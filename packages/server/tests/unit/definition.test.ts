import { describe, expect, it } from 'vitest';
import {
  isPublishable,
  validateDefinition,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '@s9/core';

/**
 * Validation rules from blueprint section 7:
 *  - exactly one trigger per workflow;
 *  - at least one action for a publishable workflow;
 *  - every action has a known type and a valid configuration;
 *  - referenced variables exist and are available before the step that
 *    consumes them;
 *  - step keys are unique;
 *  - timeouts and retry counts stay within the server limits.
 */

function baseDefinition(): WorkflowDefinition {
  return {
    trigger: { type: 'webhook', slug: 'contact-form-endpoint', requireSignature: true, samplePayload: {} },
    steps: [
      {
        key: 'save_contact',
        name: 'Save contact',
        type: 'database_insert',
        config: { table: 'contacts', values: { email: '{{trigger.body.email}}' }, dedupeKey: 'k' },
      },
      {
        key: 'notify',
        name: 'Notify',
        type: 'notification',
        config: {
          channel: 'sales',
          message: 'Contact {{steps.save_contact.output.id}}',
          webhookUrl: 'https://hooks.example.com/x',
        },
      },
    ],
    policy: {
      maxSteps: 10,
      executionTimeoutMs: 600_000,
      concurrency: 1,
      retry: { maxAttempts: 3, baseDelayMs: 5_000, maxDelayMs: 300_000, timeoutMs: 30_000 },
    },
  };
}

describe('definition validation', () => {
  it('accepts a valid definition', () => {
    const issues = validateDefinition(baseDefinition());
    expect(isPublishable(issues)).toBe(true);
  });

  it('rejects a workflow without a step', () => {
    const definition = baseDefinition();
    definition.steps = [];
    const issues = validateDefinition(definition);
    expect(isPublishable(issues)).toBe(false);
    expect(issues.some((issue) => issue.code === 'schema_invalid')).toBe(true);
  });

  it('rejects duplicate step keys', () => {
    const definition = baseDefinition();
    definition.steps[1]!.key = definition.steps[0]!.key;
    const issues = validateDefinition(definition);
    expect(issues.some((issue) => issue.code === 'duplicate_step_key')).toBe(true);
  });

  it('rejects a reference to a step that does not exist', () => {
    const definition = baseDefinition();
    definition.steps[1]!.config = {
      channel: 'sales',
      message: 'Contact {{steps.missing_step.output.id}}',
      webhookUrl: 'https://hooks.example.com/x',
    };
    const issues = validateDefinition(definition);
    expect(issues.some((issue) => issue.code === 'unknown_variable')).toBe(true);
    expect(isPublishable(issues)).toBe(false);
  });

  it('rejects a forward reference', () => {
    const definition = baseDefinition();
    definition.steps[0]!.config = {
      table: 'contacts',
      values: { email: '{{steps.notify.output.id}}' },
    };
    const issues = validateDefinition(definition);
    expect(issues.some((issue) => issue.code === 'forward_reference')).toBe(true);
  });

  it('rejects an invalid action configuration', () => {
    const definition = baseDefinition();
    definition.steps[0]!.config = { table: 'not_allowed', values: {} };
    const issues = validateDefinition(definition);
    expect(issues.some((issue) => issue.code === 'invalid_action_config')).toBe(true);
  });

  it('rejects a step key that is not a lowercase slug', () => {
    const definition = baseDefinition();
    definition.steps[0]!.key = 'Save Contact';
    const issues = validateDefinition(definition);
    expect(isPublishable(issues)).toBe(false);
  });

  it('rejects more steps than the server allows', () => {
    const definition = baseDefinition();
    definition.steps = Array.from({ length: 11 }, (_, index) => ({
      key: `step_${index}`,
      name: `Step ${index}`,
      type: 'notification' as const,
      config: { channel: 'c', message: 'm', webhookUrl: 'https://hooks.example.com/x' },
    }));
    const issues = validateDefinition(definition);
    expect(isPublishable(issues)).toBe(false);
  });

  it('rejects a retry count above the server limit', () => {
    const definition = baseDefinition();
    definition.policy.retry.maxAttempts = 50;
    const issues = validateDefinition(issuesInput(definition));
    expect(isPublishable(issues)).toBe(false);
  });

  it('rejects a step timeout above the server limit', () => {
    const definition = baseDefinition();
    definition.policy.retry.timeoutMs = 600_000;
    const issues = validateDefinition(definition);
    expect(isPublishable(issues)).toBe(false);
  });

  it('parses the schema and applies the defaults', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      trigger: { type: 'manual' },
      steps: [
        {
          key: 'save',
          name: 'Save',
          type: 'database_insert',
          config: { values: { email: 'a@b.c' } },
        },
      ],
    });
    expect(parsed.policy.retry.maxAttempts).toBe(3);
    expect(parsed.policy.concurrency).toBe(1);
    expect(parsed.trigger.type).toBe('manual');
  });
});

function issuesInput(definition: WorkflowDefinition): WorkflowDefinition {
  return definition;
}
