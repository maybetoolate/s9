import { describe, expect, it } from 'vitest';
import {
  extractVariables,
  interpolateTemplate,
  interpolateValue,
  resolveVariable,
  stripControlCharacters,
  VariableResolutionError,
  type VariableContext,
} from '@flowforge/core';

/**
 * Variable mapping rules:
 *  - one syntax, no expressions;
 *  - steps are referenced by stable key;
 *  - a path that cannot be resolved is a validation error;
 *  - a null value is a permanent failure unless a default is configured;
 *  - CR/LF is stripped from mapped values used in email headers.
 */
const context: VariableContext = {
  trigger: { body: { name: 'Ada', email: 'ada@example.com', nested: { deep: 42 }, empty: null } },
  steps: {
    save_contact: { output: { id: 'contact-1', created: true }, status: 'succeeded' },
    failed_step: { output: undefined, status: 'failed' },
  },
  execution: { id: 'exec-1', workflowId: 'wf-1' },
  workflow: { id: 'wf-1', name: 'Demo' },
};

describe('variable extraction', () => {
  it('finds every reference', () => {
    const variables = extractVariables('Hello {{trigger.body.name}}, id {{steps.save_contact.output.id}}');
    expect(variables.map((variable) => variable.path)).toEqual(['trigger.body.name', 'steps.save_contact.output.id']);
    expect(variables[0]?.root).toBe('trigger');
    expect(variables[1]?.segments).toEqual(['save_contact', 'output', 'id']);
  });

  it('ignores text without references', () => {
    expect(extractVariables('no variables here')).toEqual([]);
  });
});

describe('variable resolution', () => {
  it('resolves trigger and step values', () => {
    expect(resolveVariable('trigger.body.name', context)).toEqual({ found: true, value: 'Ada' });
    expect(resolveVariable('steps.save_contact.output.id', context)).toEqual({ found: true, value: 'contact-1' });
    expect(resolveVariable('trigger.body.nested.deep', context)).toEqual({ found: true, value: 42 });
  });

  it('reports a missing path', () => {
    expect(resolveVariable('trigger.body.missing', context).found).toBe(false);
    expect(resolveVariable('steps.unknown_step.output.id', context).found).toBe(false);
    expect(resolveVariable('nonsense.path', context).found).toBe(false);
  });

  it('reports a null value as found but unresolvable', () => {
    const resolution = resolveVariable('trigger.body.empty', context);
    expect(resolution.found).toBe(true);
    expect(resolution.value).toBeNull();
  });
});

describe('template interpolation', () => {
  it('replaces the references', () => {
    expect(interpolateTemplate('Hi {{trigger.body.name}}!', context)).toBe('Hi Ada!');
  });

  it('throws for a missing path', () => {
    expect(() => interpolateTemplate('Hi {{trigger.body.missing}}!', context)).toThrow(VariableResolutionError);
  });

  it('throws for a null value without a default', () => {
    expect(() => interpolateTemplate('Hi {{trigger.body.empty}}!', context)).toThrow(VariableResolutionError);
  });

  it('uses the configured default', () => {
    const result = interpolateTemplate('Hi {{trigger.body.empty}}!', context, {
      defaults: { 'trigger.body.empty': 'there' },
    });
    expect(result).toBe('Hi there!');
  });

  it('keeps structured values structured', () => {
    const resolved = interpolateValue(
      { to: '{{trigger.body.email}}', count: 3, nested: { list: ['{{trigger.body.name}}'] } },
      context,
    );
    expect(resolved).toEqual({ to: 'ada@example.com', count: 3, nested: { list: ['Ada'] } });
  });
});

describe('header sanitisation', () => {
  it('strips CR and LF', () => {
    expect(stripControlCharacters('a\r\nb')).toBe('a b');
    expect(stripControlCharacters('a\nb')).toBe('a b');
  });

  it('leaves ordinary values untouched', () => {
    expect(stripControlCharacters('hello world')).toBe('hello world');
  });
});
