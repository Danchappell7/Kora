/* ============================================================
   KORA — data store
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
import type { Task, Member, Project, Workspace, WorkspaceMember, Subtask, TagDef, Comment, Activity, ActivityKind, Attachment, Subscription, Plan, SubStatus, Status, Priority, EnergyKind, Recurrence } from "./types";

export interface Bootstrap {
  tasks: Task[];
  projects: Project[];
  tags: Record<string, TagDef>;
  workspaces: Workspace[];
  members: WorkspaceMember[];
  currentUserId: string;
  defaultWorkspace: string | null;
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
  due_date: string | null;
  original_due_date: string | null;
  completed_at: string | null;
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
    dueDate: r.due_date ?? undefined,
    originalDueDate: r.original_due_date ?? undefined,
    completedAt: r.completed_at ?? undefined,
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
  };
}

interface ProjectRow { id: string; name: string; emoji: string | null; color: string | null; workspace_id: string | null; }
function rowToProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, emoji: r.emoji ?? "📁", color: r.color ?? "oklch(0.74 0.14 230)", workspaceId: r.workspace_id ?? null };
}

interface TagRow { id: string; label: string; color: string; }

export interface CreatedTag { id: string; label: string; color: string; }

interface CommentRow { id: string; task_id: string; user_id: string; author_name: string; body: string; created_at: string; }
function rowToComment(r: CommentRow): Comment {
  return { id: r.id, taskId: r.task_id, authorId: r.user_id, authorName: r.author_name, body: r.body, createdAt: r.created_at };
}

interface ActivityRow { id: string; task_id: string | null; task_title: string; kind: string; detail: string; created_at: string; }
function rowToActivity(r: ActivityRow): Activity {
  return { id: r.id, taskId: r.task_id, taskTitle: r.task_title, kind: r.kind as ActivityKind, detail: r.detail, createdAt: r.created_at };
}

export interface NewActivity {
  taskId: string | null;
  taskTitle: string;
  kind: ActivityKind;
  detail: string;
}

interface WorkspaceRow { id: string; name: string; owner_id: string; }
interface MemberRow { id: string; workspace_id: string; user_id: string | null; email: string; name: string; role: "owner" | "member"; status: "invited" | "active"; }
function rowToWsMember(r: MemberRow): WorkspaceMember {
  return { id: r.id, workspaceId: r.workspace_id, userId: r.user_id, email: r.email, name: r.name, role: r.role, status: r.status };
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

/* demo-mode in-memory stores (session-only, like the rest of demo mode) */
const demoComments: Record<string, Comment[]> = {};
let demoActivity: Activity[] = [];
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
  return row;
}

function taskToInsertRow(t: Task, userId: string): Record<string, unknown> {
  return {
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
  };
}

// tasks ↔ task_dependencies has TWO foreign keys (task_id and depends_on), so
// the embed MUST name the FK or PostgREST returns 300 PGRST201 and the whole
// query fails. We want this task's own dependency rows (task_id = id).
const TASK_SELECT = "*, subtasks(*), task_dependencies!task_dependencies_task_id_fkey(depends_on)";

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
        tasks: TASKS.map(withPlanFields), projects: [...PROJECTS], tags: { ...BUILTIN_TAGS },
        workspaces: demoWorkspaces, members: demoMembers,
        currentUserId: "m-self", defaultWorkspace: "ws-foundrise",
      };
    }
    // resolve the REAL authenticated user from the live session — robust to a
    // stale "m-self" placeholder lingering in app/auth state.
    const { data: sessionData } = await supabase.auth.getSession();
    const sUser = sessionData.session?.user;
    const uid = sUser?.id ?? (user && user.id !== "m-self" ? user.id : undefined);
    if (!uid) throw new Error("Not authenticated");

    // clean, minimal reference set (one Personal workspace + project, no demo
    // projects / teammates / calendar events).
    const self: Member = {
      id: uid,
      name: (sUser?.user_metadata?.name as string) || sUser?.email || user?.name || user?.email || "You",
      email: sUser?.email || user?.email || "",
      type: "self",
      color: "oklch(0.585 0.196 264)",
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
      ...((wsData as WorkspaceRow[] | null) ?? []).map((w) => ({ id: w.id, name: w.name, kind: "team" as const, ownerId: w.owner_id })),
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

    setReferenceData({ members: [self, ...teammates], projects, workspaces, events: [], tags });
    return {
      tasks: (taskData as TaskRow[]).map(rowToTask),
      projects,
      tags,
      workspaces,
      members,
      currentUserId: uid,
      defaultWorkspace: null,
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
    return { id: ws.id, name: ws.name, kind: "team", ownerId: ws.owner_id };
  },

  async inviteMember(workspaceId: string, email: string): Promise<WorkspaceMember> {
    if (!supabase) {
      const m: WorkspaceMember = { id: newId(), workspaceId, userId: null, email, name: "", role: "member", status: "invited" };
      demoMembers = [...demoMembers, m];
      return m;
    }
    const { data, error } = await supabase.from("workspace_members")
      .insert({ workspace_id: workspaceId, email: email.trim().toLowerCase(), role: "member", status: "invited" })
      .select("*").single();
    if (error) throw error;
    return rowToWsMember(data as MemberRow);
  },

  async removeMember(memberId: string): Promise<void> {
    if (!supabase) { demoMembers = demoMembers.filter((m) => m.id !== memberId); return; }
    const { error } = await supabase.from("workspace_members").delete().eq("id", memberId);
    if (error) throw error;
  },

  async createTask(t: Task, userId: string): Promise<Task> {
    if (!supabase) return t; // demo mode keeps the optimistic copy
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("tasks").insert(taskToInsertRow(t, uid)).select(TASK_SELECT).single();
    if (error) throw error;
    return rowToTask(data as TaskRow);
  },

  async updateTask(id: string, patch: Partial<Task>): Promise<void> {
    if (!supabase) return;
    const row = patchToRow(patch);
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from("tasks").update(row).eq("id", id);
    if (error) throw error;
  },

  async deleteTask(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (error) throw error;
  },

  async createProject(input: NewProject, userId: string): Promise<Project> {
    if (!supabase) return { id: newId(), ...input };
    const uid = await authUid(userId);
    const { data, error } = await supabase
      .from("projects")
      .insert({ user_id: uid, name: input.name, emoji: input.emoji, color: input.color, workspace_id: input.workspaceId })
      .select("*")
      .single();
    if (error) throw error;
    return rowToProject(data as ProjectRow);
  },

  async deleteProject(id: string): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) throw error;
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

  async addComment(taskId: string, body: string, userId: string, authorName: string): Promise<Comment> {
    if (!supabase) {
      const c: Comment = { id: newId(), taskId, authorId: userId, authorName, body, createdAt: new Date().toISOString() };
      (demoComments[taskId] ??= []).push(c);
      return c;
    }
    const uid = await authUid(userId);
    const { data, error } = await supabase.from("comments").insert({ task_id: taskId, user_id: uid, author_name: authorName, body }).select("*").single();
    if (error) throw error;
    return rowToComment(data as CommentRow);
  },

  /* ---------- attachments ---------- */
  async listAttachments(taskId: string): Promise<Attachment[]> {
    if (!supabase) return demoAttachments[taskId] ?? [];
    const { data, error } = await supabase.from("attachments").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
    if (error) throw error;
    const rows = data as AttachmentRow[];
    // sign each path for download (best-effort)
    const signed = await Promise.all(rows.map(async (r) => {
      const { data: s } = await supabase!.storage.from(ATTACH_BUCKET).createSignedUrl(r.path, 3600);
      return rowToAttachment(r, s?.signedUrl);
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

  /* ---------- AI prioritization (real LLM with heuristic fallback) ---------- */
  async aiPrioritize(tasks: Task[], today: string): Promise<{ items: { id: string; score: number; reason: string }[]; summary: string; source: "ai" | "heuristic" }> {
    const heuristic = () => {
      const open = tasks.filter((t) => t.status !== "done");
      const items = [...open].sort((a, b) => b.aiScore - a.aiScore).map((t) => ({ id: t.id, score: t.aiScore, reason: t.aiReason || "Ranked by Kora's priority model." }));
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

  /* ---------- activity feed ---------- */
  async listActivity(limit = 100): Promise<Activity[]> {
    if (!supabase) return demoActivity.slice(0, limit);
    const { data, error } = await supabase.from("activity").select("*").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data as ActivityRow[]).map(rowToActivity);
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
      .channel("kora-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "tags" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "subtasks" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "workspaces" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "workspace_members" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "attachments" }, onChange)
      .subscribe();
    return () => { client.removeChannel(channel); };
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
