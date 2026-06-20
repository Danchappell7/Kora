/* ============================================================
   KANBO — List view (the showpiece) + TaskRow
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar, Check, StatusDot, Tag, PriorityFlag, AiScore } from "../primitives";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  getProject, blockingTasks, dueState, fmtDue, toLocalISO, KANBO_TODAY,
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

export function SubtaskProgress({ subtasks }: { subtasks?: Subtask[] }) {
  if (!subtasks?.length) return null;
  const done = subtasks.filter((s) => s.done).length;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>
      <Icon name="layers" size={12} /> {done}/{subtasks.length}
    </span>
  );
}

function TaskRow({ task, allTasks, onOpen, onToggle, onToggleSubtask, smart, depth = 0, selected = false, selectionActive = false, onSelect, draggable = false, dragging = false, dropHint = null, onPickup, onHover, onRowDrop, onPatch, members, customFields = [] }: {
  task: Task; allTasks: Task[]; onOpen: (id: string) => void; onToggle: (id: string) => void; onToggleSubtask: (taskId: string, subId: string) => void; smart: boolean; depth?: number;
  selected?: boolean; selectionActive?: boolean; onSelect?: (id: string, additive: boolean) => void;
  draggable?: boolean; dragging?: boolean; dropHint?: "top" | "bottom" | null;
  onPickup?: (id: string) => void; onHover?: (id: string, half: "top" | "bottom") => void; onRowDrop?: (draggedId: string, targetId: string, half: "top" | "bottom") => void;
  onPatch?: (id: string, patch: Partial<Task>) => void; members?: { id: string; name: string }[]; customFields?: CustomFieldDef[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [menu, setMenu] = useState<null | "priority" | "assignee">(null);
  const isMobile = useMediaQuery("(max-width: 860px)");
  const PRIORITIES_INLINE: Priority[] = ["urgent", "high", "medium", "low"];
  const saveTitle = () => { const v = titleDraft.trim(); setEditingTitle(false); if (v && v !== task.title) onPatch?.(task.id, { title: v }); else setTitleDraft(task.title); };
  const proj = getProject(task.projectId);
  const blocked = blockingTasks(task, allTasks);
  const done = task.status === "done";
  const ds = dueState(task.dueDate, task.status);
  const dueColor = ds === "overdue" ? "var(--prio-urgent)" : ds === "today" ? "var(--accent)" : "var(--ink-3)";
  // sub-tasks are full tasks with parentId; legacy checklist items live on task.subtasks
  const childTasks = allTasks.filter((c) => c.parentId === task.id);
  const subDone = childTasks.filter((c) => c.status === "done").length + (task.subtasks ?? []).filter((s) => s.done).length;
  const subTotal = childTasks.length + (task.subtasks?.length ?? 0);
  const hasSubs = subTotal > 0;

  return (
    <div className="krow-cv" style={{ borderBottom: "1px solid var(--hairline)" }}>
      <div onClick={() => onOpen(task.id)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} className="task-row lift-row"
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
          <button onClick={(e) => { e.stopPropagation(); onSelect(task.id, e.shiftKey || e.metaKey); }} aria-label={selected ? "Deselect task" : "Select task"}
            style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, padding: 0, cursor: "pointer", display: "grid", placeItems: "center",
              border: `1.6px solid ${selected ? "var(--accent)" : "var(--hairline-strong)"}`, background: selected ? "var(--accent)" : "transparent",
              opacity: selected || selectionActive || hovered ? 1 : 0, transition: "opacity .12s" }}>
            {selected && <Icon name="check" size={12} sw={3} style={{ color: "var(--on-accent)" }} />}
          </button>
        )}

        <Check done={done} onToggle={() => onToggle(task.id)} />

        {hasSubs ? (
          <button onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }} className="btn-icon" style={{ width: 20, height: 20, border: "none", background: "transparent", color: "var(--ink-4)" }}>
            <Icon name="chevronRight" size={14} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .18s" }} />
          </button>
        ) : <StatusDot status={task.status} />}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            {task.isMilestone && <span title="Milestone" style={{ width: 9, height: 9, transform: "rotate(45deg)", background: "var(--st-review)", borderRadius: 2, flexShrink: 0 }} />}
            {editingTitle ? (
              // eslint-disable-next-line jsx-a11y/no-autofocus
              <input autoFocus value={titleDraft} onClick={(e) => e.stopPropagation()} onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") saveTitle(); else if (e.key === "Escape") { setTitleDraft(task.title); setEditingTitle(false); } }}
                onBlur={saveTitle}
                style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 450, fontFamily: "var(--font-display)", color: "var(--ink)", background: "var(--surface)", border: "1px solid var(--accent)", borderRadius: 7, padding: "3px 7px", outline: "none" }} />
            ) : (
              <span className="truncate" title={onPatch ? "Double-click to rename" : undefined}
                onDoubleClick={onPatch ? (e) => { e.stopPropagation(); setTitleDraft(task.title); setEditingTitle(true); } : undefined}
                style={{ fontSize: 14.5, fontWeight: 450, color: done ? "var(--ink-4)" : "var(--ink)", textDecoration: done ? "line-through" : "none" }}>{task.title}</span>
            )}
            {blocked.length > 0 && (
              <span data-tip={"Blocked by " + blocked.map((b) => b.title).join(", ")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--st-blocked)", flexShrink: 0, position: "relative" }}>
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
          {!isMobile && (onPatch ? (
            <div style={{ position: "relative", display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setMenu((m) => m === "priority" ? null : "priority")} aria-label="Set priority" style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "inline-flex" }}>
                <PriorityFlag priority={task.priority} size={14} />
              </button>
              {menu === "priority" && (
                <>
                  <div onClick={() => setMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                  <div className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 41, minWidth: 150, padding: 5, borderRadius: 11, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
                    {PRIORITIES_INLINE.map((p) => (
                      <button key={p} onClick={() => { setMenu(null); onPatch?.(task.id, { priority: p }); }} style={bulkItemStyle}>
                        <PriorityFlag priority={p} size={13} /> {PRIORITY_META[p].label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : <PriorityFlag priority={task.priority} size={14} />)}
          {onPatch ? (
            <label onClick={(e) => e.stopPropagation()} style={{ position: "relative", display: "inline-flex", alignItems: "center" }} title="Set due date">
              <span className="mono tnum" style={{ fontSize: 12, color: task.dueDate ? dueColor : "var(--ink-4)", minWidth: isMobile ? 0 : 56, textAlign: "right", fontWeight: ds === "overdue" || ds === "today" ? 600 : 400, cursor: "pointer" }}>
                {task.dueDate ? fmtDue(task.dueDate) : "—"}
              </span>
              <input type="date" value={task.dueDate || ""} onChange={(e) => onPatch?.(task.id, { dueDate: e.target.value || undefined })} aria-label="Due date" style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: "pointer" }} />
            </label>
          ) : (task.dueDate && (
            <span className="mono tnum" style={{ fontSize: 12, color: dueColor, minWidth: isMobile ? 0 : 56, textAlign: "right", fontWeight: ds === "overdue" || ds === "today" ? 600 : 400 }}>{fmtDue(task.dueDate)}</span>
          ))}
          {onPatch && members && members.length > 0 ? (
            <div style={{ position: "relative", display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setMenu((m) => m === "assignee" ? null : "assignee")} aria-label="Assign" style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "inline-flex" }}>
                <Avatar id={task.assigneeId} size={24} />
              </button>
              {menu === "assignee" && (
                <>
                  <div onClick={() => setMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                  <div className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 41, minWidth: 170, maxHeight: 240, overflowY: "auto", padding: 5, borderRadius: 11, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
                    {members.map((m) => (
                      <button key={m.id} onClick={() => { setMenu(null); onPatch?.(task.id, { assigneeId: m.id }); }} style={bulkItemStyle}>
                        <Avatar id={m.id} size={18} /> {m.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : <Avatar id={task.assigneeId} size={24} />}
        </div>
      </div>

      {/* sub-tasks (full tasks) + any legacy checklist items */}
      {expanded && hasSubs && (
        <div className="anim-fadein" style={{ background: "color-mix(in oklch, var(--bg-deep) 30%, transparent)" }}>
          {childTasks.map((c) => {
            const cdone = c.status === "done";
            const cds = dueState(c.dueDate, c.status);
            return (
              <div key={c.id} onClick={() => onOpen(c.id)} className="lift-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px 8px " + (52 + depth * 22) + "px", borderTop: "1px solid var(--hairline)", cursor: "pointer" }}>
                <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}><Check done={cdone} size={16} onToggle={() => onToggle(c.id)} /></span>
                <span className="truncate" style={{ flex: 1, fontSize: 13.5, color: cdone ? "var(--ink-4)" : "var(--ink-2)", textDecoration: cdone ? "line-through" : "none" }}>{c.title}</span>
                {c.priority !== "medium" && <PriorityFlag priority={c.priority} size={12} />}
                {c.dueDate && <span className="mono" style={{ fontSize: 11, color: cds === "overdue" ? "var(--prio-urgent)" : cds === "today" ? "var(--accent)" : "var(--ink-4)" }}>{fmtDue(c.dueDate)}</span>}
                <Avatar id={c.assigneeId} size={18} />
              </div>
            );
          })}
          {(task.subtasks ?? []).map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 18px 8px " + (52 + depth * 22) + "px", borderTop: "1px solid var(--hairline)" }}>
              <Check done={s.done} size={16} onToggle={() => onToggleSubtask(task.id, s.id)} />
              <span style={{ fontSize: 13.5, color: s.done ? "var(--ink-4)" : "var(--ink-2)", textDecoration: s.done ? "line-through" : "none", flex: 1 }}>{s.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupHeader({ label, color, count, icon, onRename, onDelete }: { label: string; color: string; count: number; icon?: IconName; onRename?: () => void; onDelete?: () => void }) {
  return (
    <div className="kgrouphdr" style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px 9px", position: "sticky", top: 0, zIndex: 2, background: "color-mix(in oklch, var(--bg) 86%, transparent)", backdropFilter: "blur(8px)" }}>
      {icon ? <Icon name={icon} size={14} style={{ color }} /> : <span style={{ width: 9, height: 9, borderRadius: 99, background: color, boxShadow: `0 0 8px color-mix(in oklch, ${color} 70%, transparent)` }} />}
      <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em", cursor: onRename ? "text" : "default" }} onDoubleClick={onRename}>{label}</span>
      <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{count}</span>
      {onRename && <button onClick={onRename} title="Rename section" aria-label="Rename section" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", padding: 2, display: "inline-flex" }}><Icon name="settings" size={13} /></button>}
      {onDelete && <button onClick={onDelete} title="Delete section" aria-label="Delete section" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", padding: 2, fontSize: 15, lineHeight: 1 }}>×</button>}
    </div>
  );
}

interface Group { key: string; label: string; color: string; icon?: IconName; items: Task[]; }

export function ListView({ tasks, allTasks, projects = [], compact = false, onOpen, onToggle, onToggleSubtask, groupBy, smart, sort, onBulkPatch, onBulkDelete, onPatch, onQuickAdd, members = [], sections = [], onCreateSection, onRenameSection, onDeleteSection, customFields = [], sectionField = "sectionId", sectionProjectId }: {
  tasks: Task[]; allTasks: Task[]; projects?: Project[]; compact?: boolean; onOpen: (id: string) => void; onToggle: (id: string) => void; onToggleSubtask: (taskId: string, subId: string) => void; groupBy: GroupBy; smart: boolean;
  onBulkPatch?: (ids: string[], patch: Partial<Task>) => void;
  onBulkDelete?: (ids: string[]) => void;
  onPatch?: (id: string, patch: Partial<Task>) => void;
  onQuickAdd?: (partial: Partial<Task> & { title: string }) => void;
  sort?: string;
  members?: { id: string; name: string }[];
  sections?: Section[];
  onCreateSection?: (projectId: string, name: string) => void;
  onRenameSection?: (id: string, name: string) => void;
  onDeleteSection?: (id: string) => void;
  customFields?: CustomFieldDef[];
  sectionField?: "sectionId" | "mySectionId";
  sectionProjectId?: string;
}) {
  const bulkEnabled = !!onBulkPatch;
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState("");
  const quickAdd = (groupKey: string) => {
    const v = addDraft.trim(); if (!v) { setAddingKey(null); return; }
    const partial: Partial<Task> & { title: string } = { title: v };
    if (groupBy === "status") partial.status = groupKey as Task["status"];
    else if (groupBy === "priority") partial.priority = groupKey as Priority;
    else if (groupBy === "project") partial.projectId = groupKey;
    else if (groupBy === "section") { const v = groupKey === "__none" ? undefined : groupKey; if (sectionField === "mySectionId") partial.mySectionId = v; else partial.sectionId = v; }
    onQuickAdd?.(partial);
    setAddDraft("");
  };
  const sortMode = sort || "manual";
  // manual reorder only in manual order; not under Due grouping (dragging
  // across due buckets has no well-defined date, so it would just snap back)
  const dragEnabled = !!onPatch && !smart && sortMode === "manual" && groupBy !== "due";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMenu, setBulkMenu] = useState<null | "status" | "priority" | "assignee" | "due" | "project">(null);
  const isoDay = (n: number) => { const d = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const [dragId, setDragId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; half: "top" | "bottom" } | null>(null);
  const selectionActive = selected.size > 0;
  const toggleSelect = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => { setSelected(new Set()); setBulkMenu(null); };
  const ids = [...selected].filter((id) => tasks.some((t) => t.id === id));
  const applyPatch = (patch: Partial<Task>) => { onBulkPatch?.(ids, patch); clearSel(); };
  const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];

  // which group a task sits in for the current grouping
  const groupKeyOf = (t: Task): string => groupBy === "status" ? t.status : groupBy === "priority" ? t.priority : groupBy === "project" ? t.projectId : groupBy === "section" ? (t[sectionField] ?? "__none") : "all";
  // drop a dragged task next to a target row: change its group field if needed, and reposition
  const onRowDrop = (draggedId: string, targetId: string, half: "top" | "bottom") => {
    setDragId(null); setHover(null);
    if (draggedId === targetId) return;
    const dragged = tasks.find((t) => t.id === draggedId), target = tasks.find((t) => t.id === targetId);
    if (!dragged || !target) return;
    const patch: Partial<Task> = {};
    if (groupBy === "status" && dragged.status !== target.status) {
      patch.status = target.status;
      patch.completedAt = target.status === "done" ? toLocalISO(new Date()) : undefined;
    } else if (groupBy === "priority" && dragged.priority !== target.priority) patch.priority = target.priority;
    else if (groupBy === "project" && dragged.projectId !== target.projectId) patch.projectId = target.projectId;
    else if (groupBy === "section" && (dragged[sectionField] ?? "") !== (target[sectionField] ?? "")) { if (sectionField === "mySectionId") patch.mySectionId = target.mySectionId; else patch.sectionId = target.sectionId; }
    const groupItems = tasks.filter((t) => t.id !== draggedId && groupKeyOf(t) === groupKeyOf(target)).sort((a, b) => ((a.position ?? 0) - (b.position ?? 0)) || a.id.localeCompare(b.id));
    const ti = groupItems.findIndex((t) => t.id === targetId);
    const at = half === "top" ? ti : ti + 1;
    onPatch?.(draggedId, { ...patch, position: between(groupItems[at - 1], groupItems[at]) });
  };

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
  const presentIds = new Set(tasks.map((t) => t.id));
  const topLevel = tasks.filter((t) => !t.parentId || !presentIds.has(t.parentId));

  let groups: Group[] = [];
  if (groupBy === "status") {
    groups = STATUS_ORDER.map((s) => ({ key: s, label: STATUS_META[s].label, color: STATUS_META[s].color, items: topLevel.filter((t) => t.status === s).sort(sortFn) })).filter((g) => g.items.length);
  } else if (groupBy === "priority") {
    groups = (["urgent", "high", "medium", "low"] as const).map((p) => ({ key: p, label: PRIORITY_META[p].label + " priority", color: PRIORITY_META[p].color, icon: "flag" as IconName, items: topLevel.filter((t) => t.priority === p).sort(sortFn) })).filter((g) => g.items.length);
  } else if (groupBy === "project") {
    // group by the projects actually present in these tasks (real accounts, not just the demo seed)
    groups = [...new Set(topLevel.map((t) => t.projectId))]
      .map((pid) => ({ pid, p: getProject(pid) }))
      .filter((x) => !!x.p)
      .map(({ pid, p }) => ({ key: pid, label: p!.name, color: p!.color, items: topLevel.filter((t) => t.projectId === pid).sort(sortFn) }))
      .filter((g) => g.items.length);
  } else if (groupBy === "section") {
    // named sections (kept even when empty, so you can add into them) + a "No section" bucket
    const ordered = [...sections].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    groups = ordered.map((s) => ({ key: s.id, label: s.name, color: "var(--accent)", icon: "layers" as IconName, items: topLevel.filter((t) => t[sectionField] === s.id).sort(sortFn) }));
    const none = topLevel.filter((t) => !t[sectionField] || !ordered.some((s) => s.id === t[sectionField])).sort(sortFn);
    if (none.length || ordered.length === 0) groups.push({ key: "__none", label: "No section", color: "var(--ink-4)", icon: "layers" as IconName, items: none });
  } else if (groupBy === "due") {
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
    groups = BUCKETS.map((b) => ({ key: b.key, label: b.label, color: b.color, items: topLevel.filter((t) => dueBucket(t) === b.key).sort(sortFn) })).filter((g) => g.items.length);
  } else {
    groups = [{ key: "all", label: smart ? "Smart order" : "All tasks", color: "var(--accent)", icon: (smart ? "sparkles" : "list") as IconName, items: [...topLevel].sort(sortFn) }];
  }

  return (
    <div style={{ overflowY: "auto", flex: 1, "--kanbo-rowpad": compact ? "5px" : "10px" } as React.CSSProperties}>
      {smart && (
        <div className="anim-fadein" style={{ margin: "16px 18px 0", display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", borderRadius: 12, background: "var(--accent-dim)", border: "1px solid color-mix(in oklch, var(--accent) 28%, transparent)" }}>
          <Icon name="sparkles" size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Sorted by Kanbo's recommended focus order — urgent, unblocking work first.</span>
        </div>
      )}
      {tasks.length === 0 ? (
        <div style={{ textAlign: "center", padding: "80px 24px", color: "var(--ink-4)" }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="tasks" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>No tasks yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 0" }}>Capture one from <strong style={{ color: "var(--ink-3)" }}>Plan my day</strong> or hit <strong style={{ color: "var(--ink-3)" }}>New task</strong> up top.</p>
        </div>
      ) : groups.map((g) => (
        <div key={g.key}>
          <GroupHeader label={g.label} color={g.color} count={g.items.length} icon={g.icon}
            onRename={groupBy === "section" && g.key !== "__none" && onRenameSection ? () => { const n = window.prompt("Rename section", g.label); if (n?.trim()) onRenameSection(g.key, n.trim()); } : undefined}
            onDelete={groupBy === "section" && g.key !== "__none" && onDeleteSection ? () => { if (window.confirm(`Delete section "${g.label}"? Its tasks move to No section.`)) onDeleteSection(g.key); } : undefined} />
          <div>{g.items.map((t) => <TaskRow key={t.id} task={t} allTasks={allTasks} onOpen={onOpen} onToggle={onToggle} onToggleSubtask={onToggleSubtask} smart={smart}
            selected={selected.has(t.id)} selectionActive={selectionActive} onSelect={bulkEnabled ? toggleSelect : undefined}
            draggable={dragEnabled} dragging={dragId === t.id} dropHint={hover && hover.id === t.id && dragId !== t.id ? hover.half : null}
            onPickup={setDragId} onHover={(id, half) => setHover({ id, half })} onRowDrop={onRowDrop}
            onPatch={onPatch} members={members} customFields={customFields} />)}</div>
          {onQuickAdd && (addingKey === g.key ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px 8px 30px", borderBottom: "1px solid var(--hairline)" }}>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input autoFocus value={addDraft} onChange={(e) => setAddDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") quickAdd(g.key); else if (e.key === "Escape") { setAddDraft(""); setAddingKey(null); } }}
                onBlur={() => { quickAdd(g.key); setAddingKey(null); }} placeholder="Task name, then Enter…"
                style={{ flex: 1, height: 32, padding: "0 11px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14, outline: "none" }} />
            </div>
          ) : (
            <button onClick={() => { setAddDraft(""); setAddingKey(g.key); }} className="lift-row" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 18px 9px 30px", border: "none", borderBottom: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13 }}>
              <Icon name="plus" size={14} /> Add task
            </button>
          ))}
        </div>
      ))}
      {groupBy === "section" && onCreateSection && (sectionProjectId || sections[0]?.projectId || tasks[0]?.projectId) && (
        <button onClick={() => { const n = window.prompt("New section name"); if (n?.trim()) onCreateSection(sectionProjectId ?? sections[0]?.projectId ?? tasks[0]!.projectId, n.trim()); }}
          style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 18px", padding: "9px 13px", border: "1px dashed var(--hairline-strong)", borderRadius: 10, background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13 }}>
          <Icon name="plus" size={15} /> Add section
        </button>
      )}
      <div style={{ height: selectionActive ? 90 : 40 }} />

      {selectionActive && (
        <div className="glass anim-fadeup" style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 60,
          display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 14, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
          <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", padding: "0 8px" }}>{ids.length} selected</span>
          <span style={{ width: 1, height: 22, background: "var(--hairline)" }} />
          <button className="btn btn-ghost" onClick={() => applyPatch({ status: "done", completedAt: toLocalISO(new Date()) })} style={{ padding: "7px 11px", fontSize: 13 }}><Icon name="check" size={15} /> Done</button>
          <BulkMenuButton label="Status" icon="layers" open={bulkMenu === "status"} onToggle={() => setBulkMenu((m) => m === "status" ? null : "status")}>
            {STATUS_ORDER.map((s) => (
              <button key={s} onClick={() => applyPatch({ status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined })} style={bulkItemStyle}>
                <StatusDot status={s} size={7} /> {STATUS_META[s].label}
              </button>
            ))}
          </BulkMenuButton>
          <BulkMenuButton label="Priority" icon="flag" open={bulkMenu === "priority"} onToggle={() => setBulkMenu((m) => m === "priority" ? null : "priority")}>
            {PRIORITIES.map((p) => (
              <button key={p} onClick={() => applyPatch({ priority: p })} style={bulkItemStyle}>
                <PriorityFlag priority={p} size={13} /> {PRIORITY_META[p].label}
              </button>
            ))}
          </BulkMenuButton>
          <BulkMenuButton label="Due" icon="calendar" open={bulkMenu === "due"} onToggle={() => setBulkMenu((m) => m === "due" ? null : "due")}>
            <button onClick={() => applyPatch({ dueDate: isoDay(0) })} style={bulkItemStyle}><Icon name="calendar" size={13} /> Today</button>
            <button onClick={() => applyPatch({ dueDate: isoDay(1) })} style={bulkItemStyle}><Icon name="calendar" size={13} /> Tomorrow</button>
            <button onClick={() => applyPatch({ dueDate: isoDay(7) })} style={bulkItemStyle}><Icon name="calendar" size={13} /> Next week</button>
            <button onClick={() => applyPatch({ dueDate: undefined })} style={bulkItemStyle}><Icon name="x" size={13} /> Clear due date</button>
          </BulkMenuButton>
          {members.length > 0 && (
            <BulkMenuButton label="Assign" icon="user" open={bulkMenu === "assignee"} onToggle={() => setBulkMenu((m) => m === "assignee" ? null : "assignee")}>
              {members.map((m) => (
                <button key={m.id} onClick={() => applyPatch({ assigneeId: m.id })} style={bulkItemStyle}>
                  <Avatar id={m.id} size={18} /> {m.name}
                </button>
              ))}
            </BulkMenuButton>
          )}
          {projects.length > 0 && (
            <BulkMenuButton label="Project" icon="grid" open={bulkMenu === "project"} onToggle={() => setBulkMenu((m) => m === "project" ? null : "project")}>
              {projects.map((p) => (
                <button key={p.id} onClick={() => applyPatch({ projectId: p.id })} style={bulkItemStyle}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, flexShrink: 0 }} /> {p.name}
                </button>
              ))}
            </BulkMenuButton>
          )}
          <button className="btn btn-ghost" onClick={() => { onBulkDelete?.(ids); clearSel(); }} style={{ padding: "7px 11px", fontSize: 13, color: "var(--prio-urgent)" }}><Icon name="trash" size={15} /> Delete</button>
          <span style={{ width: 1, height: 22, background: "var(--hairline)" }} />
          <button className="btn-icon" onClick={clearSel} aria-label="Clear selection" style={{ border: "none", width: 30, height: 30 }}><Icon name="x" size={16} /></button>
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

export function BulkMenuButton({ label, icon, open, onToggle, children }: { label: string; icon: IconName; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: "relative" }}>
      <button className="btn btn-ghost" onClick={onToggle} style={{ padding: "7px 11px", fontSize: 13 }}><Icon name={icon} size={15} /> {label}</button>
      {open && (
        <>
          <div onClick={onToggle} style={{ position: "fixed", inset: 0, zIndex: 1 }} />
          <div className="glass anim-scalein" style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 2, minWidth: 168, padding: 5, borderRadius: 12, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
            {children}
          </div>
        </>
      )}
    </div>
  );
}
