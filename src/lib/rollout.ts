/* ============================================================
   KANBO — rolling Kanbo out to a team (0058), the rules:
   · Workspace health, for a team's owners and admins: who was invited
     and hasn't joined, who's been active in the last 7 days (by day,
     never by the minute: workspace_activity), open tasks with no owner
     or no date, projects whose update is missing (0053's update day;
     before it, none in 14 days) and goals with no check-in in two
     weeks (0052). Each line has one fix.
   · Kanbo noticed nudges an owner one fix at a time (the most useful
     first), never more than one.
   · "Welcome to <workspace>" on Today for someone who joined lately:
     their projects, their people, the team's top goal, who to ask and
     one or two starter tasks. Shown once per workspace.
   Pure: no React, no I/O, no clock of its own.
   ============================================================ */
import type { Goal, GoalCheckin, Project, Role, RolloutPlan, StatusUpdate, Task, Workspace, WorkspaceMember } from "../data/types";
import type { Noticed } from "./noticed";
import { indexTasks, isStale, oldestTaskAge, statusFacts } from "./statusDraft";
import { projectRhythmState, readsMissing } from "./updateRhythm";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayNo = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };
/** whole days from `iso` (a date or a timestamp, read on this device) to `today` */
export function daysSince(iso: string, today: Date): number {
  const day = iso.length > 10 ? localIso(new Date(iso)) : iso;
  return Math.round(dayNo(localIso(today)) - dayNo(day));
}
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
/** "Priya", "Priya and Jonas", "Priya, Jonas and Sam", "Priya, Jonas and 3 others" */
export function namesLine(names: string[], max = 3): string {
  const ns = names.filter(Boolean);
  if (ns.length <= 1) return ns[0] ?? "";
  if (ns.length <= max) return `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
  return `${ns.slice(0, max - 1).join(", ")} and ${plural(ns.length - (max - 1), "other")}`;
}

/* ================================ activity (workspace_activity) ================================ */

export interface MemberActivity {
  userId: string;
  /** how many of the last 7 days (today included) they were active */
  days: number;
  /** the last day they were active ("YYYY-MM-DD"), within 30 days; null: not in the last 30 */
  lastDay: string | null;
}
export interface WorkspaceActivity {
  /** the server's today ("YYYY-MM-DD", London) */
  today: string;
  members: MemberActivity[];
  /** the last 7 days, oldest first: how many people were active each day */
  days: { day: string; people: number }[];
}

/** workspace_activity's answer (anything) → WorkspaceActivity, or null. Only days are kept, never times. */
export function parseActivity(raw: unknown): WorkspaceActivity | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.today !== "string") return null;
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const members = (Array.isArray(o.members) ? o.members : []).flatMap((m): MemberActivity[] => {
    const r = m as Record<string, unknown>;
    if (!r || typeof r.user_id !== "string") return [];
    const n = Number(r.days);
    return [{ userId: r.user_id, days: Number.isFinite(n) ? Math.max(0, Math.min(7, Math.round(n))) : 0, lastDay: day(r.last_day) }];
  });
  const days = (Array.isArray(o.days) ? o.days : []).flatMap((d) => {
    const r = d as Record<string, unknown>;
    const at = day(r?.day);
    const n = Number(r?.people);
    return at ? [{ day: at, people: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0 }] : [];
  });
  return { today: day(o.today) ?? o.today, members, days };
}

/** "Today", "Yesterday", "3 days ago", "Last week", "Over a week ago", "Not this month" — rough on purpose. */
export function lastActiveWords(lastDay: string | null, today: string): string {
  if (!lastDay) return "Not in the last month";
  const n = Math.round(dayNo(today) - dayNo(lastDay));
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n < 7) return `${n} days ago`;
  if (n < 14) return "Over a week ago";
  return "Over two weeks ago";
}

/* ================================ Workspace health ================================ */

/** a goal is due a check-in after this many days without one */
export const CHECKIN_DAYS = 14;

export interface HealthInput {
  workspaceId: string;
  /** every workspace's memberships (this one's are picked out) */
  members: readonly WorkspaceMember[];
  /** the workspace's live tasks (others are ignored) */
  tasks: readonly Task[];
  projects: readonly Project[];
  statusUpdates: readonly StatusUpdate[];
  workspaces: readonly Workspace[];
  /** 0052: goals and check-ins (null: goals 2.0 isn't in, so there's no check-in line) */
  goals?: readonly Goal[] | null;
  checkins?: readonly GoalCheckin[] | null;
  /** which goals take check-ins (lib/goalFlow takesCheckins): a goal its work moves doesn't need them */
  takesCheckin?: (goal: Goal) => boolean;
  /** workspace_activity (null: not loaded, or not switched on) */
  activity?: WorkspaceActivity | null;
  today: Date;
}

export interface WorkspaceHealth {
  /** invited, not joined yet */
  invited: WorkspaceMember[];
  /** active people (the activity line); null without workspace_activity */
  active: { count: number; of: number; days: { day: string; people: number }[]; quiet: { member: WorkspaceMember; lastDay: string | null }[]; today: string } | null;
  /** open top-level tasks with no owner, or no date */
  loose: { tasks: Task[]; noOwner: number; noDate: number };
  /** projects whose update is missing */
  missing: Project[];
  /** goals with no check-in for two weeks (null: goals 2.0 isn't in) */
  quietGoals: Goal[] | null;
  /** how many lines need a look (the card's count) */
  issues: number;
}

const isOpen = (t: Task) => t.status !== "done" && !t.archivedAt;

/** The health of one team workspace. */
export function workspaceHealth(input: HealthInput): WorkspaceHealth {
  const { workspaceId: ws, today } = input;
  const mine = input.members.filter((m) => m.workspaceId === ws);
  const invited = mine.filter((m) => m.status === "invited");
  const people = mine.filter((m) => m.status === "active" && !!m.userId);

  let active: WorkspaceHealth["active"] = null;
  if (input.activity) {
    const a = input.activity;
    const by = new Map(a.members.map((m) => [m.userId, m]));
    const quiet = people.filter((m) => (by.get(m.userId!)?.days ?? 0) === 0)
      .map((member) => ({ member, lastDay: by.get(member.userId!)?.lastDay ?? null }))
      .sort((x, y) => (x.lastDay ?? "").localeCompare(y.lastDay ?? ""));
    active = { count: people.length - quiet.length, of: people.length, days: a.days, quiet, today: a.today };
  }

  const projects = input.projects.filter((p) => (p.workspaceId ?? null) === ws && !p.archivedAt);
  const live = new Set(projects.map((p) => p.id));
  const tasks = input.tasks.filter((t) => (t.workspaceId ?? null) === ws && !t.archivedAt && (!t.projectId || live.has(t.projectId) || t.projectId === "p-personal")) as Task[];
  const loose = tasks.filter((t) => isOpen(t) && !t.parentId && (!t.assigneeId || !t.dueDate))
    .sort((a, b) => Number(!!a.assigneeId) - Number(!!b.assigneeId) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.title.localeCompare(b.title));

  // a project's update: missing by its update day (0053), or none in 14 days before it
  const idx = indexTasks(tasks);
  const missing: Project[] = [];
  for (const p of projects) {
    if (p.status === "on_hold") continue;
    const ptasks = idx.byProject.get(p.id) ?? [];
    const f = statusFacts(p, tasks, input.statusUpdates as StatusUpdate[], today, idx);
    const rhythm = projectRhythmState(p, ptasks, f.latest, today, input.workspaces);
    if (rhythm ? readsMissing(rhythm) : isStale(f, oldestTaskAge(ptasks, p.id, today))) missing.push(p);
  }

  let quietGoals: Goal[] | null = null;
  if (input.goals && input.checkins) {
    const last = new Map<string, string>();
    for (const c of input.checkins) if ((last.get(c.goalId) ?? "") < c.createdAt) last.set(c.goalId, c.createdAt);
    quietGoals = input.goals.filter((g) => (g.workspaceId ?? null) === ws && !g.archivedAt && g.status !== "done"
      && (input.takesCheckin ? input.takesCheckin(g) : true)
      && (() => {
        const at = last.get(g.id) ?? g.createdAt;
        return !at || daysSince(at, today) >= CHECKIN_DAYS;
      })());
  }

  const issues = Number(invited.length > 0) + Number(loose.length > 0) + Number(missing.length > 0) + Number(!!quietGoals?.length)
    + Number(!!active && active.of > 1 && active.count < Math.ceil(active.of / 2));
  return { invited, active, loose: { tasks: loose, noOwner: loose.filter((t) => !t.assigneeId).length, noDate: loose.filter((t) => !t.dueDate).length }, missing, quietGoals, issues };
}

/** The fixes the card and the nudge offer. */
export type HealthFix = "resend" | "assign" | "ask" | "goals";

/** an invite is worth a nudge once it's had this long to be answered */
export const INVITE_NUDGE_DAYS = 2;

/** Kanbo noticed, for a team's owners and admins: the one fix that helps most right now (none: nothing). */
export function healthNudge(h: WorkspaceHealth, ctx: { workspaceId: string; workspaceName: string; memberName: (m: WorkspaceMember) => string; today: Date }): Noticed | null {
  const ws = ctx.workspaceName;
  // (an invite that's just gone out isn't late yet; one with no date is from before it was kept)
  const waiting = h.invited.filter((m) => !m.invitedAt || daysSince(m.invitedAt, ctx.today) >= INVITE_NUDGE_DAYS);
  if (waiting.length) {
    const n = waiting.length;
    // named people by first name; a bare address isn't a name to put in a sentence
    const named = waiting.every((m) => !!m.name?.trim());
    const names = namesLine(waiting.map((m) => firstName(ctx.memberName(m))));
    return {
      id: `rollout:invited:${ctx.workspaceId}:${n}`, kind: "rollout", tone: "accent", icon: "users",
      title: n === 1 && named ? `${names} hasn't joined ${ws} yet` : `${plural(n, "person", "people")} ${n === 1 ? "hasn't" : "haven't"} joined ${ws}`,
      body: named
        ? `${names} ${n === 1 ? "was" : "were"} invited but ${n === 1 ? "hasn't" : "haven't"} signed in yet. A fresh invite often does it.`
        : `${n === 1 ? "Someone you invited hasn't" : "People you invited haven't"} signed in yet. A fresh invite often does it.`,
      actions: [{ kind: "fix", label: n === 1 ? "Resend invite" : "Resend all", fix: "resend" }, { kind: "fix", label: "See health", fix: "health" }],
    };
  }
  if (h.loose.noOwner > 0) {
    const n = h.loose.noOwner;
    return {
      id: `rollout:owner:${ctx.workspaceId}:${n}`, kind: "rollout", tone: "warn", icon: "user",
      title: `${plural(n, "task")} in ${ws} ${n === 1 ? "has" : "have"} no owner`,
      body: n === 1 ? "Work nobody owns tends to wait. Give it to someone, or to its project's owner." : "Work nobody owns tends to wait. Give each one to someone, or to its project's owner.",
      actions: [{ kind: "fix", label: "Assign now", fix: "assign" }],
    };
  }
  if (h.missing.length) {
    const n = h.missing.length;
    return {
      id: `rollout:updates:${ctx.workspaceId}:${n}`, kind: "rollout", tone: "warn", icon: "message",
      title: n === 1 ? `${h.missing[0].name} has no update` : `${n} projects have no update`,
      body: n === 1 ? "Its update is missing. Ask its owner for one: they'll find Kanbo's draft waiting." : `Their updates are missing. Ask their owners: each will find Kanbo's draft waiting.`,
      actions: [{ kind: "fix", label: n === 1 ? "Ask for it" : "Ask for updates", fix: "ask" }],
    };
  }
  if (h.loose.noDate > 0) {
    const n = h.loose.noDate;
    return {
      id: `rollout:date:${ctx.workspaceId}:${n}`, kind: "rollout", tone: "accent", icon: "calendar",
      title: `${plural(n, "task")} in ${ws} ${n === 1 ? "has" : "have"} no date`,
      body: "Undated work never reaches anyone's day. A rough date is better than none.",
      actions: [{ kind: "fix", label: "Add dates", fix: "assign" }],
    };
  }
  if (h.quietGoals?.length) {
    const n = h.quietGoals.length;
    return {
      id: `rollout:goals:${ctx.workspaceId}:${n}`, kind: "rollout", tone: "accent", icon: "target",
      title: n === 1 ? `${h.quietGoals[0].name} hasn't had a check-in` : `${n} goals haven't had a check-in`,
      body: `Nothing's been checked in for two weeks or more, so nobody knows if ${n === 1 ? "it's" : "they're"} on track.`,
      actions: [{ kind: "fix", label: "Open goals", fix: "goals" }],
    };
  }
  return null;
}

/* ================================ Welcome to <workspace> ================================ */

/** how long after joining someone is welcomed */
export const WELCOME_DAYS = 30;
/** before 0058 records when people join: an account this new is new here */
export const NEW_ACCOUNT_DAYS = 14;

/** Should Today welcome `me` to this workspace? A team workspace they joined (not one they own) in the last
 *  WELCOME_DAYS, that they haven't put the card away in. Before 0058 (no joinedAt at all): a new account. */
export function shouldWelcome(input: {
  me: string;
  workspace: Pick<Workspace, "id" | "kind" | "ownerId"> | undefined;
  membership: Pick<WorkspaceMember, "role" | "status" | "joinedAt"> | undefined;
  welcomed?: Record<string, string>;
  accountCreatedAt?: string | null;
  today: Date;
}): boolean {
  const { workspace: w, membership: m } = input;
  if (!w?.id || w.kind !== "team" || w.ownerId === input.me) return false;
  if (!m || m.status !== "active" || m.role === "owner") return false;
  if (input.welcomed?.[w.id]) return false;
  if (m.joinedAt) return daysSince(m.joinedAt, input.today) <= WELCOME_DAYS;
  if (m.joinedAt === null) return false;   // 0058 is in: they joined before it kept the date, a while ago
  return !!input.accountCreatedAt && daysSince(input.accountCreatedAt, input.today) <= NEW_ACCOUNT_DAYS;
}

export interface WelcomePerson { id: string; name: string; role: Role; title?: string }
export interface WelcomeContent {
  /** yours first (you own, help on or have work in), then the team's; at most four */
  projects: Project[];
  /** everyone else here, owners and admins first; at most six */
  people: WelcomePerson[];
  /** how many more people beyond `people` */
  morePeople: number;
  /** the team's top goal (none for a guest, or none set) */
  goal: Goal | null;
  /** who to ask: the rollout's champion, else whoever runs it */
  ask: (WelcomePerson & { why: "champion" | "owner" | "admin" }) | null;
  /** one or two of your open tasks here, soonest first */
  starters: Task[];
}

const ROLE_RANK: Record<Role, number> = { owner: 0, admin: 1, member: 2, guest: 3 };

/** What the welcome card shows `me` in a workspace. */
export function welcomeContent(input: {
  me: string;
  workspace: Pick<Workspace, "id" | "ownerId"> & { rollout?: RolloutPlan | null };
  role: Role;
  members: readonly WorkspaceMember[];
  projects: readonly Project[];
  tasks: readonly Task[];
  goals?: readonly Goal[];
  nameOf: (m: WorkspaceMember) => string;
  /** the goals' quarter (lib/goalPeriods quarterOf), to prefer this quarter's */
  quarter?: string;
}): WelcomeContent {
  const ws = input.workspace.id;
  const tasks = input.tasks.filter((t) => (t.workspaceId ?? null) === ws && !t.archivedAt);
  const projects = input.projects.filter((p) => (p.workspaceId ?? null) === ws && !p.archivedAt && p.id !== "p-personal");
  const myWork = new Set(tasks.filter((t) => t.assigneeId === input.me || (t.collaborators ?? []).includes(input.me)).map((t) => t.projectId));
  const yours = (p: Project) => p.ownerId === input.me || (p.contributorIds ?? []).includes(input.me) || myWork.has(p.id);
  const shownProjects = [...projects].sort((a, b) => Number(yours(b)) - Number(yours(a))).slice(0, 4);

  const here = input.members.filter((m) => m.workspaceId === ws && m.status === "active" && m.userId && m.userId !== input.me);
  const person = (m: WorkspaceMember): WelcomePerson => ({ id: m.userId!, name: input.nameOf(m), role: m.role, ...(m.title ? { title: m.title } : {}) });
  const sorted = [...here].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || input.nameOf(a).localeCompare(input.nameOf(b)));
  const people = sorted.slice(0, 6).map(person);

  // the team's top goal: a company goal (top level) that's live, this quarter's first, then by position
  const goals = input.role === "guest" ? [] : (input.goals ?? []).filter((g) => (g.workspaceId ?? null) === ws && !g.parentId && !g.archivedAt && g.status !== "done");
  const inQuarter = (g: Goal) => !!input.quarter && g.period === input.quarter;
  const goal = [...goals].sort((a, b) => Number(inQuarter(b)) - Number(inQuarter(a)) || (a.position ?? 0) - (b.position ?? 0))[0] ?? null;

  const champ = input.workspace.rollout?.champion;
  const champion = champ && champ !== input.me ? here.find((m) => m.userId === champ && m.role !== "guest") : undefined;
  const owner = here.find((m) => m.userId === input.workspace.ownerId) ?? here.find((m) => m.role === "owner");
  const admin = here.find((m) => m.role === "admin");
  const ask = champion ? { ...person(champion), why: "champion" as const } : owner ? { ...person(owner), why: "owner" as const } : admin ? { ...person(admin), why: "admin" as const } : null;

  const starters = input.role === "guest" ? [] : tasks.filter((t) => isOpen(t) && !t.parentId && t.assigneeId === input.me)
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || (b.aiScore ?? 0) - (a.aiScore ?? 0)).slice(0, 2);

  return { projects: shownProjects, people, morePeople: Math.max(0, here.length - people.length), goal, ask, starters };
}

/** Put the welcome away for a workspace (it's shown once). */
export function welcomedNow(welcomed: Record<string, string> | undefined, workspaceId: string, now = new Date()): Record<string, string> {
  return { ...(welcomed ?? {}), [workspaceId]: now.toISOString() };
}

/* ================================ the first run's team path ================================ */

/** "Just me", "My team" or "A whole business". */
export type TeamKind = "solo" | "team" | "business";

/** Emails typed for the pilot group: valid ones (once each, lower case), and what didn't look like one. */
export function pilotEmails(text: string): { valid: string[]; invalid: string[] } {
  const parts = text.split(/[\s,;]+/).map((s) => s.trim().replace(/^<|>$/g, "")).filter(Boolean);
  const valid: string[] = [], invalid: string[] = [];
  for (const p of parts) {
    const e = p.toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { if (!valid.includes(e)) valid.push(e); }
    else invalid.push(p);
  }
  return { valid, invalid };
}
