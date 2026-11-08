import type { App } from '../context.js';
import { z } from 'zod';
import {
  ACTION_METADATA,
  ACTION_TYPES,
  isPublishable,
  parseActionConfig,
  validateDefinition,
  type ActionType,
} from '@s9/core';
import {
  countOutboxByStatus,
  findCredentialReferences,
  getCredential,
  insertAuditEvent,
  insertCredential,
  listAuditEvents,
  listCredentials,
  listHeartbeats,
  listSchedules,
  listWorkflows,
  outboxLagSeconds,
  softDeleteCredential,
  updateCredentialSecret,
  countRunningExecutionsInWorkspace,
  getExecution,
  listExecutions,
} from '../../db/repo.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { getUserProfile } from '../../auth/client.js';
import { requireContext } from '../context.js';
import { ApiError, jsonRoute, paginated, parsePagination, readJson } from '../http.js';
import { toAuditEventDto, toCredentialDto, toExecutionSummary, toScheduleDto } from '../mappers.js';
import { encrypt } from '../../lib/secrets.js';
import { getRedis } from '../../queue/connection.js';
import { getExecutionQueue } from '../../queue/execution-queue.js';
import { databaseNow } from '../../db/pool.js';

/**
 * Resource routes: credentials, the action registry, schedules, the audit
 * log, the dashboard and the operational endpoints.
 */

const CredentialBody = z.object({
  name: z.string().min(1, 'a name is required').max(200),
  provider: z.string().min(1, 'a provider is required').max(64),
  secret: z.string().min(1, 'a secret is required').max(10_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export async function registerResourceRoutes(app: App): Promise<void> {
  // -------------------------------------------------------------- me
  app.get('/api/me', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['read'] });
    // The profile lives in the auth service; the API never reads its tables.
    const profile = await getUserProfile(ctx.userId);
    if (!profile) throw ApiError.unauthorized('the account no longer exists');
    return {
      user: { id: ctx.userId, email: profile.email, name: profile.name },
      workspace: { id: ctx.workspaceId, name: ctx.workspaceName },
      role: ctx.role,
    };
  }));

  // -------------------------------------------------------- dashboard
  app.get('/api/dashboard', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['read'] });
    const db = getPool();

    const workflows = await listWorkflows(db, ctx.workspaceId, { page: 1, pageSize: 1 });
    const byStatus = await db.query<{ status: string; count: string }>(
      'SELECT status, count(*)::text AS count FROM workflows WHERE workspace_id = $1 GROUP BY status',
      [ctx.workspaceId],
    );
    const statusCounts: Record<string, number> = { draft: 0, published: 0, paused: 0, archived: 0 };
    for (const row of byStatus.rows) statusCounts[row.status] = Number(row.count);

    const execCounts = await db.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM executions
        WHERE workspace_id = $1 AND is_test = false GROUP BY status`,
      [ctx.workspaceId],
    );
    const execStatus: Record<string, number> = {};
    for (const row of execCounts.rows) execStatus[row.status] = Number(row.count);

    const last7 = await db.query<{ count: string; average_ms: string | null }>(
      `SELECT count(*)::text AS count, avg(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::text AS average_ms
         FROM executions
        WHERE workspace_id = $1 AND is_test = false AND created_at > now() - interval '7 days'`,
      [ctx.workspaceId],
    );

    const recent = await listExecutions(db, ctx.workspaceId, { page: 1, pageSize: 10 });
    const needsAttention = await listExecutions(db, ctx.workspaceId, {
      status: 'failed',
      page: 1,
      pageSize: 10,
    });

    const total = Object.values(execStatus).reduce((sum, value) => sum + value, 0);
    const succeeded = execStatus.succeeded ?? 0;
    const failed = execStatus.failed ?? 0;

    return {
      workflows: {
        total: workflows.total,
        draft: statusCounts.draft ?? 0,
        published: statusCounts.published ?? 0,
        paused: statusCounts.paused ?? 0,
        archived: statusCounts.archived ?? 0,
      },
      executions: {
        total,
        succeeded,
        failed,
        running: execStatus.running ?? 0,
        queued: execStatus.queued ?? 0,
        last7Days: Number(last7.rows[0]?.count ?? 0),
        averageDurationMs: last7.rows[0]?.average_ms ? Number(last7.rows[0].average_ms) : null,
        successRate: total > 0 ? succeeded / total : null,
      },
      recentExecutions: recent.rows.map(toExecutionSummary),
      needsAttention: needsAttention.rows.map(toExecutionSummary),
    };
  }));

  // --------------------------------------------------------- actions
  app.get('/api/actions', jsonRoute(async (c) => {
    await requireContext(c, { capabilities: ['read'] });
    return {
      data: ACTION_TYPES.map((type) => {
        const metadata = ACTION_METADATA[type];
        return {
          type,
          label: metadata.label,
          description: metadata.description,
          requiredFields: metadata.requiredFields,
          defaultSafeToRepeat: metadata.defaultSafeToRepeat,
          configSchema: toJsonSchema(metadata.configSchema),
          example: exampleFor(type),
        };
      }),
    };
  }));

  app.post('/api/actions/validate', jsonRoute(async (c) => {
    await requireContext(c, { capabilities: ['read'] });
    const body = z
      .object({ type: z.enum(ACTION_TYPES), config: z.unknown() })
      .parse(await readJson(c));

    const result = parseActionConfig(body.type, body.config);
    if (!result.success) {
      return {
        valid: false,
        issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      };
    }
    return { valid: true, issues: [] };
  }));

  // ----------------------------------------------------- credentials
  app.get('/api/credentials', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['read'] });
    const rows = await listCredentials(getPool(), ctx.workspaceId);
    return { data: rows.map(toCredentialDto) };
  }));

  app.post('/api/credentials', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['manage_credentials'] });
    const body = CredentialBody.parse(await readJson(c));

    const credential = await withTransaction(async (client) => {
      const row = await insertCredential(client, {
        workspaceId: ctx.workspaceId,
        name: body.name,
        provider: body.provider,
        encryptedSecret: encrypt(body.secret),
        metadata: body.metadata,
      });
      await insertAuditEvent(client, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorType: 'user',
        action: 'credential.created',
        targetType: 'credential',
        targetId: row.id,
        metadata: { name: body.name, provider: body.provider },
      });
      return row;
    });

    c.status(201);
    // The plaintext secret is never returned.
    return toCredentialDto(credential);
  }));

  app.post('/api/credentials/:id/rotate', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['rotate_credentials'] });
    const { id } = c.req.param() as { id: string };
    const body = z.object({ secret: z.string().min(1).max(10_000) }).parse(await readJson(c));

    const db = getPool();
    const credential = await getCredential(db, ctx.workspaceId, id);
    if (!credential) throw ApiError.notFound('credential not found');

    await withTransaction(async (client) => {
      await updateCredentialSecret(client, ctx.workspaceId, id, encrypt(body.secret));
      await insertAuditEvent(client, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorType: 'user',
        action: 'credential.rotated',
        targetType: 'credential',
        targetId: id,
        metadata: { name: credential.name },
      });
    });

    const updated = await getCredential(db, ctx.workspaceId, id);
    return toCredentialDto(updated as NonNullable<typeof updated>);
  }));

  app.delete('/api/credentials/:id', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['manage_credentials'] });
    const { id } = c.req.param() as { id: string };

    const db = getPool();
    const credential = await getCredential(db, ctx.workspaceId, id);
    if (!credential) throw ApiError.notFound('credential not found');

    // A credential that a published workflow uses may not be deleted.
    const references = await findCredentialReferences(db, id);
    if (references.length > 0) {
      throw ApiError.conflict(
        `the credential is used by ${references.length} published workflow version(s)`,
        'credential_in_use',
      );
    }

    await withTransaction(async (client) => {
      await softDeleteCredential(client, ctx.workspaceId, id);
      await insertAuditEvent(client, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorType: 'user',
        action: 'credential.deleted',
        targetType: 'credential',
        targetId: id,
        metadata: { name: credential.name },
      });
    });

    return { ok: true };
  }));

  // ------------------------------------------------------- schedules
  app.get('/api/schedules', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['read'] });
    const rows = await listSchedules(getPool(), ctx.workspaceId);
    return { data: rows.map((row) => ({ ...toScheduleDto(row), workflowName: row.workflow_name })) };
  }));

  app.post('/api/schedules/:workflowId/enable', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['publish'] });
    const { workflowId } = c.req.param() as { workflowId: string };
    const db = getPool();
    const rows = await listSchedules(db, ctx.workspaceId);
    const schedule = rows.find((row) => row.workflow_id === workflowId);
    if (!schedule) throw ApiError.notFound('the workflow has no schedule');

    const { computeNextRun } = await import('../../engine/scheduler.js');
    await db.query('UPDATE schedules SET enabled = true, next_run_at = $2 WHERE id = $1', [
      schedule.id,
      computeNextRun(schedule.schedule_spec, schedule.timezone),
    ]);
    return { ok: true, enabled: true };
  }));

  app.post('/api/schedules/:workflowId/disable', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['publish'] });
    const { workflowId } = c.req.param() as { workflowId: string };
    const db = getPool();
    const rows = await listSchedules(db, ctx.workspaceId);
    const schedule = rows.find((row) => row.workflow_id === workflowId);
    if (!schedule) throw ApiError.notFound('the workflow has no schedule');

    await db.query('UPDATE schedules SET enabled = false, next_run_at = NULL WHERE id = $1', [schedule.id]);
    return { ok: true, enabled: false };
  }));

  // ----------------------------------------------------------- audit
  app.get('/api/audit', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['read'] });
    const query = c.req.query();
    const pagination = parsePagination(query);

    const { rows, total } = await listAuditEvents(getPool(), ctx.workspaceId, {
      targetType: typeof query.targetType === 'string' ? query.targetType : undefined,
      targetId: typeof query.targetId === 'string' ? query.targetId : undefined,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    return paginated(rows.map(toAuditEventDto), total, pagination);
  }));

  // ------------------------------------------------------ operations
  app.get('/api/ops/queue', jsonRoute(async (c) => {
    await requireContext(c, { capabilities: ['read'] });
    const db = getPool();

    const queue = getExecutionQueue(getRedis());
    const counts = (await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')) as Record<
      string,
      number
    >;
    const outbox = await countOutboxByStatus(db);
    const lag = await outboxLagSeconds(db);
    const workers = await listHeartbeats(db);
    await queue.close().catch(() => undefined);

    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
      outbox: {
        pending: outbox.pending ?? 0,
        failed: outbox.failed ?? 0,
        deadLetter: outbox.dead_letter ?? 0,
        lagSeconds: lag,
      },
      workers: workers.map((worker) => ({
        id: worker.worker_id,
        lastSeenAt: worker.last_seen_at.toISOString(),
        currentExecutionId: worker.current_execution_id,
      })),
    };
  }));

  app.get('/api/ops/workspace-usage', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['read'] });
    const active = await countRunningExecutionsInWorkspace(getPool(), ctx.workspaceId);
    return { activeExecutions: active };
  }));
}

/** Converts a zod schema into a small JSON schema description for the UI. */
function toJsonSchema(schema: unknown): Record<string, unknown> {
  const candidate = schema as {
    _def?: {
      type?: string;
      shape?: Record<string, unknown> | (() => Record<string, unknown>);
      defaultValue?: unknown;
      innerType?: unknown;
    };
  };
  const def = candidate?._def;
  if (!def) return { type: 'object', properties: {} };

  const rawShape = typeof def.shape === 'function' ? def.shape() : def.shape;
  if (!rawShape) return { type: 'object', properties: {} };

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawShape)) {
    const field = value as {
      _def?: { type?: string; typeName?: string; defaultValue?: unknown };
    };
    const type = field._def?.type ?? field._def?.typeName ?? 'unknown';
    const defaultValue =
      typeof field._def?.defaultValue === 'function'
        ? (field._def.defaultValue as () => unknown)()
        : field._def?.defaultValue;
    properties[key] = {
      type: String(type).replace(/^Zod/, '').toLowerCase(),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    };
  }

  return { type: 'object', properties };
}

function exampleFor(type: ActionType): Record<string, unknown> {
  switch (type) {
    case 'http_request':
      return {
        method: 'POST',
        url: 'https://api.example.com/contacts',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"{{trigger.body.name}}"}',
        bodyType: 'json',
        timeoutMs: 30_000,
      };
    case 'send_email':
      return {
        provider: 'mailpit',
        from: 's9 <no-reply@s9.local>',
        to: '{{trigger.body.email}}',
        subject: 'We received your message',
        body: 'Thanks for reaching out.',
      };
    case 'database_insert':
      return {
        table: 'contacts',
        values: {
          name: '{{trigger.body.name}}',
          email: '{{trigger.body.email}}',
          message: '{{trigger.body.message}}',
        },
        dedupeKey: '{{trigger.body.email}}',
      };
    case 'notification':
      return {
        channel: 'sales',
        message: 'New contact: {{trigger.body.name}}',
        webhookUrl: 'https://hooks.example.com/services/T000/B000/XXXX',
      };
    default:
      return {};
  }
}

export { isPublishable, validateDefinition, getExecution, databaseNow };
