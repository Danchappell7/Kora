/* ============================================================
   KANBO — dropping tasks on a project or a person (0048).  [0048 contract → u6]
   The sidebar's project rows (u6) and the Team place's people rows
   (TeamView: u6; Pulse: u10 binds the same hook) take task drags from
   lib/dnd: dropping moves the tasks to that project / reassigns them,
   then a toast says what happened, with Undo ("Moved 3 tasks to Launch ·
   Undo"). The keyboard path is the rows' own "Move to…" / "Assign to…"
   menus (lib/dnd dropOnTarget, or these functions directly).
   Rules: only writers (never guests or suspended people) — the hooks bind
   nothing when readOnly; a person must be an active member of the tasks'
   workspace; personal tasks can only move between personal projects;
   tasks already there are skipped ("Already in Launch").
   The host (App, wired by the integrator) supplies the update path and the
   toast through MoveDeps; this module owns the wording and the Undo.
   ============================================================ */
import type { Member, Project, Task } from "../data/types";
import type { TaskDropTarget } from "./dnd";

export interface MoveDeps {
  /** the tasks as they are now (to know what Undo puts back) */
  tasks: readonly Task[];
  /** App's bulk update path (optimistic + saved); one patch per task */
  updateTasks: (patches: { id: string; patch: Partial<Task> }[]) => void | Promise<void>;
  /** the app's toast with an Undo action */
  toast: (message: string, undo?: () => void) => void;
}

export interface MoveOutcome { moved: string[]; skipped: string[]; message: string }

/** Move tasks to a project (its first section; sub-tasks follow their parent). */
export function moveTasksToProject(_taskIds: string[], _project: Pick<Project, "id" | "name" | "workspaceId">, _deps: MoveDeps): MoveOutcome {
  return { moved: [], skipped: [], message: "" };
}

/** Reassign tasks to a person. */
export function reassignTasks(_taskIds: string[], _person: Pick<Member, "id" | "name">, _deps: MoveDeps): MoveOutcome {
  return { moved: [], skipped: [], message: "" };
}

const INERT: TaskDropTarget = Object.freeze({ bind: Object.freeze({ ref: () => undefined }), isOver: false, canDrop: false, payload: null }) as TaskDropTarget;

/** A sidebar project row as a drop target (lib/dnd kind "project"). */
export function useProjectDropTarget(_project: Pick<Project, "id" | "name" | "workspaceId">, _opts: { readOnly?: boolean; onDrop: (taskIds: string[], projectId: string) => void }): TaskDropTarget {
  return INERT;
}

/** A team person row as a drop target (lib/dnd kind "person"). */
export function usePersonDropTarget(_person: { userId: string; name: string }, _opts: { readOnly?: boolean; onDrop: (taskIds: string[], userId: string) => void }): TaskDropTarget {
  return INERT;
}
