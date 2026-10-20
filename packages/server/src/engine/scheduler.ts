import {
  buildExecutionIdempotencyKey,
  decideCatchUp,
  isValidCron,
  isValidTimezone,
  LIMITS,
  nextOccurrences,
  type ScheduleOccurrence,
} from '@flowforge/core';
import {
  insertScheduleOccurrence,
  linkOccurrenceToExecution,
  listDueSchedules,
  updateScheduleRunState,
  type ScheduleRow,
} from '../db/repo.js';
import { databaseNow, getPool, withAdvisoryLock, withTransaction } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { createExecution } from './execution-service.js';

/**
 * The scheduler.
 *
 * Schedule definitions live in PostgreSQL; the Schedule table is a derived
 * index of the published definition. The unique occurrence key plus an
 * advisory lock keep a single creator, so a duplicated scheduler poll cannot
 * create the same occurrence twice.
 */

/** An occurrence that became due more than a minute ago is treated as a miss. */
const DUE_GRACE_MS = 60_000;

export interface SchedulerResult {
  schedulesChecked: number;
  occurrencesCreated: number;
  executionsCreated: number;
}

export async function runSchedulerOnce(): Promise<SchedulerResult> {
  const db = getPool();
  const now = await databaseNow();
  const result: SchedulerResult = { schedulesChecked: 0, occurrencesCreated: 0, executionsCreated: 0 };

  const due = await listDueSchedules(db, now);
  for (const schedule of due) {
    result.schedulesChecked += 1;
    try {
      const outcome = await processSchedule(schedule, now);
      result.occurrencesCreated += outcome.occurrencesCreated;
      result.executionsCreated += outcome.executionsCreated;
    } catch (error) {
      logger.error({ err: error, scheduleId: schedule.id }, 'the schedule could not be processed');
    }
  }

  return result;
}

async function processSchedule(schedule: ScheduleRow, now: Date) {
  const db = getPool();

  if (!isValidCron(schedule.schedule_spec) || !isValidTimezone(schedule.timezone)) {
    logger.error({ scheduleId: schedule.id }, 'the schedule is invalid and was skipped');
    return { occurrencesCreated: 0, executionsCreated: 0 };
  }

  // The advisory lock keeps a single creator for this schedule.
  return withAdvisoryLock(`schedule:${schedule.id}`, async (client) => {
    const current = await client.query<ScheduleRow>('SELECT * FROM schedules WHERE id = $1 FOR UPDATE', [schedule.id]);
    const row = current.rows[0];
    if (!row || !row.enabled || !row.next_run_at || row.next_run_at > now) {
      return { occurrencesCreated: 0, executionsCreated: 0 };
    }

    const reference = row.last_occurrence_at ?? row.next_run_at;
    const after = new Date(reference.getTime() - 1_000);
    const occurrences = nextOccurrences({
      expression: row.schedule_spec,
      timezone: row.timezone,
      after,
      count: 100,
    });

    const dueOccurrences = occurrences.filter((occurrence) => occurrence.scheduledFor <= now);
    if (dueOccurrences.length === 0) {
      const [next] = nextOccurrences({
        expression: row.schedule_spec,
        timezone: row.timezone,
        after: new Date(now.getTime() - 1_000),
        count: 1,
      });
      await updateScheduleRunState(client, row.id, next?.scheduledFor ?? null, row.last_occurrence_at);
      return { occurrencesCreated: 0, executionsCreated: 0 };
    }

    // Only the latest missed occurrence is caught up, and only when it is
    // younger than the catch-up window.
    const candidate = dueOccurrences[dueOccurrences.length - 1] as ScheduleOccurrence;
    const age = now.getTime() - candidate.scheduledFor.getTime();
    const isCatchUp = dueOccurrences.length > 1 || row.last_occurrence_at !== null;

    let toFire: ScheduleOccurrence | null = candidate;
    if (age > LIMITS.scheduleCatchUpWindowMs) {
      logger.warn(
        { scheduleId: row.id, ageHours: Math.round(age / 3_600_000) },
        'the missed occurrence is older than the catch-up window and was skipped',
      );
      toFire = null;
    } else if (isCatchUp && age > DUE_GRACE_MS && !catchUpEnabled(row)) {
      toFire = null;
    }

    if (!toFire) {
      const [next] = nextOccurrences({
        expression: row.schedule_spec,
        timezone: row.timezone,
        after: new Date(now.getTime() - 1_000),
        count: 1,
      });
      await updateScheduleRunState(client, row.id, next?.scheduledFor ?? null, row.last_occurrence_at);
      return { occurrencesCreated: 0, executionsCreated: 0 };
    }

    // The unique occurrence key is the real guard against a duplicate.
    const occurrence = await insertScheduleOccurrence(client, {
      scheduleId: row.id,
      scheduledFor: toFire.scheduledFor,
      localKey: toFire.localKey,
    });

    if (!occurrence) {
      logger.info({ scheduleId: row.id, localKey: toFire.localKey }, 'the occurrence already exists');
      const [next] = nextOccurrences({
        expression: row.schedule_spec,
        timezone: row.timezone,
        after: new Date(toFire.scheduledFor.getTime() - 1_000),
        count: 1,
      });
      await updateScheduleRunState(client, row.id, next?.scheduledFor ?? null, toFire.scheduledFor);
      return { occurrencesCreated: 0, executionsCreated: 0 };
    }

    const executionsCreated = await createScheduledExecution(row, toFire, occurrence.id);

    const [next] = nextOccurrences({
      expression: row.schedule_spec,
      timezone: row.timezone,
      after: new Date(toFire.scheduledFor.getTime() - 1_000),
      count: 1,
    });
    await updateScheduleRunState(client, row.id, next?.scheduledFor ?? null, toFire.scheduledFor);

    return { occurrencesCreated: 1, executionsCreated };
  });
}

function catchUpEnabled(schedule: ScheduleRow): boolean {
  // Catch-up is part of the published trigger configuration; the Schedule row
  // mirrors it.
  return schedule.catch_up !== false;
}

async function createScheduledExecution(
  schedule: ScheduleRow,
  occurrence: ScheduleOccurrence,
  occurrenceId: string,
): Promise<number> {
  const db = getPool();

  const row = await db.query<{
    id: string;
    workspace_id: string;
    status: string;
    current_version_id: string | null;
  }>(
    `SELECT w.id, w.workspace_id, w.status, w.current_version_id
       FROM workflows w WHERE w.id = $1`,
    [schedule.workflow_id],
  );
  const wf = row.rows[0];
  if (!wf) {
    logger.error({ scheduleId: schedule.id }, 'the workflow of the schedule no longer exists');
    return 0;
  }

  // Pausing a workflow stops the creation of new production runs.
  if (wf.status !== 'published' || !wf.current_version_id) {
    logger.info({ workflowId: wf.id, status: wf.status }, 'the schedule did not create a run');
    return 0;
  }

  const idempotencyKey = buildExecutionIdempotencyKey({
    workflowId: wf.id,
    triggerType: 'schedule',
    triggerKey: `${schedule.id}:${occurrence.localKey}`,
    version: 0,
  });

  const result = await createExecution({
    workspaceId: wf.workspace_id,
    workflowId: wf.id,
    workflowVersionId: wf.current_version_id,
    triggerType: 'schedule',
    input: {
      scheduledFor: occurrence.scheduledFor.toISOString(),
      occurrence: occurrence.localKey,
    },
    idempotencyKey,
    actorId: null,
  });

  if (result.duplicate) return 0;

  await withTransaction(async (client) => {
    await linkOccurrenceToExecution(client, occurrenceId, result.id);
  });

  logger.info({ executionId: result.id, workflowId: wf.id }, 'the scheduled execution was created');
  return 1;
}

/**
 * Computes the next run of a schedule, used when a workflow is published.
 */
export function computeNextRun(
  expression: string,
  timezone: string,
  from: Date = new Date(),
): Date | null {
  if (!isValidCron(expression) || !isValidTimezone(timezone)) return null;
  const [next] = nextOccurrences({ expression, timezone, after: from, count: 1 });
  return next?.scheduledFor ?? null;
}

export { decideCatchUp };
