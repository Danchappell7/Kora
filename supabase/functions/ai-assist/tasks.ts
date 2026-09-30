// ============================================================
// KANBO — ai-assist input shaping (pure, unit-tested: tasks.test.ts).
// The app sends every task in view (a big team workspace can send thousands);
// the prompt only ever gets MAX_TASKS of them. We keep the ones that matter —
// what's open and due soonest, plus the most recently finished (for "what got
// done") — and bound every field so a padded payload can't become a giant,
// expensive prompt.
// ============================================================

export interface TaskIn {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate?: string | null;
  dueTime?: string | null;
  startDate?: string | null;
  tags?: string[];
  focusMin?: number;
  blockedBy?: string[];
  completedAt?: string | null;
  project?: string | null;
  projectName?: string | null;
  /** people are sent by name (the model answers in names, never ids) */
  assignee?: string | null;
  collaborators?: string[];
  createdBy?: string | null;
  /** plain text, first DESCRIPTION_MAX characters */
  description?: string;
}

/** Tasks that reach a prompt. */
export const MAX_TASKS = 120;
/** Ask Kanbo's command mode reads more: the app has already ranked them. */
export const MAX_TASKS_COMMAND = 300;
/** Tasks we look at before choosing MAX_TASKS (bounds the work per request). */
export const MAX_TASKS_IN = 20_000;
/** Recently finished tasks kept for summary/ask even when plenty are open. */
const RECENT_DONE = 40;
/** A task's description is context, not content: its opening is enough. */
export const DESCRIPTION_MAX = 200;
const NAME_MAX = 80;

export const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : v == null ? "" : String(v).slice(0, max));
const strOrNull = (v: unknown, max: number) => (v == null || v === "" ? null : str(v, max));
const strList = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.slice(0, n).map((x) => str(x, max)) : []);

/** One task, every field bounded; unknown fields are dropped. Who a task is
 *  for (assignee, collaborators) and who asked for it (createdBy) are kept:
 *  without them "what's Maya working on?" can't be answered. */
function cleanTask(raw: unknown): TaskIn {
  const t = (raw ?? {}) as Record<string, unknown>;
  const out: TaskIn = { id: str(t.id, 64), title: str(t.title, 300), status: str(t.status, 24), priority: str(t.priority, 24) };
  if ("dueDate" in t) out.dueDate = strOrNull(t.dueDate, 32);
  if ("dueTime" in t) out.dueTime = strOrNull(t.dueTime, 8);
  if ("startDate" in t) out.startDate = strOrNull(t.startDate, 32);
  if ("completedAt" in t) out.completedAt = strOrNull(t.completedAt, 40);
  if ("project" in t) out.project = strOrNull(t.project, 64);
  if ("projectName" in t) out.projectName = strOrNull(t.projectName, 64);
  if ("assignee" in t) out.assignee = strOrNull(t.assignee, NAME_MAX);
  if ("createdBy" in t) out.createdBy = strOrNull(t.createdBy, NAME_MAX);
  if ("collaborators" in t) out.collaborators = strList(t.collaborators, 10, NAME_MAX);
  if ("description" in t && t.description != null && t.description !== "") out.description = str(t.description, DESCRIPTION_MAX);
  if ("tags" in t) out.tags = strList(t.tags, 10, 40);
  if ("blockedBy" in t) out.blockedBy = strList(t.blockedBy, 20, 64);
  if (typeof t.focusMin === "number" && Number.isFinite(t.focusMin)) out.focusMin = Math.max(0, Math.min(1440, Math.round(t.focusMin)));
  return out;
}

/**
 * At most MAX_TASKS cleaned tasks, most relevant first. Small lists keep the
 * app's order. Larger ones: open tasks by due date (undated last), then the
 * most recently completed — with RECENT_DONE places kept for completed work
 * in "summary"/"ask" so a weekly summary can still say what got done.
 * "command" keeps the app's own relevance order (open work first, with room
 * kept for what was finished in the last fortnight) and reads up to
 * MAX_TASKS_COMMAND.
 */
export function cleanTasks(v: unknown, mode = ""): TaskIn[] {
  if (!Array.isArray(v)) return [];
  if (mode === "command") return v.slice(0, MAX_TASKS_COMMAND).map(cleanTask);
  const all = v.slice(0, MAX_TASKS_IN).map(cleanTask);
  if (all.length <= MAX_TASKS) return all;
  const open = all.filter((t) => t.status !== "done")
    .sort((a, b) => (a.dueDate || "￿").localeCompare(b.dueDate || "￿"));
  const done = all.filter((t) => t.status === "done")
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
  const keepDone = mode === "summary" || mode === "ask" ? Math.min(done.length, RECENT_DONE) : 0;
  const nOpen = Math.min(open.length, MAX_TASKS - keepDone);
  return [...open.slice(0, nOpen), ...done.slice(0, MAX_TASKS - nOpen)];
}
