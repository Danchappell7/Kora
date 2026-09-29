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

/** Week offset (from today's week) of the week holding the 1st of the month `monthOffset` months away. */
export function weekOffsetForMonth(today: Date, monthOffset: number): number {
  if (monthOffset === 0) return 0;
  const first = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  return Math.round((mondayOf(first).getTime() - mondayOf(today).getTime()) / (7 * DAY_MS));
}

/** Month offset (from today's month) that a week `weekOffset` weeks away mostly falls in (its Thursday). */
export function monthOffsetForWeek(today: Date, weekOffset: number): number {
  const thu = mondayOf(today);
  thu.setDate(thu.getDate() + weekOffset * 7 + 3);
  return (thu.getFullYear() - today.getFullYear()) * 12 + (thu.getMonth() - today.getMonth());
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

/**
 * Plans the position writes that put `movingId` at `index` of `list` once it
 * has been taken out (so `index` counts the other items). Normally that is a
 * single write for the moved task; when its neighbours share a position (bulk
 * imports) or lack one, the column is renumbered so the move actually shows.
 */
export function planReorder(list: Positioned[], movingId: string, index: number): { id: string; position: number }[] {
  const rest = list.filter((t) => t.id !== movingId);
  const i = Math.max(0, Math.min(rest.length, index));
  const before = rest[i - 1], after = rest[i];
  const bp = before?.position, ap = after?.position;
  const neighboursKnown = (!before || bp != null) && (!after || ap != null);
  const pos = between(bp, ap);
  if (neighboursKnown && Number.isFinite(pos) && (bp == null || pos > bp) && (ap == null || pos < ap)) {
    return [{ id: movingId, position: pos }];
  }
  const order = [...rest.slice(0, i).map((t) => t.id), movingId, ...rest.slice(i).map((t) => t.id)];
  const known = list.map((t) => t.position).filter((p): p is number => p != null && Number.isFinite(p));
  const base = known.length ? Math.floor(Math.min(...known)) : 0;
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
/** WIP limits are stored per board (route / project), then per grouping + column. */
export function wipStorageKey(scope: string): string {
  return `kanbo-board-wip:${scope || "all"}`;
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
