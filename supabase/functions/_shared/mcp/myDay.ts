// ============================================================
// KANBO — "What do I need to get done today?"
//
// planMyDay is the whole of it: overdue, due today, approvals waiting on you,
// on your plan for today, then blocked, each with a one-line reason. It's
// deterministic and cheap (no AI call): the same tasks on the same day always
// read the same way, and a task appears once, in the first list it fits.
//
// Each list has its own cap, so an old backlog can't push today's work out of
// the answer. Overdue and blocked are short (the most urgent first); the counts
// and the summary always cover everything.
//
// `reason` is only ever Kanbo's own fixed words. Anything a person wrote (the title
// of what a task waits for, who asked for an approval) is in a field of its own.
//
// Pure module: myDay.test.ts. apiExtras.ts reads the rows.
// ============================================================
import { dayLabel } from "../nlp.ts";
import type { ApiTask } from "../api/serialise.ts";
import { localMidnight } from "../zone.ts";

export { DEFAULT_TIMEZONE, dateInZone, isTimeZone, localMidnight } from "../zone.ts";

export type MyDayKind = "overdue" | "due_today" | "approval" | "planned" | "blocked";

export interface MyDayTask {
  task: ApiTask;
  /** on this person's plan for today */
  planned: boolean;
  /** minutes from midnight: their slot on the plan */
  scheduled: number | null;
  /** the title of an unfinished task this one waits for */
  blockedBy: string | null;
}

export interface MyDayApproval {
  id: string;
  taskId: string;
  /** the request's title, or the task's */
  title: string;
  createdAt: string;
  requester: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  dueTime: string | null;
  projectId: string | null;
  workspaceId: string | null;
  url: string | null;
}

export interface MyDayItem {
  kind: MyDayKind;
  taskId: string;
  title: string;
  /** why it's here, in one line: Kanbo's own words, never a person's */
  reason: string;
  status: string;
  priority: string;
  dueDate: string | null;
  dueTime: string | null;
  projectId: string | null;
  workspaceId: string | null;
  url: string | null;
  /** set on an approval */
  approvalId: string | null;
  /** the title of an unfinished task this one waits for: written by a person */
  blockedByTitle: string | null;
  /** who asked for this approval: written by a person */
  requesterName: string | null;
}

export interface MyDayCounts { overdue: number; dueToday: number; approvals: number; planned: number; blocked: number }

export interface MyDay {
  object: "my_day";
  date: string;
  timezone: string;
  /** in a sentence */
  summary: string;
  /** how many of each there are in all, shown or not */
  counts: MyDayCounts;
  items: MyDayItem[];
  /** how many of each aren't in `items` */
  notShown: MyDayCounts;
  /** something isn't in `items`: the counts still cover everything */
  truncated: boolean;
}

/** The most of each list an answer shows. Overdue is short on purpose: most urgent first, and today's work isn't crowded out. */
export const MY_DAY_CAPS: MyDayCounts = { overdue: 10, dueToday: 40, approvals: 40, planned: 40, blocked: 10 };

const OTHER_PEOPLES_WORDS_MAX = 120;
const shortName = (s: string | null) => (s ? Array.from(s.replace(/\s+/g, " ").trim()).slice(0, OTHER_PEOPLES_WORDS_MAX).join("") : null);

const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const rank = (p: string) => RANK[p] ?? 2;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const DAY_MS = 86_400_000;
/** Whole days from one YYYY-MM-DD to another (no clocks, so no daylight-saving surprises). */
export function daysBetween(from: string, to: string): number {
  const utc = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const priorityNote = (p: string) => (p === "urgent" ? " Urgent." : p === "high" ? " High priority." : "");

function plural(n: number, one: string, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

function reasonFor(kind: Exclude<MyDayKind, "approval">, row: MyDayTask, today: string): string {
  const t = row.task;
  const waiting = row.blockedBy ? " Blocked by an unfinished task." : "";
  switch (kind) {
    case "overdue": {
      const days = daysBetween(t.dueDate!, today);
      const when = days === 1 ? "yesterday" : `${dayLabel(t.dueDate!, localMidnight(today))}, ${days} days ago`;
      return `Was due ${when}.${priorityNote(t.priority)}${t.status === "blocked" && !row.blockedBy ? " Marked as blocked." : waiting}`;
    }
    case "due_today":
      return `Due today${t.dueTime ? ` at ${t.dueTime}` : ""}.${priorityNote(t.priority)}${t.status === "blocked" && !row.blockedBy ? " Marked as blocked." : waiting}`;
    case "planned":
      return `On your plan for today${row.scheduled != null ? ` at ${hhmm(row.scheduled)}` : ""}.${priorityNote(t.priority)}${t.status === "blocked" && !row.blockedBy ? " Marked as blocked." : waiting}`;
    case "blocked":
      return row.blockedBy ? "Blocked by an unfinished task." : `Marked as blocked.${priorityNote(t.priority)}`;
  }
}

function itemOf(kind: MyDayKind, row: MyDayTask, today: string): MyDayItem {
  const t = row.task;
  return {
    kind,
    taskId: t.id,
    title: t.title,
    reason: reasonFor(kind as Exclude<MyDayKind, "approval">, row, today),
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    dueTime: t.dueTime,
    projectId: t.projectId,
    workspaceId: t.workspaceId,
    url: t.url,
    approvalId: null,
    blockedByTitle: shortName(row.blockedBy),
    requesterName: null,
  };
}

/**
 * The day, in the order to work through it. `totals` are the true counts when `tasks` and `approvals`
 * were already cut down to the caps (apiExtras.ts); without them, what's passed in is everything.
 */
export function planMyDay(input: { today: string; timezone: string; tasks: MyDayTask[]; approvals: MyDayApproval[]; totals?: MyDayCounts; caps?: Partial<MyDayCounts> }): MyDay {
  const { today, timezone } = input;
  const caps = { ...MY_DAY_CAPS, ...input.caps };
  const overdue: MyDayTask[] = [], dueToday: MyDayTask[] = [], planned: MyDayTask[] = [], blocked: MyDayTask[] = [];
  for (const row of input.tasks) {
    const t = row.task;
    if (t.status === "done" || t.archived) continue;
    if (t.dueDate && t.dueDate < today) overdue.push(row);
    else if (t.dueDate === today) dueToday.push(row);
    else if (row.planned) planned.push(row);
    else if (t.status === "blocked" || row.blockedBy) blocked.push(row);
  }
  const tie = (a: MyDayTask, b: MyDayTask) => byText(a.task.title, b.task.title) || byText(a.task.id, b.task.id);
  overdue.sort((a, b) => rank(a.task.priority) - rank(b.task.priority) || byText(a.task.dueDate!, b.task.dueDate!) || tie(a, b));
  dueToday.sort((a, b) => byText(a.task.dueTime ?? "99", b.task.dueTime ?? "99") || rank(a.task.priority) - rank(b.task.priority) || tie(a, b));
  planned.sort((a, b) => (a.scheduled ?? 1e9) - (b.scheduled ?? 1e9) || rank(a.task.priority) - rank(b.task.priority) || tie(a, b));
  blocked.sort((a, b) => rank(a.task.priority) - rank(b.task.priority) || byText(a.task.dueDate ?? "9999", b.task.dueDate ?? "9999") || tie(a, b));
  const approvals = [...input.approvals].sort((a, b) => byText(a.createdAt, b.createdAt) || byText(a.id, b.id));

  const counts: MyDayCounts = input.totals
    ?? { overdue: overdue.length, dueToday: dueToday.length, approvals: approvals.length, planned: planned.length, blocked: blocked.length };
  const shown = {
    overdue: overdue.slice(0, caps.overdue),
    dueToday: dueToday.slice(0, caps.dueToday),
    approvals: approvals.slice(0, caps.approvals),
    planned: planned.slice(0, caps.planned),
    blocked: blocked.slice(0, caps.blocked),
  };
  const items: MyDayItem[] = [
    ...shown.overdue.map((r) => itemOf("overdue", r, today)),
    ...shown.dueToday.map((r) => itemOf("due_today", r, today)),
    ...shown.approvals.map((a): MyDayItem => ({
      kind: "approval",
      taskId: a.taskId,
      title: a.title,
      reason: "Your approval was asked for.",
      status: a.status,
      priority: a.priority,
      dueDate: a.dueDate,
      dueTime: a.dueTime,
      projectId: a.projectId,
      workspaceId: a.workspaceId,
      url: a.url,
      approvalId: a.id,
      blockedByTitle: null,
      requesterName: shortName(a.requester),
    })),
    ...shown.planned.map((r) => itemOf("planned", r, today)),
    ...shown.blocked.map((r) => itemOf("blocked", r, today)),
  ];
  const notShown: MyDayCounts = {
    overdue: Math.max(0, counts.overdue - shown.overdue.length),
    dueToday: Math.max(0, counts.dueToday - shown.dueToday.length),
    approvals: Math.max(0, counts.approvals - shown.approvals.length),
    planned: Math.max(0, counts.planned - shown.planned.length),
    blocked: Math.max(0, counts.blocked - shown.blocked.length),
  };
  const bits = [
    counts.overdue ? `${counts.overdue} overdue` : "",
    counts.dueToday ? `${counts.dueToday} due today` : "",
    counts.approvals ? `${plural(counts.approvals, "approval")} waiting on you` : "",
    counts.planned ? `${counts.planned} planned` : "",
    counts.blocked ? `${counts.blocked} blocked` : "",
  ].filter(Boolean);
  return {
    object: "my_day",
    date: today,
    timezone,
    summary: bits.length ? `${bits.join(", ")}.` : "Nothing is due, planned or waiting on you today.",
    counts,
    items,
    notShown,
    truncated: Object.values(notShown).some((n) => n > 0),
  };
}
