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
  seeAllProjects: boolean;
}

const CAPS: Record<Role, Caps> = {
  owner:  { manageMembers: true,  manageAdmins: true,  manageWorkspace: true,  deleteWorkspace: true,  createProjects: true,  editContent: true,  seeAllProjects: true },
  admin:  { manageMembers: true,  manageAdmins: false, manageWorkspace: true,  deleteWorkspace: false, createProjects: true,  editContent: true,  seeAllProjects: true },
  member: { manageMembers: false, manageAdmins: false, manageWorkspace: false, deleteWorkspace: false, createProjects: true,  editContent: true,  seeAllProjects: true },
  guest:  { manageMembers: false, manageAdmins: false, manageWorkspace: false, deleteWorkspace: false, createProjects: false, editContent: false, seeAllProjects: true },
};

/** Personal workspace (no role) behaves like a solo owner of your own space. */
const SOLO: Caps = { manageMembers: false, manageAdmins: false, manageWorkspace: true, deleteWorkspace: true, createProjects: true, editContent: true, seeAllProjects: true };

export const can = (role: Role | null | undefined, cap: keyof Caps): boolean =>
  role ? CAPS[role][cap] : SOLO[cap];

export const ROLE_META: Record<Role, { label: string; blurb: string }> = {
  owner:  { label: "Owner",  blurb: "Full control, billing & ownership" },
  admin:  { label: "Admin",  blurb: "Manage members & settings" },
  member: { label: "Member", blurb: "Create and edit work" },
  guest:  { label: "Guest",  blurb: "Can view and comment" },
};

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
