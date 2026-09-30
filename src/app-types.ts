export type ViewId =
  | "plan" | "home" | "inbox" | "tasks" | "calendar" | "team" | "analytics" | "reports" | "project" | "search"
  | "goals" | "portfolios" | "workload" | "automations" | "forms" | "myweek"
  | "projects" | "pulse";

/** My tasks' tabs. `route.tab` undefined means "open". */
export type TasksTab = "open" | "waiting" | "done";
/** A project's tabs: its task views, then its panels. */
export type ProjectTab = "list" | "board" | "timeline" | "calendar" | "files" | "matrix" | "updates" | "requests" | "rules" | "about";

export interface Route {
  view: ViewId;
  projectId?: string;
  smart?: boolean;
  /** search: a smart-list or saved-search id · tasks: the due focus ("today" | "overdue" | "week") */
  list?: string;
  /** tasks: a TasksTab · project: a ProjectTab */
  tab?: string;
}

export type TaskView = "list" | "board" | "timeline" | "calendar" | "files" | "matrix";
export type GroupBy = "status" | "section" | "priority" | "project" | "due" | "none";
