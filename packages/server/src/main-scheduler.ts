import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closePool } from './db/pool.js';
import { runSchedulerOnce } from './engine/scheduler.js';
import { pruneOutboxEvents } from './db/repo.js';
import { getPool } from './db/pool.js';
import { LIMITS } from '@s9/core';

/**
 * The scheduler process.
 *
 * It finds due schedule occurrences and creates deduplicated executions. The
 * durable source of truth is the Schedule table in PostgreSQL, never an
 * in-memory timer.
 */

const POLL_INTERVAL_MS = 10_000;

async function main(): Promise<void> {
  env();

  const timer = setInterval(() => {
    void runSchedulerOnce()
      .then((result) => {
        if (result.executionsCreated > 0) {
          logger.info(result, 'the scheduler created executions');
        }
      })
      .catch((error) => {
        logger.error({ err: error }, 'the scheduler failed');
      });
  }, POLL_INTERVAL_MS);

  // Published outbox rows are removed after the retention period so the table
  // does not grow without bound.
  const cleanupTimer = setInterval(() => {
    void pruneOutboxEvents(getPool(), LIMITS.outboxRetentionDays)
      .then((removed) => {
        if (removed > 0) logger.info({ removed }, 'old outbox rows were pruned');
      })
      .catch((error) => {
        logger.error({ err: error }, 'the outbox cleanup failed');
      });
  }, 60 * 60_000);

  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'the scheduler started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'the scheduler is shutting down');
    clearInterval(timer);
    clearInterval(cleanupTimer);
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error({ err: error }, 'the scheduler failed to start');
  process.exit(1);
});
