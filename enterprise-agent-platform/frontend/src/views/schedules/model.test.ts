import { describe, expect, it } from 'vitest';
import { isoToZonedInput, splitInterval, zonedInputToIso } from './model';

describe('schedule wall-clock conversion', () => {
  it('reads a datetime-local value in the schedule time zone, not the browser zone', () => {
    expect(zonedInputToIso('2026-10-05T09:00', 'Asia/Shanghai')).toBe('2026-10-05T01:00:00.000Z');
    expect(zonedInputToIso('2026-06-15T12:00', 'Asia/Kolkata')).toBe('2026-06-15T06:30:00.000Z');
  });

  it('uses the offset in force on that date across daylight-saving changes', () => {
    expect(zonedInputToIso('2026-03-29T01:30', 'Europe/Berlin')).toBe('2026-03-29T00:30:00.000Z');
    expect(zonedInputToIso('2026-03-29T03:30', 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z');
    expect(zonedInputToIso('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('round-trips a saved instant back to the same wall-clock input', () => {
    const iso = zonedInputToIso('2026-12-31T23:59', 'America/Los_Angeles');
    expect(isoToZonedInput(iso, 'America/Los_Angeles')).toBe('2026-12-31T23:59');
  });

  it('rejects incomplete input instead of guessing a time', () => {
    expect(zonedInputToIso('2026-12-31', 'UTC')).toBe('');
  });
});

describe('splitInterval', () => {
  it('shows an interval in the largest unit that divides it exactly', () => {
    expect(splitInterval(172_800)).toEqual({ amount: 2, unit: 'days' });
    expect(splitInterval(7_200)).toEqual({ amount: 2, unit: 'hours' });
    expect(splitInterval(5_400)).toEqual({ amount: 90, unit: 'minutes' });
  });
});
