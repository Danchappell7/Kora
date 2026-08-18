/* ============================================================
   KANBO — global search: query across every task with field filters,
   plus saved searches. Reads tasks already in memory (instant).
   ============================================================ */
import { useMemo, useState, useEffect } from "react";
import { Icon, Avatar, StatusDot, PriorityFlag } from "../primitives";
import { getProject, fmtDue, dueState, STATUS_META, toLocalISO } from "../../data/data";
import { exportTasksCsv, printTasks } from "../../lib/exportTasks";
import { taskMatchesQuery, EMPTY_QUERY as EMPTY, type Query } from "../../lib/searchQuery";
import type { Task, Project, SavedSearch, Status, Priority } from "../../data/types";

const selStyle: React.CSSProperties = { height: 32, padding: "0 9px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none" };

export function SearchView({ tasks, projects, members, currentUserId, onOpen, savedSearches, onSaveSearch, onDeleteSavedSearch, preset, presetKey, onBulkPatch, onBulkDelete }: {
  tasks: Task[];
  projects: Project[];
  members: { id: string; name: string }[];
  currentUserId?: string;
  onOpen: (id: string) => void;
  savedSearches: SavedSearch[];
  onSaveSearch: (name: string, query: Record<string, unknown>) => void;
  onDeleteSavedSearch: (id: string) => void;
  preset?: Record<string, string>;
  presetKey?: string; // changes whenever a smart list is (re-)selected
  onBulkPatch?: (ids: string[], patch: Partial<Task>) => void;
  onBulkDelete?: (ids: string[]) => void;
}) {
  const [q, setQ] = useState<Query>(preset ? { ...EMPTY, ...preset } : EMPTY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  // apply a smart-list preset whenever one is selected from the sidebar
  useEffect(() => { if (preset) setQ({ ...EMPTY, ...preset }); }, [presetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // dropping a selected task out of the current results shouldn't keep it selected
  useEffect(() => { clearSel(); }, [presetKey, q]);
  const set = (patch: Partial<Query>) => setQ((p) => ({ ...p, ...patch }));
  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => t.tags || []))], [tasks]);
  // one-click cross-project presets (combine + save your own)
  const presets: { label: string; q: Partial<Query> }[] = [
    ...(currentUserId ? [{ label: "Assigned to me", q: { assignee: currentUserId } as Partial<Query> }] : []),
    { label: "Due this week", q: { due: "week" } },
    ...(currentUserId ? [{ label: "My work this week", q: { assignee: currentUserId, due: "week" } as Partial<Query> }] : []),
    { label: "Overdue", q: { due: "overdue" } },
    { label: "Urgent", q: { priority: "urgent" } },
  ];

  const results = useMemo(() => {
    return tasks.filter((t) => taskMatchesQuery(t, q)).slice(0, 200);
  }, [tasks, q]);

  const active = q.text.trim() !== "" || Object.entries(q).some(([k, v]) => k !== "text" && v !== "all");

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 920, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <Icon name="search" size={18} style={{ color: "var(--accent)" }} />
        <input autoFocus value={q.text} onChange={(e) => set({ text: e.target.value })} placeholder="Search every task…"
          style={{ flex: 1, height: 40, padding: "0 12px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15, outline: "none" }} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 12 }}>
        {presets.map((p) => (
          <button key={p.label} onClick={() => setQ({ ...EMPTY, ...p.q })} className="lift" style={{ padding: "5px 12px", borderRadius: 999, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer", fontSize: 12.5, color: "var(--ink-2)", fontFamily: "var(--font-display)" }}>{p.label}</button>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <select value={q.status} onChange={(e) => set({ status: e.target.value })} style={selStyle}><option value="all">Any status</option>{(Object.keys(STATUS_META) as Status[]).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}</select>
        <select value={q.priority} onChange={(e) => set({ priority: e.target.value })} style={selStyle}><option value="all">Any priority</option>{(["urgent", "high", "medium", "low"] as Priority[]).map((p) => <option key={p} value={p}>{p}</option>)}</select>
        <select value={q.assignee} onChange={(e) => set({ assignee: e.target.value })} style={selStyle}><option value="all">Anyone</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        <select value={q.projectId} onChange={(e) => set({ projectId: e.target.value })} style={selStyle}><option value="all">Any project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        {allTags.length > 0 && <select value={q.tag} onChange={(e) => set({ tag: e.target.value })} style={selStyle}><option value="all">Any tag</option>{allTags.map((t) => <option key={t} value={t}>{t}</option>)}</select>}
        <select value={q.due} onChange={(e) => set({ due: e.target.value })} style={selStyle}><option value="all">Any due date</option><option value="today">Due today</option><option value="week">Due this week</option><option value="overdue">Overdue</option><option value="has">Has a due date</option><option value="none">No due date</option></select>
        {active && (
          <>
            <button onClick={() => { const name = window.prompt("Name this search"); if (name?.trim()) onSaveSearch(name.trim(), q as unknown as Record<string, unknown>); }} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="filter" size={14} /> Save</button>
            <button onClick={() => setQ(EMPTY)} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}>Clear</button>
          </>
        )}
      </div>

      {savedSearches.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          <span className="kicker" style={{ alignSelf: "center" }}>Saved</span>
          {savedSearches.map((s) => (
            <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 6px 4px 11px", borderRadius: 999, border: "1px solid var(--hairline)", background: "var(--surface)", fontSize: 12.5 }}>
              <button onClick={() => setQ({ ...EMPTY, ...(s.query as unknown as Partial<Query>) })} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5 }}>{s.name}</button>
              <button onClick={() => onDeleteSavedSearch(s.id)} aria-label="Delete saved search" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-4)", fontSize: 13 }}>×</button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span className="kicker">{active ? `${results.length} result${results.length === 1 ? "" : "s"}` : "Type or pick a filter to search"}</span>
        {active && results.length > 0 && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 7, alignItems: "center" }}>
            {(onBulkPatch || onBulkDelete) && (
              <button onClick={() => setSelected(selected.size === results.length ? new Set() : new Set(results.map((t) => t.id)))} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>
                {selected.size === results.length ? "Clear" : "Select all"}
              </button>
            )}
            <button onClick={() => exportTasksCsv(results, "search")} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}><Icon name="arrowUpRight" size={13} /> CSV</button>
            <button onClick={() => printTasks(results, "Search results")} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}><Icon name="arrowUpRight" size={13} /> PDF</button>
          </span>
        )}
      </div>
      {selected.size > 0 && (onBulkPatch || onBulkDelete) && (
        <div className="glass anim-fadeup" style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{selected.size} selected</span>
          <div style={{ flex: 1 }} />
          {onBulkPatch && <button onClick={() => { onBulkPatch([...selected], { status: "done", completedAt: toLocalISO(new Date()) }); clearSel(); }} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="check" size={14} /> Complete</button>}
          {onBulkPatch && <button onClick={() => { onBulkPatch([...selected], { dueDate: toLocalISO(new Date()) }); clearSel(); }} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="calendar" size={14} /> Due today</button>}
          {onBulkDelete && <button onClick={() => { if (window.confirm(`Delete ${selected.size} task${selected.size === 1 ? "" : "s"}?`)) { onBulkDelete([...selected]); clearSel(); } }} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5, color: "var(--prio-urgent)" }}><Icon name="trash" size={14} /> Delete</button>}
          <button onClick={clearSel} className="btn btn-ghost" style={{ padding: "5px 9px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      <div className="glass" style={{ borderRadius: 16, overflow: "hidden" }}>
        {active && results.map((t, i) => {
          const proj = getProject(t.projectId);
          const ds = dueState(t.dueDate, t.status);
          const sel = selected.has(t.id);
          return (
            <div key={t.id} className="lift-row" onClick={() => onOpen(t.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", cursor: "pointer", borderTop: i ? "1px solid var(--hairline)" : "none", background: sel ? "var(--accent-dim)" : undefined }}>
              {(onBulkPatch || onBulkDelete) && (
                <input type="checkbox" checked={sel} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(t.id)} aria-label={`Select ${t.title}`} style={{ cursor: "pointer", flexShrink: 0 }} />
              )}
              <StatusDot status={t.status} size={8} />
              <span className="truncate" style={{ flex: 1, fontSize: 14, color: t.status === "done" ? "var(--ink-4)" : "var(--ink)", textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</span>
              {t.priority !== "medium" && <PriorityFlag priority={t.priority} size={13} />}
              {proj && <span className="truncate hide-sm" style={{ fontSize: 12, color: "var(--ink-4)", maxWidth: 120 }}>{proj.name}</span>}
              {t.dueDate && <span className="mono" style={{ fontSize: 11.5, color: ds === "overdue" ? "var(--prio-urgent)" : ds === "today" ? "var(--accent)" : "var(--ink-4)" }}>{fmtDue(t.dueDate)}</span>}
              <Avatar id={t.assigneeId} size={20} />
            </div>
          );
        })}
        {active && results.length === 0 && <div style={{ padding: "32px 18px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>No tasks match.</div>}
        {!active && <div style={{ padding: "40px 18px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>Search by text, status, priority, assignee, project, tag or due date.</div>}
      </div>
    </div>
  );
}
