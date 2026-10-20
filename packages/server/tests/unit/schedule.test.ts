import { describe, expect, it } from 'vitest';
import {
  computeBackoffDelay,
  decideCatchUp,
  formatDelay,
  isValidCron,
  isValidTimezone,
  localWallClockKey,
  nextOccurrences,
  resolveLocalTimeToInstant,
} from '@flowforge/core';

/**
 * Schedule behaviour from blueprint section 6.2:
 *  - a daily 02:30 schedule in America/New_York fires once at 03:00 on the
 *    spring-forward day;
 *  - on the fall-back day a 01:30 schedule fires once, at its first
 *    occurrence;
 *  - catch-up after downtime covers only the latest missed occurrence, and
 *    only when it is under 24 hours old.
 */
const NEW_YORK = 'America/New_York';

describe('cron and timezone validation', () => {
  it('accepts a valid cron expression', () => {
    expect(isValidCron('30 2 * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
  });

  it('rejects an invalid cron expression', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('99 99 * * *')).toBe(false);
  });

  it('validates the timezone', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('daylight saving behaviour', () => {
  it('fires once at 03:00 when the local time does not exist', () => {
    const [first] = nextOccurrences({
      expression: '30 2 * * *',
      timezone: NEW_YORK,
      after: new Date('2026-03-07T12:00:00Z'),
      count: 1,
    });
    expect(first).toBeDefined();
    expect(first?.scheduledFor.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(localWallClockKey(first!.scheduledFor, NEW_YORK)).toBe('2026-03-08T03:00');
  });

  it('fires once at the first occurrence when the local time happens twice', () => {
    const [first] = nextOccurrences({
      expression: '30 1 * * *',
      timezone: NEW_YORK,
      after: new Date('2026-10-31T12:00:00Z'),
      count: 1,
    });
    expect(first?.scheduledFor.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(localWallClockKey(first!.scheduledFor, NEW_YORK)).toBe('2026-11-01T01:30');
  });

  it('does not fire the repeated hour twice', () => {
    const occurrences = nextOccurrences({
      expression: '0 * * * *',
      timezone: NEW_YORK,
      after: new Date('2026-11-01T04:30:00Z'),
      count: 4,
    });
    const localKeys = occurrences.map((occurrence) => occurrence.localKey);
    expect(localKeys).toEqual(['2026-11-01T01:00', '2026-11-01T02:00', '2026-11-01T03:00', '2026-11-01T04:00']);
  });

  it('resolves a local time to the first valid instant', () => {
    // 02:30 does not exist on the spring-forward day.
    const local = Date.UTC(2026, 2, 8, 2, 30);
    expect(resolveLocalTimeToInstant(local, NEW_YORK).toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('keeps ordinary schedules unchanged', () => {
    const [first] = nextOccurrences({
      expression: '30 2 * * *',
      timezone: NEW_YORK,
      after: new Date('2026-06-01T00:00:00Z'),
      count: 1,
    });
    // 2026-06-01T00:00Z is 2026-05-31T20:00 in New York, so the next 02:30
    // is still on the first of June.
    expect(localWallClockKey(first!.scheduledFor, NEW_YORK)).toBe('2026-06-01T02:30');
    expect(first?.scheduledFor.toISOString()).toBe('2026-06-01T06:30:00.000Z');
  });
});

describe('catch-up after downtime', () => {
  const now = new Date('2026-06-10T12:00:00Z');

  it('catches up the latest missed occurrence when it is young enough', () => {
    const decision = decideCatchUp({
      expression: '0 * * * *',
      timezone: 'UTC',
      lastOccurrenceAt: new Date('2026-06-10T09:00:00Z'),
      now,
      catchUpEnabled: true,
      catchUpWindowMs: 24 * 60 * 60_000,
    });
    expect(decision.shouldCatchUp).toBe(true);
    expect(decision.occurrence?.scheduledFor.toISOString()).toBe('2026-06-10T11:00:00.000Z');
  });

  it('does not catch up an occurrence that is older than the window', () => {
    // A weekly schedule: the latest missed occurrence is two days old.
    const decision = decideCatchUp({
      expression: '0 3 * * 1',
      timezone: 'UTC',
      lastOccurrenceAt: new Date('2026-06-01T03:00:00Z'),
      now,
      catchUpEnabled: true,
      catchUpWindowMs: 24 * 60 * 60_000,
    });
    expect(decision.shouldCatchUp).toBe(false);
    expect(decision.reason).toContain('catch-up window');
  });

  it('never catches up when catch-up is disabled', () => {
    const decision = decideCatchUp({
      expression: '0 * * * *',
      timezone: 'UTC',
      lastOccurrenceAt: new Date('2026-06-10T11:00:00Z'),
      now,
      catchUpEnabled: false,
      catchUpWindowMs: 24 * 60 * 60_000,
    });
    expect(decision.shouldCatchUp).toBe(false);
  });
});

describe('backoff', () => {
  it('grows exponentially and stays below the cap', () => {
    const options = { baseDelayMs: 5_000, maxDelayMs: 300_000, random: () => 0.5 };
    expect(computeBackoffDelay({ ...options, attempt: 1 })).toBe(5_000);
    expect(computeBackoffDelay({ ...options, attempt: 2 })).toBe(10_000);
    expect(computeBackoffDelay({ ...options, attempt: 3 })).toBe(20_000);
    expect(computeBackoffDelay({ ...options, attempt: 10 })).toBeLessThanOrEqual(300_000);
  });

  it('applies jitter', () => {
    const low = computeBackoffDelay({ attempt: 1, baseDelayMs: 5_000, maxDelayMs: 300_000, random: () => 0 });
    const high = computeBackoffDelay({ attempt: 1, baseDelayMs: 5_000, maxDelayMs: 300_000, random: () => 1 });
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(4_000);
    expect(high).toBeLessThanOrEqual(6_000);
  });

  it('honours the provider retry hint', () => {
    const delay = computeBackoffDelay({
      attempt: 1,
      baseDelayMs: 5_000,
      maxDelayMs: 300_000,
      retryAfterMs: 1_500,
    });
    expect(delay).toBe(1_500);
  });

  it('formats the delay for humans', () => {
    expect(formatDelay(500)).toBe('500ms');
    expect(formatDelay(5_000)).toBe('5.0s');
    expect(formatDelay(300_000)).toBe('5m');
  });
});
