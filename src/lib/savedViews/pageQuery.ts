/* ============================================================
   KANBO — a tasks page (My tasks, a project's list / board…) as a
   saved view, and back.
   pageViewQuery: the toolbar's state → { kind, query, active } for
     SaveViewButton (active = something is filtered; grouping and sort
     alone are display choices, not a view worth saving).
   pageStateFromView: a saved view → the page's state, to apply on
     arrival (route.savedViewId): its tab, the filters in TasksPage's own
     shape (lib/taskOps TaskFilters + status / section), the title filter,
     grouping and sort. "@me" (assigned to whoever is looking) becomes the
     viewer's id.
   suggestViewName: "Urgent · Design", "Blocked in Q3 Product Launch".
   viewPageStart: arriving on a view, the state TasksPage starts from —
     its filters, title filter, grouping and sort, as the page's own
     values. A view has its own state: nothing is written to the keys
     where the page keeps the person's own filters, grouping and sort
     ("kanbo-filters:<my | project>", "kanbo-groupby-my",
     "kanbo-board-group", "kanbo-pview-<id>", "kanbo-sort"), so plain My
     tasks or the project is as they left it once they leave the view.
   Pure; used by the toolbars (lazy chunks) and the editor.
   ============================================================ */
import type { SavedView, SavedViewKind, SavedViewQuery, SavedViewType } from "../../data/types";
import { getMember, getProject, PRIORITY_META, STATUS_META, TAGS } from "../../data/data";
import { VIEW_CUSTOM_PREFIX, VIEW_ME } from "../views";

/** What a tasks page is showing. Missing or "all" = no filter. */
export interface PageViewState {
  scope: "my" | "project";
  /** scope "project" */
  projectId?: string;
  /** My tasks: "open" | "waiting" | "done" (or a due focus: "today" | "overdue" | "week");
   *  a project: its view ("list" | "board" | "timeline" | "calendar") */
  tab?: string;
  /** the title filter */
  text?: string;
  priority?: string;
  status?: string;
  assignee?: string;
  tag?: string;
  due?: string;
  /** a section id, or "__none" */
  section?: string;
  hideDone?: boolean;
  /** custom field id → value */
  custom?: Record<string, string>;
  /** list grouping (or the board's columns) */
  groupBy?: string;
  sort?: string;
  sortDir?: "asc" | "desc";
}

const VIEW_TYPES: readonly SavedViewType[] = ["list", "board", "calendar", "timeline"];
const MY_LISTS = ["open", "waiting", "done", "today", "overdue", "week"];
const FILTER_KEYS = ["priority", "status", "assignee", "tag", "due", "section"] as const;
const set = (v: string | undefined): v is string => !!v && v !== "all";

/** The page's state as a saved view's kind and query; `active` when anything is filtered. */
export function pageViewQuery(state: PageViewState): { kind: SavedViewKind; query: SavedViewQuery; active: boolean } {
  const filters: Record<string, string | boolean> = {};
  for (const k of FILTER_KEYS) { const v = state[k]; if (set(v)) filters[k] = v; }
  if (state.hideDone) filters.hideDone = true;
  for (const [id, v] of Object.entries(state.custom ?? {})) if (set(v)) filters[VIEW_CUSTOM_PREFIX + id] = v;
  const text = state.text?.trim();
  if (text) filters.text = text;
  const active = Object.keys(filters).length > 0;
  const query: SavedViewQuery = { v: 1 };
  if (state.scope === "project") {
    if (state.projectId) query.projectId = state.projectId;
    query.viewType = VIEW_TYPES.includes(state.tab as SavedViewType) ? (state.tab as SavedViewType) : "list";
  } else {
    query.list = state.tab && MY_LISTS.includes(state.tab) ? state.tab : "open";
  }
  if (active) query.filters = filters;
  if (state.groupBy) query.groupBy = state.groupBy;
  if (state.sort && state.sort !== "manual") query.sort = state.sort;
  if (state.sortDir) query.sortDir = state.sortDir;
  return { kind: state.scope === "project" ? "project" : "my_tasks", query, active };
}

/** TasksPage's filter record (lib/taskOps TaskFilters + status and section). */
export interface PageFilters {
  priority: string; assignee: string; tag: string; due: string; hideDone: boolean; showArchived: boolean;
  custom: Record<string, string>; status: string; section: string;
}

/** A saved view → the page's state (apply it on arrival). `currentUserId` resolves "@me". */
export function pageStateFromView(view: Pick<SavedView, "kind" | "query">, currentUserId: string): PageViewState & { filters: PageFilters } {
  const q = view.query ?? { v: 1 };
  const f = q.filters ?? {};
  const str = (k: string) => (typeof f[k] === "string" && f[k] ? (f[k] as string) : "all");
  const custom: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (k.startsWith(VIEW_CUSTOM_PREFIX) && typeof v === "string" && v) custom[k.slice(VIEW_CUSTOM_PREFIX.length)] = v;
  const assignee = str("assignee") === VIEW_ME ? currentUserId || "all" : str("assignee");
  const filters: PageFilters = {
    priority: str("priority"), assignee, tag: str("tag"), due: str("due"), status: str("status"), section: str("section"),
    hideDone: f.hideDone === true || f.hideDone === "true", showArchived: false, custom,
  };
  return {
    scope: view.kind === "project" ? "project" : "my",
    projectId: q.projectId,
    tab: view.kind === "project" ? q.viewType ?? "list" : q.list ?? "open",
    text: typeof f.text === "string" ? f.text : "",
    priority: filters.priority, status: filters.status, assignee, tag: filters.tag, due: filters.due, section: filters.section,
    hideDone: filters.hideDone, custom,
    groupBy: q.groupBy, sort: q.sort, sortDir: q.sortDir,
    filters,
  };
}

const DUE_WORDS: Record<string, string> = { overdue: "Overdue", today: "Due today", week: "Due this week", has: "Has a date", none: "No date" };

/** A name to start from: the filters in a few words ("Urgent · Design · Overdue"), "… in <project>". */
export function suggestViewName(state: Pick<PageViewState, "scope" | "projectId" | "priority" | "status" | "assignee" | "tag" | "due" | "text">): string {
  const bits: string[] = [];
  if (set(state.status)) bits.push(state.status === "open" ? "Open" : STATUS_META[state.status as keyof typeof STATUS_META]?.label ?? state.status);
  if (set(state.priority)) bits.push(PRIORITY_META[state.priority as keyof typeof PRIORITY_META]?.label ?? state.priority);
  if (set(state.tag)) bits.push(TAGS[state.tag]?.label ?? state.tag);
  if (set(state.due)) bits.push(DUE_WORDS[state.due] ?? state.due);
  if (set(state.assignee)) bits.push(state.assignee === VIEW_ME ? "Mine" : getMember(state.assignee)?.name.split(/\s+/)[0] ?? "Assigned");
  if (state.text?.trim()) bits.push(`“${state.text.trim()}”`);
  let name = bits.slice(0, 3).join(" · ") || (state.scope === "my" ? "My view" : "Saved view");
  const p = state.scope === "project" && state.projectId ? getProject(state.projectId) : undefined;
  if (p) name = `${name} in ${p.name}`;
  return name.length > 80 ? name.slice(0, 79) + "…" : name;
}

const LIST_GROUPS = ["status", "section", "priority", "project", "due", "none"];
const BOARD_GROUPS = ["status", "priority", "project", "assignee"];
const SORTS = ["manual", "due", "priority", "title"];
const DUE_FOCUS = ["today", "overdue", "week"] as const;

/** What a tasks page starts from on a saved view (TasksPage's `viewStart`). */
export interface ViewPageStart {
  /** the view: key the page by it, so every arrival starts afresh */
  viewId: string;
  scope: "my" | "project";
  projectId?: string;
  /** My tasks: "open" | "waiting" | "done"; a project: its view type */
  tab: string;
  /** My tasks: a view saved from Due today / Overdue / Due this week opens on that group */
  dueFocus?: "today" | "overdue" | "week";
  /** the title filter */
  text: string;
  filters: PageFilters;
  /** My tasks' grouping (in place of "kanbo-groupby-my") */
  myGroup?: string;
  /** a project board's columns (in place of "kanbo-board-group") */
  boardGroup?: string;
  /** a project list's grouping (in place of App's "kanbo-pview-<id>" groupBy) */
  listGroup?: string;
  /** in place of "kanbo-sort" */
  sort?: string;
  sortDir?: "asc" | "desc";
}

/** Arriving on a saved view (route.savedViewId): the state the page starts from. Writes nothing — the
 *  page holds it while the view is open (changes there are the view's, to Update or Save as new) and
 *  leaves the person's own stored filters, grouping and sort alone. Groupings and sorts the page doesn't
 *  know are left out (the page's own default applies). "@me" becomes the viewer. */
export function viewPageStart(view: Pick<SavedView, "id" | "kind" | "query">, currentUserId: string): ViewPageStart {
  const state = pageStateFromView(view, currentUserId);
  const g = state.groupBy;
  const project = state.scope === "project";
  const list = view.query?.list;
  const start: ViewPageStart = {
    viewId: view.id, scope: state.scope, tab: project ? state.tab ?? "list" : list === "waiting" || list === "done" ? list : "open",
    text: state.text ?? "", filters: state.filters,
  };
  if (project && state.projectId) start.projectId = state.projectId;
  if (!project && (DUE_FOCUS as readonly string[]).includes(list ?? "")) start.dueFocus = list as ViewPageStart["dueFocus"];
  if (g && !project && LIST_GROUPS.includes(g)) start.myGroup = g;
  if (g && project && state.tab === "board" && BOARD_GROUPS.includes(g)) start.boardGroup = g;
  if (g && project && state.tab !== "board" && LIST_GROUPS.includes(g)) start.listGroup = g;
  if (state.sort && SORTS.includes(state.sort)) start.sort = state.sort;
  if (state.sortDir) start.sortDir = state.sortDir;
  return start;
}
