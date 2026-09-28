import { usageError } from "./output.js";

const ISO_WEEK = /^(\d{4})-W(\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_MS = 7 * 86_400_000;

/** The Monday of ISO week 1: the week holding January 4th. */
function mondayOfWeekOne(year: number): number {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  return Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7));
}

/**
 * `--week` as `list_publish_runs` takes it: any day of the week. A day passes
 * through; an ISO week such as `2026-W40` becomes its Monday.
 */
export function isoWeekMonday(value: string): string {
  if (DAY.test(value)) return value;
  const match = ISO_WEEK.exec(value);
  if (!match) throw usageError(`--week must be a day (YYYY-MM-DD) or an ISO week (YYYY-Www), not "${value}".`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  const start = mondayOfWeekOne(year);
  const weeksInYear = Math.round((mondayOfWeekOne(year + 1) - start) / WEEK_MS);
  if (week < 1 || week > weeksInYear) throw usageError(`${year} has weeks W01 to W${weeksInYear}, not W${match[2]}.`);
  return new Date(start + (week - 1) * WEEK_MS).toISOString().slice(0, 10);
}
