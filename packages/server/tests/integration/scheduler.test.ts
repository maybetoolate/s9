import { beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { databaseNow, getDb } from '../../src/db/client.js';
import { executions, scheduleOccurrences, schedules } from '../../src/db/schema.js';
import { runSchedulerOnce } from '../../src/engine/scheduler.js';
import {
  buildServer,
  createPublishedWorkflow,
  createSession,
  resetData,
  type TestContext,
} from './helpers.js';

/**
 * The scheduler.
 *
 * Schedule definitions live in PostgreSQL, so these tests drive the real
 * scheduler against the real database: one poll must create one execution for
 * a due occurrence, and a duplicate poll must create nothing.
 */

const scheduledDefinition = {
  trigger: {
    type: 'schedule',
    cron: '* * * * *',
    timezone: 'UTC',
    catchUp: true,
  },
  steps: [
    {
      key: 'save_contact',
      name: 'Save contact',
      type: 'database_insert',
      config: {
        table: 'contacts',
        values: { name: 'Scheduled run', email: 'scheduled@example.com' },
      },
    },
  ],
};

describe('scheduler', () => {
  let context: TestContext;

  beforeEach(async () => {
    await resetData();
    const app = await buildServer();
    context = await createSession(
      app,
      `scheduler-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    );
  });

  it('reads database time as a real Date', async () => {
    const before = Date.now();
    const now = await databaseNow();

    expect(now).toBeInstanceOf(Date);
    // The test database and the test process share a clock.
    expect(Math.abs(now.getTime() - before)).toBeLessThan(60_000);
  });

  it('creates one execution for a due schedule and does not duplicate it', async () => {
    await createPublishedWorkflow(context, scheduledDefinition);

    const db = getDb();
    const [schedule] = await db.select().from(schedules).limit(1);
    expect(schedule).toBeDefined();

    // The current minute boundary is always due and its age stays inside the
    // one-minute grace window, so the latest occurrence is the one that fires.
    await db.execute(sql`
      UPDATE schedules
      SET next_run_at = date_trunc('minute', now()), last_occurrence_at = NULL
      WHERE id = ${schedule!.id}
    `);

    const first = await runSchedulerOnce();
    expect(first.executionsCreated).toBe(1);
    expect(first.occurrencesCreated).toBe(1);

    const created = await db.select().from(executions);
    expect(created).toHaveLength(1);
    expect(created[0]!.trigger_type).toBe('schedule');
    expect(created[0]!.status).toBe('queued');
    expect(created[0]!.workflow_id).toBe(schedule!.workflow_id);

    // The occurrence is linked to the execution it produced.
    const occurrences = await db.select().from(scheduleOccurrences);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.execution_id).toBe(created[0]!.id);

    // A second poll must not create another execution: the next run is in the
    // future and the occurrence key is unique.
    const second = await runSchedulerOnce();
    expect(second.schedulesChecked).toBe(0);
    expect(second.executionsCreated).toBe(0);
    expect(second.occurrencesCreated).toBe(0);
    expect(await db.select().from(executions)).toHaveLength(1);

    // The schedule advanced past the occurrence it just fired.
    const [updated] = await db.select().from(schedules).where(eq(schedules.id, schedule!.id));
    expect(updated!.next_run_at!.getTime()).toBeGreaterThan(occurrences[0]!.scheduled_for.getTime());
    expect(updated!.last_occurrence_at!.getTime()).toBe(occurrences[0]!.scheduled_for.getTime());
  });
});
