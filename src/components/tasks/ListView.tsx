/* ============================================================
   KANBO — List view (the showpiece) + TaskRow
   ============================================================ */
import { useState, useRef, useEffect, useMemo, useCallback, memo } from "react";
import { Icon, Avatar, Check, StatusDot, Tag, PriorityFlag, AiScore, wasJustCompleted, EmptyArt, wasJustLanded, markJustLanded, Collapse } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  getProject, getMember, dueState, fmtDue, toLocalISO, KANBO_TODAY,
  STATUS_META, STATUS_ORDER, PRIORITY_META,
} from "../../data/data";
import type { Task, Subtask, IconName, Priority, Section, CustomFieldDef, Project } from "../../data/types";

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
  return <>{chips.map((c) => <span key={c.id} className="pchip" title={c.label}><span className="truncate" style={{ maxWidth: 90 }}>{c.label}</span></span>)}</>;
}
import type { GroupBy } from "../../app-types";
import { useEntrance } from "../../hooks/useEntrance";

export function SubtaskProgress({ subtasks }: { subtasks?: Subtask[] }) {
  if (!subtasks?.length) return null;
  const done = subtasks.filter((s) => s.done).length;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>
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

/** Position for a task dropped above/below `targetId` (or at the top of the
 *  group when targetId is null) in a group whose rows render in `items` order.
 *  Done rows always sort to the bottom whatever their position, so positions
 *  aren't monotonic across that boundary: neighbours are taken from the rows
 *  in the dropped task's own band (open vs done), counted up to the drop point. */
export function dropPosition(items: Task[], draggedId: string, targetId: string | null, half: "top" | "bottom", willBeDone: boolean): number {
  const rest = items.filter((t) => t.id !== draggedId);
  const ti = targetId ? rest.findIndex((t) => t.id === targetId) : -1;
  const at = ti < 0 ? 0 : half === "top" ? ti : ti + 1;
  const inBand = (t: Task) => (t.status === "done") === willBeDone;
  const k = rest.slice(0, at).filter(inBand).length;
  const band = rest.filter(inBand);
  return between(band[k - 1], band[k]);
}

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

const triggerStyle: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 99, color: "inherit" };
// the task title is a real button (keyboard users can reach and open it) that looks like text
const titleBtnStyle: React.CSSProperties = { display: "block", minWidth: 0, maxWidth: "100%", padding: 0, margin: 0, border: "none", backgroundColor: "transparent", textAlign: "left", cursor: "inherit", fontFamily: "inherit", lineHeight: "inherit", letterSpacing: "inherit", borderRadius: 4 };
const selectBoxStyle = (on: boolean): React.CSSProperties => ({
  width: 18, height: 18, borderRadius: 5, flexShrink: 0, padding: 0, cursor: "pointer", display: "grid", placeItems: "center",
  border: `1.6px solid ${on ? "var(--accent)" : "var(--hairline-strong)"}`, background: on ? "var(--accent)" : "transparent", transition: "opacity .12s",
});

// read-only stand-in for the completion checkbox (guests can't complete tasks)
function DoneMark({ done, size = 18 }: { done: boolean; size?: number }) {
  return (
    <span role="img" aria-label={done ? "Completed" : "Not completed"} style={{ width: size, height: size, borderRadius: 6, flexShrink: 0, boxSizing: "border-box", display: "grid", placeItems: "center",
      border: `1.6px solid ${done ? "var(--accent)" : "var(--hairline-strong)"}`, background: done ? "var(--accent)" : "transparent", color: "var(--on-accent)" }}>
      {done && <Icon name="check" size={Math.round(size * 0.62)} sw={3} />}
    </span>
  );
}

// tick shown against the current value in an inline menu
function CurrentMark() {
  return <Icon name="check" size={13} sw={2.4} style={{ marginLeft: "auto", color: "var(--accent)" }} />;
}

interface TaskRowProps {
  task: Task;
  /** this row's sub-tasks (full tasks) and how many are done — from the parent's per-render map */
  childTasks: Task[]; childDone: number;
  /** id → task, for "blocked by" lookups without scanning every task per row */
  byId: Map<string, Task>;
  onOpen: (id: string) => void; onToggle: (id: string) => void; onToggleSubtask: (taskId: string, subId: string) => void;
  smart: boolean; depth?: number; isMobile: boolean; readOnly?: boolean;
  selected?: boolean; selectionActive?: boolean; onSelect?: (id: string, range: boolean) => void;
  draggable?: boolean; dragging?: boolean; dropHint?: "top" | "bottom" | null;
  onPickup?: (id: string) => void; onHover?: (id: string, half: "top" | "bottom") => void; onRowDrop?: (draggedId: string, targetId: string, half: "top" | "bottom") => void;
  /** keyboard reorder (Alt+↑/↓ on the title) */
  onMoveBy?: (id: string, dir: -1 | 1) => void;
  onPatch?: (id: string, patch: Partial<Task>) => void; members?: { id: string; name: string }[]; customFields?: CustomFieldDef[];
}

const TaskRow = memo(function TaskRow({ task, childTasks, childDone, byId, onOpen, onToggle, onToggleSubtask, smart, depth = 0, isMobile, readOnly = false, selected = false, selectionActive = false, onSelect, draggable = false, dragging = false, dropHint = null, onPickup, onHover, onRowDrop, onMoveBy, onPatch, members = NO_MEMBERS, customFields = NO_FIELDS }: TaskRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [selFocus, setSelFocus] = useState(false);
  const [dateFocus, setDateFocus] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [menu, setMenu] = useState<null | "priority" | "assignee" | "status">(null);
  const statusRef = useRef<HTMLButtonElement>(null);
  const priorityRef = useRef<HTMLButtonElement>(null);
  const assigneeRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const toggleMenu = (m: "priority" | "assignee" | "status") => setMenu((cur) => cur === m ? null : m);
  const edit = readOnly ? undefined : onPatch;
  const PRIORITIES_INLINE: Priority[] = ["urgent", "high", "medium", "low"];
  const saveTitle = () => { const v = titleDraft.trim(); setEditingTitle(false); if (v && v !== task.title) edit?.(task.id, { title: v }); else setTitleDraft(task.title); };
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
  // play the strike-sweep only when THIS row flips to done while on screen —
  // rows that are already done on first render just show a static strike.
  // (also plays when completing MOVED this row into another group — the fresh
  // mount looks itself up in the just-completed registry)
  const prevDone = useRef(done);
  const [justDone, setJustDone] = useState(() => done && wasJustCompleted(task.id));
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
  // soft accent glow when this row was just dropped (drag-reorder)
  const [landed, setLanded] = useState(() => wasJustLanded(task.id));
  useEffect(() => { if (wasJustLanded(task.id)) setLanded(true); }, [task.id, task.position]);
  useEffect(() => { if (!landed) return; const t = window.setTimeout(() => setLanded(false), 1000); return () => window.clearTimeout(t); }, [landed]);
  const ds = dueState(task.dueDate, task.status);
  const dueColor = ds === "overdue" ? "var(--prio-urgent)" : ds === "today" ? "var(--accent)" : "var(--ink-3)";
  // sub-tasks are full tasks with parentId; legacy checklist items live on task.subtasks
  const subDone = childDone + (task.subtasks ?? []).filter((s) => s.done).length;
  const subTotal = childTasks.length + (task.subtasks?.length ?? 0);
  const hasSubs = subTotal > 0;
  const statusLabel = STATUS_META[task.status].label;
  const prioLabel = PRIORITY_META[task.priority].label;
  const assignee = getMember(task.assigneeId);
  const q = `“${task.title}”`;

  const onTitleKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "F2" && edit) { e.preventDefault(); startRename(); return; }
    if (e.altKey && onMoveBy && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); e.stopPropagation(); onMoveBy(task.id, e.key === "ArrowUp" ? -1 : 1); }
  };

  return (
    <div className="krow-cv" style={{ borderBottom: "1px solid var(--hairline)" }}>
      <div role="group" aria-label={task.title} onClick={() => onOpen(task.id)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} className={"task-row lift-row" + (landed ? " kland-row" : "")}
        draggable={draggable}
        onDragStart={draggable ? (e) => { e.dataTransfer.setData("text/kanbo-task", task.id); e.dataTransfer.effectAllowed = "move"; onPickup?.(task.id); } : undefined}
        onDragOver={draggable ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onHover?.(task.id, e.clientY < r.top + r.height / 2 ? "top" : "bottom"); } : undefined}
        onDrop={draggable ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData("text/kanbo-task"); const r = e.currentTarget.getBoundingClientRect(); onRowDrop?.(id, task.id, e.clientY < r.top + r.height / 2 ? "top" : "bottom"); } : undefined}
        onDragEnd={draggable ? () => onPickup?.("") : undefined}
        style={{
        display: "flex", alignItems: "center", gap: 12, padding: "var(--kanbo-rowpad,10px) 18px var(--kanbo-rowpad,10px) " + (18 + depth * 22) + "px",
        cursor: draggable ? "grab" : "pointer", position: "relative",
        opacity: dragging ? 0.4 : (done ? 0.55 : 1),
        background: selected ? "var(--accent-dim)" : undefined,
        boxShadow: dropHint === "top" ? "inset 0 3px 0 -1px var(--accent)" : dropHint === "bottom" ? "inset 0 -3px 0 -1px var(--accent)" : undefined,
      }}>
        {/* priority accent bar */}
        <span style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderRadius: 99,
          background: PRIORITY_META[task.priority].color,
          opacity: task.priority === "urgent" || task.priority === "high" ? 0.9 : 0.3 }} />

        {onSelect && (
          <button type="button" role="checkbox" aria-checked={selected} aria-label={`Select ${q}`}
            onClick={(e) => { e.stopPropagation(); onSelect(task.id, e.shiftKey); }}
            onFocus={() => setSelFocus(true)} onBlur={() => setSelFocus(false)}
            style={{ ...selectBoxStyle(selected), opacity: selected || selectionActive || hovered || selFocus ? 1 : 0 }}>
            {selected && <Icon name="check" size={12} sw={3} style={{ color: "var(--on-accent)" }} />}
          </button>
        )}

        {readOnly ? <DoneMark done={done} /> : <Check done={done} celebrateKey={task.id} onToggle={() => onToggle(task.id)} />}

        {hasSubs && (
          <button type="button" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }} className="btn-icon" aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} sub-tasks of ${q}`}
            style={{ width: 20, height: 20, border: "none", background: "transparent", color: "var(--ink-4)" }}>
            <Icon name="chevronRight" size={14} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .18s" }} />
          </button>
        )}
        {edit ? (
          <span style={{ display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
            <button ref={statusRef} type="button" onClick={() => toggleMenu("status")} aria-haspopup="menu" aria-expanded={menu === "status"}
              aria-label={`Status: ${statusLabel}. Change status for ${q}`} title={statusLabel}
              style={{ ...triggerStyle, padding: 7, margin: -7 }}>
              <StatusDot status={task.status} />
            </button>
            {menu === "status" && <Popover open anchorRef={statusRef} onClose={closeMenu} label={`Status for ${q}`}>
              {STATUS_ORDER.map((s) => (
                <button key={s} type="button" role="menuitemradio" aria-checked={task.status === s} style={bulkItemStyle}
                  onClick={() => { setMenu(null); if (s !== task.status) edit(task.id, { status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined }); }}>
                  <StatusDot status={s} size={9} /> {STATUS_META[s].label}{task.status === s && <CurrentMark />}
                </button>
              ))}
            </Popover>}
          </span>
        ) : <span role="img" aria-label={`Status: ${statusLabel}`} title={statusLabel} style={{ display: "inline-flex" }}><StatusDot status={task.status} /></span>}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            {task.isMilestone && <span title="Milestone" style={{ width: 9, height: 9, transform: "rotate(45deg)", background: "var(--st-review)", borderRadius: 2, flexShrink: 0 }} />}
            {editingTitle ? (
              // eslint-disable-next-line jsx-a11y/no-autofocus
              <input autoFocus value={titleDraft} aria-label={`Rename ${q}`} onClick={(e) => e.stopPropagation()} onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") saveTitle(); else if (e.key === "Escape") { setTitleDraft(task.title); setEditingTitle(false); } }}
                onBlur={saveTitle}
                style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 450, fontFamily: "var(--font-display)", color: "var(--ink)", background: "var(--surface)", border: "1px solid var(--accent)", borderRadius: 7, padding: "3px 7px", outline: "none" }} />
            ) : (
              <button ref={titleRef} type="button" data-row-title={task.id} className={"truncate" + (justDone ? " kstrike-anim" : "")} title={edit ? "Double-click (or F2) to rename" : undefined}
                onClick={(e) => { e.stopPropagation(); onOpen(task.id); }}
                onDoubleClick={edit ? (e) => { e.stopPropagation(); startRename(); } : undefined}
                onKeyDown={onTitleKey}
                style={{ ...titleBtnStyle, fontSize: 14.5, fontWeight: 450, color: done ? "var(--ink-4)" : "var(--ink)", textDecoration: done ? "line-through" : "none" }}>{task.title}</button>
            )}
            {blocked.length > 0 && (
              <span data-tip={"Blocked by " + blocked.map((b) => b.title).join(", ")} role="img" aria-label={"Blocked by " + blocked.map((b) => b.title).join(", ")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--st-blocked)", flexShrink: 0, position: "relative" }}>
                <Icon name="lock" size={12} />
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            {(task.tags || []).slice(0, 2).map((tg) => <Tag key={tg} id={tg} small />)}
            {subTotal > 0 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>
                <Icon name="layers" size={12} /> {subDone}/{subTotal}
              </span>
            )}
            <CustomChips task={task} fields={customFields} members={members} />
            {task.recurrence && task.recurrence !== "none" && <span title={`Repeats ${task.recurrence}`} style={{ display: "inline-flex", color: "var(--ink-4)" }}><Icon name="refresh" size={12} /></span>}
            {task.comments > 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}><Icon name="message" size={12} /> {task.comments}</span>}
            {!done && !task.dueDate && task.createdAt && (() => {
              const ageDays = Math.floor((Date.now() - new Date(task.createdAt).getTime()) / 86400000);
              if (ageDays < 14 || isNaN(ageDays)) return null;
              return <span title={`Open ${ageDays} days with no due date — review, schedule, or archive`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)", opacity: 0.8 }}><Icon name="clock" size={12} /> stale · {ageDays}d</span>;
            })()}
          </div>
        </div>

        {/* right meta — drop secondary columns on phones so the title has room */}
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 9 : 14, flexShrink: 0 }}>
          {smart && task.status !== "done" && <AiScore score={task.aiScore} reason={task.aiReason} />}
          {!isMobile && proj && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-3)" }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: proj.color }} />
              <span className="truncate" style={{ maxWidth: 110 }}>{proj.name}</span>
            </span>
          )}
          {!isMobile && (edit ? (
            <span style={{ display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
              <button ref={priorityRef} type="button" onClick={() => toggleMenu("priority")} aria-haspopup="menu" aria-expanded={menu === "priority"}
                aria-label={`Priority: ${prioLabel}. Change priority for ${q}`}
                style={{ ...triggerStyle, padding: 5, margin: -5 }}>
                <PriorityFlag priority={task.priority} size={14} />
              </button>
              {menu === "priority" && <Popover open anchorRef={priorityRef} onClose={closeMenu} align="end" label={`Priority for ${q}`}>
                {PRIORITIES_INLINE.map((p) => (
                  <button key={p} type="button" role="menuitemradio" aria-checked={task.priority === p} style={bulkItemStyle}
                    onClick={() => { setMenu(null); if (p !== task.priority) edit(task.id, { priority: p }); }}>
                    <PriorityFlag priority={p} size={13} /> {PRIORITY_META[p].label}{task.priority === p && <CurrentMark />}
                  </button>
                ))}
              </Popover>}
            </span>
          ) : <span role="img" aria-label={`Priority: ${prioLabel}`} style={{ display: "inline-flex" }}><PriorityFlag priority={task.priority} size={14} /></span>)}
          {edit ? (
            <label onClick={(e) => e.stopPropagation()} style={{ position: "relative", display: "inline-flex", alignItems: "center" }} title="Set due date">
              <span className="mono tnum" style={{ fontSize: 12, color: task.dueDate ? dueColor : "var(--ink-4)", minWidth: isMobile ? 0 : 56, textAlign: "right", fontWeight: ds === "overdue" || ds === "today" ? 600 : 400, cursor: "pointer",
                borderRadius: 4, outline: dateFocus ? "2px solid var(--accent)" : undefined, outlineOffset: 2 }}>
                {task.dueDate ? fmtDue(task.dueDate) : "—"}
              </span>
              <input type="date" value={task.dueDate || ""} onChange={(e) => edit(task.id, { dueDate: e.target.value || undefined })}
                aria-label={`Due date for ${q}`}
                // the native input is invisible, so mirror keyboard focus onto the visible date
                onFocus={(e) => { let kb = true; try { kb = e.currentTarget.matches(":focus-visible"); } catch { /* old engines */ } setDateFocus(kb); }}
                onBlur={() => setDateFocus(false)}
                style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: "pointer" }} />
            </label>
          ) : (task.dueDate && (
            <span className="mono tnum" style={{ fontSize: 12, color: dueColor, minWidth: isMobile ? 0 : 56, textAlign: "right", fontWeight: ds === "overdue" || ds === "today" ? 600 : 400 }}>{fmtDue(task.dueDate)}</span>
          ))}
          {edit && members.length > 0 ? (
            <span style={{ display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
              <button ref={assigneeRef} type="button" onClick={() => toggleMenu("assignee")} aria-haspopup="menu" aria-expanded={menu === "assignee"}
                aria-label={assignee ? `Assigned to ${assignee.name}. Change assignee for ${q}` : `Unassigned. Assign ${q}`}
                style={{ ...triggerStyle, padding: 0 }}>
                {assignee ? <Avatar id={task.assigneeId} size={24} /> : (
                  <span title="Unassigned" style={{ width: 24, height: 24, borderRadius: 99, boxSizing: "border-box", border: "1.5px dashed var(--hairline-strong)", display: "grid", placeItems: "center", color: "var(--ink-4)" }}>
                    <Icon name="user" size={12} />
                  </span>
                )}
              </button>
              {menu === "assignee" && <Popover open anchorRef={assigneeRef} onClose={closeMenu} align="end" minWidth={180} maxHeight={280} label={`Assignee for ${q}`}>
                {members.map((m) => (
                  <button key={m.id} type="button" role="menuitemradio" aria-checked={task.assigneeId === m.id} style={bulkItemStyle}
                    onClick={() => { setMenu(null); if (m.id !== task.assigneeId) edit(task.id, { assigneeId: m.id }); }}>
                    <Avatar id={m.id} size={18} /> <span className="truncate">{m.name}</span>{task.assigneeId === m.id && <CurrentMark />}
                  </button>
                ))}
              </Popover>}
            </span>
          ) : <Avatar id={task.assigneeId} size={24} />}
        </div>
      </div>

      {/* sub-tasks (full tasks) + any legacy checklist items */}
      {hasSubs && (<Collapse open={expanded}>
        <div style={{ background: "color-mix(in oklch, var(--bg-deep) 30%, transparent)" }}>
          {childTasks.map((c) => {
            const cdone = c.status === "done";
            const cds = dueState(c.dueDate, c.status);
            return (
              <div key={c.id} onClick={() => onOpen(c.id)} className="lift-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px 8px " + (52 + depth * 22) + "px", borderTop: "1px solid var(--hairline)", cursor: "pointer" }}>
                {readOnly ? <DoneMark done={cdone} size={16} /> : <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}><Check done={cdone} size={16} celebrateKey={c.id} onToggle={() => onToggle(c.id)} /></span>}
                <button type="button" className="truncate" onClick={(e) => { e.stopPropagation(); onOpen(c.id); }}
                  style={{ ...titleBtnStyle, flex: 1, fontSize: 13.5, color: cdone ? "var(--ink-4)" : "var(--ink-2)", textDecoration: cdone ? "line-through" : "none" }}>{c.title}</button>
                {c.priority !== "medium" && <PriorityFlag priority={c.priority} size={12} />}
                {c.dueDate && <span className="mono" style={{ fontSize: 11, color: cds === "overdue" ? "var(--prio-urgent)" : cds === "today" ? "var(--accent)" : "var(--ink-4)" }}>{fmtDue(c.dueDate)}</span>}
                <Avatar id={c.assigneeId} size={18} />
              </div>
            );
          })}
          {(task.subtasks ?? []).map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 18px 8px " + (52 + depth * 22) + "px", borderTop: "1px solid var(--hairline)" }}>
              {readOnly ? <DoneMark done={s.done} size={16} /> : <Check done={s.done} size={16} onToggle={() => onToggleSubtask(task.id, s.id)} />}
              <span style={{ fontSize: 13.5, color: s.done ? "var(--ink-4)" : "var(--ink-2)", textDecoration: s.done ? "line-through" : "none", flex: 1 }}>{s.title}</span>
            </div>
          ))}
        </div>
      </Collapse>)}
    </div>
  );
});

function GroupHeader({ label, color, count, icon, onRename, onDelete, selectState, showSelect = false, onSelectAll, dropActive = false, onDragOver, onDrop }: {
  label: string; color: string; count: number; icon?: IconName; onRename?: () => void; onDelete?: () => void;
  /** select-all checkbox for the group (bulk selection) */
  selectState?: "all" | "some" | "none"; showSelect?: boolean; onSelectAll?: () => void;
  /** drop target for dragging a task into this group (works for empty sections too) */
  dropActive?: boolean; onDragOver?: (e: React.DragEvent) => void; onDrop?: (e: React.DragEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  return (
    <div className="kgrouphdr" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onDragOver={onDragOver} onDrop={onDrop}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px 9px", position: "sticky", top: 0, zIndex: 2,
        background: dropActive ? "color-mix(in oklch, var(--accent) 9%, var(--bg))" : "color-mix(in oklch, var(--bg) 86%, transparent)", backdropFilter: "blur(8px)",
        boxShadow: dropActive ? "inset 0 -3px 0 -1px var(--accent)" : undefined, transition: "background .14s" }}>
      {onSelectAll && selectState && (
        <button type="button" role="checkbox" aria-checked={selectState === "all" ? true : selectState === "some" ? "mixed" : false}
          aria-label={`Select all tasks in ${label}`} onClick={onSelectAll} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{ ...selectBoxStyle(selectState !== "none"), opacity: showSelect || hover || focus || selectState !== "none" ? 1 : 0 }}>
          {selectState === "all" && <Icon name="check" size={12} sw={3} style={{ color: "var(--on-accent)" }} />}
          {selectState === "some" && <span style={{ width: 8, height: 2, borderRadius: 2, background: "var(--on-accent)" }} />}
        </button>
      )}
      {icon ? <Icon name={icon} size={14} style={{ color }} /> : <span style={{ width: 9, height: 9, borderRadius: 99, background: color, boxShadow: `0 0 8px color-mix(in oklch, ${color} 70%, transparent)` }} />}
      <span role="heading" aria-level={2} style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em", cursor: onRename ? "text" : "default" }} onDoubleClick={onRename}>{label}<span className="sr-only">, {count} task{count === 1 ? "" : "s"}</span></span>
      <span className="mono tnum" aria-hidden="true" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{count}</span>
      {onRename && <button type="button" onClick={onRename} title="Rename section" aria-label={`Rename section “${label}”`} style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", padding: 2, display: "inline-flex" }}><Icon name="settings" size={13} /></button>}
      {onDelete && <button type="button" onClick={onDelete} title="Delete section" aria-label={`Delete section “${label}”`} style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", padding: 2, fontSize: 15, lineHeight: 1 }}>×</button>}
    </div>
  );
}

interface Group { key: string; label: string; color: string; icon?: IconName; items: Task[]; }

export function ListView({ tasks, allTasks, projects = NO_PROJECTS, compact = false, onOpen, onToggle, onToggleSubtask, groupBy, smart, sort, onBulkPatch, onBulkDelete, onPatch, onQuickAdd, onOpenImport, members = NO_MEMBERS, sections = NO_SECTIONS, onCreateSection, onRenameSection, onDeleteSection, customFields = NO_FIELDS, sectionField = "sectionId", sectionProjectId, filtered = false, onClearFilters, readOnly = false }: {
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
}) {
  const entrance = useEntrance();
  const isMobile = useMediaQuery("(max-width: 860px)");
  // read-only strips every write path at the source
  const patch = readOnly ? undefined : onPatch;
  const quickAddFn = readOnly ? undefined : onQuickAdd;
  const bulkEnabled = !readOnly && !!onBulkPatch;
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState("");
  const [live, setLive] = useState(""); // screen-reader announcements (keyboard moves, range selection)
  // cheap windowing: very large groups render a capped slice with a "show all"
  const ROW_CAP = 100;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const quickAdd = (groupKey: string) => {
    const v = addDraft.trim(); if (!v) { setAddingKey(null); return; }
    const partial: Partial<Task> & { title: string } = { title: v };
    if (groupBy === "status") partial.status = groupKey as Task["status"];
    else if (groupBy === "priority") partial.priority = groupKey as Priority;
    else if (groupBy === "project") partial.projectId = groupKey;
    else if (groupBy === "section") { const v = groupKey === "__none" ? undefined : groupKey; if (sectionField === "mySectionId") partial.mySectionId = v; else partial.sectionId = v; }
    else if (groupBy === "due") { const d = dueDateForBucket(groupKey); if (d) partial.dueDate = d; }
    quickAddFn?.(partial);
    setAddDraft("");
  };
  // sensible group key for the empty-state quick-add (project view falls back to the route's project)
  const emptyKey = groupBy === "status" ? "todo" : groupBy === "priority" ? "medium" : groupBy === "section" ? "__none" : "";
  const sortMode = sort || "manual";
  // manual reorder only in manual order; not under Due grouping (dragging
  // across due buckets has no well-defined date, so it would just snap back)
  const dragEnabled = !!patch && !smart && sortMode === "manual" && groupBy !== "due";
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

  // ---- grouping ----
  const groups: Group[] = useMemo(() => {
    const sortFn = (a: Task, b: Task) => {
      if (a.status === "done" && b.status !== "done") return 1;
      if (b.status === "done" && a.status !== "done") return -1;
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
    const topLevel = tasks.filter((t) => !t.parentId || !presentIds.has(t.parentId));

    if (groupBy === "status") {
      return STATUS_ORDER.map((s) => ({ key: s, label: STATUS_META[s].label, color: STATUS_META[s].color, items: topLevel.filter((t) => t.status === s).sort(sortFn) })).filter((g) => g.items.length);
    }
    if (groupBy === "priority") {
      return (["urgent", "high", "medium", "low"] as const).map((p) => ({ key: p, label: PRIORITY_META[p].label + " priority", color: PRIORITY_META[p].color, icon: "flag" as IconName, items: topLevel.filter((t) => t.priority === p).sort(sortFn) })).filter((g) => g.items.length);
    }
    if (groupBy === "project") {
      // group by the projects actually present in these tasks (real accounts, not just the demo seed)
      return [...new Set(topLevel.map((t) => t.projectId))]
        .map((pid) => ({ pid, p: getProject(pid) }))
        .filter((x) => !!x.p)
        .map(({ pid, p }) => ({ key: pid, label: p!.name, color: p!.color, items: topLevel.filter((t) => t.projectId === pid).sort(sortFn) }))
        .filter((g) => g.items.length);
    }
    if (groupBy === "section") {
      // named sections (kept even when empty, so you can add into them) + a "No section" bucket
      const ordered = [...sections].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const gs: Group[] = ordered.map((s) => ({ key: s.id, label: s.name, color: "var(--accent)", icon: "layers" as IconName, items: topLevel.filter((t) => t[sectionField] === s.id).sort(sortFn) }));
      const none = topLevel.filter((t) => !t[sectionField] || !ordered.some((s) => s.id === t[sectionField])).sort(sortFn);
      if (none.length || ordered.length === 0) gs.push({ key: "__none", label: "No section", color: "var(--ink-4)", icon: "layers" as IconName, items: none });
      return gs;
    }
    if (groupBy === "due") {
      // the "My Tasks" planner: bucket by when work is due
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
      const BUCKETS: { key: string; label: string; color: string }[] = [
        { key: "overdue", label: "Overdue", color: "var(--prio-urgent)" },
        { key: "today", label: "Today", color: "var(--accent)" },
        { key: "week", label: "This week", color: "var(--st-progress)" },
        { key: "later", label: "Later", color: "var(--ink-4)" },
        { key: "nodate", label: "No date", color: "var(--ink-4)" },
        { key: "completed", label: "Completed", color: "var(--st-done)" },
      ];
      return BUCKETS.map((b) => ({ key: b.key, label: b.label, color: b.color, items: topLevel.filter((t) => dueBucket(t) === b.key).sort(sortFn) })).filter((g) => g.items.length);
    }
    return [{ key: "all", label: smart ? "Smart order" : "All tasks", color: "var(--accent)", icon: (smart ? "sparkles" : "list") as IconName, items: [...topLevel].sort(sortFn) }];
  }, [tasks, presentIds, groupBy, smart, sortMode, sections, sectionField]);

  // rows in on-screen order (respecting the per-group cap) — for shift-click ranges
  const visibleOrder = useMemo(() => groups.flatMap((g) => (expandedGroups.has(g.key) ? g.items : g.items.slice(0, ROW_CAP)).map((t) => t.id)), [groups, expandedGroups]);

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
  // drop a dragged task next to a target row (or at the top of a group): change its group field if needed, and reposition
  const dropInto = (draggedId: string, g: Group, targetId: string | null, half: "top" | "bottom") => {
    setDragId(null); setHover(null);
    if (draggedId === targetId) return;
    const dragged = tasks.find((t) => t.id === draggedId);
    if (!dragged) return;
    const p = groupPatch(dragged, g.key);
    const willBeDone = (p.status ?? dragged.status) === "done";
    markJustLanded(draggedId);
    patch?.(draggedId, { ...p, position: dropPosition(g.items, draggedId, targetId, half, willBeDone) });
    if (p.projectId) moveFamily(draggedId, p.projectId);
  };
  const onRowDrop = useStableCallback((draggedId: string, targetId: string, half: "top" | "bottom") => {
    const g = groups.find((x) => x.items.some((t) => t.id === targetId));
    if (!g) { setDragId(null); setHover(null); return; }
    dropInto(draggedId, g, targetId, half);
  });
  const onPickup = useStableCallback((id: string) => { setDragId(id || null); if (!id) setHover(null); });
  // dragover fires ~60×/s — only re-render when the hovered row or half actually changes
  const onHoverRow = useStableCallback((id: string, half: "top" | "bottom") => setHover((h) => h && h.id === id && h.half === half ? h : { id, half }));
  const groupDropProps = (g: Group) => dragEnabled ? {
    onDragOver: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); onHoverRow("hdr:" + g.key, "bottom"); },
    onDrop: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); dropInto(e.dataTransfer.getData("text/kanbo-task"), g, null, "top"); },
  } : {};

  // keyboard reorder: Alt+↑/↓ on a row title moves it one place within its group
  const pendingFocus = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onMoveBy = useStableCallback((id: string, dir: -1 | 1) => {
    const g = groups.find((x) => x.items.some((t) => t.id === id));
    if (!g) return;
    const i = g.items.findIndex((t) => t.id === id);
    const me = g.items[i], other = g.items[i + dir];
    // done rows always sit at the bottom, so an open task can't hop past them (and vice versa)
    if (!other || (me.status === "done") !== (other.status === "done")) { setLive(`“${me.title}” can't move any further ${dir < 0 ? "up" : "down"}`); return; }
    markJustLanded(id);
    pendingFocus.current = id;
    patch?.(id, { position: dropPosition(g.items, id, other.id, dir < 0 ? "top" : "bottom", me.status === "done") });
    setLive(`Moved “${me.title}” ${dir < 0 ? "above" : "below"} “${other.title}”`);
  });
  // a moved row can be re-inserted in the DOM, which drops focus — put it back on its title
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    const el = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-row-title]") ?? []).find((n) => n.dataset.rowTitle === id);
    if (el && document.activeElement !== el) el.focus();
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
  // Escape clears a selection (an open bulk menu swallows the first Escape itself) — but only
  // when focus is in the list, so closing a task panel with Escape keeps the selection
  useEffect(() => {
    if (!selectionActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as Node | null;
      if (!t || t === document.body || rootRef.current?.contains(t)) clearSel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionActive]);

  // Only offer to take focus for a scope that was genuinely empty when opened —
  // never because a search/filter emptied the list (that stole the user's typing).
  const [scope, setScope] = useState(() => ({ key: sectionProjectId, empty: tasks.length === 0 }));
  if (scope.key !== sectionProjectId) setScope({ key: sectionProjectId, empty: tasks.length === 0 });
  const showNoMatch = tasks.length === 0 && filtered;
  const showOnboarding = tasks.length === 0 && !filtered && !(groupBy === "section" && sections.length > 0);
  const emptyInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!showOnboarding || !scope.empty || filtered) return;
    const el = emptyInputRef.current, ae = document.activeElement;
    if (!el || (ae && ae !== document.body && ae !== el)) return; // someone is already typing somewhere
    el.focus({ preventScroll: true });
  }, [showOnboarding, scope.empty, filtered]);

  const bulkBtnStyle: React.CSSProperties = { padding: isMobile ? "7px 9px" : "7px 11px", fontSize: 13 };
  const divider = !isMobile && <span aria-hidden="true" style={{ width: 1, height: 22, background: "var(--hairline)" }} />;

  return (
    <div ref={rootRef} style={{ overflowY: "auto", flex: 1, "--kanbo-rowpad": compact ? "5px" : "10px" } as React.CSSProperties}>
      <div className="sr-only" role="status" aria-live="polite">{live}</div>
      {smart && (
        <div className="anim-scalein" style={{ margin: "16px 18px 0", display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", borderRadius: 12, background: "var(--accent-dim)", border: "1px solid color-mix(in oklch, var(--accent) 28%, transparent)" }}>
          <Icon name="sparkles" size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Sorted by Kanbo's recommended focus order — urgent, unblocking work first.</span>
        </div>
      )}
      {showNoMatch ? (
        <div role="status" style={{ textAlign: "center", padding: "64px 24px", color: "var(--ink-4)" }}>
          <div style={{ marginBottom: 14 }}><EmptyArt kind="search" /></div>
          <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>No tasks match these filters</p>
          <p style={{ fontSize: 13, margin: "5px 0 18px" }}>Try a different search, or clear the filters to see every task.</p>
          {onClearFilters && <button type="button" className="btn btn-ghost" onClick={onClearFilters}><Icon name="x" size={15} /> Clear filters</button>}
        </div>
      ) : showOnboarding ? (
        <div style={{ textAlign: "center", padding: "64px 24px", color: "var(--ink-4)" }}>
          <div style={{ marginBottom: 14 }}><EmptyArt kind="tasks" /></div>
          <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>No tasks yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 18px" }}>{quickAddFn ? "Type your first task below, or import a whole list." : "Tasks added here will show up in this list."}</p>
          {quickAddFn && (
            <div style={{ display: "flex", gap: 8, maxWidth: 460, margin: "0 auto", alignItems: "center", flexWrap: isMobile ? "wrap" : undefined, justifyContent: "center" }}>
              <input ref={emptyInputRef} value={addDraft} onChange={(e) => setAddDraft(e.target.value)} aria-label="New task name"
                onKeyDown={(e) => { if (e.key === "Enter") quickAdd(emptyKey); else if (e.key === "Escape") setAddDraft(""); }}
                placeholder="Task name, then Enter…"
                style={{ flex: 1, minWidth: 0, height: 38, padding: "0 13px", borderRadius: 10, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14, outline: "none" }} />
              <button type="button" className="btn btn-accent" onClick={() => quickAdd(emptyKey)} disabled={!addDraft.trim()} style={{ opacity: addDraft.trim() ? 1 : 0.5 }}>Add</button>
              {onOpenImport && <button type="button" className="btn btn-ghost" onClick={onOpenImport} title="Import a list of tasks"><Icon name="plus" size={15} /> Import</button>}
            </div>
          )}
        </div>
      ) : groups.map((g) => {
        const shown = expandedGroups.has(g.key) ? g.items : g.items.slice(0, ROW_CAP);
        const nSel = selectionActive ? g.items.reduce((n, t) => n + (selected.has(t.id) ? 1 : 0), 0) : 0;
        const canAddHere = !!quickAddFn && !(groupBy === "due" && g.key === "completed"); // "Completed" isn't somewhere you add to-dos
        const dropProps = groupDropProps(g);
        const headerHot = !!dragId && hover?.id === "hdr:" + g.key;
        return (
          <div key={g.key}>
            <GroupHeader label={g.label} color={g.color} count={g.items.length} icon={g.icon}
              onRename={!readOnly && groupBy === "section" && g.key !== "__none" && onRenameSection ? () => { const n = window.prompt("Rename section", g.label); if (n?.trim()) onRenameSection(g.key, n.trim()); } : undefined}
              onDelete={!readOnly && groupBy === "section" && g.key !== "__none" && onDeleteSection ? () => { if (window.confirm(`Delete section "${g.label}"? Its tasks move to No section.`)) onDeleteSection(g.key); } : undefined}
              selectState={bulkEnabled && g.items.length > 0 ? (nSel === 0 ? "none" : nSel === g.items.length ? "all" : "some") : undefined}
              showSelect={selectionActive} onSelectAll={bulkEnabled ? () => toggleGroupSelection(g) : undefined}
              dropActive={headerHot} {...dropProps} />
            <div className={entrance}>{shown.map((t) => (
              <TaskRow key={t.id} task={t} childTasks={childrenOf.get(t.id) ?? NO_TASKS} childDone={doneKids.get(t.id) ?? 0} byId={byId}
                onOpen={onOpen} onToggle={onToggle} onToggleSubtask={onToggleSubtask} smart={smart} isMobile={isMobile} readOnly={readOnly}
                selected={selected.has(t.id)} selectionActive={selectionActive} onSelect={bulkEnabled ? onSelectRow : undefined}
                draggable={dragEnabled} dragging={dragId === t.id} dropHint={hover && hover.id === t.id && dragId !== t.id ? hover.half : null}
                onPickup={onPickup} onHover={onHoverRow} onRowDrop={onRowDrop} onMoveBy={dragEnabled ? onMoveBy : undefined}
                onPatch={patch} members={members} customFields={customFields} />
            ))}</div>
            {!expandedGroups.has(g.key) && g.items.length > ROW_CAP && (
              <button type="button" onClick={() => setExpandedGroups((s) => new Set(s).add(g.key))} className="lift-row" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, width: "100%", padding: "9px 18px", border: "none", borderBottom: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13 }}>
                <Icon name="chevronDown" size={14} /> Show all {g.items.length}
              </button>
            )}
            {canAddHere && (addingKey === g.key ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px 8px 30px", borderBottom: "1px solid var(--hairline)" }}>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input autoFocus value={addDraft} onChange={(e) => setAddDraft(e.target.value)} aria-label={`New task in ${g.label}`}
                  onKeyDown={(e) => { if (e.key === "Enter") quickAdd(g.key); else if (e.key === "Escape") { setAddDraft(""); setAddingKey(null); } }}
                  onBlur={() => { quickAdd(g.key); setAddingKey(null); }} placeholder="Task name, then Enter…"
                  style={{ flex: 1, height: 32, padding: "0 11px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14, outline: "none" }} />
              </div>
            ) : (
              <button type="button" onClick={() => { setAddDraft(""); setAddingKey(g.key); }} className="lift-row" aria-label={`Add task to ${g.label}`} {...dropProps}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 18px 9px 30px", border: "none", borderBottom: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13 }}>
                <Icon name="plus" size={14} /> Add task
              </button>
            ))}
          </div>
        );
      })}
      {!readOnly && !showNoMatch && groupBy === "section" && onCreateSection && (sectionProjectId || sections[0]?.projectId || tasks[0]?.projectId) && (
        <button type="button" onClick={() => { const n = window.prompt("New section name"); if (n?.trim()) onCreateSection(sectionProjectId ?? sections[0]?.projectId ?? tasks[0]!.projectId, n.trim()); }}
          style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 18px", padding: "9px 13px", border: "1px dashed var(--hairline-strong)", borderRadius: 10, background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13 }}>
          <Icon name="plus" size={15} /> Add section
        </button>
      )}
      <div style={{ height: selectionActive ? (isMobile ? 150 : 90) : 40 }} />

      {selectionActive && (
        // centred with left/right insets (not translateX) so it can wrap within the screen on phones,
        // and on phones it sits above the bottom tab bar
        <div role="toolbar" aria-label="Bulk actions for selected tasks" className="glass anim-fadeup" style={{ position: "fixed", bottom: isMobile ? "calc(env(safe-area-inset-bottom, 0px) + 74px)" : 22, left: 12, right: 12, marginInline: "auto", width: "fit-content", maxWidth: "calc(100vw - 24px)", boxSizing: "border-box", zIndex: 60,
          display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: isMobile ? 2 : 6, padding: "8px 10px", borderRadius: 14, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
          <span className="mono" aria-live="polite" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", padding: "0 8px", whiteSpace: "nowrap" }}>{ids.length} selected</span>
          {divider}
          <button type="button" className="btn btn-ghost" onClick={() => applyPatch({ status: "done", completedAt: toLocalISO(new Date()) })} aria-label={isMobile ? "Mark selected as done" : undefined} title={isMobile ? "Mark as done" : undefined} style={bulkBtnStyle}><Icon name="check" size={15} />{!isMobile && " Done"}</button>
          <BulkMenuButton label="Status" icon="layers" iconOnly={isMobile} open={bulkMenu === "status"} onToggle={() => setBulkMenu((m) => m === "status" ? null : "status")}>
            {STATUS_ORDER.map((s) => (
              <button key={s} type="button" role="menuitem" onClick={() => applyPatch({ status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined })} style={bulkItemStyle}>
                <StatusDot status={s} size={7} /> {STATUS_META[s].label}
              </button>
            ))}
          </BulkMenuButton>
          <BulkMenuButton label="Priority" icon="flag" iconOnly={isMobile} open={bulkMenu === "priority"} onToggle={() => setBulkMenu((m) => m === "priority" ? null : "priority")}>
            {PRIORITIES.map((p) => (
              <button key={p} type="button" role="menuitem" onClick={() => applyPatch({ priority: p })} style={bulkItemStyle}>
                <PriorityFlag priority={p} size={13} /> {PRIORITY_META[p].label}
              </button>
            ))}
          </BulkMenuButton>
          <BulkMenuButton label="Due" icon="calendar" iconOnly={isMobile} open={bulkMenu === "due"} onToggle={() => setBulkMenu((m) => m === "due" ? null : "due")}>
            <button type="button" role="menuitem" onClick={() => applyPatch({ dueDate: isoDay(0) })} style={bulkItemStyle}><Icon name="calendar" size={13} /> Today</button>
            <button type="button" role="menuitem" onClick={() => applyPatch({ dueDate: isoDay(1) })} style={bulkItemStyle}><Icon name="calendar" size={13} /> Tomorrow</button>
            <button type="button" role="menuitem" onClick={() => applyPatch({ dueDate: isoDay(7) })} style={bulkItemStyle}><Icon name="calendar" size={13} /> Next week</button>
            <button type="button" role="menuitem" onClick={() => applyPatch({ dueDate: undefined })} style={bulkItemStyle}><Icon name="x" size={13} /> Clear due date</button>
          </BulkMenuButton>
          {members.length > 0 && (
            <BulkMenuButton label="Assign" icon="user" iconOnly={isMobile} open={bulkMenu === "assignee"} onToggle={() => setBulkMenu((m) => m === "assignee" ? null : "assignee")}>
              {members.map((m) => (
                <button key={m.id} type="button" role="menuitem" onClick={() => applyPatch({ assigneeId: m.id })} style={bulkItemStyle}>
                  <Avatar id={m.id} size={18} /> <span className="truncate">{m.name}</span>
                </button>
              ))}
            </BulkMenuButton>
          )}
          {projects.length > 0 && (
            <BulkMenuButton label="Project" icon="grid" iconOnly={isMobile} open={bulkMenu === "project"} onToggle={() => setBulkMenu((m) => m === "project" ? null : "project")}>
              {projects.map((p) => (
                <button key={p.id} type="button" role="menuitem" onClick={() => applyPatch({ projectId: p.id })} style={bulkItemStyle}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, flexShrink: 0 }} /> <span className="truncate">{p.name}</span>
                </button>
              ))}
            </BulkMenuButton>
          )}
          {onBulkDelete && <button type="button" className="btn btn-ghost" onClick={() => { onBulkDelete(ids); clearSel(); }} aria-label={isMobile ? "Delete selected tasks" : undefined} title={isMobile ? "Delete" : undefined} style={{ ...bulkBtnStyle, color: "var(--prio-urgent)" }}><Icon name="trash" size={15} />{!isMobile && " Delete"}</button>}
          {divider}
          <button type="button" className="btn-icon" onClick={clearSel} aria-label="Clear selection" title="Clear selection (Esc)" style={{ border: "none", width: 30, height: 30 }}><Icon name="x" size={16} /></button>
        </div>
      )}
    </div>
  );
}

// fractional index between two neighbours (matches the board's reorder math)
function between(before?: Task, after?: Task): number {
  const bp = before?.position, ap = after?.position;
  if (bp == null && ap == null) return Date.now();
  if (bp == null) return (ap as number) - 1;
  if (ap == null) return (bp as number) + 1;
  return (bp + ap) / 2;
}

export const bulkItemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "8px 9px", borderRadius: 8, border: "none",
  background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13, textAlign: "left", color: "var(--ink-2)",
};

/** A bulk-bar button with an upward menu. The menu renders through Popover
 *  (portal), so a wrapping or frosted bar can't clip it. `iconOnly` suits phones. */
export function BulkMenuButton({ label, icon, open, onToggle, children, iconOnly = false }: { label: string; icon: IconName; open: boolean; onToggle: () => void; children: React.ReactNode; iconOnly?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div style={{ position: "relative" }}>
      <button ref={ref} type="button" className="btn btn-ghost" onClick={onToggle} aria-haspopup="menu" aria-expanded={open}
        aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined}
        style={{ padding: iconOnly ? "7px 9px" : "7px 11px", fontSize: 13 }}><Icon name={icon} size={15} />{!iconOnly && " " + label}</button>
      <Popover open={open} anchorRef={ref} onClose={onToggle} side="top" label={label} minWidth={168} maxHeight={320} className="glass"
        style={{ borderRadius: 12, background: "var(--surface-raised)", border: undefined }}>
        {children}
      </Popover>
    </div>
  );
}
