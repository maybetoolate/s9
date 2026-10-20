/**
 * Statuses and the central state machine.
 *
 * Blueprint section 10/11: allowed state transitions are defined centrally and
 * terminal states are never overwritten by a late duplicate queue delivery
 * without an explicit recovery operation.
 */

export const WORKFLOW_STATUSES = ['draft', 'published', 'paused', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const EXECUTION_STATUSES = [
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const STEP_STATUSES = [
  'pending',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'skipped',
  'outcome_unknown',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ATTEMPT_STATUSES = ['running', 'succeeded', 'failed', 'timed_out'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = ['succeeded', 'failed', 'cancelled'];
export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = ['succeeded', 'failed', 'skipped', 'outcome_unknown'];

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.includes(status);
}

export function isTerminalStepStatus(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.includes(status);
}

/**
 * Execution transitions.
 *
 * `from failed` is only reachable through an explicit recovery operation
 * (retry step / rerun), never through ordinary worker processing.
 */
export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'failed', 'retrying', 'cancelled'],
  retrying: ['running', 'queued', 'failed', 'cancelled'],
  succeeded: [],
  failed: ['queued'], // recovery operation only (retry step)
  cancelled: [],
};

/**
 * Step transitions. `failed`/`outcome_unknown` -> `retrying` is a recovery
 * operation; `outcome_unknown` -> `succeeded|failed` is a manual resolution.
 */
export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ['running', 'skipped'],
  running: ['succeeded', 'failed', 'retrying', 'outcome_unknown'],
  retrying: ['running', 'failed', 'skipped'],
  succeeded: [],
  failed: ['retrying'],
  skipped: [],
  outcome_unknown: ['succeeded', 'failed', 'retrying'],
};

export type TransitionCheck = { allowed: true } | { allowed: false; reason: string };

/** Checks an execution transition. Terminal states are immutable. */
export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): TransitionCheck {
  if (from === to) return { allowed: false, reason: 'no-op transition' };
  const allowed = EXECUTION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { allowed: false, reason: `illegal execution transition ${from} -> ${to}` };
  }
  return { allowed: true };
}

/** Checks a step transition. Terminal states are immutable except via recovery. */
export function canTransitionStep(from: StepStatus, to: StepStatus): TransitionCheck {
  if (from === to) return { allowed: false, reason: 'no-op transition' };
  const allowed = STEP_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { allowed: false, reason: `illegal step transition ${from} -> ${to}` };
  }
  return { allowed: true };
}

/** Transitions that only a recovery operation (editor) is allowed to perform. */
export const RECOVERY_ONLY_STEP_TRANSITIONS: readonly string[] = ['failed->retrying', 'outcome_unknown->retrying'];
export const RECOVERY_ONLY_EXECUTION_TRANSITIONS: readonly string[] = ['failed->queued'];

/**
 * Whether an execution may be picked up by a worker right now.
 * Mirrors "worker claims the job and verifies the execution is still eligible".
 */
export function isExecutionEligibleToRun(status: ExecutionStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'retrying';
}

/** Whether the workflow status permits the creation of new production executions. */
export function workflowAcceptsNewExecutions(status: WorkflowStatus): boolean {
  return status === 'published';
}
