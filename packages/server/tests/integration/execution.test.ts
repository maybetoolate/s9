import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { signWebhookPayload } from '@s9/core';
import {
  buildServer,
  createPublishedWorkflow,
  createSession,
  inject,
  publishOutbox,
  resetData,
  runContinuation,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../src/db/client.js';
import { listStepExecutions } from '../../src/db/repo.js';
import {
  contacts,
  executions,
  outboxEvents,
  retryRequests,
  stepAttempts,
  stepExecutions,
  webhookEndpoints,
  workflowVersions,
} from '../../src/db/schema.js';
import { decrypt } from '../../src/lib/secrets.js';
import { resetEnvCache } from '../../src/config/env.js';

/**
 * End-to-end behaviour of the execution pipeline, driven through the real
 * API and the real engine.
 */
describe('execution pipeline', () => {
  let context: TestContext;
  let server: TestServer;

  const contactFormDefinition = (baseUrl: string) => ({
    trigger: {
      type: 'webhook',
      slug: 'contact-form-endpoint',
      requireSignature: true,
      samplePayload: { name: 'Ada', email: 'ada@example.com' },
    },
    steps: [
      {
        key: 'save_contact',
        name: 'Save contact',
        type: 'database_insert',
        config: {
          table: 'contacts',
          values: { name: '{{trigger.body.name}}', email: '{{trigger.body.email}}' },
          dedupeKey: '{{trigger.body.email}}',
        },
      },
      {
        key: 'call_provider',
        name: 'Call provider',
        type: 'http_request',
        config: {
          method: 'POST',
          url: `${baseUrl}/contacts`,
          headers: { 'content-type': 'application/json' },
          body: '{"id":"{{steps.save_contact.output.contactId}}"}',
          bodyType: 'json',
          timeoutMs: 2_000,
          // The test provider runs on localhost, so the private destination
          // has to be allowed explicitly.
          allowPrivateNetwork: true,
        },
      },
    ],
    policy: {
      maxSteps: 10,
      executionTimeoutMs: 120_000,
      concurrency: 1,
      retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 2_000, timeoutMs: 2_000 },
    },
  });

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    // The provider simulator is shared, so its queued failures and hangs are
    // cleared before every test.
    server.reset();
    const app = await buildServer();
    context = await createSession(app, `operator-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`);
  });

  it('accepts a signed webhook exactly once for one idempotency key', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));
    expect(workflow.webhookSecret).toBeTruthy();

    const body = JSON.stringify({ name: 'Ada', email: 'ada@example.com' });
    const timestamp = Date.now();
    const signature = signWebhookPayload(workflow.webhookSecret!, timestamp, body);

    const first = await inject(context.app, {
      method: 'POST',
      url: `/webhooks/${workflow.webhookSlug}`,
      headers: {
        'content-type': 'application/json',
        'x-s9-signature': `t=${timestamp},v1=${signature}`,
        'idempotency-key': 'evt-1',
      },
      payload: body,
    });

    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as { executionId: string; accepted: boolean };
    expect(firstBody.accepted).toBe(true);

    // The same delivery inside the deduplication window creates nothing.
    const second = await inject(context.app, {
      method: 'POST',
      url: `/webhooks/${workflow.webhookSlug}`,
      headers: {
        'content-type': 'application/json',
        'x-s9-signature': `t=${timestamp},v1=${signature}`,
        'idempotency-key': 'evt-1',
      },
      payload: body,
    });

    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { executionId: string; accepted: boolean };
    expect(secondBody.accepted).toBe(false);
    expect(secondBody.executionId).toBe(firstBody.executionId);

    const db = getDb();
    const [count] = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(executions)
      .where(eq(executions.workflow_id, workflow.id));
    expect(Number(count?.count)).toBe(1);
  });

  it('rejects an unauthenticated webhook without enqueueing work', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const response = await inject(context.app, {
      method: 'POST',
      url: `/webhooks/${workflow.webhookSlug}`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'evt-bad' },
      payload: JSON.stringify({ name: 'Ada' }),
    });

    expect(response.statusCode).toBe(401);

    const db = getDb();
    const [countRow] = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(executions)
      .where(eq(executions.workflow_id, workflow.id));
    expect(Number(countRow?.count)).toBe(0);
  });

  it('rejects a webhook with a bad signature', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));
    const timestamp = Date.now();

    const response = await inject(context.app, {
      method: 'POST',
      url: `/webhooks/${workflow.webhookSlug}`,
      headers: {
        'content-type': 'application/json',
        'x-s9-signature': `t=${timestamp},v1=${'0'.repeat(64)}`,
      },
      payload: JSON.stringify({ name: 'Ada' }),
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects the intake of a paused workflow with 409', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));
    const pause = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/pause`,
      headers: { cookie: context.cookie },
    });
    expect(pause.statusCode).toBe(200);

    const body = JSON.stringify({ name: 'Ada' });
    const timestamp = Date.now();
    const signature = signWebhookPayload(workflow.webhookSecret!, timestamp, body);

    const response = await inject(context.app, {
      method: 'POST',
      url: `/webhooks/${workflow.webhookSlug}`,
      headers: {
        'content-type': 'application/json',
        'x-s9-signature': `t=${timestamp},v1=${signature}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(409);
  });

  it('runs the steps in order and records the outputs', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const run = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/run`,
      headers: { cookie: context.cookie },
      payload: { input: { name: 'Ada', email: 'ada@example.com' } },
    });
    expect(run.statusCode).toBe(202);
    const { executionId } = run.json() as { executionId: string };

    await publishOutbox();
    const result = await runContinuation(executionId);
    expect(result).toBe('completed');

    const db = getDb();
    const [execution] = await db
      .select({ status: executions.status, output: executions.output })
      .from(executions)
      .where(eq(executions.id, executionId));
    expect(execution?.status).toBe('succeeded');

    const steps = await listStepExecutions(db, executionId);
    expect(steps.map((step) => step.step_key)).toEqual(['save_contact', 'call_provider']);
    expect(steps.every((step) => step.status === 'succeeded')).toBe(true);

    // The second step received the resolved output of the first step.
    const [contact] = await db.select({ id: contacts.id }).from(contacts).limit(1);
    const providerCall = server.requests.find((request) => request.path === '/contacts');
    expect(providerCall?.body).toContain(contact!.id);
    expect(providerCall?.body).not.toContain('{{');
  });

  it('retries a transient failure and eventually succeeds', async () => {
    server.failNext(1, 503);
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const run = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/run`,
      headers: { cookie: context.cookie },
      payload: { input: { name: 'Ada', email: 'ada@example.com' } },
    });
    const { executionId } = run.json() as { executionId: string };

    await publishOutbox();
    const first = await runContinuation(executionId);
    expect(first).toBe('deferred');

    const db = getDb();
    const [step] = await db
      .select({ status: stepExecutions.status })
      .from(stepExecutions)
      .where(
        and(
          eq(stepExecutions.execution_id, executionId),
          eq(stepExecutions.step_key, 'call_provider'),
        ),
      );
    expect(step?.status).toBe('retrying');

    // The next continuation succeeds.
    const second = await runContinuation(executionId);
    expect(second).toBe('completed');

    const [attempts] = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(stepAttempts)
      .innerJoin(stepExecutions, eq(stepExecutions.id, stepAttempts.step_execution_id))
      .where(
        and(
          eq(stepExecutions.execution_id, executionId),
          eq(stepExecutions.step_key, 'call_provider'),
        ),
      );
    expect(Number(attempts?.count)).toBe(2);
  });

  it('stops the workflow on a permanent failure with a sanitised error', async () => {
    server.failNext(10, 400);
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const run = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/run`,
      headers: { cookie: context.cookie },
      payload: { input: { name: 'Ada', email: 'ada@example.com' } },
    });
    const { executionId } = run.json() as { executionId: string };

    await publishOutbox();
    const result = await runContinuation(executionId);
    expect(result).toBe('failed');

    const db = getDb();
    const [execution] = await db
      .select({ status: executions.status, error: executions.error })
      .from(executions)
      .where(eq(executions.id, executionId));
    expect(execution?.status).toBe('failed');
    expect(execution?.error?.class).toBe('permanent_provider');
    expect(execution?.error?.message).not.toContain('ada@example.com');
  });

  it('marks a timed out non-idempotent step as outcome_unknown', async () => {
    server.hangNext(1);
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const run = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/run`,
      headers: { cookie: context.cookie },
      payload: { input: { name: 'Ada', email: 'ada@example.com' } },
    });
    const { executionId } = run.json() as { executionId: string };

    await publishOutbox();
    const result = await runContinuation(executionId);
    expect(result).toBe('outcome_unknown');

    const db = getDb();
    const [step] = await db
      .select({ status: stepExecutions.status })
      .from(stepExecutions)
      .where(
        and(
          eq(stepExecutions.execution_id, executionId),
          eq(stepExecutions.step_key, 'call_provider'),
        ),
      );
    expect(step?.status).toBe('outcome_unknown');

    // The attempt is recorded as timed out and is never retried automatically.
    const [attempt] = await db
      .select({ status: stepAttempts.status })
      .from(stepAttempts)
      .innerJoin(stepExecutions, eq(stepExecutions.id, stepAttempts.step_execution_id))
      .where(
        and(
          eq(stepExecutions.execution_id, executionId),
          eq(stepExecutions.step_key, 'call_provider'),
        ),
      );
    expect(attempt?.status).toBe('timed_out');
  });

  it('lets a user resolve an unknown outcome without editing the attempt history', async () => {
    server.hangNext(1);
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const run = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/run`,
      headers: { cookie: context.cookie },
      payload: { input: { name: 'Ada', email: 'ada@example.com' } },
    });
    const { executionId } = run.json() as { executionId: string };
    await publishOutbox();
    await runContinuation(executionId);

    const resolve = await inject(context.app, {
      method: 'POST',
      url: `/api/executions/${executionId}/steps/call_provider/resolve`,
      headers: { cookie: context.cookie },
      payload: { outcome: 'succeeded', reason: 'verified in the provider dashboard' },
    });
    expect(resolve.statusCode).toBe(200);

    const db = getDb();
    const [step] = await db
      .select({
        status: stepExecutions.status,
        resolved_manually: stepExecutions.resolved_manually,
        resolution: stepExecutions.resolution,
      })
      .from(stepExecutions)
      .where(
        and(
          eq(stepExecutions.execution_id, executionId),
          eq(stepExecutions.step_key, 'call_provider'),
        ),
      );
    expect(step?.status).toBe('succeeded');
    expect(step?.resolved_manually).toBe(true);
    expect(step?.resolution?.reason).toBe('verified in the provider dashboard');

    // The original attempt is still recorded as timed out.
    const [attempt] = await db
      .select({ status: stepAttempts.status })
      .from(stepAttempts)
      .innerJoin(stepExecutions, eq(stepExecutions.id, stepAttempts.step_execution_id))
      .where(
        and(
          eq(stepExecutions.execution_id, executionId),
          eq(stepExecutions.step_key, 'call_provider'),
        ),
      );
    expect(attempt?.status).toBe('timed_out');
  });

  it('does not repeat a successful step when a failed step is retried', async () => {
    server.failNext(10, 400);
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const run = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/run`,
      headers: { cookie: context.cookie },
      payload: { input: { name: 'Ada', email: 'ada@example.com' } },
    });
    const { executionId } = run.json() as { executionId: string };
    await publishOutbox();
    await runContinuation(executionId);

    const db = getDb();
    const [contactsBefore] = await db.select({ count: sql<string>`count(*)::text` }).from(contacts);
    expect(Number(contactsBefore?.count)).toBe(1);

    const retry = await inject(context.app, {
      method: 'POST',
      url: `/api/executions/${executionId}/retry`,
      headers: { cookie: context.cookie },
      payload: { stepKey: 'call_provider', idempotencyKey: `retry-${Date.now()}-${Math.random()}` },
    });
    expect(retry.statusCode).toBe(202);

    await publishOutbox();
    await runContinuation(executionId);

    // The successful step was not repeated.
    const [contactsAfter] = await db.select({ count: sql<string>`count(*)::text` }).from(contacts);
    expect(Number(contactsAfter?.count)).toBe(1);
  });

  it('creates one recovery for two simultaneous retry requests', async () => {
    server.failNext(10, 400);
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const run = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/run`,
      headers: { cookie: context.cookie },
      payload: { input: { name: 'Ada', email: 'ada@example.com' } },
    });
    const { executionId } = run.json() as { executionId: string };
    await publishOutbox();
    await runContinuation(executionId);

    const sharedKey = `same-recovery-${Date.now()}-${Math.random()}`;
    const [first, second] = await Promise.all([
      inject(context.app, {
        method: 'POST',
        url: `/api/executions/${executionId}/retry`,
        headers: { cookie: context.cookie },
        payload: { stepKey: 'call_provider', idempotencyKey: sharedKey },
      }),
      inject(context.app, {
        method: 'POST',
        url: `/api/executions/${executionId}/retry`,
        headers: { cookie: context.cookie },
        payload: { stepKey: 'call_provider', idempotencyKey: sharedKey },
      }),
    ]);

    expect(first.statusCode).toBeLessThan(400);
    expect(second.statusCode).toBeLessThan(400);

    const db = getDb();
    const [requests] = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(retryRequests)
      .where(eq(retryRequests.execution_id, executionId));
    expect(Number(requests?.count)).toBe(1);
  });

  it('keeps a published version unchanged after a draft edit', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const detail = await inject(context.app, {
      method: 'GET',
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: context.cookie },
    });
    const body = detail.json() as { draft: { revision: number; definition: Record<string, unknown> } };

    const definition = structuredClone(body.draft.definition);
    (definition.steps as Record<string, unknown>[])[0]!.name = 'Save contact (edited)';

    const update = await inject(context.app, {
      method: 'PUT',
      url: `/api/workflows/${workflow.id}/draft`,
      headers: { cookie: context.cookie },
      payload: { definition, revision: body.draft.revision },
    });
    expect(update.statusCode).toBe(200);

    const db = getDb();
    const [version] = await db
      .select({ definition: workflowVersions.definition })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, workflow.versionId));
    const steps = version?.definition.steps as Record<string, unknown>[];
    expect(steps[0]!.name).toBe('Save contact');
  });

  it('rejects a stale draft revision', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));
    const detail = await inject(context.app, {
      method: 'GET',
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: context.cookie },
    });
    const body = detail.json() as { draft: { revision: number; definition: Record<string, unknown> } };

    // A first update succeeds and moves the revision forward.
    const firstUpdate = await inject(context.app, {
      method: 'PUT',
      url: `/api/workflows/${workflow.id}/draft`,
      headers: { cookie: context.cookie },
      payload: { definition: body.draft.definition, revision: body.draft.revision },
    });
    expect(firstUpdate.statusCode).toBe(200);

    // The same (now stale) revision is rejected instead of overwriting.
    const update = await inject(context.app, {
      method: 'PUT',
      url: `/api/workflows/${workflow.id}/draft`,
      headers: { cookie: context.cookie },
      payload: { definition: body.draft.definition, revision: body.draft.revision },
    });

    expect(update.statusCode).toBe(409);
  });

  it('does not let a user of another workspace read the workflow', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    const other = await createSession(
      context.app,
      `other-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    );

    const response = await inject(context.app, {
      method: 'GET',
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: other.cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('does not let a user of another workspace read the execution', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));
    const run = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/run`,
      headers: { cookie: context.cookie },
      payload: { input: { name: 'Ada' } },
    });
    const { executionId } = run.json() as { executionId: string };

    const other = await createSession(
      context.app,
      `other2-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    );
    const response = await inject(context.app, {
      method: 'GET',
      url: `/api/executions/${executionId}`,
      headers: { cookie: other.cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('signs a test delivery with the endpoint secret', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));

    // The test delivery is sent over a real socket to this API process, so
    // the test app has to listen for real.
    const { serveHttp } = await import('../../src/lib/serve.js');
    const selfServer = await serveHttp({
      fetch: context.app.fetch,
      port: 0,
      hostname: '127.0.0.1',
    });
    process.env.API_SELF_URL = `http://127.0.0.1:${selfServer.port}`;
    resetEnvCache();

    const response = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/webhook/test-delivery`,
      headers: { cookie: context.cookie },
      payload: { payload: { name: 'Ada', email: 'ada@example.com' } },
    });

    if (response.statusCode !== 202) {
      throw new Error(`unexpected response ${response.statusCode}: ${response.body}`);
    }
    const body = response.json() as {
      status: number;
      accepted: boolean;
      executionId: string | null;
      request: { headers: Record<string, string>; body: string; timestamp: number; signature: string };
    };

    expect(body.accepted).toBe(true);
    expect(body.executionId).toBeTruthy();

    // The signature is the hex HMAC-SHA256 of "<timestamp>.<body>", keyed with
    // the endpoint secret, exactly like an external sender would compute it.
    const signatureHeader = body.request.headers['x-s9-signature'];
    expect(signatureHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const db = getDb();
    const [endpoint] = await db
      .select({ encrypted_secret: webhookEndpoints.encrypted_secret })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.workflow_id, workflow.id));
    const secret = decrypt(endpoint!.encrypted_secret!);
    const expected = signWebhookPayload(secret, body.request.timestamp, body.request.body);
    expect(body.request.signature).toBe(expected);

    // The delivery was accepted and queued. No worker runs in the test, so the
    // continuation is driven by hand.
    const [execution] = await db
      .select({ status: executions.status })
      .from(executions)
      .where(eq(executions.id, body.executionId!));
    expect(execution?.status).toBe('queued');

    await publishOutbox();
    const result = await runContinuation(body.executionId!);
    expect(result).toBe('completed');

    const [finished] = await db
      .select({ status: executions.status })
      .from(executions)
      .where(eq(executions.id, body.executionId!));
    expect(finished?.status).toBe('succeeded');

    await selfServer.stop();
    delete process.env.API_SELF_URL;
    resetEnvCache();
  });

  it('publishes queued work through the outbox', async () => {
    const workflow = await createPublishedWorkflow(context, contactFormDefinition(server.url));
    const run = await inject(context.app, {
      method: 'POST',
      url: `/api/workflows/${workflow.id}/run`,
      headers: { cookie: context.cookie },
      payload: { input: { name: 'Ada' } },
    });
    const { executionId } = run.json() as { executionId: string };

    const db = getDb();
    const [outbox] = await db
      .select({ status: outboxEvents.status, attempt_count: outboxEvents.attempt_count })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregate_id, executionId));
    expect(outbox?.status).toBe('pending');

    const published = await publishOutbox();
    expect(published).toBeGreaterThan(0);

    const [after] = await db
      .select({ status: outboxEvents.status })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregate_id, executionId));
    expect(after?.status).toBe('published');
  });
});

export { resetData };
