import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { buildServer } from '../../src/api/server.js';
import { auth } from '../../src/auth/index.js';
import { closePool } from '../../src/db/pool.js';
import { getDb, withTransaction } from '../../src/db/client.js';
import { addMembership, createWorkflow } from '../../src/db/repo.js';
import { workspaceMemberships, workspaces } from '../../src/db/schema.js';
import { runExecutionContinuation } from '../../src/engine/execution-engine.js';
import { createActionExecutors, createActionRegistry } from '../../src/actions/index.js';
import { dispatchOutboxOnce } from '../../src/engine/dispatcher.js';
import { getExecutionQueue } from '../../src/queue/execution-queue.js';
import { getRedis } from '../../src/queue/connection.js';
import type { App } from '../../src/api/context.js';

/**
 * Integration helpers.
 *
 * The tests drive the real API through Hono's request dispatcher, the real database
 * and the real engine, so they exercise the same code paths as production.
 */

export const executors = createActionExecutors();
export const registry = createActionRegistry(executors);

export interface TestContext {
  app: App;
  cookie: string;
  userId: string;
  workspaceId: string;
  email: string;
}

export interface InjectOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

export interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  json: <T = unknown>() => T;
  text: () => string;
}

/** Dispatches a request through Hono without opening a socket. */
export async function inject(app: App, options: InjectOptions): Promise<InjectResponse> {
  const headers = new Headers(options.headers);
  let body: string | Uint8Array | undefined;

  if (options.payload !== undefined) {
    if (typeof options.payload === 'string' || options.payload instanceof Uint8Array) {
      body = options.payload as string | Uint8Array;
    } else {
      body = JSON.stringify(options.payload);
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }

  const response = await app.request(options.url, {
    method: options.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });

  const text = await response.text();
  const flatHeaders: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    flatHeaders[key] = value;
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) flatHeaders['set-cookie'] = setCookie;

  return {
    statusCode: response.status,
    headers: flatHeaders,
    body: text,
    text: () => text,
    json: <T = unknown>() => JSON.parse(text) as T,
  };
}

/** Signs a user up and returns an authenticated session cookie. */
export async function createSession(app: App, email: string): Promise<TestContext> {
  const response = await inject(app, {
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password: 'integration-test-password', name: 'Integration Test' },
  });

  if (response.statusCode >= 400) {
    // The user may already exist from a previous run: sign in instead.
    const login = await inject(app, {
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: 'integration-test-password' },
    });
    if (login.statusCode >= 400) {
      throw new Error(`could not sign in: ${login.statusCode} ${login.body}`);
    }
    const cookie = extractCookie(login.headers['set-cookie']);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookie.split(';')[0] ?? '' }),
    });
    const workspaceId = await ensureWorkspace(session!.user.id, email);
    return { app, cookie, userId: session!.user.id, workspaceId, email };
  }

  const cookie = extractCookie(response.headers['set-cookie']);
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: cookie.split(';')[0] ?? '' }),
  });
  const workspaceId = await ensureWorkspace(session!.user.id, email);
  return { app, cookie, userId: session!.user.id, workspaceId, email };
}

function extractCookie(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return value?.split(';')[0] ?? '';
}

async function ensureWorkspace(userId: string, email: string): Promise<string> {
  const db = getDb();
  const [existing] = await db
    .select({ id: workspaceMemberships.workspace_id })
    .from(workspaceMemberships)
    .where(sql`${workspaceMemberships.user_id} = ${userId}`)
    .limit(1);
  if (existing) return existing.id;

  return withTransaction(async (client) => {
    const [workspace] = await client
      .insert(workspaces)
      .values({ name: `Workspace ${email}` })
      .returning({ id: workspaces.id });
    const id = workspace!.id;
    await addMembership(client, id, userId, 'owner');
    return id;
  });
}

/** Creates a workflow with a published version. */
export async function createPublishedWorkflow(
  context: TestContext,
  definition: Record<string, unknown>,
  options: { name?: string; publish?: boolean } = {},
): Promise<{ id: string; versionId: string; webhookSecret?: string; webhookSlug?: string }> {
  const trigger = definition.trigger as { type: string };

  const workflow = await withTransaction(async (client) =>
    createWorkflow(client, {
      workspaceId: context.workspaceId,
      name: options.name ?? `Test workflow ${Date.now()}`,
      triggerType: trigger.type as never,
      definition: definition as never,
    }),
  );

  if (options.publish === false) return { id: workflow.id, versionId: '' };

  const response = await inject(context.app, {
    method: 'POST',
    url: `/api/workflows/${workflow.id}/publish`,
    headers: { cookie: context.cookie },
  });
  if (response.statusCode >= 400) {
    throw new Error(`publish failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { version: { id: string }; webhookSecret?: string; webhookEndpoint?: { slug: string } };

  return {
    id: workflow.id,
    versionId: body.version.id,
    ...(body.webhookSecret ? { webhookSecret: body.webhookSecret } : {}),
    ...(body.webhookEndpoint ? { webhookSlug: body.webhookEndpoint.slug } : {}),
  };
}

/** Runs one continuation of an execution inline. */
export async function runContinuation(executionId: string): Promise<string> {
  const result = await runExecutionContinuation(
    { executionId, runSequence: 0 },
    { registry, executors, workerId: 'test-worker', leaseDurationMs: 60_000 },
  );
  return result;
}

/** Publishes the pending outbox rows to the queue. */
export async function publishOutbox(): Promise<number> {
  const queue = getExecutionQueue(getRedis());
  const result = await dispatchOutboxOnce(queue);
  await queue.close();
  return result.published;
}

/** A tiny HTTP server used to simulate a flaky provider. */
export interface TestServer {
  url: string;
  requests: { path: string; headers: Record<string, string | undefined>; body: string }[];
  /** Makes the next N requests fail with the given status. */
  failNext: (times: number, status?: number) => void;
  /** Clears the queued failures and hangs, so a test starts from a clean slate. */
  reset: () => void;
  /** Makes the server never answer (used to simulate a timeout). */
  hangNext: (times: number) => void;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  let failures = 0;
  let failureStatus = 500;
  let hangs = 0;

  const requests: TestServer['requests'] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        path: request.url ?? '',
        headers: request.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (hangs > 0) {
        hangs -= 1;
        // Never answer: the request times out.
        return;
      }
      if (failures > 0) {
        failures -= 1;
        response.writeHead(failureStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'temporary failure' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, received: requests.length }));
    });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    reset: () => {
      failures = 0;
      hangs = 0;
      requests.length = 0;
    },
    failNext: (times, status = 500) => {
      failures = times;
      failureStatus = status;
    },
    hangNext: (times) => {
      hangs = times;
    },
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

/** Removes every row from the transactional tables. */
export async function resetData(): Promise<void> {
  await getDb().execute(sql`
    TRUNCATE TABLE
      step_attempts, step_executions, executions, trigger_events, outbox_events,
      retry_requests, audit_events, schedule_occurrences, schedules,
      webhook_endpoints, workflow_versions, workflow_drafts, workflows,
      credentials, contacts, workspace_memberships, workspaces
    RESTART IDENTITY CASCADE
  `);
}

export { closePool, getDb, buildServer };
