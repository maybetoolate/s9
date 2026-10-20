import { pino, type Logger } from 'pino';
import { env } from '../config/env.js';
import { REDACTED } from '@flowforge/core';

/**
 * Structured logging.
 *
 * Blueprint section 16: correlate every log with request ID, workspace ID,
 * workflow ID, execution ID, step ID and attempt number - and never log
 * secrets or entire personal-data payloads.
 */

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'encrypted_secret',
  'body.secret',
  '*.secret',
  '*.password',
  '*.token',
  '*.apiKey',
];

/** Pino options shared by the API logger and the standalone loggers. */
export function loggerOptions(base: Record<string, unknown> = {}) {
  const config = env();
  return {
    level: config.LOG_LEVEL,
    base: { service: 'flowforge', ...base },
    redact: { paths: redactPaths, censor: REDACTED },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  return pino(loggerOptions(base));
}

export const logger = createLogger();

/** Returns a child logger bound to an execution context. */
export function executionLogger(context: {
  requestId?: string;
  workerId?: string;
  workspaceId?: string;
  workflowId?: string;
  executionId?: string;
  stepKey?: string;
  attempt?: number;
}): Logger {
  return logger.child({
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.workerId ? { workerId: context.workerId } : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.workflowId ? { workflowId: context.workflowId } : {}),
    ...(context.executionId ? { executionId: context.executionId } : {}),
    ...(context.stepKey ? { stepKey: context.stepKey } : {}),
    ...(context.attempt ? { attempt: context.attempt } : {}),
  });
}
