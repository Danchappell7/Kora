/* ============================================================
   KANBO — dropping tasks on a project or a person (0048).
   The sidebar's project rows (u6) and the Team place's people rows
   (TeamView: u6; Pulse: u10 binds the same hook) take task drags from
   lib/dnd: dropping moves the tasks to that project / reassigns them,
   then a toast says what happened, with Undo ("Moved 3 tasks to Launch ·
   Undo"). The keyboard path is the rows' own "Move to…" / "Assign to…"
   menus (lib/dnd dropOnTarget, or these functions directly): every row
   here registers as a target with its name, so those menus list it.
   Rules: only writers (never guests or suspended people) — the hooks bind
   nothing when readOnly; a person must be an active member of the tasks'
   workspace; personal tasks can only move between personal projects (and
   a team task stays in its workspace: a drop never carries work across);
   tasks already there are skipped ("Already in Launch").
   The host (App, wired by the integrator) supplies the update path and the
   toast through MoveDeps; ./dropMoves owns the wording and the Undo.
   Kept small: the Sidebar imports it (first download).
   ============================================================ */
import type { Project } from "../data/types";
import { useCallback, useMemo, useRef } from "react";
import { useTaskDropTarget, type DropTargetRef, type TaskDragPayload, type TaskDropEvent, type TaskDropTarget } from "./dnd";

// The moves themselves (the wording, the checks, the Undo) are in ./dropMoves: loaded on the first drop (or when
// the browser is idle), so the Sidebar's first download carries only the targets below.
export type { MoveDeps, MoveOutcome } from "./dropMoves";

/** A drag can be dropped here: something is being carried. */
const carries = (p: TaskDragPayload) => p.taskIds.length > 0;

/** The kit's target with stable options (a fresh object each render would re-register it). */
function useStableTarget(target: DropTargetRef, onDrop: (taskIds: string[], id: string) => void, disabled: boolean): TaskDropTarget {
  const cb = useRef(onDrop);
  cb.current = onDrop;
  const { kind, id, label } = target;
  const ws = (target.data?.workspaceId as string | null | undefined) ?? null;
  const ref = useMemo<DropTargetRef>(() => (kind === "project" ? { kind, id, label, data: { workspaceId: ws } } : { kind, id, label }), [kind, id, label, ws]);
  const handle = useCallback((e: TaskDropEvent) => cb.current(e.payload.taskIds, id), [id]);
  return useTaskDropTarget({ target: ref, accepts: carries, onDrop: handle, disabled });
}

/** A sidebar project row as a drop target (lib/dnd kind "project"). */
export function useProjectDropTarget(project: Pick<Project, "id" | "name" | "workspaceId">, opts: { readOnly?: boolean; onDrop: (taskIds: string[], projectId: string) => void }): TaskDropTarget {
  return useStableTarget({ kind: "project", id: project.id, label: project.name, data: { workspaceId: project.workspaceId ?? null } }, opts.onDrop, !!opts.readOnly);
}

/** A team person row as a drop target (lib/dnd kind "person"). */
export function usePersonDropTarget(person: { userId: string; name: string }, opts: { readOnly?: boolean; onDrop: (taskIds: string[], userId: string) => void }): TaskDropTarget {
  return useStableTarget({ kind: "person", id: person.userId, label: person.name }, opts.onDrop, !!opts.readOnly || !person.userId);
}
