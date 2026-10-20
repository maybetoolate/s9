import type { Pool, PoolClient } from 'pg';
import type { ExecutionStatus, StepStatus, TriggerType, WorkflowDefinition, WorkflowStatus } from '@flowforge/core';
import { getPool } from './pool.js';
import type {
  AuditEventRow,
  ContactRow,
  CredentialRow,
  ExecutionRow,
  MembershipRow,
  OutboxEventRow,
  RetryRequestRow,
  ScheduleOccurrenceRow,
  ScheduleRow,
  StepAttemptRow,
  StepExecutionRow,
  TriggerEventRow,
  WebhookEndpointRow,
  WorkerHeartbeatRow,
  WorkflowDraftRow,
  WorkflowRow,
  WorkflowVersionRow,
  WorkspaceRow,
} from './rows.js';

/**
 * Data access layer.
 *
 * Every function that participates in a multi-statement invariant accepts a
 * `Db` (pool or transaction client) so the caller controls the transaction
 * boundary. The durable state always lives in PostgreSQL.
 */

export type Db = Pool | PoolClient;

export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

export class NotFoundError extends RepositoryError {
  constructor(message: string) {
    super(message, 'not_found', 404);
  }
}

export class ConflictError extends RepositoryError {
  constructor(message: string, code = 'conflict') {
    super(message, code, 409);
  }
}

export class ForbiddenError extends RepositoryError {
  constructor(message = 'you do not have access to this resource') {
    super(message, 'forbidden', 403);
  }
}

async function run<T extends object>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query(text, params);
  return result.rows as T[];
}

async function runOne<T extends object>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await run<T>(db, text, params);
  return rows[0] ?? null;
}

// ------------------------------------------------------------------ workspaces

export async function createWorkspace(db: Db, name: string): Promise<WorkspaceRow> {
  const row = await runOne<WorkspaceRow>(
    db,
    'INSERT INTO workspaces (name) VALUES ($1) RETURNING *',
    [name],
  );
  if (!row) throw new RepositoryError('failed to create workspace', 'insert_failed', 500);
  return row;
}

export async function listWorkspacesForUser(db: Db, userId: string): Promise<(WorkspaceRow & { role: string })[]> {
  return run<WorkspaceRow & { role: string }>(
    db,
    `SELECT w.*, m.role
       FROM workspaces w
       JOIN workspace_memberships m ON m.workspace_id = w.id
      WHERE m.user_id = $1
      ORDER BY w.created_at ASC`,
    [userId],
  );
}

export async function findMembership(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<MembershipRow | null> {
  return runOne<MembershipRow>(
    db,
    'SELECT * FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
}

export async function addMembership(
  db: Db,
  workspaceId: string,
  userId: string,
  role: 'owner' | 'editor' | 'viewer',
): Promise<MembershipRow> {
  const row = await runOne<MembershipRow>(
    db,
    `INSERT INTO workspace_memberships (workspace_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING *`,
    [workspaceId, userId, role],
  );
  if (!row) throw new RepositoryError('failed to add membership', 'insert_failed', 500);
  return row;
}

// ------------------------------------------------------------------- workflows

export async function createWorkflow(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    description?: string | null;
    triggerType: TriggerType;
    definition: WorkflowDefinition;
  },
): Promise<WorkflowRow> {
  const workflow = await runOne<WorkflowRow>(
    db,
    `INSERT INTO workflows (workspace_id, name, description, trigger_type)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.workspaceId, input.name, input.description ?? null, input.triggerType],
  );
  if (!workflow) throw new RepositoryError('failed to create workflow', 'insert_failed', 500);

  await run(
    db,
    `INSERT INTO workflow_drafts (workflow_id, definition, revision)
     VALUES ($1, $2::jsonb, 1)`,
    [workflow.id, JSON.stringify(input.definition)],
  );

  return workflow;
}

export async function getWorkflow(db: Db, workspaceId: string, workflowId: string): Promise<WorkflowRow | null> {
  return runOne<WorkflowRow>(
    db,
    'SELECT * FROM workflows WHERE id = $1 AND workspace_id = $2',
    [workflowId, workspaceId],
  );
}

export async function requireWorkflow(db: Db, workspaceId: string, workflowId: string): Promise<WorkflowRow> {
  const workflow = await getWorkflow(db, workspaceId, workflowId);
  if (!workflow) throw new NotFoundError('workflow not found');
  return workflow;
}

export interface WorkflowListFilters {
  status?: WorkflowStatus | 'all';
  triggerType?: TriggerType | 'all';
  search?: string;
  page: number;
  pageSize: number;
}

export interface WorkflowListItem extends WorkflowRow {
  current_version_number: number | null;
  has_unpublished_changes: boolean;
  last_run_at: Date | null;
  last_run_status: ExecutionStatus | null;
  step_count: number;
}

export async function listWorkflows(
  db: Db,
  workspaceId: string,
  filters: WorkflowListFilters,
): Promise<{ rows: WorkflowListItem[]; total: number }> {
  const conditions = ['w.workspace_id = $1'];
  const params: unknown[] = [workspaceId];

  if (filters.status && filters.status !== 'all') {
    params.push(filters.status);
    conditions.push(`w.status = $${params.length}`);
  }
  if (filters.triggerType && filters.triggerType !== 'all') {
    params.push(filters.triggerType);
    conditions.push(`w.trigger_type = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(`w.name ILIKE $${params.length}`);
  }

  const where = conditions.join(' AND ');

  const totalRow = await runOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM workflows w WHERE ${where}`,
    params,
  );

  const rows = await run<WorkflowListItem>(
    db,
    `SELECT w.*,
            v.version_number AS current_version_number,
            (d.revision IS NOT NULL AND d.definition::text IS DISTINCT FROM v.definition::text) AS has_unpublished_changes,
            last_exec.run_at AS last_run_at,
            last_exec.status AS last_run_status,
            COALESCE(jsonb_array_length(d.definition->'steps'), 0) AS step_count
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.id = w.current_version_id
       LEFT JOIN workflow_drafts d ON d.workflow_id = w.id
       LEFT JOIN LATERAL (
            SELECT e.created_at AS run_at, e.status
              FROM executions e
             WHERE e.workflow_id = w.id
             ORDER BY e.created_at DESC
             LIMIT 1
       ) last_exec ON true
      WHERE ${where}
      ORDER BY w.updated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
  );

  return { rows, total: Number(totalRow?.count ?? 0) };
}

export async function getDraft(db: Db, workflowId: string): Promise<WorkflowDraftRow | null> {
  return runOne<WorkflowDraftRow>(db, 'SELECT * FROM workflow_drafts WHERE workflow_id = $1', [workflowId]);
}

export async function getLatestVersion(db: Db, workflowId: string): Promise<WorkflowVersionRow | null> {
  return runOne<WorkflowVersionRow>(
    db,
    'SELECT * FROM workflow_versions WHERE workflow_id = $1 ORDER BY version_number DESC LIMIT 1',
    [workflowId],
  );
}

export async function listVersions(db: Db, workflowId: string): Promise<WorkflowVersionRow[]> {
  return run<WorkflowVersionRow>(
    db,
    'SELECT * FROM workflow_versions WHERE workflow_id = $1 ORDER BY version_number DESC',
    [workflowId],
  );
}

export async function getVersion(db: Db, versionId: string): Promise<WorkflowVersionRow | null> {
  return runOne<WorkflowVersionRow>(db, 'SELECT * FROM workflow_versions WHERE id = $1', [versionId]);
}

/**
 * Updates the draft with optimistic concurrency.
 *
 * The client sends the revision it loaded; a stale revision is rejected with
 * a 409 instead of silently overwriting another editor's work.
 */
export async function updateDraft(
  db: Db,
  workflowId: string,
  definition: WorkflowDefinition,
  expectedRevision: number,
): Promise<WorkflowDraftRow> {
  const row = await runOne<WorkflowDraftRow>(
    db,
    `UPDATE workflow_drafts
        SET definition = $2::jsonb, revision = revision + 1, updated_at = now()
      WHERE workflow_id = $1 AND revision = $3
      RETURNING *`,
    [workflowId, JSON.stringify(definition), expectedRevision],
  );
  if (!row) {
    throw new ConflictError(
      'the draft was modified by someone else, reload the workflow and try again',
      'draft_revision_conflict',
    );
  }
  await run(db, 'UPDATE workflows SET updated_at = now() WHERE id = $1', [workflowId]);
  return row;
}

export async function setWorkflowStatus(
  db: Db,
  workflowId: string,
  status: WorkflowStatus,
): Promise<WorkflowRow | null> {
  return runOne<WorkflowRow>(
    db,
    'UPDATE workflows SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [workflowId, status],
  );
}

export async function touchWorkflow(db: Db, workflowId: string): Promise<void> {
  await run(db, 'UPDATE workflows SET updated_at = now() WHERE id = $1', [workflowId]);
}

// ----------------------------------------------------------------- credentials

export async function listCredentials(db: Db, workspaceId: string): Promise<CredentialRow[]> {
  return run<CredentialRow>(
    db,
    'SELECT * FROM credentials WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
    [workspaceId],
  );
}

export async function getCredential(db: Db, workspaceId: string, credentialId: string): Promise<CredentialRow | null> {
  return runOne<CredentialRow>(
    db,
    'SELECT * FROM credentials WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
    [credentialId, workspaceId],
  );
}

export async function insertCredential(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    provider: string;
    encryptedSecret: CredentialRow['encrypted_secret'];
    metadata?: Record<string, unknown>;
  },
): Promise<CredentialRow> {
  const row = await runOne<CredentialRow>(
    db,
    `INSERT INTO credentials (workspace_id, name, provider, encrypted_secret, metadata)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     RETURNING *`,
    [
      input.workspaceId,
      input.name,
      input.provider,
      JSON.stringify(input.encryptedSecret),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (!row) throw new RepositoryError('failed to create credential', 'insert_failed', 500);
  return row;
}

export async function updateCredentialSecret(
  db: Db,
  workspaceId: string,
  credentialId: string,
  encryptedSecret: CredentialRow['encrypted_secret'],
): Promise<CredentialRow | null> {
  return runOne<CredentialRow>(
    db,
    `UPDATE credentials
        SET encrypted_secret = $3::jsonb, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
      RETURNING *`,
    [credentialId, workspaceId, JSON.stringify(encryptedSecret)],
  );
}

/**
 * Soft deletes a credential.
 *
 * A credential that is referenced by a published workflow must not be deleted;
 * the caller checks the references first.
 */
export async function softDeleteCredential(db: Db, workspaceId: string, credentialId: string): Promise<boolean> {
  const result = await run(
    db,
    'UPDATE credentials SET deleted_at = now() WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
    [credentialId, workspaceId],
  );
  return result.length > 0;
}

/** Finds published workflows that reference the given credential. */
export async function findCredentialReferences(
  db: Db,
  credentialId: string,
): Promise<{ id: string; name: string; version_number: number }[]> {
  return run<{ id: string; name: string; version_number: number }>(
    db,
    `SELECT w.id, w.name, v.version_number
       FROM workflow_versions v
       JOIN workflows w ON w.id = v.workflow_id
      WHERE v.definition::text LIKE $1`,
    [`%${credentialId}%`],
  );
}

// ------------------------------------------------------------ webhook endpoints

export async function getWebhookEndpointByWorkflow(
  db: Db,
  workflowId: string,
): Promise<WebhookEndpointRow | null> {
  return runOne<WebhookEndpointRow>(db, 'SELECT * FROM webhook_endpoints WHERE workflow_id = $1', [workflowId]);
}

export async function getWebhookEndpointBySlug(db: Db, slug: string): Promise<WebhookEndpointRow | null> {
  return runOne<WebhookEndpointRow>(db, 'SELECT * FROM webhook_endpoints WHERE slug = $1', [slug]);
}

export async function insertWebhookEndpoint(
  db: Db,
  input: {
    workflowId: string;
    slug: string;
    secretHash: string;
    encryptedSecret: WebhookEndpointRow['encrypted_secret'];
    requireSignature: boolean;
  },
): Promise<WebhookEndpointRow> {
  const row = await runOne<WebhookEndpointRow>(
    db,
    `INSERT INTO webhook_endpoints (workflow_id, slug, secret_hash, encrypted_secret, require_signature)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING *`,
    [
      input.workflowId,
      input.slug,
      input.secretHash,
      input.encryptedSecret ? JSON.stringify(input.encryptedSecret) : null,
      input.requireSignature,
    ],
  );
  if (!row) throw new RepositoryError('failed to create webhook endpoint', 'insert_failed', 500);
  return row;
}

/**
 * Rotates the endpoint secret.
 *
 * The previous secret keeps working during a short overlap window so a
 * rotation does not break senders that have not been updated yet.
 */
export async function rotateWebhookSecret(
  db: Db,
  endpointId: string,
  secretHash: string,
  encryptedSecret: WebhookEndpointRow['encrypted_secret'],
  previousSecretHash: string | null,
  previousEncryptedSecret: WebhookEndpointRow['previous_encrypted_secret'],
  overlapMs: number,
): Promise<WebhookEndpointRow | null> {
  return runOne<WebhookEndpointRow>(
    db,
    `UPDATE webhook_endpoints
        SET secret_hash = $2,
            encrypted_secret = $3::jsonb,
            previous_secret_hash = $4,
            previous_encrypted_secret = $5::jsonb,
            previous_secret_expires_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() + ($6 || ' milliseconds')::interval END,
            rotated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      endpointId,
      secretHash,
      encryptedSecret ? JSON.stringify(encryptedSecret) : null,
      previousSecretHash,
      previousEncryptedSecret ? JSON.stringify(previousEncryptedSecret) : null,
      String(overlapMs),
    ],
  );
}

/** Looks up a workflow by id without a workspace filter (internal use). */
export async function getWorkflowById(db: Db, workflowId: string): Promise<WorkflowRow | null> {
  return runOne<WorkflowRow>(db, 'SELECT * FROM workflows WHERE id = $1', [workflowId]);
}

// ------------------------------------------------------------------- schedules

export async function upsertSchedule(
  db: Db,
  input: {
    workflowId: string;
    timezone: string;
    scheduleSpec: string;
    enabled: boolean;
    catchUp: boolean;
    nextRunAt: Date | null;
  },
): Promise<ScheduleRow> {
  const row = await runOne<ScheduleRow>(
    db,
    `INSERT INTO schedules (workflow_id, timezone, schedule_spec, enabled, catch_up, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workflow_id) DO UPDATE
        SET timezone = EXCLUDED.timezone,
            schedule_spec = EXCLUDED.schedule_spec,
            enabled = EXCLUDED.enabled,
            catch_up = EXCLUDED.catch_up,
            next_run_at = EXCLUDED.next_run_at,
            updated_at = now()
      RETURNING *`,
    [input.workflowId, input.timezone, input.scheduleSpec, input.enabled, input.catchUp, input.nextRunAt],
  );
  if (!row) throw new RepositoryError('failed to upsert schedule', 'write_failed', 500);
  return row;
}

export async function getScheduleByWorkflow(db: Db, workflowId: string): Promise<ScheduleRow | null> {
  return runOne<ScheduleRow>(db, 'SELECT * FROM schedules WHERE workflow_id = $1', [workflowId]);
}

export async function listSchedules(db: Db, workspaceId: string): Promise<(ScheduleRow & { workflow_name: string })[]> {
  return run<ScheduleRow & { workflow_name: string }>(
    db,
    `SELECT s.*, w.name AS workflow_name
       FROM schedules s
       JOIN workflows w ON w.id = s.workflow_id
      WHERE w.workspace_id = $1
      ORDER BY s.next_run_at NULLS LAST`,
    [workspaceId],
  );
}

export async function listDueSchedules(db: Db, now: Date): Promise<ScheduleRow[]> {
  return run<ScheduleRow>(
    db,
    `SELECT s.* FROM schedules s
      WHERE s.enabled = true AND s.next_run_at IS NOT NULL AND s.next_run_at <= $1
      ORDER BY s.next_run_at ASC
      LIMIT 100`,
    [now],
  );
}

export async function updateScheduleRunState(
  db: Db,
  scheduleId: string,
  nextRunAt: Date | null,
  lastOccurrenceAt: Date | null,
): Promise<void> {
  await run(
    db,
    'UPDATE schedules SET next_run_at = $2, last_occurrence_at = COALESCE($3, last_occurrence_at), updated_at = now() WHERE id = $1',
    [scheduleId, nextRunAt, lastOccurrenceAt],
  );
}

/**
 * Claims an occurrence slot.
 *
 * The unique constraint on (schedule_id, scheduled_for) is the real guard:
 * the insert only succeeds for the single creator of the occurrence.
 */
export async function insertScheduleOccurrence(
  db: Db,
  input: { scheduleId: string; scheduledFor: Date; localKey: string },
): Promise<ScheduleOccurrenceRow | null> {
  return runOne<ScheduleOccurrenceRow>(
    db,
    `INSERT INTO schedule_occurrences (schedule_id, scheduled_for, local_key)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [input.scheduleId, input.scheduledFor, input.localKey],
  );
}

export async function linkOccurrenceToExecution(
  db: Db,
  occurrenceId: string,
  executionId: string,
): Promise<void> {
  await run(db, 'UPDATE schedule_occurrences SET execution_id = $2 WHERE id = $1', [occurrenceId, executionId]);
}

// ------------------------------------------------------------------ executions

export interface CreateExecutionInput {
  workspaceId: string;
  workflowId: string;
  /** Null for a test run, which pins a draft snapshot instead. */
  workflowVersionId: string | null;
  triggerType: TriggerType;
  triggerEventId?: string | null;
  idempotencyKey: string;
  input: Record<string, unknown>;
  isTest?: boolean;
  rerunOfExecutionId?: string | null;
  actorId?: string | null;
  /** The pinned definition of a test run. */
  definitionSnapshot?: Record<string, unknown> | null;
  /** The draft revision a test run pinned. */
  draftRevision?: number | null;
}

/**
 * Creates an execution and its outbox event in one transaction.
 *
 * The outbox stores the intent to enqueue in the same PostgreSQL transaction
 * as the execution, so a crash between commit and publish cannot strand the
 * run (blueprint section 8).
 */
export async function createExecutionWithOutbox(
  db: Db,
  input: CreateExecutionInput,
): Promise<ExecutionRow> {
  const execution = await runOne<ExecutionRow>(
    db,
    `INSERT INTO executions (
        workspace_id, workflow_id, workflow_version_id, status, trigger_type, trigger_event_id,
        idempotency_key, input, is_test, rerun_of_execution_id, definition_snapshot, draft_revision, queued_at)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, now())
     RETURNING *`,
    [
      input.workspaceId,
      input.workflowId,
      input.workflowVersionId,
      input.triggerType,
      input.triggerEventId ?? null,
      input.idempotencyKey,
      JSON.stringify(input.input ?? {}),
      input.isTest ?? false,
      input.rerunOfExecutionId ?? null,
      input.definitionSnapshot === undefined || input.definitionSnapshot === null
        ? null
        : JSON.stringify(input.definitionSnapshot),
      input.draftRevision ?? null,
    ],
  );
  if (!execution) throw new RepositoryError('failed to create execution', 'insert_failed', 500);

  await insertOutboxEvent(db, {
    aggregateType: 'execution',
    aggregateId: execution.id,
    eventType: 'execution.requested',
    payload: {
      executionId: execution.id,
      workflowId: execution.workflow_id,
      workflowVersionId: execution.workflow_version_id,
      runSequence: 0,
      triggerType: input.triggerType,
    },
  });

  await insertAuditEvent(db, {
    workspaceId: input.workspaceId,
    actorId: input.actorId ?? null,
    actorType: input.actorId ? 'user' : 'system',
    action: 'execution.created',
    targetType: 'execution',
    targetId: execution.id,
    metadata: { triggerType: input.triggerType, isTest: input.isTest ?? false },
  });

  return execution;
}

export async function getExecution(db: Db, workspaceId: string, executionId: string): Promise<ExecutionRow | null> {
  return runOne<ExecutionRow>(
    db,
    'SELECT * FROM executions WHERE id = $1 AND workspace_id = $2',
    [executionId, workspaceId],
  );
}

export async function getExecutionById(db: Db, executionId: string): Promise<ExecutionRow | null> {
  return runOne<ExecutionRow>(db, 'SELECT * FROM executions WHERE id = $1', [executionId]);
}

export interface ExecutionListFilters {
  workflowId?: string;
  status?: ExecutionStatus | 'all';
  triggerType?: TriggerType | 'all';
  isTest?: 'true' | 'false' | 'all';
  search?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export async function listExecutions(
  db: Db,
  workspaceId: string,
  filters: ExecutionListFilters,
): Promise<{ rows: (ExecutionRow & { workflow_name: string; version_number: number })[]; total: number }> {
  const conditions = ['e.workspace_id = $1'];
  const params: unknown[] = [workspaceId];

  if (filters.workflowId) {
    params.push(filters.workflowId);
    conditions.push(`e.workflow_id = $${params.length}`);
  }
  if (filters.status && filters.status !== 'all') {
    params.push(filters.status);
    conditions.push(`e.status = $${params.length}`);
  }
  if (filters.triggerType && filters.triggerType !== 'all') {
    params.push(filters.triggerType);
    conditions.push(`e.trigger_type = $${params.length}`);
  }
  if (filters.isTest && filters.isTest !== 'all') {
    params.push(filters.isTest === 'true');
    conditions.push(`e.is_test = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(`e.id::text ILIKE $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`e.created_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`e.created_at <= $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const totalRow = await runOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM executions e WHERE ${where}`,
    params,
  );

  const rows = await run<ExecutionRow & { workflow_name: string; version_number: number }>(
    db,
    `SELECT e.*, w.name AS workflow_name, v.version_number
       FROM executions e
       JOIN workflows w ON w.id = e.workflow_id
       JOIN workflow_versions v ON v.id = e.workflow_version_id
      WHERE ${where}
      ORDER BY e.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
  );

  return { rows, total: Number(totalRow?.count ?? 0) };
}

export async function countRunningExecutions(db: Db, workflowId: string): Promise<number> {
  const row = await runOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM executions
      WHERE workflow_id = $1 AND status IN ('queued', 'running', 'retrying')`,
    [workflowId],
  );
  return Number(row?.count ?? 0);
}

export async function countRunningExecutionsInWorkspace(db: Db, workspaceId: string): Promise<number> {
  const row = await runOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM executions
      WHERE workspace_id = $1 AND status IN ('queued', 'running', 'retrying')`,
    [workspaceId],
  );
  return Number(row?.count ?? 0);
}

/**
 * Guarded status transition.
 *
 * Every worker write goes through this helper so that a late duplicate queue
 * delivery cannot overwrite a terminal state.
 */
export async function updateExecutionStatus(
  db: Db,
  input: {
    executionId: string;
    from: ExecutionStatus[];
    to: ExecutionStatus;
    leaseToken?: string | null;
    error?: object | null;
    output?: Record<string, unknown> | null;
    finished?: boolean;
    incrementRunSequence?: boolean;
  },
): Promise<ExecutionRow | null> {
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  // $1 = id, $2 = target status, $3 = allowed source statuses.
  const params: unknown[] = [input.executionId, input.to, input.from];
  const conditions: string[] = ['id = $1', 'status = ANY($3::text[])'];

  if (input.error !== undefined) {
    params.push(input.error === null ? null : JSON.stringify(input.error));
    sets.push(`error = $${params.length}::jsonb`);
  }
  if (input.output !== undefined) {
    params.push(input.output === null ? null : JSON.stringify(input.output));
    sets.push(`output = $${params.length}::jsonb`);
  }
  if (input.finished) {
    sets.push('finished_at = now()');
  }
  if (input.incrementRunSequence) {
    sets.push('run_sequence = run_sequence + 1');
  }
  if (input.leaseToken !== undefined && input.leaseToken !== null) {
    params.push(input.leaseToken);
    sets.push(`lease_token = $${params.length}`);
    conditions.push(`lease_token = $${params.length}`);
  }

  const result = await run<ExecutionRow>(
    db,
    `UPDATE executions
        SET ${sets.join(', ')}
      WHERE ${conditions.join(' AND ')}
      RETURNING *`,
    params,
  );
  return result[0] ?? null;
}

/**
 * Claims an execution for a worker.
 *
 * The claim installs a lease token; every subsequent state change is guarded
 * on that token. When the lease has expired the claim is a takeover.
 */
export async function claimExecution(
  db: Db,
  input: { executionId: string; workerId: string; leaseToken: string; leaseDurationMs: number },
): Promise<ExecutionRow | null> {
  return runOne<ExecutionRow>(
    db,
    `UPDATE executions
        SET status = 'running',
            worker_id = $2,
            lease_token = $3,
            lease_expires_at = now() + ($4 || ' milliseconds')::interval,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = $1
        AND status IN ('queued', 'running', 'retrying')
        AND (lease_expires_at IS NULL OR lease_expires_at < now() OR lease_token = $3)
      RETURNING *`,
    [input.executionId, input.workerId, input.leaseToken, String(input.leaseDurationMs)],
  );
}

/** Extends the lease of a running execution (worker heartbeat). */
export async function heartbeatExecution(
  db: Db,
  input: { executionId: string; leaseToken: string; leaseDurationMs: number },
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE executions
        SET lease_expires_at = now() + ($3 || ' milliseconds')::interval
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [input.executionId, input.leaseToken, String(input.leaseDurationMs)],
  );
  return result.length > 0;
}

export async function setExecutionLease(
  db: Db,
  input: { executionId: string; leaseToken: string | null; workerId: string | null; leaseDurationMs?: number },
): Promise<void> {
  if (input.leaseToken === null) {
    await run(
      db,
      `UPDATE executions
          SET lease_token = NULL, lease_expires_at = NULL, worker_id = NULL, updated_at = now()
        WHERE id = $1`,
      [input.executionId],
    );
    return;
  }
  await run(
    db,
    `UPDATE executions
        SET lease_token = $2, worker_id = $3,
            lease_expires_at = now() + ($4 || ' milliseconds')::interval,
            updated_at = now()
      WHERE id = $1`,
    [input.executionId, input.leaseToken, input.workerId, String(input.leaseDurationMs ?? 0)],
  );
}

/** Finds executions whose lease expired while they were still running. */
export async function findStaleExecutions(db: Db, now: Date): Promise<ExecutionRow[]> {
  return run<ExecutionRow>(
    db,
    `SELECT * FROM executions
      WHERE status IN ('running', 'retrying')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < $1
      ORDER BY lease_expires_at ASC
      LIMIT 50`,
    [now],
  );
}

/** Finds queued executions that no worker has picked up (Redis data loss). */
export async function findUnstartedExecutions(db: Db, olderThan: Date): Promise<ExecutionRow[]> {
  return run<ExecutionRow>(
    db,
    `SELECT * FROM executions
      WHERE status = 'queued' AND queued_at < $1
      ORDER BY queued_at ASC
      LIMIT 50`,
    [olderThan],
  );
}

// ------------------------------------------------------------- step executions

export async function getStepExecution(
  db: Db,
  executionId: string,
  stepKey: string,
): Promise<StepExecutionRow | null> {
  return runOne<StepExecutionRow>(
    db,
    'SELECT * FROM step_executions WHERE execution_id = $1 AND step_key = $2',
    [executionId, stepKey],
  );
}

export async function listStepExecutions(db: Db, executionId: string): Promise<StepExecutionRow[]> {
  return run<StepExecutionRow>(
    db,
    'SELECT * FROM step_executions WHERE execution_id = $1 ORDER BY step_index ASC',
    [executionId],
  );
}

/** Creates the step rows for a fresh execution. */
export async function createStepExecutions(
  db: Db,
  executionId: string,
  steps: { key: string; name: string; type: string; index: number }[],
): Promise<void> {
  for (const step of steps) {
    await run(
      db,
      `INSERT INTO step_executions (execution_id, step_key, step_index, name, type, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (execution_id, step_key) DO NOTHING`,
      [executionId, step.key, step.index, step.name, step.type],
    );
  }
}

export async function updateStepExecution(
  db: Db,
  input: {
    stepExecutionId: string;
    from: StepStatus[];
    to: StepStatus;
    error?: object | null;
    output?: Record<string, unknown> | null;
    input?: Record<string, unknown>;
    started?: boolean;
    finished?: boolean;
    workerId?: string | null;
  },
): Promise<StepExecutionRow | null> {
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  // $1 = id, $2 = target status, $3 = allowed source statuses.
  const params: unknown[] = [input.stepExecutionId, input.to, input.from];
  const conditions: string[] = ['id = $1', 'status = ANY($3::text[])'];

  if (input.error !== undefined) {
    params.push(input.error === null ? null : JSON.stringify(input.error));
    sets.push(`error = $${params.length}::jsonb`);
  }
  if (input.output !== undefined) {
    params.push(input.output === null ? null : JSON.stringify(input.output));
    sets.push(`output = $${params.length}::jsonb`);
  }
  if (input.input !== undefined) {
    params.push(JSON.stringify(input.input));
    sets.push(`input = $${params.length}::jsonb`);
  }
  if (input.started) sets.push('started_at = COALESCE(started_at, now())');
  if (input.finished) sets.push('finished_at = now()');
  if (input.workerId !== undefined) {
    params.push(input.workerId);
    sets.push(`worker_id = $${params.length}`);
  }

  const result = await run<StepExecutionRow>(
    db,
    `UPDATE step_executions
        SET ${sets.join(', ')}
      WHERE ${conditions.join(' AND ')}
      RETURNING *`,
    params,
  );
  return result[0] ?? null;
}

/** Resets a step so that it can run again (retry step). */
export async function resetStepForRetry(db: Db, stepExecutionId: string): Promise<StepExecutionRow | null> {
  return runOne<StepExecutionRow>(
    db,
    `UPDATE step_executions
        SET status = 'pending', error = NULL, output = NULL, started_at = NULL, finished_at = NULL,
            resolved_manually = false, resolution = NULL, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [stepExecutionId],
  );
}

/** Marks the steps after a permanent failure as skipped. */
export async function skipRemainingSteps(
  db: Db,
  executionId: string,
  fromStepIndex: number,
): Promise<number> {
  const result = await run(
    db,
    `UPDATE step_executions
        SET status = 'skipped', finished_at = now(), updated_at = now()
      WHERE execution_id = $1 AND step_index > $2 AND status = 'pending'`,
    [executionId, fromStepIndex],
  );
  return result.length;
}

export async function recordManualResolution(
  db: Db,
  input: {
    stepExecutionId: string;
    to: 'succeeded' | 'failed';
    actorId: string | null;
    reason: string;
  },
): Promise<StepExecutionRow | null> {
  return runOne<StepExecutionRow>(
    db,
    `UPDATE step_executions
        SET status = $2,
            resolved_manually = true,
            resolution = $3::jsonb,
            finished_at = now(),
            updated_at = now()
      WHERE id = $1 AND status = 'outcome_unknown'
      RETURNING *`,
    [
      input.stepExecutionId,
      input.to,
      JSON.stringify({ actorId: input.actorId, reason: input.reason, resolvedAt: new Date().toISOString(), outcome: input.to }),
    ],
  );
}

// ---------------------------------------------------------------- step attempts

export async function insertStepAttempt(
  db: Db,
  input: { stepExecutionId: string; attemptNumber: number; idempotencyKey: string },
): Promise<StepAttemptRow> {
  const row = await runOne<StepAttemptRow>(
    db,
    `INSERT INTO step_attempts (step_execution_id, attempt_number, status, idempotency_key)
     VALUES ($1, $2, 'running', $3)
     ON CONFLICT (step_execution_id, attempt_number) DO UPDATE
        SET status = 'running', error = NULL, started_at = now(), finished_at = NULL, idempotency_key = EXCLUDED.idempotency_key
     RETURNING *`,
    [input.stepExecutionId, input.attemptNumber, input.idempotencyKey],
  );
  if (!row) throw new RepositoryError('failed to create step attempt', 'insert_failed', 500);
  return row;
}

export async function finishStepAttempt(
  db: Db,
  input: {
    stepExecutionId: string;
    attemptNumber: number;
    status: 'succeeded' | 'failed' | 'timed_out';
    error?: object | null;
    durationMs?: number;
  },
): Promise<void> {
  await run(
    db,
    `UPDATE step_attempts
        SET status = $3,
            error = $4::jsonb,
            finished_at = now(),
            duration_ms = $5
      WHERE step_execution_id = $1 AND attempt_number = $2`,
    [
      input.stepExecutionId,
      input.attemptNumber,
      input.status,
      input.error === undefined || input.error === null ? null : JSON.stringify(input.error),
      input.durationMs ?? null,
    ],
  );
}

export async function listStepAttempts(db: Db, stepExecutionId: string): Promise<StepAttemptRow[]> {
  return run<StepAttemptRow>(
    db,
    'SELECT * FROM step_attempts WHERE step_execution_id = $1 ORDER BY attempt_number ASC',
    [stepExecutionId],
  );
}

/**
 * Counts the attempts that actually reached the provider.
 *
 * Infrastructure failures (database or Redis unavailable) do not consume an
 * attempt: the system retries the job instead.
 */
export async function countConsumedAttempts(db: Db, stepExecutionId: string): Promise<number> {
  const row = await runOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM step_attempts
      WHERE step_execution_id = $1
        AND (error IS NULL OR error->>'class' IS DISTINCT FROM 'internal_infrastructure')`,
    [stepExecutionId],
  );
  return Number(row?.count ?? 0);
}

export async function countStepAttempts(db: Db, stepExecutionId: string): Promise<number> {
  const row = await runOne<{ count: string }>(
    db,
    'SELECT count(*)::text AS count FROM step_attempts WHERE step_execution_id = $1',
    [stepExecutionId],
  );
  return Number(row?.count ?? 0);
}

// -------------------------------------------------------------- trigger events

/**
 * Records a webhook receipt.
 *
 * The unique index on (endpoint_id, source_key) makes the insert the
 * deduplication point: a repeated delivery returns the existing row.
 */
export async function insertTriggerEvent(
  db: Db,
  input: {
    workflowId: string;
    endpointId: string | null;
    sourceKey: string | null;
    payloadDigest: string;
    payload?: Record<string, unknown> | null;
  },
): Promise<{ row: TriggerEventRow; created: boolean }> {
  const row = await runOne<TriggerEventRow>(
    db,
    `INSERT INTO trigger_events (workflow_id, endpoint_id, source_key, payload_digest, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      input.workflowId,
      input.endpointId,
      input.sourceKey,
      input.payloadDigest,
      input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
    ],
  );
  if (row) return { row, created: true };

  const existing = await runOne<TriggerEventRow>(
    db,
    `SELECT * FROM trigger_events
      WHERE endpoint_id IS NOT DISTINCT FROM $1 AND source_key IS NOT DISTINCT FROM $2
      ORDER BY received_at ASC LIMIT 1`,
    [input.endpointId, input.sourceKey],
  );
  if (!existing) throw new RepositoryError('failed to record trigger event', 'insert_failed', 500);
  return { row: existing, created: false };
}

export async function setTriggerEventResponse(
  db: Db,
  eventId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await run(db, 'UPDATE trigger_events SET response = $2::jsonb WHERE id = $1', [eventId, JSON.stringify(response)]);
}

// --------------------------------------------------------------------- outbox

export async function insertOutboxEvent(
  db: Db,
  input: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
): Promise<OutboxEventRow> {
  const row = await runOne<OutboxEventRow>(
    db,
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [input.aggregateType, input.aggregateId, input.eventType, JSON.stringify(input.payload)],
  );
  if (!row) throw new RepositoryError('failed to create outbox event', 'insert_failed', 500);
  return row;
}

/**
 * Claims a batch of outbox rows.
 *
 * `FOR UPDATE SKIP LOCKED` lets several dispatchers run safely in parallel.
 * The claim installs a visibility timeout: if the dispatcher dies, the row
 * becomes visible again after the timeout instead of being lost.
 */
export async function claimOutboxEvents(db: Db, limit: number): Promise<OutboxEventRow[]> {
  return run<OutboxEventRow>(
    db,
    `UPDATE outbox_events
        SET status = 'failed',
            attempt_count = attempt_count + 1,
            next_attempt_at = now() + interval '30 seconds'
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit],
  );
}

export async function markOutboxPublished(db: Db, id: string): Promise<void> {
  await run(
    db,
    `UPDATE outbox_events SET status = 'published', published_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

export async function markOutboxFailed(
  db: Db,
  input: { id: string; error: string; nextAttemptAt: Date; deadLetter: boolean },
): Promise<void> {
  await run(
    db,
    `UPDATE outbox_events
        SET status = $2, last_error = $3, next_attempt_at = $4
      WHERE id = $1`,
    [input.id, input.deadLetter ? 'dead_letter' : 'failed', input.error, input.nextAttemptAt],
  );
}

export async function countOutboxByStatus(db: Db): Promise<Record<string, number>> {
  const rows = await run<{ status: string; count: string }>(
    db,
    'SELECT status, count(*)::text AS count FROM outbox_events GROUP BY status',
  );
  const result: Record<string, number> = { pending: 0, published: 0, failed: 0, dead_letter: 0 };
  for (const row of rows) result[row.status] = Number(row.count);
  return result;
}

export async function outboxLagSeconds(db: Db): Promise<number | null> {
  const row = await runOne<{ lag: string | null }>(
    db,
    `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::text AS lag
       FROM outbox_events WHERE status IN ('pending', 'failed')`,
  );
  return row?.lag ? Number(row.lag) : null;
}

/** Deletes published outbox rows after the retention period. */
export async function pruneOutboxEvents(db: Db, retentionDays: number): Promise<number> {
  const result = await run(
    db,
    `DELETE FROM outbox_events
      WHERE status = 'published' AND published_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)],
  );
  return result.length;
}

// ------------------------------------------------------------- retry requests

/**
 * Registers a recovery request.
 *
 * The idempotency key is unique, so two simultaneous retries of the same step
 * create one recovery, not two.
 */
export async function insertRetryRequest(
  db: Db,
  input: { executionId: string; stepKey: string; idempotencyKey: string; actorId: string | null },
): Promise<{ row: RetryRequestRow; created: boolean }> {
  const row = await runOne<RetryRequestRow>(
    db,
    `INSERT INTO retry_requests (execution_id, step_key, idempotency_key, actor_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [input.executionId, input.stepKey, input.idempotencyKey, input.actorId],
  );
  if (row) return { row, created: true };
  const existing = await runOne<RetryRequestRow>(
    db,
    'SELECT * FROM retry_requests WHERE idempotency_key = $1',
    [input.idempotencyKey],
  );
  if (!existing) throw new RepositoryError('failed to create retry request', 'insert_failed', 500);
  return { row: existing, created: false };
}

// ---------------------------------------------------------------------- audit

export async function insertAuditEvent(
  db: Db,
  input: {
    workspaceId: string;
    actorId?: string | null;
    actorType: 'user' | 'system';
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<AuditEventRow> {
  const row = await runOne<AuditEventRow>(
    db,
    `INSERT INTO audit_events (workspace_id, actor_id, actor_type, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING *`,
    [
      input.workspaceId,
      input.actorId ?? null,
      input.actorType,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (!row) throw new RepositoryError('failed to create audit event', 'insert_failed', 500);
  return row;
}

export async function listAuditEvents(
  db: Db,
  workspaceId: string,
  filters: { targetType?: string; targetId?: string; page: number; pageSize: number },
): Promise<{ rows: AuditEventRow[]; total: number }> {
  const conditions = ['workspace_id = $1'];
  const params: unknown[] = [workspaceId];
  if (filters.targetType) {
    params.push(filters.targetType);
    conditions.push(`target_type = $${params.length}`);
  }
  if (filters.targetId) {
    params.push(filters.targetId);
    conditions.push(`target_id = $${params.length}`);
  }
  const where = conditions.join(' AND ');
  const totalRow = await runOne<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM audit_events WHERE ${where}`,
    params,
  );
  const rows = await run<AuditEventRow>(
    db,
    `SELECT * FROM audit_events WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
  );
  return { rows, total: Number(totalRow?.count ?? 0) };
}

// ------------------------------------------------------------------- contacts

export async function upsertContact(
  db: Db,
  input: {
    name?: string | null;
    email?: string | null;
    message?: string | null;
    source?: string | null;
    dedupeKey?: string | null;
  },
): Promise<ContactRow> {
  if (input.dedupeKey) {
    const row = await runOne<ContactRow>(
      db,
      `INSERT INTO contacts (name, email, message, source, dedupe_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO UPDATE
          SET name = EXCLUDED.name, email = EXCLUDED.email, message = EXCLUDED.message, source = EXCLUDED.source
       RETURNING *`,
      [input.name ?? null, input.email ?? null, input.message ?? null, input.source ?? null, input.dedupeKey],
    );
    if (!row) throw new RepositoryError('failed to upsert contact', 'write_failed', 500);
    return row;
  }
  const row = await runOne<ContactRow>(
    db,
    `INSERT INTO contacts (name, email, message, source, dedupe_key)
     VALUES ($1, $2, $3, $4, NULL) RETURNING *`,
    [input.name ?? null, input.email ?? null, input.message ?? null, input.source ?? null],
  );
  if (!row) throw new RepositoryError('failed to insert contact', 'write_failed', 500);
  return row;
}

// ------------------------------------------------------------------ heartbeats

export async function upsertHeartbeat(
  db: Db,
  input: { workerId: string; currentExecutionId: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await run(
    db,
    `INSERT INTO worker_heartbeats (worker_id, last_seen_at, current_execution_id, metadata)
     VALUES ($1, now(), $2, $3::jsonb)
     ON CONFLICT (worker_id) DO UPDATE
        SET last_seen_at = now(), current_execution_id = EXCLUDED.current_execution_id, metadata = EXCLUDED.metadata`,
    [input.workerId, input.currentExecutionId, JSON.stringify(input.metadata ?? {})],
  );
}

export async function listHeartbeats(db: Db): Promise<WorkerHeartbeatRow[]> {
  return run<WorkerHeartbeatRow>(
    db,
    'SELECT * FROM worker_heartbeats WHERE last_seen_at > now() - interval \'5 minutes\' ORDER BY worker_id',
  );
}

export { getPool };

export type {
  AuditEventRow,
  ContactRow,
  CredentialRow,
  ExecutionRow,
  MembershipRow,
  OutboxEventRow,
  RetryRequestRow,
  ScheduleOccurrenceRow,
  ScheduleRow,
  StepAttemptRow,
  StepExecutionRow,
  TriggerEventRow,
  WebhookEndpointRow,
  WorkerHeartbeatRow,
  WorkflowDraftRow,
  WorkflowRow,
  WorkflowVersionRow,
  WorkspaceRow,
} from './rows.js';
