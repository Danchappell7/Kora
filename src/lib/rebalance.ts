/* ============================================================
   KANBO — Workload you can act on (0055): Kanbo's rebalance, and
   where a task lands when it's dropped on someone's week.
   planRebalance: for the week on show, each teammate over capacity
   hands on the work they haven't started (biggest first) to the
   teammate with the most room, who stays under 90% of their own
   capacity and isn't off the day it's due. A few moves at most, so
   the preview reads at a glance; nothing is written here (Workload
   shows the preview, Apply saves it, Undo puts it back).
   moveIntoWeek: a task dropped on a person's week keeps its weekday
   (Friday when it had no date), never lands before today, and steps
   off days the person doesn't work or is away.
   Pure: no React, no storage, no clock of its own.
   ============================================================ */
import type { Task } from "../data/types";
import { loadForWeek } from "./radar";
import { addDays, localDay, round1 } from "./weekMath";
import { isoOf, isoWeekday } from "./availability";

export interface RebalanceMove {
  taskId: string;
  title: string;
  from: string;
  to: string;
  /** the hours it carries in that week */
  hours: number;
}
export interface RebalancePlan {
  moves: RebalanceMove[];
  /** each person's hours that week, before and after */
  before: Record<string, number>;
  after: Record<string, number>;
}

const MAX_MOVES = 6;
/** a receiver stays under this share of their capacity */
const ROOM = 0.9;

/**
 * Kanbo's rebalance for one week. `members` are the people on screen (guests carry no capacity
 * and never take work on); `capacityOf` is each person's capacity that week; `isOff(id, iso)`
 * says whether they're away that day.
 */
export function planRebalance(input: {
  tasks: Task[];
  members: { id: string; guest?: boolean }[];
  weekStart: Date;
  today: Date;
  capacityOf: (id: string) => number;
  isOff?: (id: string, iso: string) => boolean;
}): RebalancePlan {
  const { tasks, weekStart, today } = input;
  const team = input.members.filter((m) => !m.guest).map((m) => m.id);
  const { rows } = loadForWeek(tasks, weekStart, today);
  const load: Record<string, number> = {};
  const capOf: Record<string, number> = {};
  for (const id of team) { load[id] = round1(rows.get(id)?.hours ?? 0); capOf[id] = input.capacityOf(id); }
  const before = { ...load };
  const over = team.filter((id) => load[id] > capOf[id]).sort((a, b) => (load[b] - capOf[b]) - (load[a] - capOf[a]));
  const moves: RebalanceMove[] = [];
  for (const from of over) {
    // work not yet started, that someone else could pick up: a top-level task (sub-tasks go with their parent)
    const candidates = (rows.get(from)?.items ?? [])
      .filter((i) => i.task.status === "todo" && !i.task.parentId && !i.task.isMilestone && !!i.task.workspaceId && i.hours > 0)
      .sort((a, b) => b.hours - a.hours || (a.task.dueDate ?? "9999").localeCompare(b.task.dueDate ?? "9999") || a.task.id.localeCompare(b.task.id));
    for (const item of candidates) {
      if (moves.length >= MAX_MOVES || load[from] <= capOf[from]) break;
      const due = item.task.dueDate?.slice(0, 10);
      const to = team
        .filter((id) => id !== from && capOf[id] > 0 && load[id] + item.hours <= capOf[id] * ROOM && !(due && input.isOff?.(id, due)))
        .sort((a, b) => (capOf[b] * ROOM - load[b]) - (capOf[a] * ROOM - load[a]) || a.localeCompare(b))[0];
      if (!to) continue;
      moves.push({ taskId: item.task.id, title: item.task.title, from, to, hours: round1(item.hours) });
      load[from] = round1(load[from] - item.hours);
      load[to] = round1(load[to] + item.hours);
    }
  }
  return { moves, before, after: load };
}

/** The patches that apply a plan (and the ones that undo it). */
export function rebalancePatches(plan: RebalancePlan): { apply: { id: string; patch: Partial<Task> }[]; undo: { id: string; patch: Partial<Task> }[] } {
  return {
    apply: plan.moves.map((m) => ({ id: m.taskId, patch: { assigneeId: m.to } })),
    undo: plan.moves.map((m) => ({ id: m.taskId, patch: { assigneeId: m.from } })),
  };
}

/**
 * Where a task lands in another week: the same weekday (Friday when it had no due date), never
 * before today, on one of `workDays` (ISO) that the person isn't off (`isOff`), searching forward
 * through that week and then back. A start date moves with the due date (the span is kept).
 * Null when it's already due in that week.
 */
export function moveIntoWeek(task: Pick<Task, "dueDate" | "startDate">, weekStart: Date, today: Date, opts: { workDays?: readonly number[]; isOff?: (iso: string) => boolean } = {}): Partial<Task> | null {
  const due = localDay(task.dueDate);
  const weekEnd = addDays(weekStart, 6);
  if (due && due >= weekStart && due <= weekEnd) return null;
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const offset = due ? isoWeekday(due) - 1 : 4;
  const floor = todayMid > weekStart ? todayMid : weekStart;
  if (floor > weekEnd) return null;
  const days = opts.workDays?.length ? opts.workDays : [1, 2, 3, 4, 5];
  const fits = (d: Date) => days.includes(isoWeekday(d)) && !opts.isOff?.(isoOf(d));
  let pick = addDays(weekStart, offset);
  if (pick < floor) pick = floor;
  if (!fits(pick)) {
    let found: Date | null = null;
    for (let d = addDays(pick, 1); d <= weekEnd; d = addDays(d, 1)) if (fits(d)) { found = d; break; }
    if (!found) for (let d = addDays(pick, -1); d >= floor; d = addDays(d, -1)) if (fits(d)) { found = d; break; }
    if (found) pick = found;
  }
  const dueDate = isoOf(pick);
  const patch: Partial<Task> = { dueDate };
  const start = localDay(task.startDate);
  if (start) {
    if (due) {
      const shift = Math.round((pick.getTime() - due.getTime()) / 86400000);
      patch.startDate = isoOf(addDays(start, shift));
    } else if (start > pick) patch.startDate = dueDate;
  }
  return patch;
}
