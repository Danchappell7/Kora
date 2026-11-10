/* ============================================================
   KANBO — a goal's period: a quarter, a half, a year or your own
   dates. "2027-Q1", "2027-H2", "2027-FY" (the calendar year) or
   "custom" with a start and an end. The named ones' dates are the
   same as the database's goal_period_bounds (0052).
   Pure: no React, no I/O.
   ============================================================ */

export interface PeriodRange { start: string; end: string }

const NAMED = /^(\d{4})-(Q[1-4]|H[12]|FY)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate();   // m is 1-12

/** Is this a period label Kanbo knows ("custom" included)? */
export const isPeriod = (p: string | null | undefined): boolean => !!p && (p === "custom" || NAMED.test(p));

/** A named period's first and last day; a custom one's own dates (when both are set, in order). */
export function periodRange(period: string | null | undefined, start?: string | null, end?: string | null): PeriodRange | null {
  if (!period) return null;
  if (period === "custom") return start && end && start <= end ? { start, end } : null;
  const m = NAMED.exec(period);
  if (!m) return null;
  const y = Number(m[1]), part = m[2];
  if (part === "FY") return { start: isoOf(y, 1, 1), end: isoOf(y, 12, 31) };
  const [first, months] = part[0] === "H" ? [part === "H1" ? 1 : 7, 6] : [(Number(part[1]) - 1) * 3 + 1, 3];
  const lastMonth = first + months - 1;
  return { start: isoOf(y, first, 1), end: isoOf(y, lastMonth, lastDay(y, lastMonth)) };
}

const shortDate = (iso: string, withYear: boolean) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
};

/** "Q1 2027", "H2 2027", "2027", or "1 Feb – 15 May 2027" for your own dates. */
export function periodLabel(period: string | null | undefined, start?: string | null, end?: string | null): string {
  if (!period) return "";
  const m = NAMED.exec(period);
  if (m) return m[2] === "FY" ? m[1] : `${m[2]} ${m[1]}`;
  const r = periodRange(period, start, end);
  if (!r) return "Your own dates";
  const sameYear = r.start.slice(0, 4) === r.end.slice(0, 4);
  return `${shortDate(r.start, !sameYear)} – ${shortDate(r.end, true)}`;
}

/** The quarter a date falls in: "2026-Q4". */
export function quarterOf(d: Date): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

/** The periods to offer, from today: this quarter and the next three, this half and the
 *  next, this year and the next. (A goal's own period is added by the picker if it's
 *  not among them.) */
export function periodChoices(today: Date): { value: string; label: string; group: "Quarter" | "Half" | "Year" }[] {
  const y = today.getFullYear(), q = Math.floor(today.getMonth() / 3), h = today.getMonth() < 6 ? 0 : 1;
  const out: { value: string; label: string; group: "Quarter" | "Half" | "Year" }[] = [];
  for (let i = 0; i < 4; i++) {
    const qq = (q + i) % 4, yy = y + Math.floor((q + i) / 4);
    const value = `${yy}-Q${qq + 1}`;
    out.push({ value, label: periodLabel(value), group: "Quarter" });
  }
  for (let i = 0; i < 2; i++) {
    const hh = (h + i) % 2, yy = y + Math.floor((h + i) / 2);
    const value = `${yy}-H${hh + 1}`;
    out.push({ value, label: periodLabel(value), group: "Half" });
  }
  for (let i = 0; i < 2; i++) out.push({ value: `${y + i}-FY`, label: periodLabel(`${y + i}-FY`), group: "Year" });
  return out;
}
