/* ============================================================
   KANBO — Board (Kanban), Timeline (Gantt), Month calendar,
   Matrix and Files views
   ============================================================ */
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useId, memo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Icon, Avatar, wasJustLanded, markJustLanded, Segmented,
  StatusGlyph, PriorityGlyph, DateChip, ProjectDot, projectPaint, Button, IconButton, EmptyState,
} from "../primitives";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useListKeyboard, type ListKeyAction } from "../../hooks/useListKeyboard";
import { BulkMenuButton, CustomChips } from "./ListView";
import {
  getProject, getMember, dueState, fmtDue, TAGS,
  STATUS_META, STATUS_ORDER, PRIORITY_META, KANBO_TODAY, toLocalISO,
} from "../../data/data";
import type { Task, Status, Priority, Project, CalProvider, CalendarConnection, ExternalEvent, Attachment, CustomFieldDef } from "../../data/types";
import { store } from "../../data/store";
import { reportError } from "../../lib/monitoring";
import {
  addDaysISO, daysBetweenISO, mondayOf, switchCalendarPeriod, type CalendarPeriod,
  hideNestedSubtasks, assigneeColumnKey, UNASSIGNED_COL, FORMER_COL, NO_PROJECT_COL,
  planReorder, barSpan, clipSpan, effectiveStartISO, timelineMovePatch, timelineStartPatch,
  wipKeyFor, loadWipLimits, parseWipLimit, chunk, type BarSpan,
} from "./otherViewsLogic";
import "./taskViews.css";

export type BoardGroup = "status" | "priority" | "project" | "assignee";

const PROVIDER_META: Record<CalProvider, { label: string; color: string }> = {
  google: { label: "Google Calendar", color: "oklch(0.7 0.18 25)" },
  microsoft: { label: "Microsoft / Outlook", color: "oklch(0.62 0.16 250)" },
};

// fixed English names, so every browser says "Sep" (some en-GB builds say "Sept")
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const localDate = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00");
/** "Wed 30 Sep" · "30 Sep" · "Wednesday 30 September" */
const dayLabel = (iso: string, style: "short" | "dm" | "long" = "short") => {
  const d = localDate(iso);
  if (style === "dm") return `${d.getDate()} ${MON[d.getMonth()]}`;
  if (style === "long") return `${WD_LONG[d.getDay()]} ${d.getDate()} ${MON_LONG[d.getMonth()]}`;
  return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
};
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
/** Keyboard (not mouse) focus — browsers without :focus-visible just treat all focus as visible. */
const isFocusVisible = (el: Element) => { try { return el.matches(":focus-visible"); } catch { return true; } };

/* ---------------- anchored popover ----------------
   Menus render into <body> with fixed positioning taken from the trigger's
   rect, so they float above neighbouring cards and scroll containers instead
   of being drawn underneath the next card. They flip above the trigger when
   there's no room below and are clamped to the viewport. Menus get arrow-key
   navigation; dialogs trap focus. Escape closes and focus returns to the
   trigger. */
function Popover({ anchor, onClose, label, role = "menu", align = "start", minWidth = 160, maxWidth, children }: {
  anchor: HTMLElement | null; onClose: () => void; label: string;
  role?: "menu" | "dialog"; align?: "start" | "end"; minWidth?: number; maxWidth?: number; children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useFocusTrap<HTMLDivElement>(role === "dialog", onClose);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [ready, setReady] = useState(false);

  const place = useCallback(() => {
    const box = boxRef.current, panel = panelRef.current, bd = backdropRef.current;
    if (!box || !panel || !bd || !anchor || !anchor.isConnected) return;
    // calibrate CSS px against client px — Appearance → text size applies `zoom` to <html>
    box.style.left = "0px"; box.style.top = "0px"; panel.style.maxHeight = "";
    const r0 = box.getBoundingClientRect();
    box.style.left = "100px";
    const k = (box.getBoundingClientRect().left - r0.left) / 100 || 1;
    const view = bd.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    const gap = 6 * k, pad = 8 * k;
    const below = view.bottom - a.bottom - gap - pad, above = a.top - view.top - gap - pad;
    const flip = r0.height > below && above > below;
    const room = Math.max(120 * k, flip ? above : below);
    let x = align === "end" ? a.right - r0.width : a.left;
    x = Math.max(view.left + pad, Math.min(x, view.right - r0.width - pad));
    const y = flip ? a.top - gap - Math.min(r0.height, room) : a.bottom + gap;
    box.style.left = `${(x - r0.left) / k}px`;
    box.style.top = `${(y - r0.top) / k}px`;
    panel.style.maxHeight = `${room / k}px`;
    panel.style.transformOrigin = flip ? "50% 100%" : "50% 0";
  }, [anchor, align, panelRef]);

  useLayoutEffect(() => { place(); setReady(true); }, [place]);
  useEffect(() => {
    const onScroll = (e: Event) => { if (!boxRef.current?.contains(e.target as Node)) place(); };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", onScroll, true); };
  }, [place]);
  // initial focus: an explicit target, else the current choice, else the first control
  useEffect(() => {
    if (!ready) return;
    const p = panelRef.current;
    const target = p?.querySelector<HTMLElement>("[data-autofocus]")
      ?? p?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?? p?.querySelector<HTMLElement>('[role^="menuitem"], button:not([disabled]), input, a[href]');
    target?.focus({ preventScroll: true });
  }, [ready, panelRef]);
  // hand focus back to the trigger on close (when it's still on the page)
  useEffect(() => () => {
    const ae = document.activeElement;
    if (anchor?.isConnected && (!ae || ae === document.body)) anchor.focus({ preventScroll: true });
  }, [anchor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // keep keys away from the card underneath and global shortcuts
    if (role === "dialog") return; // useFocusTrap handles Escape + Tab
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); closeRef.current(); return; }
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };

  return createPortal(
    <>
      <div ref={backdropRef} data-kpop="" onClick={(e) => { e.stopPropagation(); closeRef.current(); }} style={{ position: "fixed", inset: 0, zIndex: 80 }} />
      <div ref={boxRef} style={{ position: "fixed", zIndex: 81, visibility: ready ? "visible" : "hidden" }}>
        <div ref={panelRef} role={role} aria-label={label} aria-modal={role === "dialog" ? true : undefined} data-kpop-panel=""
          onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()} className={ready ? "anim-scalein" : undefined}
          style={{ minWidth, maxWidth, overflowY: "auto", padding: 4, borderRadius: "var(--r-lg, 12px)", background: "var(--surface-raised)", boxShadow: "var(--e2, var(--shadow-lg))", border: "1px solid var(--hairline)" }}>
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

function MenuItem({ checked, onSelect, children }: { checked?: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button type="button" role={checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={checked} className="ktv-mi"
      onClick={onSelect} onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}>
      {children}
      {checked && <span className="ktv-mi-end"><Icon name="check" size={14} sw={2.2} /></span>}
    </button>
  );
}

/* ---------------- KANBAN ---------------- */
type Half = "top" | "bottom";
type CardMenu = null | "priority" | "assignee" | "status" | "move";
const CARD_CAP = 50; // cards rendered per column before "Show more"
const EMPTY_COLUMN: Record<string, string> = {
  todo: "Nothing to do", progress: "Nothing in progress", review: "Nothing in review", blocked: "Nothing blocked", done: "Nothing done yet",
};

interface KanbanCardProps {
  task: Task; subDone: number; subTotal: number; blocked: boolean;
  onOpen: (id: string) => void;
  /** tap-to-move on touch screens; omitted when read-only */
  onMove?: (id: string, status: Status) => void;
  /** inline status / priority / due / assignee edits; omitted when read-only */
  onPatch?: (id: string, patch: Partial<Task>) => void;
  isMobile: boolean; canDrag: boolean; acceptsDrop: boolean; dragging: boolean; dropHint: Half | null;
  onPickup: (id: string) => void; onDragDone: () => void;
  onHoverCard: (id: string, half: Half) => void; onCardDrop: (draggedId: string, targetId: string, half: Half) => void;
  selected: boolean; selectionActive: boolean; onSelect?: (id: string) => void;
  customFields: CustomFieldDef[]; members: { id: string; name: string }[];
  onKeyMove?: (id: string, key: string) => void; onMenuDone: (id: string) => void; hintId?: string;
  showProject: boolean; cursor: boolean;
}

const KanbanCard = memo(function KanbanCard(p: KanbanCardProps) {
  const { task, onPatch, members } = p;
  const proj = getProject(task.projectId);
  const [menu, setMenu] = useState<CardMenu>(null);
  const statusBtn = useRef<HTMLButtonElement>(null);
  const prioBtn = useRef<HTMLButtonElement>(null);
  const assignBtn = useRef<HTMLButtonElement>(null);
  const moveBtn = useRef<HTMLButtonElement>(null);
  const PRIORITIES_INLINE: Priority[] = ["urgent", "high", "medium", "low"];
  // a settle when this card was just dropped (survives a re-mount into a new column)
  const [landed, setLanded] = useState(() => wasJustLanded(task.id));
  useEffect(() => { if (wasJustLanded(task.id)) setLanded(true); }, [task.id, task.position]);
  useEffect(() => { if (!landed) return; const t = window.setTimeout(() => setLanded(false), 520); return () => window.clearTimeout(t); }, [landed]);
  const halfFrom = (e: React.DragEvent): Half => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "top" : "bottom";
  };
  const choose = (apply: () => void) => { setMenu(null); apply(); p.onMenuDone(task.id); };
  const toggle = (m: Exclude<CardMenu, null>) => setMenu((cur) => (cur === m ? null : m));
  const assignee = getMember(task.assigneeId);
  const dueText = task.dueDate ? fmtDue(task.dueDate) : null;
  const done = task.status === "done";
  const loud = task.priority === "urgent" || task.priority === "high";
  const tags = (task.tags || []).filter((id) => TAGS[id]);
  const label = [task.title, STATUS_META[task.status].label, `${PRIORITY_META[task.priority].label} priority`,
    dueText ? `due ${dueText}` : null, assignee ? `assigned to ${assignee.name}` : null, p.blocked ? "blocked" : null].filter(Boolean).join(", ");
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  // keyboard focus on the card's open button rings the whole card
  const [ring, setRing] = useState(false);

  return (
    // a labelled group, not a button: it holds its own buttons and a date chip, which a
    // role="button" would flatten for screen readers. Mouse clicks anywhere open the task;
    // keyboard and screen-reader users get the real button below.
    <div data-card-id={task.id} role="group" aria-label={task.title}
      onClick={() => p.onOpen(task.id)}
      className={"ktv-card" + (landed ? " kland" : "")} draggable={p.canDrag}
      data-selected={p.selected || undefined} data-ring={ring || undefined} data-cursor={p.cursor || undefined}
      data-drag={p.dragging || undefined} data-drop={p.dropHint ?? undefined} data-draggable={p.canDrag || undefined} data-done={done || undefined}
      onDragStart={p.canDrag ? (e) => { e.dataTransfer.setData("text/kanbo-task", task.id); e.dataTransfer.effectAllowed = "move"; p.onPickup(task.id); } : undefined}
      onDragEnd={p.canDrag ? p.onDragDone : undefined}
      onDragOver={p.canDrag && p.acceptsDrop ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); p.onHoverCard(task.id, halfFrom(e)); } : undefined}
      onDrop={p.canDrag && p.acceptsDrop ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData("text/kanbo-task"); p.onCardDrop(id, task.id, halfFrom(e)); } : undefined}>
      {/* first in the tab order: Enter / Space opens, Alt+arrows move. Visually hidden (so it
          never gets in the way of dragging the card) — the card shows its focus ring instead. */}
      <button type="button" data-card-open className="sr-only" aria-label={label} aria-describedby={p.hintId}
        onClick={(e) => { e.stopPropagation(); p.onOpen(task.id); }}
        onKeyDown={(e) => { if (e.altKey && p.onKeyMove && e.key.startsWith("Arrow")) { e.preventDefault(); e.stopPropagation(); p.onKeyMove(task.id, e.key); } }}
        onFocus={(e) => setRing(isFocusVisible(e.currentTarget))} onBlur={() => setRing(false)} />
      {p.onSelect && (
        <button type="button" className="ktv-sel ksel" role="checkbox" aria-checked={p.selected} onClick={(e) => { e.stopPropagation(); p.onSelect?.(task.id); }}
          aria-label={p.selected ? `Deselect ${task.title}` : `Select ${task.title}`}>
          {p.selected && <Icon name="check" size={11} sw={3} />}
        </button>
      )}
      <div className="ktv-card-top">
        {onPatch ? (
          <span style={{ display: "inline-flex" }} onClick={stop}>
            <button ref={statusBtn} type="button" className="ktv-trig" data-card-status onClick={() => toggle("status")} aria-label={`Status: ${STATUS_META[task.status].label}. Change status of ${task.title}`}
              aria-haspopup="menu" aria-expanded={menu === "status"} title={STATUS_META[task.status].label}><StatusGlyph status={task.status} size={14} readOnly /></button>
            {menu === "status" && (
              <Popover anchor={statusBtn.current} label={`Status of ${task.title}`} onClose={() => setMenu(null)} minWidth={176}>
                {STATUS_ORDER.map((s) => (
                  <MenuItem key={s} checked={task.status === s} onSelect={() => choose(() => { if (s !== task.status) onPatch(task.id, { status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined }); })}>
                    <StatusGlyph status={s} size={14} readOnly /> {STATUS_META[s].label}
                  </MenuItem>
                ))}
              </Popover>
            )}
          </span>
        ) : <span style={{ display: "inline-flex", padding: 3 }} title={STATUS_META[task.status].label}><StatusGlyph status={task.status} size={14} readOnly /></span>}
        {task.isMilestone && <span className="ktv-milestone" title="Milestone" style={{ marginTop: 6 }} />}
        <span className="ktv-card-title">{task.title}</span>
      </div>
      {(tags.length > 0 || (p.customFields.length > 0 && task.custom && Object.keys(task.custom).length > 0)) && (
        <div className="ktv-card-tags">
          {tags.slice(0, 2).map((id) => <span key={id} className="ktv-tag"><i style={{ background: projectPaint(TAGS[id].color).solid }} />{TAGS[id].label}</span>)}
          {tags.length > 2 && <span className="ktv-mono" style={{ color: "var(--ink-3)" }}>+{tags.length - 2}</span>}
          {p.customFields.length > 0 && <CustomChips task={task} fields={p.customFields} members={members} />}
        </div>
      )}
      <div className="ktv-card-meta">
        <span onClick={stop} data-card-due style={{ display: "inline-flex" }}>
          {onPatch
            ? <DateChip value={task.dueDate} time={task.dueTime} withTime size="sm" status={task.status} label={`Due date for ${task.title}`} placeholder="Add date"
                onChange={(date, time) => onPatch(task.id, { dueDate: date, dueTime: date ? time : undefined })} />
            : task.dueDate ? <DateChip value={task.dueDate} time={task.dueTime} size="sm" status={task.status} label="Due" readOnly onChange={() => {}} /> : null}
        </span>
        {p.subTotal > 0 && <span className="ktv-m ktv-mono" title={`${p.subDone} of ${p.subTotal} sub-tasks done`}><Icon name="layers" size={12} />{p.subDone}/{p.subTotal}</span>}
        {p.blocked && <span className="ktv-m ktv-m-signal" role="img" aria-label="Blocked" title="Blocked"><Icon name="lock" size={12} /></span>}
        <span className="ktv-card-end">
          {onPatch ? (
            <span style={{ display: "inline-flex" }} onClick={stop}>
              <button ref={prioBtn} type="button" className="ktv-trig" data-card-priority data-hidden={loud ? undefined : true} onClick={() => toggle("priority")}
                aria-label={`Priority: ${PRIORITY_META[task.priority].label}. Change priority of ${task.title}`} aria-haspopup="menu" aria-expanded={menu === "priority"}>
                <PriorityGlyph priority={task.priority} />
              </button>
              {menu === "priority" && (
                <Popover anchor={prioBtn.current} align="end" label={`Priority of ${task.title}`} onClose={() => setMenu(null)} minWidth={168}>
                  {PRIORITIES_INLINE.map((pr) => (
                    <MenuItem key={pr} checked={task.priority === pr} onSelect={() => choose(() => { if (pr !== task.priority) onPatch(task.id, { priority: pr }); })}>
                      <span style={{ display: "inline-grid", placeItems: "center", width: 16 }}><PriorityGlyph priority={pr} /></span> {PRIORITY_META[pr].label}
                    </MenuItem>
                  ))}
                </Popover>
              )}
            </span>
          ) : loud ? <PriorityGlyph priority={task.priority} /> : null}
          {p.showProject && proj && <ProjectDot color={proj.color} title={proj.name} />}
          {onPatch && members.length > 0 ? (
            <span style={{ display: "inline-flex" }} onClick={stop}>
              <button ref={assignBtn} type="button" className="ktv-trig" data-card-assignee onClick={() => toggle("assignee")} aria-label={`${assignee ? `Assigned to ${assignee.name}` : "Unassigned"}. Change assignee of ${task.title}`}
                aria-haspopup="menu" aria-expanded={menu === "assignee"}>
                {assignee ? <Avatar id={task.assigneeId} size={20} /> : <span className="ktv-unassigned"><Icon name="user" size={11} /></span>}
              </button>
              {menu === "assignee" && (
                <Popover anchor={assignBtn.current} align="end" label={`Assignee of ${task.title}`} onClose={() => setMenu(null)} minWidth={200} maxWidth={280}>
                  {members.map((m) => (
                    <MenuItem key={m.id} checked={task.assigneeId === m.id} onSelect={() => choose(() => { if (m.id !== task.assigneeId) onPatch(task.id, { assigneeId: m.id }); })}>
                      <Avatar id={m.id} size={20} /> <span className="truncate">{m.name}</span>
                    </MenuItem>
                  ))}
                </Popover>
              )}
            </span>
          ) : <Avatar id={task.assigneeId} size={20} />}
          {/* touch devices can't drag between columns — give a tap-to-move menu */}
          {p.isMobile && p.onMove && (
            <span style={{ display: "inline-flex" }} onClick={stop}>
              <button ref={moveBtn} type="button" className="ktv-trig" aria-label={`Move ${task.title} to another status`} aria-haspopup="menu" aria-expanded={menu === "move"}
                onClick={() => toggle("move")}><Icon name="layers" size={16} /></button>
              {menu === "move" && (
                <Popover anchor={moveBtn.current} align="end" label={`Move ${task.title} to`} onClose={() => setMenu(null)} minWidth={184}>
                  <div className="ktv-mlabel" aria-hidden>Move to</div>
                  {STATUS_ORDER.map((s) => (
                    <MenuItem key={s} checked={task.status === s} onSelect={() => choose(() => { if (s !== task.status) p.onMove?.(task.id, s); })}>
                      <StatusGlyph status={s} size={14} readOnly /> {STATUS_META[s].label}
                    </MenuItem>
                  ))}
                </Popover>
              )}
            </span>
          )}
        </span>
      </div>
    </div>
  );
});

/** Small dialog for a column's work-in-progress limit (replaces window.prompt). */
function WipLimitEditor({ column, current, perBoard, onSave, onClose }: { column: string; current?: number; perBoard: boolean; onSave: (n: number | null) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(current != null ? String(current) : "");
  const [error, setError] = useState("");
  const inputId = useId();
  const submit = () => {
    const v = parseWipLimit(draft);
    if (v === "invalid") { setError("Enter a whole number from 1 to 999, or leave it blank."); return; }
    onSave(v); onClose();
  };
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); submit(); }} style={{ padding: 8, width: 248, display: "flex", flexDirection: "column", gap: 8 }}>
      <label htmlFor={inputId} style={{ font: "600 12px/16px var(--font-ui, var(--font-display))", color: "var(--ink-2)" }}>WIP limit for {column}</label>
      <input id={inputId} data-autofocus type="number" inputMode="numeric" min={1} max={999} value={draft} className="kdp-field"
        onChange={(e) => { setDraft(e.target.value); setError(""); }} placeholder="No limit" aria-invalid={!!error} aria-describedby={`${inputId}-help`}
        style={{ fontFamily: "var(--font-mono)", borderColor: error ? "var(--signal, var(--prio-urgent))" : undefined }} />
      <p id={`${inputId}-help`} role={error ? "alert" : undefined} style={{ margin: 0, font: "500 12px/16px var(--font-ui, var(--font-display))", color: error ? "var(--signal, var(--prio-urgent))" : "var(--ink-3)" }}>
        {error || `The count turns red when the column holds more than this. Saved ${perBoard ? "for this board " : ""}on this device.`}
      </p>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {current != null && <Button variant="ghost" size="sm" onClick={() => { onSave(null); onClose(); }} style={{ marginRight: "auto" }}>Remove</Button>}
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" type="submit">Save</Button>
      </div>
    </form>
  );
}

interface BoardCol { key: string; label: string; status?: Status; dot?: string; avatar?: string; accepts: boolean; hint?: string }
const BOARD_GROUPS: { value: BoardGroup; label: string }[] = [{ value: "status", label: "Status" }, { value: "priority", label: "Priority" }, { value: "project", label: "Project" }, { value: "assignee", label: "Assignee" }];

export function BoardView({ tasks, allTasks, onOpen, onAdd, onMove, onPatch, onBulkPatch, onBulkDelete, members = [], customFields = [], readOnly = false, scopeKey, group: groupProp, onGroupChange, showProject = true, onToggle }: {
  tasks: Task[]; allTasks: Task[]; onOpen: (id: string) => void; onAdd: (status: Status) => void;
  onMove: (taskId: string, status: Status, position?: number) => void;
  onPatch?: (id: string, patch: Partial<Task>) => void;
  onBulkPatch?: (ids: string[], patch: Partial<Task>) => void;
  onBulkDelete?: (ids: string[]) => void;
  members?: { id: string; name: string }[];
  customFields?: CustomFieldDef[];
  /** view-only board (guests): cards open, but no drag, inline menus, add or bulk actions */
  readOnly?: boolean;
  /** which board this is (e.g. a project id, or "__my" for My tasks) — WIP limits are saved per board */
  scopeKey?: string;
  /** the columns, when the page chooses them (Display › Columns); otherwise the board's own switch */
  group?: BoardGroup;
  onGroupChange?: (g: BoardGroup) => void;
  /** a project dot on each card (off inside a project) */
  showProject?: boolean;
  /** ⌘↵ on a card (completes it like its row would); falls back to moving it to Done */
  onToggle?: (id: string) => void;
}) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const editable = !readOnly;
  const patch = editable ? onPatch : undefined;
  const canDrag = editable && !isMobile;
  const bulkEnabled = editable && !!onBulkPatch;
  const rootRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMenu, setBulkMenu] = useState<null | "status" | "priority" | "assignee">(null);
  const selectionActive = selected.size > 0;
  const toggleSelect = useCallback((id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const clearSel = () => { setSelected(new Set()); setBulkMenu(null); };
  const selIds = [...selected].filter((id) => tasks.some((t) => t.id === id));
  const applyBulk = (p: Partial<Task>) => { onBulkPatch?.(selIds, p); clearSel(); };
  const BULK_PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; half: Half } | null>(null);
  const [shown, setShown] = useState<Record<string, number>>({});
  const [announce, setAnnounce] = useState("");
  const [wipEdit, setWipEdit] = useState<{ key: string; label: string; anchor: HTMLElement } | null>(null);
  const focusReq = useRef<{ id: string; force: boolean } | null>(null);
  const [ownGroup, setOwnGroup] = useState<BoardGroup>(() => {
    try { const s = localStorage.getItem("kanbo-board-group") as BoardGroup | null; if (s && ["status", "priority", "project", "assignee"].includes(s)) return s; } catch { /* ignore */ }
    return "status";
  });
  const group = groupProp ?? ownGroup;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { const s = localStorage.getItem("kanbo-board-collapsed"); if (s) return new Set(JSON.parse(s)); } catch { /* ignore */ }
    return new Set();
  });
  useEffect(() => { if (!groupProp) { try { localStorage.setItem("kanbo-board-group", ownGroup); } catch { /* ignore */ } } }, [ownGroup, groupProp]);
  useEffect(() => { try { localStorage.setItem("kanbo-board-collapsed", JSON.stringify([...collapsed])); } catch { /* ignore */ } }, [collapsed]);

  // per-column WIP limits, saved per board when the page says which board this is (scopeKey);
  // never guessed from the visible tasks, so a filter can't swap one board's limits for another's.
  // Without a scopeKey the board keeps the device-wide limits it always had.
  const wipStore = wipKeyFor(scopeKey);
  const [wipCache, setWipCache] = useState<Record<string, Record<string, number>>>({});
  const wip = useMemo(() => wipCache[wipStore] ?? (() => { try { return loadWipLimits((k) => localStorage.getItem(k), scopeKey); } catch { return {}; } })(), [wipCache, wipStore, scopeKey]);
  const wipKey = (k: string) => `${group}:${k}`;
  const saveLimit = (k: string, n: number | null) => {
    const next = { ...wip };
    if (n == null) delete next[wipKey(k)]; else next[wipKey(k)] = n;
    setWipCache((c) => ({ ...c, [wipStore]: next }));
    try { localStorage.setItem(wipStore, JSON.stringify(next)); } catch { /* ignore */ }
  };

  // one pass over allTasks for sub-task counts and blockers (not one scan per card); the board's
  // own tasks are added because allTasks leaves out archived ones ("Show archived")
  const byId = useMemo(() => new Map([...allTasks, ...tasks].map((t) => [t.id, t])), [allTasks, tasks]);
  const kidCounts = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const c of allTasks) {
      if (!c.parentId) continue;
      const e = m.get(c.parentId) ?? { done: 0, total: 0 };
      e.total++; if (c.status === "done") e.done++;
      m.set(c.parentId, e);
    }
    return m;
  }, [allTasks]);
  const isBlocked = (t: Task) => (t.dependencies ?? []).some((d) => { const x = byId.get(d); return !!x && x.status !== "done"; });

  // sub-tasks hide only when their parent is on this board too (they're reachable from it)
  const boardTasks = hideNestedSubtasks(tasks);

  // columns — plus catch-all columns so no task silently drops off the board
  const memberList = members.length ? members
    : [...new Set(boardTasks.map((t) => t.assigneeId).filter(Boolean))].map((id) => ({ id, name: getMember(id)?.name || "Someone" }));
  const memberIds = new Set(memberList.map((m) => m.id));
  const keyOf = (t: Task): string =>
    group === "status" ? t.status
    : group === "priority" ? t.priority
    : group === "project" ? (getProject(t.projectId) ? t.projectId : NO_PROJECT_COL)
    : assigneeColumnKey(t.assigneeId, memberIds);
  const colItems: Record<string, Task[]> = {};
  const colOf = new Map<string, string>();
  for (const t of boardTasks) { const k = keyOf(t); (colItems[k] ||= []).push(t); colOf.set(t.id, k); }
  for (const k of Object.keys(colItems)) colItems[k].sort((a, b) => ((a.position ?? 0) - (b.position ?? 0)) || a.id.localeCompare(b.id));
  const columns: BoardCol[] =
    group === "status" ? STATUS_ORDER.map((s) => ({ key: s, label: STATUS_META[s].label, status: s, accepts: true }))
    : group === "priority" ? (["urgent", "high", "medium", "low"] as Priority[]).map((pr) => ({ key: pr, label: PRIORITY_META[pr].label, accepts: true }))
    : group === "project" ? [
        ...[...new Set(boardTasks.map((t) => t.projectId))].map((pid) => ({ pid, pr: getProject(pid) })).filter((x): x is { pid: string; pr: Project } => !!x.pr)
          .map(({ pid, pr }) => ({ key: pid, label: pr.name, dot: pr.color, accepts: true })),
        ...(colItems[NO_PROJECT_COL]?.length ? [{ key: NO_PROJECT_COL, label: "Other projects", accepts: false, hint: "In projects you can't see here. Drag a card to a project to move it." }] : []),
      ]
    : [
        ...memberList.map((m) => ({ key: m.id, label: m.name, avatar: m.id, accepts: true })),
        ...(colItems[UNASSIGNED_COL]?.length ? [{ key: UNASSIGNED_COL, label: "Unassigned", accepts: false, hint: "Drag a card onto a person to assign it." }] : []),
        ...(colItems[FORMER_COL]?.length ? [{ key: FORMER_COL, label: "Former members", accepts: false, hint: "Assigned to people no longer in this workspace. Drag a card onto a person to reassign it." }] : []),
      ];

  // the latest render's data for the stable (memo-friendly) handlers below
  const live = useRef(null as unknown as { columns: BoardCol[]; colItems: Record<string, Task[]>; colOf: Map<string, string>; shown: Record<string, number>; collapsed: Set<string>; group: BoardGroup; byId: Map<string, Task>; onMove: typeof onMove; patch?: typeof onPatch });
  live.current = { columns, colItems, colOf, shown, collapsed, group, byId, onMove, patch };

  const endHover = useCallback(() => { setDragId(null); setHover(null); setDragOver(null); }, []);
  // only re-render when the hovered card or half actually changes (dragover fires ~20×/s)
  const onHoverCard = useCallback((id: string, half: Half) => {
    setDragOver(null);
    setHover((h) => (h && h.id === id && h.half === half ? h : { id, half }));
  }, []);
  /** Applies a move; false when nothing could be moved (so callers don't announce one). */
  const moveTo = useCallback((draggedId: string, colKey: string, index: number): boolean => {
    const L = live.current;
    const col = L.columns.find((c) => c.key === colKey);
    const task = L.byId.get(draggedId);
    if (!col || !col.accepts || !task) return false;
    const plan = planReorder(L.colItems[colKey] ?? [], draggedId, index);
    const mine = plan.find((x) => x.id === draggedId);
    if (!mine) return false;
    const sameCol = L.colOf.get(draggedId) === colKey;
    markJustLanded(draggedId);
    for (const x of plan) if (x.id !== draggedId) L.patch?.(x.id, { position: x.position });
    if (L.group === "status") {
      // a reorder within a column only touches position (never re-stamps completedAt)
      if (sameCol && L.patch) L.patch(draggedId, { position: mine.position });
      else L.onMove(draggedId, col.status!, mine.position);
    } else {
      const field: Partial<Task> = sameCol ? {} : L.group === "priority" ? { priority: col.key as Priority } : L.group === "project" ? { projectId: col.key } : { assigneeId: col.key };
      L.patch?.(draggedId, { ...field, position: mine.position });
    }
    // keep the moved card inside the rendered part of a long column
    const cap = L.shown[colKey] ?? CARD_CAP;
    if (index >= cap) setShown((s) => ({ ...s, [colKey]: index + 1 }));
    return true;
  }, []);
  const onCardDrop = useCallback((draggedId: string, targetId: string, half: Half) => {
    endHover();
    if (!draggedId || draggedId === targetId) return;
    const L = live.current;
    const colKey = L.colOf.get(targetId);
    if (!colKey) return;
    const rest = (L.colItems[colKey] ?? []).filter((t) => t.id !== draggedId);
    const ti = rest.findIndex((t) => t.id === targetId);
    moveTo(draggedId, colKey, half === "top" ? ti : ti + 1);
  }, [endHover, moveTo]);
  const onColumnDrop = (draggedId: string, colKey: string) => {
    endHover();
    const list = colItems[colKey] ?? [];
    // land after the last card that's actually rendered, not behind "Show more"
    const vis = list.slice(0, shown[colKey] ?? CARD_CAP).filter((t) => t.id !== draggedId).length;
    moveTo(draggedId, colKey, vis);
  };
  // keyboard alternative to drag-and-drop: Alt+↑/↓ reorders, Alt+←/→ moves between columns
  const onKeyMove = useCallback((id: string, key: string) => {
    const L = live.current;
    const colKey = L.colOf.get(id);
    const ci = L.columns.findIndex((c) => c.key === colKey);
    if (!colKey || ci < 0) return;
    const col = L.columns[ci];
    const title = L.byId.get(id)?.title ?? "Task";
    const list = L.colItems[colKey] ?? [];
    const i = list.findIndex((t) => t.id === id);
    if (key === "ArrowUp" || key === "ArrowDown") {
      const up = key === "ArrowUp";
      if (!col.accepts) { setAnnounce(`${col.label} can't be reordered. Move the card to another column first.`); return; }
      const to = up ? i - 1 : i + 1;
      if (to < 0 || to >= list.length) { setAnnounce(`${title} is already at the ${up ? "top" : "bottom"} of ${col.label}`); return; }
      if (!moveTo(id, colKey, to)) return;
      setAnnounce(`${title} moved ${up ? "up" : "down"}, ${to + 1} of ${list.length} in ${col.label}`);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const dir = key === "ArrowLeft" ? -1 : 1;
      let j = ci + dir;
      while (j >= 0 && j < L.columns.length && (!L.columns[j].accepts || L.collapsed.has(L.columns[j].key))) j += dir;
      if (j < 0 || j >= L.columns.length) { setAnnounce(`There's no column to the ${dir < 0 ? "left" : "right"} of ${col.label}`); return; }
      const dest = L.columns[j];
      if (!moveTo(id, dest.key, Math.min((L.colItems[dest.key] ?? []).length, L.shown[dest.key] ?? CARD_CAP))) return;
      setAnnounce(`${title} moved to ${dest.label}`);
    } else return;
    focusReq.current = { id, force: true };
  }, [moveTo]);
  const onMenuDone = useCallback((id: string) => { focusReq.current = { id, force: false }; }, []);
  // after a keyboard move (or an inline edit that re-mounts the card in another column) keep focus on it
  useEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    focusReq.current = null;
    const card = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-card-id]") ?? []).find((n) => n.dataset.cardId === req.id);
    const el = card?.querySelector<HTMLElement>("[data-card-open]");
    const ae = document.activeElement;
    // keyboard moves follow the card (scrolling to it); after a menu pick we only rescue lost focus
    if (el && (req.force || !ae || ae === document.body)) el.focus({ preventScroll: !req.force });
  });
  const toggleCollapse = (key: string) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  // J/K through the cards (column by column), X selects, S/P/D/A edit, ⌘↵ completes
  const kb = useListKeyboard({
    rootRef, itemSelector: "[data-card-id]", idOf: (el) => el.dataset.cardId,
    focusTargetOf: (el) => el.querySelector<HTMLElement>("[data-card-open]"),
    onOpen,
    onComplete: editable ? (id) => { const t = byId.get(id); if (!t) return; if (onToggle) onToggle(id); else if (t.status !== "done") onMove(id, "done"); focusReq.current = { id, force: true }; } : undefined,
    onToggleSelect: bulkEnabled ? toggleSelect : undefined,
    onClear: clearSel,
    onAction: editable ? (action: ListKeyAction, _id: string, el: HTMLElement) => {
      const sel = action === "status" ? "[data-card-status]" : action === "priority" ? "[data-card-priority]" : action === "due" ? "[data-card-due] button" : action === "assign" ? "[data-card-assignee]" : null;
      if (sel) el.querySelector<HTMLElement>(sel)?.click();
    } : undefined,
  });

  return (
    <div ref={rootRef} className="ktv" style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div role="status" aria-live="polite" className="sr-only">{announce}</div>
      {!onGroupChange && (
        <div className="ktv-viewbar">
          <span className="ktv-mlabel" style={{ padding: 0 }} id={`${hintId}-cols`}>Columns</span>
          <Segmented options={BOARD_GROUPS} value={group} onChange={(g) => setOwnGroup(g)} ariaLabel="Columns" />
        </div>
      )}
      <p id={hintId} className="sr-only">{editable ? "Press Enter to open. Alt plus the arrow keys moves the card up, down or to the next column." : "Press Enter to open."}</p>
      <div className="ktv-board" data-selecting={selectionActive || undefined}>
        {columns.map((col) => {
          const items = colItems[col.key] ?? [];
          const cap = shown[col.key] ?? CARD_CAP;
          const visible = items.length > cap ? items.slice(0, cap) : items;
          const hiddenCount = items.length - visible.length;
          const isCollapsed = collapsed.has(col.key);
          const dropOk = canDrag && col.accepts;
          const lead = col.status ? <StatusGlyph status={col.status} size={14} readOnly />
            : col.avatar && getMember(col.avatar) ? <Avatar id={col.avatar} size={20} />
            : col.dot ? <ProjectDot color={col.dot} size={10} />
            : col.key in PRIORITY_META ? <PriorityGlyph priority={col.key as Priority} />
            : <span className="ktv-dot" style={{ background: "var(--icon-quiet, var(--ink-4))" }} />;
          if (isCollapsed) {
            return (
              <button key={col.key} type="button" className="ktv-colrail" onClick={() => toggleCollapse(col.key)} aria-expanded={false}
                aria-label={`Expand ${col.label} column, ${items.length} task${items.length === 1 ? "" : "s"}`}>
                <Icon name="chevronRight" size={14} />
                {lead}
                <span className="ktv-mono">{items.length}</span>
                <b>{col.label}</b>
              </button>
            );
          }
          const limit = wip[wipKey(col.key)];
          const over = limit != null && items.length > limit;
          const countLabel = `${items.length} task${items.length === 1 ? "" : "s"} in ${col.label}${limit != null ? `, WIP limit ${limit}${over ? ", over the limit" : ""}` : ""}`;
          return (
            <div key={col.key} role="group" aria-label={`${col.label} column`} className="ktv-col"
              onDragOver={dropOk ? (e) => { if (e.dataTransfer.types.includes("text/kanbo-task")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(col.key); setHover(null); } } : undefined}
              onDragLeave={dropOk ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver((d) => d === col.key ? null : d); } : undefined}
              onDrop={dropOk ? (e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/kanbo-task"); if (id) onColumnDrop(id, col.key); else endHover(); } : undefined}>
              <div className="ktv-col-head">
                {lead}
                <span className="ktv-col-name">{col.label}</span>
                {editable
                  ? <button type="button" className="ktv-wip" data-over={over || undefined} onClick={(e) => setWipEdit({ key: col.key, label: col.label, anchor: e.currentTarget })} title="Set WIP limit" aria-label={`${countLabel}. Set WIP limit`} aria-haspopup="dialog">{items.length}{limit != null ? `/${limit}` : ""}</button>
                  : <span className="ktv-wip" data-over={over || undefined} aria-label={countLabel}>{items.length}{limit != null ? `/${limit}` : ""}</span>}
                <span className="ktv-col-tools">
                  {col.status && editable && <IconButton icon="plus" size="sm" label={`Add task to ${col.label}`} onClick={() => onAdd(col.status!)} />}
                  <IconButton icon="chevronLeft" size="sm" label={`Collapse ${col.label} column`} aria-expanded onClick={() => toggleCollapse(col.key)} />
                </span>
              </div>
              {col.hint && <p className="ktv-col-hint">{col.hint}</p>}
              <div className="klane ktv-lane" data-drop={(dragOver === col.key && !hover) || undefined}>
                {visible.map((t) => {
                  const kc = kidCounts.get(t.id);
                  return (
                    <KanbanCard key={t.id} task={t} subDone={(kc?.done ?? 0) + (t.subtasks ?? []).filter((s) => s.done).length} subTotal={(kc?.total ?? 0) + (t.subtasks?.length ?? 0)} blocked={isBlocked(t)}
                      onOpen={onOpen} onMove={editable ? onMove : undefined} onPatch={patch}
                      isMobile={isMobile} canDrag={canDrag} acceptsDrop={col.accepts} dragging={dragId === t.id}
                      dropHint={hover && hover.id === t.id && dragId !== t.id ? hover.half : null}
                      onPickup={setDragId} onDragDone={endHover} onHoverCard={onHoverCard} onCardDrop={onCardDrop}
                      selected={selected.has(t.id)} selectionActive={selectionActive} onSelect={bulkEnabled ? toggleSelect : undefined}
                      customFields={customFields} members={members}
                      onKeyMove={editable ? onKeyMove : undefined} onMenuDone={onMenuDone} hintId={hintId}
                      showProject={showProject} cursor={kb.cursor === t.id} />
                  );
                })}
                {items.length === 0 && <div className="ktv-lane-empty">{col.status ? EMPTY_COLUMN[col.status] : "Nothing here"}</div>}
                {hiddenCount > 0 && (
                  <button type="button" className="ktv-morecards" onClick={() => setShown((s) => ({ ...s, [col.key]: cap + CARD_CAP }))} aria-label={`Show ${Math.min(CARD_CAP, hiddenCount)} more tasks in ${col.label}`}>
                    <Icon name="chevronDown" size={14} /> Show {Math.min(CARD_CAP, hiddenCount)} more{hiddenCount > CARD_CAP ? <span style={{ color: "var(--ink-4)" }}> · {hiddenCount} hidden</span> : null}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {wipEdit && (
        <Popover anchor={wipEdit.anchor} role="dialog" label={`WIP limit for ${wipEdit.label}`} onClose={() => setWipEdit(null)} minWidth={0}>
          <WipLimitEditor column={wipEdit.label} current={wip[wipKey(wipEdit.key)]} perBoard={!!scopeKey} onSave={(n) => saveLimit(wipEdit.key, n)} onClose={() => setWipEdit(null)} />
        </Popover>
      )}

      {bulkEnabled && selectionActive && (
        <div role="toolbar" aria-label="Bulk actions for selected tasks" className="ktv-float">
          <span className="ktv-float-count" aria-live="polite">{selIds.length} selected</span>
          <span className="ktv-float-sep" aria-hidden="true" />
          <Button variant="ghost" size="sm" icon="check" onClick={() => applyBulk({ status: "done", completedAt: toLocalISO(new Date()) })}>Done</Button>
          <BulkMenuButton label="Status" icon="layers" open={bulkMenu === "status"} onToggle={() => setBulkMenu((m) => m === "status" ? null : "status")}>
            {STATUS_ORDER.map((s) => (<button key={s} type="button" className="ktv-mi" onClick={() => applyBulk({ status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined })}><StatusGlyph status={s} size={14} readOnly /> {STATUS_META[s].label}</button>))}
          </BulkMenuButton>
          <BulkMenuButton label="Priority" icon="flag" open={bulkMenu === "priority"} onToggle={() => setBulkMenu((m) => m === "priority" ? null : "priority")}>
            {BULK_PRIORITIES.map((pr) => (<button key={pr} type="button" className="ktv-mi" onClick={() => applyBulk({ priority: pr })}><span style={{ display: "inline-grid", placeItems: "center", width: 16 }}><PriorityGlyph priority={pr} /></span> {PRIORITY_META[pr].label}</button>))}
          </BulkMenuButton>
          {members.length > 0 && (
            <BulkMenuButton label="Assign" icon="user" open={bulkMenu === "assignee"} onToggle={() => setBulkMenu((m) => m === "assignee" ? null : "assignee")}>
              {members.map((m) => (<button key={m.id} type="button" className="ktv-mi" onClick={() => applyBulk({ assigneeId: m.id })}><Avatar id={m.id} size={20} /> {m.name}</button>))}
            </BulkMenuButton>
          )}
          <Button variant="ghost" size="sm" icon="trash" onClick={() => { onBulkDelete?.(selIds); clearSel(); }} style={{ color: "var(--signal, var(--prio-urgent))" }}>Delete</Button>
          <span className="ktv-float-sep" aria-hidden="true" />
          <IconButton icon="x" size="sm" label="Clear selection" onClick={clearSel} />
        </div>
      )}
    </div>
  );
}

/* ---------------- TIMELINE (Gantt) ---------------- */
type TimelineZoom = "2w" | "6w";
const STATUS_BAR: Record<Status, string> = {
  todo: "var(--st-todo-fill, var(--st-todo))", progress: "var(--st-progress-fill, var(--st-progress))", review: "var(--st-review-fill, var(--st-review))",
  blocked: "var(--st-blocked-fill, var(--st-blocked))", done: "var(--st-done-fill, var(--st-done))",
};

export function TimelineView({ tasks, onOpen, onPatch, readOnly = false }: {
  tasks: Task[]; allTasks?: Task[]; onOpen: (id: string) => void; onPatch?: (id: string, patch: Partial<Task>) => void;
  /** view-only timeline (guests): bars open, but can't be dragged or nudged */
  readOnly?: boolean;
}) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const canEdit = !!onPatch && !readOnly;
  const hintId = useId();
  const [zoom, setZoom] = useState<TimelineZoom>(() => { try { return localStorage.getItem("kanbo-timeline-zoom") === "6w" ? "6w" : "2w"; } catch { return "2w"; } });
  useEffect(() => { try { localStorage.setItem("kanbo-timeline-zoom", zoom); } catch { /* ignore */ } }, [zoom]);
  const [offset, setOffset] = useState(0); // days the window is moved from its today-anchored default
  const scrollRef = useRef<HTMLDivElement>(null);
  const resetScroll = useRef(false);
  // explicit navigation (‹ Today ›, edge markers, zoom) shows the new window from its first day
  const goTo = (next: (o: number) => number) => { resetScroll.current = true; setOffset(next); };
  useLayoutEffect(() => {
    if (resetScroll.current && scrollRef.current) scrollRef.current.scrollLeft = 0;
    resetScroll.current = false;
  }, [offset, zoom]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dropCol, setDropCol] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const say = (text: string, warn = false) => {
    setNotice({ text, warn });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4500);
  };

  const wide = zoom === "6w";
  const DAYS = wide ? 42 : 16;
  const LEAD = wide ? 7 : 2;   // days shown before today in the default window
  const STEP = wide ? 28 : 7;  // how far ‹ and › move the window
  // tighter columns + lane on phones so more of the chart is visible
  const colW = wide ? (isMobile ? 18 : 26) : (isMobile ? 46 : 72);
  const inset = wide ? 2 : 4;
  const laneW = isMobile ? 104 : 160, rowH = 36, MORE_H = 36, ROW_CAP = 50;
  const trackW = DAYS * colW;
  const todayIso = toLocalISO(KANBO_TODAY);
  const windowStart = addDaysISO(todayIso, offset - LEAD);
  const dayIsos = Array.from({ length: DAYS }, (_, i) => addDaysISO(windowStart, i));
  const dates = dayIsos.map((iso) => localDate(iso));
  const todayIdx = daysBetweenISO(windowStart, todayIso);
  const lastYear = dates[DAYS - 1].getFullYear();
  const rangeLabel = `${dayLabel(dayIsos[0], "dm")} – ${dayLabel(dayIsos[DAYS - 1], "dm")}${lastYear !== KANBO_TODAY.getFullYear() ? ` ${lastYear}` : ""}`;

  // group by the projects actually present in these tasks (works for real
  // accounts, not just the demo seed); long projects render their first rows
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const buckets = new Map<string, Task[]>();
  for (const t of tasks) (buckets.get(t.projectId) ?? buckets.set(t.projectId, []).get(t.projectId)!).push(t);
  const byProject = [...buckets.entries()]
    .map(([pid, items]) => ({ project: getProject(pid), items }))
    .filter((g): g is { project: Project; items: Task[] } => !!g.project && g.items.length > 0)
    .map((g) => {
      const rows = expanded.has(g.project.id) || g.items.length <= ROW_CAP ? g.items : g.items.slice(0, ROW_CAP);
      return { ...g, rows, hidden: g.items.length - rows.length };
    });

  // bar geometry relative to the window (unclipped), then each bar's pixel position for dependency lines
  const spans = new Map<string, BarSpan | null>();
  for (const t of tasks) spans.set(t.id, barSpan(t, windowStart));
  const layout = new Map<string, { y: number; barL: number | null; barR: number | null }>();
  let yAcc = 0;
  byProject.forEach((g) => {
    g.rows.forEach((t) => {
      const sp = spans.get(t.id);
      const c = sp ? clipSpan(sp, DAYS) : null;
      const v = c && typeof c === "object" ? c : null;
      layout.set(t.id, { y: yAcc + rowH / 2, barL: v ? laneW + v.vs * colW + inset : null, barR: v ? laneW + (v.ve + 1) * colW - inset : null });
      yAcc += rowH;
    });
    if (g.hidden > 0) yAcc += MORE_H;
  });
  const totalH = yAcc;
  // critical path = longest dependency chain by bar span (cycle-guarded)
  const spanLen = (id: string) => { const sp = spans.get(id); return sp ? Math.max(1, sp.e - sp.s + 1) : 1; };
  const memo = new Map<string, { len: number; path: string[] }>();
  const chain = (id: string, seen: Set<string>): { len: number; path: string[] } => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return { len: 0, path: [] };
    const t = byId.get(id); if (!t) return { len: 0, path: [] };
    seen.add(id);
    let best = { len: 0, path: [] as string[] };
    for (const dep of t.dependencies || []) { const c = chain(dep, seen); if (c.len > best.len) best = c; }
    seen.delete(id);
    const res = { len: best.len + spanLen(id), path: [...best.path, id] };
    memo.set(id, res); return res;
  };
  let critical = { len: 0, path: [] as string[] };
  tasks.forEach((t) => { const c = chain(t.id, new Set()); if (c.len > critical.len) critical = c; });
  const criticalSet = new Set(critical.path.length > 1 ? critical.path : []);
  const depLines = tasks.flatMap((t) => (t.dependencies || []).map((dep) => {
    const A = layout.get(dep), B = layout.get(t.id);
    if (!A || !B || A.barR == null || B.barL == null) return null;
    return { key: dep + ">" + t.id, x1: A.barR, y1: A.y, x2: B.barL, y2: B.y, crit: criticalSet.has(dep) && criticalSet.has(t.id) };
  })).filter((l): l is { key: string; x1: number; y1: number; x2: number; y2: number; crit: boolean } => !!l);

  /* ---- rescheduling: drag (grab-day → drop-day delta) and keyboard nudges ---- */
  const colAt = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect(); // width-relative, so it holds under the app's text-size zoom
    if (!(r.width > 0)) return 0;
    return Math.max(0, Math.min(DAYS - 1, Math.floor((clientX - r.left) / (r.width / DAYS))));
  };
  const isTimelineDrag = (e: React.DragEvent) => { const ty = e.dataTransfer.types; return ty.includes("text/kanbo-timeline") || ty.includes("text/kanbo-tl-start"); };
  // keep a bar in view after a keyboard move so it (and focus) doesn't slide off the edge
  const keepInView = (startIso: string, dueIso: string) => {
    const s = daysBetweenISO(windowStart, startIso), e = daysBetweenISO(windowStart, dueIso);
    if (s > DAYS - 3) setOffset((o) => o + (s - (DAYS - 3)));
    else if (e < 2) setOffset((o) => o + (e - 2));
    window.requestAnimationFrame(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el && scrollRef.current?.contains(el)) el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  };
  const onTrackDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isTimelineDrag(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
    const c = colAt(e.clientX, e.currentTarget);
    setDropCol((d) => (d === c ? d : c));
  };
  const onTrackDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isTimelineDrag(e) || !onPatch) return;
    e.preventDefault(); setDropCol(null);
    const dropIso = dayIsos[colAt(e.clientX, e.currentTarget)];
    const moveId = e.dataTransfer.getData("text/kanbo-timeline");
    const startId = e.dataTransfer.getData("text/kanbo-tl-start");
    if (moveId) {
      const t = byId.get(moveId); if (!t) return;
      const patch = timelineMovePatch(t, e.dataTransfer.getData("text/kanbo-tl-grab") || null, dropIso);
      if (!patch) return;
      onPatch(moveId, patch);
      say(t.dueDate ? `“${t.title}” moved: now due ${dayLabel(patch.dueDate!)}` : `“${t.title}” scheduled for ${dayLabel(patch.dueDate!)}`);
    } else if (startId) {
      const t = byId.get(startId); if (!t) return;
      const r = timelineStartPatch(t, dropIso);
      if (r.ok) { onPatch(startId, r.patch); say(`“${t.title}” now starts ${dayLabel(dropIso)}`); }
      else if (r.reason === "after-due") say(`A start date can't be after the due date (${dayLabel(t.dueDate!)}).`, true);
    }
  };
  const nudge = (t: Task, days: number, startOnly: boolean) => {
    if (!onPatch || !t.dueDate) return;
    if (startOnly) {
      const next = addDaysISO(effectiveStartISO(t)!, days);
      const r = timelineStartPatch(t, next);
      if (!r.ok) { if (r.reason === "after-due") say(`A start date can't be after the due date (${dayLabel(t.dueDate)}).`, true); return; }
      onPatch(t.id, r.patch);
      say(`“${t.title}” now starts ${dayLabel(next)}`);
      keepInView(next, t.dueDate);
    } else {
      const patch = timelineMovePatch(t, t.dueDate, addDaysISO(t.dueDate, days))!;
      onPatch(t.id, patch);
      say(`“${t.title}” now due ${dayLabel(patch.dueDate!)}`);
      keepInView(effectiveStartISO({ ...t, ...patch })!, patch.dueDate!);
    }
  };

  if (byProject.length === 0) {
    return (
      <div className="ktv" style={{ flex: 1, overflowY: "auto" }}>
        <EmptyState art="layers" title="Nothing to chart yet" body="Add a few tasks and they'll lay out here on a timeline, by project and due date." />
      </div>
    );
  }

  // edge markers are sticky flex items of the track, so they sit at the visible edge of the
  // chart (just right of the project lanes, or at the right-hand edge) whatever the scroll or width
  const edgeChip: React.CSSProperties = { position: "sticky" };

  return (
    <div className="ktv" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* window navigation + zoom */}
      <div className="ktv-viewbar" style={{ paddingBottom: 8 }}>
        <div role="group" aria-label="Timeline dates" style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <IconButton icon="chevronLeft" size="sm" label={wide ? "Previous four weeks" : "Previous week"} onClick={() => goTo((o) => o - STEP)} />
          <Button variant="ghost" size="sm" onClick={() => goTo(() => 0)} aria-label="Jump to today">Today</Button>
          <IconButton icon="chevronRight" size="sm" label={wide ? "Next four weeks" : "Next week"} onClick={() => goTo((o) => o + STEP)} />
        </div>
        <span className="ktv-range" aria-live="polite">{rangeLabel}</span>
        <Segmented ariaLabel="Zoom" value={zoom} onChange={(z) => { resetScroll.current = true; setZoom(z); }} options={[{ value: "2w", label: "2 weeks" }, { value: "6w", label: "6 weeks" }]} />
        <span style={{ flex: 1 }} />
        <span role="status" aria-live="polite" className="ktv-note" data-warn={notice?.warn || undefined}>
          {notice && <>{!notice.warn && <Icon name="check" size={14} />}{notice.text}</>}
        </span>
        {criticalSet.size > 0 && <span className="ktv-legend"><span className="ktv-dot" style={{ background: "var(--signal, var(--prio-urgent))" }} />Critical path</span>}
      </div>
      <p id={hintId} className="sr-only">Press Enter to open. Alt plus Left or Right arrow moves the task by a day; add Shift to change only its start date.</p>

      <div ref={scrollRef} className="ktv-tl" style={{ ["--tl-lane" as string]: `${laneW}px` }}>
        <div style={{ minWidth: laneW + trackW, paddingBottom: 40 }}>
          {/* axis */}
          <div className="ktv-tl-axis">
            <div className="ktv-tl-corner" />
            {dates.map((d, i) => {
              const isToday = i === todayIdx;
              const weekend = d.getDay() === 0 || d.getDay() === 6;
              const monthMark = wide && (i === 0 || d.getDate() === 1);
              const top = wide ? (monthMark ? MON[d.getMonth()] : WD[d.getDay()][0]) : WD[d.getDay()];
              return (
                <div key={dayIsos[i]} className="ktv-tl-day" data-weekend={weekend || undefined} data-month={monthMark || undefined} data-week={(wide && (d.getDay() === 1 || d.getDate() === 1)) || undefined} style={{ width: colW }}>
                  <span>{top}</span>
                  <span className={isToday ? "ktv-tl-today" : undefined}>{d.getDate()}</span>
                </div>
              );
            })}
          </div>

          {/* lanes */}
          <div className="ktv-tl-lanes" onDragLeave={canEdit ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropCol(null); } : undefined}>
            {dates.map((d, i) => (d.getDay() === 0 || d.getDay() === 6) && <div key={`we-${i}`} aria-hidden className="ktv-tl-weekend" style={{ left: laneW + i * colW, width: colW }} />)}
            {dropCol != null && <div aria-hidden className="ktv-tl-drop" style={{ left: laneW + dropCol * colW, width: colW }} />}
            {todayIdx >= 0 && todayIdx < DAYS && <div aria-hidden className="ktv-tl-nowline" style={{ left: laneW + todayIdx * colW + colW / 2 }} />}
            {/* dependency connectors */}
            {depLines.length > 0 && (
              <svg aria-hidden width={laneW + trackW} height={totalH} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", zIndex: 1, overflow: "visible" }}>
                <defs>
                  <marker id={`${hintId}-arrow`} markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--icon-quiet, var(--ink-4))" /></marker>
                  <marker id={`${hintId}-crit`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--signal, var(--prio-urgent))" /></marker>
                </defs>
                {depLines.map((l) => { const mx = (l.x1 + l.x2) / 2; return <path key={l.key} d={`M${l.x1},${l.y1} C${mx},${l.y1} ${mx},${l.y2} ${l.x2},${l.y2}`} fill="none" stroke={l.crit ? "var(--signal, var(--prio-urgent))" : "var(--icon-quiet, var(--ink-4))"} strokeWidth={l.crit ? 1.75 : 1.25} opacity={l.crit ? 0.9 : 0.7} markerEnd={`url(#${hintId}-${l.crit ? "crit" : "arrow"})`} />; })}
              </svg>
            )}
            {byProject.map((g) => (
              <div key={g.project.id} className="ktv-tl-group">
                <div className="ktv-tl-lane">
                  <div className="ktv-tl-lane-in"><ProjectDot color={g.project.color} /><span>{g.project.name}</span><small>{g.items.length}</small></div>
                </div>
                <div className="ktv-tl-rows" style={{ width: trackW }}>
                  {g.rows.map((t) => {
                    const sp = spans.get(t.id) ?? null;
                    const c = sp ? clipSpan(sp, DAYS) : null;
                    const v = c && typeof c === "object" ? c : null;
                    const done = t.status === "done";
                    const crit = criticalSet.has(t.id);
                    const barW = v ? (v.ve - v.vs + 1) * colW - inset * 2 : 0;
                    const barStyle = { left: v ? v.vs * colW + inset : 0, width: barW, ["--bar" as string]: STATUS_BAR[t.status], scrollMarginLeft: laneW + 12, scrollMarginRight: 16 } as React.CSSProperties;
                    const barBody = (
                      <>
                        {canEdit && <span aria-hidden draggable className="ktv-tl-grip" onClick={(e) => e.stopPropagation()} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData("text/kanbo-tl-start", t.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDropCol(null)} title="Drag to set the start date" />}
                        {barW >= 36 && <span className="ktv-tl-label">{t.title}</span>}
                        {barW >= 96 && <Avatar id={t.assigneeId} size={16} />}
                      </>
                    );
                    return (
                      <div key={t.id} className="ktv-tl-row" style={{ width: trackW, display: "flex", alignItems: "center" }}
                        onDragOver={canEdit ? onTrackDragOver : undefined} onDrop={canEdit ? onTrackDrop : undefined}>
                        {v && sp && t.dueDate && (canEdit ? (
                          <div role="button" tabIndex={0} className="ktv-tl-bar" data-crit={crit || undefined} data-done={done || undefined} data-clip-l={v.clipL || undefined} data-clip-r={v.clipR || undefined}
                            aria-label={`${t.title}: ${sp.impliedStart ? "" : `starts ${dayLabel(t.startDate!)}, `}due ${dayLabel(t.dueDate)}`}
                            aria-describedby={hintId}
                            onClick={() => onOpen(t.id)} draggable
                            onKeyDown={(e) => {
                              if (e.target !== e.currentTarget) return;
                              if (!e.altKey && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(t.id); return; }
                              if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); nudge(t, e.key === "ArrowLeft" ? -1 : 1, e.shiftKey); }
                            }}
                            onDragStart={(e) => {
                              // remember the day under the cursor: the drop moves the task by (drop day − this day)
                              const track = e.currentTarget.parentElement as HTMLElement;
                              e.dataTransfer.setData("text/kanbo-timeline", t.id);
                              e.dataTransfer.setData("text/kanbo-tl-grab", dayIsos[colAt(e.clientX, track)]);
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            onDragEnd={() => setDropCol(null)}
                            title={`${t.title}: drag to reschedule`} style={barStyle}>
                            {barBody}
                          </div>
                        ) : (
                          <button type="button" className="ktv-tl-bar" aria-label={t.title} data-done={done || undefined} data-clip-l={v.clipL || undefined} data-clip-r={v.clipR || undefined}
                            onClick={() => onOpen(t.id)} title={t.title} style={barStyle}>
                            {barBody}
                          </button>
                        ))}
                        {/* bars outside the window: an edge marker that jumps to them */}
                        {c === "before" && sp && t.dueDate && (
                          <button type="button" className="ktv-tl-edge" onClick={() => goTo((o) => o + sp.s - 2)} title={`${t.title}: due ${dayLabel(t.dueDate)}. Show it`} aria-label={`${t.title} is due ${dayLabel(t.dueDate)}, before these dates. Show it`}
                            style={{ ...edgeChip, left: laneW + 6, marginLeft: 6, padding: "0 8px 0 4px" }}>
                            <Icon name="chevronLeft" size={12} />{dayLabel(t.dueDate, "dm")}<span>· {t.title}</span>
                          </button>
                        )}
                        {c === "after" && sp && t.dueDate && (
                          <button type="button" className="ktv-tl-edge" onClick={() => goTo((o) => o + sp.s - 2)} title={`${t.title}: due ${dayLabel(t.dueDate)}. Show it`} aria-label={`${t.title} is due ${dayLabel(t.dueDate)}, after these dates. Show it`}
                            style={{ ...edgeChip, right: 10, marginLeft: "auto", marginRight: 6, padding: "0 4px 0 8px" }}>
                            <span>{t.title} ·</span>{dayLabel(t.dueDate, "dm")}<Icon name="chevronRight" size={12} />
                          </button>
                        )}
                        {/* tasks with no due date: a draggable placeholder so they can be scheduled */}
                        {!sp && (
                          <button type="button" className="ktv-tl-nodate" onClick={() => onOpen(t.id)} draggable={canEdit}
                            onDragStart={canEdit ? (e) => { e.dataTransfer.setData("text/kanbo-timeline", t.id); e.dataTransfer.effectAllowed = "move"; } : undefined}
                            onDragEnd={canEdit ? () => setDropCol(null) : undefined}
                            aria-label={`${t.title}, no due date${canEdit ? ". Drag onto a day to schedule it" : ""}`}
                            title={canEdit ? "Drag onto a day to schedule" : "No due date"} style={{ left: 6 }}>
                            <Icon name="calendarPlus" size={12} /><span>{t.title}</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {g.hidden > 0 && (
                    <div className="ktv-tl-moregroup" style={{ position: "sticky", left: laneW, width: "max-content" }}>
                      <Button variant="ghost" size="sm" icon="chevronDown" onClick={() => setExpanded((s) => new Set(s).add(g.project.id))}>Show {g.hidden} more in {g.project.name}</Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A plain list row with a hover / focus fill (for lists inside dialogs, not menus). */
function RowButton({ onClick, children, autoFocus }: { onClick: () => void; children: ReactNode; autoFocus?: boolean }) {
  return (
    <button type="button" onClick={onClick} data-autofocus={autoFocus ? "" : undefined} className="ktv-mi">
      {children}
    </button>
  );
}

/* ---------------- CALENDAR ---------------- */
function ConnectCalendarMenu({ connections, onConnect, onDisconnect, syncing }: {
  connections: CalendarConnection[];
  onConnect: (p: CalProvider) => void;
  onDisconnect: (p: CalProvider) => void;
  syncing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const connectedFor = (p: CalProvider) => connections.find((c) => c.provider === p);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {connections.map((c) => {
        const meta = PROVIDER_META[c.provider];
        return (
          <span key={c.provider} className="ktv-saved" style={{ height: 28 }}>
            <span className="ktv-dot" style={{ background: meta.color, marginRight: 6 }} />
            <span style={{ color: "var(--ink-2)" }}>{c.accountEmail || meta.label}</span>
            <button type="button" title={`Disconnect ${meta.label}`} aria-label={`Disconnect ${meta.label}`} onClick={() => onDisconnect(c.provider)}><Icon name="x" size={12} /></button>
          </span>
        );
      })}
      {syncing && <span className="ktv-note">Syncing…</span>}
      <Button ref={btn} variant="ghost" size="sm" icon="calendarPlus" iconRight="chevronDown" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>Connect calendar</Button>
      {open && (
        <Popover anchor={btn.current} align="end" label="Connect a calendar" onClose={() => setOpen(false)} minWidth={248}>
          {(Object.keys(PROVIDER_META) as CalProvider[]).map((p) => {
            const meta = PROVIDER_META[p];
            const conn = connectedFor(p);
            return (
              <MenuItem key={p} onSelect={() => { setOpen(false); if (conn) onDisconnect(p); else onConnect(p); }}>
                <span className="ktv-dot" style={{ background: meta.color, margin: "0 4px" }} />
                <span style={{ flex: 1 }}>{meta.label}</span>
                {conn ? <span className="ktv-mi-end">Disconnect</span> : <Icon name="plus" size={14} />}
              </MenuItem>
            );
          })}
          <div className="ktv-msep" />
          <p style={{ margin: 0, padding: "4px 8px 6px", font: "500 12px/16px var(--font-ui, var(--font-display))", color: "var(--ink-3)" }}>We only read your events to show them here. Disconnect any time.</p>
        </Popover>
      )}
    </div>
  );
}

export function CalendarView({ tasks, onOpen, onPatch, connections = [], externalEvents = [], onConnect, onDisconnect, syncing, readOnly = false, scope, onScopeChange, onOpenSettings }: {
  tasks: Task[];
  onOpen: (id: string) => void;
  onPatch?: (id: string, patch: Partial<Task>) => void;
  connections?: CalendarConnection[];
  externalEvents?: ExternalEvent[];
  /** the connect / disconnect menu shows only when these are passed (connect lives in Settings) */
  onConnect?: (p: CalProvider) => void;
  onDisconnect?: (p: CalProvider) => void;
  syncing?: boolean;
  /** view-only calendar (guests): tasks open, but can't be dragged to another day */
  readOnly?: boolean;
  /** Today › Month: whose tasks — mine, or the team's */
  scope?: "mine" | "team";
  onScopeChange?: (s: "mine" | "team") => void;
  /** with no calendar connected, a prompt links to Settings › Calendar */
  onOpenSettings?: () => void;
}) {
  const canEdit = !!onPatch && !readOnly;
  const [mode, setMode] = useState<"month" | "week">("month");
  // month / week navigation (0 = the current one)
  const [monthOffset, setMonthOffset] = useState(0);
  const [weekOffset, setWeekOffset] = useState(0);
  const periodAtSwitch = useRef<CalendarPeriod | null>(null); // where the last month ↔ week switch left each view
  const [dayPop, setDayPop] = useState<{ iso: string; anchor: HTMLElement } | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const viewMonth = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth() + monthOffset, 1);
  const year = viewMonth.getFullYear(), month = viewMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const iso = (d: number) => toLocalISO(new Date(year, month, d));
  const monthLabel = `${MON_LONG[month]} ${year}`;
  // switching month ↔ week keeps you looking at the same stretch of time, and switching
  // straight back returns to exactly where you were
  const switchMode = (m: "month" | "week") => {
    if (m === mode) return;
    const next = switchCalendarPeriod(KANBO_TODAY, m, { month: monthOffset, week: weekOffset }, periodAtSwitch.current);
    periodAtSwitch.current = next;
    setMonthOffset(next.month); setWeekOffset(next.week);
    setMode(m);
  };
  const weekStartDate = mondayOf(KANBO_TODAY);
  weekStartDate.setDate(weekStartDate.getDate() + weekOffset * 7);
  const weekEndDate = new Date(weekStartDate); weekEndDate.setDate(weekStartDate.getDate() + 6);
  const weekLabel = `${weekStartDate.getDate()} ${MON[weekStartDate.getMonth()]} – ${weekEndDate.getDate()} ${MON[weekEndDate.getMonth()]}${weekEndDate.getFullYear() !== KANBO_TODAY.getFullYear() ? ` ${weekEndDate.getFullYear()}` : ""}`;
  // a rendered element (not an inline component) so focus stays on ‹ › between clicks
  const nav = mode === "month" ? (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <IconButton icon="chevronLeft" size="sm" label="Previous month" onClick={() => setMonthOffset((m) => m - 1)} />
      <span className="ktv-range" aria-live="polite">{monthLabel}</span>
      <IconButton icon="chevronRight" size="sm" label="Next month" onClick={() => setMonthOffset((m) => m + 1)} />
      {monthOffset !== 0 && <Button variant="ghost" size="sm" onClick={() => setMonthOffset(0)}>Today</Button>}
    </div>
  ) : (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <IconButton icon="chevronLeft" size="sm" label="Previous week" onClick={() => setWeekOffset((w) => w - 1)} />
      <span className="ktv-range" aria-live="polite">{weekOffset === 0 ? "This week" : weekLabel}</span>
      <IconButton icon="chevronRight" size="sm" label="Next week" onClick={() => setWeekOffset((w) => w + 1)} />
      {weekOffset !== 0 && <Button variant="ghost" size="sm" onClick={() => setWeekOffset(0)}>Today</Button>}
    </div>
  );

  // index tasks and external events by local calendar day once (not per cell)
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const tasksByDay = new Map<string, Task[]>();
  for (const t of tasks) if (t.dueDate) (tasksByDay.get(t.dueDate) ?? tasksByDay.set(t.dueDate, []).get(t.dueDate)!).push(t);
  const evByDate: Record<string, ExternalEvent[]> = {};
  for (const e of externalEvents) {
    const key = e.allDay ? (e.start || "").slice(0, 10) : toLocalISO(new Date(e.start));
    if (key) (evByDate[key] ||= []).push(e);
  }
  const fmtTime = (e: ExternalEvent) => (e.allDay ? "" : hhmm(new Date(e.start)));
  const isMobile = useMediaQuery("(max-width: 860px)");
  const todayIso = toLocalISO(KANBO_TODAY);

  const scopeSwitch = scope && onScopeChange && (
    <Segmented ariaLabel="Whose tasks" value={scope} onChange={onScopeChange} options={[{ value: "mine", label: "Mine" }, { value: "team", label: "Team" }]} />
  );
  const prompt = onOpenSettings && connections.length === 0 && (
    <div className="ktv-cal-prompt">
      <Icon name="calendar" size={16} sw={1.75} />
      <span>Connect Google Calendar in Settings to see your meetings.</span>
      <Button variant="ghost" size="sm" onClick={onOpenSettings}>Open Settings</Button>
    </div>
  );
  const connectMenu = onConnect && onDisconnect && <ConnectCalendarMenu connections={connections} onConnect={onConnect} onDisconnect={onDisconnect} syncing={syncing} />;
  const taskName = (t: Task) => `${t.title} (${STATUS_META[t.status].label})`;

  // ---- mobile: an agenda list (the 7-col grid can't fit a phone) ----
  if (isMobile) {
    const agenda: { d: number; iso: string; tasks: Task[]; events: ExternalEvent[] }[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const di = iso(d);
      const dt = tasksByDay.get(di) ?? [];
      const de = evByDate[di] ?? [];
      if (dt.length || de.length) agenda.push({ d, iso: di, tasks: dt, events: de });
    }
    return (
      <div className="ktv ktv-cal">
        <div className="ktv-cal-head">
          {nav}
          <div className="ktv-cal-end">{scopeSwitch}{connectMenu}</div>
        </div>
        {prompt}
        {agenda.length === 0 ? (
          <EmptyState art="calendar" title="Nothing scheduled this month" body="Tasks with a due date, and your connected calendar's events, show up here." />
        ) : agenda.map((day) => (
          <div key={day.iso} className="ktv-agenda-day">
            <h3 data-today={day.iso === todayIso || undefined}>{dayLabel(day.iso, "long")}{day.iso === todayIso && <span className="ktv-mono">Today</span>}</h3>
            {day.events.map((e) => (
              <div key={e.id} className="ktv-agenda-item" data-event="true">
                <Icon name="calendar" size={14} />
                <span>{e.title}</span>
                <span className="ktv-mono" style={{ color: "var(--ink-3)" }}>{fmtTime(e) || "All day"}</span>
              </div>
            ))}
            {day.tasks.map((t) => {
              const proj = getProject(t.projectId);
              return (
                <button key={t.id} type="button" className="ktv-agenda-item" onClick={() => onOpen(t.id)} aria-label={taskName(t)}>
                  <StatusGlyph status={t.status} size={16} readOnly />
                  <span style={{ color: t.status === "done" ? "var(--ink-3)" : undefined, textDecoration: t.status === "done" ? "line-through" : undefined }}>{t.title}</span>
                  {proj && <ProjectDot color={proj.color} />}
                  <Avatar id={t.assigneeId} size={20} />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  // one date grid for a month (whole weeks, Monday first) or a single week
  const gridDates: Date[] = mode === "week"
    ? Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStartDate); d.setDate(weekStartDate.getDate() + i); return d; })
    : (() => {
        const first = new Date(year, month, 1);
        const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
        const weeks = Math.ceil((((first.getDay() + 6) % 7) + daysInMonth) / 7);
        return Array.from({ length: weeks * 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
      })();
  // dropping a task on a day moves its due date there (and a start date with it, keeping the length)
  const dropOnDay = (dayIso: string) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("text/kanbo-cal")) return;
    e.preventDefault(); setDropDay(null);
    const id = e.dataTransfer.getData("text/kanbo-cal");
    const t = byId.get(id);
    if (!t || !onPatch) return;
    const patch = timelineMovePatch(t, t.dueDate ?? null, dayIso);
    if (patch) onPatch(id, patch);
  };
  const popDay = dayPop ? { dt: tasksByDay.get(dayPop.iso) ?? [], de: evByDate[dayPop.iso] ?? [], long: dayLabel(dayPop.iso, "long") } : null;

  return (
    <div className="ktv ktv-cal">
      <div className="ktv-cal-head">
        {nav}
        <div className="ktv-cal-end">
          {connectMenu}
          <Segmented ariaLabel="Calendar range" value={mode} onChange={switchMode} options={[{ value: "month", label: "Month" }, { value: "week", label: "Week" }]} />
          {scopeSwitch}
        </div>
      </div>
      {prompt}
      <div style={{ overflowX: "auto" }}>
        <div className="ktv-cal-wd" aria-hidden="true">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d}>{d}</span>)}</div>
        <div className="ktv-cal-grid" data-mode={mode}>
          {gridDates.map((date) => {
            const dayIso = toLocalISO(date);
            const dayTasks = tasksByDay.get(dayIso) ?? [];
            const dayEvents = evByDate[dayIso] ?? [];
            const outside = mode === "month" && date.getMonth() !== month;
            const taskCap = mode === "week" ? 99 : 3;
            const evCap = mode === "week" ? 99 : 2;
            const overflow = Math.max(0, dayTasks.length - taskCap) + Math.max(0, dayEvents.length - evCap);
            const weekend = date.getDay() === 0 || date.getDay() === 6;
            return (
              <div key={dayIso} className="ktv-cal-cell" data-outside={outside || undefined} data-weekend={weekend || undefined} data-drop={dropDay === dayIso || undefined}
                onDragOver={canEdit ? (e) => { if (e.dataTransfer.types.includes("text/kanbo-cal")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropDay((d) => (d === dayIso ? d : dayIso)); } } : undefined}
                onDragLeave={canEdit ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropDay((d) => (d === dayIso ? null : d)); } : undefined}
                onDrop={canEdit ? dropOnDay(dayIso) : undefined}>
                <span className="ktv-cal-num" data-today={dayIso === todayIso || undefined} aria-label={dayLabel(dayIso, "long")}>{date.getDate()}</span>
                {dayEvents.slice(0, evCap).map((e) => {
                  const time = fmtTime(e);
                  return (
                    <span key={e.id} className="ktv-cal-event" title={`${time ? time + " · " : ""}${e.title}`}>
                      {time && <time>{time}</time>}
                      <span>{e.title}</span>
                    </span>
                  );
                })}
                {dayTasks.slice(0, taskCap).map((t) => (
                  <button key={t.id} type="button" className="ktv-cal-task" data-done={t.status === "done" || undefined} onClick={() => onOpen(t.id)} draggable={canEdit}
                    onDragStart={canEdit ? (e) => { e.dataTransfer.setData("text/kanbo-cal", t.id); e.dataTransfer.effectAllowed = "move"; } : undefined}
                    onDragEnd={canEdit ? () => setDropDay(null) : undefined}
                    aria-label={taskName(t)} title={canEdit ? `${t.title}: drag to another day to reschedule` : t.title}>
                    <span aria-hidden="true" style={{ display: "inline-flex" }}><StatusGlyph status={t.status} size={14} readOnly /></span>
                    <span>{t.title}</span>
                  </button>
                ))}
                {overflow > 0 && (
                  <button type="button" className="ktv-cal-more" onClick={(e) => setDayPop({ iso: dayIso, anchor: e.currentTarget })} aria-haspopup="dialog"
                    aria-label={`Show all ${dayTasks.length + dayEvents.length} items on ${dayLabel(dayIso, "long")}`}>
                    +{overflow} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {dayPop && popDay && (
        <Popover anchor={dayPop.anchor} role="dialog" label={`Everything on ${popDay.long}`} onClose={() => setDayPop(null)} minWidth={272} maxWidth={320}>
          <div className="ktv-dayp">
            <div className="ktv-dayp-head">
              <span>{popDay.long}</span>
              <span className="ktv-mono" style={{ color: "var(--ink-4)" }}>{popDay.dt.length + popDay.de.length}</span>
              <IconButton icon="x" size="sm" label="Close" onClick={() => setDayPop(null)} />
            </div>
            {popDay.de.map((e) => (
              <div key={e.id} className="ktv-cal-event" style={{ height: 28, margin: "0 4px" }}>
                <time>{fmtTime(e) || "All day"}</time><span>{e.title}</span>
              </div>
            ))}
            {popDay.dt.map((t, i) => (
              <RowButton key={t.id} autoFocus={i === 0} onClick={() => { setDayPop(null); onOpen(t.id); }}>
                <StatusGlyph status={t.status} size={14} readOnly />
                <span className="truncate" style={{ flex: 1, minWidth: 0, color: t.status === "done" ? "var(--ink-3)" : "var(--ink)", textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</span>
                <Avatar id={t.assigneeId} size={20} />
              </RowButton>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

/* ---------------- EISENHOWER MATRIX (urgent × important) ---------------- */
const QUAD_CAP = 50;
export function MatrixView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const [expandedQ, setExpandedQ] = useState<Set<string>>(new Set());
  const todayMid = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate()).getTime();
  // a sub-task hides only when its parent is on the matrix too
  const open = hideNestedSubtasks(tasks.filter((t) => t.status !== "done" && !t.archivedAt));
  const isUrgent = (t: Task) => !!t.dueDate && new Date(t.dueDate + "T00:00:00").getTime() <= todayMid + 2 * 86400000;
  const isImportant = (t: Task) => t.priority === "urgent" || t.priority === "high";
  const quads: { key: string; title: string; sub: string; tone?: "signal"; items: Task[] }[] = [
    { key: "do", title: "Do first", sub: "Important and urgent", tone: "signal", items: open.filter((t) => isImportant(t) && isUrgent(t)) },
    { key: "schedule", title: "Schedule", sub: "Important, not urgent", items: open.filter((t) => isImportant(t) && !isUrgent(t)) },
    { key: "delegate", title: "Delegate", sub: "Urgent, not important", items: open.filter((t) => !isImportant(t) && isUrgent(t)) },
    { key: "later", title: "Later", sub: "Neither: trim or defer", items: open.filter((t) => !isImportant(t) && !isUrgent(t)) },
  ];
  return (
    <div className="ktv ktv-matrix">
      <p>Urgency comes from the due date, importance from priority. Focus on “Do first”; protect time for “Schedule”.</p>
      <div className="ktv-quads">
        {quads.map((q) => {
          const all = expandedQ.has(q.key);
          const list = all ? q.items : q.items.slice(0, QUAD_CAP);
          const hidden = q.items.length - list.length;
          return (
            <div key={q.key} role="group" aria-label={`${q.title}: ${q.sub}`} className="ktv-quad" data-tone={q.tone}>
              <div className="ktv-quad-head"><b>{q.title}</b><span>{q.sub}</span><small>{q.items.length}</small></div>
              {q.items.length === 0 ? <span className="ktv-quad-empty">Nothing here.</span> : list.map((t) => {
                const proj = getProject(t.projectId);
                const ds = dueState(t.dueDate, t.status);
                return (
                  <button key={t.id} type="button" className="ktv-quad-item" onClick={() => onOpen(t.id)}>
                    <StatusGlyph status={t.status} size={14} readOnly />
                    <span>{t.title}</span>
                    {proj && <ProjectDot color={proj.color} title={proj.name} />}
                    {t.dueDate && <span className="ktv-mono" style={{ color: ds === "overdue" ? "var(--signal, var(--prio-urgent))" : "var(--ink-3)" }}>{fmtDue(t.dueDate)}</span>}
                  </button>
                );
              })}
              {hidden > 0 && <Button variant="ghost" size="sm" icon="chevronDown" onClick={() => setExpandedQ((s) => new Set(s).add(q.key))}>Show all {q.items.length}</Button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- FILES (all attachments across the current scope) ---------------- */
const FILE_ID_CHUNK = 80;                 // task ids per request — keeps each query string short
const FILE_REFRESH_MS = 45 * 60 * 1000;   // signed links last an hour; re-sign well before that
function bytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
export function FilesView({ tasks, onOpen }: { tasks: Task[]; allTasks?: Task[]; onOpen: (id: string) => void }) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const reqRef = useRef(0);
  const loadedAt = useRef(0);
  const loadedIds = useRef<Set<string> | null>(null); // the task ids `files` was fetched for (null until a load succeeds)
  // order-insensitive, so re-sorting the tasks in view doesn't refetch
  const idKey = useMemo(() => [...new Set(tasks.map((t) => t.id))].sort().join(","), [tasks]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  /** quiet: keep the list on screen (re-signing links, a task added); otherwise show loading, then the list or an error */
  const load = useCallback(async (quiet: boolean) => {
    const req = ++reqRef.current;
    const idList = idKey ? idKey.split(",") : [];
    if (!quiet) { setStatus("loading"); setRefreshFailed(false); loadedIds.current = null; loadedAt.current = 0; }
    try {
      // query in chunks — one huge IN (...) list fails on big projects
      const parts = await Promise.all(chunk(idList, FILE_ID_CHUNK).map((c) => store.listProjectAttachments(c)));
      if (req !== reqRef.current) return;
      const seen = new Set<string>();
      const merged: Attachment[] = [];
      for (const a of parts.flat()) if (!seen.has(a.id)) { seen.add(a.id); merged.push(a); }
      merged.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      setFiles(merged); setBroken(new Set()); setRefreshFailed(false);
      loadedIds.current = new Set(idList);
      loadedAt.current = Date.now();
      setStatus("ready");
    } catch (err) {
      if (req !== reqRef.current) return;
      reportError(err);
      // a failed background refresh keeps the (still correct) list on screen; a failed load says so
      if (quiet && loadedIds.current) setRefreshFailed(true);
      else setStatus("error");
    }
  }, [idKey]);

  // when the tasks in view change: fewer tasks just narrow the list below; a task added
  // alongside ones already loaded refreshes quietly; a different set of tasks (another
  // project or workspace — this view isn't remounted between them) loads afresh, so the
  // previous project's files are never shown while or after it loads
  useEffect(() => {
    const prev = loadedIds.current;
    const next = idKey ? idKey.split(",") : [];
    if (!prev) { load(false); return; }
    if (next.every((id) => prev.has(id))) return;
    load(next.some((id) => prev.has(id)));
  }, [idKey, load]);
  useEffect(() => () => { reqRef.current++; }, []); // ignore responses after unmount
  // re-sign links before they expire (checked each minute and when the tab comes back)
  useEffect(() => {
    const tick = () => {
      if (loadedIds.current && loadedAt.current && document.visibilityState === "visible" && Date.now() - loadedAt.current > FILE_REFRESH_MS) load(true);
    };
    const iv = window.setInterval(tick, 60 * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(iv); document.removeEventListener("visibilitychange", tick); };
  }, [load]);

  // only files of tasks in view — belt and braces against a list fetched for another set of tasks
  const shown = files.filter((a) => taskById.has(a.taskId));

  return (
    <div className="ktv ktv-files">
      {status === "loading" ? (
        <div role="status" className="ktv-note" style={{ justifyContent: "center", padding: "56px 0" }}>Loading files…</div>
      ) : status === "error" ? (
        <div role="alert">
          <EmptyState art="folder" title="Couldn't load files" body="Something went wrong fetching attachments. Your files are safe: check your connection and try again."
            action={<Button variant="secondary" icon="refresh" onClick={() => load(false)}>Retry</Button>} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState art="folder" title="No files yet" body="Attachments added to tasks here will appear in one place." />
      ) : (
        <>
          {refreshFailed && (
            <div role="alert" className="ktv-banner">
              <span>Couldn't refresh files, so some links may have expired or new files may be missing.</span>
              <Button variant="ghost" size="sm" icon="refresh" onClick={() => load(true)}>Retry</Button>
            </div>
          )}
          <div className="ktv-files-grid">
            {shown.map((att) => {
              const task = taskById.get(att.taskId);
              const img = att.mime?.startsWith("image/") && att.url && !broken.has(att.id);
              return (
                <div key={att.id} className="ktv-file">
                  <button type="button" className="ktv-file-open" onClick={() => task && onOpen(task.id)} disabled={!task} aria-label={task ? `${att.name}, attached to ${task.title}. Open task` : att.name}>
                    <div className="ktv-file-thumb">
                      {img ? <img src={att.url} alt="" loading="lazy" onError={() => setBroken((s) => new Set(s).add(att.id))} /> : <Icon name="folder" size={24} sw={1.5} />}
                    </div>
                    <div className="ktv-file-name">{att.name}</div>
                    <div className="ktv-file-sub"><span className="ktv-mono">{bytes(att.size)}</span>{task ? ` · ${task.title}` : ""}</div>
                  </button>
                  {att.url
                    ? <a href={att.url} target="_blank" rel="noreferrer" className="ktv-file-link" aria-label={`Open ${att.name} in a new tab`}><Icon name="arrowUpRight" size={12} /> Open</a>
                    : <span className="ktv-file-link" style={{ color: "var(--ink-3)" }}>Link unavailable</span>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
