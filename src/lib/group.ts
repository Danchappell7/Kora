/* ============================================================
   KANBO — the Group page's numbers: one digest per business you run
   (owner or admin), worked out once per business from what's already
   loaded for you, so nothing is read that you couldn't open yourself.
   · goals behind: a goal marked at risk or off track, or past its date
     unfinished. Wave 2's pace line plugs in through `pace` (GoalPace):
     when given, a goal it says is behind counts too, and its line is
     shown under the goal.
   · projects to look at: off track or at risk (Kanbo's read of the work,
     or the latest update's call), or its update missing (0053: past its
     update day and the follow-ups; before 0053, no update in 14 days).
     Each carries ONE pill, the lead's call and Kanbo's read together
     (lib/honestStatus), and those where the call is rosier than the
     work come first;
   · requests waiting for your approval there;
   · the week's wins: top-level tasks finished this week (on a Monday,
     last week's);
   · Radar's signals, worked out for that business alone;
   · your own work there that's overdue or due today (as the switcher's
     dot and Today count it).
   "Needs you most" is the switcher's and Today's meaning (lib/businesses
   attentionScore: requests, your overdue and due-today work): that
   business comes first, the rest by how much is behind.
   ============================================================ */
import type { ApprovalWithTask, Goal, Project, Role, StatusUpdate, Task, Workspace, WorkspaceMember } from "../data/types";
import { PRIORITY_META, getMember } from "../data/data";
import { goalProgressMap, projectHealth, type GoalProgress, type HealthKind } from "../components/views/reportingUtils";
import { indexTasks, isStale, oldestTaskAge, statusFacts, STALE_DAYS } from "./statusDraft";
import { mergedStatus, type MergedStatus } from "./honestStatus";
import { projectRhythmState, readsMissing } from "./updateRhythm";
import { computeRisks, type Risk } from "./radar";
import { projectProgressOf } from "./countRules";
import { hiddenProjectOf } from "./goalFlow";
import { localDay, startOfWeekMon, addDays } from "./weekMath";
import { approvalsEverywhere, businessesYouRun, businessLead, roleInWorkspace, wsKey, type WorkspaceSignal } from "./businesses";

/** Wave 2's pace read for a goal (the hook): behind or not, and the line to show under it. */
export interface GoalPaceRead { behind: boolean; line: string }
export type GoalPace = (goal: Goal, progress: GoalProgress, today: Date) => GoalPaceRead | null;

export type GoalWhy = "off_track" | "at_risk" | "overdue" | "pace";
/** hidden (0058): its % comes from a project you can't see (only its own status can put it here) */
export interface GroupGoal { goal: Goal; pct: number; why: GoalWhy; pace?: GoalPaceRead; hidden?: true }
/** missing: past its update day and the follow-ups (0053) · stale: no update in 14 days (before 0053) */
export type ProjectWhy = "off_track" | "at_risk" | "missing" | "stale";
export interface GroupProject {
  project: Project;
  why: ProjectWhy;
  /** "Off track", "At risk", "Update missing", "No update in 14 days" */
  label: string;
  /** whose call the label is: Kanbo's read of the work, or the latest update's (missing / stale: neither) */
  source?: "work" | "update";
  /** "3 overdue · 2 blocked · Update: at risk", "Update: at risk", "Last update 16 days ago" */
  detail: string;
  /** the one pill: the lead's call and Kanbo's read together */
  status: MergedStatus;
  /** its update is missing (0053), whatever else is wrong: a lead can ask for it */
  missing?: boolean;
}
export interface GroupApproval { id: string; taskId: string; title: string; requestedByName: string | null; createdAt: string }
export interface BusinessDigest {
  workspace: Workspace;
  role: Role;
  goals: { behind: GroupGoal[]; total: number };
  projects: { needs: GroupProject[]; total: number };
  approvals: GroupApproval[];
  wins: { count: number; top: Task[]; label: string };
  /** Radar's signals for this business (blockers, slips, over capacity) */
  risks: number;
  /** your own work there: overdue, and due today */
  mine: { overdue: number; dueToday: number };
  /** how much is behind there (the page's order after the business that needs you most) */
  score: number;
  /** the business that needs you most (the switcher's and Today's meaning) */
  needsMost?: boolean;
}

export interface GroupInput {
  workspaces: readonly Workspace[];
  members: readonly WorkspaceMember[];
  me: string;
  /** every live task you can see, in every workspace */
  tasks: readonly Task[];
  /** the same, archived projects' tasks included: a goal linked to an archived project keeps
   *  its % (as on the Goals page). Defaults to `tasks`. */
  goalTasks?: readonly Task[];
  projects: readonly Project[];
  goals: readonly Goal[];
  statusUpdates: readonly StatusUpdate[];
  /** requests waiting for your approval (every workspace) */
  approvals: readonly ApprovalWithTask[];
  today: Date;
  capacities?: Record<string, number>;
  /** (0055) each business's own capacities this week (its shared weeks); `capacities` otherwise */
  capacitiesFor?: (workspaceId: string | null) => Record<string, number>;
  /** wave 2: the pace line */
  pace?: GoalPace;
  /** each workspace's signals (lib/businesses workspaceSignals): your own work there, and who needs you most */
  signals?: ReadonlyMap<string, WorkspaceSignal>;
  /** 0058: goals whose % comes from a project the readers can't see. Defaults to what `me` can't see
   *  (hiddenProjectOf); a meeting's agenda says it for its audience (everyone at it reads it). */
  hiddenGoal?: (g: Goal) => boolean;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const KIND_LABEL: Record<"off_track" | "at_risk", string> = { off_track: "Off track", at_risk: "At risk" };
const SEVERITY: Record<ProjectWhy, number> = { off_track: 0, at_risk: 1, missing: 2, stale: 2 };

/** The week the wins are counted over: this week so far, or on a Monday the whole of last week. */
export function winsWeek(today: Date): { from: Date; to: Date; label: string } {
  const mid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const monday = startOfWeekMon(mid);
  if (mid.getDay() === 1) return { from: addDays(monday, -7), to: addDays(monday, -1), label: "Last week's wins" };
  return { from: monday, to: mid, label: "This week's wins" };
}

/** Goals behind: marked at risk or off track, past their date unfinished, or (wave 2) behind pace. */
export function goalsBehind(goals: readonly Goal[], progress: ReadonlyMap<string, GoalProgress>, today: Date, pace?: GoalPace): GroupGoal[] {
  const todayIso = iso(today);
  const out: GroupGoal[] = [];
  for (const g of goals) {
    if (g.status === "done" || g.archivedAt) continue;
    const prog = progress.get(g.id) ?? { pct: 0, source: "manual" as const, children: 0 };
    const pct = Math.round(prog.pct);
    // (0058: a % from a project you can't see is unknown: never past due at 0%, never behind pace)
    const hidden = prog.source === "hidden";
    const read = hidden ? undefined : pace?.(g, prog, today) ?? undefined;
    const why: GoalWhy | null = g.status === "off_track" ? "off_track"
      : g.status === "at_risk" ? "at_risk"
      : !hidden && g.due && g.due < todayIso && pct < 100 ? "overdue"
      : read?.behind ? "pace" : null;
    if (why) out.push({ goal: g, pct, why, ...(read ? { pace: read } : {}), ...(hidden ? { hidden: true as const } : {}) });
  }
  const rank: Record<GoalWhy, number> = { off_track: 0, overdue: 1, at_risk: 2, pace: 3 };
  return out.sort((a, b) => rank[a.why] - rank[b.why] || (a.goal.position ?? 0) - (b.goal.position ?? 0));
}

/** One business's digest. */
export function businessDigest(ws: Workspace, role: Role, input: GroupInput): BusinessDigest {
  const { tasks: all, projects: allProjects, goals: allGoals, statusUpdates, approvals, today, members } = input;
  const wsId = ws.id;
  const tasks = all.filter((t) => (t.workspaceId ?? null) === wsId);
  const projects = allProjects.filter((p) => (p.workspaceId ?? null) === wsId && !p.archivedAt);
  const idx = indexTasks(tasks);

  // goals: progress from linked projects (this business's tasks), sub-goal roll-ups, or their own numbers
  // (an archived goal is out of the count: its quarter is over)
  const goals = allGoals.filter((g) => (g.workspaceId ?? null) === wsId && !g.archivedAt);
  // (lib/countRules: top-level tasks, the rule the Goals page and each project's header use)
  const goalTasks = (input.goalTasks ?? all).filter((t) => (t.workspaceId ?? null) === wsId) as Task[];
  const pctOf = (pid: string) => projectProgressOf(goalTasks, pid).pct;
  const behind = goalsBehind(goals, goalProgressMap(goals, pctOf, input.hiddenGoal ?? hiddenProjectOf(allProjects, input.workspaces, input.me)), today, input.pace);

  // projects: Kanbo's read of the work, the latest update's call, or an update that's gone missing
  const needs: GroupProject[] = [];
  for (const p of projects) {
    const ptasks = idx.byProject.get(p.id) ?? [];
    const health = projectHealth(ptasks, today);
    const f = statusFacts(p, tasks as Task[], statusUpdates as StatusUpdate[], today, idx);
    const call = f.latest?.status;
    const status = mergedStatus(p, f.latest, { health: health?.kind ?? null, overdue: f.overdue.length, blocked: f.blocked.length });
    const rhythm = projectRhythmState(p, ptasks, f.latest, today, input.workspaces);
    const last = f.lastUpdateDays != null ? `Last update ${f.lastUpdateDays} ${f.lastUpdateDays === 1 ? "day" : "days"} ago` : "No update yet";
    const bad = (k?: HealthKind | string): k is "off_track" | "at_risk" => k === "off_track" || k === "at_risk";
    const worst = health?.kind === "off_track" || call === "off_track" ? "off_track"
      : bad(health?.kind) || call === "at_risk" ? "at_risk" : null;
    const missing = !!rhythm && readsMissing(rhythm);
    if (worst) {
      const fromWork = !!health && health.kind === worst;
      // (the latest update's call is the row's pill, beside what Kanbo counts; a missing update says so beside it)
      needs.push({ project: p, why: worst, label: KIND_LABEL[worst], source: fromWork ? "work" : "update", status, missing,
        detail: fromWork ? health!.detail : `Update: ${KIND_LABEL[worst].toLowerCase()}` });
    } else if (rhythm ? missing : isStale(f, oldestTaskAge(ptasks, p.id, today))) {
      needs.push(rhythm
        ? { project: p, why: "missing", label: "Update missing", status, missing, detail: last }
        : { project: p, why: "stale", label: `No update in ${STALE_DAYS} days`, status, detail: last });
    }
  }
  // the lead's call rosier than the work first, then the worst off
  needs.sort((a, b) => Number(b.status.mismatch) - Number(a.status.mismatch) || SEVERITY[a.why] - SEVERITY[b.why]);

  // requests waiting for you here
  const waiting = approvalsEverywhere(approvals).filter((a) => (a.workspaceId ?? null) === wsId)
    .map((a): GroupApproval => ({ id: a.id, taskId: a.taskId, title: a.task?.title ?? a.title ?? "A task", requestedByName: a.requestedByName ?? null, createdAt: a.createdAt }));

  // the week's wins: top-level tasks finished in it, the weightiest first
  const week = winsWeek(today);
  const won = tasks.filter((t) => {
    if (t.status !== "done" || t.parentId) return false;
    const d = localDay(t.completedAt);
    return !!d && d >= week.from && d <= week.to;
  }).sort((a, b) => PRIORITY_META[b.priority].rank - PRIORITY_META[a.priority].rank || (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  // Radar, for this business alone
  const people = members.filter((m) => (m.workspaceId ?? null) === wsId && m.status === "active" && m.userId)
    .map((m) => ({ id: m.userId!, name: getMember(m.userId!)?.name || m.name || m.email, ...(m.role === "guest" ? { guest: true } : {}) }));
  let risks: Risk[] = [];
  try { risks = computeRisks({ tasks: tasks as Task[], members: people, capacities: input.capacitiesFor?.(wsId) ?? input.capacities ?? {}, today: iso(today) }); } catch { risks = []; }
  const signals = risks.filter((r) => r.severity === "signal").length;

  // your own work there (the switcher's dot counts it too)
  const sig = input.signals?.get(wsKey(wsId));
  const mine = { overdue: sig?.overdue ?? 0, dueToday: sig?.dueToday ?? 0 };

  const off = needs.filter((n) => n.why === "off_track").length;
  const score = waiting.length * 3 + off * 3 + (needs.length - off) + behind.length * 2 + signals + mine.overdue * 3 + mine.dueToday * 2;
  return {
    workspace: ws, role,
    goals: { behind, total: goals.length },
    projects: { needs, total: projects.length },
    approvals: waiting,
    wins: { count: won.length, top: won.slice(0, 3), label: week.label },
    risks: signals,
    mine,
    score,
  };
}

/** Every business you run: the one that needs you most first (as Today's brief and the switcher say it, when
 *  `signals` are given), then the rest by how much is behind (ties keep the switcher's order). */
export function groupDigest(input: GroupInput): BusinessDigest[] {
  const runs = businessesYouRun(input.workspaces, input.members, input.me);
  const order = new Map(runs.map((w, i) => [wsKey(w.id), i]));
  const list = runs
    .map((w) => businessDigest(w, roleInWorkspace(input.members, input.me, w.id)!, input))
    .sort((a, b) => b.score - a.score || (order.get(wsKey(a.workspace.id)) ?? 0) - (order.get(wsKey(b.workspace.id)) ?? 0));
  const most = input.signals ? businessLead(input.signals, runs).lead?.key : list[0] && list[0].score > 0 ? wsKey(list[0].workspace.id) : undefined;
  const i = most ? list.findIndex((d) => wsKey(d.workspace.id) === most) : -1;
  if (i < 0) return list;
  const lead = { ...list[i], needsMost: true };
  return [lead, ...list.slice(0, i), ...list.slice(i + 1)];
}

/** How many of a business's projects to look at wear an Off track pill (the lead's call, as each row shows it). */
export const offTrackPills = (d: BusinessDigest): number => d.projects.needs.filter((n) => n.status.lead === "off_track").length;

/** "1 approval · 1 of yours overdue · 1 project off track · 2 goals behind" (or "Nothing needs you"): the projects
 *  counted by the pill each row wears, so the line never says "off track" over a row that says "At risk". */
export function digestLine(d: BusinessDigest): string {
  const bits: string[] = [];
  const p = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (d.approvals.length) bits.push(p(d.approvals.length, "approval"));
  if (d.mine.overdue) bits.push(`${d.mine.overdue} of yours overdue`);
  if (d.mine.dueToday) bits.push(`${d.mine.dueToday} of yours due today`);
  const off = offTrackPills(d);
  if (off) bits.push(`${p(off, "project")} off track`);
  const look = d.projects.needs.length - off;
  if (look) bits.push(`${p(look, "project")} to look at`);
  if (d.goals.behind.length) bits.push(`${p(d.goals.behind.length, "goal")} behind`);
  return bits.length ? bits.join(" · ") : "Nothing needs you";
}
