/* ============================================================
   KANBO — Radar: the ranked risks across a team's work (blocked
   chains, slipping dates, stale work, overloaded people), each with
   the one-click fixes that deal with it.
   Also home to the one load model Pulse, Radar, People and Workload
   share: a task's hours are its estimate, else its planned block,
   else 1h, spread over the week(s) it lands in — so "45h / 40h" reads
   the same on every Team tab.
   Pure (no React): computeRisks is deterministic for a given input.
   ============================================================ */
import type { Task, WorkspaceEvent } from "../data/types";
import { KANBO_TODAY, getMember, getProject, toLocalISO } from "../data/data";
import { addDays, fmtDayMonth, localDay, round1, startOfWeekMon, taskLoadInWeek } from "../components/views/reportingUtils";

export type RiskKind = "blocked" | "blocker_late" | "slipping" | "stale" | "unassigned_due" | "over_capacity" | "milestone_at_risk";

/** A one-click fix offered on a risk. */
export interface RiskFix {
  kind: "nudge" | "open" | "rebalance" | "firm_date" | "assign" | "check_in";
  label: string;
}

export interface Risk {
  id: string;
  kind: RiskKind;
  severity: "signal" | "warn" | "neutral";
  title: string;
  reason: string;
  taskIds: string[];
  /** who the fix talks to: the person to nudge or check in with, or the person over capacity */
  memberId?: string;
  projectId?: string;
  fixes: RiskFix[];
  /** the task a Nudge, Check in, firm date or Assign acts on, when that isn't taskIds[0] */
  focusTaskId?: string;
  /** the leading part of `reason` that is data (a date chain, hours), set in mono */
  mono?: string;
}

/* ---------------- capacity ---------------- */

/** Weekly capacity (hours) unless one is set for the person. */
export const DEFAULT_CAPACITY = 40;
const CAP_KEY = "kanbo-capacity";

/** Weekly capacity (hours) per person id, as set on this device (Workload). */
export function readCapacities(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(CAP_KEY) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Save the per-person capacities (private mode quietly keeps them in memory only). */
export function writeCapacities(caps: Record<string, number>): void {
  try { localStorage.setItem(CAP_KEY, JSON.stringify(caps)); } catch { /* private mode */ }
}

export function capacityOf(caps: Record<string, number> | undefined, id: string): number {
  const c = caps?.[id];
  return typeof c === "number" && c > 0 ? c : DEFAULT_CAPACITY;
}

/* ---------------- load ---------------- */

/** The hours a task is expected to take: its estimate, else its planned
 *  block on the day canvas, else 1h (so work without estimates still counts). */
export function taskHours(t: Pick<Task, "effortHours" | "dur">): { hours: number; estimated: boolean } {
  if (typeof t.effortHours === "number" && t.effortHours > 0) return { hours: t.effortHours, estimated: true };
  if (typeof t.dur === "number" && t.dur > 0) return { hours: t.dur / 60, estimated: true };
  return { hours: 1, estimated: false };
}

export interface LoadItem { task: Task; hours: number; overdue: boolean; estimated: boolean }
export interface PersonLoad { id: string; hours: number; items: LoadItem[]; undated: number }

/** Open work per assignee ("" = unassigned) for the week starting `weekStart`,
 *  spread the way Workload always has (see taskLoadInWeek). Milestones are
 *  markers, not work, so they carry no load. `estimated` counts the items
 *  that had a real estimate — none means every hour shown is the 1h fallback. */
export function loadForWeek(tasks: Task[], weekStart: Date, today: Date): { rows: Map<string, PersonLoad>; undated: number; estimated: number } {
  const rows = new Map<string, PersonLoad>();
  const row = (id: string) => { let r = rows.get(id); if (!r) { r = { id, hours: 0, items: [], undated: 0 }; rows.set(id, r); } return r; };
  let undated = 0, estimated = 0;
  for (const t of tasks) {
    if (t.status === "done" || t.archivedAt || t.isMilestone) continue;
    const h = taskHours(t);
    const l = taskLoadInWeek(h.hours === t.effortHours ? t : { ...t, effortHours: h.hours }, weekStart, today);
    if (!l) {
      if (!t.dueDate && !t.startDate) { undated++; row(t.assigneeId || "").undated++; }
      continue;
    }
    const r = row(t.assigneeId || "");
    r.hours += l.hours;
    r.items.push({ task: t, hours: l.hours, overdue: l.overdue, estimated: h.estimated });
    if (h.estimated) estimated++;
  }
  rows.forEach((r) => r.items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.task.dueDate ?? "9999").localeCompare(b.task.dueDate ?? "9999")));
  return { rows, undated, estimated };
}

/** The colour a load reads in: ink below 90% of capacity, warn from 90% to
 *  100%, signal above it. Hours compare as shown (one decimal), so "40h / 40h"
 *  is never "over". */
export function loadTone(hours: number, capacity: number): "ink" | "warn" | "signal" {
  const h = round1(hours);
  if (h > capacity) return "signal";
  return capacity > 0 && h >= capacity * 0.9 ? "warn" : "ink";
}

/* ---------------- dates ---------------- */

const DAY = 86400000;
const dayDiff = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const TIMES = ["", "once", "twice", "three times"];

/** "today" · "tomorrow" · "on Friday" (this week) · "on 7 Oct" */
function dayWords(iso: string, today: Date): string {
  const d = localDay(iso);
  if (!d) return "soon";
  const n = dayDiff(today, d);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n > 1 && n < 7) return "on " + d.toLocaleDateString("en-GB", { weekday: "long" });
  return "on " + fmtDayMonth(d);
}
const shortDate = (iso: string | null | undefined) => { const d = localDay(iso); return d ? fmtDayMonth(d) : "—"; };

/* ---------------- risks ---------------- */

type Member = { id: string; name: string; guest?: boolean };
const SEVERITY_RANK: Record<Risk["severity"], number> = { signal: 0, warn: 1, neutral: 2 };

/**
 * Every risk, most severe first, then by impact (how many open tasks it holds
 * up), then by the soonest due date. `projectId` narrows it to one project;
 * `capacities` are weekly hours per person (default: Workload's, else 40h).
 * `events` are the workspace's task changes — pass the window they cover as
 * `eventsSince`, so a task quiet for longer than the window reads "over N days"
 * rather than a guess from when it was created.
 */
export function computeRisks(input: {
  tasks: Task[];
  events?: WorkspaceEvent[];
  members: Member[];
  capacities?: Record<string, number>;
  today?: string;
  projectId?: string;
  eventsSince?: string;
}): Risk[] {
  const { tasks, members } = input;
  const events = input.events ?? [];
  const caps = input.capacities ?? readCapacities();
  const todayISO = input.today ?? toLocalISO(KANBO_TODAY);
  const today = localDay(todayISO) ?? new Date(KANBO_TODAY);

  const live = tasks.filter((t) => !t.archivedAt);
  const byId = new Map(live.map((t) => [t.id, t]));
  const isOpen = (t: Task | undefined): t is Task => !!t && t.status !== "done";
  const open = live.filter(isOpen);

  // names: first names, unless two people share one
  const firsts = new Map<string, number>();
  for (const m of members) { const f = m.name.trim().split(/\s+/)[0] ?? ""; firsts.set(f, (firsts.get(f) ?? 0) + 1); }
  const nameOf = (id: string | undefined): string => {
    if (!id) return "no one";
    const full = members.find((m) => m.id === id)?.name ?? getMember(id)?.name ?? "";
    if (!full.trim()) return "someone";
    const first = full.trim().split(/\s+/)[0];
    return (firsts.get(first) ?? 0) > 1 ? full.trim() : first;
  };
  const known = (id: string | undefined) => !!id && (members.some((m) => m.id === id) || !!getMember(id));

  // events per task, oldest first
  const evs = new Map<string, WorkspaceEvent[]>();
  for (const e of events) { const a = evs.get(e.taskId) ?? []; a.push(e); evs.set(e.taskId, a); }
  evs.forEach((a) => a.sort((x, y) => x.createdAt.localeCompare(y.createdAt)));

  // who waits on whom (open tasks only)
  const dependants = new Map<string, string[]>();
  for (const t of open) for (const d of t.dependencies ?? []) {
    if (!isOpen(byId.get(d))) continue;
    const a = dependants.get(d) ?? []; a.push(t.id); dependants.set(d, a);
  }
  const downstream = (id: string): number => {
    const seen = new Set<string>([id]); const queue = [id];
    while (queue.length) for (const n of dependants.get(queue.shift()!) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    return seen.size - 1;
  };
  const blockersOf = (t: Task): Task[] => (t.dependencies ?? []).map((d) => byId.get(d)).filter(isOpen);

  const out: Array<Risk & { impact: number; due: string }> = [];
  const push = (r: Risk, impact: number, due?: string) => out.push({ ...r, impact, due: due ?? "9999-12-31" });
  const nudge = (id: string | undefined): RiskFix[] => (known(id) ? [{ kind: "nudge", label: `Nudge ${nameOf(id)}` }] : []);
  const checkIn = (id: string | undefined): RiskFix[] => (known(id) ? [{ kind: "check_in", label: "Check in" }] : []);
  const OPEN_CHAIN: RiskFix = { kind: "open", label: "Open chain" };
  const soon = toLocalISO(addDays(today, 7));

  /* blocked — marked blocked, or waiting on someone else's open task and due within a week
     (a late blocker is left to blocker_late, which offers the better fix: a firm date) */
  const isLateFor = (b: Task, d: Task) => !!b.dueDate && (b.dueDate < todayISO || (!!d.dueDate && b.dueDate > d.dueDate));
  const blockedOn = new Map<string, string>(); // marked-blocked task → the blocker its risk names
  for (const t of open) {
    if (t.isMilestone) continue;
    const blockers = blockersOf(t);
    const marked = t.status === "blocked";
    const other = blockers.find((b) => b.assigneeId !== t.assigneeId);
    if (!marked && !(other && t.dueDate && t.dueDate <= soon && !isLateFor(other, t))) continue;
    const b = marked ? (other ?? blockers[0]) : other!;
    let reason: string;
    if (b) {
      if (marked) blockedOn.set(t.id, b.id);
      const who = b.assigneeId ? `"${b.title}" (${nameOf(b.assigneeId)})` : `"${b.title}", which has no owner`;
      if (marked) {
        const since = [...(evs.get(t.id) ?? [])].reverse().find((e) => e.field === "status" && e.newValue === "blocked");
        const d = since ? dayDiff(localDay(since.createdAt) ?? today, today) : 0;
        reason = `Waiting on ${who}${d >= 1 ? ` for ${plural(d, "day")}` : ""}`;
      } else {
        const state = b.status === "todo" ? "not started yet" : b.status === "blocked" ? "itself blocked" : b.status === "review" ? "still in review" : "still in progress";
        reason = `Waiting on ${who}, ${state}`;
      }
    } else {
      reason = t.assigneeId ? `Marked blocked · ${nameOf(t.assigneeId)}` : "Marked blocked, and nobody owns it";
    }
    const target = b?.assigneeId || t.assigneeId || undefined;
    push({
      id: `blocked:${t.id}`, kind: "blocked", severity: "signal",
      title: `${t.title} is blocked`, reason,
      taskIds: b ? [t.id, b.id] : [t.id], memberId: known(target) ? target : undefined,
      projectId: t.projectId, focusTaskId: b?.id,
      fixes: [...nudge(target), OPEN_CHAIN],
    }, 1 + downstream(t.id), t.dueDate);
  }

  /* blocker_late — a blocker due after the task waiting on it, or already overdue */
  for (const b of open) {
    if (!b.dueDate) continue;
    const overdue = b.dueDate < todayISO;
    const held = (dependants.get(b.id) ?? []).map((id) => byId.get(id)!)
      .filter((d) => !d.isMilestone && blockedOn.get(d.id) !== b.id && isLateFor(b, d))
      .sort((x, y) => (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999"));
    if (!held.length) continue;
    const d = held[0];
    const chain = d.dueDate ? `${shortDate(b.dueDate)} → ${shortDate(d.dueDate)}` : undefined;
    const tail = [overdue ? "overdue" : null, b.assigneeId ? nameOf(b.assigneeId) : "no owner", held.length > 1 ? `and ${plural(held.length - 1, "more task")}` : null].filter(Boolean).join(" · ");
    push({
      id: `blocker_late:${b.id}`, kind: "blocker_late", severity: "signal",
      title: `${b.title} will hold up ${d.title}`,
      reason: chain ? `${chain} · ${tail}` : `Overdue since ${shortDate(b.dueDate)} · ${tail.replace(/^overdue · /, "")}`,
      mono: chain,
      taskIds: [b.id, ...held.map((x) => x.id)], memberId: known(b.assigneeId) ? b.assigneeId : undefined,
      projectId: b.projectId, focusTaskId: b.id,
      fixes: [{ kind: "firm_date", label: "Set a firm date" }, OPEN_CHAIN],
    }, 1 + downstream(b.id), d.dueDate ?? b.dueDate);
  }

  /* slipping — due later than first planned, moved twice or more (or by over a week) */
  for (const t of open) {
    if (!t.dueDate || !t.originalDueDate || t.dueDate <= t.originalDueDate) continue;
    const dueEvents = (evs.get(t.id) ?? []).filter((e) => e.field === "due");
    const later = dueEvents.filter((e) => e.oldValue && e.newValue && e.newValue.slice(0, 10) > e.oldValue.slice(0, 10));
    const moved = dayDiff(localDay(t.originalDueDate) ?? today, localDay(t.dueDate) ?? today);
    let title: string, chain: string;
    if (later.length >= 2) {
      const dates = [t.originalDueDate, ...later.map((e) => e.newValue!.slice(0, 10))];
      if (dates[dates.length - 1] !== t.dueDate) dates.push(t.dueDate);
      const steps = dates.filter((x, i) => i === 0 || x !== dates[i - 1]).map(shortDate);
      chain = (steps.length > 4 ? [steps[0], "…", ...steps.slice(-2)] : steps).join(" → ");
      title = `${t.title} has slipped ${TIMES[later.length] ?? `${later.length} times`}`;
    } else if (!dueEvents.length && moved > 7) {
      chain = `${shortDate(t.originalDueDate)} → ${shortDate(t.dueDate)}`;
      title = `${t.title} has slipped by ${plural(moved, "day")}`;
    } else continue;
    push({
      id: `slipping:${t.id}`, kind: "slipping", severity: "warn",
      title, reason: `${chain} · ${t.assigneeId ? nameOf(t.assigneeId) : "no owner"}`, mono: chain,
      taskIds: [t.id], memberId: known(t.assigneeId) ? t.assigneeId : undefined, projectId: t.projectId,
      fixes: [{ kind: "firm_date", label: "Set a firm date" }, ...checkIn(t.assigneeId)],
    }, 1 + downstream(t.id), t.dueDate);
  }

  /* stale — in progress with no change for a week or more */
  const windowStart = localDay(input.eventsSince);
  for (const t of open) {
    if (t.status !== "progress") continue;
    const last = (evs.get(t.id) ?? []).reduce<Date | null>((acc, e) => { const d = localDay(e.createdAt); return d && (!acc || d > acc) ? d : acc; }, null);
    const created = localDay(t.createdAt);
    // no change inside the events' window, and created before it: quiet for at least the whole window
    const over = !last && !!windowStart && !!created && created < windowStart;
    const quietSince = last ?? (over ? windowStart : created);
    if (!quietSince) continue;
    const d = dayDiff(quietSince, today);
    if (d < 7) continue;
    push({
      id: `stale:${t.id}`, kind: "stale", severity: "warn",
      title: `${t.title} hasn't moved in ${over ? "over " : ""}${plural(d, "day")}`,
      reason: `In progress with no changes ${over ? "for over" : "since"} ${over ? plural(d, "day") : shortDate(toLocalISO(quietSince))} · ${t.assigneeId ? nameOf(t.assigneeId) : "no owner"}`,
      taskIds: [t.id], memberId: known(t.assigneeId) ? t.assigneeId : undefined, projectId: t.projectId,
      fixes: t.assigneeId ? checkIn(t.assigneeId) : [{ kind: "assign", label: "Assign" }],
    }, 1 + downstream(t.id), t.dueDate);
  }

  /* unassigned_due — nobody owns it and it's due within three days */
  const within3 = toLocalISO(addDays(today, 3));
  for (const t of open) {
    if (t.assigneeId || t.isMilestone || !t.dueDate || t.dueDate > within3) continue;
    const project = getProject(t.projectId);
    push({
      id: `unassigned_due:${t.id}`, kind: "unassigned_due", severity: "warn",
      title: t.dueDate < todayISO ? `${t.title} is overdue with no owner` : `${t.title} is due ${dayWords(t.dueDate, today)} with no owner`,
      reason: project ? `Nobody has picked it up · ${project.name}` : "Nobody has picked it up yet",
      taskIds: [t.id], projectId: t.projectId,
      fixes: [{ kind: "assign", label: "Assign" }],
    }, 1 + downstream(t.id), t.dueDate);
  }

  /* over_capacity — this week's load at 90% of capacity or more */
  const week = loadForWeek(live, startOfWeekMon(today), today);
  for (const m of members) {
    if (m.guest) continue;
    const r = week.rows.get(m.id);
    if (!r) continue;
    const cap = capacityOf(caps, m.id);
    const h = round1(r.hours);
    if (h < cap * 0.9) continue;
    const hours = `${h}h / ${round1(cap)}h`;
    const inProject = !input.projectId || r.items.some((i) => i.task.projectId === input.projectId);
    if (!inProject) continue;
    push({
      id: `over_capacity:${m.id}`, kind: "over_capacity", severity: h > cap * 1.1 ? "signal" : "warn",
      title: h > cap ? `${nameOf(m.id)} is over capacity` : `${nameOf(m.id)} is near capacity`,
      reason: `${hours} this week · ${plural(r.items.length, "task")}`, mono: hours,
      taskIds: r.items.map((i) => i.task.id), memberId: m.id,
      fixes: [{ kind: "rebalance", label: "Rebalance" }],
    }, r.items.length, r.items[0]?.task.dueDate);
  }

  /* milestone_at_risk — a milestone within ten days with blocked or overdue work ahead of it */
  const horizon = toLocalISO(addDays(today, 10));
  for (const ms of open) {
    if (!ms.isMilestone || !ms.dueDate || ms.dueDate > horizon) continue;
    const seen = new Set<string>(); const queue = [...(ms.dependencies ?? [])]; const upstream: Task[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const u = byId.get(id);
      if (!isOpen(u)) continue;
      upstream.push(u);
      queue.push(...(u.dependencies ?? []));
    }
    const culprits = upstream.filter((u) => u.status === "blocked" || (!!u.dueDate && u.dueDate < todayISO));
    if (!culprits.length) continue;
    const c = culprits[0];
    const due = ms.dueDate < todayISO ? `was due ${shortDate(ms.dueDate)}` : `due ${dayWords(ms.dueDate, today)}`;
    push({
      id: `milestone_at_risk:${ms.id}`, kind: "milestone_at_risk", severity: "signal",
      title: `${ms.title} is at risk`,
      reason: culprits.length === 1
        ? `${c.title} is ${c.status === "blocked" ? "blocked" : "overdue"} · ${due}`
        : `${culprits.length} tasks it depends on are blocked or overdue · ${due}`,
      taskIds: [ms.id, ...culprits.map((x) => x.id)], projectId: ms.projectId,
      fixes: [OPEN_CHAIN],
    }, 1 + upstream.length, ms.dueDate);
  }

  const ranked = out
    .filter((r) => !input.projectId || r.kind === "over_capacity" || r.projectId === input.projectId)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.impact - a.impact || a.due.localeCompare(b.due) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return ranked.map(({ impact: _i, due: _d, ...r }) => r);
}
