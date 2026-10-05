// ============================================================
// KANBO — public API v1: the route table (0046).                 [a1]
//
// coreRoutes are this package's endpoints; the pipeline mounts
// [...coreRoutes, ...webhookRoutes] (webhooks.ts, package a2). Kept out of
// router.ts so the handlers can import router.ts's helpers without a cycle.
// GET /openapi.json and GET / are public and answered by the pipeline
// itself (no key needed); everything here needs a key.
// ============================================================
import type { Route } from "./router.ts";
import {
  completeTask, createComment, createProject, createSection, createTask, deleteTask, getMe, getProject, getTask,
  listComments, listMembers, listProjects, listSections, listTasks, listWorkspaces, updateProject, updateTask,
} from "./handlers.ts";

export const coreRoutes: Route[] = [
  { method: "GET", path: "/me", handler: getMe, summary: "The person and key making the request" },
  { method: "GET", path: "/workspaces", handler: listWorkspaces, summary: "Workspaces you can reach" },
  { method: "GET", path: "/members", handler: listMembers, summary: "A workspace's members" },
  { method: "GET", path: "/projects", handler: listProjects, summary: "List projects" },
  { method: "POST", path: "/projects", handler: createProject, summary: "Create a project" },
  { method: "GET", path: "/projects/:id", handler: getProject, summary: "Get a project" },
  { method: "PATCH", path: "/projects/:id", handler: updateProject, summary: "Update a project" },
  { method: "GET", path: "/sections", handler: listSections, summary: "A project's sections" },
  { method: "POST", path: "/sections", handler: createSection, summary: "Add a section to a project" },
  { method: "GET", path: "/tasks", handler: listTasks, summary: "List and filter tasks" },
  { method: "POST", path: "/tasks", handler: createTask, summary: "Create a task" },
  { method: "GET", path: "/tasks/:id", handler: getTask, summary: "Get a task" },
  { method: "PATCH", path: "/tasks/:id", handler: updateTask, summary: "Update a task" },
  { method: "DELETE", path: "/tasks/:id", handler: deleteTask, summary: "Archive (or delete) a task" },
  { method: "POST", path: "/tasks/:id/complete", handler: completeTask, summary: "Mark a task done" },
  { method: "GET", path: "/tasks/:id/comments", handler: listComments, summary: "A task's comments" },
  { method: "POST", path: "/tasks/:id/comments", handler: createComment, summary: "Comment on a task" },
];
