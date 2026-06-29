/* ============================================================
   KANBO — data store
   One interface, two adapters:
   - mock    : in-memory demo data (no backend needed)
   - supabase: real Postgres persistence
   Components depend only on the domain types, never the adapter.
   ============================================================ */
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import {
  TASKS, PROJECTS, MEMBERS, WORKSPACES, energyOf, PLAN_TODAY_IDS, setReferenceData,
  PERSONAL_PROJECT, PERSONAL_WORKSPACE, BUILTIN_TAGS,
} from "./data";
import type { Task, Member, Project, Workspace, WorkspaceMember, Subtask, TagDef, Comment, Activity, ActivityKind, Attachment, Subscription, Plan, SubStatus, Status, Priority, EnergyKind, Recurrence, Role, Profile, AccessRequest, CalProvider, CalendarConnection, ExternalEvent, CustomValue, CustomFieldDef, Section, SavedSearch, Goal, GoalStatus, Portfolio, StatusUpdate, StatusKind, AutomationRule, AutomationAction, FormDef, FormFieldKey } from "./types";

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
}

/* fields the prototype derived on load; persisted as columns in Supabase */
function withPlanFields(t: Task): Task {
  const wsId = PROJECTS.find((p) => p.id === t.projectId)?.workspaceId ?? null;
  return { ...t, energy: energyOf(t), dur: t.focusMin, scheduled: null, planToday: PLAN_TODAY_IDS.includes(t.id), workspaceId: wsId, recurrence: t.recurrence ?? "none" };
}

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.round(Math.random() * 1e6));

/* Always write rows under the REAL authenticated user id. Reading it from the
   live Supabase session (not app state) means a stale "m-self" placeholder can
   never leak into a uuid column. */
async function authUid(fallback: string): Promise<string> {
  if (!supabase) return fallback;
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? fallback;
}

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

interface ProjectRow { id: string; name: string; emoji: string | null; color: string | null; workspace_id: string | null; description?: string | null; status?: string | null; owner_id?: string | null; contributor_ids?: string[] | null; }
function rowToProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, emoji: r.emoji ?? "📁", color: r.color ?? "oklch(0.74 0.14 230)", workspaceId: r.workspace_id ?? null, description: r.description ?? undefined, status: r.status ?? undefined, ownerId: r.owner_id ?? undefined, contributorIds: r.contributor_ids ?? undefined };
}

interface TagRow { id: string; label: string; color: string; }

export interface CreatedTag { id: string; label: string; color: string; }

interface CommentRow { id: string; task_id: string; user_id: string; author_name: string; body: string; created_at: string; mentions?: string[] | null; reactions?: Record<string, string[]> | null; }
function rowToComment(r: CommentRow): Comment {
  return { id: r.id, taskId: r.task_id, authorId: r.user_id, authorName: r.author_name, body: r.body, createdAt: r.created_at, mentions: r.mentions ?? [], reactions: r.reactions ?? {} };
}

interface ActivityRow { id: string; task_id: string | null; task_title: string; kind: string; detail: string; created_at: string; archived_at?: string | null; read_at?: string | null; }
function rowToActivity(r: ActivityRow): Activity {
  return { id: r.id, taskId: r.task_id, taskTitle: r.task_title, kind: r.kind as ActivityKind, detail: r.detail, createdAt: r.created_at, readAt: r.read_at ?? undefined };
}

interface ProfileRow { id: string; first_name: string; last_name: string; pronouns: string; email: string; avatar_url: string | null; approved?: boolean | null; suspended?: boolean | null; notify_prefs?: Record<string, boolean> | null; }
function rowToProfile(r: ProfileRow): Profile {
  return { id: r.id, firstName: r.first_name || "", lastName: r.last_name || "", pronouns: r.pronouns || "", email: r.email || "", avatarUrl: r.avatar_url, approved: r.approved ?? undefined, suspended: r.suspended ?? undefined, notifyPrefs: r.notify_prefs ?? undefined };
}
function fullName(p: { firstName: string; lastName: string }): string {
  return [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
}
const AVATAR_BUCKET = "avatars";

export interface NewActivity {
  taskId: string | null;
  taskTitle: string;
  kind: ActivityKind;
  detail: string;
}

interface WorkspaceRow { id: string; name: string; owner_id: string; logo_url?: string | null; }
interface MemberRow { id: string; workspace_id: string; user_id: string | null; email: string; name: string; role: Role; status: "invited" | "active"; title?: string | null; }
function rowToWsMember(r: MemberRow): WorkspaceMember {
  return { id: r.id, workspaceId: r.workspace_id, userId: r.user_id, email: r.email, name: r.name, role: r.role, status: r.status, title: r.title ?? undefined };
}

const MEMBER_COLORS = [
  "oklch(0.74 0.14 230)", "oklch(0.78 0.15 70)", "oklch(0.74 0.16 305)",
  "oklch(0.7 0.13 20)", "oklch(0.75 0.13 155)", "oklch(0.7 0.02 240)",
];

interface AttachmentRow { id: string; task_id: string; name: string; size: number; mime: string; path: string; created_at: string; }
function rowToAttachment(r: AttachmentRow, url?: string): Attachment {
  return { id: r.id, taskId: r.task_id, name: r.name, size: r.size, mime: r.mime, path: r.path, url, createdAt: r.created_at };
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
  return row;
}

// If a write failed because the DB doesn't have a column (a migration not yet
// applied), return a copy of the row with that column removed; null if the
// error isn't a missing-column error or the column isn't in the row.
function withoutMissingColumn(row: Record<string, unknown>, message?: string): Record<string, unknown> | null {
  if (!message) return null;
  let col: string | null = null;
  // PostgREST schema cache: Could not find the 'due_time' column of 'tasks' …
  let m = message.match(/Could not find the '([^']+)' column/i);
  if (m) col = m[1];
  // Postgres 42703: column tasks.due_time does not exist  |  column "due_time" does not exist
  if (!col) { m = message.match(/column\s+"?(?:[\w]+\.)?([a-z0-9_]+)"?\s+does not exist/i); if (m) col = m[1]; }
  if (!col || !(col in row)) return null;
  const copy = { ...row };
  delete copy[col];
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
  // only send newer (migration 0015/0018) columns when actually used, so a
  // normal task insert never depends on that migration being applied
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

    // load this user's profile (best-effort: tolerates the profiles migration
    // not being applied yet). Drives the display name / avatar / pronouns.
    let myProfile: Profile | null = null;
    try {
      const { data: pData } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
      if (pData) myProfile = rowToProfile(pData as ProfileRow);
    } catch { /* profiles table not present yet */ }

    // clean, minimal reference set (one Personal workspace + project, no demo
    // projects / teammates / calendar events).
    const profileName = myProfile ? fullName(myProfile) : "";
    const self: Member = {
      id: uid,
      name: profileName || (sUser?.user_metadata?.name as string) || sUser?.email || user?.name || user?.email || "You",
      email: sUser?.email || user?.email || "",
      type: "self",
      color: "oklch(0.585 0.196 264)",
      pronouns: myProfile?.pronouns || undefined,
      avatarUrl: myProfile?.avatarUrl || null,
    };

    // claim any pending workspace invites for this email (best-effort —
    // tolerates the teams migration not being applied yet)
    await supabase.rpc("claim_invites").then(() => {}, () => {});

    // tasks are required; everything else is best-effort so a missing table
    // (e.g. a migration not yet applied) can never break boot or leak demo data.
    // Visibility (own + shared-workspace rows) is enforced by RLS — no user filter.
    const { data: taskData, error: tErr } = await supabase.from("tasks").select(TASK_SELECT);
    if (tErr) throw tErr;

    const { data: projData } = await supabase.from("projects").select("*");
    const projects = [PERSONAL_PROJECT, ...((projData as ProjectRow[] | null) ?? []).map(rowToProject)];

    // real accounts start with NO built-in tags — only the user's own.
    const { data: tagData } = await supabase.from("tags").select("*").eq("user_id", uid);
    const tags: Record<string, TagDef> = {};
    for (const t of (tagData as TagRow[] | null) ?? []) tags[t.id] = { label: t.label, color: t.color };

    // workspaces + members (best-effort)
    const { data: wsData } = await supabase.from("workspaces").select("*");
    const workspaces: Workspace[] = [
      { ...PERSONAL_WORKSPACE },
      ...((wsData as WorkspaceRow[] | null) ?? []).map((w) => ({ id: w.id, name: w.name, kind: "team" as const, ownerId: w.owner_id, logoUrl: w.logo_url ?? undefined })),
    ];
    const { data: memData } = await supabase.from("workspace_members").select("*");
    const members = ((memData as MemberRow[] | null) ?? []).map(rowToWsMember);

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
    try {
      const { data: gData } = await supabase.from("goals").select("*");
      goals = ((gData as GoalRow[] | null) ?? []).map(rowToGoal);
    } catch { /* table not present yet */ }
    try {
      const { data: pData2 } = await supabase.from("portfolios").select("*");
      portfolios = ((pData2 as PortfolioRow[] | null) ?? []).map(rowToPortfolio);
    } catch { /* table not present yet */ }
    try {
      const { data: suData } = await supabase.from("status_updates").select("*").order("created_at", { ascending: false });
      statusUpdates = ((suData as StatusUpdateRow[] | null) ?? []).map(rowToStatusUpdate);
    } catch { /* table not present yet */ }
    let automationRules: AutomationRule[] = [];
    try {
      const { data: arData } = await supabase.from("automation_rules").select("*");
      automationRules = ((arData as AutomationRuleRow[] | null) ?? []).map(rowToRule);
    } catch { /* table not present yet */ }
    let forms: FormDef[] = [];
    try {
      const { data: fmData } = await supabase.from("forms").select("*");
      forms = ((fmData as FormRow[] | null) ?? []).map(rowToForm);
    } catch { /* table not present yet */ }

    setReferenceData({ members: [self, ...teammates], projects, workspaces, events: [], tags });
    return {
      tasks: ((taskData as TaskRow[] | null) ?? []).map(rowToTask),
      projects,
      tags,
      workspaces,
      members,
      currentUserId: uid,
      defaultWorkspace: null,
      profile: myProfile,
      sections,
      customFields,
      savedSearches,
      goals,
      portfolios,
      statusUpdates,
      automationRules,
      forms,
    };
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

  async inviteMember(workspaceId: string, email: string, role: Role = "member", name = ""): Promise<WorkspaceMember> {
    if (!supabase) {
      const m: WorkspaceMember = { id: newId(), workspaceId, userId: null, email, name, role, status: "invited" };
      demoMembers = [...demoMembers, m];
      return m;
    }
    // guarded server-side: only owner/admin can invite, only owner can add admins
    const { data, error } = await supabase.rpc("invite_member", { p_ws: workspaceId, p_email: email.trim().toLowerCase(), p_name: name, p_role: role });
    if (error) throw error;
    return rowToWsMember(data as MemberRow);
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

  async createTask(t: Task, userId: string): Promise<Task> {
    if (!supabase) return t; // demo mode keeps the optimistic copy
    const uid = await authUid(userId);
    // Resilient insert: if the DB is missing a newer column (a migration not
    // applied yet), strip that column and retry so the task ALWAYS saves —
    // losing a field is acceptable, losing the whole task is not.
    let row = taskToInsertRow(t, uid);
    for (let i = 0; i < 8; i++) {
      // select only "id" — a brand-new task has no subtasks/deps, so we avoid
      // the heavier embed (a frequent silent failure point) and just adopt the id
      const { data, error } = await supabase.from("tasks").insert(row).select("id").single();
      if (!error) return { ...t, id: (data as { id: string }).id };
      const stripped = withoutMissingColumn(row, error.message);
      if (!stripped) throw error;
      row = stripped;
    }
    throw new Error("createTask: could not persist after stripping unknown columns");
  },

  async updateTask(id: string, patch: Partial<Task>): Promise<void> {
    if (!supabase) return;
    let row = patchToRow(patch);
    if (Object.keys(row).length === 0) return;
    for (let i = 0; i < 8; i++) {
      const { error } = await supabase.from("tasks").update(row).eq("id", id);
      if (!error) return;
      const stripped = withoutMissingColumn(row, error.message);
      if (!stripped) throw error;
      if (Object.keys(stripped).length === 0) return; // nothing left to write
      row = stripped;
    }
  },

  async deleteTask(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (error) throw error;
  },

  async createProject(input: NewProject, userId: string): Promise<Project> {
    if (!supabase) return { id: newId(), ...input };
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

  async deleteProject(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) throw error;
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

  // every attachment across a set of tasks (for the Files view)
  async listProjectAttachments(taskIds: string[]): Promise<Attachment[]> {
    if (!supabase || taskIds.length === 0) return [];
    const { data, error } = await supabase.from("attachments").select("*").in("task_id", taskIds).order("created_at", { ascending: false });
    if (error) throw error;
    const rows = (data as AttachmentRow[] | null) ?? [];
    return Promise.all(rows.map(async (r) => {
      try {
        const { data: s } = await supabase!.storage.from(ATTACH_BUCKET).createSignedUrl(r.path, 3600);
        return rowToAttachment(r, s?.signedUrl);
      } catch { return rowToAttachment(r, undefined); }
    }));
  },

  async createTag(label: string, color: string, userId: string): Promise<CreatedTag> {
    if (!supabase) return { id: newId(), label, color };
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("tags").insert({ user_id: uid, label, color }).select("*").single();
    if (error) throw error;
    return { id: data.id, label: data.label, color: data.color };
  },

  async deleteTag(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("tags").delete().eq("id", id);
    if (error) throw error;
  },

  /* ---------- comments ---------- */
  async listComments(taskId: string): Promise<Comment[]> {
    if (!supabase) return demoComments[taskId] ?? [];
    const { data, error } = await supabase.from("comments").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
    if (error) throw error;
    return (data as CommentRow[]).map(rowToComment);
  },

  async addComment(taskId: string, body: string, userId: string, authorName: string, mentions: string[] = []): Promise<Comment> {
    if (!supabase) {
      const c: Comment = { id: newId(), taskId, authorId: userId, authorName, body, createdAt: new Date().toISOString(), mentions };
      (demoComments[taskId] ??= []).push(c);
      return c;
    }
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("comments").insert({ task_id: taskId, user_id: uid, author_name: authorName, body, mentions }).select("*").single();
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
      const a: Attachment = { id: newId(), taskId, name: file.name, size: file.size, mime: file.type, path: "demo", url: URL.createObjectURL(file), createdAt: new Date().toISOString() };
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
      return { items, summary: "Prioritized your open work — urgent and unblocking tasks first.", source: "heuristic" as const };
    };
    if (!supabase) return heuristic();
    try {
      const payload = tasks.filter((t) => t.status !== "done").map((t) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate ?? null, tags: t.tags, focusMin: t.focusMin,
        blockedBy: t.dependencies,
      }));
      const { data, error } = await supabase.functions.invoke("ai-assist", { body: { tasks: payload, today } });
      if (error || !data || !Array.isArray(data.items)) return heuristic();
      return { items: data.items, summary: data.summary || "Here's how I'd approach your day.", source: "ai" };
    } catch {
      return heuristic();
    }
  },

  // AI: break a task into concrete subtasks. Returns [] if AI is unavailable.
  async aiBreakdown(title: string, description: string): Promise<string[]> {
    if (!supabase) return [];
    try {
      const { data, error } = await supabase.functions.invoke("ai-assist", { body: { mode: "breakdown", title, description } });
      if (error || !data || !Array.isArray(data.subtasks)) return [];
      return (data.subtasks as unknown[]).map((s) => String(s)).filter(Boolean).slice(0, 12);
    } catch { return []; }
  },

  // AI: weekly status summary (markdown). null if unavailable.
  async aiSummary(tasks: Task[], today: string): Promise<string | null> {
    if (!supabase) return null;
    try {
      const payload = tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate ?? null, completedAt: t.completedAt ?? null }));
      const { data, error } = await supabase.functions.invoke("ai-assist", { body: { mode: "summary", tasks: payload, today } });
      if (error || !data?.summary) return null;
      return String(data.summary);
    } catch { return null; }
  },

  // AI: answer a question about the user's tasks (read-only). null if unavailable.
  async aiAsk(question: string, tasks: Task[], today: string): Promise<string | null> {
    if (!supabase) return null;
    try {
      const payload = tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate ?? null, project: t.projectId }));
      const { data, error } = await supabase.functions.invoke("ai-assist", { body: { mode: "ask", question, tasks: payload, today } });
      if (error || !data?.answer) return null;
      return String(data.answer);
    } catch { return null; }
  },

  /* ---------- activity feed (Inbox) ---------- */
  async listActivity(limit = 100): Promise<Activity[]> {
    if (!supabase) return demoActivity.slice(0, limit);
    // prefer non-archived only; fall back if the archived_at column isn't there
    // yet (migration 0010 not applied) so the app still loads.
    let res = await supabase.from("activity").select("*")
      .is("archived_at", null).order("created_at", { ascending: false }).limit(limit);
    if (res.error) {
      res = await supabase.from("activity").select("*").order("created_at", { ascending: false }).limit(limit);
    }
    if (res.error) throw res.error;
    return (res.data as ActivityRow[]).map(rowToActivity);
  },
  // mark all of the user's unread activity as read (best-effort; tolerates the
  // read_at column not existing yet)
  async markActivityRead(): Promise<void> {
    if (!supabase) return;
    try { await supabase.from("activity").update({ read_at: new Date().toISOString() }).is("read_at", null); } catch { /* column not present yet */ }
  },

  // Archive a single inbox item — hides it from the feed, keeps the history.
  async archiveActivity(id: string): Promise<void> {
    if (!supabase) { demoActivity = demoActivity.filter((a) => a.id !== id); return; }
    const { error } = await supabase.from("activity").update({ archived_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  },

  // "Clear whole inbox" — archive every still-active item for this user.
  async clearInbox(): Promise<void> {
    if (!supabase) { demoActivity = []; return; }
    const { error } = await supabase.from("activity")
      .update({ archived_at: new Date().toISOString() }).is("archived_at", null);
    if (error) throw error;
  },

  /* ---------- profiles ---------- */
  async getProfile(userId: string): Promise<Profile | null> {
    if (!supabase) return demoProfile;
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
    if (error) throw error;
    return data ? rowToProfile(data as ProfileRow) : null;
  },

  async saveProfile(userId: string, p: { firstName: string; lastName: string; pronouns: string; email: string; avatarUrl: string | null }): Promise<Profile> {
    if (!supabase) { demoProfile = { id: userId, ...p }; return demoProfile; }
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("profiles").upsert({
      id: uid, first_name: p.firstName, last_name: p.lastName, pronouns: p.pronouns,
      email: p.email, avatar_url: p.avatarUrl, updated_at: new Date().toISOString(),
    }).select("*").single();
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
    try { await supabase.functions.invoke("notify", { body: payload }); } catch { /* not deployed — in-app notifications already handled by triggers */ }
  },

  // Upload an avatar image to the public "avatars" bucket; returns its URL.
  async uploadAvatar(userId: string, file: File): Promise<string> {
    if (!supabase) return URL.createObjectURL(file);
    const uid = await authUid(userId);
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
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

  // get the provider's OAuth consent URL to redirect the browser to
  async getCalendarAuthUrl(provider: CalProvider): Promise<string> {
    const b = await callCalendarFn(`?action=connect&provider=${provider}`);
    if (!b.url) throw new Error((b.error as string) || "Couldn't start the connection.");
    return b.url as string;
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
    if (!supabase) {
      const a: Activity = { id: newId(), taskId: input.taskId, taskTitle: input.taskTitle, kind: input.kind, detail: input.detail, createdAt: new Date().toISOString() };
      demoActivity = [a, ...demoActivity];
      return a;
    }
    const uid = await authUid(userId);
    const { data, error } = await supabase
      .from("activity")
      .insert({ user_id: uid, task_id: input.taskId, task_title: input.taskTitle, kind: input.kind, detail: input.detail })
      .select("*")
      .single();
    if (error) throw error;
    return rowToActivity(data as ActivityRow);
  },

  /* Real-time multi-tab sync: invoke onChange when any of this user's
     tasks/projects/tags/subtasks change (RLS scopes it to their rows).
     Returns an unsubscribe fn. No-op in demo mode. */
  subscribeToChanges(onChange: () => void): () => void {
    if (!supabase) return () => {};
    const client = supabase;
    const channel = client
      .channel("kanbo-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "tags" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "subtasks" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "workspaces" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "workspace_members" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "attachments" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "activity" }, onChange) // assignment notifications land live in the inbox
      .subscribe();
    return () => { client.removeChannel(channel); };
  },

  /* Live presence on a single task: announce that I'm viewing it and get the
     list of everyone else currently viewing. Returns an unsubscribe fn. */
  subscribeToTaskPresence(taskId: string, me: { id: string; name: string }, onSync: (people: { id: string; name: string }[]) => void): () => void {
    if (!supabase) return () => {};
    const client = supabase;
    const channel = client.channel(`presence-task-${taskId}`, { config: { presence: { key: me.id } } });
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as Record<string, { id: string; name: string }[]>;
      const seen = new Map<string, string>();
      Object.values(state).flat().forEach((p) => { if (p && p.id) seen.set(p.id, p.name); });
      onSync([...seen].map(([id, name]) => ({ id, name })));
    });
    channel.subscribe((status) => { if (status === "SUBSCRIBED") channel.track({ id: me.id, name: me.name }); });
    return () => { client.removeChannel(channel); };
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
