export type ViewId =
  | "plan" | "home" | "inbox" | "tasks" | "calendar" | "team" | "analytics" | "reports" | "project" | "search"
  | "goals" | "portfolios" | "workload" | "automations" | "forms" | "myweek";

export interface Route {
  view: ViewId;
  projectId?: string;
  smart?: boolean;
  list?: string; // active smart-list id when view === "search"
}

export type TaskView = "list" | "board" | "timeline" | "calendar" | "files" | "matrix";
export type GroupBy = "status" | "section" | "priority" | "project" | "due" | "none";
