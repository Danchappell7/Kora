/* ============================================================
   KANBO — Today › Week: plan the week, clear what slipped.
   Seven equal days, Monday first. Drag a task onto a day (or use its
   "Move to…" menu from the keyboard) to give it that due date; what's
   overdue and what has no date wait underneath. The header counts this
   week's wins against a seven-day sparkline.
   ============================================================ */
import {
  useCallback, useEffect, useId, useRef, useState,
  type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject,
} from "react";
import { Button, Icon, SectionLabel, StatusGlyph, projectPaint } from "../primitives";
import { Popover } from "../primitives/Popover";
import { getProject, KANBO_TODAY } from "../../data/data";
import type { Task } from "../../data/types";
import { useEntrance } from "../../hooks/useEntrance";
import { useToast } from "../Toast";
import { useAuth } from "../../auth/AuthProvider";
import { dayLong, dayMonth, weekdayShort } from "./planCanvas";

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const CONFIRM_OVER = 3;
const DRAG_TYPE = "application/x-kanbo-task";
const LONG_PRESS_MS = 300;
const TOUCH_SLOP = 8;
const FULL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// both providers always wrap the app; tolerate their absence in isolated renders
function useOptionalToast() { try { return useToast(); } catch { return null; } }
function useAuthUserId(): string | undefined { try { return useAuth().user?.id; } catch { return undefined; } }

const WEEK_CSS = `
.kweek {
  --kw-e1: var(--e1, 0 0 0 1px var(--hairline), 0 1px 2px oklch(0.2 0.03 268 / 0.06));
  --kw-e2: var(--e2, 0 0 0 1px var(--hairline-strong), 0 12px 32px -12px oklch(0.2 0.03 268 / 0.28));
  --kw-ui: var(--font-ui, var(--font-display));
  --kw-accent-tint: var(--accent-tint, var(--accent-dim));
  --kw-accent-line: var(--accent-line, color-mix(in oklch, var(--accent) 45%, transparent));
  flex: 1; min-height: 0; overflow-y: auto; padding: 20px var(--gutter, 32px) 48px;
}
.kweek-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; min-height: 40px; margin-bottom: 16px; }
.kweek-title { margin: 0; font: 600 14px/20px var(--kw-ui); color: var(--ink); }
.kweek-stat { font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-2); white-space: nowrap; }
.kweek-trend { font: 500 12px/16px var(--kw-ui); color: var(--ink-3); white-space: nowrap; }
.kweek-trend[data-tone="up"] { color: var(--ok, var(--st-done)); }
.kweek-spark { display: block; flex-shrink: 0; }
.kweek-range { font: 500 11px/16px var(--font-mono); color: var(--ink-4); white-space: nowrap; }
.kweek-head-end { margin-left: auto; display: flex; align-items: center; gap: 8px; }

/* seven equal days while they fit at 132px (1280 wide, even with the sidebar); the
   box is measured, not the window, so a docked task panel wraps the days too */
.kweek-days { container-type: inline-size; }
.kweek-grid { display: grid; grid-template-columns: repeat(7, minmax(132px, 1fr)); gap: 8px; }
.kweek-day { display: flex; flex-direction: column; min-width: 0; min-height: 220px; padding: 0 6px 8px; border-radius: var(--r-md, 8px);
  background: var(--bg-deep); transition: box-shadow var(--d-1, 90ms) var(--ease), background var(--d-1, 90ms) var(--ease); }
.kweek-day[data-drop="true"] { background: color-mix(in oklch, var(--accent) 8%, var(--bg-deep)); box-shadow: inset 0 0 0 1.5px var(--kw-accent-line); }
.kweek-day-head { display: flex; align-items: baseline; gap: 6px; height: 36px; padding: 10px 4px 0; }
.kweek-day-name { position: relative; font: 600 12px/16px var(--kw-ui); color: var(--ink-2); }
.kweek-day-date { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-4); }
.kweek-day-count { margin-left: auto; font: 500 11px/16px var(--font-mono); color: var(--ink-4); }
.kweek-day[data-today="true"] .kweek-day-name { color: var(--accent-text, var(--accent)); }
.kweek-day[data-today="true"] .kweek-day-name::after { content: ""; position: absolute; left: 0; right: 0; bottom: -5px; height: 2px; border-radius: 2px; background: var(--accent); }
.kweek-day[data-weekend="true"]:not([data-today="true"]) .kweek-day-name { color: var(--ink-3); }
.kweek-day[data-past="true"] .kweek-day-name { color: var(--ink-3); }
.kweek-day-list { display: flex; flex-direction: column; gap: 6px; flex: 1; }
.kweek-empty { flex: 1; display: grid; place-items: center; min-height: 64px; border-radius: var(--r-sm, 6px); font: 500 12px/16px var(--kw-ui); color: var(--ink-4); }
.kweek-day[data-drop="true"] .kweek-empty { color: var(--accent-text, var(--accent)); }

.kweek-chip { position: relative; display: flex; align-items: flex-start; gap: 6px; min-width: 0; padding: 6px 8px 6px 9px;
  border-radius: var(--r-sm, 6px); background: var(--surface-raised); box-shadow: var(--kw-e1); cursor: grab;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: pan-y;
  transition: box-shadow var(--d-1, 90ms) var(--ease), opacity var(--d-2, 160ms) var(--ease); }
.kweek-chip:hover { box-shadow: var(--kw-e2); }
/* the project's colour, as an edge (never a fill) */
.kweek-chip::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px; border-radius: 0 2px 2px 0; background: var(--edge, transparent); }
.kweek-chip[data-dragging="true"] { opacity: 0.4; }
.kweek-chip[data-ring="true"] { box-shadow: 0 0 0 2px var(--accent), var(--kw-e2); }
.kweek-chip .kglyph { margin-top: -2px; }
.kweek-chip-open { flex: 1; min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: inherit; outline: none; }
.kweek-chip-open::after { content: ""; position: absolute; inset: 0; }
.kweek-chip-title { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere;
  font: 500 13px/18px var(--kw-ui); color: var(--ink); }
.kweek-chip[data-done="true"] .kweek-chip-title { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-4); }
/* "Move to…" floats over the title's end on hover, so the title keeps the width */
.kweek-more.kibtn { position: absolute; z-index: 1; top: 3px; right: 3px; width: 24px; height: 24px; opacity: 0;
  background: var(--surface-raised); box-shadow: -8px 0 8px -2px var(--surface-raised); transition: opacity var(--d-1, 90ms) var(--ease); }
.kweek-more.kibtn:hover { background: linear-gradient(var(--fill-1), var(--fill-1)), var(--surface-raised); }
.kweek-chip:hover .kweek-more, .kweek-chip:focus-within .kweek-more, .kweek-more[aria-expanded="true"] { opacity: 1; }

.kweek-section { margin-top: 28px; }
.kweek-section-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.kweek-section-head .ksection { flex: 1; }
.kweek-chips { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px; }
.kweek-note { margin: -4px 0 8px; font: 400 12px/16px var(--kw-ui); color: var(--ink-3); }

.kweek-float { position: fixed; z-index: 80; max-width: 220px; padding: 6px 10px; pointer-events: none; border-radius: var(--r-sm, 6px);
  background: var(--surface-raised); box-shadow: var(--kw-e2); font: 500 13px/18px var(--kw-ui); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* the menu is portalled out of .kweek: only global tokens in here */
.kweek-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 10px 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); cursor: pointer; text-align: left; white-space: nowrap;
  transition: background var(--d-1, 90ms) var(--ease); }
.kweek-menu-item:hover, .kweek-menu-item:focus-visible { background: var(--fill-1); color: var(--ink); }
.kweek-menu-item > svg { flex-shrink: 0; color: var(--accent-text, var(--accent)); }
.kweek-menu-item[aria-checked="false"] > svg { visibility: hidden; }
.kweek-menu-item .mono { margin-left: auto; padding-left: 16px; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kweek-menu-label { padding: 6px 8px 4px 32px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }

@container (max-width: 971px) { .kweek-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); } }
@media (max-width: 859px) {
  .kweek { padding: 16px 16px 32px; }
  .kweek-grid { grid-template-columns: 1fr; }
  .kweek-day { min-height: 0; }
  .kweek-empty { min-height: 36px; place-items: center start; padding-left: 4px; }
  .kweek-chip { padding-right: 40px; }
  .kweek-more.kibtn { opacity: 1; width: 32px; height: 32px; top: 50%; translate: 0 -50%; box-shadow: none; }
}
@media (hover: none) { .kweek-chip { padding-right: 32px; } .kweek-more.kibtn { opacity: 1; box-shadow: none; } }
@media (prefers-reduced-motion: reduce) { .kweek-day, .kweek-chip, .kweek-more.kibtn, .kweek-menu-item { transition: none; } }
`;

/** A seven-day completions sparkline: a gradient area under a hairline of ink. */
function Spark({ data, labels }: { data: number[]; labels: string[] }) {
  const gid = "kws" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const w = 120, h = 28, pad = 3;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => [(i / Math.max(1, data.length - 1)) * w, h - pad - (v / max) * (h - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg className="kweek-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img"
      aria-label={`Completed over the last seven days: ${data.map((v, i) => `${labels[i]} ${v}`).join(", ")}`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--brand-blue, #5B7CFA)" />
          <stop offset="0.52" stopColor="var(--brand-violet, #8B5CF6)" />
          <stop offset="1" stopColor="var(--brand-magenta, #C24BE0)" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={`url(#${gid})`} opacity={0.28} />
      <path d={line} fill="none" stroke={`url(#${gid})`} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      {pts.length > 0 && <circle cx={pts[pts.length - 1][0] - 1.5} cy={pts[pts.length - 1][1]} r={2.5} fill="var(--brand-magenta, #C24BE0)" />}
    </svg>
  );
}

interface Target { iso: string; label: string; hint: string }

function MoveMenu({ task, targets, anchorRef, open, onClose, onMove }: {
  task: Task; targets: Target[]; anchorRef: RefObject<HTMLElement>; open: boolean; onClose: () => void; onMove: (id: string, iso: string) => void;
}) {
  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} label={`Move “${task.title}” to`} minWidth={200}>
      <div className="kweek-menu-label" role="presentation">Move to…</div>
      {targets.map((t) => (
        <button key={t.label} type="button" role="menuitemradio" aria-checked={task.dueDate === t.iso} className="kweek-menu-item"
          onClick={() => { onClose(); onMove(task.id, t.iso); }}>
          <Icon name="check" size={16} sw={2} />{t.label}<span className="mono">{t.hint}</span>
        </button>
      ))}
    </Popover>
  );
}

function TaskChip({ t, targets, dragging, onOpen, onMove, onDragStart, onDragEnd, onTouchDrag }: {
  t: Task; targets: Target[]; dragging?: boolean;
  onOpen: (id: string) => void;
  onMove?: (id: string, iso: string) => void;
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
  onTouchDrag?: (e: ReactPointerEvent, t: Task) => void;
}) {
  const proj = getProject(t.projectId);
  const [menu, setMenu] = useState(false);
  const [ring, setRing] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const movable = !!onMove && t.status !== "done";
  const onKey = (e: ReactKeyboardEvent) => {
    // the context-menu key or Shift+F10 opens "Move to…", as a right-click would
    if (movable && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) { e.preventDefault(); setMenu(true); }
  };
  return (
    <div className="kweek-chip" data-task-id={t.id} data-dragging={dragging || undefined} data-ring={ring || undefined} data-done={t.status === "done" || undefined}
      title={proj?.name} style={proj ? { "--edge": projectPaint(proj.color).solid } as CSSProperties : undefined}
      draggable={movable || undefined}
      onDragStart={movable ? (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(DRAG_TYPE, t.id);
        e.dataTransfer.setData("text/plain", t.title);
        onDragStart?.(t.id);
      } : undefined}
      onDragEnd={movable ? () => onDragEnd?.() : undefined}
      onPointerDown={movable && onTouchDrag ? (e) => { if (e.pointerType === "touch") onTouchDrag(e, t); } : undefined}
      onContextMenu={movable ? (e) => { e.preventDefault(); setMenu(true); } : undefined}>
      <StatusGlyph status={t.status} size={14} readOnly />
      <button type="button" className="kweek-chip-open" onClick={() => onOpen(t.id)} onKeyDown={onKey}
        onFocus={(e) => { let v = true; try { v = e.currentTarget.matches(":focus-visible"); } catch { /* older engines */ } setRing(v); }} onBlur={() => setRing(false)}
        aria-label={t.title} aria-keyshortcuts={movable ? "Shift+F10" : undefined}>
        <span className="kweek-chip-title">{t.title}</span>
      </button>
      {movable && (
        <button ref={moreRef} type="button" className="kibtn kweek-more" data-size="sm" aria-haspopup="menu" aria-expanded={menu}
          aria-label={`Move “${t.title}” to another day`} title="Move to…" onClick={() => setMenu((m) => !m)}>
          <Icon name="more" size={16} sw={1.75} />
        </button>
      )}
      {movable && <MoveMenu task={t} targets={targets} anchorRef={moreRef} open={menu} onClose={() => setMenu(false)} onMove={onMove!} />}
    </div>
  );
}

/* a chip grid that shows the first `limit` and lets you expand the rest */
function ChipGrid({ tasks, limit, label, chip }: { tasks: Task[]; limit: number; label: string; chip: (t: Task) => JSX.Element }) {
  const [all, setAll] = useState(false);
  const shown = all ? tasks : tasks.slice(0, limit);
  const hidden = tasks.length - shown.length;
  return (
    <>
      <div className="kweek-chips">{shown.map(chip)}</div>
      {(hidden > 0 || (all && tasks.length > limit)) && (
        <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all} style={{ marginTop: 8 }}
          aria-label={all ? `Show fewer ${label}` : `Show all ${tasks.length} ${label}`}>
          {all ? "Show fewer" : `Show all ${tasks.length}`}
        </Button>
      )}
    </>
  );
}

export function MyWeekView({ tasks, onOpen, onPatch, currentUserId, readOnly }: {
  tasks: Task[];
  onOpen: (id: string) => void;
  onPatch: (id: string, patch: Partial<Task>) => void;
  /** the signed-in user — "Pull to today" only moves tasks assigned to them (defaults to the auth user) */
  currentUserId?: string;
  /** guests: nothing moves */
  readOnly?: boolean;
}) {
  const entrance = useEntrance();
  const toast = useOptionalToast();
  const authUserId = useAuthUserId();
  const me = currentUserId ?? authUserId;
  const today = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate());
  const todayIso = isoOf(today);
  const dow = (today.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(today); monday.setDate(today.getDate() - dow);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  const weekIsos = days.map(isoOf);
  const nextMonday = new Date(monday); nextMonday.setDate(monday.getDate() + 7);
  const open = tasks.filter((t) => t.status !== "done" && !t.archivedAt && !t.parentId);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < todayIso);
  // only reschedule work you own — tasks you merely collaborate on keep their owner's dates
  const myOverdue = me ? overdue.filter((t) => t.assigneeId === me) : overdue;
  const othersOverdue = overdue.length - myOverdue.length;
  const noDate = open.filter((t) => !t.dueDate);
  const doneOn = (iso: string) => tasks.filter((t) => t.status === "done" && t.completedAt?.slice(0, 10) === iso).length;
  const completedThisWeek = tasks.filter((t) => t.status === "done" && t.completedAt && weekIsos.includes(t.completedAt.slice(0, 10)));
  const doneThisWeek = completedThisWeek.length;
  // week-over-week: how many I finished last week, for a trend read
  const lastWeekIsos = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() - 7 + i); return isoOf(d); });
  const doneLastWeek = tasks.filter((t) => t.status === "done" && t.completedAt && lastWeekIsos.includes(t.completedAt.slice(0, 10))).length;
  const trend = doneThisWeek - doneLastWeek;
  const trendLabel = doneLastWeek === 0 ? (doneThisWeek > 0 ? "first wins this week" : "nothing yet") : `${trend >= 0 ? "+" : ""}${trend} vs last week`;
  // the last seven days, ending today (the sparkline Home used to show)
  const last7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(today); d.setDate(today.getDate() - 6 + i); return d; });
  const sparkData = last7.map((d) => doneOn(isoOf(d)));

  const targets: Target[] = [
    ...days.map((d, i) => ({ iso: weekIsos[i], label: weekIsos[i] === todayIso ? "Today" : FULL_DAYS[d.getDay()], hint: dayMonth(d) })),
    { iso: isoOf(nextMonday), label: "Next week", hint: `Mon ${dayMonth(nextMonday)}` },
  ];

  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const moveTo = useCallback((id: string, iso: string) => {
    const t = tasksRef.current.find((x) => x.id === id);
    if (!t || t.dueDate === iso) return;
    const prev = t.dueDate;
    onPatch(id, { dueDate: iso });
    const d = new Date(iso + "T00:00:00");
    const msg = `Moved “${t.title}” to ${iso === todayIso ? "today" : dayLong(d)}`;
    if (toast) toast.action(msg, "Undo", () => onPatch(id, { dueDate: prev }), { ms: 10000 });
  }, [onPatch, toast, todayIso]);

  const pullToToday = () => {
    const moving = myOverdue.map((t) => ({ id: t.id, dueDate: t.dueDate }));
    const n = moving.length;
    if (n === 0) return;
    if (n > CONFIRM_OVER && !window.confirm(`Move ${n} overdue tasks to today? Their due dates will change to today.`)) return;
    moving.forEach((m) => onPatch(m.id, { dueDate: todayIso }));
    const msg = `Moved ${n} overdue task${n === 1 ? "" : "s"} to today`;
    const undo = () => moving.forEach((m) => onPatch(m.id, { dueDate: m.dueDate }));
    if (toast) toast.action(msg, "Undo", undo, 8000);
  };

  /* ----- dragging a chip onto a day: HTML5 drag for mouse, a long-press for touch ----- */
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const [touch, setTouch] = useState<{ id: string; title: string; x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const touchActive = useRef(false);
  useEffect(() => {
    const el = rootRef.current; if (!el) return;
    const onTouchMove = (e: TouchEvent) => { if (touchActive.current && e.cancelable) e.preventDefault(); };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, []);
  const dayAt = (x: number, y: number): string | null =>
    (document.elementFromPoint?.(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-day]")?.dataset.day ?? null;
  const startTouch = useCallback((e: ReactPointerEvent, t: Task) => {
    const pid = e.pointerId, x0 = e.clientX, y0 = e.clientY;
    let live = false, over: string | null = null;
    const timer = window.setTimeout(() => {
      live = true; touchActive.current = true;
      try { navigator.vibrate?.(8); } catch { /* unsupported */ }
      setDragId(t.id); setTouch({ id: t.id, title: t.title, x: x0, y: y0 });
    }, LONG_PRESS_MS);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      if (!live) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > TOUCH_SLOP) end(); return; }
      over = dayAt(ev.clientX, ev.clientY);
      setOverDay(over);
      setTouch((s) => (s ? { ...s, x: ev.clientX, y: ev.clientY } : s));
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId !== pid) return; if (live && over) moveTo(t.id, over); end(); };
    const end = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      touchActive.current = false;
      setDragId(null); setOverDay(null); setTouch(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
  }, [moveTo]);

  const canMove = !readOnly;
  const chip = (t: Task) => (
    <TaskChip key={t.id} t={t} targets={targets} dragging={dragId === t.id} onOpen={onOpen}
      onMove={canMove ? moveTo : undefined} onDragStart={setDragId} onDragEnd={() => { setDragId(null); setOverDay(null); }}
      onTouchDrag={canMove ? startTouch : undefined} />
  );
  const dropProps = (iso: string) => canMove ? {
    onDragOver: (e: ReactDragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      if (overDay !== iso) setOverDay(iso);
    },
    onDragLeave: (e: ReactDragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverDay((d) => (d === iso ? null : d)); },
    onDrop: (e: ReactDragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      e.preventDefault(); setOverDay(null); setDragId(null);
      if (id) moveTo(id, iso);
    },
  } : {};

  const rangeLabel = `${dayMonth(days[0])} – ${dayMonth(days[6])}`;
  return (
    <div ref={rootRef} className="kweek">
      <style>{WEEK_CSS}</style>
      <div className="kweek-head">
        <h2 className="kweek-title">This week</h2>
        <span className="kweek-range">{rangeLabel}</span>
        <span className="kweek-stat">{doneThisWeek} done</span>
        <span className="kweek-trend" data-tone={trend > 0 && doneLastWeek > 0 ? "up" : undefined}>{trendLabel}</span>
        <Spark data={sparkData} labels={last7.map((d) => weekdayShort(d))} />
        <div className="kweek-head-end">
          {myOverdue.length > 0 && !readOnly && (
            <Button variant="secondary" size="sm" icon="arrowRight" onClick={pullToToday}
              title={othersOverdue > 0 ? `Moves the ${myOverdue.length} assigned to you; ${othersOverdue} you collaborate on keep their dates` : "Change their due dates to today"}>
              {othersOverdue > 0 ? `Pull my ${myOverdue.length} to today` : "Pull all to today"}
            </Button>
          )}
        </div>
      </div>

      <div className="kweek-days">
        <div className={"kweek-grid " + entrance}>
          {days.map((d, i) => {
            const iso = weekIsos[i];
            const items = open.filter((t) => t.dueDate === iso);
            const isToday = iso === todayIso;
            const nameId = `kw-${iso}`;
            return (
              <section key={iso} className="kweek-day" data-day={iso} data-today={isToday || undefined} data-past={iso < todayIso || undefined}
                data-weekend={i >= 5 || undefined} data-drop={overDay === iso || undefined} aria-labelledby={nameId} {...dropProps(iso)}>
                <h3 className="kweek-day-head" id={nameId} aria-label={`${FULL_DAYS[d.getDay()]} ${dayMonth(d)}${isToday ? ", today" : ""}`}>
                  <span className="kweek-day-name">{weekdayShort(d)}</span>
                  <span className="kweek-day-date">{d.getDate()}</span>
                  {items.length > 0 && <span className="kweek-day-count">{items.length}</span>}
                </h3>
                <div className="kweek-day-list">
                  {items.map(chip)}
                  {items.length === 0 && <div className="kweek-empty" aria-hidden="true">{overDay === iso ? "Drop here" : dragId ? "" : "—"}</div>}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {overdue.length > 0 && (
        <section className="kweek-section" aria-labelledby="kw-carried">
          <div className="kweek-section-head"><SectionLabel id="kw-carried" tone="signal" count={overdue.length}>Carried over</SectionLabel></div>
          <ChipGrid tasks={overdue} limit={12} label="overdue tasks" chip={chip} />
        </section>
      )}

      {noDate.length > 0 && (
        <section className="kweek-section" aria-labelledby="kw-nodate">
          <div className="kweek-section-head"><SectionLabel id="kw-nodate" count={noDate.length}>No date</SectionLabel></div>
          {!readOnly && <p className="kweek-note">Drag one onto a day to schedule it.</p>}
          <ChipGrid tasks={noDate} limit={18} label="unscheduled tasks" chip={chip} />
        </section>
      )}

      {completedThisWeek.length > 0 && (
        <section className="kweek-section" aria-labelledby="kw-wins">
          <div className="kweek-section-head"><SectionLabel id="kw-wins" count={completedThisWeek.length}>This week's wins</SectionLabel></div>
          <ChipGrid tasks={completedThisWeek} limit={8} label="completed tasks" chip={chip} />
        </section>
      )}

      {touch && (
        <div aria-hidden="true" className="kweek-float" style={{ left: touch.x - 24, top: touch.y - 52 } as CSSProperties}>{touch.title}</div>
      )}
    </div>
  );
}
