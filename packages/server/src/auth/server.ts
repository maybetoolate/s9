import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { auth, authPool } from '../api/auth.js';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { ApiError, relayResponse, sendError } from '../api/http.js';
import { closePool } from '../db/pool.js';
import { isInsufficientScopeError, verifyBearerToken } from 'better-auth/oauth2';
import { ensureServiceClient } from './bootstrap.js';
import { serveHttp } from '../lib/serve.js';

/**
 * The authentication service.
 *
 * It owns the Better-Auth tables and is the only process that reads them. The
 * public surface is mounted at `/api/auth/*`; the API reaches it through the
 * internal endpoints below.
 *
 * Service-to-service calls use the OAuth2 client-credentials grant issued by
 * the OAuth provider plugin. The access token identifies the calling service,
 * never a user.
 */

interface AuthEnv {
  Variables: {
    requestId: string;
  };
}

const MAX_BODY_BYTES = 1024 * 1024;

export async function buildAuthServer(): Promise<Hono<AuthEnv>> {
  const config = env();

  // Migrations run before the server is built, so the OAuth tables exist by
  // now. The client is reconciled on every start so the environment remains
  // the source of truth for its secret and scopes.
  await ensureServiceClient();

  const app = new Hono<AuthEnv>();
  const serviceLogger = createLogger({ service: 's9-auth' });

  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    c.set('requestId', incoming && incoming.length > 0 ? incoming : randomUUID());
    await next();
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        sendError(c, ApiError.payloadTooLarge('the request body is too large'), c.get('requestId')),
    }),
  );

  app.onError((error, c) => {
    const requestId = c.get('requestId');
    if (error instanceof ApiError) return sendError(c, error, requestId);
    serviceLogger.error({ err: error }, 'the auth request failed');
    return sendError(c, error, requestId);
  });

  app.notFound((c) =>
    sendError(
      c,
      ApiError.notFound(`no route for ${c.req.method} ${c.req.path}`),
      c.get('requestId'),
    ),
  );

  // ------------------------------------------------------------- health
  app.get('/health', (c) => c.json({ status: 'ok', service: 's9-auth' }));

  app.get('/health/ready', async (c) => {
    try {
      await authPool.query('SELECT 1');
      return c.json({ status: 'ready', checks: { database: 'ok' } });
    } catch (error) {
      serviceLogger.error({ err: error }, 'the auth database health check failed');
      return c.json({ status: 'degraded', checks: { database: 'error' } }, 503);
    }
  });

  // ----------------------------------------------------------- internal API
  app.post('/internal/sessions/validate', async (c) => {
    await verifyServiceToken(bearerToken(c.req.header('authorization')), 'sessions:validate');

    const cookie = c.req.header('cookie');
    if (!cookie) return c.json({ session: null });

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session?.user) return c.json({ session: null });

    return c.json({
      session: {
        userId: session.user.id,
        expiresAt: session.session.expiresAt,
      },
    });
  });

  app.get('/internal/users/:id', async (c) => {
    await verifyServiceToken(bearerToken(c.req.header('authorization')), 'users:read');

    const id = c.req.param('id');
    const result = await authPool.query<{
      id: string;
      email: string;
      name: string;
      emailVerified: boolean;
    }>('SELECT id, email, name, "emailVerified" AS "emailVerified" FROM "user" WHERE id = $1', [id]);

    const user = result.rows[0];
    if (!user) throw new ApiError(404, 'unknown_user', 'the user does not exist');
    return c.json(user);
  });

  // ------------------------------------------------------------- Better-Auth
  app.all('/api/auth/*', async (c) => {
    // The public origin, not the internal address, is what Better-Auth uses to
    // build URLs and to decide the cookie scope.
    const incoming = new URL(c.req.url);
    const url = new URL(incoming.pathname + incoming.search, config.WEB_PUBLIC_URL);

    const headers = new Headers();
    for (const [key, value] of c.req.raw.headers) {
      if (key === 'host' || key === 'content-length' || key === 'connection') continue;
      headers.append(key, value);
    }

    const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    const body = hasBody ? await c.req.arrayBuffer() : undefined;

    const authRequest = new Request(url.toString(), {
      method: c.req.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });

    const response = await auth.handler(authRequest);
    return relayResponse(response);
  });

  return app;
}

export async function startAuth(): Promise<void> {
  const config = env();
  const serviceLogger = createLogger({ service: 's9-auth' });
  const app = await buildAuthServer();

  const server = await serveHttp({
    fetch: app.fetch,
    port: config.AUTH_PORT,
    hostname: config.AUTH_HOST,
  });

  const shutdown = async (signal: string) => {
    serviceLogger.info({ signal }, 'the auth service is shutting down');
    await server.stop().catch(() => undefined);
    await authPool.end().catch(() => undefined);
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  serviceLogger.info(
    { runtime: server.runtime, port: server.port, host: config.AUTH_HOST },
    'the auth service started',
  );
}

/**
 * Verifies an access token issued by the OAuth provider.
 *
 * The auth service is the resource server for its internal API, so it checks
 * the token locally against its own JWKS: signature, issuer, audience, the
 * `at+jwt` type, the client claim and the required scope.
 */
async function verifyServiceToken(token: string, requiredScope: string): Promise<void> {
  const config = env();

  try {
    await verifyBearerToken(token, {
      jwksUrl: new URL('/api/auth/jwks', config.AUTH_INTERNAL_URL).toString(),
      verifyOptions: {
        issuer: config.AUTH_ISSUER,
        audience: config.AUTH_API_RESOURCE,
        typ: 'at+jwt',
        requiredClaims: ['azp'],
      },
      requiredScopes: [requiredScope],
    });
  } catch (error) {
    if (isInsufficientScopeError(error)) {
      throw new ApiError(
        403,
        'insufficient_scope',
        `the service token does not grant ${requiredScope}`,
      );
    }
    throw new ApiError(401, 'invalid_token', 'the service token is not valid');
  }
}

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'invalid_token', 'a service token is required');
  }
  return header.slice(7);
}
