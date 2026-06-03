/* ============================================================
   KORA — Plan my day (white-glass, time-native hero)
   Day canvas + intake + NL capture + AI auto-plan.
   ============================================================ */
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../primitives";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  getProject, dueState, fmtDue, fmtClock, fmtClockRange, fmtDurMin,
  parseCapture, planDay, ENERGY, EVENTS, DAY_START, DAY_END, NOW_MIN,
} from "../../data/data";
import type { Task, CalEvent, EnergyKind } from "../../data/types";

const PXM = 1.0; // px per minute
const SNAP = 5;

type DragSource = "intake" | "canvas";
interface DragState {
  taskId: string;
  dur: number;
  title: string;
  energy: EnergyKind;
  source: DragSource;
  grab: number;
}

export function EnergyChip({ energy, small }: { energy: EnergyKind; small?: boolean }) {
  const e = ENERGY[energy];
  if (!e) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: small ? 9.5 : 10.5, fontWeight: 500,
      color: e.color, padding: small ? "1px 6px" : "2px 7px", borderRadius: 6,
      background: `color-mix(in oklch, ${e.color} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${e.color} 26%, transparent)` }}>
      <Icon name={e.icon} size={small ? 10 : 11} /> {e.label}
    </span>
  );
}

/* ---------- day canvas pieces ---------- */
function PlanNowLine() {
  const top = (NOW_MIN - DAY_START) * PXM;
  return (
    <div style={{ position: "absolute", left: 54, right: 12, top, zIndex: 6, pointerEvents: "none" }}>
      <span style={{ position: "absolute", left: -54, top: -7, width: 48, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600, color: "var(--accent)" }}>{fmtClock(NOW_MIN)}</span>
      <span style={{ position: "absolute", left: -4, top: -4, width: 9, height: 9, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 0 4px var(--accent-dim), 0 0 10px var(--accent-glow)" }} />
      <div style={{ height: 2, background: "var(--accent)", borderRadius: 2, opacity: 0.85, boxShadow: "0 0 8px var(--accent-glow)" }} />
    </div>
  );
}

function PlanEventBlock({ ev }: { ev: CalEvent }) {
  const top = (ev.start - DAY_START) * PXM, h = (ev.end - ev.start) * PXM;
  const tall = h > 38;
  return (
    <div style={{ position: "absolute", left: 54, right: 12, top, height: h, borderRadius: 14, padding: tall ? "8px 13px" : "0 13px",
      background: "color-mix(in oklch, var(--surface-2) 60%, transparent)", border: "1px dashed var(--hairline-strong)",
      backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
      display: "flex", flexDirection: tall ? "column" : "row", alignItems: tall ? "flex-start" : "center", justifyContent: "center", gap: tall ? 2 : 10, overflow: "hidden", zIndex: 2 }}>
      <span className="truncate" style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)", flex: tall ? "none" : 1, minWidth: 0 }}>
        {ev.title}{ev.with ? <span style={{ fontWeight: 400, color: "var(--ink-4)" }}>{"  ·  " + ev.with.join(", ")}</span> : null}
      </span>
      <span className="mono" style={{ fontSize: 10, color: "var(--ink-4)", flexShrink: 0 }}>{tall ? fmtClockRange(ev.start, ev.end) : fmtClock(ev.start)}</span>
    </div>
  );
}

function PlanTaskBlock({ task, onStartDrag, onOpen, dragging, justPlaced }: {
  task: Task; onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource) => void; onOpen: (id: string) => void; dragging?: boolean; justPlaced?: boolean;
}) {
  const top = (task.scheduled! - DAY_START) * PXM, h = (task.dur || task.focusMin) * PXM;
  const e = ENERGY[task.energy!], proj = getProject(task.projectId);
  const active = task.scheduled! <= NOW_MIN && task.scheduled! + (task.dur || task.focusMin) > NOW_MIN && task.status !== "done";
  const done = task.status === "done";
  return (
    <div onPointerDown={(ev) => onStartDrag(ev, task, "canvas")} onClick={(ev) => { ev.stopPropagation(); onOpen(task.id); }}
      className={(justPlaced ? "anim-scalein " : "") + (dragging ? "dragging " : "") + "glass"}
      style={{ position: "absolute", left: 54, right: 12, top, height: h, minHeight: 26, borderRadius: 14, zIndex: 4,
        borderLeft: `3px solid ${e.color}`, padding: h > 46 ? "9px 13px" : "5px 13px", cursor: "grab", overflow: "hidden",
        display: "flex", flexDirection: "column", gap: 3, touchAction: "none",
        boxShadow: active ? "var(--shadow-lg), 0 0 0 1px var(--accent-dim)" : "var(--shadow)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span className="truncate" style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", flex: 1, textDecoration: done ? "line-through" : "none", opacity: done ? 0.5 : 1 }}>{task.title}</span>
        {active && <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: "var(--accent)", letterSpacing: ".1em" }}>NOW</span>}
      </div>
      {h > 46 && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-4)" }}>
          <span style={{ color: e.color }}>{fmtClockRange(task.scheduled!, task.scheduled! + (task.dur || task.focusMin))}</span>
          {proj && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--ink-3)" }}><span style={{ width: 6, height: 6, borderRadius: 2, background: proj.color }} />{proj.name}</span>}
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
      <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)" }}>{fmtClock(start)} – {fmtClock(start + dur)}</span>
    </div>
  );
}

function DayCanvas({ tasks, onStartDrag, onOpen, dragId, previewStart, previewDur, onCanvasRef, justPlacedId }: {
  tasks: Task[];
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource) => void;
  onOpen: (id: string) => void;
  dragId?: string;
  previewStart: number | null;
  previewDur: number;
  onCanvasRef: (el: HTMLDivElement | null) => void;
  justPlacedId: string | null;
}) {
  const totalH = (DAY_END - DAY_START) * PXM;
  const hours: number[] = [];
  for (let m = DAY_START; m <= DAY_END; m += 60) hours.push(m);
  const scheduled = tasks.filter((t) => t.scheduled != null);
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "6px 0 70px" }}>
      <div ref={onCanvasRef} style={{ position: "relative", height: totalH, margin: "0 20px 0 24px" }}>
        {hours.map((m) => (
          <div key={m} style={{ position: "absolute", left: 0, right: 0, top: (m - DAY_START) * PXM }}>
            <span style={{ position: "absolute", left: 0, top: -7, width: 46, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-4)" }}>{fmtClock(m)}</span>
            <div style={{ position: "absolute", left: 54, right: 12, height: 1, background: "var(--hairline)" }} />
          </div>
        ))}
        {hours.slice(0, -1).map((m) => <div key={"h" + m} style={{ position: "absolute", left: 54, right: 12, top: (m + 30 - DAY_START) * PXM, height: 1, background: "var(--hairline)", opacity: 0.4 }} />)}
        {EVENTS.map((ev) => <PlanEventBlock key={ev.id} ev={ev} />)}
        {scheduled.map((t) => <PlanTaskBlock key={t.id} task={t} onStartDrag={onStartDrag} onOpen={onOpen} dragging={dragId === t.id} justPlaced={justPlacedId === t.id} />)}
        <PlanDropPreview start={previewStart} dur={previewDur} />
        <PlanNowLine />
      </div>
    </div>
  );
}

/* ---------- capture ---------- */
function PlanCapture({ onCapture }: { onCapture: (t: Task) => void }) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (text.trim().length > 1 ? parseCapture(text) : null), [text]);
  const submit = () => { const t = parseCapture(text); if (t) { onCapture(t); setText(""); } };
  return (
    <div style={{ position: "relative" }}>
      <div className="glass" style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", borderRadius: 16,
        boxShadow: focused ? "var(--shadow-lg), 0 0 0 4px var(--accent-dim)" : "var(--shadow)", borderColor: focused ? "var(--accent)" : "var(--hairline)" }}>
        <Icon name="sparkles" size={18} style={{ color: focused ? "var(--accent)" : "var(--ink-4)" }} />
        <input ref={ref} value={text} onChange={(e) => setText(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 140)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder="Add anything — “Draft Q3 deck 90m deep work today”"
          style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-display)", fontSize: 15, color: "var(--ink)" }} />
        {text ? <button className="btn btn-accent" style={{ padding: "6px 12px" }} onMouseDown={(e) => { e.preventDefault(); submit(); }}>Add</button>
          : <kbd className="mono" style={{ fontSize: 11, padding: "3px 7px", borderRadius: 7, background: "var(--surface-2)", border: "1px solid var(--hairline)", color: "var(--ink-4)" }}>⌘K</kbd>}
      </div>
      {focused && preview && (
        <div className="glass anim-fadein" style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, right: 0, zIndex: 30, padding: "13px 15px", borderRadius: 16, boxShadow: "var(--shadow-lg)", background: "var(--surface-raised)" }}>
          <div className="kicker" style={{ marginBottom: 9, color: "var(--accent)" }}>Kora understood</div>
          <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 10 }}>{preview.title}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            <span className="pchip"><Icon name="clock" size={12} /> {fmtDurMin(preview.dur!)}</span>
            <EnergyChip energy={preview.energy!} />
            <span className="pchip">Due {fmtDue(preview.dueDate)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- intake ---------- */
function IntakeCard({ task, onStartDrag, onSchedule, onOpen }: {
  task: Task; onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource) => void; onSchedule: (id: string) => void; onOpen: (id: string) => void;
}) {
  const e = ENERGY[task.energy!];
  const overdue = dueState(task.dueDate, task.status) === "overdue" || dueState(task.dueDate, task.status) === "today";
  return (
    <div onPointerDown={(ev) => onStartDrag(ev, task, "intake")} onClick={() => onOpen(task.id)}
      className="glass lift" style={{ padding: "11px 12px 11px 13px", borderRadius: 14, borderLeft: `3px solid ${e.color}`, cursor: "grab", touchAction: "none" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3, flex: 1, color: "var(--ink)" }}>{task.title}</span>
        <button onClick={(ev) => { ev.stopPropagation(); onSchedule(task.id); }} title="Place on day" className="iadd"
          style={{ width: 25, height: 25, borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface-2)", color: "var(--ink-3)", display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0 }}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 7, marginTop: 9 }}>
        <span className="pchip"><Icon name="clock" size={11} /> {fmtDurMin(task.dur || task.focusMin)}</span>
        <EnergyChip energy={task.energy!} small />
        <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: overdue ? "var(--prio-urgent)" : "var(--ink-4)", fontWeight: overdue ? 600 : 400 }}>
          {overdue && <span style={{ width: 5, height: 5, borderRadius: 99, background: "var(--prio-urgent)" }} />}{fmtDue(task.dueDate)}
        </span>
      </div>
    </div>
  );
}

function IntakeRail({ tasks, onStartDrag, onSchedule, onOpen, onAutoPlan, planning, stacked }: {
  tasks: Task[];
  onStartDrag: (ev: ReactPointerEvent, task: Task, source: DragSource) => void;
  onSchedule: (id: string) => void;
  onOpen: (id: string) => void;
  onAutoPlan: () => void;
  planning: boolean;
  stacked?: boolean;
}) {
  const unscheduled = tasks.filter((t) => t.planToday && t.scheduled == null && t.status !== "done");
  const onboarding = tasks.length === 0;
  return (
    <aside style={{ width: stacked ? "100%" : 340, flexShrink: 0, maxHeight: stacked ? "46vh" : undefined, display: "flex", flexDirection: "column", borderLeft: stacked ? "none" : "1px solid var(--hairline)", borderTop: stacked ? "1px solid var(--hairline)" : "none", background: "color-mix(in oklch, var(--bg-deep) 45%, transparent)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}>
      <div style={{ padding: "18px 18px 14px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>Intake</h3>
          <span className="mono tnum" style={{ fontSize: 12, color: "var(--ink-4)", whiteSpace: "nowrap" }}>{unscheduled.length} unplaced</span>
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ink-3)" }}>Drag onto your day, or let Kora plan it.</p>
        <button onClick={onAutoPlan} disabled={planning || unscheduled.length === 0} className="btn btn-accent"
          style={{ width: "100%", justifyContent: "center", marginTop: 13, opacity: unscheduled.length === 0 ? 0.5 : 1 }}>
          <Icon name="sparkles" size={16} /> {planning ? "Planning your day…" : "Auto-plan my day"}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "2px 14px 24px", display: "flex", flexDirection: "column", gap: 9 }}>
        {onboarding ? (
          <div style={{ textAlign: "center", padding: "40px 18px", color: "var(--ink-4)" }}>
            <div style={{ display: "inline-flex", padding: 13, borderRadius: 16, background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 12 }}><Icon name="sparkles" size={22} /></div>
            <p style={{ fontSize: 14, color: "var(--ink)", margin: 0, fontWeight: 600 }}>Welcome to Kora 👋</p>
            <p style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>Capture your first task in the bar above — try <span style={{ color: "var(--ink-2)" }}>“Draft proposal 60m deep work today”</span> — then hit Auto-plan to lay out your day.</p>
          </div>
        ) : unscheduled.length === 0 ? (
          <div style={{ textAlign: "center", padding: "44px 16px", color: "var(--ink-4)" }}>
            <div style={{ display: "inline-flex", padding: 13, borderRadius: 16, background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 12 }}><Icon name="check" size={22} sw={2.4} /></div>
            <p style={{ fontSize: 13.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>Everything's on the day.</p>
            <p style={{ fontSize: 12.5, margin: "4px 0 0" }}>Your plan is set — go do the first thing.</p>
          </div>
        ) : unscheduled.map((t) => <IntakeCard key={t.id} task={t} onStartDrag={onStartDrag} onSchedule={onSchedule} onOpen={onOpen} />)}
      </div>
    </aside>
  );
}

function PlanToast({ msg, onClose }: { msg: string | null; onClose: () => void }) {
  if (!msg) return null;
  return (
    <div className="glass anim-fadeup" style={{ position: "absolute", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 40, maxWidth: 580,
      display: "flex", alignItems: "flex-start", gap: 11, padding: "13px 16px", borderRadius: 16, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
      <Icon name="sparkles" size={17} style={{ color: "var(--accent)", marginTop: 1, flexShrink: 0 }} />
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--ink-2)" }}>{msg}</p>
      <button onClick={onClose} style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", padding: 2, flexShrink: 0 }}><Icon name="x" size={16} /></button>
    </div>
  );
}

/* ---------- the view ---------- */
export function PlanView({ tasks, onUpdate, onCreate, onOpen }: {
  tasks: Task[];
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onCreate: (t: Task) => void;
  onOpen: (id: string) => void;
}) {
  const [planning, setPlanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [justPlacedId, setJustPlaced] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [previewStart, setPreviewStart] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const isMobile = useMediaQuery("(max-width: 860px)");

  const planTasks = tasks.filter((t) => t.planToday);
  const scheduledFocus = planTasks.filter((t) => t.scheduled != null && (t.energy === "deep" || t.energy === "create")).reduce((a, t) => a + (t.dur || t.focusMin), 0);
  const snap = (m: number) => Math.round(m / SNAP) * SNAP;

  const computePreview = useCallback((x: number, y: number, dur: number, grab: number): number | null => {
    const c = canvasRef.current; if (!c) return null;
    const r = c.getBoundingClientRect();
    if (x < r.left - 40 || x > r.right + 40) return null;
    const m = snap(DAY_START + (y - r.top - grab) / PXM);
    return Math.max(DAY_START, Math.min(DAY_END - dur, m));
  }, []);

  const startDrag = useCallback((e: ReactPointerEvent, task: Task, source: DragSource) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    let grab = 16;
    if (source === "canvas") grab = e.clientY - ((task.scheduled! - DAY_START) * PXM + (canvasRef.current?.getBoundingClientRect().top || 0));
    const dur = task.dur || task.focusMin;
    setDrag({ taskId: task.id, dur, title: task.title, energy: task.energy!, source, grab });
    setPointer({ x: e.clientX, y: e.clientY });
    setPreviewStart(computePreview(e.clientX, e.clientY, dur, grab));
  }, [computePreview]);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => { setPointer({ x: e.clientX, y: e.clientY }); setPreviewStart(computePreview(e.clientX, e.clientY, drag.dur, drag.grab)); };
    const up = (e: PointerEvent) => {
      const start = computePreview(e.clientX, e.clientY, drag.dur, drag.grab);
      if (start != null) { onUpdate(drag.taskId, { scheduled: start }); setJustPlaced(drag.taskId); setTimeout(() => setJustPlaced(null), 500); }
      else if (drag.source === "canvas") onUpdate(drag.taskId, { scheduled: null });
      setDrag(null); setPreviewStart(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [drag, computePreview, onUpdate]);

  const scheduleOne = useCallback((id: string) => {
    const cur = tasksRef.current;
    const others = cur.filter((t) => t.scheduled != null && t.id !== id).map((t) => ({ id: "busy-" + t.id, title: t.title, start: t.scheduled!, end: t.scheduled! + (t.dur || t.focusMin), kind: "meeting" as const }));
    const target = cur.find((t) => t.id === id); if (!target) return;
    const placed = planDay([target], [...EVENTS, ...others]);
    if (placed[id] != null) { onUpdate(id, { scheduled: placed[id] }); setJustPlaced(id); setTimeout(() => setJustPlaced(null), 500); }
  }, [onUpdate]);

  const doAutoPlan = useCallback(() => {
    setPlanning(true);
    setTimeout(() => {
      const cur = tasksRef.current.filter((t) => t.planToday && t.status !== "done");
      const placed = planDay(cur, EVENTS);
      const n = Object.keys(placed).length;
      const leftover = cur.filter((t) => t.scheduled == null && placed[t.id] == null).length;
      Object.keys(placed).forEach((id) => onUpdate(id, { scheduled: placed[id] }));
      setPlanning(false);
      setToast(`Planned ${n} task${n === 1 ? "" : "s"} around your meetings — deep work up front, lighter work after lunch.${leftover ? ` ${leftover} didn’t fit today, so I’ll carry ${leftover === 1 ? "it" : "them"} to tomorrow.` : ""}`);
      setTimeout(() => setToast(null), 9000);
    }, 850);
  }, [onUpdate]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        <div style={{ padding: "16px 24px 12px" }}><PlanCapture onCapture={onCreate} /></div>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "0 24px 8px" }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>Your day</h2>
          <span className="mono" style={{ fontSize: 12, color: "var(--ink-4)" }}>{fmtClock(DAY_START)} – {fmtClock(DAY_END)}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-3)", marginLeft: 4 }}><Icon name="zap" size={13} style={{ color: "var(--accent)" }} /> {Math.floor(scheduledFocus / 60)}h {scheduledFocus % 60 ? (scheduledFocus % 60) + "m" : ""} focus planned</span>
          <div style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-3)" }}><span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 6px var(--accent-glow)" }} /> now {fmtClock(NOW_MIN)}</span>
        </div>
        <DayCanvas tasks={planTasks} onStartDrag={startDrag} onOpen={onOpen} dragId={drag?.taskId} previewStart={previewStart} previewDur={drag?.dur || 30} onCanvasRef={(el) => (canvasRef.current = el)} justPlacedId={justPlacedId} />
        <PlanToast msg={toast} onClose={() => setToast(null)} />
        {planning && (
          <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "grid", placeItems: "center", background: "color-mix(in oklch, var(--bg) 35%, transparent)", backdropFilter: "blur(2px)" }}>
            <div className="glass anim-scalein" style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 22px", borderRadius: 16, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
              <Icon name="sparkles" size={20} style={{ color: "var(--accent)" }} />
              <span className="ai-think" style={{ fontSize: 15, fontWeight: 600 }}>Kora is planning your day…</span>
            </div>
          </div>
        )}
      </div>
      <IntakeRail tasks={tasks} onStartDrag={startDrag} onSchedule={scheduleOne} onOpen={onOpen} onAutoPlan={doAutoPlan} planning={planning} stacked={isMobile} />
      {drag && (
        <div style={{ position: "fixed", left: pointer.x + 14, top: pointer.y - 10, zIndex: 80, pointerEvents: "none", maxWidth: 240,
          padding: "8px 12px", borderRadius: 12, background: "var(--surface-raised)", border: "1px solid var(--hairline-strong)", borderLeft: `3px solid ${ENERGY[drag.energy].color}`, boxShadow: "var(--shadow-lg)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", transform: "rotate(-1.5deg)" }}>
          <span className="truncate" style={{ fontSize: 13, fontWeight: 600, display: "block" }}>{drag.title}</span>
        </div>
      )}
    </div>
  );
}
