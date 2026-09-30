/* ============================================================
   KANBO — Plan my day (white-glass, time-native hero)
   Day canvas + intake + NL capture + AI auto-plan.
   ============================================================ */
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useId } from "react";
import { flushSync } from "react-dom";
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent, CSSProperties, RefObject } from "react";
import { Icon, chipInk, chipFill, chipEdge } from "../primitives";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useToast } from "../Toast";
import { useAuth } from "../../auth/AuthProvider";
import {
  getProject, dueState, fmtDue, fmtClock, fmtClockRange, fmtDurMin,
  parseCapture, planDay, ENERGY, EVENTS, DAY_START, DAY_END, todayISO,
} from "../../data/data";
import type { CaptureOptions } from "../../data/data";
import { uiZoom } from "../../lib/appearance";
import type { Task, CalEvent, EnergyKind, ExternalEvent } from "../../data/types";
import {
  durOf, energyKindOf, energyMetaOf, layoutLanes, mergeIntervals, totalMinutes,
  localDayKey, planSeenKey, readSeen, writeSeen, carryOver, recordSeen, markSeen, touchSeen, carryLabel,
} from "./planCanvas";
import type { Lane, SeenMap } from "./planCanvas";

const PXM = 1.0; // px per minute
const SNAP = 5;
const MOUSE_SLOP = 4;       // px a mouse press must travel before it becomes a drag — a click never writes
const TOUCH_SLOP = 6;       // px of finger travel before the long-press means "the user is scrolling"
const LONG_PRESS_MS = 250;  // touch: hold this long to pick a block up
const EDGE = 56;            // px from the canvas edge where a drag auto-scrolls the day
const KEY_COMMIT_MS = 700;  // keyboard nudges settle into one write
const MIN_BLOCK_PX = 26;

const snapTo = (m: number, step = SNAP) => Math.round(m / step) * step;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Convert connected-calendar events (ISO datetimes) into today's day-blocks
// (minutes-from-midnight) that the canvas + auto-planner understand. All-day
// events are skipped so they don't block the timeline; times are clamped to
// the visible day window.
function todaysEvents(ext: ExternalEvent[]): CalEvent[] {
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  const out: CalEvent[] = [];
  for (const e of ext) {
    if (e.allDay) continue;
    const s = new Date(e.start), en = new Date(e.end);
    if (isNaN(s.getTime()) || isNaN(en.getTime())) continue;
    if (s.getFullYear() !== y || s.getMonth() !== mo || s.getDate() !== d) continue;
    let startMin = s.getHours() * 60 + s.getMinutes();
    let endMin = en.getHours() * 60 + en.getMinutes();
    if (endMin <= startMin) endMin = startMin + 30;          // guard zero/negative
    startMin = Math.max(DAY_START, Math.min(DAY_END, startMin));
    endMin = Math.max(DAY_START, Math.min(DAY_END, endMin));
    if (endMin <= startMin) continue;
    out.push({ id: e.id, title: e.title, start: startMin, end: endMin, kind: "meeting" });
  }
  return out.sort((a, b) => a.start - b.start);
}

/* The live clock for this view: the now-line, "NOW" badges and the carry-over
   prompt all follow the real time, even in a tab left open overnight. */
function readClock() { const d = new Date(); return { nowMin: d.getHours() * 60 + d.getMinutes(), day: localDayKey(d) }; }
function useClock() {
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

// Plan works outside the providers in tests/storybook-style renders; inside the
// app both are always present.
function useOptionalToast() { try { return useToast(); } catch { return null; } }
function useAuthUserId(): string | undefined { try { return useAuth().user?.id; } catch { return undefined; } }

/* keyboard-only focus ring for a whole card/block (its open-button is stretched over it) */
function useFocusRing() {
  const [ring, setRing] = useState(false);
  return {
    ring,
    onFocus: (e: ReactFocusEvent<HTMLElement>) => { let v = true; try { v = e.currentTarget.matches(":focus-visible"); } catch { /* older engines */ } setRing(v); },
    onBlur: () => setRing(false),
  };
}

const laneStyle = (l?: Lane): CSSProperties => {
  const n = Math.max(1, l?.lanes ?? 1), i = l?.lane ?? 0, gap = n > 1 ? 4 : 0;
  return { left: `calc(54px + (100% - 66px) * ${i / n})`, width: `calc((100% - 66px) / ${n} - ${gap}px)` };
};

// a button stretched over its card: the whole card is one click target, while
// the action buttons (position: relative; z-index 1) stay on top of it
const bareButton: CSSProperties = { flex: 1, minWidth: 0, border: "none", background: "transparent", padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "inherit", outline: "none" };
const stretched: CSSProperties = { position: "absolute", inset: 0, zIndex: 0 };
const noSelect: CSSProperties = { userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" };

type DragSource = "intake" | "canvas";
interface DragState {
  taskId: string;
  dur: number;
  title: string;
  energy: EnergyKind;
  source: DragSource;
  grab: number;
  /** the block's start when the drag began (null from Intake) — dropping it back there writes nothing */
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
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: small ? 9.5 : 10.5, fontWeight: 500,
      // text pushed off the raw palette colour so e.g. "Creative" stays ≥ 4.5:1 on its tint in light
      color: chipInk(e.color), padding: small ? "1px 6px" : "2px 7px", borderRadius: 6,
      background: chipFill(e.color), border: `1px solid ${chipEdge(e.color)}` }}>
      <Icon name={e.icon} size={small ? 10 : 11} /> {e.label}
    </span>
  );
}

/* ---------- day canvas pieces ---------- */
function PlanNowLine({ nowMin }: { nowMin: number }) {
  if (nowMin < DAY_START || nowMin > DAY_END) return null;
  const top = (nowMin - DAY_START) * PXM;
  return (
    <div aria-hidden="true" style={{ position: "absolute", left: 54, right: 12, top, zIndex: 6, pointerEvents: "none" }}>
      <span style={{ position: "absolute", left: -54, top: -7, width: 48, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600, color: "var(--accent-text, var(--accent))" }}>{fmtClock(nowMin)}</span>
      <span style={{ position: "absolute", left: -4, top: -4, width: 9, height: 9, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 0 4px var(--accent-dim), 0 0 10px var(--accent-glow)" }} />
      <div style={{ height: 2, background: "var(--accent)", borderRadius: 2, opacity: 0.85, boxShadow: "0 0 8px var(--accent-glow)" }} />
    </div>
  );
}

function PlanEventBlock({ ev, lane }: { ev: CalEvent; lane?: Lane }) {
  const top = (ev.start - DAY_START) * PXM, h = (ev.end - ev.start) * PXM;
  const tall = h > 38;
  const meeting = ev.kind !== "break";
  return (
    <div style={{ position: "absolute", ...laneStyle(lane), top, height: h, borderRadius: 14, padding: tall ? "8px 13px" : "0 13px",
      // meetings read as "taken" at a glance: a soft hatch over the glass, with a solid hairline
      background: meeting
        ? "repeating-linear-gradient(135deg, var(--fill-1, oklch(0.28 0.02 266 / 0.05)) 0 6px, transparent 6px 12px), color-mix(in oklch, var(--surface-2) 60%, transparent)"
        : "color-mix(in oklch, var(--surface-2) 50%, transparent)",
      border: meeting ? "1px solid var(--hairline-strong)" : "1px dashed var(--hairline-strong)",
      backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
      display: "flex", flexDirection: tall ? "column" : "row", alignItems: tall ? "flex-start" : "center", justifyContent: "center", gap: tall ? 2 : 10, overflow: "hidden", zIndex: 2 }}>
      <span className="truncate" style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)", flex: tall ? "none" : 1, minWidth: 0, maxWidth: "100%" }}>
        {ev.title}{ev.with ? <span style={{ fontWeight: 400, color: "var(--ink-4)" }}>{"  ·  " + ev.with.join(", ")}</span> : null}
      </span>
      <span className="mono" style={{ fontSize: 10, color: "var(--ink-4)", flexShrink: 0 }}>{tall ? fmtClockRange(ev.start, ev.end) : fmtClock(ev.start)}</span>
    </div>
  );
}

function PlanTaskBlock({ task, start, lane, nowMin, helpId, onStartDrag, onOpen, onRemove, onKeyMove, onKeyBlur, dragging, justPlaced }: {
  task: Task; start: number; lane?: Lane; nowMin: number; helpId: string;
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string, viaKeyboard: boolean) => void;
  onKeyMove: (ev: ReactKeyboardEvent, task: Task) => void;
  onKeyBlur: () => void;
  dragging?: boolean; justPlaced?: boolean;
}) {
  const dur = durOf(task);
  const top = (start - DAY_START) * PXM, h = dur * PXM;
  const e = energyMetaOf(task), proj = getProject(task.projectId);
  const active = start <= nowMin && start + dur > nowMin;
  const range = fmtClockRange(start, start + dur);
  const tall = h > 46;
  const focus = useFocusRing();
  return (
    <div onPointerDown={(ev) => onStartDrag(ev, task, "canvas")}
      className={(justPlaced ? "anim-scalein " : "") + (dragging ? "dragging " : "") + "glass plan-block"}
      style={{ position: "absolute", ...laneStyle(lane), top, height: h, minHeight: MIN_BLOCK_PX, borderRadius: 14, zIndex: 4,
        borderLeft: `3px solid ${e.color}`, padding: tall ? "9px 13px" : "5px 13px", cursor: "grab", overflow: "hidden",
        display: "flex", flexDirection: "column", gap: 3, touchAction: dragging ? "none" : "pan-y", ...noSelect, opacity: dragging ? 0.5 : 1,
        boxShadow: focus.ring ? "0 0 0 2px var(--accent), var(--shadow-lg)" : active ? "var(--shadow-lg), 0 0 0 1px var(--accent-dim)" : "var(--shadow)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <button type="button" data-block-id={task.id} onClick={() => onOpen(task.id)} onKeyDown={(ev) => onKeyMove(ev, task)}
          onFocus={focus.onFocus} onBlur={() => { focus.onBlur(); onKeyBlur(); }}
          aria-label={`${task.title}, ${range}${active ? ", happening now" : ""}`} aria-describedby={helpId} style={bareButton}>
          <span className="truncate" style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{task.title}</span>
          <span aria-hidden="true" style={stretched} />
        </button>
        {active && <span aria-hidden="true" className="mono" style={{ position: "relative", zIndex: 1, fontSize: 9, fontWeight: 700, color: "var(--accent-text, var(--accent))", letterSpacing: ".1em", pointerEvents: "none" }}>NOW</span>}
        <button type="button" className="plan-block-x" title="Back to Intake" aria-label={`Move “${task.title}” back to Intake`}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => { ev.stopPropagation(); onRemove(task.id, ev.detail === 0); }}
          style={{ position: "relative", zIndex: 1, flexShrink: 0, width: 20, height: 20, borderRadius: 6, border: "none", background: "var(--surface-2)", color: "var(--ink-4)", display: "grid", placeItems: "center", cursor: "pointer" }}>
          <Icon name="x" size={13} />
        </button>
      </div>
      {tall && (
        <div aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: 9, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-4)", minWidth: 0, pointerEvents: "none" }}>
          <span style={{ color: chipInk(e.color), whiteSpace: "nowrap" }}>{range}</span>
          {proj && <span className="truncate" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--ink-3)", minWidth: 0 }}><span style={{ width: 6, height: 6, borderRadius: 2, background: proj.color, flexShrink: 0 }} />{proj.name}</span>}
        </div>
      )}
    </div>
  );
}

function PlanDropPreview({ start, dur }: { start: number | null; dur: number }) {
  if (start == null) return null;
  const top = (start - DAY_START) * PXM, h = dur * PXM;
  return (
    <div style={{ position: "absolute", left: 54, right: 12, top, height: h, borderRadius: 14, zIndex: 5, pointerEvents: "none",
      background: "var(--accent-dim)", border: "2px dashed var(--accent)", display: "flex", alignItems: "center", paddingLeft: 13 }}>
      <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--accent-text, var(--accent))" }}>{fmtClock(start)} – {fmtClock(start + dur)}</span>
    </div>
  );
}

interface CanvasBlock { task: Task; start: number }

function DayCanvas({ blocks, events, nowMin, helpId, onStartDrag, onOpen, onRemove, onKeyMove, onKeyBlur, dragId, previewStart, previewDur, canvasRef, scrollRef, justPlacedId }: {
  blocks: CanvasBlock[];
  events: CalEvent[];
  nowMin: number;
  helpId: string;
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string, viaKeyboard: boolean) => void;
  onKeyMove: (ev: ReactKeyboardEvent, task: Task) => void;
  onKeyBlur: () => void;
  dragId?: string;
  previewStart: number | null;
  previewDur: number;
  canvasRef: RefObject<HTMLDivElement>;
  scrollRef: RefObject<HTMLDivElement>;
  justPlacedId: string | null;
}) {
  const totalH = (DAY_END - DAY_START) * PXM;
  const hours: number[] = [];
  for (let m = DAY_START; m <= DAY_END; m += 60) hours.push(m);
  // overlapping blocks (two tasks at once, or a task over a meeting) sit side by side
  const lanes = layoutLanes([
    ...events.map((ev) => ({ id: "ev:" + ev.id, start: ev.start, end: ev.end })),
    ...blocks.map((b) => ({ id: "t:" + b.task.id, start: b.start, end: b.start + Math.max(durOf(b.task), MIN_BLOCK_PX / PXM) })),
  ]);
  // on open, scroll so the current time sits near the top (don't strand the user at 7am)
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, (clamp(nowMin, DAY_START, DAY_END) - DAY_START) * PXM - 90);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "6px 0 70px" }}>
      <div ref={canvasRef} role="group" aria-label="Your day" style={{ position: "relative", height: totalH, margin: "0 20px 0 24px" }}>
        {hours.map((m) => (
          <div key={m} aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: (m - DAY_START) * PXM }}>
            <span style={{ position: "absolute", left: 0, top: -7, width: 46, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-4)" }}>{fmtClock(m)}</span>
            <div style={{ position: "absolute", left: 54, right: 12, height: 1, background: "var(--hairline)" }} />
          </div>
        ))}
        {hours.slice(0, -1).map((m) => <div key={"h" + m} aria-hidden="true" style={{ position: "absolute", left: 54, right: 12, top: (m + 30 - DAY_START) * PXM, height: 1, background: "var(--hairline)", opacity: 0.4 }} />)}
        {events.map((ev) => <PlanEventBlock key={ev.id} ev={ev} lane={lanes["ev:" + ev.id]} />)}
        {blocks.map((b) => (
          <PlanTaskBlock key={b.task.id} task={b.task} start={b.start} lane={lanes["t:" + b.task.id]} nowMin={nowMin} helpId={helpId}
            onStartDrag={onStartDrag} onOpen={onOpen} onRemove={onRemove} onKeyMove={onKeyMove} onKeyBlur={onKeyBlur}
            dragging={dragId === b.task.id} justPlaced={justPlacedId === b.task.id} />
        ))}
        <PlanDropPreview start={previewStart} dur={previewDur} />
        <PlanNowLine nowMin={nowMin} />
      </div>
    </div>
  );
}

/* ---------- capture ---------- */
function PlanCapture({ onCapture, inputRef, hint = true, defaults }: { onCapture: (t: Task) => void; inputRef: RefObject<HTMLInputElement>; hint?: boolean; defaults?: CaptureOptions }) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  // "today" / "tomorrow" in the text resolve against the date, so the preview
  // re-reads it when the day changes under a half-typed capture
  const today = todayISO();
  const projectId = defaults?.projectId, assigneeId = defaults?.assigneeId;
  const preview = useMemo(() => (text.trim().length > 1 ? parseCapture(text, { projectId, assigneeId }) : null), [text, today, projectId, assigneeId]);
  const submit = () => { const t = parseCapture(text, { projectId, assigneeId }); if (t) { onCapture(t); setText(""); } };
  return (
    <div style={{ position: "relative" }}>
      <div className="glass" style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", borderRadius: 16,
        boxShadow: focused ? "var(--shadow-lg), 0 0 0 4px var(--accent-dim)" : "var(--shadow)", borderColor: focused ? "var(--accent)" : "var(--hairline)" }}>
        <Icon name="sparkles" size={18} style={{ color: focused ? "var(--accent)" : "var(--ink-4)" }} />
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 140)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); else if (e.key === "Escape" && text) { e.stopPropagation(); setText(""); } }}
          aria-label="Capture a task for today" placeholder="Add anything — “Draft Q3 deck 90m deep work today”"
          style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-display)", fontSize: 15, color: "var(--ink)" }} />
        {text ? <button className="btn btn-accent" style={{ padding: "6px 12px" }} onMouseDown={(e) => { e.preventDefault(); submit(); }} onClick={(e) => { if (e.detail === 0) submit(); }}>Add</button>
          : hint && !focused && <kbd className="mono" title="Press q to jump here" aria-hidden="true" style={{ fontSize: 11, padding: "3px 7px", borderRadius: 7, background: "var(--surface-2)", border: "1px solid var(--hairline)", color: "var(--ink-4)", whiteSpace: "nowrap" }}>press q</kbd>}
      </div>
      {focused && preview && (
        <div className="glass anim-scalein" style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, right: 0, zIndex: 30, padding: "13px 15px", borderRadius: 16, boxShadow: "var(--shadow-lg)", background: "var(--surface-raised)" }}>
          <div className="kicker" style={{ marginBottom: 9, color: "var(--accent-text, var(--accent))" }}>Kanbo understood</div>
          <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 10 }}>{preview.title}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            <span className="pchip"><Icon name="clock" size={12} /> {fmtDurMin(durOf(preview))}</span>
            <EnergyChip energy={energyKindOf(preview)} />
            {preview.dueDate && <span className="pchip">Due {fmtDue(preview.dueDate)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- carry-over (first open of a new day) ---------- */
function CarryBanner({ label, count, onCarry, onClear, onKeep }: { label: string; count: number; onCarry: () => void; onClear: () => void; onKeep: () => void }) {
  const them = count === 1 ? "it" : "them";
  return (
    <div style={{ padding: "0 24px 12px" }}>
      <div className="glass anim-fadeup" role="region" aria-label="Unfinished blocks from an earlier plan"
        style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "10px 10px 10px 13px", borderRadius: 14, border: "1px solid color-mix(in oklch, var(--accent) 30%, var(--hairline))" }}>
        <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 9, background: "var(--accent-dim)", color: "var(--accent)", flexShrink: 0 }}><Icon name="calendar" size={15} /></span>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{label}: {count} unfinished block{count === 1 ? "" : "s"}</div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 1 }}>Carry over puts {them} back in Intake to re-plan. Clear takes {them} off today.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginLeft: "auto" }}>
          <button type="button" className="btn btn-accent" onClick={onCarry} style={{ padding: "6px 12px", fontSize: 12.5 }}>Carry over</button>
          <button type="button" className="btn btn-ghost" onClick={onClear} style={{ padding: "6px 12px", fontSize: 12.5 }}>Clear</button>
          <button type="button" className="btn-icon" onClick={onKeep} title="Keep them where they are" aria-label="Keep them where they are" style={{ width: 30, height: 30, border: "none", color: "var(--ink-4)" }}><Icon name="x" size={15} /></button>
        </div>
      </div>
    </div>
  );
}

/* ---------- intake ---------- */
function IntakeCard({ task, dragging, onStartDrag, onSchedule, onOpen, onNotToday }: {
  task: Task; dragging?: boolean;
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource) => void;
  onSchedule: (id: string, viaKeyboard: boolean) => void;
  onOpen: (id: string) => void;
  onNotToday: (task: Task, ev: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const e = energyMetaOf(task);
  const due = dueState(task.dueDate, task.status);
  const urgent = due === "overdue" || due === "today";
  const dueLabel = fmtDue(task.dueDate);
  const focus = useFocusRing();
  return (
    <div data-intake-card onPointerDown={(ev) => onStartDrag(ev, task, "intake")}
      className="glass lift" style={{ position: "relative", padding: "11px 12px 11px 13px", borderRadius: 14, borderLeft: `3px solid ${e.color}`, cursor: "grab",
        touchAction: dragging ? "none" : "pan-y", ...noSelect, opacity: dragging ? 0.55 : 1,
        boxShadow: focus.ring ? "0 0 0 2px var(--accent), var(--shadow)" : undefined }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <button type="button" data-intake-open onClick={() => onOpen(task.id)} onFocus={focus.onFocus} onBlur={focus.onBlur}
          aria-label={`${task.title}, ${fmtDurMin(durOf(task))}, ${e.label}${dueLabel ? `, due ${dueLabel}` : ""}`} style={bareButton}>
          <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, lineHeight: 1.3, color: "var(--ink)", overflowWrap: "anywhere" }}>{task.title}</span>
          <span aria-hidden="true" style={stretched} />
        </button>
        <button type="button" onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); onSchedule(task.id, ev.detail === 0); }}
          title="Place on day" aria-label={`Place “${task.title}” on your day`} className="iadd"
          style={{ position: "relative", zIndex: 1, width: 25, height: 25, borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface-2)", color: "var(--ink-3)", display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0 }}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 7, marginTop: 9 }}>
        <span aria-hidden="true" className="pchip" style={{ pointerEvents: "none" }}><Icon name="clock" size={11} /> {fmtDurMin(durOf(task))}</span>
        <span aria-hidden="true" style={{ pointerEvents: "none", display: "inline-flex" }}><EnergyChip energy={energyKindOf(task)} small /></span>
        {dueLabel && (
          <span aria-hidden="true" className="mono" style={{ pointerEvents: "none", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: urgent ? "var(--prio-urgent)" : "var(--ink-4)", fontWeight: urgent ? 600 : 400 }}>
            {urgent && <span style={{ width: 5, height: 5, borderRadius: 99, background: "var(--prio-urgent)" }} />}{dueLabel}
          </span>
        )}
        <button type="button" onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); onNotToday(task, ev); }}
          title="Take it off today's list" aria-label={`Not today: take “${task.title}” off today's list`}
          style={{ position: "relative", zIndex: 1, marginLeft: "auto", border: "none", background: "transparent", padding: "2px 4px", borderRadius: 6, fontFamily: "var(--font-display)", fontSize: 11.5, fontWeight: 500, color: "var(--ink-4)", cursor: "pointer" }}>
          Not today
        </button>
      </div>
    </div>
  );
}

function IntakeRail({ items, empty, dragId, onStartDrag, onSchedule, onOpen, onNotToday, onAutoPlan, planning, stacked, dropActive, railRef, headingRef, slippedCount, onPullSlipped }: {
  items: Task[];
  empty: boolean;
  dragId?: string;
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource) => void;
  onSchedule: (id: string, viaKeyboard: boolean) => void;
  onOpen: (id: string) => void;
  onNotToday: (task: Task, ev: ReactMouseEvent<HTMLButtonElement>) => void;
  onAutoPlan: () => void;
  planning: boolean;
  stacked?: boolean;
  dropActive?: boolean;
  railRef: RefObject<HTMLElement>;
  headingRef: RefObject<HTMLHeadingElement>;
  slippedCount: number;
  onPullSlipped: () => void;
}) {
  return (
    <aside ref={railRef} aria-label="Intake" style={{ position: "relative", width: stacked ? "100%" : 340, flexShrink: 0, maxHeight: stacked ? "46vh" : undefined, display: "flex", flexDirection: "column", borderLeft: stacked ? "none" : "1px solid var(--hairline)", borderTop: stacked ? "1px solid var(--hairline)" : "none", background: "color-mix(in oklch, var(--bg-deep) 45%, transparent)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", transition: "box-shadow .15s var(--ease)", boxShadow: dropActive ? "inset 0 0 0 2px var(--accent)" : "none" }}>
      {dropActive && (
        <div style={{ position: "absolute", inset: 0, zIndex: 20, display: "grid", placeItems: "center", pointerEvents: "none", background: "color-mix(in oklch, var(--accent) 12%, transparent)", backdropFilter: "blur(2px)" }}>
          <div className="glass anim-scalein" style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 18px", borderRadius: 14, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", border: "1px dashed var(--accent)" }}>
            <Icon name="arrowLeft" size={16} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--accent-text, var(--accent))" }}>Release to move back to Intake</span>
          </div>
        </div>
      )}
      <div style={{ padding: "18px 18px 14px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <h3 ref={headingRef} tabIndex={-1} style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>Intake</h3>
          <span className="mono tnum" style={{ fontSize: 12, color: "var(--ink-4)", whiteSpace: "nowrap" }}>{items.length} unplaced</span>
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ink-3)" }}>{stacked ? "Hold and drag onto your day, or let Kanbo plan it." : "Drag onto your day, or let Kanbo plan it."}</p>
        <button type="button" onClick={onAutoPlan} disabled={planning || items.length === 0} className="btn btn-accent"
          style={{ width: "100%", justifyContent: "center", marginTop: 13, opacity: items.length === 0 ? 0.5 : 1 }}>
          <Icon name="sparkles" size={16} /> {planning ? "Planning your day…" : "Auto-plan my day"}
        </button>
        {slippedCount > 0 && (
          <button type="button" onClick={onPullSlipped} className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", marginTop: 8 }}>
            <Icon name="arrowRight" size={15} /> Bring in {slippedCount} due &amp; overdue
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "2px 14px 24px", display: "flex", flexDirection: "column", gap: 9 }}>
        {empty ? (
          <div style={{ textAlign: "center", padding: "40px 18px", color: "var(--ink-4)" }}>
            <div style={{ display: "inline-flex", padding: 13, borderRadius: 16, background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 12 }}><Icon name="sparkles" size={22} /></div>
            <p style={{ fontSize: 14, color: "var(--ink)", margin: 0, fontWeight: 600 }}>Welcome to Kanbo 👋</p>
            <p style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>Capture your first task in the bar above — try <span style={{ color: "var(--ink-2)" }}>“Draft proposal 60m deep work today”</span> — then hit Auto-plan to lay out your day.</p>
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: "center", padding: "44px 16px", color: "var(--ink-4)" }}>
            <div style={{ display: "inline-flex", padding: 13, borderRadius: 16, background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 12 }}><Icon name="check" size={22} sw={2.4} /></div>
            <p style={{ fontSize: 13.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>Everything's on the day.</p>
            <p style={{ fontSize: 12.5, margin: "4px 0 0" }}>Your plan is set — go do the first thing.</p>
          </div>
        ) : items.map((t) => <IntakeCard key={t.id} task={t} dragging={dragId === t.id} onStartDrag={onStartDrag} onSchedule={onSchedule} onOpen={onOpen} onNotToday={onNotToday} />)}
      </div>
    </aside>
  );
}

function PlanToast({ msg, onClose }: { msg: string | null; onClose: () => void }) {
  // the live region stays mounted so screen readers announce each new message
  return (
    <div role="status" aria-live="polite" style={{ position: "absolute", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 40, maxWidth: "min(580px, calc(100% - 32px))", width: msg ? "max-content" : 0, pointerEvents: msg ? "auto" : "none" }}>
      {msg && (
        <div className="glass anim-fadeup" style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: "13px 16px", borderRadius: 16, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
          <Icon name="sparkles" size={17} style={{ color: "var(--accent)", marginTop: 1, flexShrink: 0 }} />
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--ink-2)" }}>{msg}</p>
          <button type="button" onClick={onClose} aria-label="Dismiss" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", padding: 2, flexShrink: 0 }}><Icon name="x" size={16} /></button>
        </div>
      )}
    </div>
  );
}

/* ---------- the view ---------- */
export function PlanView({ tasks, onUpdate, onCreate, onOpen, externalEvents = [], calendarConnected = false, currentUserId, captureDefaults }: {
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
}) {
  const authUserId = useAuthUserId();
  const me = currentUserId ?? authUserId;
  const toast = useOptionalToast();
  const { nowMin, day } = useClock();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const isMobile = useMediaQuery("(max-width: 860px)");
  const helpId = useId();

  // Once a real calendar is connected, plan around its events (today's, timed).
  // Before that, fall back to the illustrative demo day so the view isn't empty.
  const dayEvents = useMemo(
    () => (calendarConnected ? todaysEvents(externalEvents) : EVENTS),
    // `day` re-reads "today's" events after midnight
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [calendarConnected, externalEvents, day],
  );
  const [planning, setPlanning] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef(0);
  const [justPlacedId, setJustPlaced] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [previewStart, setPreviewStart] = useState<number | null>(null);
  const [overRail, setOverRail] = useState(false);
  const [kb, setKb] = useState<{ id: string; start: number } | null>(null);
  const [srMsg, setSrMsg] = useState("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
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
  const rootRef = useRef<HTMLDivElement>(null);
  const touchDragRef = useRef(false);

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
    setSrMsg((prev) => (prev === msg ? msg + "\u200b" : msg));
  }, []);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 9000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  /* ----- what's on today's plan ----- */
  // Finished and archived tasks leave the canvas and the capacity maths, so
  // yesterday's struck-through blocks can't pile up on today.
  const live = tasks.filter((t) => !t.archivedAt);
  const planTasks = live.filter((t) => t.planToday && t.status !== "done");
  const isPlaced = (t: Task) => t.scheduled != null && Number.isFinite(t.scheduled);
  const blocks: CanvasBlock[] = planTasks.filter(isPlaced)
    // DOM (and so Tab) order follows the clock — by the saved time, so a block
    // being nudged from the keyboard doesn't jump in the DOM (and lose focus) mid-move
    .sort((a, b) => a.scheduled! - b.scheduled!)
    .map((t) => ({ task: t, start: kb && kb.id === t.id ? kb.start : t.scheduled! }));
  const unscheduled = planTasks.filter((t) => !isPlaced(t));

  const scheduledFocus = blocks.filter((b) => { const k = energyKindOf(b.task); return k === "deep" || k === "create"; }).reduce((a, b) => a + durOf(b.task), 0);

  // capacity: merged busy time (meetings + planned blocks, overlaps counted once)
  // against the day window, and what's still free between now and the end of day.
  const workMin = DAY_END - DAY_START;
  const blockSpans = blocks.map((b) => ({ start: b.start, end: b.start + durOf(b.task) }));
  const meetingMin = totalMinutes(mergeIntervals(dayEvents, DAY_START, DAY_END));
  const busySpans = mergeIntervals([...dayEvents, ...blockSpans], DAY_START, DAY_END);
  const busyMin = totalMinutes(busySpans);
  const scheduledMin = Math.max(0, busyMin - meetingMin);
  const fromMin = clamp(nowMin, DAY_START, DAY_END);
  const freeLeft = Math.max(0, (DAY_END - fromMin) - totalMinutes(mergeIntervals(busySpans, fromMin, DAY_END)));
  const intakeMin = unscheduled.reduce((a, t) => a + durOf(t), 0);
  const overCapacity = intakeMin > 0 && intakeMin > freeLeft;
  const pctBusy = Math.min(100, Math.round((busyMin / workMin) * 100));
  const meterText = overCapacity ? `Intake is ${fmtDurMin(intakeMin - freeLeft)} more than fits today` : `${fmtDurMin(freeLeft)} left free · ${pctBusy}% booked`;
  const meterTitle = `${fmtDurMin(meetingMin)} meetings · ${fmtDurMin(scheduledMin)} planned · ${fmtDurMin(freeLeft)} free for the rest of today${intakeMin ? ` · ${fmtDurMin(intakeMin)} still in Intake` : ""}`;

  // carry-over ritual: tasks that slipped (overdue) or are due today but aren't
  // on the day yet — one click pulls them into Intake to plan.
  const slipped = live.filter((t) => t.status !== "done" && !t.planToday && (dueState(t.dueDate, t.status) === "overdue" || dueState(t.dueDate, t.status) === "today"));
  const pullSlipped = useCallback(() => {
    slipped.forEach((t) => onUpdate(t.id, { planToday: true }));
    announce(`Brought ${slipped.length} due and overdue task${slipped.length === 1 ? "" : "s"} into Intake.`);
  }, [slipped, onUpdate, announce]);

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
  const carryTasks = planTasks.filter((t) => carry.ids.includes(t.id));
  const resolveCarry = (mode: "carry" | "clear" | "keep") => {
    const list = carryTasks.map((t) => ({ id: t.id, scheduled: t.scheduled! }));
    // answered for today: an Undo that puts a block back where it was won't re-prompt
    saveSeen(seenRef.current.key, markSeen(seenRef.current.map, list.map((p) => ({ id: p.id, at: p.scheduled })), day));
    if (mode === "keep" || list.length === 0) return;
    list.forEach((p) => onUpdate(p.id, mode === "carry" ? { scheduled: null } : { scheduled: null, planToday: false }));
    const noun = `${list.length} block${list.length === 1 ? "" : "s"}`;
    const msg = mode === "carry" ? `Moved ${noun} back to Intake to re-plan.` : `Cleared ${noun} from today.`;
    if (toast) toast.action(msg, "Undo", () => list.forEach((p) => onUpdate(p.id, { scheduled: p.scheduled, planToday: true })), 8000);
    else announce(msg);
    requestAnimationFrame(() => (mode === "carry" ? intakeHeadingRef.current : dayHeadingRef.current)?.focus());
  };

  /* ----- placing / removing ----- */
  const flashPlaced = useCallback((id: string) => { setJustPlaced(id); window.setTimeout(() => setJustPlaced((cur) => (cur === id ? null : cur)), 500); }, []);
  const place = useCallback((id: string, start: number, title: string, dur: number) => {
    onUpdate(id, { scheduled: start });
    touchBlock(id, start);
    flashPlaced(id);
    announce(`Planned “${title}” for ${fmtClockRange(start, start + dur)}.`);
  }, [onUpdate, touchBlock, flashPlaced, announce]);
  const unschedule = useCallback((id: string, title: string) => {
    onUpdate(id, { scheduled: null });
    touchBlock(id, null);
    announce(`Moved “${title}” back to Intake.`);
  }, [onUpdate, touchBlock, announce]);

  const removeFromDay = useCallback((id: string, viaKeyboard: boolean) => {
    const t = tasksRef.current.find((x) => x.id === id); if (!t) return;
    unschedule(id, t.title);
    if (viaKeyboard) requestAnimationFrame(() => dayHeadingRef.current?.focus());
  }, [unschedule]);

  const notToday = useCallback((task: Task, ev: ReactMouseEvent<HTMLButtonElement>) => {
    const viaKeyboard = ev.detail === 0;
    let next: HTMLElement | null = null;
    if (viaKeyboard) {
      const card = ev.currentTarget.closest("[data-intake-card]");
      const sib = (card?.nextElementSibling ?? card?.previousElementSibling) as HTMLElement | null;
      next = sib?.querySelector<HTMLElement>("[data-intake-open]") ?? null;
    }
    onUpdate(task.id, { planToday: false });
    touchBlock(task.id, null);
    const msg = `Took “${task.title}” off today.`;
    if (toast) toast.action(msg, "Undo", () => onUpdate(task.id, { planToday: true }));
    else announce(msg);
    if (viaKeyboard) requestAnimationFrame(() => (next ?? intakeHeadingRef.current)?.focus());
  }, [onUpdate, touchBlock, toast, announce]);

  // a newly placed block scrolls into view; from the keyboard it also takes focus
  useEffect(() => {
    const r = revealRef.current; if (!r) return;
    const el = Array.from(canvasRef.current?.querySelectorAll<HTMLElement>("[data-block-id]") ?? []).find((x) => x.dataset.blockId === r.id);
    if (!el) return;
    revealRef.current = null;
    try { el.scrollIntoView({ block: "nearest" }); } catch { /* jsdom */ }
    if (r.focus) el.focus();
  });

  const scheduleOne = useCallback((id: string, viaKeyboard: boolean) => {
    const cur = tasksRef.current;
    const target = cur.find((t) => t.id === id); if (!target) return;
    const others = cur
      .filter((t) => t.id !== id && t.planToday && t.status !== "done" && !t.archivedAt && t.scheduled != null && Number.isFinite(t.scheduled))
      .map((t) => ({ id: "busy-" + t.id, title: t.title, start: t.scheduled!, end: t.scheduled! + durOf(t), kind: "meeting" as const }));
    const dur = durOf(target);
    const placed = planDay([{ ...target, energy: energyKindOf(target), dur, scheduled: null }], [...dayEvents, ...others]);
    if (placed[id] != null) {
      revealRef.current = { id, focus: viaKeyboard };
      place(id, placed[id], target.title, dur);
    } else {
      showToast(`“${target.title}” doesn’t fit in what’s left of today. Drag it onto a gap, or take something else off the day.`);
    }
  }, [dayEvents, place, showToast]);

  const doAutoPlan = useCallback(() => {
    setPlanning(true);
    window.setTimeout(() => {
      const cur = tasksRef.current.filter((t) => t.planToday && t.status !== "done" && !t.archivedAt);
      const fixed = cur.filter((t) => t.scheduled != null && Number.isFinite(t.scheduled));
      const todo = cur.filter((t) => !(t.scheduled != null && Number.isFinite(t.scheduled)))
        .map((t) => ({ ...t, energy: energyKindOf(t), dur: durOf(t), scheduled: null }));
      // already-placed blocks are busy time — auto-plan fills the gaps, never stacks on them
      const busy = fixed.map((t) => ({ id: "busy-" + t.id, title: t.title, start: t.scheduled!, end: t.scheduled! + durOf(t), kind: "meeting" as const }));
      const placed = planDay(todo, [...dayEvents, ...busy]);
      const ids = Object.keys(placed);
      ids.forEach((id) => onUpdate(id, { scheduled: placed[id] }));
      const n = ids.length, leftover = todo.length - n;
      setPlanning(false);
      const rest = leftover ? ` ${leftover} didn’t fit today, so ${leftover === 1 ? "it stays" : "they stay"} in Intake.` : "";
      showToast(n
        ? `Planned ${n} task${n === 1 ? "" : "s"} around your meetings — deep work up front, lighter work after lunch.${rest}`
        : `Nothing more fits in what’s left of today.${rest}`);
    }, reduceMotion ? 0 : 850);
  }, [onUpdate, dayEvents, showToast, reduceMotion]);

  /* ----- keyboard: move a focused block by 15 minutes (Shift: an hour), Delete to unplan ----- */
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
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      const step = ev.shiftKey ? 60 : 15;
      const cur = kbRef.current?.id === task.id ? kbRef.current.start : task.scheduled!;
      const dur = durOf(task);
      // land on the step's grid (9:07 ↓ → 9:15, ↑ → 9:00) so moves are predictable
      const raw = ev.key === "ArrowDown" ? Math.floor(cur / step) * step + step : Math.ceil(cur / step) * step - step;
      const next = clamp(raw, DAY_START, DAY_END - dur);
      if (kbRef.current && kbRef.current.id !== task.id) flushKb();
      const k = { id: task.id, start: next };
      kbRef.current = k; setKb(k);
      window.clearTimeout(kbTimer.current);
      kbTimer.current = window.setTimeout(flushKb, KEY_COMMIT_MS);
      announce(`${task.title}: ${fmtClockRange(next, next + dur)}`);
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      if (kbRef.current?.id === task.id) { window.clearTimeout(kbTimer.current); kbRef.current = null; setKb(null); }
      removeFromDay(task.id, true);
    }
  }, [flushKb, announce, removeFromDay]);

  /* ----- pointer drag (mouse, pen and touch) ----- */
  const isOverRail = useCallback((x: number, y: number) => {
    const r = railRef.current?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }, []);

  const computePreview = useCallback((x: number, y: number, dur: number, grab: number): number | null => {
    const c = canvasRef.current; if (!c) return null;
    const r = c.getBoundingClientRect();
    if (x < r.left - 40 || x > r.right + 40) return null;
    // pointer and rect are screen px; at Small/Large text the day is zoomed, so a minute is PXM × zoom of them
    const m = snapTo(DAY_START + (y - r.top - grab) / (PXM * uiZoom()));
    return clamp(m, DAY_START, DAY_END - dur);
  }, []);

  const activate = useCallback((base: DragState, x: number, y: number) => {
    pointerRef.current = { x, y };
    movedRef.current = Math.hypot(x - base.x0, y - base.y0);
    touchDragRef.current = base.touch;
    setDrag(base);
    setPointer({ x, y });
    setPreviewStart(isOverRail(x, y) ? null : computePreview(x, y, base.dur, base.grab));
  }, [computePreview, isOverRail]);

  // A press only becomes a drag once it's clearly meant as one: a mouse must
  // travel a few px (so a click just opens the task and never writes), and a
  // finger must hold still for a long-press (so swiping scrolls the day).
  const startDrag = useCallback((e: ReactPointerEvent, task: Task, source: DragSource) => {
    if (drag || pendingRef.current) return;
    const touch = e.pointerType === "touch";
    if (!touch && e.button !== 0) return;
    if (!touch) e.preventDefault(); // no text selection while dragging with a mouse
    const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
    const top = canvasRef.current?.getBoundingClientRect().top ?? 0;
    const grab = source === "canvas" && task.scheduled != null ? y0 - ((task.scheduled - DAY_START) * PXM * uiZoom() + top) : 16;
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
      const b = touch ? { ...base, x0: last.x, y0: last.y, grab: base.origin != null ? base.grab + (last.y - y0) : base.grab } : base;
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
  }, [drag, activate]);
  useEffect(() => () => pendingRef.current?.(), []);

  // a layout effect, so the listeners are in place as soon as the drag renders (see go())
  useLayoutEffect(() => {
    if (!drag) return;
    let ended = false, raf = 0;
    const update = (x: number, y: number) => {
      const onRail = isOverRail(x, y);
      setOverRail(onRail);
      // while hovering the intake rail, suppress the day preview so it reads as "removing"
      setPreviewStart(onRail ? null : computePreview(x, y, drag.dur, drag.grab));
    };
    const finish = (commit: boolean, e?: PointerEvent) => {
      if (ended) return;
      ended = true;
      // commit only a real move to a different time — a click or a nudge that
      // snaps back to the same slot writes nothing
      if (commit && e && movedRef.current > MOUSE_SLOP) {
        const onRail = isOverRail(e.clientX, e.clientY);
        const start = onRail ? null : computePreview(e.clientX, e.clientY, drag.dur, drag.grab);
        if (start != null) { if (start !== drag.origin) place(drag.taskId, start, drag.title, drag.dur); }
        else if (drag.source === "canvas") unschedule(drag.taskId, drag.title); // dropped on the rail (or off the day) → back to Intake
      }
      lastDragEndRef.current = performance.now();
      touchDragRef.current = false;
      setDrag(null); setPreviewStart(null); setOverRail(false);
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
      const sc = scrollRef.current, { x, y } = pointerRef.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        const inside = x >= r.left && x <= r.right && y >= r.top - 40 && y <= r.bottom + 40 && !isOverRail(x, y);
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
  }, [drag, computePreview, isOverRail, place, unschedule]);

  // the click that ends a drag must not also open the task
  const openItem = useCallback((id: string) => {
    if (performance.now() - lastDragEndRef.current < 400) return;
    onOpen(id);
  }, [onOpen]);

  // "q" jumps to this view's capture bar (instead of the global quick-capture
  // dialog) while Plan is on screen and nothing modal is open
  useEffect(() => {
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
  }, []);

  const ghostEnergy = drag ? (ENERGY[drag.energy] ?? ENERGY.admin) : null;
  const zoom = drag ? uiZoom() : 1; // the fixed ghost sits inside the zoomed page: screen px ÷ zoom
  return (
    <div ref={rootRef} style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", minHeight: 0 }}>
      <span id={helpId} className="sr-only">Press Enter to open. Use the up and down arrow keys to move it by 15 minutes, or hold Shift to move it by an hour. Press Delete to send it back to Intake.</span>
      <div role="status" aria-live="polite" className="sr-only">{srMsg}</div>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        <div style={{ padding: "16px 24px 12px" }}><PlanCapture onCapture={onCreate} inputRef={captureRef} hint={!isMobile} defaults={captureDefaults} /></div>
        {carryTasks.length > 0 && (
          <CarryBanner label={carryLabel(carry.from, day)} count={carryTasks.length}
            onCarry={() => resolveCarry("carry")} onClear={() => resolveCarry("clear")} onKeep={() => resolveCarry("keep")} />
        )}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px 11px", padding: "0 24px 8px" }}>
          <h2 ref={dayHeadingRef} tabIndex={-1} style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>Your day</h2>
          <span className="mono" style={{ fontSize: 12, color: "var(--ink-4)" }}>{fmtClock(DAY_START)} – {fmtClock(DAY_END)}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-3)", marginLeft: 4 }}><Icon name="zap" size={13} style={{ color: "var(--accent)" }} /> {scheduledFocus > 0 ? `${fmtDurMin(scheduledFocus)} focus planned` : "No focus time planned yet"}</span>
          <div style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-3)" }}><span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 6px var(--accent-glow)" }} /> now {fmtClock(nowMin)}</span>
        </div>
        {/* capacity meter */}
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "0 24px 12px" }}>
          <div role="meter" aria-label="Day booked" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pctBusy} aria-valuetext={meterTitle} title={meterTitle}
            style={{ flex: 1, maxWidth: 340, height: 8, borderRadius: 5, background: "var(--track, var(--surface-2))", overflow: "hidden", display: "flex" }}>
            <div style={{ width: `${(meetingMin / workMin) * 100}%`, background: "var(--ink-4)" }} />
            <div style={{ width: `${(scheduledMin / workMin) * 100}%`, background: overCapacity ? "var(--prio-urgent)" : "var(--accent)", transition: "width .5s var(--ease)" }} />
          </div>
          <span style={{ fontSize: 12, color: overCapacity ? "var(--prio-urgent)" : "var(--ink-3)", fontWeight: 500, whiteSpace: "nowrap" }}>{meterText}</span>
        </div>
        <DayCanvas blocks={blocks} events={dayEvents} nowMin={nowMin} helpId={helpId} onStartDrag={startDrag} onOpen={openItem} onRemove={removeFromDay}
          onKeyMove={onBlockKey} onKeyBlur={flushKb} dragId={drag?.taskId} previewStart={previewStart} previewDur={drag?.dur || 30}
          canvasRef={canvasRef} scrollRef={scrollRef} justPlacedId={justPlacedId} />
        <PlanToast msg={toastMsg} onClose={() => setToastMsg(null)} />
        {planning && (
          <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "grid", placeItems: "center", background: "color-mix(in oklch, var(--bg) 35%, transparent)", backdropFilter: "blur(2px)" }}>
            <div className="glass anim-scalein" style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 22px", borderRadius: 16, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
              <Icon name="sparkles" size={20} style={{ color: "var(--accent)" }} />
              <span className="ai-think" style={{ fontSize: 15, fontWeight: 600 }}>Kanbo is planning your day…</span>
            </div>
          </div>
        )}
      </div>
      <IntakeRail items={unscheduled} empty={tasks.length === 0} dragId={drag?.taskId} onStartDrag={startDrag} onSchedule={scheduleOne} onOpen={openItem} onNotToday={notToday}
        onAutoPlan={doAutoPlan} planning={planning} stacked={isMobile} dropActive={overRail && drag?.source === "canvas"}
        railRef={railRef} headingRef={intakeHeadingRef} slippedCount={slipped.length} onPullSlipped={pullSlipped} />
      {drag && ghostEnergy && (
        // on touch the ghost floats above the finger so it isn't hidden under it
        <div aria-hidden="true" style={{ position: "fixed", left: pointer.x / zoom + (drag.touch ? -24 : 14), top: pointer.y / zoom + (drag.touch ? -58 : -10), zIndex: 80, pointerEvents: "none", maxWidth: 240,
          padding: "8px 12px", borderRadius: 12, background: "var(--surface-raised)", border: "1px solid var(--hairline-strong)", borderLeft: `3px solid ${ghostEnergy.color}`, boxShadow: "var(--shadow-lg)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", transform: reduceMotion ? undefined : "rotate(-1.5deg)" }}>
          <span className="truncate" style={{ fontSize: 13, fontWeight: 600, display: "block" }}>{drag.title}</span>
          {previewStart != null && <span className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--accent-text, var(--accent))", marginTop: 2 }}>{fmtClockRange(previewStart, previewStart + drag.dur)}</span>}
        </div>
      )}
    </div>
  );
}
