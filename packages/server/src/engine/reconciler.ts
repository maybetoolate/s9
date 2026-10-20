import {
  findStaleExecutions,
  findUnstartedExecutions,
  insertAuditEvent,
  updateExecutionStatus,
  type Db,
  type ExecutionRow,
} from '../db/repo.js';
import { databaseNow, getPool, withTransaction } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { scheduleContinuation } from './execution-service.js';

/**
 * The stale-run reconciler.
 *
 * Two failure modes are covered:
 *
 *  - a worker crashed while an action was running: the database lease
 *    expired, so the run is marked for a controlled retry;
 *  - Redis lost its data: queued executions that were already published are
 *    re-enqueued from PostgreSQL.
 *
 * The database lease and the guarded transitions are authoritative;
 * BullMQ's stalled-job detection is only a secondary signal.
 */

export interface ReconcileResult {
  staleRecovered: number;
  requeued: number;
}

/** Queued executions older than this are considered lost by the queue. */
const REQUEUE_AFTER_MS = 60_000;

export async function reconcileOnce(): Promise<ReconcileResult> {
  const db = getPool();
  const now = await databaseNow();
  const result: ReconcileResult = { staleRecovered: 0, requeued: 0 };

  // 1. Executions whose lease expired while they were running.
  const stale = await findStaleExecutions(db, now);
  for (const execution of stale) {
    const recovered = await recoverStaleExecution(db, execution);
    if (recovered) result.staleRecovered += 1;
  }

  // 2. Queued executions that no worker ever picked up (Redis data loss).
  const cutoff = new Date(now.getTime() - REQUEUE_AFTER_MS);
  const orphaned = await findUnstartedExecutions(db, cutoff);
  for (const execution of orphaned) {
    const requeued = await requeueExecution(db, execution);
    if (requeued) result.requeued += 1;
  }

  return result;
}

async function recoverStaleExecution(db: Db, execution: ExecutionRow) {
  return withTransaction(async (client) => {
    const updated = await updateExecutionStatus(client, {
      executionId: execution.id,
      from: ['running', 'retrying'],
      to: 'retrying',
      error: {
        class: 'internal_infrastructure',
        message: 'the worker stopped while the execution was running; the run was recovered',
      },
    });

    if (!updated) return false;

    const runSequence = await incrementRunSequence(client, execution.id);
    await scheduleContinuation(client, {
      executionId: execution.id,
      runSequence,
      workspaceId: execution.workspace_id,
      workflowId: execution.workflow_id,
    });

    await insertAuditEvent(client, {
      workspaceId: execution.workspace_id,
      actorId: null,
      actorType: 'system',
      action: 'execution.recovered',
      targetType: 'execution',
      targetId: execution.id,
      metadata: { previousWorker: execution.worker_id },
    });

    logger.warn(
      { executionId: execution.id, previousWorker: execution.worker_id },
      'a stale execution was recovered',
    );
    return true;
  });
}

async function requeueExecution(db: Db, execution: ExecutionRow) {
  return withTransaction(async (client) => {
    // Only re-enqueue when nothing is waiting to be published: an execution
    // that still has a pending outbox row will be published by the dispatcher.
    const pending = await client.query(
      `SELECT 1 FROM outbox_events
        WHERE aggregate_id = $1 AND status IN ('pending', 'failed') LIMIT 1`,
      [execution.id],
    );
    if (pending.rowCount && pending.rowCount > 0) return false;

    const result = await client.query<{ run_sequence: number }>(
      `UPDATE executions
          SET run_sequence = run_sequence + 1, updated_at = now()
        WHERE id = $1 AND status = 'queued'
        RETURNING run_sequence`,
      [execution.id],
    );
    const row = result.rows[0];
    if (!row) return false;

    await scheduleContinuation(client, {
      executionId: execution.id,
      runSequence: row.run_sequence,
      workspaceId: execution.workspace_id,
      workflowId: execution.workflow_id,
    });

    logger.info({ executionId: execution.id }, 'an execution was re-enqueued after a queue data loss');
    return true;
  });
}

async function incrementRunSequence(client: import('pg').PoolClient, executionId: string): Promise<number> {
  const result = await client.query<{ run_sequence: number }>(
    'UPDATE executions SET run_sequence = run_sequence + 1 WHERE id = $1 RETURNING run_sequence',
    [executionId],
  );
  return result.rows[0]?.run_sequence ?? 0;
}
