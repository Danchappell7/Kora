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
  dayMonth, daysBetween, durOf, energyKindOf, fmtDuration, fmtTime, fmtTimeRange, isMine, parseDay, weekdayShort, isPlaced, mergeIntervals, totalMinutes, type Interval,
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

/* ============================================================
   Today's brief, Companion-grade: Kanbo speaks first.
   composeTodayBrief writes the card Today opens on: a greeting, a
   headline naming the day's one big thing (the focus phrase is the
   gradient, and opens the task), two or three sentences of why with
   the people, tasks and times as chips, the day in fact pills, and
   "How I got here" (the facts it was built from). Deterministic: the
   template IS the brief; the variants follow the clock and the work
   (morning, afternoon, evening, an empty day, Monday's preview of
   the week, an overloaded day).
   ============================================================ */

export type TodayVariant = "morning" | "afternoon" | "evening" | "empty" | "monday" | "overloaded";

/** A live part of the brief: the view draws each as a chip or a button. */
export type BriefEntity =
  | { kind: "focus"; text: string; taskId: string }
  | { kind: "task"; text: string; taskId: string; status: Task["status"] }
  | { kind: "person"; text: string; memberId: string }
  | { kind: "project"; text: string; projectId: string }
  | { kind: "time"; text: string }
  | { kind: "risks"; text: string };
export type BriefSpan = string | BriefEntity;

export type BriefFactKind = "meetings" | "free" | "due" | "overdue" | "slipping" | "team";
/** One of the day's numbers ("3 meetings"): `value` is the figure (mono), `label` the words after it. */
export interface BriefFact { kind: BriefFactKind; n: number; value: string; label: string; tone?: "warn" | "signal" }
/** A group of the facts the brief was built from ("How I got here"). */
export interface BriefWhy { label: string; items: string[] }

export interface TodayBrief {
  variant: TodayVariant;
  /** "Morning, Daniel." */
  greeting: string;
  /** the rest of the headline; its `focus` entity is the day's one big thing */
  headline: BriefSpan[];
  /** two or three sentences, with chips */
  prose: BriefSpan[];
  /** the day in numbers; zeros are left out */
  facts: BriefFact[];
  why: BriefWhy[];
  /** the one big thing */
  focusTaskId?: string;
  /** the stretch the brief suggests for it */
  slot?: Interval;
  /** the whole brief as one string (for screen readers and tests) */
  plain: string;
}

export interface TodayBriefInput extends BriefInput {
  /** workspace people, for the names in "unblocks Maya" */
  members?: { id: string; name: string }[];
  /** the projects the one big thing may belong to (its chip in "due today for …"); Personal is never named */
  projects?: { id: string; name: string }[];
}

const FOCUS_MAX = 44;
const firstName = (s?: string) => (s && !s.includes("@") ? s.trim().split(/\s+/)[0] ?? "" : "");
/** "tomorrow", "on Friday" (within the week), else "on 12 Oct". */
function dueWords(iso: string, today: string): string {
  const n = daysBetween(today, iso);
  const d = parseDay(iso);
  if (n === 1) return "tomorrow";
  if (d && n > 1 && n < 7) return "on " + d.toLocaleDateString("en-GB", { weekday: "long" });
  return d ? `on ${dayMonth(d)}` : iso;
}
/** A task's title as a phrase inside a sentence: shortened, its first letter lowered
 *  unless it starts an acronym or a name ("Finalise the deck" → "finalise the deck"). */
export function focusPhrase(title: string): string {
  const t = title.trim().replace(/[.!\s]+$/, "");
  const cut = t.length > FOCUS_MAX ? t.slice(0, FOCUS_MAX - 1).trimEnd() + "…" : t;
  return /^[A-Z][a-z]/.test(cut) && !/^(I|I'm|I've)\b/.test(cut) ? cut.charAt(0).toLowerCase() + cut.slice(1) : cut;
}
const timeOf = (t: Task) => (t.dueTime ? t.dueTime.slice(0, 5) : "");
const plusMore = (items: string[], max = 3) => (items.length > max ? [...items.slice(0, max), `and ${items.length - max} more`] : items);
const dayAfter = (iso: string, n = 1) => { const d = parseDay(iso) ?? new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Open tasks of yours whose date has moved later than first planned. */
export function slippingTasks(tasks: Task[], me?: string | null): Task[] {
  return tasks.filter((t) => isOpen(t) && !t.parentId && isMine(t, me) && !!t.dueDate && !!t.originalDueDate && day10(t.dueDate) > day10(t.originalDueDate));
}

/** Open work of yours that someone else gave you since yesterday. */
export function newFromTeam(tasks: Task[], today: string, me?: string | null): Task[] {
  if (!me) return [];
  const since = dayAfter(today, -1);
  return tasks.filter((t) => isOpen(t) && !t.parentId && t.assigneeId === me && !!t.createdBy && t.createdBy !== me && day10(t.createdAt) >= since);
}

/** Your open tasks that someone else's open work waits on, with who is waiting: most held up first. */
export function waitingOnYou(all: Task[], me?: string | null): { task: Task; waiting: Task[] }[] {
  if (!me) return [];
  const byId = new Map(all.filter((t) => !t.archivedAt).map((t) => [t.id, t]));
  const held = new Map<string, Task[]>();
  for (const d of byId.values()) {
    if (!isOpen(d) || d.assigneeId === me || !d.assigneeId) continue;
    for (const dep of d.dependencies ?? []) {
      const b = byId.get(dep);
      if (!b || !isOpen(b) || b.assigneeId !== me) continue;
      const a = held.get(b.id) ?? []; a.push(d); held.set(b.id, a);
    }
  }
  return [...held.entries()].map(([id, waiting]) => ({ task: byId.get(id)!, waiting }))
    .sort((x, y) => y.waiting.length - x.waiting.length || (day10(x.task.dueDate) || "9999").localeCompare(day10(y.task.dueDate) || "9999"));
}

/** The clearest stretch for `dur` minutes still ahead today: the longest free gap that
 *  holds it, finishing by `by` (a deadline today) when one does. */
export function clearestStretch(tasks: Task[], events: CalEvent[], nowMin: number, dur: number, by?: number | null): Interval | null {
  const all = freeGaps(tasks, events, Math.ceil(nowMin / 5) * 5);
  const pick = (gaps: Interval[]) => {
    const fit = gaps.filter((g) => g.end - g.start >= dur);
    if (!fit.length) return null;
    const best = fit.reduce((a, g) => (g.end - g.start > a.end - a.start ? g : a));
    return { start: best.start, end: best.start + dur };
  };
  if (by != null) {
    const before = pick(all.map((g) => ({ start: g.start, end: Math.min(g.end, by) })).filter((g) => g.end > g.start));
    if (before) return before;
  }
  return pick(all);
}

/** Today's brief card (see the section note above). */
export function composeTodayBrief({ tasks: given, events, nowMin, today, userName, riskCount = 0, allTasks, me, members = [], projects = [] }: TodayBriefInput): TodayBrief {
  const all = allTasks ?? given;
  const name = firstName(userName);
  const nameOf = (id: string) => firstName(members.find((m) => m.id === id)?.name) || "a teammate";
  const scope = given.filter((t) => isTodaysScope(t, me));
  const open = scope.filter(isOpen);
  const dueToday = open.filter((t) => isDueToday(t, today));
  const overdue = open.filter((t) => isOverdue(t, today));
  const todaysWork = open.filter((t) => isDueToday(t, today) || isOverdue(t, today) || !!t.planToday || isPlaced(t));
  const meetings = events.filter((e) => e.kind === "meeting");
  const free = freeMinutes(scope, events, nowMin);
  const slipping = slippingTasks(scope, me);
  const team = newFromTeam(scope, today, me);
  const top = topTask(scope, today, me);
  const waits = waitingOnYou(all, me);
  const unplacedNeed = todaysWork.filter((t) => !isPlaced(t)).reduce((a, t) => a + durOf(t), 0);
  const weekday = parseDay(today)?.getDay();
  const hour = nowMin / 60;

  const variant: TodayVariant = nowMin >= WORK_END ? "evening"
    : todaysWork.length === 0 ? "empty"
    : unplacedNeed >= 60 && unplacedNeed > free + 30 ? "overloaded"
    : weekday === 1 && hour < 12 ? "monday"
    : hour < 12 ? "morning" : "afternoon";

  const part = variant === "evening" ? "Evening" : hour < 12 ? "Morning" : "Afternoon";
  const greeting = name ? `${part}, ${name}.` : `Good ${part.toLowerCase()}.`;
  const headline: BriefSpan[] = [];
  const prose: BriefSpan[] = [];
  const focus: BriefEntity | null = top ? { kind: "focus", text: focusPhrase(top.title), taskId: top.id } : null;
  let slot: Interval | undefined;

  // why the one big thing, and when: "It's due at 17:00 and three of the team's tasks are waiting on it, so I'd give it your clearest stretch, 10:15–11:45, before lunch."
  const whyTop = (t: Task) => {
    const held = all.filter((x) => isOpen(x) && x.id !== t.id && !x.archivedAt && (x.dependencies ?? []).includes(t.id));
    const others = held.filter((x) => x.assigneeId && x.assigneeId !== me);
    const bits: string[] = [];
    if (isDueToday(t, today) && timeOf(t)) bits.push(`it's due at ${timeOf(t)}`);
    else if (isOverdue(t, today)) bits.push(`it's been overdue since ${sinceLabel(t.dueDate!, today)}`);
    else if (isDueToday(t, today)) bits.push("it's due today");
    if (held.length) bits.push(`${countWord(held.length)} of ${others.length === held.length ? "the team's" : "your"} tasks ${held.length === 1 ? "is" : "are"} waiting on it`);
    if (!bits.length) {
      const ai = cleanReason(t.aiReason);
      bits.push(ai ? `Kanbo put it first: ${ai}` : t.planToday ? "it's on today's list" : "it's your highest priority");
    }
    // "It's due at 17:00 for [Q3 Product Launch] and three of …": the deadline names its project
    const proj = t.projectId && t.projectId !== "p-personal" ? projects.find((p) => p.id === t.projectId) : undefined;
    const dated = bits.length > 0 && /^it's (due|been overdue)/.test(bits[0]);
    if (proj && dated) {
      prose.push(capitalise(bits[0]) + " for ", { kind: "project", text: proj.name, projectId: proj.id });
      if (bits.length > 1) prose.push(" and " + bits.slice(1).join(" and "));
    } else prose.push(capitalise(bits.join(" and ")));
    if (isPlaced(t)) {
      prose.push(", and it's on your day at ", { kind: "time", text: fmtTimeRange(t.scheduled!, t.scheduled! + durOf(t)) }, ".");
      return;
    }
    const s = clearestStretch(scope, events, nowMin, durOf(t), isDueToday(t, today) ? dueMinutes(t) : null);
    if (s) {
      slot = s;
      prose.push(", so I'd give it your clearest stretch, ", { kind: "time", text: fmtTimeRange(s.start, s.end) }, s.end <= 12 * 60 ? ", before lunch." : ".");
    } else {
      prose.push(`, but there's no free stretch of ${fmtDuration(durOf(t))} left today.`);
    }
  };
  // "Define design tokens v2 is waiting on your review: 20m there unblocks Maya."
  const whoWaits = (skipId?: string) => {
    const w = waits.find((x) => x.task.id !== skipId);
    if (!w) return;
    const d = w.waiting[0];
    const review = w.task.status === "review";
    prose.push(" ", { kind: "task", text: w.task.title.length > TITLE_MAX ? shorten(w.task.title) : w.task.title, taskId: w.task.id, status: w.task.status },
      review ? " is waiting on your review. " : " is waiting on you. ",
      `${fmtDuration(durOf(w.task))} there unblocks `, { kind: "person", text: nameOf(d.assigneeId), memberId: d.assigneeId },
      w.waiting.length > 1 ? ` and ${countOf(w.waiting.length - 1, "other task")}.` : ".");
  };

  if (variant === "evening") {
    const finished = scope.filter((t) => doneToday(t, today)).length;
    headline.push(finished > 0 ? `You finished ${countOf(finished, "thing")} today.` : "The working day's done.");
    const left = todaysWork.length;
    prose.push(left > 0
      ? `${capitalise(countOf(left, "thing"))} ${left === 1 ? "is" : "are"} still open. Shut down to close the day and pick tomorrow's first thing.`
      : "Everything for today is done. Shut down to close the day and pick tomorrow's first thing.");
  } else if (variant === "empty") {
    headline.push("A clear day. Want to pull something forward?");
    const next = open.filter((t) => !!t.dueDate && day10(t.dueDate) > today && day10(t.dueDate) <= dayAfter(today, 14))
      .sort((a, b) => day10(a.dueDate).localeCompare(day10(b.dueDate)) || (b.aiScore ?? 0) - (a.aiScore ?? 0))[0];
    if (next) prose.push("Nothing's due and nothing's planned. The nearest thing is ", { kind: "task", text: shorten(next.title), taskId: next.id, status: next.status }, `, due ${dueWords(next.dueDate!, today)}.`);
    else prose.push("Nothing's due and nothing's planned. Capture what's on your mind, or enjoy the room.");
    if (free >= BOOKED_UNDER) prose.push(` You've ${fmtDuration(free)} free.`);
  } else if (variant === "overloaded") {
    headline.push("Something has to give. Start with ", focus!, ".");
    whyTop(top!);
    // what to move: the lowest-ranked unplaced work until the rest fits
    const movable = todaysWork.filter((t) => !isPlaced(t) && t.id !== top!.id && !t.dueTime)
      .sort((a, b) => rank(a) - rank(b) || (a.aiScore ?? 0) - (b.aiScore ?? 0) || (day10(b.dueDate) || "9999").localeCompare(day10(a.dueDate) || "9999"));
    const move: Task[] = [];
    let need = unplacedNeed;
    for (const t of movable) { if (need <= free) break; move.push(t); need -= durOf(t); }
    prose.push(` You've ${fmtDuration(unplacedNeed)} of work and ${fmtDuration(free)} free.`);
    if (move.length) {
      prose.push(" To fit, I'd move ", { kind: "task", text: shorten(move[0].title), taskId: move[0].id, status: move[0].status },
        move.length > 1 ? ` and ${countOf(move.length - 1, "other")} to tomorrow.` : " to tomorrow.");
    }
  } else {
    // morning, afternoon, Monday: the one big thing
    headline.push(variant === "monday" ? "New week. One big thing today: " : variant === "afternoon" ? "One big thing this afternoon: " : "One big thing today: ", focus!, ".");
    whyTop(top!);
    whoWaits(top!.id);
    if (variant === "monday") {
      const weekEnd = dayAfter(today, 6);
      const week = open.filter((t) => !!t.dueDate && day10(t.dueDate) > today && day10(t.dueDate) <= weekEnd);
      const ms = week.filter((t) => t.isMilestone).sort((a, b) => day10(a.dueDate).localeCompare(day10(b.dueDate)))[0];
      if (week.length) {
        prose.push(` This week: ${countOf(week.length, "more thing")} due`);
        if (ms) prose.push(", and ", { kind: "task", text: shorten(ms.title), taskId: ms.id, status: ms.status }, ` lands ${dueWords(ms.dueDate!, today)}`);
        prose.push(".");
      }
    }
  }
  if (riskCount > 0 && variant !== "evening") {
    prose.push(" ", { kind: "risks", text: capitalise(`${countOf(riskCount, "risk")} ${riskCount === 1 ? "needs" : "need"} a look`) }, ".");
  }

  const facts: BriefFact[] = [];
  const fact = (kind: BriefFactKind, n: number, value: string, label: string, tone?: BriefFact["tone"]) => { if (n > 0) facts.push({ kind, n, value, label, tone }); };
  fact("meetings", meetings.length, String(meetings.length), meetings.length === 1 ? "meeting" : "meetings");
  if (variant !== "evening") fact("free", free, fmtDuration(free), "free");
  fact("due", dueToday.length, String(dueToday.length), "due today");
  fact("overdue", overdue.length, String(overdue.length), "overdue", "signal");
  fact("slipping", slipping.length, String(slipping.length), "slipping", "warn");
  fact("team", team.length, String(team.length), "new from the team");

  const withTime = (t: Task) => (timeOf(t) ? `${t.title} (${timeOf(t)})` : t.title);
  const why: BriefWhy[] = [{ label: "Due today", items: dueToday.length ? plusMore(dueToday.map(withTime)) : ["Nothing"] }];
  if (top) {
    const held = all.filter((x) => isOpen(x) && !x.archivedAt && x.id !== top.id && (x.dependencies ?? []).includes(top.id));
    if (held.length) why.push({ label: "Waiting on this", items: plusMore(held.map((x) => x.assigneeId && x.assigneeId !== me ? `${x.title} (${nameOf(x.assigneeId)})` : x.title)) });
  }
  if (waits.length) why.push({ label: "Waiting on you", items: plusMore(waits.map((w) => `${w.task.title} → ${w.waiting[0].title} (${nameOf(w.waiting[0].assigneeId)})`)) });
  why.push({ label: "Your calendar", items: meetings.length ? plusMore(meetings.map((m) => `${m.title} ${fmtTime(m.start)}`), 4) : ["No meetings today"] });

  // neighbouring strings merge, so the parts stay few (and a lone "." never floats free)
  const merge = (list: BriefSpan[]) => list.reduce<BriefSpan[]>((out, x) => {
    const last = out[out.length - 1];
    if (typeof x === "string" && typeof last === "string") out[out.length - 1] = last + x; else out.push(x);
    return out;
  }, []);
  const head = merge(headline), body = merge(prose);
  const text = (s: BriefSpan) => (typeof s === "string" ? s : s.text);
  const plain = [greeting, head.map(text).join(""), body.map(text).join("").trim()].filter(Boolean).join(" ");
  return { variant, greeting, headline: head, prose: body, facts, why, focusTaskId: top?.id, slot, plain };
}

/* ---------- after hours: tomorrow, in brief ---------- */

export interface TomorrowPreview {
  /** YYYY-MM-DD: tomorrow */
  day: string;
  /** YYYY-MM-DD: today, the day it was read on */
  today: string;
  /** tomorrow's first meeting */
  firstMeeting?: CalEvent;
  meetings: number;
  /** what Kanbo would put first tomorrow (at most three) */
  top: Task[];
}

/** Once the working day is over: tomorrow's first meeting and the three things
 *  Kanbo would start it with (still open and due by tomorrow, or on today's list). */
export function tomorrowPreview(tasks: Task[], tomorrowEvents: CalEvent[], today: string, me?: string | null): TomorrowPreview {
  const tmr = dayAfter(today, 1);
  const meetings = tomorrowEvents.filter((e) => e.kind === "meeting").sort((a, b) => a.start - b.start);
  const pool = tasks.filter((t) => isOpen(t) && isTodaysScope(t, me) && (!!t.planToday || (!!t.dueDate && day10(t.dueDate) <= tmr)));
  const top = [...pool].sort((a, b) => (day10(a.dueDate) || "9999").localeCompare(day10(b.dueDate) || "9999")
    || (b.aiScore ?? 0) - (a.aiScore ?? 0) || rank(b) - rank(a)).slice(0, 3);
  return { day: tmr, today, firstMeeting: meetings[0], meetings: meetings.length, top };
}
