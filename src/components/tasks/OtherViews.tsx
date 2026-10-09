/* ============================================================
   KANBO — Board (Kanban), Timeline (Gantt), Month calendar,
   Matrix and Files views
   ============================================================ */
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useId, memo, type ReactNode, type CSSProperties } from "react";
import {
  Icon, Avatar, wasJustLanded, markJustLanded, Segmented, Meter, ProjectCover,
  StatusGlyph, PriorityGlyph, DateChip, ProjectTile, projectPaint, Button, IconButton, EmptyState,
} from "../primitives";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useListKeyboard, type ListKeyAction } from "../../hooks/useListKeyboard";
import { BulkMenuButton, CustomChips, useFloatBounds } from "./ListView";
import { parseDateText } from "../../lib/nlp";
import {
  getProject, getMember, dueState, fmtDue, TAGS,
  STATUS_META, STATUS_ORDER, PRIORITY_META, KANBO_TODAY, toLocalISO,
} from "../../data/data";
import type { Task, Status, Priority, Project, CalProvider, CalendarConnection, CalendarWarning, ExternalEvent, Attachment, CustomFieldDef, BoardSettings } from "../../data/types";
import { calendarLegend, eventCalendarKey, eventColour, loadHiddenCalendars, saveHiddenCalendars, type LegendEntry } from "../../lib/calendars";
import { store } from "../../data/store";
import { reportError } from "../../lib/monitoring";
import { useTaskDragSource, useTaskDropTarget, type TaskDragPayload, type TaskDropEvent } from "../../lib/dnd";
import {
  addDaysISO, daysBetweenISO, mondayOf, switchCalendarPeriod, type CalendarPeriod,
  hideNestedSubtasks, assigneeColumnKey, UNASSIGNED_COL, FORMER_COL, NO_PROJECT_COL,
  planReorder, planInsertMany, barSpan, clipSpan, effectiveStartISO, timelineMovePatch, timelineStartPatch,
  wipKeyFor, loadWipLimits, chunk, type BarSpan,
  VIRTUALISE_AFTER, SWIMLANE_OPTIONS, swimlanes, lanePatch, effectiveSwimlane, swimlaneStorageKey, laneCollapseStorageKey, readSwimlane,
  wipSettingKey, localWipToSettings, withWipLimit, withCovers, wipBreachMessage, wipState, cardProgress, cardHeightEstimate,
  type SwimlaneBy, type Swimlane, type SwimlaneCtx,
} from "./otherViewsLogic";
import { Popover, MenuItem } from "../board/AnchoredPopover";
import { ColumnMenu } from "../board/ColumnMenu";
import { CardMoveMenu, type MoveColumn } from "../board/CardMoveMenu";
import { VirtualCards } from "../board/VirtualCards";
import { useCoverUrls } from "../board/useCoverUrls";
import { demoAwareBoardSettings, effectiveCoverId, markBoardSettingsTouched } from "../board/boardDemo";
import { useOptionalToast } from "../rituals/shared";
import "./taskViews.css";
import "../board/board.css";
import { TaskApprovalBadge } from "../approvals/ApprovalSummaries";

export type BoardGroup = "status" | "priority" | "project" | "assignee";

const PROVIDER_META: Record<CalProvider, { label: string; add: string; color: string }> = {
  google: { label: "Google Calendar", add: "Add Google account", color: "oklch(0.7 0.18 25)" },
  microsoft: { label: "Microsoft / Outlook", add: "Add Outlook account", color: "oklch(0.62 0.16 250)" },
};
/** a connected calendar's colour, re-toned for the theme (the same lightness as project colours) */
const calInk = (hex: string) => ({ "--kcal": projectPaint(hex).solid }) as CSSProperties;

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

/* ---------------- KANBAN ----------------
   Cards: an optional cover (one of the task's images, or the project's
   identity cover when the board shows project covers), the title renamed
   in place (click it, or E / F2), status / priority / assignee / due
   edited from the card, a sub-task (or checklist) progress bar, and a
   due chip that says when it's overdue. Rows (swimlanes) by assignee,
   priority or project, folding away with their counts. WIP limits per
   column, edited in the column's menu: shared on a project board (its
   board_settings), kept on this device on My tasks; a column past its
   limit wears the warn token, and a move that takes it past says so.
   Cards are drag sources for the drag kit (lib/dnd: onto Today, the
   sidebar's projects…) and move between columns and rows with it; while
   the kit is inert the board keeps its own HTML5 drag. Every drag has a
   keyboard way: Alt+arrows, and the card's "Move to…" (M). Columns past
   VIRTUALISE_AFTER cards render only what's near the screen. */
/** the date picker's typed field ("fri", "in 2 weeks"); the chip's own parser covers the rest */
const parseDue = (text: string) => parseDateText(text);
type Half = "top" | "bottom";
type CardMenu = null | "priority" | "assignee" | "status" | "move";
const EMPTY_COLUMN: Record<string, string> = {
  todo: "Nothing to do", progress: "Nothing in progress", review: "Nothing in review", blocked: "Nothing blocked", done: "Nothing done yet",
};
const PRIORITIES_INLINE: Priority[] = ["urgent", "high", "medium", "low"];
/** a cell = a column within a row (no rows: the column) */
const cellKeyOf = (colKey: string, laneKey: string | null) => (laneKey == null ? colKey : `${colKey}␟${laneKey}`);

interface KanbanCardProps {
  task: Task; index: number;
  progressDone: number; progressTotal: number; progressKind: "subtasks" | "checklist";
  blocked: boolean;
  /** the cover image's link, or the project whose identity cover stands in */
  coverUrl?: string; coverProject?: Project;
  onOpen: (id: string) => void;
  /** inline status / priority / due / assignee / title edits; omitted when read-only */
  onPatch?: (id: string, patch: Partial<Task>) => void;
  isMobile: boolean;
  /** the board's own HTML5 drag (used while the drag kit is inert) */
  nativeDrag: boolean;
  /** a drag-kit source (lib/dnd); off when read-only */
  kitDrag: boolean;
  acceptsDrop: boolean; dragging: boolean; dropHint: Half | null;
  onPickup: (id: string) => void; onDragDone: () => void;
  onHoverCard: (id: string, half: Half) => void; onCardDrop: (draggedId: string, targetId: string, half: Half) => void;
  /** what a drag of this card carries: every selected card when it's selected */
  dragIds: (id: string) => string[];
  selected: boolean; onSelect?: (id: string) => void;
  customFields: CustomFieldDef[]; members: { id: string; name: string }[];
  onKeyMove?: (id: string, key: string) => void; onMenuDone: (id: string) => void; hintId?: string;
  showProject: boolean; cursor: boolean;
  /** open in the task panel */
  active?: boolean;
  canRename: boolean;
  /** bumped by E / F2 (rename) and M (move) from the board's keyboard */
  renameNonce: number; moveNonce: number;
  getMoveColumns?: (id: string) => { columns: MoveColumn[]; current: string | undefined };
  onMoveToColumn?: (id: string, colKey: string) => void;
  onToggleToday?: (id: string) => void;
  onAnnounce: (text: string) => void;
}

const KanbanCard = memo(function KanbanCard(p: KanbanCardProps) {
  const { task, onPatch, members } = p;
  const proj = getProject(task.projectId);
  const [menu, setMenu] = useState<CardMenu>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const statusBtn = useRef<HTMLButtonElement>(null);
  const prioBtn = useRef<HTMLButtonElement>(null);
  const assignBtn = useRef<HTMLButtonElement>(null);
  const moveBtn = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  // a settle when this card was just dropped (survives a re-mount into a new column)
  const [landed, setLanded] = useState(() => wasJustLanded(task.id));
  useEffect(() => { if (wasJustLanded(task.id)) setLanded(true); }, [task.id, task.position]);
  useEffect(() => { if (!landed) return; const t = window.setTimeout(() => setLanded(false), 520); return () => window.clearTimeout(t); }, [landed]);

  /* ---- rename in place ---- */
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  const [draft, setDraft] = useState(task.title);
  const startRename = useCallback(() => {
    if (!p.canRename) return;
    setMenu(null);
    setDraft(task.title); editingRef.current = true; setEditing(true);
  }, [p.canRename, task.title]);
  const finishRename = (save: boolean) => {
    if (!editingRef.current) return;
    editingRef.current = false; setEditing(false);
    const next = draft.replace(/\s+/g, " ").trim();
    if (save && next && next !== task.title) { onPatch?.(task.id, { title: next }); p.onAnnounce(`Renamed to ${next}`); }
    else if (save && !next) p.onAnnounce(`A task needs a title, so it's still ${task.title}`);
    p.onMenuDone(task.id);
  };
  useLayoutEffect(() => {
    const el = titleInput.current;
    if (!editing || !el) return;
    el.style.height = "0px"; el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);
  useEffect(() => { if (editing) { titleInput.current?.focus({ preventScroll: true }); titleInput.current?.select(); } }, [editing]);
  // E / F2 and M from the board's keyboard; a card that re-mounts (moved to another column) never re-runs an old request
  const seen = useRef({ rename: p.renameNonce, move: p.moveNonce });
  useEffect(() => {
    if (!p.renameNonce || p.renameNonce === seen.current.rename) return;
    seen.current.rename = p.renameNonce; startRename();
  }, [p.renameNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!p.moveNonce || p.moveNonce === seen.current.move) return;
    seen.current.move = p.moveNonce; if (p.getMoveColumns) setMenu("move");
  }, [p.moveNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- dragging: the kit (lib/dnd) when it's live, else the board's HTML5 drag ---- */
  const src = useTaskDragSource({
    taskIds: () => p.dragIds(task.id), source: "board", originId: task.id, label: task.title,
    disabled: !p.kitDrag || editing,
    onDragStart: () => p.onPickup(task.id), onDragEnd: () => p.onDragDone(),
  });
  const kitLive = !!src.bind.onPointerDown;
  const native = p.nativeDrag && !kitLive && !editing;
  const halfFrom = (e: React.DragEvent): Half => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "top" : "bottom";
  };

  /* ---- cover ---- */
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const coverUrl = p.coverUrl && p.coverUrl !== brokenUrl ? p.coverUrl : undefined;
  const coverKind = coverUrl ? "image" : p.coverProject ? "project" : null;

  const choose = (apply: () => void) => { setMenu(null); apply(); p.onMenuDone(task.id); };
  const toggle = (m: Exclude<CardMenu, null>) => setMenu((cur) => (cur === m ? null : m));
  const assignee = getMember(task.assigneeId);
  const dueText = task.dueDate ? fmtDue(task.dueDate) : null;
  const due = task.dueDate ? dueState(task.dueDate, task.status) : "none";
  const done = task.status === "done";
  const loud = task.priority === "urgent" || task.priority === "high";
  const tags = (task.tags || []).filter((id) => TAGS[id]);
  const progressNoun = p.progressKind === "subtasks" ? "sub-tasks" : "checklist items";
  const label = [task.title, STATUS_META[task.status].label, `${PRIORITY_META[task.priority].label} priority`,
    dueText ? `due ${dueText}${due === "overdue" ? ", overdue" : ""}` : null, assignee ? `assigned to ${assignee.name}` : null,
    p.progressTotal > 0 ? `${p.progressDone} of ${p.progressTotal} ${progressNoun} done` : null,
    p.blocked ? "blocked" : null].filter(Boolean).join(", ");
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  // keyboard focus on the card's open button rings the whole card
  const [ring, setRing] = useState(false);
  const moveMenu = menu === "move" && p.getMoveColumns ? p.getMoveColumns(task.id) : null;

  return (
    // a labelled group, not a button: it holds its own buttons and a date chip, which a
    // role="button" would flatten for screen readers. Mouse clicks anywhere open the task;
    // keyboard and screen-reader users get the real button below.
    <div ref={cardRef} data-card-id={task.id} data-index={p.index} role="group" aria-label={task.title}
      onClick={() => { if (!editingRef.current) p.onOpen(task.id); }}
      className={"ktv-card kbd-card" + (landed ? " kland" : "")} draggable={native}
      data-kdnd-source={src.bind["data-kdnd-source"]} data-kdnd-dragging={src.bind["data-kdnd-dragging"]}
      // a press inside one of the card's menus (portalled, but React bubbles it here) never picks the card up
      onPointerDown={kitLive ? (e) => { if (e.currentTarget.contains(e.target as Node)) src.bind.onPointerDown?.(e); } : undefined}
      data-selected={p.selected || undefined} data-ring={ring || undefined} data-cursor={p.cursor || undefined} data-active={p.active || undefined}
      data-drag={p.dragging || src.isDragging || undefined} data-drop={p.dropHint ?? undefined} data-draggable={native || kitLive || undefined} data-done={done || undefined}
      data-cover={coverKind ?? undefined} data-editing={editing || undefined}
      onDragStart={native ? (e) => { e.dataTransfer.setData("text/kanbo-task", task.id); e.dataTransfer.effectAllowed = "move"; p.onPickup(task.id); } : undefined}
      onDragEnd={native ? p.onDragDone : undefined}
      onDragOver={native && p.acceptsDrop ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); p.onHoverCard(task.id, halfFrom(e)); } : undefined}
      onDrop={native && p.acceptsDrop ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData("text/kanbo-task"); p.onCardDrop(id, task.id, halfFrom(e)); } : undefined}>
      {/* first in the tab order: Enter / Space opens, Alt+arrows move, F2 renames. Visually hidden (so it
          never gets in the way of dragging the card) — the card shows its focus ring instead. */}
      <button type="button" data-card-open className="sr-only" aria-label={label} aria-describedby={p.hintId}
        onClick={(e) => { e.stopPropagation(); p.onOpen(task.id); }}
        onKeyDown={(e) => {
          if (e.altKey && p.onKeyMove && e.key.startsWith("Arrow")) { e.preventDefault(); e.stopPropagation(); p.onKeyMove(task.id, e.key); }
          else if (e.key === "F2" && p.canRename) { e.preventDefault(); e.stopPropagation(); startRename(); }
        }}
        onFocus={(e) => setRing(isFocusVisible(e.currentTarget))} onBlur={() => setRing(false)} />
      {p.onSelect && (
        <button type="button" className="ktv-sel ksel" role="checkbox" aria-checked={p.selected} onClick={(e) => { e.stopPropagation(); p.onSelect?.(task.id); }}
          aria-label={p.selected ? `Deselect ${task.title}` : `Select ${task.title}`}>
          {p.selected && <Icon name="check" size={11} sw={3} />}
        </button>
      )}
      {coverKind === "image" && (
        <div className="kbd-cover" aria-hidden="true">
          <img src={coverUrl} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBrokenUrl(p.coverUrl ?? null)} />
        </div>
      )}
      {coverKind === "project" && <ProjectCover project={p.coverProject} height={24} surface="raised" className="kbd-pcover" />}
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
        {editing ? (
          <textarea ref={titleInput} className="kbd-rename" aria-label={`Rename ${task.title}`} value={draft} maxLength={500} rows={1}
            data-kdnd-ignore="" spellCheck
            onChange={(e) => setDraft(e.target.value.replace(/[\r\n]+/g, " "))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); finishRename(true); }
              else if (e.key === "Escape") { e.preventDefault(); finishRename(false); }
            }}
            onBlur={() => finishRename(true)} onClick={stop} onPointerDown={stop} onDragStart={(e) => e.preventDefault()} />
        ) : (
          <span className="ktv-card-title" data-card-title data-rename={p.canRename || undefined}
            title={p.canRename ? "Click to rename" : undefined}
            onClick={p.canRename ? (e) => { e.stopPropagation(); startRename(); } : undefined}>{task.title}</span>
        )}
      </div>
      {(tags.length > 0 || (p.customFields.length > 0 && task.custom && Object.keys(task.custom).length > 0)) && (
        <div className="ktv-card-tags">
          {tags.slice(0, 2).map((id) => <span key={id} className="ktv-tag"><i style={{ background: projectPaint(TAGS[id].color).solid }} />{TAGS[id].label}</span>)}
          {tags.length > 2 && <span className="ktv-mono" style={{ color: "var(--ink-3)" }}>+{tags.length - 2}</span>}
          {p.customFields.length > 0 && <CustomChips task={task} fields={p.customFields} members={members} />}
        </div>
      )}
      {p.progressTotal > 0 && (
        <div className="kbd-progress" data-complete={p.progressDone >= p.progressTotal || undefined} title={`${p.progressDone} of ${p.progressTotal} ${progressNoun} done`}>
          <Meter value={p.progressDone} max={p.progressTotal} height={4} tone={p.progressDone >= p.progressTotal ? "ok" : "grad"} label={`${p.progressDone} of ${p.progressTotal} ${progressNoun} done`} />
          <span className="ktv-mono" aria-hidden="true">{p.progressDone}/{p.progressTotal}</span>
        </div>
      )}
      <div className="ktv-card-meta">
        <span onClick={stop} data-card-due className="kbd-due" data-tone={due === "overdue" || due === "today" ? due : undefined} style={{ display: "inline-flex" }}>
          {due === "overdue" && <Icon name="alert" size={12} sw={2} className="kbd-due-icon" />}
          {onPatch
            ? <DateChip value={task.dueDate} time={task.dueTime} withTime size="sm" status={task.status} label={`Due date for ${task.title}`} placeholder="Add date" parse={parseDue}
                onChange={(date, time) => onPatch(task.id, { dueDate: date, dueTime: date ? time : undefined })} />
            : task.dueDate ? <DateChip value={task.dueDate} time={task.dueTime} size="sm" status={task.status} label="Due" readOnly onChange={() => {}} /> : null}
        </span>
        {p.blocked && <span className="ktv-m ktv-m-signal" role="img" aria-label="Blocked" title="Blocked"><Icon name="lock" size={12} /></span>}
        <TaskApprovalBadge taskId={task.id} />
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
          {p.showProject && proj && <ProjectTile project={proj} size={16} title={proj.name} />}
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
          {/* Move to…: another column, Today, or a place elsewhere on screen (the keyboard and tap way to drag) */}
          {p.getMoveColumns && (
            <span style={{ display: "inline-flex" }} onClick={stop}>
              <button ref={moveBtn} type="button" className="ktv-trig" data-card-move data-hidden={p.isMobile ? undefined : true}
                aria-label={`Move ${task.title}`} aria-haspopup="menu" aria-expanded={menu === "move"} title="Move to…"
                onClick={() => toggle("move")}><Icon name="arrowRight" size={14} /></button>
              {moveMenu && (
                <Popover anchor={moveBtn.current ?? cardRef.current} align="end" label={`Move ${task.title} to`} onClose={() => setMenu(null)} minWidth={208} maxWidth={300}>
                  <CardMoveMenu task={task} columns={moveMenu.columns} currentKey={moveMenu.current}
                    onPickColumn={(k) => p.onMoveToColumn?.(task.id, k)}
                    onToggleToday={p.onToggleToday && !done ? () => p.onToggleToday?.(task.id) : undefined}
                    onDone={() => { setMenu(null); p.onMenuDone(task.id); }}
                    onMoved={(where) => p.onAnnounce(`${task.title} moved to ${where}`)} />
                </Popover>
              )}
            </span>
          )}
        </span>
      </div>
    </div>
  );
});

interface BoardCol { key: string; label: string; status?: Status; project?: Project; avatar?: string; accepts: boolean; hint?: string }
const BOARD_GROUPS: { value: BoardGroup; label: string }[] = [{ value: "status", label: "Status" }, { value: "priority", label: "Priority" }, { value: "project", label: "Project" }, { value: "assignee", label: "Assignee" }];

/** A column's (or a row's) mark: status glyph, avatar, project tile, priority glyph, else a dot. */
function groupLead(g: { key: string; status?: Status; avatar?: string; project?: Project }, by: string) {
  if (g.status) return <StatusGlyph status={g.status} size={14} readOnly />;
  if (by === "assignee" || g.avatar) {
    const id = g.avatar ?? g.key;
    if (getMember(id)) return <Avatar id={id} size={20} />;
    if (id === UNASSIGNED_COL) return <span className="ktv-unassigned"><Icon name="user" size={11} /></span>;
  }
  if (g.project) return <ProjectTile project={g.project} size={20} />;
  if (by === "project" && getProject(g.key)) return <ProjectTile project={getProject(g.key)} size={20} />;
  if (g.key in PRIORITY_META) return <PriorityGlyph priority={g.key as Priority} />;
  return <span className="ktv-dot" style={{ background: "var(--icon-quiet, var(--ink-4))" }} />;
}

/** One column of cards (or a column within a row): a drop target for both drags, virtualised when long. */
function BoardCell({ cellKey, col, laneKey, laneLabel, items, nativeOk, kitOk, isOverNative, accepts, onNativeOver, onNativeLeave, onNativeDrop, onKitOver, onKitLeave, onKitDrop, renderCard, estimate, pinIds, projectId, wip }: {
  cellKey: string; col: BoardCol; laneKey: string | null; laneLabel?: string; items: Task[];
  nativeOk: boolean; kitOk: boolean; isOverNative: boolean;
  accepts: (payload: TaskDragPayload) => boolean;
  onNativeOver: (cellKey: string) => void; onNativeLeave: (cellKey: string) => void; onNativeDrop: (id: string, cellKey: string) => void;
  onKitOver: (cellKey: string, lane: HTMLElement | null, e: TaskDropEvent) => void; onKitLeave: (cellKey: string) => void;
  onKitDrop: (cellKey: string, lane: HTMLElement | null, e: TaskDropEvent) => void;
  renderCard: (t: Task, index: number) => ReactNode;
  estimate: (t: Task) => number;
  pinIds: (string | null | undefined)[];
  projectId?: string;
  wip: "ok" | "at" | "over";
}) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const name = laneLabel ? `${col.label}, ${laneLabel}` : col.label;
  const target = useTaskDropTarget({
    target: { kind: "board-column", id: cellKey, label: name, data: { column: col.key, lane: laneKey, status: col.status ?? null, projectId: projectId ?? null, listed: laneKey == null } },
    accepts, disabled: !kitOk,
    onOver: (e) => onKitOver(cellKey, laneRef.current, e),
    onLeave: () => onKitLeave(cellKey),
    onDrop: (e) => onKitDrop(cellKey, laneRef.current, e),
  });
  // one stable ref for both (the kit's own ref is told again if it changes, e.g. a board turning editable)
  const kitRef = useRef(target.bind.ref);
  kitRef.current = target.bind.ref;
  const setRef = useCallback((el: HTMLDivElement | null) => { laneRef.current = el; kitRef.current(el); }, []);
  useLayoutEffect(() => { target.bind.ref(laneRef.current); }, [target.bind.ref]);
  return (
    // (not .klane: kanbo.css paints that class's light well with !important, which would hide the drop and WIP states)
    <div ref={setRef} className="ktv-lane kbd-lane" role={laneLabel ? "group" : undefined} aria-label={laneLabel ? `${col.label}, ${laneLabel}` : undefined}
      data-kdnd-target={target.bind["data-kdnd-target"]} data-kdnd-over={target.bind["data-kdnd-over"]}
      data-drop={isOverNative || target.isOver || undefined} data-can-drop={target.canDrop || undefined} data-wip={wip !== "ok" ? wip : undefined}
      onDragOver={nativeOk ? (e) => { if (e.dataTransfer.types.includes("text/kanbo-task")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onNativeOver(cellKey); } } : undefined}
      onDragLeave={nativeOk ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onNativeLeave(cellKey); } : undefined}
      onDrop={nativeOk ? (e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/kanbo-task"); onNativeDrop(id, cellKey); } : undefined}>
      {items.length > VIRTUALISE_AFTER
        ? <VirtualCards items={items} laneRef={laneRef} renderCard={renderCard} estimate={estimate} pinIds={pinIds} label={name} />
        : items.map((t, i) => renderCard(t, i))}
      {items.length === 0 && (laneKey == null
        ? <div className="ktv-lane-empty">{col.status ? EMPTY_COLUMN[col.status] : "Nothing here"}</div>
        : <span className="sr-only">No cards</span>)}
    </div>
  );
}

/** The board's own bar, for what the page doesn't choose itself: Columns, Rows, project covers. */
function BoardBar({ group, onGroup, lanes, onLanes, covers, onCovers, hintId }: {
  group: BoardGroup; onGroup?: (g: BoardGroup) => void;
  lanes: SwimlaneBy; onLanes?: (s: SwimlaneBy) => void;
  covers: boolean; onCovers?: (on: boolean) => void; hintId: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const current = SWIMLANE_OPTIONS.find((o) => o.value === lanes) ?? SWIMLANE_OPTIONS[0];
  return (
    <div className="ktv-viewbar kbd-bar">
      {onGroup && (
        <>
          <span className="ktv-mlabel" style={{ padding: 0 }} id={`${hintId}-cols`}>Columns</span>
          <Segmented options={BOARD_GROUPS} value={group} onChange={onGroup} ariaLabel="Columns" />
        </>
      )}
      <span className="kbd-bar-end">
        {onLanes && (
          <>
            <Button ref={btn} variant="ghost" size="sm" icon="layers" iconRight="chevronDown" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {lanes === "none" ? "Rows" : `Rows: ${current.label}`}
            </Button>
            {open && (
              <Popover anchor={btn.current} align="end" label="Rows" onClose={() => setOpen(false)} minWidth={200}>
                <div className="ktv-mlabel" aria-hidden>Rows, just for you</div>
                {SWIMLANE_OPTIONS.map((o) => {
                  const same = o.value !== "none" && o.value === group;
                  return (
                    <MenuItem key={o.value} checked={lanes === o.value} disabled={same} title={same ? `The columns are already by ${o.label.toLowerCase()}` : undefined}
                      onSelect={() => { setOpen(false); onLanes(o.value); }}>
                      <span className="truncate">{o.label}</span>
                    </MenuItem>
                  );
                })}
              </Popover>
            )}
          </>
        )}
        {onCovers && (
          <button type="button" className="ktv-chip kbd-covers" aria-pressed={covers} onClick={() => onCovers(!covers)}
            title="Show the project's cover on cards without a cover image, for everyone on this board">
            <Icon name="palette" size={14} /> Project covers
          </button>
        )}
      </span>
    </div>
  );
}

export interface BoardViewProps {
  tasks: Task[]; allTasks: Task[]; onOpen: (id: string) => void; onAdd: (status: Status) => void;
  onMove: (taskId: string, status: Status, position?: number) => void;
  onPatch?: (id: string, patch: Partial<Task>) => void;
  onBulkPatch?: (ids: string[], patch: Partial<Task>) => void;
  onBulkDelete?: (ids: string[]) => void;
  members?: { id: string; name: string }[];
  customFields?: CustomFieldDef[];
  /** view-only board (guests): cards open, but no drag, inline menus, add or bulk actions */
  readOnly?: boolean;
  /** which board this is (e.g. "project:<id>", or "my:<workspace>" for My tasks) — rows and device WIP limits are kept per board */
  scopeKey?: string;
  /** the columns, when the page chooses them (Display › Columns); otherwise the board's own switch */
  group?: BoardGroup;
  onGroupChange?: (g: BoardGroup) => void;
  /** a project dot on each card (off inside a project) */
  showProject?: boolean;
  /** ⌘↵ on a card (completes it like its row would); falls back to moving it to Done */
  onToggle?: (id: string) => void;
  /** the task open in the task panel */
  activeId?: string;
  /* ---- 0048 (u8) ---- */
  /** a project board's settings (projects.board_settings; pass {} when it has none): its WIP limits are
   *  then everyone's, and "Show project covers" applies. Without it (My tasks) limits stay on this device. */
  boardSettings?: BoardSettings;
  /** project writers: save the board's settings (store.updateProject(id, { boardSettings })) */
  onChangeBoardSettings?: (next: BoardSettings) => void;
  /** the board's project (default: read from scopeKey "project:<id>") */
  projectId?: string;
  /** attachment id → signed image link for cover images; without it the board fetches the ones it needs */
  coverUrls?: Record<string, string>;
  /** rows (swimlanes), when the page chooses them (Display › Rows, via BoardDisplayOptions); otherwise the board's own bar */
  swimlane?: SwimlaneBy;
  onSwimlaneChange?: (s: SwimlaneBy) => void;
}

const readLS = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLS = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const readSet = (k: string): Set<string> => { try { const s = localStorage.getItem(k); const a = s ? JSON.parse(s) : []; return new Set(Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []); } catch { return new Set(); } };
/** the board's WIP limits were copied up to its project once (never again, even after they're cleared) */
const wipCopiedKey = (scope: string) => `kanbo-board-wip-copied:${scope}`;

export function BoardView({ tasks, allTasks, onOpen, onAdd, onMove, onPatch, onBulkPatch, onBulkDelete, members = [], customFields = [], readOnly = false, scopeKey, group: groupProp, onGroupChange, showProject = true, onToggle, activeId,
  boardSettings, onChangeBoardSettings, projectId: projectIdProp, coverUrls: coverUrlsProp, swimlane: swimlaneProp, onSwimlaneChange }: BoardViewProps) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const editable = !readOnly;
  const patch = editable ? onPatch : undefined;
  const canDrag = editable && !isMobile;
  const bulkEnabled = editable && !!onBulkPatch;
  const rootRef = useRef<HTMLDivElement>(null);
  const toast = useOptionalToast();
  // phones, or a column squeezed by the docked task panel: the bulk bar's buttons are icons
  const iconBulk = useFloatBounds(rootRef, 620) || isMobile;
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
  const [announce, setAnnounce] = useState("");
  const [colMenu, setColMenu] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const [renameReq, setRenameReq] = useState<{ id: string; n: number } | null>(null);
  const [moveReq, setMoveReq] = useState<{ id: string; n: number } | null>(null);
  const [movedId, setMovedId] = useState<string | null>(null);
  const focusReq = useRef<{ id: string; force: boolean } | null>(null);
  const [ownGroup, setOwnGroup] = useState<BoardGroup>(() => {
    const s = readLS("kanbo-board-group") as BoardGroup | null;
    return s && ["status", "priority", "project", "assignee"].includes(s) ? s : "status";
  });
  const group = groupProp ?? ownGroup;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readSet("kanbo-board-collapsed"));
  useEffect(() => { if (!groupProp) writeLS("kanbo-board-group", ownGroup); }, [ownGroup, groupProp]);
  useEffect(() => { writeLS("kanbo-board-collapsed", JSON.stringify([...collapsed])); }, [collapsed]);

  /* ---- rows (swimlanes): per person, per board ---- */
  const [ownLanes, setOwnLanes] = useState<{ scope: string | undefined; by: SwimlaneBy }>(() => ({ scope: scopeKey, by: readSwimlane(readLS(swimlaneStorageKey(scopeKey))) }));
  const ownLanesBy = ownLanes.scope === scopeKey ? ownLanes.by : readSwimlane(readLS(swimlaneStorageKey(scopeKey)));
  const lanesBy = effectiveSwimlane(swimlaneProp ?? ownLanesBy, group);
  const setLanes = (by: SwimlaneBy) => {
    if (onSwimlaneChange) { onSwimlaneChange(by); return; }
    setOwnLanes({ scope: scopeKey, by });
    writeLS(swimlaneStorageKey(scopeKey), by);
  };
  const [lanesFolded, setLanesFolded] = useState<{ scope: string | undefined; set: Set<string> }>(() => ({ scope: scopeKey, set: readSet(laneCollapseStorageKey(scopeKey)) }));
  const foldedLanes = lanesFolded.scope === scopeKey ? lanesFolded.set : readSet(laneCollapseStorageKey(scopeKey));
  const toggleLane = (key: string) => {
    const next = new Set(foldedLanes);
    const k = `${lanesBy}:${key}`;
    if (next.has(k)) next.delete(k); else next.add(k);
    setLanesFolded({ scope: scopeKey, set: next });
    writeLS(laneCollapseStorageKey(scopeKey), JSON.stringify([...next]));
  };

  /* ---- WIP limits: the project's (shared) on a project board, else this device's per board ---- */
  const ownProjectId = projectIdProp ?? (scopeKey?.startsWith("project:") ? scopeKey.slice("project:".length) : undefined);
  const teamWip = !!onChangeBoardSettings || boardSettings !== undefined;
  const settings = teamWip ? demoAwareBoardSettings(ownProjectId, boardSettings) : undefined;
  const wipStore = wipKeyFor(scopeKey);
  const [wipCache, setWipCache] = useState<Record<string, Record<string, number>>>({});
  const localWip = useMemo(() => wipCache[wipStore] ?? (() => { try { return loadWipLimits((k) => localStorage.getItem(k), scopeKey); } catch { return {}; } })(), [wipCache, wipStore, scopeKey]);
  const limitOf = (colKey: string): number | undefined => (teamWip ? settings?.wip?.[wipSettingKey(group, colKey)] : localWip[`${group}:${colKey}`]);
  const saveSettings = (next: BoardSettings) => { markBoardSettingsTouched(ownProjectId); onChangeBoardSettings?.(next); };
  const saveLimit = (colKey: string, n: number | null) => {
    if (teamWip) { saveSettings(withWipLimit(settings, wipSettingKey(group, colKey), n)); return; }
    const next = { ...localWip };
    const k = `${group}:${colKey}`;
    if (n == null) delete next[k]; else next[k] = n;
    setWipCache((c) => ({ ...c, [wipStore]: next }));
    writeLS(wipStore, JSON.stringify(next));
  };
  const wipNote = teamWip ? "Shared with everyone on this board." : scopeKey ? "Saved for this board on this device." : "Saved on this device.";
  // the first time a writer opens a project board, the limits this device kept for it become the board's own
  useEffect(() => {
    if (!onChangeBoardSettings || readOnly || !scopeKey) return;
    const flag = wipCopiedKey(scopeKey);
    if (readLS(flag)) return;
    writeLS(flag, "1");
    if (settings?.wip && Object.keys(settings.wip).length) return;
    const local = (() => { try { return loadWipLimits((k) => localStorage.getItem(k), scopeKey); } catch { return {}; } })();
    const up = localWipToSettings(local);
    if (!Object.keys(up).length) return;
    saveSettings({ ...(settings ?? {}), wip: up });
    toast?.toast("This board's WIP limits are now shared with everyone on it.", "info");
  }, [scopeKey, !!onChangeBoardSettings, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- covers ---- */
  const coversFor = useCallback((pid: string): boolean => {
    if (pid === ownProjectId && teamWip) return !!settings?.covers;
    return !!demoAwareBoardSettings(pid, getProject(pid)?.boardSettings)?.covers;
  }, [ownProjectId, teamWip, settings]);

  // one pass over allTasks for sub-tasks and blockers (not one scan per card); the board's
  // own tasks are added because allTasks leaves out archived ones ("Show archived")
  const byId = useMemo(() => new Map([...allTasks, ...tasks].map((t) => [t.id, t])), [allTasks, tasks]);
  const children = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const c of allTasks) {
      if (!c.parentId) continue;
      const list = m.get(c.parentId);
      if (list) list.push(c); else m.set(c.parentId, [c]);
    }
    return m;
  }, [allTasks]);
  const isBlocked = (t: Task) => (t.dependencies ?? []).some((d) => { const x = byId.get(d); return !!x && x.status !== "done"; });

  // sub-tasks hide only when their parent is on this board too (they're reachable from it)
  const boardTasks = useMemo(() => hideNestedSubtasks(tasks), [tasks]);
  const coverUrls = useCoverUrls(boardTasks, coverUrlsProp);

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
          .map(({ pid, pr }) => ({ key: pid, label: pr.name, project: pr, accepts: true })),
        ...(colItems[NO_PROJECT_COL]?.length ? [{ key: NO_PROJECT_COL, label: "Other projects", accepts: false, hint: "In projects you can't see here. Drag a card to a project to move it." }] : []),
      ]
    : [
        ...memberList.map((m) => ({ key: m.id, label: m.name, avatar: m.id, accepts: true })),
        ...(colItems[UNASSIGNED_COL]?.length ? [{ key: UNASSIGNED_COL, label: "Unassigned", accepts: false, hint: "Drag a card onto a person to assign it." }] : []),
        ...(colItems[FORMER_COL]?.length ? [{ key: FORMER_COL, label: "Former members", accepts: false, hint: "Assigned to people no longer in this workspace. Drag a card onto a person to reassign it." }] : []),
      ];

  // rows: the lanes, each task's lane, and every cell's cards in column order
  const memberNames = new Map(memberList.map((m) => [m.id, m.name]));
  const laneCtx: SwimlaneCtx = { memberName: (id) => (memberNames.has(id) ? memberNames.get(id) || getMember(id)?.name || "Someone" : undefined), projectName: (id) => getProject(id)?.name, memberOrder: memberList.map((m) => m.id) };
  const lanes = lanesBy === "none" ? null : swimlanes(boardTasks, lanesBy, laneCtx);
  const laneOf = new Map<string, string>();
  if (lanes) for (const l of lanes) for (const id of l.taskIds) laneOf.set(id, l.key);
  const cells = new Map<string, Task[]>();
  for (const col of columns) for (const t of colItems[col.key] ?? []) {
    const ck = cellKeyOf(col.key, lanes ? laneOf.get(t.id) ?? null : null);
    const list = cells.get(ck);
    if (list) list.push(t); else cells.set(ck, [t]);
  }
  const cellOf = (id: string): string | undefined => { const c = colOf.get(id); return c === undefined ? undefined : cellKeyOf(c, lanes ? laneOf.get(id) ?? null : null); };

  // the latest render's data for the stable (memo-friendly) handlers below
  const live = useRef(null as unknown as {
    columns: BoardCol[]; colItems: Record<string, Task[]>; colOf: Map<string, string>; laneOf: Map<string, string>; cells: Map<string, Task[]>;
    lanes: Swimlane[] | null; lanesBy: SwimlaneBy; collapsed: Set<string>; group: BoardGroup; byId: Map<string, Task>;
    onMove: typeof onMove; patch?: typeof onPatch; limitOf: (k: string) => number | undefined; selected: Set<string>; editable: boolean;
  });
  live.current = { columns, colItems, colOf, laneOf, cells, lanes, lanesBy, collapsed, group, byId, onMove, patch, limitOf, selected, editable };
  const say = useCallback((text: string) => setAnnounce(text), []);

  /** Moves cards into a cell at `index` (counting the cards that stay); false when the cell can't take them. */
  const moveCards = useCallback((ids: string[], cellKey: string, index: number): { ok: boolean; wip: string | null } => {
    const L = live.current;
    const [colKey, laneKey = null] = cellKey.split("␟") as [string, string?];
    const col = L.columns.find((c) => c.key === colKey);
    const moving = ids.map((id) => L.byId.get(id)).filter((t): t is Task => !!t);
    if (!col || !moving.length) return { ok: false, wip: null };
    const laneFields = laneKey != null && L.lanesBy !== "none" ? lanePatch(L.lanesBy, laneKey) : null;
    for (const t of moving) {
      if (!col.accepts && L.colOf.get(t.id) !== colKey) return { ok: false, wip: null };
      if (laneKey != null && L.laneOf.get(t.id) !== laneKey && !laneFields) return { ok: false, wip: null };
    }
    const list = L.cells.get(cellKey) ?? [];
    const plan = moving.length === 1 ? planReorder(list, moving[0].id, index) : planInsertMany(list, moving.map((t) => t.id), index);
    const pos = new Map(plan.map((x) => [x.id, x.position]));
    const movingIds = new Set(moving.map((t) => t.id));
    for (const x of plan) if (!movingIds.has(x.id)) L.patch?.(x.id, { position: x.position });
    let entered = 0;
    for (const t of moving) {
      const position = pos.get(t.id);
      if (position === undefined) continue;
      markJustLanded(t.id);
      const sameCol = L.colOf.get(t.id) === colKey;
      if (!sameCol) entered++;
      const laneField = laneKey != null && L.laneOf.get(t.id) !== laneKey ? laneFields : null;
      if (L.group === "status") {
        // a reorder within a column only touches position (never re-stamps completedAt)
        if (sameCol && L.patch) L.patch(t.id, { ...(laneField ?? {}), position });
        else { L.onMove(t.id, col.status!, position); if (laneField) L.patch?.(t.id, laneField); }
      } else {
        const field: Partial<Task> = sameCol ? {} : L.group === "priority" ? { priority: col.key as Priority } : L.group === "project" ? { projectId: col.key } : { assigneeId: col.key };
        L.patch?.(t.id, { ...field, ...(laneField ?? {}), position });
      }
    }
    setMovedId(moving[moving.length - 1].id);
    // a move that takes the column past its WIP limit says so
    const wip = entered ? wipBreachMessage(col.label, (L.colItems[colKey]?.length ?? 0) + entered, L.limitOf(colKey)) : null;
    if (wip) toast?.toast(wip, "info");
    return { ok: true, wip };
  }, [toast]);

  const endHover = useCallback(() => { setDragId(null); setHover(null); setDragOver(null); }, []);
  // only re-render when the hovered card or half actually changes (dragover fires ~20×/s)
  const onHoverCard = useCallback((id: string, half: Half) => {
    setDragOver(null);
    setHover((h) => (h && h.id === id && h.half === half ? h : { id, half }));
  }, []);
  /** where a drop next to a card lands, counting only the cards that stay */
  const indexNear = (cellKey: string, targetId: string, half: Half, moving: ReadonlySet<string>): number => {
    const list = live.current.cells.get(cellKey) ?? [];
    const ti = list.findIndex((t) => t.id === targetId);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      if (moving.has(list[i].id)) continue;
      if (i < ti || (i === ti && half === "bottom")) n++;
    }
    return n;
  };
  const dropAnnounce = (ids: string[], cellKey: string, r: { ok: boolean; wip: string | null }) => {
    if (!r.ok) return;
    const L = live.current;
    const [colKey, laneKey] = cellKey.split("␟");
    const col = L.columns.find((c) => c.key === colKey);
    const lane = laneKey ? L.lanes?.find((l) => l.key === laneKey) : null;
    const what = ids.length === 1 ? L.byId.get(ids[0])?.title ?? "Task" : `${ids.length} tasks`;
    say(`${what} moved to ${col?.label ?? "the column"}${lane ? `, ${lane.label}` : ""}${r.wip ? `. ${r.wip}` : ""}`);
  };
  const cellOfRef = useRef(cellOf);
  cellOfRef.current = cellOf;
  const onCardDrop = useCallback((draggedId: string, targetId: string, half: Half) => {
    endHover();
    if (!draggedId || draggedId === targetId) return;
    const cellKey = cellOfRef.current(targetId);
    if (!cellKey) return;
    const r = moveCards([draggedId], cellKey, indexNear(cellKey, targetId, half, new Set([draggedId])));
    dropAnnounce([draggedId], cellKey, r);
  }, [endHover, moveCards]); // eslint-disable-line react-hooks/exhaustive-deps
  const onNativeDrop = (draggedId: string, cellKey: string) => {
    endHover();
    if (!draggedId) return;
    const list = cells.get(cellKey) ?? [];
    const r = moveCards([draggedId], cellKey, list.filter((t) => t.id !== draggedId).length);
    dropAnnounce([draggedId], cellKey, r);
  };
  /** the card under a pointer in a column: the drop goes before it (top half) or after it */
  const pointAt = (lane: HTMLElement | null, y: number): { id: string; half: Half } | null => {
    if (!lane) return null;
    const cards = Array.from(lane.querySelectorAll<HTMLElement>(":scope > [data-card-id]"));
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { id: el.dataset.cardId!, half: "top" };
    }
    const last = cards[cards.length - 1];
    return last ? { id: last.dataset.cardId!, half: "bottom" } : null;
  };
  const onKitOver = (cellKey: string, lane: HTMLElement | null, e: TaskDropEvent) => {
    const at = e.point ? pointAt(lane, e.point.y) : null;
    if (at && !e.payload.taskIds.includes(at.id)) { setDragOver(null); setHover((h) => (h && h.id === at.id && h.half === at.half ? h : at)); }
    else { setHover(null); setDragOver((d) => (d === cellKey ? d : cellKey)); }
  };
  const onKitLeave = (cellKey: string) => { setDragOver((d) => (d === cellKey ? null : d)); setHover(null); };
  const onKitDrop = (cellKey: string, lane: HTMLElement | null, e: TaskDropEvent) => {
    endHover();
    const ids = e.payload.taskIds.filter((id) => live.current.byId.has(id));
    if (!ids.length) return;
    const moving = new Set(ids);
    const at = e.point ? pointAt(lane, e.point.y) : null;
    const list = live.current.cells.get(cellKey) ?? [];
    const index = at ? indexNear(cellKey, at.id, at.half, moving) : list.filter((t) => !moving.has(t.id)).length;
    const r = moveCards(ids, cellKey, index);
    dropAnnounce(ids, cellKey, r);
    if (r.ok) focusReq.current = { id: ids[ids.length - 1], force: false };
  };
  /** which drags a cell takes: this board's own cards, into a column (and row) that can take them */
  const acceptsFor = (cellKey: string) => (payload: TaskDragPayload): boolean => {
    const L = live.current;
    if (!L.editable || payload.source !== "board" || !payload.taskIds.length) return false;
    const [colKey, laneKey] = cellKey.split("␟");
    const col = L.columns.find((c) => c.key === colKey);
    if (!col) return false;
    const laneOk = laneKey == null || L.lanesBy === "none" || !!lanePatch(L.lanesBy, laneKey);
    return payload.taskIds.every((id) => L.byId.has(id) && (col.accepts || L.colOf.get(id) === colKey) && (laneOk || L.laneOf.get(id) === laneKey));
  };
  const dragIds = useCallback((id: string) => {
    const sel = live.current.selected;
    return sel.has(id) ? [id, ...[...sel].filter((x) => x !== id && live.current.byId.has(x))] : [id];
  }, []);

  // keyboard alternative to drag-and-drop: Alt+↑/↓ reorders, Alt+←/→ moves between columns (within its row)
  const onKeyMove = useCallback((id: string, key: string) => {
    const L = live.current;
    const colKey = L.colOf.get(id);
    const ci = L.columns.findIndex((c) => c.key === colKey);
    if (!colKey || ci < 0) return;
    const col = L.columns[ci];
    const laneKey = L.lanes ? L.laneOf.get(id) ?? null : null;
    const lane = laneKey ? L.lanes?.find((l) => l.key === laneKey) : null;
    const where = (c: BoardCol) => `${c.label}${lane ? `, ${lane.label}` : ""}`;
    const title = L.byId.get(id)?.title ?? "Task";
    const list = L.cells.get(cellKeyOf(colKey, laneKey)) ?? [];
    const i = list.findIndex((t) => t.id === id);
    if (key === "ArrowUp" || key === "ArrowDown") {
      const up = key === "ArrowUp";
      if (!col.accepts) { say(`${col.label} can't be reordered. Move the card to another column first.`); return; }
      const to = up ? i - 1 : i + 1;
      if (to < 0 || to >= list.length) { say(`${title} is already at the ${up ? "top" : "bottom"} of ${where(col)}`); return; }
      if (!moveCards([id], cellKeyOf(colKey, laneKey), to).ok) return;
      say(`${title} moved ${up ? "up" : "down"}, ${to + 1} of ${list.length} in ${where(col)}`);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const dir = key === "ArrowLeft" ? -1 : 1;
      let j = ci + dir;
      while (j >= 0 && j < L.columns.length && (!L.columns[j].accepts || L.collapsed.has(L.columns[j].key))) j += dir;
      if (j < 0 || j >= L.columns.length) { say(`There's no column to the ${dir < 0 ? "left" : "right"} of ${col.label}`); return; }
      const dest = L.columns[j];
      const destCell = cellKeyOf(dest.key, laneKey);
      const r = moveCards([id], destCell, (L.cells.get(destCell) ?? []).length);
      if (!r.ok) return;
      say(`${title} moved to ${where(dest)}${r.wip ? `. ${r.wip}` : ""}`);
    } else return;
    focusReq.current = { id, force: true };
  }, [moveCards, say]);
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

  /* ---- the card's Move to… menu and Today ---- */
  const getMoveColumns = useCallback((id: string) => {
    const L = live.current;
    return {
      current: L.colOf.get(id),
      columns: L.columns.map((c) => ({ key: c.key, label: c.label, accepts: c.accepts, lead: groupLead(c, L.group) })),
    };
  }, []);
  const onMoveToColumn = useCallback((id: string, colKey: string) => {
    const L = live.current;
    const laneKey = L.lanes ? L.laneOf.get(id) ?? null : null;
    const cell = cellKeyOf(colKey, laneKey);
    const r = moveCards([id], cell, (L.cells.get(cell) ?? []).filter((t) => t.id !== id).length);
    dropAnnounce([id], cell, r);
  }, [moveCards]); // eslint-disable-line react-hooks/exhaustive-deps
  const onToggleToday = useCallback((id: string) => {
    const L = live.current;
    const t = L.byId.get(id);
    if (!t || !L.patch) return;
    L.patch(id, { planToday: !t.planToday });
    say(t.planToday ? `Took ${t.title} off Today` : `Added ${t.title} to Today`);
  }, [say]);
  // a status change from the card's own menu can take a column past its limit too
  const patchFromCard = useMemo(() => (patch ? (id: string, p: Partial<Task>) => {
    const L = live.current;
    const t = L.byId.get(id);
    patch(id, p);
    if (!t || L.group !== "status" || !p.status || p.status === t.status) return;
    const col = L.columns.find((c) => c.key === p.status);
    const msg = col ? wipBreachMessage(col.label, (L.colItems[col.key]?.length ?? 0) + 1, L.limitOf(col.key)) : null;
    if (msg) { toast?.toast(msg, "info"); say(msg); }
  } : undefined), [patch, toast, say]);

  // J/K through the cards (column by column), X selects, S/P/D/A edit, E renames, M moves, T plans for today, ⌘↵ completes
  const kb = useListKeyboard({
    rootRef, itemSelector: "[data-card-id]", idOf: (el) => el.dataset.cardId,
    focusTargetOf: (el) => el.querySelector<HTMLElement>("[data-card-open]"),
    onOpen,
    onComplete: editable ? (id) => { const t = byId.get(id); if (!t) return; if (onToggle) onToggle(id); else if (t.status !== "done") onMove(id, "done"); focusReq.current = { id, force: true }; } : undefined,
    onToggleSelect: bulkEnabled ? toggleSelect : undefined,
    onClear: clearSel,
    onAction: editable ? (action: ListKeyAction, id: string, el: HTMLElement) => {
      if (action === "rename") { if (patch && !isMobile) setRenameReq((r) => ({ id, n: (r?.n ?? 0) + 1 })); return; }
      if (action === "move") { setMoveReq((r) => ({ id, n: (r?.n ?? 0) + 1 })); return; }
      if (action === "today") { onToggleToday(id); return; }
      const sel = action === "status" ? "[data-card-status]" : action === "priority" ? "[data-card-priority]" : action === "due" ? "[data-card-due] button" : action === "assign" ? "[data-card-assignee]" : null;
      if (sel) el.querySelector<HTMLElement>(sel)?.click();
    } : undefined,
  });

  const estimate = useCallback((t: Task) => cardHeightEstimate({
    cover: effectiveCoverId(t) && coverUrls[effectiveCoverId(t)!] ? "image" : coversFor(t.projectId) ? "project" : null,
    tags: (t.tags?.length ?? 0) > 0, progress: (children.get(t.id)?.length ?? 0) + (t.subtasks?.length ?? 0) > 0, titleLength: t.title.length,
  }), [coverUrls, coversFor, children]);
  const pinIds = [activeId, kb.cursor, movedId];

  const renderCard = (t: Task, index: number, acceptsDrop: boolean) => {
    const prog = cardProgress(t, children.get(t.id) ?? []);
    const coverId = effectiveCoverId(t);
    const coverUrl = coverId ? coverUrls[coverId] : undefined;
    return (
      <KanbanCard key={t.id} task={t} index={index}
        progressDone={prog?.done ?? 0} progressTotal={prog?.total ?? 0} progressKind={(children.get(t.id)?.length ?? 0) > 0 ? "subtasks" : "checklist"}
        blocked={isBlocked(t)} coverUrl={coverUrl} coverProject={coversFor(t.projectId) ? getProject(t.projectId) : undefined}
        onOpen={onOpen} onPatch={patchFromCard}
        isMobile={isMobile} nativeDrag={canDrag} kitDrag={editable} acceptsDrop={acceptsDrop} dragging={dragId === t.id}
        dropHint={hover && hover.id === t.id && dragId !== t.id ? hover.half : null}
        onPickup={setDragId} onDragDone={endHover} onHoverCard={onHoverCard} onCardDrop={onCardDrop} dragIds={dragIds}
        selected={selected.has(t.id)} onSelect={bulkEnabled ? toggleSelect : undefined}
        customFields={customFields} members={members}
        onKeyMove={editable ? onKeyMove : undefined} onMenuDone={onMenuDone} hintId={hintId}
        showProject={showProject} cursor={kb.cursor === t.id} active={activeId === t.id}
        canRename={!!patch && !isMobile} renameNonce={renameReq?.id === t.id ? renameReq.n : 0} moveNonce={moveReq?.id === t.id ? moveReq.n : 0}
        getMoveColumns={editable ? getMoveColumns : undefined} onMoveToColumn={editable ? onMoveToColumn : undefined}
        onToggleToday={patch ? onToggleToday : undefined} onAnnounce={say} />
    );
  };

  /* ---- columns ---- */
  const colState = (col: BoardCol) => {
    const items = colItems[col.key] ?? [];
    const limit = limitOf(col.key);
    return { items, limit, state: wipState(items.length, limit) };
  };
  const head = (col: BoardCol) => {
    const { items, limit, state } = colState(col);
    const countLabel = `${items.length} task${items.length === 1 ? "" : "s"} in ${col.label}${limit != null ? `, WIP limit ${limit}${state === "over" ? ", over the limit" : state === "at" ? ", at the limit" : ""}` : ""}`;
    const count = <>{state === "over" && <Icon name="alert" size={12} sw={2} />}{items.length}{limit != null ? `/${limit}` : ""}</>;
    return (
      <div className="ktv-col-head kbd-colhead" data-wip={state !== "ok" ? state : undefined}>
        {groupLead(col, group)}
        <span className="ktv-col-name">{col.label}</span>
        {editable
          ? <button type="button" className="ktv-wip kbd-count" data-wip={state} onClick={(e) => setColMenu({ key: col.key, anchor: e.currentTarget })} title="Set WIP limit" aria-label={`${countLabel}. Set WIP limit`} aria-haspopup="dialog">{count}</button>
          : <span className="ktv-wip kbd-count" data-wip={state} aria-label={countLabel}>{count}</span>}
        <span className="ktv-col-tools">
          {col.status && editable && <IconButton icon="plus" size="sm" label={`Add task to ${col.label}`} onClick={() => onAdd(col.status!)} />}
          {editable && <IconButton icon="more" size="sm" label={`Options for ${col.label} column`} aria-haspopup="dialog" onClick={(e) => setColMenu({ key: col.key, anchor: e.currentTarget })} />}
          <IconButton icon="chevronLeft" size="sm" label={`Collapse ${col.label} column`} aria-expanded onClick={() => toggleCollapse(col.key)} />
        </span>
      </div>
    );
  };
  const rail = (col: BoardCol, compact: boolean) => {
    const n = (colItems[col.key] ?? []).length;
    return (
      <button key={col.key} type="button" className="ktv-colrail" data-compact={compact || undefined} onClick={() => toggleCollapse(col.key)} aria-expanded={false}
        aria-label={`Expand ${col.label} column, ${n} task${n === 1 ? "" : "s"}`} title={compact ? col.label : undefined}>
        <Icon name="chevronRight" size={14} />
        {!compact && groupLead(col, group)}
        <span className="ktv-mono">{n}</span>
        {!compact && <b>{col.label}</b>}
      </button>
    );
  };
  const cell = (col: BoardCol, lane: Swimlane | null) => {
    const ck = cellKeyOf(col.key, lane?.key ?? null);
    const items = cells.get(ck) ?? [];
    const laneTakes = !lane || !!lanePatch(lanesBy, lane.key);
    return (
      <BoardCell key={ck} cellKey={ck} col={col} laneKey={lane?.key ?? null} laneLabel={lane?.label} items={items}
        nativeOk={canDrag && col.accepts && laneTakes} kitOk={editable} isOverNative={dragOver === ck && !hover}
        accepts={acceptsFor(ck)} onNativeOver={(k) => { setDragOver(k); setHover(null); }} onNativeLeave={(k) => setDragOver((d) => (d === k ? null : d))} onNativeDrop={onNativeDrop}
        onKitOver={onKitOver} onKitLeave={onKitLeave} onKitDrop={onKitDrop}
        renderCard={(t, i) => renderCard(t, i, col.accepts && laneTakes)} estimate={estimate} pinIds={pinIds} projectId={ownProjectId}
        wip={colState(col).state} />
    );
  };
  const menuCol = colMenu ? columns.find((c) => c.key === colMenu.key) : undefined;
  const showBar = !onGroupChange || !onSwimlaneChange;

  return (
    <div ref={rootRef} className="ktv" style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div role="status" aria-live="polite" className="sr-only">{announce}</div>
      {showBar && (
        <BoardBar group={group} onGroup={onGroupChange ? undefined : (g) => setOwnGroup(g)} lanes={lanesBy} onLanes={onSwimlaneChange ? undefined : setLanes}
          covers={!!settings?.covers} onCovers={onChangeBoardSettings && !onSwimlaneChange && editable ? (on) => saveSettings(withCovers(settings, on)) : undefined} hintId={hintId} />
      )}
      <p id={hintId} className="sr-only">{editable
        ? `Press Enter to open, E to rename, M to move it, T to add it to Today. Alt plus the arrow keys moves the card up, down or to the next column${lanes ? " in its row" : ""}.`
        : "Press Enter to open."}</p>
      {!lanes ? (
        <div className="ktv-board" data-selecting={selectionActive || undefined}>
          {columns.map((col) => {
            if (collapsed.has(col.key)) return rail(col, false);
            const { state } = colState(col);
            return (
              <div key={col.key} role="group" aria-label={`${col.label} column`} className="ktv-col" data-wip={state !== "ok" ? state : undefined}>
                {head(col)}
                {col.hint && <p className="ktv-col-hint">{col.hint}</p>}
                {cell(col, null)}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="kbd-grid" data-selecting={selectionActive || undefined}>
          <div className="kbd-heads">
            {columns.map((col) => collapsed.has(col.key) ? rail(col, true) : (
              <div key={col.key} className="ktv-col kbd-headcell" data-wip={colState(col).state !== "ok" ? colState(col).state : undefined}>{head(col)}</div>
            ))}
          </div>
          {lanes.length === 0 && <div className="ktv-lane-empty kbd-nolanes">Nothing on this board yet</div>}
          {lanes.map((lane) => {
            const folded = foldedLanes.has(`${lanesBy}:${lane.key}`);
            const bodyId = `${hintId}-lane-${lane.key}`;
            return (
              <div key={lane.key} role="group" className="kbd-swim" aria-label={`${lane.label}, ${lane.taskIds.length} task${lane.taskIds.length === 1 ? "" : "s"}`} data-folded={folded || undefined}>
                <h3 className="kbd-swim-head">
                  <button type="button" aria-expanded={!folded} aria-controls={folded ? undefined : bodyId} onClick={() => toggleLane(lane.key)}>
                    <Icon name={folded ? "chevronRight" : "chevronDown"} size={14} />
                    {groupLead({ key: lane.key }, lanesBy)}
                    <span className="kbd-swim-name">{lane.label}</span>
                    <span className="ktv-mono kbd-swim-count">{lane.taskIds.length}</span>
                  </button>
                </h3>
                {!folded && (
                  <div id={bodyId} className="kbd-swim-row">
                    {columns.map((col) => collapsed.has(col.key)
                      ? <div key={col.key} className="kbd-railcell" aria-hidden="true" />
                      : <div key={col.key} className="ktv-col kbd-cellwrap">{cell(col, lane)}</div>)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {colMenu && menuCol && (
        <Popover anchor={colMenu.anchor} role="dialog" label={`Options for ${menuCol.label}`} onClose={() => setColMenu(null)} minWidth={0}>
          <ColumnMenu column={menuCol.label} count={(colItems[menuCol.key] ?? []).length} limit={limitOf(menuCol.key)} scopeNote={wipNote}
            canEditWip={editable && (!teamWip || !!onChangeBoardSettings)} onSaveLimit={(n) => saveLimit(menuCol.key, n)} onClose={() => setColMenu(null)}
            onCollapse={() => toggleCollapse(menuCol.key)} onAdd={menuCol.status && editable ? () => onAdd(menuCol.status!) : undefined} />
        </Popover>
      )}

      {bulkEnabled && selectionActive && (
        <div role="toolbar" aria-label="Bulk actions for selected tasks" className="ktv-float">
          <span className="ktv-float-count" aria-live="polite">{selIds.length} selected</span>
          <span className="ktv-float-sep" aria-hidden="true" />
          <Button variant="ghost" size="sm" icon="check" onClick={() => applyBulk({ status: "done", completedAt: toLocalISO(new Date()) })} aria-label={iconBulk ? "Mark selected as done" : undefined}>{!iconBulk && "Done"}</Button>
          <BulkMenuButton label="Status" icon="layers" iconOnly={iconBulk} open={bulkMenu === "status"} onToggle={() => setBulkMenu((m) => m === "status" ? null : "status")}>
            {STATUS_ORDER.map((s) => (<button key={s} type="button" className="ktv-mi" onClick={() => applyBulk({ status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined })}><StatusGlyph status={s} size={14} readOnly /> {STATUS_META[s].label}</button>))}
          </BulkMenuButton>
          <BulkMenuButton label="Priority" icon="flag" iconOnly={iconBulk} open={bulkMenu === "priority"} onToggle={() => setBulkMenu((m) => m === "priority" ? null : "priority")}>
            {BULK_PRIORITIES.map((pr) => (<button key={pr} type="button" className="ktv-mi" onClick={() => applyBulk({ priority: pr })}><span style={{ display: "inline-grid", placeItems: "center", width: 16 }}><PriorityGlyph priority={pr} /></span> {PRIORITY_META[pr].label}</button>))}
          </BulkMenuButton>
          {members.length > 0 && (
            <BulkMenuButton label="Assign" icon="user" iconOnly={iconBulk} open={bulkMenu === "assignee"} onToggle={() => setBulkMenu((m) => m === "assignee" ? null : "assignee")}>
              {members.map((m) => (<button key={m.id} type="button" className="ktv-mi" onClick={() => applyBulk({ assigneeId: m.id })}><Avatar id={m.id} size={20} /> {m.name}</button>))}
            </BulkMenuButton>
          )}
          <Button variant="ghost" size="sm" icon="trash" onClick={() => { onBulkDelete?.(selIds); clearSel(); }} aria-label={iconBulk ? "Delete selected tasks" : undefined} style={{ color: "var(--signal, var(--prio-urgent))" }}>{!iconBulk && "Delete"}</Button>
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
            {/* the today line and the dependency connectors run behind the bars, so no label is crossed */}
            {todayIdx >= 0 && todayIdx < DAYS && <div aria-hidden className="ktv-tl-nowline" style={{ left: laneW + todayIdx * colW + colW / 2 }} />}
            {depLines.length > 0 && (
              <svg aria-hidden width={laneW + trackW} height={totalH} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}>
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
                  <div className="ktv-tl-lane-in"><ProjectTile project={g.project} size={16} /><span>{g.project.name}</span><small>{g.items.length}</small></div>
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
/** Connected accounts as chips (each can be disconnected) and an "Add calendar" menu that
 *  always offers both providers: several accounts of either kind can be connected. */
function ConnectCalendarMenu({ connections, onConnect, onDisconnect, syncing }: {
  connections: CalendarConnection[];
  onConnect: (p: CalProvider) => void;
  onDisconnect: (connectionId: string) => void;
  syncing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {connections.map((c) => {
        const meta = PROVIDER_META[c.provider];
        const who = c.accountEmail || meta.label;
        return (
          <span key={c.id} className="ktv-saved" style={{ height: 28 }}>
            <span className="ktv-dot" style={{ background: meta.color, marginRight: 6 }} />
            <span style={{ color: "var(--ink-2)" }}>{who}</span>
            <button type="button" title={`Disconnect ${who}`} aria-label={`Disconnect ${who}`} onClick={() => onDisconnect(c.id)}><Icon name="x" size={12} /></button>
          </span>
        );
      })}
      {syncing && <span className="ktv-note">Syncing…</span>}
      <Button ref={btn} variant="ghost" size="sm" icon="calendarPlus" iconRight="chevronDown" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>Add calendar</Button>
      {open && (
        <Popover anchor={btn.current} align="end" label="Add a calendar account" onClose={() => setOpen(false)} minWidth={248}>
          {(Object.keys(PROVIDER_META) as CalProvider[]).map((p) => {
            const meta = PROVIDER_META[p];
            return (
              <MenuItem key={p} onSelect={() => { setOpen(false); onConnect(p); }}>
                <span className="ktv-dot" style={{ background: meta.color, margin: "0 4px" }} />
                <span style={{ flex: 1 }}>{meta.add}</span>
                <Icon name="plus" size={14} />
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

/** Month's key to the calendars shown: one chip per calendar, in its colour. A chip hides
 *  (or shows again) that calendar's events here, on this device only — Settings decides
 *  what's connected; this is "not right now". */
function CalendarLegend({ entries, hidden, onToggle, warnings, onOpenSettings }: {
  entries: LegendEntry[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  warnings: CalendarWarning[];
  onOpenSettings?: () => void;
}) {
  if (entries.length === 0 && warnings.length === 0) return null;
  const nameCount = new Map<string, number>();
  for (const e of entries) nameCount.set(e.name, (nameCount.get(e.name) ?? 0) + 1);
  const failed = new Set(warnings.map((w) => `${w.connectionId}|${w.calendarId ?? "*"}`)).size;
  return (
    <div className="ktv-cal-legend">
      {entries.length > 0 && (
        <div className="ktv-cal-chips" role="group" aria-label="Calendars shown on Month">
          {entries.map((e) => {
            const on = !hidden.has(e.key);
            const detail = e.accountEmail ? `${e.name} (${e.accountEmail})` : e.name;
            return (
              <button key={e.key} type="button" className="ktv-cal-chip" aria-pressed={on} data-off={!on || undefined}
                title={on ? `Hide ${detail} here for now` : `Show ${detail}`} style={calInk(e.color)} onClick={() => onToggle(e.key)}>
                <span className="ktv-cal-swatch" aria-hidden="true" />
                <span className="ktv-cal-chip-name">{e.name}</span>
                {/* two calendars with one name ("Calendar" in two Outlook accounts) are told apart */}
                {(nameCount.get(e.name) ?? 0) > 1 && e.accountEmail && <span className="sr-only"> ({e.accountEmail})</span>}
              </button>
            );
          })}
        </div>
      )}
      {failed > 0 && (
        <span className="ktv-cal-warn" role="note">
          <Icon name="alert" size={12} sw={2} />
          {failed === 1 ? "1 calendar couldn't load" : `${failed} calendars couldn't load`}
          {onOpenSettings && <button type="button" className="ktv-cal-warn-link" onClick={onOpenSettings}>See Settings</button>}
        </span>
      )}
    </div>
  );
}

export function CalendarView({ tasks, onOpen, onPatch, connections = [], externalEvents = [], warnings = [], onConnect, onDisconnect, syncing, readOnly = false, scope, onScopeChange, onOpenSettings }: {
  tasks: Task[];
  onOpen: (id: string) => void;
  onPatch?: (id: string, patch: Partial<Task>) => void;
  /** connected calendar accounts (several, each with its chosen calendars) */
  connections?: CalendarConnection[];
  /** their events, each tagged with its calendar and colour */
  externalEvents?: ExternalEvent[];
  /** calendars the last sync couldn't read */
  warnings?: CalendarWarning[];
  /** the add / disconnect menu shows only when these are passed (connect lives in Settings) */
  onConnect?: (p: CalProvider) => void;
  onDisconnect?: (connectionId: string) => void;
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

  // the calendars shown, and the ones hidden here for now (per device)
  const legend = useMemo(() => calendarLegend(connections, externalEvents), [connections, externalEvents]);
  const [hiddenCals, setHiddenCals] = useState<Set<string>>(loadHiddenCalendars);
  const toggleCal = (key: string) => setHiddenCals((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    saveHiddenCalendars(next);
    return next;
  });
  const shownEvents = hiddenCals.size ? externalEvents.filter((e) => !hiddenCals.has(eventCalendarKey(e))) : externalEvents;
  const legendBar = (connections.length > 0 || legend.length > 0) && (
    <CalendarLegend entries={legend} hidden={hiddenCals} onToggle={toggleCal} warnings={warnings} onOpenSettings={onOpenSettings} />
  );

  // index tasks and external events by local calendar day once (not per cell)
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const tasksByDay = new Map<string, Task[]>();
  for (const t of tasks) if (t.dueDate) (tasksByDay.get(t.dueDate) ?? tasksByDay.set(t.dueDate, []).get(t.dueDate)!).push(t);
  const evByDate: Record<string, ExternalEvent[]> = {};
  for (const e of shownEvents) {
    const key = e.allDay ? (e.start || "").slice(0, 10) : toLocalISO(new Date(e.start));
    if (key) (evByDate[key] ||= []).push(e);
  }
  const fmtTime = (e: ExternalEvent) => (e.allDay ? "" : hhmm(new Date(e.start)));
  // "09:00 · Standup · Work" for the hover title, and the calendar's name for screen readers
  const evTitle = (e: ExternalEvent, time: string) => `${time ? time + " · " : ""}${e.title}${e.calendarName ? ` · ${e.calendarName}` : ""}`;
  const evCal = (e: ExternalEvent) => e.calendarName ? <span className="sr-only">, {e.calendarName}</span> : null;
  const isMobile = useMediaQuery("(max-width: 860px)");
  const todayIso = toLocalISO(KANBO_TODAY);

  const scopeSwitch = scope && onScopeChange && (
    <Segmented ariaLabel="Whose tasks" value={scope} onChange={onScopeChange} options={[{ value: "mine", label: "Mine" }, { value: "team", label: "Team" }]} />
  );
  const prompt = onOpenSettings && connections.length === 0 && (
    <div className="ktv-cal-prompt">
      <Icon name="calendar" size={16} sw={1.75} />
      <span>Connect your Google or Outlook calendars in Settings to see your meetings here.</span>
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
        {legendBar}
        {prompt}
        {agenda.length === 0 ? (
          <EmptyState art="calendar" title="Nothing scheduled this month" body="Tasks with a due date, and your connected calendar's events, show up here." />
        ) : agenda.map((day) => (
          <div key={day.iso} className="ktv-agenda-day">
            <h3 data-today={day.iso === todayIso || undefined}>{dayLabel(day.iso, "long")}{day.iso === todayIso && <span className="ktv-mono">Today</span>}</h3>
            {day.events.map((e) => (
              <div key={e.id} className="ktv-agenda-item" data-event="true" style={calInk(eventColour(e))} title={evTitle(e, fmtTime(e))}>
                <Icon name="calendar" size={14} />
                <span>{e.title}{evCal(e)}</span>
                <span className="ktv-mono" style={{ color: "var(--ink-3)" }}>{fmtTime(e) || "All day"}</span>
              </div>
            ))}
            {day.tasks.map((t) => {
              const proj = getProject(t.projectId);
              return (
                <button key={t.id} type="button" className="ktv-agenda-item" onClick={() => onOpen(t.id)} aria-label={taskName(t)}>
                  <StatusGlyph status={t.status} size={16} readOnly />
                  <span style={{ color: t.status === "done" ? "var(--ink-3)" : undefined, textDecoration: t.status === "done" ? "line-through" : undefined }}>{t.title}</span>
                  {proj && <ProjectTile project={proj} size={16} title={proj.name} />}
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
          {/* Today › Month already sits under a Day · Week · Month switcher: a second "Week" there would mean something else */}
          {!scopeSwitch && <Segmented ariaLabel="Calendar range" value={mode} onChange={switchMode} options={[{ value: "month", label: "Month" }, { value: "week", label: "Week" }]} />}
          {scopeSwitch}
        </div>
      </div>
      {legendBar}
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
                    <span key={e.id} className="ktv-cal-event" title={evTitle(e, time)} style={calInk(eventColour(e))}>
                      {time && <time>{time}</time>}
                      <span>{e.title}{evCal(e)}</span>
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
              <div key={e.id} className="ktv-cal-event" style={{ height: 28, margin: "0 4px", ...calInk(eventColour(e)) }} title={evTitle(e, fmtTime(e))}>
                <time>{fmtTime(e) || "All day"}</time><span>{e.title}{evCal(e)}</span>
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
                    {proj && <ProjectTile project={proj} size={16} title={proj.name} />}
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
