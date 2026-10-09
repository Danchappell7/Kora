/* ============================================================
   KANBO — the guided tour's coach marks.               [0048 stub → u1]
   Mount once at the app root (the integrator does, lazily: it's only
   needed while a tour runs). Starts by itself for a new person (lib/
   onboarding shouldAutoStartTour), or when startTour() is called (Help
   menu). One step at a time: a spotlight ring on the anchor element and a
   card beside it (Next / Back / Skip tour, "2 of 6"); Escape skips; focus
   moves into the card and returns afterwards; the card is a labelled
   dialog with a live step count. Resumes at the saved step. With
   prefers-reduced-motion nothing glides. On phones the card docks to the
   bottom. Saves progress through onChange (the host persists it with
   lib/onboarding saveOnboarding).
   Renders nothing until package u1 builds it.
   ============================================================ */
import type { OnboardingState, TourRole } from "../../data/types";
import type { Route } from "../../app-types";

export interface TourHostProps {
  role: TourRole;
  onboarding: OnboardingState;
  /** after any change (step moved, finished, skipped): the new state — the host saves it */
  onChange: (next: OnboardingState) => void;
  /** a brand-new account (first sign-in): the tour may start by itself */
  isNewAccount?: boolean;
  /** a step that needs another place (e.g. the Inbox) asks the app to go there first */
  onNavigate?: (route: Route) => void;
  /** a step that shows the task panel asks the app to open a task (the sample project's first, if any) */
  onOpenTask?: (taskId: string) => void;
}

export function TourHost(_props: TourHostProps) {
  return null;
}
