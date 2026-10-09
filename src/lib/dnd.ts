/* ============================================================
   KANBO — drag to plan: one drag-and-drop kit for tasks, on pointer
   events (no dependency, no HTML5 drag-and-drop), shared by every
   place a task can be picked up or put down.   [0048 contract → u3]

   Sources (rows, cards, Today blocks, Inbox items) bind
   useTaskDragSource; targets (Today's time slots and rail, a week's
   days and time lists, sidebar projects and people, board columns,
   sections) bind useTaskDropTarget; <DragLayer /> is mounted ONCE at
   the app root (the integrator does it) and draws the ghost ("3 tasks"),
   with the target it would land on ("→ Fri 9 Oct, 09:15").

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

   How it works (u3). The engine lives here, not in DragLayer, so a drag
   works (and Escape cancels it) even where no layer is mounted:
     • a press arms a drag (window listeners); past the threshold (or after
       the long-press) it starts: the payload is read (taskIds() = the
       selection at that moment), every target's accepts() is asked once.
     • hit-testing: the innermost mounted target under the pointer that
       accepts the drag. Browsers confirm it with elementFromPoint, so a
       target that's scrolled away, clipped or covered (a dialog, the task
       panel) never takes a drop.
     • auto-scroll: the scrollers under the pointer (innermost first) scroll
       while it's within DND_AUTOSCROLL_EDGE_PX of an edge they can move to.
     • spring-loading: hovering an element marked `data-kdnd-spring` (the
       sidebar's Today, the Day / Week tabs) for a moment clicks it, so a
       task from My tasks or the Inbox can travel to Today and land on a
       time. It wears `data-kdnd-spring-armed` while it counts down.
     • the click that ends a drag never also opens what was under it.
     • touch: a passive-false touchmove listener is kept while sources are
       mounted on a touch screen, so a finger that's dragging never scrolls
       the page (browsers decide that when the finger lands).
     • presses inside inputs, text areas, selects, editable text or
       anything marked `data-kdnd-ignore` never start a drag; neither do
       presses with a modifier key (they're selection gestures).
     • a slot target ("today-slot", "week-slot") registered under a day id
       also takes keyboard drops on "YYYY-MM-DDTHH:MM": dropOnTarget hands
       its onDrop that id with data { date, minute }.
     • a target with data.listed === false is pointer-only: it isn't listed
       for menus (e.g. the Daybeam, a second way onto Today's canvas).
     • payload.meta.edge (a CSS colour) tints the ghost's edge.
   ============================================================ */
import { createElement, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { createPortal } from "react-dom";

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

/* ============================== the engine (u3) ============================== */

const TOUCH_SLOP = 8;        // px a finger may wander while it holds (more is a scroll or a swipe)
const AUTOSCROLL_MAX = 16;   // px per frame at the very edge
const SPRING_MS = 700;       // hover a [data-kdnd-spring] this long and it's clicked
const IGNORE = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [data-kdnd-ignore]";
const SLOT_ID = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

interface Entry {
  el: HTMLElement | null;
  o: TaskDropTargetOptions;
  /** accepts(payload) for the drag in the air (asked once per drag, again when accepts changes) */
  ok: { p: TaskDragPayload; f: TaskDropTargetOptions["accepts"]; v: boolean } | null;
  snap: TargetSnap;
}
interface TargetSnap { payload: TaskDragPayload | null; isOver: boolean; canDrop: boolean }
interface Live {
  payload: TaskDragPayload;
  src: { current: TaskDragSourceOptions };
  pointerId: number;
  touch: boolean;
  point: DragPoint;
  over: Entry | null;
  from: HTMLElement | null;
}

const IDLE: DragState = Object.freeze({ payload: null, over: null, point: null });
const IDLE_TARGET: TargetSnap = Object.freeze({ payload: null, isOver: false, canDrop: false });
const NOOP_REF = (_el: HTMLElement | null): void => undefined;

const entries = new Set<Entry>();
let live: Live | null = null;
/** how the last drag ended (DragLayer says "Cancelled") */
let ended: { payload: TaskDragPayload; dropped: boolean } | null = null;
let armed: (() => void) | null = null;   // a press waiting to become a drag: its cancel
let state: DragState = IDLE;
let regVersion = 0;
const moveSubs = new Set<() => void>();  // every change, the pointer included (useDragState, DragLayer)
const coarseSubs = new Set<() => void>(); // start / end / over (sources, targets)
const regSubs = new Set<() => void>();    // targets mounting / changing (menus)

const subMove = (f: () => void) => { moveSubs.add(f); return () => { moveSubs.delete(f); }; };
const subCoarse = (f: () => void) => { coarseSubs.add(f); return () => { coarseSubs.delete(f); }; };
const subReg = (f: () => void) => { regSubs.add(f); return () => { regSubs.delete(f); }; };

function emit(coarse: boolean) {
  state = live ? { payload: live.payload, over: live.over?.o.target ?? null, point: live.point } : IDLE;
  if (coarse) coarseSubs.forEach((f) => f());
  moveSubs.forEach((f) => f());
}
function bumpReg() { regVersion++; regSubs.forEach((f) => f()); }

const hasDom = () => typeof window !== "undefined" && typeof document !== "undefined";

/* ---------- the kit's own CSS (once, on the first source or drag) ---------- */
/** the ghost's widest (its CSS max-width) */
const GHOST_MAX = 260;
const KIT_CSS = `
[data-kdnd-source] { -webkit-touch-callout: none; }
html[data-kdnd-active], html[data-kdnd-active] * { cursor: grabbing !important; -webkit-user-select: none !important; user-select: none !important; }
.kdnd-ghost { position: fixed; z-index: 2000; pointer-events: none; box-sizing: border-box; min-width: 120px; max-width: ${GHOST_MAX}px; padding: 7px 12px 7px 14px;
  border-radius: var(--r-md, 8px); background: var(--surface-raised); box-shadow: var(--e2); transform: rotate(-1.5deg);
  animation: kdndLift var(--d-2, 160ms) var(--ease, ease) both; }
.kdnd-ghost::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; border-radius: var(--r-md, 8px) 0 0 var(--r-md, 8px); background: var(--kdnd-edge, var(--accent)); }
.kdnd-ghost[data-multi] { box-shadow: var(--e2), 5px 5px 0 -1px var(--surface-raised), 5px 5px 0 0 var(--hairline-strong); }
.kdnd-ghost > b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 13px/18px var(--font-ui, system-ui); color: var(--ink); }
.kdnd-ghost > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 500 11px/16px var(--font-mono, monospace); font-variant-numeric: tabular-nums; color: var(--accent-text, var(--accent)); }
.kdnd-ghost > i { position: absolute; top: -8px; right: -8px; min-width: 20px; height: 20px; padding: 0 6px; box-sizing: border-box; border-radius: 999px;
  background: var(--accent); color: var(--on-accent, #fff); box-shadow: var(--e1); font: 600 11px/20px var(--font-mono, monospace); font-style: normal; text-align: center; }
@keyframes kdndLift { from { opacity: 0; transform: rotate(0deg) scale(0.96); } }
@media (prefers-reduced-motion: reduce) { .kdnd-ghost { transform: none; animation: none; } }
`;
let styled = false;
function ensureStyle() {
  if (styled || !hasDom()) return;
  styled = true;
  const s = document.createElement("style");
  s.setAttribute("data-kdnd", "");
  s.textContent = KIT_CSS;
  document.head.appendChild(s);
}

/* ---------- touch: keep a finger that's dragging from scrolling the page ---------- */
let touchUsers = 0;
const onTouchMove = (e: TouchEvent) => { if (live?.touch && e.cancelable) e.preventDefault(); };
function retainTouch(): () => void {
  if (!hasDom() || !(navigator.maxTouchPoints > 0 || "ontouchstart" in window)) return () => undefined;
  if (touchUsers++ === 0) window.addEventListener("touchmove", onTouchMove, { passive: false });
  return () => { if (--touchUsers === 0) window.removeEventListener("touchmove", onTouchMove); };
}

/* ---------- hit-testing ---------- */
function accepted(en: Entry): boolean {
  if (!live || en.o.disabled || !en.el) return false;
  const p = live.payload, f = en.o.accepts;
  if (!en.ok || en.ok.p !== p || en.ok.f !== f) {
    let v = true;
    try { v = f ? !!f(p) : p.taskIds.length > 0; } catch { v = false; }
    en.ok = { p, f, v };
  }
  return en.ok.v;
}

const inRect = (r: DOMRect, x: number, y: number) => r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

function topElementAt(x: number, y: number): Element | null | undefined {
  // undefined: this engine can't tell (jsdom) — rects alone decide
  return typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : undefined;
}

function hitTest(x: number, y: number, top: Element | null | undefined = topElementAt(x, y)): Entry | null {
  if (top === null) return null; // off the page
  let best: Entry | null = null, bestArea = Infinity;
  for (const en of entries) {
    const el = en.el;
    if (!el || !el.isConnected || !accepted(en)) continue;
    const r = el.getBoundingClientRect();
    if (!inRect(r, x, y)) continue;
    if (top && !el.contains(top)) continue; // scrolled away, clipped or covered
    const area = r.width * r.height;
    if (best?.el) {
      if (best.el.contains(el)) { best = en; bestArea = area; continue; } // nested: the inner one is more specific
      if (el.contains(best.el)) continue;
    }
    if (!best || area < bestArea) { best = en; bestArea = area; }
  }
  return best;
}

function dropEvent(en: Entry, point: DragPoint | null): TaskDropEvent {
  let within: TaskDropEvent["within"] = null;
  if (point && en.el) {
    const r = en.el.getBoundingClientRect();
    const f = (v: number, a: number, len: number) => (len > 0 ? Math.min(1, Math.max(0, (v - a) / len)) : 0);
    within = { x: f(point.x, r.left, r.width), y: f(point.y, r.top, r.height) };
  }
  return { payload: live!.payload, target: en.o.target, point, within, via: point ? "pointer" : "keyboard" };
}

/** Re-read what's under the pointer: tell the target it left / is hovered, arm a spring. */
function retarget() {
  if (!live) return;
  const { x, y } = live.point;
  const top = topElementAt(x, y);
  const next = hitTest(x, y, top);
  const prev = live.over;
  if (next !== prev) {
    live.over = next;
    try { prev?.o.onLeave?.(); } catch (e) { console.error(e); }
  }
  if (next?.o.onOver) { try { next.o.onOver(dropEvent(next, live.point)); } catch (e) { console.error(e); } }
  springAt(top);
  emit(next !== prev);
}

/* ---------- spring-loading ---------- */
let spring: { el: Element; timer: number } | null = null;
function clearSpring() {
  if (!spring) return;
  window.clearTimeout(spring.timer);
  spring.el.removeAttribute("data-kdnd-spring-armed");
  spring = null;
}
function springAt(top: Element | null | undefined) {
  const el = top ? top.closest("[data-kdnd-spring]") : null;
  if (el === spring?.el) return;
  clearSpring();
  if (!el) return;
  el.setAttribute("data-kdnd-spring-armed", "true");
  // (once it has fired it stays the spring under the pointer, so it fires once per visit)
  spring = {
    el,
    timer: window.setTimeout(() => {
      el.removeAttribute("data-kdnd-spring-armed");
      if (live && el.isConnected) (el as HTMLElement).click();
    }, SPRING_MS),
  };
}

/* ---------- auto-scroll ---------- */
let raf = 0;
let overflowOf = new WeakMap<Element, { y: boolean; x: boolean }>();
function scrollable(el: Element): { y: boolean; x: boolean } {
  let o = overflowOf.get(el);
  if (!o) {
    const cs = window.getComputedStyle(el);
    const can = (v: string) => v === "auto" || v === "scroll" || v === "overlay";
    o = { y: can(cs.overflowY), x: can(cs.overflowX) };
    overflowOf.set(el, o);
  }
  return o;
}
function edgeSpeed(p: number, lo: number, hi: number): number {
  const edge = Math.min(DND_AUTOSCROLL_EDGE_PX, (hi - lo) / 3);
  if (p < lo + edge) return -Math.ceil(((lo + edge - Math.max(p, lo - edge)) / edge) * AUTOSCROLL_MAX / 2);
  if (p > hi - edge) return Math.ceil(((Math.min(p, hi + edge) - (hi - edge)) / edge) * AUTOSCROLL_MAX / 2);
  return 0;
}
function autoScroll() {
  raf = 0;
  if (!live) return;
  raf = window.requestAnimationFrame(autoScroll);
  const { x, y } = live.point;
  let el: Element | null = topElementAt(x, y) ?? live.over?.el ?? live.from;
  let moved = false;
  const root = document.scrollingElement;
  for (; el && !moved; el = el.parentElement) {
    // the page itself only when the app lets it scroll (Kanbo's shell doesn't: its panes do)
    const o = el === root ? (scrollable(document.body).y || /auto|scroll/.test(window.getComputedStyle(el).overflowY) ? { y: true, x: false } : { y: false, x: false }) : scrollable(el);
    if (!o.y && !o.x) continue;
    const r = el === root ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top - DND_AUTOSCROLL_EDGE_PX || y > r.bottom + DND_AUTOSCROLL_EDGE_PX) continue;
    if (o.y && el.scrollHeight > el.clientHeight + 1) {
      const dy = edgeSpeed(y, r.top, r.bottom);
      const room = dy < 0 ? el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop;
      if (dy && room > 0.5) { el.scrollTop += Math.max(-room, Math.min(room, dy)); moved = true; }
    }
    if (!moved && o.x && el.scrollWidth > el.clientWidth + 1 && y >= r.top && y <= r.bottom) {
      const dx = edgeSpeed(x, r.left, r.right);
      const room = dx < 0 ? el.scrollLeft : el.scrollWidth - el.clientWidth - el.scrollLeft;
      if (dx && room > 0.5) { el.scrollLeft += Math.max(-room, Math.min(room, dx)); moved = true; }
    }
  }
  if (moved) retarget(); // what's under the pointer moved
}

/* ---------- the drag's own listeners ---------- */
function onMove(e: PointerEvent) {
  if (!live || e.pointerId !== live.pointerId) return;
  // the button was let go where this page couldn't hear it (another window): nothing lands
  if (e.isTrusted && !live.touch && e.pointerType === "mouse" && e.buttons === 0) { finish(null, null); return; }
  live.point = { x: e.clientX, y: e.clientY };
  retarget();
}
function onUp(e: PointerEvent) {
  if (!live || e.pointerId !== live.pointerId) return;
  live.point = { x: e.clientX, y: e.clientY };
  const en = hitTest(live.point.x, live.point.y);
  finish(en, en ? dropEvent(en, live.point) : null);
}
function onCancel(e: PointerEvent) { if (live && e.pointerId === live.pointerId) finish(null, null); }
function onKey(e: KeyboardEvent) {
  if (!live || e.key !== "Escape") return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();
  finish(null, null);
}
function onBlock(e: Event) { if (e.cancelable) e.preventDefault(); }
function onHide() { if (document.visibilityState === "hidden") finish(null, null); }
function onBlur() { finish(null, null); }

function listen(on: boolean) {
  const f = on ? window.addEventListener.bind(window) : window.removeEventListener.bind(window);
  f("pointermove", onMove as EventListener, true);
  f("pointerup", onUp as EventListener, true);
  f("pointercancel", onCancel as EventListener, true);
  f("keydown", onKey as EventListener, true);
  f("contextmenu", onBlock, true);
  f("selectstart", onBlock, true);
  f("blur", onBlur);
  (on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document))("visibilitychange", onHide);
}

/** The click a browser sends straight after the drag's release (same task) must not open what's under it. */
let unguard: (() => void) | null = null;
function guardClick() {
  unguard?.();
  const h = (e: MouseEvent) => { off(); e.preventDefault(); e.stopPropagation(); };
  // gone after this task, or at the next press at the latest (a new click is never swallowed)
  const off = () => {
    window.removeEventListener("click", h, true);
    window.removeEventListener("pointerdown", off, true);
    if (unguard === off) unguard = null;
  };
  window.addEventListener("click", h, true);
  window.addEventListener("pointerdown", off, true);
  window.setTimeout(off, 0);
  unguard = off;
}

function begin(src: { current: TaskDragSourceOptions }, from: HTMLElement | null, point: DragPoint, pointerId: number, touch: boolean) {
  const o = src.current;
  if (live || o.disabled) return;
  let ids: string[] = [];
  try { ids = typeof o.taskIds === "function" ? o.taskIds() : o.taskIds; } catch { ids = []; }
  ids = [...new Set((ids ?? []).filter((id) => typeof id === "string" && id))];
  if (!ids.length) return;
  const payload: TaskDragPayload = { taskIds: ids, source: o.source, originId: o.originId, ...(o.meta ? { meta: o.meta } : {}) };
  live = { payload, src, pointerId, touch, point, over: null, from };
  overflowOf = new WeakMap();
  ensureStyle();
  document.documentElement.setAttribute("data-kdnd-active", touch ? "touch" : "pointer");
  try { window.getSelection?.()?.removeAllRanges(); } catch { /* nothing selected */ }
  if (touch) { try { navigator.vibrate?.(8); } catch { /* unsupported */ } }
  listen(true);
  try { o.onDragStart?.(payload); } catch (e) { console.error(e); }
  retarget();
  emit(true);
  if (typeof window.requestAnimationFrame === "function") raf = window.requestAnimationFrame(autoScroll);
}

function finish(en: Entry | null, ev: TaskDropEvent | null) {
  const l = live;
  if (!l) return;
  live = null;
  listen(false);
  if (raf) { window.cancelAnimationFrame?.(raf); raf = 0; }
  clearSpring();
  document.documentElement.removeAttribute("data-kdnd-active");
  try { l.over?.o.onLeave?.(); } catch (e) { console.error(e); }
  ended = { payload: l.payload, dropped: !!ev };
  emit(true);
  guardClick();
  if (en && ev) { try { en.o.onDrop(ev); } catch (e) { console.error(e); } }
  try { l.src.current.onDragEnd?.({ dropped: ev, cancelled: !ev }); } catch (e) { console.error(e); }
}

/** A press on a source: becomes a drag past the threshold (mouse, pen) or after a long-press (touch). */
function press(e: ReactPointerEvent<HTMLElement>, src: { current: TaskDragSourceOptions }) {
  const o = src.current;
  if (o.disabled || live || armed || e.defaultPrevented) return;
  const touch = e.pointerType === "touch";
  if ((!touch && e.button !== 0) || e.isPrimary === false) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const t = e.target as Element | null;
  if (t && typeof t.closest === "function" && t.closest(IGNORE)) return;
  const pid = e.pointerId, x0 = e.clientX, y0 = e.clientY, from = e.currentTarget;
  let last: DragPoint = { x: x0, y: y0 };
  let timer = 0;
  const disarm = () => {
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    window.removeEventListener("contextmenu", noMenu, true);
    document.removeEventListener("selectstart", noNative, true);
    document.removeEventListener("dragstart", noNative, true);
    armed = null;
  };
  const go = () => { disarm(); begin(src, from, last, pid, touch); };
  function move(ev: PointerEvent) {
    if (ev.pointerId !== pid) return;
    last = { x: ev.clientX, y: ev.clientY };
    const d = Math.hypot(ev.clientX - x0, ev.clientY - y0);
    if (touch) { if (d > TOUCH_SLOP) disarm(); } // moved before the long-press: a scroll or a swipe
    else if (d > DND_DRAG_THRESHOLD_PX) go();
  }
  // released (a click or a tap: the element's own onClick runs) or the browser took the gesture
  function up(ev: PointerEvent) { if (ev.pointerId === pid) disarm(); }
  // a long-press mustn't open the browser's own menu first
  function noMenu(ev: Event) { if (touch && ev.cancelable) ev.preventDefault(); }
  // pressing on a task and moving picks it up: no text selection, no link or image drag
  // (a native drag the source asked for — draggable="true" — still wins, and cancels this one)
  function noNative(ev: Event) {
    const el = ev.target as Element | null;
    if (ev.type === "dragstart" && el && typeof el.closest === "function" && el.closest('[draggable="true"]')) return;
    if (ev.cancelable) ev.preventDefault();
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("contextmenu", noMenu, true);
  document.addEventListener("selectstart", noNative, true);
  document.addEventListener("dragstart", noNative, true);
  if (touch) timer = window.setTimeout(go, DND_LONG_PRESS_MS);
  armed = disarm;
}

/* ============================== the hooks ============================== */

function sameData(a?: Record<string, unknown>, b?: Record<string, unknown>): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is(a[k], b[k]));
}

/** Make an element a drag source for tasks. */
export function useTaskDragSource(opts: TaskDragSourceOptions): TaskDragSource {
  const src = useRef(opts);
  src.current = opts;
  const disabled = !!opts.disabled;
  useLayoutEffect(() => { if (disabled) return; ensureStyle(); return retainTouch(); }, [disabled]);
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => press(e, src), []);
  const dragging = useSyncExternalStore(subCoarse, () => {
    const p = live?.payload, o = src.current;
    return !!p && !o.disabled && p.source === o.source && (p.originId === o.originId || p.taskIds.includes(o.originId));
  }, () => false);
  const kind = opts.source;
  const bind = useMemo<TaskDragSourceBindings>(() => (disabled ? {} : {
    onPointerDown, "data-kdnd-source": kind, ...(dragging ? { "data-kdnd-dragging": "true" as const } : {}),
  }), [disabled, onPointerDown, kind, dragging]);
  return useMemo(() => ({ bind, isDragging: dragging }), [bind, dragging]);
}

/** Make an element a drop target for tasks. */
export function useTaskDropTarget(opts: TaskDropTargetOptions): TaskDropTarget {
  const [en] = useState<Entry>(() => ({ el: null, o: opts, ok: null, snap: IDLE_TARGET }));
  useLayoutEffect(() => {
    entries.add(en);
    bumpReg();
    return () => {
      entries.delete(en);
      if (live?.over === en) { live.over = null; emit(true); }
      bumpReg();
    };
  }, [en]);
  // the latest options, every render (handlers close over fresh state)
  useLayoutEffect(() => {
    const was = en.o;
    en.o = opts;
    const a = was.target, b = opts.target;
    // by value: a target written inline (a fresh object each render) mustn't look like a new one
    const listedChanged = a.kind !== b.kind || a.id !== b.id || a.label !== b.label || !sameData(a.data, b.data) || !!was.disabled !== !!opts.disabled;
    if (listedChanged && entries.has(en)) {
      bumpReg();
      if (live?.over === en) emit(true); // the ghost's hint follows the target's label
    }
  });
  const ref = useCallback((el: HTMLElement | null) => {
    if (en.el === el) return;
    en.el = el;
    if (entries.has(en)) bumpReg();
  }, [en]);
  const snap = useSyncExternalStore(subCoarse, () => {
    if (!live || en.o.disabled || !en.el) return IDLE_TARGET;
    const canDrop = accepted(en), isOver = live.over === en, payload = live.payload;
    const s = en.snap;
    if (s.payload === payload && s.isOver === isOver && s.canDrop === canDrop) return s;
    return (en.snap = { payload, isOver, canDrop });
  }, () => IDLE_TARGET);
  const disabled = !!opts.disabled;
  const kind = opts.target.kind;
  const bind = useMemo<TaskDropTargetBindings>(() => (disabled ? { ref: NOOP_REF } : {
    ref, "data-kdnd-target": kind, ...(snap.isOver ? { "data-kdnd-over": "true" as const } : {}),
  }), [disabled, ref, kind, snap.isOver]);
  return useMemo(() => ({ bind, isOver: snap.isOver, canDrop: snap.canDrop, payload: snap.payload }), [bind, snap]);
}

/** The drag in the air (re-renders when it changes). */
export function useDragState(): DragState {
  return useSyncExternalStore(subMove, () => state, () => IDLE);
}

/** The drop targets mounted right now, optionally only some kinds (for "Move to…" / "Schedule…" menus; re-renders as they mount). */
export function useDropTargets(kinds?: DropTargetKind[]): DropTargetRef[] {
  const version = useSyncExternalStore(subReg, () => regVersion, () => 0);
  const key = kinds ? kinds.join(",") : "*";
  const ref = useRef<DropTargetRef[]>([]);
  return useMemo(() => {
    const next = listDropTargets(key === "*" ? undefined : (key.split(",") as DropTargetKind[]));
    const prev = ref.current;
    if (prev.length === next.length && prev.every((t, i) => t === next[i])) return prev;
    return (ref.current = next);
  }, [version, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The same, read once (outside React). */
export function listDropTargets(kinds?: DropTargetKind[]): DropTargetRef[] {
  const seen = new Set<string>();
  const out: DropTargetRef[] = [];
  for (const en of entries) {
    const t = en.o.target;
    if (!en.el || en.o.disabled || t.data?.listed === false || (kinds && !kinds.includes(t.kind))) continue;
    const k = t.kind + "\u0000" + t.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Keyboard drop: run a mounted target's onDrop as if the tasks were dragged there (its accepts() applies).
 *  false when no such target is mounted, or it refuses. */
export function dropOnTarget(payload: TaskDragPayload, target: Pick<DropTargetRef, "kind" | "id">): boolean {
  if (!payload || !payload.taskIds?.length || live) return false;
  const slot = (target.kind === "today-slot" || target.kind === "week-slot") ? SLOT_ID.exec(target.id) : null;
  let found: Entry | null = null, ref: DropTargetRef | null = null;
  for (const en of entries) {
    if (!en.el || en.o.disabled || en.o.target.kind !== target.kind) continue;
    if (en.o.target.id === target.id) { found = en; ref = en.o.target; break; }
    if (slot && en.o.target.id === slot[1] && !found && en.o.target.data?.listed !== false) {
      found = en;
      ref = { ...en.o.target, id: target.id, data: { ...en.o.target.data, date: slot[1], minute: +slot[2] * 60 + +slot[3] } };
    }
  }
  if (!found || !ref) return false;
  let ok = true;
  try { ok = found.o.accepts ? !!found.o.accepts(payload) : true; } catch { ok = false; }
  if (!ok) return false;
  try { found.o.onDrop({ payload, target: ref, point: null, within: null, via: "keyboard" }); } catch (e) { console.error(e); return false; }
  return true;
}

/** Is anything being dragged? */
export function isTaskDragActive(): boolean {
  return live !== null;
}

/** Cancel the drag in the air (as Escape does). */
export function cancelTaskDrag(): void {
  armed?.();
  finish(null, null);
}

/* ============================== the layer ============================== */

const readZoom = () => {
  const z = parseFloat(document.documentElement.style.getPropertyValue("--zoom"));
  return Number.isFinite(z) && z > 0 ? z : 1;
};

/** The ghost, and what a screen reader hears when a drag starts or is cancelled. Mount once, at the app root. */
export function DragLayer({ getTaskTitle }: DragLayerProps): ReactElement | null {
  const s = useDragState();
  const [said, setSaid] = useState("");
  const last = useRef<TaskDragPayload | null>(null);
  const titleOf = useCallback((p: TaskDragPayload) => {
    const own = live?.payload === p ? live.src.current.label : undefined;
    return dragLabel(p, p.taskIds.length === 1 ? (getTaskTitle?.(p.taskIds[0]) ?? own) : undefined);
  }, [getTaskTitle]);
  useLayoutEffect(() => {
    const p = s.payload, was = last.current;
    if (p && p !== was) setSaid(`Picked up ${titleOf(p)}. Escape cancels.`);
    // a drop is told by whoever took it (a toast); a cancel is told here
    else if (!p && was && ended?.payload === was && !ended.dropped) setSaid(`Cancelled. ${titleOf(was)} didn't move.`);
    last.current = p;
  }, [s.payload, titleOf]);
  if (!hasDom()) return null;
  const region = createElement("div", { role: "status", "aria-live": "polite", className: "sr-only", key: "said" }, said);
  if (!s.payload || !s.point) return createPortal(region, document.body);
  const p = s.payload;
  const zoom = readZoom();
  const touch = !!live?.touch;
  const edge = typeof p.meta?.edge === "string" ? p.meta.edge : undefined;
  const n = p.taskIds.length;
  const ghost = createElement("div", {
    key: "ghost", className: "kdnd-ghost", "aria-hidden": "true", "data-multi": n > 1 ? "" : undefined,
    style: {
      // on touch it floats above the finger, which would hide it; never off the side of a phone
      left: Math.max(8, Math.min(s.point.x / zoom + (touch ? -24 : 14), window.innerWidth / zoom - GHOST_MAX - 8)),
      top: Math.max(8, s.point.y / zoom + (touch ? -64 : 12)),
      ...(edge ? { "--kdnd-edge": edge } : null),
    },
  },
  createElement("b", null, titleOf(p)),
  s.over?.label ? createElement("span", null, `→ ${s.over.label}`) : null,
  n > 1 ? createElement("i", null, n) : null);
  return createPortal([region, ghost], document.body);
}

/** @internal tests: forget every target and any drag in the air */
export function __resetDnd(): void {
  armed?.();
  unguard?.();
  if (live) finish(null, null);
  entries.clear();
  regVersion = 0;
}
