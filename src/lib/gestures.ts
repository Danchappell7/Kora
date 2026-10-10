/* ============================================================
   KANBO — touch gestures for task rows (0048).                    [u7]
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

   Pointer events, no dependency. The row carries `touch-action: pan-y
   pinch-zoom` (bind.style), so the browser keeps vertical scrolling and
   pinch to itself and hands a sideways finger to us; when it starts a
   scroll it cancels the pointer and the row stays put. Only a press on
   the bound element's own DOM starts a gesture: a menu or date picker
   the row opens is a portal (a React child, so its events bubble here)
   and is never swiped or long-pressed through.
   Kept small: ListView (the shell's lists) imports it.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent, RefObject } from "react";

/** px a finger travels before the direction locks (horizontal = swipe, vertical = scroll) */
export const SWIPE_LOCK_PX = 10;
/** fraction of the row's width that commits a swipe on release */
export const SWIPE_COMMIT_RATIO = 0.35;
/** a fling this fast (px/ms) commits even before the ratio */
export const SWIPE_FLING_VELOCITY = 0.6;
export const LONG_PRESS_MS = 450;

export type SwipeDirection = "right" | "left";
export type SwipePhase = "idle" | "tracking" | "armed" | "committed" | "cancelled";

/** a fling still has to travel this far (a flick of the wrist on a tap isn't a swipe) */
export const SWIPE_FLING_MIN_PX = 24;
/** the width a decision assumes when the row hasn't been measured (tests, hidden rows) */
const FALLBACK_WIDTH = 360;
/** how long a released row takes to settle (the CSS transition is 160ms; a timer ends it, so reduced motion needs none) */
export const SWIPE_GLIDE_MS = 200;
/** the click a finished gesture leaves behind is swallowed for this long */
const SWALLOW_MS = 400;
/** the default width of the left reveal (four 64px buttons) */
export const SWIPE_REVEAL_PX = 256;

/** What a release does, from how far and how fast the finger went (pure; unit-tested by u7).
 *  `dx` px (+ = rightwards), `width` the row's px, `velocity` px/ms (+ = rightwards). */
export function swipeDecision(dx: number, width: number, velocity: number): { commit: boolean; direction: SwipeDirection | null } {
  if (!Number.isFinite(dx) || Math.abs(dx) < SWIPE_LOCK_PX) return { commit: false, direction: null };
  const direction: SwipeDirection = dx > 0 ? "right" : "left";
  const sign = dx > 0 ? 1 : -1;
  const w = Number.isFinite(width) && width > 0 ? width : FALLBACK_WIDTH;
  const v = Number.isFinite(velocity) ? velocity * sign : 0; // along the swipe (negative = flicked back)
  // flicked back the way it came: changed their mind, whatever the distance
  if (v <= -SWIPE_FLING_VELOCITY) return { commit: false, direction };
  if (Math.abs(dx) >= w * SWIPE_COMMIT_RATIO) return { commit: true, direction };
  if (v >= SWIPE_FLING_VELOCITY && Math.abs(dx) >= SWIPE_FLING_MIN_PX) return { commit: true, direction };
  return { commit: false, direction };
}

/** Rubber-banding: free up to `limit`, then a quarter of the travel (pure). Works both ways. */
export function swipeResist(dx: number, limit: number, give = 0.25): number {
  const a = Math.abs(dx);
  if (!(limit > 0) || a <= limit) return dx;
  return Math.sign(dx) * (limit + (a - limit) * give);
}

/** px/ms over the last ~100ms of samples (+ = rightwards); 0 with too few (pure). */
export function swipeVelocity(samples: { x: number; t: number }[], windowMs = 100): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

export interface SwipeRowOptions {
  /** guests / read-only / a done task you can't reopen: no swipes */
  disabled?: boolean;
  onSwipeRight?: () => void;
  /** opens the left reveal (Snooze / Schedule) */
  onSwipeLeft?: () => void;
  onLongPress?: () => void;
  /** px the left reveal stays open at (its buttons' width). Default SWIPE_REVEAL_PX. */
  revealWidth?: number;
  /** the element holding the row AND its reveal: a touch outside it closes an open reveal
   *  (default: the bound element) */
  hostRef?: RefObject<HTMLElement>;
  /** where a long press doesn't start (a control with a long press of its own), as a CSS selector */
  longPressIgnore?: string;
}
export interface SwipeRow {
  /** spread onto the row */
  bind: {
    onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove?: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp?: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel?: (e: ReactPointerEvent<HTMLElement>) => void;
    /** swallows the click a swipe or a long press leaves behind; a tap on a row with its reveal open closes it */
    onClickCapture?: (e: ReactMouseEvent<HTMLElement>) => void;
    /** the browser's own long-press menu doesn't also open */
    onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
    /** cancels the mouse events and click a phone sends after a long press or a swipe (which would
     *  otherwise land on whatever opened under the finger, e.g. the sheet's scrim) */
    onTouchEnd?: (e: ReactTouchEvent<HTMLElement>) => void;
    style?: { transform?: string; touchAction?: string };
  };
  /** px the row is pulled (for the reveal's width / colour) */
  offset: number;
  phase: SwipePhase;
  direction: SwipeDirection | null;
  /** close a left reveal */
  reset: () => void;
  /** the left reveal is open (its buttons can take focus) */
  open: boolean;
  /** a released row is easing home (style it with a short transform transition) */
  gliding: boolean;
  /** prefers-reduced-motion: the row doesn't slide (bind.style has no transform); show the reveal in place */
  still: boolean;
}

/** Does the person ask for less motion? (read on each gesture: it can change while the app is open) */
function reducedMotion(): boolean {
  try { return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/** when the event happened (ms; the event's own clock, so a queued burst of moves keeps its real spacing) */
const stamp = (e: { timeStamp?: number }) =>
  typeof e.timeStamp === "number" && e.timeStamp > 0 ? e.timeStamp : typeof performance !== "undefined" ? performance.now() : Date.now();

interface Gesture {
  id: number;
  x0: number; y0: number;
  /** the offset when the finger went down (a negative one: the reveal was open) */
  base: number;
  axis: "x" | "y" | null;
  width: number;
  samples: { x: number; t: number }[];
  timer: number;
  longFired: boolean;
  armed: boolean;
  /** the offset before rubber-banding */
  raw: number;
}

export function useSwipeRow(opts: SwipeRowOptions): SwipeRow {
  const o = useRef(opts);
  o.current = opts;
  const revealW = opts.revealWidth ?? SWIPE_REVEAL_PX;
  const [offset, setOffset] = useState(0);
  const [phase, setPhase] = useState<SwipePhase>("idle");
  const [direction, setDirection] = useState<SwipeDirection | null>(null);
  const [gliding, setGliding] = useState(false);
  const [still, setStill] = useState(false);
  const g = useRef<Gesture | null>(null);
  const el = useRef<HTMLElement | null>(null);
  const offsetRef = useRef(0);
  const swallowUntil = useRef(0);
  const settleTimer = useRef(0);
  const open = phase === "committed" && direction === "left";
  const openRef = useRef(open);
  openRef.current = open;

  const move = (n: number) => { offsetRef.current = n; setOffset(n); };
  const clearPress = () => { const s = g.current; if (s?.timer) { window.clearTimeout(s.timer); s.timer = 0; } };
  // ease home (or to the open reveal), then settle into `then`
  const glideTo = (n: number, then: SwipePhase, dir: SwipeDirection | null) => {
    window.clearTimeout(settleTimer.current);
    setGliding(n !== offsetRef.current);
    move(n);
    setDirection(dir);
    setPhase(then === "committed" && dir === "left" ? "committed" : then);
    settleTimer.current = window.setTimeout(() => {
      setGliding(false);
      if (then !== "committed" || dir !== "left") { setPhase("idle"); setDirection(null); }
    }, SWIPE_GLIDE_MS);
  };

  const reset = useCallback(() => {
    // an explicit close (a tray button, a touch elsewhere) ends the gesture's aftermath: the next click is a
    // real one, e.g. the tray's Pick opening the row's own date picker a moment after the swipe
    swallowUntil.current = 0;
    const s = g.current;
    if (s?.timer) window.clearTimeout(s.timer);
    g.current = null;
    if (offsetRef.current === 0 && !openRef.current) return;
    glideTo(0, "cancelled", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { window.clearTimeout(settleTimer.current); clearPress(); }, []);

  // disabled while open (a selection started, the task was finished elsewhere): put it back
  const disabled = !!opts.disabled;
  useEffect(() => { if (disabled) reset(); }, [disabled, reset]);

  // a touch anywhere else closes an open reveal
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const host = o.current.hostRef?.current ?? el.current;
      if (!(e.target instanceof Node) || !host?.contains(e.target)) reset();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, reset]);

  const canSwipe = (dx: number, base: number) => {
    const { onSwipeRight, onSwipeLeft } = o.current;
    if (base < 0) return true;                       // an open reveal can be pushed shut (or tugged further)
    return dx > 0 ? !!onSwipeRight : !!onSwipeLeft;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const cur = o.current;
    // only a press on the bound element's own DOM: React events from a portal (a menu or date picker the
    // row opened, rendered on document.body but a React child of the row) bubble here too, and a swipe
    // across an open picker mustn't complete the task behind it, nor a long press in it open the sheet
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    if (cur.disabled || e.pointerType !== "touch" || e.isPrimary === false) return;
    if (!cur.onSwipeLeft && !cur.onSwipeRight && !cur.onLongPress && !openRef.current) return;
    el.current = e.currentTarget;
    if (g.current?.timer) window.clearTimeout(g.current.timer);
    const width = e.currentTarget.getBoundingClientRect?.().width || e.currentTarget.clientWidth || FALLBACK_WIDTH;
    const t = stamp(e);
    const s: Gesture = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base: offsetRef.current, axis: null, width, samples: [{ x: e.clientX, t }], timer: 0, longFired: false, armed: false, raw: offsetRef.current };
    g.current = s;
    setStill(reducedMotion());
    const ignore = cur.longPressIgnore && e.target instanceof Element && e.target.closest(cur.longPressIgnore);
    if (cur.onLongPress && !openRef.current && !ignore) {
      s.timer = window.setTimeout(() => {
        s.timer = 0;
        if (g.current !== s || s.axis) return;
        s.longFired = true;
        haptic(10);
        o.current.onLongPress?.();
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id || s.longFired) return;
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (s.timer && Math.hypot(dx, dy) > SWIPE_LOCK_PX) clearPress();
    if (!s.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_LOCK_PX) return;
      // mostly vertical, or a way this row doesn't go: it's a scroll, and the row stays put
      if (Math.abs(dx) <= Math.abs(dy) * 1.2 || !canSwipe(dx, s.base)) { s.axis = "y"; clearPress(); g.current = null; return; }
      s.axis = "x";
      clearPress();
      window.clearTimeout(settleTimer.current);
      setGliding(false);
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* already released */ }
    }
    const t = stamp(e);
    s.samples.push({ x: e.clientX, t });
    if (s.samples.length > 12) s.samples.shift();
    const cur = o.current;
    let raw = s.base + dx;
    if (s.base < 0) raw = Math.min(0, raw);              // an open reveal only closes (or tugs further)
    if (!cur.onSwipeRight) raw = Math.min(0, raw);
    if (!cur.onSwipeLeft && s.base === 0) raw = Math.max(0, raw);
    s.raw = raw;
    const commitAt = s.width * SWIPE_COMMIT_RATIO;
    const shown = raw < 0 ? swipeResist(raw, revealW) : swipeResist(raw, commitAt, 0.35);
    const armed = s.base === 0 && swipeDecision(raw, s.width, 0).commit;
    if (armed !== s.armed) { s.armed = armed; if (armed) haptic(8); }
    move(shown);
    setDirection(raw > 0 ? "right" : raw < 0 ? "left" : null);
    setPhase(armed ? "armed" : "tracking");
  };

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id) return;
    g.current = null;
    clearPress();
    if (s.longFired) {
      // the tap a long press ends is spent: no click on whatever was under the finger
      swallowUntil.current = Date.now() + SWALLOW_MS;
      return;
    }
    if (s.axis !== "x") return;
    swallowUntil.current = Date.now() + SWALLOW_MS;
    const v = cancelled ? 0 : swipeVelocity(s.samples);
    if (s.base < 0) {
      // the reveal was open: a decent push (a third of it) or a flick shuts it, otherwise it stays
      const pushed = s.raw - s.base;
      if (!cancelled && (pushed >= revealW / 3 || (v >= SWIPE_FLING_VELOCITY && pushed >= SWIPE_FLING_MIN_PX))) glideTo(0, "cancelled", null);
      else glideTo(-revealW, "committed", "left");
      return;
    }
    const d = cancelled ? { commit: false, direction: null } : swipeDecision(s.raw, s.width, v);
    if (d.commit && d.direction === "right" && o.current.onSwipeRight) {
      glideTo(0, "committed", "right");
      o.current.onSwipeRight();
    } else if (d.commit && d.direction === "left" && o.current.onSwipeLeft) {
      glideTo(-revealW, "committed", "left");
      o.current.onSwipeLeft();
    } else {
      glideTo(0, "cancelled", null);
    }
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (Date.now() < swallowUntil.current) { e.preventDefault(); e.stopPropagation(); return; }
    if (openRef.current) { e.preventDefault(); e.stopPropagation(); reset(); }
  };
  const onContextMenu = (e: ReactMouseEvent<HTMLElement>) => {
    if (g.current?.longFired || Date.now() < swallowUntil.current) e.preventDefault();
  };
  // (pointerup comes first, so a spent gesture has already set swallowUntil)
  const onTouchEnd = (e: ReactTouchEvent<HTMLElement>) => {
    if (Date.now() < swallowUntil.current && e.cancelable) e.preventDefault();
  };

  const active = !opts.disabled && !!(opts.onSwipeLeft || opts.onSwipeRight || opts.onLongPress);
  if (!active && !open && offset === 0) return { bind: {}, offset: 0, phase: "idle", direction: null, reset, open: false, gliding: false, still };
  return {
    bind: {
      onPointerDown, onPointerMove,
      onPointerUp: (e) => finish(e, false),
      onPointerCancel: (e) => finish(e, true),
      onClickCapture, onContextMenu, onTouchEnd,
      style: {
        ...(offset && !still ? { transform: `translate3d(${offset}px, 0, 0)` } : null),
        ...(opts.onSwipeLeft || opts.onSwipeRight ? { touchAction: "pan-y pinch-zoom" } : null),
      },
    },
    offset, phase, direction, reset, open, gliding: gliding && !still, still,
  };
}

/** A short vibration where the browser allows it (never throws; nothing on desktop or with reduced motion). */
export function haptic(pattern: number | number[] = 10): void {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (!window.matchMedia("(hover: none), (pointer: coarse)").matches) return; // a desktop
    }
    // Chrome refuses (with a console note) before the page has had a tap: don't ask
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation;
    if (ua && ua.hasBeenActive === false) return;
    navigator.vibrate(pattern);
  } catch { /* not allowed here */ }
}
