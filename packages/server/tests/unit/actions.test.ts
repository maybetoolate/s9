import { beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  S9Error,
  type ActionContext,
  type ActionExecutor,
  type ActionResult,
  type ActionType,
  type ClassifiedError,
} from '@s9/core';
import type { ActionExecutors } from '../../src/actions/index.js';

type ActionsModule = typeof import('../../src/actions/index.js');

/**
 * The action adapters and the typed dispatcher.
 *
 * The unit project does not load the integration environment, so the modules
 * are imported only after the minimum environment contract is in place. The
 * db pool reads the environment lazily, but the adapters read it while
 * validating a destination, so the variables have to exist before the import.
 */

let actions: ActionsModule;

const TYPES: readonly ActionType[] = ['http_request', 'send_email', 'database_insert', 'notification'];

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    executionId: 'execution-1',
    workflowVersionId: 'version-1',
    stepKey: 'step-1',
    attempt: 1,
    idempotencyKey: 'idempotency-1',
    input: {},
    stepOutputs: {},
    triggerInput: {},
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    simulate: false,
    ...overrides,
  };
}

function adapterTypes(executors: ActionExecutors): ActionType[] {
  const adapters: ActionExecutor[] = [
    executors.http_request,
    executors.send_email,
    executors.database_insert,
    executors.notification,
  ];
  return adapters.map((adapter) => adapter.type);
}

function executeSpies(executors: ActionExecutors, result: ActionResult) {
  return {
    http_request: spyOn(executors.http_request, 'execute').mockResolvedValue(result),
    send_email: spyOn(executors.send_email, 'execute').mockResolvedValue(result),
    database_insert: spyOn(executors.database_insert, 'execute').mockResolvedValue(result),
    notification: spyOn(executors.notification, 'execute').mockResolvedValue(result),
  };
}

function classifySpies(executors: ActionExecutors, result: ClassifiedError) {
  return {
    http_request: spyOn(executors.http_request, 'classifyError').mockReturnValue(result),
    send_email: spyOn(executors.send_email, 'classifyError').mockReturnValue(result),
    database_insert: spyOn(executors.database_insert, 'classifyError').mockReturnValue(result),
    notification: spyOn(executors.notification, 'classifyError').mockReturnValue(result),
  };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://s9:s9@localhost:55432/s9_test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.SESSION_SECRET = 'unit-test-session-secret';
  process.env.ENCRYPTION_KEY = 'unit-test-encryption-key';
  process.env.ALLOWED_PRIVATE_HOSTS = '';
  process.env.LOG_LEVEL = 'silent';

  actions = await import('../../src/actions/index.js');
});

describe('createActionExecutors', () => {
  it('builds one adapter per action type', () => {
    const executors = actions.createActionExecutors();
    expect(adapterTypes(executors).sort()).toEqual([...TYPES].sort());
  });

  it('declares the repeat-safety of every adapter', () => {
    const executors = actions.createActionExecutors();
    expect({
      http_request: executors.http_request.safeToRepeat,
      send_email: executors.send_email.safeToRepeat,
      database_insert: executors.database_insert.safeToRepeat,
      notification: executors.notification.safeToRepeat,
    }).toEqual({
      http_request: false,
      send_email: false,
      database_insert: true,
      notification: false,
    });
  });

  it('registers the exact instances it was given', () => {
    const executors = actions.createActionExecutors();
    const registry = actions.createActionRegistry(executors);

    for (const type of TYPES) {
      expect(registry.get(type)).toBe(executors[type]);
    }
    expect(registry.list()).toHaveLength(TYPES.length);
  });

  it('still builds a complete registry without an explicit map', () => {
    const registry = actions.createActionRegistry();
    expect(registry.list().map((adapter) => adapter.type).sort()).toEqual([...TYPES].sort());
  });
});

describe('dispatchExecute', () => {
  it('calls exactly the adapter for the action type', async () => {
    const result: ActionResult = { output: { routed: true } };

    for (const type of TYPES) {
      const executors = actions.createActionExecutors();
      const spies = executeSpies(executors, result);
      const input = context({ input: { marker: type } });

      await expect(actions.dispatchExecute(executors, type, input)).resolves.toBe(result);

      for (const candidate of TYPES) {
        if (candidate === type) expect(spies[candidate]).toHaveBeenCalledTimes(1);
        else expect(spies[candidate]).not.toHaveBeenCalled();
      }

      mock.restore();
    }
  });

  it('rejects a type that has no adapter', async () => {
    const executors = actions.createActionExecutors();
    await expect(
      actions.dispatchExecute(executors, 'unknown' as ActionType, context()),
    ).rejects.toThrow('unhandled action type: unknown');
  });
});

describe('dispatchClassifyError', () => {
  it('classifies with exactly the adapter for the action type', () => {
    const classified: ClassifiedError = {
      class: 'transient_provider',
      message: 'provider unavailable',
      safeToRepeat: false,
    };

    for (const type of TYPES) {
      const executors = actions.createActionExecutors();
      const spies = classifySpies(executors, classified);

      expect(actions.dispatchClassifyError(executors, type, new Error('boom'))).toBe(classified);

      for (const candidate of TYPES) {
        if (candidate === type) expect(spies[candidate]).toHaveBeenCalledTimes(1);
        else expect(spies[candidate]).not.toHaveBeenCalled();
      }

      mock.restore();
    }
  });

  it('rejects a type that has no adapter', () => {
    const executors = actions.createActionExecutors();
    expect(() =>
      actions.dispatchClassifyError(executors, 'unknown' as ActionType, new Error('boom')),
    ).toThrow('unhandled action type: unknown');
  });
});

describe('validateConfig', () => {
  const cases: {
    type: ActionType;
    valid: Record<string, unknown>;
    invalid: Record<string, unknown>;
  }[] = [
    {
      type: 'http_request',
      valid: { url: 'https://api.example.com/hook' },
      invalid: { url: 'http://127.0.0.1:8080/admin' },
    },
    {
      type: 'send_email',
      valid: { from: 'forge@example.com', to: 'ada@example.com', subject: 'Hello' },
      invalid: { from: 'forge@example.com', to: '', subject: 'Hello' },
    },
    {
      type: 'database_insert',
      valid: { values: { email: 'ada@example.com' } },
      invalid: { values: 'not-an-object' },
    },
    {
      type: 'notification',
      valid: { channel: '#ops', message: 'Deployed', webhookUrl: 'https://hooks.example.com/ops' },
      invalid: { channel: '#ops', message: 'Deployed' },
    },
  ];

  for (const { type, valid, invalid } of cases) {
    it(`accepts a valid ${type} configuration`, () => {
      const executors = actions.createActionExecutors();
      const result = executors[type].validateConfig(valid);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toMatchObject(valid);
    });

    it(`rejects an invalid ${type} configuration`, () => {
      const executors = actions.createActionExecutors();
      const result = executors[type].validateConfig(invalid);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toHaveLength(0);
    });
  }

  it('rejects a notification destination on a private address', () => {
    const result = actions.createActionExecutors().notification.validateConfig({
      channel: '#ops',
      message: 'Deployed',
      webhookUrl: 'http://10.0.0.5/hook',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('private');
  });

  it('allows an http_request to opt into a private destination', () => {
    const result = actions
      .createActionExecutors()
      .http_request.validateConfig({ url: 'http://10.0.0.5/hook', allowPrivateNetwork: true });
    expect(result.ok).toBe(true);
  });
});

describe('simulated execution', () => {
  it('http_request simulates without a network call', async () => {
    const result = await actions.createActionExecutors().http_request.execute(
      context({ simulate: true, input: { url: 'https://api.example.com/hook' } }),
    );

    expect(result.status).toBe(200);
    expect(result.output).toMatchObject({
      status: 200,
      truncated: false,
      body: { simulated: true, url: 'https://api.example.com/hook', method: 'POST' },
    });
  });

  it('send_email simulates with a deterministic message id', async () => {
    const result = await actions.createActionExecutors().send_email.execute(
      context({
        simulate: true,
        input: { from: 'Forge <forge@example.com>', to: 'Ada <ada@example.com>', subject: 'Hello' },
      }),
    );

    expect(result.output).toMatchObject({ provider: 'mailpit', accepted: true, simulated: true });
    expect(result.output.messageId).toBe('simulated-execution-1-step-1');
  });

  it('database_insert simulates with a deterministic contact id', async () => {
    const result = await actions.createActionExecutors().database_insert.execute(
      context({ simulate: true, input: { values: { email: 'ada@example.com' }, dedupeKey: 'ada' } }),
    );

    expect(result.output).toEqual({
      contactId: 'simulated-execution-1-step-1',
      created: true,
      dedupeKey: 'ada',
    });
  });

  it('notification simulates without resolving the destination', async () => {
    const result = await actions.createActionExecutors().notification.execute(
      context({
        simulate: true,
        input: { channel: '#ops', message: 'Deployed', webhookUrl: 'https://hooks.example.com/ops' },
      }),
    );

    expect(result.output).toEqual({ channel: '#ops', delivered: true, status: 200 });
  });

  it('notification refuses to simulate without a destination', async () => {
    await expect(
      actions
        .createActionExecutors()
        .notification.execute(context({ simulate: true, input: { channel: '#ops', message: 'Deployed' } })),
    ).rejects.toThrow('the notification action has no destination URL');
  });
});

describe('classifyError', () => {
  it('passes a S9Error through unchanged for every adapter', () => {
    const original = S9Error.rateLimited('slow down', 1_500, { status: 429 });

    for (const type of TYPES) {
      const classified = actions.createActionExecutors()[type].classifyError(original);
      expect(classified).toEqual(original.toClassified());
    }
  });

  it('maps an unclassified error to the adapter default', () => {
    const defaults: Record<ActionType, ClassifiedError['class']> = {
      http_request: 'transient_provider',
      send_email: 'transient_provider',
      database_insert: 'internal_infrastructure',
      notification: 'transient_provider',
    };

    for (const type of TYPES) {
      const classified = actions.createActionExecutors()[type].classifyError(new Error('socket hang up'));
      expect(classified.class).toBe(defaults[type]);
      expect(classified.message).toContain('socket hang up');
    }
  });

  it('marks the idempotent database write safe to repeat', () => {
    const classified = actions
      .createActionExecutors()
      .database_insert.classifyError(new Error('connection reset'));
    expect(classified.safeToRepeat).toBe(true);
  });

  it('keeps a provider failure unsafe to repeat', () => {
    const classified = actions
      .createActionExecutors()
      .http_request.classifyError(new Error('connection reset'));
    expect(classified.safeToRepeat).toBe(false);
  });
});
