/* ============================================================
   KANBO — every business you're in, at once.
   · which workspaces you run (owner or admin: the Group page's businesses)
     and whether All businesses is on offer (you're in more than one);
   · each workspace's signals for the switcher's dots: unread Inbox items,
     and what needs you there (your overdue and due-today work, requests
     waiting for your approval);
   · All businesses on Today, Inbox and My tasks: every workspace's tasks,
     Inbox items and requests that the single-workspace views leave out;
   · the brief's lead line in All businesses ("Courtside Padel needs you
     most today: …"), the business that needs you most first;
   · the blocks you've planned in other businesses, as busy time on Today.
   Pure: no React, no storage. Everything here reads what's already loaded
   for you (rows the database lets you see), so it can never show anything
   you couldn't open yourself.
   ============================================================ */
import type { Activity, ActivityKind, ApprovalWithTask, CalEvent, Project, Role, Task, Workspace, WorkspaceMember } from "../data/types";
import { PRIORITY_META } from "../data/data";
import { docMentionRoute } from "./docMentions";
import { durOf, isOnCanvas } from "../components/views/planCanvas";

/** A workspace as a key: its id, or "personal". */
export const wsKey = (id: string | null | undefined): string => id ?? "personal";
const PERSONAL_KEY = wsKey(null);

/** Your role in a workspace (null for Personal, or one you're not an active member of). */
export function roleInWorkspace(members: readonly WorkspaceMember[], me: string, wsId: string | null | undefined): Role | null {
  if (!wsId) return null;
  return members.find((m) => (m.workspaceId ?? null) === wsId && m.userId === me && m.status === "active")?.role ?? null;
}

/** The businesses you run: team workspaces where you're an owner or admin, in the switcher's order. */
export function businessesYouRun(workspaces: readonly Workspace[], members: readonly WorkspaceMember[], me: string): Workspace[] {
  return workspaces.filter((w) => w.kind === "team" && w.id !== null && ["owner", "admin"].includes(roleInWorkspace(members, me, w.id) ?? ""));
}

/** The Group page is for someone who runs two or more businesses. */
export const hasGroup = (workspaces: readonly Workspace[], members: readonly WorkspaceMember[], me: string): boolean =>
  businessesYouRun(workspaces, members, me).length >= 2;

/** All businesses is offered once you're in more than one workspace (Personal counts). */
export const offersAllBusinesses = (workspaces: readonly Workspace[]): boolean => workspaces.length >= 2;

/** A short name for tight places ("Courtside Padel" stays whole; past 18 characters it's cut). */
export function shortName(name: string, max = 18): string {
  const n = name.trim();
  return n.length > max ? n.slice(0, max - 1).trimEnd() + "…" : n;
}

/* ---------- what's live ---------- */

/** Tasks still in play: not archived, and not in an archived project. */
export function liveTasks(tasks: readonly Task[], projects: readonly Pick<Project, "id" | "archivedAt">[]): Task[] {
  const archived = new Set(projects.filter((p) => p.archivedAt).map((p) => p.id));
  return tasks.filter((t) => !t.archivedAt && !archived.has(t.projectId));
}

/** Yours: assigned to you, or you're a collaborator (as My tasks counts them). */
export const isYours = (t: Pick<Task, "assigneeId" | "collaborators">, me: string): boolean =>
  t.assigneeId === me || (t.collaborators ?? []).includes(me);

/** Your own actions (history, not notifications): never unread. */
export const SELF_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>(["created", "status", "completed", "reopened", "deleted"]);

/** The workspace an Inbox item belongs to: its task's (a doc @mention: its project's). Undefined when
 *  it can't be told (a deleted task, a project you can't see) or it's about your own setup (integrations). */
export function activityWorkspace(a: Activity, wsOfTask: ReadonlyMap<string, string | null>, projects: readonly Pick<Project, "id" | "workspaceId">[]): string | null | undefined {
  if (a.taskId != null) return wsOfTask.has(a.taskId) ? wsOfTask.get(a.taskId) ?? null : undefined;
  const r = docMentionRoute(a);
  if (!r) return undefined;
  const p = projects.find((x) => x.id === r.projectId);
  return p ? p.workspaceId ?? null : undefined;
}

/** All businesses' Inbox: what every workspace's Inbox shows, together. As each one does, an item whose
 *  task (or doc's project) can't be found is left out; your integration notices show once. */
export function inboxEverywhere(activity: readonly Activity[], tasks: readonly Task[], projects: readonly Pick<Project, "id" | "workspaceId">[]): Activity[] {
  const wsOfTask = new Map(tasks.map((t) => [t.id, t.workspaceId ?? null] as const));
  return activity.filter((a) => (a.kind === "integration" && a.taskId == null) || activityWorkspace(a, wsOfTask, projects) !== undefined);
}

/** Requests waiting on you, in every workspace: each one still in its task's workspace (as each Inbox keeps them). */
export function approvalsEverywhere<A extends Pick<ApprovalWithTask, "workspaceId" | "task">>(list: readonly A[]): A[] {
  return list.filter((a) => !a.task || (a.task.workspaceId ?? null) === (a.workspaceId ?? null));
}

/** A reply's @mentions, kept to people who can see the task: active members of its workspace (nobody,
 *  for a Personal task). In All businesses a reply can be on any business's task. */
export function mentionsInWorkspace(mentions: readonly string[] | undefined, wsId: string | null | undefined, members: readonly WorkspaceMember[]): string[] | undefined {
  if (!mentions?.length) return mentions ? [] : undefined;
  if (!wsId) return [];
  const here = new Set(members.filter((m) => (m.workspaceId ?? null) === wsId && m.status === "active" && m.userId).map((m) => m.userId!));
  return mentions.filter((id) => here.has(id));
}

/* ---------- each workspace's signals (the switcher's dots) ---------- */

export interface WorkspaceSignal {
  /** unread Inbox items there (not your own actions) */
  unread: number;
  /** your open work there that's past its date */
  overdue: number;
  /** your open work there due today */
  dueToday: number;
  /** requests there waiting for your approval */
  approvals: number;
  /** overdue + due today + approvals: what the attention dot counts */
  attention: number;
  /** the one thing to name for it: your most pressing overdue or due-today task there */
  top?: Task;
  /** …and whether it's overdue (else it's due today) */
  topOverdue?: boolean;
  /** "2 approvals · 1 overdue" (empty when nothing needs you) */
  detail: string;
}

const day10 = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 approvals · 1 overdue · 1 due today" */
export function signalDetail(s: Pick<WorkspaceSignal, "approvals" | "overdue" | "dueToday">): string {
  const bits: string[] = [];
  if (s.approvals) bits.push(plural(s.approvals, "approval"));
  if (s.overdue) bits.push(`${s.overdue} overdue`);
  if (s.dueToday) bits.push(`${s.dueToday} due today`);
  return bits.join(" · ");
}

/** Signals for every workspace you're in, by wsKey. `tasks` are every live task you can see (with your own
 *  plan on them); `activity` your Inbox items from every workspace; `approvals` the requests waiting on you. */
export function workspaceSignals(input: {
  workspaces: readonly Workspace[];
  tasks: readonly Task[];
  projects: readonly Pick<Project, "id" | "workspaceId">[];
  activity: readonly Activity[];
  approvals: readonly Pick<ApprovalWithTask, "workspaceId" | "task">[];
  me: string;
  today: string;
}): Map<string, WorkspaceSignal> {
  const { workspaces, tasks, projects, activity, approvals, me, today } = input;
  const out = new Map<string, WorkspaceSignal>();
  const at = (k: string) => {
    let s = out.get(k);
    if (!s) { s = { unread: 0, overdue: 0, dueToday: 0, approvals: 0, attention: 0, detail: "" }; out.set(k, s); }
    return s;
  };
  for (const w of workspaces) at(wsKey(w.id));
  const rank = (t: Task) => (day10(t.dueDate) < today ? 10 : 0) + PRIORITY_META[t.priority].rank;
  for (const t of tasks) {
    if (t.status === "done" || t.parentId || !isYours(t, me) || !t.dueDate) continue;
    const d = day10(t.dueDate);
    if (d > today) continue;
    const s = at(wsKey(t.workspaceId));
    if (d < today) s.overdue++; else s.dueToday++;
    if (!s.top || rank(t) > rank(s.top)) { s.top = t; s.topOverdue = d < today; }
  }
  const wsOfTask = new Map(tasks.map((t) => [t.id, t.workspaceId ?? null] as const));
  for (const a of activity) {
    if (a.readAt || SELF_KINDS.has(a.kind)) continue;
    const ws = activityWorkspace(a, wsOfTask, projects);
    if (ws !== undefined) at(wsKey(ws)).unread++;
  }
  for (const a of approvalsEverywhere(approvals)) at(wsKey(a.workspaceId)).approvals++;
  for (const s of out.values()) {
    s.attention = s.overdue + s.dueToday + s.approvals;
    s.detail = signalDetail(s);
  }
  return out;
}

/* ---------- the brief's lead, in All businesses ---------- */

export interface BusinessNeed {
  key: string;
  workspace: Workspace;
  /** "the lighting order", "1 approval", "2 overdue" */
  parts: string[];
  score: number;
  /** the task the lead names first */
  taskId?: string;
}
export interface BusinessLead {
  /** the business that needs you most today (none when nothing does) */
  lead: BusinessNeed | null;
  /** the rest that need something, most first */
  others: BusinessNeed[];
  /** the whole line as words (screen readers, tests) */
  plain: string;
}

/** A task's title inside a sentence: shortened, its first letter lowered unless it starts a name. */
export function taskPhrase(title: string, max = 40): string {
  const t = title.trim().replace(/[.!\s]+$/, "");
  const cut = t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
  return /^[A-Z][a-z]/.test(cut) ? cut.charAt(0).toLowerCase() + cut.slice(1) : cut;
}

/** Who needs you most today, across every workspace: requests and overdue work weigh most, then what's
 *  due today, then unread items. The lead names its most pressing task; the others say what they hold. */
export function businessLead(signals: ReadonlyMap<string, WorkspaceSignal>, workspaces: readonly Workspace[]): BusinessLead {
  const needs: BusinessNeed[] = [];
  workspaces.forEach((w) => {
    const s = signals.get(wsKey(w.id));
    if (!s || !s.attention) return;
    const parts: string[] = [];
    if (s.top) parts.push(taskPhrase(s.top.title));
    if (s.approvals) parts.push(plural(s.approvals, "approval"));
    // the rest of what's late or due, beyond the task already named
    const moreLate = s.overdue - (s.top && s.topOverdue ? 1 : 0);
    const moreToday = s.dueToday - (s.top && !s.topOverdue ? 1 : 0);
    if (moreLate > 0) parts.push(`${moreLate} more overdue`);
    if (moreToday > 0) parts.push(`${moreToday} more due today`);
    needs.push({ key: wsKey(w.id), workspace: w, parts, score: s.approvals * 3 + s.overdue * 3 + s.dueToday * 2 + Math.min(s.unread, 3), taskId: s.top?.id });
  });
  // most first; a tie keeps the switcher's order
  const order = new Map(workspaces.map((w, i) => [wsKey(w.id), i]));
  needs.sort((a, b) => b.score - a.score || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  const [lead = null, ...others] = needs;
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const plain = lead
    ? [`${lead.workspace.name} needs you most today: ${list(lead.parts)}.`, ...others.map((o) => `${o.workspace.name}: ${o.parts.join(", ")}.`)].join(" ")
    : "";
  return { lead, others, plain };
}

/* ---------- time planned in other businesses ---------- */

/** Your blocks on today's canvas in other workspaces, as busy time for this one's day (Plan my day works
 *  round them, and free time leaves them out). Breaks, not meetings: they aren't counted as meetings. */
export function busyElsewhere(tasks: readonly Task[], activeWs: string | null, me: string, nameOf: (wsId: string | null) => string): CalEvent[] {
  const here = wsKey(activeWs);
  return tasks
    .filter((t) => isOnCanvas(t) && isYours(t, me) && wsKey(t.workspaceId) !== here)
    .map((t): CalEvent => {
      const name = t.workspaceId ? nameOf(t.workspaceId) : nameOf(null);
      return { id: `elsewhere-${t.id}`, title: `${name} · ${t.title}`, start: t.scheduled!, end: t.scheduled! + durOf(t), kind: "break", calendarName: name };
    })
    .sort((a, b) => a.start - b.start);
}

/** Personal's key, for callers that need it. */
export { PERSONAL_KEY };
