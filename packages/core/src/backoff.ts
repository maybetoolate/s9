/**
 * Exponential backoff with jitter.
 *
 * Blueprint: "Retries: 3 attempts by default, 5 maximum. Backoff: 5 s base,
 * 5 min cap, with jitter." Rate limited responses honour the provider hint.
 */

export interface BackoffOptions {
  /** 1-based attempt number that just failed. */
  attempt: number;
  /** Base delay in milliseconds. */
  baseDelayMs: number;
  /** Maximum delay in milliseconds. */
  maxDelayMs: number;
  /** Provider supplied retry hint; wins when present. */
  retryAfterMs?: number;
  /** Injectable randomness for deterministic tests. */
  random?: () => number;
}

const DEFAULT_JITTER_RATIO = 0.2;

/**
 * Computes the delay before the next attempt.
 *
 * The exponential term is `base * 2^(attempt-1)`, capped at `maxDelayMs`.
 * Jitter is applied as a symmetric +/-20% factor so that a fleet of workers
 * does not retry in lockstep. The result never exceeds `maxDelayMs`.
 */
export function computeBackoffDelay(options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const base = Math.max(0, options.baseDelayMs);
  const cap = Math.max(base, options.maxDelayMs);

  if (options.retryAfterMs !== undefined && options.retryAfterMs >= 0) {
    return Math.min(cap, Math.round(options.retryAfterMs));
  }

  const exponential = base * 2 ** Math.max(0, options.attempt - 1);
  const capped = Math.min(cap, exponential);
  const jitterFactor = 1 + (random() * 2 - 1) * DEFAULT_JITTER_RATIO;
  return Math.max(0, Math.min(cap, Math.round(capped * jitterFactor)));
}

/** Formats a millisecond delay for human readable audit metadata. */
export function formatDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
