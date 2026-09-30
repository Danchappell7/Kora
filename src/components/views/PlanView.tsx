/* ============================================================
   KANBO — Today › Day: the day canvas and the Unplanned rail.
   The canvas lays today out an hour to 60px: meetings as quiet solid
   blocks, your planned work as raised blocks with a project (or, for
   deep work, gradient) edge, and Kanbo's suggestions as dashed ghosts
   that are never written until you accept them. The rail holds
   everything not on the day yet, grouped by when it's due, with the
   capture field on top. TodayView wraps it with the brief (`lede`) and
   feeds it the suggestions; on its own it's a plain day planner.
   ============================================================ */
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useId } from "react";
import { flushSync } from "react-dom";
import type {
  PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent, CSSProperties, ReactNode, RefObject, SyntheticEvent,
} from "react";
import { Icon, chipInk, chipFill, chipEdge, Button, Kbd, StatusGlyph, ProjectDot, EmptyState, SectionLabel, projectPaint } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useToast } from "../Toast";
import { useAuth } from "../../auth/AuthProvider";
import {
  getProject, getMember, parseCapture, planDay, ENERGY, EVENTS, DAY_START, DAY_END, MEMBERS, PROJECTS, PRIORITY_META,
} from "../../data/data";
import type { CaptureOptions } from "../../data/data";
import { parseTask, type NlpSpan } from "../../lib/nlp";
import { uiZoom } from "../../lib/appearance";
import type { Task, CalEvent, EnergyKind, ExternalEvent } from "../../data/types";
import {
  durOf, energyKindOf, layoutLanes, isPlaced, todaysEvents, fmtTime, fmtTimeRange, fmtDuration, parseDay, daysBetween, weekdayShort, dayMonth, dayLong,
  localDayKey, planSeenKey, readSeen, writeSeen, carryOver, recordSeen, markSeen, touchSeen, carryLabel,
} from "./planCanvas";
import type { Lane, SeenMap } from "./planCanvas";
import { freeGaps as freeGapsOf, isTodaysScope, WORK_START, type GhostBlock } from "../../lib/brief";

const SNAP = 15;            // drags land on the quarter hour
const MOUSE_SLOP = 4;       // px a mouse press must travel before it becomes a drag — a click never writes
const TOUCH_SLOP = 6;       // px of finger travel before the long-press means "the user is scrolling"
const LONG_PRESS_MS = 250;  // touch: hold this long to pick a block up
const EDGE = 56;            // px from the canvas edge where a drag auto-scrolls the day
const KEY_COMMIT_MS = 700;  // keyboard nudges settle into one write
const MIN_BLOCK_PX = 20;    // a 20-minute block is drawn to scale; short ones grow on hover to show their actions
const LANE_LEFT = 64;       // blocks start just right of the hour rules (the gutter is 56px)
const LINGER_MS = 700;      // a block you tick off stays long enough to see it land
const FREE_LABEL_MIN = 30;  // gaps this long say "Free · 1h"
const FREE_LABEL_CLEAR = 12; // px between that label's centre and an hour rule (half its height, and a hair)
const PHONE_PXM = 56 / 60;  // phones: 56px per hour
const STACK_UNDER = 920;    // px: narrower than this (a tablet, a docked task panel) the rail goes under the day

const snapTo = (m: number, step = SNAP) => Math.round(m / step) * step;

/** The stretch of the day the canvas shows and its scale: the whole day at 60px
 *  an hour beside the rail; in one column, from an hour before now to the
 *  evening (at 56px an hour on phones). */
interface DayWindow { from: number; to: number; pxm: number }
const FULL_DAY: DayWindow = { from: DAY_START, to: DAY_END, pxm: 1 };
const yOf = (m: number, w: DayWindow) => (m - w.from) * w.pxm;
/** Where a block of `h` px starting at `top` is drawn: a pixel of daylight above
 *  and below, so back-to-back blocks read as two, never one run-on box. */
const inset = (top: number, h: number) => ({ top: top + 1, height: Math.max(2, h - 2) });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const stop = (e: SyntheticEvent) => e.stopPropagation();

/* The live clock for this view: the now-line and the carry-over prompt follow
   the real time, even in a tab left open overnight. TodayView shares it. */
function readClock() { const d = new Date(); return { nowMin: d.getHours() * 60 + d.getMinutes(), day: localDayKey(d) }; }
export function useDayClock() {
  const [c, setC] = useState(readClock);
  useEffect(() => {
    const tick = () => setC((prev) => { const n = readClock(); return n.nowMin === prev.nowMin && n.day === prev.day ? prev : n; });
    const id = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", tick); window.removeEventListener("focus", tick); };
  }, []);
  return c;
}

/** Today's meetings: the connected calendar's, or the illustrative demo day
 *  until one is connected (empty for real accounts). */
export function dayEventsFor(calendarConnected: boolean, externalEvents: ExternalEvent[]): CalEvent[] {
  return calendarConnected ? todaysEvents(externalEvents) : EVENTS;
}

// Plan works outside the providers in tests/storybook-style renders; inside the
// app both are always present.
function useOptionalToast() { try { return useToast(); } catch { return null; } }
function useAuthUserId(): string | undefined { try { return useAuth().user?.id; } catch { return undefined; } }

/* keyboard-only focus ring for a whole block/card (its open-button is stretched over it) */
function useFocusRing() {
  const [ring, setRing] = useState(false);
  return {
    ring,
    onFocus: (e: ReactFocusEvent<HTMLElement>) => { let v = true; try { v = e.currentTarget.matches(":focus-visible"); } catch { /* older engines */ } setRing(v); },
    onBlur: () => setRing(false),
  };
}

/** True while the element is narrower than `px` (measured, so a docked panel counts too). */
function useNarrowerThan(ref: RefObject<HTMLElement>, px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const check = () => { const w = el.getBoundingClientRect().width; if (w > 0) setNarrow(w < px); };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px]);
  return narrow;
}

const laneStyle = (l?: Lane): CSSProperties => {
  const n = Math.max(1, l?.lanes ?? 1), i = l?.lane ?? 0, gap = n > 1 ? 4 : 0;
  return { left: `calc(${LANE_LEFT}px + (100% - ${LANE_LEFT}px) * ${i / n})`, width: `calc((100% - ${LANE_LEFT}px) / ${n} - ${gap}px)` };
};

/** "Today", "Tomorrow", "Mon 28" (within the week either side), else "2 Oct". */
function dueLabel(iso: string | undefined, today: string): string | null {
  const date = parseDay(iso);
  if (!date) return null;
  const diff = daysBetween(today, iso!);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (Math.abs(diff) < 7) return `${weekdayShort(date)} ${date.getDate()}`;
  return dayMonth(date);
}

/** The capture's parse line names the day in full: "Today", "Tomorrow", else "Fri 2 Oct". */
function captureDayLabel(iso: string | undefined, today: string): string | null {
  const date = parseDay(iso);
  if (!date) return null;
  const diff = daysBetween(today, iso!);
  return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : dayLong(date);
}

type DragSource = "intake" | "canvas" | "ghost";
interface DragState {
  taskId: string;
  dur: number;
  title: string;
  energy: EnergyKind;
  source: DragSource;
  grab: number;
  /** the block's start when the drag began (null from the rail or a ghost) — dropping it back there writes nothing */
  origin: number | null;
  x0: number;
  y0: number;
  touch: boolean;
  /** only this pointer moves or drops the block (a second finger can't) */
  pointerId: number;
}

export function EnergyChip({ energy, small }: { energy: EnergyKind; small?: boolean }) {
  const e = ENERGY[energy];
  if (!e) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500,
      // text pushed off the raw palette colour so e.g. "Creative" stays ≥ 4.5:1 on its tint in light
      color: chipInk(e.color), padding: small ? "1px 6px" : "2px 7px", borderRadius: 6,
      background: chipFill(e.color), border: `1px solid ${chipEdge(e.color)}` }}>
      <Icon name={e.icon} size={small ? 11 : 12} /> {e.label}
    </span>
  );
}

/* ============================== styles ============================== */

/* Tokens are read with fallbacks to today's names (the "Paper & Navy" set
   lands separately); the aliases on .kplan keep the rules below readable. */
const PLAN_CSS = `
.kplan {
  --kp-grad-v: linear-gradient(180deg, var(--brand-blue, #5B7CFA), var(--brand-violet, #8B5CF6) 52%, var(--brand-magenta, #C24BE0));
  --kp-accent-line: var(--accent-line, color-mix(in oklch, var(--accent) 45%, transparent));
  --kp-accent-tint: var(--accent-tint, var(--accent-dim));
  --kp-icon-quiet: var(--icon-quiet, var(--ink-4));
  --kp-signal: var(--signal, var(--prio-urgent));
  --kp-e1: var(--e1, 0 0 0 1px var(--hairline), 0 1px 2px oklch(0.2 0.03 268 / 0.06));
  --kp-e2: var(--e2, 0 0 0 1px var(--hairline-strong), 0 12px 32px -12px oklch(0.2 0.03 268 / 0.28));
  --kp-r-xs: var(--r-xs, 4px); --kp-r-sm: var(--r-sm, 6px); --kp-r-md: var(--r-md, 8px);
  --kp-d1: var(--d-1, 90ms); --kp-d2: var(--d-2, 160ms); --kp-d3: var(--d-3, 240ms);
  --kp-gutter: var(--gutter, 32px);
  --kp-ui: var(--font-ui, var(--font-display));
  position: relative; flex: 1; display: flex; min-width: 0; min-height: 0;
}
.kplan[data-stacked="true"] { flex-direction: column; overflow-y: auto; overflow-x: hidden; }
@media (max-width: 859px) { .kplan { --kp-gutter: var(--gutter, 16px); } }
.kplan-main { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.kplan[data-stacked="true"] .kplan-main { flex: none; }

/* ---- the day ---- */
.kday-scroll { position: relative; flex: 1; min-height: 0; overflow-y: auto; padding: 16px var(--kp-gutter) 72px;
  /* the day slides away under the brief rather than being cut off */
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 16px); mask-image: linear-gradient(to bottom, transparent, #000 16px); }
.kplan[data-stacked="true"] .kday-scroll { flex: none; overflow: visible; padding: 16px var(--kp-gutter) 24px; -webkit-mask-image: none; mask-image: none; }
.kday-connect { display: inline-flex; align-items: center; gap: 6px; margin: 0 0 12px ${LANE_LEFT}px; padding: 0; border: 0; background: none;
  font: 500 12px/16px var(--kp-ui); color: var(--ink-3); cursor: pointer; text-decoration: underline dotted var(--ink-4); text-underline-offset: 4px; }
.kday-connect:hover { color: var(--accent-text, var(--accent)); text-decoration-color: currentColor; }
.kday-canvas { position: relative; }
.kplan[data-stacked="true"] .kday-canvas { margin-top: 8px; }
.kday-earlier { display: inline-flex; align-items: center; gap: 6px; height: 32px; margin: 0 0 4px; padding: 0 8px 0 4px; border: 0; border-radius: var(--kp-r-sm);
  background: none; cursor: pointer; font: 500 12px/16px var(--kp-ui); color: var(--ink-3); }
.kday-earlier:hover { background: var(--fill-1); color: var(--ink); }
.kday-hour { position: absolute; left: 0; right: 0; height: 0; pointer-events: none; }
.kday-hour-label { position: absolute; left: 0; top: -8px; width: 44px; text-align: right;
  font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-4); }
.kday-hour-rule { position: absolute; left: 56px; right: 0; top: 0; height: 1px; background: var(--hairline); }

.kday-event { position: absolute; z-index: 2; display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden;
  padding: 0 6px 0 12px; border-radius: var(--kp-r-sm); }
.kday-event[data-kind="meeting"] { background: var(--bg-deep); box-shadow: inset 2px 0 0 var(--kp-icon-quiet), inset 0 0 0 1px var(--hairline); }
.kday-event[data-kind="break"] { border: 1px dashed var(--hairline-strong); }
.kday-event[data-tall="true"] { flex-direction: column; align-items: flex-start; justify-content: flex-start; gap: 0; padding-top: 6px; }
/* the past recedes by its surface, never its words: the canvas's own colour (opaque, so hour
   rules don't run through it), a quiet edge, and text-safe inks */
.kday-event[data-kind="meeting"][data-past="true"] { background: var(--bg); box-shadow: inset 2px 0 0 var(--hairline-strong), inset 0 0 0 1px var(--hairline); }
.kday-event[data-past="true"] .kday-event-title { color: var(--ink-3); }
.kday-event[data-past="true"] .kday-event-meta { color: var(--ink-4); }
.kday-event[data-kind="meeting"][data-now="true"] { box-shadow: inset 2px 0 0 var(--accent), inset 0 0 0 1px var(--kp-accent-line); }
/* short of room, the time and people give way before the meeting's name does */
.kday-event-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12px/16px var(--kp-ui); color: var(--ink-2); }
.kday-event[data-kind="break"] .kday-event-title { font-weight: 500; color: var(--ink-3); }
.kday-event-meta { flex: 0 100 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kday-event-act { margin-left: auto; opacity: 0; transition: opacity var(--kp-d1) var(--ease); }
.kday-event[data-tall="true"] .kday-event-act { position: absolute; top: 4px; right: 4px; }
.kday-event:hover .kday-event-act, .kday-event:focus-within .kday-event-act { opacity: 1; }

.kday-block { position: absolute; z-index: 4; display: flex; flex-direction: column; justify-content: center; gap: 2px;
  padding: 0 4px 0 11px; border-radius: var(--kp-r-sm); overflow: hidden; cursor: grab; touch-action: pan-y;
  background: var(--surface-raised); box-shadow: var(--kp-e1);
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  transition: box-shadow var(--kp-d1) var(--ease), opacity var(--kp-d2) var(--ease); }
.kday-block::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--edge, var(--ink-4)); }
.kday-block[data-deep="true"]::before { background: var(--kp-grad-v); }
.kday-block:hover { box-shadow: var(--kp-e2); }
.kday-block[data-now="true"] { box-shadow: var(--kp-e1), 0 0 0 1px var(--kp-accent-line); }
.kday-block[data-ring="true"] { box-shadow: 0 0 0 2px var(--accent), var(--kp-e2); }
/* a block that's behind you (or just ticked off) lies flat on the canvas: no raise, its
   edge faded, its words in text-safe inks. Hover or focus lifts it back. */
.kday-block:is([data-past="true"], [data-done="true"]) { background: var(--bg); box-shadow: inset 0 0 0 1px var(--hairline); }
.kday-block:is([data-past="true"], [data-done="true"])::before { opacity: 0.45; }
.kday-block:is([data-past="true"], [data-done="true"]) .kday-block-title { color: var(--ink-3); }
.kday-block:is([data-past="true"], [data-done="true"]) .kday-block-meta,
.kday-block:is([data-past="true"], [data-done="true"]) .kday-proj { color: var(--ink-4); }
.kday-block[data-past="true"]:is(:hover, :focus-within) { background: var(--surface-raised); box-shadow: var(--kp-e2); }
.kday-block[data-past="true"]:is(:hover, :focus-within)::before { opacity: 1; }
.kday-block[data-ring="true"]:is([data-past="true"], [data-done="true"]) { box-shadow: 0 0 0 2px var(--accent), var(--kp-e2); }
.kday-block[data-dragging="true"] { opacity: 0.4; touch-action: none; }
.kday-block[data-done="true"] .kday-block-title { text-decoration: line-through; text-decoration-color: var(--ink-4); }
.kday-block[data-tall="true"] { justify-content: flex-start; padding-top: 5px; }
/* a short block grows over its neighbours while you're on it, so its actions fit */
.kday-block[data-short="true"]:hover, .kday-block[data-short="true"]:focus-within,
.kday-ghost[data-short="true"]:hover, .kday-ghost[data-short="true"]:focus-within { min-height: 30px; z-index: 6; }
.kday-block-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kday-open { position: static; flex: 1; min-width: 0; padding: 0; margin: 0; border: 0; background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: inherit; outline: none; }
.kday-open::after { content: ""; position: absolute; inset: 0; z-index: 0; }
.kday-block-title, .kday-ghost-title { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kday-block-title { font: 600 13px/16px var(--kp-ui); color: var(--ink); }
.kday-block-meta { display: flex; align-items: center; gap: 8px; min-width: 0; padding-left: 22px; overflow: hidden; pointer-events: none;
  font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); white-space: nowrap; }
.kday-proj { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  font: 500 12px/16px var(--kp-ui); color: var(--ink-3); }
.kday-glyph, .kday-acts { position: relative; z-index: 1; display: inline-flex; flex-shrink: 0; }
.kday-acts { gap: 2px; margin-left: auto; opacity: 0; transition: opacity var(--kp-d1) var(--ease); }
.kday-block:hover .kday-acts, .kday-block:focus-within .kday-acts { opacity: 1; }
/* now: "Start focus" stays in view; its neighbour (back to Unplanned) still waits for a hover */
.kday-block[data-now="true"] .kday-acts { opacity: 1; }
.kday-block[data-now="true"] .kday-acts > [data-tone="danger"] { opacity: 0; transition: opacity var(--kp-d1) var(--ease); }
.kday-block[data-now="true"]:hover .kday-acts > [data-tone="danger"], .kday-block[data-now="true"]:focus-within .kday-acts > [data-tone="danger"] { opacity: 1; }
/* in-canvas actions are compact so a half-hour block still holds them */
.kday-acts .kibtn { width: 24px; height: 24px; }
.kday-mini.kbtn { height: 24px; padding: 0 8px; gap: 4px; font-size: 12px; }
/* one column (phones, narrow widths): a meeting keeps its title; "Notes → tasks" is its icon (the name stays on the button) */
.kplan[data-stacked="true"] .kday-event .kday-mini-label { display: none; }
.kplan[data-stacked="true"] .kday-event .kday-mini.kbtn { width: 28px; padding: 0; justify-content: center; }

/* the tint is laid over the canvas (not see-through), so hour rules don't run through a suggestion */
.kday-ghost { position: absolute; z-index: 3; display: flex; flex-direction: column; justify-content: center; gap: 2px; min-width: 0; overflow: hidden;
  padding: 0 4px 0 10px; border-radius: var(--kp-r-sm); cursor: grab; touch-action: pan-y;
  border: 1px dashed var(--kp-accent-line); background: linear-gradient(var(--kp-accent-tint), var(--kp-accent-tint)), var(--bg);
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  transition: background var(--kp-d1) var(--ease), box-shadow var(--kp-d1) var(--ease); }
.kday-ghost[data-tall="true"] { justify-content: flex-start; padding-top: 5px; }
.kday-ghost-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kday-ghost-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.kday-ghost-title { font: 500 13px/16px var(--kp-ui); color: var(--ink-2); }
.kday-ghost-meta { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kday-ghost-sub { display: flex; align-items: center; gap: 8px; min-width: 0; padding-left: 22px; overflow: hidden; white-space: nowrap; pointer-events: none;
  font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kday-ghost-tag { position: relative; z-index: 1; margin-left: auto; padding-right: 6px; flex-shrink: 0; white-space: nowrap; pointer-events: none;
  font: 500 11px/16px var(--font-mono); color: var(--accent-text, var(--accent)); }
.kday-ghost[data-overdue="true"] .kday-ghost-tag { color: var(--kp-signal); }
/* the actions sit over the tag; hidden by opacity (not display) so they stay in the tab order */
.kday-ghost-acts { position: absolute; z-index: 1; right: 4px; top: 50%; translate: 0 -50%; display: inline-flex; gap: 4px;
  opacity: 0; pointer-events: none; transition: opacity var(--kp-d1) var(--ease); }
.kday-ghost[data-tall="true"] .kday-ghost-acts { top: 4px; translate: none; }
.kday-ghost:hover, .kday-ghost:focus-within { z-index: 5; border-style: solid; background: var(--surface-raised); box-shadow: 0 0 0 1px var(--kp-accent-line), var(--kp-e2); }
.kday-ghost:hover .kday-ghost-title, .kday-ghost:focus-within .kday-ghost-title { color: var(--ink); }
.kday-ghost:hover .kday-ghost-tag, .kday-ghost:focus-within .kday-ghost-tag { opacity: 0; }
.kday-ghost:hover .kday-ghost-acts, .kday-ghost:focus-within .kday-ghost-acts { opacity: 1; pointer-events: auto; }
/* with a mouse the actions are words ("Accept ⏎", "Not now"); their icons are for touch */
.kday-ghost-acts .kbtn > svg { display: none; }
.kday-ghost[data-dragging="true"] { opacity: 0.4; }
.kday-ghost[data-ring="true"] { box-shadow: 0 0 0 2px var(--accent), var(--kp-e2); }

/* the line runs under the blocks (crossing a title it would read as a strike-through);
   its dot and time sit in the gutter, and whatever is happening now wears an accent edge */
.kday-now { position: absolute; left: 56px; right: 0; height: 0; border-top: 1.5px solid var(--accent); z-index: 1; pointer-events: none; }
.kday-now::before { content: ""; position: absolute; left: -4px; top: -4.75px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.kday-now-label { position: absolute; left: 0; width: 44px; margin-top: -8px; text-align: right; z-index: 6; pointer-events: none;
  font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--accent-text, var(--accent)); }

.kday-free { position: absolute; left: ${LANE_LEFT}px; right: 0; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  border-radius: var(--kp-r-sm); pointer-events: none; font: 500 12px/16px var(--kp-ui); color: var(--ink-4);
  transition: background var(--kp-d2) var(--ease), box-shadow var(--kp-d2) var(--ease); }
.kday-free-label { white-space: nowrap; }
.kday-free-label .mono { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; }
/* the brief's "free" figure: every free stretch outlined for a moment, over any suggestion
   in it — the outline comes and goes in 160ms, and holds long enough to be seen between */
@keyframes kdayOpen { 0% { opacity: 0; } 13.3%, 86.7% { opacity: 1; } 100% { opacity: 0; } }
.kday-openpulse { position: absolute; left: ${LANE_LEFT}px; right: 0; z-index: 7; pointer-events: none; border-radius: var(--kp-r-sm);
  box-shadow: inset 0 0 0 1.5px var(--accent); background: color-mix(in oklch, var(--accent) 6%, transparent); animation: kdayOpen 1200ms linear both; }
.kday-drop { position: absolute; left: ${LANE_LEFT}px; right: 0; z-index: 5; display: flex; align-items: flex-start; padding: 5px 10px; pointer-events: none;
  border-radius: var(--kp-r-sm); border: 1.5px dashed var(--accent); background: var(--kp-accent-tint); }
.kday-drop span { font: 600 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--accent-text, var(--accent)); }
.kday-float { position: fixed; z-index: 80; max-width: 240px; padding: 7px 12px 7px 14px; pointer-events: none; overflow: hidden;
  border-radius: var(--kp-r-md); background: var(--surface-raised); box-shadow: var(--kp-e2); }
.kday-float::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--edge, var(--accent)); }
.kday-float b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 13px/18px var(--kp-ui); color: var(--ink); }
.kday-float span { display: block; font: 500 11px/16px var(--font-mono); color: var(--accent-text, var(--accent)); }

@keyframes kdayLand { from { opacity: 0.35; transform: translateY(3px) scale(0.985); } }
@keyframes kdayFade { from { opacity: 0.35; } }
.kday-block[data-landing="true"] { animation: kdayLand var(--kp-d3) var(--ease) backwards; }

/* ---- the rail ---- */
.krail { position: relative; width: var(--rail-w, 360px); flex: none; display: flex; flex-direction: column; min-height: 0;
  border-left: 1px solid var(--hairline); background: var(--bg); transition: box-shadow var(--kp-d2) var(--ease); }
.krail[data-drop="true"] { box-shadow: inset 0 0 0 2px var(--accent); }
.kplan[data-stacked="true"] .krail { width: auto; border-left: 0; border-top: 1px solid var(--hairline); }
.krail-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 20px 32px; display: flex; flex-direction: column; }
.kplan[data-stacked="true"] .krail-scroll { overflow: visible; padding: 16px var(--kp-gutter) 32px; }
.krail-dropnote { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; pointer-events: none;
  background: color-mix(in oklch, var(--accent) 8%, var(--bg)); }
.krail-dropnote span { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: var(--kp-r-md);
  border: 1px dashed var(--accent); background: var(--surface-raised); box-shadow: var(--kp-e2);
  font: 600 13px/20px var(--kp-ui); color: var(--accent-text, var(--accent)); }

.krail-cap { position: relative; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 8px 0 12px;
  border-radius: var(--kp-r-md); background: var(--field-bg, var(--surface)); cursor: text;
  box-shadow: inset 0 0 0 1px var(--field-border, var(--hairline-strong)); transition: box-shadow var(--kp-d1) var(--ease); }
.krail-cap:hover { box-shadow: inset 0 0 0 1px var(--field-border-hover, var(--hairline-strong)); }
/* the field is the ring's owner (the input inside it sits over a highlight layer):
   the same 2px accent ring every text field wears */
.krail-cap[data-focused="true"] { outline: 2px solid var(--accent); outline-offset: 1px; }
.krail-cap > svg { flex-shrink: 0; color: var(--kp-icon-quiet); }
.krail-cap[data-focused="true"] > svg { color: var(--accent-text, var(--accent)); }
.krail-cap-box { position: relative; flex: 1; min-width: 0; height: 100%; }
.krail-cap-input, .krail-cap-mirror { position: absolute; inset: 0; margin: 0; padding: 0; border: 0;
  font: 500 13px/40px var(--kp-ui); letter-spacing: 0; white-space: pre; }
.krail-cap-input { width: 100%; background: transparent; color: var(--ink); outline: none; z-index: 1; text-overflow: ellipsis; }
.krail-cap-input::placeholder { color: var(--ink-4); }
.krail-cap-mirror { overflow: hidden; color: transparent; pointer-events: none; }
.krail-cap-mirror > span { display: inline-block; }
.krail-cap-mirror mark { color: transparent; background: var(--kp-accent-tint); border-radius: var(--kp-r-xs); box-shadow: 0 0 0 2px var(--kp-accent-tint); }
.krail-parse { display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 8px 2px 0; overflow: hidden;
  font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); white-space: nowrap; }
.krail-parse-bits { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.krail-parse-keys { margin-left: auto; flex-shrink: 0; color: var(--ink-4); }

.krail-section { margin-top: 16px; }
.krail-head { display: flex; align-items: center; gap: 8px; min-height: 44px; margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--hairline); }
.krail-head h2 { margin: 0; font: 600 14px/20px var(--kp-ui); color: var(--ink); outline: none; }
.krail-head-count { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.krail-head .kbtn { margin-left: auto; }
.krail-head[data-first="true"] { margin-top: 0; padding-top: 0; border-top: 0; }
.kplan[data-stacked="true"] .krail-head + div > .krail-cap { margin-top: 4px; }
.krail-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin: 4px 0 4px; font: 500 12px/16px var(--kp-ui); color: var(--ink-3); }
.krail-filter button { border: 0; background: none; padding: 0; font: inherit; color: var(--accent-text, var(--accent)); cursor: pointer; }
.krail-filter button:hover { text-decoration: underline; text-underline-offset: 3px; }
.krail-group { padding-top: 8px; }
.krail-note { display: flex; align-items: center; gap: 8px; margin: 4px 0 0; font: 400 13px/20px var(--kp-ui); color: var(--ink-3); }
.krail-note svg { color: var(--st-done-fill, var(--st-done)); flex-shrink: 0; }
.krail-group .ksection { min-height: 24px; }

/* glyph · title · suggested slot on the first line; the meta line under the title runs to the edge */
.krail-item { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 10px; row-gap: 2px;
  margin: 0 -8px; padding: 8px;
  border-radius: var(--kp-r-sm); cursor: grab; touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  transition: background var(--kp-d1) var(--ease), opacity var(--kp-d2) var(--ease); }
.krail-item:hover { background: var(--fill-1); }
.krail-item[data-ring="true"] { box-shadow: inset 0 0 0 2px var(--accent); }
.krail-item[data-dragging="true"] { opacity: 0.45; touch-action: none; }
.krail-item[data-done="true"] .krail-item-title { text-decoration: line-through; text-decoration-color: var(--ink-4); color: var(--ink-3); }
.krail-item > .kglyph { grid-column: 1; grid-row: 1; position: relative; z-index: 1; }
.krail-item-open { grid-column: 2; grid-row: 1; }
.krail-item-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 14px/20px var(--kp-ui); color: var(--ink); }
.krail-item-meta { grid-column: 2 / 4; grid-row: 2; display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap;
  font: 500 12px/16px var(--kp-ui); color: var(--ink-3); pointer-events: none; }
.krail-item-meta > * { flex-shrink: 0; }
.krail-item-meta .mono { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; }
.krail-item-meta [data-tone="signal"] { color: var(--kp-signal); }
.krail-item-meta .krail-dot { color: var(--ink-4); }
/* when the line is short of room, the project name gives way first (it keeps its dot) */
.krail-item-meta .krail-proj { flex-shrink: 1; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.krail-item-meta .krail-proj > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.krail-side { grid-column: 3; grid-row: 1; position: relative; z-index: 1; display: flex; align-items: center; justify-content: flex-end; gap: 2px; min-width: 56px; min-height: 20px; }
.krail-slot { padding: 0 2px; border: 0; background: none; border-radius: var(--kp-r-xs); cursor: pointer;
  font: 500 11px/20px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--accent-text, var(--accent)); white-space: nowrap; }
.krail-slot:hover { text-decoration: underline; text-underline-offset: 3px; }
.krail-slot[data-later="true"] { cursor: default; font: 500 12px/20px var(--kp-ui); color: var(--ink-3); text-decoration: none; }
/* hover actions sit over the slot; hidden by opacity (not display) so they stay in the tab order */
.krail-acts { position: absolute; right: -2px; top: -4px; display: inline-flex; gap: 2px; opacity: 0; pointer-events: none;
  transition: opacity var(--kp-d1) var(--ease); }
.krail-item:hover .krail-acts, .krail-item:focus-within .krail-acts { opacity: 1; pointer-events: auto; }
.krail-item:hover .krail-slot, .krail-item:focus-within .krail-slot { opacity: 0; }
.krail-later { display: flex; align-items: center; gap: 8px; width: 100%; height: 36px; margin-top: 12px; padding: 0; border: 0;
  border-top: 1px solid var(--hairline); background: none; cursor: pointer; font: 600 12px/16px var(--kp-ui); color: var(--ink-3); text-align: left; }
.krail-later:hover { color: var(--ink); }
.krail-later svg { transition: transform var(--kp-d2) var(--ease); }
.krail-later[aria-expanded="true"] svg { transform: rotate(90deg); }
.krail-later .mono { font: 500 11px/16px var(--font-mono); color: var(--ink-4); }
.krail-carry .ksection-action { gap: 2px; }
.krail-carry-note { margin: 2px 0 0; font: 500 13px/20px var(--kp-ui); color: var(--ink-2); }
.krail-carry-sub { display: block; font: 400 12px/16px var(--kp-ui); color: var(--ink-3); }
.krail-carry-list { margin: 6px 0 0; padding: 0; list-style: none; }
.krail-carry-row { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.krail-carry-open { flex: 1; min-width: 0; padding: 0; border: 0; background: none; cursor: pointer; text-align: left;
  font: 500 13px/20px var(--kp-ui); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.krail-carry-open:hover { color: var(--accent-text, var(--accent)); }
.krail-carry-row .kglyph[aria-checked="true"] + .krail-carry-open { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-4); }
.krail-carry-at { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.krail-big3 li { list-style: none; }
.krail-big3 ol { margin: 4px 0 0; padding: 0; }
.krail-big3-row { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.krail-big3-row button.krail-big3-open { flex: 1; min-width: 0; padding: 0; border: 0; background: none; cursor: pointer; text-align: left;
  font: 500 14px/20px var(--kp-ui); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.krail-big3-row button.krail-big3-open:hover { color: var(--accent-text, var(--accent)); }
.krail-big3-row[data-done="true"] button.krail-big3-open { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-4); }
.krail-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 20px;
  font: 500 12px/16px var(--kp-ui); color: var(--ink-3); }
/* the Order menu is portalled out of .kplan: only global tokens in here */
.krail-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 10px 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); cursor: pointer; text-align: left; white-space: nowrap;
  transition: background var(--d-1, 90ms) var(--ease); }
.krail-menu-item:hover, .krail-menu-item:focus-visible { background: var(--fill-1); color: var(--ink); }
.krail-menu-item svg { color: var(--accent-text, var(--accent)); }
.krail-menu-item[aria-checked="false"] svg { visibility: hidden; }

@media (hover: none) {
  .krail-cap .kkbd { display: none; }
  .kday-acts, .kday-event-act { opacity: 1; }
  /* a tap on a suggestion opens it, so Accept and Not now can't wait for a hover:
     they're always there, as two icons where the "suggested" tag was */
  .kday-ghost-tag { display: none; }
  .kday-ghost-row { padding-right: 60px; }
  .kday-ghost-acts { opacity: 1; pointer-events: auto; }
  .kday-ghost-acts .kbtn { width: 24px; height: 24px; padding: 0; justify-content: center; }
  .kday-ghost-acts .kbtn > svg { display: inline; }
  .kday-ghost-acts :is(.kday-mini-label, .kkbd) { display: none; }
  .kday-ghost[data-short="true"] { min-height: 26px; z-index: 5; }
  /* touch: the slot and "Not today" side by side, always there */
  .krail-acts { position: static; opacity: 1; pointer-events: auto; }
  .krail-item[data-slot="true"] .iadd-place { display: none; }
  .krail-item:hover .krail-slot, .krail-item:focus-within .krail-slot { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .kday-block[data-landing="true"] { animation: kdayFade 120ms linear backwards; }
  .kday-openpulse { animation: none; }
  .kday-free, .kday-block, .kday-ghost, .krail-item, .krail-later svg, .krail-menu-item, .kday-acts, .kday-acts > * { transition: none; }
}
`;

/* ============================== day canvas pieces ============================== */

function NowLine({ nowMin, win }: { nowMin: number; win: DayWindow }) {
  if (nowMin < win.from || nowMin > win.to) return null;
  const top = yOf(nowMin, win);
  return (
    <>
      <span aria-hidden="true" className="kday-now-label" style={{ top }}>{fmtTime(nowMin)}</span>
      <div aria-hidden="true" className="kday-now" style={{ top }} />
    </>
  );
}

function EventBlock({ ev, lane, win, nowMin, onExtract }: { ev: CalEvent; lane?: Lane; win: DayWindow; nowMin: number; onExtract?: (title: string) => void }) {
  // (a phone's agenda can start part-way through a meeting)
  const from = Math.max(ev.start, win.from);
  const top = yOf(from, win), h = (ev.end - from) * win.pxm;
  const tall = h >= 44;
  const meeting = ev.kind !== "break";
  return (
    <div className="kday-event" data-kind={meeting ? "meeting" : "break"} data-tall={tall || undefined} data-past={ev.end <= nowMin || undefined}
      data-now={(ev.start <= nowMin && ev.end > nowMin) || undefined}
      style={{ ...inset(top, h), ...laneStyle(lane) }}>
      <span className="kday-event-title">{ev.title}</span>
      <span className="kday-event-meta">{fmtTimeRange(ev.start, ev.end)}{ev.with?.length ? ` · ${ev.with.join(", ")}` : ""}</span>
      {meeting && onExtract && (
        <Button variant="ghost" size="sm" icon="notes" className="kday-event-act kday-mini" aria-label={`Turn notes from “${ev.title}” into tasks`}
          onClick={() => onExtract(ev.title)}><span className="kday-mini-label">Notes → tasks</span></Button>
      )}
    </div>
  );
}

function TaskBlock({ task, start, lane, win, nowMin, helpId, readOnly, onStartDrag, onOpen, onRemove, onKeyMove, onKeyBlur, onToggle, onStartFocus, dragging, landing }: {
  task: Task; start: number; lane?: Lane; win: DayWindow; nowMin: number; helpId: string; readOnly?: boolean;
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource, at?: number) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string, viaKeyboard: boolean) => void;
  onKeyMove: (ev: ReactKeyboardEvent, task: Task) => void;
  onKeyBlur: () => void;
  onToggle: (task: Task) => void;
  onStartFocus?: (id: string) => void;
  dragging?: boolean; landing?: number;
}) {
  const dur = durOf(task);
  const shown = Math.max(start, win.from);
  const top = yOf(shown, win), h = Math.max(MIN_BLOCK_PX, (start + dur - shown) * win.pxm);
  const proj = getProject(task.projectId);
  const deep = energyKindOf(task) === "deep";
  const now = start <= nowMin && start + dur > nowMin;
  const range = fmtTimeRange(start, start + dur);
  const tall = h >= 46;
  const done = task.status === "done";
  const focus = useFocusRing();
  const style = { ...inset(top, h), ...laneStyle(lane), "--edge": proj ? projectPaint(proj.color).solid : undefined, animationDelay: landing != null ? `${landing * 40}ms` : undefined } as CSSProperties;
  return (
    <div onPointerDown={(ev) => onStartDrag(ev, task, "canvas")} className="kday-block" style={style}
      data-deep={deep || undefined} data-now={(now && !done) || undefined} data-past={(start + dur <= nowMin && !done) || undefined}
      data-ring={focus.ring || undefined} data-dragging={dragging || undefined} data-landing={landing != null || undefined}
      data-tall={tall || undefined} data-short={h < 28 || undefined} data-done={done || undefined}>
      <div className="kday-block-row">
        <span className="kday-glyph" onPointerDown={stop}>
          <StatusGlyph status={task.status} size={14} label={task.title} celebrateKey={task.id}
            readOnly={readOnly} onToggle={readOnly ? undefined : () => onToggle(task)} />
        </span>
        <button type="button" className="kday-open" data-block-id={task.id} onClick={() => onOpen(task.id)}
          onKeyDown={(ev) => onKeyMove(ev, task)} onFocus={focus.onFocus} onBlur={() => { focus.onBlur(); onKeyBlur(); }}
          aria-label={`${task.title}, ${range}${now ? ", happening now" : ""}`} aria-describedby={helpId}>
          <span className="kday-block-title">{task.title}</span>
        </button>
        {!readOnly && (
          <span className="kday-acts" onPointerDown={stop}>
            {onStartFocus && (now && !done && h >= 28
              // the block you should be in right now says so, without waiting for a hover
              ? <Button size="sm" variant="secondary" icon="play" className="kday-mini" aria-label={`Start focus on “${task.title}”`}
                  onClick={(ev) => { ev.stopPropagation(); onStartFocus(task.id); }}>Start focus</Button>
              : <button type="button" className="kibtn" data-size="sm" title="Start focus" aria-label={`Start focus on “${task.title}”`}
                  onClick={(ev) => { ev.stopPropagation(); onStartFocus(task.id); }}>
                  <Icon name="play" size={14} sw={1.75} />
                </button>
            )}
            <button type="button" className="kibtn" data-size="sm" data-tone="danger" title="Back to Unplanned" aria-label={`Move “${task.title}” back to Unplanned`}
              onClick={(ev) => { ev.stopPropagation(); onRemove(task.id, ev.detail === 0); }}>
              <Icon name="x" size={14} sw={1.75} />
            </button>
          </span>
        )}
      </div>
      {tall && (
        <div className="kday-block-meta" aria-hidden="true">
          <span>{fmtTime(start)} · {fmtDuration(dur)}</span>
          {proj && <span className="kday-proj"><ProjectDot color={proj.color} />{proj.name}</span>}
        </div>
      )}
    </div>
  );
}

function GhostView({ task, ghost, lane, win, helpId, onStartDrag, onOpen, onAccept, onSkip, dragging }: {
  task: Task; ghost: GhostBlock; lane?: Lane; win: DayWindow; helpId: string;
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource, at?: number) => void;
  onOpen: (id: string) => void;
  onAccept: (g: GhostBlock, viaKeyboard: boolean) => void;
  onSkip?: (id: string, viaKeyboard: boolean) => void;
  dragging?: boolean;
}) {
  const dur = ghost.end - ghost.start;
  const top = yOf(ghost.start, win), h = Math.max(MIN_BLOCK_PX, dur * win.pxm);
  const range = fmtTimeRange(ghost.start, ghost.end);
  const tall = h >= 46;
  const proj = tall ? getProject(task.projectId) : undefined;
  const focus = useFocusRing();
  return (
    <div className="kday-ghost" data-overdue={ghost.overdue || undefined} data-tall={tall || undefined} data-short={h < 28 || undefined} data-dragging={dragging || undefined} data-ring={focus.ring || undefined}
      onPointerDown={(ev) => onStartDrag(ev, task, "ghost", ghost.start)}
      style={{ ...inset(top, h), ...laneStyle(lane) }}>
      <div className="kday-ghost-row">
        <span aria-hidden="true" className="kday-glyph"><StatusGlyph status={task.status} size={14} readOnly /></span>
        <button type="button" className="kday-open" data-ghost-id={task.id} onClick={() => onOpen(task.id)} onFocus={focus.onFocus} onBlur={focus.onBlur}
          onKeyDown={(ev) => {
            if (ev.key !== "Enter" || ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey) return;
            ev.preventDefault(); ev.stopPropagation();
            onAccept(ghost, true);
          }}
          aria-label={`Suggested: ${task.title}, ${range}${ghost.overdue ? ", overdue" : ""}`} aria-describedby={helpId}>
          <span className="kday-ghost-line">
            <span className="kday-ghost-title">{task.title}</span>
            <span className="kday-ghost-meta" aria-hidden="true">{fmtDuration(dur)}</span>
          </span>
        </button>
        <span className="kday-ghost-tag" aria-hidden="true">{ghost.overdue ? "Overdue · suggested" : "suggested"}</span>
      </div>
      {tall && (
        <div className="kday-ghost-sub" aria-hidden="true">
          <span>{range}</span>
          {proj && <span className="kday-proj"><ProjectDot color={proj.color} />{proj.name}</span>}
        </div>
      )}
      {/* with a mouse they appear on hover or focus; on touch they're always there, as icons */}
      <span className="kday-ghost-acts" onPointerDown={stop}>
        <Button size="sm" className="kday-mini" kbd="⏎" icon="check" aria-label={`Accept: ${task.title} at ${fmtTime(ghost.start)}`}
          onClick={(ev) => { ev.stopPropagation(); onAccept(ghost, ev.detail === 0); }}><span className="kday-mini-label">Accept</span></Button>
        {onSkip && (
          <Button size="sm" variant="ghost" className="kday-mini" icon="x" aria-label={`Not now: hide the suggestion for “${task.title}” today`}
            onClick={(ev) => { ev.stopPropagation(); onSkip(task.id, ev.detail === 0); }}><span className="kday-mini-label">Not now</span></Button>
        )}
      </span>
    </div>
  );
}

interface CanvasBlock { task: Task; start: number }

function DayCanvas({ blocks, ghosts, taskById, events, nowMin, win, helpId, readOnly, onStartDrag, onOpen, onRemove, onKeyMove, onKeyBlur, onToggle, onStartFocus,
  onAccept, onSkip, onExtract, dragId, previewStart, previewDur, canvasRef, landing, freeGaps, openTime, pulse }: {
  blocks: CanvasBlock[];
  ghosts: GhostBlock[];
  taskById: Map<string, Task>;
  events: CalEvent[];
  nowMin: number;
  win: DayWindow;
  helpId: string;
  readOnly?: boolean;
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource, at?: number) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string, viaKeyboard: boolean) => void;
  onKeyMove: (ev: ReactKeyboardEvent, task: Task) => void;
  onKeyBlur: () => void;
  onToggle: (task: Task) => void;
  onStartFocus?: (id: string) => void;
  onAccept: (g: GhostBlock, viaKeyboard: boolean) => void;
  onSkip?: (id: string, viaKeyboard: boolean) => void;
  onExtract?: (title: string) => void;
  dragId?: string;
  previewStart: number | null;
  previewDur: number;
  canvasRef: RefObject<HTMLDivElement>;
  landing?: Record<string, number>;
  freeGaps: { start: number; end: number }[];
  openTime: { start: number; end: number }[];
  pulse: boolean;
}) {
  const totalH = (win.to - win.from) * win.pxm;
  const hours: number[] = [];
  for (let m = win.from; m <= win.to; m += 60) hours.push(m);
  const nowIn = nowMin >= win.from && nowMin <= win.to;
  // overlapping blocks (two tasks at once, a task over a meeting) sit side by side.
  // A short block is drawn taller than its time (MIN_BLOCK_PX); only when that would
  // hide more than a few px of the next one does it move over, so back-to-back
  // 20-minute tasks stay in one column, even at a phone's 56px an hour.
  const minDur = (MIN_BLOCK_PX - 6) / win.pxm;
  const lanes = layoutLanes([
    ...events.map((ev) => ({ id: "ev:" + ev.id, start: ev.start, end: ev.end })),
    ...blocks.map((b) => ({ id: "t:" + b.task.id, start: b.start, end: b.start + Math.max(durOf(b.task), minDur) })),
    ...ghosts.map((g) => ({ id: "g:" + g.id, start: g.start, end: g.start + Math.max(g.end - g.start, minDur) })),
  ]);
  return (
    <div ref={canvasRef} className="kday-canvas" role="group" aria-label="Your day" style={{ height: totalH }}>
      {hours.map((m) => (
        <div key={m} aria-hidden="true" className="kday-hour" style={{ top: yOf(m, win) }}>
          {/* the now label takes the gutter near now, so the two never collide */}
          {!(nowIn && Math.abs(m - nowMin) <= 20) && <span className="kday-hour-label">{fmtTime(m)}</span>}
          <span className="kday-hour-rule" />
        </div>
      ))}
      {!dragId && freeGaps.map((g) => {
        const len = g.end - g.start, h = len * win.pxm - 4;
        // a gap centred on the hour would put its label on the hour rule (it reads as struck
        // through): step it just clear of the rule, above or below, while the gap has room
        const mid = (g.start + g.end) / 2;
        const off = (mid - Math.round(mid / 60) * 60) * win.pxm;
        const shift = Math.abs(off) < FREE_LABEL_CLEAR && h / 2 - 8 >= FREE_LABEL_CLEAR ? (off >= 0 ? FREE_LABEL_CLEAR - off : -(FREE_LABEL_CLEAR + off)) : 0;
        return (
          <div key={`free-${g.start}`} aria-hidden="true" className="kday-free"
            style={{ top: yOf(g.start, win) + 2, height: h }}>
            {len >= FREE_LABEL_MIN && (
              <span className="kday-free-label" style={shift ? { transform: `translateY(${shift}px)` } : undefined}>
                Free · <span className="mono">{fmtDuration(len)}</span>
              </span>
            )}
          </div>
        );
      })}
      {pulse && openTime.map((g) => (
        <div key={`open-${g.start}`} aria-hidden="true" className="kday-openpulse" style={{ top: yOf(g.start, win) + 1, height: (g.end - g.start) * win.pxm - 2 }} />
      ))}
      {/* meetings, suggestions and blocks in one clock-ordered run, so Tab walks the day in order
          (blocks by their saved time: a keyboard nudge never moves the focused node) */}
      {[
        ...events.filter((ev) => ev.end > win.from).map((ev) => ({ at: ev.start, node: (
          <EventBlock key={"e" + ev.id} ev={ev} lane={lanes["ev:" + ev.id]} win={win} nowMin={nowMin} onExtract={readOnly ? undefined : onExtract} />
        ) })),
        ...ghosts.flatMap((g) => {
          const t = taskById.get(g.id);
          return t ? [{ at: g.start, node: (
            <GhostView key={"g" + g.id} task={t} ghost={g} lane={lanes["g:" + g.id]} win={win} helpId={helpId + "-g"}
              onStartDrag={onStartDrag} onOpen={onOpen} onAccept={onAccept} onSkip={onSkip} dragging={dragId === g.id} />
          ) }] : [];
        }),
        ...blocks.filter((b) => b.start + durOf(b.task) > win.from).map((b) => ({ at: b.task.scheduled ?? b.start, node: (
          <TaskBlock key={"t" + b.task.id} task={b.task} start={b.start} lane={lanes["t:" + b.task.id]} win={win} nowMin={nowMin} helpId={helpId} readOnly={readOnly}
            onStartDrag={onStartDrag} onOpen={onOpen} onRemove={onRemove} onKeyMove={onKeyMove} onKeyBlur={onKeyBlur} onToggle={onToggle}
            onStartFocus={onStartFocus} dragging={dragId === b.task.id} landing={landing?.[b.task.id]} />
        ) })),
      ].sort((x, y) => x.at - y.at).map((x) => x.node)}
      {previewStart != null && (
        <div className="kday-drop" style={inset(yOf(previewStart, win), Math.max(MIN_BLOCK_PX, previewDur * win.pxm))}>
          <span>{fmtTimeRange(previewStart, previewStart + previewDur)}</span>
        </div>
      )}
      <NowLine nowMin={nowMin} win={win} />
    </div>
  );
}

/* ============================== the rail ============================== */

/** Capture, with the words Kanbo understood highlighted as you type. */
function CaptureField({ onCapture, onCapturePlan, inputRef, defaults, today, projects, members }: {
  onCapture: (t: Task) => void;
  /** Tab: add it and put it on the day */
  onCapturePlan: (t: Task) => void;
  inputRef: RefObject<HTMLInputElement>;
  defaults?: CaptureOptions;
  today: string;
  projects: { id: string; name: string }[];
  members: { id: string; name: string }[];
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const parseId = useId();
  const projectId = defaults?.projectId, assigneeId = defaults?.assigneeId;
  // "today" / "fri" resolve against the date, so the parse re-reads it when the day changes under a half-typed capture
  const nl = useMemo(() => (text.trim() ? parseTask(text, { projects, members }) : null), [text, today, projects, members]);
  const cap = useMemo(() => (text.trim().length > 1 ? parseCapture(text, { projectId, assigneeId }) : null), [text, today, projectId, assigneeId]);

  const build = (): Task | null => {
    const t = parseCapture(text, { projectId, assigneeId });
    if (!t) return null;
    // the one grammar knows a few things the capture parser doesn't (yet): a time, @person, #project
    const p = parseTask(text, { projects, members });
    return {
      ...t,
      ...(p.dueTime ? { dueTime: p.dueTime } : {}),
      ...(p.assigneeId ? { assigneeId: p.assigneeId } : {}),
      ...(p.projectId ? { projectId: p.projectId } : {}),
    };
  };
  const submit = (plan: boolean) => {
    const t = build(); if (!t) return;
    (plan ? onCapturePlan : onCapture)(t);
    setText("");
  };

  // the highlight layer scrolls with the text
  const syncScroll = () => {
    const input = inputRef.current, m = mirrorRef.current;
    if (input && m) m.style.transform = `translateX(${-input.scrollLeft}px)`;
  };
  useLayoutEffect(syncScroll);

  const spans = (nl?.spans ?? []).filter((s: NlpSpan) => s.end > s.start).sort((a, b) => a.start - b.start);
  const marked: ReactNode[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    marked.push(text.slice(at, s.start), <mark key={s.start}>{text.slice(s.start, s.end)}</mark>);
    at = s.end;
  }
  marked.push(text.slice(at));

  const bits: string[] = [];
  if (cap?.dueDate || nl?.dueDate) bits.push(captureDayLabel(nl?.dueDate ?? cap?.dueDate, today) ?? "");
  if (nl?.dueTime) bits.push(nl.dueTime);
  if (cap) bits.push(fmtDuration(durOf(cap)));
  if (nl?.assigneeId) bits.push(members.find((m) => m.id === nl.assigneeId)?.name ?? "");
  if (nl?.projectId) bits.push(projects.find((p) => p.id === nl.projectId)?.name ?? "");
  const line = bits.filter(Boolean).join(" · ");

  return (
    <div>
      <div className="krail-cap" data-focused={focused || undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); inputRef.current?.focus(); } }}>
        <Icon name="plus" size={16} sw={1.75} />
        <div className="krail-cap-box">
          <div className="krail-cap-mirror" aria-hidden="true"><span ref={mirrorRef}>{marked}</span></div>
          <input ref={inputRef} className="krail-cap-input" value={text} spellCheck={false} autoComplete="off"
            onChange={(e) => setText(e.target.value)} onScroll={syncScroll} onKeyUp={syncScroll}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); submit(false); }
              else if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && text.trim()) { e.preventDefault(); submit(true); }
              else if (e.key === "Escape" && text) { e.stopPropagation(); setText(""); }
            }}
            aria-label="Capture a task for today" aria-describedby={parseId} data-focus-ring="none"
            placeholder="Add a task — try “call Sana fri 3pm ~30m”" />
        </div>
        {!focused && !text && <span aria-hidden="true" title="Press q to jump here"><Kbd>Q</Kbd></span>}
      </div>
      <div id={parseId} className="krail-parse" aria-live="polite">
        {text.trim() ? (
          <>
            <span className="krail-parse-bits">{line}</span>
            <span className="krail-parse-keys" aria-hidden="true">⏎ add · ⇥ plan</span>
            <span className="sr-only">Press Enter to add it, or Tab to add it and plan it.</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

type RailOrder = "smart" | "due" | "priority" | "duration";
const ORDER_LABEL: Record<RailOrder, string> = { smart: "Smart order", due: "Due", priority: "Priority", duration: "Duration" };
const ORDER_KEY = "kanbo-rail-order";
function readOrder(): RailOrder {
  try { const v = localStorage.getItem(ORDER_KEY); if (v && v in ORDER_LABEL) return v as RailOrder; } catch { /* blocked */ }
  return "smart";
}

const prioRank = (t: Task) => PRIORITY_META[t.priority]?.rank ?? 0;
const dueKey = (t: Task) => t.dueDate?.slice(0, 10) || "9999-99-99";
const byOrder: Record<RailOrder, (a: Task, b: Task) => number> = {
  smart: (a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0) || dueKey(a).localeCompare(dueKey(b)) || prioRank(b) - prioRank(a),
  due: (a, b) => dueKey(a).localeCompare(dueKey(b)) || (b.aiScore ?? 0) - (a.aiScore ?? 0),
  priority: (a, b) => prioRank(b) - prioRank(a) || dueKey(a).localeCompare(dueKey(b)),
  duration: (a, b) => durOf(a) - durOf(b) || (b.aiScore ?? 0) - (a.aiScore ?? 0),
};

function OrderMenu({ value, onChange }: { value: RailOrder; onChange: (o: RailOrder) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={ref} variant="ghost" size="sm" iconRight="chevronDown" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Order: ${ORDER_LABEL[value]}`} onClick={() => setOpen((o) => !o)}>{ORDER_LABEL[value]}</Button>
      <Popover open={open} anchorRef={ref} onClose={() => setOpen(false)} align="end" label="Order unplanned tasks" minWidth={180}>
        {(Object.keys(ORDER_LABEL) as RailOrder[]).map((o) => (
          <button key={o} type="button" role="menuitemradio" aria-checked={o === value} className="krail-menu-item"
            onClick={() => { onChange(o); setOpen(false); }}>
            <Icon name="check" size={16} sw={2} /> {o === "smart" ? "Smart (Kanbo's order)" : ORDER_LABEL[o]}
          </button>
        ))}
      </Popover>
    </>
  );
}

function RailItem({ task, today, me, slot, tomorrow, readOnly, dragging, canSkip, onStartDrag, onOpen, onToggle, onAccept, onSchedule, onNotToday }: {
  task: Task; today: string; me?: string;
  /** Kanbo's suggested start ("→ 14:00"), or "Tomorrow" when it doesn't fit */
  slot?: GhostBlock; tomorrow?: boolean;
  readOnly?: boolean; dragging?: boolean;
  /** today's list can wave away what isn't on it (Today does; a bare PlanView can't) */
  canSkip?: boolean;
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource) => void;
  onOpen: (id: string) => void;
  onToggle: (task: Task) => void;
  onAccept: (g: GhostBlock, viaKeyboard: boolean) => void;
  onSchedule: (id: string, viaKeyboard: boolean) => void;
  onNotToday: (task: Task, ev: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const proj = getProject(task.projectId);
  const due = dueLabel(task.dueDate, today);
  const overdue = !!task.dueDate && task.dueDate.slice(0, 10) < today;
  const from = task.createdBy && task.createdBy !== me && task.assigneeId === me ? getMember(task.createdBy)?.name?.split(/\s+/)[0] : undefined;
  const focus = useFocusRing();
  const done = task.status === "done";
  return (
    <div data-intake-card className="krail-item" data-slot={(!!slot && !readOnly) || undefined} data-ring={focus.ring || undefined} data-dragging={dragging || undefined} data-done={done || undefined}
      onPointerDown={readOnly ? undefined : (ev) => onStartDrag(ev, task, "intake")}>
      <StatusGlyph status={task.status} label={task.title} celebrateKey={task.id} readOnly={readOnly} onToggle={readOnly ? undefined : () => onToggle(task)} />
      <button type="button" data-intake-open className="kday-open krail-item-open" onClick={() => onOpen(task.id)} onFocus={focus.onFocus} onBlur={focus.onBlur}
        aria-label={`${task.title}, ${fmtDuration(durOf(task))}${due ? `, due ${due}` : ""}${slot ? `, suggested for ${fmtTime(slot.start)}` : ""}`}>
        <span className="krail-item-title">{task.title}</span>
      </button>
      {/* the meta line runs the full width, under the suggested slot too */}
      <div className="krail-item-meta" aria-hidden="true">
        <span className="mono">{fmtDuration(durOf(task))}</span>
        {proj && <><span className="krail-dot">·</span><span className="krail-proj"><ProjectDot color={proj.color} /><span>{proj.name}</span></span></>}
        {due && <><span className="krail-dot">·</span><span className="mono" data-tone={overdue ? "signal" : undefined}>{due}</span></>}
        {from && <><span className="krail-dot">·</span><span className="krail-from">from {from}</span></>}
      </div>
      <div className="krail-side" onPointerDown={stop}>
        {slot && !readOnly ? (
          <button type="button" className="krail-slot" aria-label={`Plan “${task.title}” at ${fmtTime(slot.start)}`} title="Put it there"
            onClick={(ev) => onAccept(slot, ev.detail === 0)}>→ {fmtTime(slot.start)}</button>
        ) : tomorrow ? <span className="krail-slot" data-later="true" title="Doesn't fit in what's left of today">Tomorrow</span> : null}
        {!readOnly && (
          <span className="krail-acts">
            <button type="button" className="kibtn iadd-place" data-size="sm" title="Place on day" aria-label={`Place “${task.title}” on your day`}
              onClick={(ev) => { ev.stopPropagation(); onSchedule(task.id, ev.detail === 0); }}>
              <Icon name="plus" size={16} sw={1.75} />
            </button>
            {(task.planToday || canSkip) && (
              <button type="button" className="kibtn" data-size="sm" data-tone="danger" title="Not today" aria-label={`Not today: take “${task.title}” off today's list`}
                onClick={(ev) => { ev.stopPropagation(); onNotToday(task, ev); }}>
                <Icon name="x" size={16} sw={1.75} />
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/* ============================== the view ============================== */

export interface PlanViewProps {
  tasks: Task[];
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onCreate: (t: Task) => void;
  onOpen: (id: string) => void;
  externalEvents?: ExternalEvent[];
  calendarConnected?: boolean;
  /** the signed-in user; scopes the new-day carry-over to their own tasks (defaults to the auth user) */
  currentUserId?: string;
  /** where a capture is filed (the active workspace's project, the signed-in user) — used by the preview and the new task */
  captureDefaults?: CaptureOptions;
  /* ---- Today (all optional: PlanView stands alone without them) ---- */
  /** the brief and its actions, above the canvas; as a function it's told where a
   *  task held over the Daybeam would land, so the beam can show it */
  lede?: ReactNode | ((beamDrop: { start: number; end: number } | null) => ReactNode);
  /** today's meetings (TodayView shares them with the brief); default: from the calendar props */
  events?: CalEvent[];
  /** the clock (TodayView shares it with the brief) */
  nowMin?: number;
  /** Kanbo's suggested blocks, drawn as ghosts; accepting one writes it */
  ghosts?: GhostBlock[];
  /** candidates that don't fit today ("Tomorrow" in the rail) */
  tomorrowIds?: string[];
  /** ids waved away for today ("Not now"): they wait under Later */
  skipped?: string[];
  onSkip?: (id: string) => void;
  /** brings a waved-away task back (the Undo on "Not today" and "Not now") */
  onUnskip?: (id: string) => void;
  /** blocks Plan my day just committed → their stagger index (they land 40ms apart) */
  landing?: Record<string, number>;
  /** guests: a read-only day (no capture, no dragging, no ticking off) */
  readOnly?: boolean;
  onStartFocus?: (id: string) => void;
  onExtractFromMeeting?: (meetingTitle: string) => void;
  onConnectCalendar?: () => void;
  /** show only the due-today or overdue group (the brief's figures) */
  railFocus?: "due" | "overdue" | null;
  onRailFocus?: (f: "due" | "overdue" | null) => void;
  /** bump to flash the free gaps (the brief's "free" figure) */
  freePulse?: number;
  /** this week's Big 3 task ids */
  big3?: string[];
  onOpenMyTasks?: () => void;
  onShutdown?: () => void;
  /** people and projects for @mentions and #projects in the capture field */
  members?: { id: string; name: string }[];
  projects?: { id: string; name: string }[];
}

export function PlanView({
  tasks, onUpdate, onCreate, onOpen, externalEvents = [], calendarConnected = false, currentUserId, captureDefaults,
  lede, events: eventsProp, nowMin: nowProp, ghosts = [], tomorrowIds, skipped, onSkip, onUnskip, landing, readOnly = false,
  onStartFocus, onExtractFromMeeting, onConnectCalendar, railFocus = null, onRailFocus, freePulse, big3, onOpenMyTasks, onShutdown,
  members: membersProp, projects: projectsProp,
}: PlanViewProps) {
  const authUserId = useAuthUserId();
  const me = currentUserId ?? authUserId;
  const toast = useOptionalToast();
  const clock = useDayClock();
  const nowMin = nowProp ?? clock.nowMin;
  const day = clock.day;
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const isPhone = useMediaQuery("(max-width: 859px)");
  const helpId = useId();

  // Once a real calendar is connected, plan around its events (today's, timed).
  // Before that, fall back to the illustrative demo day so the view isn't empty.
  const ownEvents = useMemo(
    () => dayEventsFor(calendarConnected, externalEvents),
    // `day` re-reads "today's" events after midnight
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [calendarConnected, externalEvents, day],
  );
  const dayEvents = eventsProp ?? ownEvents;
  const members = useMemo(() => membersProp ?? MEMBERS.map((m) => ({ id: m.id, name: m.name })), [membersProp]);
  const projects = useMemo(() => projectsProp ?? PROJECTS.filter((p) => !p.archivedAt).map((p) => ({ id: p.id, name: p.name })), [projectsProp]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [previewStart, setPreviewStart] = useState<number | null>(null);
  const [overRail, setOverRail] = useState(false);
  const [overBeam, setOverBeam] = useState(false);
  const [kb, setKb] = useState<{ id: string; start: number } | null>(null);
  const [srMsg, setSrMsg] = useState("");
  const [linger, setLinger] = useState<ReadonlySet<string>>(() => new Set());
  const [order, setOrderState] = useState<RailOrder>(readOrder);
  const [laterOpen, setLaterOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // phones, and any width too narrow for the day and the rail side by side: one
  // column (the agenda from an hour before now, then Unplanned), and the page scrolls
  const stacked = useNarrowerThan(rootRef, STACK_UNDER) || isPhone;
  const railRef = useRef<HTMLElement>(null);
  const railScrollRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const dayHeadingRef = useRef<HTMLHeadingElement>(null);
  const intakeHeadingRef = useRef<HTMLHeadingElement>(null);
  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const pendingRef = useRef<(() => void) | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(0);
  const lastDragEndRef = useRef(-Infinity); // no drag has ended yet — a click right after load still opens
  const kbRef = useRef(kb); kbRef.current = kb;
  const kbTimer = useRef(0);
  const revealRef = useRef<{ id: string; focus: boolean } | null>(null);
  const touchDragRef = useRef(false);

  const setOrder = (o: RailOrder) => { setOrderState(o); try { localStorage.setItem(ORDER_KEY, o); } catch { /* blocked */ } };

  // Browsers decide at touchstart whether a touch's moves can be cancelled, so a
  // listener added once a long-press turns into a drag would be too late. This
  // one is always there, and only stops the page scrolling while a finger is
  // actually dragging a block.
  useEffect(() => {
    const el = rootRef.current; if (!el) return;
    const onTouchMove = (e: TouchEvent) => { if (touchDragRef.current && e.cancelable) e.preventDefault(); };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, []);

  const announce = useCallback((msg: string) => {
    // a trailing zero-width space toggles so a repeated message is still announced
    setSrMsg((prev) => (prev === msg ? msg + "​" : msg));
  }, []);
  const notify = useCallback((msg: string) => { if (toast) toast.toast(msg); else announce(msg); }, [toast, announce]);

  /* ----- what's on today's plan ----- */
  // Finished and archived tasks leave the canvas, so yesterday's struck-through
  // blocks can't pile up on today (one you've just ticked off lingers a moment).
  const live = tasks.filter((t) => !t.archivedAt);
  const planTasks = live.filter((t) => t.planToday && (t.status !== "done" || linger.has(t.id)));
  const blocks: CanvasBlock[] = planTasks.filter(isPlaced)
    // DOM (and so Tab) order follows the clock — by the saved time, so a block
    // being nudged from the keyboard doesn't jump in the DOM (and lose focus) mid-move
    .sort((a, b) => a.scheduled! - b.scheduled!)
    .map((t) => ({ task: t, start: kb && kb.id === t.id ? kb.start : t.scheduled! }));
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // a ghost for a task that has since been placed, finished or archived is stale
  const liveGhosts = readOnly ? [] : ghosts.filter((g) => { const t = taskById.get(g.id); return !!t && !isPlaced(t) && t.status !== "done" && !t.archivedAt; });
  const ghostById = new Map(liveGhosts.map((g) => [g.id, g]));

  // one column shows a single agenda from an hour before now (earlier hours on request) to the evening
  const [earlier, setEarlier] = useState(false);
  const win: DayWindow = (() => {
    if (!stacked) return FULL_DAY;
    const from = earlier ? DAY_START : clamp(Math.floor(nowMin / 60) * 60 - 60, DAY_START, DAY_END - 4 * 60);
    const last = Math.max(18 * 60, ...dayEvents.map((e) => e.end), ...blocks.map((b) => b.start + durOf(b.task)), ...liveGhosts.map((g) => g.end));
    return { from, to: clamp(Math.ceil((last + 30) / 60) * 60, from + 4 * 60, DAY_END), pxm: isPhone ? PHONE_PXM : 1 };
  })();

  // the working day's free time still ahead: all of it (what the brief's "free"
  // counts, outlined when you ask), and what's left around the suggestions (labelled)
  const blockSpans = blocks.filter((b) => b.task.status !== "done").map((b) => ({ start: b.start, end: b.start + durOf(b.task) }));
  const openTime = freeGapsOf([], dayEvents, Math.ceil(nowMin / 5) * 5, { extra: blockSpans }).filter((g) => g.end - g.start >= 5);
  const freeGaps = freeGapsOf([], dayEvents, Math.ceil(nowMin / 5) * 5, { extra: [...blockSpans, ...liveGhosts] }).filter((g) => g.end - g.start >= 15);

  // the brief's "free" figure flashes the gaps, and brings the first into view
  const lastPulse = useRef(freePulse);
  useEffect(() => {
    if (freePulse == null || freePulse === lastPulse.current) return;
    lastPulse.current = freePulse;
    setPulse(true);
    const g = openTime[0], sc = scrollRef.current;
    if (g && sc && !stacked) {
      const y = yOf(g.start, win);
      if (y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - 40) sc.scrollTo({ top: Math.max(0, y - 60), behavior: reduceMotion ? "auto" : "smooth" });
    }
    const t = window.setTimeout(() => setPulse(false), 1200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freePulse]);

  // on open, scroll so the hour before now sits at the top, its label in full (don't
  // strand the user at 7am) — as soon as the day can scroll (a view mounted while
  // hidden gets its size later)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || stacked) return;
    const go = () => {
      if (el.clientHeight === 0 || el.scrollHeight <= el.clientHeight) return false;
      const hour = Math.max(DAY_START, Math.floor((clamp(nowMin, DAY_START, DAY_END) - 60) / 60) * 60);
      // that hour's rule 24px down, its label clear of the fade; late in the day the
      // scroll runs out first, so land on the latest hour that still sits there whole
      const base = (canvasRef.current?.offsetTop ?? 0) - 24, perHour = 60 * win.pxm;
      const max = el.scrollHeight - el.clientHeight;
      const want = base + yOf(hour, win);
      el.scrollTop = Math.max(0, want <= max ? want : base + Math.floor((max - base) / perHour) * perHour);
      return true;
    };
    if (go() || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => { if (go()) ro.disconnect(); });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- new day: offer to carry over or clear an earlier day's unfinished blocks -----
     This device remembers the day and time it last saw each of my blocks
     (planCanvas.recordSeen); a block it saw on an earlier day, still at the same
     time, is left over from that day's plan. */
  const seenKey = planSeenKey(me);
  const [seenState, setSeenState] = useState(() => ({ key: seenKey, map: readSeen(seenKey) }));
  const seenRef = useRef(seenState); seenRef.current = seenState;
  const saveSeen = useCallback((key: string, map: SeenMap) => {
    const st = { key, map };
    seenRef.current = st; setSeenState(st); writeSeen(key, map);
  }, []);
  useEffect(() => {
    const cur = seenRef.current.key === seenKey ? seenRef.current.map : readSeen(seenKey); // another person signed in
    const next = recordSeen(cur, tasks, day, me);
    if (next) saveSeen(seenKey, next);
    else if (seenRef.current.key !== seenKey) { const st = { key: seenKey, map: cur }; seenRef.current = st; setSeenState(st); }
  }, [tasks, day, me, seenKey, saveSeen]);
  // a block that's moved or taken off the day is no longer left over
  const touchBlock = useCallback((id: string, at: number | null) => {
    const { key, map } = seenRef.current;
    const next = touchSeen(map, id, at, localDayKey());
    if (next) saveSeen(key, next);
  }, [saveSeen]);
  const carry = seenState.key === seenKey ? carryOver(planTasks, seenState.map, day, me) : { ids: [] as string[], from: null };
  const carryTasks = readOnly ? [] : planTasks.filter((t) => carry.ids.includes(t.id));
  const resolveCarry = (mode: "carry" | "clear" | "keep") => {
    const list = carryTasks.map((t) => ({ id: t.id, scheduled: t.scheduled! }));
    // answered for today: an Undo that puts a block back where it was won't re-prompt
    saveSeen(seenRef.current.key, markSeen(seenRef.current.map, list.map((p) => ({ id: p.id, at: p.scheduled })), day));
    if (mode === "keep" || list.length === 0) return;
    list.forEach((p) => onUpdate(p.id, mode === "carry" ? { scheduled: null } : { scheduled: null, planToday: false }));
    const noun = `${list.length} block${list.length === 1 ? "" : "s"}`;
    const msg = mode === "carry" ? `Brought ${noun} back to re-plan.` : `Cleared ${noun} from today.`;
    if (toast) toast.action(msg, "Undo", () => list.forEach((p) => onUpdate(p.id, { scheduled: p.scheduled, planToday: true })), { ms: 10000 });
    else announce(msg);
    requestAnimationFrame(() => (mode === "carry" ? intakeHeadingRef.current : dayHeadingRef.current)?.focus());
  };

  /* ----- placing / removing ----- */
  const place = useCallback((id: string, start: number, title: string, dur: number) => {
    const t = tasksRef.current.find((x) => x.id === id);
    // anything from the rail that isn't on today's list yet joins it
    onUpdate(id, t && !t.planToday ? { scheduled: start, planToday: true } : { scheduled: start });
    touchBlock(id, start);
    announce(`Planned “${title}” for ${fmtTimeRange(start, start + dur)}.`);
  }, [onUpdate, touchBlock, announce]);
  const unschedule = useCallback((id: string, title: string) => {
    onUpdate(id, { scheduled: null });
    touchBlock(id, null);
    announce(`Moved “${title}” back to Unplanned.`);
  }, [onUpdate, touchBlock, announce]);

  const removeFromDay = useCallback((id: string, viaKeyboard: boolean) => {
    const t = tasksRef.current.find((x) => x.id === id); if (!t) return;
    unschedule(id, t.title);
    if (viaKeyboard) requestAnimationFrame(() => dayHeadingRef.current?.focus());
  }, [unschedule]);

  const toggleDone = useCallback((t: Task) => {
    const done = t.status === "done";
    if (!done) {
      setLinger((s) => new Set(s).add(t.id));
      window.setTimeout(() => setLinger((s) => { if (!s.has(t.id)) return s; const n = new Set(s); n.delete(t.id); return n; }), LINGER_MS);
    }
    onUpdate(t.id, { status: done ? "todo" : "done" });
    announce(done ? `Reopened “${t.title}”.` : `Done: “${t.title}”.`);
  }, [onUpdate, announce]);

  const acceptGhost = useCallback((g: GhostBlock, viaKeyboard: boolean) => {
    const t = tasksRef.current.find((x) => x.id === g.id); if (!t) return;
    if (viaKeyboard) revealRef.current = { id: g.id, focus: true };
    onUpdate(g.id, { scheduled: g.start, planToday: true });
    touchBlock(g.id, g.start);
    announce(`Planned “${t.title}” for ${fmtTimeRange(g.start, g.end)}.`);
  }, [onUpdate, touchBlock, announce]);

  const skipGhost = useCallback((id: string, viaKeyboard: boolean) => {
    const t = tasksRef.current.find((x) => x.id === id);
    onSkip?.(id);
    if (t) {
      const msg = `Hid the suggestion for “${t.title}” today.`;
      if (toast && onUnskip) toast.action(msg, "Undo", () => onUnskip(id), { ms: 10000 });
      else announce(msg);
    }
    if (viaKeyboard) requestAnimationFrame(() => dayHeadingRef.current?.focus());
  }, [onSkip, onUnskip, toast, announce]);

  const notToday = useCallback((task: Task, ev: ReactMouseEvent<HTMLButtonElement>) => {
    const wasPlanned = !!task.planToday;
    if (!wasPlanned && !onSkip) return; // nothing to take off (and the button isn't offered)
    const viaKeyboard = ev.detail === 0;
    let next: HTMLElement | null = null;
    if (viaKeyboard) {
      const card = ev.currentTarget.closest("[data-intake-card]");
      const sib = (card?.nextElementSibling ?? card?.previousElementSibling) as HTMLElement | null;
      next = sib?.querySelector<HTMLElement>("[data-intake-open]") ?? null;
    }
    if (wasPlanned) onUpdate(task.id, { planToday: false });
    onSkip?.(task.id);
    touchBlock(task.id, null);
    const msg = `Took “${task.title}” off today.`;
    // Undo puts it all back: on today's list if it was, and a candidate for the plan again
    const undo = () => { if (wasPlanned) onUpdate(task.id, { planToday: true }); onUnskip?.(task.id); };
    if (toast && (wasPlanned || onUnskip)) toast.action(msg, "Undo", undo, { ms: 10000 });
    else announce(msg);
    if (viaKeyboard) requestAnimationFrame(() => (next ?? intakeHeadingRef.current)?.focus());
  }, [onUpdate, onSkip, onUnskip, touchBlock, toast, announce]);

  // a newly placed block scrolls into view; from the keyboard it also takes focus
  useEffect(() => {
    const r = revealRef.current; if (!r) return;
    const el = Array.from(canvasRef.current?.querySelectorAll<HTMLElement>("[data-block-id]") ?? []).find((x) => x.dataset.blockId === r.id);
    if (!el) return;
    revealRef.current = null;
    try { el.scrollIntoView({ block: "nearest" }); } catch { /* jsdom */ }
    if (r.focus) el.focus();
  });

  /** The first slot today that fits this task (around meetings and what's placed; never
   *  before the working day starts, like the suggestions). You asked for it, so after
   *  18:00 the evening is fair game. */
  const slotFor = useCallback((target: Task): number | null => {
    const cur = tasksRef.current;
    const others = cur
      .filter((t) => t.id !== target.id && isPlaced(t) && t.status !== "done" && !t.archivedAt)
      .map((t) => ({ id: "busy-" + t.id, title: t.title, start: t.scheduled!, end: t.scheduled! + durOf(t), kind: "meeting" as const }));
    const placed = planDay([{ ...target, energy: energyKindOf(target), dur: durOf(target), scheduled: null }], [...dayEvents, ...others],
      { nowMin: Math.max(readClock().nowMin, WORK_START) });
    return placed[target.id] ?? null;
  }, [dayEvents]);

  const scheduleOne = useCallback((id: string, viaKeyboard: boolean) => {
    const target = tasksRef.current.find((t) => t.id === id); if (!target) return;
    const g = ghostById.get(id);
    const at = g ? g.start : slotFor(target);
    if (at != null) {
      revealRef.current = { id, focus: viaKeyboard };
      place(id, at, target.title, durOf(target));
    } else {
      notify(`“${target.title}” doesn’t fit in what’s left of today. Drag it onto a gap, or take something else off the day.`);
    }
  }, [ghostById, slotFor, place, notify]);

  const capture = useCallback((t: Task) => { onCreate(t); announce(`Added “${t.title}” to today.`); }, [onCreate, announce]);
  const captureAndPlan = useCallback((t: Task) => {
    const at = slotFor(t);
    onCreate(at != null ? { ...t, scheduled: at } : t);
    announce(at != null ? `Added “${t.title}” and planned it for ${fmtTimeRange(at, at + durOf(t))}.` : `Added “${t.title}”. It doesn’t fit today, so it waits in Unplanned.`);
  }, [slotFor, onCreate, announce]);

  /* ----- keyboard: move a focused block by 15 minutes (Shift: an hour), Delete to unplan, F to focus ----- */
  const flushKb = useCallback(() => {
    window.clearTimeout(kbTimer.current);
    const k = kbRef.current; if (!k) return;
    kbRef.current = null; setKb(null);
    const t = tasksRef.current.find((x) => x.id === k.id);
    if (!t || t.scheduled === k.start) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.blockId === k.id;
    if (focused) revealRef.current = { id: k.id, focus: true }; // re-sorting can move the node; keep focus on it
    onUpdate(k.id, { scheduled: k.start });
    touchBlock(k.id, k.start);
  }, [onUpdate, touchBlock]);
  const flushKbRef = useRef(flushKb); flushKbRef.current = flushKb;
  useEffect(() => () => flushKbRef.current(), []); // leaving the view saves a pending nudge
  const onBlockKey = useCallback((ev: ReactKeyboardEvent, task: Task) => {
    if (readOnly) return;
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      const step = ev.shiftKey ? 60 : 15;
      const cur = kbRef.current?.id === task.id ? kbRef.current.start : task.scheduled!;
      const dur = durOf(task);
      // land on the step's grid (9:07 ↓ → 9:15, ↑ → 9:00) so moves are predictable
      const raw = ev.key === "ArrowDown" ? Math.floor(cur / step) * step + step : Math.ceil(cur / step) * step - step;
      const next = clamp(raw, win.from, win.to - dur);
      if (kbRef.current && kbRef.current.id !== task.id) flushKb();
      const k = { id: task.id, start: next };
      kbRef.current = k; setKb(k);
      window.clearTimeout(kbTimer.current);
      kbTimer.current = window.setTimeout(flushKb, KEY_COMMIT_MS);
      announce(`${task.title}: ${fmtTimeRange(next, next + dur)}`);
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      if (kbRef.current?.id === task.id) { window.clearTimeout(kbTimer.current); kbRef.current = null; setKb(null); }
      removeFromDay(task.id, true);
    } else if ((ev.key === "f" || ev.key === "F") && onStartFocus && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault(); ev.stopPropagation();
      onStartFocus(task.id);
    }
  }, [readOnly, flushKb, announce, removeFromDay, onStartFocus, win.from, win.to]);

  /* ----- pointer drag (mouse, pen and touch) ----- */
  const isOverRail = useCallback((x: number, y: number) => {
    if (stacked) return false; // the rail is below the day, not beside it
    const r = railRef.current?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }, [stacked]);

  /** Over the Daybeam (Today's lede): the start the pointer points at, on the beam's own scale. */
  const beamStartAt = useCallback((x: number, y: number, dur: number): number | null => {
    const bar = rootRef.current?.querySelector<HTMLElement>("[data-daybeam]");
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    if (r.width <= 0 || x < r.left - 8 || x > r.right + 8 || y < r.top - 14 || y > r.bottom + 14) return null;
    const from = Number(bar.dataset.from), to = Number(bar.dataset.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    const m = snapTo(from + ((x - r.left) / r.width) * (to - from));
    return clamp(m, from, Math.max(from, to - dur));
  }, []);

  const computePreview = useCallback((x: number, y: number, dur: number, grab: number): number | null => {
    const c = canvasRef.current; if (!c) return null;
    const r = c.getBoundingClientRect();
    if (x < r.left - 40 || x > r.right + 40) return null;
    // pointer and rect are screen px; at Small/Large text the day is zoomed, so a minute is pxm × zoom of them
    const m = snapTo(win.from + (y - r.top - grab) / (win.pxm * uiZoom()));
    return clamp(m, win.from, win.to - dur);
  }, [win.from, win.to, win.pxm]);

  const activate = useCallback((base: DragState, x: number, y: number) => {
    pointerRef.current = { x, y };
    movedRef.current = Math.hypot(x - base.x0, y - base.y0);
    touchDragRef.current = base.touch;
    setDrag(base);
    setPointer({ x, y });
    const beam = beamStartAt(x, y, base.dur);
    setOverBeam(beam != null);
    setPreviewStart(beam ?? (isOverRail(x, y) ? null : computePreview(x, y, base.dur, base.grab)));
  }, [computePreview, isOverRail, beamStartAt]);

  // A press only becomes a drag once it's clearly meant as one: a mouse must
  // travel a few px (so a click just opens the task and never writes), and a
  // finger must hold still for a long-press (so swiping scrolls the day).
  const startDrag = useCallback((e: ReactPointerEvent, task: Task, source: DragSource, at?: number) => {
    if (readOnly || drag || pendingRef.current) return;
    const touch = e.pointerType === "touch";
    if (!touch && e.button !== 0) return;
    if (!touch) e.preventDefault(); // no text selection while dragging with a mouse
    const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
    const top = canvasRef.current?.getBoundingClientRect().top ?? 0;
    const from = source === "canvas" ? task.scheduled : source === "ghost" ? at : null;
    const grab = from != null ? y0 - (yOf(from, win) * uiZoom() + top) : 16;
    const base: DragState = {
      taskId: task.id, dur: durOf(task), title: task.title, energy: energyKindOf(task), source, grab,
      origin: source === "canvas" ? task.scheduled ?? null : null, x0, y0, touch, pointerId: pid,
    };
    let last = { x: x0, y: y0 };
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      pendingRef.current = null;
    };
    const go = () => {
      cleanup();
      // a finger picks the block up where it is when the long-press fires, so the
      // wobble while holding can't nudge it (a hold released in place writes nothing)
      const b = touch ? { ...base, x0: last.x, y0: last.y, grab: from != null ? base.grab + (last.y - y0) : base.grab } : base;
      // render the drag now, so its own move/release listeners are attached before
      // the next pointer event — a release in between would otherwise be lost and
      // leave the block stuck to the pointer
      flushSync(() => activate(b, last.x, last.y));
    };
    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pid) return;
      last = { x: ev.clientX, y: ev.clientY };
      const d = Math.hypot(ev.clientX - x0, ev.clientY - y0);
      if (touch) { if (d > TOUCH_SLOP) cleanup(); } // moved before the long-press: it's a scroll
      else if (d > MOUSE_SLOP) go();
    }
    // released (a tap/click — onClick opens the task) or the browser took the gesture over
    function onEnd(ev: PointerEvent) { if (ev.pointerId === pid) cleanup(); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    if (touch) timer = window.setTimeout(() => { try { navigator.vibrate?.(8); } catch { /* unsupported */ } go(); }, LONG_PRESS_MS);
    pendingRef.current = cleanup;
  }, [readOnly, drag, activate, win.from, win.pxm]);
  useEffect(() => () => pendingRef.current?.(), []);

  // a layout effect, so the listeners are in place as soon as the drag renders (see go())
  useLayoutEffect(() => {
    if (!drag) return;
    let ended = false, raf = 0;
    const update = (x: number, y: number) => {
      // the Daybeam is a second, smaller day: over it, the block lands where it points
      const beam = beamStartAt(x, y, drag.dur);
      setOverBeam(beam != null);
      const onRail = beam == null && isOverRail(x, y);
      setOverRail(onRail);
      // while hovering the rail, suppress the day preview so it reads as "removing"
      setPreviewStart(beam ?? (onRail ? null : computePreview(x, y, drag.dur, drag.grab)));
    };
    const finish = (commit: boolean, e?: PointerEvent) => {
      if (ended) return;
      ended = true;
      // commit only a real move to a different time — a click or a nudge that
      // snaps back to the same slot writes nothing
      if (commit && e && movedRef.current > MOUSE_SLOP) {
        const beam = beamStartAt(e.clientX, e.clientY, drag.dur);
        const onRail = beam == null && isOverRail(e.clientX, e.clientY);
        const start = beam ?? (onRail ? null : computePreview(e.clientX, e.clientY, drag.dur, drag.grab));
        if (start != null) { if (start !== drag.origin) place(drag.taskId, start, drag.title, drag.dur); }
        else if (drag.source === "canvas") unschedule(drag.taskId, drag.title); // dropped on the rail (or off the day) → back to Unplanned
      }
      lastDragEndRef.current = performance.now();
      touchDragRef.current = false;
      setDrag(null); setPreviewStart(null); setOverRail(false); setOverBeam(false);
    };
    const mine = (e: PointerEvent) => e.pointerId === drag.pointerId;
    const move = (e: PointerEvent) => {
      if (!mine(e)) return;
      pointerRef.current = { x: e.clientX, y: e.clientY };
      movedRef.current = Math.max(movedRef.current, Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0));
      setPointer(pointerRef.current);
      update(e.clientX, e.clientY);
    };
    const up = (e: PointerEvent) => { if (mine(e)) finish(true, e); };
    const cancel = (e: PointerEvent) => { if (mine(e)) finish(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } };
    // no long-press context menu mid-drag
    const block = (e: Event) => { if (e.cancelable) e.preventDefault(); };
    // auto-scroll the day while dragging near its top or bottom edge
    const autoScroll = () => {
      const sc = stacked ? rootRef.current : scrollRef.current, { x, y } = pointerRef.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        const inside = x >= r.left && x <= r.right && y >= r.top - 40 && y <= r.bottom + 40 && !isOverRail(x, y) && beamStartAt(x, y, 0) == null;
        let dy = 0;
        if (inside && y < r.top + EDGE) dy = -((r.top + EDGE - y) / EDGE) * 14;
        else if (inside && y > r.bottom - EDGE) dy = ((y - (r.bottom - EDGE)) / EDGE) * 14;
        if (dy) {
          const before = sc.scrollTop;
          sc.scrollTop = before + clamp(Math.round(dy), -18, 18);
          if (sc.scrollTop !== before) update(x, y);
        }
      }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("contextmenu", block);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("contextmenu", block);
    };
  }, [drag, computePreview, isOverRail, beamStartAt, place, unschedule, stacked]);

  // the click that ends a drag must not also open the task
  const openItem = useCallback((id: string) => {
    if (performance.now() - lastDragEndRef.current < 400) return;
    onOpen(id);
  }, [onOpen]);

  // "q" jumps to this view's capture field (instead of the global quick-capture
  // dialog) while Today is on screen and nothing modal is open
  useEffect(() => {
    if (readOnly) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "q" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const input = captureRef.current; if (!input) return;
      e.preventDefault(); e.stopImmediatePropagation();
      input.focus();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [readOnly]);

  /* ----- the rail's groups ----- */
  const skip = useMemo(() => new Set(skipped ?? []), [skipped]);
  const tomorrow = useMemo(() => new Set(tomorrowIds ?? []), [tomorrowIds]);
  const weekEnd = useMemo(() => {
    const [y, m, d] = day.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + (7 - ((dt.getDay() + 6) % 7) - 1)); // this Sunday
    return localDayKey(dt);
  }, [day]);
  const groups = useMemo(() => {
    const sort = byOrder[order];
    const dayCut = Date.now() - 24 * 3600_000;
    // the same set the brief counts and the suggestions come from
    const pool = live.filter((t) => (t.status !== "done" || linger.has(t.id)) && !isPlaced(t) && isTodaysScope(t, me));
    const overdue: Task[] = [], today: Task[] = [], week: Task[] = [], inbox: Task[] = [], later: Task[] = [];
    for (const t of pool) {
      const due = t.dueDate?.slice(0, 10);
      if (skip.has(t.id) && !t.planToday) later.push(t);
      else if (due && due < day) overdue.push(t);
      else if (due === day || t.planToday) today.push(t);
      else if (due && due <= weekEnd) week.push(t);
      else if (me && t.assigneeId === me && t.createdBy && t.createdBy !== me && t.createdAt && Date.parse(t.createdAt) >= dayCut) inbox.push(t);
      else later.push(t);
    }
    return { overdue: overdue.sort(sort), today: today.sort(sort), week: week.sort(sort), inbox: inbox.sort(sort), later: later.sort(sort) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, linger, skip, day, weekEnd, me, order]);
  const unplannedCount = groups.overdue.length + groups.today.length + groups.week.length + groups.inbox.length;

  // the brief's figures narrow the rail; scroll it to the top so the group is in view
  useEffect(() => { if (railFocus) railScrollRef.current?.scrollTo?.({ top: 0 }); }, [railFocus]);
  const shown = railFocus === "due"
    ? { overdue: [], today: groups.today.filter((t) => t.dueDate?.slice(0, 10) === day), week: [], inbox: [] }
    : railFocus === "overdue" ? { overdue: groups.overdue, today: [], week: [], inbox: [] } : groups;

  const big3Tasks = (big3 ?? []).map((id) => taskById.get(id)).filter((t): t is Task => !!t && !t.archivedAt);

  const itemProps = {
    today: day, me, readOnly, onStartDrag: startDrag, onOpen: openItem, onToggle: toggleDone, onAccept: acceptGhost,
    onSchedule: scheduleOne, onNotToday: notToday,
  };
  const renderGroup = (key: string, label: string, list: Task[], tone?: "signal") => list.length === 0 ? null : (
    <section key={key} className="krail-group" aria-labelledby={`${helpId}-${key}`}>
      <SectionLabel id={`${helpId}-${key}`} tone={tone} count={list.length}>{label}</SectionLabel>
      {list.map((t) => <RailItem key={t.id} task={t} {...itemProps} canSkip={!!onSkip} slot={ghostById.get(t.id)} tomorrow={tomorrow.has(t.id)} dragging={drag?.taskId === t.id} />)}
    </section>
  );
  // narrowed by the brief's figure: what of it is already on the day (the brief counts that too)
  const focusOnDay = railFocus ? blocks.filter((b) => {
    const due = b.task.dueDate?.slice(0, 10);
    return b.task.status !== "done" && !!due && (railFocus === "due" ? due === day : due < day);
  }).length : 0;

  const railEmpty = unplannedCount === 0 && groups.later.length === 0 && carryTasks.length === 0;
  const floatEdge = drag ? (() => {
    const t = taskById.get(drag.taskId); const p = t ? getProject(t.projectId) : undefined;
    return drag.energy === "deep" ? "var(--kp-grad-v)" : p ? projectPaint(p.color).solid : "var(--accent)";
  })() : undefined;
  const zoom = drag ? uiZoom() : 1; // the fixed float sits inside the zoomed page: screen px ÷ zoom
  const noCalendar = !calendarConnected && dayEvents.length === 0 && !!onConnectCalendar && !readOnly;
  const hour = Math.floor(nowMin / 60);

  const captureField = readOnly ? null : (
    <CaptureField onCapture={capture} onCapturePlan={captureAndPlan} inputRef={captureRef} defaults={captureDefaults}
      today={day} projects={projects} members={members} />
  );
  const big3Section = big3Tasks.length > 0 && (
    <section className="krail-section krail-big3" aria-labelledby={`${helpId}-big3`}>
      <SectionLabel id={`${helpId}-big3`}>This week's Big 3</SectionLabel>
      <ol>
        {big3Tasks.map((t) => (
          <li key={t.id} className="krail-big3-row" data-done={t.status === "done" || undefined}>
            <StatusGlyph status={t.status} label={t.title} celebrateKey={t.id} readOnly={readOnly} onToggle={readOnly ? undefined : () => toggleDone(t)} />
            <button type="button" className="krail-big3-open" onClick={() => onOpen(t.id)}>{t.title}</button>
          </li>
        ))}
      </ol>
    </section>
  );
  const railHead = (
    <div className="krail-head" data-first={stacked || (readOnly && !big3Tasks.length) || undefined}>
      <h2 ref={intakeHeadingRef} tabIndex={-1}>Unplanned</h2>
      {unplannedCount > 0 && <span className="krail-head-count" aria-label={`${unplannedCount} task${unplannedCount === 1 ? "" : "s"}`}>{unplannedCount}</span>}
      {unplannedCount > 1 && <OrderMenu value={order} onChange={setOrder} />}
    </div>
  );

  const canvas = (
    <DayCanvas blocks={blocks} ghosts={liveGhosts} taskById={taskById} events={dayEvents} nowMin={nowMin} win={win} helpId={helpId} readOnly={readOnly}
      onStartDrag={startDrag} onOpen={openItem} onRemove={removeFromDay} onKeyMove={onBlockKey} onKeyBlur={flushKb} onToggle={toggleDone}
      onStartFocus={onStartFocus} onAccept={acceptGhost} onSkip={onSkip ? skipGhost : undefined} onExtract={onExtractFromMeeting}
      dragId={drag?.taskId} previewStart={previewStart} previewDur={drag?.dur || 30} canvasRef={canvasRef} landing={landing}
      freeGaps={freeGaps} openTime={openTime} pulse={pulse} />
  );

  return (
    <div ref={rootRef} className="kplan" data-stacked={stacked || undefined}>
      <style>{PLAN_CSS}</style>
      <span id={helpId} className="sr-only">Press Enter to open. Use the up and down arrow keys to move it by 15 minutes, or hold Shift to move it by an hour. Press Delete to send it back to Unplanned{onStartFocus ? ", or F to start focus on it" : ""}.</span>
      <span id={helpId + "-g"} className="sr-only">A suggestion from Kanbo. Press Enter to put it on your day, or drag it to another time.</span>
      <div role="status" aria-live="polite" className="sr-only">{srMsg}</div>
      <div className="kplan-main">
        {typeof lede === "function"
          ? lede(drag && overBeam && previewStart != null ? { start: previewStart, end: previewStart + drag.dur } : null)
          : lede}
        <h2 ref={dayHeadingRef} tabIndex={-1} className="sr-only">Your day</h2>
        <div ref={scrollRef} className="kday-scroll">
          {noCalendar && (
            <button type="button" className="kday-connect" onClick={onConnectCalendar}>
              <Icon name="calendar" size={14} sw={1.75} /> Connect your calendar to see meetings here
            </button>
          )}
          {stacked && (win.from > DAY_START || earlier) && (
            <button type="button" className="kday-earlier" aria-expanded={earlier} onClick={() => setEarlier((e) => !e)}>
              <Icon name={earlier ? "chevronDown" : "chevronRight"} size={14} sw={1.75} />
              {earlier ? "Hide earlier today" : `Earlier today · ${fmtTime(DAY_START)}–${fmtTime(win.from)}`}
            </button>
          )}
          {canvas}
        </div>
      </div>
      <aside ref={railRef} className="krail" aria-label="Unplanned" data-drop={(overRail && drag?.source === "canvas") || undefined}>
        {overRail && drag?.source === "canvas" && (
          <div className="krail-dropnote"><span><Icon name="arrowLeft" size={16} /> Release to move back to Unplanned</span></div>
        )}
        <div ref={railScrollRef} className="krail-scroll">
          {/* side by side, capture heads the rail; in one column the rail is "Unplanned"
              under the agenda, with capture at its top */}
          {!stacked && captureField}
          {!stacked && big3Section}
          {railHead}
          {stacked && captureField}
          {stacked && big3Section}
          {railFocus && (
            <div className="krail-filter" role="status">
              <span>Showing {railFocus === "due" ? "what's due today" : "what's overdue"}{focusOnDay > 0 ? ` · ${focusOnDay} already on your day` : ""}</span>
              <button type="button" onClick={() => onRailFocus?.(null)}>Show all</button>
            </div>
          )}
          {carryTasks.length > 0 && !railFocus && (
            // an earlier day's unfinished blocks, still on the canvas at their old times:
            // a group that asks one question (bring them back, clear them, or keep them)
            <section className="krail-group krail-carry" role="region" aria-label="Unfinished blocks from an earlier plan">
              <SectionLabel id={`${helpId}-carry`} count={carryTasks.length} action={
                <>
                  <Button size="sm" variant="secondary" onClick={() => resolveCarry("carry")} title="Take them off the canvas to re-plan">Bring all</Button>
                  <Button size="sm" variant="ghost" onClick={() => resolveCarry("clear")} title="Take them off today altogether">Clear</Button>
                  <button type="button" className="kibtn" data-size="sm" onClick={() => resolveCarry("keep")} title="Keep them where they are" aria-label="Keep them where they are">
                    <Icon name="x" size={16} sw={1.75} />
                  </button>
                </>
              }>Carried over</SectionLabel>
              <p className="krail-carry-note">{carryLabel(carry.from, day)}: {carryTasks.length} unfinished block{carryTasks.length === 1 ? "" : "s"}</p>
              <small className="krail-carry-sub">{carryTasks.length === 1 ? "Still on the day at its old time." : "Still on the day at their old times."}</small>
              <ul className="krail-carry-list">
                {[...carryTasks].sort((a, b) => a.scheduled! - b.scheduled!).map((t) => (
                  <li key={t.id} className="krail-carry-row">
                    <StatusGlyph status={t.status} size={14} label={t.title} celebrateKey={t.id} onToggle={() => toggleDone(t)} />
                    <button type="button" className="krail-carry-open" onClick={() => onOpen(t.id)}>{t.title}</button>
                    <span className="krail-carry-at" aria-label={`at ${fmtTime(t.scheduled!)}`}>{fmtTime(t.scheduled!)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {renderGroup("overdue", "Overdue", shown.overdue, "signal")}
          {renderGroup("today", "Today", shown.today)}
          {renderGroup("week", "This week", shown.week)}
          {renderGroup("inbox", "From Inbox", shown.inbox)}
          {!railFocus && railEmpty && blocks.length === 0 && (
            <EmptyState size="sm" art="tasks" title="Nothing waiting"
              body={readOnly ? "Nothing's lined up for today." : "Capture something above, or pull from My tasks."}
              action={onOpenMyTasks ? <Button variant="ghost" size="sm" onClick={onOpenMyTasks}>Open My tasks</Button> : undefined} />
          )}
          {!railFocus && unplannedCount === 0 && carryTasks.length === 0 && (blocks.length > 0 || groups.later.length > 0) && (
            <p className="krail-note">
              <Icon name="check" size={14} sw={2} />
              {blocks.length ? "Everything for today is on the day." : "Nothing's due or planned for today."}
            </p>
          )}
          {!railFocus && groups.later.length > 0 && (
            <>
              <button type="button" className="krail-later" aria-expanded={laterOpen} onClick={() => setLaterOpen((o) => !o)}>
                <Icon name="chevronRight" size={14} sw={1.75} /> Later <span className="mono">{groups.later.length}</span>
              </button>
              {laterOpen && (
                <div className="krail-group">
                  {groups.later.slice(0, 30).map((t) => <RailItem key={t.id} task={t} {...itemProps} dragging={drag?.taskId === t.id} />)}
                  {groups.later.length > 30 && onOpenMyTasks && (
                    <Button variant="ghost" size="sm" iconRight="arrowRight" onClick={onOpenMyTasks}>All {groups.later.length} in My tasks</Button>
                  )}
                </div>
              )}
            </>
          )}
          {/* the list ends where the day does: from 16:00, a way to close it */}
          {onShutdown && !readOnly && hour >= 16 && (
            <div className="krail-foot">
              <Button variant="ghost" size="sm" icon="sunset" onClick={onShutdown}>Shut down my day</Button>
            </div>
          )}
        </div>
      </aside>
      {drag && (
        // on touch the float sits above the finger so it isn't hidden under it; over the
        // Daybeam a mouse's float drops below the pointer, so the slot it marks stays in view
        <div aria-hidden="true" className="kday-float" style={{ left: pointer.x / zoom + (drag.touch ? -24 : 14), top: pointer.y / zoom + (drag.touch ? -58 : overBeam ? 18 : -10),
          "--edge": floatEdge, transform: reduceMotion ? undefined : "rotate(-1.5deg)" } as CSSProperties}>
          <b>{drag.title}</b>
          {previewStart != null && <span>{fmtTimeRange(previewStart, previewStart + drag.dur)}</span>}
        </div>
      )}
    </div>
  );
}
