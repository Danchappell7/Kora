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
  tags?: string[];
  focusMin?: number;
  blockedBy?: string[];
  completedAt?: string | null;
  project?: string | null;
}

/** Tasks that reach a prompt. */
export const MAX_TASKS = 120;
/** Tasks we look at before choosing MAX_TASKS (bounds the work per request). */
export const MAX_TASKS_IN = 20_000;
/** Recently finished tasks kept for summary/ask even when plenty are open. */
const RECENT_DONE = 40;

export const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : v == null ? "" : String(v).slice(0, max));
const strOrNull = (v: unknown, max: number) => (v == null || v === "" ? null : str(v, max));
const strList = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.slice(0, n).map((x) => str(x, max)) : []);

function cleanTask(raw: unknown): TaskIn {
  const t = (raw ?? {}) as Record<string, unknown>;
  const out: TaskIn = { id: str(t.id, 64), title: str(t.title, 300), status: str(t.status, 24), priority: str(t.priority, 24) };
  if ("dueDate" in t) out.dueDate = strOrNull(t.dueDate, 32);
  if ("completedAt" in t) out.completedAt = strOrNull(t.completedAt, 40);
  if ("project" in t) out.project = strOrNull(t.project, 64);
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
 */
export function cleanTasks(v: unknown, mode = ""): TaskIn[] {
  if (!Array.isArray(v)) return [];
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
