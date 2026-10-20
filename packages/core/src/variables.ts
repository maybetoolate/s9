/**
 * Variable mapping.
 *
 * Blueprint section 11: "Use a single syntax such as {{trigger.body.email}} and
 * {{steps.save_contact.output.id}}. No expressions or functions in the MVP.
 * Reference steps by stable step keys (lowercase slugs fixed at creation),
 * never by display name."
 *
 * A path that cannot resolve at publish time is a validation error. A value
 * that is null at runtime is a permanent step failure unless a default is
 * configured.
 */

export const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export const VARIABLE_ROOTS = ['trigger', 'steps', 'execution', 'workflow'] as const;
export type VariableRoot = (typeof VARIABLE_ROOTS)[number];

export interface VariableContext {
  trigger: {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    eventId?: string;
    receivedAt?: string;
  };
  steps: Record<string, { output?: unknown; status?: string }>;
  execution: { id?: string; workflowId?: string; attempt?: number };
  workflow: { id?: string; name?: string };
}

export interface ExtractedVariable {
  /** The raw path as written inside the braces, e.g. `trigger.body.email`. */
  path: string;
  root: string;
  /** The remaining path segments after the root. */
  segments: string[];
}

export interface VariableResolution {
  value: unknown;
  /** True when the path was found in the context (even if the value is null). */
  found: boolean;
}

export class VariableResolutionError extends Error {
  readonly path: string;
  readonly reason: 'missing_path' | 'null_value';
  constructor(path: string, reason: 'missing_path' | 'null_value') {
    super(
      reason === 'missing_path'
        ? `variable "${path}" could not be resolved`
        : `variable "${path}" resolved to null and no default is configured`,
    );
    this.name = 'VariableResolutionError';
    this.path = path;
    this.reason = reason;
  }
}

/** Extracts every `{{...}}` reference from a string. */
export function extractVariables(text: string): ExtractedVariable[] {
  const found: ExtractedVariable[] = [];
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    const segments = raw.split('.');
    const root = segments[0] ?? '';
    found.push({ path: raw, root, segments: segments.slice(1) });
  }
  return found;
}

/** Returns true when the string contains at least one variable reference. */
export function hasVariables(text: string): boolean {
  VARIABLE_PATTERN.lastIndex = 0;
  return VARIABLE_PATTERN.test(text);
}

/** Reads a dotted path out of an arbitrary value. */
export function readPath(root: unknown, segments: string[]): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false, value: undefined };
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/**
 * Resolves one variable path against the runtime context.
 * `steps.<key>.output.<path>` is the only form that reaches into prior steps.
 */
export function resolveVariable(path: string, context: VariableContext): VariableResolution {
  const segments = path.split('.');
  const root = segments[0];
  if (!root || !(VARIABLE_ROOTS as readonly string[]).includes(root)) {
    return { found: false, value: undefined };
  }
  return readPath(context, segments);
}

/**
 * Interpolates every variable in a template string.
 *
 * Throws `VariableResolutionError` when a referenced path is missing or
 * resolves to null, so the caller can turn it into a permanent step failure.
 */
export function interpolateTemplate(
  template: string,
  context: VariableContext,
  options: { defaults?: Record<string, unknown> } = {},
): string {
  return template.replace(VARIABLE_PATTERN, (match, rawPath: string) => {
    const resolution = resolveVariable(rawPath, context);
    if (!resolution.found) {
      const fallback = options.defaults?.[rawPath];
      if (fallback === undefined) throw new VariableResolutionError(rawPath, 'missing_path');
      return stringifyValue(fallback);
    }
    if (resolution.value === null || resolution.value === undefined) {
      const fallback = options.defaults?.[rawPath];
      if (fallback === undefined) throw new VariableResolutionError(rawPath, 'null_value');
      return stringifyValue(fallback);
    }
    return stringifyValue(resolution.value);
  });
}

/** Interpolates and returns a typed value (keeps objects/arrays structured). */
export function interpolateValue<T = unknown>(
  value: T,
  context: VariableContext,
  options: { defaults?: Record<string, unknown> } = {},
): T {
  if (typeof value === 'string') {
    return interpolateTemplate(value, context, options) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, context, options)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolateValue(item, context, options);
    }
    return out as unknown as T;
  }
  return value;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Strips CR/LF from a mapped value.
 *
 * Blueprint: "Strip CR/LF from mapped values used in email headers." Header
 * injection through a mapped value would otherwise be trivial.
 */
export function stripControlCharacters(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/** Returns the set of step keys referenced by the given templates. */
export function referencedStepKeys(texts: string[]): Set<string> {
  const keys = new Set<string>();
  for (const text of texts) {
    for (const variable of extractVariables(text)) {
      if (variable.root === 'steps' && variable.segments[0]) keys.add(variable.segments[0]);
    }
  }
  return keys;
}
