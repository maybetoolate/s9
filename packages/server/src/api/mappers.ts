import type {
  AuditEventDto,
  StepErrorDto,
  CredentialDto,
  ExecutionDetailDto,
  ExecutionSummaryDto,
  ScheduleDto,
  StepExecutionDto,
  WebhookEndpointDto,
  WorkflowDetailDto,
  WorkflowDraftDto,
  WorkflowSummaryDto,
  WorkflowVersionDto,
} from '@flowforge/core';
import type {
  AuditEventRow,
  CredentialRow,
  ExecutionRow,
  ScheduleRow,
  StepAttemptRow,
  StepExecutionRow,
  WebhookEndpointRow,
  WorkflowDraftRow,
  WorkflowRow,
  WorkflowVersionRow,
} from '../db/rows.js';

/**
 * Row to DTO mapping.
 *
 * The API never returns a plaintext secret, and stored payloads are already
 * redacted when they were written.
 */

export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface WorkflowListRow extends WorkflowRow {
  current_version_number: number | null;
  has_unpublished_changes: boolean;
  last_run_at: Date | null;
  last_run_status: WorkflowSummaryDto['lastRunStatus'];
  step_count: number;
}

export function toWorkflowSummary(row: WorkflowListRow): WorkflowSummaryDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    status: row.status,
    triggerType: row.trigger_type,
    currentVersionId: row.current_version_id,
    currentVersionNumber: row.current_version_number,
    hasUnpublishedChanges: row.has_unpublished_changes,
    lastRunAt: toIso(row.last_run_at),
    lastRunStatus: row.last_run_status,
    stepCount: row.step_count,
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

export function toDraftDto(row: WorkflowDraftRow): WorkflowDraftDto {
  return {
    workflowId: row.workflow_id,
    definition: row.definition as WorkflowDraftDto['definition'],
    revision: row.revision,
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

export function toVersionDto(row: WorkflowVersionRow): WorkflowVersionDto {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    versionNumber: row.version_number,
    definition: row.definition as unknown as WorkflowVersionDto['definition'],
    publishedAt: toIso(row.published_at) ?? '',
    publishedBy: row.published_by,
  };
}

export function toWebhookEndpointDto(row: WebhookEndpointRow, publicUrl: string): WebhookEndpointDto {
  const now = Date.now();
  return {
    id: row.id,
    workflowId: row.workflow_id,
    slug: row.slug,
    url: `${publicUrl.replace(/\/$/, '')}/webhooks/${row.slug}`,
    requireSignature: row.require_signature,
    rotatedAt: toIso(row.rotated_at),
    previousSecretValidUntil:
      row.previous_secret_expires_at && row.previous_secret_expires_at.getTime() > now
        ? toIso(row.previous_secret_expires_at)
        : null,
    createdAt: toIso(row.created_at) ?? '',
  };
}

export function toScheduleDto(row: ScheduleRow): ScheduleDto {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    timezone: row.timezone,
    scheduleSpec: row.schedule_spec,
    enabled: row.enabled,
    nextRunAt: toIso(row.next_run_at),
    lastOccurrenceAt: toIso(row.last_occurrence_at),
    createdAt: toIso(row.created_at) ?? '',
  };
}

export function toCredentialDto(row: CredentialRow): CredentialDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    provider: row.provider,
    metadata: row.metadata ?? {},
    hasSecret: Boolean(row.encrypted_secret),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

export function toExecutionSummary(
  row: ExecutionRow & { workflow_name?: string; version_number?: number },
): ExecutionSummaryDto {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name ?? '',
    workflowVersionId: row.workflow_version_id,
    workflowVersionNumber: row.version_number ?? 0,
    status: row.status,
    triggerType: row.trigger_type,
    triggerEventId: row.trigger_event_id,
    idempotencyKey: row.idempotency_key,
    isTest: row.is_test,
    rerunOfExecutionId: row.rerun_of_execution_id,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    durationMs:
      row.started_at && row.finished_at ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime() : null,
    createdAt: toIso(row.created_at) ?? '',
    error: (row.error as unknown as ExecutionSummaryDto['error']) ?? null,
  };
}

export function toStepExecutionDto(
  row: StepExecutionRow,
  attempts: StepAttemptRow[],
  safeToRepeat: boolean,
): StepExecutionDto {
  return {
    id: row.id,
    executionId: row.execution_id,
    stepKey: row.step_key,
    stepIndex: row.step_index,
    name: row.name,
    type: row.type as StepExecutionDto['type'],
    status: row.status,
    input: row.input ?? {},
    output: row.output,
    error: (row.error as unknown as StepErrorDto) ?? null,
    resolvedManually: row.resolved_manually,
    resolution: (row.resolution as unknown as StepExecutionDto['resolution']) ?? null,
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      error: (attempt.error as unknown as StepErrorDto) ?? null,
      startedAt: toIso(attempt.started_at),
      finishedAt: toIso(attempt.finished_at),
      durationMs: attempt.duration_ms,
      idempotencyKey: attempt.idempotency_key,
    })),
    attemptCount: attempts.length,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    durationMs:
      row.started_at && row.finished_at ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime() : null,
    safeToRepeat,
    retryable: row.status === 'failed' || row.status === 'outcome_unknown',
  };
}

export function toAuditEventDto(row: AuditEventRow): AuditEventDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata ?? {},
    createdAt: toIso(row.created_at) ?? '',
  };
}

export type { ExecutionDetailDto, WorkflowDetailDto };
