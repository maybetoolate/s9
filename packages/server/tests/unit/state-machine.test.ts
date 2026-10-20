import { describe, expect, it } from 'vitest';
import {
  canTransitionExecution,
  canTransitionStep,
  isExecutionEligibleToRun,
  isTerminalExecutionStatus,
  isTerminalStepStatus,
  workflowAcceptsNewExecutions,
} from '@flowforge/core';

/**
 * The state machine is the contract of the product: every failure has to be
 * recoverable without silent repeats, and no terminal state may be
 * overwritten.
 */
describe('execution state machine', () => {
  it('allows the normal lifecycle', () => {
    expect(canTransitionExecution('queued', 'running').allowed).toBe(true);
    expect(canTransitionExecution('running', 'retrying').allowed).toBe(true);
    expect(canTransitionExecution('retrying', 'running').allowed).toBe(true);
    expect(canTransitionExecution('running', 'succeeded').allowed).toBe(true);
    expect(canTransitionExecution('running', 'failed').allowed).toBe(true);
  });

  it('only allows a recovery operation to leave the failed state', () => {
    expect(canTransitionExecution('failed', 'queued').allowed).toBe(true);
    expect(canTransitionExecution('failed', 'running').allowed).toBe(false);
    expect(canTransitionExecution('failed', 'succeeded').allowed).toBe(false);
  });

  it('never leaves a terminal state', () => {
    for (const status of ['succeeded', 'cancelled'] as const) {
      for (const target of ['queued', 'running', 'retrying', 'failed', 'cancelled'] as const) {
        expect(canTransitionExecution(status, target).allowed).toBe(false);
      }
    }
  });

  it('rejects a no-op transition', () => {
    expect(canTransitionExecution('running', 'running').allowed).toBe(false);
  });

  it('allows cancelling a queued or running execution', () => {
    expect(canTransitionExecution('queued', 'cancelled').allowed).toBe(true);
    expect(canTransitionExecution('running', 'cancelled').allowed).toBe(true);
  });
});

describe('step state machine', () => {
  it('allows the normal lifecycle', () => {
    expect(canTransitionStep('pending', 'running').allowed).toBe(true);
    expect(canTransitionStep('running', 'succeeded').allowed).toBe(true);
    expect(canTransitionStep('running', 'failed').allowed).toBe(true);
    expect(canTransitionStep('running', 'retrying').allowed).toBe(true);
    expect(canTransitionStep('pending', 'skipped').allowed).toBe(true);
  });

  it('requires a recovery operation for a failed step', () => {
    expect(canTransitionStep('failed', 'retrying').allowed).toBe(true);
    expect(canTransitionStep('failed', 'running').allowed).toBe(false);
  });

  it('allows a manual resolution of an unknown outcome', () => {
    expect(canTransitionStep('outcome_unknown', 'succeeded').allowed).toBe(true);
    expect(canTransitionStep('outcome_unknown', 'failed').allowed).toBe(true);
    expect(canTransitionStep('outcome_unknown', 'running').allowed).toBe(false);
  });

  it('never overwrites a succeeded step', () => {
    for (const target of ['pending', 'running', 'retrying', 'failed', 'skipped'] as const) {
      expect(canTransitionStep('succeeded', target).allowed).toBe(false);
    }
  });
});

describe('status helpers', () => {
  it('knows the terminal states', () => {
    expect(isTerminalExecutionStatus('succeeded')).toBe(true);
    expect(isTerminalExecutionStatus('failed')).toBe(true);
    expect(isTerminalExecutionStatus('cancelled')).toBe(true);
    expect(isTerminalExecutionStatus('running')).toBe(false);
    expect(isTerminalStepStatus('outcome_unknown')).toBe(true);
    expect(isTerminalStepStatus('running')).toBe(false);
  });

  it('knows which executions a worker may pick up', () => {
    expect(isExecutionEligibleToRun('queued')).toBe(true);
    expect(isExecutionEligibleToRun('running')).toBe(true);
    expect(isExecutionEligibleToRun('retrying')).toBe(true);
    expect(isExecutionEligibleToRun('succeeded')).toBe(false);
    expect(isExecutionEligibleToRun('failed')).toBe(false);
  });

  it('only accepts new production executions for a published workflow', () => {
    expect(workflowAcceptsNewExecutions('published')).toBe(true);
    expect(workflowAcceptsNewExecutions('paused')).toBe(false);
    expect(workflowAcceptsNewExecutions('draft')).toBe(false);
    expect(workflowAcceptsNewExecutions('archived')).toBe(false);
  });
});
