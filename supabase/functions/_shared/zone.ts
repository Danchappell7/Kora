// ============================================================
// KANBO — what day it is for someone, from a time zone name. Pure.
// ============================================================
export const DEFAULT_TIMEZONE = "Europe/London";

/** Is this a time zone the runtime knows? */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}

/** The calendar day it is in a time zone, as YYYY-MM-DD. */
export function dateInZone(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A local-midnight Date for that day (what the grammar and the date maths count from). */
export function localMidnight(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
