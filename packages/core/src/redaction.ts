/**
 * Redaction helpers.
 *
 * Blueprint section 13: "redact emails, tokens, and personal data from logs"
 * and "No secrets appear in logs or API responses".
 */

export const REDACTED = '[redacted]';

const SENSITIVE_KEY_PATTERN = /(pass(word)?|secret|token|api[_-]?key|authorization|auth|credential|private[_-]?key|cookie|session|signature)/i;

export const SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'access_token',
  'refresh_token',
  'private_key',
  'cookie',
  'session_token',
  'signature',
];

/** True when a key name looks like it holds a secret. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Recursively redacts sensitive values from an arbitrary structure.
 * Depth limited so a hostile payload cannot blow the stack.
 */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 12) return REDACTED as unknown as T;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out as unknown as T;
  }
  if (typeof value === 'string') {
    return redactString(value) as unknown as T;
  }
  return value;
}

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const LONG_TOKEN_PATTERN = /\b(sk|pk|whsec|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g;

/** Masks emails and obvious token shapes inside a free-text string. */
export function redactString(value: string): string {
  return value.replace(BEARER_PATTERN, REDACTED).replace(LONG_TOKEN_PATTERN, REDACTED).replace(EMAIL_PATTERN, REDACTED);
}

/** Truncates and sanitises an error summary for storage and display. */
export function sanitizeErrorSummary(message: string, maxLength = 500): string {
  const cleaned = redactString(message).replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}
