import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { auth, authPool } from '../api/auth.js';
import { env } from '../config/env.js';
import { createLogger, loggerOptions } from '../lib/logger.js';
import { ApiError, sendError } from '../api/http.js';
import { closePool } from '../db/pool.js';
import { isInsufficientScopeError, verifyBearerToken } from 'better-auth/oauth2';
import { ensureServiceClient } from './bootstrap.js';

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

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildAuthServer(): Promise<FastifyInstance> {
  const config = env();

  // Migrations run before the server is built, so the OAuth tables exist by
  // now. The client is reconciled on every start so the environment remains
  // the source of truth for its secret and scopes.
  await ensureServiceClient();

  const app = Fastify({
    logger: loggerOptions({ service: 's9-auth' }),
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  // Better-Auth needs the exact bytes it was sent, so the JSON body is kept.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    const text = (body as Buffer).toString('utf8');
    if (text.trim().length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError(400, 'invalid_json', 'the request body is not valid JSON'), undefined);
    }
  });

  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    done(null, (body as Buffer).toString('utf8'));
  });

  // The OAuth2 token endpoint uses application/x-www-form-urlencoded.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (request, body, done) => {
      request.rawBody = Buffer.from(body as string);
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch {
        done(new ApiError(400, 'invalid_request', 'the form body is not valid'), undefined);
      }
    },
  );

  // Better-Auth may receive a content type this service does not parse. The
  // handler is handed the untouched bytes, so the request still works.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    done(null, body);
  });

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const incoming = request.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    request.id = requestId;
  });

  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) return sendError(reply, error, request.id);
    request.log.error({ err: error }, 'the auth request failed');
    return sendError(reply, error, request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    return sendError(reply, ApiError.notFound(`no route for ${request.method} ${request.url}`), request.id);
  });

  // ------------------------------------------------------------- health
  app.get('/health', async () => ({ status: 'ok', service: 's9-auth' }));

  app.get('/health/ready', async (request, reply) => {
    try {
      await authPool.query('SELECT 1');
      return { status: 'ready', checks: { database: 'ok' } };
    } catch (error) {
      request.log.error({ err: error }, 'the auth database health check failed');
      reply.status(503);
      return { status: 'degraded', checks: { database: 'error' } };
    }
  });

  // ----------------------------------------------------------- internal API
  app.post('/internal/sessions/validate', async (request) => {
    await verifyServiceToken(bearerToken(request.headers.authorization), 'sessions:validate');

    const cookie = request.headers.cookie;
    if (!cookie) return { session: null };

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session?.user) return { session: null };

    return {
      session: {
        userId: session.user.id,
        expiresAt: session.session.expiresAt,
      },
    };
  });

  app.get('/internal/users/:id', async (request) => {
    await verifyServiceToken(bearerToken(request.headers.authorization), 'users:read');

    const { id } = request.params as { id: string };
    const result = await authPool.query<{
      id: string;
      email: string;
      name: string;
      emailVerified: boolean;
    }>('SELECT id, email, name, "emailVerified" AS "emailVerified" FROM "user" WHERE id = $1', [id]);

    const user = result.rows[0];
    if (!user) throw new ApiError(404, 'unknown_user', 'the user does not exist');
    return user;
  });

  // ------------------------------------------------------------- Better-Auth
  app.all('/api/auth/*', async (request, reply) => {
    // The public origin, not the internal address, is what Better-Auth uses to
    // build URLs and to decide the cookie scope.
    const url = new URL(request.url, config.WEB_PUBLIC_URL);

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, String(value));
      }
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? (request.rawBody ?? Buffer.alloc(0)) : undefined;

    const authRequest = new Request(url.toString(), {
      method: request.method,
      headers,
      ...(body !== undefined ? { body, duplex: 'half' } : {}),
    } as RequestInit);

    const response = await auth.handler(authRequest);

    reply.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') return;
      reply.header(key, value);
    });

    const setCookie = response.headers.getSetCookie?.() ?? [];
    if (setCookie.length > 0) reply.header('set-cookie', setCookie);

    return reply.send(Buffer.from(await response.arrayBuffer()));
  });

  return app;
}

export async function startAuth(): Promise<void> {
  const config = env();
  const serviceLogger = createLogger({ service: 's9-auth' });
  const app = await buildAuthServer();

  const shutdown = async (signal: string) => {
    serviceLogger.info({ signal }, 'the auth service is shutting down');
    await app.close().catch(() => undefined);
    await authPool.end().catch(() => undefined);
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.AUTH_PORT, host: config.AUTH_HOST });
  serviceLogger.info(
    { port: config.AUTH_PORT, host: config.AUTH_HOST },
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
