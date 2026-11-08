import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { ExecutionStatus, StepStatus, TriggerType, WorkflowDefinition, WorkflowStatus } from '@s9/core';
import { getDb } from './client.js';
import type { Db } from './client.js';
import {
  auditEvents,
  contacts,
  credentials,
  executions,
  outboxEvents,
  retryRequests,
  scheduleOccurrences,
  schedules,
  stepAttempts,
  stepExecutions,
  triggerEvents,
  webhookEndpoints,
  workerHeartbeats,
  workflowDrafts,
  workflowVersions,
  workflows,
  workspaceMemberships,
  workspaces,
  type EncryptedSecret,
} from './schema.js';
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
 * `Db` (database or transaction) so the caller controls the transaction
 * boundary. The durable state always lives in PostgreSQL.
 */

export type { Db };

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

function requireRow<T>(row: T | undefined, message: string, code = 'insert_failed'): T {
  if (!row) throw new RepositoryError(message, code, 500);
  return row;
}

// ------------------------------------------------------------------ workspaces

export async function createWorkspace(db: Db, name: string): Promise<WorkspaceRow> {
  const [row] = await db.insert(workspaces).values({ name }).returning();
  return requireRow(row, 'failed to create workspace');
}

export async function listWorkspacesForUser(db: Db, userId: string): Promise<(WorkspaceRow & { role: string })[]> {
  return db
    .select({ ...getTableColumns(workspaces), role: workspaceMemberships.role })
    .from(workspaces)
    .innerJoin(workspaceMemberships, eq(workspaceMemberships.workspace_id, workspaces.id))
    .where(eq(workspaceMemberships.user_id, userId))
    .orderBy(asc(workspaces.created_at));
}

export async function findMembership(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<MembershipRow | null> {
  const [row] = await db
    .select()
    .from(workspaceMemberships)
    .where(and(eq(workspaceMemberships.workspace_id, workspaceId), eq(workspaceMemberships.user_id, userId)))
    .limit(1);
  return row ?? null;
}

export async function addMembership(
  db: Db,
  workspaceId: string,
  userId: string,
  role: 'owner' | 'editor' | 'viewer',
): Promise<MembershipRow> {
  const [row] = await db
    .insert(workspaceMemberships)
    .values({ workspace_id: workspaceId, user_id: userId, role })
    .onConflictDoUpdate({
      target: [workspaceMemberships.workspace_id, workspaceMemberships.user_id],
      set: { role },
    })
    .returning();
  return requireRow(row, 'failed to add membership');
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
  const [created] = await db
    .insert(workflows)
    .values({
      workspace_id: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
      trigger_type: input.triggerType,
    })
    .returning();
  const workflow = requireRow(created, 'failed to create workflow');

  await db.insert(workflowDrafts).values({
    workflow_id: workflow.id,
    definition: input.definition,
    revision: 1,
  });

  return workflow;
}

export async function getWorkflow(db: Db, workspaceId: string, workflowId: string): Promise<WorkflowRow | null> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.workspace_id, workspaceId)))
    .limit(1);
  return row ?? null;
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
  const conditions: (SQL | undefined)[] = [eq(workflows.workspace_id, workspaceId)];
  if (filters.status && filters.status !== 'all') {
    conditions.push(eq(workflows.status, filters.status));
  }
  if (filters.triggerType && filters.triggerType !== 'all') {
    conditions.push(eq(workflows.trigger_type, filters.triggerType));
  }
  if (filters.search) {
    conditions.push(sql`${workflows.name} ILIKE ${`%${filters.search}%`}`);
  }
  const where = and(...conditions);

  const [totalRow] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(workflows)
    .where(where);

  const rows = await db
    .select({
      ...getTableColumns(workflows),
      current_version_number: workflowVersions.version_number,
      has_unpublished_changes: sql<boolean>`(${workflowDrafts.revision} IS NOT NULL AND ${workflowDrafts.definition}::text IS DISTINCT FROM ${workflowVersions.definition}::text)`,
      last_run_at: sql<Date | null>`(
        SELECT e.created_at FROM executions e
         WHERE e.workflow_id = ${workflows.id}
         ORDER BY e.created_at DESC LIMIT 1
      )`,
      last_run_status: sql<ExecutionStatus | null>`(
        SELECT e.status FROM executions e
         WHERE e.workflow_id = ${workflows.id}
         ORDER BY e.created_at DESC LIMIT 1
      )`,
      step_count: sql<number>`COALESCE(jsonb_array_length(${workflowDrafts.definition}->'steps'), 0)`,
    })
    .from(workflows)
    .leftJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .leftJoin(workflowDrafts, eq(workflowDrafts.workflow_id, workflows.id))
    .where(where)
    .orderBy(desc(workflows.updated_at))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  return { rows, total: Number(totalRow?.count ?? 0) };
}

export async function getDraft(db: Db, workflowId: string): Promise<WorkflowDraftRow | null> {
  const [row] = await db
    .select()
    .from(workflowDrafts)
    .where(eq(workflowDrafts.workflow_id, workflowId))
    .limit(1);
  return row ?? null;
}

export async function getLatestVersion(db: Db, workflowId: string): Promise<WorkflowVersionRow | null> {
  const [row] = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflow_id, workflowId))
    .orderBy(desc(workflowVersions.version_number))
    .limit(1);
  return row ?? null;
}

export async function listVersions(db: Db, workflowId: string): Promise<WorkflowVersionRow[]> {
  return db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflow_id, workflowId))
    .orderBy(desc(workflowVersions.version_number));
}

export async function getVersion(db: Db, versionId: string): Promise<WorkflowVersionRow | null> {
  const [row] = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, versionId))
    .limit(1);
  return row ?? null;
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
  const [row] = await db
    .update(workflowDrafts)
    .set({
      definition,
      revision: sql`${workflowDrafts.revision} + 1`,
      updated_at: sql`now()`,
    })
    .where(and(eq(workflowDrafts.workflow_id, workflowId), eq(workflowDrafts.revision, expectedRevision)))
    .returning();
  if (!row) {
    throw new ConflictError(
      'the draft was modified by someone else, reload the workflow and try again',
      'draft_revision_conflict',
    );
  }
  await touchWorkflow(db, workflowId);
  return row;
}

export async function setWorkflowStatus(
  db: Db,
  workflowId: string,
  status: WorkflowStatus,
): Promise<WorkflowRow | null> {
  const [row] = await db
    .update(workflows)
    .set({ status, updated_at: sql`now()` })
    .where(eq(workflows.id, workflowId))
    .returning();
  return row ?? null;
}

export async function touchWorkflow(db: Db, workflowId: string): Promise<void> {
  await db
    .update(workflows)
    .set({ updated_at: sql`now()` })
    .where(eq(workflows.id, workflowId));
}

export async function updateWorkflowDetails(
  db: Db,
  workflowId: string,
  input: { name?: string; description?: string | null },
): Promise<void> {
  const set: { name?: string; description?: string | null; updated_at: SQL } = {
    updated_at: sql`now()`,
  };
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  await db.update(workflows).set(set).where(eq(workflows.id, workflowId));
}

export async function createWorkflowVersion(
  db: Db,
  input: {
    workflowId: string;
    versionNumber: number;
    definition: WorkflowDefinition;
    publishedBy: string | null;
  },
): Promise<WorkflowVersionRow> {
  const [row] = await db
    .insert(workflowVersions)
    .values({
      workflow_id: input.workflowId,
      version_number: input.versionNumber,
      definition: input.definition,
      published_by: input.publishedBy,
    })
    .returning();
  return requireRow(row, 'failed to create workflow version');
}

export async function setWorkflowPublished(
  db: Db,
  workflowId: string,
  versionId: string,
  triggerType: TriggerType,
): Promise<void> {
  await db
    .update(workflows)
    .set({
      current_version_id: versionId,
      status: 'published',
      trigger_type: triggerType,
      updated_at: sql`now()`,
    })
    .where(eq(workflows.id, workflowId));
}

// ----------------------------------------------------------------- credentials

export async function listCredentials(db: Db, workspaceId: string): Promise<CredentialRow[]> {
  return db
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspace_id, workspaceId), isNull(credentials.deleted_at)))
    .orderBy(desc(credentials.created_at));
}

export async function getCredential(db: Db, workspaceId: string, credentialId: string): Promise<CredentialRow | null> {
  const [row] = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.id, credentialId),
        eq(credentials.workspace_id, workspaceId),
        isNull(credentials.deleted_at),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertCredential(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    provider: string;
    encryptedSecret: EncryptedSecret;
    metadata?: Record<string, unknown>;
  },
): Promise<CredentialRow> {
  const [row] = await db
    .insert(credentials)
    .values({
      workspace_id: input.workspaceId,
      name: input.name,
      provider: input.provider,
      encrypted_secret: input.encryptedSecret,
      metadata: input.metadata ?? {},
    })
    .returning();
  return requireRow(row, 'failed to create credential');
}

export async function updateCredentialSecret(
  db: Db,
  workspaceId: string,
  credentialId: string,
  encryptedSecret: EncryptedSecret,
): Promise<CredentialRow | null> {
  const [row] = await db
    .update(credentials)
    .set({ encrypted_secret: encryptedSecret, updated_at: sql`now()` })
    .where(
      and(
        eq(credentials.id, credentialId),
        eq(credentials.workspace_id, workspaceId),
        isNull(credentials.deleted_at),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Soft deletes a credential.
 *
 * A credential that is referenced by a published workflow must not be deleted;
 * the caller checks the references first.
 */
export async function softDeleteCredential(db: Db, workspaceId: string, credentialId: string): Promise<boolean> {
  const rows = await db
    .update(credentials)
    .set({ deleted_at: sql`now()` })
    .where(
      and(
        eq(credentials.id, credentialId),
        eq(credentials.workspace_id, workspaceId),
        isNull(credentials.deleted_at),
      ),
    )
    .returning({ id: credentials.id });
  return rows.length > 0;
}

/** Finds published workflows that reference the given credential. */
export async function findCredentialReferences(
  db: Db,
  credentialId: string,
): Promise<{ id: string; name: string; version_number: number }[]> {
  return db
    .select({
      id: workflows.id,
      name: workflows.name,
      version_number: workflowVersions.version_number,
    })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflow_id))
    .where(sql`${workflowVersions.definition}::text LIKE ${`%${credentialId}%`}`);
}

// ------------------------------------------------------------ webhook endpoints

export async function getWebhookEndpointByWorkflow(
  db: Db,
  workflowId: string,
): Promise<WebhookEndpointRow | null> {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.workflow_id, workflowId))
    .limit(1);
  return row ?? null;
}

export async function getWebhookEndpointBySlug(db: Db, slug: string): Promise<WebhookEndpointRow | null> {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.slug, slug))
    .limit(1);
  return row ?? null;
}

export async function insertWebhookEndpoint(
  db: Db,
  input: {
    workflowId: string;
    slug: string;
    secretHash: string;
    encryptedSecret: EncryptedSecret | null;
    requireSignature: boolean;
  },
): Promise<WebhookEndpointRow> {
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      workflow_id: input.workflowId,
      slug: input.slug,
      secret_hash: input.secretHash,
      encrypted_secret: input.encryptedSecret,
      require_signature: input.requireSignature,
    })
    .returning();
  return requireRow(row, 'failed to create webhook endpoint');
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
  encryptedSecret: EncryptedSecret | null,
  previousSecretHash: string | null,
  previousEncryptedSecret: EncryptedSecret | null,
  overlapMs: number,
): Promise<WebhookEndpointRow | null> {
  const [row] = await db
    .update(webhookEndpoints)
    .set({
      secret_hash: secretHash,
      encrypted_secret: encryptedSecret,
      previous_secret_hash: previousSecretHash,
      previous_encrypted_secret: previousEncryptedSecret,
      previous_secret_expires_at:
        previousSecretHash === null
          ? null
          : sql`now() + (${String(overlapMs)} || ' milliseconds')::interval`,
      rotated_at: sql`now()`,
    })
    .where(eq(webhookEndpoints.id, endpointId))
    .returning();
  return row ?? null;
}

/** Looks up a workflow by id without a workspace filter (internal use). */
export async function getWorkflowById(db: Db, workflowId: string): Promise<WorkflowRow | null> {
  const [row] = await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
  return row ?? null;
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
  const [row] = await db
    .insert(schedules)
    .values({
      workflow_id: input.workflowId,
      timezone: input.timezone,
      schedule_spec: input.scheduleSpec,
      enabled: input.enabled,
      catch_up: input.catchUp,
      next_run_at: input.nextRunAt,
    })
    .onConflictDoUpdate({
      target: schedules.workflow_id,
      set: {
        timezone: input.timezone,
        schedule_spec: input.scheduleSpec,
        enabled: input.enabled,
        catch_up: input.catchUp,
        next_run_at: input.nextRunAt,
        updated_at: sql`now()`,
      },
    })
    .returning();
  return requireRow(row, 'failed to upsert schedule', 'write_failed');
}

export async function getScheduleByWorkflow(db: Db, workflowId: string): Promise<ScheduleRow | null> {
  const [row] = await db
    .select()
    .from(schedules)
    .where(eq(schedules.workflow_id, workflowId))
    .limit(1);
  return row ?? null;
}

export async function listSchedules(db: Db, workspaceId: string): Promise<(ScheduleRow & { workflow_name: string })[]> {
  return db
    .select({ ...getTableColumns(schedules), workflow_name: workflows.name })
    .from(schedules)
    .innerJoin(workflows, eq(workflows.id, schedules.workflow_id))
    .where(eq(workflows.workspace_id, workspaceId))
    .orderBy(sql`${schedules.next_run_at} NULLS LAST`);
}

export async function listDueSchedules(db: Db, now: Date): Promise<ScheduleRow[]> {
  return db
    .select()
    .from(schedules)
    .where(
      and(eq(schedules.enabled, true), isNotNull(schedules.next_run_at), lte(schedules.next_run_at, now)),
    )
    .orderBy(asc(schedules.next_run_at))
    .limit(100);
}

export async function updateScheduleRunState(
  db: Db,
  scheduleId: string,
  nextRunAt: Date | null,
  lastOccurrenceAt: Date | null,
): Promise<void> {
  await db
    .update(schedules)
    .set({
      next_run_at: nextRunAt,
      last_occurrence_at: sql`COALESCE(${lastOccurrenceAt}, ${schedules.last_occurrence_at})`,
      updated_at: sql`now()`,
    })
    .where(eq(schedules.id, scheduleId));
}

export async function setScheduleEnabled(
  db: Db,
  scheduleId: string,
  enabled: boolean,
  nextRunAt: Date | null,
): Promise<void> {
  await db
    .update(schedules)
    .set({ enabled, next_run_at: nextRunAt, updated_at: sql`now()` })
    .where(eq(schedules.id, scheduleId));
}

export async function setScheduleNextRun(
  db: Db,
  scheduleId: string,
  nextRunAt: Date | null,
): Promise<void> {
  await db.update(schedules).set({ next_run_at: nextRunAt }).where(eq(schedules.id, scheduleId));
}

export async function disableSchedulesForWorkflow(db: Db, workflowId: string): Promise<void> {
  await db
    .update(schedules)
    .set({ enabled: false, next_run_at: null, updated_at: sql`now()` })
    .where(eq(schedules.workflow_id, workflowId));
}

/**
 * Claims an occurrence slot.
 *
 * The unique constraint on (schedule_id, scheduled_for) is the real guard:
 * the insert only succeeds for the single creator of the occurrence.
 */export async function insertScheduleOccurrence(
  db: Db,
  input: { scheduleId: string; scheduledFor: Date; localKey: string },
): Promise<ScheduleOccurrenceRow | null> {
  const [row] = await db
    .insert(scheduleOccurrences)
    .values({
      schedule_id: input.scheduleId,
      scheduled_for: input.scheduledFor,
      local_key: input.localKey,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function linkOccurrenceToExecution(
  db: Db,
  occurrenceId: string,
  executionId: string,
): Promise<void> {
  await db
    .update(scheduleOccurrences)
    .set({ execution_id: executionId })
    .where(eq(scheduleOccurrences.id, occurrenceId));
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
  const [created] = await db
    .insert(executions)
    .values({
      workspace_id: input.workspaceId,
      workflow_id: input.workflowId,
      workflow_version_id: input.workflowVersionId,
      status: 'queued',
      trigger_type: input.triggerType,
      trigger_event_id: input.triggerEventId ?? null,
      idempotency_key: input.idempotencyKey,
      input: input.input ?? {},
      is_test: input.isTest ?? false,
      rerun_of_execution_id: input.rerunOfExecutionId ?? null,
      definition_snapshot: input.definitionSnapshot ?? null,
      draft_revision: input.draftRevision ?? null,
      queued_at: sql`now()`,
    })
    .returning();
  const execution = requireRow(created, 'failed to create execution');

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
  const [row] = await db
    .select()
    .from(executions)
    .where(and(eq(executions.id, executionId), eq(executions.workspace_id, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function getExecutionById(db: Db, executionId: string): Promise<ExecutionRow | null> {
  const [row] = await db.select().from(executions).where(eq(executions.id, executionId)).limit(1);
  return row ?? null;
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
  const conditions: (SQL | undefined)[] = [eq(executions.workspace_id, workspaceId)];

  if (filters.workflowId) {
    conditions.push(eq(executions.workflow_id, filters.workflowId));
  }
  if (filters.status && filters.status !== 'all') {
    conditions.push(eq(executions.status, filters.status));
  }
  if (filters.triggerType && filters.triggerType !== 'all') {
    conditions.push(eq(executions.trigger_type, filters.triggerType));
  }
  if (filters.isTest && filters.isTest !== 'all') {
    conditions.push(eq(executions.is_test, filters.isTest === 'true'));
  }
  if (filters.search) {
    conditions.push(sql`${executions.id}::text ILIKE ${`%${filters.search}%`}`);
  }
  if (filters.from) {
    conditions.push(sql`${executions.created_at} >= ${filters.from}`);
  }
  if (filters.to) {
    conditions.push(sql`${executions.created_at} <= ${filters.to}`);
  }

  const where = and(...conditions);

  const [totalRow] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(executions)
    .where(where);

  const rows = await db
    .select({
      ...getTableColumns(executions),
      workflow_name: workflows.name,
      version_number: workflowVersions.version_number,
    })
    .from(executions)
    .innerJoin(workflows, eq(workflows.id, executions.workflow_id))
    .innerJoin(workflowVersions, eq(workflowVersions.id, executions.workflow_version_id))
    .where(where)
    .orderBy(desc(executions.created_at))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  return { rows, total: Number(totalRow?.count ?? 0) };
}

export async function countRunningExecutions(db: Db, workflowId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(executions)
    .where(
      and(
        eq(executions.workflow_id, workflowId),
        inArray(executions.status, ['queued', 'running', 'retrying']),
      ),
    );
  return Number(row?.count ?? 0);
}

export async function countOtherRunningExecutions(
  db: Db,
  workflowId: string,
  executionId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(executions)
    .where(
      and(
        eq(executions.workflow_id, workflowId),
        sql`${executions.id} <> ${executionId}`,
        eq(executions.status, 'running'),
      ),
    );
  return Number(row?.count ?? 0);
}

export async function countRunningExecutionsInWorkspace(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(executions)
    .where(
      and(
        eq(executions.workspace_id, workspaceId),
        inArray(executions.status, ['queued', 'running', 'retrying']),
      ),
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
  const set: Record<string, SQL | unknown> = {
    status: input.to,
    updated_at: sql`now()`,
  };

  if (input.error !== undefined) {
    set.error = input.error;
  }
  if (input.output !== undefined) {
    set.output = input.output;
  }
  if (input.finished) {
    set.finished_at = sql`now()`;
  }
  if (input.incrementRunSequence) {
    set.run_sequence = sql`${executions.run_sequence} + 1`;
  }
  if (input.leaseToken !== undefined && input.leaseToken !== null) {
    set.lease_token = input.leaseToken;
  }

  const conditions: (SQL | undefined)[] = [
    eq(executions.id, input.executionId),
    inArray(executions.status, input.from),
  ];
  if (input.leaseToken !== undefined && input.leaseToken !== null) {
    conditions.push(eq(executions.lease_token, input.leaseToken));
  }

  const [row] = await db
    .update(executions)
    // The dynamic map is intentional: only the supplied fields are written.
    .set(set as never)
    .where(and(...conditions))
    .returning();
  return row ?? null;
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
  const [row] = await db
    .update(executions)
    .set({
      status: 'running',
      worker_id: input.workerId,
      lease_token: input.leaseToken,
      lease_expires_at: sql`now() + (${String(input.leaseDurationMs)} || ' milliseconds')::interval`,
      started_at: sql`COALESCE(${executions.started_at}, now())`,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(executions.id, input.executionId),
        inArray(executions.status, ['queued', 'running', 'retrying']),
        or(
          isNull(executions.lease_expires_at),
          sql`${executions.lease_expires_at} < now()`,
          eq(executions.lease_token, input.leaseToken),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/** Extends the lease of a running execution (worker heartbeat). */
export async function heartbeatExecution(
  db: Db,
  input: { executionId: string; leaseToken: string; leaseDurationMs: number },
): Promise<boolean> {
  const rows = await db
    .update(executions)
    .set({
      lease_expires_at: sql`now() + (${String(input.leaseDurationMs)} || ' milliseconds')::interval`,
    })
    .where(
      and(
        eq(executions.id, input.executionId),
        eq(executions.lease_token, input.leaseToken),
        eq(executions.status, 'running'),
      ),
    )
    .returning({ id: executions.id });
  return rows.length > 0;
}

export async function setExecutionLease(
  db: Db,
  input: { executionId: string; leaseToken: string | null; workerId: string | null; leaseDurationMs?: number },
): Promise<void> {
  if (input.leaseToken === null) {
    await db
      .update(executions)
      .set({
        lease_token: null,
        lease_expires_at: null,
        worker_id: null,
        updated_at: sql`now()`,
      })
      .where(eq(executions.id, input.executionId));
    return;
  }
  await db
    .update(executions)
    .set({
      lease_token: input.leaseToken,
      worker_id: input.workerId,
      lease_expires_at: sql`now() + (${String(input.leaseDurationMs ?? 0)} || ' milliseconds')::interval`,
      updated_at: sql`now()`,
    })
    .where(eq(executions.id, input.executionId));
}

/**
 * Moves an execution into the durable retry state and returns its new run
 * sequence. The lease is released so the next continuation can claim it.
 */
export async function deferExecution(db: Db, executionId: string): Promise<number> {
  const [row] = await db
    .update(executions)
    .set({
      status: 'retrying',
      run_sequence: sql`${executions.run_sequence} + 1`,
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(executions.id, executionId),
        inArray(executions.status, ['queued', 'running', 'retrying']),
      ),
    )
    .returning({ run_sequence: executions.run_sequence });
  return row?.run_sequence ?? 0;
}

/**
 * Returns a failed execution to the queue after an operator retry or a manual
 * resolution, clearing the error and the lease.
 */
export async function requeueExecution(db: Db, executionId: string): Promise<number | null> {
  const [row] = await db
    .update(executions)
    .set({
      status: 'queued',
      error: null,
      finished_at: null,
      run_sequence: sql`${executions.run_sequence} + 1`,
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
      updated_at: sql`now()`,
    })
    .where(eq(executions.id, executionId))
    .returning({ run_sequence: executions.run_sequence });
  return row?.run_sequence ?? null;
}

/** Re-enqueues a queued execution whose queue delivery was lost. */
export async function touchQueuedExecution(db: Db, executionId: string): Promise<number | null> {
  const [row] = await db
    .update(executions)
    .set({ run_sequence: sql`${executions.run_sequence} + 1`, updated_at: sql`now()` })
    .where(and(eq(executions.id, executionId), eq(executions.status, 'queued')))
    .returning({ run_sequence: executions.run_sequence });
  return row?.run_sequence ?? null;
}

export async function incrementRunSequence(db: Db, executionId: string): Promise<number> {
  const [row] = await db
    .update(executions)
    .set({ run_sequence: sql`${executions.run_sequence} + 1` })
    .where(eq(executions.id, executionId))
    .returning({ run_sequence: executions.run_sequence });
  return row?.run_sequence ?? 0;
}

/** Finds executions whose lease expired while they were still running. */

export async function findStaleExecutions(db: Db, now: Date): Promise<ExecutionRow[]> {
  return db
    .select()
    .from(executions)
    .where(
      and(
        inArray(executions.status, ['running', 'retrying']),
        isNotNull(executions.lease_expires_at),
        sql`${executions.lease_expires_at} < ${now}`,
      ),
    )
    .orderBy(asc(executions.lease_expires_at))
    .limit(50);
}

/** Finds queued executions that no worker has picked up (Redis data loss). */
export async function findUnstartedExecutions(db: Db, olderThan: Date): Promise<ExecutionRow[]> {
  return db
    .select()
    .from(executions)
    .where(and(eq(executions.status, 'queued'), sql`${executions.queued_at} < ${olderThan}`))
    .orderBy(asc(executions.queued_at))
    .limit(50);
}

// ------------------------------------------------------------- step executions

export async function getStepExecution(
  db: Db,
  executionId: string,
  stepKey: string,
): Promise<StepExecutionRow | null> {
  const [row] = await db
    .select()
    .from(stepExecutions)
    .where(and(eq(stepExecutions.execution_id, executionId), eq(stepExecutions.step_key, stepKey)))
    .limit(1);
  return row ?? null;
}

export async function listStepExecutions(db: Db, executionId: string): Promise<StepExecutionRow[]> {
  return db
    .select()
    .from(stepExecutions)
    .where(eq(stepExecutions.execution_id, executionId))
    .orderBy(asc(stepExecutions.step_index));
}

/** Creates the step rows for a fresh execution. */
export async function createStepExecutions(
  db: Db,
  executionId: string,
  steps: { key: string; name: string; type: string; index: number }[],
): Promise<void> {
  for (const step of steps) {
    await db
      .insert(stepExecutions)
      .values({
        execution_id: executionId,
        step_key: step.key,
        step_index: step.index,
        name: step.name,
        type: step.type,
        status: 'pending',
      })
      .onConflictDoNothing();
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
  const set: Record<string, SQL | unknown> = {
    status: input.to,
    updated_at: sql`now()`,
  };

  if (input.error !== undefined) {
    set.error = input.error;
  }
  if (input.output !== undefined) {
    set.output = input.output;
  }
  if (input.input !== undefined) {
    set.input = input.input;
  }
  if (input.started) {
    set.started_at = sql`COALESCE(${stepExecutions.started_at}, now())`;
  }
  if (input.finished) {
    set.finished_at = sql`now()`;
  }
  if (input.workerId !== undefined) {
    set.worker_id = input.workerId;
  }

  const [row] = await db
    .update(stepExecutions)
    // The dynamic map is intentional: only the supplied fields are written.
    .set(set as never)
    .where(and(eq(stepExecutions.id, input.stepExecutionId), inArray(stepExecutions.status, input.from)))
    .returning();
  return row ?? null;
}

/** Resets a step so that it can run again (retry step). */
export async function resetStepForRetry(db: Db, stepExecutionId: string): Promise<StepExecutionRow | null> {
  const [row] = await db
    .update(stepExecutions)
    .set({
      status: 'pending',
      error: null,
      output: null,
      started_at: null,
      finished_at: null,
      resolved_manually: false,
      resolution: null,
      updated_at: sql`now()`,
    })
    .where(eq(stepExecutions.id, stepExecutionId))
    .returning();
  return row ?? null;
}

/** Marks the steps after a permanent failure as skipped. */
export async function skipRemainingSteps(
  db: Db,
  executionId: string,
  fromStepIndex: number,
): Promise<number> {
  const rows = await db
    .update(stepExecutions)
    .set({ status: 'skipped', finished_at: sql`now()`, updated_at: sql`now()` })
    .where(
      and(
        eq(stepExecutions.execution_id, executionId),
        sql`${stepExecutions.step_index} > ${fromStepIndex}`,
        eq(stepExecutions.status, 'pending'),
      ),
    )
    .returning({ id: stepExecutions.id });
  return rows.length;
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
  const [row] = await db
    .update(stepExecutions)
    .set({
      status: input.to,
      resolved_manually: true,
      resolution: {
        actorId: input.actorId,
        reason: input.reason,
        resolvedAt: new Date().toISOString(),
        outcome: input.to,
      },
      finished_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .where(and(eq(stepExecutions.id, input.stepExecutionId), eq(stepExecutions.status, 'outcome_unknown')))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------- step attempts

export async function insertStepAttempt(
  db: Db,
  input: { stepExecutionId: string; attemptNumber: number; idempotencyKey: string },
): Promise<StepAttemptRow> {
  const [row] = await db
    .insert(stepAttempts)
    .values({
      step_execution_id: input.stepExecutionId,
      attempt_number: input.attemptNumber,
      status: 'running',
      idempotency_key: input.idempotencyKey,
    })
    .onConflictDoUpdate({
      target: [stepAttempts.step_execution_id, stepAttempts.attempt_number],
      set: {
        status: 'running',
        error: null,
        started_at: sql`now()`,
        finished_at: null,
        idempotency_key: input.idempotencyKey,
      },
    })
    .returning();
  return requireRow(row, 'failed to create step attempt');
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
  await db
    .update(stepAttempts)
    .set({
      status: input.status,
      error: (input.error ?? null) as Record<string, unknown> | null,
      finished_at: sql`now()`,
      duration_ms: input.durationMs ?? null,
    })
    .where(
      and(
        eq(stepAttempts.step_execution_id, input.stepExecutionId),
        eq(stepAttempts.attempt_number, input.attemptNumber),
      ),
    );
}

export async function listStepAttempts(db: Db, stepExecutionId: string): Promise<StepAttemptRow[]> {
  return db
    .select()
    .from(stepAttempts)
    .where(eq(stepAttempts.step_execution_id, stepExecutionId))
    .orderBy(asc(stepAttempts.attempt_number));
}

/**
 * Counts the attempts that actually reached the provider.
 *
 * Infrastructure failures (database or Redis unavailable) do not consume an
 * attempt: the system retries the job instead.
 */
export async function countConsumedAttempts(db: Db, stepExecutionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(stepAttempts)
    .where(
      and(
        eq(stepAttempts.step_execution_id, stepExecutionId),
        sql`(${stepAttempts.error} IS NULL OR ${stepAttempts.error}->>'class' IS DISTINCT FROM 'internal_infrastructure')`,
      ),
    );
  return Number(row?.count ?? 0);
}

export async function countStepAttempts(db: Db, stepExecutionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(stepAttempts)
    .where(eq(stepAttempts.step_execution_id, stepExecutionId));
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
  const [row] = await db
    .insert(triggerEvents)
    .values({
      workflow_id: input.workflowId,
      endpoint_id: input.endpointId,
      source_key: input.sourceKey,
      payload_digest: input.payloadDigest,
      payload: input.payload ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { row, created: true };

  const [existing] = await db
    .select()
    .from(triggerEvents)
    .where(
      and(
        sql`${triggerEvents.endpoint_id} IS NOT DISTINCT FROM ${input.endpointId}`,
        sql`${triggerEvents.source_key} IS NOT DISTINCT FROM ${input.sourceKey}`,
      ),
    )
    .orderBy(asc(triggerEvents.received_at))
    .limit(1);
  return { row: requireRow(existing, 'failed to record trigger event'), created: false };
}

export async function setTriggerEventResponse(
  db: Db,
  eventId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await db.update(triggerEvents).set({ response }).where(eq(triggerEvents.id, eventId));
}

export async function getTriggerEventResponse(
  db: Db,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ response: triggerEvents.response })
    .from(triggerEvents)
    .where(eq(triggerEvents.id, eventId))
    .limit(1);
  return row?.response ?? null;
}

/** Finds an execution by the deduplication key of its workflow. */
export async function findExecutionByIdempotencyKey(
  db: Db,
  workflowId: string,
  idempotencyKey: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(eq(executions.workflow_id, workflowId), eq(executions.idempotency_key, idempotencyKey)),
    )
    .limit(1);
  return row ?? null;
}

/** True when the aggregate still has an outbox row that will be published. */
export async function hasPendingOutboxForAggregate(db: Db, aggregateId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregate_id, aggregateId),
        inArray(outboxEvents.status, ['pending', 'failed']),
      ),
    )
    .limit(1);
  return Boolean(row);
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
  const [row] = await db
    .insert(outboxEvents)
    .values({
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      event_type: input.eventType,
      payload: input.payload,
    })
    .returning();
  return requireRow(row, 'failed to create outbox event');
}

/**
 * Claims a batch of outbox rows.
 *
 * `FOR UPDATE SKIP LOCKED` lets several dispatchers run safely in parallel.
 * The claim installs a visibility timeout: if the dispatcher dies, the row
 * becomes visible again after the timeout instead of being lost.
 */
export async function claimOutboxEvents(db: Db, limit: number): Promise<OutboxEventRow[]> {
  const candidates = db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        inArray(outboxEvents.status, ['pending', 'failed']),
        sql`${outboxEvents.next_attempt_at} <= now()`,
      ),
    )
    .orderBy(asc(outboxEvents.next_attempt_at))
    .limit(limit)
    .for('update', { skipLocked: true });

  return db
    .update(outboxEvents)
    .set({
      status: 'failed',
      attempt_count: sql`${outboxEvents.attempt_count} + 1`,
      next_attempt_at: sql`now() + interval '30 seconds'`,
    })
    .where(inArray(outboxEvents.id, candidates))
    .returning();
}

export async function markOutboxPublished(db: Db, id: string): Promise<void> {
  await db
    .update(outboxEvents)
    .set({ status: 'published', published_at: sql`now()`, last_error: null })
    .where(eq(outboxEvents.id, id));
}

export async function markOutboxFailed(
  db: Db,
  input: { id: string; error: string; nextAttemptAt: Date; deadLetter: boolean },
): Promise<void> {
  await db
    .update(outboxEvents)
    .set({
      status: input.deadLetter ? 'dead_letter' : 'failed',
      last_error: input.error,
      next_attempt_at: input.nextAttemptAt,
    })
    .where(eq(outboxEvents.id, input.id));
}

export async function countOutboxByStatus(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: outboxEvents.status, count: sql<string>`count(*)::text` })
    .from(outboxEvents)
    .groupBy(outboxEvents.status);
  const result: Record<string, number> = { pending: 0, published: 0, failed: 0, dead_letter: 0 };
  for (const row of rows) result[row.status] = Number(row.count);
  return result;
}

export async function outboxLagSeconds(db: Db): Promise<number | null> {
  const result = await db.execute<{ lag: string | null }>(
    sql`SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::text AS lag
          FROM outbox_events WHERE status IN ('pending', 'failed')`,
  );
  const lag = result.rows[0]?.lag;
  return lag ? Number(lag) : null;
}

/** Deletes published outbox rows after the retention period. */
export async function pruneOutboxEvents(db: Db, retentionDays: number): Promise<number> {
  const rows = await db
    .delete(outboxEvents)
    .where(
      and(
        eq(outboxEvents.status, 'published'),
        sql`${outboxEvents.published_at} < now() - (${String(retentionDays)} || ' days')::interval`,
      ),
    )
    .returning({ id: outboxEvents.id });
  return rows.length;
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
  const [row] = await db
    .insert(retryRequests)
    .values({
      execution_id: input.executionId,
      step_key: input.stepKey,
      idempotency_key: input.idempotencyKey,
      actor_id: input.actorId,
    })
    .onConflictDoNothing({ target: retryRequests.idempotency_key })
    .returning();
  if (row) return { row, created: true };

  const [existing] = await db
    .select()
    .from(retryRequests)
    .where(eq(retryRequests.idempotency_key, input.idempotencyKey))
    .limit(1);
  return { row: requireRow(existing, 'failed to create retry request'), created: false };
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
  const [row] = await db
    .insert(auditEvents)
    .values({
      workspace_id: input.workspaceId,
      actor_id: input.actorId ?? null,
      actor_type: input.actorType,
      action: input.action,
      target_type: input.targetType ?? null,
      target_id: input.targetId ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();
  return requireRow(row, 'failed to create audit event');
}

export async function listAuditEvents(
  db: Db,
  workspaceId: string,
  filters: { targetType?: string; targetId?: string; page: number; pageSize: number },
): Promise<{ rows: AuditEventRow[]; total: number }> {
  const conditions: (SQL | undefined)[] = [eq(auditEvents.workspace_id, workspaceId)];
  if (filters.targetType) {
    conditions.push(eq(auditEvents.target_type, filters.targetType));
  }
  if (filters.targetId) {
    conditions.push(eq(auditEvents.target_id, filters.targetId));
  }
  const where = and(...conditions);

  const [totalRow] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(auditEvents)
    .where(where);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.created_at))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

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
    const [row] = await db
      .insert(contacts)
      .values({
        name: input.name ?? null,
        email: input.email ?? null,
        message: input.message ?? null,
        source: input.source ?? null,
        dedupe_key: input.dedupeKey,
      })
      .onConflictDoUpdate({
        target: contacts.dedupe_key,
        set: {
          name: sql`excluded.name`,
          email: sql`excluded.email`,
          message: sql`excluded.message`,
          source: sql`excluded.source`,
        },
      })
      .returning();
    return requireRow(row, 'failed to upsert contact', 'write_failed');
  }

  const [row] = await db
    .insert(contacts)
    .values({
      name: input.name ?? null,
      email: input.email ?? null,
      message: input.message ?? null,
      source: input.source ?? null,
      dedupe_key: null,
    })
    .returning();
  return requireRow(row, 'failed to insert contact', 'write_failed');
}

// ------------------------------------------------------------------ heartbeats

export async function upsertHeartbeat(
  db: Db,
  input: { workerId: string; currentExecutionId: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      worker_id: input.workerId,
      last_seen_at: sql`now()`,
      current_execution_id: input.currentExecutionId,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.worker_id,
      set: {
        last_seen_at: sql`now()`,
        current_execution_id: input.currentExecutionId,
        metadata: input.metadata ?? {},
      },
    });
}

export async function listHeartbeats(db: Db): Promise<WorkerHeartbeatRow[]> {
  return db
    .select()
    .from(workerHeartbeats)
    .where(sql`${workerHeartbeats.last_seen_at} > now() - interval '5 minutes'`)
    .orderBy(asc(workerHeartbeats.worker_id));
}

export { getDb };

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
