import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  ExecutionStatus,
  StepStatus,
  TriggerType,
  WorkflowDefinition,
  WorkflowStatus,
} from '@s9/core';

/**
 * The database schema.
 *
 * The workflow tables keep their stored snake_case column names as the
 * TypeScript property names. The repository and the API already speak that
 * shape, and the DTO mappers own the camelCase boundary, so the schema stays
 * a faithful description of the database rather than a third naming layer.
 *
 * The Better-Auth tables are the exception: the auth library addresses its
 * models by their camelCase field names, so those tables expose camelCase
 * properties over the quoted camelCase columns the library expects.
 */

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyId: string;
  version: 1;
}

export type Role = 'owner' | 'editor' | 'viewer';

// ------------------------------------------------------------------ workspaces

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workspace_id: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    role: text('role').$type<Role>().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('workspace_memberships_workspace_user_key').on(table.workspace_id, table.user_id),
    index('workspace_memberships_user_idx').on(table.user_id),
    check('workspace_memberships_role_check', sql`${table.role} IN ('owner', 'editor', 'viewer')`),
  ],
);

// ------------------------------------------------------------------- workflows

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workspace_id: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status')
      .$type<WorkflowStatus>()
      .notNull()
      .default('draft'),
    trigger_type: text('trigger_type').$type<TriggerType>().notNull(),
    current_version_id: uuid('current_version_id').references(
      (): AnyPgColumn => workflowVersions.id,
      { onDelete: 'set null' },
    ),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('workflows_workspace_idx').on(table.workspace_id, table.updated_at.desc()),
    index('workflows_workspace_status_idx').on(table.workspace_id, table.status),
    check(
      'workflows_status_check',
      sql`${table.status} IN ('draft', 'published', 'paused', 'archived')`,
    ),
    check(
      'workflows_trigger_type_check',
      sql`${table.trigger_type} IN ('webhook', 'schedule', 'manual')`,
    ),
  ],
);

export const workflowDrafts = pgTable('workflow_drafts', {
  workflow_id: uuid('workflow_id')
    .primaryKey()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  definition: jsonb('definition').$type<WorkflowDefinition>().notNull(),
  revision: integer('revision').notNull().default(1),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflowVersions = pgTable(
  'workflow_versions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workflow_id: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    version_number: integer('version_number').notNull(),
    definition: jsonb('definition').$type<WorkflowDefinition>().notNull(),
    published_at: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    published_by: text('published_by'),
  },
  (table) => [
    unique('workflow_versions_workflow_version_key').on(table.workflow_id, table.version_number),
    index('workflow_versions_workflow_idx').on(table.workflow_id, table.version_number.desc()),
  ],
);

// ----------------------------------------------------------------- credentials

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workspace_id: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    encrypted_secret: jsonb('encrypted_secret').$type<EncryptedSecret>().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('credentials_workspace_idx')
      .on(table.workspace_id)
      .where(sql`${table.deleted_at} IS NULL`),
  ],
);

// ------------------------------------------------------------ webhook endpoints

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workflow_id: uuid('workflow_id')
      .notNull()
      .unique()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull().unique(),
    secret_hash: text('secret_hash').notNull(),
    encrypted_secret: jsonb('encrypted_secret').$type<EncryptedSecret>(),
    previous_secret_hash: text('previous_secret_hash'),
    previous_encrypted_secret: jsonb('previous_encrypted_secret').$type<EncryptedSecret>(),
    previous_secret_expires_at: timestamp('previous_secret_expires_at', { withTimezone: true }),
    rotated_at: timestamp('rotated_at', { withTimezone: true }),
    require_signature: boolean('require_signature').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ------------------------------------------------------------------- schedules

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workflow_id: uuid('workflow_id')
      .notNull()
      .unique()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    timezone: text('timezone').notNull().default('UTC'),
    schedule_spec: text('schedule_spec').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    catch_up: boolean('catch_up').notNull().default(true),
    next_run_at: timestamp('next_run_at', { withTimezone: true }),
    last_occurrence_at: timestamp('last_occurrence_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('schedules_due_idx')
      .on(table.next_run_at)
      .where(sql`${table.enabled}`),
    index('schedules_enabled_next_run_idx')
      .on(table.next_run_at)
      .where(sql`${table.enabled}`),
  ],
);

export const scheduleOccurrences = pgTable(
  'schedule_occurrences',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    schedule_id: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    scheduled_for: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    local_key: text('local_key').notNull(),
    execution_id: uuid('execution_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('schedule_occurrences_schedule_scheduled_key').on(table.schedule_id, table.scheduled_for),
    unique('schedule_occurrences_schedule_local_key').on(table.schedule_id, table.local_key),
  ],
);

// ------------------------------------------------------------------ executions

export const executions = pgTable(
  'executions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workspace_id: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflow_id: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    workflow_version_id: uuid('workflow_version_id').references(() => workflowVersions.id),
    definition_snapshot: jsonb('definition_snapshot').$type<Record<string, unknown>>(),
    draft_revision: integer('draft_revision'),
    status: text('status').$type<ExecutionStatus>().notNull(),
    trigger_type: text('trigger_type').$type<TriggerType>().notNull(),
    trigger_event_id: uuid('trigger_event_id'),
    idempotency_key: text('idempotency_key').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<Record<string, unknown>>(),
    error: jsonb('error').$type<Record<string, unknown>>(),
    is_test: boolean('is_test').notNull().default(false),
    rerun_of_execution_id: uuid('rerun_of_execution_id').references(
      (): AnyPgColumn => executions.id,
      { onDelete: 'set null' },
    ),
    worker_id: text('worker_id'),
    lease_token: uuid('lease_token'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    run_sequence: integer('run_sequence').notNull().default(0),
    queued_at: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    started_at: timestamp('started_at', { withTimezone: true }),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('executions_workflow_idempotency_key').on(table.workflow_id, table.idempotency_key),
    index('executions_workspace_created_idx').on(table.workspace_id, table.created_at.desc()),
    index('executions_workflow_created_idx').on(table.workflow_id, table.created_at.desc()),
    index('executions_status_idx').on(table.workspace_id, table.status),
    index('executions_lease_idx').on(table.status, table.lease_expires_at),
    index('executions_rerun_idx').on(table.rerun_of_execution_id),
    index('executions_version_idx')
      .on(table.workflow_version_id)
      .where(sql`${table.workflow_version_id} IS NOT NULL`),
    index('executions_updated_at_idx').on(table.workspace_id, table.updated_at.desc()),
    check(
      'executions_status_check',
      sql`${table.status} IN ('queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);

export const stepExecutions = pgTable(
  'step_executions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    execution_id: uuid('execution_id')
      .notNull()
      .references(() => executions.id, { onDelete: 'cascade' }),
    step_key: text('step_key').notNull(),
    step_index: integer('step_index').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    status: text('status').$type<StepStatus>().notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<Record<string, unknown>>(),
    error: jsonb('error').$type<Record<string, unknown>>(),
    resolved_manually: boolean('resolved_manually').notNull().default(false),
    resolution: jsonb('resolution').$type<Record<string, unknown>>(),
    worker_id: text('worker_id'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    started_at: timestamp('started_at', { withTimezone: true }),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('step_executions_execution_step_key').on(table.execution_id, table.step_key),
    index('step_executions_execution_idx').on(table.execution_id, table.step_index),
    check(
      'step_executions_status_check',
      sql`${table.status} IN ('pending', 'running', 'retrying', 'succeeded', 'failed', 'skipped', 'outcome_unknown')`,
    ),
  ],
);

export const stepAttempts = pgTable(
  'step_attempts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    step_execution_id: uuid('step_execution_id')
      .notNull()
      .references(() => stepExecutions.id, { onDelete: 'cascade' }),
    attempt_number: integer('attempt_number').notNull(),
    status: text('status').$type<'running' | 'succeeded' | 'failed' | 'timed_out'>().notNull(),
    error: jsonb('error').$type<Record<string, unknown>>(),
    idempotency_key: text('idempotency_key').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    duration_ms: integer('duration_ms'),
  },
  (table) => [
    unique('step_attempts_step_attempt_key').on(table.step_execution_id, table.attempt_number),
    check(
      'step_attempts_status_check',
      sql`${table.status} IN ('running', 'succeeded', 'failed', 'timed_out')`,
    ),
  ],
);

// -------------------------------------------------------------- trigger events

export const triggerEvents = pgTable(
  'trigger_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workflow_id: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    endpoint_id: uuid('endpoint_id').references(() => webhookEndpoints.id, {
      onDelete: 'set null',
    }),
    source_key: text('source_key'),
    payload_digest: text('payload_digest').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    response: jsonb('response').$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex('trigger_events_dedupe_idx')
      .on(table.endpoint_id, table.source_key)
      .where(sql`${table.source_key} IS NOT NULL`),
  ],
);

// -------------------------------------------------------------------- outbox

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    aggregate_type: text('aggregate_type').notNull(),
    aggregate_id: uuid('aggregate_id').notNull(),
    event_type: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status')
      .$type<'pending' | 'published' | 'failed' | 'dead_letter'>()
      .notNull()
      .default('pending'),
    attempt_count: integer('attempt_count').notNull().default(0),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    published_at: timestamp('published_at', { withTimezone: true }),
    last_error: text('last_error'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('outbox_pending_idx')
      .on(table.next_attempt_at)
      .where(sql`${table.status} IN ('pending', 'failed')`),
    check(
      'outbox_events_status_check',
      sql`${table.status} IN ('pending', 'published', 'failed', 'dead_letter')`,
    ),
  ],
);

// ------------------------------------------------------------- retry requests

export const retryRequests = pgTable(
  'retry_requests',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    execution_id: uuid('execution_id')
      .notNull()
      .references(() => executions.id, { onDelete: 'cascade' }),
    step_key: text('step_key').notNull(),
    idempotency_key: text('idempotency_key').notNull().unique(),
    actor_id: text('actor_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('retry_requests_execution_idx').on(table.execution_id)],
);

// --------------------------------------------------------------------- audit

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workspace_id: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actor_id: text('actor_id'),
    actor_type: text('actor_type').$type<'user' | 'system'>().notNull().default('system'),
    action: text('action').notNull(),
    target_type: text('target_type'),
    target_id: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_workspace_idx').on(table.workspace_id, table.created_at.desc()),
    index('audit_target_idx').on(table.target_type, table.target_id),
    check('audit_events_actor_type_check', sql`${table.actor_type} IN ('user', 'system')`),
  ],
);

// ---------------------------------------------------------------- operations

export const workerHeartbeats = pgTable('worker_heartbeats', {
  worker_id: text('worker_id').primaryKey(),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  current_execution_id: uuid('current_execution_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
});

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name'),
    email: text('email'),
    message: text('message'),
    source: text('source'),
    dedupe_key: text('dedupe_key').unique(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('contacts_created_idx').on(table.created_at.desc())],
);

// ---------------------------------------------------------------- auth tables
//
// These are owned by Better-Auth. The property names must match the library's
// model fields because the Drizzle adapter resolves columns by field name.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expiresAt').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').notNull().defaultNow(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  },
  (table) => [index('account_user_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt').notNull(),
    createdAt: timestamp('createdAt').defaultNow(),
    updatedAt: timestamp('updatedAt').defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/** The full schema, used by the Drizzle client and the auth adapter. */
export const schema = {
  workspaces,
  workspaceMemberships,
  workflows,
  workflowDrafts,
  workflowVersions,
  credentials,
  webhookEndpoints,
  schedules,
  scheduleOccurrences,
  executions,
  stepExecutions,
  stepAttempts,
  triggerEvents,
  outboxEvents,
  retryRequests,
  auditEvents,
  workerHeartbeats,
  contacts,
  user,
  session,
  account,
  verification,
};

export type Schema = typeof schema;
