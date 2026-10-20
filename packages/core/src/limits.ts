/**
 * Server-defined limits.
 *
 * The blueprint is explicit that "every server-defined limit has a number".
 * These are starting values, not requirements, but they are the single source
 * of truth for validation, the worker and the API.
 */
export const LIMITS = {
  /** Maximum number of steps in a publishable workflow. */
  maxSteps: 10,
  /** Maximum accepted webhook body size in bytes. */
  maxWebhookBodyBytes: 256 * 1024,
  /** Maximum HTTP action response body size in bytes. */
  maxHttpResponseBytes: 1024 * 1024,
  /** Default per-step timeout in milliseconds. */
  defaultStepTimeoutMs: 30_000,
  /** Maximum per-step timeout in milliseconds. */
  maxStepTimeoutMs: 120_000,
  /** Maximum total execution duration in milliseconds (active run time). */
  defaultExecutionTimeoutMs: 10 * 60_000,
  /** Default number of attempts per step. */
  defaultMaxAttempts: 3,
  /** Maximum number of attempts per step. */
  maxAttempts: 5,
  /** Base backoff delay in milliseconds. */
  defaultBaseDelayMs: 5_000,
  /** Maximum backoff delay in milliseconds. */
  defaultMaxDelayMs: 5 * 60_000,
  /** Webhook deduplication window in milliseconds (24h). */
  webhookDedupeWindowMs: 24 * 60 * 60_000,
  /** Webhook signature timestamp tolerance in milliseconds (5 minutes). */
  webhookSignatureToleranceMs: 5 * 60_000,
  /** Execution payload retention in days. */
  payloadRetentionDays: 30,
  /** Maximum active (running) executions per workflow. */
  defaultWorkflowConcurrency: 1,
  /** Maximum queued executions per workflow before intake is rejected. */
  maxQueuedExecutionsPerWorkflow: 1_000,
  /** Maximum queued executions per workspace before intake is rejected. */
  maxQueuedExecutionsPerWorkspace: 5_000,
  /** Maximum number of pages / rows a single list endpoint may return. */
  defaultPageSize: 25,
  maxPageSize: 100,
  /** Maximum number of steps in a single request body for the API. */
  maxApiBodyBytes: 1024 * 1024,
  /** Lease duration: must exceed the maximum step timeout plus a heartbeat margin. */
  leaseDurationMs: 120_000 + 60_000,
  /** How often the worker heartbeats its lease. */
  leaseHeartbeatMs: 30_000,
  /** Maximum number of outbox publish attempts before the row becomes dead_letter. */
  maxOutboxAttempts: 8,
  /** Maximum age of a missed schedule occurrence that may still catch up. */
  scheduleCatchUpWindowMs: 24 * 60 * 60_000,
  /** Retention for published outbox rows before cleanup deletes them. */
  outboxRetentionDays: 7,
  /** Max length of a stored error summary (chars). */
  maxErrorSummaryLength: 500,
} as const;

export type Limits = typeof LIMITS;
