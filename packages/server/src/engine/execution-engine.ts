import { randomUUID } from 'node:crypto';
import {
  buildStepIdempotencyKey,
  computeBackoffDelay,
  S9Error,
  interpolateValue,
  isRetryableClass,
  LIMITS,
  redactValue,
  sanitizeErrorSummary,
  VariableResolutionError,
  type ActionContext,
  type ActionRegistry,
  type ActionType,
  type ClassifiedError,
  type VariableContext,
  type WorkflowDefinition,
} from '@s9/core';
import {
  countConsumedAttempts,
  createStepExecutions,
  finishStepAttempt,
  getExecutionById,
  getStepExecution,
  getVersion,
  insertAuditEvent,
  insertStepAttempt,
  listStepExecutions,
  updateExecutionStatus,
  updateStepExecution,
  type Db,
} from '../db/repo.js';
import { getPool, withTransaction } from '../db/pool.js';
import { executionLogger } from '../lib/logger.js';
import { resolveCredential } from './credentials.js';
import { scheduleContinuation } from './execution-service.js';
import type { ExecutionJobData } from '../queue/execution-queue.js';
import { dispatchClassifyError, dispatchExecute, type ActionExecutors } from '../actions/index.js';

/**
 * The execution engine.
 *
 * One continuation runs the pending steps of an execution until it finishes,
 * fails, or needs a delayed retry - which is published as the next
 * continuation through the outbox.
 *
 * Every state change is guarded by the lease token, so a duplicate queue
 * delivery cannot produce an invalid transition.
 */

export interface EngineOptions {
  registry: ActionRegistry;
  executors: ActionExecutors;
  workerId: string;
  leaseDurationMs: number;
}

/** The result of a continuation. */
export type ContinuationResult =
  | 'completed'
  | 'failed'
  | 'outcome_unknown'
  | 'deferred'
  | 'succeeded'
  | 'cancelled';

export async function runExecutionContinuation(
  job: ExecutionJobData,
  options: EngineOptions,
): Promise<ContinuationResult> {
  const { registry, executors, workerId, leaseDurationMs } = options;
  const db = getPool();
  const log = executionLogger({ executionId: job.executionId, workerId });

  const execution = await getExecutionById(db, job.executionId);
  if (!execution) {
    log.warn('execution no longer exists, dropping the job');
    return 'failed';
  }

  if (execution.status === 'succeeded' || execution.status === 'failed' || execution.status === 'cancelled') {
    // A terminal state is never overwritten by a late duplicate delivery.
    log.info({ status: execution.status }, 'execution already terminal, skipping');
    return execution.status === 'succeeded' ? 'succeeded' : 'cancelled';
  }

  // A production run pins a published version; a test run pins a snapshot of
  // the draft revision it was started from.
  const pinned = execution.workflow_version_id
    ? ((await getVersion(db, execution.workflow_version_id))?.definition as unknown as WorkflowDefinition | undefined)
    : (execution.definition_snapshot as unknown as WorkflowDefinition | undefined);

  if (!pinned) {
    log.error('the pinned workflow definition is missing');
    await failExecution(db, execution.id, {
      class: 'permanent_provider',
      message: 'the pinned workflow definition no longer exists',
    });
    return 'failed';
  }
  const definition = pinned;

  // Honour the per-workflow concurrency limit before claiming the lease.
  const busy = await countOtherRunningExecutions(db, execution.workflow_id, execution.id);
  if (busy >= definition.policy.concurrency) {
    log.info({ busy, limit: definition.policy.concurrency }, 'workflow concurrency reached, deferring');
    await deferContinuation(db, execution, 15_000);
    return 'deferred';
  }

  const leaseToken = randomUUID();
  const claimed = await withTransaction((client) =>
    claimExecution(client, execution.id, workerId, leaseToken, leaseDurationMs),
  );

  if (!claimed) {
    log.info('the execution could not be claimed, another worker holds the lease');
    return 'deferred';
  }

  const heartbeat = setInterval(() => {
    void heartbeatExecution(db, execution.id, leaseToken, leaseDurationMs).catch((error) => {
      log.error({ err: error }, 'lease heartbeat failed');
    });
  }, LIMITS.leaseHeartbeatMs);
  heartbeat.unref?.();

  try {
    await ensureStepRows(db, execution.id, definition);
    const outcome = await runSteps({
      db,
      executionId: execution.id,
      workspaceId: execution.workspace_id,
      definition,
      triggerInput: execution.input,
      isTest: execution.is_test,
      leaseToken,
      registry,
      executors,
      workerId,
    });

    if (outcome.kind === 'completed') {
      await completeExecution(db, execution.id, execution.workspace_id, outcome.output);
      return 'completed';
    }
    if (outcome.kind === 'failed' || outcome.kind === 'outcome_unknown') {
      await failExecution(db, execution.id, outcome.error);
      return outcome.kind;
    }
    await deferContinuation(db, execution, outcome.delayMs);
    return 'deferred';
  } catch (error) {
    log.error({ err: error }, 'the continuation failed with an unexpected error');
    await failExecution(db, execution.id, {
      class: 'internal_infrastructure',
      message: sanitizeErrorSummary((error as Error)?.message ?? 'unexpected worker error'),
    });
    return 'failed';
  } finally {
    clearInterval(heartbeat);
  }
}

// ------------------------------------------------------------------- helpers

async function claimExecution(
  client: import('pg').PoolClient,
  executionId: string,
  workerId: string,
  leaseToken: string,
  leaseDurationMs: number,
): Promise<{ id: string } | null> {
  const result = await client.query(
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
      RETURNING id`,
    [executionId, workerId, leaseToken, String(leaseDurationMs)],
  );
  return (result.rows[0] as { id: string } | undefined) ?? null;
}

async function heartbeatExecution(
  db: Db,
  executionId: string,
  leaseToken: string,
  leaseDurationMs: number,
): Promise<void> {
  await db.query(
    `UPDATE executions
        SET lease_expires_at = now() + ($3 || ' milliseconds')::interval
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [executionId, leaseToken, String(leaseDurationMs)],
  );
}

async function countOtherRunningExecutions(db: Db, workflowId: string, executionId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM executions
      WHERE workflow_id = $1 AND id <> $2 AND status = 'running'`,
    [workflowId, executionId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function ensureStepRows(db: Db, executionId: string, definition: WorkflowDefinition): Promise<void> {
  await withTransaction((client) =>
    createStepExecutions(
      client,
      executionId,
      definition.steps.map((step, index) => ({
        key: step.key,
        name: step.name,
        type: step.type,
        index,
      })),
    ),
  );
}

type StepOutcome =
  | { kind: 'completed'; output: Record<string, unknown> }
  | { kind: 'failed'; error: Record<string, unknown> }
  | { kind: 'outcome_unknown'; error: Record<string, unknown> }
  | { kind: 'retry'; delayMs: number };

async function runSteps(input: {
  db: Db;
  executionId: string;
  workspaceId: string;
  definition: WorkflowDefinition;
  triggerInput: Record<string, unknown>;
  isTest: boolean;
  leaseToken: string;
  registry: ActionRegistry;
  executors: ActionExecutors;
  workerId: string;
}): Promise<StepOutcome> {
  const { db, executionId, definition, registry, executors } = input;
  const policy = definition.policy;
  const executionStartedAt = Date.now();

  for (const step of definition.steps) {
    const log = executionLogger({ executionId, stepKey: step.key, workerId: input.workerId });

    const stepRow = await getStepExecution(db, executionId, step.key);
    if (!stepRow) continue;

    // The execution may have been cancelled between steps.
    const current = await getExecutionById(db, executionId);
    if (!current) {
      return { kind: 'failed', error: { class: 'permanent_provider', message: 'the execution disappeared' } };
    }
    if (current.status === 'cancelled') {
      await skipRemaining(db, executionId, stepRow.step_index);
      return { kind: 'failed', error: { class: 'permanent_provider', message: 'the execution was cancelled' } };
    }

    if (stepRow.status === 'succeeded') continue; // already done, never repeated
    if (stepRow.status === 'skipped') continue;
    if (stepRow.status === 'outcome_unknown') {
      return {
        kind: 'outcome_unknown',
        error: { class: 'timeout', message: `step "${step.key}" ended with an unknown outcome` },
      };
    }
    if (stepRow.status === 'failed') {
      return { kind: 'failed', error: stepRow.error ?? { class: 'permanent_provider', message: 'the step failed' } };
    }

    // Resolve the step input from the trigger payload and earlier outputs.
    const context = await buildVariableContext(db, executionId, input.triggerInput, current);
    let resolvedConfig: Record<string, unknown>;
    try {
      resolvedConfig = interpolateValue(step.config as Record<string, unknown>, context) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof VariableResolutionError) {
        // A value that cannot be resolved is a permanent step failure.
        const classified: ClassifiedError = { class: 'validation', message: error.message, safeToRepeat: false };
        await recordStepFailure(db, stepRow.id, classified, 0, false, input.workerId);
        return { kind: 'failed', error: { ...classified, stepKey: step.key } };
      }
      throw error;
    }

    const attemptsConsumed = await countConsumedAttempts(db, stepRow.id);
    const attemptNumber = attemptsConsumed + 1;
    const attemptsLeft = attemptsConsumed < policy.retry.maxAttempts;

    const remainingExecution = policy.executionTimeoutMs - (Date.now() - executionStartedAt);
    if (remainingExecution <= 0) {
      const classified: ClassifiedError = {
        class: 'timeout',
        message: 'the execution exceeded its total timeout',
        safeToRepeat: false,
      };
      await recordStepFailure(db, stepRow.id, classified, attemptNumber, true, input.workerId);
      return { kind: 'failed', error: { ...classified, stepKey: step.key, attempt: attemptNumber } };
    }

    const stepTimeoutMs = Math.max(1_000, Math.min(policy.retry.timeoutMs, remainingExecution));
    const idempotencyKey = buildStepIdempotencyKey({ executionId, stepKey: step.key, attempt: attemptNumber });

    // Record the attempt before performing the side effect.
    await withTransaction((client) =>
      insertStepAttempt(client, { stepExecutionId: stepRow.id, attemptNumber, idempotencyKey }),
    );
    await withTransaction((client) =>
      updateStepExecution(client, {
        stepExecutionId: stepRow.id,
        from: ['pending', 'retrying'],
        to: 'running',
        input: redactValue(resolvedConfig),
        started: true,
        workerId: input.workerId,
      }),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), stepTimeoutMs);
    const startedAt = Date.now();

    log.info({ attempt: attemptNumber, timeoutMs: stepTimeoutMs }, 'step started');

    let result: { output: Record<string, unknown>; reference?: string; status?: number };
    try {
      const credential = await resolveCredential(db, input.workspaceId, resolvedConfig.credentialId);

      const actionContext: ActionContext = {
        executionId,
        workflowVersionId: current.workflow_version_id ?? 'draft',
        stepKey: step.key,
        attempt: attemptNumber,
        idempotencyKey,
        input: resolvedConfig,
        stepOutputs: await collectStepOutputs(db, executionId),
        triggerInput: input.triggerInput,
        signal: controller.signal,
        timeoutMs: stepTimeoutMs,
        simulate: input.isTest && resolvedConfig.executeForReal !== true,
        ...(credential ? { credential } : {}),
      };

      result = await dispatchExecute(executors, step.type, actionContext);

      const validation = registry.validateOutput(step.type, result.output);
      if (!validation.ok) {
        throw S9Error.validation(`the action returned an unexpected output: ${validation.message}`);
      }
    } catch (error) {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const classified = classifyFailure(executors, step.type, error);

      if (classified.class === 'internal_infrastructure') {
        // Infrastructure failures do not consume an attempt: the job is
        // retried and the attempt row is reused.
        await withTransaction((client) =>
          finishStepAttempt(client, {
            stepExecutionId: stepRow.id,
            attemptNumber,
            status: 'failed',
            error: classified,
            durationMs,
          }),
        );
        await withTransaction((client) =>
          updateStepExecution(client, {
            stepExecutionId: stepRow.id,
            from: ['running', 'retrying'],
            to: 'retrying',
            error: classified,
            workerId: input.workerId,
          }),
        );
        throw error;
      }

      if (classified.class === 'timeout' && !classified.safeToRepeat) {
        // A timeout does not prove the remote operation failed: the step is
        // surfaced as outcome_unknown and never retried automatically.
        await withTransaction((client) =>
          finishStepAttempt(client, {
            stepExecutionId: stepRow.id,
            attemptNumber,
            status: 'timed_out',
            error: classified,
            durationMs,
          }),
        );
        await withTransaction((client) =>
          updateStepExecution(client, {
            stepExecutionId: stepRow.id,
            from: ['running', 'retrying'],
            to: 'outcome_unknown',
            error: classified,
            workerId: input.workerId,
          }),
        );
        log.warn({ attempt: attemptNumber, durationMs }, 'the step outcome is unknown');
        return { kind: 'outcome_unknown', error: { ...classified, stepKey: step.key, attempt: attemptNumber } };
      }

      if (isRetryableClass(classified.class) && attemptsLeft) {
        const delayMs = computeBackoffDelay({
          attempt: attemptNumber,
          baseDelayMs: policy.retry.baseDelayMs,
          maxDelayMs: policy.retry.maxDelayMs,
          ...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
        });

        await withTransaction((client) =>
          finishStepAttempt(client, {
            stepExecutionId: stepRow.id,
            attemptNumber,
            status: 'failed',
            error: classified,
            durationMs,
          }),
        );
        await withTransaction((client) =>
          updateStepExecution(client, {
            stepExecutionId: stepRow.id,
            from: ['running', 'retrying'],
            to: 'retrying',
            error: classified,
            workerId: input.workerId,
          }),
        );

        log.info({ attempt: attemptNumber, delayMs }, 'the step will be retried');
        return { kind: 'retry', delayMs };
      }

      await recordStepFailure(db, stepRow.id, classified, attemptNumber, true, input.workerId);
      log.error({ attempt: attemptNumber, errorClass: classified.class }, 'the step failed permanently');
      return { kind: 'failed', error: { ...classified, stepKey: step.key, attempt: attemptNumber } };
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - startedAt;

    await withTransaction((client) =>
      finishStepAttempt(client, {
        stepExecutionId: stepRow.id,
        attemptNumber,
        status: 'succeeded',
        durationMs,
      }),
    );
    await withTransaction((client) =>
      updateStepExecution(client, {
        stepExecutionId: stepRow.id,
        from: ['running', 'retrying'],
        to: 'succeeded',
        output: redactValue(result.output),
        finished: true,
        workerId: input.workerId,
      }),
    );

    log.info({ attempt: attemptNumber, durationMs }, 'the step succeeded');
  }

  const output = await collectStepOutputs(db, executionId);
  return { kind: 'completed', output };
}

async function recordStepFailure(
  db: Db,
  stepExecutionId: string,
  classified: ClassifiedError,
  attemptNumber: number,
  finishAttempt: boolean,
  workerId: string,
): Promise<void> {
  if (finishAttempt && attemptNumber > 0) {
    await withTransaction((client) =>
      finishStepAttempt(client, {
        stepExecutionId,
        attemptNumber,
        status: 'failed',
        error: classified,
      }),
    );
  }

  await withTransaction((client) =>
    updateStepExecution(client, {
      stepExecutionId,
      from: ['pending', 'running', 'retrying'],
      to: 'failed',
      error: classified,
      finished: true,
      workerId,
    }),
  );
}

async function skipRemaining(db: Db, executionId: string, fromStepIndex: number): Promise<void> {
  await db.query(
    `UPDATE step_executions
        SET status = 'skipped', finished_at = now(), updated_at = now()
      WHERE execution_id = $1 AND step_index > $2 AND status = 'pending'`,
    [executionId, fromStepIndex],
  );
}

async function collectStepOutputs(db: Db, executionId: string): Promise<Record<string, unknown>> {
  const steps = await listStepExecutions(db, executionId);
  const outputs: Record<string, unknown> = {};
  for (const step of steps) {
    if (step.status === 'succeeded' && step.output) outputs[step.step_key] = step.output;
  }
  return outputs;
}

async function buildVariableContext(
  db: Db,
  executionId: string,
  triggerInput: Record<string, unknown>,
  execution: { id: string; workflow_id: string },
): Promise<VariableContext> {
  const steps = await listStepExecutions(db, executionId);
  const stepMap: Record<string, { output?: unknown; status?: string }> = {};
  for (const step of steps) {
    stepMap[step.step_key] = { output: step.output ?? undefined, status: step.status };
  }
  return {
    trigger: { body: triggerInput },
    steps: stepMap,
    execution: { id: execution.id, workflowId: execution.workflow_id },
    workflow: { id: execution.workflow_id },
  };
}

function classifyFailure(
  executors: ActionExecutors,
  type: ActionType,
  error: unknown,
): ClassifiedError {
  if (error instanceof S9Error) return error.toClassified();
  try {
    return dispatchClassifyError(executors, type, error);
  } catch {
    return {
      class: 'permanent_provider',
      message: sanitizeErrorSummary((error as Error)?.message ?? 'the action failed'),
      safeToRepeat: false,
    };
  }
}

async function completeExecution(
  db: Db,
  executionId: string,
  workspaceId: string,
  output: Record<string, unknown>,
): Promise<void> {
  await withTransaction(async (client) => {
    await updateExecutionStatus(client, {
      executionId,
      from: ['running', 'retrying', 'queued'],
      to: 'succeeded',
      output,
      finished: true,
      error: null,
    });
    await insertAuditEvent(client, {
      workspaceId,
      actorId: null,
      actorType: 'system',
      action: 'execution.succeeded',
      targetType: 'execution',
      targetId: executionId,
      metadata: {},
    });
  });
}

async function failExecution(db: Db, executionId: string, error: Record<string, unknown>): Promise<void> {
  await withTransaction(async (client) => {
    await updateExecutionStatus(client, {
      executionId,
      from: ['running', 'retrying', 'queued'],
      to: 'failed',
      error,
      finished: true,
    });
  });
}

/**
 * Defers a continuation.
 *
 * The execution moves to `retrying` and the next continuation is published
 * through the outbox, so the delay is durable even if Redis loses data.
 */
async function deferContinuation(
  db: Db,
  execution: { id: string; workspace_id: string; workflow_id: string; run_sequence: number },
  delayMs: number,
): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{ run_sequence: number }>(
      `UPDATE executions
          SET status = 'retrying', run_sequence = run_sequence + 1,
              worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('queued', 'running', 'retrying')
        RETURNING run_sequence`,
      [execution.id],
    );
    const runSequence = result.rows[0]?.run_sequence ?? execution.run_sequence + 1;
    await scheduleContinuation(client, {
      executionId: execution.id,
      runSequence,
      workspaceId: execution.workspace_id,
      workflowId: execution.workflow_id,
      delayMs,
    });
  });
}
