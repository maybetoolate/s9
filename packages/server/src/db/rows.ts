import type { ExecutionStatus, StepStatus, WorkflowStatus } from '@s9/core';

/**
 * Row shapes returned by the database.
 *
 * The repository layer speaks snake_case (as stored); the API maps them to the
 * camelCase DTOs in `@s9/core/contracts`.
 */

export interface WorkspaceRow {
  id: string;
  name: string;
  created_at: Date;
}

export interface MembershipRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'editor' | 'viewer';
  created_at: Date;
}

export interface WorkflowRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  trigger_type: 'webhook' | 'schedule' | 'manual';
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowDraftRow {
  workflow_id: string;
  definition: Record<string, unknown>;
  revision: number;
  updated_at: Date;
}

export interface WorkflowVersionRow {
  id: string;
  workflow_id: string;
  version_number: number;
  definition: Record<string, unknown>;
  published_at: Date;
  published_by: string | null;
}

export interface CredentialRow {
  id: string;
  workspace_id: string;
  name: string;
  provider: string;
  encrypted_secret: { ciphertext: string; iv: string; authTag: string; keyId: string; version: 1 };
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface WebhookEndpointRow {
  id: string;
  workflow_id: string;
  slug: string;
  secret_hash: string;
  encrypted_secret: { ciphertext: string; iv: string; authTag: string; keyId: string; version: 1 } | null;
  previous_secret_hash: string | null;
  previous_encrypted_secret: { ciphertext: string; iv: string; authTag: string; keyId: string; version: 1 } | null;
  previous_secret_expires_at: Date | null;
  rotated_at: Date | null;
  require_signature: boolean;
  created_at: Date;
}

export interface ScheduleRow {
  id: string;
  workflow_id: string;
  timezone: string;
  schedule_spec: string;
  enabled: boolean;
  catch_up: boolean;
  next_run_at: Date | null;
  last_occurrence_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScheduleOccurrenceRow {
  id: string;
  schedule_id: string;
  scheduled_for: Date;
  local_key: string;
  execution_id: string | null;
  created_at: Date;
}

export interface ExecutionRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  workflow_version_id: string | null;
  definition_snapshot: Record<string, unknown> | null;
  draft_revision: number | null;
  status: ExecutionStatus;
  trigger_type: 'webhook' | 'schedule' | 'manual';
  trigger_event_id: string | null;
  idempotency_key: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  is_test: boolean;
  rerun_of_execution_id: string | null;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  run_sequence: number;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface StepExecutionRow {
  id: string;
  execution_id: string;
  step_key: string;
  step_index: number;
  name: string;
  type: string;
  status: StepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  resolved_manually: boolean;
  resolution: Record<string, unknown> | null;
  worker_id: string | null;
  lease_expires_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface StepAttemptRow {
  id: string;
  step_execution_id: string;
  attempt_number: number;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out';
  error: Record<string, unknown> | null;
  idempotency_key: string;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
}

export interface TriggerEventRow {
  id: string;
  workflow_id: string;
  endpoint_id: string | null;
  source_key: string | null;
  payload_digest: string;
  payload: Record<string, unknown> | null;
  received_at: Date;
  response: Record<string, unknown> | null;
}

export interface OutboxEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'published' | 'failed' | 'dead_letter';
  attempt_count: number;
  next_attempt_at: Date;
  published_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export interface RetryRequestRow {
  id: string;
  execution_id: string;
  step_key: string;
  idempotency_key: string;
  actor_id: string | null;
  created_at: Date;
}

export interface AuditEventRow {
  id: string;
  workspace_id: string;
  actor_id: string | null;
  actor_type: 'user' | 'system';
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface WorkerHeartbeatRow {
  worker_id: string;
  last_seen_at: Date;
  current_execution_id: string | null;
  metadata: Record<string, unknown>;
}

export interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  message: string | null;
  source: string | null;
  dedupe_key: string | null;
  created_at: Date;
}
