import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { ApiError, sendError } from "./http.js";
import { auth } from "../auth/index.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerExecutionRoutes } from "./routes/executions.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerResourceRoutes } from "./routes/resources.js";
import { closePool } from "../db/pool.js";
import { getDb } from "../db/client.js";
import { RepositoryError } from "../db/repo.js";
import { getRedis, closeRedis } from "../queue/connection.js";
import type { App, AppEnv } from "./context.js";
import { serveHttp } from "../lib/serve.js";

/**
 * The HTTP API.
 *
 * The API owns authentication (through the embedded auth module), CRUD,
 * validation, publishing, webhook intake and run requests. It never performs
 * long running workflow work inline.
 */

const MAX_BODY_BYTES = 1024 * 1024;

export async function buildServer(): Promise<App> {
  const app = new Hono<AppEnv>();

  // A correlation id is returned for support and log correlation.
  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    c.set("requestId", incoming && incoming.length > 0 ? incoming : randomUUID());
    await next();
  });

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        sendError(c, ApiError.payloadTooLarge("the request body is too large"), c.get("requestId")),
    }),
  );

  app.onError((error, c) => {
    const requestId = c.get("requestId");
    if (error instanceof ApiError) {
      return sendError(c, error, requestId);
    }
    if (error instanceof RepositoryError) {
      return sendError(c, new ApiError(error.statusCode, error.code, error.message), requestId);
    }
    const errorName = (error as { name?: string }).name;
    if (errorName === "ZodError") {
      return sendError(
        c,
        ApiError.badRequest(
          "the request body is not valid",
          "invalid_body",
          (error as { issues?: unknown }).issues,
        ),
        requestId,
      );
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode < 500) {
      const message = (error as { message?: string }).message ?? "the request was rejected";
      return sendError(c, new ApiError(statusCode, "request_error", message), requestId);
    }
    logger.error({ err: error }, "the request failed");
    return sendError(c, error, requestId);
  });

  app.notFound((c) =>
    sendError(
      c,
      ApiError.notFound(`no route for ${c.req.method} ${c.req.path}`),
      c.get("requestId"),
    ),
  );

  // ------------------------------------------------------------- health
  app.get("/health", (c) => c.json({ status: "ok", service: "s9-api" }));

  app.get("/health/ready", async (c) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await getDb().execute(sql`SELECT 1`);
      checks.database = "ok";
    } catch (error) {
      checks.database = "error";
      healthy = false;
      logger.error({ err: error }, "the database health check failed");
    }

    try {
      await getRedis().ping();
      checks.queue = "ok";
    } catch (error) {
      checks.queue = "error";
      healthy = false;
      logger.error({ err: error }, "the queue health check failed");
    }

    return c.json({ status: healthy ? "ready" : "degraded", checks }, healthy ? 200 : 503);
  });

  // -------------------------------------------------------------- auth
  // Authentication is an embedded module, but it is mounted as a distinct
  // surface: the web app and clients only ever see `/api/auth/*`, and the
  // workflow code never reaches into Better-Auth.
  app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

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

  const server = await serveHttp({
    fetch: app.fetch,
    port: config.API_PORT,
    hostname: config.API_HOST,
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "the api is shutting down");
    await server.stop().catch(() => undefined);
    await closeRedis();
    await closePool();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info(
    { runtime: server.runtime, port: server.port, host: config.API_HOST },
    "the api started",
  );
}
