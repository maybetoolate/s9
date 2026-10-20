import { CronExpressionParser } from 'cron-parser';

/**
 * Schedule evaluation.
 *
 * Blueprint section 6.2:
 *  - the timezone is stored explicitly and defaults to UTC;
 *  - a daily 02:30 schedule in America/New_York fires once at 03:00 on the
 *    spring-forward day (the local time does not exist, the fire time snaps to
 *    the end of the DST gap);
 *  - on the fall-back day a 01:30 schedule fires once, at its first occurrence;
 *  - after downtime only the latest missed occurrence is caught up, and only if
 *    it is less than 24 hours old.
 *
 * Cron expressions are evaluated as *wall clock* times in the schedule's own
 * timezone and then resolved to an instant. Resolving the wall clock time
 * ourselves is what makes the DST rules above exact: the raw cron library
 * either skips the gap or shifts the fire time by the gap length.
 */

export const SUPPORTED_CRON_SYNTAX = 'Standard 5-field cron (minute hour day-of-month month day-of-week)';

export interface ScheduleOccurrence {
  /** The UTC instant the occurrence fires at. */
  scheduledFor: Date;
  /** Local wall-clock key, e.g. `2026-11-01T01:30`. Used for DST de-duplication. */
  localKey: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the UTC offset (in ms) of a timezone at a given instant. */
export function getTimezoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const hour = Number(values.hour) === 24 ? 0 : Number(values.hour);
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    hour,
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Formats an instant in the given IANA timezone as a local wall-clock key. */
export function localWallClockKey(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/**
 * Resolves a local wall-clock time to a UTC instant.
 *
 * - Normal time: the unique instant with that local time.
 * - Ambiguous time (fall back): the *first* occurrence, so a repeated hour
 *   fires once.
 * - Non-existent time (spring forward): the instant of the transition, i.e.
 *   the first valid local time after the gap. A 02:30 schedule therefore
 *   fires at 03:00 on the spring-forward day.
 */
export function resolveLocalTimeToInstant(localMs: number, timeZone: string): Date {
  const offsetGuess = getTimezoneOffsetMs(new Date(localMs), timeZone);
  const guess = localMs - offsetGuess;
  const offsetAtGuess = getTimezoneOffsetMs(new Date(guess), timeZone);
  if (offsetAtGuess === offsetGuess) return new Date(guess);

  const offsetBefore = getTimezoneOffsetMs(new Date(guess - 2 * DAY_MS), timeZone);
  const offsetAfter = getTimezoneOffsetMs(new Date(guess + 2 * DAY_MS), timeZone);

  if (offsetBefore > offsetAfter) {
    // Fall back: the local time happens twice. Pick the earlier instant.
    const earlier = localMs - offsetBefore;
    const later = localMs - offsetAfter;
    const earlierValid = getTimezoneOffsetMs(new Date(earlier), timeZone) === offsetBefore;
    const laterValid = getTimezoneOffsetMs(new Date(later), timeZone) === offsetAfter;
    if (earlierValid) return new Date(earlier);
    if (laterValid) return new Date(later);
    return new Date(guess);
  }

  // Spring forward: the local time does not exist. Fire at the transition.
  let low = localMs - offsetAfter;
  let high = localMs - offsetBefore;
  while (high - low > 1000) {
    const mid = low + Math.floor((high - low) / 2);
    const localMid = mid + getTimezoneOffsetMs(new Date(mid), timeZone);
    if (localMid > localMs) high = mid;
    else low = mid;
  }
  return new Date(high);
}

/** Validates an IANA timezone name. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Validates a cron expression. */
export function isValidCron(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression);
    return true;
  } catch {
    return false;
  }
}

export interface NextOccurrenceOptions {
  expression: string;
  timezone: string;
  /** The instant to search from (exclusive). */
  after: Date;
  /** Maximum number of occurrences to return. */
  count?: number;
}

/** Returns the next occurrences strictly after `after`. */
export function nextOccurrences(options: NextOccurrenceOptions): ScheduleOccurrence[] {
  const count = options.count ?? 1;
  const naiveAfter = options.after.getTime() + getTimezoneOffsetMs(options.after, options.timezone);
  const expression = CronExpressionParser.parse(options.expression, {
    currentDate: new Date(naiveAfter),
    tz: 'UTC',
  });

  const results: ScheduleOccurrence[] = [];
  const seenLocalKeys = new Set<string>();
  for (let i = 0; i < 1000 && results.length < count; i += 1) {
    let naive: Date;
    try {
      naive = expression.next().toDate();
    } catch {
      break;
    }
    const instant = resolveLocalTimeToInstant(naive.getTime(), options.timezone);
    if (instant.getTime() <= options.after.getTime()) continue;
    const localKey = localWallClockKey(instant, options.timezone);
    if (seenLocalKeys.has(localKey)) continue;
    seenLocalKeys.add(localKey);
    results.push({ scheduledFor: instant, localKey });
  }
  return results;
}

export interface CatchUpDecision {
  /** Whether a catch-up run should be created. */
  shouldCatchUp: boolean;
  /** The occurrence that should be caught up. */
  occurrence?: ScheduleOccurrence;
  reason: string;
}

/**
 * Decides whether a missed occurrence should be caught up after downtime.
 *
 * Only the latest missed occurrence is caught up, and only when it is younger
 * than the catch-up window (24 hours by default).
 */
export function decideCatchUp(options: {
  expression: string;
  timezone: string;
  /** The last occurrence that was already executed. */
  lastOccurrenceAt?: Date | null;
  now: Date;
  catchUpEnabled: boolean;
  catchUpWindowMs: number;
}): CatchUpDecision {
  if (!options.catchUpEnabled) {
    return { shouldCatchUp: false, reason: 'catch-up is disabled for this schedule' };
  }

  const after = options.lastOccurrenceAt ?? new Date(options.now.getTime() - options.catchUpWindowMs);

  // Only the latest missed occurrence is caught up, so every occurrence
  // between the last one and now is evaluated and the newest is selected.
  const candidates = nextOccurrences({
    expression: options.expression,
    timezone: options.timezone,
    after,
    count: 100,
  }).filter((occurrence) => occurrence.scheduledFor < options.now);

  const latestMissed = candidates[candidates.length - 1];
  if (!latestMissed) {
    return { shouldCatchUp: false, reason: 'no missed occurrence found' };
  }

  const age = options.now.getTime() - latestMissed.scheduledFor.getTime();
  if (age > options.catchUpWindowMs) {
    return {
      shouldCatchUp: false,
      reason: `latest missed occurrence is ${Math.round(age / 3_600_000)}h old, beyond the ${Math.round(options.catchUpWindowMs / 3_600_000)}h catch-up window`,
    };
  }

  return { shouldCatchUp: true, occurrence: latestMissed, reason: 'catching up the latest missed occurrence' };
}
