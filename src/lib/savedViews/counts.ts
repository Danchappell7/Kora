/* ============================================================
   KANBO — saved views: what a view shows, and its live count (0048).
   The same predicates as the lists themselves (lib/searchQuery for
   searches; My tasks' and a project's own filters for the rest), over
   the tasks the app holds. Apart from lib/views (the store, which the
   Sidebar reads at first paint) so it isn't in the first download: the
   host fetches it while the browser is idle (the badges show once it
   has), the Views group's own chunk imports it.
   ============================================================ */
import type { SavedView, SearchFilters, Task } from "../../data/types";
import { getProject, KANBO_TODAY } from "../../data/data";
import { taskMatchesQuery, toQuery } from "../searchQuery";
import { VIEW_CUSTOM_PREFIX, VIEW_ME, type ViewContext } from "../views";

type Filters = Record<string, string | boolean>;
const fs = (f: Filters | undefined, k: string): string => {
  const v = f?.[k];
  return typeof v === "string" && v ? v : "all";
};
const DAY = 86400000;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Whole days from today to a stored day (lib/myTaskBuckets daysFromToday; kept here so the first download
 *  doesn't carry that module — views.test.ts checks they agree). */
function daysFrom(value: string | undefined | null, today: Date): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : midnight(new Date(value));
  return Number.isNaN(d.getTime()) ? null : Math.round((d.getTime() - midnight(today).getTime()) / DAY);
}
const mine = (t: Task, me: string) => t.assigneeId === me || (t.collaborators ?? []).includes(me);
/** My tasks' Open bucket (lib/myTaskBuckets openBucketOf). */
export function viewBucketOf(t: Task, today: Date): "overdue" | "today" | "week" | "later" | "nodate" {
  const n = daysFrom(t.dueDate, today);
  if (n !== null && n < 0) return "overdue";
  if (n === 0 || t.planToday || t.scheduled != null || (n === null && t.status === "progress")) return "today";
  if (n === null) return "nodate";
  return n <= 7 ? "week" : "later";
}
/** My tasks › Waiting on (lib/myTaskBuckets bucketWaiting's rule): what you handed to someone, and yours held up by theirs. */
export function viewWaitingIds(tasks: readonly Task[], me: string): Set<string> {
  const ids = new Set<string>();
  if (!me) return ids;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    if (t.status === "done" || t.archivedAt) continue;
    if ((t.createdBy === me || (t.followers ?? []).includes(me)) && t.assigneeId && t.assigneeId !== me && !mine(t, me)) { ids.add(t.id); continue; }
    if (mine(t, me) && (t.dependencies ?? []).some((id) => { const b = byId.get(id); return !!b && b.status !== "done" && !b.archivedAt && !!b.assigneeId && b.assigneeId !== me; })) ids.add(t.id);
  }
  return ids;
}

/** The list filters' due words (My tasks / a project / an old saved search). */
function dueMatches(due: string, t: Task, today: Date): boolean {
  if (due === "all") return true;
  if (due === "has") return !!t.dueDate;
  if (due === "none") return !t.dueDate;
  const n = daysFrom(t.dueDate, today);
  if (due === "overdue") return n !== null && n < 0 && t.status !== "done";
  if (due === "today") return n === 0 && t.status !== "done";
  if (due === "week") return n !== null && n >= 0 && n <= 7;
  return true;
}

/** My tasks' and a project's own filters (TasksPage's `passes`). */
function pageFiltersMatch(t: Task, f: Filters | undefined, me: string, sectionField: "sectionId" | "mySectionId", today: Date): boolean {
  if (!f) return true;
  const priority = fs(f, "priority"), status = fs(f, "status"), tag = fs(f, "tag"), section = fs(f, "section");
  let assignee = fs(f, "assignee");
  if (assignee === VIEW_ME) assignee = me;
  if (priority !== "all" && t.priority !== priority) return false;
  if (status === "open" ? t.status === "done" : status !== "all" && t.status !== status) return false;
  if ((f.hideDone === true || f.hideDone === "true") && t.status === "done") return false;
  if (assignee !== "all" && t.assigneeId !== assignee) return false;
  if (tag !== "all" && !(t.tags || []).includes(tag)) return false;
  if (section !== "all" && (section === "__none" ? !!t[sectionField] : t[sectionField] !== section)) return false;
  if (!dueMatches(fs(f, "due"), t, today)) return false;
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith(VIEW_CUSTOM_PREFIX) || typeof v !== "string" || !v || v === "all") continue;
    const cv = (t.custom ?? {})[k.slice(VIEW_CUSTOM_PREFIX.length)];
    if (Array.isArray(cv) ? !cv.includes(v) : String(cv ?? "") !== v) return false;
  }
  const text = typeof f.text === "string" ? f.text.trim().toLowerCase() : "";
  return !text || t.title.toLowerCase().includes(text);
}

/** search_all's filters, applied on the device (task rows only). */
function searchFiltersMatch(t: Task, f: SearchFilters, me: string): boolean {
  if ("workspaceId" in f && (t.workspaceId ?? null) !== (f.workspaceId ?? null)) return false;
  if (f.projectId && t.projectId !== f.projectId) return false;
  const who = f.assigneeId === VIEW_ME ? me : f.assigneeId;
  if (who && t.assigneeId !== who && !(t.collaborators ?? []).includes(who)) return false;
  if (f.statuses?.length && !f.statuses.includes(t.status)) return false;
  if (f.excludeDone && t.status === "done") return false;
  if (f.dueFrom && (!t.dueDate || t.dueDate < f.dueFrom)) return false;
  if (f.dueTo && (!t.dueDate || t.dueDate > f.dueTo)) return false;
  return true;
}

interface Compiled {
  /** belongs in the view's list */
  match: (t: Task) => boolean;
  /** tasks aren't what it lists (a docs-only search): no count */
  countable: boolean;
  /** the badge counts open work only (as every sidebar badge does), nesting sub-tasks under a listed parent */
  openOnly: boolean;
  nested: boolean;
}

const waitingCache = new WeakMap<readonly Task[], Map<string, Set<string>>>();
function waitingFor(ctx: ViewContext, ws: string | null): Set<string> {
  let byScope = waitingCache.get(ctx.tasks);
  if (!byScope) waitingCache.set(ctx.tasks, (byScope = new Map()));
  const key = `${ctx.currentUserId}|${ws ?? ""}`;
  let ids = byScope.get(key);
  if (!ids) byScope.set(key, (ids = viewWaitingIds(ctx.tasks.filter((t) => (t.workspaceId ?? null) === ws && !t.archivedAt), ctx.currentUserId)));
  return ids;
}

const archivedProject = (t: Task) => !!getProject(t.projectId)?.archivedAt;

function compile(view: SavedView, ctx: ViewContext): Compiled {
  const q = view.query ?? { v: 1 };
  const me = ctx.currentUserId;
  const today = midnight(ctx.today ?? KANBO_TODAY);
  if (view.kind === "my_tasks") {
    const ws = view.workspaceId ?? null;
    const list = q.list ?? "open";
    const inWs = (t: Task) => (t.workspaceId ?? null) === ws && !t.archivedAt && !archivedProject(t);
    const waiting = list === "waiting" ? waitingFor(ctx, ws) : null;
    const base = waiting ? (t: Task) => waiting.has(t.id) && inWs(t) : (t: Task) => !!me && mine(t, me) && inWs(t);
    const tab = list === "done" ? (t: Task) => t.status === "done"
      : list === "today" || list === "overdue" || list === "week" ? (t: Task) => t.status !== "done" && viewBucketOf(t, today) === list
      : waiting ? () => true
      : (t: Task) => t.status !== "done";
    return { match: (t) => base(t) && tab(t) && pageFiltersMatch(t, q.filters, me, "mySectionId", today), countable: true, openOnly: list !== "done", nested: true };
  }
  if (view.kind === "project") {
    const pid = q.projectId;
    return {
      match: (t) => !!pid && t.projectId === pid && !t.archivedAt && pageFiltersMatch(t, q.filters, me, "sectionId", today),
      countable: !!pid, openOnly: fs(q.filters, "status") !== "done", nested: true,
    };
  }
  // search: the old saved-search shape (filters), and/or the new words + search_all filters
  const legacy: Record<string, unknown> = { ...(q.filters ?? {}) };
  if (legacy.assignee === VIEW_ME) legacy.assignee = me;
  const due = typeof legacy.due === "string" ? legacy.due : "all";
  let sf: SearchFilters = q.search?.filters ?? {};
  let words = q.search?.text?.trim() ?? "";
  if (words && ctx.parseSearchText) {
    try { const parsed = ctx.parseSearchText(words); words = parsed.text.trim(); sf = { ...parsed.filters, ...sf }; }
    catch { /* read literally */ }
  }
  const text = [typeof legacy.text === "string" ? legacy.text : "", words].filter(Boolean).join(" ");
  const query = toQuery({ ...legacy, text, due: "all", includeArchived: legacy.includeArchived === true || legacy.includeArchived === "true" || !!sf.includeArchived });
  const countable = !sf.kinds?.length || sf.kinds.includes("task");
  return {
    match: (t) => countable && taskMatchesQuery(t, query) && dueMatches(due, t, today) && searchFiltersMatch(t, sf, me),
    countable, openOnly: false, nested: false,
  };
}

/** Does this task belong in the view? (the list's own predicate: lib/searchQuery taskMatchesQuery + the view's scope) */
export function viewMatchesTask(view: SavedView, task: Task, ctx: ViewContext): boolean {
  return compile(view, ctx).match(task);
}

/** The count, or null when the view doesn't list tasks (a docs-only search). */
export function viewCountOrNull(view: SavedView, ctx: ViewContext): number | null {
  const c = compile(view, ctx);
  if (!c.countable) return null;
  const rows = ctx.tasks.filter((t) => c.match(t) && (!c.openOnly || t.status !== "done"));
  if (!c.nested) return rows.length;
  const ids = new Set(rows.map((t) => t.id));
  return rows.filter((t) => !t.parentId || !ids.has(t.parentId)).length;
}

/** The sidebar's live count. */
export function viewCount(view: SavedView, ctx: ViewContext): number {
  return viewCountOrNull(view, ctx) ?? 0;
}

/** Every view's count at once (null: not a task list). */
export function viewCounts(views: readonly SavedView[], ctx: ViewContext): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const v of views) out[v.id] = viewCountOrNull(v, ctx);
  return out;
}
