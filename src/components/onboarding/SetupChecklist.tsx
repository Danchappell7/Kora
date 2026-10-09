/* ============================================================
   KANBO — Today › "Get set up" card.                   [0048 stub → u1]
   For owners/admins: invite your team, connect a calendar, add your
   company domain, connect Slack. For members and guests: plan your day,
   complete a task, install the app, set notifications. A progress ring
   ("2 of 4"), each item a button that takes you there (onAction), ticked
   items struck through with a check, "Dismiss" (and it leaves by itself
   once complete, after a moment of celebration — none with reduced
   motion). Shown only while lib/onboarding showSetupChecklist is true.
   Renders nothing until package u1 builds it.
   ============================================================ */
import type { OnboardingState, SetupItemId, TourRole } from "../../data/types";
import type { SetupSignals } from "../../lib/onboarding";

export interface SetupChecklistProps {
  role: TourRole;
  onboarding: OnboardingState;
  /** what the app can see (team invited, calendar connected…) */
  signals: SetupSignals;
  /** ticks / dismissal: the new state — the host saves it */
  onChange: (next: OnboardingState) => void;
  /** go and do it: open Settings › Team, the calendar panel, Plan my day… (the host routes) */
  onAction: (id: SetupItemId) => void;
}

export function SetupChecklist(_props: SetupChecklistProps) {
  return null;
}
