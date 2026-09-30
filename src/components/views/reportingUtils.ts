/* ============================================================
   KANBO — pure helpers for the reporting & manager views
   (Analytics, Reports, Workload, Goals, Portfolios, Automations).
   Kept free of JSX so the maths is unit-tested directly.
   ============================================================ */
import { useRef } from "react";
import type { Task, Goal, TagDef } from "../../data/types";
import { csvCell, downloadCsv as downloadCsvText, toCsv } from "../../lib/exportTasks";

export const DAY_MS = 86400000;
export const round1 = (n: number): number => Math.round(n * 10) / 10;
/** "12.5h" — hours rounded to one decimal (no float noise like 40.300000000000004). */
export const fmtHours = (n: number): string => `${round1(n)}h`;

/* ---------------- CSV ---------------- */

// One formula-injection guard for every CSV Kanbo writes: csvCell quotes the
// value and gives anything a spreadsheet would run as a formula (leading
// = + - @ tab or CR) a leading apostrophe; plain numbers ("-3", "4.5") are
// left alone. It lives with the task export in lib/exportTasks.
export { csvCell };
export const csvText = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

/** Save rows as a CSV file (UTF-8 BOM so Excel reads accented names; the object URL is revoked late so Safari/Firefox don't cancel the download). */
export function downloadCsv(rows: unknown[][], filename: string): void {
  downloadCsvText(filename, toCsv(rows));
}

/* ---------------- dates ---------------- */

/** Local calendar day (00:00) for a date-only ISO ("2026-09-30") or a timestamp.
 *  Timestamps are converted to the viewer's own day, so work finished at 00:30
 *  BST on a Monday lands on Monday, not the previous (UTC) Sunday. */
export function localDay(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, dd] = iso.split("-").map(Number);
    d = new Date(y, m - 1, dd);
  } else {
    const t = new Date(iso);
    if (isNaN(t.getTime())) return null;
    d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }
  return isNaN(d.getTime()) ? null : d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14 Sep" — compact day + month that never wraps in chart axes (en-GB would give "Sept"). */
export const fmtDayMonth = (d: Date): string => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

export function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** Monday 00:00 of the week containing `d` (UK convention: weeks start on Monday). */
export function startOfWeekMon(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** Whole local days from `a` to `b` (never negative). */
export function daysBetween(a: string, b: string): number {
  const da = localDay(a), db = localDay(b);
  if (!da || !db) return 0;
  return Math.max(0, Math.round((db.getTime() - da.getTime()) / DAY_MS));
}

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const calendarDays = (a: Date, b: Date): number => (b < a ? 0 : Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1);
/** Mon–Fri days between a and b inclusive (arithmetic, so a year-long task costs nothing). */
export function workdays(a: Date, b: Date): number {
  const days = calendarDays(a, b);
  if (!days) return 0;
  const full = Math.floor(days / 7);
  let n = full * 5;
  for (let i = 0, dow = a.getDay(); i < days % 7; i++) { const x = (dow + i) % 7; if (x !== 0 && x !== 6) n++; }
  return n;
}

/* ---------------- Reports: weekly throughput ---------------- */

export interface WeeklyThroughput {
  /** week starts, oldest → newest; the LAST entry is the current (partial) week */
  weekStarts: Date[];
  created: number[];
  completed: number[];
  /** burnup lines — seeded with everything created/completed before the window */
  cumCreated: number[];
  cumCompleted: number[];
  /** avg completed per FULL week (the current partial week is left out) */
  velocity: number;
  /** later half of the full weeks minus the earlier half (tasks/week) */
  trend: number;
  totalCreated: number;
  totalDone: number;
}

/** `fullWeeks` complete Monday-start weeks plus the current week so far. */
export function weeklyThroughput(tasks: Task[], fullWeeks: number, today: Date): WeeklyThroughput {
  const thisWk = startOfWeekMon(today);
  const weekStarts = Array.from({ length: fullWeeks + 1 }, (_, i) => addDays(thisWk, -(fullWeeks - i) * 7));
  const n = weekStarts.length;
  const created: number[] = new Array(n).fill(0);
  const completed: number[] = new Array(n).fill(0);
  let baseCreated = 0, baseCompleted = 0;
  const bucketOf = (d: Date): number => { for (let i = n - 1; i >= 0; i--) if (d >= weekStarts[i]) return i; return -1; };
  for (const t of tasks) {
    const c = localDay(t.createdAt);
    // no creation date → treat as existing before the window, so the scope
    // line always contains every task that can appear as completed
    const cb = c ? bucketOf(c) : -1;
    if (cb >= 0) created[cb]++; else baseCreated++;
    if (t.status !== "done") continue;
    const d = localDay(t.completedAt);
    // a task can't finish before it existed (imports can carry older dates);
    // done-without-a-date is counted where it was created
    let b = d ? bucketOf(d) : cb;
    if (b < cb) b = cb;
    if (b >= 0) completed[b]++; else baseCompleted++;
  }
  let cc = baseCreated, cd = baseCompleted;
  const cumCreated = created.map((v) => (cc += v));
  const cumCompleted = completed.map((v) => (cd += v));
  const full = completed.slice(0, fullWeeks);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const velocity = fullWeeks > 0 ? round1(sum(full) / fullWeeks) : 0;
  const half = Math.floor(fullWeeks / 2);
  const trend = half > 0 ? round1(sum(full.slice(fullWeeks - half)) / half - sum(full.slice(0, half)) / half) : 0;
  return { weekStarts, created, completed, cumCreated, cumCompleted, velocity, trend, totalCreated: sum(created), totalDone: sum(completed) };
}

/* ---------------- Insights: scope, facts and sentences ---------------- */

/** Whose work Insights is about: yours (assigned to you, or shared with you
 *  as a collaborator) or the whole workspace's. */
export type InsightsScope = "me" | "team";

/** The tasks in a scope. Without a user id there's no "me" to filter by. */
export function scopeTasks(tasks: Task[], scope: InsightsScope, userId?: string): Task[] {
  if (scope !== "me" || !userId) return tasks;
  return tasks.filter((t) => t.assigneeId === userId || (t.collaborators ?? []).includes(userId));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Wed 30 Sep" (en-GB order, no comma, never "Sept"). */
export const fmtDay = (d: Date): string => `${WEEKDAYS[d.getDay()]} ${fmtDayMonth(d)}`;

/** "1h 20m", "45m", "2h" — durations the way the rest of Kanbo writes them. */
export function fmtMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}

const plural = (n: number, one: string, many = one + "s") => (n === 1 ? one : many);
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** completed on or before its due day (a timestamp is read as the viewer's own day) */
const landedOnTime = (t: Task) => {
  const done = localDay(t.completedAt), due = localDay(t.dueDate);
  return !!done && !!due && done <= due;
};

/** The numbers the Overview's KPI sentence is built from. "Past week" is today
 *  and the six days before it, the same seven days the Completed chart shows. */
export interface OverviewFacts {
  finished: number;
  /** of `finished`, how many had a due date */
  withDue: number;
  onTime: number;
  /** on time as a share of the finished tasks that had a due date; null when none did */
  onTimePct: number | null;
  overdue: number;
  blocked: number;
  open: number;
  total: number;
}

export function overviewFacts(tasks: Task[], today: Date): OverviewFacts {
  const end = midnight(today), start = addDays(end, -6);
  let finished = 0, withDue = 0, onTime = 0, overdue = 0, blocked = 0, open = 0;
  for (const t of tasks) {
    if (t.status === "done") {
      const d = localDay(t.completedAt);
      if (!d || d < start || d > end) continue;
      finished++;
      if (t.dueDate) { withDue++; if (landedOnTime(t)) onTime++; }
      continue;
    }
    open++;
    if (t.status === "blocked") blocked++;
    const due = localDay(t.dueDate);
    if (due && due < end) overdue++;
  }
  return { finished, withDue, onTime, onTimePct: withDue ? Math.round((onTime / withDue) * 100) : null, overdue, blocked, open, total: tasks.length };
}

/** A sentence as text runs and figures, so a view can set the figures in bold
 *  (and colour the ones that need attention) without re-parsing the words. */
export type Phrase = Array<string | { n: string; tone?: "signal" }>;

/** "In the past week you finished 14 tasks — 67% on time. 3 are overdue and 1 is blocked."
 *  Every figure appears once. `who` is "you" (Me scope, or a Personal workspace)
 *  or "team"; `focusMin` (yours, today) is added in the "you" voice only. */
export function kpiSentence(f: OverviewFacts, who: "you" | "team", focusMin = 0): Phrase {
  const out: Phrase = [];
  if (f.finished > 0) {
    out.push(`In the past week ${who === "you" ? "you" : "the team"} finished `, { n: String(f.finished) }, ` ${plural(f.finished, "task")}`);
    if (f.onTimePct != null) out.push(" — ", { n: `${f.onTimePct}%` }, " on time.");
    else out.push(".");
  } else {
    out.push(who === "you" ? "You haven't finished anything in the past week." : "Nothing has been finished in the past week.");
  }
  // "3 are overdue" follows a sentence about tasks; after "nothing finished" it needs the noun
  const noun = (n: number) => (f.finished > 0 ? "" : ` ${plural(n, "task")}`);
  const is = (n: number) => (n === 1 ? "is" : "are");
  if (f.overdue > 0 && f.blocked > 0) {
    out.push(" ", { n: String(f.overdue), tone: "signal" }, `${noun(f.overdue)} ${is(f.overdue)} overdue and `, { n: String(f.blocked), tone: "signal" }, ` ${is(f.blocked)} blocked.`);
  } else if (f.overdue > 0) {
    out.push(" ", { n: String(f.overdue), tone: "signal" }, `${noun(f.overdue)} ${is(f.overdue)} overdue.`);
  } else if (f.blocked > 0) {
    out.push(" ", { n: String(f.blocked), tone: "signal" }, `${noun(f.blocked)} ${is(f.blocked)} blocked.`);
  } else if (f.open > 0) {
    out.push(" Nothing is overdue or blocked.");
  } else if (f.total > 0) {
    out.push(" Everything is done.");
  }
  if (who === "you" && focusMin > 0) out.push(" You've logged ", { n: fmtMinutes(focusMin) }, " of focus today.");
  return out;
}

/** The plain text of a phrase (tests, aria, copy). */
export const phraseText = (p: Phrase): string => p.map((x) => (typeof x === "string" ? x : x.n)).join("");

/* ---------------- Insights: the weekly summary ---------------- */

/** What the Trends weekly summary is written from: the past seven days
 *  (today and the six before it) plus what's due in the next seven. */
export interface WeeklyFacts {
  from: Date;
  to: Date;
  /** completed in the window, newest first */
  finished: Task[];
  withDue: number;
  onTime: number;
  /** open and under way (in progress or in review), most urgent first */
  inFlight: Task[];
  /** open and past due, the longest-overdue first */
  overdue: Task[];
  blocked: Task[];
  /** open and due from today to a week out, soonest first */
  dueSoon: Task[];
  /** created in the window */
  created: number;
  /** the project with the most completions in the window */
  topProject: { id: string; n: number } | null;
  /** how many tasks the summary looked at */
  total: number;
}

const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const byUrgency = (a: Task, b: Task) =>
  (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");

export function weeklyFacts(tasks: Task[], today: Date): WeeklyFacts {
  const to = midnight(today), from = addDays(to, -6), soon = addDays(to, 7);
  const finished: Task[] = [], inFlight: Task[] = [], overdue: Task[] = [], blocked: Task[] = [], dueSoon: Task[] = [];
  let withDue = 0, onTime = 0, created = 0;
  const perProject = new Map<string, number>();
  for (const t of tasks) {
    const c = localDay(t.createdAt);
    if (c && c >= from && c <= to) created++;
    if (t.status === "done") {
      const d = localDay(t.completedAt);
      if (!d || d < from || d > to) continue;
      finished.push(t);
      perProject.set(t.projectId, (perProject.get(t.projectId) ?? 0) + 1);
      if (t.dueDate) { withDue++; if (landedOnTime(t)) onTime++; }
      continue;
    }
    if (t.status === "blocked") blocked.push(t);
    else if (t.status === "progress" || t.status === "review") inFlight.push(t);
    const due = localDay(t.dueDate);
    if (due && due < to) overdue.push(t);
    else if (due && due <= soon) dueSoon.push(t);
  }
  finished.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  inFlight.sort(byUrgency);
  blocked.sort(byUrgency);
  overdue.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || byUrgency(a, b));
  dueSoon.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || byUrgency(a, b));
  let topProject: WeeklyFacts["topProject"] = null;
  perProject.forEach((n, id) => { if (!topProject || n > topProject.n) topProject = { id, n }; });
  return { from, to, finished, withDue, onTime, inFlight, overdue, blocked, dueSoon, created, topProject, total: tasks.length };
}

const quote = (s: string) => `“${s.trim()}”`;
const dueLabel = (t: Task, today: Date): string => {
  const d = localDay(t.dueDate);
  if (!d) return "";
  const n = Math.round((d.getTime() - midnight(today).getTime()) / DAY_MS);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : `on ${fmtDay(d)}`;
};

/** The on-device weekly summary: four short markdown bullets (the same shape
 *  the AI writes) covering what finished, what's under way, what needs
 *  attention and what's next. Subject-less, so it reads right in Me and Team. */
export function weeklySummaryText(f: WeeklyFacts, projectName: (id: string) => string | undefined): string {
  const lines: string[] = [];
  const n = f.finished.length;
  if (n) {
    let line = `**Finished ${n} ${plural(n, "task")}**`;
    if (f.withDue === n) line += `, ${f.onTime === n ? (n === 1 ? "on time" : "all on time") : `${f.onTime} on time`}`;
    else if (f.withDue > 0) line += `; ${f.onTime} of the ${f.withDue} with a due date landed on time`;
    const top = f.topProject ? projectName(f.topProject.id) : undefined;
    line += ".";
    if (top && f.topProject && f.topProject.n > 1 && f.topProject.n < n) line += ` ${top} moved most, with ${f.topProject.n} done.`;
    else if (top && f.topProject && f.topProject.n === n && n > 1) line += ` All of it in ${top}.`;
    lines.push(line);
  } else {
    lines.push("**Nothing finished** in the past 7 days.");
  }
  if (f.inFlight.length) {
    const k = f.inFlight.length;
    lines.push(`**Under way:** ${k} ${plural(k, "task")}${k > 1 ? ", led by" : ":"} ${quote(f.inFlight[0].title)}.`);
  }
  const od = f.overdue.length, bl = f.blocked.length;
  if (od || bl) {
    const parts: string[] = [];
    if (od) parts.push(`${od} overdue${od > 1 ? `, the oldest ${quote(f.overdue[0].title)}` : ` (${quote(f.overdue[0].title)})`}`);
    if (bl) parts.push(`${bl} blocked${bl > 1 ? "" : ` (${quote(f.blocked[0].title)})`}`);
    lines.push(`**Needs attention:** ${parts.join(od > 1 && bl ? "; " : " and ")}.`);
  } else {
    lines.push("**Needs attention:** nothing overdue or blocked.");
  }
  const s = f.dueSoon.length;
  lines.push(s
    ? `**Next 7 days:** ${s} ${plural(s, "task")} due, starting with ${quote(f.dueSoon[0].title)} ${dueLabel(f.dueSoon[0], f.to)}.`
    : "**Next 7 days:** nothing due yet.");
  return lines.map((l) => `- ${l}`).join("\n");
}

/** The facts behind a summary, one per line, for its "How I got here" list. */
export function weeklySummaryDetails(f: WeeklyFacts): string[] {
  const n = f.finished.length;
  return [
    `${n} finished between ${fmtDay(f.from)} and ${fmtDay(f.to)}${f.withDue ? `, ${f.onTime} of ${f.withDue} on time` : ""}`,
    `${f.inFlight.length} under way, ${f.blocked.length} blocked`,
    `${f.overdue.length} overdue`,
    `${f.dueSoon.length} due in the next 7 days`,
    `${f.created} created in the same 7 days`,
  ];
}

/** Markdown bullets as plain text, for the clipboard and the PDF. */
export const plainSummary = (md: string): string => md.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");

/* ---------------- Trends: cycle time ---------------- */

export const CYCLE_BUCKETS = [
  { label: "Same day", lo: 0, hi: 1 },
  { label: "1–2 days", lo: 1, hi: 3 },
  { label: "3–7 days", lo: 3, hi: 8 },
  { label: "1–2 weeks", lo: 8, hi: 15 },
  { label: "Over 2 weeks", lo: 15, hi: Infinity },
] as const;

/** How many cycle times (whole days, created → done) fall in each bucket. */
export function cycleHistogram(days: number[]): { label: string; n: number }[] {
  return CYCLE_BUCKETS.map((b) => ({ label: b.label, n: days.filter((d) => d >= b.lo && d < b.hi).length }));
}

/* ---------------- Workload ---------------- */

export interface TaskWeekLoad { hours: number; overdue: boolean }

/** How much of an open task's estimate lands in the week starting `weekStart`.
 *  - due date only → the whole estimate lands in the week it's due
 *  - start → due  → the estimate is spread evenly over the working days of the span
 *  - start date only → the whole estimate lands in the week it starts
 *  - late work that is still open is carried, in full, into the current week
 *  - work under way with no due date (started before this week) counts this
 *    week's share of the estimate, spread from its start to the end of this week
 *  - no dates at all → null (unscheduled; not counted against capacity) */
export function taskLoadInWeek(t: Task, weekStart: Date, today: Date): TaskWeekLoad | null {
  const due = localDay(t.dueDate), start = localDay(t.startDate);
  if (!due && !start) return null;
  const weekEnd = addDays(weekStart, 7);
  const lastDay = addDays(weekEnd, -1);
  const effort = Math.max(0, t.effortHours ?? 0);
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const overdue = !!due && due < todayMid;
  const isCurrent = todayMid >= weekStart && todayMid < weekEnd;
  const last = due ?? start!;
  // everything still open on a late task is due now, however long its span was
  if (overdue) return isCurrent ? { hours: effort, overdue } : null;
  // work already under way with no due date isn't late — it has no deadline.
  // Count this week's share of the estimate spread from its start to the end of
  // this week, not the whole estimate again every week it stays open.
  if (!due && start! < weekStart) {
    if (!isCurrent) return null;
    const span = workdays(start!, lastDay);
    return { hours: span > 0 ? effort * (workdays(weekStart, lastDay) / span) : effort, overdue: false };
  }
  if (last < weekStart) return isCurrent ? { hours: effort, overdue } : null;
  const first = start && due && start <= due ? start : last;
  if (first > lastDay) return null;
  if (first.getTime() === last.getTime()) return { hours: effort, overdue };
  const oa = first > weekStart ? first : weekStart;
  const ob = last < lastDay ? last : lastDay;
  const spanWork = workdays(first, last);
  const share = spanWork > 0 ? workdays(oa, ob) / spanWork : calendarDays(oa, ob) / calendarDays(first, last);
  if (share <= 0) return null;
  return { hours: effort * share, overdue };
}

export interface WorkloadRow {
  id: string;
  hours: number;
  items: { task: Task; hours: number; overdue: boolean }[];
  undated: number;
}

/** Open work per assignee for one week (see taskLoadInWeek). */
export function workloadForWeek(tasks: Task[], weekStart: Date, today: Date): { rows: Map<string, WorkloadRow>; undated: number } {
  const rows = new Map<string, WorkloadRow>();
  const row = (id: string) => { let r = rows.get(id); if (!r) { r = { id, hours: 0, items: [], undated: 0 }; rows.set(id, r); } return r; };
  let undated = 0;
  for (const t of tasks) {
    if (t.status === "done" || t.archivedAt) continue;
    const l = taskLoadInWeek(t, weekStart, today);
    if (!l) {
      if (!t.dueDate && !t.startDate) { undated++; row(t.assigneeId || "").undated++; }
      continue;
    }
    const r = row(t.assigneeId || "");
    r.hours += l.hours;
    r.items.push({ task: t, hours: l.hours, overdue: l.overdue });
  }
  rows.forEach((r) => r.items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.task.dueDate ?? "9999").localeCompare(b.task.dueDate ?? "9999")));
  return { rows, undated };
}

/* ---------------- Goals ---------------- */

/** Goals in tree order (each goal followed by its whole sub-tree), with depth.
 *  Goals whose parent is missing become top-level; goals caught in a parent
 *  cycle (A → B → A) are surfaced at the top level instead of disappearing. */
export function goalTree<G extends { id: string; parentId?: string }>(goals: G[]): { g: G; depth: number }[] {
  const ids = new Set(goals.map((g) => g.id));
  const kids = new Map<string, G[]>();
  const roots: G[] = [];
  for (const g of goals) {
    if (g.parentId && g.parentId !== g.id && ids.has(g.parentId)) {
      const a = kids.get(g.parentId) ?? []; a.push(g); kids.set(g.parentId, a);
    } else roots.push(g);
  }
  const out: { g: G; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (g: G, depth: number) => {
    if (seen.has(g.id)) return;
    seen.add(g.id); out.push({ g, depth });
    (kids.get(g.id) ?? []).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  goals.forEach((g) => { if (!seen.has(g.id)) walk(g, 0); });
  return out;
}

/** Every goal nested (at any depth) under `id`. */
export function goalDescendants<G extends { id: string; parentId?: string }>(goals: G[], id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const g of goals) if (g.parentId === cur && g.id !== id && !out.has(g.id)) { out.add(g.id); queue.push(g.id); }
  }
  return out;
}

export interface GoalProgress {
  pct: number;
  source: "project" | "subgoals" | "manual";
  children: number;
  /** average of the sub-goals, when there are any (shown alongside a goal's own number) */
  subPct?: number;
}

/** Progress for every goal:
 *  - a linked project drives it;
 *  - otherwise a goal that tracks its own number (current > 0) keeps current / target,
 *    so parents that already tracked a figure don't change when sub-goals are added;
 *  - otherwise a goal with sub-goals rolls up as their average (the untouched
 *    0 / 100 parent used to read 0% however far along its sub-goals were);
 *  - otherwise current / target. */
export function goalProgressMap(goals: Goal[], projectPct: (projectId: string) => number): Map<string, GoalProgress> {
  const ids = new Set(goals.map((g) => g.id));
  const kids = new Map<string, Goal[]>();
  for (const g of goals) if (g.parentId && g.parentId !== g.id && ids.has(g.parentId)) { const a = kids.get(g.parentId) ?? []; a.push(g); kids.set(g.parentId, a); }
  const memo = new Map<string, GoalProgress>();
  const visiting = new Set<string>();
  const manual = (g: Goal) => (g.target && g.target > 0 ? Math.max(0, Math.min(100, ((g.current ?? 0) / g.target) * 100)) : 0);
  const calc = (g: Goal): GoalProgress => {
    const hit = memo.get(g.id); if (hit) return hit;
    const children = kids.get(g.id) ?? [];
    let subPct: number | undefined;
    if (children.length && !visiting.has(g.id)) {
      visiting.add(g.id);
      const vals = children.filter((c) => !visiting.has(c.id)).map((c) => calc(c).pct);
      visiting.delete(g.id);
      if (vals.length) subPct = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    const n = children.length;
    const withSub = subPct === undefined ? {} : { subPct };
    let res: GoalProgress;
    if (g.projectId) res = { pct: projectPct(g.projectId), source: "project", children: n, ...withSub };
    else if (subPct !== undefined && !((g.current ?? 0) > 0)) res = { pct: subPct, source: "subgoals", children: n, subPct };
    else res = { pct: manual(g), source: "manual", children: n, ...withSub };
    memo.set(g.id, res);
    return res;
  };
  goals.forEach((g) => calc(g));
  memo.forEach((v, k) => memo.set(k, { ...v, pct: Math.round(v.pct), ...(v.subPct === undefined ? {} : { subPct: Math.round(v.subPct) }) }));
  return memo;
}

/* ---------------- Portfolios: auto health (mirrors the project overview) ---------------- */

export type HealthKind = "complete" | "on_track" | "at_risk" | "off_track";
export interface ProjectHealth { kind: HealthKind; label: string; detail: string; overdue: number; blocked: number; total: number; pct: number }

export function projectHealth(tasks: Task[], today: Date): ProjectHealth | null {
  const total = tasks.length;
  if (!total) return null;
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const done = tasks.filter((t) => t.status === "done").length;
  const overdue = tasks.filter((t) => { if (t.status === "done") return false; const d = localDay(t.dueDate); return !!d && d < todayMid; }).length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const pct = Math.round((done / total) * 100);
  const bits: string[] = [];
  if (overdue) bits.push(`${overdue} overdue`);
  if (blocked) bits.push(`${blocked} blocked`);
  const detail = bits.length ? bits.join(" · ") : "nothing overdue or blocked";
  if (pct === 100) return { kind: "complete", label: "Complete", detail: "all tasks done", overdue, blocked, total, pct };
  if (overdue >= 3 || overdue / total > 0.25 || (overdue >= 1 && blocked >= 2)) return { kind: "off_track", label: "Off track", detail, overdue, blocked, total, pct };
  if (overdue >= 1 || blocked >= 1) return { kind: "at_risk", label: "At risk", detail, overdue, blocked, total, pct };
  return { kind: "on_track", label: "On track", detail, overdue, blocked, total, pct };
}

/* ---------------- Automations: tag values ---------------- */

/** The tag id an "Add tag" action value refers to: the id itself, or — for
 *  rules saved before the tag picker, which stored free text — the one tag
 *  whose label matches (case-insensitive). null when there's no single match. */
export function resolveTagId(value: string, tags: Record<string, TagDef>): string | null {
  if (!value) return null;
  if (tags[value]) return value;
  const want = value.trim().toLowerCase();
  const hits = Object.entries(tags).filter(([, t]) => t.label.trim().toLowerCase() === want);
  return hits.length === 1 ? hits[0][0] : null;
}

/* ---------------- stable list order ---------------- */

/** Keeps a list in a stable order across realtime reloads: by `position` when
 *  set, otherwise in the order items were first seen this session. (Postgres
 *  returns just-updated rows in a different place, which reshuffled goals,
 *  rules and forms after every edit.) */
export function useStableOrder<T extends { id: string; position?: number }>(items: T[]): T[] {
  const seen = useRef(new Map<string, number>());
  for (const it of items) if (!seen.current.has(it.id)) seen.current.set(it.id, seen.current.size);
  return [...items].sort((a, b) => ((a.position ?? Infinity) - (b.position ?? Infinity)) || (seen.current.get(a.id)! - seen.current.get(b.id)!));
}
