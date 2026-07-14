/**
 * Pure time math for the sleep cycle. Minute resolution, IANA-timezone aware.
 * Mirrors the Intl.DateTimeFormat approach openclaw itself uses in
 * heartbeat-active-hours.ts — no date libraries, no Date.parse of local
 * strings, DST handled by Intl.
 */

const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse "HH:MM" (24h) to minutes since midnight, or null when invalid. */
export function parseHHMM(raw: string | undefined): number | null {
  if (!raw || !HHMM_PATTERN.test(raw)) {
    return null;
  }
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes since local midnight in `timeZone` at `nowMs`, or null on bad tz. */
export function minutesInTimeZone(nowMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

/** Local calendar date key (YYYY-MM-DD) in `timeZone` — the once-per-day guard. */
export function dateKeyInTimeZone(nowMs: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(nowMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/**
 * Has local time-of-day in `timeZone` passed `hhmm` today?
 * Minute resolution; returns false on unparseable input (fail-open to "not yet").
 */
export function isAtOrPast(hhmm: string, timeZone: string, nowMs: number): boolean {
  const target = parseHHMM(hhmm);
  const current = minutesInTimeZone(nowMs, timeZone);
  if (target === null || current === null) {
    return false;
  }
  return current >= target;
}

/**
 * Is local time inside the [startHHMM, endHHMM) window? Supports windows that
 * cross midnight (start > end), same convention as openclaw activeHours.
 */
export function isWithinWindow(
  startHHMM: string,
  endHHMM: string,
  timeZone: string,
  nowMs: number,
): boolean {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  const current = minutesInTimeZone(nowMs, timeZone);
  if (start === null || end === null || current === null || start === end) {
    return false;
  }
  if (end > start) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}
