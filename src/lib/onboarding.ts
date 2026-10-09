/* ============================================================
   KANBO — the guided first run (0048).                 [0048 contract → u1]
   • A 3-minute tour of coach marks pointing at the real UI, by role
     (owner/admin · member · guest), Next / Back / Skip, resumable (the
     step is saved), keyboard and screen-reader complete, no motion with
     prefers-reduced-motion. Replayable from the Help (?) menu.
   • "Try it": a sample project "Kanbo tour" in Personal (its own
     identity; 6 tasks showing sub-tasks, a dependency, an approval
     request and a doc), removable in one click. Approvals need a team
     task, so in Personal the approval step is shown as a task that
     explains it (a real request only when made in a team workspace).
   • "Get set up": a checklist card on Today until done or dismissed —
     owners: invite your team, connect a calendar, add your company
     domain, connect Slack; members (and guests): plan your day, complete
     a task, install the app, set notifications. Items tick themselves from
     what the app can see (SetupSignals) or by hand; progress ring.
   State: profiles.onboarding (keys tour / checklist / sample; momentum is
   u10's), saved with merge_onboarding (one level deep; null removes).
   Demo mode: the same, in memory on the demo profile.
   Coach-mark anchors: TOUR_ANCHORS (data-tour attributes already on the
   sidebar places, ⌘K search, New task, Plan my day, the task panel and
   the Inbox's first triage group). A step whose anchor isn't on screen
   (e.g. phone layout, a closed panel) shows as a centred card instead.
   ============================================================ */
import type {
  DocBlock, OnboardingPatch, OnboardingState, Project, Role, SetupItemId, Task, TourRole,
} from "../data/types";

export { parseOnboardingState } from "./profileState";

/** CSS selectors for the elements the tour points at (the first visible match wins).  [final] */
export const TOUR_ANCHORS = {
  places: '[data-tour="places"]',
  search: '[data-tour="search"]',
  capture: '[data-tour="capture"]',
  planDay: '[data-tour="plan-day"]',
  taskPanel: '[data-tour="task-panel"]',
  inboxTriage: '[data-tour="inbox-triage"]',
} as const;
export type TourAnchor = keyof typeof TOUR_ANCHORS;

/** The tour's role for a workspace role (Personal: owner).  [final] */
export function tourRoleOf(role: Role | null | undefined, personal: boolean): TourRole {
  if (personal || role === "owner" || role === "admin") return "owner";
  return role === "guest" ? "guest" : "member";
}

/** The checklist's items per role, in order.  [final] */
export const SETUP_ITEMS: Readonly<Record<TourRole, readonly SetupItemId[]>> = {
  owner: ["invite_team", "connect_calendar", "add_domain", "connect_slack"],
  member: ["plan_day", "complete_task", "install_app", "set_notifications"],
  guest: ["plan_day", "complete_task", "install_app", "set_notifications"],
};

/** What the app can see right now (the integrator computes these; any item already true counts as done). */
export type SetupSignals = Partial<Record<SetupItemId, boolean>>;

export interface TourStep {
  id: string;
  anchor: TourAnchor | null;
  title: string;
  body: string;
  /** the shortcut it teaches, shown as a key cap ("⌘K", "Q", "P") */
  kbd?: string;
}

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package u1)`));

/** The tour for a role (owner/admin, member, guest: guests never see write-only steps). */
export function tourSteps(_role: TourRole): TourStep[] { return []; }

/** Progress of the "Get set up" card: manual ticks + signals. */
export interface ChecklistItemView { id: SetupItemId; label: string; hint: string; done: boolean }
export function checklistView(_role: TourRole, _state: OnboardingState, _signals: SetupSignals): { items: ChecklistItemView[]; done: number; total: number; complete: boolean } {
  return { items: [], done: 0, total: 0, complete: true };
}

/** Should the card show on Today? (not dismissed, not complete) */
export function showSetupChecklist(_role: TourRole, _state: OnboardingState, _signals: SetupSignals): boolean { return false; }

/** Should the tour start by itself? (a new person who hasn't finished or skipped it) */
export function shouldAutoStartTour(_state: OnboardingState, _opts: { isNewAccount: boolean }): boolean { return false; }

/** Save a patch to profiles.onboarding (rpc merge_onboarding); answers the stored state. Demo: in memory. */
export function saveOnboarding(_patch: OnboardingPatch): Promise<OnboardingState> { return notBuilt("saveOnboarding"); }

/** Ask the mounted TourHost to (re)start the tour — the Help menu's "Take the tour". */
export function startTour(_opts?: { from?: string }): void { /* no TourHost yet */ }
/** TourHost listens here. Returns unsubscribe. */
export function onTourRequest(_cb: (opts: { from?: string }) => void): () => void { return () => undefined; }

/* ---------- the sample project ---------- */

/** How the sample project is made and removed (the integrator wires App's create paths, like PlanApplyDeps). */
export interface TourSampleDeps {
  createProject(input: { name: string; emoji: string; color: string; workspaceId: string | null; description?: string }): Promise<Project>;
  /** store.createTasksBatch semantics (final ids; parentId for sub-tasks) */
  createTasks(tasks: Task[]): Promise<Task[]>;
  addDependency(taskId: string, dependsOn: string): Promise<void>;
  /** a doc in the project (lib/docs saveProjectDoc); optional: skipped when absent */
  createDoc?(projectId: string, title: string, body: DocBlock[]): Promise<{ id: string }>;
  /** an approval request (team workspaces only; lib/approvals requestApproval); optional */
  requestApproval?(taskId: string, reviewerIds: string[], note: string): Promise<void>;
  /** removal: the project goes (to the bin) with its tasks and doc */
  deleteProject(projectId: string): Promise<void>;
}

/** The sample project's content (pure: the same every time, dates relative to `today`). */
export interface TourSamplePlan { project: { name: string; emoji: string; color: string; description: string }; tasks: Task[]; dependencies: [string, string][]; doc: { title: string; body: DocBlock[] } | null }
export function tourSamplePlan(_ctx: { today: Date; currentUserId: string; workspaceId: string | null }): TourSamplePlan {
  return { project: { name: "Kanbo tour", emoji: "🧭", color: "oklch(0.74 0.14 230)", description: "" }, tasks: [], dependencies: [], doc: null };
}
/** Make it (and record it in profiles.onboarding.sample). */
export function createTourSample(_deps: TourSampleDeps, _ctx: { today: Date; currentUserId: string; workspaceId: string | null }): Promise<OnboardingState> { return notBuilt("createTourSample"); }
/** Remove it (one click) and forget it. */
export function removeTourSample(_deps: TourSampleDeps, _state: OnboardingState): Promise<OnboardingState> { return notBuilt("removeTourSample"); }
