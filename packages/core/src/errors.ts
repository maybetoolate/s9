/**
 * Error taxonomy.
 *
 * Blueprint section 11. Every failure that crosses the action boundary must be
 * classified into exactly one of these classes; the class decides whether the
 * step is retried, failed permanently, or surfaced as `outcome_unknown`.
 */

export const ERROR_CLASSES = [
  'validation',
  'permanent_provider',
  'transient_provider',
  'rate_limited',
  'timeout',
  'internal_infrastructure',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export interface ClassifiedError {
  class: ErrorClass;
  /** Short, sanitized, human-readable summary. Never contains secrets. */
  message: string;
  /** Optional provider status code. */
  status?: number;
  /** Optional provider retry hint in milliseconds (e.g. Retry-After). */
  retryAfterMs?: number;
  /** True when repeating the action is safe (no duplicate external side effect). */
  safeToRepeat: boolean;
  /** Optional structured details, already redacted. */
  details?: Record<string, unknown>;
}

export class FlowForgeError extends Error {
  readonly errorClass: ErrorClass;
  readonly safeToRepeat: boolean;
  readonly details?: Record<string, unknown>;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    errorClass: ErrorClass,
    message: string,
    options: { safeToRepeat?: boolean; details?: Record<string, unknown>; status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FlowForgeError';
    this.errorClass = errorClass;
    this.safeToRepeat = options.safeToRepeat ?? false;
    this.details = options.details;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  toClassified(): ClassifiedError {
    const result: ClassifiedError = {
      class: this.errorClass,
      message: this.message,
      safeToRepeat: this.safeToRepeat,
    };
    if (this.status !== undefined) result.status = this.status;
    if (this.retryAfterMs !== undefined) result.retryAfterMs = this.retryAfterMs;
    if (this.details !== undefined) result.details = this.details;
    return result;
  }

  static validation(message: string, details?: Record<string, unknown>): FlowForgeError {
    return new FlowForgeError('validation', message, { safeToRepeat: false, details });
  }

  static permanent(message: string, details?: Record<string, unknown>): FlowForgeError {
    return new FlowForgeError('permanent_provider', message, { safeToRepeat: false, details });
  }

  static transient(message: string, details?: Record<string, unknown>): FlowForgeError {
    return new FlowForgeError('transient_provider', message, { safeToRepeat: true, details });
  }

  static rateLimited(message: string, retryAfterMs: number | undefined, details?: Record<string, unknown>): FlowForgeError {
    return new FlowForgeError('rate_limited', message, { safeToRepeat: true, retryAfterMs, details });
  }

  static timeout(message: string, safeToRepeat: boolean, details?: Record<string, unknown>): FlowForgeError {
    return new FlowForgeError('timeout', message, { safeToRepeat, details });
  }

  static infrastructure(message: string, cause?: unknown): FlowForgeError {
    return new FlowForgeError('internal_infrastructure', message, { safeToRepeat: true, cause });
  }
}

/**
 * Maps an HTTP status code to a taxonomy class.
 * `safeToRepeat` is decided by the adapter, not here: a 4xx may still be a
 * replayed side effect that the provider has already applied.
 */
export function classifyHttpStatus(status: number, retryAfterMs?: number): ErrorClass {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'transient_provider';
  if (status >= 400) return 'permanent_provider';
  if (status >= 300) return 'permanent_provider';
  return 'transient_provider';
}

export function isRetryableClass(errorClass: ErrorClass): boolean {
  return errorClass === 'transient_provider' || errorClass === 'rate_limited' || errorClass === 'internal_infrastructure';
}

/**
 * A timeout only becomes `outcome_unknown` when the action is not safe to
 * repeat. Otherwise it is retried like any other transient failure.
 */
export function timeoutOutcome(error: ClassifiedError): 'retry' | 'outcome_unknown' {
  if (error.class !== 'timeout') return 'retry';
  return error.safeToRepeat ? 'retry' : 'outcome_unknown';
}
