export type ViewId =
  | "plan" | "home" | "inbox" | "tasks" | "calendar" | "team" | "analytics" | "reports" | "project" | "search"
  | "goals" | "portfolios" | "workload" | "automations" | "forms" | "myweek"
  | "projects" | "pulse"
  /** 0047: Projects › Recycle bin (/projects/bin) */
  | "bin";

/** My tasks' tabs. `route.tab` undefined means "open". */
export type TasksTab = "open" | "waiting" | "done";
/** A project's tabs: its task views, then its panels. */
export type ProjectTab = "list" | "board" | "timeline" | "calendar" | "files" | "matrix" | "updates" | "requests" | "rules" | "about" | "docs";

export interface Route {
  view: ViewId;
  projectId?: string;
  smart?: boolean;
  /** search: a smart-list or saved-search id · tasks: the due focus ("today" | "overdue" | "week") */
  list?: string;
  /** tasks: a TasksTab · project: a ProjectTab */
  tab?: string;
  /** project › docs: the open doc (/p/:id/docs/:docId) */
  docId?: string;
  /** 0048: the saved view applied to My tasks or a project (?view=<id>); search views use `list` */
  savedViewId?: string;
}

export type TaskView = "list" | "board" | "timeline" | "calendar" | "files" | "matrix";
export type GroupBy = "status" | "section" | "priority" | "project" | "due" | "none";
