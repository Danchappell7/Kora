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

/** "integration": a notice about one of your integrations, with no task (0046: a webhook switched off after 20 failures) */
export type ActivityKind = "created" | "status" | "completed" | "reopened" | "comment" | "deleted" | "assigned" | "mention" | "integration";

export interface Activity {
  id: string;
  taskId: string | null;
  taskTitle: string;
  kind: ActivityKind;
  detail: string;
  createdAt: string;
  readAt?: string;
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
}

/* external calendar integration (Google / Microsoft) */
export type CalProvider = "google" | "microsoft";

export interface CalendarConnection {
  provider: CalProvider;
  accountEmail: string;
  createdAt?: string;
}

export interface ExternalEvent {
  id: string;
  title: string;
  start: string;   // ISO datetime (or date for all-day)
  end: string;
  allDay: boolean;
  provider: string;
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
