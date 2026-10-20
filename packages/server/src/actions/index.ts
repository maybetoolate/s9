import { ActionRegistry } from '@flowforge/core';
import { createHttpRequestExecutor } from './http.js';
import { createEmailExecutor } from './email.js';
import { createDatabaseInsertExecutor } from './database.js';
import { createNotificationExecutor } from './notification.js';

/**
 * The action registry.
 *
 * Every adapter declares its output schema, redaction rules, error
 * classification and safe_to_repeat flag. The registry rejects an adapter
 * that omits any of them, so an incomplete adapter can never reach the
 * worker.
 */

export function createActionRegistry(): ActionRegistry {
  const registry = new ActionRegistry();

  registry.register(createDatabaseInsertExecutor());
  registry.register(createEmailExecutor());
  registry.register(createHttpRequestExecutor());
  registry.register(createNotificationExecutor());

  return registry;
}

export { createHttpRequestExecutor, createEmailExecutor, createDatabaseInsertExecutor, createNotificationExecutor };
