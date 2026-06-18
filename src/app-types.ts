export type ViewId =
  | "plan" | "home" | "inbox" | "tasks" | "calendar" | "team" | "analytics" | "project";

export interface Route {
  view: ViewId;
  projectId?: string;
  smart?: boolean;
}

export type TaskView = "list" | "board" | "timeline" | "calendar" | "files";
export type GroupBy = "status" | "priority" | "project" | "due" | "none";
