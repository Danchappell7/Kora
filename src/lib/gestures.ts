/* ============================================================
   KANBO — touch gestures for task rows (0048).          [0048 contract → u7]
   • swipe right → complete (a green reveal grows under the row; past the
     threshold it commits on release, with a short haptic where allowed)
   • swipe left → reveal Snooze / Schedule (Today, Tomorrow, Next week,
     Pick date)
   • long-press → the quick-actions sheet (status, priority, assign,
     move, delete)
   All with Undo toasts; every one has a button alternative already
   (accessible names, keyboard). Touch only: a mouse never swipes. A
   vertical scroll always wins over a swipe (direction locks after
   SWIPE_LOCK_PX). prefers-reduced-motion: no slide or spring — the action
   still happens. Guests (read-only): no gestures that write.
   Long-press on desktop rows is lib/dnd's pick-up instead (they don't
   overlap: gestures are pointerType "touch" only, the kit's long-press
   start is for dragging to Today/Week from touch lists that opt in).
   ============================================================ */
import type { PointerEvent as ReactPointerEvent } from "react";

/** px a finger travels before the direction locks (horizontal = swipe, vertical = scroll) */
export const SWIPE_LOCK_PX = 10;
/** fraction of the row's width that commits a swipe on release */
export const SWIPE_COMMIT_RATIO = 0.35;
/** a fling this fast (px/ms) commits even before the ratio */
export const SWIPE_FLING_VELOCITY = 0.6;
export const LONG_PRESS_MS = 450;

export type SwipeDirection = "right" | "left";
export type SwipePhase = "idle" | "tracking" | "armed" | "committed" | "cancelled";

/** What a release does, from how far and how fast the finger went (pure; unit-tested by u7). */
export function swipeDecision(_dx: number, _width: number, _velocity: number): { commit: boolean; direction: SwipeDirection | null } {
  return { commit: false, direction: null };
}

export interface SwipeRowOptions {
  /** guests / read-only / a done task you can't reopen: no swipes */
  disabled?: boolean;
  onSwipeRight?: () => void;
  /** opens the left reveal (Snooze / Schedule) */
  onSwipeLeft?: () => void;
  onLongPress?: () => void;
}
export interface SwipeRow {
  /** spread onto the row */
  bind: {
    onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove?: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp?: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel?: (e: ReactPointerEvent<HTMLElement>) => void;
    style?: { transform?: string; touchAction?: string };
  };
  /** px the row is pulled (for the reveal's width / colour) */
  offset: number;
  phase: SwipePhase;
  direction: SwipeDirection | null;
  /** close a left reveal */
  reset: () => void;
}
export function useSwipeRow(_opts: SwipeRowOptions): SwipeRow {
  return { bind: {}, offset: 0, phase: "idle", direction: null, reset: () => undefined };
}

/** A short vibration where the browser allows it (never throws; nothing on desktop or with reduced motion). */
export function haptic(_pattern: number | number[] = 10): void { /* u7 */ }
