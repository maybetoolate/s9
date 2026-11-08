import {
  ActionRegistry,
  type ActionContext,
  type ActionResult,
  type ActionType,
  type ClassifiedError,
} from '@s9/core';
import { HttpRequestExecutor, createHttpRequestExecutor } from './http.js';
import { EmailExecutor, createEmailExecutor } from './email.js';
import { DatabaseInsertExecutor, createDatabaseInsertExecutor } from './database.js';
import { NotificationExecutor, createNotificationExecutor } from './notification.js';

/**
 * The action registry.
 *
 * Every adapter declares its output schema, redaction rules, error
 * classification and safe_to_repeat flag. The registry rejects an adapter
 * that omits any of them, so an incomplete adapter can never reach the
 * worker.
 *
 * The adapters are also exposed as a concrete, type-keyed map so the engine
 * can dispatch a step to the exact executor instead of a dynamic lookup.
 */

export interface ActionExecutors {
  readonly http_request: HttpRequestExecutor;
  readonly send_email: EmailExecutor;
  readonly database_insert: DatabaseInsertExecutor;
  readonly notification: NotificationExecutor;
}

export function createActionExecutors(): ActionExecutors {
  return {
    http_request: new HttpRequestExecutor(),
    send_email: new EmailExecutor(),
    database_insert: new DatabaseInsertExecutor(),
    notification: new NotificationExecutor(),
  };
}

export function createActionRegistry(executors: ActionExecutors = createActionExecutors()): ActionRegistry {
  const registry = new ActionRegistry();

  registry.register(executors.database_insert);
  registry.register(executors.send_email);
  registry.register(executors.http_request);
  registry.register(executors.notification);

  return registry;
}

/** Runs a step on the exact adapter for its type. */
export async function dispatchExecute(
  executors: ActionExecutors,
  type: ActionType,
  context: ActionContext,
): Promise<ActionResult> {
  switch (type) {
    case 'http_request':
      return executors.http_request.execute(context);
    case 'send_email':
      return executors.send_email.execute(context);
    case 'database_insert':
      return executors.database_insert.execute(context);
    case 'notification':
      return executors.notification.execute(context);
    default:
      throw new Error(`unhandled action type: ${String(type)}`);
  }
}

/** Maps a thrown value onto the taxonomy with the exact adapter for its type. */
export function dispatchClassifyError(
  executors: ActionExecutors,
  type: ActionType,
  error: unknown,
): ClassifiedError {
  switch (type) {
    case 'http_request':
      return executors.http_request.classifyError(error);
    case 'send_email':
      return executors.send_email.classifyError(error);
    case 'database_insert':
      return executors.database_insert.classifyError(error);
    case 'notification':
      return executors.notification.classifyError(error);
    default:
      throw new Error(`unhandled action type: ${String(type)}`);
  }
}

export { createHttpRequestExecutor, createEmailExecutor, createDatabaseInsertExecutor, createNotificationExecutor };
