/* ============================================================
   KANBO — project status: the facts behind a project's status,
   an on-device draft of its update, and "Kanbo's read" (one line).
   Pure: no React, no I/O. The AI path (store.aiStatus) is given
   statusFactsForAi(facts); when it can't answer, draftStatusLocal
   writes the same update from the same facts.
   ============================================================ */
import type { Project, StatusKind, StatusUpdate, Task } from "../data/types";
import { localDay, projectHealth, type HealthKind } from "../components/views/reportingUtils";

const DAY = 86400000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** an update this old (or older) is stale */
export const STALE_DAYS = 14;

export interface StatusFacts {
  project: { id: string; name: string };
  /** the day the facts were read, YYYY-MM-DD */
  today: string;
  /** top-level tasks (sub-tasks nest under them), like the page header */
  total: number;
  open: number;
  /** open work, sub-tasks included: what `overdue` and `blocked` are counted from,
   *  so a count shown beside them never reads fewer than they do */
  openAll: number;
  /** % of top-level tasks done */
  pct: number;
  /** finished in the last 7 days */
  done7: Task[];
  /** added in the last 7 days */
  created7: Task[];
  /** open tasks now due later than first planned */
  slipped: Task[];
  blocked: Task[];
  overdue: Task[];
  /** blocked task id → the open tasks it waits on */
  waitingOn: Record<string, Task[]>;
  /** the soonest open milestone */
  nextMilestone?: Task;
  /** the open task that most other open work waits on */
  criticalPath?: Task;
  health: HealthKind;
  /** e.g. "2 overdue · 1 blocked" */
  healthDetail: string;
  latest?: StatusUpdate;
  lastUpdateDays: number | null;
  /** tasks finished, added or slipped this week: what a drafted update is built from */
  changes: number;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const ageDays = (when: string | undefined, today: Date): number | null => {
  const d = localDay(when);
  return d ? Math.round((midnight(today).getTime() - d.getTime()) / DAY) : null;
};

/** "Thu 8 Oct" (plus the year when it isn't this year's) */
export function fmtShortDay(value: string | undefined, today: Date = new Date()): string {
  const d = localDay(value);
  if (!d) return "";
  const s = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === today.getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

/** "2d", "today", "9d": a mono age for tables and meta lines */
export function fmtAge(days: number): string {
  return days <= 0 ? "today" : `${days}d`;
}

/** Newest first, whatever order they arrive in. */
export function projectUpdates(statusUpdates: StatusUpdate[], projectId: string): StatusUpdate[] {
  return statusUpdates
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const byDue = (a: Task, b: Task) =>
  (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);

/** Every live task grouped once, so reading many projects (the directory, a
 *  portfolio) doesn't rescan the whole list for each one. Build it from the
 *  same `tasks` you pass to statusFacts. */
export interface TaskIndex {
  byId: Map<string, Task>;
  byProject: Map<string, Task[]>;
  /** task id → the open tasks that list it as a dependency */
  dependents: Map<string, string[]>;
}
export function indexTasks(tasks: Task[]): TaskIndex {
  const byId = new Map<string, Task>();
  const byProject = new Map<string, Task[]>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.archivedAt) continue;
    byId.set(t.id, t);
    const list = byProject.get(t.projectId);
    if (list) list.push(t); else byProject.set(t.projectId, [t]);
    if (t.status === "done") continue;
    for (const dep of t.dependencies ?? []) {
      const d = dependents.get(dep);
      if (d) d.push(t.id); else dependents.set(dep, [t.id]);
    }
  }
  return { byId, byProject, dependents };
}

/**
 * The facts a status update is written from. `tasks` may be every task you
 * can see: the project's own are picked out here, and the rest are only used
 * to name what a blocked task is waiting on. Pass `idx` (indexTasks(tasks))
 * when reading many projects from the same list.
 */
export function statusFacts(project: Project, tasks: Task[], statusUpdates: StatusUpdate[], today: Date, idx?: TaskIndex): StatusFacts {
  const { byId, byProject, dependents } = idx ?? indexTasks(tasks);
  const mine = byProject.get(project.id) ?? [];
  const top = mine.filter((t) => !t.parentId);
  const open = mine.filter((t) => t.status !== "done");
  const todayMid = midnight(today);
  const within7 = (when?: string) => { const a = ageDays(when, today); return a != null && a >= 0 && a < 7; };

  const done7 = mine.filter((t) => t.status === "done" && within7(t.completedAt));
  const created7 = mine.filter((t) => within7(t.createdAt));
  const slipped = open.filter((t) => !!t.originalDueDate && !!t.dueDate && t.dueDate > t.originalDueDate);
  const blocked = mine.filter((t) => t.status === "blocked").sort(byDue);
  const overdue = open.filter((t) => { const d = localDay(t.dueDate); return !!d && d < todayMid; }).sort(byDue);

  const waitingOn: Record<string, Task[]> = {};
  for (const b of blocked) {
    waitingOn[b.id] = (b.dependencies ?? []).map((id) => byId.get(id)).filter((x): x is Task => !!x && x.status !== "done");
  }

  const nextMilestone = open
    .filter((t) => t.isMilestone && t.dueDate && (localDay(t.dueDate)?.getTime() ?? 0) >= todayMid.getTime())
    .sort(byDue)[0];

  // the critical path: the open task that the most other open work waits on,
  // counting the whole chain (a milestone waiting on B waiting on A puts A first)
  const downstream = (id: string): number => {
    const seen = new Set<string>();
    const walk = (x: string) => { for (const d of dependents.get(x) ?? []) if (!seen.has(d) && d !== id) { seen.add(d); walk(d); } };
    walk(id);
    return seen.size;
  };
  let criticalPath: Task | undefined;
  let best = 0;
  for (const t of [...open].filter((x) => !x.isMilestone).sort(byDue)) {
    const n = downstream(t.id);
    if (n > best) { best = n; criticalPath = t; }
  }

  const health = projectHealth(mine, today);
  const updates = projectUpdates(statusUpdates, project.id);
  const latest = updates[0];
  const lastUpdateDays = latest ? Math.max(0, ageDays(latest.createdAt, today) ?? 0) : null;
  const changes = new Set([...done7, ...created7, ...slipped].map((t) => t.id)).size;
  const topDone = top.filter((t) => t.status === "done").length;

  return {
    project: { id: project.id, name: project.name },
    today: iso(todayMid),
    total: top.length,
    open: top.length - topDone,
    openAll: open.length,
    pct: top.length ? Math.round((topDone / top.length) * 100) : 0,
    done7, created7, slipped, blocked, overdue, waitingOn, nextMilestone, criticalPath,
    health: health?.kind ?? "on_track",
    healthDetail: health?.detail ?? "no tasks yet",
    latest, lastUpdateDays, changes,
  };
}

/** The status a drafted update proposes: the project's health, in update terms. */
export function statusFromHealth(health: HealthKind): StatusKind {
  return health === "off_track" ? "off_track" : health === "at_risk" ? "at_risk" : "on_track";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clean = (title: string) => title.trim().replace(/[.!?;:,\s]+$/, "");
const list = (titles: string[]) => titles.length <= 1 ? titles.join("") : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;

/** An update written on this device from the facts: 2–4 short sentences, and a status from the health. */
export function draftStatusLocal(f: StatusFacts): { summary: string; status: StatusKind } {
  const today = localDay(f.today) ?? new Date();
  const s: string[] = [];
  if (f.total === 0) s.push("No tasks in this project yet.");
  else if (f.health === "complete") s.push(`Every task is done${f.done7.length ? `, ${plural(f.done7.length, "task")} of them this week` : ""}.`);
  else if (f.done7.length) s.push(`Finished ${plural(f.done7.length, "task")} this week; ${f.pct}% done overall.`);
  else s.push(`Nothing finished this week; ${f.pct}% done overall.`);

  const blocked = [...f.blocked];
  const cp = f.criticalPath;
  if (cp) {
    const due = cp.dueDate ? `, due ${fmtShortDay(cp.dueDate, today)}` : "";
    const on = cp.status === "blocked" ? (f.waitingOn[cp.id] ?? [])[0] : undefined;
    if (cp.status === "blocked") {
      s.push(`${clean(cp.title)} is the critical path${due}, and it's blocked${on ? ` on ${clean(on.title)}` : ""}.`);
      const i = blocked.indexOf(cp);
      if (i >= 0) blocked.splice(i, 1);
    } else s.push(`${clean(cp.title)} is the critical path${due}.`);
  }
  if (blocked.length) {
    const first = blocked[0];
    const on = (f.waitingOn[first.id] ?? [])[0];
    s.push(blocked.length === 1
      ? `${clean(first.title)} is blocked${on ? ` on ${clean(on.title)}` : ""}.`
      : `${plural(blocked.length, "task is", "tasks are")} blocked, including ${clean(first.title)}${on ? ` (waiting on ${clean(on.title)})` : ""}.`);
  }
  const lateOthers = f.overdue.filter((t) => t.id !== cp?.id && t.status !== "blocked");
  if (lateOthers.length) {
    s.push(lateOthers.length <= 2
      ? `Overdue: ${list(lateOthers.map((t) => clean(t.title)))}.`
      : `${plural(lateOthers.length, "task")} overdue, the oldest ${clean(lateOthers[0].title)}.`);
  }
  if (f.nextMilestone) s.push(`Next milestone: ${clean(f.nextMilestone.title)}, ${fmtShortDay(f.nextMilestone.dueDate, today)}.`);
  else if (f.slipped.length && s.length < 4) s.push(`${plural(f.slipped.length, "due date has", "due dates have")} moved later than first planned.`);

  return { summary: s.join(" "), status: f.total === 0 ? "on_track" : statusFromHealth(f.health) };
}

// the doing-word a task title usually starts with; a one-line read names the thing, not the chore
const LEAD_VERBS = new Set(("add agree approve audit book build check clean close create define deliver design draft finalise finalize " +
  "finish fix get hire launch make migrate move plan polish prep prepare publish record refresh review rewrite run send set " +
  "ship sign start test tidy update upgrade write").split(" "));

/** A task title as a short name: "Finalise Q3 launch narrative deck" → "Q3 launch narrative deck". */
export function shortTitle(title: string, max = 32): string {
  const t = clean(title);
  const words = t.split(/\s+/);
  const lead = words[0]?.toLowerCase();
  let name = words.length > 2 && LEAD_VERBS.has(lead) ? words.slice(lead === "set" && words[1]?.toLowerCase() === "up" ? 2 : 1).join(" ") : t;
  if (name.length > max) name = `${name.slice(0, max).replace(/\s+\S*$/, "").trimEnd() || name.slice(0, max - 1)}…`;
  return name;
}
const short = (title: string, max = 32) => shortTitle(title, max);

/** One line on how the project is really going, e.g. "Critical path: narrative deck · no update for 9 days".
 *  `withUpdate: false` leaves the update's age out (the directory has its own column for it). */
export function kanbosRead(f: StatusFacts, { withUpdate = true }: { withUpdate?: boolean } = {}): string {
  if (f.total === 0) return "No tasks yet";
  const today = localDay(f.today) ?? new Date();
  const parts: string[] = [];
  let lead: "cp" | "blocked" | "overdue" | "other" = "other";
  if (f.health === "complete") parts.push("All tasks done");
  else if (f.criticalPath) { parts.push(`Critical path: ${short(f.criticalPath.title)}`); lead = "cp"; }
  else if (f.blocked.length) { parts.push(`${f.blocked.length} blocked`); lead = "blocked"; }
  else if (f.overdue.length) { parts.push(`${f.overdue.length} overdue`); lead = "overdue"; }
  else if (f.nextMilestone) parts.push(`Next: ${short(f.nextMilestone.title, 32)}, ${fmtShortDay(f.nextMilestone.dueDate, today)}`);
  else if (f.done7.length) parts.push(`${plural(f.done7.length, "task")} done this week`);
  else parts.push("Nothing finished this week");

  if (withUpdate && f.lastUpdateDays == null) parts.push("no updates yet");
  else if (withUpdate && f.lastUpdateDays != null && f.lastUpdateDays >= 7) parts.push(`no update for ${f.lastUpdateDays} days`);
  else if (lead !== "blocked" && f.blocked.length) parts.push(`${f.blocked.length} blocked`);
  else if (lead !== "overdue" && f.overdue.length) parts.push(`${f.overdue.length} overdue`);
  return parts.join(" · ");
}

/** The facts behind a draft, as the short sentences the composer's
 *  "How I got here" lists. */
export function factLines(f: StatusFacts): string[] {
  const today = localDay(f.today) ?? new Date();
  const out: string[] = [];
  out.push(`${plural(f.done7.length, "task")} finished in the last 7 days`);
  if (f.created7.length) out.push(`${plural(f.created7.length, "task")} added`);
  if (f.blocked.length) out.push(`${f.blocked.length} blocked`);
  if (f.overdue.length) out.push(`${f.overdue.length} overdue`);
  if (f.slipped.length) out.push(`${plural(f.slipped.length, "due date")} moved later`);
  if (f.criticalPath) out.push(`Critical path: ${clean(f.criticalPath.title)}`);
  if (f.nextMilestone) out.push(`Next milestone: ${clean(f.nextMilestone.title)}, ${fmtShortDay(f.nextMilestone.dueDate, today)}`);
  out.push(f.lastUpdateDays == null ? "No update posted yet" : `Last update ${f.lastUpdateDays === 0 ? "today" : `${plural(f.lastUpdateDays, "day")} ago`}`);
  return out;
}

/** The facts as compact JSON for the `status` AI mode: titles and dates, never whole tasks. */
export function statusFactsForAi(f: StatusFacts) {
  const brief = (t: Task) => ({ title: clean(t.title), due: t.dueDate ?? null, status: t.status });
  return {
    project: f.project.name,
    today: f.today,
    health: f.health,
    healthDetail: f.healthDetail,
    progressPct: f.pct,
    openTasks: f.open,
    totalTasks: f.total,
    finishedThisWeek: f.done7.slice(0, 12).map((t) => clean(t.title)),
    addedThisWeek: f.created7.length,
    blocked: f.blocked.slice(0, 8).map((t) => ({ ...brief(t), waitingOn: (f.waitingOn[t.id] ?? []).slice(0, 3).map((w) => clean(w.title)) })),
    overdue: f.overdue.slice(0, 8).map(brief),
    slipped: f.slipped.slice(0, 8).map((t) => ({ title: clean(t.title), firstDue: t.originalDueDate ?? null, due: t.dueDate ?? null })),
    criticalPath: f.criticalPath ? brief(f.criticalPath) : null,
    nextMilestone: f.nextMilestone ? brief(f.nextMilestone) : null,
    lastUpdate: f.latest ? { daysAgo: f.lastUpdateDays, status: f.latest.status, summary: f.latest.summary.slice(0, 400) } : null,
  };
}

/** Is a project's update stale? No update counts as stale, unless the project's
 *  work is all younger than that (a project started this week isn't behind). */
export function isStale(f: Pick<StatusFacts, "lastUpdateDays" | "total">, oldestTaskAgeDays?: number | null): boolean {
  if (f.lastUpdateDays != null) return f.lastUpdateDays >= STALE_DAYS;
  if (f.total === 0) return false;
  return oldestTaskAgeDays == null || oldestTaskAgeDays >= STALE_DAYS;
}

/** Days since the project's oldest task was added, when the tasks say (null when none do). */
export function oldestTaskAge(tasks: Task[], projectId: string, today: Date): number | null {
  let oldest: number | null = null;
  for (const t of tasks) {
    if (t.projectId !== projectId || t.archivedAt) continue;
    const a = ageDays(t.createdAt, today);
    if (a != null && (oldest == null || a > oldest)) oldest = a;
  }
  return oldest;
}
