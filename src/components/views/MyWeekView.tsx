/* ============================================================
   KANBO — Today › Week: plan the week, clear what slipped.
   Seven equal days, Monday first. Drag a task onto a day to give it
   that due date, or onto the day's time strip (its left edge, there
   while a task is in the air) to give it a time too; "No date" takes
   the date off. Drags run on lib/dnd, so a task from the Inbox, My
   tasks or a board lands here the same way. From the keyboard, a
   chip's "Move to…" menu (Shift+F10) lists the days, and S opens
   "Schedule…" (a day and a time). What's overdue and what has no date
   wait underneath. The header counts this week's wins against a
   seven-day sparkline.
   ============================================================ */
import {
  Suspense, memo, useCallback, useId, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject,
} from "react";
import { Button, Icon, SectionLabel, StatusGlyph, projectPaint } from "../primitives";
import { Popover } from "../primitives/Popover";
import { getProject, KANBO_TODAY } from "../../data/data";
import type { Task } from "../../data/types";
import { useEntrance } from "../../hooks/useEntrance";
import { useToast } from "../Toast";
import { useAuth } from "../../auth/AuthProvider";
import { dayLong, dayMonth, durOf, weekdayShort } from "./planCanvas";
import { useTaskDragSource, useTaskDropTarget, useDropTargets, type TaskDragPayload, type TaskDropEvent } from "../../lib/dnd";
import { ScheduleMenu, MoveToMenu, prefetchPlanMenus } from "../dnd/lazy";
import { WEEK_SLOT_FROM, WEEK_SLOT_TO, WEEK_SLOT_STEP, hhmm, minuteOf, stripMinute, stripY, undoPatch, weekPatch } from "../dnd/weekSlots";

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const CONFIRM_OVER = 3;
const FULL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** the strip's hour marks */
const STRIP_HOURS = [9, 12, 15, 18];

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

/* seven equal days while they fit (1280 wide beside the sidebar, with room to spare for
   a classic scrollbar); the box is measured, not the window, so a docked task panel
   folds the week too: four and three, then pairs, never an orphaned Sunday */
.kweek-days { container-type: inline-size; }
.kweek-grid { display: grid; grid-template-columns: repeat(7, minmax(128px, 1fr)); gap: 8px; }
.kweek-day { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 220px; padding: 0 6px 8px; border-radius: var(--r-md, 8px);
  background: var(--bg-deep); transition: box-shadow var(--d-1, 90ms) var(--ease), background var(--d-1, 90ms) var(--ease); }
/* a task in the air that can land here: every day says so quietly; the one under it, clearly */
.kweek-day[data-can="true"] { box-shadow: inset 0 0 0 1px var(--hairline-strong); }
.kweek-day[data-drop="true"] { background: color-mix(in oklch, var(--accent) 8%, var(--bg-deep)); box-shadow: inset 0 0 0 1.5px var(--kw-accent-line); }
/* the day's time strip: its left edge, there while a task is in the air; over it, the time it would get */
.kweek-times { position: absolute; z-index: 2; left: 0; top: 36px; bottom: 8px; width: 8px; border-radius: 0 6px 6px 0; opacity: 0; pointer-events: none;
  transition: opacity var(--d-1, 90ms) var(--ease), background var(--d-1, 90ms) var(--ease), width var(--d-1, 90ms) var(--ease); }
.kweek-times[data-open="true"] { opacity: 1; pointer-events: auto; background: color-mix(in oklch, var(--accent) 6%, transparent); }
/* the day under the pointer: its strip opens out; over the strip, the day's chips step back so the hours read */
.kweek-times[data-open="true"][data-near="true"] { width: 18px; background: color-mix(in oklch, var(--accent) 10%, transparent); box-shadow: inset -1px 0 0 var(--kw-accent-line); }
.kweek-times[data-over="true"] { background: var(--kw-accent-tint); }
.kweek-day[data-timing="true"] .kweek-day-list { opacity: 0.3; }
.kweek-times > i { position: absolute; left: 3px; right: 3px; height: 1px; background: var(--hairline-strong); }
.kweek-times > i > b { position: absolute; left: 18px; top: -8px; padding: 0 3px; border-radius: 3px; display: none; white-space: nowrap;
  background: var(--bg-deep); font: 500 10px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-4); }
.kweek-times[data-over="true"] > i > b { display: block; }
.kweek-mark { position: absolute; z-index: 3; left: 0; right: 6px; height: 0; border-top: 1.5px dashed var(--accent); pointer-events: none; }
.kweek-mark > span { position: absolute; left: 20px; top: -10px; padding: 0 6px; border-radius: var(--r-xs, 4px); background: var(--accent);
  font: 600 11px/18px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--on-accent, #fff); box-shadow: var(--kw-e1); }
.kweek-nodrop { display: grid; place-items: center; min-height: 48px; border-radius: var(--r-sm, 6px); border: 1px dashed var(--hairline-strong);
  font: 500 12px/16px var(--kw-ui); color: var(--ink-3); }
.kweek-nodate[data-drop="true"] .kweek-nodrop, .kweek-nodate[data-drop="true"] .kweek-chips { border-color: var(--accent); color: var(--accent-text, var(--accent)); }
.kweek-nodate { border-radius: var(--r-md, 8px); transition: box-shadow var(--d-1, 90ms) var(--ease); }
.kweek-nodate[data-drop="true"] { box-shadow: 0 0 0 6px color-mix(in oklch, var(--accent) 8%, transparent), 0 0 0 7px var(--kw-accent-line); }
.kweek-day-head { display: flex; align-items: baseline; gap: 6px; height: 36px; padding: 10px 4px 0; }
.kweek-day-name { position: relative; font: 600 12px/16px var(--kw-ui); color: var(--ink-2); }
.kweek-day-date { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-4); }
.kweek-day-count { margin-left: auto; font: 500 11px/16px var(--font-mono); color: var(--ink-4); }
.kweek-day[data-today="true"] .kweek-day-name { color: var(--accent-text, var(--accent)); }
.kweek-day[data-today="true"] .kweek-day-name::after { content: ""; position: absolute; left: 0; right: 0; bottom: -5px; height: 2px; border-radius: 2px; background: var(--accent); }
.kweek-day[data-weekend="true"]:not([data-today="true"]) .kweek-day-name { color: var(--ink-3); }
.kweek-day[data-past="true"] .kweek-day-name { color: var(--ink-3); }
.kweek-day-list { display: flex; flex-direction: column; gap: 6px; flex: 1; transition: opacity var(--d-1, 90ms) var(--ease); }
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
.kweek-chip-time { flex-shrink: 0; font: 500 11px/18px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
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

@container (max-width: 943px) { .kweek-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@container (max-width: 559px) { .kweek-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 859px) {
  /* one column on a phone: a day is too short for a time strip (Schedule… sets the time) */
  .kweek-times, .kweek-mark { display: none; }
  .kweek { padding: 16px 16px 32px; }
  .kweek-grid { grid-template-columns: 1fr; }
  .kweek-day { min-height: 0; }
  .kweek-empty { min-height: 36px; place-items: center start; padding-left: 4px; }
  .kweek-chip { padding-right: 40px; }
  .kweek-more.kibtn { opacity: 1; width: 32px; height: 32px; top: 50%; translate: 0 -50%; box-shadow: none; }
}
@media (hover: none) { .kweek-chip { padding-right: 32px; } .kweek-more.kibtn { opacity: 1; box-shadow: none; } }
@media (prefers-reduced-motion: reduce) { .kweek-day, .kweek-chip, .kweek-more.kibtn, .kweek-menu-item, .kweek-times, .kweek-nodate, .kweek-day-list { transition: none; } }
`;

/** A seven-day completions sparkline: a gradient area under a hairline of ink. */
function Spark({ data, labels }: { data: number[]; labels: string[] }) {
  const gid = "kws" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const w = 120, h = 28, pad = 3;
  const label = `Completed over the last seven days: ${data.map((v, i) => `${labels[i]} ${v}`).join(", ")}`;
  // a quiet week is a flat track, not a gradient line with nothing to say
  if (data.every((v) => v === 0)) {
    return (
      <svg className="kweek-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
        <line x1={1} x2={w - 1} y1={h - pad} y2={h - pad} stroke="var(--track, var(--fill-2))" strokeWidth={2} strokeLinecap="round" />
      </svg>
    );
  }
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => [(i / Math.max(1, data.length - 1)) * w, h - pad - (v / max) * (h - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg className="kweek-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
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

function MoveMenu({ task, targets, anchorRef, open, onClose, onMove, onPickTime, onElsewhere }: {
  task: Task; targets: Target[]; anchorRef: RefObject<HTMLElement>; open: boolean; onClose: () => void; onMove: (id: string, iso: string) => void;
  /** "Pick a time…": Schedule… (a day and a time) */
  onPickTime: () => void;
  /** "Somewhere else…": the projects and people on screen (lib/dnd's targets), when there are any */
  onElsewhere?: () => void;
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
      <hr />
      <button type="button" role="menuitem" className="kweek-menu-item" aria-keyshortcuts="S" onPointerEnter={prefetchPlanMenus} onFocus={prefetchPlanMenus}
        onClick={() => { onClose(); onPickTime(); }}>
        <Icon name="clock" size={16} sw={1.75} />Pick a day and time…<span className="mono">S</span>
      </button>
      {onElsewhere && (
        <button type="button" role="menuitem" className="kweek-menu-item" onPointerEnter={prefetchPlanMenus} onFocus={prefetchPlanMenus}
          onClick={() => { onClose(); onElsewhere(); }}>
          <Icon name="arrowUpRight" size={16} sw={1.75} />A project or person…
        </button>
      )}
    </Popover>
  );
}

// (memo: a day re-renders as a drag moves down its time strip; its chips needn't)
const TaskChip = memo(function TaskChip({ t, targets, onOpen, onMove, onSchedule, onElsewhere, showTime }: {
  t: Task; targets: Target[];
  onOpen: (id: string) => void;
  onMove?: (id: string, iso: string) => void;
  /** Schedule… (S): a day and a time */
  onSchedule?: (t: Task, anchor: HTMLElement) => void;
  /** Move to a project or person on screen */
  onElsewhere?: (t: Task, anchor: HTMLElement) => void;
  /** a day's chips say their time */
  showTime?: boolean;
}) {
  const proj = getProject(t.projectId);
  const [menu, setMenu] = useState(false);
  const [ring, setRing] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const movable = !!onMove && t.status !== "done";
  const src = useTaskDragSource({ taskIds: [t.id], source: "week", originId: t.id, label: t.title, disabled: !movable,
    meta: proj ? { edge: projectPaint(proj.color).solid } : undefined });
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!movable || e.metaKey || e.ctrlKey || e.altKey) return;
    // the context-menu key or Shift+F10 opens "Move to…", as a right-click would; S opens Schedule…
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); setMenu(true); }
    else if ((e.key === "s" || e.key === "S") && !e.shiftKey && onSchedule) { e.preventDefault(); e.stopPropagation(); onSchedule(t, e.currentTarget); }
  };
  const time = showTime ? minuteOf(t.dueTime) : null;
  return (
    <div {...src.bind} className="kweek-chip" data-task-id={t.id} data-dragging={src.isDragging || undefined} data-ring={ring || undefined} data-done={t.status === "done" || undefined}
      title={proj?.name} style={proj ? { "--edge": projectPaint(proj.color).solid } as CSSProperties : undefined}
      onContextMenu={movable ? (e) => { e.preventDefault(); setMenu(true); } : undefined}>
      <StatusGlyph status={t.status} size={14} readOnly />
      {time != null && <span className="kweek-chip-time" aria-hidden="true">{hhmm(time)}</span>}
      <button type="button" className="kweek-chip-open" onClick={() => onOpen(t.id)} onKeyDown={onKey}
        onFocus={(e) => { let v = true; try { v = e.currentTarget.matches(":focus-visible"); } catch { /* older engines */ } setRing(v); }} onBlur={() => setRing(false)}
        aria-label={time != null ? `${t.title}, ${hhmm(time)}` : t.title} aria-keyshortcuts={movable ? "Shift+F10 S" : undefined}>
        <span className="kweek-chip-title">{t.title}</span>
      </button>
      {movable && (
        <button ref={moreRef} type="button" className="kibtn kweek-more" data-size="sm" aria-haspopup="menu" aria-expanded={menu}
          aria-label={`Move “${t.title}” to another day`} title="Move to…" onClick={() => setMenu((m) => !m)}>
          <Icon name="more" size={16} sw={1.75} />
        </button>
      )}
      {movable && (
        <MoveMenu task={t} targets={targets} anchorRef={moreRef} open={menu} onClose={() => setMenu(false)} onMove={onMove!}
          onPickTime={() => moreRef.current && onSchedule?.(t, moreRef.current)}
          onElsewhere={onElsewhere ? () => moreRef.current && onElsewhere(t, moreRef.current) : undefined} />
      )}
    </div>
  );
});

/** One day: a "week-day" target (that day), with a "week-slot" strip (a time that day). The strip
 *  isn't listed for menus (it would only repeat the day, and Schedule… is the keyboard's way to a
 *  time); keyboard drops on "YYYY-MM-DDTHH:MM" still reach it. While a drag is over it, the time
 *  it would get is the ghost's hint, not its label, so menus don't re-render on every move. */
function DayColumn({ date, iso, isToday, isPast, weekend, label, items, chip, canMove, accepts, onDrop }: {
  date: Date; iso: string; isToday: boolean; isPast: boolean; weekend: boolean;
  /** "Today" / "Fri 9 Oct" (the ghost's hint, keyboard menus) */
  label: string;
  items: Task[];
  chip: (t: Task, showTime?: boolean) => JSX.Element;
  canMove: boolean;
  accepts: (p: TaskDragPayload) => boolean;
  onDrop: (p: TaskDragPayload, date: string | null, minute: number | null | undefined) => void;
}) {
  const nameId = `kw-${iso}`;
  const [at, setAt] = useState<number | null>(null);
  const dayRef = useMemo(() => ({ kind: "week-day" as const, id: iso, data: { date: iso }, label }), [iso, label]);
  const day = useTaskDropTarget({ target: dayRef, accepts, disabled: !canMove, onDrop: (e) => onDrop(e.payload, iso, undefined) });
  const slotRef = useMemo(() => ({ kind: "week-slot" as const, id: iso, data: { date: iso, listed: false }, label: `${label}, at a time` }), [iso, label]);
  const slot = useTaskDropTarget({
    target: slotRef, accepts, disabled: !canMove, hint: at != null ? `${label}, ${hhmm(at)}` : undefined,
    onOver: (e) => { if (e.within) { const m = stripMinute(e.within.y); setAt((cur) => (cur === m ? cur : m)); } },
    onLeave: () => setAt(null),
    onDrop: (e: TaskDropEvent) => {
      // (a keyboard drop on the bare day, with no time, keeps the time it had: it's a move to the day)
      const m = e.within ? stripMinute(e.within.y) : typeof e.target.data?.minute === "number" ? e.target.data.minute as number : undefined;
      onDrop(e.payload, iso, m);
    },
  });
  const over = day.isOver || slot.isOver;
  return (
    <section {...day.bind} className="kweek-day" data-day={iso} data-today={isToday || undefined} data-past={isPast || undefined}
      data-weekend={weekend || undefined} data-drop={over || undefined} data-can={(day.canDrop && !over) || undefined}
      data-timing={slot.isOver || undefined} aria-labelledby={nameId}>
      <h3 className="kweek-day-head" id={nameId} aria-label={`${FULL_DAYS[date.getDay()]} ${dayMonth(date)}${isToday ? ", today" : ""}`}>
        <span className="kweek-day-name">{weekdayShort(date)}</span>
        <span className="kweek-day-date">{date.getDate()}</span>
        {items.length > 0 && <span className="kweek-day-count">{items.length}</span>}
      </h3>
      <div className="kweek-day-list">
        {items.map((t) => chip(t, true))}
        {items.length === 0 && <div className="kweek-empty" aria-hidden="true">{over ? "Drop here" : day.canDrop ? "" : "—"}</div>}
      </div>
      {canMove && (
        <div {...slot.bind} className="kweek-times" aria-hidden="true" data-open={slot.canDrop || undefined} data-near={over || undefined} data-over={slot.isOver || undefined}>
          {STRIP_HOURS.map((h) => (
            <i key={h} style={{ top: `${stripY(h * 60) * 100}%` }}><b>{hhmm(h * 60)}</b></i>
          ))}
        </div>
      )}
      {slot.isOver && at != null && (
        <span className="kweek-mark" aria-hidden="true" style={{ top: `calc(36px + (100% - 44px) * ${stripY(at)})` }}><span>{hhmm(at)}</span></span>
      )}
    </section>
  );
}

/** "No date": dropping a task here takes its date (and time) off. */
function NoDateSection({ tasks, canMove, accepts, onDrop, readOnly, chip }: {
  tasks: Task[]; canMove: boolean; readOnly?: boolean;
  accepts: (p: TaskDragPayload) => boolean;
  onDrop: (p: TaskDragPayload, date: string | null, minute: number | null | undefined) => void;
  chip: (t: Task) => JSX.Element;
}) {
  const ref = useMemo(() => ({ kind: "week-day" as const, id: "no-date", data: { date: null }, label: "No date" }), []);
  const t = useTaskDropTarget({ target: ref, accepts, disabled: !canMove, onDrop: (e) => onDrop(e.payload, null, null) });
  // with nothing undated it's only there while a dated task is in the air
  const show = tasks.length > 0 || (canMove && t.canDrop);
  return (
    <section {...t.bind} className={show ? "kweek-section kweek-nodate" : undefined} data-drop={t.isOver || undefined} aria-labelledby={show ? "kw-nodate" : undefined}>
      {show && (
        <>
          <div className="kweek-section-head"><SectionLabel id="kw-nodate" count={tasks.length}>No date</SectionLabel></div>
          {!readOnly && tasks.length > 0 && <p className="kweek-note">Drag one onto a day to schedule it.</p>}
          {tasks.length > 0
            ? <ChipGrid tasks={tasks} limit={18} label="unscheduled tasks" chip={chip} />
            : <div className="kweek-nodrop">Drop here to take the date off</div>}
        </>
      )}
    </section>
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
  // only a week with something to compare against gets a trend
  const trendLabel = doneLastWeek > 0 ? `${trend >= 0 ? "+" : ""}${trend} vs last week` : null;
  // the last seven days, ending today (the sparkline Home used to show)
  const last7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(today); d.setDate(today.getDate() - 6 + i); return d; });
  const sparkData = last7.map((d) => doneOn(isoOf(d)));

  const targets: Target[] = [
    ...days.map((d, i) => ({ iso: weekIsos[i], label: weekIsos[i] === todayIso ? "Today" : FULL_DAYS[d.getDay()], hint: dayMonth(d) })),
    { iso: isoOf(nextMonday), label: "Next week", hint: `Mon ${dayMonth(nextMonday)}` },
  ];

  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const canMove = !readOnly;
  const whereLabel = (iso: string) => (iso === todayIso ? "today" : dayLong(new Date(iso + "T00:00:00")));

  /** Put tasks on a day (a time on it, or none: "No date"), with one toast and its Undo. Done,
   *  archived and unknown tasks (someone else's, from search) stay put. */
  const applyWeek = useCallback((ids: string[], date: string | null, minute: number | null | undefined) => {
    const byId = new Map(tasksRef.current.map((t) => [t.id, t]));
    const changes = ids.map((id) => byId.get(id))
      .filter((t): t is Task => !!t && t.status !== "done" && !t.archivedAt)
      .map((t) => ({ t, patch: weekPatch(t, date, minute) }))
      .filter((c): c is { t: Task; patch: Partial<Task> } => !!c.patch);
    if (!changes.length) return;
    changes.forEach((c) => onPatch(c.t.id, c.patch));
    const one = changes.length === 1 ? changes[0].t : null;
    const what = one ? `“${one.title}”` : `${changes.length} tasks`;
    const msg = date === null ? `Took the date off ${what}`
      : minute != null ? `Moved ${what} to ${whereLabel(date)}, ${hhmm(minute)}`
      : minute === null && changes.every((c) => !("dueDate" in c.patch)) ? `${one ? `“${one.title}” is` : `${changes.length} tasks are`} due ${whereLabel(date)}, any time`
      : `Moved ${what} to ${whereLabel(date)}`;
    if (toast) toast.action(msg, "Undo", () => changes.forEach((c) => onPatch(c.t.id, undoPatch(c.t, c.patch))), { ms: 10000 });
  }, [onPatch, toast, todayIso]); // eslint-disable-line react-hooks/exhaustive-deps
  // a keyboard move: focus follows the chip to its new day (its old node is gone)
  const refocus = (id: string) => requestAnimationFrame(() => {
    const chip = Array.from(document.querySelectorAll<HTMLElement>(".kweek [data-task-id]")).find((c) => c.dataset.taskId === id);
    const el = chip?.querySelector<HTMLElement>(".kweek-chip-open");
    if (el && (!document.activeElement || document.activeElement === document.body)) el.focus();
  });
  const moveTo = useCallback((id: string, iso: string) => { applyWeek([id], iso, undefined); refocus(id); }, [applyWeek]);

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

  /* ----- drag to plan (lib/dnd): days, their time strips and "No date" take tasks from anywhere ----- */
  const accepts = useCallback((p: TaskDragPayload) => {
    if (!canMove) return false;
    const known = new Map(tasksRef.current.map((t) => [t.id, t]));
    return p.taskIds.some((id) => { const t = known.get(id); return !!t && t.status !== "done" && !t.archivedAt; });
  }, [canMove]);
  const onDrop = useCallback((p: TaskDragPayload, date: string | null, minute: number | null | undefined) => applyWeek(p.taskIds, date, minute), [applyWeek]);

  /* ----- the keyboard's drag: Schedule… (a day and a time), or a project or person on screen ----- */
  const [schedule, setSchedule] = useState<Task | null>(null);
  const [elsewhere, setElsewhere] = useState<Task | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const placesOnScreen = useDropTargets(["project", "person"]).length > 0;
  const openSchedule = useCallback((t: Task, anchor: HTMLElement) => { menuAnchor.current = anchor; setSchedule(t); }, []);
  const openElsewhere = useCallback((t: Task, anchor: HTMLElement) => { menuAnchor.current = anchor; setElsewhere(t); }, []);
  const scheduleDays = targets.map((t) => ({ date: t.iso, label: t.label === "Next week" ? `Mon ${nextMonday.getDate()}` : t.label === "Today" ? "Today" : weekdayShort(new Date(t.iso + "T00:00:00")) }));
  const busyOn = useCallback((date: string | undefined) => tasksRef.current
    .filter((t) => t.id !== schedule?.id && t.dueDate?.slice(0, 10) === date && t.status !== "done" && minuteOf(t.dueTime) != null)
    .map((t) => { const m = minuteOf(t.dueTime)!; return { start: m, end: m + durOf(t), title: t.title }; }), [schedule]);

  const chip = (t: Task, showTime?: boolean) => (
    <TaskChip key={t.id} t={t} targets={targets} onOpen={onOpen} showTime={showTime}
      onMove={canMove ? moveTo : undefined} onSchedule={canMove ? openSchedule : undefined}
      onElsewhere={canMove && placesOnScreen ? openElsewhere : undefined} />
  );
  // a day's list: what has a time, in time order, then the rest
  const dayItems = (iso: string) => {
    const items = open.filter((t) => t.dueDate === iso);
    const timed = items.filter((t) => minuteOf(t.dueTime) != null).sort((x, y) => minuteOf(x.dueTime)! - minuteOf(y.dueTime)!);
    return [...timed, ...items.filter((t) => minuteOf(t.dueTime) == null)];
  };

  const rangeLabel = `${dayMonth(days[0])} – ${dayMonth(days[6])}`;
  return (
    <div className="kweek">
      <style>{WEEK_CSS}</style>
      <div className="kweek-head">
        <h2 className="kweek-title">This week</h2>
        <span className="kweek-range">{rangeLabel}</span>
        <span className="kweek-stat">{doneThisWeek} done</span>
        {trendLabel && <span className="kweek-trend" data-tone={trend > 0 ? "up" : undefined}>{trendLabel}</span>}
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
            return (
              <DayColumn key={iso} date={d} iso={iso} isToday={iso === todayIso} isPast={iso < todayIso} weekend={i >= 5}
                label={iso === todayIso ? "Today" : dayLong(d)} items={dayItems(iso)} chip={chip} canMove={canMove} accepts={accepts} onDrop={onDrop} />
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

      <NoDateSection tasks={noDate} canMove={canMove} readOnly={readOnly} accepts={accepts} onDrop={onDrop} chip={chip} />

      {completedThisWeek.length > 0 && (
        <section className="kweek-section" aria-labelledby="kw-wins">
          <div className="kweek-section-head"><SectionLabel id="kw-wins" count={completedThisWeek.length}>This week's wins</SectionLabel></div>
          <ChipGrid tasks={completedThisWeek} limit={8} label="completed tasks" chip={chip} />
        </section>
      )}

      {schedule && (
        <Suspense fallback={null}>
          <ScheduleMenu open anchorRef={menuAnchor} onClose={() => setSchedule(null)} title={schedule.title} days={scheduleDays}
            value={{ date: schedule.dueDate?.slice(0, 10) && targets.some((t) => t.iso === schedule.dueDate?.slice(0, 10)) ? schedule.dueDate.slice(0, 10) : todayIso, minute: minuteOf(schedule.dueTime) }}
            allowNoTime from={WEEK_SLOT_FROM} to={WEEK_SLOT_TO} step={WEEK_SLOT_STEP} busy={busyOn} today={todayIso}
            nowMin={new Date().getHours() * 60 + new Date().getMinutes()} pickLabel="Schedule"
            onPick={(v) => { if (v.date) { applyWeek([schedule.id], v.date, v.minute); refocus(schedule.id); } }} />
        </Suspense>
      )}
      {elsewhere && (
        <Suspense fallback={null}>
          <MoveToMenu open anchorRef={menuAnchor} onClose={() => setElsewhere(null)} label={`Move “${elsewhere.title}” to`}
            kinds={["project", "person"]} payload={{ taskIds: [elsewhere.id], source: "week", originId: elsewhere.id }} />
        </Suspense>
      )}
    </div>
  );
}
