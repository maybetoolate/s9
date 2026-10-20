import type { z } from 'zod';
import type { ActionType } from './actions.js';
import type { ClassifiedError } from './errors.js';
import type { StepStatus } from './status.js';

/**
 * The action contract.
 *
 * Blueprint section 11: "Every action adapter should follow one shared
 * conceptual contract: validate configuration, resolve inputs, execute with a
 * deadline, return a structured result, classify failures, and expose whether
 * repeating the action is safe."
 *
 * "Each action adapter declares its output schema, redaction rules, error
 * classification and safe_to_repeat flag, and the registry rejects adapters
 * that omit them."
 */

export interface ActionContext {
  /** The execution this step belongs to. */
  executionId: string;
  /** The workflow version pinned by the execution. */
  workflowVersionId: string;
  /** Stable step key. */
  stepKey: string;
  /** 1-based attempt number. */
  attempt: number;
  /** Stable per-step idempotency key, forwarded to providers that support one. */
  idempotencyKey: string;
  /** Resolved inputs for this step (variables already interpolated). */
  input: Record<string, unknown>;
  /** Outputs of earlier steps, keyed by step key. */
  stepOutputs: Record<string, unknown>;
  /** The raw trigger input. */
  triggerInput: Record<string, unknown>;
  /** Signal used to abort the action when the deadline passes. */
  signal: AbortSignal;
  /** Deadline in milliseconds for this attempt. */
  timeoutMs: number;
  /** Whether the action should simulate side effects (test runs). */
  simulate: boolean;
  /** Secret material for the referenced credential, when the step has one. */
  credential?: { id: string; provider: string; secret: string; metadata: Record<string, unknown> };
}

export interface ActionResult {
  /** Structured output of the action. */
  output: Record<string, unknown>;
  /** Optional provider reference (message id, contact id, ...). */
  reference?: string;
  /** HTTP status, when the action performed an HTTP call. */
  status?: number;
}

export interface ActionExecutor {
  readonly type: ActionType;
  /** Zod schema describing the action configuration. */
  readonly configSchema: z.ZodType;
  /** Zod schema describing the action output. */
  readonly outputSchema: z.ZodType;
  /**
   * Whether repeating the action is safe. A timeout on an action that is not
   * safe to repeat becomes `outcome_unknown` instead of an automatic retry.
   */
  readonly safeToRepeat: boolean;
  /** Keys removed from logs and API responses. */
  readonly redactionKeys: readonly string[];
  /** Validates a configuration object. */
  validateConfig(config: unknown): { ok: true; value: unknown } | { ok: false; message: string };
  /** Executes the action. Throws a `FlowForgeError` with a classified error. */
  execute(context: ActionContext): Promise<ActionResult>;
  /** Maps an arbitrary thrown value onto the error taxonomy. */
  classifyError(error: unknown): ClassifiedError;
  /** Optional hook that runs after a successful execution (used by the demo DB action). */
  afterSuccess?(context: ActionContext, result: ActionResult): Promise<void>;
}

/** Thrown when an adapter omits a required part of the contract. */
export class IncompleteActionAdapterError extends Error {
  constructor(type: string, missing: string[]) {
    super(`action adapter "${type}" is missing required contract members: ${missing.join(', ')}`);
    this.name = 'IncompleteActionAdapterError';
  }
}

export interface ActionRegistryOptions {
  /** Called when the action fails to produce a valid output. */
  onOutputValidationError?: (type: ActionType, error: unknown) => void;
}

/**
 * The action registry.
 *
 * Registration fails loudly when an adapter does not honour the contract, so
 * an incomplete adapter can never reach the worker.
 */
export class ActionRegistry {
  private readonly executors = new Map<ActionType, ActionExecutor>();

  constructor(private readonly options: ActionRegistryOptions = {}) {}

  register(executor: ActionExecutor): void {
    const missing: string[] = [];
    if (!executor.configSchema) missing.push('configSchema');
    if (!executor.outputSchema) missing.push('outputSchema');
    if (typeof executor.safeToRepeat !== 'boolean') missing.push('safeToRepeat');
    if (!Array.isArray(executor.redactionKeys)) missing.push('redactionKeys');
    if (typeof executor.classifyError !== 'function') missing.push('classifyError');
    if (typeof executor.execute !== 'function') missing.push('execute');
    if (typeof executor.validateConfig !== 'function') missing.push('validateConfig');
    if (missing.length > 0) throw new IncompleteActionAdapterError(executor.type, missing);

    this.executors.set(executor.type, executor);
  }

  get(type: ActionType): ActionExecutor {
    const executor = this.executors.get(type);
    if (!executor) throw new Error(`no action adapter registered for type "${type}"`);
    return executor;
  }

  has(type: ActionType): boolean {
    return this.executors.has(type);
  }

  list(): ActionExecutor[] {
    return [...this.executors.values()];
  }

  /** Validates an action output against the adapter's output schema. */
  validateOutput(type: ActionType, output: unknown): { ok: true } | { ok: false; message: string } {
    const executor = this.get(type);
    const result = executor.outputSchema.safeParse(output);
    if (result.success) return { ok: true };
    this.options.onOutputValidationError?.(type, result.error);
    return { ok: false, message: result.error.issues.map((issue) => issue.message).join('; ') };
  }
}

/** Convenience helper: the step status a classified error leads to. */
export function stepStatusForError(error: ClassifiedError, attemptsLeft: boolean): StepStatus {
  if (error.class === 'timeout' && !error.safeToRepeat) return 'outcome_unknown';
  if (attemptsLeft) return 'retrying';
  return 'failed';
}
