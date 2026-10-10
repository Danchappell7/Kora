/* ============================================================
   KANBO — pure helpers behind the Board, Timeline, Calendar and
   Files views. No React here, so every rule can be unit-tested.
   Dates are local "YYYY-MM-DD" strings, parsed at local midnight
   (never via toISOString) so DST and UTC offsets can't shift a day.
   ============================================================ */
import { toLocalISO, PRIORITY_META } from "../../data/data";
import type { BoardSettings, Priority, Task } from "../../data/types";

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


/* ---------------- board upgrade (0048)            [0048 contract → u8] ----------------
   WIP limits move to projects.board_settings.wip (team-wide, writers set
   them, one change at a time: BoardSettingsChange, merged by
   merge_board_settings; lib/profileState parseBoardSettings). The
   per-browser limits above (kanbo-board-wip) stay in use on My tasks; the
   ones a device kept for a project board itself are offered up, once, the
   first time a writer opens it. Swimlane grouping is per person
   per board (localStorage). Columns past VIRTUALISE_AFTER cards render a
   window of them (no dependency). */

/** columns with more cards than this render only what's on screen */
export const VIRTUALISE_AFTER = 50;
export type SwimlaneBy = "none" | "assignee" | "priority" | "project";
export interface Swimlane { key: string; label: string; taskIds: string[] }

/** The row groupings, in the order the Rows control offers them. */
export const SWIMLANE_OPTIONS: { value: SwimlaneBy; label: string }[] = [
  { value: "none", label: "None" }, { value: "assignee", label: "Assignee" }, { value: "priority", label: "Priority" }, { value: "project", label: "Project" },
];
const SWIMLANE_VALUES: readonly SwimlaneBy[] = ["none", "assignee", "priority", "project"];
const PRIORITY_LANES: Priority[] = ["urgent", "high", "medium", "low"];

export interface SwimlaneCtx {
  /** a member of this board's workspace (undefined = not a member any more → "Former members") */
  memberName: (id: string) => string | undefined;
  /** a project you can see (undefined → "Other projects") */
  projectName: (id: string) => string | undefined;
  /** members in the board's own order (the Assignee columns' order); others follow by name */
  memberOrder?: readonly string[];
}

type LaneTask = Pick<Task, "id" | "assigneeId" | "priority" | "projectId">;

/** The lane a task sits in. */
export function swimlaneKeyOf(t: LaneTask, by: SwimlaneBy, ctx: SwimlaneCtx): string {
  if (by === "assignee") return !t.assigneeId || t.assigneeId === "—" ? UNASSIGNED_COL : ctx.memberName(t.assigneeId) !== undefined ? t.assigneeId : FORMER_COL;
  if (by === "priority") return PRIORITY_LANES.includes(t.priority) ? t.priority : "medium";
  if (by === "project") return ctx.projectName(t.projectId) !== undefined ? t.projectId : NO_PROJECT_COL;
  return "all";
}

/** Group a board's tasks into lanes (each lane's tasks keep their board order; "none" = one lane).
 *  Only lanes with tasks: people in the board's order, then Unassigned, then Former members;
 *  priorities urgent → low; projects by name, then Other projects. */
export function swimlanes(tasks: LaneTask[], by: SwimlaneBy, ctx: SwimlaneCtx): Swimlane[] {
  if (by === "none" || !SWIMLANE_VALUES.includes(by)) return [{ key: "all", label: "", taskIds: tasks.map((t) => t.id) }];
  const groups = new Map<string, string[]>();
  for (const t of tasks) {
    const k = swimlaneKeyOf(t, by, ctx);
    const g = groups.get(k);
    if (g) g.push(t.id); else groups.set(k, [t.id]);
  }
  const lane = (key: string, label: string): Swimlane => ({ key, label, taskIds: groups.get(key) ?? [] });
  const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, "en-GB", { sensitivity: "base" });
  const tail = (special: [string, string][]) => special.filter(([k]) => groups.has(k)).map(([k, l]) => lane(k, l));
  if (by === "priority") return PRIORITY_LANES.filter((p) => groups.has(p)).map((p) => lane(p, PRIORITY_META[p].label));
  if (by === "assignee") {
    const order = ctx.memberOrder ?? [];
    const rank = new Map(order.map((id, i) => [id, i]));
    const people = [...groups.keys()].filter((k) => k !== UNASSIGNED_COL && k !== FORMER_COL)
      .map((k) => lane(k, ctx.memberName(k) || "Someone"))
      .sort((a, b) => ((rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity)) || byName(a, b));
    return [...people, ...tail([[UNASSIGNED_COL, "Unassigned"], [FORMER_COL, "Former members"]])];
  }
  const projects = [...groups.keys()].filter((k) => k !== NO_PROJECT_COL).map((k) => lane(k, ctx.projectName(k) || "Untitled project")).sort(byName);
  return [...projects, ...tail([[NO_PROJECT_COL, "Other projects"]])];
}

/** What dropping a task into a lane writes; null when the lane can't take tasks from another lane
 *  (Unassigned, Former members, Other projects — move a card out of them, never into them). */
export function lanePatch(by: SwimlaneBy, laneKey: string): Partial<Task> | null {
  if (by === "none" || laneKey === UNASSIGNED_COL || laneKey === FORMER_COL || laneKey === NO_PROJECT_COL) return null;
  if (by === "assignee") return { assigneeId: laneKey };
  if (by === "priority") return PRIORITY_LANES.includes(laneKey as Priority) ? { priority: laneKey as Priority } : null;
  if (by === "project") return { projectId: laneKey };
  return null;
}

/** Rows by the same thing as the columns would repeat the columns: that's no rows. */
export function effectiveSwimlane(by: SwimlaneBy, columns: string): SwimlaneBy {
  return by === columns ? "none" : by;
}

/** Where a board's row grouping is kept (per person, per board, on this device). */
export const swimlaneStorageKey = (scope: string | null | undefined): string => `kanbo-board-lanes:${scope || "all"}`;
/** A board's lanes that are folded away (keys are "<by>:<lane key>"). */
export const laneCollapseStorageKey = (scope: string | null | undefined): string => `kanbo-board-lanes-collapsed:${scope || "all"}`;

export function readSwimlane(raw: string | null): SwimlaneBy {
  return raw && (SWIMLANE_VALUES as readonly string[]).includes(raw) ? (raw as SwimlaneBy) : "none";
}

/* ---------------- WIP limits on the board's settings ---------------- */

/** A column's key in board_settings.wip: a status column by its status (the contract's "column key"),
 *  other groupings qualified ("priority:urgent", "assignee:<id>") so they can never collide. */
export function wipSettingKey(group: string, colKey: string): string {
  return group === "status" ? colKey : `${group}:${colKey}`;
}

/** This device's limits ("status:todo" → 3) in board_settings' shape ("todo" → 3). */
export function localWipToSettings(local: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(local)) {
    if (!(typeof v === "number" && Number.isInteger(v) && v >= 1)) continue;
    out[k.startsWith("status:") ? k.slice("status:".length) : k] = Math.min(v, 999);
  }
  return out;
}

/**
 * One change to a project's board settings, never the whole object, so two
 * writers (or a tab that missed a live update) change only what they touched.
 * Merged one level deep, as merge_board_settings (0048) stores it: wip keys
 * merge (a null removes that limit; wip: null removes them all), covers on or
 * off (false / null removes it).
 */
export interface BoardSettingsChange {
  wip?: Record<string, number | null> | null;
  covers?: boolean | null;
}

/** The settings with a change merged in (the client's copy of merge_board_settings). An empty wip disappears. */
export function applyBoardSettingsChange(settings: BoardSettings | undefined, change: BoardSettingsChange): BoardSettings {
  const next: BoardSettings = { ...(settings ?? {}) };
  if ("wip" in change) {
    const wip: Record<string, number> = change.wip === null ? {} : { ...(settings?.wip ?? {}) };
    for (const [k, v] of Object.entries(change.wip ?? {})) {
      if (v == null || !Number.isFinite(v)) delete wip[k];
      else wip[k] = Math.max(1, Math.min(999, Math.round(v)));
    }
    if (Object.keys(wip).length) next.wip = wip; else delete next.wip;
  }
  if ("covers" in change) { if (change.covers) next.covers = true; else delete next.covers; }
  return next;
}

/** The settings with one limit set (n) or cleared (null). An empty wip disappears. */
export function withWipLimit(settings: BoardSettings | undefined, key: string, n: number | null): BoardSettings {
  return applyBoardSettingsChange(settings, { wip: { [key]: n } });
}

/** The settings with "Show project covers" on or off. */
export function withCovers(settings: BoardSettings | undefined, on: boolean): BoardSettings {
  return applyBoardSettingsChange(settings, { covers: on });
}

/** The limits a device kept for a board that the board doesn't share yet (never overriding one it does). */
export function wipToShare(local: Record<string, number>, shared: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(localWipToSettings(local))) if (shared?.[k] == null) out[k] = v;
  return out;
}

/** Said (toast + screen reader) when a move takes a column past its limit; null when it doesn't. */
export function wipBreachMessage(column: string, count: number, limit: number | null | undefined): string | null {
  if (wipState(count, limit) !== "over") return null;
  return `${column} is over its WIP limit: ${count} of ${limit}`;
}

/** A column against its WIP limit: under it, at it, or over it.  [final] */
export function wipState(count: number, limit: number | null | undefined): "ok" | "at" | "over" {
  if (!limit || limit < 1) return "ok";
  return count > limit ? "over" : count === limit ? "at" : "ok";
}

/* ---------------- cards ---------------- */

/** A card's progress bar: sub-tasks done / total, else the legacy checklist; null when it has neither. */
export function cardProgress(task: Pick<Task, "subtasks">, children: Pick<Task, "status">[]): { done: number; total: number } | null {
  if (children.length > 0) return { done: children.filter((c) => c.status === "done").length, total: children.length };
  const list = Array.isArray(task.subtasks) ? task.subtasks : [];
  if (list.length > 0) return { done: list.filter((s) => s.done).length, total: list.length };
  return null;
}

/** How tall a card will probably be (px) before it's been measured: virtualising needs a guess. */
export function cardHeightEstimate(c: { cover?: "image" | "project" | null; tags?: boolean; progress?: boolean; titleLength?: number }): number {
  let h = 92; // padding, one title line, the meta row
  if ((c.titleLength ?? 0) > 30) h += 20; // titles wrap to two lines
  if (c.tags) h += 24;
  if (c.progress) h += 14;
  if (c.cover === "image") h += 104;
  else if (c.cover === "project") h += 26;
  return h;
}

/* ---------------- moving several cards ---------------- */

/** Like planReorder for a run of cards: puts `ids` (in that order) at `index` of `list` (index counts
 *  the cards that aren't moving). Every write the run needs, at most one per card. */
export function planInsertMany(list: Positioned[], ids: string[], index: number): { id: string; position: number }[] {
  const moving = [...new Set(ids)];
  const set = new Set(moving);
  const order = (a: Positioned, b: Positioned) => (sortPos(a) - sortPos(b)) || a.id.localeCompare(b.id);
  let work: Positioned[] = list.filter((t) => !set.has(t.id)).map((t) => ({ id: t.id, position: t.position })).sort(order);
  const at = Math.max(0, Math.min(work.length, index));
  const writes = new Map<string, number>();
  moving.forEach((id, k) => {
    const plan = planReorder(work, id, at + k);
    const pos = new Map(plan.map((p) => [p.id, p.position]));
    work = [...work.map((t) => (pos.has(t.id) ? { id: t.id, position: pos.get(t.id) } : t)), { id, position: pos.get(id) }].sort(order);
    for (const p of plan) writes.set(p.id, p.position);
  });
  return [...writes].map(([id, position]) => ({ id, position }));
}

/* ---------------- virtual window ---------------- */

export interface VirtualRange { start: number; end: number }
/** A virtual column, top to bottom: spacers standing in for cards that aren't rendered, and runs of cards that are. */
export type VirtualSegment = { kind: "space"; height: number } | { kind: "cards"; start: number; end: number };

/** Top of each card in a stack with `gap` between cards, and the stack's height. */
export function stackOffsets(heights: readonly number[], gap: number): { offsets: number[]; total: number } {
  const offsets: number[] = new Array(heights.length);
  let y = 0;
  for (let i = 0; i < heights.length; i++) { offsets[i] = y; y += Math.max(0, heights[i]) + (i < heights.length - 1 ? gap : 0); }
  return { offsets, total: y };
}

/**
 * The cards to render in a long column: the ones within `overscan` px of the part of the column on
 * screen (view = px from the column's top, may be negative or past its end), plus `pinned` cards
 * (focused, open, just moved) and one each side of them, so keyboard moves always find a neighbour.
 * Ranges are [start, end), sorted and merged.
 */
export function virtualRanges(heights: readonly number[], gap: number, viewTop: number, viewBottom: number, overscan: number, pinned: readonly number[] = []): VirtualRange[] {
  const n = heights.length;
  if (n === 0) return [];
  const { offsets } = stackOffsets(heights, gap);
  const lo = viewTop - overscan, hi = viewBottom + overscan;
  // first card whose bottom reaches lo; last card whose top is above hi
  let a = 0, b = n - 1;
  while (a < b) { const m = (a + b) >> 1; if (offsets[m] + heights[m] < lo) a = m + 1; else b = m; }
  const start = a;
  a = start; b = n - 1;
  while (a < b) { const m = (a + b + 1) >> 1; if (offsets[m] > hi) b = m - 1; else a = m; }
  const ranges: VirtualRange[] = [];
  if (offsets[start] <= hi && offsets[start] + heights[start] >= lo) ranges.push({ start, end: a + 1 });
  for (const p of pinned) if (Number.isInteger(p) && p >= 0 && p < n) ranges.push({ start: Math.max(0, p - 1), end: Math.min(n, p + 2) });
  if (ranges.length === 0) ranges.push({ start: Math.min(start, n - 1), end: Math.min(start, n - 1) + 1 }); // never nothing at all
  ranges.sort((x, y) => x.start - y.start);
  const merged: VirtualRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** The ranges as a column's children: a spacer before, between and after them sized so every
 *  rendered card sits exactly where it would in the full column (the column's flex gap included). */
export function virtualSegments(heights: readonly number[], gap: number, ranges: readonly VirtualRange[]): VirtualSegment[] {
  const n = heights.length;
  const { offsets, total } = stackOffsets(heights, gap);
  const out: VirtualSegment[] = [];
  let cursor = 0; // the next card not yet accounted for
  for (const r of ranges) {
    if (r.start >= r.end || r.start < cursor) continue;
    if (r.start > cursor) out.push({ kind: "space", height: Math.max(0, offsets[r.start] - (cursor > 0 ? offsets[cursor] : 0) - gap) });
    out.push({ kind: "cards", start: r.start, end: Math.min(n, r.end) });
    cursor = Math.min(n, r.end);
  }
  if (cursor < n) out.push({ kind: "space", height: Math.max(0, total - (cursor > 0 ? offsets[cursor] : 0)) });
  return out;
}
