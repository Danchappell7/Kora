/* ============================================================
   KORA — data store
   One interface, two adapters:
   - mock    : in-memory demo data (no backend needed)
   - supabase: real Postgres persistence
   Components depend only on the domain types, never the adapter.
   ============================================================ */
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import {
  TASKS, PROJECTS, energyOf, PLAN_TODAY_IDS, setReferenceData,
  PERSONAL_PROJECT, PERSONAL_WORKSPACE, BUILTIN_TAGS,
} from "./data";
import type { Task, Member, Project, Subtask, TagDef, Comment, Activity, ActivityKind, Status, Priority, EnergyKind } from "./types";

export interface Bootstrap {
  tasks: Task[];
  projects: Project[];
  tags: Record<string, TagDef>;
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
  return { ...t, energy: energyOf(t), dur: t.focusMin, scheduled: null, planToday: PLAN_TODAY_IDS.includes(t.id) };
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

/* demo-mode in-memory stores (session-only, like the rest of demo mode) */
const demoComments: Record<string, Comment[]> = {};
let demoActivity: Activity[] = [];

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
  };
}

const TASK_SELECT = "*, subtasks(*), task_dependencies(depends_on)";

/* ============================================================
   Public store API
   ============================================================ */
export const store = {
  configured: isSupabaseConfigured,

  async bootstrap(user: AuthedUser | null): Promise<Bootstrap> {
    if (!supabase) {
      // demo mode — seeded in-memory data + rich reference set, fixed "self" user
      return { tasks: TASKS.map(withPlanFields), projects: [...PROJECTS], tags: { ...BUILTIN_TAGS }, currentUserId: "m-self", defaultWorkspace: "ws-foundrise" };
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
    // tasks are required; projects + tags are best-effort so a missing table
    // (e.g. a migration not yet applied) can never leak demo reference data.
    const { data: taskData, error: tErr } = await supabase.from("tasks").select(TASK_SELECT).eq("user_id", uid);
    if (tErr) throw tErr;

    const { data: projData } = await supabase.from("projects").select("*").eq("user_id", uid);
    const projects = [PERSONAL_PROJECT, ...((projData as ProjectRow[] | null) ?? []).map(rowToProject)];

    // real accounts start with NO built-in tags — only the user's own.
    const { data: tagData } = await supabase.from("tags").select("*").eq("user_id", uid);
    const tags: Record<string, TagDef> = {};
    for (const t of (tagData as TagRow[] | null) ?? []) tags[t.id] = { label: t.label, color: t.color };

    setReferenceData({ members: [self], projects, workspaces: [PERSONAL_WORKSPACE], events: [], tags });
    return {
      tasks: (taskData as TaskRow[]).map(rowToTask),
      projects,
      tags,
      currentUserId: uid,
      defaultWorkspace: null,
    };
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
