export type ScheduleSpec =
  | { type: 'once'; at: string }
  | { type: 'interval'; every_seconds: number; starts_at?: string }
  | { type: 'cron'; expression: string };

export interface ScheduleRun {
  id: number;
  status: string;
  trigger?: string;
  scheduled_for?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
}

export interface Schedule {
  id: number;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  timezone: string;
  delivery: 'chat';
  state: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run: ScheduleRun | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  timezone: string;
}

export const INTERVAL_UNITS = { minutes: 60, hours: 3_600, days: 86_400 } as const;
export type IntervalUnit = keyof typeof INTERVAL_UNITS;
/** Platform rejects recurring schedules more frequent than five minutes. */
export const MIN_INTERVAL_SECONDS = 300;

/** Largest unit that expresses `seconds` exactly, so an edited interval reads as it was entered. */
export function splitInterval(seconds: number): { amount: number; unit: IntervalUnit } {
  if (seconds % INTERVAL_UNITS.days === 0) return { amount: seconds / INTERVAL_UNITS.days, unit: 'days' };
  if (seconds % INTERVAL_UNITS.hours === 0) return { amount: seconds / INTERVAL_UNITS.hours, unit: 'hours' };
  return { amount: Math.max(1, Math.round(seconds / INTERVAL_UNITS.minutes)), unit: 'minutes' };
}

export function isRunLive(run: ScheduleRun | null | undefined): boolean {
  return run?.status === 'queued' || run?.status === 'running';
}

export function formatDate(value: string | null | undefined, locale: string, timeZone: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
}

/** Wall-clock fields of `date` as seen in `timeZone`, read back as if they were UTC. */
function wallClockAsUtc(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** `YYYY-MM-DDTHH:mm` entered as wall-clock time in `timeZone` → UTC ISO timestamp ('' when malformed). */
export function zonedInputToIso(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return '';
  const [, year, month, day, hour, minute] = match.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the zone offset, including across a DST change.
  let utc = wall - (wallClockAsUtc(new Date(wall), timeZone) - wall);
  utc = wall - (wallClockAsUtc(new Date(utc), timeZone) - utc);
  return new Date(utc).toISOString();
}

/** UTC ISO timestamp → `YYYY-MM-DDTHH:mm` wall-clock time in `timeZone`, for a datetime-local input. */
export function isoToZonedInput(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(wallClockAsUtc(date, timeZone)).toISOString().slice(0, 16);
}
