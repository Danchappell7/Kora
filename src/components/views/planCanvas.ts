/* ============================================================
   KANBO — Plan my day: pure canvas helpers
   Lane layout for overlapping blocks, busy-time maths for the
   capacity meter, and the new-day carry-over bookkeeping. Kept
   free of React so they can be unit-tested directly.
   ============================================================ */
import { ENERGY, energyOf, DAY_START, DAY_END } from "../../data/data";
import type { Task, EnergyKind, EnergyMeta, CalEvent, ExternalEvent } from "../../data/types";

/* ---------- times on the 24h clock ("09:30", "09:30–10:00") ---------- */

/** Minutes from midnight as a 24h time: 570 → "09:30". */
export function fmtTime(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
/** "09:30–10:00" (an en dash, no spaces, as in data columns). */
export const fmtTimeRange = (start: number, end: number): string => `${fmtTime(start)}–${fmtTime(end)}`;
/** A duration in words for people: 90 → "1h 30m", 60 → "1h", 45 → "45m". */
export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/* ---------- dates, en-GB and stable across browsers ("Wed 30 Sep", never "Sept") ---------- */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const weekdayShort = (d: Date): string => WEEKDAYS[d.getDay()];
/** "30 Sep" */
export const dayMonth = (d: Date): string => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
/** "Wed 30 Sep" */
export const dayLong = (d: Date): string => `${WEEKDAYS[d.getDay()]} ${dayMonth(d)}`;
/** Local midnight of "YYYY-MM-DD" (a time part is ignored); null when it isn't a date. */
export function parseDay(iso?: string | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d;
}
/** Whole days from `from` to `to` (both "YYYY-MM-DD"). */
export function daysBetween(from: string, to: string): number {
  const a = parseDay(from), b = parseDay(to);
  return a && b ? Math.round((b.getTime() - a.getTime()) / 86400000) : 0;
}

/* ---------- today's calendar ---------- */

/** Connected-calendar events (ISO datetimes) as today's day-blocks in minutes
 *  from midnight, which the canvas and the planner understand. All-day events
 *  are skipped so they don't block the timeline; times are clamped to the
 *  visible day. `now` picks the day (tests pass one). */
export function todaysEvents(ext: ExternalEvent[], now: Date = new Date()): CalEvent[] {
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  const out: CalEvent[] = [];
  for (const e of ext) {
    if (e.allDay) continue;
    const s = new Date(e.start), en = new Date(e.end);
    if (isNaN(s.getTime()) || isNaN(en.getTime())) continue;
    if (s.getFullYear() !== y || s.getMonth() !== mo || s.getDate() !== d) continue;
    let startMin = s.getHours() * 60 + s.getMinutes();
    let endMin = en.getHours() * 60 + en.getMinutes();
    if (endMin <= startMin) endMin = startMin + 30;          // guard zero/negative
    startMin = Math.max(DAY_START, Math.min(DAY_END, startMin));
    endMin = Math.max(DAY_START, Math.min(DAY_END, endMin));
    if (endMin <= startMin) continue;
    out.push({ id: e.id, title: e.title, start: startMin, end: endMin, kind: "meeting" });
  }
  return out.sort((a, b) => a.start - b.start);
}

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

/* ---------- new-day carry-over ----------
   A plan row has no date, so this device remembers, per block, the last day it
   saw that block on the canvas and at what time ({ id: { day, at } }). A block
   is left over from an earlier day's plan only when this device saw it then, at
   the same time, and nobody has moved it since. So:
   - blocks planned today (here or on another device) are never offered;
   - the first open on a new device, or after an update, offers nothing;
   - it works per task, so every workspace gets its own prompt — whichever one
     Plan happens to be opened in first;
   - it's kept per person, so a shared computer never mixes two people's plans. */

export const PLAN_SEEN_KEY = "kanbo-plan-seen";
export const planSeenKey = (me?: string | null) => `${PLAN_SEEN_KEY}:${me || "local"}`;

export interface SeenBlock { day: string; at: number }
export type SeenMap = Record<string, SeenBlock>;

/** how long an unvisited block is remembered */
const SEEN_KEEP_DAYS = 60;
const SEEN_MAX = 1500;

/** Local calendar day as YYYY-MM-DD (zero-padded, so days compare as strings). */
export function localDayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDayKey(new Date(y, m - 1, d + by));
}

/** Placed on today's canvas (finished or not): on the plan, with a time. */
export const isPlaced = (t: Task): boolean => !!t.planToday && t.scheduled != null && Number.isFinite(t.scheduled);

/** A block on today's canvas: on the plan, placed, and not finished. */
export const isOnCanvas = (t: Task): boolean =>
  !!t.planToday && t.scheduled != null && Number.isFinite(t.scheduled) && t.status !== "done" && !t.archivedAt;

/** My task: assigned to me (or the local "m-self" placeholder a new task carries
 *  until it's saved), or an unassigned personal one. Never a teammate's. */
export const isMine = (t: Task, me?: string | null): boolean =>
  !me || t.assigneeId === me || t.assigneeId === "m-self" || (!t.assigneeId && (t.workspaceId ?? null) === null);

// storage can be blocked (policy, some webviews): keep a copy in memory so a
// failed read never makes every visit look like the first one
const memory = new Map<string, SeenMap>();
function isSeenMap(v: unknown): v is SeenMap {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
export function readSeen(key: string): SeenMap {
  try {
    const raw = localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : {};
    const out: SeenMap = {};
    if (isSeenMap(v)) {
      for (const [id, e] of Object.entries(v)) {
        if (e && typeof e.day === "string" && typeof e.at === "number") out[id] = { day: e.day, at: e.at };
      }
    }
    memory.set(key, out);
    return out;
  } catch {
    return memory.get(key) ?? {};
  }
}
export function writeSeen(key: string, map: SeenMap) {
  memory.set(key, map);
  try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* blocked — the memory copy carries on */ }
}

/** The blocks an earlier day's plan left on the canvas, and which day that was
 *  (null when they come from different days). */
export function carryOver(tasks: Task[], seen: SeenMap, today: string, me?: string | null): { ids: string[]; from: string | null } {
  const ids: string[] = [];
  const days = new Set<string>();
  for (const t of tasks) {
    if (!isOnCanvas(t) || !isMine(t, me)) continue;
    const e = seen[t.id];
    if (e && e.day < today && e.at === t.scheduled) { ids.push(t.id); days.add(e.day); }
  }
  return { ids, from: days.size === 1 ? [...days][0] : null };
}

/**
 * Brings the record up to date with what's on the canvas now. Blocks still
 * waiting on the carry-over prompt keep their earlier day; everything else of
 * mine that's placed is stamped with today and its time; blocks that left the
 * canvas are forgotten. Tasks not in `tasks` (another workspace) are left alone.
 * Returns null when nothing changed.
 */
export function recordSeen(seen: SeenMap, tasks: Task[], today: string, me?: string | null): SeenMap | null {
  let next: SeenMap | null = null;
  const edit = () => (next ??= { ...seen });
  for (const t of tasks) {
    const e = seen[t.id];
    if (!isOnCanvas(t) || !isMine(t, me)) {
      if (e) delete edit()[t.id];
      continue;
    }
    if (e && e.day < today && e.at === t.scheduled) continue; // left over — waits for the prompt
    if (!e || e.day !== today || e.at !== t.scheduled) edit()[t.id] = { day: today, at: t.scheduled! };
  }
  // forget blocks not seen for a long time, and keep the record small
  const cutoff = shiftDay(today, -SEEN_KEEP_DAYS);
  const base: SeenMap = next ?? seen;
  const entries = Object.entries(base);
  const old = entries.filter(([, e]) => e.day < cutoff);
  if (old.length) { const m = edit(); for (const [id] of old) delete m[id]; }
  const cur: SeenMap = next ?? seen;
  const n = Object.keys(cur).length;
  if (n > SEEN_MAX) {
    const m = edit();
    Object.entries(m).sort((a, b) => (a[1].day < b[1].day ? -1 : a[1].day > b[1].day ? 1 : 0))
      .slice(0, n - SEEN_MAX).forEach(([id]) => delete m[id]);
  }
  return next;
}

/** Marks blocks as dealt with today (the prompt was answered), so an Undo that
 *  puts one back exactly where it was doesn't bring the prompt back. */
export function markSeen(seen: SeenMap, blocks: { id: string; at: number }[], today: string): SeenMap {
  const next = { ...seen };
  for (const b of blocks) next[b.id] = { day: today, at: b.at };
  return next;
}

/** Forgets or re-stamps one block after it was moved (at = its new time) or taken off the day (at = null). */
export function touchSeen(seen: SeenMap, id: string, at: number | null, today: string): SeenMap | null {
  const e = seen[id];
  if (at == null) {
    if (!e) return null;
    const next = { ...seen }; delete next[id]; return next;
  }
  if (e && e.day === today && e.at === at) return null;
  return { ...seen, [id]: { day: today, at } };
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

/* ---------- Today's suggestions: what you've waved away ----------
   Personal and per device, like the carry-over record. "Not now" hides one
   suggestion for the rest of the day; H hides them all for the day. Both
   forget themselves at midnight, so tomorrow starts with a fresh plan. */

export const ghostPrefsKey = (me?: string | null) => `kanbo-ghosts:${me || "local"}`;

export interface GhostPrefs { day: string; skipped: string[]; hidden: boolean }

const ghostMemory = new Map<string, GhostPrefs>();

/** Today's prefs (a record from an earlier day reads as a fresh one). */
export function readGhostPrefs(key: string, today: string = localDayKey()): GhostPrefs {
  const fresh: GhostPrefs = { day: today, skipped: [], hidden: false };
  let v: unknown;
  try {
    const raw = localStorage.getItem(key);
    v = raw ? JSON.parse(raw) : null;
  } catch { v = ghostMemory.get(key); /* blocked: the memory copy carries on */ }
  if (!v || typeof v !== "object") return fresh;
  const p = v as Partial<GhostPrefs>;
  if (p.day !== today) return fresh;
  return {
    day: today,
    skipped: Array.isArray(p.skipped) ? p.skipped.filter((x): x is string => typeof x === "string").slice(-500) : [],
    hidden: p.hidden === true,
  };
}
export function writeGhostPrefs(key: string, prefs: GhostPrefs) {
  ghostMemory.set(key, prefs);
  try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* blocked */ }
}
