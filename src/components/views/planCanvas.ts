/* ============================================================
   KANBO — Plan my day: pure canvas helpers
   Lane layout for overlapping blocks, busy-time maths for the
   capacity meter, and the new-day carry-over bookkeeping. Kept
   free of React so they can be unit-tested directly.
   ============================================================ */
import { ENERGY, energyOf } from "../../data/data";
import type { Task, EnergyKind, EnergyMeta } from "../../data/types";

/* ---------- task fields that may be missing on quick-added / imported rows ---------- */

/** A task's planned length in minutes — never 0/NaN, so a block always has a height. */
export function durOf(t: Pick<Task, "dur" | "focusMin">): number {
  const d = t.dur || t.focusMin;
  return typeof d === "number" && d > 0 ? d : 30;
}

/** A task's energy kind, derived from its tags when the row doesn't carry one. */
export function energyKindOf(t: Task): EnergyKind {
  const k = t.energy ?? energyOf(t);
  return ENERGY[k] ? k : "admin";
}

/** Energy metadata that can never be undefined (a missing energy used to crash Plan). */
export function energyMetaOf(t: Task): EnergyMeta {
  return ENERGY[t.energy ?? energyOf(t)] ?? ENERGY.admin;
}

/* ---------- side-by-side lanes for overlapping blocks ---------- */

export interface Span { id: string; start: number; end: number }
export interface Lane { lane: number; lanes: number }

/** Lays overlapping blocks out side by side. Items connected by overlaps form a
 *  group; each item takes the first lane that is free when it starts, and every
 *  item in the group shares the group's lane count so the columns line up. */
export function layoutLanes(items: Span[]): Record<string, Lane> {
  const sorted = items
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end))
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Record<string, Lane> = {};
  let group: string[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    for (const id of group) out[id].lanes = laneEnds.length;
    group = []; laneEnds = []; groupEnd = -Infinity;
  };
  for (const it of sorted) {
    if (group.length && it.start >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.end); }
    else laneEnds[lane] = it.end;
    out[it.id] = { lane, lanes: 1 };
    group.push(it.id);
    groupEnd = Math.max(groupEnd, it.end);
  }
  if (group.length) flush();
  return out;
}

/* ---------- busy-time maths ---------- */

export interface Interval { start: number; end: number }

/** Clips intervals to [lo, hi] and merges overlaps, so shared time isn't counted twice. */
export function mergeIntervals(spans: Interval[], lo: number, hi: number): Interval[] {
  const clipped = spans
    .map((s) => ({ start: Math.max(lo, s.start), end: Math.min(hi, s.end) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const s of clipped) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export const totalMinutes = (spans: Interval[]): number => spans.reduce((a, s) => a + (s.end - s.start), 0);

/* ---------- new-day carry-over ---------- */

export const PLAN_DAY_KEY = "kanbo-plan-day";
export const PLAN_CARRY_KEY = "kanbo-plan-carry";

/** Local calendar day as YYYY-MM-DD. */
export function localDayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The blocks an earlier day's plan left on the canvas: still scheduled and not
 *  finished. Scoped to tasks assigned to `me` when known, so opening Plan can
 *  never offer to clear a teammate's plan. */
export function staleBlockIds(tasks: Task[], me?: string): string[] {
  return tasks
    .filter((t) => t.planToday && t.scheduled != null && t.status !== "done" && !t.archivedAt && (!me || t.assigneeId === me))
    .map((t) => t.id);
}

export interface Carry {
  /** the day this carry-over prompt belongs to */
  day: string;
  /** the last day Plan was opened on this device (null = never) */
  from: string | null;
  ids: string[];
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function readPlanDay(): string | null { return read(PLAN_DAY_KEY); }
export function writePlanDay(day: string) { write(PLAN_DAY_KEY, day); }

export function readCarry(): Carry | null {
  try {
    const v = JSON.parse(read(PLAN_CARRY_KEY) || "null");
    if (v && typeof v.day === "string" && Array.isArray(v.ids)) return { day: v.day, from: typeof v.from === "string" ? v.from : null, ids: v.ids.filter((x: unknown) => typeof x === "string") };
  } catch { /* corrupt — ignore */ }
  return null;
}
export function writeCarry(c: Carry | null) { write(PLAN_CARRY_KEY, c && c.ids.length ? JSON.stringify(c) : null); }

/**
 * Decides what the carry-over prompt should hold when Plan is opened.
 *  - Same day as last time: keep whatever prompt is still pending for today.
 *  - A new day (or first open on this device): snapshot the unfinished blocks
 *    left on the canvas. Only that snapshot is offered, so blocks planned after
 *    opening today are never mistaken for yesterday's.
 */
export function nextCarry(today: string, lastDay: string | null, pending: Carry | null, staleIds: string[]): { carry: Carry | null; markDay: boolean } {
  if (lastDay === today) return { carry: pending && pending.day === today ? pending : null, markDay: false };
  return { carry: staleIds.length ? { day: today, from: lastDay, ids: staleIds } : null, markDay: true };
}

/** "Yesterday's plan" / "Your plan from Monday" / "An earlier plan". */
export function carryLabel(from: string | null, today: string): string {
  if (!from) return "An earlier plan";
  const [y, m, d] = today.split("-").map(Number);
  const yest = localDayKey(new Date(y, m - 1, d - 1));
  if (from === yest) return "Yesterday's plan";
  const [fy, fm, fd] = from.split("-").map(Number);
  const fromDate = new Date(fy, fm - 1, fd);
  if (isNaN(fromDate.getTime())) return "An earlier plan";
  const days = Math.round((new Date(y, m - 1, d).getTime() - fromDate.getTime()) / 86400000);
  const label = days > 0 && days < 7
    ? fromDate.toLocaleDateString("en-GB", { weekday: "long" })
    : fromDate.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `Your plan from ${label}`;
}
