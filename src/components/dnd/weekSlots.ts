/* ============================================================
   KANBO — drag to plan: My week's maths (pure, unit-tested).
   A day column takes a task for that day ("week-day"); its time
   strip takes it at a time ("week-slot": a due time, the time it
   happens). "No date" takes the date off. MyWeekView only.
   ============================================================ */
import type { Task } from "../../data/types";

/** The time strip runs over the working day and the evening around it. */
export const WEEK_SLOT_FROM = 7 * 60;
export const WEEK_SLOT_TO = 21 * 60;
export const WEEK_SLOT_STEP = 15;

/** The minute at `y` (0 at the strip's top, 1 at its bottom), on the quarter hour. */
export function stripMinute(y: number, from = WEEK_SLOT_FROM, to = WEEK_SLOT_TO, step = WEEK_SLOT_STEP): number {
  const f = Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 0;
  const m = Math.round((from + f * (to - from)) / step) * step;
  return Math.min(to - step, Math.max(from, m));
}

/** Where a minute sits on the strip (0–1). */
export const stripY = (min: number, from = WEEK_SLOT_FROM, to = WEEK_SLOT_TO): number =>
  Math.min(1, Math.max(0, (min - from) / (to - from)));

/** "09:30" */
export const hhmm = (min: number): string =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** "09:30" → 570; anything else → null */
export function minuteOf(time?: string | null): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  if (!m) return null;
  const v = +m[1] * 60 + +m[2];
  return v >= 0 && v < 1440 ? v : null;
}

/**
 * The patch for a task dropped in My week, or null when nothing would change.
 *   date: the day ("YYYY-MM-DD"), or null for "No date" (its time goes too)
 *   minute: a time on that day; null takes the time off ("Any time");
 *           undefined keeps whatever time it had (a plain move to another day)
 */
export function weekPatch(t: Pick<Task, "dueDate" | "dueTime">, date: string | null, minute?: number | null): Partial<Task> | null {
  const p: Partial<Task> = {};
  const curDate = t.dueDate ? t.dueDate.slice(0, 10) : undefined;
  if (date === null) {
    if (curDate) p.dueDate = undefined;
    if (t.dueTime) p.dueTime = undefined;
    return Object.keys(p).length ? p : null;
  }
  if (curDate !== date) p.dueDate = date;
  if (minute !== undefined) {
    const time = minute === null ? undefined : hhmm(minute);
    if ((t.dueTime || undefined) !== time) p.dueTime = time;
  }
  return Object.keys(p).length ? p : null;
}

/** What Undo puts back for a patch: the fields it changed, as they were. */
export function undoPatch(t: Pick<Task, "dueDate" | "dueTime">, patch: Partial<Task>): Partial<Task> {
  const back: Partial<Task> = {};
  if ("dueDate" in patch) back.dueDate = t.dueDate;
  if ("dueTime" in patch) back.dueTime = t.dueTime;
  return back;
}

/** "Fri 9 Oct, 10:30" / "Today, 10:30" / "Fri 9 Oct" */
export function slotLabel(dayLabel: string, minute: number | null | undefined): string {
  return minute == null ? dayLabel : `${dayLabel}, ${hhmm(minute)}`;
}
