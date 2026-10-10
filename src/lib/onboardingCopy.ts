/* ============================================================
   KANBO — the guided first run's words (0048, u1): the tour's steps by
   role and the "Get set up" items' labels, hints and buttons.
   Kept out of lib/onboarding (which the shell imports to decide what to
   mount) so the words only download with the lazy TourHost and
   SetupChecklist; lib/onboarding re-exports everything here.
   British English.
   ============================================================ */
import type { OnboardingState, SetupItemId, TourRole } from "../data/types";
import type { Route } from "../app-types";
import type { SetupSignals, TourAnchor } from "./onboarding";
import { setupItemsFor, type ChecklistOpts } from "./onboardingItems";

export interface TourStep {
  id: string;
  anchor: TourAnchor | null;
  title: string;
  body: string;
  /** the shortcut it teaches, shown as a key cap ("⌘K", "Q", "P") */
  kbd?: string;
  /** the place the anchor lives in: the tour asks the app to go there first (TourHost onNavigate) */
  route?: Route;
  /** the step shows the task panel: the tour asks the app to open a task (the sample project's first) */
  opensTask?: boolean;
  /** the words on a phone or tablet (no keyboard shortcuts; the bottom bar instead of the sidebar) */
  touchBody?: string;
}

const STEP_PLACES: TourStep = {
  id: "places", anchor: "places", title: "Your five places",
  body: "Today plans your day, Inbox collects what needs you, My tasks holds everything on your plate, Projects is your team's work and Team shows who's doing what. Press G, then D, I, T, O or E, to jump between them.",
  touchBody: "Today, My tasks and Inbox sit in the bar at the bottom. More opens Projects, Team and your workspaces.",
};
const STEP_SEARCH: TourStep = {
  id: "search", anchor: "search", title: "Search or ask Kanbo", kbd: "⌘K",
  body: "Find any task, project, doc or person, or ask in plain words: “what's overdue this week?” Kanbo answers from your work.",
  touchBody: "Tap search at the top to find any task, project, doc or person, or ask in plain words: “what's overdue this week?”",
};
const STEP_CAPTURE: TourStep = {
  id: "capture", anchor: "capture", title: "Capture in a second", kbd: "Q",
  body: "Press Q and type it the way you'd say it: “Send the invoice Friday 30m”. Kanbo picks out the date, the time and the project. New task (C) opens the full form.",
  touchBody: "Tap + in the bar at the bottom and type it the way you'd say it: “Send the invoice Friday 30m”. Kanbo picks out the date, the time and the project.",
};
const STEP_PLAN: TourStep = {
  id: "plan-day", anchor: "planDay", title: "Plan my day", kbd: "P", route: { view: "plan" },
  body: "Kanbo orders your work around your meetings and lays it on the day. Drag anything to move it, or press P to plan again; one Undo puts it all back.",
  touchBody: "Kanbo orders your work around your meetings and lays it on the day. Tap Plan my day for me to try it; one Undo puts it all back.",
};
const STEP_PANEL: TourStep = {
  id: "task-panel", anchor: "taskPanel", title: "Everything about a task", opensTask: true,
  body: "Open any task and it's all in one panel: sub-tasks, files, comments, approvals and its history. Escape closes it.",
  touchBody: "Open any task and it's all in one place: sub-tasks, files, comments, approvals and its history. Close it from the top.",
};
const STEP_INBOX: TourStep = {
  id: "inbox-triage", anchor: "inboxTriage", title: "Triage your Inbox", route: { view: "inbox" },
  body: "Mentions, assignments and requests land here, sorted into what needs your reply, what's new to you and what's just for your information. R replies, A adds to Today, H snoozes and E archives.",
  touchBody: "Mentions, assignments and requests land here, sorted into what needs your reply, what's new to you and what's just for your information. Tap ⋯ on an item to reply, snooze or archive it.",
};
const STEP_INVITE: TourStep = {
  id: "invite", anchor: null, title: "Bring your team in",
  body: "Kanbo is better together. Invite people from Team, or start a team workspace from the switcher at the top of the sidebar. Guests can follow along without editing. Your “Get set up” card on Today has the rest.",
};

/* guests read, follow and comment: never the steps that create or plan. Their words for the shared steps
   (plain literals: nothing here runs at load, so the module stays out of the shell's first download) */
const GUEST_WORDS: Readonly<Record<string, readonly [body: string, touchBody: string]>> = {
  places: [
    "Everything you've been invited to see lives in one of these: Today, Inbox, My tasks, Projects and Team. Press G, then D, I, T, O or E, to jump between them.",
    "Today, My tasks and Inbox sit in the bar at the bottom. More opens Projects and Team: everything you've been invited to see.",
  ],
  search: [
    "Find any task, project, doc or person you can see, or ask in plain words: “what changed this week?”",
    "Tap search at the top to find any task, project, doc or person you can see, or ask in plain words: “what changed this week?”",
  ],
  "task-panel": [
    "Open any task to read it, follow it or join the conversation: you can comment and react, and the team keeps the edits. Escape closes it.",
    "Open any task to read it, follow it or join the conversation: you can comment and react, and the team keeps the edits.",
  ],
  "inbox-triage": [
    "Mentions and replies to you land here, sorted into what needs your reply and what's just for your information. R replies, H snoozes and E archives.",
    "Mentions and replies to you land here, sorted into what needs your reply and what's just for your information. Tap ⋯ on an item to reply, snooze or archive it.",
  ],
};

/** The tour for a role (owner/admin, member, guest: guests never see write-only steps). */
export function tourSteps(role: TourRole): TourStep[] {
  if (role === "guest") {
    return [STEP_PLACES, STEP_SEARCH, STEP_PANEL, STEP_INBOX].map((s) => ({ ...s, body: GUEST_WORDS[s.id][0], touchBody: GUEST_WORDS[s.id][1] }));
  }
  const member = [STEP_PLACES, STEP_SEARCH, STEP_CAPTURE, STEP_PLAN, STEP_PANEL, STEP_INBOX];
  return role === "owner" ? [...member, STEP_INVITE] : member;
}

/** Where a saved step resumes (its index in the role's tour; 0 when it's not in this role's tour). */
export function resumeIndex(role: TourRole, stepId: string | null | undefined): number {
  if (!stepId) return 0;
  const i = tourSteps(role).findIndex((s) => s.id === stepId);
  return i < 0 ? 0 : i;
}

/** Progress of the "Get set up" card: manual ticks + signals. */
export interface ChecklistItemView {
  id: SetupItemId;
  label: string;
  hint: string;
  done: boolean;
  /** ticked because the app can see it's done (it can't be unticked by hand) */
  auto?: boolean;
  /** the item's button: what it does ("Invite", "Connect"…) */
  action: string;
}

export const SETUP_COPY: Readonly<Record<SetupItemId, { label: string; hint: string; action: string }>> = {
  invite_team: { label: "Invite your team", hint: "Share projects and see who's doing what.", action: "Invite" },
  connect_calendar: { label: "Connect a calendar", hint: "Your meetings shape the plan Kanbo draws for your day.", action: "Connect" },
  add_domain: { label: "Add your company domain", hint: "Colleagues signing up with your company's email address get in without waiting.", action: "Add" },
  connect_slack: { label: "Connect Slack", hint: "Turn messages into tasks and post updates to your channels.", action: "Connect" },
  plan_day: { label: "Plan your day", hint: "Press P on Today: Kanbo lays out your work around your meetings.", action: "Plan" },
  complete_task: { label: "Complete a task", hint: "Tick the circle beside any task to finish it.", action: "Open" },
  install_app: { label: "Install the app", hint: "Kanbo on your dock or home screen, with notifications.", action: "Install" },
  set_notifications: { label: "Set your notifications", hint: "Choose what reaches you, and when.", action: "Choose" },
};

export function checklistView(role: TourRole, state: OnboardingState, signals: SetupSignals, opts: ChecklistOpts = {}): { items: ChecklistItemView[]; done: number; total: number; complete: boolean } {
  const ticked = state.checklist?.done ?? {};
  const items = setupItemsFor(role, opts).map((id): ChecklistItemView => {
    const auto = !!signals[id];
    return { id, ...SETUP_COPY[id], done: auto || !!ticked[id], ...(auto ? { auto: true } : {}) };
  });
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, complete: items.length > 0 && done === items.length };
}

