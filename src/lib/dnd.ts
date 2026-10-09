/* ============================================================
   KANBO — drag to plan: one drag-and-drop kit for tasks, on pointer
   events (no dependency, no HTML5 drag-and-drop), shared by every
   place a task can be picked up or put down.   [0048 contract → u3]

   Sources (rows, cards, Today blocks, Inbox items) bind
   useTaskDragSource; targets (Today's time slots and rail, a week's
   days and time lists, sidebar projects and people, board columns,
   sections) bind useTaskDropTarget; <DragLayer /> is mounted ONCE at
   the app root (the integrator does it) and draws the ghost ("3 tasks"),
   auto-scrolls near edges and owns Escape.

     • mouse / pen: press, move past DND_DRAG_THRESHOLD_PX → drag
     • touch: long-press DND_LONG_PRESS_MS (with haptic) → drag; a plain
       swipe / scroll is never a drag (U7's row gestures stay theirs)
     • Escape, or letting go over nothing: cancelled, nothing changes
     • multi-select: a source whose row is selected drags every selected id
     • keyboard / screen reader: dragging is never the only way. Every view
       offers "Move to…" / "Schedule…" menus; they can list the targets
       mounted right now (listDropTargets / useDropTargets) and drop on one
       (dropOnTarget) so a keyboard move runs the very same handler.
       Announce results through the existing toasts (aria-live).
     • prefers-reduced-motion: no ghost glide or settle animation.
     • read-only people (guests, suspended): pass disabled — nothing binds.

   Rules for consumers: call the hooks unconditionally (rules of hooks);
   spread `bind` onto ONE element; if you have your own onPointerDown,
   call `bind.onPointerDown?.(e)` from it. Keep this module small: the
   shell (Sidebar, lists) imports it, so it lands in the first download.

   Until u3 builds it, the hooks are inert (bind does nothing, nothing is
   ever dragging) and DragLayer renders nothing, so wiring against it is
   safe today.
   ============================================================ */
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";

/* ---------- what moves, and where it can land ---------- */

/** where a drag started */
export type DragSourceKind = "list" | "board" | "today" | "week" | "inbox" | "search" | "sidebar";
/** what can take a drop */
export type DropTargetKind =
  | "today-slot"     // a time on Today's canvas: data { date: "YYYY-MM-DD", minute: 0–1439 } (snap 15)
  | "today-rail"     // Today's rail (unschedule / "today, no time")
  | "week-day"       // a day column in My week: data { date }
  | "week-slot"      // a time in a day's list: data { date, minute }
  | "project"        // a sidebar project row: id = project id ("move to project")
  | "person"         // a team person row: id = user id ("reassign")
  | "section"        // a list / board section: id = section id, data { projectId }
  | "board-column";  // a board column: id = column key (status), data { projectId }

export interface TaskDragPayload {
  /** the tasks being dragged (≥ 1): the grabbed one, or every selected one when it's selected */
  taskIds: string[];
  source: DragSourceKind;
  /** the row / card / block that was grabbed */
  originId: string;
  /** source extras, e.g. a Today block's { start, dur } (minutes), an Inbox item's { activityId } */
  meta?: Record<string, unknown>;
}

export interface DropTargetRef {
  kind: DropTargetKind;
  /** unique within its kind: a project / user / section id, a column key, "2026-10-09", "2026-10-09T09:15" */
  id: string;
  /** what the drop handler needs ({ date, minute }, { status, projectId }…) */
  data?: Record<string, unknown>;
  /** for keyboard menus and the ghost's hint: "Launch", "Sana Rao", "Fri 9 Oct, 09:15" */
  label?: string;
}

export interface DragPoint { x: number; y: number }

export interface TaskDropEvent {
  payload: TaskDragPayload;
  target: DropTargetRef;
  /** the pointer (viewport px); null for a keyboard drop */
  point: DragPoint | null;
  /** the pointer inside the target's box, 0–1 each way (Today's slot maths); null for a keyboard drop */
  within: { x: number; y: number } | null;
  via: "pointer" | "keyboard";
}

/* ---------- sources ---------- */

export interface TaskDragSourceOptions {
  /** the ids to drag (a function is read when the drag starts: the selection at that moment) */
  taskIds: string[] | (() => string[]);
  source: DragSourceKind;
  originId: string;
  meta?: Record<string, unknown>;
  /** read-only (guests, suspended, a locked list): binds nothing */
  disabled?: boolean;
  /** the ghost's text for a single task (default: DragLayer's getTaskTitle, then "1 task") */
  label?: string;
  onDragStart?: (payload: TaskDragPayload) => void;
  /** dropped on a target (dropped = that drop) or cancelled (Escape, or let go over nothing) */
  onDragEnd?: (result: { dropped: TaskDropEvent | null; cancelled: boolean }) => void;
}

/** spread onto the element that is picked up */
export interface TaskDragSourceBindings {
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  /** marks the element for the kit (and for CSS: [data-kdnd-source][data-kdnd-dragging]) */
  "data-kdnd-source"?: string;
  /** "true" while this element's tasks are being dragged */
  "data-kdnd-dragging"?: "true";
}

export interface TaskDragSource {
  bind: TaskDragSourceBindings;
  /** this source's tasks are in the air right now */
  isDragging: boolean;
}

/* ---------- targets ---------- */

export interface TaskDropTargetOptions {
  target: DropTargetRef;
  /** default: any task drag. Return false to refuse (e.g. guests' tasks, the same project) */
  accepts?: (payload: TaskDragPayload) => boolean;
  onDrop: (e: TaskDropEvent) => void;
  /** the pointer moves over it while dragging (Today's slot preview); once per animation frame at most */
  onOver?: (e: TaskDropEvent) => void;
  onLeave?: () => void;
  disabled?: boolean;
}

/** spread onto the element that takes the drop */
export interface TaskDropTargetBindings {
  ref: (el: HTMLElement | null) => void;
  "data-kdnd-target"?: string;
  /** "true" while an acceptable drag hovers it: style the affordance with [data-kdnd-over] */
  "data-kdnd-over"?: "true";
}

export interface TaskDropTarget {
  bind: TaskDropTargetBindings;
  /** an acceptable drag is over it */
  isOver: boolean;
  /** a drag is in the air and this target accepts it (highlight every valid target) */
  canDrop: boolean;
  /** the drag in the air, if any */
  payload: TaskDragPayload | null;
}

/** the whole kit's state (for affordances outside a target, e.g. "Drop on a day") */
export interface DragState {
  payload: TaskDragPayload | null;
  over: DropTargetRef | null;
  point: DragPoint | null;
}

export interface DragLayerProps {
  /** a task's title for the ghost of a single-task drag */
  getTaskTitle?: (id: string) => string | undefined;
}

/* ---------- constants ---------- */

/** pointer travel before a mouse / pen press becomes a drag */
export const DND_DRAG_THRESHOLD_PX = 4;
/** touch: hold this long to pick up (a swipe or scroll before it is never a drag) */
export const DND_LONG_PRESS_MS = 350;
/** Today's canvas snaps to quarter hours */
export const DND_SNAP_MINUTES = 15;
/** auto-scroll when the pointer is this close to a scroller's edge */
export const DND_AUTOSCROLL_EDGE_PX = 48;

/* ---------- pure helpers (final) ---------- */

/** Round minutes to the nearest step (default 15), clamped to the day (0–1440 − step). */
export function snapMinutes(min: number, step: number = DND_SNAP_MINUTES): number {
  if (!Number.isFinite(min) || step <= 0) return 0;
  const snapped = Math.round(min / step) * step;
  return Math.min(Math.max(snapped, 0), 1440 - step);
}

/** "2 tasks" / the title of one */
export function dragLabel(payload: Pick<TaskDragPayload, "taskIds">, title?: string): string {
  const n = payload.taskIds.length;
  return n === 1 ? (title?.trim() || "1 task") : `${n} tasks`;
}

/* ---------- the kit (stubs until u3) ---------- */

const NOOP_REF = (_el: HTMLElement | null): void => undefined;
const INERT_SOURCE: TaskDragSource = Object.freeze({ bind: Object.freeze({}) as TaskDragSourceBindings, isDragging: false });
const INERT_TARGET: TaskDropTarget = Object.freeze({ bind: Object.freeze({ ref: NOOP_REF }) as TaskDropTargetBindings, isOver: false, canDrop: false, payload: null });
const IDLE: DragState = Object.freeze({ payload: null, over: null, point: null });
const NO_TARGETS: DropTargetRef[] = [];

/** Make an element a drag source for tasks. */
export function useTaskDragSource(_opts: TaskDragSourceOptions): TaskDragSource {
  return INERT_SOURCE;
}

/** Make an element a drop target for tasks. */
export function useTaskDropTarget(_opts: TaskDropTargetOptions): TaskDropTarget {
  return INERT_TARGET;
}

/** The drag in the air (re-renders when it changes). */
export function useDragState(): DragState {
  return IDLE;
}

/** The drop targets mounted right now, optionally only some kinds (for "Move to…" / "Schedule…" menus; re-renders as they mount). */
export function useDropTargets(_kinds?: DropTargetKind[]): DropTargetRef[] {
  return NO_TARGETS;
}

/** The same, read once (outside React). */
export function listDropTargets(_kinds?: DropTargetKind[]): DropTargetRef[] {
  return NO_TARGETS;
}

/** Keyboard drop: run a mounted target's onDrop as if the tasks were dragged there (its accepts() applies).
 *  false when no such target is mounted, or it refuses. */
export function dropOnTarget(_payload: TaskDragPayload, _target: Pick<DropTargetRef, "kind" | "id">): boolean {
  return false;
}

/** Is anything being dragged? */
export function isTaskDragActive(): boolean {
  return false;
}

/** Cancel the drag in the air (as Escape does). */
export function cancelTaskDrag(): void {
  /* nothing is ever in the air until u3 builds the kit */
}

/** The ghost, auto-scroll and Escape. Mount once, at the app root. */
export function DragLayer(_props: DragLayerProps): ReactElement | null {
  return null;
}
