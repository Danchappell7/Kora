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
   applyViewToTasksPageStorage: arriving on a view, write its filters,
     grouping and sort where TasksPage (and App's per-project prefs) read
     them on mount, so keying the page by the view id shows it at once.
   Pure; used by the toolbars (lazy chunks) and the editor.
   ============================================================ */
import type { SavedView, SavedViewKind, SavedViewQuery, SavedViewType } from "../../data/types";
import { getMember, getProject, PRIORITY_META, STATUS_META, TAGS } from "../../data/data";
import { VIEW_CUSTOM_PREFIX, VIEW_ME } from "../views";
import { filtersKey } from "../taskOps";

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
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/** Arriving on a saved view (route.savedViewId): write its filters (lib/taskOps filtersKey: "my" or the project id),
 *  grouping and sort into the keys TasksPage reads when it mounts (My tasks: "kanbo-groupby-my"; a board:
 *  "kanbo-board-group"; a project's list: App's "kanbo-pview-<id>" groupBy; "kanbo-sort"). Returns the page state
 *  (its tab and title filter, which aren't stored: hand them to the page). */
export function applyViewToTasksPageStorage(view: Pick<SavedView, "kind" | "query">, currentUserId: string): PageViewState & { filters: PageFilters } {
  const state = pageStateFromView(view, currentUserId);
  const scope = state.scope === "project" ? state.projectId ?? "" : "my";
  if (scope) put(filtersKey(scope), JSON.stringify(state.filters));
  const g = state.groupBy;
  if (g) {
    if (state.scope === "my" && LIST_GROUPS.includes(g)) put("kanbo-groupby-my", g);
    else if (state.scope === "project" && state.tab === "board" && BOARD_GROUPS.includes(g)) put("kanbo-board-group", g);
    else if (state.scope === "project" && state.projectId && LIST_GROUPS.includes(g)) {
      let prev: Record<string, unknown> = {};
      try { prev = JSON.parse(localStorage.getItem(`kanbo-pview-${state.projectId}`) || "{}") as Record<string, unknown>; } catch { /* bad JSON */ }
      put(`kanbo-pview-${state.projectId}`, JSON.stringify({ ...prev, view: state.tab ?? "list", groupBy: g }));
    }
  }
  if (state.sort && SORTS.includes(state.sort)) put("kanbo-sort", state.sort);
  return state;
}
