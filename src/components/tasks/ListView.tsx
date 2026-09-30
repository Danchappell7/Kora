/* ============================================================
   KANBO — the task list (My tasks, a project's List view) + TaskRow.
   One 36px line per task (30px compact, two lines on phones): the
   status glyph IS the completion checkbox (shift- or right-click for
   the status menu), then the title and its quiet inline meta, then a
   right-hand cluster that lines up row to row — project, due date,
   priority, assignee. No stripes, no dividers: groups carry the
   structure. J/K move, X selects, S/P/D/A edit, ⌘↵ completes.
   Phones: swipe a row right to complete it, left for Tomorrow ·
   Next week · Pick; a long press opens the row's action sheet.
   ============================================================ */
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, memo, type ReactNode } from "react";
import {
  Icon, Avatar, Check, AiScore, wasJustCompleted, wasJustLanded, markJustLanded, Collapse,
  StatusGlyph, PriorityGlyph, DateChip, ProjectDot, projectPaint, EmptyState, Button, IconButton, Kbd, AiMark, Sheet,
} from "../primitives";
import { Popover } from "../primitives/Popover";
import { useToast } from "../Toast";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useListKeyboard, isTypingTarget, type ListKeyAction } from "../../hooks/useListKeyboard";
import { pushUndo } from "../../lib/undoStack";
import { parseDateText } from "../../lib/nlp";
import { dayLabel, daysFromToday, localDayOf } from "../../lib/myTaskBuckets";
import {
  getProject, getMember, dueState, fmtDue, toLocalISO, presetDate, KANBO_TODAY, TAGS,
  STATUS_META, STATUS_ORDER, PRIORITY_META,
} from "../../data/data";
import type { Task, Subtask, IconName, Priority, Section, CustomFieldDef, Project, TagDef } from "../../data/types";
import type { GroupBy } from "../../app-types";
import { useEntrance } from "../../hooks/useEntrance";
import "./taskViews.css";

// small chips showing a task's filled custom-field values (max 3)
export function CustomChips({ task, fields, members = [] }: { task: Task; fields: CustomFieldDef[]; members?: { id: string; name: string }[] }) {
  const vals = task.custom ?? {};
  const chips = fields.map((f) => {
    const v = vals[f.id];
    if (v == null || v === "" || v === false) return null;
    if (f.type === "checkbox") return { id: f.id, label: f.name };
    if (f.type === "multiselect") { const arr = Array.isArray(v) ? v as string[] : []; return arr.length ? { id: f.id, label: arr.join(", ") } : null; }
    if (f.type === "currency") return { id: f.id, label: "£" + v };
    const label = f.type === "people" ? (members.find((m) => m.id === v)?.name ?? String(v)) : String(v);
    return { id: f.id, label };
  }).filter((c): c is { id: string; label: string } => !!c).slice(0, 3);
  if (chips.length === 0) return null;
  return <>{chips.map((c) => <span key={c.id} className="ktv-m" title={`${fields.find((f) => f.id === c.id)?.name ?? ""}: ${c.label}`}><span className="truncate" style={{ maxWidth: 110 }}>{c.label}</span></span>)}</>;
}

export function SubtaskProgress({ subtasks }: { subtasks?: Subtask[] }) {
  if (!subtasks?.length) return null;
  const done = subtasks.filter((s) => s.done).length;
  return (
    <span className="ktv-m ktv-mono" title={`${done} of ${subtasks.length} sub-tasks done`}>
      <Icon name="layers" size={12} /> {done}/{subtasks.length}
    </span>
  );
}

/* ---------- pure helpers (unit-tested) ---------- */

/** "YYYY-MM-DD" for `today` + n days (local time). */
function isoFrom(today: Date, n: number): string {
  return toLocalISO(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
}

/** Due date a task added under a "Due" group should get, so it lands in that
 *  group instead of jumping to "No date": overdue/today → today, this week →
 *  tomorrow, later → today + 8, no date → none. */
export function dueDateForBucket(bucket: string, today: Date = KANBO_TODAY): string | undefined {
  if (bucket === "overdue" || bucket === "today") return isoFrom(today, 0);
  if (bucket === "week") return isoFrom(today, 1);
  if (bucket === "later") return isoFrom(today, 8);
  return undefined;
}

export interface DropPlan {
  /** the moved task's new position */
  position: number;
  /** neighbours to re-space first — needed when the rows either side of the gap share a
   *  position (a pasted list is created in the same millisecond), so no midpoint exists */
  respace: { id: string; position: number }[];
  /** the drop puts the task back exactly where it already was */
  unchanged: boolean;
}

/** Where a task dropped above/below `targetId` goes, in a group whose rows render in
 *  `items` order. With no target row it goes to the top of the group (its header), or
 *  to the end for half "bottom" (its "Add task" row).
 *  Done rows always sort to the bottom whatever their position, so positions
 *  aren't monotonic across that boundary: neighbours are taken from the rows
 *  in the dropped task's own band (open vs done), counted up to the drop point. */
export function planDrop(items: Task[], draggedId: string, targetId: string | null, half: "top" | "bottom", willBeDone: boolean): DropPlan {
  const inBand = (t: Task) => (t.status === "done") === willBeDone;
  const rest = items.filter((t) => t.id !== draggedId);
  const ti = targetId ? rest.findIndex((t) => t.id === targetId) : -1;
  const at = ti < 0 ? (half === "bottom" ? rest.length : 0) : half === "top" ? ti : ti + 1;
  const k = rest.slice(0, at).filter(inBand).length;
  const band = rest.filter(inBand);
  const own = items.filter(inBand).findIndex((t) => t.id === draggedId);
  return { ...placeAt(band, k), unchanged: own === k };
}

/** Just the new position (see planDrop). */
export function dropPosition(items: Task[], draggedId: string, targetId: string | null, half: "top" | "bottom", willBeDone: boolean): number {
  return planDrop(items, draggedId, targetId, half, willBeDone).position;
}

// the list sorts a missing position as 0, so the maths must too
const posOf = (t: Task) => t.position ?? 0;

// n strictly increasing values strictly inside (lo, hi) — null if they don't fit (float precision)
function spaced(lo: number, hi: number, n: number): number[] | null {
  const vals = lo === -Infinity ? Array.from({ length: n }, (_, i) => hi - (n - i))
    : hi === Infinity ? Array.from({ length: n }, (_, i) => lo + i + 1)
    : lo < hi ? Array.from({ length: n }, (_, i) => lo + ((hi - lo) * (i + 1)) / (n + 1))
    : null;
  return vals && vals.every((v, i) => v > (i ? vals[i - 1] : lo) && v < hi) ? vals : null;
}

// the task goes into `band` (its rendered rows, without it) at index k
function placeAt(band: Task[], k: number): Omit<DropPlan, "unchanged"> {
  if (band.length === 0) return { position: Date.now(), respace: [] };
  if (k <= 0) return { position: posOf(band[0]) - 1, respace: [] };
  if (k >= band.length) return { position: posOf(band[band.length - 1]) + 1, respace: [] };
  const lo = posOf(band[k - 1]), hi = posOf(band[k]);
  const mid = (lo + hi) / 2;
  if (lo < mid && mid < hi) return { position: mid, respace: [] };
  // tied (or too-close) neighbours: shift the fewest rows on one side of the gap, keeping their order
  let down: Omit<DropPlan, "unchanged"> | null = null, up: Omit<DropPlan, "unchanged"> | null = null;
  for (let i = k - 1; i >= 0 && !down; i--) {
    const seg = band.slice(i, k); // these rows, then the task, fit between band[i-1] and band[k]
    const v = spaced(i > 0 ? posOf(band[i - 1]) : -Infinity, hi, seg.length + 1);
    if (v) down = { position: v[seg.length], respace: seg.map((t, j) => ({ id: t.id, position: v[j] })) };
  }
  for (let j = k; j < band.length && !up; j++) {
    const seg = band.slice(k, j + 1); // the task, then these rows, fit between band[k-1] and band[j+1]
    const v = spaced(lo, j + 1 < band.length ? posOf(band[j + 1]) : Infinity, seg.length + 1);
    if (v) up = { position: v[0], respace: seg.map((t, i) => ({ id: t.id, position: v[i + 1] })) };
  }
  if (down && (!up || down.respace.length <= up.respace.length)) return down;
  if (up) return up;
  // (unreachable in practice) renumber the whole band
  const order = [...band.slice(0, k), null, ...band.slice(k)];
  return { position: k * 1024, respace: order.flatMap((t, i) => t ? [{ id: t.id, position: i * 1024 }] : []) };
}

// keep the previous array while its items are unchanged, so memoised rows don't
// re-render just because the parent rebuilt an equal list (App filters on every render)
function useStableList<T>(list: T[], same: (a: T, b: T) => boolean = Object.is): T[] {
  const ref = useRef(list);
  const prev = ref.current;
  if (prev !== list && (prev.length !== list.length || list.some((x, i) => !same(x, prev[i])))) ref.current = list;
  return ref.current;
}
const sameMember = (a: { id: string; name: string }, b: { id: string; name: string }) => a.id === b.id && a.name === b.name;

/** Which control of a row keeps keyboard focus when a change re-mounts it in another group. */
type RowFocusPart = "title" | "priority" | "due" | "check" | "assignee";

// stable empties so memoised rows don't re-render on a fresh [] every time
const NO_TASKS: Task[] = [];
const NO_MEMBERS: { id: string; name: string }[] = [];
const NO_FIELDS: CustomFieldDef[] = [];
const NO_SECTIONS: Section[] = [];
const NO_PROJECTS: Project[] = [];

// a latest-value callback with a stable identity (keeps memo'd rows from re-rendering)
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/** Completing a row lets its strike sweep across in place, then the row moves to its new group. */
export const SETTLE_MS = 600;

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

// tick shown against the current value in an inline menu
function CurrentMark() {
  return <span className="ktv-mi-end"><Icon name="check" size={14} sw={2.2} /></span>;
}

/** A task edit from a row control: applied at once, and ⌘Z puts the old values back. */
type RowEdit = (task: Task, patch: Partial<Task>, what: string) => void;

/* ---------- phone gestures ---------- */
/** the swipe-left tray: Tomorrow · Next week · Pick, 64px each */
const TRAY_W = 192;
/** how far a right swipe travels before letting go completes the task */
const SWIPE_DONE_AT = 112;
const LONG_PRESS_MS = 450;
const buzz = (ms: number) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };
/** A due date in words for a toast: "today", "tomorrow", else "Wed 7 Oct". */
export function dueWords(iso: string, today: Date = KANBO_TODAY): string {
  const n = daysFromToday(iso, today);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  const d = localDayOf(iso);
  return d ? dayLabel(d, today) : iso;
}
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Thu 1" under a tray button */
const shortDay = (iso: string) => { const d = localDayOf(iso); return d ? `${WD[d.getDay()]} ${d.getDate()}` : ""; };
/** the natural-language date field in every row's picker ("fri", "in 2 weeks"); the chip's own parser covers the rest */
const parseDue = (text: string) => parseDateText(text);

/** The toast stack, when the page has one (the list also renders bare, in tests and previews). */
function useOptionalToast(): ReturnType<typeof useToast> | null {
  try { return useToast(); } catch { return null; }
}

interface TaskRowProps {
  task: Task;
  /** this row's sub-tasks (full tasks) and how many are done — from the parent's per-render map */
  childTasks: Task[]; childDone: number;
  /** id → task, for "blocked by" lookups without scanning every task per row */
  byId: Map<string, Task>;
  onOpen: (id: string) => void; onToggle: (id: string) => void; onToggleSubtask: (taskId: string, subId: string) => void;
  /** completes this row with the settle (the list's wrapper around onToggle) */
  onCheck: (id: string) => void;
  smart: boolean; depth?: number; isMobile: boolean; readOnly?: boolean;
  selected?: boolean; selectionActive?: boolean; onSelect?: (id: string, range: boolean) => void;
  /** touch: a tap toggles selection while a selection is under way; a long press starts one */
  touchSelect?: boolean;
  draggable?: boolean; dragging?: boolean; dropHint?: "top" | "bottom" | null;
  onPickup?: (id: string) => void; onHover?: (id: string, half: "top" | "bottom") => void; onRowDrop?: (draggedId: string, targetId: string, half: "top" | "bottom") => void;
  /** keyboard reorder (Alt+↑/↓ on the title) */
  onMoveBy?: (id: string, dir: -1 | 1) => void;
  /** called just before a change that may move this row into another group (which re-mounts
   *  it), so the list can put focus back on the same control; `scroll` = keyboard-initiated */
  onRefocus?: (id: string, part: RowFocusPart, scroll: boolean) => void;
  onEdit?: RowEdit; members?: { id: string; name: string }[]; customFields?: CustomFieldDef[];
  showProject?: boolean;
  /** quiet the assignee (it's you): shown on hover only */
  quietAssignee?: boolean;
  cursor?: boolean;
  /** this task is open in the task panel */
  active?: boolean;
  /** play the completion moment when this row mounts already done (false right after it settled) */
  celebrate?: boolean;
  meta?: ReactNode;
  action?: ReactNode;
  /** phones: swipe right completes, swipe left offers Tomorrow · Next week · Pick */
  swipe?: boolean;
  /** a date from the swipe tray (applied with an Undo toast) */
  onQuickDue?: (task: Task, iso: string | undefined) => void;
  /** the tray's Pick: open this row's date picker */
  onPickDue?: (id: string) => void;
  /** the row's own date chip changed (the list decides whether that gets a toast) */
  onDue?: (task: Task, patch: Partial<Task>) => void;
  /** phones: a long press opens the row's action sheet */
  onLongPress?: (id: string) => void;
}

const TaskRow = memo(function TaskRow({ task, childTasks, childDone, byId, onOpen, onToggle, onToggleSubtask, onCheck, smart, depth = 0, isMobile, readOnly = false, selected = false, selectionActive = false, onSelect, touchSelect = false, draggable = false, dragging = false, dropHint = null, onPickup, onHover, onRowDrop, onMoveBy, onRefocus, onEdit, members = NO_MEMBERS, customFields = NO_FIELDS, showProject = true, quietAssignee = false, cursor = false, active = false, celebrate = true, meta, action, swipe = false, onQuickDue, onPickDue, onDue, onLongPress }: TaskRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [menu, setMenu] = useState<null | "priority" | "assignee" | "status">(null);
  const statusAnchor = useRef<HTMLElement | null>(null);
  const priorityRef = useRef<HTMLButtonElement>(null);
  const assigneeRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const checkByKey = useRef(false); // was the completion toggle pressed from the keyboard?
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const toggleMenu = (m: "priority" | "assignee") => setMenu((cur) => cur === m ? null : m);
  const edit = readOnly ? undefined : onEdit;
  const PRIORITIES_INLINE: Priority[] = ["urgent", "high", "medium", "low"];
  const saveTitle = () => { const v = titleDraft.trim(); setEditingTitle(false); if (v && v !== task.title) edit?.(task, { title: v }, "Name"); else setTitleDraft(task.title); };
  const startRename = () => { setTitleDraft(task.title); setEditingTitle(true); };
  // after a rename (Enter/Escape), put keyboard focus back on the title
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editingTitle && document.activeElement === document.body) titleRef.current?.focus({ preventScroll: true });
    wasEditing.current = editingTitle;
  }, [editingTitle]);
  const proj = getProject(task.projectId);
  const blocked = useMemo(() => (task.dependencies ?? []).map((id) => byId.get(id)).filter((x): x is Task => !!x && x.status !== "done"), [task.dependencies, byId]);
  const done = task.status === "done";
  // the strike sweeps only when THIS row flips to done while on screen (or when completing
  // re-mounted it); rows that are already done on first render just show a static strike
  const prevDone = useRef(done);
  const [justDone, setJustDone] = useState(() => celebrate && done && wasJustCompleted(task.id));
  useEffect(() => {
    const was = prevDone.current;
    prevDone.current = done;
    if (done && !was) setJustDone(true);
  }, [done]);
  useEffect(() => {
    if (!justDone) return;
    const t = window.setTimeout(() => setJustDone(false), 600);
    return () => window.clearTimeout(t);
  }, [justDone]);
  // a soft accent wash when this row was just dropped (drag-reorder)
  const [landed, setLanded] = useState(() => wasJustLanded(task.id));
  useEffect(() => { if (wasJustLanded(task.id)) setLanded(true); }, [task.id, task.position]);
  useEffect(() => { if (!landed) return; const t = window.setTimeout(() => setLanded(false), 1000); return () => window.clearTimeout(t); }, [landed]);
  useEffect(() => () => { if (press.current) window.clearTimeout(press.current.timer); }, []);
  // sub-tasks are full tasks with parentId; legacy checklist items live on task.subtasks
  const subDone = childDone + (task.subtasks ?? []).filter((s) => s.done).length;
  const subTotal = childTasks.length + (task.subtasks?.length ?? 0);
  const hasSubs = subTotal > 0;
  const statusLabel = STATUS_META[task.status].label;
  const prioLabel = PRIORITY_META[task.priority].label;
  const assignee = getMember(task.assigneeId);
  const q = `“${task.title}”`;
  const tags = (task.tags || []).filter((id) => TAGS[id]);
  const stale = !done && !task.dueDate && task.createdAt ? Math.floor((Date.now() - new Date(task.createdAt).getTime()) / 86400000) : NaN;

  const onTitleKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "F2" && edit) { e.preventDefault(); startRename(); return; }
    if (e.altKey && onMoveBy && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); e.stopPropagation(); onMoveBy(task.id, e.key === "ArrowUp" ? -1 : 1); }
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  /* ---- phones: swipe right to complete, left for the reschedule tray; long press for the sheet ---- */
  const hostRef = useRef<HTMLDivElement>(null);
  const [shift, setShiftState] = useState(0);
  const shiftRef = useRef(0);
  const sideRef = useRef<"right" | "left">("right"); // which layer shows while the row is off-centre
  const setShift = (n: number) => { shiftRef.current = n; if (n) sideRef.current = n > 0 ? "right" : "left"; setShiftState(n); };
  const [tray, setTray] = useState(false);
  const [glide, setGlide] = useState(false); // a released row eases home; a dragged one follows the finger
  // the glide lasts one transition (reduced motion has none, so a timer ends it rather than transitionend)
  useEffect(() => {
    if (!glide) return;
    const t = window.setTimeout(() => setGlide(false), 220);
    return () => window.clearTimeout(t);
  }, [glide]);
  const [armed, setArmed] = useState(false);
  const swipeRef = useRef<{ x: number; y: number; base: number; axis: "x" | null; reach: number } | null>(null);
  const swallowUntil = useRef(0); // the click a finished swipe leaves behind
  const closeTray = (animate = true) => { setGlide(animate); setShift(0); setTray(false); setArmed(false); };
  // a selection starting, or the row being done, puts the row back
  useEffect(() => {
    if ((!swipe || done) && (shiftRef.current !== 0 || tray)) closeTray();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swipe, done]);
  // a touch anywhere else closes an open tray
  useEffect(() => {
    if (!tray) return;
    const onDown = (e: Event) => { if (!(e.target instanceof Node) || !hostRef.current?.contains(e.target)) closeTray(); };
    document.addEventListener("touchstart", onDown, { capture: true, passive: true });
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("touchstart", onDown, { capture: true });
      document.removeEventListener("mousedown", onDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tray]);
  // while a selection is under way a long press adds to it; otherwise it opens the sheet (phones) or starts one
  const longPress = touchSelect && onSelect ? () => onSelect(task.id, false)
    : onLongPress ? () => onLongPress(task.id)
    : onSelect ? () => onSelect(task.id, false) : undefined;
  const touchable = swipe || !!longPress;
  const cancelPress = () => { const s = press.current; if (s && !s.fired) { window.clearTimeout(s.timer); press.current = null; } };
  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const p = e.touches[0];
    if (!p || e.touches.length > 1) { cancelPress(); swipeRef.current = null; return; }
    if (swipe) swipeRef.current = { x: p.clientX, y: p.clientY, base: shiftRef.current, axis: null, reach: Math.min(SWIPE_DONE_AT, (hostRef.current?.clientWidth || 360) * 0.34) };
    // the glyph keeps its own long press (the status menu, where the platform offers one)
    if (!longPress || press.current || (e.target as HTMLElement).closest?.(".ktv-lead")) return;
    const timer = window.setTimeout(() => {
      if (!press.current) return;
      press.current.fired = true;
      swipeRef.current = null;
      buzz(10);
      longPress();
    }, LONG_PRESS_MS);
    press.current = { timer, x: p.clientX, y: p.clientY, fired: false };
  };
  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const p = e.touches[0];
    if (!p) return;
    const s = press.current;
    if (s && !s.fired && Math.hypot(p.clientX - s.x, p.clientY - s.y) > 8) cancelPress();
    const w = swipeRef.current;
    if (!w) return;
    const dx = p.clientX - w.x, dy = p.clientY - w.y;
    if (!w.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // mostly vertical: it's a scroll, and the row stays put (a done row has no tray to pull out)
      if (Math.abs(dx) <= Math.abs(dy) * 1.2 || (w.base === 0 && dx < 0 && done)) { swipeRef.current = null; return; }
      w.axis = "x";
      setGlide(false);
    }
    let next = w.base + dx;
    if (w.base < 0) next = Math.min(0, next);          // an open tray only closes
    if (done) next = Math.max(0, next);
    if (next < -TRAY_W) next = -TRAY_W + (next + TRAY_W) * 0.25;       // resists past the tray
    if (next > w.reach) next = w.reach + (next - w.reach) * 0.35;     // and past the finish line
    const nowArmed = w.base === 0 && next >= w.reach;
    if (nowArmed !== armed) { setArmed(nowArmed); if (nowArmed) buzz(8); }
    setShift(next);
  };
  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>, cancelled: boolean) => {
    // A long press that fired, or a swipe: the tap it ends is spent. Cancelling touchend stops the
    // click the browser would send (which would land on the sheet's scrim and close it); any that
    // still arrives is swallowed.
    if (press.current?.fired) {
      press.current = null;
      swallowUntil.current = Date.now() + 400;
      if (e.cancelable) e.preventDefault();
    }
    cancelPress();
    const w = swipeRef.current;
    swipeRef.current = null;
    if (!w || w.axis !== "x") return;
    if (e.cancelable) e.preventDefault();
    swallowUntil.current = Date.now() + 400;
    const x = shiftRef.current;
    if (!cancelled && w.base === 0 && x >= w.reach) { closeTray(); onCheck(task.id); return; }
    const open = !cancelled && !done && (w.base < 0 ? x <= -TRAY_W + 48 : x <= -64);
    setGlide(true); setArmed(false);
    setShift(open ? -TRAY_W : 0);
    setTray(open);
  };
  const tomorrowIso = presetDate("tomorrow");
  const nextWeekIso = presetDate("nextweek");
  const trayDue = (iso: string) => { closeTray(); onQuickDue?.(task, iso); };

  return (
    <div className="ktv-rowwrap">
      <div ref={hostRef} className="ktv-rowhost">
      {swipe && (shift !== 0 || tray || glide) && (
        sideRef.current === "right" ? (
          <div className="ktv-swipe ktv-swipe-done" data-armed={armed || undefined} aria-hidden="true">
            <Icon name={done ? "refresh" : "check"} size={16} sw={2.2} /><span>{done ? "Not done" : "Done"}</span>
          </div>
        ) : (
          <div className="ktv-swipe ktv-swipe-tray" role="group" aria-label={`Reschedule ${q}`} aria-hidden={!tray || undefined}>
            <button type="button" tabIndex={tray ? 0 : -1} onClick={() => trayDue(tomorrowIso)} aria-label={`Due tomorrow, ${shortDay(tomorrowIso)}`}>
              Tomorrow<span className="ktv-mono" aria-hidden="true">{shortDay(tomorrowIso)}</span>
            </button>
            <button type="button" tabIndex={tray ? 0 : -1} onClick={() => trayDue(nextWeekIso)} aria-label={`Due next week, ${shortDay(nextWeekIso)}`}>
              Next week<span className="ktv-mono" aria-hidden="true">{shortDay(nextWeekIso)}</span>
            </button>
            <button type="button" tabIndex={tray ? 0 : -1} data-pick="true" onClick={() => { swallowUntil.current = 0; closeTray(false); onPickDue?.(task.id); }} aria-label="Pick a due date">
              <Icon name="calendar" size={16} sw={1.75} />Pick
            </button>
          </div>
        )
      )}
      <div role="group" aria-label={task.title} data-row-id={task.id} data-selected={selected || undefined}
        className={"ktv-row task-row" + (landed ? " kland-row" : "")}
        data-done={done || undefined} data-cursor={cursor || undefined} data-active={active || undefined} data-drag={dragging || undefined}
        data-drop={dropHint ?? undefined} data-draggable={draggable || undefined}
        data-swipe={swipe || undefined} data-shifted={swipe && (shift !== 0 || tray || glide) ? sideRef.current : undefined} data-glide={glide || undefined}
        onClickCapture={(e) => {
          // the click a long press or a swipe leaves behind, or a tap that closes the open tray, goes no
          // further (not even to the title or a chip inside the row)
          if (Date.now() < swallowUntil.current || tray) {
            e.stopPropagation(); e.preventDefault();
            if (tray) closeTray();
          }
        }}
        onClick={() => {
          if (touchSelect && onSelect) { onSelect(task.id, false); return; }
          onOpen(task.id);
        }}
        onTouchStart={touchable ? onTouchStart : undefined}
        onTouchMove={touchable ? onTouchMove : undefined}
        onTouchEnd={touchable ? (e) => onTouchEnd(e, false) : undefined}
        onTouchCancel={touchable ? (e) => onTouchEnd(e, true) : undefined}
        onContextMenu={touchable ? (e) => { if (press.current?.fired) e.preventDefault(); } : undefined}
        draggable={draggable}
        onDragStart={draggable ? (e) => { e.dataTransfer.setData("text/kanbo-task", task.id); e.dataTransfer.effectAllowed = "move"; onPickup?.(task.id); } : undefined}
        onDragOver={draggable ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onHover?.(task.id, e.clientY < r.top + r.height / 2 ? "top" : "bottom"); } : undefined}
        onDrop={draggable ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData("text/kanbo-task"); const r = e.currentTarget.getBoundingClientRect(); onRowDrop?.(id, task.id, e.clientY < r.top + r.height / 2 ? "top" : "bottom"); } : undefined}
        onDragEnd={draggable ? () => onPickup?.("") : undefined}
        style={depth || shift ? { ...(depth ? { paddingLeft: `calc(var(--tv-gutter) + ${depth * 22}px)` } : null), ...(shift ? { transform: `translate3d(${shift}px, 0, 0)` } : null) } : undefined}>

        {onSelect && (
          <button type="button" role="checkbox" aria-checked={selected} aria-label={`Select ${q}`} className="ktv-sel ksel"
            onClick={(e) => { e.stopPropagation(); onSelect(task.id, e.shiftKey); }}>
            {selected && <Icon name="check" size={11} sw={3} />}
          </button>
        )}

        <span className="ktv-lead" data-row-check={task.id} onClickCapture={(e) => { checkByKey.current = e.detail === 0; }}>
          {readOnly ? (
            <span role="img" aria-label={`Status: ${statusLabel}`} title={statusLabel} style={{ display: "inline-flex" }}>
              <StatusGlyph status={task.status} size={isMobile ? 20 : 16} readOnly />
            </span>
          ) : (
            <StatusGlyph status={task.status} size={isMobile ? 20 : 16} label={task.title} celebrateKey={celebrate ? task.id : undefined}
              onToggle={() => { onRefocus?.(task.id, "check", checkByKey.current); onCheck(task.id); }}
              onPick={edit ? (anchor) => { statusAnchor.current = anchor; setMenu((m) => (m === "status" ? null : "status")); } : undefined} />
          )}
          {menu === "status" && edit && (
            <Popover open anchorRef={statusAnchor} onClose={closeMenu} label={`Status for ${q}`}>
              {STATUS_ORDER.map((s) => (
                <button key={s} type="button" role="menuitemradio" aria-checked={task.status === s} className="ktv-mi"
                  onClick={(e) => { setMenu(null); if (s === task.status) return; onRefocus?.(task.id, "check", e.detail === 0); edit(task, { status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined }, "Status"); }}>
                  <StatusGlyph status={s} size={14} readOnly /> {STATUS_META[s].label}{task.status === s && <CurrentMark />}
                </button>
              ))}
            </Popover>
          )}
        </span>

        <div className="ktv-main">
          {task.isMilestone && <span className="ktv-milestone" title="Milestone" />}
          {editingTitle ? (
            // eslint-disable-next-line jsx-a11y/no-autofocus
            <input autoFocus value={titleDraft} aria-label={`Rename ${q}`} className="ktv-rename" onClick={stop} onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") saveTitle(); else if (e.key === "Escape") { setTitleDraft(task.title); setEditingTitle(false); } }}
              onBlur={saveTitle} />
          ) : (
            <button ref={titleRef} type="button" data-row-title={task.id} className={"ktv-title" + (justDone ? " ktv-strike" : "")} title={edit ? "Double-click (or F2) to rename" : undefined}
              onClick={(e) => { e.stopPropagation(); if (touchSelect && onSelect) { onSelect(task.id, false); return; } onOpen(task.id); }}
              onDoubleClick={edit ? (e) => { e.stopPropagation(); startRename(); } : undefined}
              onKeyDown={onTitleKey}>{task.title}</button>
          )}
          {!editingTitle && (
            <span className="ktv-meta">
              {/* the page's own note leads (Waiting on: "with Maya"): it's why the row is here, so it's the last to give way */}
              {meta}
              {hasSubs && (
                <button type="button" className="ktv-subbtn ktv-mono" aria-expanded={expanded} onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
                  aria-label={`${expanded ? "Hide" : "Show"} sub-tasks of ${q}, ${subDone} of ${subTotal} done`}>
                  <Icon name="chevronRight" size={12} sw={2} />{subDone}/{subTotal}
                </button>
              )}
              {blocked.length > 0 && (
                <span className="ktv-m ktv-m-signal" role="img" data-tip={"Blocked by " + blocked.map((b) => b.title).join(", ")} aria-label={"Blocked by " + blocked.map((b) => b.title).join(", ")}>
                  <Icon name="lock" size={12} />
                </span>
              )}
              {task.recurrence && task.recurrence !== "none" && <span className="ktv-m" role="img" aria-label={`Repeats ${task.recurrence}`} title={`Repeats ${task.recurrence}`}><Icon name="refresh" size={12} /></span>}
              {task.comments > 0 && <span className="ktv-m" title={`${task.comments} comment${task.comments === 1 ? "" : "s"}`}><Icon name="message" size={12} /><span className="ktv-mono">{task.comments}</span></span>}
              {tags.slice(0, 2).map((id) => <span key={id} className="ktv-tag"><i style={{ background: projectPaint(TAGS[id].color).solid }} />{TAGS[id].label}</span>)}
              {tags.length > 2 && <span className="ktv-mono" title={tags.slice(2).map((id) => TAGS[id].label).join(", ")}>+{tags.length - 2}</span>}
              <CustomChips task={task} fields={customFields} members={members} />
              {stale >= 14 && <span className="ktv-m ktv-mono" title={`Open ${stale} days with no due date: review, schedule or archive`}><Icon name="clock" size={12} />{stale}d</span>}
            </span>
          )}
        </div>

        <div className="ktv-cluster">
          {action && <span className="ktv-action" onClick={stop}>{action}</span>}
          {smart && !done && <AiScore score={task.aiScore} reason={task.aiReason} />}
          {showProject && (
            <span className="ktv-proj" data-row-project={task.id}>
              {proj && <><ProjectDot color={proj.color} title={proj.name} /><span>{proj.name}</span></>}
            </span>
          )}
          <span className="ktv-due" data-row-due={task.id} onClick={stop}>
            {edit ? (
              <DateChip value={task.dueDate} time={task.dueTime} withTime size="sm" status={task.status} label={`Due date for ${q}`} placeholder="Add date" parse={parseDue}
                onChange={(date, time) => {
                  const next: Partial<Task> = {};
                  if ((date ?? undefined) !== (task.dueDate ?? undefined)) next.dueDate = date;
                  const t = date ? time : undefined;
                  if ((t ?? undefined) !== (task.dueTime ?? undefined)) next.dueTime = t;
                  if (!Object.keys(next).length) return;
                  onRefocus?.(task.id, "due", false);
                  if (onDue) onDue(task, next); else edit(task, next, "Due date");
                }} />
            ) : task.dueDate ? <DateChip value={task.dueDate} time={task.dueTime} size="sm" status={task.status} label="Due" readOnly onChange={() => {}} /> : null}
          </span>
          <span data-row-priority={task.id} data-prio={task.priority} onClick={stop} style={{ display: "inline-flex" }}>
            {edit ? (
              <>
                <button ref={priorityRef} type="button" className="ktv-trig" onClick={() => toggleMenu("priority")} aria-haspopup="menu" aria-expanded={menu === "priority"}
                  aria-label={`Priority: ${prioLabel}. Change priority for ${q}`}>
                  <PriorityGlyph priority={task.priority} />
                </button>
                {menu === "priority" && <Popover open anchorRef={priorityRef} onClose={closeMenu} align="end" label={`Priority for ${q}`}>
                  {PRIORITIES_INLINE.map((p) => (
                    <button key={p} type="button" role="menuitemradio" aria-checked={task.priority === p} className="ktv-mi"
                      onClick={(e) => { setMenu(null); if (p === task.priority) return; onRefocus?.(task.id, "priority", e.detail === 0); edit(task, { priority: p }, "Priority"); }}>
                      <span style={{ display: "inline-grid", placeItems: "center", width: 16 }}><PriorityGlyph priority={p} /></span> {PRIORITY_META[p].label}{task.priority === p && <CurrentMark />}
                    </button>
                  ))}
                </Popover>}
              </>
            ) : <span role="img" aria-label={`Priority: ${prioLabel}`} className="ktv-trig" style={{ cursor: "inherit" }}><PriorityGlyph priority={task.priority} /></span>}
          </span>
          <span className="ktv-avatar" data-row-assignee={task.id} onClick={stop}>
            {edit && members.length > 0 ? (
              <>
                <button ref={assigneeRef} type="button" className="ktv-trig" data-quiet={quietAssignee && !!assignee ? true : undefined}
                  onClick={() => toggleMenu("assignee")} aria-haspopup="menu" aria-expanded={menu === "assignee"}
                  aria-label={assignee ? `Assigned to ${assignee.name}. Change assignee for ${q}` : `Unassigned. Assign ${q}`}>
                  {assignee ? <Avatar id={task.assigneeId} size={20} /> : <span className="ktv-unassigned" title="Unassigned"><Icon name="user" size={11} /></span>}
                </button>
                {menu === "assignee" && <Popover open anchorRef={assigneeRef} onClose={closeMenu} align="end" minWidth={200} maxHeight={300} label={`Assignee for ${q}`}>
                  {members.map((m) => (
                    <button key={m.id} type="button" role="menuitemradio" aria-checked={task.assigneeId === m.id} className="ktv-mi"
                      onClick={(e) => { setMenu(null); if (m.id === task.assigneeId) return; onRefocus?.(task.id, "assignee", e.detail === 0); edit(task, { assigneeId: m.id }, "Assignee"); }}>
                      <Avatar id={m.id} size={20} /> <span className="truncate">{m.name}</span>{task.assigneeId === m.id && <CurrentMark />}
                    </button>
                  ))}
                </Popover>}
              </>
            ) : (!quietAssignee || !assignee) && <Avatar id={task.assigneeId} size={20} />}
          </span>
        </div>
      </div>
      </div>

      {/* sub-tasks (full tasks) + any legacy checklist items */}
      {hasSubs && (<Collapse open={expanded} ms={240}>
        <div role="group" aria-label={`Sub-tasks of ${task.title}`}>
          {childTasks.map((c) => {
            const cdone = c.status === "done";
            const cds = dueState(c.dueDate, c.status);
            return (
              <div key={c.id} className="ktv-sub" data-done={cdone || undefined} onClick={() => onOpen(c.id)} style={depth ? { paddingLeft: `calc(var(--tv-gutter) + ${26 + depth * 22}px)` } : undefined}>
                {readOnly
                  ? <span role="img" aria-label={`Status: ${STATUS_META[c.status].label}`} style={{ display: "inline-flex" }}><StatusGlyph status={c.status} size={14} readOnly /></span>
                  : <StatusGlyph status={c.status} size={14} label={c.title} celebrateKey={c.id} onToggle={() => onToggle(c.id)} />}
                <button type="button" className="ktv-title" onClick={(e) => { e.stopPropagation(); onOpen(c.id); }}>{c.title}</button>
                <span className="ktv-cluster">
                  {c.priority === "urgent" || c.priority === "high" ? <PriorityGlyph priority={c.priority} /> : null}
                  {c.dueDate && <span className="ktv-mono" style={{ color: cds === "overdue" ? "var(--tv-signal)" : cds === "today" ? "var(--accent-text, var(--accent))" : "var(--ink-3)" }}>{fmtDue(c.dueDate)}</span>}
                  <span className="ktv-avatar"><Avatar id={c.assigneeId} size={20} /></span>
                </span>
              </div>
            );
          })}
          {(task.subtasks ?? []).map((s) => (
            <div key={s.id} className="ktv-sub" data-done={s.done || undefined} style={{ cursor: "default", ...(depth ? { paddingLeft: `calc(var(--tv-gutter) + ${26 + depth * 22}px)` } : {}) }}>
              {readOnly
                ? <span role="img" aria-label={s.done ? "Completed" : "Not completed"} style={{ display: "inline-grid", placeItems: "center", width: 14, height: 14, borderRadius: 4, border: "1.5px solid var(--control-border, var(--hairline-strong))", background: s.done ? "var(--accent-fill, var(--accent))" : "transparent", color: "var(--on-accent)" }}>{s.done && <Icon name="check" size={9} sw={3} />}</span>
                : <Check done={s.done} size={14} label={s.title} onToggle={() => onToggleSubtask(task.id, s.id)} />}
              <span className="ktv-title" style={{ cursor: "default" }}>{s.title}</span>
            </div>
          ))}
        </div>
      </Collapse>)}
    </div>
  );
});

/** Phones: a long press on a row opens this sheet: open, status, due, priority, Today and select. */
function RowActionSheet({ task, canSelect, onOpen, onStatus, onDue, onPickDue, onPriority, onToday, onSelect }: {
  task: Task; canSelect: boolean;
  onOpen: (id: string) => void;
  onStatus: (t: Task, s: Task["status"]) => void;
  onDue: (t: Task, iso: string | undefined) => void;
  onPickDue: (id: string) => void;
  onPriority: (t: Task, p: Priority) => void;
  onToday: (t: Task) => void;
  onSelect: (id: string) => void;
}) {
  const proj = getProject(task.projectId);
  const quick = [
    { label: "Today", iso: toLocalISO(KANBO_TODAY) },
    { label: "Tomorrow", iso: presetDate("tomorrow") },
    { label: "Next week", iso: presetDate("nextweek") },
  ];
  return (
    <div className="ktv-acts">
      <p className="ktv-acts-meta">
        <StatusGlyph status={task.status} size={14} readOnly /><span>{STATUS_META[task.status].label}</span>
        {proj && <><span aria-hidden="true">·</span><ProjectDot color={proj.color} /><span className="truncate">{proj.name}</span></>}
        {task.dueDate && <><span aria-hidden="true">·</span><span className="ktv-mono">{fmtDue(task.dueDate)}</span></>}
      </p>
      <button type="button" className="ktv-act" onClick={() => onOpen(task.id)}>
        <Icon name="arrowUpRight" size={18} sw={1.75} /><span>Open task</span>
      </button>
      <div className="ktv-acts-sec" role="group" aria-label="Status">
        <h3>Status</h3>
        <div className="ktv-chips">
          {STATUS_ORDER.map((s) => (
            <button key={s} type="button" className="ktv-chip" aria-pressed={task.status === s} onClick={() => onStatus(task, s)}>
              <StatusGlyph status={s} size={14} readOnly /><span>{STATUS_META[s].label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="ktv-acts-sec" role="group" aria-label="Due date">
        <h3>Due</h3>
        <div className="ktv-chips">
          {quick.map((d) => (
            <button key={d.label} type="button" className="ktv-chip" aria-pressed={task.dueDate === d.iso} onClick={() => onDue(task, d.iso)}>
              <span>{d.label}</span><span className="ktv-mono" aria-hidden="true">{shortDay(d.iso)}</span>
            </button>
          ))}
          <button type="button" className="ktv-chip" onClick={() => onPickDue(task.id)}><Icon name="calendar" size={14} sw={1.75} /><span>Pick a date…</span></button>
          {task.dueDate && <button type="button" className="ktv-chip" onClick={() => onDue(task, undefined)}><span>No date</span></button>}
        </div>
      </div>
      <div className="ktv-acts-sec" role="group" aria-label="Priority">
        <h3>Priority</h3>
        <div className="ktv-chips">
          {(["urgent", "high", "medium", "low"] as const).map((p) => (
            <button key={p} type="button" className="ktv-chip" aria-pressed={task.priority === p} onClick={() => onPriority(task, p)}>
              <PriorityGlyph priority={p} /><span>{PRIORITY_META[p].label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="ktv-acts-list">
        <button type="button" className="ktv-act" onClick={() => onToday(task)}>
          <Icon name="sun" size={18} sw={1.75} /><span>{task.planToday ? "Take off Today" : "Add to Today"}</span>
        </button>
        {canSelect && (
          <button type="button" className="ktv-act" onClick={() => onSelect(task.id)}>
            <Icon name="check" size={18} sw={1.75} /><span>Select</span><small>to change several at once</small>
          </button>
        )}
      </div>
    </div>
  );
}

function GroupHeader({ groupKey, label, tone, count, collapsed, onToggleCollapse, onRename, onDelete, selectState, onSelectAll, onAdd, dropActive = false, onDragOver, onDrop }: {
  groupKey: string; label: string; tone?: "signal"; count: number; collapsed: boolean; onToggleCollapse: () => void;
  onRename?: (name: string) => void; onDelete?: () => void;
  /** select-all checkbox for the group (bulk selection) */
  selectState?: "all" | "some" | "none"; onSelectAll?: () => void;
  onAdd?: () => void;
  /** drop target for dragging a task into this group (works for empty sections too) */
  dropActive?: boolean; onDragOver?: (e: React.DragEvent) => void; onDrop?: (e: React.DragEvent) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(label);
  const finish = (save: boolean) => { setRenaming(false); const v = draft.trim(); if (save && v && v !== label) onRename?.(v); };
  return (
    <div className="ktv-ghead kgrouphdr" data-tone={tone} data-collapsed={collapsed || undefined} data-drop={dropActive || undefined} data-group-head={groupKey}
      onDragOver={onDragOver} onDrop={onDrop}>
      {onSelectAll && selectState && (
        <button type="button" role="checkbox" className="ktv-sel" aria-checked={selectState === "all" ? true : selectState === "some" ? "mixed" : false}
          aria-label={`Select all tasks in ${label}`} onClick={onSelectAll}>
          {selectState === "all" && <Icon name="check" size={11} sw={3} />}
          {selectState === "some" && <i />}
        </button>
      )}
      {renaming ? (
        // eslint-disable-next-line jsx-a11y/no-autofocus
        <input autoFocus className="ktv-inline-edit" value={draft} aria-label={`Rename section “${label}”`} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); }} onBlur={() => finish(true)} />
      ) : (
        <div role="heading" aria-level={2} style={{ display: "flex", minWidth: 0 }}>
          <button type="button" className="ktv-gtitle" aria-expanded={!collapsed} onClick={onToggleCollapse}
            onDoubleClick={onRename ? () => { setDraft(label); setRenaming(true); } : undefined}>
            <span className="ktv-gname" data-rename={onRename ? true : undefined}>{label}</span>
            <span className="ktv-gcount" aria-hidden="true">{count}</span>
            <span className="sr-only">, {count} task{count === 1 ? "" : "s"}</span>
            <Icon name="chevronDown" size={12} sw={2} className="ktv-gchev" />
          </button>
        </div>
      )}
      <span className="ktv-gtools">
        {onRename && !renaming && <IconButton icon="settings" size="sm" label={`Rename section “${label}”`} onClick={() => { setDraft(label); setRenaming(true); }} />}
        {onDelete && <IconButton icon="trash" size="sm" tone="danger" label={`Delete section “${label}”`} onClick={onDelete} />}
        {onAdd && <IconButton icon="plus" size="sm" label={`Add a task to ${label}`} onClick={onAdd} />}
      </span>
    </div>
  );
}

interface Group { key: string; label: string; tone?: "signal"; items: Task[]; addable?: boolean; addPatch?: Partial<Task>; keep?: boolean }

/** A group handed in by the page (My tasks' Open / Waiting on / Done buckets). */
export interface ListGroup {
  key: string;
  label: string;
  tone?: "signal";
  items: Task[];
  /** offer "Add task" here (default true) */
  addable?: boolean;
  /** what a task added here gets, e.g. that bucket's due date */
  addPatch?: Partial<Task>;
}

export function ListView({ tasks: tasksIn, allTasks: allTasksIn, projects = NO_PROJECTS, compact = false, onOpen, onToggle, onToggleSubtask, groupBy, smart, sort, onBulkPatch, onBulkDelete, onPatch, onQuickAdd, onOpenImport, members: membersIn = NO_MEMBERS, sections: sectionsIn = NO_SECTIONS, onCreateSection, onRenameSection, onDeleteSection, customFields: customFieldsIn = NO_FIELDS, sectionField = "sectionId", sectionProjectId, filtered = false, onClearFilters, readOnly = false,
  groups: groupsIn, showProject = true, quietAssigneeFor, renderMeta, renderAction, focusGroup, focusKey, emptyState, footer, allTags, keyboard = true, label = "Tasks", activeId }: {
  tasks: Task[]; allTasks: Task[]; projects?: Project[]; compact?: boolean; onOpen: (id: string) => void; onToggle: (id: string) => void; onToggleSubtask: (taskId: string, subId: string) => void; groupBy: GroupBy; smart: boolean;
  onBulkPatch?: (ids: string[], patch: Partial<Task>) => void;
  onBulkDelete?: (ids: string[]) => void;
  onPatch?: (id: string, patch: Partial<Task>) => void;
  onQuickAdd?: (partial: Partial<Task> & { title: string }) => void;
  onOpenImport?: () => void;
  sort?: string;
  members?: { id: string; name: string }[];
  sections?: Section[];
  onCreateSection?: (projectId: string, name: string) => void;
  onRenameSection?: (id: string, name: string) => void;
  onDeleteSection?: (id: string) => void;
  customFields?: CustomFieldDef[];
  sectionField?: "sectionId" | "mySectionId";
  sectionProjectId?: string;
  /** search or filters are narrowing `tasks` — an empty list then means "no matches", not "no tasks" */
  filtered?: boolean;
  onClearFilters?: () => void;
  /** view-only (guests): rows still open, but nothing can be added, edited, reordered or bulk-changed */
  readOnly?: boolean;
  /** the page's own groups (My tasks buckets); replaces `groupBy` grouping */
  groups?: ListGroup[];
  /** the project column (off inside a project) */
  showProject?: boolean;
  /** this person's avatar only shows on hover (My tasks: it's you) */
  quietAssigneeFor?: string;
  /** extra inline meta after a row's title (Waiting on: "with Maya") */
  renderMeta?: (t: Task) => ReactNode;
  /** a hover action at the start of a row's cluster (Waiting on: Nudge) */
  renderAction?: (t: Task) => ReactNode;
  /** scroll to this group and flash it (My tasks ?due=); `focusKey` replays it */
  focusGroup?: string;
  focusKey?: string | number;
  /** replaces "No tasks yet" when there's nothing here (and no filter) */
  emptyState?: ReactNode;
  /** after the last group (Done: "Show older") */
  footer?: ReactNode;
  /** the workspace's tags, for L (labels) */
  allTags?: Record<string, TagDef>;
  /** J/K keyboard triage (default on) */
  keyboard?: boolean;
  label?: string;
  /** the task open in the task panel: its row stays marked while you work beside it */
  activeId?: string;
}) {
  const entrance = useEntrance();
  const isMobile = useMediaQuery("(max-width: 860px)");
  const isTouch = useMediaQuery("(hover: none), (pointer: coarse)");
  // App rebuilds these arrays on every render; keep the old ones while nothing in them
  // changed, so the grouping memo and the memoised rows skip unrelated re-renders
  const tasks = useStableList(tasksIn);
  const allTasks = useStableList(allTasksIn);
  const members = useStableList(membersIn, sameMember);
  const customFields = useStableList(customFieldsIn);
  const sections = useStableList(sectionsIn);
  // read-only strips every write path at the source
  const patch = readOnly ? undefined : onPatch;
  const quickAddFn = readOnly ? undefined : onQuickAdd;
  const bulkEnabled = !readOnly && !!onBulkPatch;
  const [adding, setAdding] = useState<{ key: string; at: "top" | "end" } | null>(null);
  const [addDraft, setAddDraft] = useState("");
  const [live, setLive] = useState(""); // screen-reader announcements (keyboard moves, range selection)
  // cheap windowing: very large groups render a capped slice with a "show all"
  const ROW_CAP = 100;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [newSection, setNewSection] = useState<string | null>(null);
  const sortMode = sort || "manual";
  const external = !!groupsIn;
  // manual reorder only in manual order, with the list's own grouping; not under Due grouping
  // (dragging across due buckets has no well-defined date, so it would just snap back)
  const dragEnabled = !!patch && !smart && sortMode === "manual" && groupBy !== "due" && !external;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMenu, setBulkMenu] = useState<null | "status" | "priority" | "assignee" | "due" | "project">(null);
  const isoDay = (n: number) => isoFrom(KANBO_TODAY, n);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; half: "top" | "bottom" } | null>(null);
  const selectionActive = bulkEnabled && selected.size > 0;
  const lastSelRef = useRef<string | null>(null);
  const clearSel = () => { setSelected(new Set()); setBulkMenu(null); lastSelRef.current = null; };

  // ---- per-render lookups (built once, shared by every row) ----
  const { childrenOf, doneKids, byId } = useMemo(() => {
    const childrenOf = new Map<string, Task[]>();
    const doneKids = new Map<string, number>();
    const byId = new Map<string, Task>();
    for (const t of allTasks) {
      byId.set(t.id, t);
      if (!t.parentId) continue;
      const arr = childrenOf.get(t.parentId);
      if (arr) arr.push(t); else childrenOf.set(t.parentId, [t]);
      if (t.status === "done") doneKids.set(t.parentId, (doneKids.get(t.parentId) ?? 0) + 1);
    }
    return { childrenOf, doneKids, byId };
  }, [allTasks]);
  const presentIds = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks]);
  const ids = [...selected].filter((id) => presentIds.has(id));
  const findTask = (id: string) => tasks.find((t) => t.id === id) ?? byId.get(id);

  // sub-tasks follow their parent when it moves project (sections belong to the old project, so they're cleared)
  const descendantsOf = (id: string): Task[] => {
    const out: Task[] = [];
    const seen = new Set<string>([id]);
    const walk = (pid: string) => { for (const c of childrenOf.get(pid) ?? NO_TASKS) { if (seen.has(c.id)) continue; seen.add(c.id); out.push(c); walk(c.id); } };
    walk(id);
    return out;
  };
  const workspaceOf = (projectId: string) => (projects.find((p) => p.id === projectId) ?? getProject(projectId))?.workspaceId ?? null;
  const moveFamily = (id: string, projectId: string) => {
    const ws = workspaceOf(projectId);
    for (const c of descendantsOf(id)) if (c.projectId !== projectId) patch?.(c.id, { projectId, workspaceId: ws, sectionId: undefined });
  };

  const applyPatch = (p: Partial<Task>) => {
    if (p.projectId !== undefined) {
      // bulk project move: bring each selected task's sub-tasks along and keep the workspace in
      // step; sections belong to the old project, so they're cleared — but only for tasks that
      // actually change project (re-picking the current project mustn't wipe their sections)
      const all = new Set(ids);
      for (const id of ids) for (const c of descendantsOf(id)) all.add(c.id);
      const moving = [...all].filter((id) => (byId.get(id) ?? tasks.find((t) => t.id === id))?.projectId !== p.projectId);
      if (moving.length) onBulkPatch?.(moving, { ...p, workspaceId: workspaceOf(p.projectId), sectionId: undefined });
    } else onBulkPatch?.(ids, p);
    clearSel();
  };
  const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];

  // a row control's edit: applied at once, and registered for ⌘Z (the previous values come back)
  const onEdit = useStableCallback((t: Task, p: Partial<Task>, what: string) => {
    if (!patch) return;
    const before: Partial<Task> = {};
    for (const k of Object.keys(p) as (keyof Task)[]) (before as Record<string, unknown>)[k] = t[k];
    patch(t.id, p);
    pushUndo(`${what} of “${t.title}”`, () => patch(t.id, before));
  });

  // ---- phones: swipes and the long-press sheet. Their changes say what happened, with an Undo ----
  const toast = useOptionalToast();
  const toastEdit = useStableCallback((t: Task, p: Partial<Task>, what: string, message: string) => {
    if (!patch) return;
    const before: Partial<Task> = {};
    for (const k of Object.keys(p) as (keyof Task)[]) (before as Record<string, unknown>)[k] = t[k];
    patch(t.id, p);
    // one undo, whichever runs it first: the toast's button or ⌘Z
    let undone = false;
    let remove = () => {};
    const undo = () => { if (undone) return; undone = true; remove(); patch(t.id, before); };
    remove = pushUndo(`${what} of “${t.title}”`, undo);
    toast?.action(message, "Undo", undo, {});
  });
  const onQuickDue = useStableCallback((t: Task, iso: string | undefined) => {
    if ((iso ?? undefined) === (t.dueDate ?? undefined)) return;
    toastEdit(t, iso ? { dueDate: iso } : { dueDate: undefined, dueTime: undefined }, "Due date",
      iso ? `“${t.title}” is now due ${dueWords(iso)}` : `“${t.title}” has no due date now`);
  });
  // the tray's (or the sheet's) Pick opens the row's own date picker; what it picks gets the same toast
  const pickFor = useRef<{ id: string; at: number } | null>(null);
  const onPickDue = useStableCallback((id: string) => {
    pickFor.current = { id, at: Date.now() };
    const open = () => findRowEl("data-row-due", id)?.querySelector<HTMLElement>("button")?.click();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(open); else window.setTimeout(open, 16);
  });
  const onDue = useStableCallback((t: Task, p: Partial<Task>) => {
    const pick = pickFor.current;
    pickFor.current = null;
    if (pick && pick.id === t.id && Date.now() - pick.at < 120000) {
      toastEdit(t, p, "Due date", p.dueDate ? `“${t.title}” is now due ${dueWords(p.dueDate)}` : `“${t.title}” has no due date now`);
    } else onEdit(t, p, "Due date");
  });
  const [sheetId, setSheetId] = useState<string | null>(null);
  const onLongPress = useStableCallback((id: string) => setSheetId(id));

  // ---- completing a row: it settles in place (strike + filled glyph), then moves ----
  const settleRef = useRef(new Map<string, { key: string; until: number }>());
  const settledAt = useRef(new Map<string, number>());
  const [settleTick, setSettleTick] = useState(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);
  const lastGroupsRef = useRef<Group[]>([]);
  const onCheck = useStableCallback((id: string) => {
    const t = findTask(id);
    const g = lastGroupsRef.current.find((x) => x.items.some((i) => i.id === id));
    if (t && t.status !== "done" && g) {
      settleRef.current.set(id, { key: g.key, until: Date.now() + SETTLE_MS });
      timers.current.push(window.setTimeout(() => {
        settleRef.current.delete(id);
        settledAt.current.set(id, Date.now());
        setSettleTick((n) => n + 1);
      }, SETTLE_MS));
    }
    onToggle(id);
  });

  // ---- grouping ----
  const groups: Group[] = useMemo(() => {
    const now = Date.now();
    const settling = new Map([...settleRef.current].filter(([, s]) => s.until > now).map(([id, s]) => [id, s.key] as const));
    // a row that is settling sorts as it did before it was ticked off
    const doneish = (t: Task) => t.status === "done" && !settling.has(t.id);
    const sortFn = (a: Task, b: Task) => {
      if (doneish(a) && !doneish(b)) return 1;
      if (doneish(b) && !doneish(a)) return -1;
      if (smart) return b.aiScore - a.aiScore;
      if (sortMode === "due") {
        if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
      } else if (sortMode === "priority") {
        const dr = PRIORITY_META[b.priority].rank - PRIORITY_META[a.priority].rank;
        if (dr !== 0) return dr;
      } else if (sortMode === "title") {
        const dt = a.title.localeCompare(b.title);
        if (dt !== 0) return dt;
      }
      // default / tiebreak: manual position order
      const dp = (a.position ?? 0) - (b.position ?? 0);
      return dp !== 0 ? dp : PRIORITY_META[b.priority].rank - PRIORITY_META[a.priority].rank;
    };

    // sub-tasks nest under their parent row, so exclude them from the top-level
    // grouping WHEN their parent is also in view; a sub-task whose parent isn't
    // here (e.g. an assigned sub-task in "My tasks") still shows as its own row.
    const topLevel = (list: Task[]) => list.filter((t) => !t.parentId || !presentIds.has(t.parentId));

    let base: Group[];
    if (groupsIn) {
      base = groupsIn.map((g) => ({ key: g.key, label: g.label, tone: g.tone, items: topLevel(g.items), addable: g.addable, addPatch: g.addPatch }));
    } else {
      const top = topLevel(tasks);
      if (groupBy === "status") {
        base = STATUS_ORDER.map((s) => ({ key: s, label: STATUS_META[s].label, items: top.filter((t) => t.status === s) }));
      } else if (groupBy === "priority") {
        base = (["urgent", "high", "medium", "low"] as const).map((p) => ({ key: p, label: PRIORITY_META[p].label + " priority", tone: p === "urgent" ? "signal" as const : undefined, items: top.filter((t) => t.priority === p) }));
      } else if (groupBy === "project") {
        // group by the projects actually present in these tasks (real accounts, not just the demo seed)
        base = [...new Set(top.map((t) => t.projectId))]
          .map((pid) => ({ pid, p: getProject(pid) }))
          .filter((x) => !!x.p)
          .map(({ pid, p }) => ({ key: pid, label: p!.name, items: top.filter((t) => t.projectId === pid) }));
      } else if (groupBy === "section") {
        // named sections (kept even when empty, so you can add into them) + a "No section" bucket
        const ordered = [...sections].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        base = ordered.map((s) => ({ key: s.id, label: s.name, keep: true, items: top.filter((t) => t[sectionField] === s.id) }));
        const none = top.filter((t) => !t[sectionField] || !ordered.some((s) => s.id === t[sectionField]));
        if (none.length || ordered.length === 0) base.push({ key: "__none", label: "No section", keep: ordered.length === 0, items: none });
      } else if (groupBy === "due") {
        // plain due-date buckets (My tasks passes its own, which also know about Today's plan)
        const todayMid = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate()).getTime();
        const dueBucket = (t: Task): string => {
          if (t.status === "done") return "completed";
          if (!t.dueDate) return "nodate";
          const d = new Date(t.dueDate + "T00:00:00").getTime();
          if (d < todayMid) return "overdue";
          if (d === todayMid) return "today";
          if (d <= todayMid + 7 * 86400000) return "week";
          return "later";
        };
        const BUCKETS: { key: string; label: string; tone?: "signal" }[] = [
          { key: "overdue", label: "Overdue", tone: "signal" }, { key: "today", label: "Today" }, { key: "week", label: "This week" },
          { key: "later", label: "Later" }, { key: "nodate", label: "No date" }, { key: "completed", label: "Completed" },
        ];
        base = BUCKETS.map((b) => ({ ...b, items: top.filter((t) => dueBucket(t) === b.key), addable: b.key !== "completed" }));
      } else {
        base = [{ key: "all", label: smart ? "Kanbo's order" : "All tasks", items: [...top] }];
      }
    }

    // settling rows stay in the group they were ticked off in (brought back from wherever
    // the new data put them — even from outside `tasks`, when done work is hidden)
    if (settling.size) {
      const prev = lastGroupsRef.current;
      for (const [id, key] of settling) {
        const t = findTask(id);
        if (!t) continue;
        for (const g of base) { const i = g.items.findIndex((x) => x.id === id); if (i >= 0) g.items.splice(i, 1); }
        let target = base.find((g) => g.key === key);
        if (!target) {
          const meta = prev.find((g) => g.key === key);
          if (!meta) continue;
          target = { ...meta, items: [] };
          const order = prev.map((g) => g.key);
          let at = 0;
          for (let j = order.indexOf(key) - 1; j >= 0; j--) { const k = base.findIndex((g) => g.key === order[j]); if (k >= 0) { at = k + 1; break; } }
          base.splice(at, 0, target);
        }
        target.items.push(t);
      }
    }
    return base.map((g) => ({ ...g, items: [...g.items].sort(sortFn) })).filter((g) => g.items.length || g.keep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, groupsIn, presentIds, groupBy, smart, sortMode, sections, sectionField, settleTick, byId]);
  useEffect(() => { lastGroupsRef.current = groups; });

  // rows in on-screen order (respecting the per-group cap) — for shift-click ranges
  const visibleOrder = useMemo(() => groups.flatMap((g) => (collapsed.has(g.key) ? [] : expandedGroups.has(g.key) ? g.items : g.items.slice(0, ROW_CAP)).map((t) => t.id)), [groups, expandedGroups, collapsed]);

  // which group a task sits in for the current grouping
  const groupKeyOf = (t: Task): string => groupBy === "status" ? t.status : groupBy === "priority" ? t.priority : groupBy === "project" ? t.projectId : groupBy === "section" ? (t[sectionField] ?? "__none") : "all";
  // the field change that moves a task into group `key`
  const groupPatch = (dragged: Task, key: string): Partial<Task> => {
    if (groupKeyOf(dragged) === key) return {};
    if (groupBy === "status") { const s = key as Task["status"]; return { status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined }; }
    if (groupBy === "priority") return { priority: key as Priority };
    if (groupBy === "project") return { projectId: key, sectionId: undefined };
    if (groupBy === "section") { const v = key === "__none" ? undefined : key; return sectionField === "mySectionId" ? { mySectionId: v } : { sectionId: v }; }
    return {};
  };
  // focus / scroll requests carried across the re-render that a move causes (see the effect below)
  const pendingFocus = useRef<{ id: string; part: RowFocusPart; scroll: boolean; at: number } | null>(null);
  const pendingReveal = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // phones, or a column squeezed by the docked task panel: the bulk bar's buttons are icons
  const iconBulk = useFloatBounds(rootRef) || isMobile;
  // write a placement: re-space any tied neighbours first, then move the task
  const applyPlan = (id: string, plan: DropPlan, extra: Partial<Task> = {}) => {
    for (const r of plan.respace) patch?.(r.id, { position: r.position });
    patch?.(id, { ...extra, position: plan.position });
  };
  // drop a dragged task next to a target row, or with no target at the top of a group
  // (header) / its end (half "bottom", the "Add task" row): change its group field if needed, and reposition
  const dropInto = (draggedId: string, g: Group, targetId: string | null, half: "top" | "bottom") => {
    setDragId(null); setHover(null);
    if (draggedId === targetId) return;
    const dragged = tasks.find((t) => t.id === draggedId);
    if (!dragged) return;
    const p = groupPatch(dragged, g.key);
    const willBeDone = (p.status ?? dragged.status) === "done";
    const plan = planDrop(g.items, draggedId, targetId, half, willBeDone);
    if (plan.unchanged && Object.keys(p).length === 0) return; // dropped back where it was
    markJustLanded(draggedId);
    applyPlan(draggedId, plan, p);
    if (p.projectId) moveFamily(draggedId, p.projectId);
    // a (sticky) header or "Add task" drop can land it out of sight — bring it into view
    if (!targetId) pendingReveal.current = draggedId;
  };
  const onRowDrop = useStableCallback((draggedId: string, targetId: string, half: "top" | "bottom") => {
    const g = groups.find((x) => x.items.some((t) => t.id === targetId));
    if (!g) { setDragId(null); setHover(null); return; }
    dropInto(draggedId, g, targetId, half);
  });
  const onPickup = useStableCallback((id: string) => { setDragId(id || null); if (!id) setHover(null); });
  // dragover fires ~60×/s — only re-render when the hovered row or half actually changes
  const onHoverRow = useStableCallback((id: string, half: "top" | "bottom") => setHover((h) => h && h.id === id && h.half === half ? h : { id, half }));
  // group drop targets: the header drops at the top of the group, the "Add task" row at its end
  const groupDropProps = (g: Group, where: "top" | "end") => dragEnabled ? {
    onDragOver: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); onHoverRow((where === "top" ? "hdr:" : "add:") + g.key, "bottom"); },
    onDrop: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); dropInto(e.dataTransfer.getData("text/kanbo-task"), g, null, where === "top" ? "top" : "bottom"); },
  } : {};

  // A change can move a row into another group (new status under Status grouping, a
  // completed task under Due…), which re-mounts it and drops keyboard focus on <body>.
  // The row asks for focus back on the same control; after the re-render it's restored.
  const onRefocus = useStableCallback((id: string, part: RowFocusPart, scroll: boolean) => { pendingFocus.current = { id, part, scroll, at: Date.now() }; });
  const findRowEl = (attr: string, id: string) => Array.from(rootRef.current?.querySelectorAll<HTMLElement>(`[${attr}]`) ?? []).find((n) => n.getAttribute(attr) === id);
  useEffect(() => {
    const rid = pendingReveal.current;
    if (rid) { pendingReveal.current = null; findRowEl("data-row-title", rid)?.closest<HTMLElement>(".ktv-rowwrap")?.scrollIntoView?.({ block: "nearest" }); }
    const pf = pendingFocus.current;
    if (!pf) return;
    if (Date.now() - pf.at > 2000) { pendingFocus.current = null; return; } // the change never landed (cancelled, filtered out…)
    const host = findRowEl("data-row-" + pf.part, pf.id);
    const el = host && (host.matches("button, input") ? host : host.querySelector<HTMLElement>("button, input"));
    if (!el) return; // not rendered yet — try again on the next render
    // only when the change actually lost focus — never pull it from wherever the user went
    const ae = document.activeElement;
    if (ae === el) return; // still here (the row hasn't moved yet): keep waiting
    if (ae && ae !== document.body) { pendingFocus.current = null; return; }
    el.focus({ preventScroll: !pf.scroll });
    // a row that's settling moves again in a moment: follow it there too
    if (!settleRef.current.has(pf.id)) pendingFocus.current = null;
  });

  // keyboard reorder: Alt+↑/↓ on a row title moves it one place within its group
  const onMoveBy = useStableCallback((id: string, dir: -1 | 1) => {
    const g = groups.find((x) => x.items.some((t) => t.id === id));
    if (!g) return;
    const i = g.items.findIndex((t) => t.id === id);
    const me = g.items[i], other = g.items[i + dir];
    // done rows always sit at the bottom, so an open task can't hop past them (and vice versa)
    if (!other || (me.status === "done") !== (other.status === "done")) { setLive(`“${me.title}” can't move any further ${dir < 0 ? "up" : "down"}`); return; }
    const plan = planDrop(g.items, id, other.id, dir < 0 ? "top" : "bottom", me.status === "done");
    if (plan.unchanged) return;
    markJustLanded(id);
    onRefocus(id, "title", true);
    applyPlan(id, plan);
    setLive(`Moved “${me.title}” ${dir < 0 ? "above" : "below"} “${other.title}”`);
  });

  // selection: click toggles; shift-click selects the range from the last clicked row
  const onSelectRow = useStableCallback((id: string, range: boolean) => {
    const last = lastSelRef.current;
    if (range && last && last !== id) {
      const a = visibleOrder.indexOf(last), b = visibleOrder.indexOf(id);
      if (a >= 0 && b >= 0) {
        const span = visibleOrder.slice(Math.min(a, b), Math.max(a, b) + 1);
        setSelected((prev) => { const n = new Set(prev); span.forEach((x) => n.add(x)); return n; });
        lastSelRef.current = id;
        setLive(`${span.length} tasks selected`);
        return;
      }
    }
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    lastSelRef.current = id;
  });
  const toggleGroupSelection = (g: Group) => {
    const all = g.items.every((t) => selected.has(t.id));
    setSelected((prev) => { const n = new Set(prev); g.items.forEach((t) => { if (all) n.delete(t.id); else n.add(t.id); }); return n; });
  };
  // Escape clears a selection — but only when nothing else claims that Escape. It's captured
  // (so it runs before App closes the task panel, while the panel is still on screen) and it
  // stands aside when: a task panel / modal is open (Escape closes that — peeking at a task
  // mustn't cost a 40-task selection), a menu is open (it closes first), focus is in a text
  // field (Escape cancels the rename / quick-add), or focus is somewhere outside the list.
  useEffect(() => {
    if (!selectionActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !rootRef.current?.contains(t)) return;
      if (isTypingTarget(t)) return;
      if (document.querySelector('[aria-modal="true"], [data-kpop]')) return;
      clearSel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectionActive]);

  // ---- keyboard triage: J/K, X, Enter, ⌘↵, S/P/D/A (+ E/T/M/L) ----
  const [listMenu, setListMenu] = useState<null | { kind: "move" | "labels"; id: string }>(null);
  const listMenuAnchor = useRef<HTMLElement | null>(null);
  const kb = useListKeyboard({
    rootRef, itemSelector: "[data-row-id]", enabled: keyboard,
    idOf: (el) => el.dataset.rowId,
    focusTargetOf: (el) => el.querySelector<HTMLElement>("[data-row-title]"),
    onOpen,
    onComplete: (id) => { if (readOnly) return; onRefocus(id, "title", true); onCheck(id); },
    onToggleSelect: bulkEnabled ? (id) => onSelectRow(id, false) : undefined,
    onClear: clearSel,
    onAction: (action: ListKeyAction, id: string, el: HTMLElement) => {
      if (readOnly || !patch) return;
      const t = findTask(id);
      if (!t) return;
      const click = (sel: string) => el.querySelector<HTMLElement>(sel)?.click();
      if (action === "status") el.querySelector<HTMLElement>("[data-row-check] button")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      else if (action === "priority") click("[data-row-priority] button");
      else if (action === "due") click("[data-row-due] button");
      else if (action === "assign") click("[data-row-assignee] button");
      else if (action === "rename") el.querySelector<HTMLElement>("[data-row-title]")?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
      else if (action === "today") {
        onEdit(t, { planToday: !t.planToday }, "Today");
        setLive(t.planToday ? `Took “${t.title}” off Today` : `Added “${t.title}” to Today`);
      } else if ((action === "move" && projects.length > 0) || (action === "labels" && allTags && Object.keys(allTags).length > 0)) {
        listMenuAnchor.current = el.querySelector<HTMLElement>("[data-row-title]") ?? el;
        setListMenu({ kind: action === "move" ? "move" : "labels", id });
      }
    },
  });
  const menuTask = listMenu ? findTask(listMenu.id) : undefined;

  // ---- sticky group headers: see-through on the page, opaque once they stick ----
  // A header is stuck when its group has scrolled up past it. Checked on any scroll that
  // moves this list (the list itself, or the page on phones) and after every render (groups
  // open, close, fill and empty without one), reading every header before writing any.
  const stickyCheck = useRef<null | (() => void)>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => window.setTimeout(cb, 16);
    const unraf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : window.clearTimeout;
    let frame = 0;
    const update = () => {
      frame = 0;
      const heads = Array.from(root.querySelectorAll<HTMLElement>(".ktv-ghead"));
      const stuck = heads.map((h) => !!h.parentElement && h.parentElement.getBoundingClientRect().top < h.getBoundingClientRect().top - 0.5);
      heads.forEach((h, i) => { if (stuck[i]) h.dataset.stuck = "true"; else delete h.dataset.stuck; });
    };
    const schedule = () => { if (!frame) frame = raf(update); };
    const onScroll = (e: Event) => { const t = e.target; if (t === document || (t instanceof Node && t.contains(root))) schedule(); };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    stickyCheck.current = schedule;
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", schedule);
      if (frame) unraf(frame);
      stickyCheck.current = null;
    };
  }, []);
  useEffect(() => { stickyCheck.current?.(); });

  // ---- My tasks ?due=…: scroll to that group and flash it ----
  useEffect(() => {
    if (!focusGroup) return;
    const el = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-group-key]") ?? []).find((n) => n.dataset.groupKey === focusGroup);
    if (!el) return;
    el.scrollIntoView?.({ block: "start" });
    el.classList.remove("ktv-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("ktv-flash");
    const t = window.setTimeout(() => el.classList.remove("ktv-flash"), 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusGroup, focusKey]);

  // Only offer to take focus for a scope that was genuinely empty when opened —
  // never because a search/filter emptied the list (that stole the user's typing).
  const [scope, setScope] = useState(() => ({ key: sectionProjectId, empty: tasks.length === 0 }));
  if (scope.key !== sectionProjectId) setScope({ key: sectionProjectId, empty: tasks.length === 0 });
  const nothing = external ? groups.length === 0 : tasks.length === 0;
  const showNoMatch = nothing && filtered;
  const showOnboarding = nothing && !filtered && !(groupBy === "section" && sections.length > 0 && !external);
  const emptyInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!showOnboarding || emptyState || !scope.empty || filtered) return;
    const el = emptyInputRef.current, ae = document.activeElement;
    if (!el || ae === el) return;
    // never take over a field someone is typing in (the search box), or reach behind an open
    // modal — but a focused button (the sidebar link that opened this project) is fine
    if (isTypingTarget(ae) || document.querySelector('[aria-modal="true"]')) return;
    el.focus({ preventScroll: true });
  }, [showOnboarding, emptyState, scope.empty, scope.key, filtered]);

  // sensible group key for the empty-state quick-add (project view falls back to the route's project)
  const emptyKey = groupBy === "status" ? "todo" : groupBy === "priority" ? "medium" : groupBy === "section" ? "__none" : "";
  const quickAdd = (groupKey: string, extra?: Partial<Task>) => {
    const v = addDraft.trim(); if (!v) { setAdding(null); return; }
    const partial: Partial<Task> & { title: string } = { ...extra, title: v };
    if (!extra && !external) {
      if (groupBy === "status") partial.status = groupKey as Task["status"];
      else if (groupBy === "priority") partial.priority = groupKey as Priority;
      else if (groupBy === "project") partial.projectId = groupKey;
      else if (groupBy === "section") { const s = groupKey === "__none" ? undefined : groupKey; if (sectionField === "mySectionId") partial.mySectionId = s; else partial.sectionId = s; }
      else if (groupBy === "due") { const d = dueDateForBucket(groupKey); if (d) partial.dueDate = d; }
    }
    quickAddFn?.(partial);
    setAddDraft("");
  };
  const recentlySettled = (id: string) => { const t = settledAt.current.get(id); return !!t && Date.now() - t < 1500; };
  const touchSelect = isTouch && selectionActive;
  // phones: rows swipe (not while a selection is under way: taps toggle it then) and long-press for the sheet
  const swipeRows = isMobile && !!patch && !selectionActive;
  // (and don't also offer the browser's own drag, which would fight both on the phones that have it)
  const sheetable = isMobile && !!patch;
  const sheetTask = sheetId ? findTask(sheetId) : undefined;
  const lastSheetTask = useRef<Task | undefined>(undefined);
  if (sheetTask) lastSheetTask.current = sheetTask;
  const doneKey = isMac() ? "⌘↵" : "Ctrl ↵";

  return (
    <div ref={rootRef} className="ktv ktv-scroll" data-density={compact ? "compact" : undefined}>
      <div className="sr-only" role="status" aria-live="polite">{live}</div>
      <div className="ktv-list" role="region" aria-label={label} data-selecting={selectionActive || undefined}>
        {smart && !nothing && (
          <p className="ktv-notice-ai"><AiMark size={14} /> In Kanbo's order: urgent work, and work that unblocks others, first.</p>
        )}
        {showNoMatch ? (
          <div role="status" className="ktv-empty">
            <EmptyState art="search" title="No tasks match these filters" body="Try a different search, or clear the filters to see every task."
              action={onClearFilters && <Button variant="secondary" icon="x" onClick={onClearFilters}>Clear filters</Button>} />
          </div>
        ) : showOnboarding ? (
          emptyState ?? (
            <div className="ktv-empty">
              <EmptyState art="tasks" title="No tasks yet"
                body={quickAddFn ? "Type your first task below, or import a whole list." : "Tasks added here will show up in this list."}
                action={quickAddFn && (
                  <div className="ktv-empty-add">
                    <input ref={emptyInputRef} value={addDraft} onChange={(e) => setAddDraft(e.target.value)} aria-label="New task name"
                      onKeyDown={(e) => { if (e.key === "Enter") quickAdd(emptyKey); else if (e.key === "Escape") setAddDraft(""); }}
                      placeholder="Task name, then Enter…" />
                    <Button variant="primary" onClick={() => quickAdd(emptyKey)} disabled={!addDraft.trim()}>Add</Button>
                    {onOpenImport && <Button variant="ghost" icon="plus" onClick={onOpenImport} title="Import a list of tasks">Import</Button>}
                  </div>
                )} />
            </div>
          )
        ) : groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          const shown = isCollapsed ? NO_TASKS : expandedGroups.has(g.key) ? g.items : g.items.slice(0, ROW_CAP);
          const nSel = selectionActive ? g.items.reduce((n, t) => n + (selected.has(t.id) ? 1 : 0), 0) : 0;
          const canAddHere = !!quickAddFn && g.addable !== false;
          const headerHot = !!dragId && hover?.id === "hdr:" + g.key;
          const addHot = !!dragId && hover?.id === "add:" + g.key;
          // touch screens have no hover to reveal the group select-all, so an invisible box would
          // sit under a stray tap — offer it there only once a selection is under way (and visible)
          const offerSelectAll = bulkEnabled && g.items.length > 0 && (!isTouch || selectionActive);
          const isSection = !external && groupBy === "section" && g.key !== "__none";
          const addField = (at: "top" | "end") => adding?.key === g.key && adding.at === at && (
            <div className="ktv-add" data-open="true" style={{ cursor: "default" }}>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input autoFocus className="ktv-add-field" value={addDraft} onChange={(e) => setAddDraft(e.target.value)} aria-label={`New task in ${g.label}`}
                onKeyDown={(e) => { if (e.key === "Enter") quickAdd(g.key, g.addPatch); else if (e.key === "Escape") { setAddDraft(""); setAdding(null); } }}
                onBlur={() => { quickAdd(g.key, g.addPatch); setAdding(null); }} placeholder="Task name, then Enter…" />
            </div>
          );
          return (
            <section key={g.key} className="ktv-group" data-group-key={g.key}>
              <GroupHeader groupKey={g.key} label={g.label} tone={g.tone} count={g.items.length} collapsed={isCollapsed}
                onToggleCollapse={() => setCollapsed((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
                onRename={!readOnly && isSection && onRenameSection ? (name) => onRenameSection(g.key, name) : undefined}
                onDelete={!readOnly && isSection && onDeleteSection ? () => { if (window.confirm(`Delete section "${g.label}"? Its tasks move to No section.`)) onDeleteSection(g.key); } : undefined}
                onAdd={canAddHere ? () => { setAddDraft(""); setAdding({ key: g.key, at: "top" }); if (isCollapsed) setCollapsed((s) => { const n = new Set(s); n.delete(g.key); return n; }); } : undefined}
                selectState={offerSelectAll ? (nSel === 0 ? "none" : nSel === g.items.length ? "all" : "some") : undefined}
                onSelectAll={offerSelectAll ? () => toggleGroupSelection(g) : undefined}
                dropActive={headerHot} {...groupDropProps(g, "top")} />
              {addField("top")}
              <div className={entrance}>{shown.map((t) => (
                <TaskRow key={t.id} task={t} childTasks={childrenOf.get(t.id) ?? NO_TASKS} childDone={doneKids.get(t.id) ?? 0} byId={byId}
                  onOpen={onOpen} onToggle={onToggle} onToggleSubtask={onToggleSubtask} onCheck={onCheck} smart={smart} isMobile={isMobile} readOnly={readOnly}
                  selected={selected.has(t.id)} selectionActive={selectionActive} onSelect={bulkEnabled ? onSelectRow : undefined} touchSelect={touchSelect}
                  draggable={dragEnabled && !sheetable} dragging={dragId === t.id} dropHint={hover && hover.id === t.id && dragId !== t.id ? hover.half : null}
                  onPickup={onPickup} onHover={onHoverRow} onRowDrop={onRowDrop} onMoveBy={dragEnabled ? onMoveBy : undefined} onRefocus={onRefocus}
                  onEdit={patch ? onEdit : undefined} members={members} customFields={customFields}
                  showProject={showProject} quietAssignee={!!quietAssigneeFor && t.assigneeId === quietAssigneeFor}
                  cursor={kb.cursor === t.id} active={activeId === t.id} celebrate={!recentlySettled(t.id)}
                  meta={renderMeta?.(t)} action={renderAction?.(t)}
                  swipe={swipeRows} onQuickDue={onQuickDue} onPickDue={onPickDue} onDue={onDue} onLongPress={sheetable ? onLongPress : undefined} />
              ))}</div>
              {!isCollapsed && !expandedGroups.has(g.key) && g.items.length > ROW_CAP && (
                <button type="button" className="ktv-more" onClick={() => setExpandedGroups((s) => new Set(s).add(g.key))}>
                  <Icon name="chevronDown" size={14} /> Show all {g.items.length}
                </button>
              )}
              {!isCollapsed && canAddHere && (addField("end") || (
                // also a drop target: a task dropped here goes to the END of the group (the hint line shows where)
                <button type="button" className="ktv-add" data-drop={addHot || undefined} onClick={() => { setAddDraft(""); setAdding({ key: g.key, at: "end" }); }}
                  aria-label={`Add task to ${g.label}`} {...groupDropProps(g, "end")}>
                  <span><Icon name="plus" size={14} /></span>Add task
                </button>
              ))}
            </section>
          );
        })}
        {!readOnly && !showNoMatch && !external && groupBy === "section" && onCreateSection && (sectionProjectId || sections[0]?.projectId || tasks[0]?.projectId) && (
          newSection === null ? (
            <button type="button" className="ktv-newsection" onClick={() => setNewSection("")}><Icon name="plus" size={14} /> Add section</button>
          ) : (
            <div style={{ margin: "16px var(--tv-gutter) 0" }}>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input autoFocus className="ktv-inline-edit" value={newSection} placeholder="Section name, then Enter" aria-label="New section name"
                onChange={(e) => setNewSection(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { const n = newSection.trim(); if (n) onCreateSection(sectionProjectId ?? sections[0]?.projectId ?? tasks[0]!.projectId, n); setNewSection(null); }
                  else if (e.key === "Escape") setNewSection(null);
                }} onBlur={() => setNewSection(null)} />
            </div>
          )
        )}
        {footer}
      </div>
      <div aria-hidden="true" style={{ height: selectionActive ? (isMobile ? 150 : 80) : 16 }} />

      {listMenu && menuTask && (
        <Popover open anchorRef={listMenuAnchor} onClose={() => setListMenu(null)} minWidth={220} maxHeight={320}
          label={listMenu.kind === "move" ? `Move “${menuTask.title}” to a project` : `Labels for “${menuTask.title}”`}>
          {listMenu.kind === "move" ? projects.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={menuTask.projectId === p.id} className="ktv-mi"
              onClick={() => { setListMenu(null); if (p.id === menuTask.projectId) return; onEdit(menuTask, { projectId: p.id, workspaceId: workspaceOf(p.id), sectionId: undefined }, "Project"); moveFamily(menuTask.id, p.id); }}>
              <ProjectDot color={p.color} /> <span className="truncate">{p.name}</span>{menuTask.projectId === p.id && <CurrentMark />}
            </button>
          )) : Object.entries(allTags ?? {}).map(([id, tg]) => {
            const on = (menuTask.tags ?? []).includes(id);
            return (
              <button key={id} type="button" role="menuitemcheckbox" aria-checked={on} className="ktv-mi"
                onClick={() => onEdit(menuTask, { tags: on ? menuTask.tags.filter((x) => x !== id) : [...(menuTask.tags ?? []), id] }, "Labels")}>
                <span className="ktv-dot" style={{ background: projectPaint(tg.color).solid, margin: "0 4px" }} /> <span className="truncate">{tg.label}</span>{on && <CurrentMark />}
              </button>
            );
          })}
        </Popover>
      )}

      {/* the long-press sheet keeps its task through the exit fade */}
      <Sheet open={!!sheetTask} onClose={() => setSheetId(null)} side="bottom" title={lastSheetTask.current?.title}
        label={lastSheetTask.current ? `Actions for “${lastSheetTask.current.title}”` : "Task actions"}>
        {lastSheetTask.current && (
          <RowActionSheet task={lastSheetTask.current} canSelect={bulkEnabled}
            onOpen={(id) => { setSheetId(null); onOpen(id); }}
            onStatus={(t, s) => {
              setSheetId(null);
              if (s === t.status) return;
              // finishing, or reopening to To do, is the row's own completion toggle (the settle, and App's Undo toast)
              if (s === "done" || (t.status === "done" && s === "todo")) { onCheck(t.id); return; }
              toastEdit(t, { status: s, completedAt: undefined }, "Status", `“${t.title}” is now ${STATUS_META[s].label.toLowerCase()}`);
            }}
            onDue={(t, iso) => { setSheetId(null); onQuickDue(t, iso); }}
            onPickDue={(id) => { setSheetId(null); window.setTimeout(() => onPickDue(id), 200); }}
            onPriority={(t, pr) => { setSheetId(null); if (pr !== t.priority) toastEdit(t, { priority: pr }, "Priority", `“${t.title}” is now ${PRIORITY_META[pr].label.toLowerCase()} priority`); }}
            onToday={(t) => { setSheetId(null); toastEdit(t, { planToday: !t.planToday }, "Today", t.planToday ? `Took “${t.title}” off Today` : `Added “${t.title}” to Today`); }}
            onSelect={(id) => { setSheetId(null); onSelectRow(id, false); }} />
        )}
      </Sheet>

      {kb.hint && !selectionActive && (
        <div className="ktv-float ktv-hint" role="note" aria-label="Keyboard shortcuts for this list">
          <span><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
          <span><Kbd>X</Kbd> select</span>
          <span><Kbd>S</Kbd> status</span>
          <span><Kbd>D</Kbd> due</span>
          <span><Kbd>{doneKey}</Kbd> done</span>
          <span><Kbd>?</Kbd> all keys</span>
          <IconButton icon="x" size="sm" label="Hide these hints" onClick={kb.dismissHint} />
        </div>
      )}

      {selectionActive && (
        // centred with left/right insets (not translateX) so it can wrap within the screen on phones,
        // and on phones it sits above the bottom tab bar
        <div role="toolbar" aria-label="Bulk actions for selected tasks" className="ktv-float">
          <span className="ktv-float-count" aria-live="polite">{ids.length} selected</span>
          <span className="ktv-float-sep" aria-hidden="true" />
          <Button variant="ghost" size="sm" icon="check" onClick={() => applyPatch({ status: "done", completedAt: toLocalISO(new Date()) })} aria-label={iconBulk ? "Mark selected as done" : undefined}>{!iconBulk && "Done"}</Button>
          <BulkMenuButton label="Status" icon="layers" iconOnly={iconBulk} open={bulkMenu === "status"} onToggle={() => setBulkMenu((m) => m === "status" ? null : "status")}>
            {STATUS_ORDER.map((s) => (
              <button key={s} type="button" role="menuitem" className="ktv-mi" onClick={() => applyPatch({ status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined })}>
                <StatusGlyph status={s} size={14} readOnly /> {STATUS_META[s].label}
              </button>
            ))}
          </BulkMenuButton>
          <BulkMenuButton label="Priority" icon="flag" iconOnly={iconBulk} open={bulkMenu === "priority"} onToggle={() => setBulkMenu((m) => m === "priority" ? null : "priority")}>
            {PRIORITIES.map((p) => (
              <button key={p} type="button" role="menuitem" className="ktv-mi" onClick={() => applyPatch({ priority: p })}>
                <span style={{ display: "inline-grid", placeItems: "center", width: 16 }}><PriorityGlyph priority={p} /></span> {PRIORITY_META[p].label}
              </button>
            ))}
          </BulkMenuButton>
          <BulkMenuButton label="Due" icon="calendar" iconOnly={iconBulk} open={bulkMenu === "due"} onToggle={() => setBulkMenu((m) => m === "due" ? null : "due")}>
            <button type="button" role="menuitem" className="ktv-mi" onClick={() => applyPatch({ dueDate: isoDay(0) })}><Icon name="calendar" size={16} /> Today</button>
            <button type="button" role="menuitem" className="ktv-mi" onClick={() => applyPatch({ dueDate: isoDay(1) })}><Icon name="calendar" size={16} /> Tomorrow</button>
            <button type="button" role="menuitem" className="ktv-mi" onClick={() => applyPatch({ dueDate: isoDay(7) })}><Icon name="calendar" size={16} /> Next week</button>
            <button type="button" role="menuitem" className="ktv-mi" onClick={() => applyPatch({ dueDate: undefined })}><Icon name="x" size={16} /> Clear due date</button>
          </BulkMenuButton>
          {members.length > 0 && (
            <BulkMenuButton label="Assign" icon="user" iconOnly={iconBulk} open={bulkMenu === "assignee"} onToggle={() => setBulkMenu((m) => m === "assignee" ? null : "assignee")}>
              {members.map((m) => (
                <button key={m.id} type="button" role="menuitem" className="ktv-mi" onClick={() => applyPatch({ assigneeId: m.id })}>
                  <Avatar id={m.id} size={20} /> <span className="truncate">{m.name}</span>
                </button>
              ))}
            </BulkMenuButton>
          )}
          {projects.length > 0 && (
            <BulkMenuButton label="Project" icon="grid" iconOnly={iconBulk} open={bulkMenu === "project"} onToggle={() => setBulkMenu((m) => m === "project" ? null : "project")}>
              {projects.map((p) => (
                <button key={p.id} type="button" role="menuitem" className="ktv-mi" onClick={() => applyPatch({ projectId: p.id })}>
                  <ProjectDot color={p.color} /> <span className="truncate">{p.name}</span>
                </button>
              ))}
            </BulkMenuButton>
          )}
          {onBulkDelete && <Button variant="ghost" size="sm" icon="trash" onClick={() => { onBulkDelete(ids); clearSel(); }} aria-label={iconBulk ? "Delete selected tasks" : undefined} style={{ color: "var(--tv-signal)" }}>{!iconBulk && "Delete"}</Button>}
          <span className="ktv-float-sep" aria-hidden="true" />
          <IconButton icon="x" size="sm" label="Clear selection" onClick={clearSel} />
        </div>
      )}
    </div>
  );
}

export const bulkItemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, width: "100%", height: 32, padding: "0 8px", borderRadius: 6, border: "none",
  background: "transparent", cursor: "pointer", fontFamily: "var(--font-ui, var(--font-display))", fontSize: 13, fontWeight: 500, textAlign: "left", color: "var(--ink-2)",
};

/** The bulk bar and the key hints float at the bottom centre of the view's own column, not the
 *  window's: a docked task panel (≥ 1280) or the sidebar would otherwise cover one end. The
 *  column's edges go to CSS as --tv-float-l / --tv-float-r (read by .ktv-float). Returns true
 *  while the column is too narrow for a labelled bulk bar on one line (the panel docked at 1280). */
export function useFloatBounds(ref: React.RefObject<HTMLElement>, narrowBelow = 760): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      if (!r.width) return; // not laid out (tests, hidden)
      el.style.setProperty("--tv-float-l", `${Math.max(0, Math.round(r.left))}px`);
      el.style.setProperty("--tv-float-r", `${Math.max(0, Math.round(window.innerWidth - r.right))}px`);
      setNarrow(r.width < narrowBelow);
    };
    sync();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    window.addEventListener("resize", sync);
    return () => { ro?.disconnect(); window.removeEventListener("resize", sync); };
  }, [ref, narrowBelow]);
  return narrow;
}

/** A bulk-bar button with an upward menu. The menu renders through Popover
 *  (portal), so a wrapping bar can't clip it. `iconOnly` suits phones. */
export function BulkMenuButton({ label, icon, open, onToggle, children, iconOnly = false }: { label: string; icon: IconName; open: boolean; onToggle: () => void; children: React.ReactNode; iconOnly?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      {iconOnly
        ? <IconButton ref={ref} icon={icon} size="sm" label={label} onClick={onToggle} aria-haspopup="menu" aria-expanded={open} />
        : <Button ref={ref} variant="ghost" size="sm" icon={icon} onClick={onToggle} aria-haspopup="menu" aria-expanded={open}>{label}</Button>}
      <Popover open={open} anchorRef={ref} onClose={onToggle} side="top" label={label} minWidth={184} maxHeight={320}>
        {children}
      </Popover>
    </div>
  );
}
