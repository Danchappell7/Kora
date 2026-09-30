/* ============================================================
   KANBO — data store
   One interface, two adapters:
   - mock    : in-memory demo data (no backend needed)
   - supabase: real Postgres persistence
   Components depend only on the domain types, never the adapter.
   ============================================================ */
import type { RealtimeChannel, RealtimePostgresChangesPayload, SupabaseClient } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { offlineQueue, LEGACY_QUEUE_KEY, type QueuedMutation } from "../lib/offlineQueue";
import { reportError } from "../lib/monitoring";
import {
  TASKS, PROJECTS, MEMBERS, WORKSPACES, energyOf, PLAN_TODAY_IDS, setReferenceData,
  PERSONAL_PROJECT, PERSONAL_WORKSPACE, BUILTIN_TAGS, getMember, getProject, toLocalISO, SELF_COLOR,
} from "./data";
import type { Task, Member, Project, Workspace, WorkspaceMember, Subtask, TagDef, Comment, Activity, ActivityKind, Attachment, Subscription, Plan, SubStatus, Status, Priority, EnergyKind, Recurrence, Role, Profile, AccessRequest, CalProvider, CalendarConnection, ExternalEvent, CustomValue, CustomFieldDef, Section, SavedSearch, Goal, GoalStatus, Portfolio, StatusUpdate, StatusKind, AutomationRule, AutomationAction, FormDef, FormFieldKey, WorkspaceEvent } from "./types";
import type { AiOutcome, AskContext, AskResult, ExtractedTask } from "../lib/askTypes";

export interface Bootstrap {
  tasks: Task[];
  projects: Project[];
  tags: Record<string, TagDef>;
  workspaces: Workspace[];
  members: WorkspaceMember[];
  currentUserId: string;
  defaultWorkspace: string | null;
  profile: Profile | null;
  sections: Section[];
  customFields: CustomFieldDef[];
  savedSearches: SavedSearch[];
  goals: Goal[];
  portfolios: Portfolio[];
  statusUpdates: StatusUpdate[];
  automationRules: AutomationRule[];
  forms: FormDef[];
  /** Parts whose query failed on this load. Their lists above are the last
   *  good copy cached on this device (or empty), not the server's, so a
   *  caller that already has them on screen should keep its own. */
  partial?: BootPartial;
}
export interface BootPartial { profile?: true; projects?: true; tags?: true; workspaces?: true; members?: true }

/** For a reload while the lists are already on screen: each part this load
 *  couldn't read (see `partial`) takes the on-screen copy, which is newer than
 *  the device snapshot bootstrap filled it from — so a passing error can't
 *  bring back a deleted project or undo a rename. Parts the caller doesn't pass
 *  stay as loaded. Not for the first load, where the snapshot is the best copy. */
export function keepOnScreen(b: Bootstrap, onScreen: Partial<Pick<Bootstrap, "profile" | "projects" | "tags" | "workspaces" | "members">>): Bootstrap {
  const p = b.partial;
  if (!p) return b;
  const out = { ...b };
  if (p.profile && onScreen.profile !== undefined) out.profile = onScreen.profile;
  if (p.projects && onScreen.projects) out.projects = onScreen.projects;
  if (p.tags && onScreen.tags) out.tags = onScreen.tags;
  if (p.workspaces && onScreen.workspaces) out.workspaces = onScreen.workspaces;
  if (p.members && onScreen.members) out.members = onScreen.members;
  return out;
}

export interface AuthedUser {
  id: string;
  email?: string;
  name?: string;
}

export interface NewProject {
  name: string;
  emoji: string;
  color: string;
  workspaceId: string | null;
  /** The starter template picked for it (the caller adds its tasks; not stored). */
  templateId?: string;
}

/* fields the prototype derived on load; persisted as columns in Supabase */
function withPlanFields(t: Task): Task {
  const wsId = PROJECTS.find((p) => p.id === t.projectId)?.workspaceId ?? null;
  return { ...t, energy: energyOf(t), dur: t.focusMin, scheduled: null, planToday: PLAN_TODAY_IDS.includes(t.id), workspaceId: wsId, recurrence: t.recurrence ?? "none" };
}

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.round(Math.random() * 1e6));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** True for ids the database can store (uuid columns reject "t-new-…" style ids). */
const isUuid = (id: unknown): id is string => typeof id === "string" && UUID_RE.test(id);
/** A real v4 UUID even where crypto.randomUUID is missing (older Safari, http). */
function uuidv4(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
// ids per `.in()` filter — they travel in the URL, and ~200 uuids already
// brushes the gateway's ~8KB request-line limit.
const IN_CHUNK = 100;

/* Report a problem once per session (keyed), so a persistent misconfiguration
   shows up in monitoring without flooding it. */
const reportedOnce = new Set<string>();
function reportOnce(key: string, error: unknown, context?: Record<string, unknown>) {
  if (reportedOnce.has(key)) return;
  reportedOnce.add(key);
  reportError(error, context);
}

/* Always write rows under the REAL authenticated user id. Reading it from the
   live Supabase session (not app state) means a stale "m-self" placeholder can
   never leak into a uuid column. */
async function authUid(fallback: string): Promise<string> {
  if (!supabase) return fallback;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? fallback;
  } catch { return fallback; } // e.g. an offline token refresh — never lose the write over it
}
/** Who a queued op belongs to, answered WITHOUT waiting on the auth client:
 *  the queue is already scoped to the signed-in user (by bootstrap and on
 *  every auth change). Offline with an expired token, getSession() retries
 *  the refresh for ~25 s, and an edit that isn't in the queue yet is lost if
 *  the tab is closed meanwhile — so writes queue first and never await this.
 *  Null only before the first sign-in is seen; callers then ask the session. */
const queueOwner = (): string | null => offlineQueue.currentUser();

/* ---------- DB row <-> Task mapping (Supabase) ---------- */
interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: Status;
  priority: Priority;
  project_id: string;
  assignee_id: string;
  created_at?: string | null;
  due_date: string | null;
  due_time?: string | null;
  start_date?: string | null;
  original_due_date: string | null;
  completed_at: string | null;
  archived_at?: string | null;
  is_milestone?: boolean | null;
  tags: string[] | null;
  focus_min: number;
  comments: number;
  ai_score: number;
  ai_reason: string | null;
  energy: EnergyKind | null;
  dur: number | null;
  scheduled: number | null;
  plan_today: boolean | null;
  workspace_id?: string | null;
  recurrence?: Recurrence | null;
  position?: number | null;
  parent_id?: string | null;
  my_section_id?: string | null;
  followers?: string[] | null;
  collaborators?: string[] | null;
  reactions?: Record<string, string[]> | null;
  section_id?: string | null;
  custom?: Record<string, unknown> | null;
  effort_hours?: number | null;
  logged_hours?: number | null;
  subtasks?: { id: string; title: string; done: boolean; position?: number }[] | null;
  task_dependencies?: { depends_on: string }[] | null;
}

function rowToTask(r: TaskRow): Task {
  const subs = (r.subtasks ?? []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? "",
    status: r.status,
    priority: r.priority,
    projectId: r.project_id,
    assigneeId: r.assignee_id,
    parentId: r.parent_id ?? undefined,
    followers: r.followers ?? [],
    collaborators: r.collaborators ?? [],
    reactions: (r.reactions as Record<string, string[]>) ?? {},
    sectionId: r.section_id ?? undefined,
    mySectionId: r.my_section_id ?? undefined,
    custom: (r.custom as Record<string, CustomValue>) ?? {},
    effortHours: r.effort_hours ?? undefined,
    loggedHours: r.logged_hours ?? undefined,
    dueDate: r.due_date ?? undefined,
    dueTime: r.due_time ?? undefined,
    startDate: r.start_date ?? undefined,
    originalDueDate: r.original_due_date ?? undefined,
    completedAt: r.completed_at ?? undefined,
    archivedAt: r.archived_at ?? undefined,
    createdAt: r.created_at ?? undefined,
    isMilestone: r.is_milestone ?? false,
    tags: r.tags ?? [],
    dependencies: (r.task_dependencies ?? []).map((d) => d.depends_on),
    subtasks: subs.map((s) => ({ id: s.id, title: s.title, done: s.done })),
    focusMin: r.focus_min,
    comments: r.comments,
    aiScore: r.ai_score,
    aiReason: r.ai_reason ?? undefined,
    energy: r.energy ?? energyOf({ tags: r.tags ?? [] } as Task),
    dur: r.dur ?? r.focus_min,
    scheduled: r.scheduled ?? null,
    planToday: r.plan_today ?? false,
    workspaceId: r.workspace_id ?? null,
    recurrence: r.recurrence ?? "none",
    position: r.position ?? 0,
  };
}

interface ProjectRow { id: string; name: string; emoji: string | null; color: string | null; workspace_id: string | null; description?: string | null; status?: string | null; owner_id?: string | null; contributor_ids?: string[] | null; archived_at?: string | null; }
function rowToProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, emoji: r.emoji ?? "📁", color: r.color ?? "oklch(0.74 0.14 230)", workspaceId: r.workspace_id ?? null, description: r.description ?? undefined, status: r.status ?? undefined, ownerId: r.owner_id ?? undefined, contributorIds: r.contributor_ids ?? undefined, archivedAt: r.archived_at ?? null };
}

interface TagRow { id: string; label: string; color: string; workspace_id?: string | null; }

export interface CreatedTag { id: string; label: string; color: string; }

interface CommentRow { id: string; task_id: string; user_id: string; author_name: string; body: string; created_at: string; mentions?: string[] | null; reactions?: Record<string, string[]> | null; parent_id?: string | null; }
function rowToComment(r: CommentRow): Comment {
  return { id: r.id, taskId: r.task_id, authorId: r.user_id, authorName: r.author_name, body: r.body, createdAt: r.created_at, mentions: r.mentions ?? [], reactions: r.reactions ?? {}, parentId: r.parent_id ?? undefined };
}

interface ActivityRow { id: string; task_id: string | null; task_title: string; kind: string; detail: string; created_at: string; archived_at?: string | null; read_at?: string | null; }
function rowToActivity(r: ActivityRow): Activity {
  return { id: r.id, taskId: r.task_id, taskTitle: r.task_title, kind: r.kind as ActivityKind, detail: r.detail, createdAt: r.created_at, readAt: r.read_at ?? undefined };
}

interface ProfileRow { id: string; first_name: string; last_name: string; pronouns: string; email: string; avatar_url: string | null; approved?: boolean | null; suspended?: boolean | null; is_admin?: boolean | null; notify_prefs?: Record<string, boolean> | null; }
function rowToProfile(r: ProfileRow): Profile {
  return { id: r.id, firstName: r.first_name || "", lastName: r.last_name || "", pronouns: r.pronouns || "", email: r.email || "", avatarUrl: r.avatar_url, approved: r.approved ?? undefined, suspended: r.suspended ?? undefined, isAdmin: r.is_admin ?? undefined, notifyPrefs: r.notify_prefs ?? undefined };
}
function fullName(p: { firstName: string; lastName: string }): string {
  return [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
}
const AVATAR_BUCKET = "avatars";
const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export interface NewActivity {
  taskId: string | null;
  taskTitle: string;
  kind: ActivityKind;
  detail: string;
}

interface WorkspaceRow { id: string; name: string; owner_id: string; logo_url?: string | null; created_at?: string | null; }
interface MemberRow { id: string; workspace_id: string; user_id: string | null; email: string; name: string; role: Role; status: "invited" | "active"; title?: string | null; }
function rowToWsMember(r: MemberRow): WorkspaceMember {
  return { id: r.id, workspaceId: r.workspace_id, userId: r.user_id, email: r.email, name: r.name, role: r.role, status: r.status, title: r.title ?? undefined };
}

const MEMBER_COLORS = [
  "oklch(0.74 0.14 230)", "oklch(0.78 0.15 70)", "oklch(0.74 0.16 305)",
  "oklch(0.7 0.13 20)", "oklch(0.75 0.13 155)", "oklch(0.7 0.02 240)",
];

interface AttachmentRow { id: string; task_id: string; user_id?: string | null; name: string; size: number; mime: string; path: string; created_at: string; }
function rowToAttachment(r: AttachmentRow, url?: string): Attachment {
  return { id: r.id, taskId: r.task_id, name: r.name, size: r.size, mime: r.mime, path: r.path, url, createdAt: r.created_at, userId: r.user_id ?? undefined };
}

const ATTACH_BUCKET = "task-files";

// Call the `calendar` Edge Function (GET, query-string actions) with the live
// session token. Throws with the function's error message on non-2xx.
const CALENDAR_FN = (import.meta.env.VITE_SUPABASE_URL || "") + "/functions/v1/calendar";
async function callCalendarFn(qs: string): Promise<Record<string, unknown>> {
  if (!supabase) throw new Error("Calendar sync needs the live backend.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in.");
  const res = await fetch(`${CALENDAR_FN}${qs}`, {
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || "", Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Calendar request failed (${res.status})`);
  return body as Record<string, unknown>;
}

/* demo-mode in-memory stores (session-only, like the rest of demo mode) */
const demoComments: Record<string, Comment[]> = {};
let demoActivity: Activity[] = [];
let demoArchived: Activity[] = [];
let demoProfile: Profile | null = null;
let demoWorkspaces: Workspace[] = [];
let demoMembers: WorkspaceMember[] = [];
const demoAttachments: Record<string, Attachment[]> = {};

/* camelCase patch -> snake_case task row */
function patchToRow(patch: Partial<Task>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if ("status" in patch) row.status = patch.status;
  if ("priority" in patch) row.priority = patch.priority;
  if ("completedAt" in patch) row.completed_at = patch.completedAt ?? null;
  if ("scheduled" in patch) row.scheduled = patch.scheduled ?? null;
  if ("planToday" in patch) row.plan_today = patch.planToday;
  if ("dueDate" in patch) row.due_date = patch.dueDate ?? null;
  if ("originalDueDate" in patch) row.original_due_date = patch.originalDueDate ?? null;
  if ("projectId" in patch) row.project_id = patch.projectId;
  if ("title" in patch) row.title = patch.title;
  if ("description" in patch) row.description = patch.description;
  if ("assigneeId" in patch) row.assignee_id = patch.assigneeId;
  if ("tags" in patch) row.tags = patch.tags;
  if ("energy" in patch) row.energy = patch.energy;
  if ("comments" in patch) row.comments = patch.comments;
  if ("focusMin" in patch) row.focus_min = patch.focusMin;
  if ("recurrence" in patch) row.recurrence = patch.recurrence;
  if ("workspaceId" in patch) row.workspace_id = patch.workspaceId ?? null;
  if ("aiScore" in patch) row.ai_score = patch.aiScore;
  if ("aiReason" in patch) row.ai_reason = patch.aiReason;
  if ("position" in patch) row.position = patch.position;
  if ("dueTime" in patch) row.due_time = patch.dueTime ?? null;
  if ("startDate" in patch) row.start_date = patch.startDate ?? null;
  if ("archivedAt" in patch) row.archived_at = patch.archivedAt ?? null;
  if ("isMilestone" in patch) row.is_milestone = patch.isMilestone ?? false;
  if ("parentId" in patch) row.parent_id = patch.parentId ?? null;
  if ("followers" in patch) row.followers = patch.followers ?? [];
  if ("collaborators" in patch) row.collaborators = patch.collaborators ?? [];
  if ("reactions" in patch) row.reactions = patch.reactions ?? {};
  if ("sectionId" in patch) row.section_id = patch.sectionId ?? null;
  if ("mySectionId" in patch) row.my_section_id = patch.mySectionId ?? null;
  if ("custom" in patch) row.custom = patch.custom ?? {};
  if ("effortHours" in patch) row.effort_hours = patch.effortHours ?? null;
  if ("loggedHours" in patch) row.logged_hours = patch.loggedHours ?? null;
  if ("dur" in patch) row.dur = patch.dur ?? null;
  return row;
}

// Columns a write had to drop because the live DB doesn't have them yet (a
// migration not applied). Each is reported once, so "the schema is behind"
// is visible in monitoring instead of fields silently not saving.
const strippedColumns = new Set<string>();
/** Columns stripped from writes this session because the database lacks them. */
export function getStrippedColumns(): string[] { return [...strippedColumns]; }

// The column named in a missing-column error, or null.
function missingColumn(message?: string): { col: string; table?: string } | null {
  if (!message) return null;
  // PostgREST schema cache: Could not find the 'due_time' column of 'tasks' …
  let m = message.match(/Could not find the '([^']+)' column(?: of '([^']+)')?/i);
  if (m) return { col: m[1], table: m[2] };
  // Postgres 42703: column tasks.due_time does not exist  |  column "due_time" does not exist
  //                 | column "due_time" of relation "tasks" does not exist
  m = message.match(/column\s+"?(?:([\w]+)\.)?([a-z0-9_]+)"?(?:\s+of relation\s+"?([\w]+)"?)?\s+does not exist/i);
  if (m) return { col: m[2], table: m[1] ?? m[3] };
  return null;
}
function noteStripped(col: string, table?: string) {
  if (strippedColumns.has(col)) return;
  strippedColumns.add(col);
  reportError(new Error("schema behind: " + col), { op: "schema-behind", column: col, table });
}

// If a write failed because the DB doesn't have a column (a migration not yet
// applied), return a copy of the row with that column removed; null if the
// error isn't a missing-column error or the column isn't in the row.
function withoutMissingColumn(row: Record<string, unknown>, message?: string): Record<string, unknown> | null {
  const miss = missingColumn(message);
  if (!miss || !(miss.col in row)) return null;
  noteStripped(miss.col, miss.table);
  const copy = { ...row };
  delete copy[miss.col];
  return copy;
}

function taskToInsertRow(t: Task, userId: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    user_id: userId,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    project_id: t.projectId,
    assignee_id: t.assigneeId === "m-self" ? userId : t.assigneeId,
    due_date: t.dueDate ?? null,
    tags: t.tags,
    focus_min: t.focusMin,
    comments: t.comments,
    ai_score: t.aiScore,
    ai_reason: t.aiReason ?? null,
    energy: t.energy ?? null,
    dur: t.dur ?? t.focusMin,
    scheduled: t.scheduled ?? null,
    plan_today: t.planToday ?? true,
    workspace_id: t.workspaceId ?? null,
    recurrence: t.recurrence ?? "none",
    position: t.position ?? null,
  };
  // only send these when set, so a normal task insert never depends on a
  // later migration (0015/0018 and on) being applied — and one that isn't is
  // stripped rather than losing the task. A task created done (an import, a
  // completed recurrence) keeps its completion date; a monthly series keeps
  // its anchor day (see seriesAnchorDay).
  if (t.completedAt) row.completed_at = t.completedAt;
  if (t.archivedAt) row.archived_at = t.archivedAt;
  if (t.originalDueDate) row.original_due_date = t.originalDueDate;
  if (t.dueTime) row.due_time = t.dueTime;
  if (t.startDate) row.start_date = t.startDate;
  if (t.isMilestone) row.is_milestone = true;
  if (t.parentId) row.parent_id = t.parentId;
  if (t.followers && t.followers.length) row.followers = t.followers;
  if (t.collaborators && t.collaborators.length) row.collaborators = t.collaborators;
  if (t.reactions && Object.keys(t.reactions).length) row.reactions = t.reactions;
  if (t.sectionId) row.section_id = t.sectionId;
  if (t.mySectionId) row.my_section_id = t.mySectionId;
  if (t.custom && Object.keys(t.custom).length) row.custom = t.custom;
  if (t.effortHours != null) row.effort_hours = t.effortHours;
  if (t.loggedHours != null) row.logged_hours = t.loggedHours;
  return row;
}

// tasks ↔ task_dependencies has TWO foreign keys (task_id and depends_on), so
// the embed MUST name the FK or PostgREST returns 300 PGRST201 and the whole
// query fails. We want this task's own dependency rows (task_id = id).
const TASK_SELECT = "*, subtasks(*), task_dependencies!task_dependencies_task_id_fkey(depends_on)";

interface SectionRow { id: string; project_id: string; workspace_id: string | null; name: string; position: number | null }
const rowToSection = (r: SectionRow): Section => ({ id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, name: r.name, position: r.position ?? undefined });
interface CustomFieldRow { id: string; project_id: string; workspace_id: string | null; name: string; type: string; options: string[] | null; position: number | null }
const rowToCustomField = (r: CustomFieldRow): CustomFieldDef => ({ id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, name: r.name, type: r.type as CustomFieldDef["type"], options: r.options ?? [], position: r.position ?? undefined });
interface SavedSearchRow { id: string; name: string; query: unknown }
interface GoalRow { id: string; workspace_id: string | null; name: string; description: string | null; target: number | null; current: number | null; unit: string | null; due: string | null; status: string; position: number | null; parent_id?: string | null; project_id?: string | null }
const rowToGoal = (r: GoalRow): Goal => ({ id: r.id, workspaceId: r.workspace_id, name: r.name, description: r.description ?? undefined, target: r.target ?? undefined, current: r.current ?? undefined, unit: r.unit ?? undefined, due: r.due ?? undefined, status: (r.status as GoalStatus) ?? "on_track", position: r.position ?? undefined, parentId: r.parent_id ?? undefined, projectId: r.project_id ?? undefined });
interface PortfolioRow { id: string; workspace_id: string | null; name: string; project_ids: string[] | null }
const rowToPortfolio = (r: PortfolioRow): Portfolio => ({ id: r.id, workspaceId: r.workspace_id, name: r.name, projectIds: r.project_ids ?? [] });
interface StatusUpdateRow { id: string; workspace_id: string | null; project_id: string; summary: string; status: string; created_at: string }
const rowToStatusUpdate = (r: StatusUpdateRow): StatusUpdate => ({ id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, summary: r.summary, status: (r.status as StatusKind) ?? "on_track", createdAt: r.created_at });
interface AutomationRuleRow { id: string; workspace_id: string | null; project_id: string; name: string; trigger: string; actions: unknown; enabled: boolean }
const rowToRule = (r: AutomationRuleRow): AutomationRule => ({ id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, name: r.name, trigger: ((r.trigger as AutomationRule["trigger"]) || "task_created"), actions: (Array.isArray(r.actions) ? r.actions : []) as AutomationAction[], enabled: r.enabled });
interface FormRow { id: string; workspace_id: string | null; project_id: string; name: string; description: string | null; fields: unknown }
const rowToForm = (r: FormRow): FormDef => ({ id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, name: r.name, description: r.description ?? undefined, fields: (Array.isArray(r.fields) ? r.fields : []) as FormFieldKey[] });

export interface TaskEvent { id: string; actorName: string; field: string; oldValue: string | null; newValue: string | null; createdAt: string }
export interface AdminAccount { id: string; name: string; email: string; createdAt: string; updatedAt: string; approved?: boolean; isAdmin?: boolean; suspended?: boolean }
export interface AdminFunnel { signups: number; approved: number; activated: number; active_30d: number }
export interface AdminWorkspace { id: string; name: string; logo_url: string | null; created_at: string; owner_email: string | null; owner_name: string; members: number; tasks: number }
export interface AdminAuditEntry { id: string; actor_email: string | null; action: string; target: string | null; detail: string | null; created_at: string }
export interface AppBanner { id: string; message: string; kind: "info" | "warning" | "success" }
export interface AdminTrial { email: string; name: string; trial_ends_at: string; plan: string | null }
export interface AdminBilling {
  trialing: number; active: number; past_due: number; canceled: number;
  plan_personal: number; plan_team: number; seats_active: number; mrr_cents: number;
  trials_ending: AdminTrial[];
}
export interface AdminAccountDetail {
  id: string; name: string; email: string; createdAt: string; lastSignInAt: string;
  approved: boolean; isAdmin: boolean; suspended: boolean;
  workspacesOwned: number; workspacesMember: number; tasksTotal: number; tasksDone: number;
  plan: string | null; subStatus: string | null;
}
export interface AdminDay { d: string; signups: number; sessions: number; active: number; tasks: number; actions: number }
export interface AdminSeries { days: AdminDay[]; by_status: Record<string, number>; by_priority: Record<string, number> }

/* ============================================================
   Offline read cache — the last successful bootstrap snapshot, so a
   reload while offline restores the workspace instead of an error
   screen. Paired with offlineQueue (the write half).
   ============================================================ */
type RefData = Parameters<typeof setReferenceData>[0];
interface Snapshot { boot: Bootstrap; ref: RefData; uid: string; savedAt: number }
const SNAP_KEY = "kanbo-offline-snapshot";
function cacheSnapshot(snap: Snapshot) {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch { /* quota / private mode */ }
}
function readSnapshot(uid: string | undefined): Snapshot | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snapshot;
    return !uid || snap.uid === uid ? snap : null;
  } catch { return null; }
}
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
/** Fold pending offline mutations onto a task list so a reload shows the
 *  user's un-synced edits (not a pre-offline snapshot) — which also stops
 *  them re-creating a task they can't see and producing a duplicate on sync. */
function applyQueue(tasks: Task[]): Task[] {
  let out = tasks.slice();
  for (const m of offlineQueue.all()) {
    if (m.kind === "create") { if (!out.some((t) => t.id === m.task.id || (m.serverId && t.id === m.serverId))) out = [m.task, ...out]; }
    else if (m.kind === "update") out = out.map((t) => t.id === m.taskId ? { ...t, ...m.patch } : t);
    else out = out.filter((t) => t.id !== m.taskId);
  }
  return out;
}
/** True for fetch/network failures (offline), so we fall back to cache instead of erroring. */
const isNetworkError = (e: unknown) =>
  isOffline() || (e instanceof TypeError) || /fetch|network|Failed to fetch|load failed/i.test(String((e as Error)?.message ?? e));

/* ---------- session scoping ---------- */
// claim_invites runs once per signed-in user per page session — not on every
// realtime reload (which fans out to every connected teammate).
let claimedFor: string | null = null;
// bumped on every sign-out: a load that started before it must not write the
// previous user's workspace back into storage when it finishes
let sessionGen = 0;
// changes parked for a passing server problem get one more try per session
let deadRetriedFor: string | null = null;

/** Hand a pre-namespacing shared queue to its owner — the user the offline
 *  snapshot belongs to, i.e. whoever was last signed in on this device. */
function migrateLegacyQueue() {
  try { if (localStorage.getItem(LEGACY_QUEUE_KEY) === null) return; } catch { return; }
  offlineQueue.migrateLegacy(readSnapshot(undefined)?.uid ?? null);
}
/** Scope the offline queue to this user. */
function scopeQueueTo(uid: string) {
  if (offlineQueue.currentUser() === uid) return;
  migrateLegacyQueue();
  offlineQueue.setUser(uid);
}

/** Signed out (here or in another tab): nothing of theirs may outlive the
 *  session on a shared machine except their own namespaced queue, which only
 *  ever replays for them. */
function clearLocalOnSignOut() {
  migrateLegacyQueue(); // park an old shared queue with its owner first
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("kanbo-offline-") && !k.includes(":")) stale.push(k); // snapshot + legacy shared queue
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
  offlineQueue.setUser(null);
  claimedFor = null;
  deadRetriedFor = null;
  sessionGen++;
}

if (supabase) {
  // registered once, at module load. Only synchronous work in here — awaiting
  // supabase calls inside this callback can deadlock the auth client.
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") { clearLocalOnSignOut(); return; }
    const uid = session?.user?.id;
    if (uid && uid !== offlineQueue.currentUser()) {
      if (offlineQueue.currentUser()) claimedFor = null; // a different person is now signed in
      scopeQueueTo(uid);
    }
  });
}

/* ---------- default workspace ---------- */
const LAST_WS_KEY = "kanbo-last-ws:";
/** Where a session opens: the workspace the user was last in (if they still
 *  belong to it), else their first team workspace, else Personal (null). */
function resolveDefaultWorkspace(uid: string, workspaces: Workspace[]): string | null {
  const teams = workspaces.filter((w) => w.kind === "team" && !!w.id);
  let saved: string | null = null;
  try { saved = localStorage.getItem(LAST_WS_KEY + uid); } catch { /* private mode */ }
  if (saved !== null) {
    const s = saved.trim();
    if (s === "" || s === "null" || s === "personal") return null; // they were last in Personal
    if (teams.some((w) => w.id === s)) return s;
  }
  return teams[0]?.id ?? null;
}

/* ---------- task reads ---------- */
const TASK_PAGE = 1000; // PostgREST's default max-rows
/** Every task visible under RLS, a page at a time. One unpaged select is
 *  silently truncated at max-rows (1,000) in no particular order, so tasks
 *  would vanish and flicker between reloads. Keyset paging on id is stable
 *  even if rows are added or deleted between pages. */
async function loadAllTasks(client: SupabaseClient): Promise<TaskRow[]> {
  const rows: TaskRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 500; page++) {
    let q = client.from("tasks").select(TASK_SELECT).order("id", { ascending: true }).limit(TASK_PAGE);
    if (after) q = q.gt("id", after);
    const res = await q;
    if (res.error) throw res.error;
    const got = (res.data as TaskRow[] | null) ?? [];
    rows.push(...got);
    if (got.length < TASK_PAGE) break;
    after = got[got.length - 1].id;
  }
  return rows;
}

/* ---------- task writes (raw: throw on failure, never queue) ---------- */
/** Idempotent create: the row is written under an explicit id with
 *  ON CONFLICT DO NOTHING, so a retry after a lost response, or an offline
 *  replay in a second tab, can never produce a duplicate task. */
async function insertTaskRow(client: SupabaseClient, t: Task, id: string, uid: string): Promise<Task> {
  // Resilient insert: if the DB is missing a newer column (a migration not
  // applied yet), strip that column and retry so the task ALWAYS saves —
  // losing a field is acceptable, losing the whole task is not.
  let row: Record<string, unknown> = { ...taskToInsertRow(t, uid), id };
  for (let i = 0; i < 8; i++) {
    const { data, error } = await client.from("tasks").upsert(row, { onConflict: "id", ignoreDuplicates: true }).select("id");
    // no row back = it already exists (an earlier attempt landed) — keep the local copy
    if (!error) return { ...t, id: (data as { id: string }[] | null)?.[0]?.id ?? id };
    const stripped = withoutMissingColumn(row, error.message);
    if (!stripped) throw error;
    row = stripped;
  }
  throw new Error("createTask: could not persist after stripping unknown columns");
}
/** Bulk variant of insertTaskRow (one statement). Rows that omit a column get
 *  its database default, not NULL. */
async function upsertTaskRows(client: SupabaseClient, rows: Record<string, unknown>[]): Promise<void> {
  let batch = rows;
  for (let i = 0; i < 8; i++) {
    const { error } = await client.from("tasks").upsert(batch, { onConflict: "id", ignoreDuplicates: true, defaultToNull: false });
    if (!error) return;
    const miss = missingColumn(error.message);
    if (!miss || !batch.some((r) => miss.col in r)) throw error;
    noteStripped(miss.col, miss.table);
    batch = batch.map((r) => { const c = { ...r }; delete c[miss.col]; return c; });
  }
  throw new Error("createTasksBatch: could not persist after stripping unknown columns");
}
async function updateTaskRow(client: SupabaseClient, id: string, patch: Partial<Task>): Promise<void> {
  let row = patchToRow(patch);
  for (let i = 0; i < 8 && Object.keys(row).length; i++) {
    const { error } = await client.from("tasks").update(row).eq("id", id);
    if (!error) return;
    const stripped = withoutMissingColumn(row, error.message);
    if (!stripped) throw error;
    row = stripped; // nothing left to write once every column is stripped
  }
}
async function deleteTaskRow(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("tasks").delete().eq("id", id);
  if (error) throw error;
}

/** How the invitation email went. The invite itself is saved either way (it's
 *  claimed on the invitee's next sign-in), so a failed email only means the
 *  person needs the sign-up link some other way, or a resend later.
 *  - throttled: this invite was emailed under a minute ago (resend later)
 *  - email_not_configured: the server has no email provider set up
 *  - inviter_limit: over 500 invite emails this hour (retryAfter seconds)
 *  - already_active: they've already joined, so there's nothing to send
 *  - not_sent: anything else (the provider refused it, the request failed) */
export type InviteEmailReason = "throttled" | "email_not_configured" | "inviter_limit" | "already_active" | "not_sent";
export interface InviteEmailResult { sent: boolean; reason?: InviteEmailReason; retryAfter?: number; message?: string }
/** A new invite, plus how its email went (absent in demo mode, which sends none). */
export type InvitedMember = WorkspaceMember & { inviteEmail?: InviteEmailResult };
const INVITE_EMAIL_TIMEOUT_MS = 15_000;

/** What to tell the inviter about the invitation email: null when it went (or
 *  there's no result, as in demo mode). "error" means they need to act — share
 *  the sign-up link or resend later; "info" is worth knowing but needs nothing. */
export function inviteEmailNotice(r: InviteEmailResult | undefined): { tone: "info" | "error"; text: string } | null {
  if (!r || r.sent) return null;
  switch (r.reason) {
    case "throttled":
      return { tone: "info", text: "An invite email went to them less than a minute ago. You can resend it in a minute." };
    case "already_active":
      return { tone: "info", text: "They've already joined this workspace, so there's no invite to email." };
    case "email_not_configured":
      return { tone: "error", text: "Invite saved, but invite emails aren't set up yet. Copy the sign-up link and send it to them yourself." };
    case "inviter_limit": {
      if (r.message) return { tone: "error", text: r.message };
      const mins = r.retryAfter && r.retryAfter > 0 ? Math.ceil(r.retryAfter / 60) : 0;
      const when = mins ? `in about ${mins} minute${mins === 1 ? "" : "s"}` : "later";
      return { tone: "error", text: `Invite saved, but you've sent a lot of invites this hour, so the email is on hold. Resend it ${when} or share the sign-up link.` };
    }
    default:
      return { tone: "error", text: "Invite saved, but the email couldn't be sent. Share the sign-up link or resend it later." };
  }
}

/** The JSON body of a failed Edge Function call, if it has one. */
async function fnErrorBody(error: unknown): Promise<{ status?: number; body: Record<string, unknown> }> {
  const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown>; clone?: () => { json: () => Promise<unknown> } } })?.context;
  let body: Record<string, unknown> = {};
  try {
    const raw = await (ctx?.clone ? ctx.clone().json() : ctx?.json?.());
    if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
  } catch { /* not JSON, or already read */ }
  return { status: typeof ctx?.status === "number" ? ctx.status : undefined, body };
}

/* Why the last AI request didn't produce an answer, when the server said so
   in words worth showing (the daily limit, an account awaiting approval). */
let aiNoticeText: string | null = null;
async function noteAiRefusal(error: unknown): Promise<void> {
  const { status, body } = await fnErrorBody(error);
  if (body.error === "daily_limit" || status === 429) {
    aiNoticeText = typeof body.detail === "string" && body.detail ? body.detail : "You've used today's AI requests. They reset at midnight (UK time).";
  } else if (body.error === "not_allowed") {
    aiNoticeText = "Your account is still awaiting approval, so AI isn't available yet.";
  }
}

/** invite_member's guard messages, in the app's voice. Anything unrecognised
 *  passes through unchanged. */
function inviteErrorMessage(message: string): string {
  const m = message || "";
  if (/already a member/i.test(m)) return "They're already a member of this workspace. Change their role from the team list.";
  if (/only the owner can add admins/i.test(m)) return "Only the workspace owner can add admins.";
  if (/not authori[sz]ed/i.test(m)) return "Only workspace owners and admins can invite people.";
  if (/invalid email/i.test(m)) return "That doesn't look like a valid email address.";
  if (/invalid role/i.test(m)) return "Choose a role for this person: admin, member or guest.";
  return m || "Couldn't send the invite.";
}

/* ---------- AI context ---------- */
const AI_TASK_CAP = 120;     // ai-assist reads at most this many tasks
const AI_DONE_SLOTS = 40;    // room kept for recent completions when there's lots of open work
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
/** The tasks worth sending to the AI for a summary or a question: open work
 *  that most needs attention first (overdue, blocked, due today, in flight,
 *  due this week), then what was finished in the last 14 days — with people's
 *  and projects' names rather than ids, so "what's overdue and who owns it?"
 *  can actually be answered. */
function aiTaskContext(tasks: Task[], today: string) {
  const base = new Date(`${(today || "").slice(0, 10)}T00:00:00`);
  const day0 = Number.isNaN(base.getTime()) ? new Date() : base;
  const shift = (n: number) => { const d = new Date(day0); d.setDate(d.getDate() + n); return toLocalISO(d); };
  const todayIso = shift(0), weekAhead = shift(7), since = shift(-14);
  const live = tasks.filter((t) => !t.archivedAt);
  const rank = (t: Task) => {
    const due = t.dueDate?.slice(0, 10);
    if (due && due < todayIso) return 0;
    if (t.status === "blocked") return 1;
    if (due === todayIso) return 2;
    if (t.status === "progress" || t.status === "review") return 3;
    if (due && due <= weekAhead) return 4;
    return 5;
  };
  const open = live.filter((t) => t.status !== "done").sort((a, b) =>
    rank(a) - rank(b) || (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  const done = live.filter((t) => t.status === "done" && (t.completedAt ?? "").slice(0, 10) >= since)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  const openTake = Math.min(open.length, AI_TASK_CAP - Math.min(done.length, AI_DONE_SLOTS));
  const doneTake = Math.min(done.length, AI_TASK_CAP - openTake);
  return [...open.slice(0, openTake), ...done.slice(0, doneTake)].map((t) => ({
    id: t.id, title: t.title, status: t.status, priority: t.priority,
    dueDate: t.dueDate ?? null, completedAt: t.completedAt ?? null,
    assignee: getMember(t.assigneeId)?.name ?? null,
    project: getProject(t.projectId)?.name ?? null,
  }));
}

/** Create failed for some rows of an import; the rest were saved. */
export interface BatchCreateError extends Error { saved: Task[]; failed: { task: Task; message: string }[] }

/* ---------- offline replay scheduling ---------- */
type RemapFn = (clientId: string, serverId: string, saved: Task) => void;
let lastRemap: RemapFn | undefined;   // App's id-swap callback, reused by retries the store schedules itself
let flushInFlight: Promise<number> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushBackoff = 2000;
const MAX_ATTEMPTS = 5;
// a replay failing on something that may clear up (gateway 5xx, timeout,
// PostgREST restarting) keeps being retried — backing off to once a minute —
// and is only parked after this long, so a server hiccup never costs edits
const PARK_TRANSIENT_AFTER_MS = 30 * 60_000;
/** Drain the queue soon without waiting for an 'online' event — after a
 *  request dies mid-flight on flaky Wi-Fi, navigator.onLine never changes. */
function scheduleFlush(delay = flushBackoff) {
  if (!supabase || flushTimer !== undefined || typeof window === "undefined") return;
  flushTimer = setTimeout(() => { flushTimer = undefined; void store.flushQueue(); }, delay);
}
const opTaskId = (m: QueuedMutation) => (m.kind === "create" ? m.task.id : m.taskId);
const errText = (e: unknown) => String((e as Error)?.message ?? e);
/** An error the server will give again however often it's retried: bad data,
 *  a constraint, a permission (RLS) or trigger refusal, a malformed request.
 *  Anything else (5xx from the gateway, timeouts, JWT refresh, connection
 *  errors — or no code at all) may clear up by itself. */
function isPermanentError(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? "");
  return /^(22|23|42|P0)/.test(code) || /^PGRST[12]/.test(code);
}
/** Try the queue again later, backing off up to once a minute. */
function retryLater() {
  scheduleFlush(flushBackoff);
  flushBackoff = Math.min(flushBackoff * 2, 60_000);
}

async function replayQueue(client: SupabaseClient, remap?: RemapFn): Promise<number> {
  // never replay without a session, and only ever the signed-in user's own ops
  let uid: string | undefined;
  try { uid = (await client.auth.getSession()).data.session?.user?.id; } catch { /* token refresh failing */ }
  if (!uid) {
    // no session at the moment (a token refresh failing while the browser
    // still says it's online): try again later rather than leaving the queue
    // parked until an 'online' event that may never come
    if (offlineQueue.size() && !isOffline()) retryLater();
    return 0;
  }
  scopeQueueTo(uid);
  let synced = 0;
  const tried = new Set<string>();
  const blocked = new Set<string>(); // tasks whose earlier op failed this pass — later ops on them must wait
  // re-read every step: edits queued mid-replay (this tab or another) are
  // picked up in order, and nothing is replayed twice in one pass
  for (;;) {
    const m = offlineQueue.all().find((op) => !tried.has(op.id));
    if (!m) break;
    tried.add(m.id);
    if (m.userId !== uid) continue;
    const taskId = opTaskId(m);
    if (blocked.has(taskId)) continue;
    try {
      if (m.kind === "create") {
        // pin the row id before the first send, so a lost response is retried
        // under the same id (a no-op if it landed) instead of creating a twin
        const id = m.serverId ?? (isUuid(m.task.id) ? m.task.id : uuidv4());
        if (m.serverId !== id) offlineQueue.setServerId(m.id, id);
        const saved = await insertTaskRow(client, m.task, id, uid);
        // deleted while the request was in flight: its delete is already queued
        if (!offlineQueue.ack(m.id)) continue;
        if (saved.id !== m.task.id) offlineQueue.remapId(m.task.id, saved.id);
        remap?.(m.task.id, saved.id, saved);
      } else if (m.kind === "update") {
        await updateTaskRow(client, m.taskId, m.patch);
        offlineQueue.ack(m.id, m.patch);
      } else {
        await deleteTaskRow(client, m.taskId);
        offlineQueue.ack(m.id);
      }
      synced++;
    } catch (e) {
      if (isNetworkError(e)) break; // still offline — stop, keep the rest
      blocked.add(taskId);
      // edits collapsed into this update while it was in flight weren't part
      // of what failed: they move to their own op, right behind it
      if (m.kind === "update" && !offlineQueue.splitUnsent(m.id, m.patch)) continue;
      // Never discard a user's change on the first miss. The server refusing
      // the data itself (RLS, a constraint) won't change, so that's parked
      // after a few tries; anything that may clear up is retried for much
      // longer. Parked ops can be retried or discarded, never silently lost.
      const attempts = offlineQueue.bumpAttempts(m.id);
      const permanent = isPermanentError(e);
      const failingFor = Date.now() - (m.failedSince ?? Date.now());
      if (attempts >= MAX_ATTEMPTS && (permanent || failingFor >= PARK_TRANSIENT_AFTER_MS)) {
        offlineQueue.deadLetter(m.id, errText(e), !permanent);
        reportError(e, { op: "flushQueue-deadletter", kind: m.kind, attempts, permanent });
      } else if (attempts === 1) {
        reportError(e, { op: "flushQueue-retry", kind: m.kind, permanent });
      }
    }
  }
  if (offlineQueue.size() === 0) flushBackoff = 2000;
  else if (!isOffline()) retryLater(); // left-overs (a blip mid-replay, or an op being retried): go again soon
  return synced;
}

/* ---------- realtime ---------- */
/** What subscribeToChanges reports: a changed row, or a request to resync
 *  everything because live events may have been missed. */
export type RealtimeChange =
  | { kind: "row"; table: string; event: "INSERT" | "UPDATE" | "DELETE"; row: Record<string, unknown> | null; old: Record<string, unknown> | null }
  | { kind: "resync"; reason: "reconnected" | "online" | "visible" };
// in the supabase_realtime publication since 0005–0010
const CORE_TABLES = ["tasks", "projects", "tags", "subtasks", "workspaces", "workspace_members", "attachments", "activity"];
// team structure tables. Migration 0042 adds them to the publication; until
// it's live the server rejects every binding on a channel that names them, so
// they get their own channel and can never take live task sync down with them.
const EXTRA_TABLES = ["sections", "custom_field_defs", "goals", "portfolios", "status_updates", "automation_rules", "forms", "task_dependencies"];
const RESYNC_AFTER_HIDDEN_MS = 60_000;
let channelSeq = 0;

/* A channel whose topic must stay fixed (everyone viewing a task joins the
   same presence room) can't be reopened while the last one is still leaving:
   realtime-js hands back the leaving channel for that topic, which never
   re-joins, and drops every channel with that topic once it has closed. So a
   new subscription waits for its predecessor's removal to settle first. */
const leavingTopics = new Map<string, Promise<void>>();
function openFixedTopic(client: SupabaseClient, name: string, open: () => RealtimeChannel): () => void {
  let disposed = false;
  let channel: RealtimeChannel | null = null;
  const start = async () => {
    // one still registered under this topic (a leave that never settled)
    // would be handed back instead of a fresh channel: take it down first
    for (let i = 0; i < 3 && !disposed; i++) {
      const stale = client.getChannels().find((c) => c.topic === "realtime:" + name);
      if (!stale) break;
      await client.removeChannel(stale).catch(() => "error");
    }
    if (!disposed) channel = open();
  };
  const pending = leavingTopics.get(name);
  (pending ? pending.then(start) : start()).catch((e) => reportError(e, { op: "realtime-open", topic: name }));
  return () => {
    if (disposed) return;
    disposed = true;
    const ch = channel;
    channel = null;
    if (!ch) return;
    const gone: Promise<void> = client.removeChannel(ch).then(() => {}, () => {})
      .finally(() => { if (leavingTopics.get(name) === gone) leavingTopics.delete(name); });
    leavingTopics.set(name, gone);
  };
}

/* ============================================================
   Public store API
   ============================================================ */
export const store = {
  configured: isSupabaseConfigured,

  async bootstrap(user: AuthedUser | null): Promise<Bootstrap> {
    if (!supabase) {
      // demo mode — seeded in-memory data + rich reference set, fixed "self" user
      if (demoWorkspaces.length === 0) demoWorkspaces = WORKSPACES.map((w) => ({ ...w }));
      if (demoMembers.length === 0) {
        demoMembers = MEMBERS.filter((m) => m.type !== "external").map((m, i) => ({
          id: "wm-" + i, workspaceId: "ws-foundrise", userId: m.id, email: m.email, name: m.name,
          role: m.type === "self" ? "owner" as const : "member" as const, status: "active" as const,
        }));
      }
      return {
        tasks: TASKS.map(withPlanFields).map((t, i) => ({ ...t, position: i })), projects: [...PROJECTS], tags: { ...BUILTIN_TAGS },
        workspaces: demoWorkspaces, members: demoMembers,
        currentUserId: "m-self", defaultWorkspace: "ws-foundrise", profile: demoProfile,
        sections: [], customFields: [], savedSearches: [], goals: [], portfolios: [], statusUpdates: [], automationRules: [], forms: [],
      };
    }
    // resolve the REAL authenticated user from the live session — robust to a
    // stale "m-self" placeholder lingering in app/auth state.
    const { data: sessionData } = await supabase.auth.getSession();
    const sUser = sessionData.session?.user;
    const uid = sUser?.id ?? (user && user.id !== "m-self" ? user.id : undefined);
    if (!uid) throw new Error("Not authenticated");
    const gen = sessionGen;
    // only this user's queued offline edits are applied / replayed
    scopeQueueTo(uid);
    const restore = (snap: Snapshot): Bootstrap => {
      setReferenceData(snap.ref);
      return { ...snap.boot, tasks: applyQueue(snap.boot.tasks), defaultWorkspace: resolveDefaultWorkspace(uid, snap.boot.workspaces) };
    };

    // Offline reload: restore the cached snapshot instead of failing. The
    // session above is read from local storage, so it resolves offline too.
    if (isOffline()) {
      const snap = readSnapshot(uid);
      if (snap) return restore(snap);
    }

    // claim any pending workspace invites for this email — once per user per
    // session, not on every realtime reload (best-effort; a network failure
    // leaves it to be retried on the next load). Before the profile is read:
    // an account that existed before it was invited is only approved inside
    // claim_invites, and reading first would show it the waitlist.
    if (claimedFor !== uid) {
      claimedFor = uid;
      const { error: claimErr } = await supabase.rpc("claim_invites").then((r) => r, (e: unknown) => ({ error: e }));
      if (claimErr && isNetworkError(claimErr)) claimedFor = null;
    }

    // A query that fails here must not pass for "you have none": the part is
    // flagged in `partial` and filled from the last good snapshot (if any), so
    // a passing error can't wipe someone's projects or workspaces off screen.
    const partial: BootPartial = {};
    let priorSnap: Snapshot | null | undefined;
    const prior = () => (priorSnap === undefined ? (priorSnap = readSnapshot(uid)) : priorSnap); // read only if needed
    const failed = (part: keyof BootPartial, error: unknown) => {
      partial[part] = true;
      reportOnce("boot-partial-" + part, error, { op: "bootstrap", part });
      return prior()?.boot;
    };

    // this user's profile. Drives the display name / avatar / pronouns.
    let myProfile: Profile | null = null;
    try {
      const { data: pData, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
      if (error) myProfile = failed("profile", error)?.profile ?? null;
      else if (pData) myProfile = rowToProfile(pData as ProfileRow);
    } catch (e) { myProfile = failed("profile", e)?.profile ?? null; }

    // clean, minimal reference set (one Personal workspace + project, no demo
    // projects / teammates / calendar events).
    const profileName = myProfile ? fullName(myProfile) : "";
    const self: Member = {
      id: uid,
      name: profileName || (sUser?.user_metadata?.name as string) || sUser?.email || user?.name || user?.email || "You",
      email: sUser?.email || user?.email || "",
      type: "self",
      color: SELF_COLOR,
      pronouns: myProfile?.pronouns || undefined,
      avatarUrl: myProfile?.avatarUrl || null,
    };

    // tasks are required; everything else is best-effort so a missing table
    // (e.g. a migration not yet applied) can never break boot or leak demo data.
    // Visibility (own + shared-workspace rows) is enforced by RLS — no user filter.
    let taskRows: TaskRow[];
    try {
      taskRows = await loadAllTasks(supabase);
    } catch (e) {
      // connection dropped after we thought we were online — fall back to the
      // last good snapshot rather than wiping the screen.
      const snap = prior();
      if (snap && isNetworkError(e)) return restore(snap);
      throw e;
    }

    const { data: projData, error: projErr } = await supabase.from("projects").select("*");
    const projects = (projErr && failed("projects", projErr)?.projects)
      || [PERSONAL_PROJECT, ...((projData as ProjectRow[] | null) ?? []).map(rowToProject)];

    // real accounts start with NO built-in tags — every tag this user can see
    // (RLS decides: their own, plus their workspaces' once tags are shared).
    const { data: tagData, error: tagErr } = await supabase.from("tags").select("*");
    const tags: Record<string, TagDef> = { ...(tagErr && failed("tags", tagErr)?.tags) };
    for (const t of (tagData as TagRow[] | null) ?? []) tags[t.id] = { label: t.label, color: t.color };

    // workspaces + members. Oldest first, so the switcher order (and the
    // default team workspace) is stable across reloads and renames.
    const { data: wsData, error: wsErr } = await supabase.from("workspaces").select("*");
    const wsRows = ((wsData as WorkspaceRow[] | null) ?? []).slice()
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    const workspaces: Workspace[] = (wsErr && failed("workspaces", wsErr)?.workspaces) || [
      { ...PERSONAL_WORKSPACE },
      ...wsRows.map((w) => ({ id: w.id, name: w.name, kind: "team" as const, ownerId: w.owner_id, logoUrl: w.logo_url ?? undefined })),
    ];
    const { data: memData, error: memErr } = await supabase.from("workspace_members").select("*");
    const members = (memErr && failed("members", memErr)?.members)
      || ((memData as MemberRow[] | null) ?? []).map(rowToWsMember);

    // reference Member list for avatars/assignees: self + active teammates
    const teammates: Member[] = [];
    const seen = new Set<string>([uid]);
    members.forEach((m, i) => {
      if (m.status === "active" && m.userId && !seen.has(m.userId)) {
        seen.add(m.userId);
        teammates.push({ id: m.userId, name: m.name || m.email, email: m.email, type: "team", color: MEMBER_COLORS[i % MEMBER_COLORS.length] });
      }
    });

    // enrich teammates with their profiles (real name / avatar / pronouns) so
    // collaborators see people, not emails (best-effort).
    if (teammates.length) {
      try {
        const { data: profData } = await supabase.from("profiles").select("*").in("id", teammates.map((t) => t.id));
        const byId = new Map((((profData as ProfileRow[] | null) ?? []).map(rowToProfile)).map((p) => [p.id, p]));
        teammates.forEach((t) => {
          const p = byId.get(t.id);
          if (p) { const n = fullName(p); if (n) t.name = n; t.avatarUrl = p.avatarUrl; t.pronouns = p.pronouns || undefined; }
        });
      } catch { /* profiles table not present yet */ }
    }

    // Asana-parity tables (best-effort — tolerate migration 0019 not applied)
    let sections: Section[] = [], customFields: CustomFieldDef[] = [], savedSearches: SavedSearch[] = [];
    try {
      const { data: secData } = await supabase.from("sections").select("*");
      sections = ((secData as SectionRow[] | null) ?? []).map(rowToSection);
    } catch { /* table not present yet */ }
    try {
      const { data: cfData } = await supabase.from("custom_field_defs").select("*");
      customFields = ((cfData as CustomFieldRow[] | null) ?? []).map(rowToCustomField);
    } catch { /* table not present yet */ }
    try {
      const { data: ssData } = await supabase.from("saved_searches").select("*");
      savedSearches = ((ssData as SavedSearchRow[] | null) ?? []).map((s) => ({ id: s.id, name: s.name, query: (s.query as Record<string, unknown>) ?? {} }));
    } catch { /* table not present yet */ }
    let goals: Goal[] = [], portfolios: Portfolio[] = [], statusUpdates: StatusUpdate[] = [];
    // goals, portfolios, rules and forms in a stable server order, so lists
    // don't reshuffle between visits
    try {
      const { data: gData } = await supabase.from("goals").select("*").order("position", { ascending: true, nullsFirst: false }).order("created_at");
      goals = ((gData as GoalRow[] | null) ?? []).map(rowToGoal);
    } catch { /* table not present yet */ }
    try {
      const { data: pData2 } = await supabase.from("portfolios").select("*").order("created_at");
      portfolios = ((pData2 as PortfolioRow[] | null) ?? []).map(rowToPortfolio);
    } catch { /* table not present yet */ }
    try {
      const { data: suData } = await supabase.from("status_updates").select("*").order("created_at", { ascending: false });
      statusUpdates = ((suData as StatusUpdateRow[] | null) ?? []).map(rowToStatusUpdate);
    } catch { /* table not present yet */ }
    let automationRules: AutomationRule[] = [];
    try {
      const { data: arData } = await supabase.from("automation_rules").select("*").order("created_at");
      automationRules = ((arData as AutomationRuleRow[] | null) ?? []).map(rowToRule);
    } catch { /* table not present yet */ }
    let forms: FormDef[] = [];
    try {
      const { data: fmData } = await supabase.from("forms").select("*").order("created_at");
      forms = ((fmData as FormRow[] | null) ?? []).map(rowToForm);
    } catch { /* table not present yet */ }

    const ref: RefData = { members: [self, ...teammates], projects, workspaces, events: [], tags };
    setReferenceData(ref);
    const boot: Bootstrap = {
      tasks: taskRows.map(rowToTask),
      projects,
      tags,
      workspaces,
      members,
      currentUserId: uid,
      defaultWorkspace: resolveDefaultWorkspace(uid, workspaces),
      profile: myProfile,
      sections,
      customFields,
      savedSearches,
      goals,
      portfolios,
      statusUpdates,
      automationRules,
      forms,
      ...(Object.keys(partial).length ? { partial } : {}),
    };
    // signed out (or someone else signed in) while this was loading — e.g. a
    // realtime reload still in flight: don't write their workspace back to
    // this device, and don't fold anyone's queue onto it
    if (gen !== sessionGen || offlineQueue.currentUser() !== uid) return boot;
    // cache for offline reads (write-half handled by offlineQueue). A part
    // that failed already holds the last good copy, which is kept.
    const { partial: _partial, ...complete } = boot;
    cacheSnapshot({ boot: complete, ref, uid, savedAt: Date.now() });
    // changes parked last time for a passing server problem (not a refusal)
    // get another go once per session; App drains the queue after this load
    if (deadRetriedFor !== uid) {
      deadRetriedFor = uid;
      const retry = offlineQueue.deadLetters().filter((d) => d.retryable).map((d) => d.op.id);
      if (retry.length) offlineQueue.retryDeadLetters(retry);
    }
    // show edits still waiting in the queue rather than the server's older copy
    return offlineQueue.size() ? { ...boot, tasks: applyQueue(boot.tasks) } : boot;
  },

  /** Register the caller's id-swap callback once, at startup, so retries the
   *  store schedules itself (after a request died mid-flight) can also tell
   *  it when a queued create was saved under a new id. */
  setRemapHandler(onRemap: RemapFn | null): void { lastRemap = onRemap ?? undefined; },

  /** Replay the signed-in user's queued offline task mutations, in order,
   *  when back online. onRemap(clientId, serverId, saved) lets the caller swap
   *  the optimistic id in state — or INSERT the task if it isn't in state
   *  (e.g. after an online reopen where the offline-created task only ever
   *  lived in the queue). One tab replays at a time (navigator.locks), and
   *  creates are idempotent, so a queue can never be applied twice.
   *  Returns count synced. */
  async flushQueue(onRemap?: RemapFn): Promise<number> {
    if (onRemap) lastRemap = onRemap;
    if (!supabase || isOffline() || flushInFlight) return 0; // this tab is already replaying
    const client = supabase;
    const run = () => replayQueue(client, onRemap ?? lastRemap);
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    flushInFlight = locks?.request
      // another tab holds the lock → it's replaying the same queue; let it
      ? locks.request("kanbo-flush", { ifAvailable: true }, (lock) => (lock ? run() : Promise.resolve(0))).then((n) => n)
      : run();
    try { return await flushInFlight; }
    finally { flushInFlight = null; }
  },

  /* ---------- workspaces & membership ---------- */
  async createWorkspace(name: string, owner: { id: string; email: string; name: string }): Promise<Workspace> {
    if (!supabase) {
      const w: Workspace = { id: newId(), name, kind: "team", ownerId: owner.id };
      demoWorkspaces = [...demoWorkspaces, w];
      demoMembers = [...demoMembers, { id: newId(), workspaceId: w.id!, userId: owner.id, email: owner.email, name: owner.name, role: "owner", status: "active" }];
      return w;
    }
    const uid = await authUid(owner.id);
    const { data, error } = await supabase.from("workspaces").insert({ name, owner_id: uid }).select("*").single();
    if (error) throw error;
    const ws = data as WorkspaceRow;
    // owner is automatically an active member
    const { error: mErr } = await supabase.from("workspace_members")
      .insert({ workspace_id: ws.id, user_id: uid, email: owner.email, name: owner.name, role: "owner", status: "active" });
    if (mErr) throw mErr;
    return { id: ws.id, name: ws.name, kind: "team", ownerId: ws.owner_id, logoUrl: ws.logo_url ?? undefined };
  },

  // upload a workspace logo (reuses the public avatars bucket; uid-scoped path)
  async uploadWorkspaceLogo(workspaceId: string, file: File, userId: string): Promise<string> {
    if (!supabase) return URL.createObjectURL(file);
    const uid = await authUid(userId);
    const ext = (file.name.split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const path = `${uid}/wslogo-${workspaceId}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw error;
    return supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;
  },

  async updateWorkspace(workspaceId: string, name: string, logoUrl: string | null): Promise<void> {
    if (!supabase) { demoWorkspaces = demoWorkspaces.map((w) => w.id === workspaceId ? { ...w, name, logoUrl: logoUrl ?? undefined } : w); return; }
    const { error } = await supabase.rpc("update_workspace", { p_ws: workspaceId, p_name: name, p_logo: logoUrl });
    if (error) throw error;
  },

  async deleteWorkspace(workspaceId: string): Promise<void> {
    if (!supabase) { demoWorkspaces = demoWorkspaces.filter((w) => w.id !== workspaceId); return; }
    const { error } = await supabase.rpc("delete_workspace", { p_ws: workspaceId });
    if (error) throw error;
  },

  async inviteMember(workspaceId: string, email: string, role: Role = "member", name = ""): Promise<InvitedMember> {
    if (!supabase) {
      const m: WorkspaceMember = { id: newId(), workspaceId, userId: null, email, name, role, status: "invited" };
      demoMembers = [...demoMembers, m];
      return m;
    }
    // guarded server-side: only owner/admin can invite, only owner can add admins
    const { data, error } = await supabase.rpc("invite_member", { p_ws: workspaceId, p_email: email.trim().toLowerCase(), p_name: name, p_role: role });
    // a real Error carrying the server's reason ("already a member …"), so the
    // UI can show it rather than a generic failure
    if (error) throw new Error(inviteErrorMessage(error.message));
    if (!data) throw new Error("Couldn't create the invite. Please try again.");
    const member = rowToWsMember(data as MemberRow);
    // email the invitation. The invite already exists (it's claimed on the
    // invitee's next sign-in), so a failed email never fails the invite; the
    // caller is told (inviteEmailNotice words it), so it can offer the sign-up
    // link or a resend instead. Awaited so the invite and its email are
    // reported together: usually a second or two, capped by the timeout.
    return { ...member, inviteEmail: await store.sendInviteEmail(member.id) };
  },

  /** Email (or re-email) an invitation. Never throws: the result says whether
   *  it went and, if not, why. The server allows one email per invite a minute. */
  async sendInviteEmail(memberId: string): Promise<InviteEmailResult> {
    if (!supabase) return { sent: false, reason: "email_not_configured" };
    try {
      const { data, error } = await supabase.functions.invoke("invite-member", { body: { memberId }, timeout: INVITE_EMAIL_TIMEOUT_MS });
      if (!error) {
        const b = (data ?? {}) as { sent?: boolean; reason?: string; retryAfter?: number };
        if (b.sent) return { sent: true };
        const reason: InviteEmailReason = b.reason === "throttled" || b.reason === "email_not_configured" ? b.reason : "not_sent";
        return { sent: false, reason, ...(typeof b.retryAfter === "number" ? { retryAfter: b.retryAfter } : {}) };
      }
      const { status, body } = await fnErrorBody(error);
      const message = typeof body.error === "string" ? body.error : undefined;
      const retryAfter = typeof body.retryAfter === "number" ? body.retryAfter : undefined;
      if (status === 429 || body.reason === "inviter_limit") return { sent: false, reason: "inviter_limit", message, retryAfter };
      if (status === 409) return { sent: false, reason: "already_active", message };
      reportOnce("invite-email", error, { op: "sendInviteEmail", status });
      return { sent: false, reason: "not_sent", message };
    } catch (e) {
      reportOnce("invite-email", e, { op: "sendInviteEmail" });
      return { sent: false, reason: "not_sent" };
    }
  },

  async listWorkspaceMembers(): Promise<WorkspaceMember[]> {
    if (!supabase) return demoMembers;
    const { data, error } = await supabase.from("workspace_members").select("*");
    if (error) throw error;
    return ((data as MemberRow[] | null) ?? []).map(rowToWsMember);
  },

  async setMemberRole(memberId: string, role: Role): Promise<void> {
    if (!supabase) { demoMembers = demoMembers.map((m) => m.id === memberId ? { ...m, role } : m); return; }
    const { error } = await supabase.rpc("set_member_role", { p_member: memberId, p_role: role });
    if (error) throw error;
  },

  async setMemberTitle(memberId: string, title: string): Promise<void> {
    if (!supabase) { demoMembers = demoMembers.map((m) => m.id === memberId ? { ...m, title: title.trim() || undefined } : m); return; }
    const { error } = await supabase.rpc("set_member_title", { p_member: memberId, p_title: title });
    if (error) throw error;
  },

  async transferOwnership(workspaceId: string, memberId: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.rpc("transfer_ownership", { p_ws: workspaceId, p_member: memberId });
    if (error) throw error;
  },

  async removeMember(memberId: string): Promise<void> {
    if (!supabase) { demoMembers = demoMembers.filter((m) => m.id !== memberId); return; }
    const { error } = await supabase.rpc("remove_member", { p_member: memberId });
    if (error) throw error;
  },

  /** Create many tasks at once (CSV import), 200 rows per request. Every row
   *  is written under an explicit UUID with ON CONFLICT DO NOTHING, so a
   *  retried or partly-applied import never duplicates anything. Returns the
   *  saved tasks in input order (with their final ids; non-UUID ids are
   *  replaced and in-batch parentId links follow). If some rows are rejected,
   *  the rest are still saved and a BatchCreateError lists both. */
  async createTasksBatch(tasks: Task[], userId: string): Promise<Task[]> {
    if (!tasks.length) return [];
    if (!supabase) return tasks.slice();
    const client = supabase;
    const idMap = new Map<string, string>();
    for (const t of tasks) if (!isUuid(t.id) && !idMap.has(t.id)) idMap.set(t.id, uuidv4());
    const prepared = tasks.map((t) => {
      const id = idMap.get(t.id) ?? t.id;
      const parentId = t.parentId ? (idMap.get(t.parentId) ?? t.parentId) : t.parentId;
      return id === t.id && parentId === t.parentId ? t : { ...t, id, parentId };
    });
    // offline: queue before anything is awaited (see queueOwner)
    if (isOffline()) { offlineQueue.enqueueCreates(prepared, queueOwner() ?? await authUid(userId)); return prepared; }
    const uid = await authUid(userId);

    const saved: Task[] = [];
    const failed: { task: Task; message: string }[] = [];
    // connection lost part-way: queue what's left (a chunk that may have landed
    // replays as a no-op) and carry on as if saved, like a single create does
    const queueFrom = (pos: number) => {
      const rest = prepared.slice(pos);
      offlineQueue.enqueueCreates(rest, uid, true);
      scheduleFlush();
      saved.push(...rest);
    };
    let pos = 0;
    chunks: for (const part of chunk(prepared, 200)) {
      try {
        await upsertTaskRows(client, part.map((t) => ({ ...taskToInsertRow(t, uid), id: t.id })));
        saved.push(...part);
        pos += part.length;
        continue;
      } catch (e) {
        if (isNetworkError(e)) { queueFrom(pos); break; }
      }
      // one bad row fails the whole statement — go row by row to save the rest
      for (const t of part) {
        try { saved.push(await insertTaskRow(client, t, t.id, uid)); }
        catch (e) {
          if (isNetworkError(e)) { queueFrom(pos); break chunks; }
          failed.push({ task: t, message: errText(e) });
        }
        pos++;
      }
    }
    if (failed.length) {
      // the server's wording stays on err.failed[].message (and in monitoring);
      // the message itself is fit to show people
      reportError(new Error(failed[0].message), { op: "createTasksBatch", failed: failed.length, total: tasks.length });
      const err = new Error(`${failed.length} of ${tasks.length} task${tasks.length === 1 ? "" : "s"} couldn't be imported. Check they're in a project you can edit and try again.`) as BatchCreateError;
      err.saved = saved;
      err.failed = failed;
      throw err;
    }
    return saved;
  },

  async createTask(t: Task, userId: string): Promise<Task> {
    if (!supabase) return t; // demo mode keeps the optimistic copy
    // offline — or queued ops on this id still waiting (e.g. an undone
    // delete): queue behind them so they apply in order, and keep the client
    // id. Queued before anything is awaited (see queueOwner).
    if (isOffline() || offlineQueue.hasPending(t.id)) {
      offlineQueue.enqueueCreate(t, queueOwner() ?? await authUid(userId));
      if (!isOffline()) scheduleFlush();
      return t;
    }
    const uid = await authUid(userId);
    // the row id is fixed before sending, so a retry can never make a twin
    const id = isUuid(t.id) ? t.id : uuidv4();
    try {
      return await insertTaskRow(supabase, t, id, uid);
    } catch (e) {
      // dropped mid-flight — it may or may not have landed, so queue it under
      // the same id (the replay is a no-op if it did). That id is handed back
      // now, so the caller swaps it in at once and later edits queue behind
      // this create, rather than waiting on a replay callback to learn it.
      if (isNetworkError(e)) {
        const pinned = id === t.id ? t : { ...t, id };
        offlineQueue.enqueueCreate(pinned, queueOwner() ?? uid, id);
        scheduleFlush();
        return pinned;
      }
      throw e;
    }
  },

  async updateTask(id: string, patch: Partial<Task>): Promise<void> {
    if (!supabase) return;
    if (Object.keys(patchToRow(patch)).length === 0) return; // nothing that persists
    // offline — or older queued edits to this task still waiting: queue behind
    // them, so a stale queued value can't be replayed over this newer one
    // Queued before anything is awaited (see queueOwner).
    if (isOffline() || offlineQueue.hasPending(id)) {
      offlineQueue.enqueueUpdate(id, patch, queueOwner() ?? await authUid(""));
      if (!isOffline()) scheduleFlush();
      return;
    }
    try {
      await updateTaskRow(supabase, id, patch);
      offlineQueue.supersede(id, Object.keys(patch)); // a parked older value must never come back over this
    } catch (e) {
      if (isNetworkError(e)) { offlineQueue.enqueueUpdate(id, patch, queueOwner() ?? await authUid("")); scheduleFlush(); return; } // dropped mid-flight — queue it
      throw e;
    }
  },

  async deleteTask(id: string): Promise<void> {
    if (!supabase) return;
    if (isOffline() || offlineQueue.hasPending(id)) {
      offlineQueue.enqueueDelete(id, queueOwner() ?? await authUid(""));
      if (!isOffline()) scheduleFlush();
      return;
    }
    try {
      await deleteTaskRow(supabase, id);
      offlineQueue.supersede(id, null);
    } catch (e) {
      if (isNetworkError(e)) { offlineQueue.enqueueDelete(id, queueOwner() ?? await authUid("")); scheduleFlush(); return; }
      throw e;
    }
  },

  async createProject(input: NewProject, userId: string): Promise<Project> {
    if (!supabase) { const { templateId: _template, ...rest } = input; return { id: newId(), ...rest }; }
    const uid = await authUid(userId);
    // owner defaults to the creator; retry without owner_id if 0035 isn't applied yet
    let payload: Record<string, unknown> = { user_id: uid, owner_id: uid, name: input.name, emoji: input.emoji, color: input.color, workspace_id: input.workspaceId };
    for (let i = 0; i < 3; i++) {
      const { data, error } = await supabase.from("projects").insert(payload).select("*").single();
      if (!error) return rowToProject(data as ProjectRow);
      const stripped = withoutMissingColumn(payload, error.message);
      if (!stripped) throw error;
      payload = stripped;
    }
    throw new Error("createProject failed");
  },

  async setProjectArchived(id: string, archived: boolean): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("projects").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id);
    if (error && !/archived_at/.test(error.message)) throw error;  // ignore until 0039 is applied
  },

  async updateProject(id: string, patch: { name?: string; emoji?: string; color?: string; description?: string; status?: string; ownerId?: string | null; contributorIds?: string[] }): Promise<void> {
    if (!supabase) return;
    let row: Record<string, unknown> = {};
    if ("name" in patch && patch.name?.trim()) row.name = patch.name.trim();
    if ("emoji" in patch) row.emoji = patch.emoji;
    if ("color" in patch) row.color = patch.color;
    if ("description" in patch) row.description = patch.description ?? null;
    if ("status" in patch) row.status = patch.status ?? null;
    if ("ownerId" in patch) row.owner_id = patch.ownerId ?? null;
    if ("contributorIds" in patch) row.contributor_ids = patch.contributorIds ?? [];
    if (Object.keys(row).length === 0) return;
    // Resilient update: projects.description/status arrive in migration 0015. If
    // it isn't applied yet, strip the unknown column and retry so the rest of the
    // edit still saves instead of throwing.
    for (let i = 0; i < 4; i++) {
      const { error } = await supabase.from("projects").update(row).eq("id", id);
      if (!error) return;
      const stripped = withoutMissingColumn(row, error.message);
      if (!stripped) throw error;
      if (Object.keys(stripped).length === 0) return;
      row = stripped;
    }
  },

  /** Follow (true) or unfollow (false) a task as the signed-in user, through
   *  0042's toggle_task_follow (the only way guests can follow: 0041 rejects
   *  their task updates without an error). Returns the task's followers
   *  afterwards, or null in demo mode, offline, while older edits to the task
   *  are still queued, or before 0042 is run, so the caller falls back to a
   *  normal patch. Always pass true or false, never a toggle, so a screen that
   *  is out of date can't flip the person's choice. */
  async setTaskFollow(taskId: string, follow: boolean): Promise<string[] | null> {
    if (!supabase || isOffline() || offlineQueue.hasPending(taskId)) return null;
    const { data, error } = await supabase.rpc("toggle_task_follow", { p_task: taskId, p_follow: follow })
      .then((r) => r, (e: unknown) => ({ data: null, error: e }));
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "PGRST202" || code === "42883" || isNetworkError(error)) return null;
      throw error;
    }
    offlineQueue.supersede(taskId, ["followers"]); // a parked older list must never come back over this
    return Array.isArray(data) ? (data as string[]) : [];
  },

  // toggle the signed-in user's reaction (emoji) on a comment.
  // Goes through a SECURITY DEFINER RPC so any teammate who can see the comment
  // may add/remove *their own* reaction — without granting write access to
  // other people's comments (the comments UPDATE policy stays author-only).
  async toggleReaction(commentId: string, emoji: string, _userId: string): Promise<Record<string, string[]>> {
    if (!supabase) return {};
    const { data, error } = await supabase.rpc("toggle_comment_reaction", { p_comment: commentId, p_emoji: emoji });
    if (error) throw error;
    return (data as Record<string, string[]>) ?? {};
  },

  /** Throws unless the project row was actually deleted. RLS turns a delete
   *  you aren't allowed to make into a silent no-op (0 rows), and the caller
   *  only moves or deletes the project's tasks once this has succeeded. */
  async deleteProject(id: string): Promise<void> {
    if (!supabase) return;
    const { data, error } = await supabase.from("projects").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!((data as { id: string }[] | null) ?? []).length) {
      throw Object.assign(new Error("That project wasn't deleted. You may not have permission to delete it, or it has already gone."), { code: "not_deleted" });
    }
  },

  /* ---------- sections ---------- */
  async createSection(input: { projectId: string; workspaceId: string | null; name: string; position?: number }, userId: string): Promise<Section> {
    if (!supabase) return { id: newId(), projectId: input.projectId, workspaceId: input.workspaceId, name: input.name, position: input.position };
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("sections")
      .insert({ user_id: uid, workspace_id: input.workspaceId, project_id: input.projectId, name: input.name, position: input.position ?? null })
      .select("*").single();
    if (error) throw error;
    return rowToSection(data as SectionRow);
  },
  async updateSection(id: string, patch: { name?: string; position?: number }): Promise<void> {
    if (!supabase) return;
    const row: Record<string, unknown> = {};
    if ("name" in patch) row.name = patch.name;
    if ("position" in patch) row.position = patch.position;
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from("sections").update(row).eq("id", id);
    if (error) throw error;
  },
  async deleteSection(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("sections").delete().eq("id", id);
    if (error) throw error;
  },

  /* ---------- custom field definitions ---------- */
  async createCustomField(input: { projectId: string; workspaceId: string | null; name: string; type: CustomFieldDef["type"]; options?: string[]; position?: number }, userId: string): Promise<CustomFieldDef> {
    if (!supabase) return { id: newId(), projectId: input.projectId, workspaceId: input.workspaceId, name: input.name, type: input.type, options: input.options ?? [], position: input.position };
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("custom_field_defs")
      .insert({ user_id: uid, workspace_id: input.workspaceId, project_id: input.projectId, name: input.name, type: input.type, options: input.options ?? [], position: input.position ?? null })
      .select("*").single();
    if (error) throw error;
    return rowToCustomField(data as CustomFieldRow);
  },
  async updateCustomField(id: string, patch: { name?: string; options?: string[]; position?: number }): Promise<void> {
    if (!supabase) return;
    const row: Record<string, unknown> = {};
    if ("name" in patch) row.name = patch.name;
    if ("options" in patch) row.options = patch.options ?? [];
    if ("position" in patch) row.position = patch.position;
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from("custom_field_defs").update(row).eq("id", id);
    if (error) throw error;
  },
  async deleteCustomField(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("custom_field_defs").delete().eq("id", id);
    if (error) throw error;
  },

  /* ---------- saved searches ---------- */
  async createSavedSearch(name: string, query: Record<string, unknown>, userId: string): Promise<SavedSearch> {
    if (!supabase) return { id: newId(), name, query };
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("saved_searches").insert({ user_id: uid, name, query }).select("*").single();
    if (error) throw error;
    const s = data as SavedSearchRow;
    return { id: s.id, name: s.name, query: (s.query as Record<string, unknown>) ?? {} };
  },
  async deleteSavedSearch(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("saved_searches").delete().eq("id", id);
    if (error) throw error;
  },

  /* ---------- goals / OKRs ---------- */
  async createGoal(input: { workspaceId: string | null; name: string; target?: number; current?: number; unit?: string; due?: string; status?: GoalStatus }, userId: string): Promise<Goal> {
    if (!supabase) return { id: newId(), workspaceId: input.workspaceId, name: input.name, target: input.target, current: input.current, unit: input.unit, due: input.due, status: input.status ?? "on_track" };
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("goals").insert({ user_id: uid, workspace_id: input.workspaceId, name: input.name, target: input.target ?? null, current: input.current ?? null, unit: input.unit ?? null, due: input.due ?? null, status: input.status ?? "on_track" }).select("*").single();
    if (error) throw error;
    return rowToGoal(data as GoalRow);
  },
  async updateGoal(id: string, patch: Partial<Pick<Goal, "name" | "target" | "current" | "unit" | "due" | "status" | "parentId" | "projectId">>): Promise<void> {
    if (!supabase) return;
    const row: Record<string, unknown> = {};
    if ("name" in patch) row.name = patch.name;
    if ("target" in patch) row.target = patch.target ?? null;
    if ("current" in patch) row.current = patch.current ?? null;
    if ("unit" in patch) row.unit = patch.unit ?? null;
    if ("due" in patch) row.due = patch.due ?? null;
    if ("status" in patch) row.status = patch.status;
    if ("parentId" in patch) row.parent_id = patch.parentId ?? null;
    if ("projectId" in patch) row.project_id = patch.projectId ?? null;
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from("goals").update(row).eq("id", id);
    if (error) throw error;
  },
  async deleteGoal(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("goals").delete().eq("id", id);
    if (error) throw error;
  },

  /* ---------- portfolios ---------- */
  async createPortfolio(input: { workspaceId: string | null; name: string; projectIds?: string[] }, userId: string): Promise<Portfolio> {
    if (!supabase) return { id: newId(), workspaceId: input.workspaceId, name: input.name, projectIds: input.projectIds ?? [] };
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("portfolios").insert({ user_id: uid, workspace_id: input.workspaceId, name: input.name, project_ids: input.projectIds ?? [] }).select("*").single();
    if (error) throw error;
    return rowToPortfolio(data as PortfolioRow);
  },
  async updatePortfolio(id: string, patch: { name?: string; projectIds?: string[] }): Promise<void> {
    if (!supabase) return;
    const row: Record<string, unknown> = {};
    if ("name" in patch) row.name = patch.name;
    if ("projectIds" in patch) row.project_ids = patch.projectIds ?? [];
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from("portfolios").update(row).eq("id", id);
    if (error) throw error;
  },
  async deletePortfolio(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("portfolios").delete().eq("id", id);
    if (error) throw error;
  },

  /* ---------- project status updates ---------- */
  async createStatusUpdate(input: { workspaceId: string | null; projectId: string; summary: string; status: StatusKind }, userId: string): Promise<StatusUpdate> {
    if (!supabase) return { id: newId(), workspaceId: input.workspaceId, projectId: input.projectId, summary: input.summary, status: input.status, createdAt: new Date().toISOString() };
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("status_updates").insert({ user_id: uid, workspace_id: input.workspaceId, project_id: input.projectId, summary: input.summary, status: input.status }).select("*").single();
    if (error) throw error;
    return rowToStatusUpdate(data as StatusUpdateRow);
  },

  /* ---------- automation rules ---------- */
  async createRule(input: { workspaceId: string | null; projectId: string; name: string; actions: AutomationAction[]; trigger?: AutomationRule["trigger"] }, userId: string): Promise<AutomationRule> {
    const trigger = input.trigger ?? "task_created";
    if (!supabase) return { id: newId(), workspaceId: input.workspaceId, projectId: input.projectId, name: input.name, trigger, actions: input.actions, enabled: true };
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("automation_rules").insert({ user_id: uid, workspace_id: input.workspaceId, project_id: input.projectId, name: input.name, trigger, actions: input.actions, enabled: true }).select("*").single();
    if (error) throw error;
    return rowToRule(data as AutomationRuleRow);
  },
  async updateRule(id: string, patch: { name?: string; actions?: AutomationAction[]; enabled?: boolean; trigger?: AutomationRule["trigger"] }): Promise<void> {
    if (!supabase) return;
    const row: Record<string, unknown> = {};
    if ("name" in patch) row.name = patch.name;
    if ("actions" in patch) row.actions = patch.actions;
    if ("enabled" in patch) row.enabled = patch.enabled;
    if ("trigger" in patch) row.trigger = patch.trigger;
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from("automation_rules").update(row).eq("id", id);
    if (error) throw error;
  },
  async deleteRule(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("automation_rules").delete().eq("id", id);
    if (error) throw error;
  },

  /* ---------- intake forms ---------- */
  async createForm(input: { workspaceId: string | null; projectId: string; name: string; fields: FormFieldKey[] }, userId: string): Promise<FormDef> {
    if (!supabase) return { id: newId(), workspaceId: input.workspaceId, projectId: input.projectId, name: input.name, fields: input.fields };
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("forms").insert({ user_id: uid, workspace_id: input.workspaceId, project_id: input.projectId, name: input.name, fields: input.fields }).select("*").single();
    if (error) throw error;
    return rowToForm(data as FormRow);
  },
  async updateForm(id: string, patch: { name?: string; description?: string; fields?: FormFieldKey[] }): Promise<void> {
    if (!supabase) return;
    const row: Record<string, unknown> = {};
    if ("name" in patch) row.name = patch.name;
    if ("description" in patch) row.description = patch.description ?? null;
    if ("fields" in patch) row.fields = patch.fields;
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from("forms").update(row).eq("id", id);
    if (error) throw error;
  },
  async deleteForm(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("forms").delete().eq("id", id);
    if (error) throw error;
  },

  /** Every attachment across a set of tasks (the Files view), newest first.
   *  Queried in batches (ids travel in the URL) and signed in one request.
   *  Throws if the list can't be loaded, so the view can say so rather than
   *  showing "No files yet". */
  async listProjectAttachments(taskIds: string[]): Promise<Attachment[]> {
    if (!supabase) {
      const want = new Set(taskIds);
      return Object.values(demoAttachments).flat().filter((a) => want.has(a.taskId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    const client = supabase;
    // unsaved (optimistic) task ids aren't uuids and would fail the whole query
    const ids = [...new Set(taskIds.filter(isUuid))];
    if (ids.length === 0) return [];
    const pages = await Promise.all(chunk(ids, IN_CHUNK).map(async (part) => {
      const { data, error } = await client.from("attachments").select("*").in("task_id", part);
      if (error) throw error;
      return (data as AttachmentRow[] | null) ?? [];
    }));
    const rows = pages.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (rows.length === 0) return [];
    // one signing round-trip for the whole view (best-effort: a file without a
    // link still lists, it just can't be opened until the next load)
    const urls = new Map<string, string>();
    try {
      const { data: signed, error } = await client.storage.from(ATTACH_BUCKET).createSignedUrls(rows.map((r) => r.path), 3600);
      if (error) reportError(error, { op: "listProjectAttachments-sign", count: rows.length });
      for (const s of signed ?? []) if (s.path && s.signedUrl && !s.error) urls.set(s.path, s.signedUrl);
    } catch (e) { reportError(e, { op: "listProjectAttachments-sign", count: rows.length }); }
    return rows.map((r) => rowToAttachment(r, urls.get(r.path)));
  },

  /** Create a tag. Pass workspaceId to share it with that team workspace
   *  (needs tags.workspace_id — until that migration is live the tag is
   *  saved as personal instead of failing). */
  async createTag(label: string, color: string, userId: string, workspaceId?: string | null): Promise<CreatedTag> {
    if (!supabase) return { id: newId(), label, color };
    const uid = await authUid(userId);
    let row: Record<string, unknown> = { user_id: uid, label, color };
    if (workspaceId) row.workspace_id = workspaceId;
    for (let i = 0; i < 3; i++) {
      const { data, error } = await supabase.from("tags").insert(row).select("*").single();
      if (!error) { const t = data as TagRow; return { id: t.id, label: t.label, color: t.color }; }
      const stripped = withoutMissingColumn(row, error.message);
      if (!stripped) throw error;
      row = stripped;
    }
    throw new Error("createTag failed");
  },

  async deleteTag(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("tags").delete().eq("id", id);
    if (error) throw error;
  },

  async updateTag(id: string, patch: { label?: string; color?: string }): Promise<void> {
    if (!supabase) return;
    const row: Record<string, unknown> = {};
    if (patch.label != null) row.label = patch.label;
    if (patch.color != null) row.color = patch.color;
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from("tags").update(row).eq("id", id);
    if (error) throw error;
  },

  /* ---------- comments ---------- */
  async listComments(taskId: string): Promise<Comment[]> {
    if (!supabase) return demoComments[taskId] ?? [];
    const { data, error } = await supabase.from("comments").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
    if (error) throw error;
    return (data as CommentRow[]).map(rowToComment);
  },

  async addComment(taskId: string, body: string, userId: string, authorName: string, mentions: string[] = [], parentId?: string): Promise<Comment> {
    if (!supabase) {
      const c: Comment = { id: newId(), taskId, authorId: userId, authorName, body, createdAt: new Date().toISOString(), mentions, parentId };
      (demoComments[taskId] ??= []).push(c);
      return c;
    }
    const uid = await authUid(userId);
    const insert: Record<string, unknown> = { task_id: taskId, user_id: uid, author_name: authorName, body, mentions };
    if (parentId) insert.parent_id = parentId;
    // resilient insert: if parent_id column isn't migrated yet, retry without it
    let { data, error } = await supabase.from("comments").insert(insert).select("*").single();
    if (error && parentId && /parent_id/.test(error.message)) {
      delete insert.parent_id;
      ({ data, error } = await supabase.from("comments").insert(insert).select("*").single());
    }
    if (error) throw error;
    return rowToComment(data as CommentRow);
  },
  // per-task change history (status/assignee/due/priority). [] if not installed.
  async listTaskEvents(taskId: string): Promise<TaskEvent[]> {
    if (!supabase) return [];
    try {
      const { data, error } = await supabase.from("task_events").select("*").eq("task_id", taskId).order("created_at", { ascending: false }).limit(80);
      if (error || !data) return [];
      return (data as { id: string; actor_name: string | null; field: string; old_value: string | null; new_value: string | null; created_at: string }[])
        .map((r) => ({ id: r.id, actorName: r.actor_name || "Someone", field: r.field, oldValue: r.old_value, newValue: r.new_value, createdAt: r.created_at }));
    } catch { return []; }
  },

  // edit/delete your own comment (RLS enforces author-only).
  async updateComment(id: string, body: string): Promise<void> {
    if (!supabase) { for (const k in demoComments) demoComments[k] = demoComments[k].map((c) => c.id === id ? { ...c, body } : c); return; }
    const { error } = await supabase.from("comments").update({ body }).eq("id", id);
    if (error) throw error;
  },
  async deleteComment(id: string): Promise<void> {
    if (!supabase) { for (const k in demoComments) demoComments[k] = demoComments[k].filter((c) => c.id !== id); return; }
    const { error } = await supabase.from("comments").delete().eq("id", id);
    if (error) throw error;
  },

  /* ---------- attachments ---------- */
  async listAttachments(taskId: string): Promise<Attachment[]> {
    if (!supabase) return demoAttachments[taskId] ?? [];
    const { data, error } = await supabase.from("attachments").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
    if (error) throw error;
    const rows = data as AttachmentRow[];
    // sign each path for download (best-effort)
    // sign each independently — one bad/missing object can't break the whole list
    const signed = await Promise.all(rows.map(async (r) => {
      try {
        const { data: s } = await supabase!.storage.from(ATTACH_BUCKET).createSignedUrl(r.path, 3600);
        return rowToAttachment(r, s?.signedUrl);
      } catch { return rowToAttachment(r, undefined); }
    }));
    return signed;
  },

  async uploadAttachment(taskId: string, file: File, userId: string): Promise<Attachment> {
    if (!supabase) {
      const a: Attachment = { id: newId(), taskId, name: file.name, size: file.size, mime: file.type, path: "demo", url: URL.createObjectURL(file), createdAt: new Date().toISOString(), userId };
      (demoAttachments[taskId] ??= []).push(a);
      return a;
    }
    const uid = await authUid(userId);
    const safe = file.name.replace(/[^\w.\-]+/g, "_");
    const path = `${uid}/${taskId}/${newId()}_${safe}`;
    const { error: upErr } = await supabase.storage.from(ATTACH_BUCKET).upload(path, file, { contentType: file.type || "application/octet-stream" });
    if (upErr) throw upErr;
    const { data, error } = await supabase.from("attachments")
      .insert({ task_id: taskId, user_id: uid, name: file.name, size: file.size, mime: file.type, path })
      .select("*").single();
    if (error) throw error;
    const { data: s } = await supabase.storage.from(ATTACH_BUCKET).createSignedUrl(path, 3600);
    return rowToAttachment(data as AttachmentRow, s?.signedUrl);
  },

  async deleteAttachment(att: Attachment): Promise<void> {
    if (!supabase) {
      const list = demoAttachments[att.taskId];
      if (list) demoAttachments[att.taskId] = list.filter((a) => a.id !== att.id);
      return;
    }
    await supabase.storage.from(ATTACH_BUCKET).remove([att.path]).then(() => {}, () => {});
    const { error } = await supabase.from("attachments").delete().eq("id", att.id);
    if (error) throw error;
  },

  /* ---------- billing / subscription ---------- */
  async getSubscription(): Promise<Subscription> {
    if (!supabase) {
      // demo: a trial with a few days left so the UI is testable
      const ends = new Date(); ends.setDate(ends.getDate() + 3);
      return { plan: null, status: "trialing", trialEndsAt: ends.toISOString(), seats: 1 };
    }
    const { data, error } = await supabase.rpc("ensure_subscription");
    if (error || !data) {
      // migration not applied yet → treat as a fresh trial, don't block the app
      const ends = new Date(); ends.setDate(ends.getDate() + 7);
      return { plan: null, status: "trialing", trialEndsAt: ends.toISOString(), seats: 1 };
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      plan: (row.plan ?? null) as Plan | null,
      status: (row.status ?? "trialing") as SubStatus,
      trialEndsAt: row.trial_ends_at,
      currentPeriodEnd: row.current_period_end ?? null,
      seats: row.seats ?? 1,
    };
  },

  async startCheckout(plan: Plan, seats: number): Promise<string | null> {
    if (!supabase) return null; // demo: no real checkout
    const { data, error } = await supabase.functions.invoke("create-checkout", {
      body: { plan, seats, returnUrl: window.location.origin },
    });
    if (error || !data?.url) throw error || new Error("Checkout unavailable. Deploy the create-checkout function.");
    return data.url as string;
  },

  async openBillingPortal(): Promise<string | null> {
    if (!supabase) return null;
    const { data, error } = await supabase.functions.invoke("customer-portal", { body: { returnUrl: window.location.origin } });
    if (error || !data?.url) throw error || new Error("Billing portal unavailable.");
    return data.url as string;
  },

  /* ---------- session tracking (dwell time) — all best-effort ---------- */
  async recordSession(userId: string): Promise<string | null> {
    if (!supabase) return null;
    try {
      const uid = await authUid(userId);
      const { data, error } = await supabase.from("sessions").insert({ user_id: uid }).select("id").single();
      if (error) return null;
      return (data as { id: string }).id;
    } catch { return null; }
  },
  async touchSession(id: string): Promise<void> {
    if (!supabase) return;
    try { await supabase.from("sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", id); } catch { /* ignore */ }
  },

  /* ---------- admin metrics (hidden /admin dashboard) ---------- */
  // Every signed-in user can read profiles (RLS policy), so this gives a real
  // ---------- early-access requests ----------
  async createAccessRequest(name: string, email: string, note?: string): Promise<void> {
    if (!supabase) return;
    // Prefer the edge function (records the request AND emails the admin). Fall
    // back to a direct insert if it isn't deployed (request still recorded).
    try {
      const { error } = await supabase.functions.invoke("request-access", { body: { name, email, note: note || null } });
      if (!error) return;
    } catch { /* not deployed — fall back */ }
    const { error } = await supabase.from("access_requests").insert({ name, email, note: note || null });
    if (error) throw error;
  },
  async listAccessRequests(): Promise<AccessRequest[]> {
    if (!supabase) return [];
    const { data, error } = await supabase.from("access_requests").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    type R = { id: string; name: string | null; email: string; note: string | null; status: string; created_at: string };
    return ((data as R[] | null) ?? []).map((r) => ({ id: r.id, name: r.name || "", email: r.email, note: r.note || undefined, status: (r.status as AccessRequest["status"]) || "pending", createdAt: r.created_at }));
  },
  // Prefer the edge function (approves AND emails the person). If it isn't
  // deployed yet, fall back to the SQL RPC so approval still works (no email).
  // Returns true if a confirmation email was sent.
  async approveAccessRequest(id: string): Promise<boolean> {
    if (!supabase) return false;
    try {
      const { data, error } = await supabase.functions.invoke("approve-access", { body: { id } });
      if (!error && data) return !!(data as { emailed?: boolean }).emailed;
    } catch { /* function not deployed — fall back below */ }
    const { error } = await supabase.rpc("approve_access_request", { p_id: id });
    if (error) throw error;
    return false;
  },
  // Returns true if a decline email was sent. Edge function first, RPC-less
  // direct update as fallback.
  async declineAccessRequest(id: string): Promise<boolean> {
    if (!supabase) return false;
    try {
      const { data, error } = await supabase.functions.invoke("approve-access", { body: { id, action: "decline" } });
      if (!error && data) return !!(data as { emailed?: boolean }).emailed;
    } catch { /* not deployed — fall back */ }
    const { error } = await supabase.from("access_requests").update({ status: "declined" }).eq("id", id);
    if (error) throw error;
    return false;
  },

  // account list/count with no extra setup.
  async adminProfiles(): Promise<AdminAccount[]> {
    if (!supabase) {
      return MEMBERS.filter((m) => m.type !== "external").map((m) => ({ id: m.id, name: m.name, email: m.email, createdAt: new Date(Date.now() - 12 * 86400000).toISOString(), updatedAt: new Date().toISOString() }));
    }
    const { data, error } = await supabase.from("profiles").select("id, first_name, last_name, email, updated_at").order("updated_at", { ascending: false });
    if (error) throw error;
    type PRow = { id: string; first_name: string | null; last_name: string | null; email: string | null; updated_at: string | null };
    return ((data as PRow[] | null) ?? []).map((p) => ({ id: p.id, name: fullName({ firstName: p.first_name || "", lastName: p.last_name || "" }) || p.email || "Unnamed", email: p.email || "", createdAt: "", updatedAt: p.updated_at || "" }));
  },
  // Full account list from auth.users via a SECURITY DEFINER RPC (so it matches
  // the user count and has real signup/last-active dates). null if not installed.
  async adminAccounts(): Promise<AdminAccount[] | null> {
    if (!supabase) return null;
    try {
      const { data, error } = await supabase.rpc("admin_accounts");
      if (error || !data) return null;
      return (data as { id: string; email: string; name: string; created_at: string; last_sign_in_at: string; approved?: boolean; is_admin?: boolean; suspended?: boolean }[])
        .map((u) => ({ id: u.id, name: u.name || u.email || "Unnamed", email: u.email || "", createdAt: u.created_at || "", updatedAt: u.last_sign_in_at || u.created_at || "", approved: u.approved ?? true, isAdmin: u.is_admin ?? false, suspended: u.suspended ?? false }));
    } catch { return null; }
  },

  // Billing aggregate for the admin dashboard (SECURITY DEFINER; admins only).
  async adminBilling(): Promise<AdminBilling | null> {
    if (!supabase) return { trialing: 2, active: 3, past_due: 0, canceled: 1, plan_personal: 2, plan_team: 1, seats_active: 5, mrr_cents: 6400, trials_ending: [] };
    try {
      const { data, error } = await supabase.rpc("admin_billing");
      if (error || !data) return null;
      return data as AdminBilling;
    } catch { return null; }
  },

  // True if the signed-in user is an admin (founding email OR profiles.is_admin).
  async amIAdmin(): Promise<boolean> {
    if (!supabase) return true;
    try { const { data, error } = await supabase.rpc("is_admin"); return !error && !!data; } catch { return false; }
  },

  // Per-user detail for the admin drawer (SECURITY DEFINER; admins only).
  async adminAccountDetail(userId: string): Promise<AdminAccountDetail | null> {
    if (!supabase) return null;
    try {
      const { data, error } = await supabase.rpc("admin_account_detail", { p_user: userId });
      if (error || !data) return null;
      const d = data as Record<string, unknown>;
      return {
        id: String(d.id), name: (d.name as string) || "", email: (d.email as string) || "",
        createdAt: (d.created_at as string) || "", lastSignInAt: (d.last_sign_in_at as string) || "",
        approved: !!d.approved, isAdmin: !!d.is_admin, suspended: !!d.suspended,
        workspacesOwned: Number(d.workspaces_owned) || 0, workspacesMember: Number(d.workspaces_member) || 0,
        tasksTotal: Number(d.tasks_total) || 0, tasksDone: Number(d.tasks_done) || 0,
        plan: (d.plan as string) || null, subStatus: (d.sub_status as string) || null,
      };
    } catch { return null; }
  },

  // Admin account mutations — all guarded server-side by is_admin().
  // company email domains whose sign-ups are auto-approved (0041)
  async listApprovedDomains(): Promise<{ domain: string; createdAt: string }[]> {
    if (!supabase) return [];
    const { data, error } = await supabase.from("approved_domains").select("domain, created_at").order("domain");
    if (error) throw error;
    return ((data as { domain: string; created_at: string }[] | null) ?? []).map((r) => ({ domain: r.domain, createdAt: r.created_at }));
  },
  async addApprovedDomain(domain: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("approved_domains").insert({ domain });
    if (error && error.code !== "23505") throw error; // already on the list is fine
  },
  async removeApprovedDomain(domain: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("approved_domains").delete().eq("domain", domain);
    if (error) throw error;
  },
  async adminSetApproved(userId: string, approved: boolean): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.rpc("admin_set_approved", { p_user: userId, p_approved: approved });
    if (error) throw error;
  },
  async adminSetAdmin(userId: string, isAdmin: boolean): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.rpc("admin_set_admin", { p_user: userId, p_is_admin: isAdmin });
    if (error) throw error;
  },
  async adminSetSuspended(userId: string, suspended: boolean): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.rpc("admin_set_suspended", { p_user: userId, p_suspended: suspended });
    if (error) throw error;
  },
  async adminDeleteUser(userId: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.rpc("admin_delete_user", { p_user: userId });
    if (error) throw error;
  },
  async adminExtendTrial(userId: string, months: number): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.rpc("admin_extend_trial", { p_user: userId, p_months: months });
    if (error) throw error;
  },
  async adminExtendAllTrials(months: number): Promise<number> {
    if (!supabase) return 0;
    const { data, error } = await supabase.rpc("admin_extend_all_trials", { p_months: months });
    if (error) throw error;
    return Number(data) || 0;
  },

  // Richer cross-user aggregates via a SECURITY DEFINER RPC (optional — returns
  // null if the admin_stats() function hasn't been installed yet).
  async adminStats(): Promise<Record<string, number> | null> {
    if (!supabase) return { total_users: 4, new_signups_30d: 1, active_users_30d: 3, total_tasks: 12, completed_tasks: 5, actions_30d: 34, dau: 2, wau: 3, sessions_30d: 27, avg_session_sec: 372, mrr_cents: 0 };
    try {
      const { data, error } = await supabase.rpc("admin_stats");
      if (error || !data) return null;
      return data as Record<string, number>;
    } catch { return null; }
  },

  // Daily time-series (last 30d) + status/priority breakdowns for the admin
  // charts. SECURITY DEFINER RPC; returns null until admin_series() is installed.
  async adminSeries(): Promise<AdminSeries | null> {
    if (!supabase) {
      const days: AdminDay[] = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10);
        const w = Math.sin(i / 3) + 1.4;
        return { d, signups: i % 9 === 0 ? 1 : 0, sessions: Math.round(w * 3 + (i % 5)), active: Math.round(w * 2), tasks: Math.round(w * 2 + (i % 4)), actions: Math.round(w * 6 + (i % 7)) };
      });
      return { days, by_status: { todo: 5, progress: 3, review: 1, blocked: 1, done: 6 }, by_priority: { low: 4, medium: 7, high: 3, urgent: 2 } };
    }
    try {
      const { data, error } = await supabase.rpc("admin_series");
      if (error || !data) return null;
      return data as AdminSeries;
    } catch { return null; }
  },

  // N-day series for the chart's date-range selector. Falls back to the 30d
  // admin_series() if the ranged RPC isn't installed yet.
  async adminSeriesRange(days: number): Promise<AdminSeries | null> {
    if (!supabase) {
      const out: AdminDay[] = Array.from({ length: days }, (_, i) => {
        const d = new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
        const w = Math.sin(i / 3) + 1.4;
        return { d, signups: i % 9 === 0 ? 1 : 0, sessions: Math.round(w * 3 + (i % 5)), active: Math.round(w * 2), tasks: Math.round(w * 2 + (i % 4)), actions: Math.round(w * 6 + (i % 7)) };
      });
      return { days: out, by_status: { todo: 5, progress: 3, review: 1, blocked: 1, done: 6 }, by_priority: { low: 4, medium: 7, high: 3, urgent: 2 } };
    }
    try {
      const { data, error } = await supabase.rpc("admin_series_range", { p_days: days });
      if (error || !data) return store.adminSeries();
      return data as AdminSeries;
    } catch { return store.adminSeries(); }
  },

  // All workspaces with owner/member/task counts (admins only).
  async adminWorkspaces(): Promise<AdminWorkspace[] | null> {
    if (!supabase) return null;
    try {
      const { data, error } = await supabase.rpc("admin_workspaces");
      if (error || !data) return null;
      return data as AdminWorkspace[];
    } catch { return null; }
  },
  async adminCloseWorkspace(workspaceId: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.rpc("admin_close_workspace", { p_ws: workspaceId });
    if (error) throw error;
  },

  // Audit trail — list + append (best-effort; admins only).
  async adminAuditList(): Promise<AdminAuditEntry[] | null> {
    if (!supabase) return null;
    try {
      const { data, error } = await supabase.rpc("admin_audit_list");
      if (error || !data) return null;
      return data as AdminAuditEntry[];
    } catch { return null; }
  },
  async adminLog(action: string, target: string, detail: string): Promise<void> {
    if (!supabase) return;
    try { await supabase.rpc("admin_log", { p_action: action, p_target: target, p_detail: detail }); } catch { /* non-fatal */ }
  },

  // Broadcast banner — admin set/clear + everyone reads the active one.
  async activeBanner(): Promise<AppBanner | null> {
    if (!supabase) return null;
    try {
      const { data, error } = await supabase.from("banners").select("id, message, kind").eq("active", true).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error || !data) return null;
      return data as AppBanner;
    } catch { return null; }
  },
  async adminSetBanner(message: string, kind: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.rpc("admin_set_banner", { p_message: message, p_kind: kind });
    if (error) throw error;
  },
  async adminClearBanner(): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.rpc("admin_clear_banner");
    if (error) throw error;
  },

  // Conversion funnel (signup → approved → activated → active). null if not installed.
  async adminFunnel(): Promise<AdminFunnel | null> {
    if (!supabase) return { signups: 42, approved: 38, activated: 29, active_30d: 21 };
    try {
      const { data, error } = await supabase.rpc("admin_funnel");
      if (error || !data) return null;
      return data as AdminFunnel;
    } catch { return null; }
  },

  /* ---------- AI prioritization (real LLM with heuristic fallback) ---------- */
  async aiPrioritize(tasks: Task[], today: string): Promise<{ items: { id: string; score: number; reason: string }[]; summary: string; source: "ai" | "heuristic" }> {
    const heuristic = () => {
      const open = tasks.filter((t) => t.status !== "done");
      const items = [...open].sort((a, b) => b.aiScore - a.aiScore).map((t) => ({ id: t.id, score: t.aiScore, reason: t.aiReason || "Ranked by Kanbo's priority model." }));
      return { items, summary: "Prioritised your open work — urgent and unblocking tasks first.", source: "heuristic" as const };
    };
    aiNoticeText = null;
    if (!supabase) return heuristic();
    try {
      const payload = tasks.filter((t) => t.status !== "done").map((t) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate ?? null, tags: t.tags, focusMin: t.focusMin,
        blockedBy: t.dependencies,
      }));
      const { data, error } = await supabase.functions.invoke("ai-assist", { body: { tasks: payload, today } });
      if (error) await noteAiRefusal(error);
      if (error || !data || !Array.isArray(data.items)) return heuristic();
      return { items: data.items, summary: data.summary || "Here's how I'd approach your day.", source: "ai" };
    } catch {
      return heuristic();
    }
  },

  // AI: break a task into concrete subtasks. Returns [] if AI is unavailable.
  async aiBreakdown(title: string, description: string): Promise<string[]> {
    aiNoticeText = null;
    if (!supabase) return [];
    try {
      const { data, error } = await supabase.functions.invoke("ai-assist", { body: { mode: "breakdown", title, description } });
      if (error) await noteAiRefusal(error);
      if (error || !data || !Array.isArray(data.subtasks)) return [];
      return (data.subtasks as unknown[]).map((s) => String(s)).filter(Boolean).slice(0, 12);
    } catch { return []; }
  },

  // AI: weekly status summary (markdown). null if unavailable.
  async aiSummary(tasks: Task[], today: string): Promise<string | null> {
    aiNoticeText = null;
    if (!supabase) return null;
    try {
      const payload = aiTaskContext(tasks, today);
      const { data, error } = await supabase.functions.invoke("ai-assist", { body: { mode: "summary", tasks: payload, today } });
      if (error) await noteAiRefusal(error);
      if (error || !data?.summary) return null;
      return String(data.summary);
    } catch { return null; }
  },

  // AI: answer a question about the user's tasks (read-only). null if unavailable.
  async aiAsk(question: string, tasks: Task[], today: string): Promise<string | null> {
    aiNoticeText = null;
    if (!supabase) return null;
    try {
      const payload = aiTaskContext(tasks, today);
      const { data, error } = await supabase.functions.invoke("ai-assist", { body: { mode: "ask", question, tasks: payload, today } });
      if (error) await noteAiRefusal(error);
      if (error || !data?.answer) return null;
      return String(data.answer);
    } catch { return null; }
  },

  /** Why the last AI request fell back (null/[]/heuristic), in words fit to
   *  show — "You've used today's 200 AI requests…" — or null when it was just
   *  unavailable. Reset at the start of every AI request. */
  aiNotice(): string | null { return aiNoticeText; },

  /* ---------- redesign contracts (W0 stubs: P13 fills them in) ----------
     Each answers "unavailable" (or nothing) until then, and every caller
     falls back to on-device rules, so nothing depends on them yet. */
  /** The workspace's task_events since a moment (Pulse, Radar), newest first. */
  async listWorkspaceEventsSince(_workspaceId: string | null, _sinceISO: string, _limit = 500): Promise<WorkspaceEvent[]> {
    return [];
  },
  /** Ask Kanbo: answer a question about the tasks and propose changes. */
  async aiCommand(_question: string, _tasks: Task[], _ctx: AskContext): Promise<AiOutcome<AskResult>> {
    return { data: null, source: "unavailable" };
  },
  /** Read tasks out of pasted notes. */
  async aiExtract(_text: string, _ctx: AskContext & { hint?: string }): Promise<AiOutcome<ExtractedTask[]>> {
    return { data: null, source: "unavailable" };
  },
  /** Write the team's standup from Pulse's facts. */
  async aiStandup(_facts: unknown): Promise<AiOutcome<string>> {
    return { data: null, source: "unavailable" };
  },
  /** Draft a project status update from its facts. */
  async aiStatus(_facts: unknown): Promise<AiOutcome<{ summary: string; status: StatusKind }>> {
    return { data: null, source: "unavailable" };
  },

  /* ---------- activity feed (Inbox) ---------- */
  /** The inbox: every unread item (up to 500) plus the newest `limit`, merged,
   *  newest first — so a burst of your own actions or a big import can never
   *  push a teammate's assignment or mention out of view unseen. */
  async listActivity(limit = 100): Promise<Activity[]> {
    if (!supabase) return demoActivity.slice(0, limit);
    const client = supabase;
    const newest = async () => {
      // prefer non-archived only; fall back if the archived_at column isn't
      // there yet (migration 0010 not applied) so the app still loads.
      let res = await client.from("activity").select("*")
        .is("archived_at", null).order("created_at", { ascending: false }).limit(limit);
      if (res.error) res = await client.from("activity").select("*").order("created_at", { ascending: false }).limit(limit);
      if (res.error) throw res.error;
      return (res.data as ActivityRow[] | null) ?? [];
    };
    const unread = async () => {
      const res = await client.from("activity").select("*")
        .is("archived_at", null).is("read_at", null).order("created_at", { ascending: false }).limit(500);
      return res.error ? [] : ((res.data as ActivityRow[] | null) ?? []); // best-effort (read_at arrives in 0023)
    };
    const [recent, pending] = await Promise.all([newest(), unread()]);
    const byId = new Map<string, ActivityRow>();
    for (const r of [...pending, ...recent]) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(rowToActivity);
  },
  // mark the user's unread activity as read — all of it, or just `ids` (e.g.
  // what the inbox is showing). Best-effort; tolerates read_at not existing yet.
  async markActivityRead(ids?: string[]): Promise<void> {
    const stamp = new Date().toISOString();
    if (!supabase) {
      demoActivity = demoActivity.map((a) => (!a.readAt && (!ids || ids.includes(a.id)) ? { ...a, readAt: stamp } : a));
      return;
    }
    if (ids && ids.length === 0) return;
    const client = supabase;
    const run = async (part?: string[]) => {
      const q = client.from("activity").update({ read_at: stamp }).is("read_at", null);
      const { error } = await (part ? q.in("id", part) : q);
      if (error && !missingColumn(error.message)) reportError(error, { op: "markActivityRead" });
    };
    try {
      if (!ids) await run();
      else for (const part of chunk([...new Set(ids.filter(isUuid))], IN_CHUNK)) await run(part);
    } catch (e) { reportError(e, { op: "markActivityRead" }); }
  },

  // Archive a single inbox item — hides it from the feed, keeps the history.
  async archiveActivity(id: string): Promise<void> {
    if (!supabase) { demoArchived = [...demoArchived, ...demoActivity.filter((a) => a.id === id)]; demoActivity = demoActivity.filter((a) => a.id !== id); return; }
    const { error } = await supabase.from("activity").update({ archived_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  },

  /** Undo an archive: put these items back in the inbox. */
  async unarchiveActivity(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (!supabase) {
      const back = demoArchived.filter((a) => ids.includes(a.id));
      demoArchived = demoArchived.filter((a) => !ids.includes(a.id));
      demoActivity = [...back, ...demoActivity].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return;
    }
    for (const part of chunk([...new Set(ids.filter(isUuid))], IN_CHUNK)) {
      const { error } = await supabase.from("activity").update({ archived_at: null }).in("id", part);
      if (error) throw error;
    }
  },

  // "Clear whole inbox" — archive every still-active item for this user.
  // Pass ids to archive only those (e.g. what the inbox is currently showing,
  // so one workspace's or filter's "Archive all" can't sweep up the rest).
  async clearInbox(ids?: string[]): Promise<void> {
    if (!supabase) {
      const gone = ids ? demoActivity.filter((a) => ids.includes(a.id)) : demoActivity;
      demoArchived = [...demoArchived, ...gone];
      demoActivity = ids ? demoActivity.filter((a) => !ids.includes(a.id)) : [];
      return;
    }
    if (ids && ids.length === 0) return;
    const stamp = new Date().toISOString();
    const parts = ids ? chunk([...new Set(ids.filter(isUuid))], IN_CHUNK) : [undefined];
    for (const part of parts) {
      const q = supabase.from("activity").update({ archived_at: stamp }).is("archived_at", null);
      const { error } = await (part ? q.in("id", part) : q);
      if (error) throw error;
    }
  },

  /* ---------- profiles ---------- */
  async getProfile(userId: string): Promise<Profile | null> {
    if (!supabase) return demoProfile;
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
    if (error) throw error;
    return data ? rowToProfile(data as ProfileRow) : null;
  },

  /** Save the profile. Leave avatarUrl out (undefined) to keep the photo that's
   *  saved: a caller holding an older copy of the profile (a second tab) must
   *  not put back a photo that has since been changed or removed. */
  async saveProfile(userId: string, p: { firstName: string; lastName: string; pronouns: string; email: string; avatarUrl?: string | null }): Promise<Profile> {
    if (!supabase) {
      demoProfile = { ...demoProfile, id: userId, ...p, avatarUrl: p.avatarUrl !== undefined ? p.avatarUrl : (demoProfile?.avatarUrl ?? null) };
      return demoProfile;
    }
    const uid = await authUid(userId);
    const row: Record<string, unknown> = {
      id: uid, first_name: p.firstName, last_name: p.lastName, pronouns: p.pronouns,
      email: p.email, updated_at: new Date().toISOString(),
    };
    if (p.avatarUrl !== undefined) row.avatar_url = p.avatarUrl;
    const { data, error } = await supabase.from("profiles").upsert(row).select("*").single();
    if (error) throw error;
    return rowToProfile(data as ProfileRow);
  },

  // Persist this user's notification preferences (jsonb on profiles).
  async updateNotifyPrefs(userId: string, prefs: Record<string, boolean>): Promise<void> {
    if (!supabase) { if (demoProfile) demoProfile = { ...demoProfile, notifyPrefs: prefs }; return; }
    const uid = await authUid(userId);
    const { error } = await supabase.from("profiles").update({ notify_prefs: prefs }).eq("id", uid);
    if (error) throw error;
  },

  // Fire transactional emails for an event (assignment / mention / comment).
  // The edge function resolves each recipient's email + email pref server-side.
  // Best-effort: a no-op if the function isn't deployed yet (in-app still works).
  async notify(payload: { kind: "assigned" | "mention" | "comment"; taskId: string; taskTitle: string; recipientIds?: string[] }): Promise<void> {
    if (!supabase) return;
    // in-app notifications are already handled by triggers; a failure here
    // means emails aren't going out, so make it visible (once per session)
    try {
      const { error } = await supabase.functions.invoke("notify", { body: payload });
      if (error) reportOnce("notify", error, { op: "notify", kind: payload.kind });
    } catch (e) { reportOnce("notify", e, { op: "notify", kind: payload.kind }); }
  },

  // Upload an avatar image to the public "avatars" bucket; returns its URL.
  async uploadAvatar(userId: string, file: File): Promise<string> {
    if (!supabase) return URL.createObjectURL(file);
    const uid = await authUid(userId);
    // the extension follows what the file IS, not what it's called
    const ext = IMAGE_EXT[file.type] ?? ((file.name.split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png");
    const path = `${uid}/avatar-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw error;
    const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  },

  // Permanently delete the signed-in account + all its data (calls the
  // delete-account Edge Function, which verifies the JWT and cascades).
  async deleteAccount(): Promise<void> {
    if (!supabase) return; // demo mode has no real account to delete
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Not signed in.");
    const res = await fetch((import.meta.env.VITE_SUPABASE_URL || "") + "/functions/v1/delete-account", {
      method: "POST",
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || "", Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error || `Couldn't delete account (${res.status})`);
    // nothing of a deleted account's should linger on this device
    const uid = data.session?.user?.id;
    if (uid) { offlineQueue.purgeUser(uid); try { localStorage.removeItem(LAST_WS_KEY + uid); } catch { /* ignore */ } }
  },

  /* ---------- external calendars (Google / Microsoft) ---------- */
  // which calendars the user has connected (no tokens — those stay server-side)
  async listCalendarConnections(): Promise<CalendarConnection[]> {
    if (!supabase) return [];
    try {
      const b = await callCalendarFn("?action=list");
      return ((b.connections ?? []) as { provider: CalProvider; account_email: string; created_at?: string }[])
        .map((c) => ({ provider: c.provider, accountEmail: c.account_email, createdAt: c.created_at }));
    } catch { return []; }
  },

  /** The provider's OAuth consent URL to redirect the browser to. With
   *  finishInApp, the provider's redirect comes back to the app as
   *  ?calendar=finish&calendar_state=…&calendar_code=…, and the app must then
   *  call finishCalendarConnect — so only pass it where that's handled.
   *  Opt-in on purpose: without that handler the connection never completes.
   *  Switch it on in the same change that adds the handler, and only then
   *  treat the app as ready for CALENDAR_APP_FINISH_ONLY (DEPLOYMENT.md). */
  async getCalendarAuthUrl(provider: CalProvider, opts: { finishInApp?: boolean } = {}): Promise<string> {
    const qs = new URLSearchParams({ action: "connect", provider });
    if (opts.finishInApp) qs.set("finish", "app");
    const b = await callCalendarFn(`?${qs}`);
    if (!b.url) throw new Error((b.error as string) || "Couldn't start the connection.");
    return b.url as string;
  },

  /** Finish a connection started with finishInApp, as whoever is signed in
   *  here (the server refuses a handshake started by another account).
   *  Throws with the server's message, e.g. an expired link. */
  async finishCalendarConnect(state: string, code: string): Promise<{ provider?: CalProvider; accountEmail?: string }> {
    const b = await callCalendarFn(`?action=finish&state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
    return { provider: b.provider as CalProvider | undefined, accountEmail: b.accountEmail as string | undefined };
  },

  // merged upcoming events across all connected calendars in a window
  async listExternalEvents(startISO: string, endISO: string): Promise<ExternalEvent[]> {
    if (!supabase) return [];
    try {
      const b = await callCalendarFn(`?action=events&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`);
      return (b.events ?? []) as ExternalEvent[];
    } catch { return []; }
  },

  async disconnectCalendar(provider: CalProvider): Promise<void> {
    await callCalendarFn(`?action=disconnect&provider=${provider}`);
  },

  async logActivity(input: NewActivity, userId: string): Promise<Activity> {
    // your own actions are born read, so they never count as unread on any device
    const readAt = new Date().toISOString();
    if (!supabase) {
      const a: Activity = { id: newId(), taskId: input.taskId, taskTitle: input.taskTitle, kind: input.kind, detail: input.detail, createdAt: new Date().toISOString(), readAt };
      demoActivity = [a, ...demoActivity];
      return a;
    }
    const uid = await authUid(userId);
    let row: Record<string, unknown> = { user_id: uid, task_id: input.taskId, task_title: input.taskTitle, kind: input.kind, detail: input.detail, read_at: readAt };
    for (let i = 0; i < 3; i++) {
      const { data, error } = await supabase.from("activity").insert(row).select("*").single();
      if (!error) return rowToActivity(data as ActivityRow);
      const stripped = withoutMissingColumn(row, error.message); // read_at arrives in 0023
      if (!stripped) throw error;
      row = stripped;
    }
    throw new Error("logActivity failed");
  },

  /* Real-time multi-tab/device sync. onChange gets each changed row (RLS
     scopes what arrives), or { kind: "resync" } when live events may have
     been missed and everything should be re-read: after the socket drops and
     reconnects (sleep, Wi-Fi change), when the browser comes back online, and
     when the tab returns after more than a minute hidden.
     Returns an unsubscribe fn. No-op in demo mode. */
  subscribeToChanges(onChange: (change?: RealtimeChange) => void): () => void {
    if (!supabase) return () => {};
    const client = supabase;
    // every channel gets a unique topic: the client hands back (and, when one
    // closes, drops) channels by topic, so a reused name could collide with a
    // channel that is still leaving
    const topic = (name: string) => `${name}-${++channelSeq}`;
    let disposed = false;
    let core: RealtimeChannel | null = null;
    let extras: RealtimeChannel | null = null;
    let extrasOff = false;   // the server refused the extra tables (not in the publication)
    let dropped = false;     // the core channel lost its connection: resync once it's back
    let reopenTimer: ReturnType<typeof setTimeout> | undefined;
    let reopenDelay = 2000;
    let hiddenAt: number | null = typeof document !== "undefined" && document.visibilityState === "hidden" ? Date.now() : null;

    const resync = (reason: "reconnected" | "online" | "visible") => {
      if (disposed) return;
      claimedFor = null; // a rare, deliberate full reload: also pick up any invite accepted meanwhile
      onChange({ kind: "resync", reason });
    };
    const forward = (p: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (disposed) return;
      const row = p.new && Object.keys(p.new).length ? p.new as Record<string, unknown> : null;
      const old = p.old && Object.keys(p.old).length ? p.old as Record<string, unknown> : null;
      onChange({ kind: "row", table: p.table, event: p.eventType, row, old });
    };
    const closeExtras = () => { if (extras) { void client.removeChannel(extras); extras = null; } };
    const openExtras = () => {
      if (disposed || extras || extrasOff) return;
      let ch = client.channel(topic("kanbo-changes-extra"));
      for (const table of EXTRA_TABLES) ch = ch.on("postgres_changes", { event: "*", schema: "public", table }, forward);
      // the server rolls back every binding on a channel if one table isn't in
      // the publication, then keeps retrying — stop asking for this session
      ch = ch.on("system", {}, (msg: { extension?: string; status?: string; message?: string }) => {
        if (msg?.extension !== "postgres_changes" || msg?.status !== "error" || disposed) return;
        extrasOff = true;
        closeExtras();
        // expected until migration 0042 (which adds them) is live, so it's a
        // console note, not a monitoring error on every page load for every user
        if (!reportedOnce.has("realtime-extras")) {
          reportedOnce.add("realtime-extras");
          console.info("[kanbo] Live updates for team tables are off — the realtime publication doesn't include them yet:", msg.message || "subscription refused");
        }
      });
      extras = ch;
      // otherwise status is ignored: the core channel owns reconnect + resync.
      // If the server closes this one, forget it so the core's next
      // SUBSCRIBED opens a fresh one.
      ch.subscribe((status) => { if (status === "CLOSED" && extras === ch) extras = null; });
    };
    const scheduleReopen = () => {
      if (disposed || reopenTimer !== undefined) return;
      reopenTimer = setTimeout(() => {
        reopenTimer = undefined;
        if (disposed) return;
        core = null; // already closed and detached by the client
        closeExtras();
        openCore();
      }, reopenDelay);
      reopenDelay = Math.min(reopenDelay * 2, 60_000);
    };
    const openCore = () => {
      let ch = client.channel(topic("kanbo-changes"));
      for (const table of CORE_TABLES) ch = ch.on("postgres_changes", { event: "*", schema: "public", table }, forward);
      core = ch;
      ch.subscribe((status) => {
        if (disposed || core !== ch) return;
        if (status === "SUBSCRIBED") {
          reopenDelay = 2000;
          if (dropped) { dropped = false; resync("reconnected"); }
          openExtras();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          dropped = true; // the client rejoins by itself; catch up when it does
        } else if (status === "CLOSED") {
          dropped = true; // closed by the server, not by us: it won't rejoin on its own
          scheduleReopen();
        }
      });
    };

    const onOnline = () => resync("online");
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away > RESYNC_AFTER_HIDDEN_MS) resync("visible");
    };
    if (typeof window !== "undefined") window.addEventListener("online", onOnline);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    openCore();

    return () => {
      disposed = true;
      clearTimeout(reopenTimer);
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      if (core) void client.removeChannel(core);
      core = null;
      closeExtras();
    };
  },

  /* Live presence on a single task: announce that I'm viewing it and get the
     list of everyone else currently viewing. Returns an unsubscribe fn. */
  subscribeToTaskPresence(taskId: string, me: { id: string; name: string }, onSync: (people: { id: string; name: string }[]) => void): () => void {
    if (!supabase) return () => {};
    const client = supabase;
    const topic = `presence-task-${taskId}`;
    return openFixedTopic(client, topic, () => {
      const channel = client.channel(topic, { config: { presence: { key: me.id } } });
      channel.on("presence", { event: "sync" }, () => {
        const state = channel.presenceState() as Record<string, { id: string; name: string }[]>;
        const seen = new Map<string, string>();
        Object.values(state).flat().forEach((p) => { if (p && p.id) seen.set(p.id, p.name); });
        onSync([...seen].map(([id, name]) => ({ id, name })));
      });
      channel.subscribe((status) => { if (status === "SUBSCRIBED") void channel.track({ id: me.id, name: me.name }); });
      return channel;
    });
  },

  /* Live comment stream for one task: fires onInsert with each new comment as
     collaborators post them, so the thread updates without a refresh — and,
     if onUpdate is given, with each edited comment (body, reactions). */
  subscribeToTaskComments(taskId: string, onInsert: (c: Comment) => void, onUpdate?: (c: Comment) => void): () => void {
    if (!supabase) return () => {};
    const client = supabase;
    // a unique topic per subscription (the filter, not the name, picks the
    // rows): reopening a task while the last channel is still leaving would
    // otherwise get that dead channel back and miss every new comment
    let channel = client
      .channel(`comments-${taskId}-${++channelSeq}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "comments", filter: `task_id=eq.${taskId}` },
        (payload) => { try { onInsert(rowToComment(payload.new as CommentRow)); } catch { /* malformed row */ } });
    if (onUpdate) {
      channel = channel.on("postgres_changes", { event: "UPDATE", schema: "public", table: "comments", filter: `task_id=eq.${taskId}` },
        (payload) => { try { onUpdate(rowToComment(payload.new as CommentRow)); } catch { /* malformed row */ } });
    }
    channel.subscribe();
    return () => { void client.removeChannel(channel); };
  },

  /* ---------- dependencies (blocked-by) ---------- */
  async addDependency(taskId: string, dependsOn: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("task_dependencies").insert({ task_id: taskId, depends_on: dependsOn });
    if (error && !String(error.message).includes("duplicate")) throw error;
  },
  async removeDependency(taskId: string, dependsOn: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("task_dependencies").delete().eq("task_id", taskId).eq("depends_on", dependsOn);
    if (error) throw error;
  },

  async addSubtask(taskId: string, title: string, position: number): Promise<Subtask> {
    if (!supabase) return { id: newId(), title, done: false };
    const { data, error } = await supabase.from("subtasks").insert({ task_id: taskId, title, done: false, position }).select("*").single();
    if (error) throw error;
    return { id: data.id, title: data.title, done: data.done };
  },

  async setSubtaskDone(subtaskId: string, done: boolean): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("subtasks").update({ done }).eq("id", subtaskId);
    if (error) throw error;
  },
};
