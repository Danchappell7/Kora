/* ============================================================
   KANBO — drag to plan: the sidebar's (and the phone bar's) "Today"
   as a drop target. Letting a task go on it puts it on today's list
   (no time: the rail's "Today" group), as T does in a list; holding
   it there a moment opens Today (lib/dnd spring-loading: mark the
   same element `data-kdnd-spring`), so it can land on a time.
   Shell-safe: a few lines. The integrator binds it (Sidebar and
   MobileNav aren't u3's) and supplies the write path:

     const today = useTodayNavDropTarget({ readOnly, onDrop: (ids) => addToToday(ids) });
     <a {...today.bind} data-kdnd-spring="" …>Today</a>

   with addToToday = App's bulk update of todayListPatches(myTasks, ids)
   and a toast "Added 2 tasks to Today · Undo" (undo = its `undo` list).
   ============================================================ */
import { useMemo } from "react";
import { useTaskDropTarget, type TaskDragPayload, type TaskDropTarget } from "../../lib/dnd";
import type { Task } from "../../data/types";

/** What putting tasks on today's list writes, and what Undo puts back. Tasks already on
 *  it, finished, archived or not in `tasks` (someone else's) are left alone. */
export function todayListPatches(tasks: readonly Task[], ids: readonly string[]): {
  patches: { id: string; patch: Partial<Task> }[];
  undo: { id: string; patch: Partial<Task> }[];
  message: string;
} {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const moving = [...new Set(ids)].map((id) => byId.get(id))
    .filter((t): t is Task => !!t && !t.planToday && t.status !== "done" && !t.archivedAt);
  const patches = moving.map((t) => ({ id: t.id, patch: { planToday: true } as Partial<Task> }));
  const undo = moving.map((t) => ({ id: t.id, patch: { planToday: false } as Partial<Task> }));
  const message = moving.length === 0 ? "Already on Today"
    : moving.length === 1 ? `Added “${moving[0].title}” to Today` : `Added ${moving.length} tasks to Today`;
  return { patches, undo, message };
}

/** The sidebar's Today item as a drop target (lib/dnd kind "today-rail", pointer-only). */
export function useTodayNavDropTarget(opts: { readOnly?: boolean; onDrop: (taskIds: string[], payload: TaskDragPayload) => void }): TaskDropTarget {
  const target = useMemo(() => ({ kind: "today-rail" as const, id: "nav", data: { listed: false }, label: "Today" }), []);
  return useTaskDropTarget({ target, disabled: !!opts.readOnly, onDrop: (e) => opts.onDrop(e.payload.taskIds, e.payload) });
}
