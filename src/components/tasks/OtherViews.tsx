/* ============================================================
   KANBO — Board (Kanban), Timeline (Gantt), Calendar, Matrix
   and Files views
   ============================================================ */
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useId, memo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, Avatar, StatusDot, Tag, PriorityFlag, EmptyArt, wasJustLanded, markJustLanded } from "../primitives";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { bulkItemStyle, BulkMenuButton, CustomChips } from "./ListView";
import {
  getProject, getMember, dueState, fmtDue,
  STATUS_META, STATUS_ORDER, PRIORITY_META, KANBO_TODAY, toLocalISO,
} from "../../data/data";
import type { Task, Status, Priority, Project, CalProvider, CalendarConnection, ExternalEvent, Attachment, CustomFieldDef } from "../../data/types";
import { store } from "../../data/store";
import { reportError } from "../../lib/monitoring";
import {
  addDaysISO, daysBetweenISO, mondayOf, weekOffsetForMonth, monthOffsetForWeek,
  hideNestedSubtasks, assigneeColumnKey, UNASSIGNED_COL, FORMER_COL, NO_PROJECT_COL,
  planReorder, barSpan, clipSpan, effectiveStartISO, timelineMovePatch, timelineStartPatch,
  wipStorageKey, readWipLimits, parseWipLimit, chunk, type BarSpan,
} from "./otherViewsLogic";

type BoardGroup = "status" | "priority" | "project" | "assignee";

const PROVIDER_META: Record<CalProvider, { label: string; color: string }> = {
  google: { label: "Google Calendar", color: "oklch(0.7 0.18 25)" },
  microsoft: { label: "Microsoft / Outlook", color: "oklch(0.62 0.16 250)" },
};

// subtle hover / focus fill that reads in both themes (new token first, then a fallback)
const FILL_HOT = "var(--fill-1, color-mix(in oklch, var(--ink) 7%, transparent))";
const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined, opts);

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
      <div ref={backdropRef} onClick={(e) => { e.stopPropagation(); closeRef.current(); }} style={{ position: "fixed", inset: 0, zIndex: 80 }} />
      <div ref={boxRef} style={{ position: "fixed", zIndex: 81, visibility: ready ? "visible" : "hidden" }}>
        <div ref={panelRef} role={role} aria-label={label} aria-modal={role === "dialog" ? true : undefined}
          onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()} className={ready ? "anim-scalein" : undefined}
          style={{ minWidth, maxWidth, overflowY: "auto", padding: 5, borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

function MenuItem({ checked, onSelect, children }: { checked?: boolean; onSelect: () => void; children: ReactNode }) {
  const [hot, setHot] = useState(false);
  return (
    <button type="button" role={checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={checked}
      onClick={onSelect} onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
      onFocus={() => setHot(true)} onBlur={() => setHot(false)}
      style={{ ...bulkItemStyle, background: hot ? FILL_HOT : "transparent" }}>
      {children}
      {checked && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
    </button>
  );
}

/* ---------------- KANBAN ---------------- */
type Half = "top" | "bottom";
type CardMenu = null | "priority" | "assignee" | "status" | "move";
const CARD_CAP = 50; // cards rendered per column before "Show more"

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
}

const KanbanCard = memo(function KanbanCard(p: KanbanCardProps) {
  const { task, onPatch, members } = p;
  const proj = getProject(task.projectId);
  const ds = dueState(task.dueDate, task.status);
  const [menu, setMenu] = useState<CardMenu>(null);
  const statusBtn = useRef<HTMLButtonElement>(null);
  const prioBtn = useRef<HTMLButtonElement>(null);
  const assignBtn = useRef<HTMLButtonElement>(null);
  const moveBtn = useRef<HTMLButtonElement>(null);
  const PRIORITIES_INLINE: Priority[] = ["urgent", "high", "medium", "low"];
  const [hovered, setHovered] = useState(false);
  const [selFocus, setSelFocus] = useState(false);
  // spring "settle" when this card was just dropped (survives a re-mount into a new column)
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
  const dueColor = task.dueDate ? (ds === "overdue" ? "var(--prio-urgent)" : ds === "today" ? "var(--accent)" : "var(--ink-4)") : "var(--ink-4)";
  const label = [task.title, STATUS_META[task.status].label, `${PRIORITY_META[task.priority].label} priority`,
    dueText ? `due ${dueText}` : null, assignee ? `assigned to ${assignee.name}` : null, p.blocked ? "blocked" : null].filter(Boolean).join(", ");
  const triggerStyle: React.CSSProperties = { border: "none", background: "transparent", padding: 3, margin: -3, borderRadius: 6, cursor: "pointer", display: "inline-flex" };

  return (
    <div data-card-id={task.id} role="button" tabIndex={0} aria-label={label} aria-describedby={p.hintId}
      onClick={() => p.onOpen(task.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // keys inside the card's own controls
        if (!e.altKey && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); p.onOpen(task.id); return; }
        if (e.altKey && p.onKeyMove && e.key.startsWith("Arrow")) { e.preventDefault(); p.onKeyMove(task.id, e.key); }
      }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      className={"glass clickable lift" + (landed ? " kland" : "")} draggable={p.canDrag}
      onDragStart={p.canDrag ? (e) => { e.dataTransfer.setData("text/kanbo-task", task.id); e.dataTransfer.effectAllowed = "move"; p.onPickup(task.id); } : undefined}
      onDragEnd={p.canDrag ? p.onDragDone : undefined}
      onDragOver={p.canDrag && p.acceptsDrop ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); p.onHoverCard(task.id, halfFrom(e)); } : undefined}
      onDrop={p.canDrag && p.acceptsDrop ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData("text/kanbo-task"); p.onCardDrop(id, task.id, halfFrom(e)); } : undefined}
      style={{ padding: 13, borderRadius: 12, cursor: p.canDrag ? "grab" : "pointer", opacity: p.dragging ? 0.4 : 1, position: "relative",
        // cards sit on a flat lane, so a per-card backdrop blur buys nothing and costs a compositing layer each
        backdropFilter: "none", WebkitBackdropFilter: "none",
        outline: p.selected ? "1.5px solid var(--accent)" : undefined, background: p.selected ? "var(--accent-dim)" : undefined,
        boxShadow: p.dropHint === "top" ? "inset 0 3px 0 -1px var(--accent)" : p.dropHint === "bottom" ? "inset 0 -3px 0 -1px var(--accent)" : undefined }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        {p.onSelect && (
          <button onClick={(e) => { e.stopPropagation(); p.onSelect?.(task.id); }} aria-label={p.selected ? `Deselect ${task.title}` : `Select ${task.title}`}
            style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, padding: 0, cursor: "pointer", display: "grid", placeItems: "center", marginTop: 1,
              border: `1.6px solid ${p.selected ? "var(--accent)" : "var(--hairline-strong)"}`, background: p.selected ? "var(--accent)" : "transparent",
              opacity: p.selected || p.selectionActive || hovered || selFocus ? 1 : 0, transition: "opacity .12s" }}
            onFocus={() => setSelFocus(true)} onBlur={() => setSelFocus(false)}>
            {p.selected && <Icon name="check" size={11} sw={3} style={{ color: "var(--on-accent)" }} />}
          </button>
        )}
        {onPatch ? (
          <span style={{ display: "inline-flex", marginTop: 2 }} onClick={(e) => e.stopPropagation()}>
            <button ref={statusBtn} onClick={() => toggle("status")} aria-label={`Status: ${STATUS_META[task.status].label}. Change status of ${task.title}`}
              aria-haspopup="menu" aria-expanded={menu === "status"} title={STATUS_META[task.status].label} style={triggerStyle}><StatusDot status={task.status} size={9} /></button>
            {menu === "status" && (
              <Popover anchor={statusBtn.current} label={`Status of ${task.title}`} onClose={() => setMenu(null)} minWidth={160}>
                {STATUS_ORDER.map((s) => (
                  <MenuItem key={s} checked={task.status === s} onSelect={() => choose(() => { if (s !== task.status) onPatch(task.id, { status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined }); })}>
                    <StatusDot status={s} size={9} /> {STATUS_META[s].label}
                  </MenuItem>
                ))}
              </Popover>
            )}
          </span>
        ) : null}
        {onPatch ? (
          <span style={{ display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
            <button ref={prioBtn} onClick={() => toggle("priority")} aria-label={`Priority: ${PRIORITY_META[task.priority].label}. Change priority of ${task.title}`}
              aria-haspopup="menu" aria-expanded={menu === "priority"} style={triggerStyle}><PriorityFlag priority={task.priority} size={13} /></button>
            {menu === "priority" && (
              <Popover anchor={prioBtn.current} label={`Priority of ${task.title}`} onClose={() => setMenu(null)} minWidth={160}>
                {PRIORITIES_INLINE.map((pr) => (
                  <MenuItem key={pr} checked={task.priority === pr} onSelect={() => choose(() => { if (pr !== task.priority) onPatch(task.id, { priority: pr }); })}>
                    <PriorityFlag priority={pr} size={13} /> {PRIORITY_META[pr].label}
                  </MenuItem>
                ))}
              </Popover>
            )}
          </span>
        ) : <PriorityFlag priority={task.priority} size={13} />}
        {task.isMilestone && <span title="Milestone" style={{ width: 9, height: 9, transform: "rotate(45deg)", background: "var(--st-review)", borderRadius: 2, flexShrink: 0, marginTop: 3 }} />}
        <span style={{ flex: 1, fontSize: 13.5, lineHeight: 1.35, fontWeight: 450, overflowWrap: "anywhere" }}>{task.title}</span>
      </div>
      {(task.tags || []).length > 0 && <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>{task.tags.slice(0, 2).map((tg) => <Tag key={tg} id={tg} small />)}</div>}
      {p.customFields.length > 0 && (task.custom && Object.keys(task.custom).length > 0) && <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}><CustomChips task={task} fields={p.customFields} members={members} /></div>}
      {p.blocked && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 9, fontSize: 11, color: "var(--st-blocked)" }}>
          <Icon name="lock" size={12} /> Blocked
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 11 }}>
        {proj && <span title={proj.name} style={{ width: 7, height: 7, borderRadius: 2, background: proj.color }} />}
        {p.subTotal > 0 && (
          <span title={`${p.subDone} of ${p.subTotal} sub-tasks done`} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>
            <Icon name="layers" size={12} /> {p.subDone}/{p.subTotal}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {onPatch ? (
          <label onClick={(e) => e.stopPropagation()} style={{ position: "relative", display: "inline-flex", alignItems: "center" }} title="Set due date">
            <span className="mono" style={{ fontSize: 11, color: dueColor, cursor: "pointer" }}>{dueText ?? "—"}</span>
            <input type="date" value={task.dueDate || ""} onChange={(e) => onPatch(task.id, { dueDate: e.target.value || undefined })} aria-label={`Due date for ${task.title}`} style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: "pointer" }} />
          </label>
        ) : (dueText && <span className="mono" style={{ fontSize: 11, color: dueColor }}>{dueText}</span>)}
        {onPatch && members.length > 0 ? (
          <span style={{ display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
            <button ref={assignBtn} onClick={() => toggle("assignee")} aria-label={`${assignee ? `Assigned to ${assignee.name}` : "Unassigned"}. Change assignee of ${task.title}`}
              aria-haspopup="menu" aria-expanded={menu === "assignee"} style={{ ...triggerStyle, borderRadius: 99 }}>
              {assignee ? <Avatar id={task.assigneeId} size={22} /> : <span style={{ width: 22, height: 22, borderRadius: 99, display: "grid", placeItems: "center", border: "1.5px dashed var(--hairline-strong)", color: "var(--ink-4)" }}><Icon name="user" size={12} /></span>}
            </button>
            {menu === "assignee" && (
              <Popover anchor={assignBtn.current} align="end" label={`Assignee of ${task.title}`} onClose={() => setMenu(null)} minWidth={190} maxWidth={280}>
                {members.map((m) => (
                  <MenuItem key={m.id} checked={task.assigneeId === m.id} onSelect={() => choose(() => { if (m.id !== task.assigneeId) onPatch(task.id, { assigneeId: m.id }); })}>
                    <Avatar id={m.id} size={18} /> <span className="truncate">{m.name}</span>
                  </MenuItem>
                ))}
              </Popover>
            )}
          </span>
        ) : <Avatar id={task.assigneeId} size={22} />}
        {/* touch devices can't drag between columns — give a tap-to-move menu */}
        {p.isMobile && p.onMove && (
          <span style={{ display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
            <button ref={moveBtn} className="btn-icon" aria-label={`Move ${task.title} to another status`} aria-haspopup="menu" aria-expanded={menu === "move"}
              onClick={() => toggle("move")} style={{ border: "none", width: 30, height: 30, color: "var(--ink-3)" }}><Icon name="layers" size={15} /></button>
            {menu === "move" && (
              <Popover anchor={moveBtn.current} align="end" label={`Move ${task.title} to`} onClose={() => setMenu(null)} minWidth={176}>
                <div className="kicker" aria-hidden style={{ padding: "4px 9px 6px" }}>Move to</div>
                {STATUS_ORDER.map((s) => (
                  <MenuItem key={s} checked={task.status === s} onSelect={() => choose(() => { if (s !== task.status) p.onMove?.(task.id, s); })}>
                    <StatusDot status={s} size={7} /> {STATUS_META[s].label}
                  </MenuItem>
                ))}
              </Popover>
            )}
          </span>
        )}
      </div>
    </div>
  );
});

/** Small dialog for a column's work-in-progress limit (replaces window.prompt). */
function WipLimitEditor({ column, current, onSave, onClose }: { column: string; current?: number; onSave: (n: number | null) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(current != null ? String(current) : "");
  const [error, setError] = useState("");
  const inputId = useId();
  const submit = () => {
    const v = parseWipLimit(draft);
    if (v === "invalid") { setError("Enter a whole number from 1 to 999, or leave it blank."); return; }
    onSave(v); onClose();
  };
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); submit(); }} style={{ padding: "6px 7px 7px", width: 236, display: "flex", flexDirection: "column", gap: 8 }}>
      <label htmlFor={inputId} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)" }}>WIP limit for {column}</label>
      <input id={inputId} data-autofocus type="number" inputMode="numeric" min={1} max={999} value={draft}
        onChange={(e) => { setDraft(e.target.value); setError(""); }} placeholder="No limit" aria-invalid={!!error} aria-describedby={`${inputId}-help`}
        style={{ height: 34, padding: "0 10px", borderRadius: 9, border: `1px solid ${error ? "var(--prio-urgent)" : "var(--hairline-strong)"}`, background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 13.5 }} />
      <p id={`${inputId}-help`} role={error ? "alert" : undefined} style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: error ? "var(--prio-urgent)" : "var(--ink-4)" }}>
        {error || "The count turns red when the column holds more than this. Saved for this board on this device."}
      </p>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {current != null && <button type="button" className="btn btn-ghost" onClick={() => { onSave(null); onClose(); }} style={{ padding: "6px 10px", fontSize: 12.5, marginRight: "auto" }}>Remove</button>}
        <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: "6px 10px", fontSize: 12.5 }}>Cancel</button>
        <button type="submit" className="btn btn-accent" style={{ padding: "6px 12px", fontSize: 12.5 }}>Save</button>
      </div>
    </form>
  );
}

interface BoardCol { key: string; label: string; status?: Status; dot?: string; avatar?: string; accepts: boolean; hint?: string }

export function BoardView({ tasks, allTasks, onOpen, onAdd, onMove, onPatch, onBulkPatch, onBulkDelete, members = [], customFields = [], readOnly = false, scopeKey }: {
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
  const [group, setGroup] = useState<BoardGroup>(() => {
    try { const s = localStorage.getItem("kanbo-board-group") as BoardGroup | null; if (s && ["status", "priority", "project", "assignee"].includes(s)) return s; } catch { /* ignore */ }
    return "status";
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { const s = localStorage.getItem("kanbo-board-collapsed"); if (s) return new Set(JSON.parse(s)); } catch { /* ignore */ }
    return new Set();
  });
  useEffect(() => { try { localStorage.setItem("kanbo-board-group", group); } catch { /* ignore */ } }, [group]);
  useEffect(() => { try { localStorage.setItem("kanbo-board-collapsed", JSON.stringify([...collapsed])); } catch { /* ignore */ } }, [collapsed]);

  // per-column WIP limits, saved per board (route / project) so one board's limit never shows on another
  const derivedScope = (() => { const pids = new Set(tasks.map((t) => t.projectId)); return pids.size === 1 ? `project:${[...pids][0]}` : "all"; })();
  const wipScope = scopeKey ?? derivedScope;
  const [wipCache, setWipCache] = useState<Record<string, Record<string, number>>>({});
  const wip = useMemo(() => wipCache[wipScope] ?? (() => { try { return readWipLimits(localStorage.getItem(wipStorageKey(wipScope))); } catch { return {}; } })(), [wipCache, wipScope]);
  const wipKey = (k: string) => `${group}:${k}`;
  const saveLimit = (k: string, n: number | null) => {
    const next = { ...wip };
    if (n == null) delete next[wipKey(k)]; else next[wipKey(k)] = n;
    setWipCache((c) => ({ ...c, [wipScope]: next }));
    try { localStorage.setItem(wipStorageKey(wipScope), JSON.stringify(next)); } catch { /* ignore */ }
  };

  // one pass over allTasks for sub-task counts and blockers (not one scan per card)
  const byId = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
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
    : group === "priority" ? (["urgent", "high", "medium", "low"] as Priority[]).map((pr) => ({ key: pr, label: PRIORITY_META[pr].label, dot: PRIORITY_META[pr].color, accepts: true }))
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
  const moveTo = useCallback((draggedId: string, colKey: string, index: number) => {
    const L = live.current;
    const col = L.columns.find((c) => c.key === colKey);
    const task = L.byId.get(draggedId);
    if (!col || !col.accepts || !task) return;
    const plan = planReorder(L.colItems[colKey] ?? [], draggedId, index);
    const mine = plan.find((x) => x.id === draggedId);
    if (!mine) return;
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
      moveTo(id, colKey, to);
      setAnnounce(`${title} moved ${up ? "up" : "down"}, ${to + 1} of ${list.length} in ${col.label}`);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const dir = key === "ArrowLeft" ? -1 : 1;
      let j = ci + dir;
      while (j >= 0 && j < L.columns.length && (!L.columns[j].accepts || L.collapsed.has(L.columns[j].key))) j += dir;
      if (j < 0 || j >= L.columns.length) { setAnnounce(`There's no column to the ${dir < 0 ? "left" : "right"} of ${col.label}`); return; }
      const dest = L.columns[j];
      moveTo(id, dest.key, Math.min((L.colItems[dest.key] ?? []).length, L.shown[dest.key] ?? CARD_CAP));
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
    const el = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-card-id]") ?? []).find((n) => n.dataset.cardId === req.id);
    const ae = document.activeElement;
    // keyboard moves follow the card (scrolling to it); after a menu pick we only rescue lost focus
    if (el && (req.force || !ae || ae === document.body)) el.focus({ preventScroll: !req.force });
  });
  const toggleCollapse = (key: string) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const GROUPS: { v: BoardGroup; label: string }[] = [{ v: "status", label: "Status" }, { v: "priority", label: "Priority" }, { v: "project", label: "Project" }, { v: "assignee", label: "Assignee" }];
  const colBg = "color-mix(in oklch, var(--bg-deep) 28%, transparent)";

  return (
    <div ref={rootRef} style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      {/* board group selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 24px 0" }}>
        <span className="kicker" id={`${hintId}-cols`}>Columns</span>
        <div role="group" aria-labelledby={`${hintId}-cols`} style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)" }}>
          {GROUPS.map((g) => (
            <button key={g.v} onClick={() => setGroup(g.v)} aria-pressed={group === g.v} style={{ padding: "5px 11px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500,
              background: group === g.v ? "var(--accent)" : "transparent", color: group === g.v ? "var(--on-accent)" : "var(--ink-3)" }}>{g.label}</button>
          ))}
        </div>
        {readOnly && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginLeft: 4, fontSize: 12, color: "var(--ink-4)" }}><Icon name="lock" size={12} /> View only</span>}
      </div>
      <p id={hintId} className="sr-only">{editable ? "Press Enter to open. Alt plus the arrow keys moves the card up, down or to the next column." : "Press Enter to open."}</p>
      <div role="status" aria-live="polite" className="sr-only">{announce}</div>
      <div style={{ display: "flex", gap: 16, padding: "16px 24px 28px", minHeight: "100%" }}>
        {columns.map((col) => {
          const items = colItems[col.key] ?? [];
          const cap = shown[col.key] ?? CARD_CAP;
          const visible = items.length > cap ? items.slice(0, cap) : items;
          const hiddenCount = items.length - visible.length;
          const isCollapsed = collapsed.has(col.key);
          const dropOk = canDrag && col.accepts;
          const lead = col.status ? null
            : col.avatar && getMember(col.avatar) ? <Avatar id={col.avatar} size={18} />
            : <span style={{ width: 9, height: 9, borderRadius: 99, background: col.dot || "var(--ink-4)", flexShrink: 0 }} />;
          if (isCollapsed) {
            return (
              <button key={col.key} onClick={() => toggleCollapse(col.key)} title={`Expand ${col.label}`} aria-expanded={false} aria-label={`Expand ${col.label} column, ${items.length} task${items.length === 1 ? "" : "s"}`}
                style={{ width: 46, flexShrink: 0, border: "1px solid var(--hairline)", borderRadius: 14, background: colBg, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "12px 0" }}>
                <Icon name="chevronRight" size={15} style={{ color: "var(--ink-4)" }} />
                {col.status ? <StatusDot status={col.status} /> : lead}
                <span className="mono tnum" style={{ fontSize: 11, color: "var(--ink-4)" }}>{items.length}</span>
                <span style={{ writingMode: "vertical-rl", fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", marginTop: 4 }}>{col.label}</span>
              </button>
            );
          }
          const limit = wip[wipKey(col.key)];
          const over = limit != null && items.length > limit;
          const countLabel = `${items.length} task${items.length === 1 ? "" : "s"} in ${col.label}${limit != null ? `, WIP limit ${limit}${over ? ", over the limit" : ""}` : ""}`;
          const countStyle: React.CSSProperties = { fontSize: 11.5, border: "none", borderRadius: 6, padding: "1px 7px", fontWeight: over ? 700 : 400, color: over ? "var(--prio-urgent)" : "var(--ink-4)", background: over ? "color-mix(in oklch, var(--prio-urgent) 15%, transparent)" : "var(--surface)" };
          return (
            <div key={col.key} role="group" aria-label={`${col.label} column`} style={{ width: isMobile ? 270 : 296, flexShrink: 0, display: "flex", flexDirection: "column" }}
              onDragOver={dropOk ? (e) => { if (e.dataTransfer.types.includes("text/kanbo-task")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(col.key); setHover(null); } } : undefined}
              onDragLeave={dropOk ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver((d) => d === col.key ? null : d); } : undefined}
              onDrop={dropOk ? (e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/kanbo-task"); if (id) onColumnDrop(id, col.key); else endHover(); } : undefined}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: col.hint ? "0 4px 4px" : "0 4px 12px" }}>
                <button onClick={() => toggleCollapse(col.key)} className="btn-icon" title="Collapse column" aria-expanded aria-label={`Collapse ${col.label} column`} style={{ width: 20, height: 20, border: "none", background: "transparent", color: "var(--ink-4)", flexShrink: 0 }}><Icon name="chevronRight" size={13} style={{ transform: "rotate(90deg)" }} /></button>
                {col.status ? <StatusDot status={col.status} glow /> : lead}
                <span className="truncate" style={{ fontSize: 13.5, fontWeight: 600 }}>{col.label}</span>
                {editable
                  ? <button onClick={(e) => setWipEdit({ key: col.key, label: col.label, anchor: e.currentTarget })} title="Set WIP limit" aria-label={`${countLabel}. Set WIP limit`} aria-haspopup="dialog" className="mono tnum" style={{ ...countStyle, cursor: "pointer" }}>{items.length}{limit != null ? `/${limit}` : ""}</button>
                  : <span className="mono tnum" aria-label={countLabel} style={countStyle}>{items.length}{limit != null ? `/${limit}` : ""}</span>}
                {col.status && editable && <button onClick={() => onAdd(col.status!)} className="btn-icon" title="Add task" aria-label={`Add task to ${col.label}`} style={{ marginLeft: "auto", width: 24, height: 24, border: "none", color: "var(--ink-4)" }}><Icon name="plus" size={15} /></button>}
              </div>
              {col.hint && <p style={{ margin: "0 4px 10px 33px", fontSize: 11.5, lineHeight: 1.4, color: "var(--ink-4)" }}>{col.hint}</p>}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, padding: 4, borderRadius: 14, minHeight: 120, transition: "background .15s, box-shadow .15s",
                background: dragOver === col.key ? "var(--accent-dim)" : colBg,
                boxShadow: dragOver === col.key && !hover ? "inset 0 0 0 2px var(--accent)" : "none" }}>
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
                      onKeyMove={editable ? onKeyMove : undefined} onMenuDone={onMenuDone} hintId={hintId} />
                  );
                })}
                {hiddenCount > 0 && (
                  <button onClick={() => setShown((s) => ({ ...s, [col.key]: cap + CARD_CAP }))} aria-label={`Show ${Math.min(CARD_CAP, hiddenCount)} more tasks in ${col.label}`}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500 }}>
                    <Icon name="chevronDown" size={14} /> Show {Math.min(CARD_CAP, hiddenCount)} more{hiddenCount > CARD_CAP ? <span style={{ color: "var(--ink-4)", fontWeight: 400 }}> · {hiddenCount} hidden</span> : null}
                  </button>
                )}
                {col.status && editable && (
                  <button onClick={() => onAdd(col.status!)} aria-label={`Add task to ${col.label}`} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px", borderRadius: 11, border: "1px dashed var(--hairline-strong)", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5 }}>
                    <Icon name="plus" size={14} /> Add task
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {wipEdit && (
        <Popover anchor={wipEdit.anchor} role="dialog" label={`WIP limit for ${wipEdit.label}`} onClose={() => setWipEdit(null)} minWidth={0}>
          <WipLimitEditor column={wipEdit.label} current={wip[wipKey(wipEdit.key)]} onSave={(n) => saveLimit(wipEdit.key, n)} onClose={() => setWipEdit(null)} />
        </Popover>
      )}

      {bulkEnabled && selectionActive && (
        <div className="anim-fadeup" style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 60,
          display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 14, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", border: "1px solid var(--hairline)" }}>
          <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", padding: "0 8px" }}>{selIds.length} selected</span>
          <span style={{ width: 1, height: 22, background: "var(--hairline)" }} />
          <button className="btn btn-ghost" onClick={() => applyBulk({ status: "done", completedAt: toLocalISO(new Date()) })} style={{ padding: "7px 11px", fontSize: 13 }}><Icon name="check" size={15} /> Done</button>
          <BulkMenuButton label="Status" icon="layers" open={bulkMenu === "status"} onToggle={() => setBulkMenu((m) => m === "status" ? null : "status")}>
            {STATUS_ORDER.map((s) => (<button key={s} onClick={() => applyBulk({ status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined })} style={bulkItemStyle}><StatusDot status={s} size={7} /> {STATUS_META[s].label}</button>))}
          </BulkMenuButton>
          <BulkMenuButton label="Priority" icon="flag" open={bulkMenu === "priority"} onToggle={() => setBulkMenu((m) => m === "priority" ? null : "priority")}>
            {BULK_PRIORITIES.map((pr) => (<button key={pr} onClick={() => applyBulk({ priority: pr })} style={bulkItemStyle}><PriorityFlag priority={pr} size={13} /> {PRIORITY_META[pr].label}</button>))}
          </BulkMenuButton>
          {members.length > 0 && (
            <BulkMenuButton label="Assign" icon="user" open={bulkMenu === "assignee"} onToggle={() => setBulkMenu((m) => m === "assignee" ? null : "assignee")}>
              {members.map((m) => (<button key={m.id} onClick={() => applyBulk({ assigneeId: m.id })} style={bulkItemStyle}><Avatar id={m.id} size={18} /> {m.name}</button>))}
            </BulkMenuButton>
          )}
          <button className="btn btn-ghost" onClick={() => { onBulkDelete?.(selIds); clearSel(); }} style={{ padding: "7px 11px", fontSize: 13, color: "var(--prio-urgent)" }}><Icon name="trash" size={15} /> Delete</button>
          <span style={{ width: 1, height: 22, background: "var(--hairline)" }} />
          <button className="btn-icon" onClick={clearSel} aria-label="Clear selection" style={{ border: "none", width: 30, height: 30 }}><Icon name="x" size={16} /></button>
        </div>
      )}
    </div>
  );
}

/* ---------------- TIMELINE (Gantt) ---------------- */
type TimelineZoom = "2w" | "6w";
const shortDate = (iso: string) => dayLabel(iso, { day: "numeric", month: "short" });

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
  // tighter columns + label on phones so more of the chart is visible
  const colW = wide ? (isMobile ? 18 : 26) : (isMobile ? 46 : 78);
  const inset = wide ? 2 : 6;
  const labelW = isMobile ? 124 : 230, rowH = 46, HEADER_H = 34, MORE_H = 42, ROW_CAP = 50;
  const trackW = DAYS * colW;
  const todayIso = toLocalISO(KANBO_TODAY);
  const windowStart = addDaysISO(todayIso, offset - LEAD);
  const dayIsos = Array.from({ length: DAYS }, (_, i) => addDaysISO(windowStart, i));
  const dates = dayIsos.map((iso) => new Date(iso + "T00:00:00"));
  const todayIdx = daysBetweenISO(windowStart, todayIso);
  const lastYear = dates[DAYS - 1].getFullYear();
  const rangeLabel = `${shortDate(dayIsos[0])} – ${shortDate(dayIsos[DAYS - 1])}${lastYear !== KANBO_TODAY.getFullYear() ? ` ${lastYear}` : ""}`;

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
    yAcc += HEADER_H;
    g.rows.forEach((t) => {
      const sp = spans.get(t.id);
      const c = sp ? clipSpan(sp, DAYS) : null;
      const v = c && typeof c === "object" ? c : null;
      layout.set(t.id, { y: yAcc + rowH / 2, barL: v ? labelW + v.vs * colW + inset : null, barR: v ? labelW + (v.ve + 1) * colW - inset : null });
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
      say(t.dueDate ? `“${t.title}” moved — now due ${dayLabel(patch.dueDate!)}` : `“${t.title}” scheduled for ${dayLabel(patch.dueDate!)}`);
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
      <div style={{ flex: 1, overflowY: "auto", padding: "24px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 380 }}>
          <div style={{ marginBottom: 14 }}><EmptyArt kind="layers" /></div>
          <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>Nothing to chart yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Add a few tasks and they'll lay out here on a timeline by project and due date.</p>
        </div>
      </div>
    );
  }

  const axisBg = "color-mix(in oklch, var(--bg) 88%, transparent)";
  const stickyBg = "color-mix(in oklch, var(--bg) 94%, transparent)";
  const edgeChip: React.CSSProperties = { position: "absolute", top: rowH / 2 - 11, height: 22, display: "inline-flex", alignItems: "center", gap: 2, borderRadius: 99, border: "1px solid var(--hairline)", background: "var(--surface-solid)", color: "var(--ink-3)", fontFamily: "var(--font-mono)", fontSize: 10.5, cursor: "pointer", boxShadow: "var(--shadow)", whiteSpace: "nowrap", zIndex: 1 };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* window navigation + zoom */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: isMobile ? "10px 14px" : "12px 24px", flexWrap: "wrap", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
        <div role="group" aria-label="Timeline dates" style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <button className="btn-icon" aria-label={wide ? "Previous four weeks" : "Previous week"} onClick={() => goTo((o) => o - STEP)} style={{ border: "none", width: 32, height: 32 }}><Icon name="chevronLeft" size={17} /></button>
          <button className="btn btn-ghost" onClick={() => goTo(() => 0)} aria-label="Jump to today" style={{ fontSize: 12.5, padding: "5px 11px", opacity: offset === 0 ? 0.6 : 1 }}>Today</button>
          <button className="btn-icon" aria-label={wide ? "Next four weeks" : "Next week"} onClick={() => goTo((o) => o + STEP)} style={{ border: "none", width: 32, height: 32 }}><Icon name="chevronRight" size={17} /></button>
        </div>
        <span aria-live="polite" style={{ fontSize: 14, fontWeight: 600, minWidth: 128 }}>{rangeLabel}</span>
        <div role="group" aria-label="Zoom" style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)" }}>
          {([["2w", "2 weeks"], ["6w", "6 weeks"]] as const).map(([z, l]) => (
            <button key={z} onClick={() => { resetScroll.current = true; setZoom(z); }} aria-pressed={zoom === z} style={{ padding: "5px 11px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500,
              background: zoom === z ? "var(--accent)" : "transparent", color: zoom === z ? "var(--on-accent)" : "var(--ink-3)" }}>{l}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span role="status" aria-live="polite" style={{ fontSize: 12.5, color: notice?.warn ? "var(--prio-urgent)" : "var(--ink-3)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          {notice && <>{!notice.warn && <Icon name="check" size={13} />}{notice.text}</>}
        </span>
        {criticalSet.size > 0 && <span style={{ fontSize: 11.5, color: "var(--prio-urgent)", display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--prio-urgent)" }} />Critical path</span>}
      </div>
      <p id={hintId} className="sr-only">Press Enter to open. Alt plus Left or Right arrow moves the task by a day; add Shift to change only its start date.</p>

      <div ref={scrollRef} style={{ flex: 1, overflow: "auto" }}>
        <div style={{ minWidth: labelW + trackW, padding: "0 0 40px" }}>
          {/* axis */}
          <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 3, background: axisBg, backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", borderBottom: "1px solid var(--hairline)" }}>
            <div style={{ width: labelW, flexShrink: 0, padding: "12px 18px", display: "flex", alignItems: "center", gap: 8, position: "sticky", left: 0, zIndex: 1, background: axisBg }}><span className="kicker">Task</span></div>
            {dates.map((d, i) => {
              const isToday = i === todayIdx;
              const weekend = d.getDay() === 0 || d.getDay() === 6;
              const monthMark = wide && (i === 0 || d.getDate() === 1);
              const top = wide ? (monthMark ? d.toLocaleDateString(undefined, { month: "short" }) : d.toLocaleDateString(undefined, { weekday: "narrow" })) : d.toLocaleDateString(undefined, { weekday: "short" });
              return (
                <div key={dayIsos[i]} style={{ width: colW, flexShrink: 0, textAlign: "center", padding: "10px 0", background: weekend ? "color-mix(in oklch, var(--bg-deep) 22%, transparent)" : "transparent",
                  borderLeft: wide && (d.getDay() === 1 || d.getDate() === 1) ? "1px solid var(--hairline)" : undefined }}>
                  <div className="kicker" style={{ color: isToday ? "var(--accent)" : monthMark ? "var(--ink-2)" : "var(--ink-4)", letterSpacing: wide ? "0.02em" : undefined, whiteSpace: "nowrap" }}>{top}</div>
                  <div className="mono tnum" style={{ fontSize: wide ? 11.5 : 14, fontWeight: 600, marginTop: 2, color: isToday ? "var(--accent)" : "var(--ink-2)" }}>{d.getDate()}</div>
                </div>
              );
            })}
          </div>

          {/* rows */}
          <div style={{ position: "relative" }} onDragLeave={canEdit ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropCol(null); } : undefined}>
            {/* drop-day highlight while dragging */}
            {dropCol != null && <div aria-hidden style={{ position: "absolute", top: 0, bottom: 0, left: labelW + dropCol * colW, width: colW, background: "var(--accent-dim)", pointerEvents: "none" }} />}
            {/* today line */}
            {todayIdx >= 0 && todayIdx < DAYS && <div aria-hidden style={{ position: "absolute", top: 0, bottom: 0, left: labelW + todayIdx * colW + colW / 2, width: 2, background: "var(--accent)", opacity: 0.4, zIndex: 1, boxShadow: "0 0 12px var(--accent)", pointerEvents: "none" }} />}
            {/* dependency connectors */}
            {depLines.length > 0 && (
              <svg aria-hidden width={labelW + trackW} height={totalH} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", zIndex: 1, overflow: "visible" }}>
                <defs>
                  <marker id="tl-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--ink-4)" /></marker>
                  <marker id="tl-arrow-crit" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--prio-urgent)" /></marker>
                </defs>
                {depLines.map((l) => { const mx = (l.x1 + l.x2) / 2; return <path key={l.key} d={`M${l.x1},${l.y1} C${mx},${l.y1} ${mx},${l.y2} ${l.x2},${l.y2}`} fill="none" stroke={l.crit ? "var(--prio-urgent)" : "var(--ink-4)"} strokeWidth={l.crit ? 2 : 1.5} opacity={l.crit ? 0.8 : 0.4} markerEnd={l.crit ? "url(#tl-arrow-crit)" : "url(#tl-arrow)"} />; })}
              </svg>
            )}
            {byProject.map((g) => (
              <div key={g.project.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, height: HEADER_H, padding: "0 18px", position: "sticky", left: 0, width: labelW, zIndex: 2 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: g.project.color, flexShrink: 0 }} />
                  <span className="truncate" style={{ fontSize: 12.5, fontWeight: 600 }}>{g.project.name}</span>
                </div>
                {g.rows.map((t) => {
                  const sp = spans.get(t.id) ?? null;
                  const c = sp ? clipSpan(sp, DAYS) : null;
                  const v = c && typeof c === "object" ? c : null;
                  const done = t.status === "done";
                  const crit = criticalSet.has(t.id);
                  const color = done ? "var(--st-done)" : g.project.color;
                  const barW = v ? (v.ve - v.vs + 1) * colW - inset * 2 : 0;
                  const rL = v?.clipL ? 2 : 8, rR = v?.clipR ? 2 : 8;
                  return (
                    <div key={t.id} style={{ display: "flex", height: rowH, alignItems: "center", position: "relative" }}>
                      <button onClick={() => onOpen(t.id)} title={t.title} style={{ width: labelW, flexShrink: 0, height: rowH, padding: "0 18px", fontSize: 13, color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 8,
                        border: "none", background: stickyBg, cursor: "pointer", textAlign: "left", fontFamily: "var(--font-display)", position: "sticky", left: 0, zIndex: 2, outlineOffset: -2 }}>
                        <StatusDot status={t.status} size={7} /><span className="truncate">{t.title}</span>
                      </button>
                      <div style={{ position: "absolute", left: labelW, top: 0, bottom: 0, width: trackW }}
                        onDragOver={canEdit ? onTrackDragOver : undefined} onDrop={canEdit ? onTrackDrop : undefined}>
                        {v && sp && t.dueDate && (
                          <div role={canEdit ? "button" : undefined} tabIndex={canEdit ? 0 : undefined}
                            aria-label={canEdit ? `${t.title}: ${sp.impliedStart ? "" : `starts ${dayLabel(t.startDate!)}, `}due ${dayLabel(t.dueDate)}` : undefined}
                            aria-describedby={canEdit ? hintId : undefined}
                            onClick={() => onOpen(t.id)} className="clickable" draggable={canEdit}
                            onKeyDown={canEdit ? (e) => {
                              if (e.target !== e.currentTarget) return;
                              if (!e.altKey && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(t.id); return; }
                              if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); nudge(t, e.key === "ArrowLeft" ? -1 : 1, e.shiftKey); }
                            } : undefined}
                            onDragStart={canEdit ? (e) => {
                              // remember the day under the cursor: the drop moves the task by (drop day − this day)
                              const track = e.currentTarget.parentElement as HTMLElement;
                              e.dataTransfer.setData("text/kanbo-timeline", t.id);
                              e.dataTransfer.setData("text/kanbo-tl-grab", dayIsos[colAt(e.clientX, track)]);
                              e.dataTransfer.effectAllowed = "move";
                            } : undefined}
                            onDragEnd={canEdit ? () => setDropCol(null) : undefined}
                            title={canEdit ? `${t.title} — drag to reschedule` : t.title}
                            style={{
                              position: "absolute", top: rowH / 2 - 13, left: v.vs * colW + inset, width: barW, height: 26,
                              borderRadius: `${rL}px ${rR}px ${rR}px ${rL}px`, display: "flex", alignItems: "center", gap: 7, padding: barW < 40 ? "0 4px" : "0 9px", overflow: "hidden", cursor: canEdit ? "grab" : "pointer",
                              background: done ? "color-mix(in oklch, var(--st-done) 18%, transparent)" : `color-mix(in oklch, ${g.project.color} 22%, transparent)`,
                              border: crit ? "1.5px solid var(--prio-urgent)" : `1px solid color-mix(in oklch, ${color} 45%, transparent)`,
                              transition: "left .18s var(--ease), width .18s var(--ease), transform .16s",
                              scrollMarginLeft: labelW + 12, scrollMarginRight: 16,
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(-1px)")}
                            onMouseLeave={(e) => (e.currentTarget.style.transform = "none")}>
                            {canEdit && <span aria-hidden draggable onClick={(e) => e.stopPropagation()} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData("text/kanbo-tl-start", t.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDropCol(null)} title="Drag to set the start date" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 7, cursor: "ew-resize", borderTopLeftRadius: rL, borderBottomLeftRadius: rL, background: "color-mix(in oklch, var(--ink) 12%, transparent)" }} />}
                            {barW >= 30 && <span style={{ width: 6, height: 6, borderRadius: 99, background: color, flexShrink: 0 }} />}
                            {barW >= 44 && <span className="truncate" style={{ fontSize: 11.5, color: "var(--ink)" }}>{t.title}</span>}
                            {barW >= 96 && <Avatar id={t.assigneeId} size={16} />}
                          </div>
                        )}
                        {/* bars outside the window: an edge marker that jumps to them */}
                        {c === "before" && sp && t.dueDate && (
                          <button onClick={() => goTo((o) => o + sp.s - 2)} title={`Due ${dayLabel(t.dueDate)} — show it`} aria-label={`${t.title} is due ${dayLabel(t.dueDate)}, before these dates. Show it`} style={{ ...edgeChip, left: 4, padding: "0 8px 0 3px" }}>
                            <Icon name="chevronLeft" size={12} />{shortDate(t.dueDate)}
                          </button>
                        )}
                        {c === "after" && sp && t.dueDate && (
                          <button onClick={() => goTo((o) => o + sp.s - 2)} title={`Due ${dayLabel(t.dueDate)} — show it`} aria-label={`${t.title} is due ${dayLabel(t.dueDate)}, after these dates. Show it`} style={{ ...edgeChip, right: 4, padding: "0 3px 0 8px" }}>
                            {shortDate(t.dueDate)}<Icon name="chevronRight" size={12} />
                          </button>
                        )}
                        {/* tasks with no due date: a draggable placeholder so they can be scheduled */}
                        {!sp && (
                          <div onClick={() => onOpen(t.id)} className="clickable" draggable={canEdit}
                            onDragStart={canEdit ? (e) => { e.dataTransfer.setData("text/kanbo-timeline", t.id); e.dataTransfer.effectAllowed = "move"; } : undefined}
                            onDragEnd={canEdit ? () => setDropCol(null) : undefined}
                            title={canEdit ? "Drag onto a day to schedule" : "No due date"}
                            style={{ position: "absolute", top: rowH / 2 - 11, left: 6, height: 22, borderRadius: 8, display: "flex", alignItems: "center", gap: 6, padding: "0 9px", cursor: canEdit ? "grab" : "pointer", background: "var(--surface-2)", border: "1px dashed var(--hairline-strong)", whiteSpace: "nowrap" }}>
                            <Icon name="calendarPlus" size={12} style={{ color: "var(--ink-4)" }} />
                            <span style={{ fontSize: 11, color: "var(--ink-4)" }}>No date</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {g.hidden > 0 && (
                  <div style={{ height: MORE_H, display: "flex", alignItems: "center", padding: "0 18px", position: "sticky", left: 0, width: "max-content", zIndex: 2 }}>
                    <button className="btn btn-ghost" onClick={() => setExpanded((s) => new Set(s).add(g.project.id))} style={{ fontSize: 12.5, padding: "5px 11px" }}>
                      <Icon name="chevronDown" size={14} /> Show {g.hidden} more in {g.project.name}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A plain list row with a hover / focus fill (for lists inside dialogs, not menus). */
function RowButton({ onClick, children, autoFocus, style }: { onClick: () => void; children: ReactNode; autoFocus?: boolean; style?: React.CSSProperties }) {
  const [hot, setHot] = useState(false);
  return (
    <button type="button" onClick={onClick} data-autofocus={autoFocus ? "" : undefined}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)} onFocus={() => setHot(true)} onBlur={() => setHot(false)}
      style={{ ...bulkItemStyle, background: hot ? FILL_HOT : "transparent", ...style }}>
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
  const connectedFor = (p: CalProvider) => connections.find((c) => c.provider === p);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
      {connections.map((c) => {
        const meta = PROVIDER_META[c.provider];
        return (
          <span key={c.provider} className="glass" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 10px 5px 11px", borderRadius: 99, fontSize: 12.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: meta.color, boxShadow: `0 0 8px ${meta.color}` }} />
            <span style={{ color: "var(--ink-2)" }}>{c.accountEmail || meta.label}</span>
            <button className="btn-icon" title={`Disconnect ${meta.label}`} aria-label={`Disconnect ${meta.label}`} onClick={() => onDisconnect(c.provider)} style={{ border: "none", width: 22, height: 22, color: "var(--ink-4)" }}><Icon name="x" size={13} /></button>
          </span>
        );
      })}
      {syncing && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Syncing…</span>}
      <div style={{ position: "relative", marginLeft: "auto" }}>
        <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} style={{ fontSize: 13 }}>
          <Icon name="calendarPlus" size={15} /> Connect calendar <Icon name="chevronDown" size={14} />
        </button>
        {open && (
          <>
            <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
            <div className="glass anim-scalein" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 31, width: 248, padding: 6, borderRadius: 12, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
              {(Object.keys(PROVIDER_META) as CalProvider[]).map((p) => {
                const meta = PROVIDER_META[p];
                const conn = connectedFor(p);
                return (
                  <button key={p} onClick={() => { setOpen(false); conn ? onDisconnect(p) : onConnect(p); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13.5, textAlign: "left", color: "var(--ink-2)" }}>
                    <span style={{ width: 9, height: 9, borderRadius: 99, background: meta.color, flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{meta.label}</span>
                    {conn ? <span style={{ fontSize: 11, color: "var(--ink-4)" }}>Disconnect</span> : <Icon name="plus" size={14} style={{ color: "var(--ink-4)" }} />}
                  </button>
                );
              })}
              <div className="divider" style={{ margin: "4px 4px" }} />
              <p style={{ margin: 0, padding: "4px 10px 6px", fontSize: 11, color: "var(--ink-4)", lineHeight: 1.45 }}>We only read your events to show them here. Disconnect anytime.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function CalendarView({ tasks, onOpen, onPatch, connections = [], externalEvents = [], onConnect, onDisconnect, syncing, readOnly = false }: {
  tasks: Task[];
  onOpen: (id: string) => void;
  onPatch?: (id: string, patch: Partial<Task>) => void;
  connections?: CalendarConnection[];
  externalEvents?: ExternalEvent[];
  onConnect?: (p: CalProvider) => void;
  onDisconnect?: (p: CalProvider) => void;
  syncing?: boolean;
  /** view-only calendar (guests): tasks open, but can't be dragged to another day */
  readOnly?: boolean;
}) {
  const canEdit = !!onPatch && !readOnly;
  const [mode, setMode] = useState<"month" | "week">("month");
  // month / week navigation (0 = the current one)
  const [monthOffset, setMonthOffset] = useState(0);
  const [weekOffset, setWeekOffset] = useState(0);
  const [dayPop, setDayPop] = useState<{ iso: string; anchor: HTMLElement } | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const viewMonth = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth() + monthOffset, 1);
  const year = viewMonth.getFullYear(), month = viewMonth.getMonth();
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // only highlight "today" when we're actually viewing the current month
  const todayD = monthOffset === 0 ? KANBO_TODAY.getDate() : -1;
  const iso = (d: number) => toLocalISO(new Date(year, month, d));
  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  // switching month ↔ week keeps you looking at the same stretch of time
  const switchMode = (m: "month" | "week") => {
    if (m === mode) return;
    if (m === "week") setWeekOffset(weekOffsetForMonth(KANBO_TODAY, monthOffset));
    else setMonthOffset(monthOffsetForWeek(KANBO_TODAY, weekOffset));
    setMode(m);
  };
  // a rendered element (not an inline component) so focus stays on ‹ › between clicks
  const monthNav = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button className="btn-icon" aria-label="Previous month" onClick={() => setMonthOffset((m) => m - 1)} style={{ border: "none", width: 32, height: 32 }}><Icon name="chevronLeft" size={17} /></button>
      <span aria-live="polite" style={{ fontSize: 14, fontWeight: 600, minWidth: 124, textAlign: "center" }}>{monthLabel}</span>
      <button className="btn-icon" aria-label="Next month" onClick={() => setMonthOffset((m) => m + 1)} style={{ border: "none", width: 32, height: 32 }}><Icon name="chevronRight" size={17} /></button>
      {monthOffset !== 0 && <button className="btn btn-ghost" onClick={() => setMonthOffset(0)} style={{ fontSize: 12.5, padding: "5px 11px" }}>Today</button>}
    </div>
  );
  const weekStartDate = mondayOf(KANBO_TODAY);
  weekStartDate.setDate(weekStartDate.getDate() + weekOffset * 7);
  const weekEndDate = new Date(weekStartDate); weekEndDate.setDate(weekStartDate.getDate() + 6);
  const fmtDM = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const weekLabel = `${fmtDM(weekStartDate)} – ${fmtDM(weekEndDate)}${weekEndDate.getFullYear() !== KANBO_TODAY.getFullYear() ? ` ${weekEndDate.getFullYear()}` : ""}`;
  const weekNav = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button className="btn-icon" aria-label="Previous week" onClick={() => setWeekOffset((w) => w - 1)} style={{ border: "none", width: 32, height: 32 }}><Icon name="chevronLeft" size={17} /></button>
      <span aria-live="polite" style={{ fontSize: 14, fontWeight: 600, minWidth: 124, textAlign: "center" }}>{weekOffset === 0 ? "This week" : weekLabel}</span>
      <button className="btn-icon" aria-label="Next week" onClick={() => setWeekOffset((w) => w + 1)} style={{ border: "none", width: 32, height: 32 }}><Icon name="chevronRight" size={17} /></button>
      {weekOffset !== 0 && <button className="btn btn-ghost" onClick={() => setWeekOffset(0)} style={{ fontSize: 12.5, padding: "5px 11px" }}>Today</button>}
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
  const fmtTime = (e: ExternalEvent) => {
    if (e.allDay) return "";
    const d = new Date(e.start);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  const isMobile = useMediaQuery("(max-width: 860px)");

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
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 28px" }}>
        {onConnect && onDisconnect && <ConnectCalendarMenu connections={connections} onConnect={onConnect} onDisconnect={onDisconnect} syncing={syncing} />}
        <div style={{ marginBottom: 14 }}>{monthNav}</div>
        {agenda.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--ink-4)", padding: "40px 16px" }}>
            <div style={{ marginBottom: 14 }}><EmptyArt kind="calendar" /></div>
            <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>Nothing scheduled this month</p>
            <p style={{ fontSize: 13, margin: "5px 0 0" }}>Tasks with a due date and connected-calendar events show up here.</p>
          </div>
        ) : agenda.map((day) => {
          const dt = new Date(year, month, day.d);
          const isToday = day.d === todayD;
          return (
            <div key={day.iso} style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span className="mono tnum" style={{ display: "grid", placeItems: "center", minWidth: 30, height: 30, borderRadius: 9, fontSize: 13, fontWeight: 600, color: isToday ? "var(--on-accent)" : "var(--ink-2)", background: isToday ? "var(--accent)" : "var(--surface-2)", boxShadow: isToday ? "0 0 12px var(--accent-glow)" : "none" }}>{day.d}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: isToday ? "var(--accent)" : "var(--ink-3)" }}>{dt.toLocaleDateString(undefined, { weekday: "long" })}</span>
                <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{dt.toLocaleDateString(undefined, { month: "short" })}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {day.events.map((e) => {
                  const color = PROVIDER_META[(e.provider as CalProvider)]?.color || "var(--ink-3)";
                  const time = fmtTime(e);
                  return (
                    <div key={e.id} className="glass" style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", borderRadius: 12, borderLeft: `3px solid ${color}` }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--ink-2)" }} className="truncate">{e.title}</span>
                      <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)", flexShrink: 0 }}>{time || "All day"}</span>
                    </div>
                  );
                })}
                {day.tasks.map((t) => {
                  const proj = getProject(t.projectId);
                  return (
                    <button key={t.id} onClick={() => onOpen(t.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", borderRadius: 12, width: "100%", textAlign: "left", cursor: "pointer", border: "1px solid var(--hairline)", background: "var(--surface)", borderLeft: `3px solid ${proj?.color || "var(--accent)"}` }}>
                      <PriorityFlag priority={t.priority} size={13} />
                      <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: t.status === "done" ? "var(--ink-4)" : "var(--ink)", textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</span>
                      <Avatar id={t.assigneeId} size={22} />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // unified date grid for month OR a week (full Date per cell)
  const gridDates: (Date | null)[] = mode === "week"
    ? Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStartDate); d.setDate(weekStartDate.getDate() + i); return d; })
    : (() => { const arr: (Date | null)[] = []; for (let i = 0; i < startDow; i++) arr.push(null); for (let d = 1; d <= daysInMonth; d++) arr.push(new Date(year, month, d)); while (arr.length % 7) arr.push(null); return arr; })();
  const todayIso = toLocalISO(new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate()));
  const modeToggle = (
    <div role="group" aria-label="Calendar range" style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)" }}>
      {(["month", "week"] as const).map((m) => (
        <button key={m} onClick={() => switchMode(m)} aria-pressed={mode === m} style={{ padding: "5px 11px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500, textTransform: "capitalize", background: mode === m ? "var(--accent)" : "transparent", color: mode === m ? "var(--on-accent)" : "var(--ink-3)" }}>{m}</button>
      ))}
    </div>
  );
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
  const popDay = dayPop ? { dt: tasksByDay.get(dayPop.iso) ?? [], de: evByDate[dayPop.iso] ?? [], long: dayLabel(dayPop.iso, { weekday: "long", day: "numeric", month: "long" }) } : null;

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "18px 24px 28px" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        {mode === "month" ? monthNav : weekNav}
        {modeToggle}
        <div style={{ flex: 1 }} />
        {onConnect && onDisconnect && <ConnectCalendarMenu connections={connections} onConnect={onConnect} onDisconnect={onDisconnect} syncing={syncing} />}
      </div>
      <div style={{ overflowX: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 1, marginBottom: 8, minWidth: 560 }}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="kicker" style={{ textAlign: "center", padding: "4px 0" }}>{d}</div>)}
      </div>
      <div className="glass" style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gridAutoRows: mode === "week" ? "minmax(320px,1fr)" : "minmax(118px,1fr)", gap: 1, padding: 1, borderRadius: 16, overflow: "hidden", background: "var(--hairline)", minWidth: 560 }}>
        {gridDates.map((date, i) => {
          const dayIso = date ? toLocalISO(date) : "";
          const dayTasks = date ? (tasksByDay.get(dayIso) ?? []) : [];
          const dayEvents = date ? (evByDate[dayIso] ?? []) : [];
          const isToday = !!date && dayIso === todayIso;
          const taskCap = mode === "week" ? 99 : 3;
          const evCap = mode === "week" ? 99 : 2;
          const overflow = Math.max(0, dayTasks.length - taskCap) + Math.max(0, dayEvents.length - evCap);
          const dropping = dropDay === dayIso && !!date;
          return (
            <div key={date ? dayIso : `pad-${i}`}
              onDragOver={canEdit && date ? (e) => { if (e.dataTransfer.types.includes("text/kanbo-cal")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropDay((d) => (d === dayIso ? d : dayIso)); } } : undefined}
              onDragLeave={canEdit && date ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropDay((d) => (d === dayIso ? null : d)); } : undefined}
              onDrop={canEdit && date ? dropOnDay(dayIso) : undefined}
              style={{ background: dropping ? "color-mix(in oklch, var(--accent) 12%, var(--surface-solid))" : date ? "var(--surface)" : "color-mix(in oklch, var(--bg-deep) 30%, transparent)", boxShadow: dropping ? "inset 0 0 0 2px var(--accent)" : undefined, padding: 9, minHeight: 0, display: "flex", flexDirection: "column", gap: 5, transition: "background .12s" }}>
              {date && (
                <>
                  <span className="mono tnum" style={{ fontSize: 12, fontWeight: 600, alignSelf: "flex-start", color: isToday ? "var(--on-accent)" : "var(--ink-3)", background: isToday ? "var(--accent)" : "transparent", borderRadius: 7, padding: isToday ? "1px 7px" : "1px 2px", boxShadow: isToday ? "0 0 12px var(--accent-glow)" : "none" }}>{date.getDate()}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, overflow: "hidden" }}>
                    {dayEvents.slice(0, evCap).map((e) => {
                      const color = PROVIDER_META[(e.provider as CalProvider)]?.color || "var(--ink-3)";
                      const time = fmtTime(e);
                      return (
                        <span key={e.id} className="truncate" title={`${time ? time + " · " : ""}${e.title}`} style={{
                          display: "flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 6px", borderRadius: 6,
                          color: "var(--ink-3)", background: `color-mix(in oklch, ${color} 12%, transparent)`, borderLeft: `2px solid ${color}`,
                        }}>
                          {time && <span className="mono" style={{ fontSize: 9.5, color: "var(--ink-4)", flexShrink: 0 }}>{time}</span>}
                          <span className="truncate">{e.title}</span>
                        </span>
                      );
                    })}
                    {dayTasks.slice(0, taskCap).map((t) => {
                      const proj = getProject(t.projectId);
                      return (
                        <button key={t.id} onClick={() => onOpen(t.id)} className="truncate" draggable={canEdit}
                          onDragStart={canEdit ? (e) => { e.dataTransfer.setData("text/kanbo-cal", t.id); e.dataTransfer.effectAllowed = "move"; } : undefined}
                          onDragEnd={canEdit ? () => setDropDay(null) : undefined}
                          title={canEdit ? `${t.title} — drag to another day to reschedule` : t.title}
                          style={{
                            display: "flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 6px", borderRadius: 6, cursor: canEdit ? "grab" : "pointer",
                            border: "none", textAlign: "left", color: t.status === "done" ? "var(--ink-4)" : "var(--ink-2)",
                            textDecoration: t.status === "done" ? "line-through" : "none",
                            background: `color-mix(in oklch, ${proj?.color || "var(--accent)"} 14%, transparent)`,
                            borderLeft: `2px solid ${proj?.color || "var(--accent)"}`,
                          }}>
                          <span className="truncate">{t.title}</span>
                        </button>
                      );
                    })}
                    {overflow > 0 && (
                      <button onClick={(e) => setDayPop({ iso: dayIso, anchor: e.currentTarget })} aria-haspopup="dialog"
                        aria-label={`Show all ${dayTasks.length + dayEvents.length} items on ${dayLabel(dayIso, { weekday: "long", day: "numeric", month: "long" })}`}
                        style={{ alignSelf: "flex-start", fontSize: 11, fontWeight: 600, color: "var(--ink-3)", padding: "2px 6px", borderRadius: 6, border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)" }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = FILL_HOT; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                        +{overflow} more
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      </div>

      {dayPop && popDay && (
        <Popover anchor={dayPop.anchor} role="dialog" label={`Everything on ${popDay.long}`} onClose={() => setDayPop(null)} minWidth={264} maxWidth={320}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 8px 9px" }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{popDay.long}</span>
            <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{popDay.dt.length + popDay.de.length}</span>
            <button className="btn-icon" aria-label="Close" onClick={() => setDayPop(null)} style={{ marginLeft: "auto", border: "none", width: 26, height: 26 }}><Icon name="x" size={14} /></button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {popDay.de.map((e) => {
              const color = PROVIDER_META[(e.provider as CalProvider)]?.color || "var(--ink-3)";
              const time = fmtTime(e);
              return (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", fontSize: 12.5, color: "var(--ink-3)", borderLeft: `2px solid ${color}`, marginLeft: 2 }}>
                  <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{e.title}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", flexShrink: 0 }}>{time || "All day"}</span>
                </div>
              );
            })}
            {popDay.dt.map((t, i) => (
              <RowButton key={t.id} autoFocus={i === 0} onClick={() => { setDayPop(null); onOpen(t.id); }}>
                <PriorityFlag priority={t.priority} size={13} />
                <span className="truncate" style={{ flex: 1, minWidth: 0, color: t.status === "done" ? "var(--ink-4)" : "var(--ink)", textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</span>
                <Avatar id={t.assigneeId} size={18} />
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
  const quads = [
    { key: "do", title: "Do first", sub: "Important & urgent", color: "var(--prio-urgent)", items: open.filter((t) => isImportant(t) && isUrgent(t)) },
    { key: "schedule", title: "Schedule", sub: "Important, not urgent", color: "var(--accent)", items: open.filter((t) => isImportant(t) && !isUrgent(t)) },
    { key: "delegate", title: "Delegate", sub: "Urgent, not important", color: "var(--st-review)", items: open.filter((t) => !isImportant(t) && isUrgent(t)) },
    { key: "later", title: "Later", sub: "Neither — trim or defer", color: "var(--ink-4)", items: open.filter((t) => !isImportant(t) && !isUrgent(t)) },
  ];
  return (
    <div style={{ flex: 1, overflow: "auto", padding: "16px 24px 28px" }}>
      <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: "0 0 14px" }}>Urgency from due date, importance from priority. Focus on “Do first”, protect time for “Schedule”.</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {quads.map((q) => {
          const all = expandedQ.has(q.key);
          const list = all ? q.items : q.items.slice(0, QUAD_CAP);
          const hidden = q.items.length - list.length;
          return (
            <div key={q.key} role="group" aria-label={`${q.title}: ${q.sub}`} className="glass" style={{ borderRadius: 16, padding: 14, display: "flex", flexDirection: "column", minHeight: 240, borderTop: `3px solid ${q.color}` }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: q.color }}>{q.title}</span>
                <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{q.sub}</span>
                <span className="mono tnum" style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-4)" }}>{q.items.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7, overflowY: "auto", flex: 1 }}>
                {q.items.length === 0 ? <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Nothing here.</span> : list.map((t) => {
                  const proj = getProject(t.projectId);
                  return (
                    <button key={t.id} onClick={() => onOpen(t.id)} className="lift" style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer", textAlign: "left" }}>
                      <StatusDot status={t.status} size={7} />
                      <span className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink)" }}>{t.title}</span>
                      {proj && <span style={{ width: 7, height: 7, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
                      {t.dueDate && <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)", flexShrink: 0 }}>{fmtDue(t.dueDate)}</span>}
                    </button>
                  );
                })}
                {hidden > 0 && (
                  <button onClick={() => setExpandedQ((s) => new Set(s).add(q.key))} className="btn btn-ghost" style={{ justifyContent: "center", fontSize: 12.5, padding: "7px 11px" }}>
                    <Icon name="chevronDown" size={14} /> Show all {q.items.length}
                  </button>
                )}
              </div>
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
  const ids = tasks.map((t) => t.id).join(",");
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const load = useCallback(async (quiet: boolean) => {
    const req = ++reqRef.current;
    if (!quiet) setStatus("loading");
    try {
      const idList = ids ? ids.split(",") : [];
      // query in chunks — one huge IN (...) list fails on big projects
      const parts = await Promise.all(chunk(idList, FILE_ID_CHUNK).map((c) => store.listProjectAttachments(c)));
      if (req !== reqRef.current) return;
      const seen = new Set<string>();
      const merged: Attachment[] = [];
      for (const a of parts.flat()) if (!seen.has(a.id)) { seen.add(a.id); merged.push(a); }
      merged.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      setFiles(merged); setBroken(new Set()); setRefreshFailed(false);
      loadedAt.current = Date.now();
      setStatus("ready");
    } catch (err) {
      if (req !== reqRef.current) return;
      reportError(err);
      // a failed background refresh keeps the list on screen; a failed first load says so
      if (quiet && loadedAt.current) setRefreshFailed(true);
      else setStatus("error");
    }
  }, [ids]);

  useEffect(() => { load(loadedAt.current > 0); }, [load]);
  useEffect(() => () => { reqRef.current++; }, []); // ignore responses after unmount
  // re-sign links before they expire (checked each minute and when the tab comes back)
  useEffect(() => {
    const tick = () => {
      if (loadedAt.current && document.visibilityState === "visible" && Date.now() - loadedAt.current > FILE_REFRESH_MS) load(true);
    };
    const iv = window.setInterval(tick, 60 * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(iv); document.removeEventListener("visibilitychange", tick); };
  }, [load]);

  const emptyWrap: React.CSSProperties = { textAlign: "center", padding: "70px 24px", color: "var(--ink-4)" };
  const emptyTitle: React.CSSProperties = { fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 40px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      {status === "loading" ? (
        <div role="status" style={{ textAlign: "center", padding: "60px 24px", color: "var(--ink-4)", fontSize: 13 }}>Loading files…</div>
      ) : status === "error" ? (
        <div role="alert" style={emptyWrap}>
          <div style={{ marginBottom: 14 }}><EmptyArt kind="folder" /></div>
          <p style={emptyTitle}>Couldn't load files</p>
          <p style={{ fontSize: 13, margin: "5px 0 14px", lineHeight: 1.5 }}>Something went wrong fetching attachments. Your files are safe — check your connection and try again.</p>
          <button className="btn btn-ghost" onClick={() => load(false)} style={{ fontSize: 13 }}><Icon name="refresh" size={14} /> Retry</button>
        </div>
      ) : files.length === 0 ? (
        <div style={emptyWrap}>
          <div style={{ marginBottom: 14 }}><EmptyArt kind="folder" /></div>
          <p style={emptyTitle}>No files yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 0" }}>Attachments added to tasks here will appear in one place.</p>
        </div>
      ) : (
        <>
          {refreshFailed && (
            <div role="alert" style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", marginBottom: 12, borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", fontSize: 12.5, color: "var(--ink-3)" }}>
              <span style={{ flex: 1 }}>Couldn't refresh file links, so some may have expired.</span>
              <button className="btn btn-ghost" onClick={() => load(true)} style={{ fontSize: 12.5, padding: "5px 10px" }}><Icon name="refresh" size={13} /> Retry</button>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {files.map((att) => {
              const task = taskById.get(att.taskId);
              const img = att.mime?.startsWith("image/") && att.url && !broken.has(att.id);
              return (
                <div key={att.id} className="glass lift" style={{ borderRadius: 14, overflow: "hidden", display: "flex", flexDirection: "column", backdropFilter: "none", WebkitBackdropFilter: "none" }}>
                  <button type="button" onClick={() => task && onOpen(task.id)} disabled={!task} aria-label={task ? `${att.name}, attached to ${task.title}. Open task` : att.name}
                    style={{ display: "block", width: "100%", padding: 0, border: "none", background: "transparent", textAlign: "left", cursor: task ? "pointer" : "default", color: "inherit", font: "inherit", outlineOffset: -2 }}>
                    <div style={{ height: 110, background: "var(--surface-2)", display: "grid", placeItems: "center", overflow: "hidden" }}>
                      {img ? <img src={att.url} alt="" loading="lazy" onError={() => setBroken((s) => new Set(s).add(att.id))} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon name="folder" size={26} style={{ color: "var(--ink-4)" }} />}
                    </div>
                    <div style={{ padding: "10px 12px 0" }}>
                      <div className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{att.name}</div>
                      <div className="truncate" style={{ fontSize: 11.5, color: "var(--ink-4)", marginTop: 2 }}>{bytes(att.size)}{task ? " · " + task.title : ""}</div>
                    </div>
                  </button>
                  <div style={{ padding: "6px 12px 10px" }}>
                    {att.url
                      ? <a href={att.url} target="_blank" rel="noreferrer" aria-label={`Open ${att.name} in a new tab`} style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}><Icon name="arrowUpRight" size={12} /> Open</a>
                      : <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Link unavailable</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
