/* ============================================================
   KANBO — the "Get set up" items per role (0048, u1). A leaf module (no
   imports but types) shared by lib/onboarding (the shell's counts) and
   lib/onboardingCopy (the card's words), so neither imports the other
   and the words stay in the lazy chunk. lib/onboarding re-exports all of
   this; import it from there.
   ============================================================ */
import type { OnboardingChecklistState, SetupItemId, TourRole } from "../data/types";

/** The checklist's items per role, in order. A team's owners and admins get the rollout list (0057:
 *  pick a pack, bring your work in, invite your pilot group, set your update day, post your first
 *  update); Slack is paused, and the company domain is the platform's to approve. */
export const SETUP_ITEMS: Readonly<Record<TourRole, readonly SetupItemId[]>> = {
  owner: ["pick_pack", "import_work", "invite_pilot", "set_update_day", "post_update"],
  member: ["plan_day", "complete_task", "install_app", "set_notifications"],
  guest: ["plan_day", "complete_task", "install_app", "set_notifications"],
};
/** Personal is yours alone: bring a team in, connect a calendar (and, for a site admin, the company domain). */
export const PERSONAL_SETUP_ITEMS: readonly SetupItemId[] = ["invite_team", "connect_calendar", "add_domain"];
/** A team's rollout items belong to that team: they're ticked per workspace (checklist.teams), so a
 *  second business you set up starts from nothing. */
export const TEAM_SETUP_ITEMS: ReadonlySet<SetupItemId> = new Set<SetupItemId>(SETUP_ITEMS.owner);

/** Guests read and comment: planning and completing are writes the server refuses them. */
const GUEST_CANNOT: ReadonlySet<SetupItemId> = new Set<SetupItemId>(["plan_day", "complete_task"]);
/** What the host can leave out: items this person can't do here (e.g. the company domain is a site
 *  admin's setting — pass ["add_domain"] for other owners). */
export interface ChecklistOpts {
  hidden?: readonly SetupItemId[];
  /** in Personal (the tour's "owner" there): PERSONAL_SETUP_ITEMS instead of a team's rollout list */
  personal?: boolean;
  /** the workspace a team's rollout items are ticked in */
  workspaceId?: string | null;
}

/** When an item was ticked: a team's rollout items in their workspace, the rest for you everywhere. */
export function tickedAt(checklist: OnboardingChecklistState | undefined, id: SetupItemId, opts: ChecklistOpts = {}): string | undefined {
  if (TEAM_SETUP_ITEMS.has(id)) return opts.workspaceId ? checklist?.teams?.[opts.workspaceId]?.[id] : undefined;
  return checklist?.done?.[id];
}

/** The items the card lists for a role (SETUP_ITEMS, less what a guest can't do and what the host hides). */
export function setupItemsFor(role: TourRole, opts: ChecklistOpts = {}): SetupItemId[] {
  const items = role === "owner" && opts.personal ? PERSONAL_SETUP_ITEMS : SETUP_ITEMS[role];
  return items.filter((id) => (role !== "guest" || !GUEST_CANNOT.has(id)) && !opts.hidden?.includes(id));
}
