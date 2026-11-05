/* ============================================================
   KANBO — the date maths of a repeating task, one copy.
   The app (src/data/data.ts) and the REST API and MCP server (api/handlers.ts)
   both use it, so a series moves the same way whoever completes it.

   Advance a due date by one recurrence step (from the due date, or today).
   Monthly keeps to its day of the month and clamps to the last day of shorter
   months (31 Jan → 28/29 Feb, 31 Aug → 30 Sep) instead of overflowing into the
   next month. Pass `anchorDay` — the day the series was set up on — so a series
   that was clamped finds its way back (28 Feb → 31 Mar); without it (or if it
   isn't a number, e.g. derived from a bad date) the anchor is the base date's
   own day.

   All in the runtime's local time. `today` is a local-midnight Date for the
   person's own day. Pure: no Deno globals.
   ============================================================ */
import { toLocalISO, type NlpRecurrence } from "./nlp.ts";

const DAY_MS = 86400000;
const daysInMonth = (y: number, m: number): number => new Date(y, m + 1, 0).getDate();

/** Local midnight of a "YYYY-MM-DD" (tolerates a trailing time part); null if unparseable. */
export function parseLocalDay(iso: string): Date | null {
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from one local date to another (DST-safe: rounds the 23/25h days). */
export function daysBetweenISO(from: string, to: string): number {
  const a = parseLocalDay(from), b = parseLocalDay(to);
  return a && b ? Math.round((b.getTime() - a.getTime()) / DAY_MS) : 0;
}

export function shiftISO(iso: string, days: number): string {
  const d = parseLocalDay(iso);
  if (!d || !days) return iso;
  d.setDate(d.getDate() + days);
  return toLocalISO(d);
}

export function nextDueDateFrom(iso: string | undefined | null, recurrence: NlpRecurrence, today: Date, anchorDay?: number): string {
  const base = (iso && parseLocalDay(iso)) || new Date(today);
  const d = new Date(base);
  const a = anchorDay != null && Number.isFinite(anchorDay) ? anchorDay : base.getDate();
  const anchor = Math.min(31, Math.max(1, Math.round(a)));
  const step = () => {
    if (recurrence === "daily") d.setDate(d.getDate() + 1);
    else if (recurrence === "weekdays") { do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); }
    else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
    else if (recurrence === "biweekly") d.setDate(d.getDate() + 14);
    else if (recurrence === "monthly") {
      // go via the 1st so setMonth can't overflow (31 Jan + 1 month = 3 Mar)
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      d.setDate(Math.min(anchor, daysInMonth(d.getFullYear(), d.getMonth())));
    }
  };
  if (recurrence === "none") return toLocalISO(d);
  step();
  // if the computed next date is in the past, roll forward to the future
  // (bounded, so a decades-old daily date can't spin the tab)
  const todayMid = new Date(today);
  for (let i = 0; d < todayMid && i < 20000; i++) step();
  return toLocalISO(d);
}

/* The day of the month a monthly series belongs on, for `anchorDay`. It's the
   due date's own day, unless that date sits on the last day of a short month
   (so it may have been clamped: 31 Jan → 28 Feb) and `originalDueDate`
   remembers a later day, which then wins (→ 31 Mar). A due date the user moved
   to mid-month is never clamped, so the series follows it. */
export function seriesAnchorDay(t: { dueDate?: string | null; originalDueDate?: string | null }): number | undefined {
  const due = t.dueDate ? parseLocalDay(t.dueDate) : null;
  if (!due) return undefined;
  const day = due.getDate();
  const orig = t.originalDueDate ? parseLocalDay(t.originalDueDate) : null;
  const atMonthEnd = day === daysInMonth(due.getFullYear(), due.getMonth());
  return orig && atMonthEnd && orig.getDate() > day ? orig.getDate() : day;
}

export interface OccurrenceDates {
  dueDate: string;
  startDate: string | null;
  /** a monthly series keeps its day here */
  originalDueDate: string | null;
  /** how far the due date moved: sub-tasks' dates move by the same */
  shiftDays: number;
}

/** The dates of a series' next occurrence. A start date moves with the due date, so a Timeline bar keeps its length. */
export function nextOccurrenceDates(
  t: { recurrence: NlpRecurrence; dueDate?: string | null; startDate?: string | null; originalDueDate?: string | null },
  today: Date,
): OccurrenceDates {
  const anchor = seriesAnchorDay(t);
  const dueDate = nextDueDateFrom(t.dueDate, t.recurrence, today, anchor);
  const shiftDays = daysBetweenISO(t.dueDate ?? toLocalISO(today), dueDate);
  const dayOf = (iso?: string | null) => (iso ? parseLocalDay(iso)?.getDate() : undefined);
  const seriesDate = t.originalDueDate && dayOf(t.originalDueDate) === anchor ? t.originalDueDate : (t.dueDate ?? null);
  return {
    dueDate,
    startDate: t.startDate ? shiftISO(t.startDate, shiftDays) : null,
    originalDueDate: t.recurrence === "monthly" ? seriesDate : null,
    shiftDays,
  };
}
