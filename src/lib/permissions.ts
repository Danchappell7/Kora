/* ============================================================
   KANBO — workspace role capabilities (single source of truth).
   Mirrors the server-side guards (0027 RPCs, 0041 row-level security).
   ============================================================ */
import type { Role, Project } from "../data/types";

export interface Caps {
  manageMembers: boolean;    // invite, remove, change roles
  manageAdmins: boolean;     // promote/demote admins (owner only)
  manageWorkspace: boolean;  // rename / settings
  deleteWorkspace: boolean;  // delete or transfer ownership (owner only)
  createProjects: boolean;
  editContent: boolean;      // create/edit/delete tasks & projects (guests: view + comment only)
}

// (what each role may SEE is project access's, 0058: lib/projectAccess.ts)
const CAPS: Record<Role, Caps> = {
  owner:  { manageMembers: true,  manageAdmins: true,  manageWorkspace: true,  deleteWorkspace: true,  createProjects: true,  editContent: true },
  admin:  { manageMembers: true,  manageAdmins: false, manageWorkspace: true,  deleteWorkspace: false, createProjects: true,  editContent: true },
  member: { manageMembers: false, manageAdmins: false, manageWorkspace: false, deleteWorkspace: false, createProjects: true,  editContent: true },
  guest:  { manageMembers: false, manageAdmins: false, manageWorkspace: false, deleteWorkspace: false, createProjects: false, editContent: false },
};

/** Personal workspace (no role) behaves like a solo owner of your own space. */
const SOLO: Caps = { manageMembers: false, manageAdmins: false, manageWorkspace: true, deleteWorkspace: true, createProjects: true, editContent: true };

export const can = (role: Role | null | undefined, cap: keyof Caps): boolean =>
  role ? CAPS[role][cap] : SOLO[cap];

export const ROLE_META: Record<Role, { label: string; blurb: string }> = {
  owner:  { label: "Owner",  blurb: "Full control, billing & ownership" },
  admin:  { label: "Admin",  blurb: "Manage members & settings" },
  member: { label: "Member", blurb: "Create and edit work" },
  // honest about a workspace with project access off: a guest sees every project there (guestBlurb for on)
  guest:  { label: "Guest",  blurb: "Can see every project and comment" },
};

/** The fuller line the People page shows for a guest (role picker, profile, badge), project access off. */
export const GUEST_LINE = "Can see every project in this workspace and comment on its tasks, but can't change anything. Team reports (Pulse, Workload, Insights) are for members.";

/** A guest's short blurb: with project access on (0058) they see only the projects they're added to. */
// (added to a project to view it, or to comment too: never promised comments everywhere)
export const guestBlurb = (on: boolean): string => (on ? "Sees only the projects they're added to, to view or comment" : ROLE_META.guest.blurb);
/** A guest's fuller line, project access on or off. */
export const guestLine = (on: boolean): string => (on
  ? "Sees only the projects they're added to, and reads or comments on their tasks as each one allows, but can't change anything. Team reports (Pulse, Workload, Insights) are for members."
  : GUEST_LINE);

/** What to ask before removing someone: what they leave behind, said plainly.
 *  `open` is their open tasks here, `owns` the projects they own here. */
export function removeMemberQuestion(name: string, open: number, owns: number, heir?: string): string {
  const first = name.trim().split(/\s+/)[0] || name;
  const tasks = `${open} open ${open === 1 ? "task" : "tasks"}`;
  const projects = `${owns} ${owns === 1 ? "project" : "projects"}`;
  // (0058: once it's in, the projects someone owns go to the workspace's owner, `heir`, when they leave)
  const goes = heir ? `${owns === 1 ? "It goes" : "They go"} to ${heir} unless you hand ${owns === 1 ? "it" : "them"} on first. ` : "";
  const left = heir && open && owns ? `${first} has ${tasks} and owns ${projects}. The tasks stay assigned to ${first} until you hand them on; ${owns === 1 ? "the project goes" : "the projects go"} to ${heir} unless you hand ${owns === 1 ? "it" : "them"} on first. `
    : heir && owns ? `${first} owns ${projects}. ${goes}`
    : open && owns ? `${first} has ${tasks} and owns ${projects}. They'll stay with ${first} until you hand them on. `
    : open ? `${first} has ${tasks}. ${open === 1 ? "It'll" : "They'll"} stay assigned to ${first} until you hand ${open === 1 ? "it" : "them"} on. `
    : owns ? `${first} owns ${projects}. ${owns === 1 ? "It'll" : "They'll"} stay in ${first}'s name until you hand ${owns === 1 ? "it" : "them"} on. `
    : "";
  return `Remove ${name} from this workspace? ${left}${left ? `${first} will` : "They'll"} also be taken off tasks they collaborate on or follow.`;
}

/** Can `actor` (the current user's role) change `target`'s role / remove them? */
export function canManageMember(actor: Role | null | undefined, target: Role): boolean {
  if (!actor) return false;
  if (target === "owner") return false;            // owner is managed only via transfer
  if (target === "admin") return actor === "owner"; // only the owner touches admins
  return actor === "owner" || actor === "admin";
}

/**
 * Can the current user delete this project? Mirrors 0041's projects DELETE
 * policy: a personal project belongs to its creator (only they can see it); a
 * team project needs write access (guests are view + comment only) AND being
 * its owner, or a workspace owner/admin. The built-in Personal project can
 * never be deleted.
 *
 * `myRole` is the caller's role in the project's workspace. When it isn't known
 * (undefined) this errs on the side of caution: only the project owner or the
 * workspace owner may delete — never "anyone". The one exception is a project
 * with no recorded owner (demo data, or rows from before 0035): production
 * rows always have one (owner_id is NOT NULL), so with the role unknown the
 * server decides, exactly like App's canManagePeople.
 */
export function canDeleteProject(
  project: Pick<Project, "id" | "workspaceId" | "ownerId">,
  ctx: { currentUserId: string; myRole?: Role | null; workspaceOwnerId?: string | null },
): boolean {
  if (project.id === "p-personal") return false;
  if ((project.workspaceId ?? null) === null) return true;
  if (ctx.myRole === "guest") return false;
  if (ctx.myRole === "owner" || ctx.myRole === "admin") return true;
  if (ctx.workspaceOwnerId && ctx.workspaceOwnerId === ctx.currentUserId) return true;
  if (!project.ownerId) return !ctx.myRole;
  return project.ownerId === ctx.currentUserId;
}

/**
 * Can the current user archive or restore this project? Archiving is an
 * UPDATE (archived_at), which 0041 allows for anyone with write access to the
 * workspace — so every owner, admin and member, but never a guest. It is fully
 * reversible, so unlike delete it isn't limited to the project's owner. An
 * unknown role is treated as a writer: the server still refuses a guest.
 */
export function canArchiveProject(
  project: Pick<Project, "id" | "workspaceId">,
  ctx: { myRole?: Role | null },
): boolean {
  if (project.id === "p-personal") return false;
  if ((project.workspaceId ?? null) === null) return true;
  return ctx.myRole !== "guest";
}

/** Roles `actor` is allowed to assign (for the role dropdown / invite). */
export function assignableRoles(actor: Role | null | undefined): Role[] {
  if (actor === "owner") return ["admin", "member", "guest"];
  if (actor === "admin") return ["member", "guest"];
  return [];
}
