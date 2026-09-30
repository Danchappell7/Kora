/* ============================================================
   KANBO — Today's brief, and the numbers behind it.
   composeBrief writes the one sentence Today opens on ("Good morning,
   Daniel. You have 3h 55m free and four things due. Start with the
   launch deck: it's holding up three tasks."), as parts so each live
   figure can be a button. Alongside it: free time, momentum and the
   ghost plan (Kanbo's suggested blocks, never written until accepted).
   Pure: no React, no storage, no clock of its own (callers pass now).
   ============================================================ */
import { DAY_START, DAY_END, PRIORITY_META, planDayDetailed } from "../data/data";
import type { CalEvent, Task } from "../data/types";
import {
  dayMonth, daysBetween, durOf, energyKindOf, fmtDuration, isMine, parseDay, weekdayShort, isPlaced, mergeIntervals, totalMinutes, type Interval,
} from "../components/views/planCanvas";

/** The working day that "free" and the suggestions are counted against. */
export const WORK_START = 8 * 60;
export const WORK_END = 18 * 60;
/** Under this much free time the day reads as fully booked. */
const BOOKED_UNDER = 15;
const TITLE_MAX = 56;

/* ---------- words ---------- */

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
/** Numbers of nine or fewer in words ("four"), larger ones as digits ("12"). */
export const countWord = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 9 ? WORDS[n] : String(n));
/** "four things", "one task", "12 tasks". */
export const countOf = (n: number, one: string, many = `${one}s`): string => `${countWord(n)} ${n === 1 ? one : many}`;
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- today's set ---------- */

const day10 = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
const isOpen = (t: Task) => t.status !== "done" && !t.archivedAt;
const isDueToday = (t: Task, today: string) => day10(t.dueDate) === today;
const isOverdue = (t: Task, today: string) => !!t.dueDate && day10(t.dueDate) < today;
const doneToday = (t: Task, today: string) => t.status === "done" && !t.archivedAt && day10(t.completedAt) === today;

/** Today's work, as the rail, the suggestions and the brief all count it:
 *  anything you've put on today's list (whoever it belongs to), and your own
 *  top-level tasks (not a collaborator's, not a subtask). */
export const isTodaysScope = (t: Task, me?: string | null): boolean => !!t.planToday || (!t.parentId && isMine(t, me));

/** Placed blocks on today's canvas, as busy time. */
function blockSpans(tasks: Task[]): Interval[] {
  return tasks.filter((t) => isPlaced(t) && isOpen(t)).map((t) => ({ start: t.scheduled!, end: t.scheduled! + durOf(t) }));
}

/** The free stretches of the working day still ahead: [now, WORK_END] (or a
 *  custom window) minus meetings, breaks and placed blocks. `extra` adds more
 *  busy time (e.g. the suggested blocks, so a "Free" label never sits on one). */
export function freeGaps(tasks: Task[], events: CalEvent[], nowMin: number, opts: { start?: number; end?: number; extra?: Interval[] } = {}): Interval[] {
  const lo = Math.max(opts.start ?? WORK_START, Math.ceil(nowMin));
  const hi = opts.end ?? WORK_END;
  if (hi <= lo) return [];
  const busy = mergeIntervals([...events, ...blockSpans(tasks), ...(opts.extra ?? [])], lo, hi);
  const out: Interval[] = [];
  let at = lo;
  for (const b of busy) {
    if (b.start > at) out.push({ start: at, end: b.start });
    at = Math.max(at, b.end);
  }
  if (at < hi) out.push({ start: at, end: hi });
  return out;
}

/** Minutes of the working day still free (see freeGaps). */
export function freeMinutes(tasks: Task[], events: CalEvent[], nowMin: number, opts: { start?: number; end?: number } = {}): number {
  return totalMinutes(freeGaps(tasks, events, nowMin, opts));
}

/** Minutes already planned on today's canvas (open blocks). */
export function plannedMinutes(tasks: Task[]): number {
  return totalMinutes(mergeIntervals(blockSpans(tasks), DAY_START, DAY_END));
}

/** Today's work done vs. the whole of today's work: finished today, plus what's
 *  still open and due today, planned for today or on today's canvas. With `me`,
 *  only the work Today shows you (yours, or on today's list) counts. */
export function momentumCounts(tasks: Task[], today: string, me?: string | null): { done: number; total: number } {
  let done = 0, open = 0;
  for (const t of tasks) {
    if (t.parentId || !isTodaysScope(t, me)) continue;
    if (doneToday(t, today)) done++;
    else if (isOpen(t) && (isDueToday(t, today) || !!t.planToday || isPlaced(t))) open++;
  }
  return { done, total: done + open };
}

/** 0..1 for the momentum line under Today's header, or null when there's nothing on today. */
export function momentum(tasks: Task[], today: string, me?: string | null): number | null {
  const { done, total } = momentumCounts(tasks, today, me);
  return total > 0 ? done / total : null;
}

/* ---------- the ghost plan ---------- */

export interface GhostBlock {
  /** the task's id */
  id: string;
  start: number;
  end: number;
  overdue: boolean;
}
export interface GhostPlan {
  /** where Kanbo would put each task, earliest first */
  suggestions: GhostBlock[];
  /** candidates that don't fit in what's left of today (they're tomorrow's) */
  unplaced: Task[];
}
export interface GhostOptions {
  today: string;
  /** the signed-in person: only their own due and overdue work is suggested
   *  (anything they've put on today's list themselves is, whoever it belongs to) */
  me?: string | null;
  /** ids waved away for today ("Not now") */
  skip?: Iterable<string>;
  /** suggestions stop at the end of the working day while it's still ahead */
  workEnd?: number;
}

/** The tasks Kanbo would like on today's canvas: open, not placed yet, and
 *  planned for today, or yours and due today or overdue. */
export function ghostCandidates(tasks: Task[], opts: GhostOptions): Task[] {
  const skip = new Set(opts.skip ?? []);
  return tasks.filter((t) => isOpen(t) && !isPlaced(t) && !skip.has(t.id) && isTodaysScope(t, opts.me)
    && (!!t.planToday || isDueToday(t, opts.today) || isOverdue(t, opts.today)));
}

/** "15:00" (or "15:00:00") → 900; null when there's no usable time. */
export function dueMinutes(t: Task): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(t.dueTime ?? "");
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 ? v : null;
}

const SLOT = 5; // the planner's grid
/** The earliest start on the 5-minute grid in [lo, hi] where `dur` fits clear of `busy`. */
function firstFit(busy: Interval[], lo: number, hi: number, dur: number): number | null {
  for (let s = Math.ceil(lo / SLOT) * SLOT; s + dur <= hi; s += SLOT) {
    const clash = busy.find((b) => s < b.end && s + dur > b.start);
    if (!clash) return s;
    s = Math.ceil(clash.end / SLOT) * SLOT - SLOT; // jump past it
  }
  return null;
}

/** Kanbo's suggested plan for the rest of the working day: the candidates laid
 *  into the free gaps. Work due at a time today goes first, in the earliest
 *  slot that still finishes by then (or, when none does, as soon as it can).
 *  The rest goes through planDayDetailed (due date and priority first, deep
 *  work in the morning, a break after 90 minutes of focus), with Kanbo's score
 *  breaking ties. Only the working day is offered (from 08:00, never after
 *  18:00); once it's over, everything waits for tomorrow. Nothing is written —
 *  the canvas draws these as dashed ghosts. */
export function ghostPlan(tasks: Task[], events: CalEvent[], nowMin: number, opts: GhostOptions): GhostPlan {
  const cand = ghostCandidates(tasks, opts);
  if (!cand.length) return { suggestions: [], unplaced: [] };
  const workEnd = Math.min(opts.workEnd ?? WORK_END, DAY_END);
  // the working day's over: nothing more is suggested for today
  if (nowMin >= workEnd) return { suggestions: [], unplaced: cand };
  const from = Math.max(nowMin, WORK_START);
  const busy: CalEvent[] = [
    ...events,
    ...tasks.filter((t) => isPlaced(t) && isOpen(t))
      .map((t) => ({ id: "busy-" + t.id, title: t.title, start: t.scheduled!, end: t.scheduled! + durOf(t), kind: "meeting" as const })),
  ];
  // the evening isn't offered
  if (workEnd < DAY_END) busy.push({ id: "busy-evening", title: "Evening", start: workEnd, end: DAY_END, kind: "break" });
  const byScore = [...cand].sort((a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0));
  const placed: Record<string, number> = {};
  const lateIds = new Set<string>();
  const taken = () => Object.entries(placed).map(([id, start]) => {
    const t = cand.find((x) => x.id === id)!;
    return { id: "sugg-" + id, title: t.title, start, end: start + durOf(t), kind: "meeting" as const };
  });

  // 1. Due at a time today: before that time. A deadline that's gone, or can't be
  //    met any more, is still today's: as soon as there's room.
  const timed = byScore.filter((t) => isDueToday(t, opts.today) && dueMinutes(t) != null)
    .sort((a, b) => dueMinutes(a)! - dueMinutes(b)!);
  for (const t of timed) {
    const by = dueMinutes(t)!, dur = durOf(t);
    const spans = [...busy, ...taken()];
    const at = firstFit(spans, from, Math.min(by, workEnd), dur) ?? firstFit(spans, from, workEnd, dur);
    if (at == null) continue; // doesn't fit today at all: the planner below says so
    placed[t.id] = at;
    if (by <= nowMin) lateIds.add(t.id);
  }

  // 2. Everything else. planDayDetailed sorts by due date then priority (stably),
  //    so score order is the tie-break.
  const ordered = byScore.filter((t) => placed[t.id] == null)
    .map((t) => ({ ...t, energy: energyKindOf(t), dur: durOf(t), scheduled: null }));
  const plan = planDayDetailed(ordered, [...busy, ...taken()], { nowMin: from });
  Object.assign(placed, plan.placed);
  // A second pass for what didn't fit: the breaks the planner holds back after
  // long runs of focus can leave a visible "Free · 40m" that a 30m task could
  // use. Offer those gaps before calling anything tomorrow's.
  const unplaced: Task[] = [];
  for (const t of plan.unplaced) {
    const again = planDayDetailed([t], [...busy, ...taken()], { nowMin: from }).placed[t.id];
    if (again != null) placed[t.id] = again;
    else unplaced.push(t);
  }
  const byId = new Map(cand.map((t) => [t.id, t]));
  const suggestions = Object.entries(placed)
    .map(([id, start]) => {
      const t = byId.get(id)!;
      return { id, start, end: start + durOf(t), overdue: isOverdue(t, opts.today) || lateIds.has(id) };
    })
    .sort((a, b) => a.start - b.start);
  return { suggestions, unplaced: unplaced.map((t) => byId.get(t.id) ?? t) };
}

/* ---------- the brief ---------- */

export type BriefPartKind = "free" | "due" | "overdue" | "task" | "risks";
export type BriefPart = string | { kind: BriefPartKind; text: string; taskId?: string };
export interface Brief { parts: BriefPart[]; plain: string }

export interface BriefInput {
  /** my tasks (the plan's scope) */
  tasks: Task[];
  /** today's meetings and breaks */
  events: CalEvent[];
  nowMin: number;
  /** YYYY-MM-DD */
  today: string;
  userName?: string;
  /** risks that need a look (owners and admins only) */
  riskCount?: number;
  /** the whole workspace, to count what the top task is holding up (defaults to `tasks`) */
  allTasks?: Task[];
  /** the signed-in person: the brief counts the work the rail and the suggestions
   *  show (yours, or on today's list), not a collaborator's or a subtask */
  me?: string | null;
}

/** "Mon" within the week, else "12 Sep". */
function sinceLabel(iso: string, today: string): string {
  const date = parseDay(iso);
  if (!date) return iso;
  const days = daysBetween(iso, today);
  return days > 0 && days < 7 ? weekdayShort(date) : dayMonth(date);
}

/** A model-written reason, fitted to follow a colon: lower-case first letter
 *  (unless it's an acronym), no closing full stop. Boilerplate is dropped. */
function cleanReason(r?: string): string | null {
  const s = (r ?? "").trim().replace(/[.!\s]+$/, "");
  if (!s || /^captured just now/i.test(s)) return null;
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

const rank = (t: Task) => PRIORITY_META[t.priority]?.rank ?? 0;

/** What to start with: the day's work ranked by Kanbo's score, then due date, then priority. */
export function topTask(tasks: Task[], today: string, me?: string | null): Task | null {
  const pool = tasks.filter((t) => isOpen(t) && isTodaysScope(t, me) && (isDueToday(t, today) || isOverdue(t, today) || !!t.planToday));
  if (!pool.length) return null;
  return [...pool].sort((a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0)
    || (day10(a.dueDate) || "9999").localeCompare(day10(b.dueDate) || "9999")
    || rank(b) - rank(a))[0];
}

/** Why that task first: Kanbo's own reason when it has one, else the plainest true thing. */
export function reasonFor(t: Task, all: Task[], today: string): string {
  const ai = cleanReason(t.aiReason);
  if (ai) return ai;
  const held = all.filter((x) => isOpen(x) && x.id !== t.id && (x.dependencies ?? []).includes(t.id)).length;
  if (held > 0) return `it's holding up ${countOf(held, "task")}`;
  if (t.dueTime && isDueToday(t, today)) return `it's due at ${t.dueTime.slice(0, 5)}`;
  if (isOverdue(t, today)) return `it's been overdue since ${sinceLabel(t.dueDate!, today)}`;
  return "it's your highest priority";
}

const shorten = (s: string) => (s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1).trimEnd() + "…" : s);

/** Today's brief, as parts: plain strings and the live figures (free time,
 *  due, overdue, the task to start with, risks) that the view renders as
 *  buttons. `plain` is the whole thing as one string. */
export function composeBrief({ tasks: given, events, nowMin, today, userName, riskCount = 0, allTasks, me }: BriefInput): Brief {
  const parts: BriefPart[] = [];
  const hour = Math.floor(nowMin / 60);
  const name = userName && !userName.includes("@") ? userName.trim().split(/\s+/)[0] : "";
  parts.push(`${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}, ${name || "there"}. `);

  // the same set the rail and the suggestions work from
  const tasks = given.filter((t) => isTodaysScope(t, me));
  const open = tasks.filter(isOpen);
  const due = open.filter((t) => isDueToday(t, today)).length;
  const over = open.filter((t) => isOverdue(t, today)).length;
  const evening = nowMin >= WORK_END;

  // "…, with four things due and two overdue."
  const withTail = (lead: string) => {
    if (!due && !over) { parts.push(lead + "."); return; }
    parts.push(lead + ", with ");
    if (due) parts.push({ kind: "due", text: `${countOf(due, "thing")} due` });
    if (due && over) parts.push(" and ");
    if (over) parts.push({ kind: "overdue", text: due ? `${countWord(over)} overdue` : `${countOf(over, "thing")} overdue` });
    parts.push(".");
  };

  if (evening) {
    const finished = tasks.filter((t) => doneToday(t, today)).length;
    withTail(finished > 0 ? `You finished ${countOf(finished, "thing")} today` : "The working day's done");
  } else {
    const free = freeMinutes(tasks, events, nowMin);
    if (free < BOOKED_UNDER) withTail("Your day is fully booked");
    else if (!due && !over) {
      parts.push("Nothing's due today — ", { kind: "free", text: `${fmtDuration(free)} free` }, ".");
    } else {
      parts.push("You have ", { kind: "free", text: `${fmtDuration(free)} free` });
      if (due && over) parts.push(", ", { kind: "due", text: `${countOf(due, "thing")} due` }, " and ", { kind: "overdue", text: `${countWord(over)} overdue` }, ".");
      else if (due) parts.push(" and ", { kind: "due", text: `${countOf(due, "thing")} due` }, ".");
      else parts.push(" and ", { kind: "overdue", text: `${countOf(over, "thing")} overdue` }, ".");
    }
    const top = topTask(tasks, today, me);
    if (top) parts.push(" Start with ", { kind: "task", text: shorten(top.title), taskId: top.id }, `: ${reasonFor(top, allTasks ?? given, today)}.`);
  }

  if (riskCount > 0) {
    parts.push(" ", { kind: "risks", text: capitalise(`${countOf(riskCount, "risk")} ${riskCount === 1 ? "needs" : "need"} a look`) }, ".");
  }

  // merge neighbouring strings so the parts stay few and readable
  const merged: BriefPart[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (typeof p === "string" && typeof last === "string") merged[merged.length - 1] = last + p;
    else merged.push(p);
  }
  const trimmed = merged.map((p, i) => (i === merged.length - 1 && typeof p === "string" ? p.trimEnd() : p));
  return { parts: trimmed, plain: trimmed.map((p) => (typeof p === "string" ? p : p.text)).join("") };
}

/** "Places 4 tasks · 2h 15m" under Plan my day (a data line, so digits). */
export function placesHint(n: number, minutes: number): string {
  return `Places ${n} ${n === 1 ? "task" : "tasks"} · ${fmtDuration(minutes)}`;
}
