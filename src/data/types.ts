/* ============================================================
   KANBO — shared domain types
   Mirrors the real Supabase schema + a few forward-looking
   fields: tags, aiScore, aiReason, focusMin, and the
   "Plan my day" scheduling fields (energy, dur, scheduled).
   ============================================================ */

export type MemberType = "self" | "team" | "external";
export type Status = "todo" | "progress" | "review" | "blocked" | "done";
export type Priority = "low" | "medium" | "high" | "urgent";
export type EnergyKind = "deep" | "create" | "collab" | "admin";

export interface Member {
  id: string;
  name: string;
  email: string;
  type: MemberType;
  color: string;
  pronouns?: string;
  avatarUrl?: string | null;
}

export interface Profile {
  id: string;
  firstName: string;
  lastName: string;
  pronouns: string;
  email: string;
  avatarUrl: string | null;
  approved?: boolean;          // early-access gate (undefined when unknown → treated as allowed)
  suspended?: boolean;         // admin-suspended account → blocked at the gate
  isAdmin?: boolean;           // platform admin flag (profiles.is_admin); the gate lets admins through
  notifyPrefs?: Record<string, boolean>;  // notification toggles, e.g. { assigned: true, mention_email: false }
}

export interface AccessRequest {
  id: string;
  name: string;
  email: string;
  note?: string;
  status: "pending" | "approved" | "declined";
  createdAt: string;
}

export interface Workspace {
  id: string | null;
  name: string;
  kind: "personal" | "team";
  ownerId?: string;
  logoUrl?: string;
}

export type Role = "owner" | "admin" | "member" | "guest";
export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string | null;
  email: string;
  name: string;
  role: Role;
  status: "invited" | "active";
  title?: string;          // free-text position e.g. "Co-founder" (per workspace)
}

export type Recurrence = "none" | "daily" | "weekdays" | "weekly" | "biweekly" | "monthly";

export type Plan = "personal" | "team";
export type SubStatus = "trialing" | "active" | "past_due" | "canceled";

export interface Subscription {
  plan: Plan | null;
  status: SubStatus;
  trialEndsAt: string;          // ISO
  currentPeriodEnd?: string | null;
  seats: number;
}

export interface Project {
  id: string;
  name: string;
  emoji: string;
  color: string;
  workspaceId: string | null;
  description?: string;
  status?: string;
  ownerId?: string | null;       // exactly one owner (defaults to creator)
  contributorIds?: string[];     // additional people working on the project
  archivedAt?: string | null;    // soft-archive: hidden but kept + restorable
}

export interface TagDef {
  label: string;
  color: string;
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  projectId: string;
  assigneeId: string;
  /** when set, this task is a sub-task of the task with this id (Asana-style) */
  parentId?: string;
  tags: string[];
  dependencies: string[];
  /** legacy lightweight checklist items (pre sub-tasks-as-tasks); still shown */
  subtasks: Subtask[];
  focusMin: number;
  comments: number;
  aiScore: number;
  aiReason?: string;
  dueDate?: string;
  dueTime?: string;
  startDate?: string;
  originalDueDate?: string;
  completedAt?: string;
  archivedAt?: string;
  createdAt?: string;          // row creation time (for staleness surfacing)
  isMilestone?: boolean;
  /* "Plan my day" fields */
  energy?: EnergyKind;
  dur?: number;
  scheduled?: number | null;
  planToday?: boolean;
  /* collaboration + recurrence */
  workspaceId?: string | null;
  recurrence?: Recurrence;
  /* manual board ordering — fractional index; lower sorts first within a column */
  position?: number;
  /* Asana-parity wave */
  followers?: string[];            // user ids following this task
  collaborators?: string[];        // extra assignees beyond the owner
  reactions?: Record<string, string[]>; // emoji -> user ids
  sectionId?: string;              // section within its project
  mySectionId?: string;            // personal section in My Tasks
  custom?: Record<string, CustomValue>; // custom field values, keyed by field def id
  effortHours?: number;            // estimate for workload planning
  loggedHours?: number;            // actual time logged
  createdBy?: string;              // tasks.user_id (the creator); mapped by rowToTask
}

export type CustomValue = string | number | boolean | string[] | null;
export type CustomFieldType = "text" | "number" | "dropdown" | "multiselect" | "currency" | "date" | "people" | "checkbox";
export interface CustomFieldDef {
  id: string;
  projectId: string;
  workspaceId?: string | null;
  name: string;
  type: CustomFieldType;
  options: string[];   // choices for dropdown
  position?: number;
}
export interface Section {
  id: string;
  projectId: string;
  workspaceId?: string | null;
  name: string;
  position?: number;
}
export interface SavedSearch {
  id: string;
  name: string;
  query: Record<string, unknown>;
}
export type GoalStatus = "on_track" | "at_risk" | "off_track" | "done";
export interface Goal {
  id: string;
  name: string;
  description?: string;
  target?: number;
  current?: number;
  unit?: string;
  due?: string;
  status: GoalStatus;
  workspaceId?: string | null;
  position?: number;
  parentId?: string;   // sub-goal of another goal
  projectId?: string;  // linked project (auto-progress)
}
export interface Portfolio {
  id: string;
  name: string;
  projectIds: string[];
  workspaceId?: string | null;
}
export type AutomationActionType = "set_priority" | "set_assignee" | "set_section" | "add_tag";
export interface AutomationAction { type: AutomationActionType; value: string }
export interface AutomationRule {
  id: string;
  projectId: string;
  workspaceId?: string | null;
  name: string;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
  enabled: boolean;
}
export type AutomationTrigger = "task_created" | "status_changed" | "task_completed";
export type FormFieldKey = "description" | "priority" | "dueDate" | "assignee";
export interface FormDef {
  id: string;
  projectId: string;
  workspaceId?: string | null;
  name: string;
  description?: string;
  fields: FormFieldKey[];
  /** 0043: the form's public link token (server-generated; null until the link is first switched on) */
  publicToken?: string | null;
  /** 0043: "Anyone with the link can submit" */
  publicEnabled?: boolean;
}
export type StatusKind = "on_track" | "at_risk" | "off_track";
export interface StatusUpdate {
  id: string;
  projectId: string;
  summary: string;
  status: StatusKind;
  createdAt: string;
  workspaceId?: string | null;
}

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  mentions?: string[];
  /* emoji -> list of user ids who reacted with it */
  reactions?: Record<string, string[]>;
  parentId?: string;   // set when this comment is a reply to another
}

export interface Attachment {
  id: string;
  taskId: string;
  name: string;
  size: number;
  mime: string;
  path: string;
  url?: string;
  createdAt: string;
  /** The file's current owner (attachments.user_id): the uploader, or the
   *  task's owner once the uploader's account is deleted. */
  userId?: string;
}

/** "integration": a notice about one of your integrations, with no task (0046: a webhook switched off after 20 failures)
 *  "approval": an approval request for you, or a decision on yours (0047; meta says which)
 *  "doc_mention": someone @mentioned you in a project doc (0047; no task — meta.docId / meta.projectId) */
export type ActivityKind = "created" | "status" | "completed" | "reopened" | "comment" | "deleted" | "assigned" | "mention" | "integration" | "approval" | "doc_mention";

/** activity.meta (0047): what an Inbox item points at beyond its task. Parsed by lib/activityMeta. */
export interface ActivityMeta {
  /** approval items */
  approvalId?: string;
  /** approval items: what happened ("requested" → you're asked; a decision → on your request) */
  event?: ApprovalEvent;
  /** approval items: the request's status after the event */
  status?: ApprovalStatus;
  rule?: ApprovalRule;
  /** approval decisions: the reviewer's comment (first 280 characters) */
  comment?: string | null;
  /** doc mentions */
  docId?: string;
  projectId?: string;
}

export interface Activity {
  id: string;
  taskId: string | null;
  taskTitle: string;
  kind: ActivityKind;
  detail: string;
  createdAt: string;
  readAt?: string;
  /** 0047: approval / doc-mention details (absent on older rows) */
  meta?: ActivityMeta;
}

/** One row of the workspace's change history (task_events): who moved which
 *  field of which task, from what to what. Feeds Pulse and Radar. */
export interface WorkspaceEvent {
  id: string;
  taskId: string;
  actorId: string | null;
  actorName: string;
  field: "status" | "assignee" | "due" | "priority" | string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

export interface CalEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  kind: "meeting" | "break";
  with?: string[];
  /** the connected calendar it came from: its colour (a thin left edge) and name */
  color?: string;
  calendarName?: string;
}

/* external calendar integration (Google / Microsoft): several accounts per
   person, and a choice of calendars inside each one (0045) */
export type CalProvider = "google" | "microsoft";

/** One calendar inside a connected account. */
export interface ExtCalendar {
  id: string;
  name: string;
  /** "#rrggbb" from the server; the app re-tones it per theme */
  color: string;
  /** the account's main calendar */
  primary: boolean;
  /** owner · writer · reader · freeBusyReader */
  accessRole?: string;
  /** shown in Kanbo (on an account's calendar list) */
  selected?: boolean;
}

/** A connected calendar account. Never carries tokens: those stay on the server. */
export interface CalendarConnection {
  /** the connection's id (on a server from before several accounts: its provider) */
  id: string;
  provider: CalProvider;
  accountEmail: string;
  /** the calendars Kanbo shows from this account; null = just its primary calendar */
  selectedCalendars: ExtCalendar[] | null;
  createdAt?: string;
  /** the server can list and choose this account's calendars (and add more accounts of a kind) */
  canChoose?: boolean;
}

export interface ExternalEvent {
  id: string;
  title: string;
  start: string;   // ISO datetime (or date for all-day)
  end: string;
  allDay: boolean;
  provider: string;
  /** where it came from (absent from a server that predates several accounts) */
  connectionId?: string;
  calendarId?: string;
  calendarName?: string;
  color?: string;
}

/** One account or calendar the last sync couldn't read (the rest still came through). */
export interface CalendarWarning {
  connectionId: string;
  provider: string;
  accountEmail: string;
  calendarId?: string;
  calendarName?: string;
  /** reconnect: the account's access was withdrawn; the others are usually passing */
  reason: "reconnect" | "unavailable" | "timeout";
}

export interface StatusMeta {
  label: string;
  color: string;
}

export interface PriorityMeta {
  label: string;
  color: string;
  rank: number;
}

export interface EnergyMeta {
  label: string;
  color: string;
  icon: IconName;
}

/* Forward declaration — concrete union lives in primitives/Icon.tsx */
export type IconName =
  | "home" | "inbox" | "tasks" | "calendar" | "users" | "chart" | "plus"
  | "search" | "bell" | "logout" | "chevronDown" | "chevronRight" | "chevronLeft"
  | "list" | "board" | "timeline" | "flag" | "lock" | "clock" | "sparkles"
  | "play" | "pause" | "x" | "more" | "arrowUpRight" | "target" | "briefcase"
  | "user" | "sun" | "moon" | "command" | "filter" | "sort" | "link" | "zap"
  | "trendingUp" | "check" | "message" | "folder" | "dot" | "settings" | "circle"
  | "grid" | "arrowRight" | "arrowLeft" | "refresh" | "calendarPlus" | "layers" | "trash" | "menu" | "archive"
  | "pulse" | "radar" | "kanbo" | "undo" | "keyboard" | "copy" | "send" | "sliders" | "hourglass" | "sunset" | "notes"
  | "palette" | "eye" | "alert" | "coffee";

/* ============================================================
   0043 — integrations, push, public request forms, plans that follow you.
   Contracts shared by the feature packages (see docs in
   docs/integrations/*.md). Everything here degrades gracefully: a
   feature whose migration / function / secret isn't set up yet hides
   itself or explains why, never crashes.
   ============================================================ */

/* ---------- plans that follow you (public.task_user_state) ---------- */

/** One person's own plan on one task. A missing field (or null) means "not
 *  set": fall back (see lib/planOverlay withOverlay for the precedence). */
export interface TaskUserState {
  taskId: string;
  userId: string;
  /** minutes from midnight: the slot on the plan canvas (Task.scheduled) */
  scheduled?: number | null;
  /** on the person's day (Task.planToday) */
  planToday?: boolean | null;
  /** YYYY-MM-DD: the local day `scheduled` / `planToday` are for (a plan from an earlier day is stale) */
  planDay?: string | null;
  /** their My-tasks section (Task.mySectionId) */
  mySectionId?: string | null;
  /** Kanbo's ranking for them (Task.aiScore / aiReason) */
  aiScore?: number | null;
  aiReason?: string | null;
  /** ISO timestamp, server-set */
  updatedAt?: string;
}
/** The writable part of a TaskUserState (an upsert patch: absent keys are left alone). */
export type TaskUserStatePatch = Partial<Pick<TaskUserState, "scheduled" | "planToday" | "planDay" | "mySectionId" | "aiScore" | "aiReason">>;

/* ---------- web push (public.push_subscriptions) ---------- */

export interface PushSubscriptionRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
  createdAt: string;
  lastOkAt?: string | null;
}
/** Notification kinds that can push. Pref keys reuse notify_prefs with a
 *  "_push" suffix ("assigned_push"…); unset = ON, like every other pref. */
export type PushKind = "assigned" | "mention" | "comment" | "due";
/** Whether push can be offered on this device:
 *  unsupported (no service worker / PushManager / Notification), unconfigured
 *  (no VITE_VAPID_PUBLIC_KEY, or demo mode), denied (the browser blocked it),
 *  ready (can be switched on, or already is). */
export type PushAvailability = "unsupported" | "unconfigured" | "denied" | "ready";

/* ---------- Slack (public.workspace_integrations via slack_status()) ---------- */

/** What anyone in the workspace may know about its Slack connection (never the URL). */
export interface SlackStatus {
  connected: boolean;
  channelLabel: string | null;
  /** daily stand-up auto-post is on (only ever true while connected) */
  autopost: boolean;
  /** "HH:MM", Europe/London */
  autopostTime: string | null;
  /** owner/admin: may connect, disconnect, test and set auto-post */
  canManage: boolean;
  /** owner/admin/member: may post stand-ups, status updates and risks (guests can't) */
  canPost: boolean;
  updatedAt: string | null;
}
export type SlackPostKind = "standup" | "status" | "risks";
export type SlackFailure = "not_connected" | "not_allowed" | "rate_limited" | "slack_rejected" | "invalid" | "unavailable" | "network";
export type SlackPostResult = { ok: true } | { ok: false; reason: SlackFailure; message: string; retryAfter?: number };

/* ---------- calendar feed (public.calendar_feed_tokens) ---------- */

export interface CalendarFeed {
  /** the unguessable token in the feed URL (64 hex characters) */
  token: string;
  includeDue: boolean;
  createdAt?: string;
}

/* ---------- public request forms (forms.public_token / public_enabled) ---------- */

/** The fields a public form may ask for. "assignee" is never public (it would
 *  list the team's names to strangers). Title, name and email are always asked. */
export type PublicFormFieldKey = "description" | "priority" | "dueDate";
/** What GET public-form?t=<token> returns: everything the public page shows, nothing more. */
export interface PublicFormSchema {
  name: string;
  /** the form's description, shown as the intro */
  intro?: string;
  /** the project's identity (render with projectIdentity({ id: token, ...project })) */
  project: { name: string; emoji: string; color: string };
  /** the team's name and logo, when it has them */
  workspace?: { name: string; logoUrl?: string | null } | null;
  fields: PublicFormFieldKey[];
}
export interface PublicFormSubmission {
  title: string;
  name: string;
  email: string;
  description?: string;
  priority?: Priority;
  dueDate?: string;
  /** honeypot: a hidden field people never fill in; anything here is a bot */
  website?: string;
}
export type PublicFormFailure = "disabled" | "not_found" | "rate_limited" | "invalid" | "unavailable" | "network";
export type PublicFormLoad = { ok: true; form: PublicFormSchema } | { ok: false; reason: PublicFormFailure; message: string; retryAfter?: number };
export type PublicFormResult = { ok: true; reference: string } | { ok: false; reason: PublicFormFailure; message: string; retryAfter?: number };

/* ---------- team (workspace) templates ---------- */

/** A starter task in a team template. Due dates are relative to the day the template is used. */
export interface TemplateTask {
  title: string;
  /** one of its project's `sections` */
  section?: string;
  priority?: Priority;
  /** days from the day the template is used (0 = that day) */
  dueInDays?: number;
  /** estimate for workload planning (Task.effortHours) */
  effortHours?: number;
  /** focus block length in minutes (Task.focusMin / dur); defaults to 30 */
  focusMin?: number;
  description?: string;
  recurrence?: Recurrence;
}
export interface TemplateForm { name: string; description?: string; fields: FormFieldKey[] }
/** An automation rule; a "set_section" action's value is a section NAME, resolved to its id when applied. */
export interface TemplateRule { name: string; trigger: AutomationTrigger; actions: AutomationAction[] }
export interface TemplateProject {
  /** stable within its template ("campaigns") */
  key: string;
  name: string;
  emoji: string;
  /** a lib/projectIdentity SpectrumKey ("jade"); stored as spectrumColor(hue) */
  hue: import("../lib/projectIdentity").SpectrumKey;
  description?: string;
  sections: string[];
  tasks: TemplateTask[];
  form?: TemplateForm;
  rule?: TemplateRule;
}
export interface WorkspaceTemplate {
  id: string;
  name: string;
  /** one sentence for the gallery card */
  summary: string;
  emoji: string;
  hue: import("../lib/projectIdentity").SpectrumKey;
  projects: TemplateProject[];
}
/** A template made concrete for a day (buildWorkspaceFromTemplate): real dates and colours, no ids yet. */
export interface PlannedTask {
  title: string;
  description: string;
  priority: Priority;
  section?: string;
  /** YYYY-MM-DD */
  dueDate?: string;
  effortHours?: number;
  focusMin: number;
  recurrence: Recurrence;
}
export interface PlannedProject {
  key: string;
  name: string;
  emoji: string;
  /** the string to store as Project.color: spectrumColor(hue) */
  color: string;
  description?: string;
  sections: string[];
  tasks: PlannedTask[];
  form?: TemplateForm;
  rule?: TemplateRule;
}
export interface WorkspacePlan {
  templateId: string;
  name: string;
  projects: PlannedProject[];
}

/* ============================================================
   0046 — public API keys, signed webhooks, Notion.
   Contracts shared by packages a1 (API + Settings › Developers),
   a2 (webhooks) and a3 (Notion). Database: 0046_api_webhooks_notion.sql.
   The definer functions answer snake_case JSON; lib/apiKeys, lib/webhooks
   and lib/notion parse it into these camelCase shapes. Every feature hides
   itself or explains why until its migration / function is live.
   ============================================================ */

/* ---------- API keys (public.api_keys; create/list/revoke_api_key) ---------- */

/** "read" keys (kanbo_pk_…) can only make GET requests; "write" keys (kanbo_sk_…) can change data. */
export type ApiKeyAccess = "read" | "write";
export type ApiKeyStatus = "active" | "revoked" | "expired";
export interface ApiKey {
  id: string;
  name: string;
  /** the first 13 characters, e.g. "kanbo_sk_Ab3x" — the full key is never stored */
  prefix: string;
  access: ApiKeyAccess;
  /** null = a personal key (acts as you everywhere you can act); else a team key limited to that workspace */
  workspaceId: string | null;
  workspaceName: string | null;
  /** whose key it is: requests act as this person */
  userId: string;
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: ApiKeyStatus;
  /** may the signed-in person revoke it (their own key, or owner/admin of its workspace) */
  canRevoke: boolean;
}
/** create_api_key()'s answer: the only time the full key exists outside the caller's clipboard. */
export interface CreatedApiKey extends ApiKey {
  /** "kanbo_sk_…" / "kanbo_pk_…" — show once, with a copy button and a warning */
  key: string;
}
export interface NewApiKeyInput {
  name: string;
  /** null = personal; a workspace id = team key (owners/admins only) */
  workspaceId: string | null;
  access: ApiKeyAccess;
  /** ISO timestamp, at least an hour and at most five years ahead; null = never */
  expiresAt: string | null;
}
export type ApiKeyFailure = "not_allowed" | "too_many" | "invalid" | "not_found" | "unavailable" | "network" | "error";

/* ---------- webhooks (public.webhooks / webhook_deliveries; *_webhook functions) ---------- */

export type WebhookEvent =
  | "task.created" | "task.updated" | "task.completed" | "task.deleted"
  | "comment.created" | "project.created" | "project.updated" | "member.joined";
/** what a delivery carried: an event, or a test ping */
export type WebhookDeliveryEvent = WebhookEvent | "ping";
export interface Webhook {
  id: string;
  /** null = personal (your personal tasks and projects) */
  workspaceId: string | null;
  url: string;
  description: string | null;
  events: WebhookEvent[];
  active: boolean;
  createdBy: string;
  createdByName: string | null;
  /** failed attempts in a row (20 switches it off) */
  failureCount: number;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** creator (while a writer) or a workspace owner/admin */
  canManage: boolean;
}
/** create_webhook()'s answer: the signing secret, shown once. */
export interface CreatedWebhook extends Webhook {
  /** "whsec_…" */
  secret: string;
}
export interface NewWebhookInput {
  workspaceId: string | null;
  url: string;
  events: WebhookEvent[];
  description?: string | null;
}
/** update_webhook(): only the fields given change; description "" clears it */
export interface WebhookPatch {
  url?: string;
  events?: WebhookEvent[];
  active?: boolean;
  description?: string | null;
}
export type WebhookDeliveryState = "pending" | "delivered" | "failed";
export interface WebhookDelivery {
  id: string;
  webhookId: string;
  outboxId: number;
  event: WebhookDeliveryEvent;
  state: WebhookDeliveryState;
  /** attempts made so far */
  attempt: number;
  /** the endpoint's HTTP status (0 / null: no answer — timeout, DNS, refused) */
  statusCode: number | null;
  error: string | null;
  /** how long the endpoint took to answer */
  durationMs: number | null;
  /** pending: when the next try is due */
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export type WebhookFailure = "not_allowed" | "invalid_url" | "invalid_events" | "too_many" | "too_many_tests" | "not_found" | "unavailable" | "network" | "error";

/* ---------- Notion (workspace_integrations.notion_*, notion_syncs, notion_links, notion_page_cache) ---------- */

export type { NotionFieldMapping } from "../../supabase/functions/_shared/notion.ts";

/** notion_status(): what anyone in the workspace may know (never the token). */
export interface NotionStatus {
  connected: boolean;
  /** the Notion workspace's name, from the token check */
  workspaceName: string | null;
  botId: string | null;
  /** owners/admins only: "…abcd" */
  tokenHint: string | null;
  connectedAt: string | null;
  connectedByName: string | null;
  /** owner/admin: connect, disconnect, import, syncs */
  canManage: boolean;
  /** owner/admin/member: link pages to tasks (guests can't) */
  canLink: boolean;
  syncCount: number;
}
export type NotionSyncDirection = "two_way" | "from_notion";
/** The last run's counts (notion_syncs.stats). */
export interface NotionSyncStats {
  created?: number;
  updated?: number;
  /** Kanbo → Notion page updates */
  pushed?: number;
  skipped?: number;
  /** ISO time of the run */
  at?: string;
}
export interface NotionSync {
  id: string;
  workspaceId: string;
  projectId: string;
  databaseId: string;
  databaseTitle: string | null;
  mapping: import("../../supabase/functions/_shared/notion.ts").NotionFieldMapping;
  direction: NotionSyncDirection;
  enabled: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  /** shown in Settings as written (a sentence) */
  lastError: string | null;
  lastErrorAt: string | null;
  stats: NotionSyncStats;
  /** the person the sync acts as (null: they left — an owner/admin saves it again) */
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}
export type NotionLinkKind = "synced" | "reference";
/** A Notion page's title / icon as last fetched (notion_page_cache). */
export interface NotionPageMeta {
  title: string | null;
  /** an emoji, or an https image URL */
  icon: string | null;
  url: string | null;
  lastEditedTime: string | null;
  archived: boolean;
  fetchedAt: string | null;
}
export interface NotionLink {
  id: string;
  workspaceId: string;
  taskId: string;
  /** dashed lower-case id */
  pageId: string;
  databaseId: string | null;
  syncId: string | null;
  /** synced: made by an import / sync (unlinking needs an owner/admin); reference: someone linked it */
  kind: NotionLinkKind;
  lastSyncedAt: string | null;
  notionLastEdited: string | null;
  createdBy: string | null;
  createdAt: string;
  /** null until the notion function has fetched it */
  page: NotionPageMeta | null;
}
/** A database the integration can see (notion function: "databases"). */
export interface NotionDatabaseSummary {
  id: string;
  title: string;
  /** an emoji or https image URL */
  icon: string | null;
  url: string | null;
  lastEditedTime: string | null;
}
export type NotionPropertyType =
  | "title" | "rich_text" | "status" | "select" | "multi_select" | "date" | "people"
  | "checkbox" | "number" | "url" | "email" | "phone_number" | "other";
export interface NotionPropertySchema {
  id: string;
  name: string;
  type: NotionPropertyType;
  /** status / select / multi_select option names */
  options?: string[];
}
export interface NotionDatabaseSchema {
  id: string;
  title: string;
  properties: NotionPropertySchema[];
}
/** One page of the import preview: property name → display text. */
export interface NotionPreviewRow {
  pageId: string;
  values: Record<string, string | string[] | null>;
}
export interface NotionImportRequest {
  workspaceId: string;
  databaseId: string;
  mapping: import("../../supabase/functions/_shared/notion.ts").NotionFieldMapping;
  /** an existing project in the workspace, or null with `newProject` */
  projectId: string | null;
  newProject?: { name: string; emoji: string; color: string } | null;
  /** also save a sync (notion_syncs) so later changes keep flowing */
  keepInSync: boolean;
  direction: NotionSyncDirection;
}
export interface NotionImportResult {
  projectId: string;
  syncId: string | null;
  created: number;
  skipped: number;
  /** per-page problems, as sentences (at most 20) */
  errors: string[];
}
export type NotionFailure =
  | "not_connected" | "not_allowed" | "invalid_token" | "not_shared" | "rate_limited"
  | "notion_error" | "invalid" | "not_found" | "unavailable" | "network" | "error";

/* ============================================================
   0047 — recycle bin, workspace history, approvals, project docs,
   and the wave's planner + uptime contracts. Database:
   0047_bin_history_approvals_docs.sql (docs/integrations/database-0047.md).
   The definer functions answer snake_case JSON; lib/trash, lib/audit,
   lib/approvals and lib/docs parse it into these camelCase shapes.
   ============================================================ */

/* ---------- recycle bin (public.trash; restore_from_trash · restore_trash_items · purge_trash) ---------- */

export type TrashKind = "task" | "project";
/** What a bin item holds (trash.summary.counts). A task's own row counts in `tasks`. */
export interface TrashCounts {
  tasks: number;
  /** tasks: its sub-tasks (all levels) */
  subtasks: number;
  comments: number;
  attachments: number;
  /** checklist items (public.subtasks) */
  checklist: number;
  /** projects: its sections */
  sections: number;
  /** projects: its docs */
  docs: number;
}
export interface TrashSummary {
  /** a task: its project when deleted (null for Personal / a project already gone) · a project: itself */
  project: { id: string; name: string; emoji: string; color: string; description?: string | null } | null;
  /** a sub-task deleted on its own: its parent then */
  parent: { id: string; title: string } | null;
  /** tasks only */
  status?: Status;
  priority?: Priority;
  dueDate?: string | null;
  assigneeId?: string | null;
  /** it was archived when deleted */
  archived: boolean;
  counts: TrashCounts;
}
/** One bin row (every column but the snapshot, which only the server reads). */
export interface TrashItem {
  id: string;
  kind: TrashKind;
  /** the deleted task's / project's id: it comes back under it */
  itemId: string;
  /** null = personal */
  workspaceId: string | null;
  /** the row's creator */
  userId: string | null;
  /** a task's project when deleted; a project's own id */
  projectId: string | null;
  title: string;
  summary: TrashSummary;
  deletedBy: string | null;
  /** "Kanbo" when the server deleted it (Notion sync, an import undo…) */
  deletedByName: string | null;
  deletedAt: string;
  /** when housekeeping deletes it for good (30 days after deletedAt) */
  purgeAfter: string;
  restoredAt: string | null;
  restoredBy: string | null;
}
export interface TrashRestoreResult {
  /** the bin row */
  id: string;
  kind: TrashKind;
  itemId: string;
  /** "already_restored": someone (or an earlier call) restored it first — not an error */
  status: "restored" | "already_restored";
  /** where it is now: a task's project ("p-personal" for Personal), a project's own id */
  projectId: string | null;
  /** say this in the toast when set ("Its project was deleted, so it's back in “Marketing”.") */
  note: string | null;
  counts: TrashCounts | null;
}
export type TrashFailure = "not_allowed" | "not_found" | "conflict" | "no_project" | "unavailable" | "network" | "error";
/** restore_trash_items(): one answer per id, newest delete first. */
export interface TrashBulkResult {
  id: string;
  ok: boolean;
  result?: TrashRestoreResult;
  error?: TrashFailure;
  /** the server's words for a failure */
  message?: string;
}

/* ---------- workspace history (public.audit_events) ---------- */

export type AuditAction =
  | "task.deleted" | "task.restored" | "task.purged"
  | "project.deleted" | "project.restored" | "project.purged" | "project.archived" | "project.unarchived"
  | "member.invited" | "member.joined" | "member.removed" | "role.changed"
  | "workspace.renamed"
  | "integration.connected" | "integration.disconnected"
  | "api_key.created" | "api_key.revoked"
  | "webhook.created" | "webhook.deleted";
export type AuditTargetKind = "task" | "project" | "member" | "workspace" | "integration" | "api_key" | "webhook";
export interface AuditEvent {
  id: string;
  workspaceId: string;
  /** null: the person's account is gone, or Kanbo did it (cron, Notion sync) */
  actorId: string | null;
  /** as it was then ("Kanbo" for the server) */
  actorName: string;
  /** a later migration may add actions: show those by their raw name */
  action: AuditAction | (string & {});
  targetKind: AuditTargetKind | (string & {}) | null;
  targetId: string | null;
  targetTitle: string | null;
  /** per action: role.changed { from, to }, member.removed { self, invite, account_deleted },
   *  workspace.renamed { from, to }, integration.* { provider }, webhook.* { host, events },
   *  api_key.* { access, prefix }, task/project.deleted { trash_id, … }, *.purged { expired? } */
  detail: Record<string, unknown>;
  createdAt: string;
}
/** A page of history: newest first, keyset-paged on (createdAt, id). */
export interface AuditQuery {
  workspaceId: string;
  /** one person's actions */
  actorId?: string | null;
  /** only these actions */
  actions?: AuditAction[] | null;
  /** YYYY-MM-DD, inclusive, Europe/London days */
  from?: string | null;
  to?: string | null;
  /** the `next` of the previous page */
  before?: AuditCursor | null;
  /** default 100, at most 500 */
  limit?: number;
}
export interface AuditCursor { createdAt: string; id: string }
export interface AuditPage { events: AuditEvent[]; next: AuditCursor | null }
export type AuditFailure = "unavailable" | "network" | "error";

/* ---------- approvals (public.approvals, approval_reviewers) ---------- */

export type ApprovalStatus = "pending" | "approved" | "changes_requested" | "cancelled";
/** any: the first approval approves · all: everyone must approve. Any "changes requested" resolves it as that. */
export type ApprovalRule = "any" | "all";
export type ApprovalDecision = "approved" | "changes_requested";
/** what an Inbox approval item / history entry says happened */
export type ApprovalEvent = "requested" | ApprovalDecision | "cancelled";
export interface ApprovalReviewer {
  userId: string;
  name: string;
  /** null: not decided yet */
  decision: ApprovalDecision | null;
  comment: string | null;
  decidedAt: string | null;
}
export interface Approval {
  id: string;
  taskId: string;
  workspaceId: string;
  requestedBy: string | null;
  requestedByName: string | null;
  /** defaults to the task's title */
  title: string;
  note: string | null;
  /** a specific file on the task, when the request is about one */
  attachmentId: string | null;
  status: ApprovalStatus;
  rule: ApprovalRule;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  reviewers: ApprovalReviewer[];
  /** you're a reviewer and it's still open */
  canDecide: boolean;
  /** you asked (or you're an owner/admin) and it's still open */
  canCancel: boolean;
}
/** list_my_approvals(): an approval with its task. */
export interface ApprovalWithTask extends Approval {
  task: { id: string; title: string; projectId: string; workspaceId: string | null; status: Status; dueDate: string | null } | null;
}
export interface MyApprovals {
  /** open requests waiting on your decision (Inbox › Approvals for you) */
  toReview: ApprovalWithTask[];
  /** open requests you made (My tasks › Waiting on › Waiting on approval) */
  requested: ApprovalWithTask[];
}
/** A task's latest request, for row/card badges ("Pending 1/2", "Approved", "Changes requested"). */
export interface ApprovalSummary {
  approvalId: string;
  taskId: string;
  status: ApprovalStatus;
  rule: ApprovalRule;
  approved: number;
  total: number;
}
export interface NewApprovalInput {
  taskId: string;
  /** 1–10 people in the task's workspace (guests may review), never yourself */
  reviewerIds: string[];
  rule: ApprovalRule;
  note?: string | null;
  /** defaults to the task's title */
  title?: string | null;
  attachmentId?: string | null;
}
export type ApprovalFailure = "not_allowed" | "not_found" | "already_pending" | "closed" | "invalid" | "unavailable" | "network" | "error";

/* ---------- project docs (public.project_docs, project_doc_versions) ---------- */

export type DocBlockType = "h1" | "h2" | "h3" | "p" | "bullet" | "numbered" | "todo" | "quote" | "divider" | "callout";
export type DocMark = "b" | "i" | "code";
/** A run of text inside a block. A mention span's text is the name as shown ("@Sana"). */
export interface DocSpan {
  text: string;
  marks?: DocMark[];
  /** a link (http(s) / mailto only) */
  href?: string;
  /** an @mention: the member's user id */
  mention?: string;
}
/** One block of a doc. The body is DocBlock[] (stored as-is in project_docs.body). */
export interface DocBlock {
  /** stable within the doc (lib/docs newBlockId) */
  id: string;
  type: DocBlockType;
  /** absent for dividers */
  spans?: DocSpan[];
  /** todo blocks */
  checked?: boolean;
  /** "Make task": the task this line became (its live status shows beside the line) */
  taskId?: string;
  /** callouts: an emoji */
  icon?: string;
  /** list nesting, 0–3 */
  indent?: number;
}
export interface ProjectDoc {
  id: string;
  projectId: string;
  /** the project's (null = personal) */
  workspaceId: string | null;
  title: string;
  body: DocBlock[];
  /** an emoji */
  icon: string | null;
  position: number | null;
  /** who the doc @mentions now (the server notifies newcomers once) */
  mentions: string[];
  createdBy: string | null;
  createdByName: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
  createdAt: string;
  /** the optimistic-concurrency token: send it back as baseUpdatedAt */
  updatedAt: string;
  archivedAt: string | null;
  /** you may edit it (never guests) */
  canEdit: boolean;
}
/** A doc in the Docs tab's list (no body). */
export type ProjectDocListItem = Omit<ProjectDoc, "body" | "mentions" | "createdByName" | "updatedByName" | "canEdit">;
export interface ProjectDocVersion {
  id: string;
  docId: string;
  title: string;
  /** null in version lists (fetch one to read it) */
  body: DocBlock[] | null;
  savedBy: string | null;
  savedAt: string;
}
export interface DocSaveInput {
  /** a fresh uuid for a new doc (made by the app) */
  id: string;
  projectId: string;
  title: string;
  body: DocBlock[];
  /** null for a new doc; else the updatedAt you last loaded or saved */
  baseUpdatedAt: string | null;
  /** undefined/null keeps the icon, "" clears it */
  icon?: string | null;
  /** every member the doc @mentions now (lib/docs mentionsIn); null = unchanged */
  mentions?: string[] | null;
}
/** conflict: someone else saved since your base — `doc` is theirs ("Sana edited this — reload / keep mine";
 *  keep mine = save again with baseUpdatedAt = doc.updatedAt). */
export type DocSaveResult = { status: "saved"; doc: ProjectDoc } | { status: "conflict"; doc: ProjectDoc };
export type DocSaveState = "idle" | "saving" | "saved" | "offline" | "conflict" | "error";
export type DocTemplateId = "blank" | "brief" | "meeting" | "decisions" | "retro";
export type DocFailure = "not_allowed" | "not_found" | "too_large" | "too_many" | "invalid" | "unavailable" | "network" | "error";

/* ---------- AI project planner (lib/projectPlanner; ai-assist mode "plan") ---------- */

export type { AiPlanReply, AiPlanRequest, AiPlanTask, AiPlanRosterEntry } from "../../supabase/functions/_shared/projectPlan.ts";

export interface PlannerInput {
  /** what the person wants to achieve */
  goal: string;
  /** YYYY-MM-DD */
  deadline?: string | null;
  /** who may be assigned (member ids); empty = the whole roster */
  memberIds?: string[];
  constraints?: string | null;
  projectName?: string | null;
}
export interface PlannerRosterMember {
  id: string;
  name: string;
  /** their job title in the workspace */
  title?: string | null;
  /** guests can be assigned but carry no team capacity (Workload) */
  guest?: boolean;
}
export interface PlannerContext {
  /** YYYY-MM-DD, Europe/London */
  today: string;
  workspaceId: string | null;
  roster: PlannerRosterMember[];
  mode: "new" | "append";
  /** append: the project's sections and task titles (so the plan adds, not repeats) */
  existingSections?: string[];
  existingTitles?: string[];
}
export interface PlanSection {
  /** stable within the draft */
  key: string;
  name: string;
}
export interface PlanTask {
  /** stable within the draft; dependsOn names these */
  key: string;
  title: string;
  /** a PlanSection key (null: no section) */
  sectionKey: string | null;
  /** a roster member id (resolved from the AI's hint), or null */
  assigneeId: string | null;
  estimateHours: number | null;
  /** working days from the plan's start day */
  startOffset: number;
  dueOffset: number;
  dependsOn: string[];
  isMilestone: boolean;
  description: string;
}
/** The editable draft (step 2: review). */
export interface PlanDraft {
  /** the project's name (new) — or the project's own (append) */
  name: string;
  emoji: string;
  /** suggested identity colour */
  hue: import("../lib/projectIdentity").SpectrumKey;
  /** YYYY-MM-DD: day 0 (a working day) */
  startDate: string;
  deadline: string | null;
  sections: PlanSection[];
  tasks: PlanTask[];
  /** where the draft came from */
  source: "ai" | "fallback";
}
export type PlanWarningKind = "overloaded" | "past_deadline" | "unassigned" | "dependency_order" | "trimmed";
export interface PlanWarning {
  kind: PlanWarningKind;
  /** a sentence to show */
  message: string;
  taskKeys?: string[];
  memberId?: string;
}
/** How the planner creates things: the host's own create paths (so its state updates). */
export interface PlanApplyDeps {
  createProject(input: { name: string; emoji: string; color: string; workspaceId: string | null; description?: string }): Promise<Project>;
  createSection(input: { projectId: string; workspaceId: string | null; name: string; position?: number }): Promise<Section>;
  /** store.createTasksBatch semantics: saved copies (final ids) in order; throws BatchCreateError with .saved on partial failure */
  createTasks(tasks: Task[]): Promise<Task[]>;
  addDependency(taskId: string, dependsOn: string): Promise<void>;
  /** rollback after a failure — a new project: removes it with everything in it (it goes to the bin) */
  deleteProject?(projectId: string): Promise<void>;
  /** rollback — tasks that saved */
  deleteTasks?(taskIds: string[]): Promise<void>;
  /** rollback when adding to a project: a section the plan added (empty by then; store.deleteSection) */
  deleteSection?(sectionId: string): Promise<void>;
}
export interface PlanApplyProgress {
  step: "project" | "sections" | "tasks" | "dependencies" | "done";
  done: number;
  total: number;
}
export interface AppliedProjectPlan {
  project: Project;
  /** the sections and tasks this run made that stand (after a failed tidy-up: what it couldn't remove) */
  sections: Section[];
  tasks: Task[];
  dependencies: number;
  /** what couldn't be made, by name */
  failed: string[];
  /** a failure undid everything that had been made */
  rolledBack: boolean;
}
export type PlannerFailure = "ai_unavailable" | "daily_limit" | "not_allowed" | "bad_output" | "network" | "error";

/* ---------- uptime (health edge function; /admin › System status) ---------- */

export type { HealthCheck, HealthCheckName, HealthReport } from "../../supabase/functions/_shared/health.ts";
