/* ============================================================
   KANBO — Board (Kanban), Timeline (Gantt), Calendar views
   ============================================================ */
import { useState, useRef, useEffect } from "react";
import { Icon, Avatar, StatusDot, Tag, PriorityFlag } from "../primitives";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { bulkItemStyle, BulkMenuButton, CustomChips } from "./ListView";
import {
  getProject, blockingTasks, dueState, fmtDue,
  STATUS_META, STATUS_ORDER, PRIORITY_META, KANBO_TODAY, toLocalISO,
} from "../../data/data";
import type { Task, Status, Priority, Project, CalProvider, CalendarConnection, ExternalEvent, Attachment, CustomFieldDef } from "../../data/types";
import { store } from "../../data/store";
import { reportError } from "../../lib/monitoring";

type BoardGroup = "status" | "priority" | "project" | "assignee";

const PROVIDER_META: Record<CalProvider, { label: string; color: string }> = {
  google: { label: "Google Calendar", color: "oklch(0.7 0.18 25)" },
  microsoft: { label: "Microsoft / Outlook", color: "oklch(0.62 0.16 250)" },
};

/* ---------------- KANBAN ---------------- */
type Half = "top" | "bottom";
function KanbanCard({ task, allTasks, onOpen, onMove, isMobile, dragging, dropHint, onPickup, onHoverCard, onCardDrop, selected = false, selectionActive = false, onSelect, customFields = [], members = [] }: {
  task: Task; allTasks: Task[]; onOpen: (id: string) => void; onMove: (id: string, status: Status) => void;
  isMobile: boolean; dragging: boolean; dropHint: Half | null;
  onPickup: (id: string) => void; onHoverCard: (id: string, half: Half) => void; onCardDrop: (draggedId: string, targetId: string, half: Half) => void;
  selected?: boolean; selectionActive?: boolean; onSelect?: (id: string) => void;
  customFields?: CustomFieldDef[]; members?: { id: string; name: string }[];
}) {
  const proj = getProject(task.projectId);
  const blocked = blockingTasks(task, allTasks);
  const ds = dueState(task.dueDate, task.status);
  // sub-task progress (child tasks + any legacy checklist items)
  const kids = allTasks.filter((c) => c.parentId === task.id);
  const subTotal = kids.length + (task.subtasks?.length ?? 0);
  const subDone = kids.filter((c) => c.status === "done").length + (task.subtasks ?? []).filter((s) => s.done).length;
  const [moveOpen, setMoveOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const halfFrom = (e: React.DragEvent): Half => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "top" : "bottom";
  };
  return (
    <div onClick={() => onOpen(task.id)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} className="glass clickable lift" draggable={!isMobile}
      onDragStart={(e) => { e.dataTransfer.setData("text/kanbo-task", task.id); e.dataTransfer.effectAllowed = "move"; onPickup(task.id); }}
      onDragOver={!isMobile ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); onHoverCard(task.id, halfFrom(e)); } : undefined}
      onDrop={!isMobile ? (e) => { if (!e.dataTransfer.types.includes("text/kanbo-task")) return; e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData("text/kanbo-task"); onCardDrop(id, task.id, halfFrom(e)); } : undefined}
      style={{ padding: 13, borderRadius: 12, cursor: isMobile ? "pointer" : "grab", opacity: dragging ? 0.4 : 1, position: "relative",
        outline: selected ? "1.5px solid var(--accent)" : undefined, background: selected ? "var(--accent-dim)" : undefined,
        boxShadow: dropHint === "top" ? "inset 0 3px 0 -1px var(--accent)" : dropHint === "bottom" ? "inset 0 -3px 0 -1px var(--accent)" : undefined }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        {onSelect && (
          <button onClick={(e) => { e.stopPropagation(); onSelect(task.id); }} aria-label={selected ? "Deselect task" : "Select task"}
            style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, padding: 0, cursor: "pointer", display: "grid", placeItems: "center", marginTop: 1,
              border: `1.6px solid ${selected ? "var(--accent)" : "var(--hairline-strong)"}`, background: selected ? "var(--accent)" : "transparent",
              opacity: selected || selectionActive || hovered ? 1 : 0, transition: "opacity .12s" }}>
            {selected && <Icon name="check" size={11} sw={3} style={{ color: "var(--on-accent)" }} />}
          </button>
        )}
        <PriorityFlag priority={task.priority} size={13} />
        {task.isMilestone && <span title="Milestone" style={{ width: 9, height: 9, transform: "rotate(45deg)", background: "var(--st-review)", borderRadius: 2, flexShrink: 0, marginTop: 3 }} />}
        <span style={{ flex: 1, fontSize: 13.5, lineHeight: 1.35, fontWeight: 450 }}>{task.title}</span>
      </div>
      {(task.tags || []).length > 0 && <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>{task.tags.slice(0, 2).map((tg) => <Tag key={tg} id={tg} small />)}</div>}
      {customFields.length > 0 && (task.custom && Object.keys(task.custom).length > 0) && <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}><CustomChips task={task} fields={customFields} members={members} /></div>}
      {blocked.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 9, fontSize: 11, color: "var(--st-blocked)" }}>
          <Icon name="lock" size={12} /> Blocked
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 11 }}>
        {proj && <span style={{ width: 7, height: 7, borderRadius: 2, background: proj.color }} />}
        {subTotal > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>
            <Icon name="layers" size={12} /> {subDone}/{subTotal}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {task.dueDate && <span className="mono" style={{ fontSize: 11, color: ds === "overdue" ? "var(--prio-urgent)" : ds === "today" ? "var(--accent)" : "var(--ink-4)" }}>{fmtDue(task.dueDate)}</span>}
        <Avatar id={task.assigneeId} size={22} />
        {/* touch devices can't drag between columns — give a tap-to-move menu */}
        {isMobile && (
          <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
            <button className="btn-icon" aria-label="Move to status" onClick={() => setMoveOpen((v) => !v)} style={{ border: "none", width: 30, height: 30, color: "var(--ink-3)" }}><Icon name="layers" size={15} /></button>
            {moveOpen && (
              <>
                <div onClick={() => setMoveOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div className="glass anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 41, width: 172, padding: 6, borderRadius: 12, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
                  <div className="kicker" style={{ padding: "4px 9px 6px" }}>Move to</div>
                  {STATUS_ORDER.map((s) => (
                    <button key={s} onClick={() => { setMoveOpen(false); if (s !== task.status) onMove(task.id, s); }}
                      style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "9px 9px", borderRadius: 8, border: "none", background: task.status === s ? "var(--surface-2)" : "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13, textAlign: "left", color: "var(--ink-2)" }}>
                      <StatusDot status={s} size={7} /> {STATUS_META[s].label}
                      {task.status === s && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Fractional index between two neighbours (either may be absent → ends of list).
function between(before?: Task, after?: Task): number {
  const bp = before?.position, ap = after?.position;
  if (bp == null && ap == null) return Date.now();
  if (bp == null) return (ap as number) - 1;
  if (ap == null) return (bp as number) + 1;
  return (bp + ap) / 2;
}

interface BoardCol { key: string; label: string; status?: Status; dot?: string }

export function BoardView({ tasks, allTasks, onOpen, onAdd, onMove, onPatch, onBulkPatch, onBulkDelete, members = [], customFields = [] }: {
  tasks: Task[]; allTasks: Task[]; onOpen: (id: string) => void; onAdd: (status: Status) => void;
  onMove: (taskId: string, status: Status, position?: number) => void;
  onPatch?: (id: string, patch: Partial<Task>) => void;
  onBulkPatch?: (ids: string[], patch: Partial<Task>) => void;
  onBulkDelete?: (ids: string[]) => void;
  members?: { id: string; name: string }[];
  customFields?: CustomFieldDef[];
}) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMenu, setBulkMenu] = useState<null | "status" | "priority" | "assignee">(null);
  const selectionActive = selected.size > 0;
  const toggleSelect = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => { setSelected(new Set()); setBulkMenu(null); };
  const selIds = [...selected].filter((id) => tasks.some((t) => t.id === id));
  const applyBulk = (patch: Partial<Task>) => { onBulkPatch?.(selIds, patch); clearSel(); };
  const BULK_PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; half: Half } | null>(null);
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
  // per-column WIP limits, keyed by group:column, persisted locally
  const [wip, setWip] = useState<Record<string, number>>(() => { try { const s = localStorage.getItem("kanbo-board-wip"); if (s) return JSON.parse(s); } catch { /* ignore */ } return {}; });
  useEffect(() => { try { localStorage.setItem("kanbo-board-wip", JSON.stringify(wip)); } catch { /* ignore */ } }, [wip]);
  const wipKey = (k: string) => `${group}:${k}`;
  const setLimit = (k: string) => {
    const cur = wip[wipKey(k)];
    const v = window.prompt("WIP limit for this column (blank to clear)", cur != null ? String(cur) : "");
    if (v == null) return;
    setWip((w) => { const n = { ...w }; const t = v.trim(); if (t === "") delete n[wipKey(k)]; else { const num = Math.max(0, parseInt(t, 10)); if (!isNaN(num)) n[wipKey(k)] = num; } return n; });
  };
  const colItems = useRef<Record<string, Task[]>>({});

  const keyOf = (t: Task): string => group === "status" ? t.status : group === "priority" ? t.priority : group === "project" ? t.projectId : (t.assigneeId || "—");
  const columns: BoardCol[] =
    group === "status" ? STATUS_ORDER.map((s) => ({ key: s, label: STATUS_META[s].label, status: s }))
    : group === "priority" ? (["urgent", "high", "medium", "low"] as Priority[]).map((p) => ({ key: p, label: PRIORITY_META[p].label, dot: PRIORITY_META[p].color }))
    : group === "project" ? [...new Set(tasks.map((t) => t.projectId))].map((pid) => ({ pid, p: getProject(pid) })).filter((x) => !!x.p).map(({ pid, p }) => ({ key: pid, label: p!.name, dot: p!.color }))
    : (members.length ? members : [{ id: "—", name: "Unassigned" }]).map((m) => ({ key: m.id, label: m.name }));

  const endHover = () => { setDragId(null); setHover(null); setDragOver(null); };
  const applyDrop = (draggedId: string, col: BoardCol, pos: number) => {
    if (group === "status") { onMove(draggedId, col.key as Status, pos); return; }
    const field: Partial<Task> = group === "priority" ? { priority: col.key as Priority } : group === "project" ? { projectId: col.key } : { assigneeId: col.key };
    onPatch?.(draggedId, { ...field, position: pos });
  };
  const onCardDrop = (draggedId: string, targetId: string, half: Half, col: BoardCol) => {
    endHover();
    if (draggedId === targetId) return;
    const list = (colItems.current[col.key] ?? []).filter((t) => t.id !== draggedId);
    const ti = list.findIndex((t) => t.id === targetId);
    const at = half === "top" ? ti : ti + 1;
    applyDrop(draggedId, col, between(list[at - 1], list[at]));
  };
  const onColumnDrop = (draggedId: string, col: BoardCol) => {
    endHover();
    const list = (colItems.current[col.key] ?? []).filter((t) => t.id !== draggedId);
    applyDrop(draggedId, col, between(list[list.length - 1], undefined));
  };
  const toggleCollapse = (key: string) => setCollapsed((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const GROUPS: { v: BoardGroup; label: string }[] = [{ v: "status", label: "Status" }, { v: "priority", label: "Priority" }, { v: "project", label: "Project" }, { v: "assignee", label: "Assignee" }];

  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      {/* board group selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 24px 0" }}>
        <span className="kicker">Columns</span>
        <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)" }}>
          {GROUPS.map((g) => (
            <button key={g.v} onClick={() => setGroup(g.v)} style={{ padding: "5px 11px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500,
              background: group === g.v ? "var(--accent)" : "transparent", color: group === g.v ? "var(--on-accent)" : "var(--ink-3)" }}>{g.label}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 16, padding: "16px 24px 28px", minHeight: "100%" }}>
        {columns.map((col) => {
          const items = tasks.filter((t) => keyOf(t) === col.key && !t.parentId).slice().sort((a, b) => ((a.position ?? 0) - (b.position ?? 0)) || a.id.localeCompare(b.id));
          colItems.current[col.key] = items;
          const isCollapsed = collapsed.has(col.key);
          const dot = col.status ? null : <span style={{ width: 9, height: 9, borderRadius: 99, background: col.dot || "var(--ink-4)", flexShrink: 0 }} />;
          if (isCollapsed) {
            return (
              <button key={col.key} onClick={() => toggleCollapse(col.key)} title={`Expand ${col.label}`}
                style={{ width: 46, flexShrink: 0, border: "1px solid var(--hairline)", borderRadius: 14, background: "color-mix(in oklch, var(--bg-deep) 28%, transparent)", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "12px 0" }}>
                <Icon name="chevronRight" size={15} style={{ color: "var(--ink-4)" }} />
                {col.status ? <StatusDot status={col.status} /> : dot}
                <span className="mono tnum" style={{ fontSize: 11, color: "var(--ink-4)" }}>{items.length}</span>
                <span style={{ writingMode: "vertical-rl", fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", marginTop: 4 }}>{col.label}</span>
              </button>
            );
          }
          return (
            <div key={col.key} style={{ width: 296, flexShrink: 0, display: "flex", flexDirection: "column" }}
              onDragOver={(e) => { if (e.dataTransfer.types.includes("text/kanbo-task")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(col.key); setHover(null); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver((d) => d === col.key ? null : d); }}
              onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/kanbo-task"); if (id) onColumnDrop(id, col); }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 4px 12px" }}>
                <button onClick={() => toggleCollapse(col.key)} className="btn-icon" title="Collapse column" style={{ width: 20, height: 20, border: "none", background: "transparent", color: "var(--ink-4)", flexShrink: 0 }}><Icon name="chevronRight" size={13} style={{ transform: "rotate(90deg)" }} /></button>
                {col.status ? <StatusDot status={col.status} glow /> : dot}
                <span className="truncate" style={{ fontSize: 13.5, fontWeight: 600 }}>{col.label}</span>
                {(() => { const limit = wip[wipKey(col.key)]; const over = limit != null && items.length > limit; return (
                  <button onClick={() => setLimit(col.key)} title="Set WIP limit" className="mono tnum" style={{ fontSize: 11.5, cursor: "pointer", border: "none", borderRadius: 6, padding: "1px 7px", fontWeight: over ? 700 : 400, color: over ? "var(--prio-urgent)" : "var(--ink-4)", background: over ? "color-mix(in oklch, var(--prio-urgent) 15%, transparent)" : "var(--surface)" }}>{items.length}{limit != null ? `/${limit}` : ""}</button>
                ); })()}
                {col.status && <button onClick={() => onAdd(col.status!)} className="btn-icon" title="Add task" style={{ marginLeft: "auto", width: 24, height: 24, border: "none", color: "var(--ink-4)" }}><Icon name="plus" size={15} /></button>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, padding: 4, borderRadius: 14, minHeight: 120, transition: "background .15s, box-shadow .15s",
                background: dragOver === col.key ? "var(--accent-dim)" : "color-mix(in oklch, var(--bg-deep) 28%, transparent)",
                boxShadow: dragOver === col.key && !hover ? "inset 0 0 0 2px var(--accent)" : "none" }}>
                {items.map((t) => (
                  <KanbanCard key={t.id} task={t} allTasks={allTasks} onOpen={onOpen} onMove={onMove}
                    isMobile={isMobile} dragging={dragId === t.id}
                    dropHint={hover && hover.id === t.id && dragId !== t.id ? hover.half : null}
                    onPickup={setDragId}
                    onHoverCard={(id, half) => { setDragOver(null); setHover({ id, half }); }}
                    onCardDrop={(draggedId, targetId, half) => onCardDrop(draggedId, targetId, half, col)}
                    selected={selected.has(t.id)} selectionActive={selectionActive} onSelect={onBulkPatch ? toggleSelect : undefined}
                    customFields={customFields} members={members} />
                ))}
                {col.status && (
                  <button onClick={() => onAdd(col.status!)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px", borderRadius: 11, border: "1px dashed var(--hairline-strong)", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5 }}>
                    <Icon name="plus" size={14} /> Add task
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selectionActive && (
        <div className="anim-fadeup" style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 60,
          display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 14, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", border: "1px solid var(--hairline)" }}>
          <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", padding: "0 8px" }}>{selIds.length} selected</span>
          <span style={{ width: 1, height: 22, background: "var(--hairline)" }} />
          <button className="btn btn-ghost" onClick={() => applyBulk({ status: "done", completedAt: toLocalISO(new Date()) })} style={{ padding: "7px 11px", fontSize: 13 }}><Icon name="check" size={15} /> Done</button>
          <BulkMenuButton label="Status" icon="layers" open={bulkMenu === "status"} onToggle={() => setBulkMenu((m) => m === "status" ? null : "status")}>
            {STATUS_ORDER.map((s) => (<button key={s} onClick={() => applyBulk({ status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined })} style={bulkItemStyle}><StatusDot status={s} size={7} /> {STATUS_META[s].label}</button>))}
          </BulkMenuButton>
          <BulkMenuButton label="Priority" icon="flag" open={bulkMenu === "priority"} onToggle={() => setBulkMenu((m) => m === "priority" ? null : "priority")}>
            {BULK_PRIORITIES.map((p) => (<button key={p} onClick={() => applyBulk({ priority: p })} style={bulkItemStyle}><PriorityFlag priority={p} size={13} /> {PRIORITY_META[p].label}</button>))}
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
export function TimelineView({ tasks, onOpen, onPatch }: { tasks: Task[]; allTasks?: Task[]; onOpen: (id: string) => void; onPatch?: (id: string, patch: Partial<Task>) => void }) {
  const DAYS = 16, START = -2; // show -2 .. +13
  const dates = Array.from({ length: DAYS }, (_, i) => { const d = new Date(KANBO_TODAY); d.setDate(d.getDate() + START + i); return d; });
  const colW = 78, labelW = 230, rowH = 46;
  const dayIndex = (iso?: string): number | null => {
    if (!iso) return null;
    const d = new Date(iso + "T00:00:00");
    const base = new Date(KANBO_TODAY); base.setDate(base.getDate() + START);
    return Math.round((d.getTime() - new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()) / 86400000);
  };

  // group by the projects actually present in these tasks (works for real
  // accounts, not just the demo seed)
  const byProject = [...new Set(tasks.map((t) => t.projectId))]
    .map((pid) => ({ project: getProject(pid), items: tasks.filter((t) => t.projectId === pid) }))
    .filter((g): g is { project: Project; items: Task[] } => !!g.project && g.items.length > 0);
  const todayIdx = -START;

  if (byProject.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 380 }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="layers" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>Nothing to chart yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Add a few tasks and they'll lay out here on a timeline by project and due date.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={{ minWidth: labelW + DAYS * colW, padding: "8px 0 40px" }}>
        {/* axis */}
        <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 3, background: "color-mix(in oklch, var(--bg) 88%, transparent)", backdropFilter: "blur(8px)", borderBottom: "1px solid var(--hairline)" }}>
          <div style={{ width: labelW, flexShrink: 0, padding: "12px 18px" }}><span className="kicker">Task</span></div>
          {dates.map((d, i) => {
            const isToday = i === todayIdx;
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            return (
              <div key={i} style={{ width: colW, flexShrink: 0, textAlign: "center", padding: "10px 0", background: weekend ? "color-mix(in oklch, var(--bg-deep) 22%, transparent)" : "transparent" }}>
                <div className="kicker" style={{ color: isToday ? "var(--accent)" : "var(--ink-4)" }}>{d.toLocaleDateString(undefined, { weekday: "short" })}</div>
                <div className="mono tnum" style={{ fontSize: 14, fontWeight: 600, marginTop: 2, color: isToday ? "var(--accent)" : "var(--ink-2)" }}>{d.getDate()}</div>
              </div>
            );
          })}
        </div>

        {/* rows */}
        <div style={{ position: "relative" }}>
          {/* today line */}
          <div style={{ position: "absolute", top: 0, bottom: 0, left: labelW + todayIdx * colW + colW / 2, width: 2, background: "var(--accent)", opacity: 0.4, zIndex: 1, boxShadow: "0 0 12px var(--accent)" }} />
          {byProject.map((g) => (
            <div key={g.project.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 18px 6px", position: "sticky", left: 0, width: labelW }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: g.project.color }} />
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{g.project.name}</span>
              </div>
              {g.items.map((t) => {
                const di = dayIndex(t.dueDate);
                const start = Math.max(0, (di ?? 0) - Math.ceil(t.focusMin / 60 / 2) - 1);
                const span = Math.max(1, (di ?? 0) - start + 1);
                const done = t.status === "done";
                return (
                  <div key={t.id} style={{ display: "flex", height: rowH, alignItems: "center", position: "relative" }}>
                    <div className="truncate" style={{ width: labelW, flexShrink: 0, padding: "0 18px", fontSize: 13, color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 8 }}>
                      <StatusDot status={t.status} size={7} />{t.title}
                    </div>
                    <div style={{ position: "absolute", left: labelW, right: 0, top: 0, bottom: 0 }}
                      onDragOver={onPatch ? (e) => { if (e.dataTransfer.types.includes("text/kanbo-timeline")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } } : undefined}
                      onDrop={onPatch ? (e) => {
                        if (!e.dataTransfer.types.includes("text/kanbo-timeline")) return;
                        e.preventDefault();
                        const id = e.dataTransfer.getData("text/kanbo-timeline"); if (!id) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const idx = Math.max(0, Math.min(DAYS - 1, Math.floor((e.clientX - rect.left) / colW)));
                        onPatch(id, { dueDate: toLocalISO(dates[idx]) });
                      } : undefined}>
                      {di != null && di >= 0 && di < DAYS && (
                        <div onClick={() => onOpen(t.id)} className="clickable" draggable={!!onPatch}
                          onDragStart={onPatch ? (e) => { e.dataTransfer.setData("text/kanbo-timeline", t.id); e.dataTransfer.effectAllowed = "move"; } : undefined}
                          title={onPatch ? "Drag to reschedule" : undefined}
                          style={{
                            position: "absolute", top: rowH / 2 - 13, left: start * colW + 6, width: span * colW - 12, height: 26,
                            borderRadius: 8, display: "flex", alignItems: "center", gap: 7, padding: "0 9px", overflow: "hidden", cursor: onPatch ? "grab" : "pointer",
                            background: done ? "color-mix(in oklch, var(--st-done) 18%, transparent)" : `color-mix(in oklch, ${g.project.color} 22%, transparent)`,
                            border: `1px solid color-mix(in oklch, ${done ? "var(--st-done)" : g.project.color} 45%, transparent)`,
                            transition: "all .16s",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(-1px)")}
                          onMouseLeave={(e) => (e.currentTarget.style.transform = "none")}>
                          <span style={{ width: 6, height: 6, borderRadius: 99, background: done ? "var(--st-done)" : g.project.color, flexShrink: 0 }} />
                          <span className="truncate" style={{ fontSize: 11.5, color: "var(--ink)" }}>{t.title}</span>
                          <Avatar id={t.assigneeId} size={16} />
                        </div>
                      )}
                      {/* tasks with no due date: a draggable placeholder so they can be scheduled */}
                      {di == null && onPatch && (
                        <div onClick={() => onOpen(t.id)} className="clickable" draggable
                          onDragStart={(e) => { e.dataTransfer.setData("text/kanbo-timeline", t.id); e.dataTransfer.effectAllowed = "move"; }}
                          title="Drag onto a day to schedule"
                          style={{ position: "absolute", top: rowH / 2 - 11, left: 6, height: 22, borderRadius: 8, display: "flex", alignItems: "center", gap: 6, padding: "0 9px", cursor: "grab", background: "var(--surface-2)", border: "1px dashed var(--hairline-strong)" }}>
                          <Icon name="calendarPlus" size={12} style={{ color: "var(--ink-4)" }} />
                          <span style={{ fontSize: 11, color: "var(--ink-4)" }}>No date</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
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

export function CalendarView({ tasks, onOpen, connections = [], externalEvents = [], onConnect, onDisconnect, syncing }: {
  tasks: Task[];
  onOpen: (id: string) => void;
  connections?: CalendarConnection[];
  externalEvents?: ExternalEvent[];
  onConnect?: (p: CalProvider) => void;
  onDisconnect?: (p: CalProvider) => void;
  syncing?: boolean;
}) {
  // month navigation (0 = current month)
  const [monthOffset, setMonthOffset] = useState(0);
  const viewMonth = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth() + monthOffset, 1);
  const year = viewMonth.getFullYear(), month = viewMonth.getMonth();
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  // only highlight "today" when we're actually viewing the current month
  const todayD = monthOffset === 0 ? KANBO_TODAY.getDate() : -1;
  const iso = (d: number) => toLocalISO(new Date(year, month, d));
  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const MonthNav = () => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button className="btn-icon" aria-label="Previous month" onClick={() => setMonthOffset((m) => m - 1)} style={{ border: "none", width: 32, height: 32 }}><Icon name="chevronLeft" size={17} /></button>
      <span style={{ fontSize: 14, fontWeight: 600, minWidth: 124, textAlign: "center" }}>{monthLabel}</span>
      <button className="btn-icon" aria-label="Next month" onClick={() => setMonthOffset((m) => m + 1)} style={{ border: "none", width: 32, height: 32 }}><Icon name="chevronRight" size={17} /></button>
      {monthOffset !== 0 && <button className="btn btn-ghost" onClick={() => setMonthOffset(0)} style={{ fontSize: 12.5, padding: "5px 11px" }}>Today</button>}
    </div>
  );

  // group external events by local calendar day
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
      const dt = tasks.filter((t) => t.dueDate === di);
      const de = evByDate[di] ?? [];
      if (dt.length || de.length) agenda.push({ d, iso: di, tasks: dt, events: de });
    }
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 28px" }}>
        {onConnect && onDisconnect && <ConnectCalendarMenu connections={connections} onConnect={onConnect} onDisconnect={onDisconnect} syncing={syncing} />}
        <div style={{ marginBottom: 14 }}><MonthNav /></div>
        {agenda.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--ink-4)", padding: "40px 16px" }}>
            <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="calendar" size={24} /></div>
            <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>Nothing scheduled this month</p>
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

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "18px 24px 28px" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <MonthNav />
        <div style={{ flex: 1 }} />
        {onConnect && onDisconnect && <ConnectCalendarMenu connections={connections} onConnect={onConnect} onDisconnect={onDisconnect} syncing={syncing} />}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 1, marginBottom: 8 }}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="kicker" style={{ textAlign: "center", padding: "4px 0" }}>{d}</div>)}
      </div>
      <div className="glass" style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gridAutoRows: "minmax(118px,1fr)", gap: 1, padding: 1, borderRadius: 16, overflow: "hidden", background: "var(--hairline)" }}>
        {cells.map((d, i) => {
          const dayIso = d ? iso(d) : "";
          const dayTasks = d ? tasks.filter((t) => t.dueDate === dayIso) : [];
          const dayEvents = d ? (evByDate[dayIso] ?? []) : [];
          const isToday = d === todayD;
          const overflow = Math.max(0, dayTasks.length - 3) + Math.max(0, dayEvents.length - 2);
          return (
            <div key={i} style={{ background: d ? "var(--surface)" : "color-mix(in oklch, var(--bg-deep) 30%, transparent)", padding: 9, minHeight: 0, display: "flex", flexDirection: "column", gap: 5 }}>
              {d && (
                <>
                  <span className="mono tnum" style={{ fontSize: 12, fontWeight: 600, alignSelf: "flex-start", color: isToday ? "var(--on-accent)" : "var(--ink-3)", background: isToday ? "var(--accent)" : "transparent", borderRadius: 7, padding: isToday ? "1px 7px" : "1px 2px", boxShadow: isToday ? "0 0 12px var(--accent-glow)" : "none" }}>{d}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, overflow: "hidden" }}>
                    {dayEvents.slice(0, 2).map((e) => {
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
                    {dayTasks.slice(0, 3).map((t) => {
                      const proj = getProject(t.projectId);
                      return (
                        <button key={t.id} onClick={() => onOpen(t.id)} className="truncate" style={{
                          display: "flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 6px", borderRadius: 6, cursor: "pointer",
                          border: "none", textAlign: "left", color: t.status === "done" ? "var(--ink-4)" : "var(--ink-2)",
                          textDecoration: t.status === "done" ? "line-through" : "none",
                          background: `color-mix(in oklch, ${proj?.color || "var(--accent)"} 14%, transparent)`,
                          borderLeft: `2px solid ${proj?.color || "var(--accent)"}`,
                        }}>
                          <span className="truncate">{t.title}</span>
                        </button>
                      );
                    })}
                    {overflow > 0 && <span style={{ fontSize: 10.5, color: "var(--ink-4)", paddingLeft: 6 }}>+{overflow} more</span>}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- FILES (all attachments across the current scope) ---------------- */
function bytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
export function FilesView({ tasks, onOpen }: { tasks: Task[]; allTasks?: Task[]; onOpen: (id: string) => void }) {
  const [files, setFiles] = useState<{ att: Attachment; task?: Task }[]>([]);
  const [loading, setLoading] = useState(true);
  const ids = tasks.map((t) => t.id).join(",");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    store.listProjectAttachments(tasks.map((t) => t.id))
      .then((atts) => { if (!cancelled) setFiles(atts.map((a) => ({ att: a, task: tasks.find((t) => t.id === a.taskId) }))); })
      .catch(reportError)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 40px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      {loading ? (
        <div style={{ textAlign: "center", padding: "60px 24px", color: "var(--ink-4)", fontSize: 13 }}>Loading files…</div>
      ) : files.length === 0 ? (
        <div style={{ textAlign: "center", padding: "70px 24px", color: "var(--ink-4)" }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="folder" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>No files yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 0" }}>Attachments added to tasks here will appear in one place.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {files.map(({ att, task }) => {
            const img = att.mime?.startsWith("image/") && att.url;
            return (
              <div key={att.id} className="glass lift" onClick={() => task && onOpen(task.id)} style={{ borderRadius: 14, overflow: "hidden", cursor: task ? "pointer" : "default", display: "flex", flexDirection: "column" }}>
                <div style={{ height: 110, background: "var(--surface-2)", display: "grid", placeItems: "center", overflow: "hidden" }}>
                  {img ? <img src={att.url} alt={att.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon name="folder" size={26} style={{ color: "var(--ink-4)" }} />}
                </div>
                <div style={{ padding: "10px 12px" }}>
                  <div className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{att.name}</div>
                  <div className="truncate" style={{ fontSize: 11.5, color: "var(--ink-4)", marginTop: 2 }}>{bytes(att.size)}{task ? " · " + task.title : ""}</div>
                  {att.url && <a href={att.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6 }}><Icon name="arrowUpRight" size={12} /> Open</a>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
