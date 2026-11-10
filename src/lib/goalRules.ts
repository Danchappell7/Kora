/* ============================================================
   KANBO — who may do what with a goal. The same rules as the
   database's (0052: goal_visible, goal_editable, goal_may_place), so
   the page only offers what will be accepted:
   · read: a team goal is for its workspace's owner, admins and members
     (never guests); a leadership-only one for owners and admins, its
     owner and its contributors;
   · edit, delete, check in, link work: owners and admins, the goal's
     owner and its contributors;
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

/** May they read it? (Personal goals reach only their creator in the first place.) */
export function canSeeGoal(g: Rules, { me, role }: Who): boolean {
  if (isPersonal(g)) return true;
  if (role === "guest" || !role) return false;
  return g.visibility !== "leadership" || runs(role) || isGoalPerson(g, me);
}

/** May they edit it, delete it, check in on it and link work to it? */
export function canEditGoal(g: Rules, { me, role }: Who): boolean {
  if (isPersonal(g)) return true;
  return writes(role) && (runs(role) || isGoalPerson(g, me));
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
