/* ============================================================
   KANBO — templates: tasks, projects, team workspaces, and the
   task template library.
   • Task templates, per browser (kanbo-templates; the original kind):
     a task's reusable shape — name, priority, tags, focus estimate,
     recurrence, description. Only the user's OWN are persisted; the
     built-ins are merged in on read. (Older builds wrote the built-ins
     into storage on every save, so reads also drop stored "builtin-"
     rows, de-duplicate by id and quietly write the cleaned list back.)
     Since 0048 they move up into the library (adoptLocalTemplates) —
     only into the account this browser's data belongs to (auth/localData
     OWNER_KEY; kanbo-templates is one of its per-account keys, so it's
     dropped when someone else signs in here).
   • Project templates (kanbo-project-templates) and the built-in ones.
   • Team (workspace) templates [f10].
   • The task template library (public.task_templates, 0048) [u9]:
     see its own header at the end of this file.
   ============================================================ */
import type { Priority, Recurrence, Task, WorkspaceTemplate, WorkspacePlan, Project, Section, FormDef, FormFieldKey, AutomationRule, AutomationAction, AutomationTrigger, PlannedTask, TemplateProject, TemplateTask, LibraryTemplate, LibraryTemplateInput, LibraryTemplatePatch, TaskTemplateBody, TagDef, Subtask, TemplateAssigneeRole, TemplateSubtask } from "../data/types";
import { toLocalISO } from "../data/data";
import { spectrumColor } from "./projectIdentity";
import { supabase } from "./supabase";
import { addDays, daysBetween, parseDay, templateRecurrence, withRecurrence } from "./templatePlan";
import { OWNER_KEY } from "../auth/localData";
import { parseLibraryTemplate, parseTemplateBody, templateFailure, TEMPLATE_LIMITS } from "./templateRows";

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
/** false when the browser refused the write (private mode, or storage full) */
function writeList(key: string, list: unknown[]): boolean {
  try { localStorage.setItem(key, JSON.stringify(list)); return true; } catch { return false; }
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
  /** starter tasks to create: a built-in's, or a project's top-level tasks when saved from it */
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

/** how many starter tasks a saved project template keeps */
export const MAX_BLUEPRINT_TASKS = 100;
/** a saved task's notes are kept up to this length… */
export const MAX_BLUEPRINT_NOTES = 1000;
/** …and a template's text all told up to this, so templates (kept in this
 *  browser's storage, beside the offline queue) stay small */
export const MAX_BLUEPRINT_CHARS = 20000;

function sanitizeBlueprintTask(x: unknown): ProjectBlueprintTask | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.title !== "string" || !r.title.trim()) return null;
  const bt: ProjectBlueprintTask = { title: r.title.trim().slice(0, 500) };
  if (PRIORITIES.includes(r.priority as Priority)) bt.priority = r.priority as Priority;
  if (typeof r.focusMin === "number" && Number.isFinite(r.focusMin)) bt.focusMin = Math.max(5, Math.round(r.focusMin));
  if (typeof r.dueInDays === "number" && Number.isFinite(r.dueInDays)) bt.dueInDays = Math.max(0, Math.round(r.dueInDays));
  if (RECURRENCES.includes(r.recurrence as Recurrence) && r.recurrence !== "none") bt.recurrence = r.recurrence as Recurrence;
  if (typeof r.description === "string" && r.description) bt.description = r.description.slice(0, 5000);
  if (typeof r.section === "string" && r.section) bt.section = r.section;
  return bt;
}

function sanitizeProjectTemplate(x: unknown): ProjectTemplate | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.name !== "string" || !r.name.trim()) return null;
  const tpl: ProjectTemplate = {
    id: r.id,
    name: r.name,
    emoji: typeof r.emoji === "string" && r.emoji ? r.emoji : "📁",
    color: typeof r.color === "string" && r.color ? r.color : "oklch(0.74 0.14 230)",
  };
  // a template saved from a project carries its tasks (never its people or dates)
  const tasks = Array.isArray(r.tasks)
    ? r.tasks.map(sanitizeBlueprintTask).filter((t): t is ProjectBlueprintTask => !!t).slice(0, MAX_BLUEPRINT_TASKS)
    : [];
  if (tasks.length) tpl.tasks = tasks;
  return tpl;
}

/**
 * A project's work as a reusable blueprint: its top-level tasks in order
 * (titles, priorities, estimates, repeats and notes). People, dates, sections
 * and progress stay with the project, so a new project starts clean.
 */
export function projectBlueprint(tasks: Task[]): ProjectBlueprintTask[] {
  let budget = MAX_BLUEPRINT_CHARS;
  const out: ProjectBlueprintTask[] = [];
  const top = tasks
    .filter((t) => !t.parentId && !t.archivedAt && t.title.trim())
    .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  for (const t of top) {
    if (out.length >= MAX_BLUEPRINT_TASKS) break;
    const title = t.title.trim().slice(0, 200);
    if (title.length > budget) break;
    budget -= title.length;
    const bt: ProjectBlueprintTask = { title };
    if (t.priority && t.priority !== "medium") bt.priority = t.priority;
    if (t.focusMin && t.focusMin !== 30) bt.focusMin = t.focusMin;
    if (t.recurrence && t.recurrence !== "none") bt.recurrence = t.recurrence;
    // notes only while there's room: the titles are the template
    const notes = t.description?.trim().slice(0, MAX_BLUEPRINT_NOTES);
    if (notes && notes.length <= budget) { bt.description = notes; budget -= notes.length; }
    out.push(bt);
  }
  return out;
}

/** A project template by id: a built-in, or one the user saved. */
export function findProjectTemplate(id: string): ProjectTemplate | undefined {
  return getProjectTemplates().find((t) => t.id === id);
}

/** the user's saved project templates only (newest first) */
export function getUserProjectTemplates(): ProjectTemplate[] {
  return readUserList(PKEY, sanitizeProjectTemplate);
}
export function getProjectTemplates(): ProjectTemplate[] {
  return [...BUILTIN_PROJECT_TEMPLATES, ...getUserProjectTemplates()];
}
/** Save a new project template; like saveTemplate, never overwrites one.
 *  Returns null when this browser wouldn't store it (private mode, or full). */
export function storeProjectTemplate(t: Omit<ProjectTemplate, "id">): ProjectTemplate | null {
  const mine = getUserProjectTemplates();
  const tpl: ProjectTemplate = { ...t, name: uniqueName(t.name, mine), id: newTemplateId("ptpl-") };
  // tasks are cleaned on the way in too, not only when read back
  const tasks = (t.tasks ?? []).map(sanitizeBlueprintTask).filter((x): x is ProjectBlueprintTask => !!x).slice(0, MAX_BLUEPRINT_TASKS);
  if (tasks.length) tpl.tasks = tasks; else delete tpl.tasks;
  return writeList(PKEY, [tpl, ...mine].slice(0, MAX_USER_TEMPLATES)) ? tpl : null;
}
/** storeProjectTemplate for callers that don't need to know whether it was kept. */
export function saveProjectTemplate(t: Omit<ProjectTemplate, "id">): ProjectTemplate {
  const mine = getUserProjectTemplates();
  return storeProjectTemplate(t) ?? { ...t, name: uniqueName(t.name, mine), id: newTemplateId("ptpl-") };
}

/* ============================================================
   Team (workspace) templates.                              [f10-templates-plans]
   Four ready-made set-ups — Marketing, Operations, Product launch, Client
   services — each three projects (emoji + spectrum hue) with sections, 6–12
   starter tasks in all (three to five a project) with relative due dates and
   estimates, and one sample request form and one rule each. Every starter task
   is assigned to whoever uses the template, so it's a light start: only a few
   are due in the first week and only a few repeat. Shown by
   <TeamTemplatePicker> (New workspace, and Projects › New project › "From a
   team template"). Everything here is pure except applyWorkspacePlan, which
   is handed the create calls to make (the store's, or the app's own).
   ============================================================ */

const t = (section: string, title: string, dueInDays: number, effortHours: number, more: Partial<TemplateTask> = {}): TemplateTask =>
  ({ section, title, dueInDays, effortHours, ...more });

/** The built-in team templates, in gallery order. */
export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplate[] = Object.freeze([
  {
    id: "marketing", name: "Marketing", emoji: "📣", hue: "orchid",
    summary: "Campaigns from brief to report, a steady content calendar, and one front door for creative requests.",
    projects: [
      {
        key: "campaigns", name: "Campaigns", emoji: "📣", hue: "orchid",
        description: "Plan, launch and report on each campaign.",
        sections: ["Brief", "Create", "Live", "Report"],
        tasks: [
          t("Brief", "Write the brief for the next campaign", 3, 2, { priority: "high", focusMin: 60, description: "**Objective**\n\n**Audience**\n\n**Key message**\n\n**Budget**\n\n**Success looks like**" }),
          t("Create", "Draft copy and visuals for every channel", 10, 4, { focusMin: 90 }),
          t("Live", "Launch the campaign", 14, 1, { priority: "urgent" }),
          t("Report", "Write up results and lessons", 30, 2, { focusMin: 60 }),
        ],
      },
      {
        key: "content", name: "Content calendar", emoji: "✍️", hue: "coral",
        description: "What we publish, when, and how it did.",
        sections: ["Ideas", "Writing", "Scheduled", "Published"],
        tasks: [
          t("Ideas", "Plan next month's themes", 8, 1.5, { focusMin: 60 }),
          t("Writing", "Write the first newsletter", 12, 2, { focusMin: 60 }),
          t("Scheduled", "Schedule the week's social posts", 7, 1, { focusMin: 45, recurrence: "weekly" }),
        ],
        rule: { name: "New content starts in Ideas", trigger: "task_created", actions: [{ type: "set_section", value: "Ideas" }] },
      },
      {
        key: "requests", name: "Creative requests", emoji: "🎨", hue: "violet",
        description: "Design, copy and video asks from the rest of the business.",
        sections: ["New", "In progress", "Review", "Delivered"],
        tasks: [
          t("New", "Agree how requests are prioritised", 2, 1, { priority: "high", description: "**Same day**: broken or wrong on a live page\n**This week**: needed for a launch\n**Next sprint**: everything else" }),
          t("New", "Share the request form with the team", 4, 0.5),
          t("In progress", "Write a one-page brand guide", 15, 3, { focusMin: 90 }),
        ],
        form: { name: "Creative request", description: "Ask for a design, copy or a video. Say what it's for and when you need it.", fields: ["description", "priority", "dueDate"] },
      },
    ],
  },
  {
    id: "operations", name: "Operations", emoji: "⚙️", hue: "cobalt",
    summary: "The routines that keep the lights on, hiring and onboarding, and a help desk for IT and office requests.",
    projects: [
      {
        key: "routines", name: "Business routines", emoji: "🗓️", hue: "sky",
        description: "The weekly, monthly and quarterly jobs nobody should have to remember.",
        sections: ["This week", "This month", "This quarter"],
        tasks: [
          t("This week", "Weekly operations check-in", 2, 0.5, { recurrence: "weekly" }),
          t("This month", "Run payroll", 10, 1.5, { priority: "high", focusMin: 60, recurrence: "monthly" }),
          t("This month", "Review software subscriptions and seats", 16, 1, { focusMin: 45 }),
          t("This quarter", "Plan next quarter's budget", 45, 4, { priority: "high", focusMin: 120 }),
        ],
      },
      {
        key: "people", name: "Hiring & onboarding", emoji: "🤝", hue: "jade",
        description: "From job description to a new starter's first month.",
        sections: ["Hiring", "Before day one", "First weeks"],
        tasks: [
          t("Hiring", "Write the job description and scorecard", 5, 2, { priority: "high", focusMin: 60 }),
          t("Before day one", "Order equipment and set up accounts", 20, 1.5),
          t("First weeks", "Hold the 30-day check-in", 51, 0.5),
        ],
      },
      {
        key: "helpdesk", name: "IT & office requests", emoji: "🛠️", hue: "amber",
        description: "Anything broken, missing or needed, in one place.",
        sections: ["New", "Doing", "Waiting", "Done"],
        tasks: [
          t("New", "Triage new requests", 3, 0.5, { recurrence: "weekly" }),
          t("New", "List every tool, its owner and renewal date", 9, 2, { priority: "high", focusMin: 60 }),
          t("Doing", "Turn on two-step sign-in for every account", 14, 3, { priority: "high", focusMin: 90 }),
        ],
        form: { name: "IT or office request", description: "Something broken, missing or needed? Tell us what's up and how urgent it is.", fields: ["description", "priority"] },
        rule: { name: "New requests land in New", trigger: "task_created", actions: [{ type: "set_section", value: "New" }] },
      },
    ],
  },
  {
    id: "launch", name: "Product launch", emoji: "🚀", hue: "violet",
    summary: "A launch plan with dates and owners, a release checklist for go / no-go, and a loop for feedback and fixes.",
    projects: [
      {
        key: "plan", name: "Launch plan", emoji: "🚀", hue: "violet",
        description: "Goals, messages, assets and the day itself.",
        sections: ["Plan", "Build", "Launch", "After launch"],
        tasks: [
          t("Plan", "Set launch goals, the date and owners", 3, 2, { priority: "high", focusMin: 60, description: "**Goal**\n\n**How we'll measure it**\n- \n\n**Launch date**\n\n**Owners**\n- " }),
          t("Plan", "Write positioning and key messages", 8, 3, { focusMin: 90 }),
          t("Build", "Prepare launch assets (screenshots, video, copy)", 14, 4, { focusMin: 120 }),
          t("Launch", "Publish the announcement and email customers", 21, 2, { priority: "urgent" }),
          t("After launch", "Run the launch retrospective", 30, 1.5, { focusMin: 60, description: "**What went well**\n\n**What didn't**\n\n**Next time**\n- " }),
        ],
      },
      {
        key: "release", name: "Release readiness", emoji: "✅", hue: "jade",
        description: "Everything that has to be true before we press go.",
        sections: ["Engineering", "Quality", "Go / no-go"],
        tasks: [
          t("Engineering", "Freeze features and write the rollback plan", 12, 2, { priority: "high", focusMin: 60 }),
          t("Quality", "Run the regression and accessibility checks", 16, 5, { focusMin: 120 }),
          t("Go / no-go", "Hold the go / no-go meeting", 19, 1, { priority: "urgent", focusMin: 45 }),
        ],
      },
      {
        key: "feedback", name: "Feedback & fixes", emoji: "💬", hue: "sky",
        description: "What customers tell us after launch, and what we do about it.",
        sections: ["Triage", "Fixing", "Shipped"],
        tasks: [
          t("Triage", "Agree severity levels and response times", 17, 1, { priority: "high", description: "**P1**: broken for everyone, fix now\n**P2**: a key flow is broken\n**P3**: there's a workaround\n**P4**: cosmetic" }),
          t("Fixing", "Fix the top three launch issues", 25, 4, { priority: "high", focusMin: 120 }),
          t("Shipped", "Tell customers what we fixed", 30, 1),
        ],
        form: { name: "Report a problem or idea", description: "Found a bug or have an idea? Tell us what happened and where.", fields: ["description", "priority"] },
        rule: { name: "New reports start in Triage", trigger: "task_created", actions: [{ type: "set_section", value: "Triage" }] },
      },
    ],
  },
  {
    id: "clients", name: "Client services", emoji: "💼", hue: "lagoon",
    summary: "Onboard and look after clients, deliver the work through review and sign-off, and keep their requests in one queue.",
    projects: [
      {
        key: "accounts", name: "Client accounts", emoji: "💼", hue: "lagoon",
        description: "Onboarding, regular check-ins and renewals.",
        sections: ["Onboarding", "Active", "Renewals"],
        tasks: [
          t("Onboarding", "Send the welcome pack and kickoff agenda", 1, 1, { priority: "high" }),
          t("Onboarding", "Hold the kickoff call", 3, 1.5, { priority: "high", focusMin: 60, description: "**Goals**\n\n**Contacts**\n\n**Ways of working**\n\n**Next steps**" }),
          t("Active", "Send the weekly status email", 9, 0.5, { recurrence: "weekly" }),
          t("Renewals", "Prepare the quarterly business review", 60, 4, { focusMin: 120 }),
        ],
      },
      {
        key: "delivery", name: "Delivery", emoji: "📦", hue: "coral",
        description: "Each piece of client work from scope to sign-off.",
        sections: ["Scoping", "In progress", "Client review", "Delivered"],
        tasks: [
          t("Scoping", "Confirm the scope and acceptance criteria", 8, 2, { priority: "high", focusMin: 60 }),
          t("In progress", "Deliver the first draft", 15, 6, { priority: "high", focusMin: 120 }),
          t("Client review", "Get written sign-off", 22, 0.5, { priority: "high" }),
          t("Delivered", "Invoice and send the wrap-up note", 23, 1),
        ],
      },
      {
        key: "requests", name: "Client requests", emoji: "📨", hue: "amber",
        description: "Changes, reports and questions from clients, in one queue.",
        sections: ["New", "Doing", "Waiting on client", "Done"],
        tasks: [
          t("New", "Agree response times with each client", 4, 1, { priority: "high", description: "**Urgent**: the same working day\n**Normal**: within two working days\n**Small changes**: batched each week" }),
          t("Doing", "Share the request form with each client", 9, 0.5),
          t("Waiting on client", "Chase answers that are holding up work", 11, 0.5, { recurrence: "weekly" }),
        ],
        form: { name: "Client request", description: "Need a change, a report or some help? Tell us what you need and by when.", fields: ["description", "priority", "dueDate"] },
        rule: { name: "New requests land in New", trigger: "task_created", actions: [{ type: "set_section", value: "New" }] },
      },
    ],
  },
] satisfies WorkspaceTemplate[]);

export function findWorkspaceTemplate(id: string): WorkspaceTemplate | undefined {
  return WORKSPACE_TEMPLATES.find((t) => t.id === id);
}

/** What a template (or some of its projects) sets up, for the gallery. */
export function templateStats(template: Pick<WorkspaceTemplate, "projects">, projectKeys?: readonly string[]): { projects: number; tasks: number; forms: number; rules: number } {
  const ps = projectKeys ? template.projects.filter((p) => projectKeys.includes(p.key)) : template.projects;
  return {
    projects: ps.length,
    tasks: ps.reduce((n, p) => n + p.tasks.length, 0),
    forms: ps.filter((p) => !!p.form).length,
    rules: ps.filter((p) => !!p.rule).length,
  };
}

/** A day (local midnight) from a Date or "YYYY-MM-DD"; today if it can't be read. */
function dayOf(today: Date | string): Date {
  let d: Date;
  if (typeof today === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(today);
    d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(NaN);
  } else d = new Date(today);
  if (Number.isNaN(d.getTime())) d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
/** `days` after `base`, moved off a weekend to the Monday after (team work is due on a working day). */
function workingDayAfter(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  const wd = d.getDay();
  if (wd === 6) d.setDate(d.getDate() + 2);
  else if (wd === 0) d.setDate(d.getDate() + 1);
  return toLocalISO(d);
}
const RECUR_OK: readonly Recurrence[] = ["none", "daily", "weekdays", "weekly", "biweekly", "monthly"];

function planTask(tt: TemplateTask, sections: readonly string[], base: Date): PlannedTask {
  const focus = typeof tt.focusMin === "number" && Number.isFinite(tt.focusMin) ? Math.max(5, Math.round(tt.focusMin)) : 30;
  const out: PlannedTask = {
    title: tt.title.trim(),
    description: tt.description ?? "",
    priority: PRIORITIES.includes(tt.priority as Priority) ? tt.priority! : "medium",
    focusMin: focus,
    recurrence: RECUR_OK.includes(tt.recurrence as Recurrence) ? tt.recurrence! : "none",
  };
  if (tt.section && sections.includes(tt.section)) out.section = tt.section;
  if (typeof tt.dueInDays === "number" && Number.isFinite(tt.dueInDays)) out.dueDate = workingDayAfter(base, Math.max(0, Math.round(tt.dueInDays)));
  if (typeof tt.effortHours === "number" && Number.isFinite(tt.effortHours) && tt.effortHours > 0) out.effortHours = Math.round(tt.effortHours * 4) / 4;
  return out;
}
function planProject(p: TemplateProject, base: Date) {
  const sections = [...new Set(p.sections.map((s) => s.trim()).filter(Boolean))];
  return {
    key: p.key, name: p.name, emoji: p.emoji, color: spectrumColor(p.hue),
    ...(p.description ? { description: p.description } : {}),
    sections,
    tasks: p.tasks.filter((x) => x.title.trim()).map((x) => planTask(x, sections, base)),
    ...(p.form ? { form: { ...p.form, fields: [...p.form.fields] } } : {}),
    ...(p.rule ? { rule: { ...p.rule, actions: p.rule.actions.map((a) => ({ ...a })) } } : {}),
  };
}

/** Pure: a template made concrete for a day — colours from the hue
 *  (spectrumColor), due dates counted from `today` (one landing on a weekend
 *  moves to the Monday), defaults filled in (medium priority, 30-minute focus,
 *  no repeat). `projectKeys` keeps only those projects, in the template's
 *  order (all when omitted). */
export function buildWorkspaceFromTemplate(template: WorkspaceTemplate, today: Date | string, opts: { projectKeys?: string[] } = {}): WorkspacePlan {
  const base = dayOf(today);
  const keep = opts.projectKeys ? new Set(opts.projectKeys) : null;
  return {
    templateId: template.id,
    name: template.name,
    projects: template.projects.filter((p) => !keep || keep.has(p.key)).map((p) => planProject(p, base)),
  };
}

/** What applying a plan needs (App passes its own create callbacks, or the
 *  store's bound to the signed-in user — store.templateDeps — both keep demo
 *  mode working). */
export interface TemplateApplyDeps {
  createProject(input: { name: string; emoji: string; color: string; workspaceId: string | null; description?: string }): Promise<Project>;
  createSection(input: { projectId: string; workspaceId: string | null; name: string; position?: number }): Promise<Section>;
  createTasks(tasks: Task[]): Promise<Task[]>;
  createForm?(input: { workspaceId: string | null; projectId: string; name: string; fields: FormFieldKey[]; description?: string }): Promise<FormDef>;
  createRule?(input: { workspaceId: string | null; projectId: string; name: string; actions: AutomationAction[]; trigger?: AutomationTrigger }): Promise<AutomationRule>;
}

/** Everything a plan created (for the caller's own state) and what it couldn't. */
export interface AppliedPlan {
  projects: Project[];
  sections: Section[];
  tasks: Task[];
  forms: FormDef[];
  rules: AutomationRule[];
  /** what couldn't be created, by name ("Campaigns", "Campaigns › Brief", a task's title, a form's or rule's name) */
  failed: string[];
}

const newTaskUuid = (i: number): string =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `t-new-${Date.now()}-${i}-${Math.round(Math.random() * 1e6)}`;

/** Create a plan's projects, sections, tasks (assigned to `assigneeId`), forms
 *  and rules, in that order, one project at a time. A step that fails is
 *  reported in `failed` (by name) and the rest carry on — never a
 *  half-silent failure. (A project that can't be created takes its sections,
 *  tasks, form and rule with it, reported as the project.) Starter tasks are
 *  to-do, not on anyone's day, and a rule is created after its project's
 *  tasks, so it only ever acts on new work. */
export async function applyWorkspacePlan(plan: WorkspacePlan, ctx: { workspaceId: string | null; assigneeId: string }, deps: TemplateApplyDeps): Promise<AppliedPlan> {
  const out: AppliedPlan = { projects: [], sections: [], tasks: [], forms: [], rules: [], failed: [] };
  const stamp = Date.now();
  let n = 0;
  for (const pp of plan.projects) {
    let project: Project;
    try {
      project = await deps.createProject({ name: pp.name, emoji: pp.emoji, color: pp.color, workspaceId: ctx.workspaceId, ...(pp.description ? { description: pp.description } : {}) });
    } catch { out.failed.push(pp.name); continue; }
    out.projects.push(project);
    const ws = project.workspaceId ?? ctx.workspaceId;

    const sectionIds: Record<string, string> = {};
    for (const [i, name] of pp.sections.entries()) {
      try {
        const sec = await deps.createSection({ projectId: project.id, workspaceId: ws, name, position: i + 1 });
        out.sections.push(sec);
        sectionIds[name] = sec.id;
      } catch { out.failed.push(`${pp.name} › ${name}`); }
    }

    const built: Task[] = pp.tasks.map((pt) => {
      const i = n++;
      return {
        id: newTaskUuid(i), title: pt.title, description: pt.description,
        status: "todo", priority: pt.priority,
        projectId: project.id, workspaceId: ws, assigneeId: ctx.assigneeId,
        sectionId: pt.section ? sectionIds[pt.section] : undefined,
        dueDate: pt.dueDate, effortHours: pt.effortHours,
        tags: [], dependencies: [], subtasks: [], comments: 0, followers: [], collaborators: [],
        focusMin: pt.focusMin, dur: pt.focusMin, aiScore: 50, scheduled: null, planToday: false,
        recurrence: pt.recurrence, position: stamp + i,
      };
    });
    if (built.length) {
      try { out.tasks.push(...await deps.createTasks(built)); }
      catch (e) {
        // a partial save says which went in (store.createTasksBatch's BatchCreateError)
        const be = e as { saved?: unknown; failed?: unknown };
        const saved = Array.isArray(be?.saved) ? (be.saved as Task[]) : [];
        out.tasks.push(...saved);
        const savedIds = new Set(saved.map((x) => x.id));
        const lost = Array.isArray(be?.failed)
          ? (be.failed as { task?: Task }[]).map((f) => f.task?.title).filter((x): x is string => !!x)
          : built.filter((b) => !savedIds.has(b.id)).map((b) => b.title);
        out.failed.push(...lost);
      }
    }

    if (pp.form && deps.createForm) {
      try { out.forms.push(await deps.createForm({ workspaceId: ws, projectId: project.id, name: pp.form.name, fields: [...pp.form.fields], ...(pp.form.description ? { description: pp.form.description } : {}) })); }
      catch { out.failed.push(pp.form.name); }
    }
    if (pp.rule && deps.createRule) {
      // a section action names its section: it needs that section to exist
      const actions = pp.rule.actions
        .map((a) => (a.type === "set_section" ? (sectionIds[a.value] ? { ...a, value: sectionIds[a.value] } : null) : { ...a }))
        .filter((a): a is AutomationAction => !!a);
      if (!actions.length) out.failed.push(pp.rule.name);
      else {
        try { out.rules.push(await deps.createRule({ workspaceId: ws, projectId: project.id, name: pp.rule.name, actions, trigger: pp.rule.trigger })); }
        catch { out.failed.push(pp.rule.name); }
      }
    }
  }
  return out;
}

/** The toast after applying a plan: what was set up, or what wasn't. */
export function appliedPlanMessage(plan: Pick<WorkspacePlan, "name">, r: Pick<AppliedPlan, "projects" | "tasks" | "failed">): { tone: "success" | "info" | "error"; text: string } {
  const projects = `${r.projects.length} ${r.projects.length === 1 ? "project" : "projects"}`;
  const tasks = `${r.tasks.length} starter ${r.tasks.length === 1 ? "task" : "tasks"}`;
  if (!r.projects.length) return { tone: "error", text: `Couldn't set up ${plan.name}. Check your connection and try again.` };
  if (!r.failed.length) return { tone: "success", text: `${plan.name} is ready: ${projects} and ${tasks}.` };
  const shown = r.failed.slice(0, 3).map((x) => `“${x}”`).join(", ");
  const more = r.failed.length > 3 ? ` and ${r.failed.length - 3} more` : "";
  return { tone: "info", text: `${plan.name} is set up with ${projects} and ${tasks}, but ${shown}${more} couldn't be added. You can add ${r.failed.length === 1 ? "it" : "them"} by hand.` };
}


/* ======================================================================
   The team template library (public.task_templates, 0048).  [0048 contract → u9]
   Personal or shared with the workspace (the same rules as saved views:
   your own + the workspace's shared ones; writers share; owners/admins
   manage shared ones; guests use shared ones read-only). Eight built-ins
   (LIBRARY_BUILTINS: Client onboarding, Bug report, Weekly report, Hiring
   loop, Content piece, Event checklist, Expense claim, Contract review).
   The per-browser templates above (kanbo-templates) move up once
   (adoptLocalTemplates) and keep working offline / in demo mode.
   Apply = the task + its sub-tasks with dates relative to the day it's
   applied, assignees by role (me / the project's owner / unassigned), the
   checklist as checklist items. In QuickCapture / NewTaskModal: type
   "/template" or "/" to pick (fuzzy), or the New task split menu.

   The model, in one place:
   • Every date in a template is "days after it's used" (day 0 = the day
     it's applied): the task's own due date (dueOffsetDays) and each
     sub-task's (offsetDays). Pick a different due date for the task when
     applying and the sub-tasks move with it (day 0 = that date less the
     template's own offset), so a plan that works back from a deadline
     keeps its shape. A date that lands before today is due today; one
     that lands on a weekend moves to the Monday after — or, for a
     sub-task, to the Friday before when that Monday is past the task's
     own due date. A due date picked by hand is never moved.
   • Roles: "me" = whoever applies it, "project_owner" = the owner of the
     project it lands in (you, when it has none, or in Personal),
     "unassigned" = nobody (you, in Personal). A missing role is "me".
   • Which templates you see: yours (wherever you made them), the shared
     ones of the workspace you're in, and the built-ins. A template made
     in a team workspace belongs to it (workspace_id never changes), so
     only those can be shared there; one of yours from elsewhere can be
     shared as a copy.
   • Tags are kept by label as well as id, so a template finds "Design"
     in whichever workspace it's used.
   • A template can repeat (body.recurrence, lib/templatePlan
     templateRecurrence): the task it makes repeats the same way, unless a
     repeat was already chosen. The per-browser ones keep theirs when they
     move up.
   ====================================================================== */
export { parseLibraryTemplate, parseTemplateBody, templateFailure, TEMPLATE_LIMITS };

export const TEMPLATE_COLUMNS = "id,workspace_id,user_id,name,emoji,body,shared,created_at,updated_at";

/* the "/" picker, the words and applying one live in lib/templatePlan (small, pure) */
export {
  templatePlaceholders, templateSpanDays, templateMeta, templateDayLabel, templateRoleLabel,
  templateQueryOf, matchTemplates, resolveTemplateTags, roleAssignee, templateDayZero, planTemplate, templateTasks,
  templateRecurrence, withRecurrence, templateRepeatLabel,
  type AppliedTemplatePlan, type RepeatingTemplateBody,
} from "./templatePlan";


/** an id the library made up for a built-in (not stored) */
export const isLibraryBuiltinId = (id: string): boolean => id.startsWith("builtin-lib-");
/** a template that only lives in this browser (kanbo-templates, before it moved up) */
export const isLocalTemplateId = (id: string): boolean => /^tpl-\d/.test(id);

const lib = (
  slug: string, name: string, emoji: string, body: TaskTemplateBody,
): LibraryTemplate => ({
  id: `builtin-lib-${slug}`, workspaceId: null, userId: "", name, emoji, body, shared: false, createdAt: "", updatedAt: "", builtin: true,
});
const sub = (title: string, offsetDays: number, assigneeRole: TemplateAssigneeRole = "me"): TemplateSubtask => ({ title, offsetDays, assigneeRole });

/** the 8 built-ins (ids "builtin-lib-…"; not stored; British English) */
export const LIBRARY_BUILTINS: readonly LibraryTemplate[] = Object.freeze([
  lib("client-onboarding", "Client onboarding", "🤝", {
    title: "Onboard {client}", priority: "high", estimate: 60, dueOffsetDays: 14,
    description: "**Client**\n\n**Main contact**\n\n**What they've bought**\n\n**Goals for the first 90 days**\n- ",
    subtasks: [
      sub("Send the welcome email and kick-off agenda", 1),
      sub("Hold the kick-off call", 3, "project_owner"),
      sub("Set up their shared folder and project space", 3),
      sub("Collect logins, brand assets and contacts", 5, "unassigned"),
      sub("Agree the first milestones in writing", 7, "project_owner"),
      sub("Book the 30-day check-in", 14),
    ],
    checklist: ["Contract signed", "Purchase order received", "Invoice details confirmed", "Added to the CRM", "Welcome pack sent"],
  }),
  lib("bug-report", "Bug report", "🐞", {
    title: "Bug: {summary}", priority: "high", estimate: 60, dueOffsetDays: 3, tags: ["Bug"],
    description: "**Steps to reproduce**\n- \n\n**What should happen**\n\n**What happens instead**\n\n**Where**\nBrowser, device and version:\n\n**Who it affects**",
    subtasks: [
      sub("Reproduce it and note the exact steps", 0),
      sub("Find the cause", 1),
      sub("Fix it and add a test", 2),
      sub("Review the fix", 3, "project_owner"),
      sub("Let whoever reported it know", 3),
    ],
    checklist: ["Severity agreed", "Screenshot or recording attached", "Fix checked on staging", "Release note written"],
  }),
  lib("weekly-report", "Weekly report", "📊", {
    title: "Weekly report", priority: "medium", estimate: 45, dueOffsetDays: 1,
    description: "**Highlights**\n- \n\n**Numbers**\n- \n\n**Risks and blockers**\n- \n\n**Next week**\n- ",
    subtasks: [
      sub("Ask the team for their updates", 0),
      sub("Pull this week's numbers", 0),
      sub("Draft the report", 1),
      sub("Share it with the team", 1),
    ],
    checklist: ["Numbers checked against last week", "Every blocker has an owner", "Links work"],
  }),
  lib("hiring-loop", "Hiring loop", "🧑‍💼", {
    title: "Hire a {role}", priority: "high", estimate: 90, dueOffsetDays: 35,
    description: "**Role**\n\n**Hiring manager**\n\n**Salary range**\n\n**Must-haves**\n- \n\n**Nice-to-haves**\n- ",
    subtasks: [
      sub("Write the job description and scorecard", 2),
      sub("Agree the interview panel and questions", 4, "project_owner"),
      sub("Advertise the role and share it with the team", 5),
      sub("Shortlist candidates", 14),
      sub("Run first interviews", 21, "unassigned"),
      sub("Run final interviews", 28, "project_owner"),
      sub("Take up references", 31),
      sub("Make the offer", 33, "project_owner"),
    ],
    checklist: ["Budget approved", "Scorecard shared with the panel", "Interview slots blocked out", "Every candidate has had a reply", "Start date agreed"],
  }),
  lib("content-piece", "Content piece", "✍️", {
    title: "Write: {topic}", priority: "medium", estimate: 120, dueOffsetDays: 10, tags: ["Writing"],
    description: "**Audience**\n\n**The one thing they should take away**\n\n**Call to action**\n\n**Keywords**\n- ",
    subtasks: [
      sub("Write the brief and outline", 1),
      sub("Write the first draft", 4),
      sub("Edit and fact-check", 6, "unassigned"),
      sub("Make the images", 7, "unassigned"),
      sub("Final sign-off", 8, "project_owner"),
      sub("Publish and share it", 10),
    ],
    checklist: ["Headline under 70 characters", "Meta description written", "Alt text on every image", "Links checked", "Spelling set to British English"],
  }),
  lib("event-checklist", "Event checklist", "🎉", {
    title: "Plan {event}", priority: "medium", estimate: 60, dueOffsetDays: 28,
    description: "**Date and time**\n\n**Venue**\n\n**Budget**\n\n**Guests**\n\n**Who's helping**\n- ",
    subtasks: [
      sub("Set the budget and guest list", 1),
      sub("Book the venue", 3),
      sub("Send save-the-dates", 5),
      sub("Book the catering", 10, "unassigned"),
      sub("Send the invitations", 14),
      sub("Confirm numbers and dietary needs", 24),
      sub("Brief everyone helping on the day", 26, "project_owner"),
      sub("Send thank-yous and photos", 30),
    ],
    checklist: ["Step-free access and a quiet room", "Insurance confirmed", "Name badges printed", "First-aid kit packed", "Running order shared"],
  }),
  lib("expense-claim", "Expense claim", "🧾", {
    title: "Expense claim: {period}", priority: "medium", estimate: 30, dueOffsetDays: 5,
    description: "**Period**\n\n**Cost centre**\n\n**Total (£)**\n\nAttach a receipt for every item.",
    subtasks: [
      sub("Gather the receipts", 0),
      sub("Fill in the claim form", 1),
      sub("Get it approved", 3, "project_owner"),
      sub("Send it to finance", 5),
    ],
    checklist: ["Every item has a receipt", "VAT shown where it applies", "Mileage logged with dates and postcodes", "Nothing personal included"],
  }),
  lib("contract-review", "Contract review", "📄", {
    title: "Review contract: {counterparty}", priority: "high", estimate: 90, dueOffsetDays: 7,
    description: "**Counterparty**\n\n**Contract type**\n\n**Value and term**\n\n**Renewal or notice date**\n\n**Concerns**\n- ",
    subtasks: [
      sub("Read it end to end and note questions", 1),
      sub("Check liability, termination and renewal terms", 2),
      sub("Check the data protection and confidentiality clauses", 2, "unassigned"),
      sub("Send our changes to the other side", 4),
      sub("Get sign-off", 6, "project_owner"),
      sub("Sign it and file the final copy", 7),
    ],
    checklist: ["Legal entity names are right", "Payment terms agreed", "Notice period in the calendar", "Signed copy saved", "Renewal reminder set"],
  }),
]);

/* ---------- the body: cleaning, size, words ---------- */

const ROLES: readonly TemplateAssigneeRole[] = ["me", "project_owner", "unassigned"];
const MAX_OFFSET_DAYS = 365;
const MAX_ITEM_CHARS = 500;
const clampDays = (n: number) => Math.min(MAX_OFFSET_DAYS, Math.max(0, Math.round(n)));
const graphemes = (s: string) => [...s].length;

/** How big a body is when stored, never under: its JSON's bytes plus jsonb's own overhead (the
 *  database checks pg_column_size(body), which runs ~10 bytes an element over the JSON text —
 *  measured in the PGlite replay, scratchpad/pgtest-u9: a 50-sub-task body is ~1.2 KB bigger). */
export function templateBodyBytes(body: TaskTemplateBody): number {
  const json = JSON.stringify(body);
  const text = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(json).length : json.length * 3;
  return text + 64 + 24 * (body.subtasks?.length ?? 0) + 8 * ((body.checklist?.length ?? 0) + (body.tags?.length ?? 0));
}

/** A body as the database will take it: trimmed, clamped (lib/templateRows limits),
 *  days 0–365, estimates 5 minutes to a day, no empty sub-tasks or items, how it
 *  repeats (if it does). A title ending in spaces keeps one ("Bug: " is typed
 *  on from when it's used); one that's only spaces is empty. */
export function cleanTemplateBody(raw: TaskTemplateBody): TaskTemplateBody {
  const parsed = parseTemplateBody(raw) ?? { title: "" };
  const lead = parsed.title.trimStart();
  const out: TaskTemplateBody = { title: lead.trim() ? lead.replace(/\s+$/, " ").slice(0, TEMPLATE_LIMITS.title) : "" };
  // (kept as written: a trailing "- " is an empty bullet waiting to be filled)
  if (parsed.description && parsed.description.trim()) out.description = parsed.description;
  if (parsed.priority) out.priority = parsed.priority;
  if (typeof parsed.estimate === "number") out.estimate = Math.min(24 * 60, Math.max(5, parsed.estimate));
  const tags = [...new Set((parsed.tags ?? []).map((t) => t.trim()).filter(Boolean))];
  if (tags.length) out.tags = tags;
  if (typeof parsed.dueOffsetDays === "number") out.dueOffsetDays = clampDays(parsed.dueOffsetDays);
  const subs = (parsed.subtasks ?? []).map((s): TemplateSubtask | null => {
    const title = s.title.trim().slice(0, MAX_ITEM_CHARS);
    if (!title) return null;
    const x: TemplateSubtask = { title };
    if (typeof s.offsetDays === "number") x.offsetDays = clampDays(s.offsetDays);
    if (s.assigneeRole && ROLES.includes(s.assigneeRole)) x.assigneeRole = s.assigneeRole;
    return x;
  }).filter((x): x is TemplateSubtask => !!x);
  if (subs.length) out.subtasks = subs;
  const items = (parsed.checklist ?? []).map((c) => c.trim().slice(0, MAX_ITEM_CHARS)).filter(Boolean);
  if (items.length) out.checklist = items;
  return withRecurrence(out, templateRecurrence(raw));
}

/** A stored body (task_templates.body) with how it repeats, which lib/templateRows doesn't read. */
function bodyOf(raw: unknown): TaskTemplateBody | null {
  const b = parseTemplateBody(raw);
  return b ? withRecurrence(b, templateRecurrence(raw)) : null;
}
/** A task_templates row → LibraryTemplate (lib/templateRows), with how its body repeats. */
function rowOf(raw: unknown): LibraryTemplate | null {
  const t = parseLibraryTemplate(raw);
  const rec = t && raw && typeof raw === "object" ? templateRecurrence((raw as { body?: unknown }).body) : undefined;
  return t && rec ? { ...t, body: withRecurrence(t.body, rec) } : t;
}

export type TemplateProblem = "name" | "emoji" | "title" | "too_big" | "share_needs_workspace";
/** What's wrong with a template before it's sent (null = nothing). */
export function templateProblem(input: { name: string; emoji?: string | null; body: TaskTemplateBody; shared?: boolean; workspaceId?: string | null }): TemplateProblem | null {
  const name = input.name.trim();
  if (!name || name.length > TEMPLATE_LIMITS.name) return "name";
  if (input.emoji && graphemes(input.emoji) > TEMPLATE_LIMITS.emoji) return "emoji";
  if (!input.body.title.trim()) return "title";
  if (templateBodyBytes(input.body) > TEMPLATE_LIMITS.bodyBytes) return "too_big";
  if (input.shared && !input.workspaceId) return "share_needs_workspace";
  return null;
}
const problemError = (p: TemplateProblem) => new Error(p === "too_big" ? "invalid template: too big" : `invalid template ${p}`);

/* ---------- who may do what (the server enforces the same) ---------- */

export interface TemplateViewer {
  userId: string;
  /** the workspace being looked at (null = Personal) */
  workspaceId: string | null;
  /** writers in a team workspace */
  canShare: boolean;
  /** owners/admins: edit / delete shared ones they didn't make */
  canManageShared?: boolean;
}
export interface TemplateRights {
  edit: boolean;
  delete: boolean;
  /** turn sharing on/off in place (yours, made in this workspace) */
  share: boolean;
  /** yours from elsewhere: share a copy with this workspace instead */
  shareCopy: boolean;
}
export function templateRights(t: Pick<LibraryTemplate, "id" | "userId" | "workspaceId" | "shared" | "builtin">, me: TemplateViewer): TemplateRights {
  const none = { edit: false, delete: false, share: false, shareCopy: false };
  if (t.builtin || isLibraryBuiltinId(t.id)) return none;
  if (isLocalTemplateId(t.id)) return { ...none, delete: true };
  const own = !!me.userId && t.userId === me.userId;
  const manage = !own && t.shared && t.workspaceId !== null && t.workspaceId === me.workspaceId && !!me.canManageShared;
  const team = me.workspaceId !== null && me.canShare;
  return {
    edit: own || manage,
    delete: own || manage,
    share: own && team && t.workspaceId === me.workspaceId,
    shareCopy: own && team && t.workspaceId !== me.workspaceId && !t.shared,
  };
}

/** Yours (newest first), then the workspace's shared ones (newest first), then the built-ins. */
export function sortLibrary(list: readonly LibraryTemplate[], userId: string): LibraryTemplate[] {
  const rank = (t: LibraryTemplate) => (t.builtin ? 2 : t.userId === userId ? 0 : 1);
  const order = new Map(LIBRARY_BUILTINS.map((b, i) => [b.id, i]));
  return [...list].sort((a, b) => rank(a) - rank(b)
    || (a.builtin && b.builtin ? (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) : 0)
    || (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)
    || a.name.localeCompare(b.name));
}

/* ---------- data: task_templates (demo: in memory) ---------- */

/** the demo's "you" (data.ts MEMBERS) */
export const DEMO_TEMPLATE_USER = "m-self";
const CACHE_MS = 60_000;
let demoRows: LibraryTemplate[] | null = null;
let demoSeq = 0;
let adopting: Promise<number> | null = null;
let schemaMissing = false;
const cache = new Map<string, { at: number; list: LibraryTemplate[] }>();
const changeListeners = new Set<() => void>();
const cacheKey = (ws: string | null) => ws ?? "personal";

/** Something in the library changed (here, in this tab): pickers and the gallery refresh. Returns unsubscribe. */
export function onLibraryChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}
function changed(): void {
  cache.clear();
  for (const fn of [...changeListeners]) { try { fn(); } catch { /* a listener's problem */ } }
}

/** Tests: forget the demo's changes, the session's adoption and the cache (and, optionally, make the demo answer at once). */
export function resetLibraryTemplates(opts: { demoDelayMs?: number } = {}): void {
  demoRows = null; demoSeq = 0; adopting = null; schemaMissing = false; cache.clear();
  if (opts.demoDelayMs !== undefined) DEMO_DELAY_MS = opts.demoDelayMs;
}

const agoIso = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/* The demo team's library: Maya's release checklist and Sana's design review
   shared with Foundrise, Theo's incident review there too, your own monthly
   invoice run (Personal) and customer interview (Foundrise, not shared), and
   Maya's experiment write-up shared with Reco HQ. */
function seedDemo(): LibraryTemplate[] {
  const row = (id: string, userId: string, workspaceId: string | null, name: string, emoji: string, shared: boolean, minutesAgo: number, body: TaskTemplateBody): LibraryTemplate =>
    ({ id, userId, workspaceId, name, emoji, shared, body, createdAt: agoIso(minutesAgo + 600), updatedAt: agoIso(minutesAgo) });
  return [
    row("demo-tpl-release", "m-1", "ws-foundrise", "Release checklist", "🚀", true, 60 * 26, {
      title: "Release {version}", priority: "high", estimate: 90, dueOffsetDays: 5,
      description: "**What's in it**\n- \n\n**Rollback plan**\n\n**Who's on call**",
      subtasks: [sub("Freeze the release branch", 0), sub("Run the regression suite", 1, "unassigned"), sub("Write the release notes", 2), sub("Go / no-go check", 4, "project_owner"), sub("Ship it and watch the dashboards", 5)],
      checklist: ["Migrations reviewed", "Feature flags set", "Support team briefed", "Status page ready"],
    }),
    row("demo-tpl-design-review", "m-3", "ws-foundrise", "Design review", "🎨", true, 60 * 50, {
      title: "Design review: {screen}", priority: "medium", estimate: 45, dueOffsetDays: 3, tags: ["Design"],
      description: "**What we're reviewing**\n\n**Questions for the room**\n- ",
      subtasks: [sub("Share the Figma link and context", 0), sub("Collect written feedback", 2, "unassigned"), sub("Decide what changes", 3, "project_owner")],
      checklist: ["Contrast checked", "Works at phone width", "Copy reviewed"],
    }),
    row("demo-tpl-incident", "m-2", "ws-foundrise", "Incident review", "🧯", true, 60 * 72, {
      title: "Incident review: {what happened}", priority: "urgent", estimate: 60, dueOffsetDays: 2, tags: ["Engineering"],
      description: "**Timeline**\n- \n\n**Impact**\n\n**Root cause**\n\n**What we'll change**\n- ",
      subtasks: [sub("Write the timeline", 0), sub("Hold the blameless review", 1, "project_owner"), sub("File follow-up tasks", 2)],
    }),
    row("demo-tpl-invoices", DEMO_TEMPLATE_USER, null, "Monthly invoice run", "💷", false, 60 * 5, {
      title: "Send {month} invoices", priority: "high", estimate: 45, dueOffsetDays: 2,
      subtasks: [sub("Export billable hours", 0), sub("Draft the invoices", 1), sub("Send and log them", 2)],
      checklist: ["Purchase order numbers added", "VAT numbers checked", "Payment terms on every invoice"],
    }),
    row("demo-tpl-interview", DEMO_TEMPLATE_USER, "ws-foundrise", "Customer interview", "🎙️", false, 60 * 30, {
      title: "Interview {customer}", priority: "medium", estimate: 60, dueOffsetDays: 7, tags: ["Research"],
      description: "**What we want to learn**\n- \n\n**Questions**\n- ",
      subtasks: [sub("Book the call", 0), sub("Prepare the questions", 5), sub("Write up the notes", 7)],
      checklist: ["Consent to record", "Notes shared in the research doc"],
    }),
    row("demo-tpl-experiment", "m-1", "ws-reco", "Experiment write-up", "📈", true, 60 * 90, {
      title: "Write up: {experiment}", priority: "medium", estimate: 60, dueOffsetDays: 4,
      subtasks: [sub("Pull the results", 0), sub("Check significance", 1), sub("Share the decision", 4, "project_owner")],
    }),
  ];
}
const rows = () => (demoRows ??= seedDemo());
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let DEMO_DELAY_MS = 120;

/** The legacy per-browser templates as library templates (personal, yours), each
 *  with everything it had: its title as typed ("Bug: "), how it repeats. */
export function localLibraryTemplates(userId = ""): LibraryTemplate[] {
  return getUserTemplates().map((t) => ({
    id: t.id, workspaceId: null, userId, name: t.name, emoji: null, shared: false, createdAt: "", updatedAt: "",
    body: cleanTemplateBody(withRecurrence({
      title: t.title.trim() ? t.title : t.name, description: t.description, priority: t.priority,
      estimate: t.focusMin, tags: t.tags,
    }, t.recurrence)),
  }));
}

/** whose this browser's stored data is (auth/localData claims it at every sign-in); null when unknown */
function deviceOwner(): string | null {
  try { return localStorage.getItem(OWNER_KEY); } catch { return null; }
}
/** This browser's own templates, when they're `uid`'s — never another account's left on a shared device. */
function localTemplatesOf(uid: string): LibraryTemplate[] {
  return uid && deviceOwner() === uid ? localLibraryTemplates(uid) : [];
}

/** a body as one string, the same for the same template however it was stored (key order, cleaning) */
const bodyKey = (b: TaskTemplateBody) =>
  JSON.stringify(Object.entries(cleanTemplateBody(b)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
/** the same name and everything the same in it: a copy that's already there */
const sameTemplate = (a: { name: string; body: TaskTemplateBody }, b: { name: string; body: TaskTemplateBody }) =>
  sameName(a.name, b.name) && bodyKey(a.body) === bodyKey(b.body);

async function sessionUid(): Promise<string | null> {
  if (!supabase) return DEMO_TEMPLATE_USER;
  try { return (await supabase.auth.getSession()).data.session?.user?.id ?? null; } catch { return null; }
}

/** Who the library is listed for: the signed-in account (demo: "m-self"; "" when signed out). Its own
 *  templates are "Yours" — for a host that doesn't pass its currentUserId (lib/templates' rows say userId). */
export async function libraryViewerId(): Promise<string> {
  return (await sessionUid()) ?? "";
}

function visibleTo(list: LibraryTemplate[], uid: string, workspaceId: string | null): LibraryTemplate[] {
  return list.filter((t) => t.userId === uid || (t.shared && t.workspaceId !== null && t.workspaceId === workspaceId));
}

/** Your templates + the workspace's shared ones + the built-ins. Demo: in memory.
 *  Adopts this browser's old templates first (once). Offline: the last list
 *  this session saw (else your local ones and the built-ins); before 0048: the
 *  same, read-only. Cached for a minute (changes here clear it). */
export async function listLibraryTemplates(workspaceId: string | null): Promise<LibraryTemplate[]> {
  const key = cacheKey(workspaceId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  if (!supabase) {
    await adoptLocalTemplates();
    await wait(DEMO_DELAY_MS);
    const list = sortLibrary([...visibleTo(rows(), DEMO_TEMPLATE_USER, workspaceId), ...LIBRARY_BUILTINS], DEMO_TEMPLATE_USER);
    cache.set(key, { at: Date.now(), list });
    return list;
  }
  try { await adoptLocalTemplates(); } catch { /* the library still loads */ }
  const uid = await sessionUid();
  if (!uid || schemaMissing) return sortLibrary([...localTemplatesOf(uid ?? ""), ...LIBRARY_BUILTINS], uid ?? "");
  const { data, error } = await supabase.from("task_templates").select(TEMPLATE_COLUMNS)
    .order("updated_at", { ascending: false }).limit(1000);
  if (error) {
    const f = templateFailure(error);
    if (f === "unavailable") schemaMissing = true;
    if (f === "unavailable" || f === "network") {
      const last = cache.get(key)?.list;
      return last ?? sortLibrary([...localTemplatesOf(uid), ...LIBRARY_BUILTINS], uid);
    }
    throw error;
  }
  const parsed = ((data as unknown[] | null) ?? []).map(rowOf).filter((x): x is LibraryTemplate => !!x && !x.builtin);
  const list = sortLibrary([...visibleTo(parsed, uid, workspaceId), ...localTemplatesOf(uid), ...LIBRARY_BUILTINS], uid);
  cache.set(key, { at: Date.now(), list });
  return list;
}

function insertRow(uid: string, input: LibraryTemplateInput, body: TaskTemplateBody) {
  return {
    workspace_id: input.workspaceId, user_id: uid, name: input.name.trim(),
    emoji: input.emoji?.trim() || null, body, shared: !!input.shared && input.workspaceId !== null,
  };
}

export async function createLibraryTemplate(input: LibraryTemplateInput): Promise<LibraryTemplate> {
  const body = cleanTemplateBody(input.body);
  const problem = templateProblem({ ...input, body });
  if (problem) throw problemError(problem);
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    if (rows().filter((r) => r.userId === DEMO_TEMPLATE_USER).length >= TEMPLATE_LIMITS.perPerson) throw new Error("too many task templates");
    const now = new Date().toISOString();
    const r = insertRow(DEMO_TEMPLATE_USER, input, body);
    const t: LibraryTemplate = {
      id: `demo-tpl-new-${++demoSeq}`, workspaceId: r.workspace_id, userId: DEMO_TEMPLATE_USER, name: r.name, emoji: r.emoji,
      body, shared: r.shared, createdAt: now, updatedAt: now,
    };
    rows().unshift(t);
    changed();
    return t;
  }
  const uid = await sessionUid();
  if (!uid) throw new Error("not authorized");
  const { data, error } = await supabase.from("task_templates").insert(insertRow(uid, input, body)).select(TEMPLATE_COLUMNS).single();
  if (error) throw error;
  const t = rowOf(data);
  if (!t) throw new Error("template not found");
  changed();
  return t;
}

export async function updateLibraryTemplate(id: string, patch: LibraryTemplatePatch): Promise<LibraryTemplate> {
  if (isLibraryBuiltinId(id) || isLocalTemplateId(id)) throw new Error("not authorized");
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.emoji !== undefined) row.emoji = patch.emoji?.trim() || null;
  if (patch.body !== undefined) row.body = cleanTemplateBody(patch.body);
  if (patch.shared !== undefined) row.shared = patch.shared;
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const t = rows().find((x) => x.id === id);
    if (!t || !templateRights(t, { userId: DEMO_TEMPLATE_USER, workspaceId: t.workspaceId, canShare: true, canManageShared: true }).edit) throw new Error("template not found");
    const next: LibraryTemplate = {
      ...t,
      ...(row.name !== undefined ? { name: row.name as string } : {}),
      ...(row.emoji !== undefined ? { emoji: row.emoji as string | null } : {}),
      ...(row.body !== undefined ? { body: row.body as TaskTemplateBody } : {}),
      ...(row.shared !== undefined ? { shared: !!row.shared } : {}),
      updatedAt: new Date().toISOString(),
    };
    const problem = templateProblem(next);
    if (problem) throw problemError(problem);
    Object.assign(t, next);
    changed();
    return { ...t };
  }
  if (row.name !== undefined && !(row.name as string)) throw problemError("name");
  if (row.body !== undefined) {
    const b = row.body as TaskTemplateBody;
    if (!b.title) throw problemError("title");
    if (templateBodyBytes(b) > TEMPLATE_LIMITS.bodyBytes) throw problemError("too_big");
  }
  const { data, error } = await supabase.from("task_templates").update(row).eq("id", id).select(TEMPLATE_COLUMNS).single();
  // no row came back: it's gone, or it isn't one this person may change (RLS hides it)
  if (error) throw (error as { code?: string }).code === "PGRST116" ? new Error("template not found") : error;
  const t = rowOf(data);
  if (!t) throw new Error("template not found");
  changed();
  return t;
}

export async function deleteLibraryTemplate(id: string): Promise<void> {
  if (isLibraryBuiltinId(id)) throw new Error("not authorized");
  if (isLocalTemplateId(id)) { deleteTemplate(id); changed(); return; }
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const i = rows().findIndex((x) => x.id === id);
    const t = rows()[i];
    if (!t || !templateRights(t, { userId: DEMO_TEMPLATE_USER, workspaceId: t.workspaceId, canShare: true, canManageShared: true }).delete) throw new Error("template not found");
    rows().splice(i, 1);
    changed();
    return;
  }
  const { data, error } = await supabase.from("task_templates").delete().eq("id", id).select("id");
  if (error) throw error;
  if (!Array.isArray(data) || !data.length) throw new Error("template not found");
  changed();
}

/** Copy this browser's old templates (kanbo-templates) into the library once; how many moved.
 *  Each becomes a personal, unshared template with everything it had (how it
 *  repeats, its title as typed). Only into the account this browser's data
 *  belongs to (auth/localData's OWNER_KEY, claimed at sign-in): another
 *  account's are never taken up. One you already have exactly (the same name
 *  and everything in it) isn't copied twice; one that only shares a name with
 *  yours comes up as "Name (2)". Real mode: only what's in the library now
 *  (copied, or there already) leaves this browser — one the library can't take
 *  (too big, or past the per-person cap) stays here and keeps working.
 *  Demo: copied into the in-memory library each session (the browser keeps them). */
export function adoptLocalTemplates(): Promise<number> {
  return (adopting ??= adoptNow().catch((e) => { adopting = null; throw e; }));
}
/** What to copy (renamed where the name's taken; at most `room`) and what's in the library already. */
function adoptionPlan(candidates: LibraryTemplate[], existing: { name: string; body: TaskTemplateBody }[], room: number) {
  const there = new Set<string>();
  const send: LibraryTemplate[] = [];
  const taken = existing.map((e) => ({ name: e.name }));
  for (const c of candidates) {
    if (existing.some((m) => sameTemplate(m, c))) { there.add(c.id); continue; }
    if (send.length >= room) continue;
    const base = c.name.trim().slice(0, TEMPLATE_LIMITS.name);
    let name = uniqueName(base, taken);
    if (name.length > TEMPLATE_LIMITS.name) name = uniqueName(base.slice(0, TEMPLATE_LIMITS.name - 6).trimEnd(), taken);
    if (templateProblem({ name, body: c.body })) continue;   // the library won't take it: it stays in this browser
    taken.push({ name });
    send.push({ ...c, name });
  }
  return { there, send };
}
async function adoptNow(): Promise<number> {
  const candidates = localLibraryTemplates();
  if (!candidates.length) return 0;
  if (!supabase) {
    const mine = rows().filter((r) => r.userId === DEMO_TEMPLATE_USER);
    const { send } = adoptionPlan(candidates, mine, TEMPLATE_LIMITS.perPerson - mine.length);
    const now = new Date().toISOString();
    for (const c of send) rows().push({ ...c, id: `demo-tpl-adopted-${++demoSeq}`, userId: DEMO_TEMPLATE_USER, createdAt: now, updatedAt: now });
    return send.length;
  }
  const uid = await sessionUid();
  if (!uid) { adopting = null; return 0; }
  // someone else's templates left on a shared device (or nobody's we know of): never taken up
  if (deviceOwner() !== uid) return 0;
  const { data: have, error: readErr } = await supabase.from("task_templates").select("name,body").eq("user_id", uid).limit(1000);
  if (readErr) {
    if (templateFailure(readErr) === "unavailable") { schemaMissing = true; return 0; }
    throw readErr;
  }
  const existing = ((have as { name?: unknown; body?: unknown }[] | null) ?? [])
    .map((r) => ({ name: String(r.name ?? ""), body: bodyOf(r.body) ?? { title: "" } }));
  const { there, send } = adoptionPlan(candidates, existing, TEMPLATE_LIMITS.perPerson - existing.length);
  if (send.length) {
    const { error } = await supabase.from("task_templates")
      .insert(send.map((c) => insertRow(uid, { workspaceId: null, name: c.name, body: c.body, shared: false }, c.body)));
    if (error) {
      const f = templateFailure(error);
      if (f === "unavailable") { schemaMissing = true; return 0; }
      if (f === "too_many") return 0;   // filled up meanwhile: they stay here (and still list from this browser)
      throw error;
    }
  }
  // what's in the library now (just copied, or there already exactly) leaves this browser; the rest stays
  const moved = new Set([...there, ...send.map((c) => c.id)]);
  if (moved.size) {
    try { localStorage.setItem(KEY, JSON.stringify(getUserTemplates().filter((t) => !moved.has(t.id)))); } catch { /* storage blocked */ }
  }
  if (send.length) changed();
  return send.length;
}

/* ---------- making one from a task ---------- */

/** "Save as template" from a task: its shape (title, description, priority, estimate, tags, how it
 *  repeats), its sub-tasks with their due dates as offsets from the task's, its checklist.
 *  Dates become "days after it's used", counted from the day the work starts
 *  — the task's start date, else today — or from the earliest of its dates if
 *  that's sooner (so nothing is ever before day 0), keeping their spacing.
 *  Sub-task people become roles: yours → "me", the project owner's →
 *  "project_owner", anyone else's → "unassigned" (`currentUserId` defaults to
 *  the task's assignee). Tags are kept by label when `tags` is given. */
export function templateFromTask(task: Task, subtasks: Task[], opts: {
  today: Date;
  currentUserId?: string;
  projectOwnerId?: string | null;
  tags?: Record<string, TagDef>;
}): TaskTemplateBody {
  const kids = subtasks
    .filter((s) => s.parentId === task.id && !s.archivedAt && s.title.trim())
    .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  const today = dayOf(opts.today);
  const dates = [task.dueDate, ...kids.map((k) => k.dueDate)].map(parseDay).filter((d): d is Date => !!d);
  const start = parseDay(task.startDate) ?? today;
  const anchor = dates.reduce((min, d) => (d < min ? d : min), start);
  const me = opts.currentUserId ?? task.assigneeId;
  const roleOf = (who: string | undefined): TemplateAssigneeRole => {
    if (!who) return "unassigned";
    if (who === me) return "me";
    if (opts.projectOwnerId && who === opts.projectOwnerId) return "project_owner";
    return "unassigned";
  };
  const due = parseDay(task.dueDate);
  const tagWords = (task.tags ?? []).map((id) => opts.tags?.[id]?.label ?? (opts.tags ? "" : id)).filter(Boolean);
  const body: TaskTemplateBody = {
    title: task.title,
    description: task.description,
    priority: task.priority,
    ...(task.focusMin > 0 ? { estimate: task.focusMin } : {}),
    ...(tagWords.length ? { tags: tagWords.slice(0, 20) } : {}),
    ...(due ? { dueOffsetDays: daysBetween(anchor, due) } : {}),
    subtasks: kids.slice(0, TEMPLATE_LIMITS.subtasks).map((k) => {
      const d = parseDay(k.dueDate);
      return { title: k.title, ...(d ? { offsetDays: daysBetween(anchor, d) } : {}), assigneeRole: roleOf(k.assigneeId) };
    }),
    checklist: (task.subtasks ?? []).map((s) => s.title).slice(0, TEMPLATE_LIMITS.checklist),
  };
  let clean = cleanTemplateBody(withRecurrence(body, task.recurrence));
  // over the size limit: the description gives way first, then the lists
  if (templateBodyBytes(clean) > TEMPLATE_LIMITS.bodyBytes && clean.description) {
    const over = templateBodyBytes(clean) - TEMPLATE_LIMITS.bodyBytes;
    clean = cleanTemplateBody({ ...clean, description: clean.description.slice(0, Math.max(0, clean.description.length - over - 64)) });
  }
  while (templateBodyBytes(clean) > TEMPLATE_LIMITS.bodyBytes && ((clean.subtasks?.length ?? 0) > 0 || (clean.checklist?.length ?? 0) > 0)) {
    clean = (clean.checklist?.length ?? 0) >= (clean.subtasks?.length ?? 0)
      ? { ...clean, checklist: clean.checklist!.slice(0, -1) }
      : { ...clean, subtasks: clean.subtasks!.slice(0, -1) };
  }
  return clean;
}
