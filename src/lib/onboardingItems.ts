/* ============================================================
   KANBO — the "Get set up" items per role (0048, u1). A leaf module (no
   imports but types) shared by lib/onboarding (the shell's counts) and
   lib/onboardingCopy (the card's words), so neither imports the other
   and the words stay in the lazy chunk. lib/onboarding re-exports all of
   this; import it from there.
   ============================================================ */
import type { SetupItemId, TourRole } from "../data/types";

/** The checklist's items per role, in order.  [final] */
export const SETUP_ITEMS: Readonly<Record<TourRole, readonly SetupItemId[]>> = {
  owner: ["invite_team", "connect_calendar", "add_domain", "connect_slack"],
  member: ["plan_day", "complete_task", "install_app", "set_notifications"],
  guest: ["plan_day", "complete_task", "install_app", "set_notifications"],
};

/** Guests read and comment: planning and completing are writes the server refuses them. */
const GUEST_CANNOT: ReadonlySet<SetupItemId> = new Set<SetupItemId>(["plan_day", "complete_task"]);
/** What the host can leave out: items this person can't do here (e.g. the company domain is a site
 *  admin's setting — pass ["add_domain"] for other owners). */
export interface ChecklistOpts { hidden?: readonly SetupItemId[] }

/** The items the card lists for a role (SETUP_ITEMS, less what a guest can't do and what the host hides). */
export function setupItemsFor(role: TourRole, opts: ChecklistOpts = {}): SetupItemId[] {
  return SETUP_ITEMS[role].filter((id) => (role !== "guest" || !GUEST_CANNOT.has(id)) && !opts.hidden?.includes(id));
}
