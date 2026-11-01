import { config } from "../config/site.js";

/**
 * Date keys are always site-local calendar days (`YYYY-MM-DD`), because "can I book Saturday"
 * means Saturday where the launch site is, not where the server runs.
 */

const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.SITE_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: config.SITE_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: config.SITE_TIMEZONE,
  hour: "2-digit",
  hour12: false,
});

export const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value: string): boolean {
  if (!DATE_KEY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime());
}

/** Site-local calendar date for an instant. */
export function localDateKey(date: Date): string {
  return dateKeyFormatter.format(date);
}

/** "HH:MM" in site-local time. */
export function localTimeLabel(date: Date): string {
  return timeFormatter.format(date);
}

/** Site-local hour (0-23) for slot planning. */
export function localHour(date: Date): number {
  return Number(hourFormatter.format(date));
}

/** Weekday for a date key, 0 = Sunday … 6 = Saturday. */
export function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

export function addDaysToKey(dateKey: string, days: number): string {
  const anchor = new Date(`${dateKey}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/** Inclusive list of date keys starting at `start`, `count` days long. */
export function dateKeyRange(start: string, count: number): string[] {
  const keys: string[] = [];
  for (let index = 0; index < count; index += 1) keys.push(addDaysToKey(start, index));
  return keys;
}

/** Offset of a timezone at a given instant, in milliseconds (positive east of UTC). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const hour = values.get("hour") === "24" ? "00" : (values.get("hour") ?? "00");
  const asUtc = Date.UTC(
    Number(values.get("year")),
    Number(values.get("month")) - 1,
    Number(values.get("day")),
    Number(hour),
    Number(values.get("minute")),
    Number(values.get("second")),
  );
  return asUtc - instant.getTime();
}

/**
 * Converts a site-local wall clock time (`2026-11-01` + `09:30`) into the matching instant.
 * Done twice so a DST change between the naive guess and the real instant still resolves.
 */
export function zonedDateTimeToUtc(dateKey: string, time: string, timeZone: string): Date {
  const naive = new Date(`${dateKey}T${time}:00Z`);
  const firstGuess = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  const corrected = new Date(naive.getTime() - zoneOffsetMs(firstGuess, timeZone));
  return corrected;
}

