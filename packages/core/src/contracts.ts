import type { ActionType } from './actions.js';
import type { ErrorClass } from './errors.js';
import type {
  AttemptStatus,
  ExecutionStatus,
  StepStatus,
  WorkflowStatus,
} from './status.js';
import type { TriggerType, WorkflowDefinition } from './definition.js';

/**
 * Wire contracts shared by the API and the web app.
 *
 * The execution lifecycle must stay independent from the frontend transport,
 * so these DTOs are plain JSON shapes with no framework types.
 */

export interface Paginated<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface ActionTypeDto {
  type: ActionType;
  label: string;
  description: string;
  requiredFields: string[];
  defaultSafeToRepeat: boolean;
  /** JSON schema of the configuration, derived from the zod schema. */
  configSchema: Record<string, unknown>;
  /** Example configuration shown in the UI. */
  example: Record<string, unknown>;
}

export interface CredentialDto {
  id: string;
  workspaceId: string;
  name: string;
  provider: string;
  metadata: Record<string, unknown>;
  /** Never the plaintext secret. */
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSummaryDto {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  triggerType: TriggerType;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  /** True when the draft differs from the published version. */
  hasUnpublishedChanges: boolean;
  lastRunAt: string | null;
  lastRunStatus: ExecutionStatus | null;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersionDto {
  id: string;
  workflowId: string;
  versionNumber: number;
  definition: WorkflowDefinition;
  publishedAt: string;
  publishedBy: string | null;
}

export interface WorkflowDraftDto {
  workflowId: string;
  definition: WorkflowDefinition;
  revision: number;
  updatedAt: string;
}

export interface WorkflowDetailDto extends WorkflowSummaryDto {
  draft: WorkflowDraftDto;
  versions: WorkflowVersionDto[];
  webhookEndpoint: WebhookEndpointDto | null;
  schedule: ScheduleDto | null;
  credentialIds: string[];
}

export interface WebhookEndpointDto {
  id: string;
  workflowId: string;
  slug: string;
  /** The public intake URL. */
  url: string;
  requireSignature: boolean;
  rotatedAt: string | null;
  /** True while the previous secret is still accepted during the overlap window. */
  previousSecretValidUntil: string | null;
  createdAt: string;
}

export interface ScheduleDto {
  id: string;
  workflowId: string;
  timezone: string;
  scheduleSpec: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastOccurrenceAt: string | null;
  createdAt: string;
}

export interface ExecutionSummaryDto {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersionId: string | null;
  workflowVersionNumber: number;
  status: ExecutionStatus;
  triggerType: TriggerType;
  triggerEventId: string | null;
  idempotencyKey: string;
  isTest: boolean;
  rerunOfExecutionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  error: StepErrorDto | null;
}

export interface StepErrorDto {
  class: ErrorClass;
  message: string;
  stepKey?: string;
  attempt?: number;
  status?: number;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export interface AttemptDto {
  id: string;
  attemptNumber: number;
  status: AttemptStatus;
  error: StepErrorDto | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Stable idempotency key used for this attempt. */
  idempotencyKey: string;
}

export interface StepExecutionDto {
  id: string;
  executionId: string;
  stepKey: string;
  stepIndex: number;
  name: string;
  type: ActionType;
  status: StepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: StepErrorDto | null;
  /** True when the step was resolved by a human instead of by the worker. */
  resolvedManually: boolean;
  resolution: { actorId: string | null; reason: string; resolvedAt: string; outcome: string } | null;
  attempts: AttemptDto[];
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Whether the action may be safely repeated. */
  safeToRepeat: boolean;
  /** Whether a manual retry is currently allowed. */
  retryable: boolean;
}

export interface ExecutionDetailDto extends ExecutionSummaryDto {
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  steps: StepExecutionDto[];
  timeline: TimelineEventDto[];
  audit: AuditEventDto[];
  /** Recovery operations that the UI may offer. */
  availableActions: {
    retryStep: boolean;
    rerun: boolean;
    cancel: boolean;
    resolveOutcomeUnknown: boolean;
  };
}

export interface TimelineEventDto {
  at: string;
  type: 'execution' | 'step' | 'attempt' | 'audit';
  stepKey?: string;
  attempt?: number;
  message: string;
  status?: ExecutionStatus | StepStatus | AttemptStatus;
}

export interface AuditEventDto {
  id: string;
  workspaceId: string;
  actorId: string | null;
  actorType: 'user' | 'system';
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardStatsDto {
  workflows: { total: number; draft: number; published: number; paused: number; archived: number };
  executions: {
    total: number;
    succeeded: number;
    failed: number;
    running: number;
    queued: number;
    last7Days: number;
    averageDurationMs: number | null;
    successRate: number | null;
  };
  recentExecutions: ExecutionSummaryDto[];
  needsAttention: ExecutionSummaryDto[];
}

export interface OperationQueueStatsDto {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  outbox: { pending: number; failed: number; deadLetter: number; lagSeconds: number | null };
  workers: { id: string; lastSeenAt: string; currentExecutionId: string | null }[];
}

export interface TriggerRunResponseDto {
  executionId: string;
  status: ExecutionStatus;
  /** True when the request was a duplicate and the original execution is returned. */
  duplicate: boolean;
}

export interface RetryResponseDto {
  executionId: string;
  stepKey: string;
  accepted: boolean;
  /** True when a recovery request with the same idempotency key already existed. */
  duplicate: boolean;
}
