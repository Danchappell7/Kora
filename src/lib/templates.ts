/* ============================================================
   KANBO — reusable task templates (stored locally per browser).
   A template captures the reusable shape of a task — name, priority,
   tags, focus estimate, recurrence, description — not project/assignee.

   Only the user's OWN templates are persisted; the built-ins are merged in
   on read. (Older builds wrote the built-ins into storage on every save, so
   reads also drop stored "builtin-" rows, de-duplicate by id and quietly
   write the cleaned list back.)
   ============================================================ */
import type { Priority, Recurrence, Task, WorkspaceTemplate, WorkspacePlan, Project, Section, FormDef, FormFieldKey, AutomationRule, AutomationAction, AutomationTrigger, PlannedTask, TemplateProject, TemplateTask, LibraryTemplate, LibraryTemplateInput, LibraryTemplatePatch, TaskTemplateBody } from "../data/types";
import { toLocalISO } from "../data/data";
import { spectrumColor } from "./projectIdentity";

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
   ====================================================================== */
export { parseLibraryTemplate, parseTemplateBody, templateFailure, TEMPLATE_LIMITS } from "./templateRows";

export const TEMPLATE_COLUMNS = "id,workspace_id,user_id,name,emoji,body,shared,created_at,updated_at";

/** the 8 built-ins (ids "builtin-lib-…"; not stored; British English) */
export const LIBRARY_BUILTINS: readonly LibraryTemplate[] = [];

const notBuiltU9 = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package u9)`));

/** Your templates + the workspace's shared ones + the built-ins. Demo: in memory. */
export function listLibraryTemplates(_workspaceId: string | null): Promise<LibraryTemplate[]> { return notBuiltU9("listLibraryTemplates"); }
export function createLibraryTemplate(_input: LibraryTemplateInput): Promise<LibraryTemplate> { return notBuiltU9("createLibraryTemplate"); }
export function updateLibraryTemplate(_id: string, _patch: LibraryTemplatePatch): Promise<LibraryTemplate> { return notBuiltU9("updateLibraryTemplate"); }
export function deleteLibraryTemplate(_id: string): Promise<void> { return notBuiltU9("deleteLibraryTemplate"); }
/** Copy this browser's old templates (kanbo-templates) into the library once; how many moved. */
export function adoptLocalTemplates(): Promise<number> { return notBuiltU9("adoptLocalTemplates"); }

/** "Save as template" from a task: its shape (title, description, priority, estimate, tags), its sub-tasks
 *  with their due dates as offsets from the task's, its checklist. */
export function templateFromTask(task: Task, _subtasks: Task[], _opts: { today: Date }): TaskTemplateBody {
  return { title: task.title };
}

/** Fuzzy match for the "/" picker (name and title; best first). */
export function matchTemplates(_query: string, templates: readonly LibraryTemplate[]): LibraryTemplate[] {
  return [...templates];
}

/** What applying makes (pure): the task and its sub-tasks, dated from `today`, assignees resolved by role. */
export interface AppliedTemplatePlan { task: Partial<Task> & { title: string }; subtasks: (Partial<Task> & { title: string })[]; checklist: string[] }
export function planTemplate(tpl: Pick<LibraryTemplate, "body">, _ctx: { today: Date; currentUserId: string; projectId: string; projectOwnerId?: string | null; workspaceId: string | null }): AppliedTemplatePlan {
  return { task: { title: tpl.body.title }, subtasks: [], checklist: [] };
}
