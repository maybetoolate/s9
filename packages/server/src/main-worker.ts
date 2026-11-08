import { Worker, type Job } from 'bullmq';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closePool } from './db/pool.js';
import { getDb } from './db/client.js';
import { closeRedis, getBlockingRedis, getRedis } from './queue/connection.js';
import { EXECUTION_QUEUE, getExecutionQueue, type ExecutionJobData } from './queue/execution-queue.js';
import { createActionExecutors, createActionRegistry } from './actions/index.js';
import { runExecutionContinuation } from './engine/execution-engine.js';
import { dispatchOutboxOnce } from './engine/dispatcher.js';
import { reconcileOnce } from './engine/reconciler.js';
import { upsertHeartbeat } from './db/repo.js';

/**
 * The worker process.
 *
 * The worker consumes execution continuations from BullMQ, publishes queued
 * work through the outbox dispatcher and recovers stale runs with the
 * reconciler. It never talks to the API and never trusts workflow input.
 */

const config = env();
const workerId = config.WORKER_ID;
const executors = createActionExecutors();
const registry = createActionRegistry(executors);

function runDispatcherTick(queue: ReturnType<typeof getExecutionQueue>): void {
  void dispatchOutboxOnce(queue)
    .then((result) => {
      if (result.claimed > 0) {
        logger.info(result, 'the outbox dispatcher published work');
      }
    })
    .catch((error) => {
      logger.error({ err: error }, 'the outbox dispatcher failed');
    });
}

function runReconcilerTick(): void {
  void reconcileOnce()
    .then((result) => {
      if (result.staleRecovered > 0 || result.requeued > 0) {
        logger.info(result, 'the reconciler recovered work');
      }
    })
    .catch((error) => {
      logger.error({ err: error }, 'the reconciler failed');
    });
}

function runHeartbeatTick(): void {
  void upsertHeartbeat(getDb(), { workerId, currentExecutionId: null }).catch((error) => {
    logger.error({ err: error }, 'the worker heartbeat failed');
  });
}

async function main(): Promise<void> {
  const redis = getRedis();
  const blockingRedis = getBlockingRedis();
  const queue = getExecutionQueue(redis);

  const worker = new Worker<ExecutionJobData>(
    EXECUTION_QUEUE,
    async (job: Job<ExecutionJobData>) => {
      await runExecutionContinuation(job.data, {
        registry,
        executors,
        workerId,
        leaseDurationMs: 180_000,
      });
    },
    {
      connection: blockingRedis,
      concurrency: config.WORKER_CONCURRENCY,
      // The database lease is authoritative, so the BullMQ lock is set above
      // the maximum step timeout and stalled-job detection stays secondary.
      lockDuration: 180_000,
      stalledInterval: 120_000,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id }, 'a job failed');
  });
  worker.on('error', (error) => {
    logger.error({ err: error }, 'the worker reported an error');
  });

  // The outbox dispatcher publishes the queued work.
  const dispatcherTimer = setInterval(() => runDispatcherTick(queue), 1_000);

  // The reconciler recovers stale runs and re-enqueues lost work.
  const reconcilerTimer = setInterval(runReconcilerTick, 15_000);

  // The heartbeat tells the operations endpoints that this worker is alive.
  const heartbeatTimer = setInterval(runHeartbeatTick, 10_000);

  logger.info(
    { workerId, concurrency: config.WORKER_CONCURRENCY, queue: EXECUTION_QUEUE },
    'the worker started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'the worker is shutting down');
    clearInterval(dispatcherTimer);
    clearInterval(reconcilerTimer);
    clearInterval(heartbeatTimer);
    await worker.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await closeRedis();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error({ err: error }, 'the worker failed to start');
  process.exit(1);
});
