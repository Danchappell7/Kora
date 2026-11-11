/* ============================================================
   KANBO — project access (0058), the app's mirror. Each team
   workspace has a switch, Project access, off by default. While it's
   off every member edits and every guest reads and comments on every
   project, exactly as before. While it's on each project has a
   visibility (Whole workspace, Members only, Private) and its people
   (editor, commenter, viewer); owners always see everything, and
   guests see only the projects they're on.
   One rank per person and project decides it: 0 none, 1 view,
   2 comment, 3 edit. rankCore is a line-for-line port of the
   database's pa_rank_core (0058 §2.1), checked against the same table
   (projectAccessMatrix.json) as the PGlite suite, so they can't drift.
   The server enforces all of it; this only keeps the screen honest.
   Before 0058 nothing here switches anything on (accessSchema()).
   ============================================================ */
import type { Project, ProjectMember, ProjectRole, ProjectVisibility, Role, Task, Workspace, WorkspaceMember } from "../data/types";
import { supabase } from "./supabase";

export type Rank = 0 | 1 | 2 | 3;
export const VISIBILITIES: ProjectVisibility[] = ["workspace", "members", "private"];
export const PROJECT_ROLES: ProjectRole[] = ["editor", "commenter", "viewer"];

/* ---------- is 0058 in? (the sign-in read says; the demo always has it) ---------- */

let schema: boolean | null = null;
/** The sign-in read saw workspaces.project_access come back: 0058 is in. */
export function noteAccessSchema(on: boolean): void { schema = on; }
/** Can project access be read and set here? Unknown (no team workspace read yet): only in the demo. */
export function accessSchema(): boolean { return schema ?? !supabase; }
/** (tests) */
export function resetAccessSchema(): void { schema = null; }

/** Is the switch on in this workspace (and 0058 in)? */
export function accessOn(ws: Pick<Workspace, "projectAccess"> | undefined | null): boolean {
  return accessSchema() && ws?.projectAccess?.on === true;
}
/** A project's visibility; before 0058 (or a personal project) it's Whole workspace. */
export const visibilityOf = (p: Pick<Project, "visibility"> | undefined | null): ProjectVisibility => p?.visibility ?? "workspace";

const memberRank = (role: string | null | undefined): Rank => (role === "editor" ? 3 : role === "commenter" ? 2 : role === "viewer" ? 1 : 0);

/** pa_rank_core (0058 §2.1). `visibility` null is a loose row: a task whose project isn't a
 *  real project in its workspace. `wsRole` null or "none" is an outsider (removed, suspended). */
export function rankCore(on: boolean, wsRole: string | null | undefined, visibility: ProjectVisibility | null, isOwner: boolean, member: string | null | undefined): Rank {
  if (!wsRole || !["owner", "admin", "member", "guest"].includes(wsRole)) return 0;
  if (!on) return wsRole === "guest" ? 2 : 3;
  if (wsRole === "owner") return 3;
  if (visibility === null) return wsRole === "guest" ? 0 : 3;
  if (wsRole === "guest" && isOwner) return 2; // a guest who owns it (made a guest later): theirs, comment at most
  if (wsRole === "guest") return Math.min(memberRank(member), 2) as Rank;
  if (isOwner) return 3;
  if (visibility === "workspace") return 3;
  if (visibility === "members" && wsRole === "admin") return 3;
  return memberRank(member);
}

/** What the rank questions need: who you are, the workspaces, the projects and their people. */
export interface AccessCtx {
  me: string;
  workspaces: Workspace[];
  projects: Project[];
  wsMembers: WorkspaceMember[];
  /** project_members (null: before 0058) */
  members: ProjectMember[] | null;
}

/** someone's role in a workspace (active only); null for Personal or nobody. As the database's
 *  ws_role, the workspace's owner is its owner even when their own row isn't there (or wasn't read). */
export function roleOf(ctx: Pick<AccessCtx, "wsMembers"> & Partial<Pick<AccessCtx, "workspaces">>, wsId: string | null | undefined, userId: string): Role | null {
  if (!wsId) return null;
  return ctx.wsMembers.find((m) => m.workspaceId === wsId && m.userId === userId && m.status === "active")?.role
    ?? (userId && ctx.workspaces?.some((w) => w.id === wsId && w.ownerId === userId) ? "owner" : null);
}
const wsOf = (ctx: Pick<AccessCtx, "workspaces">, id: string | null | undefined) => (id ? ctx.workspaces.find((w) => w.id === id) : undefined);
/** someone's stored role on a project (null: not on it) */
export function memberRole(ctx: Pick<AccessCtx, "members">, projectId: string, userId: string): ProjectRole | null {
  return ctx.members?.find((m) => m.projectId === projectId && m.userId === userId)?.role ?? null;
}

/** A person's rank on a project in a team workspace. An unknown project id there is loose. Your own
 *  role in one of your workspaces that couldn't be read (the member list didn't load) is today's while
 *  the switch is off, or before 0058: not a guest, so the server decides, as it always has. With it on,
 *  it's nothing (view only), never a writer. */
export function rankFor(ctx: AccessCtx, userId: string, wsId: string | null | undefined, projectId: string | null | undefined): Rank {
  if (!wsId) return 3; // Personal: your own space (only you can see it)
  const ws = wsOf(ctx, wsId);
  const role = roleOf(ctx, wsId, userId) ?? (userId === ctx.me && ws && !accessOn(ws) ? "member" : null);
  const p = projectId ? ctx.projects.find((x) => x.id === projectId && (x.workspaceId ?? null) === wsId) : undefined;
  return rankCore(accessOn(ws), role, p ? visibilityOf(p) : null, !!p && !!p.ownerId && p.ownerId === userId, p ? memberRole(ctx, p.id, userId) : null);
}
/** Can't `userId` be given new work in this team project (with the switch on; the caller checks it)?
 *  Someone who can't see it, and someone who has left the workspace (or never was in it): the server
 *  never gives either a task (trg_tasks_pa), though someone who has left keeps one they had when it
 *  moves. Their absence counts only once the workspace's member list has loaded; before that, the server
 *  decides. Someone suspended is a member here, as the server judges them. */
export function cantBeGiven(ctx: AccessCtx, wsId: string, userId: string, projectId: string | null | undefined): boolean {
  if (roleOf(ctx, wsId, userId)) return rankFor(ctx, userId, wsId, projectId) < 1;
  return ctx.wsMembers.some((m) => m.workspaceId === wsId && m.status === "active");
}
/** Your rank on a project (3 for a personal one). */
export function projectRank(projectId: string | null | undefined, ctx: AccessCtx): Rank {
  const p = projectId ? ctx.projects.find((x) => x.id === projectId) : undefined;
  if (p && (p.workspaceId ?? null) === null) return 3;
  return rankFor(ctx, ctx.me, p?.workspaceId ?? null, projectId);
}
/** Your rank on a task: its workspace, and its project there (loose when that isn't one). */
export function taskRank(task: Pick<Task, "workspaceId" | "projectId">, ctx: AccessCtx): Rank {
  const ws = task.workspaceId ?? ctx.projects.find((p) => p.id === task.projectId)?.workspaceId ?? null;
  return rankFor(ctx, ctx.me, ws, task.projectId);
}

/** Who a project's copy starts with: its people, and, while the switch is on (or whenever the copy is
 *  Members only or Private: `copyVisibility`), its owner when the copy is someone else's (an owner has no
 *  row of their own, and would lose a closed copy). A Whole workspace copy with the switch off: its
 *  people as they are, today's contributors, nobody added. */
export function copyPeople(src: Pick<Project, "id" | "workspaceId" | "ownerId">, ctx: AccessCtx, copyVisibility?: ProjectVisibility): string[] {
  const wsId = src.workspaceId ?? null;
  const own = (ctx.members ?? []).filter((m) => m.projectId === src.id).map((m) => m.userId);
  const closed = accessOn(wsOf(ctx, wsId)) || (!!copyVisibility && copyVisibility !== "workspace");
  const owner = closed && src.ownerId && src.ownerId !== ctx.me && roleOf(ctx, wsId, src.ownerId) ? [src.ownerId] : [];
  return [...new Set([...own, ...owner])];
}

/** The roles a copy's people keep (copyPeople's ids): each person's role on the source, and editor for
 *  its owner (who has no row). A viewer stays a viewer, a commenter a commenter. */
export function copyRoles(src: Pick<Project, "id" | "ownerId">, ctx: AccessCtx): Record<string, ProjectRole> {
  const out: Record<string, ProjectRole> = {};
  for (const m of ctx.members ?? []) if (m.projectId === src.id) out[m.userId] = m.role;
  if (src.ownerId) out[src.ownerId] = "editor";
  return out;
}

/** Who may change a project's people (D12): with the switch off, on a Whole workspace project,
 *  today's writers (owners, admins and members); with it on, or on a Members only or Private
 *  project whatever the switch says, the workspace's owner, the project's owner, its editors who
 *  aren't guests, and admins on projects that aren't Private. `onRule` asks the switch-on rule
 *  whatever the switch says (visibility always follows it). */
export function canManagePeople(project: Project, ctx: AccessCtx, onRule = false): boolean {
  const wsId = project.workspaceId ?? null;
  if (!wsId) return true;
  const role = roleOf(ctx, wsId, ctx.me);
  if (!role) return false;
  if (!onRule && !accessOn(wsOf(ctx, wsId)) && visibilityOf(project) === "workspace") return role !== "guest";
  if (role === "owner") return true;
  if (role === "guest") return false;
  if (project.ownerId === ctx.me || memberRole(ctx, project.id, ctx.me) === "editor") return true;
  return role === "admin" && visibilityOf(project) !== "private";
}
/** Who may change a project's visibility: its managers by the switch-on rule. */
export const canSetVisibility = (project: Project, ctx: AccessCtx): boolean => canManagePeople(project, ctx, true);
/** May you make projects Private here? Owners and admins always; members when the owner allows it. */
export function mayMakePrivate(wsId: string | null | undefined, ctx: AccessCtx): boolean {
  if (!wsId) return false;
  const role = roleOf(ctx, wsId, ctx.me);
  return role === "owner" || role === "admin" || (role === "member" && wsOf(ctx, wsId)?.projectAccess?.membersMayMakePrivate === true);
}
/** Your rank on this project if it had that visibility. */
export function rankWith(project: Project, to: ProjectVisibility, ctx: AccessCtx): Rank {
  const wsId = project.workspaceId ?? null;
  if (!wsId) return 3;
  return rankCore(accessOn(wsOf(ctx, wsId)), roleOf(ctx, wsId, ctx.me), to, project.ownerId === ctx.me, memberRole(ctx, project.id, ctx.me));
}
/** Would you keep edit rights on this project with that visibility? (The workspace's owner always does.) */
export function keepsEdit(project: Project, to: ProjectVisibility, ctx: AccessCtx): boolean {
  const wsId = project.workspaceId ?? null;
  if (!wsId) return true;
  if (roleOf(ctx, wsId, ctx.me) === "owner") return true;
  return rankWith(project, to, ctx) >= 3;
}

/** Active people of a project's workspace who can see it (rank ≥ `min`): who can be assigned,
 *  collaborate, be @mentioned, approve, or be asked for an update. */
export function peopleFor(projectId: string, ctx: AccessCtx, min: Rank = 1): WorkspaceMember[] {
  const p = ctx.projects.find((x) => x.id === projectId);
  const wsId = p?.workspaceId ?? null;
  if (!wsId) return [];
  return ctx.wsMembers.filter((m) => m.workspaceId === wsId && m.status === "active" && !!m.userId
    && rankFor(ctx, m.userId, wsId, projectId) >= min);
}
/** The projects you can edit (rank 3) in a workspace, archived ones left out. */
export function editableProjects(wsId: string | null, ctx: AccessCtx): Project[] {
  return ctx.projects.filter((p) => (p.workspaceId ?? null) === wsId && !p.archivedAt && projectRank(p.id, ctx) >= 3);
}

const displayName = (m: WorkspaceMember | undefined, id: string, names?: (id: string) => string | undefined) => names?.(id) || m?.name || m?.email || "Someone";

type PreviewTask = Pick<Task, "workspaceId" | "projectId" | "assigneeId" | "status" | "archivedAt"> & { collaborators?: string[] };
const isOpen = (t: PreviewTask) => t.status !== "done" && !t.archivedAt;

/** What turning the switch on would do (Settings › Workspace › Project access): each guest, the
 *  projects they're on (or own) and the open tasks of theirs they'd stop seeing (assigned or
 *  collaborating, in a project they're not on); how many projects are Whole workspace, Members only
 *  and Private; and, for each Members only or Private one already set, who'd lose sight of it. */
export function turnOnPreview(wsId: string, ctx: AccessCtx, names?: (id: string) => string | undefined, tasks: PreviewTask[] = []): {
  guests: { userId: string; name: string; projects: string[]; lost: { project: string; openTasks: number }[] }[];
  counts: Record<ProjectVisibility, number>;
  closed: { projectId: string; name: string; visibility: ProjectVisibility; losing: { userId: string; name: string; openTasks: number }[] }[];
} {
  const projects = ctx.projects.filter((p) => p.workspaceId === wsId && !p.archivedAt);
  const counts: Record<ProjectVisibility, number> = { workspace: 0, members: 0, private: 0 };
  projects.forEach((p) => { counts[visibilityOf(p)]++; });
  const real = new Map(ctx.projects.filter((p) => p.workspaceId === wsId).map((p) => [p.id, p]));
  const wsTasks = tasks.filter((t) => isOpen(t) && (t.workspaceId ?? real.get(t.projectId)?.workspaceId ?? null) === wsId);
  const guests = ctx.wsMembers.filter((m) => m.workspaceId === wsId && m.status === "active" && m.role === "guest" && !!m.userId).map((m) => {
    const uid = m.userId!;
    const lostBy = new Map<string, number>();
    for (const t of wsTasks) {
      if (t.assigneeId !== uid && !(t.collaborators ?? []).includes(uid)) continue;
      const p = real.get(t.projectId);
      if (p && (p.ownerId === uid || memberRole(ctx, p.id, uid) !== null)) continue;
      const label = p?.name ?? "no project";
      lostBy.set(label, (lostBy.get(label) ?? 0) + 1);
    }
    return {
      userId: uid,
      name: displayName(m, uid, names),
      projects: projects.filter((p) => p.ownerId === uid || memberRole(ctx, p.id, uid) !== null).map((p) => p.name),
      lost: [...lostBy].map(([project, openTasks]) => ({ project, openTasks })),
    };
  });
  const closed = projects.filter((p) => visibilityOf(p) !== "workspace").map((p) => ({
    projectId: p.id, name: p.name, visibility: visibilityOf(p),
    losing: ctx.wsMembers.filter((m) => m.workspaceId === wsId && m.status === "active" && !!m.userId && m.role !== "guest"
      && rankCore(true, m.role, visibilityOf(p), p.ownerId === m.userId, memberRole(ctx, p.id, m.userId!)) < 1).map((m) => ({
      userId: m.userId!, name: displayName(m, m.userId!, names),
      openTasks: wsTasks.filter((t) => t.projectId === p.id && t.assigneeId === m.userId).length,
    })),
  }));
  return { guests, counts, closed };
}

/** Who'd lose sight of a project if it became `to`, with their open tasks there. */
export function narrowingLoss(project: Project, to: ProjectVisibility, ctx: AccessCtx, tasks: Pick<Task, "projectId" | "assigneeId" | "status" | "archivedAt">[], names?: (id: string) => string | undefined): { userId: string; name: string; openTasks: number }[] {
  const wsId = project.workspaceId ?? null;
  if (!wsId) return [];
  const ws = wsOf(ctx, wsId);
  const on = accessOn(ws);
  return ctx.wsMembers.filter((m) => m.workspaceId === wsId && m.status === "active" && !!m.userId).flatMap((m) => {
    const uid = m.userId!;
    const role = m.role;
    const isOwner = project.ownerId === uid;
    const mine = memberRole(ctx, project.id, uid);
    const now = rankCore(on, role, visibilityOf(project), isOwner, mine);
    const then = rankCore(on, role, to, isOwner, mine);
    if (now < 1 || then >= 1) return [];
    const openTasks = tasks.filter((t) => t.projectId === project.id && t.assigneeId === uid && t.status !== "done" && !t.archivedAt).length;
    return [{ userId: uid, name: displayName(m, uid, names), openTasks }];
  });
}

/** 0058, switch on: a sub-task lives in its parent's project (D11: the server puts it back there,
 *  saying nothing). Moved to another project on its own (its parent isn't in `moving`), it becomes a
 *  task of its own, so the move holds. Changes `patch`; true when it did. `on`: the destination
 *  workspace's switch. */
export function detachSoloMove(prev: Pick<Task, "parentId" | "projectId">, patch: Partial<Pick<Task, "parentId" | "projectId">>,
  moving: ReadonlySet<string>, on: boolean): boolean {
  if (!on || !prev.parentId || "parentId" in patch || moving.has(prev.parentId)) return false;
  if (patch.projectId === undefined || patch.projectId === prev.projectId) return false;
  patch.parentId = undefined;
  return true;
}

const ROLE_ORDER: Record<Role, number> = { guest: 0, member: 1, admin: 2, owner: 3 };
/** What making someone `to` (a narrower role) takes from them in a workspace (0058): with the switch on,
 *  the projects they'd stop seeing (with their open tasks there) and those they could no longer edit;
 *  made a guest, whatever the switch says, the projects where their editor role becomes "can comment"
 *  for good (made a member again, it stays so). Empty for a wider role, or before 0058. */
export function roleChangeLoss(wsId: string, userId: string, to: Role, ctx: AccessCtx,
  tasks: Pick<Task, "projectId" | "assigneeId" | "status" | "archivedAt">[] = []): { unseen: { name: string; openTasks: number }[]; viewOnly: string[]; capped: string[] } {
  const out = { unseen: [] as { name: string; openTasks: number }[], viewOnly: [] as string[], capped: [] as string[] };
  const from = roleOf(ctx, wsId, userId);
  if (!accessSchema() || !from || from === "owner" || ROLE_ORDER[to] >= ROLE_ORDER[from]) return out;
  const on = accessOn(wsOf(ctx, wsId));
  for (const p of ctx.projects.filter((x) => (x.workspaceId ?? null) === wsId && !x.archivedAt)) {
    const isOwner = !!p.ownerId && p.ownerId === userId;
    const mine = memberRole(ctx, p.id, userId);
    const after = to === "guest" && mine === "editor" ? "commenter" : mine;
    if (to === "guest" && mine === "editor") out.capped.push(p.name);
    if (!on) continue;
    const now = rankCore(true, from, visibilityOf(p), isOwner, mine);
    const then = rankCore(true, to, visibilityOf(p), isOwner, after);
    if (now >= 1 && then < 1) {
      out.unseen.push({ name: p.name, openTasks: tasks.filter((t) => t.projectId === p.id && t.assigneeId === userId && t.status !== "done" && !t.archivedAt).length });
    } else if (now >= 3 && then < 3 && !(to === "guest" && mine === "editor")) out.viewOnly.push(p.name);
  }
  return out;
}
const listNames = (names: string[], max = 4) => {
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0] ?? "";
};
/** The question before a role change that narrows what someone has (null: nothing to ask). */
export function roleChangeQuestion(name: string, to: Role, loss: ReturnType<typeof roleChangeLoss>): string | null {
  if (!loss.unseen.length && !loss.viewOnly.length && !loss.capped.length) return null;
  const lines = [`Make ${name} ${to === "admin" ? "an admin" : `a ${to}`}?`];
  if (loss.unseen.length) {
    const open = loss.unseen.reduce((n, x) => n + x.openTasks, 0);
    lines.push(`They'd stop seeing ${listNames(loss.unseen.map((x) => x.name))}${open ? `, with ${open === 1 ? "1 open task" : `${open} open tasks`} of theirs there` : ""}.`);
  }
  if (loss.viewOnly.length) lines.push(`They could no longer change ${listNames(loss.viewOnly)}.`);
  if (loss.capped.length) lines.push(`Their role on ${listNames(loss.capped)} becomes Can comment, and stays that way if they're given their role back.`);
  return lines.join("\n\n");
}

/** How many people can see a project with that visibility once the switch is on (rank ≥ 1),
 *  the implicit owners and admins included. */
export function seesCount(project: Project, ctx: AccessCtx, visibility: ProjectVisibility = visibilityOf(project)): number {
  const wsId = project.workspaceId ?? null;
  if (!wsId) return 1;
  return ctx.wsMembers.filter((m) => m.workspaceId === wsId && m.status === "active" && !!m.userId
    && rankCore(true, m.role, visibility, project.ownerId === m.userId, memberRole(ctx, project.id, m.userId!)) >= 1).length;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A meeting's agenda reaches everyone it's for (D17): a team meeting takes only Whole workspace
 *  projects, a leadership one Whole workspace and Members only. Private projects never go on an
 *  agenda. With project access off (or a loose row) everything is open. `projectId`: a task's own
 *  project id, for when `project` isn't loaded: a real project's id that isn't here (deleted, to the
 *  bin or for good, or out of your sight) is closed, as the server judges it by what it had; only a
 *  loose one (no real project) is open. */
export function audienceOpen(preset: "team" | "leadership", ws: Pick<Workspace, "projectAccess"> | undefined, project: Pick<Project, "visibility"> | undefined, projectId?: string | null): boolean {
  if (!accessOn(ws)) return true;
  if (!project) return !(projectId && UUID_RE.test(projectId));
  const v = visibilityOf(project);
  return v === "workspace" || (preset === "leadership" && v === "members");
}

/** Sentence-case labels for each visibility. */
export const VISIBILITY_LABEL: Record<ProjectVisibility, string> = { workspace: "Whole workspace", members: "Members only", private: "Private" };
export const ROLE_LABEL: Record<ProjectRole, string> = { editor: "Can edit", commenter: "Can comment", viewer: "Can view" };

/** A refusal from one of 0058's functions, said from your side. */
export function accessErrorText(e: unknown): string {
  const code = String((e as { code?: unknown })?.code ?? "");
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  if (code === "access_missing") return "Project access isn't switched on yet.";
  if (code === "offline") return "You're offline. Try again when you're back.";
  if (/not a member of this workspace/i.test(msg)) return "They're not in this workspace any more.";
  if (/invalid visibility|invalid role|invalid grants/i.test(msg)) return "That isn't a choice Kanbo knows. Reload and try again.";
  if (/not found/i.test(msg)) return "That project couldn't be found. It may have been deleted, or you can't see it any more.";
  if (/not authorized/i.test(msg)) return "You can't change who has access to this project.";
  return "Couldn't save that. Try again.";
}
