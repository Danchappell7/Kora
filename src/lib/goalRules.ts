/* ============================================================
   KANBO — who may do what with a goal. The same rules as the
   database's (0052: goal_visible, goal_editable, goal_may_place), so
   the page only offers what will be accepted:
   · read: a team goal is for its workspace's owner, admins and members
     (never guests); a leadership-only one for owners and admins, its
     owner and its contributors, and so are the goals under it (its key
     results, theirs…) unless they're yours (0052's goal_readable);
   · edit, delete, check in, link work: owners and admins, the goal's
     owner and its contributors (deleting a team goal with key results
     under it, which would make them company goals: owners and admins);
   · hand over (owner, contributors, who can see it): owners and admins
     and the goal's owner;
   · create: a company goal (a team goal with no parent) is for owners and
     admins; a key result goes under a goal you can edit;
   · a personal goal (no workspace) is yours alone.
   Pure: no React, no I/O.
   ============================================================ */
import type { Goal, Role } from "../data/types";

type Who = { me: string; role: Role | null | undefined };
type Rules = Pick<Goal, "workspaceId" | "ownerId" | "contributors" | "visibility">;

const runs = (role: Role | null | undefined) => role === "owner" || role === "admin";
const writes = (role: Role | null | undefined) => runs(role) || role === "member";
const isPersonal = (g: Pick<Goal, "workspaceId">) => (g.workspaceId ?? null) === null;

/** Is `me` the goal's owner or one of its contributors? */
export const isGoalPerson = (g: Pick<Goal, "ownerId" | "contributors">, me: string): boolean =>
  g.ownerId === me || (g.contributors ?? []).includes(me);

type Branch = Rules & Pick<Goal, "parentId">;

/** May they read it? (Personal goals reach only their creator in the first place.) With `byId`, the goals
 *  above it count too: a leadership-only goal hides its key results (and theirs) from a member, unless the
 *  member is on one of them (or on a goal in between), as the database's goal_readable has it. */
export function canSeeGoal(g: Branch, { me, role }: Who, byId?: (id: string) => Branch | undefined): boolean {
  if (isPersonal(g)) return true;
  if (role === "guest" || !role) return false;
  if (runs(role) || isGoalPerson(g, me)) return true;
  if (g.visibility === "leadership") return false;
  for (let cur = g.parentId, hops = 0; cur && byId && hops < 100; hops++) {
    const up = byId(cur);
    if (!up) break;
    if (isGoalPerson(up, me)) return true;
    if (up.visibility === "leadership") return false;
    cur = up.parentId;
  }
  return true;
}

/** A goal list's lookup for canSeeGoal's walk up the tree. */
export const goalLookup = <T extends Pick<Goal, "id">>(goals: readonly T[]): ((id: string) => T | undefined) => {
  const m = new Map(goals.map((g) => [g.id, g]));
  return (id) => m.get(id);
};

/** May they edit it, delete it, check in on it and link work to it? */
export function canEditGoal(g: Rules, { me, role }: Who): boolean {
  if (isPersonal(g)) return true;
  return writes(role) && (runs(role) || isGoalPerson(g, me));
}

/** May they delete it? Its key results stay, as goals of their own (top-level: company goals,
 *  which are for owners and admins), so a team goal with any under it is theirs to delete. */
export function canDeleteGoal(g: Rules, childCount: number, who: Who): boolean {
  if (!canEditGoal(g, who)) return false;
  return isPersonal(g) || childCount === 0 || runs(who.role);
}

/** May they change its owner, its contributors and who can see it? */
export function canHandOverGoal(g: Rules, { me, role }: Who): boolean {
  if (isPersonal(g)) return false;   // a personal goal is yours: there's no one to hand it to
  return writes(role) && (runs(role) || g.ownerId === me);
}

/** May they make a goal here: a company goal (no parent) or a key result under `parent`? */
export function canPlaceGoal(workspaceId: string | null, parent: Rules | null, who: Who): boolean {
  if (workspaceId === null) return true;
  if (!parent) return runs(who.role);
  return (parent.workspaceId ?? null) === workspaceId && canEditGoal(parent, who);
}

/** May they lift one of their goals to the top (making it a company goal)? */
export const canMakeCompanyGoal = (workspaceId: string | null, role: Role | null | undefined): boolean =>
  workspaceId === null || runs(role);

/** The rule in words, for the page (who sets the business's goals). */
export const COMPANY_GOALS_RULE = "Owners and admins set the business's goals. Each goal's owner and the people helping keep it up to date.";
