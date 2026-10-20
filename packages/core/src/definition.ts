import { z } from 'zod';
import { LIMITS } from './limits.js';
import { ACTION_METADATA, ACTION_TYPES, type ActionType } from './actions.js';
import { referencedStepKeys } from './variables.js';

/**
 * The workflow definition.
 *
 * A definition is a declarative document, not executable code: it describes the
 * trigger, the ordered steps, the variable mappings and the execution policy.
 */

export const StepKeySchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'step keys are lowercase slugs, e.g. save_contact');

export const TriggerTypeSchema = z.enum(['webhook', 'schedule', 'manual']);
export type TriggerType = z.infer<typeof TriggerTypeSchema>;

export const WebhookTriggerSchema = z.object({
  type: z.literal('webhook'),
  /** Public path segment of the intake endpoint. */
  slug: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'slug may contain lowercase letters, digits, dashes and underscores'),
  /** Whether a valid HMAC signature is required. */
  requireSignature: z.boolean().default(true),
  /** Optional sample body shown in the UI and used for test runs. */
  samplePayload: z.record(z.string(), z.unknown()).default({}),
});

export const ScheduleTriggerSchema = z.object({
  type: z.literal('schedule'),
  /** Standard 5-field cron expression. */
  cron: z.string().min(1, 'a cron expression is required').max(120),
  /** IANA timezone. Defaults to UTC rather than server local time. */
  timezone: z.string().min(1).max(64).default('UTC'),
  /** Whether a single missed occurrence may be caught up after downtime. */
  catchUp: z.boolean().default(true),
});

export const ManualTriggerSchema = z.object({
  type: z.literal('manual'),
  samplePayload: z.record(z.string(), z.unknown()).default({}),
});

export const TriggerSchema = z.discriminatedUnion('type', [
  WebhookTriggerSchema,
  ScheduleTriggerSchema,
  ManualTriggerSchema,
]);

export const RetryPolicySchema = z.object({
  /** Total attempts per step, including the first one. */
  maxAttempts: z.number().int().min(1).max(LIMITS.maxAttempts).default(LIMITS.defaultMaxAttempts),
  baseDelayMs: z.number().int().min(1_000).max(LIMITS.defaultMaxDelayMs).default(LIMITS.defaultBaseDelayMs),
  maxDelayMs: z.number().int().min(1_000).max(LIMITS.defaultMaxDelayMs).default(LIMITS.defaultMaxDelayMs),
  /** Per-step timeout. */
  timeoutMs: z.number().int().min(1_000).max(LIMITS.maxStepTimeoutMs).default(LIMITS.defaultStepTimeoutMs),
});

export const ExecutionPolicySchema = z.object({
  maxSteps: z.number().int().min(1).max(LIMITS.maxSteps).default(LIMITS.maxSteps),
  /** Total active run time for the execution. */
  executionTimeoutMs: z
    .number()
    .int()
    .min(10_000)
    .max(LIMITS.defaultExecutionTimeoutMs)
    .default(LIMITS.defaultExecutionTimeoutMs),
  /** Maximum simultaneous running executions for this workflow. */
  concurrency: z.number().int().min(1).max(5).default(LIMITS.defaultWorkflowConcurrency),
  retry: RetryPolicySchema.default({
    maxAttempts: LIMITS.defaultMaxAttempts,
    baseDelayMs: LIMITS.defaultBaseDelayMs,
    maxDelayMs: LIMITS.defaultMaxDelayMs,
    timeoutMs: LIMITS.defaultStepTimeoutMs,
  }),
});

export const WorkflowStepSchema = z.object({
  /** Stable identifier used by variable mappings. Fixed at creation. */
  key: StepKeySchema,
  name: z.string().min(1, 'a step name is required').max(200),
  type: z.enum(ACTION_TYPES),
  config: z.record(z.string(), z.unknown()).default({}),
  // The MVP stops the execution at the first permanent failure: there is no
  // continue-on-error behaviour, so the flag is not part of the definition.
});

export const WorkflowDefinitionSchema = z.object({
  trigger: TriggerSchema,
  steps: z.array(WorkflowStepSchema).min(1, 'at least one action is required').max(LIMITS.maxSteps),
  policy: ExecutionPolicySchema.default({
    maxSteps: LIMITS.maxSteps,
    executionTimeoutMs: LIMITS.defaultExecutionTimeoutMs,
    concurrency: LIMITS.defaultWorkflowConcurrency,
    retry: {
      maxAttempts: LIMITS.defaultMaxAttempts,
      baseDelayMs: LIMITS.defaultBaseDelayMs,
      maxDelayMs: LIMITS.defaultMaxDelayMs,
      timeoutMs: LIMITS.defaultStepTimeoutMs,
    },
  }),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type TriggerConfig = z.infer<typeof TriggerSchema>;

export interface ValidationIssue {
  /** Machine readable code, e.g. `unknown_variable`. */
  code: string;
  /** Human readable, actionable message. */
  message: string;
  /** Optional path inside the definition. */
  path?: string;
  /** Optional step key the issue belongs to. */
  stepKey?: string;
  severity: 'error' | 'warning' | 'info';
}

/**
 * Validates a definition beyond the schema level.
 *
 * Blueprint validation rules: exactly one trigger, at least one action, every
 * action has a known type and valid configuration, referenced variables exist
 * and are available before the step that consumes them, step keys are unique,
 * and timeouts/retries stay within the server limits.
 */
export function validateDefinition(definition: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const parsed = WorkflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: 'schema_invalid',
        message: issue.message,
        path: issue.path.join('.'),
        severity: 'error',
      });
    }
    return issues;
  }

  const def = parsed.data;
  const seenKeys = new Set<string>();

  for (const [index, step] of def.steps.entries()) {
    if (seenKeys.has(step.key)) {
      issues.push({
        code: 'duplicate_step_key',
        message: `step key "${step.key}" is used more than once`,
        path: `steps.${index}.key`,
        stepKey: step.key,
        severity: 'error',
      });
    }
    seenKeys.add(step.key);

    const metadata = ACTION_METADATA[step.type as ActionType];
    const configResult = metadata.configSchema.safeParse(step.config ?? {});
    if (!configResult.success) {
      for (const issue of configResult.error.issues) {
        issues.push({
          code: 'invalid_action_config',
          message: `${metadata.label}: ${issue.message}`,
          path: `steps.${index}.config.${issue.path.join('.')}`,
          stepKey: step.key,
          severity: 'error',
        });
      }
      continue;
    }

    // Mappings may only reference earlier steps.
    const texts = collectTemplateStrings(step.config ?? {});
    for (const referenced of referencedStepKeys(texts)) {
      if (!seenKeys.has(referenced) || referenced === step.key) {
        issues.push({
          code: 'unknown_variable',
          message: `step "${step.key}" references "${referenced}", which is not an earlier step`,
          path: `steps.${index}.config`,
          stepKey: step.key,
          severity: 'error',
        });
      }
    }

    // Forward references to steps that come later are invalid.
    const stepIndexByKey = new Map(def.steps.map((s, i) => [s.key, i]));
    for (const referenced of referencedStepKeys(texts)) {
      const referencedIndex = stepIndexByKey.get(referenced);
      if (referencedIndex !== undefined && referencedIndex >= index) {
        issues.push({
          code: 'forward_reference',
          message: `step "${step.key}" references "${referenced}", which does not run before it`,
          path: `steps.${index}.config`,
          stepKey: step.key,
          severity: 'error',
        });
      }
    }
  }

  if (def.trigger.type === 'webhook' && def.trigger.requireSignature) {
    issues.push({
      code: 'webhook_signature_required',
      message:
        'The webhook trigger requires HMAC signatures. The sender computes the signature from the endpoint secret: ' +
        'sign the exact body with HMAC-SHA256 over "<timestamp>.<body>" and send it as ' +
        'X-FlowForge-Signature: t=<unix-ms>,v1=<hex>. The secret is shown once when the endpoint is created; ' +
        'if you no longer have it, rotate it in the Webhook tab of this workflow.',
      severity: 'info',
    });
  }

  return issues;
}

/** Collects every string value inside a configuration object. */
export function collectTemplateStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTemplateStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectTemplateStrings(item, out);
  }
  return out;
}

/** True when the definition has no blocking issues. */
export function isPublishable(issues: ValidationIssue[]): boolean {
  return !issues.some((issue) => issue.severity === 'error');
}
