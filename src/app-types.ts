export type ViewId =
  | "plan" | "home" | "inbox" | "tasks" | "calendar" | "team" | "analytics" | "project" | "search"
  | "goals" | "portfolios" | "workload" | "automations" | "forms";

export interface Route {
  view: ViewId;
  projectId?: string;
  smart?: boolean;
}

export type TaskView = "list" | "board" | "timeline" | "calendar" | "files";
export type GroupBy = "status" | "section" | "priority" | "project" | "due" | "none";
