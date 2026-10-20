import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  generateWebhookSecret,
  hashWebhookSecret,
  isPublishable,
  randomSlug,
  validateDefinition,
  WorkflowDefinitionSchema,
  type TriggerType,
  type WorkflowDefinition,
} from '@flowforge/core';
import { z } from 'zod';
import {
  createWorkflow,
  getDraft,
  getLatestVersion,
  getScheduleByWorkflow,
  getVersion,
  getWebhookEndpointByWorkflow,
  insertAuditEvent,
  insertWebhookEndpoint,
  listVersions,
  listWorkflows,
  rotateWebhookSecret,
  setWorkflowStatus,
  updateDraft,
  getWorkflow,
  countRunningExecutions,
  upsertSchedule,
} from '../../db/repo.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { context, requireContext } from '../context.js';
import { ApiError, paginated, parsePagination } from '../http.js';
import { toDraftDto, toScheduleDto, toVersionDto, toWebhookEndpointDto, toWorkflowSummary } from '../mappers.js';
import { createExecution } from '../../engine/execution-service.js';
import { computeNextRun } from '../../engine/scheduler.js';
import { env } from '../../config/env.js';
import { encrypt } from '../../lib/secrets.js';

/**
 * Workflow routes.
 *
 * A workflow has a draft (editable) and immutable published versions. Every
 * operation is scoped to the workspace of the caller.
 */

const CreateWorkflowBody = z.object({
  name: z.string().min(1, 'a name is required').max(200),
  description: z.string().max(2_000).optional(),
  triggerType: z.enum(['webhook', 'schedule', 'manual']),
  definition: z.unknown().optional(),
});

const UpdateDraftBody = z.object({
  definition: z.unknown(),
  revision: z.number().int().min(1),
});

const RunBody = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export async function registerWorkflowRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/workflows', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['read'] });
    const query = request.query as Record<string, unknown>;
    const pagination = parsePagination(query);

    const { rows, total } = await listWorkflows(getPool(), ctx.workspaceId, {
      status: (query.status as never) ?? 'all',
      triggerType: (query.triggerType as never) ?? 'all',
      search: typeof query.search === 'string' ? query.search : undefined,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    return paginated(rows.map(toWorkflowSummary), total, pagination);
  });

  app.post('/api/workflows', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['write'] });
    const body = CreateWorkflowBody.parse(request.body ?? {});

    const definition = buildInitialDefinition(body.triggerType, body.definition);
    const issues = validateDefinition(definition);
    if (!isPublishable(issues)) {
      throw ApiError.badRequest('the workflow definition is not valid', 'invalid_definition', issues);
    }

    const workflow = await withTransaction(async (client) =>
      createWorkflow(client, {
        workspaceId: ctx.workspaceId,
        name: body.name,
        description: body.description ?? null,
        triggerType: body.triggerType,
        definition,
      }),
    );

    reply.status(201);
    return {
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      triggerType: workflow.trigger_type,
      draft: definition,
    };
  });

  app.get('/api/workflows/:id', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['read'] });
    const { id } = request.params as { id: string };

    const db = getPool();
    const workflow = await getWorkflow(db, ctx.workspaceId, id);
    if (!workflow) throw ApiError.notFound('workflow not found');

    const [draft, versions, endpoint, schedule] = await Promise.all([
      getDraft(db, id),
      listVersions(db, id),
      getWebhookEndpointByWorkflow(db, id),
      getScheduleByWorkflow(db, id),
    ]);

    const latest = versions[0] ?? null;

    return {
      id: workflow.id,
      workspaceId: workflow.workspace_id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      triggerType: workflow.trigger_type,
      currentVersionId: workflow.current_version_id,
      currentVersionNumber: latest?.version_number ?? null,
      hasUnpublishedChanges: Boolean(draft && latest && JSON.stringify(draft.definition) !== JSON.stringify(latest.definition)),
      createdAt: workflow.created_at.toISOString(),
      updatedAt: workflow.updated_at.toISOString(),
      draft: draft ? toDraftDto(draft) : null,
      versions: versions.map(toVersionDto),
      webhookEndpoint: endpoint ? toWebhookEndpointDto(endpoint, env().API_PUBLIC_URL) : null,
      schedule: schedule ? toScheduleDto(schedule) : null,
    };
  });

  app.patch('/api/workflows/:id', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['write'] });
    const { id } = request.params as { id: string };
    const body = z
      .object({ name: z.string().min(1).max(200).optional(), description: z.string().max(2_000).nullable().optional() })
      .parse(request.body ?? {});

    const db = getPool();
    const workflow = await getWorkflow(db, ctx.workspaceId, id);
    if (!workflow) throw ApiError.notFound('workflow not found');

    await db.query(
      `UPDATE workflows
          SET name = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              updated_at = now()
        WHERE id = $1`,
      [id, body.name ?? null, body.description !== undefined, body.description ?? null],
    );

    return { ok: true };
  });

  app.put('/api/workflows/:id/draft', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['write'] });
    const { id } = request.params as { id: string };
    const body = UpdateDraftBody.parse(request.body ?? {});

    const db = getPool();
    const workflow = await getWorkflow(db, ctx.workspaceId, id);
    if (!workflow) throw ApiError.notFound('workflow not found');
    if (workflow.status === 'archived') throw ApiError.conflict('an archived workflow cannot be edited');

    const parsed = WorkflowDefinitionSchema.safeParse(body.definition);
    if (!parsed.success) {
      throw ApiError.badRequest(
        'the workflow definition is not valid',
        'invalid_definition',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }

    // Optimistic concurrency: a stale revision is rejected instead of
    // silently overwriting another editor's work.
    const draft = await updateDraft(db, id, parsed.data, body.revision);
    return { draft: toDraftDto(draft) };
  });

  app.post('/api/workflows/:id/validate', async (request, reply) => {
    await requireContext(request, reply, { capabilities: ['read'] });
    const { id } = request.params as { id: string };

    const db = getPool();
    const draft = await getDraft(db, id);
    if (!draft) throw ApiError.notFound('workflow not found');

    const issues = validateDefinition(draft.definition);
    return { valid: isPublishable(issues), issues };
  });

  app.post('/api/workflows/:id/publish', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['publish'] });
    const { id } = request.params as { id: string };

    const db = getPool();
    const workflow = await getWorkflow(db, ctx.workspaceId, id);
    if (!workflow) throw ApiError.notFound('workflow not found');

    const draft = await getDraft(db, id);
    if (!draft) throw ApiError.notFound('the workflow has no draft');

    const definition = WorkflowDefinitionSchema.parse(draft.definition);
    const issues = validateDefinition(definition);
    if (!isPublishable(issues)) {
      throw ApiError.badRequest('the workflow cannot be published', 'invalid_definition', issues);
    }

    const result = await withTransaction(async (client) => {
      const latest = await getLatestVersion(client, id);
      const versionNumber = (latest?.version_number ?? 0) + 1;

      const version = await client.query(
        `INSERT INTO workflow_versions (workflow_id, version_number, definition, published_by)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING *`,
        [id, versionNumber, JSON.stringify(definition), ctx.userId],
      );

      await client.query(
        `UPDATE workflows
            SET current_version_id = $2, status = 'published', trigger_type = $3, updated_at = now()
          WHERE id = $1`,
        [id, version.rows[0].id, definition.trigger.type],
      );

      let webhookSecret: string | null = null;
      const endpoint = await getWebhookEndpointByWorkflow(client, id);
      if (definition.trigger.type === 'webhook') {
        if (!endpoint) {
          webhookSecret = generateWebhookSecret();
          await insertWebhookEndpoint(client, {
            workflowId: id,
            slug: randomSlug(),
            secretHash: hashWebhookSecret(webhookSecret),
            encryptedSecret: encrypt(webhookSecret),
            requireSignature: definition.trigger.requireSignature,
          });
        }
      }

      if (definition.trigger.type === 'schedule') {
        await upsertSchedule(client, {
          workflowId: id,
          timezone: definition.trigger.timezone,
          scheduleSpec: definition.trigger.cron,
          enabled: true,
          catchUp: definition.trigger.catchUp,
          nextRunAt: computeNextRun(definition.trigger.cron, definition.trigger.timezone),
        });
      } else {
        await client.query('UPDATE schedules SET enabled = false, next_run_at = NULL WHERE workflow_id = $1', [id]);
      }

      await insertAuditEvent(client, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorType: 'user',
        action: 'workflow.published',
        targetType: 'workflow',
        targetId: id,
        metadata: { versionNumber },
      });

      return { version: version.rows[0], webhookSecret };
    });

    const endpoint = await getWebhookEndpointByWorkflow(db, id);
    return {
      version: toVersionDto(result.version),
      status: 'published',
      // The webhook secret is shown exactly once, when it is created.
      webhookSecret: result.webhookSecret,
      webhookEndpoint: endpoint ? toWebhookEndpointDto(endpoint, env().API_PUBLIC_URL) : null,
    };
  });

  app.post('/api/workflows/:id/pause', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['publish'] });
    const { id } = request.params as { id: string };
    await changeStatus(id, ctx, 'paused');
    return { status: 'paused' };
  });

  app.post('/api/workflows/:id/resume', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['publish'] });
    const { id } = request.params as { id: string };

    const db = getPool();
    const workflow = await getWorkflow(db, ctx.workspaceId, id);
    if (!workflow) throw ApiError.notFound('workflow not found');
    if (!workflow.current_version_id) {
      throw ApiError.conflict('the workflow has no published version', 'no_published_version');
    }

    await changeStatus(id, ctx, 'published');
    // A resumed schedule continues from the next occurrence.
    const schedule = await getScheduleByWorkflow(db, id);
    if (schedule?.enabled) {
      await db.query('UPDATE schedules SET next_run_at = $2 WHERE id = $1', [
        schedule.id,
        computeNextRun(schedule.schedule_spec, schedule.timezone),
      ]);
    }
    return { status: 'published' };
  });

  app.post('/api/workflows/:id/archive', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['publish'] });
    const { id } = request.params as { id: string };
    await changeStatus(id, ctx, 'archived');
    return { status: 'archived' };
  });

  app.post('/api/workflows/:id/duplicate', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['write'] });
    const { id } = request.params as { id: string };

    const db = getPool();
    const workflow = await getWorkflow(db, ctx.workspaceId, id);
    if (!workflow) throw ApiError.notFound('workflow not found');
    const draft = await getDraft(db, id);
    if (!draft) throw ApiError.notFound('the workflow has no draft');

    const copy = await withTransaction(async (client) =>
      createWorkflow(client, {
        workspaceId: ctx.workspaceId,
        name: `${workflow.name} (copy)`,
        description: workflow.description,
        triggerType: workflow.trigger_type,
        definition: draft.definition as unknown as WorkflowDefinition,
      }),
    );

    reply.status(201);
    return { id: copy.id, name: copy.name };
  });

  app.get('/api/workflows/:id/versions', async (request, reply) => {
    await requireContext(request, reply, { capabilities: ['read'] });
    const { id } = request.params as { id: string };
    const versions = await listVersions(getPool(), id);
    return { data: versions.map(toVersionDto) };
  });

  app.get('/api/workflow-versions/:id', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['read'] });
    const { id } = request.params as { id: string };
    const version = await getVersion(getPool(), id);
    if (!version) throw ApiError.notFound('workflow version not found');

    const workflow = await getWorkflow(getPool(), ctx.workspaceId, version.workflow_id);
    if (!workflow) throw ApiError.notFound('workflow version not found');

    return toVersionDto(version);
  });

  app.get('/api/workflows/:id/webhook', async (request, reply) => {
    await requireContext(request, reply, { capabilities: ['read'] });
    const { id } = request.params as { id: string };
    const endpoint = await getWebhookEndpointByWorkflow(getPool(), id);
    if (!endpoint) throw ApiError.notFound('the workflow has no webhook endpoint');
    // The secret is never returned again.
    return toWebhookEndpointDto(endpoint, env().API_PUBLIC_URL);
  });

  app.post('/api/workflows/:id/webhook/rotate', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['rotate_credentials'] });
    const { id } = request.params as { id: string };

    const db = getPool();
    const endpoint = await getWebhookEndpointByWorkflow(db, id);
    if (!endpoint) throw ApiError.notFound('the workflow has no webhook endpoint');

    const secret = generateWebhookSecret();
    // The previous secret keeps working during a short overlap window.
    const overlapMs = 60 * 60_000;

    await withTransaction(async (client) => {
      await rotateWebhookSecret(
        client,
        endpoint.id,
        hashWebhookSecret(secret),
        encrypt(secret),
        endpoint.secret_hash,
        endpoint.encrypted_secret,
        overlapMs,
      );
      await insertAuditEvent(client, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorType: 'user',
        action: 'workflow.webhook_secret_rotated',
        targetType: 'workflow',
        targetId: id,
        metadata: { endpointId: endpoint.id },
      });
    });

    return {
      secret,
      endpoint: toWebhookEndpointDto(
        (await getWebhookEndpointByWorkflow(db, id)) as NonNullable<Awaited<ReturnType<typeof getWebhookEndpointByWorkflow>>>,
        env().API_PUBLIC_URL,
      ),
    };
  });

  app.post('/api/workflows/:id/run', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['publish'] });
    const { id } = request.params as { id: string };
    const body = RunBody.parse(request.body ?? {});

    const db = getPool();
    const workflow = await getWorkflow(db, ctx.workspaceId, id);
    if (!workflow) throw ApiError.notFound('workflow not found');
    if (!workflow.current_version_id) {
      throw ApiError.conflict('the workflow has no published version', 'no_published_version');
    }
    if (workflow.status !== 'published') {
      throw ApiError.conflict(`the workflow is ${workflow.status}`, 'workflow_not_published');
    }

    const idempotencyKey =
      body.idempotencyKey ??
      request.headers['idempotency-key']?.toString() ??
      `manual:${workflow.id}:${randomUUID()}`;

    const queued = await countRunningExecutions(db, workflow.id);
    if (queued >= 1_000) {
      throw ApiError.tooManyRequests('the workflow has too many queued executions', 'workflow_queue_full');
    }

    const result = await createExecution({
      workspaceId: ctx.workspaceId,
      workflowId: workflow.id,
      workflowVersionId: workflow.current_version_id,
      triggerType: 'manual',
      input: body.input,
      idempotencyKey,
      actorId: ctx.userId,
    });

    reply.status(result.duplicate ? 200 : 202);
    return { executionId: result.id, duplicate: result.duplicate, status: 'queued' };
  });

  app.post('/api/workflows/:id/test', async (request, reply) => {
    const ctx = await requireContext(request, reply, { capabilities: ['write'] });
    const { id } = request.params as { id: string };
    const body = RunBody.parse(request.body ?? {});

    const db = getPool();
    const workflow = await getWorkflow(db, ctx.workspaceId, id);
    if (!workflow) throw ApiError.notFound('workflow not found');

    const draft = await getDraft(db, id);
    if (!draft) throw ApiError.notFound('the workflow has no draft');

    const definition = draft.definition as unknown as WorkflowDefinition;
    const issues = validateDefinition(definition);
    if (!isPublishable(issues)) {
      throw ApiError.badRequest('the draft cannot be run', 'invalid_definition', issues);
    }

    // A test run pins the draft revision and simulates side effects.
    const result = await createExecution({
      workspaceId: ctx.workspaceId,
      workflowId: workflow.id,
      workflowVersionId: null,
      triggerType: 'manual',
      input: body.input,
      idempotencyKey: `test:${workflow.id}:${randomUUID()}`,
      isTest: true,
      actorId: ctx.userId,
      definitionSnapshot: definition as unknown as Record<string, unknown>,
      draftRevision: draft.revision,
    });

    reply.status(202);
    return { executionId: result.id, duplicate: false, status: 'queued', isTest: true };
  });
}

async function changeStatus(
  workflowId: string,
  ctx: { workspaceId: string; userId: string },
  status: 'published' | 'paused' | 'archived',
): Promise<void> {
  const db = getPool();
  const workflow = await getWorkflow(db, ctx.workspaceId, workflowId);
  if (!workflow) throw ApiError.notFound('workflow not found');

  await withTransaction(async (client) => {
    await setWorkflowStatus(client, workflowId, status);
    await insertAuditEvent(client, {
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      actorType: 'user',
      action: `workflow.${status}`,
      targetType: 'workflow',
      targetId: workflowId,
      metadata: {},
    });
  });
}

function buildInitialDefinition(triggerType: TriggerType, provided: unknown): WorkflowDefinition {
  if (provided !== undefined && provided !== null) {
    const parsed = WorkflowDefinitionSchema.safeParse(provided);
    if (parsed.success) return parsed.data;
  }

  const base = {
    steps: [
      {
        key: 'first_step',
        name: 'First step',
        type: 'notification' as const,
        config: { channel: 'general', message: 'hello from FlowForge', webhookUrl: 'https://example.com/hook' },
      },
    ],
    policy: {
      maxSteps: 10,
      executionTimeoutMs: 600_000,
      concurrency: 1,
      retry: { maxAttempts: 3, baseDelayMs: 5_000, maxDelayMs: 300_000, timeoutMs: 30_000 },
    },
  };

  if (triggerType === 'webhook') {
    return { trigger: { type: 'webhook', slug: randomSlug(12), requireSignature: true, samplePayload: {} }, ...base } as WorkflowDefinition;
  }
  if (triggerType === 'schedule') {
    return { trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'UTC', catchUp: true }, ...base } as WorkflowDefinition;
  }
  return { trigger: { type: 'manual', samplePayload: {} }, ...base } as WorkflowDefinition;
}
