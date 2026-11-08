import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  buildExecutionIdempotencyKey,
  canTransitionExecution,
  canTransitionStep,
  LIMITS,
  type ExecutionStatus,
  type TriggerType,
  type WorkflowDefinition,
} from '@s9/core';
import {
  ConflictError,
  createExecutionWithOutbox,
  createStepExecutions,
  getExecution,
  getStepExecution,
  getWorkflow,
  insertAuditEvent,
  insertOutboxEvent,
  insertRetryRequest,
  insertTriggerEvent,
  setTriggerEventResponse,
  linkOccurrenceToExecution,
  recordManualResolution,
  requireWorkflow,
  resetStepForRetry,
  updateExecutionStatus,
  type Db,
} from '../db/repo.js';
import { withTransaction } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Execution service.
 *
 * All state changes that are visible to the user (create, retry, rerun,
 * resolve, cancel) live here so the rules - idempotency, state guards, audit
 * events - are applied in exactly one place.
 */

export interface CreateExecutionRequest {
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string | null;
  triggerType: TriggerType;
  input: Record<string, unknown>;
  /** Stable key used to deduplicate. */
  idempotencyKey: string;
  triggerEventId?: string | null;
  actorId?: string | null;
  isTest?: boolean;
  rerunOfExecutionId?: string | null;
  definition?: WorkflowDefinition;
  /** The pinned definition of a test run. */
  definitionSnapshot?: Record<string, unknown> | null;
  /** The draft revision a test run pinned. */
  draftRevision?: number | null;
}

/**
 * Creates an execution and its outbox event.
 *
 * The outbox row is written in the same transaction as the execution, so the
 * run can never be stranded between the database commit and the queue
 * publish.
 */
export async function createExecution(request: CreateExecutionRequest): Promise<{ id: string; duplicate: boolean }> {
  return withTransaction(async (client) => {
    const existing = await findExistingByIdempotencyKey(client, request.workflowId, request.idempotencyKey);
    if (existing) {
      logger.info(
        { executionId: existing.id, workflowId: request.workflowId },
        'duplicate trigger deduplicated',
      );
      return { id: existing.id, duplicate: true };
    }

    const execution = await createExecutionWithOutbox(client, {
      workspaceId: request.workspaceId,
      workflowId: request.workflowId,
      workflowVersionId: request.workflowVersionId,
      triggerType: request.triggerType,
      triggerEventId: request.triggerEventId ?? null,
      idempotencyKey: request.idempotencyKey,
      input: request.input,
      isTest: request.isTest ?? false,
      rerunOfExecutionId: request.rerunOfExecutionId ?? null,
      actorId: request.actorId ?? null,
      definitionSnapshot: request.definitionSnapshot ?? null,
      draftRevision: request.draftRevision ?? null,
    });

    if (request.definition) {
      await createStepExecutions(
        client,
        execution.id,
        request.definition.steps.map((step, index) => ({
          key: step.key,
          name: step.name,
          type: step.type,
          index,
        })),
      );
    }

    return { id: execution.id, duplicate: false };
  });
}

async function findExistingByIdempotencyKey(
  client: PoolClient,
  workflowId: string,
  idempotencyKey: string,
): Promise<{ id: string } | null> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM executions WHERE workflow_id = $1 AND idempotency_key = $2',
    [workflowId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

/**
 * Creates an execution for a webhook delivery.
 *
 * The trigger event and the execution are written in one transaction, so a
 * repeated delivery inside the deduplication window returns the original
 * execution id and creates nothing.
 */
export async function createWebhookExecution(input: {
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string;
  endpointId: string;
  sourceKey: string | null;
  payload: Record<string, unknown>;
  payloadDigest: string;
  idempotencyKey: string;
}): Promise<{ executionId: string; duplicate: boolean }> {
  return withTransaction(async (client) => {
    const triggerEvent = await insertTriggerEvent(client, {
      workflowId: input.workflowId,
      endpointId: input.endpointId,
      sourceKey: input.sourceKey,
      payloadDigest: input.payloadDigest,
      payload: input.payload,
    });

    if (!triggerEvent.created) {
      const existing = await client.query<{ response: { executionId?: string } | null }>(
        'SELECT response FROM trigger_events WHERE id = $1',
        [triggerEvent.row.id],
      );
      const executionId = existing.rows[0]?.response?.executionId;
      if (!executionId) {
        throw new ConflictError('the event was received but its execution is not known', 'duplicate_event');
      }
      return { executionId, duplicate: true };
    }

    const execution = await createExecutionWithOutbox(client, {
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      triggerType: 'webhook',
      triggerEventId: triggerEvent.row.id,
      idempotencyKey: input.idempotencyKey,
      input: input.payload,
      actorId: null,
    });

    await setTriggerEventResponse(client, triggerEvent.row.id, { executionId: execution.id });
    return { executionId: execution.id, duplicate: false };
  });
}

/**
 * Schedules a continuation of an execution.
 *
 * Every queue publication goes through the outbox, so the dispatcher is the
 * only component that talks to BullMQ. The run sequence is incremented to
 * guarantee a fresh job id.
 */
export async function scheduleContinuation(
  client: PoolClient,
  input: {
    executionId: string;
    runSequence: number;
    workspaceId?: string;
    workflowId?: string;
    delayMs?: number;
  },
): Promise<void> {
  await insertOutboxEvent(client, {
    aggregateType: 'execution',
    aggregateId: input.executionId,
    eventType: 'execution.continue',
    payload: {
      executionId: input.executionId,
      runSequence: input.runSequence,
      workspaceId: input.workspaceId ?? null,
      workflowId: input.workflowId ?? null,
      delayMs: input.delayMs ?? 0,
    },
  });
}

/**
 * Retries a failed step in place.
 *
 * The retry continues the same execution and moves it from failed back to
 * queued. Successful steps are not repeated: their status stays `succeeded`
 * and the engine skips them.
 */
export async function retryStep(input: {
  workspaceId: string;
  executionId: string;
  stepKey: string;
  idempotencyKey: string;
  actorId: string;
}): Promise<{ accepted: boolean; duplicate: boolean }> {
  return withTransaction(async (client) => {
    // The recovery request is registered first: two simultaneous requests for
    // the same step create one recovery, not two. The state checks below run
    // afterwards, and a failing check rolls the request back with the
    // transaction.
    const retryRequest = await insertRetryRequest(client, {
      executionId: input.executionId,
      stepKey: input.stepKey,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
    });

    if (!retryRequest.created) {
      logger.info(
        { executionId: input.executionId, stepKey: input.stepKey },
        'duplicate retry request ignored',
      );
      return { accepted: true, duplicate: true };
    }

    const execution = await getExecution(client, input.workspaceId, input.executionId);
    if (!execution) throw new ConflictError('execution not found', 'not_found');

    const step = await getStepExecution(client, input.executionId, input.stepKey);
    if (!step) throw new ConflictError(`step "${input.stepKey}" not found`, 'not_found');

    if (step.status !== 'failed' && step.status !== 'outcome_unknown') {
      throw new ConflictError(
        `step "${input.stepKey}" is ${step.status} and cannot be retried`,
        'step_not_retryable',
      );
    }
    if (execution.status !== 'failed') {
      throw new ConflictError(
        `execution is ${execution.status}; only a failed execution can be retried`,
        'execution_not_retryable',
      );
    }

    const transition = canTransitionExecution(execution.status, 'queued');
    if (!transition.allowed) throw new ConflictError(transition.reason, 'invalid_transition');

    const stepTransition = canTransitionStep(step.status, 'retrying');
    if (!stepTransition.allowed) throw new ConflictError(stepTransition.reason, 'invalid_transition');

    await resetStepForRetry(client, step.id);

    const updated = await client.query<{ run_sequence: number }>(
      `UPDATE executions
          SET status = 'queued', error = NULL, finished_at = NULL, run_sequence = run_sequence + 1,
              worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1
        RETURNING run_sequence`,
      [input.executionId],
    );
    const runSequence = updated.rows[0]?.run_sequence ?? execution.run_sequence + 1;

    await scheduleContinuation(client, {
      executionId: input.executionId,
      runSequence,
      workspaceId: input.workspaceId,
      workflowId: execution.workflow_id,
    });

    await insertAuditEvent(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorType: 'user',
      action: 'execution.step_retried',
      targetType: 'execution',
      targetId: input.executionId,
      metadata: { stepKey: input.stepKey, idempotencyKey: input.idempotencyKey },
    });

    return { accepted: true, duplicate: false };
  });
}

/**
 * Reruns an execution.
 *
 * A rerun creates a *new* execution linked to the original. It repeats every
 * step, including the ones that already succeeded, so the UI must warn about
 * repeated side effects. The idempotency key is new, so the rerun is not
 * deduplicated against the original.
 */
export async function rerunExecution(input: {
  workspaceId: string;
  executionId: string;
  actorId: string;
  /** Use the current published version instead of the pinned one. */
  useCurrentVersion?: boolean;
  correctedInput?: Record<string, unknown>;
}): Promise<{ id: string }> {
  return withTransaction(async (client) => {
    const original = await getExecution(client, input.workspaceId, input.executionId);
    if (!original) throw new ConflictError('execution not found', 'not_found');

    let workflowVersionId = original.workflow_version_id;
    if (input.useCurrentVersion) {
      const workflow = await requireWorkflow(client, input.workspaceId, original.workflow_id);
      if (!workflow.current_version_id) {
        throw new ConflictError('the workflow has no published version', 'no_published_version');
      }
      workflowVersionId = workflow.current_version_id;
    }

    const version = await client.query<{ definition: Record<string, unknown> }>(
      'SELECT definition FROM workflow_versions WHERE id = $1',
      [workflowVersionId],
    );
    const definition = version.rows[0]?.definition as WorkflowDefinition | undefined;

    const idempotencyKey = buildExecutionIdempotencyKey({
      workflowId: original.workflow_id,
      triggerType: 'manual',
      triggerKey: `rerun:${original.id}:${randomUUID()}`,
      version: Date.now(),
    });

    const execution = await createExecutionWithOutbox(client, {
      workspaceId: input.workspaceId,
      workflowId: original.workflow_id,
      workflowVersionId,
      triggerType: 'manual',
      triggerEventId: null,
      idempotencyKey,
      input: input.correctedInput ?? original.input,
      isTest: original.is_test,
      rerunOfExecutionId: original.id,
      actorId: input.actorId,
    });

    if (definition?.steps) {
      await createStepExecutions(
        client,
        execution.id,
        definition.steps.map((step, index) => ({
          key: step.key,
          name: step.name,
          type: step.type,
          index,
        })),
      );
    }

    await insertAuditEvent(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorType: 'user',
      action: 'execution.rerun',
      targetType: 'execution',
      targetId: original.id,
      metadata: { newExecutionId: execution.id, workflowVersionId },
    });

    return { id: execution.id };
  });
}

/**
 * Resolves a step whose outcome is unknown.
 *
 * The original attempt history is never edited: the manual decision is stored
 * as a resolution record next to the step.
 */
export async function resolveOutcomeUnknown(input: {
  workspaceId: string;
  executionId: string;
  stepKey: string;
  outcome: 'succeeded' | 'failed';
  reason: string;
  actorId: string;
}): Promise<{ continued: boolean }> {
  return withTransaction(async (client) => {
    const execution = await getExecution(client, input.workspaceId, input.executionId);
    if (!execution) throw new ConflictError('execution not found', 'not_found');

    const step = await getStepExecution(client, input.executionId, input.stepKey);
    if (!step) throw new ConflictError(`step "${input.stepKey}" not found`, 'not_found');
    if (step.status !== 'outcome_unknown') {
      throw new ConflictError(
        `step "${input.stepKey}" is ${step.status}, only an unknown outcome can be resolved`,
        'step_not_resolvable',
      );
    }

    const transition = canTransitionStep(step.status, input.outcome);
    if (!transition.allowed) throw new ConflictError(transition.reason, 'invalid_transition');

    await recordManualResolution(client, {
      stepExecutionId: step.id,
      to: input.outcome,
      actorId: input.actorId,
      reason: input.reason,
    });

    await insertAuditEvent(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorType: 'user',
      action: `execution.step_resolved_${input.outcome}`,
      targetType: 'execution',
      targetId: input.executionId,
      metadata: { stepKey: input.stepKey, reason: input.reason },
    });

    if (input.outcome === 'failed') {
      await updateExecutionStatus(client, {
        executionId: input.executionId,
        from: ['failed'],
        to: 'failed',
        error: { class: 'permanent_provider', message: `step "${input.stepKey}" was marked as failed manually` },
      });
      return { continued: false };
    }

    // The step is confirmed as succeeded: continue with the remaining steps.
    const updated = await client.query<{ run_sequence: number }>(
      `UPDATE executions
          SET status = 'queued', error = NULL, finished_at = NULL, run_sequence = run_sequence + 1,
              worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1
        RETURNING run_sequence`,
      [input.executionId],
    );
    const runSequence = updated.rows[0]?.run_sequence ?? execution.run_sequence + 1;

    await scheduleContinuation(client, {
      executionId: input.executionId,
      runSequence,
      workspaceId: input.workspaceId,
      workflowId: execution.workflow_id,
    });

    return { continued: true };
  });
}

/**
 * Cancels an execution.
 *
 * Cancellation applies to queued runs or to the gap between steps: a running
 * attempt completes and is recorded, it is not interrupted.
 */
export async function cancelExecution(input: {
  workspaceId: string;
  executionId: string;
  actorId: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const execution = await getExecution(client, input.workspaceId, input.executionId);
    if (!execution) throw new ConflictError('execution not found', 'not_found');

    const transition = canTransitionExecution(execution.status, 'cancelled');
    if (!transition.allowed) throw new ConflictError(transition.reason, 'invalid_transition');

    await updateExecutionStatus(client, {
      executionId: input.executionId,
      from: ['queued', 'running', 'retrying'],
      to: 'cancelled',
      finished: true,
      error: { class: 'permanent_provider', message: 'cancelled by an operator' },
    });

    await insertAuditEvent(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorType: 'user',
      action: 'execution.cancelled',
      targetType: 'execution',
      targetId: input.executionId,
      metadata: {},
    });
  });
}

/** Links a schedule occurrence to the execution it created. */
export async function linkOccurrence(
  client: PoolClient,
  occurrenceId: string,
  executionId: string,
): Promise<void> {
  await linkOccurrenceToExecution(client, occurrenceId, executionId);
}

/**
 * Rejects new production executions when the workflow or workspace is over
 * its intake limits (backpressure).
 */
export function assertIntakeAllowed(options: {
  queuedForWorkflow: number;
  queuedForWorkspace: number;
}): void {
  if (options.queuedForWorkflow >= LIMITS.maxQueuedExecutionsPerWorkflow) {
    throw new ConflictError(
      'this workflow has too many queued executions, try again later',
      'workflow_queue_full',
    );
  }
  if (options.queuedForWorkspace >= LIMITS.maxQueuedExecutionsPerWorkspace) {
    throw new ConflictError('this workspace has too many queued executions, try again later', 'workspace_queue_full');
  }
}

export type { ExecutionStatus };
export { getWorkflow };
