import type { Queue } from 'bullmq';
import { computeBackoffDelay, LIMITS } from '@s9/core';
import {
  claimOutboxEvents,
  markOutboxFailed,
  markOutboxPublished,
  type OutboxEventRow,
} from '../db/repo.js';
import { withTransaction } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { enqueueExecution, type ExecutionJobData } from '../queue/execution-queue.js';

/**
 * The outbox dispatcher.
 *
 * The dispatcher is the only component that publishes work to BullMQ. It
 * claims rows with `FOR UPDATE SKIP LOCKED` so several dispatchers can run
 * safely, retries failed publishes with backoff and marks a row
 * `dead_letter` after the maximum number of attempts.
 */

export interface DispatchResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
}

export async function dispatchOutboxOnce(queue: Queue<ExecutionJobData>): Promise<DispatchResult> {
  const result: DispatchResult = { claimed: 0, published: 0, failed: 0, deadLettered: 0 };

  const rows = await withTransaction((client) => claimOutboxEvents(client, 25));
  result.claimed = rows.length;

  for (const row of rows) {
    try {
      await publishRow(queue, row);
      await withTransaction((client) => markOutboxPublished(client, row.id));
      result.published += 1;
    } catch (error) {
      const message = (error as Error).message ?? 'the publish failed';
      const deadLetter = row.attempt_count >= LIMITS.maxOutboxAttempts;
      const delayMs = computeBackoffDelay({
        attempt: row.attempt_count,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
      });

      await withTransaction((client) =>
        markOutboxFailed(client, {
          id: row.id,
          error: message.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + delayMs),
          deadLetter,
        }),
      );

      if (deadLetter) {
        result.deadLettered += 1;
        logger.error({ outboxId: row.id, attemptCount: row.attempt_count }, 'outbox row moved to dead_letter');
      } else {
        result.failed += 1;
        logger.warn({ outboxId: row.id, attemptCount: row.attempt_count, err: message }, 'outbox publish failed');
      }
    }
  }

  return result;
}

async function publishRow(queue: Queue<ExecutionJobData>, row: OutboxEventRow): Promise<void> {
  const payload = row.payload as {
    executionId?: string;
    runSequence?: number;
    workspaceId?: string | null;
    workflowId?: string | null;
    delayMs?: number;
  };

  if (!payload.executionId) {
    throw new Error(`the outbox row ${row.id} has no execution id`);
  }

  await enqueueExecution(queue, {
    executionId: payload.executionId,
    runSequence: payload.runSequence ?? 0,
    ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
    ...(payload.workflowId ? { workflowId: payload.workflowId } : {}),
    ...(payload.delayMs ? { delayMs: payload.delayMs } : {}),
  });
}
