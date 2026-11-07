import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger, loggerOptions } from '../lib/logger.js';
import { ApiError, sendError } from './http.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerExecutionRoutes } from './routes/executions.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerResourceRoutes } from './routes/resources.js';
import { getPool, closePool } from '../db/pool.js';
import { RepositoryError } from '../db/repo.js';
import { getRedis, closeRedis } from '../queue/connection.js';

/**
 * The HTTP API.
 *
 * The API owns authentication, CRUD, validation, publishing, webhook intake
 * and run requests. It never performs long running workflow work inline.
 */

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const config = env();

  const app = Fastify({
    logger: loggerOptions(),
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  // Keep the raw body so the webhook signature can be verified over exactly
  // the bytes that were received.
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

  // The auth proxy forwards the body untouched, and the auth service decides
  // how to interpret it. Without a catch-all parser Fastify would reject a
  // form-encoded auth request before the proxy ever sees it.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    done(null, body);
  });

  // A correlation id is returned for support and log correlation.
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const incoming = request.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    request.id = requestId;
    (request as FastifyRequest & { requestId?: string }).requestId = requestId;
  });

  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) {
      return sendError(reply, error, request.id);
    }
    if (error instanceof RepositoryError) {
      return sendError(
        reply,
        new ApiError(error.statusCode, error.code, error.message),
        request.id,
      );
    }
    const errorName = (error as { name?: string }).name;
    if (errorName === 'ZodError') {
      return sendError(
        reply,
        ApiError.badRequest('the request body is not valid', 'invalid_body', (error as { issues?: unknown }).issues),
        request.id,
      );
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode < 500) {
      const message = (error as { message?: string }).message ?? 'the request was rejected';
      return sendError(reply, new ApiError(statusCode, 'request_error', message), request.id);
    }
    request.log.error({ err: error }, 'the request failed');
    return sendError(reply, error, request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    return sendError(reply, ApiError.notFound(`no route for ${request.method} ${request.url}`), request.id);
  });

  // ------------------------------------------------------------- health
  app.get('/health', async () => ({ status: 'ok', service: 'flowforge-api' }));

  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await getPool().query('SELECT 1');
      checks.database = 'ok';
    } catch (error) {
      checks.database = 'error';
      healthy = false;
      logger.error({ err: error }, 'the database health check failed');
    }

    try {
      await getRedis().ping();
      checks.queue = 'ok';
    } catch (error) {
      checks.queue = 'error';
      healthy = false;
      logger.error({ err: error }, 'the queue health check failed');
    }

    // Every authenticated request depends on the auth service, so it belongs
    // in the readiness decision.
    try {
      const response = await fetch(new URL('/health', config.AUTH_INTERNAL_URL), {
        signal: AbortSignal.timeout(2_000),
      });
      checks.auth = response.ok ? 'ok' : 'error';
      if (!response.ok) healthy = false;
    } catch (error) {
      checks.auth = 'error';
      healthy = false;
      logger.error({ err: error }, 'the auth health check failed');
    }

    reply.status(healthy ? 200 : 503);
    return { status: healthy ? 'ready' : 'degraded', checks };
  });

  // -------------------------------------------------------------- auth
  // Authentication lives in its own service. The API keeps the public
  // `/api/auth/*` surface and proxies it so existing clients and the web app
  // do not need to know the internal address.
  app.all('/api/auth/*', async (request, reply) => {
    const target = new URL(request.url, config.AUTH_INTERNAL_URL);

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      // Hop-by-hop headers are owned by the outbound request.
      if (key === 'host' || key === 'connection' || key === 'content-length') continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, String(value));
      }
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        ...(hasBody ? { body: request.rawBody ?? Buffer.alloc(0) } : {}),
        redirect: 'manual',
      });
    } catch (error) {
      throw new ApiError(
        502,
        'auth_unreachable',
        `the auth service could not be reached: ${(error as Error).message}`,
      );
    }

    reply.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') return;
      reply.header(key, value);
    });
    const setCookie = upstream.headers.getSetCookie?.() ?? [];
    if (setCookie.length > 0) reply.header('set-cookie', setCookie);

    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });

  // ----------------------------------------------------------- routes
  await registerWorkflowRoutes(app);
  await registerExecutionRoutes(app);
  await registerWebhookRoutes(app);
  await registerResourceRoutes(app);

  return app;
}

export async function startApi(): Promise<void> {
  const config = env();
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'the api is shutting down');
    await app.close().catch(() => undefined);
    await closeRedis();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  logger.info({ port: config.API_PORT, host: config.API_HOST }, 'the api started');
}
