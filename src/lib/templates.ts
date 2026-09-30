/* ============================================================
   KANBO — reusable task templates (stored locally per browser).
   A template captures the reusable shape of a task — name, priority,
   tags, focus estimate, recurrence, description — not project/assignee.

   Only the user's OWN templates are persisted; the built-ins are merged in
   on read. (Older builds wrote the built-ins into storage on every save, so
   reads also drop stored "builtin-" rows, de-duplicate by id and quietly
   write the cleaned list back.)
   ============================================================ */
import type { Priority, Recurrence, Task } from "../data/types";
import { toLocalISO } from "../data/data";

export interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  priority: Priority;
  tags: string[];
  focusMin: number;
  recurrence: Recurrence;
  description: string;
}

const KEY = "kanbo-templates";
/** how many of the user's own templates are kept (newest first) */
export const MAX_USER_TEMPLATES = 60;

const PRIORITIES: readonly Priority[] = ["low", "medium", "high", "urgent"];
const RECURRENCES: readonly Recurrence[] = ["none", "daily", "weekdays", "weekly", "biweekly", "monthly"];

export const isBuiltinTemplateId = (id: string): boolean => id.startsWith("builtin-");

// curated starting points shown in the template gallery (always available)
export const BUILTIN_TASK_TEMPLATES: TaskTemplate[] = [
  { id: "builtin-bug", name: "Bug report", title: "Bug: ", priority: "high", tags: [], focusMin: 30, recurrence: "none", description: "**Steps to reproduce**\n- \n\n**Expected**\n\n**Actual**" },
  { id: "builtin-meeting", name: "Meeting notes", title: "Meeting: ", priority: "medium", tags: [], focusMin: 30, recurrence: "none", description: "**Attendees**\n\n**Notes**\n\n**Action items**\n- " },
  { id: "builtin-brief", name: "Content brief", title: "Brief: ", priority: "medium", tags: [], focusMin: 60, recurrence: "none", description: "**Goal**\n\n**Audience**\n\n**Key points**\n- \n\n**Deadline**" },
  { id: "builtin-weekly", name: "Weekly review", title: "Weekly review", priority: "medium", tags: [], focusMin: 30, recurrence: "weekly", description: "**Wins**\n\n**Blockers**\n\n**Next week**" },
];

/* ---------- storage helpers (shared by task + project templates) ---------- */

function readList(key: string): unknown[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return null; // storage blocked or corrupt JSON
  }
}
function writeList(key: string, list: unknown[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* private mode / quota — ignore */ }
}
/** the user's own templates: valid rows only, no built-ins, one per id.
 *  Self-heals storage that an older build polluted. */
function readUserList<T extends { id: string }>(key: string, sanitize: (x: unknown) => T | null): T[] {
  const raw = readList(key);
  if (!raw) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of raw) {
    const t = sanitize(item);
    if (!t || isBuiltinTemplateId(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  if (out.length !== raw.length) writeList(key, out);
  return out;
}
const newTemplateId = (prefix: string) => prefix + Date.now() + "-" + Math.round(Math.random() * 1e5);
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** "Weekly report" → "Weekly report (2)" when the user already has a template
 *  with that name, so two saved from same-titled tasks can be told apart in the
 *  picker (built-ins sit in their own group, so they don't count) */
function uniqueName(name: string, taken: { name: string }[]): string {
  const base = name.trim() || name;
  if (!taken.some((x) => sameName(x.name, base))) return base;
  let n = 2;
  while (taken.some((x) => sameName(x.name, `${base} (${n})`))) n++;
  return `${base} (${n})`;
}

function sanitizeTaskTemplate(x: unknown): TaskTemplate | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.name !== "string" || !r.name.trim()) return null;
  const focus = typeof r.focusMin === "number" && Number.isFinite(r.focusMin) ? Math.max(5, Math.round(r.focusMin)) : 30;
  return {
    id: r.id,
    name: r.name,
    title: typeof r.title === "string" ? r.title : r.name,
    priority: PRIORITIES.includes(r.priority as Priority) ? (r.priority as Priority) : "medium",
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    focusMin: focus,
    recurrence: RECURRENCES.includes(r.recurrence as Recurrence) ? (r.recurrence as Recurrence) : "none",
    description: typeof r.description === "string" ? r.description : "",
  };
}

/* ---------- task templates ---------- */

/** the user's saved templates only (newest first) */
export function getUserTemplates(): TaskTemplate[] {
  return readUserList(KEY, sanitizeTaskTemplate);
}
/** built-ins first, then the user's own — ids are unique */
export function getTemplates(): TaskTemplate[] {
  return [...BUILTIN_TASK_TEMPLATES, ...getUserTemplates()];
}
/** Save a new template (newest first). Never overwrites an existing one: a
 *  name that's already taken gets a " (2)"-style suffix instead. */
export function saveTemplate(t: Omit<TaskTemplate, "id">): TaskTemplate {
  const mine = getUserTemplates();
  const tpl: TaskTemplate = { ...t, name: uniqueName(t.name, mine), id: newTemplateId("tpl-") };
  writeList(KEY, [tpl, ...mine].slice(0, MAX_USER_TEMPLATES));
  return tpl;
}
export function deleteTemplate(id: string): void {
  if (isBuiltinTemplateId(id)) return; // built-ins aren't stored, so can't be deleted
  writeList(KEY, getUserTemplates().filter((x) => x.id !== id));
}

/* ---------- project templates ---------- */
/** a starter task in a project template; due dates are relative to the day
 *  the project is created */
export interface ProjectBlueprintTask {
  title: string;
  section?: string;          // must match one of the template's `sections`
  priority?: Priority;
  dueInDays?: number;
  focusMin?: number;
  recurrence?: Recurrence;
  description?: string;
}
export interface ProjectTemplate {
  id: string; name: string; emoji: string; color: string;
  /** built-ins only: sections to create, in order */
  sections?: string[];
  /** built-ins only: starter tasks to create */
  tasks?: ProjectBlueprintTask[];
}
const PKEY = "kanbo-project-templates";

export const BUILTIN_PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "builtin-launch", name: "Product launch", emoji: "🚀", color: "#8B5CF6",
    sections: ["Plan", "Build", "Launch", "After launch"],
    tasks: [
      { section: "Plan", title: "Define launch goals and success metrics", priority: "high", dueInDays: 3, description: "**Goal**\n\n**How we'll measure it**\n- " },
      { section: "Plan", title: "Agree the launch date and owners", priority: "high", dueInDays: 5 },
      { section: "Plan", title: "Write positioning and key messages", dueInDays: 7 },
      { section: "Build", title: "Lock the release scope", priority: "high", dueInDays: 10 },
      { section: "Build", title: "Prepare launch assets (screenshots, video, copy)", dueInDays: 14, focusMin: 90 },
      { section: "Build", title: "Brief the support and sales teams", dueInDays: 17 },
      { section: "Launch", title: "Publish the announcement and update the website", priority: "urgent", dueInDays: 21 },
      { section: "Launch", title: "Send the launch email to customers", priority: "high", dueInDays: 21 },
      { section: "After launch", title: "Review launch metrics", dueInDays: 28 },
      { section: "After launch", title: "Run a launch retrospective", dueInDays: 30, description: "**What went well**\n\n**What didn't**\n\n**Next time**\n- " },
    ],
  },
  {
    id: "builtin-marketing", name: "Marketing campaign", emoji: "📣", color: "#C24BE0",
    sections: ["Brief", "Create", "Run", "Report"],
    tasks: [
      { section: "Brief", title: "Write the campaign brief", priority: "high", dueInDays: 2, description: "**Objective**\n\n**Audience**\n\n**Key message**\n\n**Budget**" },
      { section: "Brief", title: "Choose channels and set KPIs", dueInDays: 4 },
      { section: "Create", title: "Produce creative and copy", dueInDays: 10, focusMin: 120 },
      { section: "Create", title: "Set up tracking and UTM links", dueInDays: 12 },
      { section: "Run", title: "Launch the campaign", priority: "high", dueInDays: 14 },
      { section: "Run", title: "Mid-campaign performance check", dueInDays: 21 },
      { section: "Report", title: "Write up campaign results", dueInDays: 30 },
    ],
  },
  {
    id: "builtin-sprint", name: "Sprint", emoji: "🏃", color: "#5B7CFA",
    sections: ["Ceremonies", "Sprint backlog"],
    tasks: [
      { section: "Ceremonies", title: "Sprint planning", priority: "high", dueInDays: 0, focusMin: 60 },
      { section: "Ceremonies", title: "Agree the sprint goal", priority: "high", dueInDays: 0 },
      { section: "Ceremonies", title: "Sprint review and demo", dueInDays: 13, focusMin: 60 },
      { section: "Ceremonies", title: "Sprint retrospective", dueInDays: 14, focusMin: 45 },
    ],
  },
  {
    id: "builtin-content", name: "Content calendar", emoji: "🗓️", color: "#37c6a8",
    sections: ["Ideas", "Writing", "Scheduled", "Published"],
    tasks: [
      { section: "Ideas", title: "Brainstorm topics for the month", dueInDays: 2 },
      { section: "Writing", title: "Draft this week's post", dueInDays: 5, focusMin: 90, recurrence: "weekly" },
      { section: "Writing", title: "Edit and proofread", dueInDays: 6, recurrence: "weekly" },
      { section: "Scheduled", title: "Schedule social posts", dueInDays: 7, recurrence: "weekly" },
      { section: "Published", title: "Monthly content performance review", dueInDays: 30, recurrence: "monthly" },
    ],
  },
  {
    id: "builtin-bugs", name: "Bug tracker", emoji: "🐞", color: "#e5544b",
    sections: ["Triage", "Fixing", "Ready to verify"],
    tasks: [
      { section: "Triage", title: "Agree severity levels and response times", priority: "high", dueInDays: 3, description: "**P1** — broken for everyone, fix now\n**P2** — major feature broken\n**P3** — workaround exists\n**P4** — cosmetic" },
      { section: "Triage", title: "Weekly bug triage", dueInDays: 7, recurrence: "weekly", focusMin: 45 },
    ],
  },
];

/**
 * The starter tasks for a (built-in) project template, ready to persist.
 * Call after the project and its sections exist: `sectionIds` maps each
 * template section name to the created section's id (unmapped → no section).
 * Everything starts as to-do, assigned to `assigneeId`, with due dates counted
 * from `today`. Returns [] for templates without starter tasks.
 */
export function projectTemplateTasks(tpl: ProjectTemplate, ctx: {
  projectId: string;
  workspaceId: string | null;
  assigneeId: string;
  sectionIds?: Record<string, string>;
  today?: Date;
}): Task[] {
  const base = ctx.today ? new Date(ctx.today) : new Date();
  base.setHours(0, 0, 0, 0);
  const stamp = Date.now();
  return (tpl.tasks ?? []).map((bt, i) => {
    let dueDate: string | undefined;
    if (typeof bt.dueInDays === "number") { const d = new Date(base); d.setDate(d.getDate() + bt.dueInDays); dueDate = toLocalISO(d); }
    const focus = bt.focusMin ?? 30;
    const rnd = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${stamp}-${i}-${Math.round(Math.random() * 1e6)}`;
    return {
      id: "t-new-" + rnd,
      title: bt.title, description: bt.description ?? "",
      status: "todo", priority: bt.priority ?? "medium",
      projectId: ctx.projectId, workspaceId: ctx.workspaceId, assigneeId: ctx.assigneeId,
      sectionId: bt.section ? ctx.sectionIds?.[bt.section] : undefined,
      dueDate, tags: [], dependencies: [], subtasks: [], comments: 0,
      focusMin: focus, dur: focus, aiScore: 50, scheduled: null, planToday: false,
      recurrence: bt.recurrence ?? "none", position: stamp + i,
    };
  });
}

function sanitizeProjectTemplate(x: unknown): ProjectTemplate | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.name !== "string" || !r.name.trim()) return null;
  return {
    id: r.id,
    name: r.name,
    emoji: typeof r.emoji === "string" && r.emoji ? r.emoji : "📁",
    color: typeof r.color === "string" && r.color ? r.color : "oklch(0.74 0.14 230)",
  };
}

/** the user's saved project templates only (newest first) */
export function getUserProjectTemplates(): ProjectTemplate[] {
  return readUserList(PKEY, sanitizeProjectTemplate);
}
export function getProjectTemplates(): ProjectTemplate[] {
  return [...BUILTIN_PROJECT_TEMPLATES, ...getUserProjectTemplates()];
}
/** Save a new project template; like saveTemplate, never overwrites one. */
export function saveProjectTemplate(t: Omit<ProjectTemplate, "id">): ProjectTemplate {
  const mine = getUserProjectTemplates();
  const tpl: ProjectTemplate = { ...t, name: uniqueName(t.name, mine), id: newTemplateId("ptpl-") };
  writeList(PKEY, [tpl, ...mine].slice(0, MAX_USER_TEMPLATES));
  return tpl;
}
