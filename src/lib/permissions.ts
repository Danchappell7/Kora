/* ============================================================
   KANBO — workspace role capabilities (single source of truth).
   Mirrors the server-side RPC guards in 0027_roles_permissions.sql.
   ============================================================ */
import type { Role } from "../data/types";

export interface Caps {
  manageMembers: boolean;    // invite, remove, change roles
  manageAdmins: boolean;     // promote/demote admins (owner only)
  manageWorkspace: boolean;  // rename / settings
  deleteWorkspace: boolean;  // delete or transfer ownership (owner only)
  createProjects: boolean;
  editContent: boolean;      // create/edit tasks in projects you can see
  seeAllProjects: boolean;   // false for guests (project-scoped — enforced server-side later)
}

const CAPS: Record<Role, Caps> = {
  owner:  { manageMembers: true,  manageAdmins: true,  manageWorkspace: true,  deleteWorkspace: true,  createProjects: true,  editContent: true,  seeAllProjects: true },
  admin:  { manageMembers: true,  manageAdmins: false, manageWorkspace: true,  deleteWorkspace: false, createProjects: true,  editContent: true,  seeAllProjects: true },
  member: { manageMembers: false, manageAdmins: false, manageWorkspace: false, deleteWorkspace: false, createProjects: true,  editContent: true,  seeAllProjects: true },
  guest:  { manageMembers: false, manageAdmins: false, manageWorkspace: false, deleteWorkspace: false, createProjects: false, editContent: true,  seeAllProjects: false },
};

/** Personal workspace (no role) behaves like a solo owner of your own space. */
const SOLO: Caps = { manageMembers: false, manageAdmins: false, manageWorkspace: true, deleteWorkspace: true, createProjects: true, editContent: true, seeAllProjects: true };

export const can = (role: Role | null | undefined, cap: keyof Caps): boolean =>
  role ? CAPS[role][cap] : SOLO[cap];

export const ROLE_META: Record<Role, { label: string; blurb: string }> = {
  owner:  { label: "Owner",  blurb: "Full control, billing & ownership" },
  admin:  { label: "Admin",  blurb: "Manage members & settings" },
  member: { label: "Member", blurb: "Create and edit work" },
  guest:  { label: "Guest",  blurb: "Limited to invited projects" },
};

/** Can `actor` (the current user's role) change `target`'s role / remove them? */
export function canManageMember(actor: Role | null | undefined, target: Role): boolean {
  if (!actor) return false;
  if (target === "owner") return false;            // owner is managed only via transfer
  if (target === "admin") return actor === "owner"; // only the owner touches admins
  return actor === "owner" || actor === "admin";
}

/** Roles `actor` is allowed to assign (for the role dropdown / invite). */
export function assignableRoles(actor: Role | null | undefined): Role[] {
  if (actor === "owner") return ["admin", "member", "guest"];
  if (actor === "admin") return ["member", "guest"];
  return [];
}
