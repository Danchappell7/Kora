/* ============================================================
   KANBO — day and week maths shared by the shell (Radar's risks, the
   Today brief) and the reporting views: local days, Monday weeks,
   working days, and how much of a task's estimate lands in a week.
   Its own module so the shell needn't load the reporting helpers
   (components/views/reportingUtils re-exports all of it).
   ============================================================ */
import type { Task } from "../data/types";

export const DAY_MS = 86400000;
export const round1 = (n: number): number => Math.round(n * 10) / 10;

/* ---------------- dates ---------------- */

/** Local calendar day (00:00) for a date-only ISO ("2026-09-30") or a timestamp.
 *  Timestamps are converted to the viewer's own day, so work finished at 00:30
 *  BST on a Monday lands on Monday, not the previous (UTC) Sunday. */
export function localDay(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, dd] = iso.split("-").map(Number);
    d = new Date(y, m - 1, dd);
  } else {
    const t = new Date(iso);
    if (isNaN(t.getTime())) return null;
    d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }
  return isNaN(d.getTime()) ? null : d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14 Sep" — compact day + month that never wraps in chart axes (en-GB would give "Sept"). */
export const fmtDayMonth = (d: Date): string => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

export function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** Monday 00:00 of the week containing `d` (UK convention: weeks start on Monday). */
export function startOfWeekMon(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

const calendarDays = (a: Date, b: Date): number => (b < a ? 0 : Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1);
/** Mon–Fri days between a and b inclusive (arithmetic, so a year-long task costs nothing). */
export function workdays(a: Date, b: Date): number {
  const days = calendarDays(a, b);
  if (!days) return 0;
  const full = Math.floor(days / 7);
  let n = full * 5;
  for (let i = 0, dow = a.getDay(); i < days % 7; i++) { const x = (dow + i) % 7; if (x !== 0 && x !== 6) n++; }
  return n;
}

/* ---------------- Workload ---------------- */

export interface TaskWeekLoad { hours: number; overdue: boolean }

/** How much of an open task's estimate lands in the week starting `weekStart`.
 *  - due date only → the whole estimate lands in the week it's due
 *  - start → due  → the estimate is spread evenly over the working days of the span
 *  - start date only → the whole estimate lands in the week it starts
 *  - late work that is still open is carried, in full, into the current week
 *  - work under way with no due date (started before this week) counts this
 *    week's share of the estimate, spread from its start to the end of this week
 *  - no dates at all → null (unscheduled; not counted against capacity) */
export function taskLoadInWeek(t: Task, weekStart: Date, today: Date): TaskWeekLoad | null {
  const due = localDay(t.dueDate), start = localDay(t.startDate);
  if (!due && !start) return null;
  const weekEnd = addDays(weekStart, 7);
  const lastDay = addDays(weekEnd, -1);
  const effort = Math.max(0, t.effortHours ?? 0);
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const overdue = !!due && due < todayMid;
  const isCurrent = todayMid >= weekStart && todayMid < weekEnd;
  const last = due ?? start!;
  // everything still open on a late task is due now, however long its span was
  if (overdue) return isCurrent ? { hours: effort, overdue } : null;
  // work already under way with no due date isn't late — it has no deadline.
  // Count this week's share of the estimate spread from its start to the end of
  // this week, not the whole estimate again every week it stays open.
  if (!due && start! < weekStart) {
    if (!isCurrent) return null;
    const span = workdays(start!, lastDay);
    return { hours: span > 0 ? effort * (workdays(weekStart, lastDay) / span) : effort, overdue: false };
  }
  if (last < weekStart) return isCurrent ? { hours: effort, overdue } : null;
  const first = start && due && start <= due ? start : last;
  if (first > lastDay) return null;
  if (first.getTime() === last.getTime()) return { hours: effort, overdue };
  const oa = first > weekStart ? first : weekStart;
  const ob = last < lastDay ? last : lastDay;
  const spanWork = workdays(first, last);
  const share = spanWork > 0 ? workdays(oa, ob) / spanWork : calendarDays(oa, ob) / calendarDays(first, last);
  if (share <= 0) return null;
  return { hours: effort * share, overdue };
}
