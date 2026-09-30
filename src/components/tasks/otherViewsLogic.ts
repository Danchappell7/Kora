/* ============================================================
   KANBO — pure helpers behind the Board, Timeline, Calendar and
   Files views. No React here, so every rule can be unit-tested.
   Dates are local "YYYY-MM-DD" strings, parsed at local midnight
   (never via toISOString) so DST and UTC offsets can't shift a day.
   ============================================================ */
import { toLocalISO } from "../../data/data";
import type { Task } from "../../data/types";

const DAY_MS = 86400000;

/* ---------------- calendar maths ---------------- */
export function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toLocalISO(d);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetweenISO(from: string, to: string): number {
  const a = new Date(from + "T00:00:00").getTime();
  const b = new Date(to + "T00:00:00").getTime();
  return Math.round((b - a) / DAY_MS);
}

/** Monday (local midnight) of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

/**
 * Week to show when a month view switches to week view: this week for the
 * current month, otherwise the month's first week (the one holding the 4th,
 * i.e. the first week whose Thursday falls in that month).
 */
export function weekOffsetForMonth(today: Date, monthOffset: number): number {
  if (monthOffset === 0) return 0;
  const fourth = new Date(today.getFullYear(), today.getMonth() + monthOffset, 4);
  return Math.round((mondayOf(fourth).getTime() - mondayOf(today).getTime()) / (7 * DAY_MS));
}

/** Month for a week: today's month for this week, otherwise the month its Thursday falls in. */
export function monthOffsetForWeek(today: Date, weekOffset: number): number {
  if (weekOffset === 0) return 0;
  const thu = mondayOf(today);
  thu.setDate(thu.getDate() + weekOffset * 7 + 3);
  return (thu.getFullYear() - today.getFullYear()) * 12 + (thu.getMonth() - today.getMonth());
}

export type CalendarPeriod = { month: number; week: number };
/**
 * Switching month ↔ week. `from` is the period pair recorded at the last
 * switch: if the user hasn't moved since, they go straight back to where they
 * came from (so month → week → month never lands on a different month);
 * otherwise the new view shows the same stretch of time. The result is the
 * pair to record for the next switch.
 */
export function switchCalendarPeriod(today: Date, to: "month" | "week", cur: CalendarPeriod, from: CalendarPeriod | null): CalendarPeriod {
  if (to === "week") return { month: cur.month, week: from && from.month === cur.month ? from.week : weekOffsetForMonth(today, cur.month) };
  return { week: cur.week, month: from && from.week === cur.week ? from.month : monthOffsetForWeek(today, cur.week) };
}

/* ---------------- sub-tasks ---------------- */
/**
 * Sub-tasks nest under their parent, so a view hides one only when its parent
 * is also present. A sub-task whose parent isn't in view (e.g. an assigned
 * sub-task in My tasks) stays visible — the same rule ListView uses.
 */
export function hideNestedSubtasks<T extends Pick<Task, "id" | "parentId">>(tasks: T[], present?: ReadonlySet<string>): T[] {
  const ids = present ?? new Set(tasks.map((t) => t.id));
  return tasks.filter((t) => !t.parentId || !ids.has(t.parentId));
}

/* ---------------- board columns ---------------- */
export const UNASSIGNED_COL = "__unassigned";
export const FORMER_COL = "__former";
export const NO_PROJECT_COL = "__noproject";

/** Assignee column for a task: a member's own column, Unassigned, or Former members. */
export function assigneeColumnKey(assigneeId: string | undefined | null, memberIds: ReadonlySet<string>): string {
  if (!assigneeId || assigneeId === "—") return UNASSIGNED_COL;
  return memberIds.has(assigneeId) ? assigneeId : FORMER_COL;
}

/* ---------------- manual ordering ---------------- */
type Positioned = { id: string; position?: number | null };

/** Fractional index between two neighbours (either may be absent → ends of the list). */
export function between(before?: number | null, after?: number | null): number {
  if (before == null && after == null) return Date.now();
  if (before == null) return (after as number) - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

/** The position every view sorts by — a missing one counts as 0 (store.ts reads NULL as 0 too). */
const sortPos = (t: Positioned): number => (t.position != null && Number.isFinite(t.position) ? t.position : 0);

/**
 * Plans the position writes that put `movingId` at `index` of `list` (sorted
 * by position, then id) once it has been taken out, so `index` counts the
 * other items. Normally that is one write for the moved task.
 *
 * When the neighbours share a position (bulk imports, older tasks without
 * one) there's no number between them, so the shorter run of tied cards on
 * one side of the gap moves together to a single new value — ties sort by
 * id, so the run keeps its own order — and the moved card slots in next to
 * it. That's a handful of writes, not the whole column.
 */
export function planReorder(list: Positioned[], movingId: string, index: number): { id: string; position: number }[] {
  const rest = list.filter((t) => t.id !== movingId);
  const n = rest.length;
  const i = Math.max(0, Math.min(n, index));
  const lo = i > 0 ? sortPos(rest[i - 1]) : null;
  const hi = i < n ? sortPos(rest[i]) : null;
  const strictly = (a: number | null, x: number, b: number | null) => Number.isFinite(x) && (a == null || x > a) && (b == null || x < b);
  const pos = between(lo, hi);
  if (strictly(lo, pos, hi)) return [{ id: movingId, position: pos }];

  const plans: { id: string; position: number }[][] = [];
  // shift the tied run just before the gap down, below the moved card
  if (lo != null) {
    let a = i - 1;
    while (a > 0 && sortPos(rest[a - 1]) === lo) a--;
    const floor = a > 0 ? sortPos(rest[a - 1]) : null;
    const x = between(floor, hi), y = between(x, hi);
    if (strictly(floor, x, hi) && strictly(x, y, hi)) plans.push([...rest.slice(a, i).map((t) => ({ id: t.id, position: x })), { id: movingId, position: y }]);
  }
  // or shift the tied run just after the gap up, above the moved card
  if (hi != null) {
    let b = i + 1;
    while (b < n && sortPos(rest[b]) === hi) b++;
    const ceil = b < n ? sortPos(rest[b]) : null;
    const x = between(lo, ceil), y = between(lo, x);
    if (strictly(lo, x, ceil) && strictly(lo, y, x)) plans.push([...rest.slice(i, b).map((t) => ({ id: t.id, position: x })), { id: movingId, position: y }]);
  }
  if (plans.length) return plans.reduce((best, p) => (p.length < best.length ? p : best));

  // no room left between floating-point neighbours: renumber the column
  const order = [...rest.slice(0, i).map((t) => t.id), movingId, ...rest.slice(i).map((t) => t.id)];
  const base = n ? Math.floor(Math.min(...rest.map(sortPos))) : 0;
  const was = new Map(list.map((t) => [t.id, t.position]));
  return order
    .map((id, k) => ({ id, position: base + k }))
    .filter((p) => p.id === movingId || was.get(p.id) !== p.position);
}

/* ---------------- timeline ---------------- */
/** Days of implied lead-in drawn before a due date when a task has no start date. */
export function leadInDays(focusMin: number | undefined): number {
  const m = Number(focusMin);
  return Math.ceil((Number.isFinite(m) && m > 0 ? m : 0) / 60 / 2) + 1;
}

/** The start a bar is drawn from: the real start date, or the implied lead-in. */
export function effectiveStartISO(task: Pick<Task, "dueDate" | "startDate" | "focusMin">): string | null {
  if (!task.dueDate) return null;
  if (task.startDate && task.startDate <= task.dueDate) return task.startDate;
  return addDaysISO(task.dueDate, -leadInDays(task.focusMin));
}

export interface BarSpan { s: number; e: number; impliedStart: boolean }
/** Bar position in day columns relative to `windowStartIso` (unclipped — may be negative or past the window). */
export function barSpan(task: Pick<Task, "dueDate" | "startDate" | "focusMin">, windowStartIso: string): BarSpan | null {
  if (!task.dueDate) return null;
  const start = effectiveStartISO(task)!;
  return {
    s: daysBetweenISO(windowStartIso, start),
    e: daysBetweenISO(windowStartIso, task.dueDate),
    impliedStart: !(task.startDate && task.startDate <= task.dueDate),
  };
}

export type ClippedSpan = { vs: number; ve: number; clipL: boolean; clipR: boolean };
/** Where a bar sits in a `days`-wide window: fully before it, fully after it, or the visible slice. */
export function clipSpan(span: BarSpan, days: number): ClippedSpan | "before" | "after" {
  if (span.e < 0) return "before";
  if (span.s > days - 1) return "after";
  return { vs: Math.max(0, span.s), ve: Math.min(days - 1, span.e), clipL: span.s < 0 && !span.impliedStart, clipR: span.e > days - 1 };
}

/**
 * Dragging a bar moves the whole task by the distance dragged: the day it was
 * grabbed on → the day it was dropped on. Both dates shift so the bar keeps its
 * length. A task with no due date is scheduled on the drop day.
 */
export function timelineMovePatch(task: Pick<Task, "dueDate" | "startDate">, grabIso: string | null | undefined, dropIso: string): Partial<Task> | null {
  if (!task.dueDate) return { dueDate: dropIso };
  const delta = daysBetweenISO(grabIso || task.dueDate, dropIso);
  if (!delta) return null;
  const patch: Partial<Task> = { dueDate: addDaysISO(task.dueDate, delta) };
  if (task.startDate) patch.startDate = addDaysISO(task.startDate, delta);
  return patch;
}

export type StartDrop = { ok: true; patch: Partial<Task> } | { ok: false; reason: "after-due" | "unchanged" };
/** Setting a start date by dragging the bar's start handle; never after the due date. */
export function timelineStartPatch(task: Pick<Task, "dueDate" | "startDate">, dropIso: string): StartDrop {
  if (task.dueDate && dropIso > task.dueDate) return { ok: false, reason: "after-due" };
  if (task.startDate === dropIso) return { ok: false, reason: "unchanged" };
  return { ok: true, patch: { startDate: dropIso } };
}

/* ---------------- board WIP limits ---------------- */
/** Where limits lived before they were saved per board (one set for every board on the device). */
export const LEGACY_WIP_KEY = "kanbo-board-wip";

/** WIP limits are stored per board (route / project), then per grouping + column. */
export function wipStorageKey(scope: string): string {
  return `kanbo-board-wip:${scope || "all"}`;
}

/** The storage key a board saves to: its own when it knows which board it is, else the device-wide one. */
export function wipKeyFor(scope: string | null | undefined): string {
  return scope ? wipStorageKey(scope) : LEGACY_WIP_KEY;
}

/**
 * A board's limits. A board that hasn't saved its own yet inherits the
 * device-wide limits people set before limits were per board, so an upgrade
 * never silently drops them; the first save gives the board its own copy.
 */
export function loadWipLimits(get: (key: string) => string | null, scope: string | null | undefined): Record<string, number> {
  if (scope) {
    const own = get(wipStorageKey(scope));
    if (own != null) return readWipLimits(own);
  }
  return readWipLimits(get(LEGACY_WIP_KEY));
}

export function readWipLimits(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 1) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

/** "" clears the limit; otherwise a whole number of 1 or more. */
export function parseWipLimit(input: string): number | null | "invalid" {
  const t = input.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return "invalid";
  const n = parseInt(t, 10);
  return n >= 1 && n <= 999 ? n : "invalid";
}

/* ---------------- files ---------------- */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
