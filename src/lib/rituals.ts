/* ============================================================
   KANBO — rituals: the week's Big 3, the end-of-day shut down,
   today's leftovers and "Your day in colour".
   Personal, per device: nothing here is shared or synced.
   ============================================================ */
import { todayISO, toLocalISO, fmtDurMin, KANBO_TODAY } from "../data/data";
import type { Task, Project } from "../data/types";

const BIG3_KEY = "kanbo-big3";
const SHUTDOWN_KEY = "kanbo-shutdown";

/** The ISO 8601 week a day falls in, e.g. "2026-W40" (weeks start on Monday;
 *  week 1 is the one holding the year's first Thursday). */
export function isoWeek(d: Date = KANBO_TODAY): string {
  const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = day.getUTCDay() || 7;                 // Mon 1 … Sun 7
  day.setUTCDate(day.getUTCDate() + 4 - dow);       // that week's Thursday decides the year
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** This week's (or `week`'s) Big 3 task ids, in order. [] when none are set. */
export function readBig3(userId: string, week: string = isoWeek()): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(`${BIG3_KEY}:${userId}:${week}`) || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 3) : [];
  } catch { return []; }
}

/** Save the week's Big 3 (at most three; duplicates dropped). An empty list clears it. */
export function writeBig3(userId: string, ids: string[], week: string = isoWeek()): void {
  const key = `${BIG3_KEY}:${userId}:${week}`;
  const keep = [...new Set(ids)].slice(0, 3);
  try {
    if (keep.length) localStorage.setItem(key, JSON.stringify(keep));
    else localStorage.removeItem(key);
  } catch { /* private mode */ }
}

/** Has this person shut down their day (default: today)? */
export function shutdownDone(userId: string, day: string = todayISO()): boolean {
  try { return localStorage.getItem(`${SHUTDOWN_KEY}:${userId}:${day}`) === "1"; } catch { return false; }
}

/** Record that the day was shut down (the last step of the Shut down sheet). */
export function markShutdownDone(userId: string, day: string = todayISO()): void {
  try { localStorage.setItem(`${SHUTDOWN_KEY}:${userId}:${day}`, "1"); } catch { /* private mode */ }
}

/** What's left of today: open tasks that were due today, or planned or
 *  scheduled for today. Archived tasks are left out. */
export function leftovers(tasks: Task[], today: string = todayISO()): Task[] {
  return tasks.filter((t) => t.status !== "done" && !t.archivedAt
    && (t.dueDate === today || !!t.planToday || t.scheduled != null));
}

export interface DaySegment {
  /** a project id, or "focus" for focus-timer minutes */
  key: string;
  label: string;
  minutes: number;
  /** the project's colour; absent for focus (drawn with the brand gradient) */
  color?: string;
}

/** "Your day in colour": the minutes behind today's finished tasks, split by
 *  project (each task counts its duration, else its focus estimate), largest
 *  first, with focus-timer minutes as a last "Focus" segment. Pass the tasks
 *  finished today. */
export function dayInColour(tasks: Task[], projects: Pick<Project, "id" | "name" | "color">[], focusMinutes = 0): { segments: DaySegment[]; total: number } {
  const byProject = new Map<string, number>();
  for (const t of tasks) {
    const min = t.dur || t.focusMin || 0;
    if (min > 0) byProject.set(t.projectId, (byProject.get(t.projectId) ?? 0) + min);
  }
  const segments: DaySegment[] = [...byProject].map(([id, minutes]) => {
    const p = projects.find((x) => x.id === id);
    return { key: id, label: p?.name ?? "Other", minutes, color: p?.color };
  }).sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));
  if (focusMinutes > 0) segments.push({ key: "focus", label: "Focus", minutes: Math.round(focusMinutes) });
  return { segments, total: segments.reduce((n, s) => n + s.minutes, 0) };
}

/* ---------- the Shut down sheet's arithmetic ---------- */

const localDay = (iso: string): Date => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };

/** "YYYY-MM-DD" n days after `iso` (local calendar days, so DST never skips one). */
export function addDaysISO(iso: string, n: number): string {
  const d = localDay(iso);
  d.setDate(d.getDate() + n);
  return toLocalISO(d);
}

/** The Monday after `iso` (a Monday gives the one a week later). */
export function nextMondayISO(iso: string = todayISO()): string {
  const dow = localDay(iso).getDay();              // Sun 0 … Sat 6
  return addDaysISO(iso, ((8 - dow) % 7) || 7);
}

/** Where "Next week" lands from `iso`: the coming Monday, or the one after it
 *  when the coming Monday is tomorrow (on a Sunday), so it never repeats "Tomorrow". */
export function nextWeekISO(iso: string = todayISO()): string {
  const monday = nextMondayISO(iso);
  return monday === addDaysISO(iso, 1) ? addDaysISO(monday, 7) : monday;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 1" — a chip's short day. */
export function shortDay(iso: string): string {
  const d = localDay(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}`;
}

/** "Wed 30 Sep" (en-GB, the same in every browser). */
export function dayLabel(iso: string): string {
  const d = localDay(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Tasks finished today (by their completion time, in local time). */
export function finishedToday(tasks: Task[], today: string = todayISO()): Task[] {
  return tasks.filter((t) => {
    if (t.status !== "done" || !t.completedAt || t.archivedAt) return false;
    const at = new Date(t.completedAt);
    return !Number.isNaN(at.getTime()) && toLocalISO(at) === today;
  });
}

/** Where a leftover goes from the Shut down sheet. */
export type LeftoverMove = "tomorrow" | "nextweek" | "someday" | "drop";

const OFF_TODAY = { planToday: false, scheduled: null } as const;

/** Re-date a task to `target` and take it off today's plan. A due date only
 *  ever moves later: when `current` is already after `target`, the date is
 *  left out of the patch and only the plan changes. */
export function redatePatch(target: string, current?: string): Partial<Task> {
  return current && current > target ? { ...OFF_TODAY } : { dueDate: target, ...OFF_TODAY };
}

/** The patch for one leftover move. Every move takes the task off today's plan;
 *  "drop" keeps its due date, "someday" clears it. Pass the task's `current`
 *  due date and Tomorrow / Next week never pull it earlier. */
export function movePatch(move: LeftoverMove, today: string = todayISO(), current?: string): Partial<Task> {
  switch (move) {
    case "tomorrow": return redatePatch(addDaysISO(today, 1), current);
    case "nextweek": return redatePatch(nextWeekISO(today), current);
    case "someday": return { dueDate: undefined, ...OFF_TODAY };
    case "drop": return { ...OFF_TODAY };
  }
}

/** Where one leftover can go, and where "Move all to tomorrow" sends it.
 *  Shut down is personal, so it never changes a date that is someone else's
 *  or pulls a deadline forward:
 *  · your own task: Tomorrow and Next week while they're no earlier than its
 *    due date, Someday, and Drop from today when it's planned but not due today;
 *  · a teammate's task (you collaborate on it): only Drop from today, which
 *    clears your own plan. Due today, it's theirs to move: no choices.
 *  `all` is Tomorrow where offered, else Drop, else nothing. */
export function leftoverChoices(
  t: Pick<Task, "assigneeId" | "dueDate" | "planToday" | "scheduled">, me: string, today: string = todayISO(),
): { moves: LeftoverMove[]; all: LeftoverMove | null; mine: boolean } {
  const mine = !!me && t.assigneeId === me;
  // a task due today stays on today whatever its plan, so Drop wouldn't take it off
  const canDrop = (!!t.planToday || t.scheduled != null) && t.dueDate !== today;
  const moves: LeftoverMove[] = [];
  if (mine) {
    if (!t.dueDate || t.dueDate <= addDaysISO(today, 1)) moves.push("tomorrow");
    if (!t.dueDate || t.dueDate <= nextWeekISO(today)) moves.push("nextweek");
    moves.push("someday");
  }
  if (canDrop) moves.push("drop");
  const all = moves.includes("tomorrow") ? "tomorrow" : moves.includes("drop") ? "drop" : null;
  return { moves, all, mine };
}

/** The fields a move changes, as they were: what an Undo puts back. */
export function beforeMove(t: Task): Pick<Task, "dueDate" | "planToday" | "scheduled"> {
  return { dueDate: t.dueDate, planToday: !!t.planToday, scheduled: t.scheduled ?? null };
}

/** "Done for today. 5 finished, 2 moved to tomorrow, 1 taken off your plan." */
export function closingLine(finished: number, moves: LeftoverMove[]): string {
  const count = (m: LeftoverMove) => moves.filter((x) => x === m).length;
  const parts: string[] = [];
  if (finished > 0) parts.push(`${finished} finished`);
  const dated = ([["tomorrow", "to tomorrow"], ["nextweek", "to next week"], ["someday", "to someday"]] as const)
    .filter(([m]) => count(m) > 0);
  dated.forEach(([m, where], i) => parts.push(`${count(m)}${i === 0 ? " moved" : ""} ${where}`));
  if (count("drop")) parts.push(`${count("drop")} taken off your plan`);
  return parts.length ? `Done for today. ${parts.join(", ")}.` : "Done for today.";
}

/** Minutes as the sheet shows them: "45m", "1h 30m". */
export const fmtMinutes = (m: number): string => fmtDurMin(Math.max(0, Math.round(m)));

/** The plain-text day summary behind "Copy summary". Personal: nothing is sent anywhere. */
export function shutdownSummary(p: { day: string; finished: Pick<Task, "title">[]; segments: DaySegment[]; moved?: number }): string {
  const lines = [`Shut down · ${dayLabel(p.day)}`];
  if (p.finished.length) {
    lines.push("", `Finished today (${p.finished.length})`, ...p.finished.map((t) => `• ${t.title}`));
  } else {
    lines.push("", "Nothing marked done today.");
  }
  if (p.segments.length) lines.push("", `Time: ${p.segments.map((s) => `${s.label} ${fmtMinutes(s.minutes)}`).join(" · ")}`);
  if (p.moved) lines.push("", `Moved on: ${p.moved}`);
  return lines.join("\n");
}

/* ---------- the Weekly review ---------- */

/** Monday of the week `iso` falls in. */
export function weekStartISO(iso: string = todayISO()): string {
  const dow = localDay(iso).getDay();
  return addDaysISO(iso, -((dow + 6) % 7));
}

/** The week a review looks back on (Monday `start` to Sunday `end`) and the
 *  Monday of the week it plans. Done on a Monday morning it reviews the week
 *  just finished and plans this one; any other day it reviews this week and
 *  plans the next. So Friday afternoon and the Monday after agree. */
export function reviewWeek(today: string = todayISO()): { start: string; end: string; plan: string } {
  const monday = weekStartISO(today);
  const start = monday === today ? addDaysISO(today, -7) : monday;
  return { start, end: addDaysISO(start, 6), plan: addDaysISO(start, 7) };
}

/** Tasks finished from `from` (default: this Monday) to today, newest first. */
export function finishedThisWeek(tasks: Task[], today: string = todayISO(), from: string = weekStartISO(today)): Task[] {
  return tasks.filter((t) => {
    if (t.status !== "done" || !t.completedAt || t.archivedAt) return false;
    const at = new Date(t.completedAt);
    if (Number.isNaN(at.getTime())) return false;
    const day = toLocalISO(at);
    return day >= from && day <= today;
  }).sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
}

/** What the week leaves behind: open tasks due by its `end` (default: this
 *  Sunday) or earlier, soonest first. With `me`, only the tasks assigned to
 *  you: a teammate's due date is theirs to move. */
export function carriedOver(tasks: Task[], today: string = todayISO(), opts: { end?: string; me?: string } = {}): Task[] {
  const end = opts.end ?? addDaysISO(weekStartISO(today), 6);
  return tasks.filter((t) => t.status !== "done" && !t.archivedAt && !!t.dueDate && t.dueDate <= end
    && (opts.me === undefined || t.assigneeId === opts.me))
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.title.localeCompare(b.title));
}
