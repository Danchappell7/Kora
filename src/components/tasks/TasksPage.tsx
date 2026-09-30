/* ============================================================
   KANBO — the tasks page: My tasks and a project's tasks, with the
   view switcher (list, board, timeline, calendar, files, matrix),
   grouping, sort, filters and export.
   ============================================================ */
import { useState, useEffect } from "react";
import { Icon, Segmented, type SegmentedOption } from "../primitives";
import { ListView } from "./ListView";
import { BoardView, TimelineView, CalendarView, FilesView, MatrixView } from "./OtherViews";
import { exportTasksCsv, printTasks, type TaskExportOptions } from "../../lib/exportTasks";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { readFilters, validFilters, filtersKey, EMPTY_FILTERS, type TaskFilters } from "../../lib/taskOps";
import { dueState, KANBO_TODAY } from "../../data/data";
import type { Task, Project, Status, TagDef, Section, CustomFieldDef } from "../../data/types";
import type { TaskView, GroupBy } from "../../app-types";

const VIEW_OPTS: SegmentedOption<TaskView>[] = [
  { value: "list", label: "List", icon: "list" },
  { value: "board", label: "Board", icon: "board" },
  { value: "timeline", label: "Timeline", icon: "timeline" },
  { value: "calendar", label: "Calendar", icon: "calendar" },
  { value: "files", label: "Files", icon: "folder" },
  { value: "matrix", label: "Matrix", icon: "grid" },
];

const GROUP_OPTS: SegmentedOption<GroupBy>[] = [
  { value: "status", label: "Status" },
  { value: "section", label: "Section" },
  { value: "due", label: "Due" },
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
  { value: "none", label: "None" },
];

const PRIORITY_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All priorities" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div className="kicker" style={{ padding: "6px 8px 4px" }}>{label}</div>
      {children}
    </div>
  );
}
function FilterOption({ label, active, onClick, dot }: { label: string; active: boolean; onClick: () => void; dot?: string }) {
  return (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: active ? "var(--ink)" : "var(--ink-3)", background: active ? "var(--surface-2)" : "transparent" }}>
      <span style={{ width: 13, display: "grid", placeItems: "center", flexShrink: 0 }}>{active && <Icon name="check" size={13} style={{ color: "var(--accent)" }} />}</span>
      {dot && <span style={{ width: 8, height: 8, borderRadius: 3, background: dot, flexShrink: 0 }} />}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function TasksPage({ tasks, allTasks, projects = [], view, setView, groupBy, setGroupBy, smart, setSmart, onOpen, onToggle, onToggleSubtask, onAdd, onMove, onBulkPatch, onBulkDelete, onPatch, onQuickAdd, onOpenImport, members, allTags, archivedTasks = [], header, sections = [], onCreateSection, onRenameSection, onDeleteSection, customFields = [], sectionField = "sectionId", sectionProjectId, filterScope = "my", readOnly = false, boardScope, exportName = "my-tasks", exportOpts }: {
  tasks: Task[];
  allTasks: Task[];
  projects?: Project[];
  view: TaskView;
  setView: (v: TaskView) => void;
  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  smart: boolean;
  setSmart: React.Dispatch<React.SetStateAction<boolean>>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onToggleSubtask: (taskId: string, subId: string) => void;
  onAdd: (status: Status) => void;
  onMove: (taskId: string, status: Status, position?: number) => void;
  onBulkPatch: (ids: string[], patch: Partial<Task>) => void;
  onBulkDelete: (ids: string[]) => void;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onQuickAdd: (partial: Partial<Task> & { title: string }) => void;
  onOpenImport?: () => void;
  members: { id: string; name: string }[];
  allTags: Record<string, TagDef>;
  archivedTasks?: Task[];
  header?: React.ReactNode;
  sections?: Section[];
  onCreateSection?: (projectId: string, name: string) => void;
  onRenameSection?: (id: string, name: string) => void;
  onDeleteSection?: (id: string) => void;
  customFields?: CustomFieldDef[];
  sectionField?: "sectionId" | "mySectionId";
  sectionProjectId?: string;
  /** filters are saved per route: a project id, or "my" for My tasks */
  filterScope?: string;
  /** a guest in this workspace: view + comment only (editing controls should hide) */
  readOnly?: boolean;
  /** which board this is, so each board keeps its own WIP limits */
  boardScope?: string;
  /** the CSV file's name (the project's, or "my-tasks") */
  exportName?: string;
  /** what the CSV needs to fill its Section, Parent task and custom-field columns */
  exportOpts?: TaskExportOptions;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem("kanbo-density") === "compact"; } catch { return false; } });
  const toggleCompact = () => setCompact((c) => { const n = !c; try { localStorage.setItem("kanbo-density", n ? "compact" : "comfortable"); } catch { /* private mode */ } return n; });
  const [sortOpen, setSortOpen] = useState(false);
  const [sort, setSort] = useState<string>(() => { try { return localStorage.getItem("kanbo-sort") || "manual"; } catch { return "manual"; } });
  useEffect(() => { try { localStorage.setItem("kanbo-sort", sort); } catch { /* ignore */ } }, [sort]);
  // The page is keyed by route, so the title filter starts empty on every
  // project / My tasks switch. Filters persist per route (not app-wide), so a
  // filter set in one project can never hide every task in another.
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TaskFilters>(() => readFilters(filterScope));
  useEffect(() => { try { localStorage.setItem(filtersKey(filterScope), JSON.stringify({ ...filters, showArchived: false })); } catch { /* ignore */ } }, [filters, filterScope]);
  const setFilter = (patch: Partial<TaskFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const clearFilters = () => { setFilters({ ...EMPTY_FILTERS, custom: {} }); setSearch(""); };
  const isMobile = useMediaQuery("(max-width: 860px)");
  // ignore saved filters that can't apply here (another project's custom field,
  // someone who isn't in this workspace, a deleted tag)
  const effective = validFilters(filters, {
    memberIds: new Set(members.map((m) => m.id)),
    fieldIds: new Set(customFields.map((f) => f.id)),
    tagIds: new Set(Object.keys(allTags)),
  });
  const { priority: priorityFilter, assignee: assigneeFilter, tag: tagFilter, due: dueFilter, hideDone, showArchived, custom: customFilter } = effective;
  const cfActive = Object.values(customFilter ?? {}).some((v) => v && v !== "all");
  const filterActive = priorityFilter !== "all" || assigneeFilter !== "all" || tagFilter !== "all" || dueFilter !== "all" || hideDone || cfActive;
  const dueOk = (t: Task) => {
    if (dueFilter === "all") return true;
    const ds = dueState(t.dueDate, t.status);
    if (dueFilter === "overdue") return ds === "overdue";
    if (dueFilter === "today") return ds === "today";
    if (dueFilter === "week") {
      if (!t.dueDate) return false;
      const days = Math.round((new Date(t.dueDate + "T00:00:00").getTime() - new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate()).getTime()) / 86400000);
      return days >= 0 && days <= 7;
    }
    return true;
  };
  const q = search.trim().toLowerCase();
  const filtered = (showArchived ? archivedTasks : tasks).filter((t) =>
    (priorityFilter === "all" || t.priority === priorityFilter) &&
    (!hideDone || t.status !== "done") &&
    (assigneeFilter === "all" || t.assigneeId === assigneeFilter) &&
    (tagFilter === "all" || (t.tags || []).includes(tagFilter)) &&
    dueOk(t) &&
    Object.entries(customFilter ?? {}).every(([fid, v]) => { if (!v || v === "all") return true; const cv = (t.custom ?? {})[fid]; return Array.isArray(cv) ? cv.includes(v) : String(cv ?? "") === v; }) &&
    (q === "" || t.title.toLowerCase().includes(q)));
  const narrowed = filterActive || q !== "";
  // filters hide everything: say so (the list view renders its own empty state)
  const hiddenByFilters = narrowed && filtered.length === 0 && (showArchived ? archivedTasks : tasks).length > 0 && view !== "list";

  return (
    <>
      {header}
      <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, padding: isMobile ? "10px 14px" : "12px 24px", borderBottom: "1px solid var(--hairline)", flexShrink: 0, flexWrap: "wrap" }}>
        <Segmented options={VIEW_OPTS} value={view} onChange={setView} ariaLabel="View" />
        {!isMobile && <div style={{ width: 1, height: 22, background: "var(--hairline)" }} />}
        {view === "list" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {!isMobile && <span className="kicker">Group</span>}
            <Segmented options={GROUP_OPTS} value={groupBy} onChange={setGroupBy} ariaLabel="Group by" />
          </div>
        )}
        {/* wraps rather than running off the edge on a narrow window (a focused button out
            there would scroll the whole app sideways) */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: isMobile ? 8 : 10, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0 }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <Icon name="search" size={14} style={{ position: "absolute", left: 10, color: "var(--ink-4)", pointerEvents: "none" }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tasks…" aria-label="Filter tasks by title"
            style={{ width: isMobile ? 120 : 168, height: 34, padding: "0 10px 0 30px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" }} />
          {search && <button onClick={() => setSearch("")} aria-label="Clear search" style={{ position: "absolute", right: 6, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 15, lineHeight: 1 }}>×</button>}
        </div>
        {view === "list" && (
          <div style={{ position: "relative" }}>
            <button onClick={() => setSortOpen((v) => !v)} className="btn" style={{ padding: "8px 11px", border: sort !== "manual" ? "1px solid var(--accent)" : "1px solid var(--hairline)", background: sort !== "manual" ? "var(--accent-dim)" : "transparent", color: sort !== "manual" ? "var(--accent)" : "var(--ink-2)" }}>
              <Icon name="sort" size={15} /> Sort
            </button>
            {sortOpen && (
              <>
                <div onClick={() => setSortOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
                <div className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 31, width: 180, padding: 6, borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
                  {[{ v: "manual", l: "Manual" }, { v: "due", l: "Due date" }, { v: "priority", l: "Priority" }, { v: "title", l: "Name (A–Z)" }].map((o) => (
                    <button key={o.v} onClick={() => { setSort(o.v); setSortOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 9px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: sort === o.v ? "var(--ink)" : "var(--ink-3)", background: sort === o.v ? "var(--surface-2)" : "transparent" }}>
                      <span style={{ width: 13, display: "grid", placeItems: "center" }}>{sort === o.v && <Icon name="check" size={13} style={{ color: "var(--accent)" }} />}</span>{o.l}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <div style={{ position: "relative" }}>
          <button onClick={() => setFilterOpen((v) => !v)} className="btn" style={{ padding: "8px 11px", border: filterActive ? "1px solid var(--accent)" : "1px solid var(--hairline)", background: filterActive ? "var(--accent-dim)" : "transparent", color: filterActive ? "var(--accent)" : "var(--ink-2)" }}>
            <Icon name="filter" size={15} /> Filter{filterActive ? " · on" : ""}
          </button>
          {filterOpen && (
            <>
              <div onClick={() => setFilterOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
              <div className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 31, width: 224, maxHeight: 420, overflowY: "auto", padding: 8, borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
                <div style={{ display: "flex", alignItems: "center", padding: "2px 6px 8px" }}>
                  <span className="kicker">Filters</span>
                  {filterActive && <button onClick={() => setFilters({ ...EMPTY_FILTERS, custom: {} })} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-display)" }}>Clear all</button>}
                </div>

                <FilterSection label="Priority">
                  {PRIORITY_FILTERS.map((p) => <FilterOption key={p.value} label={p.label} active={priorityFilter === p.value} onClick={() => setFilter({ priority: p.value })} />)}
                </FilterSection>

                <FilterSection label="Due">
                  {[{ v: "all", l: "Any time" }, { v: "overdue", l: "Overdue" }, { v: "today", l: "Due today" }, { v: "week", l: "Next 7 days" }].map((d) => <FilterOption key={d.v} label={d.l} active={dueFilter === d.v} onClick={() => setFilter({ due: d.v })} />)}
                </FilterSection>

                {members.length > 1 && (
                  <FilterSection label="Assignee">
                    <FilterOption label="Anyone" active={assigneeFilter === "all"} onClick={() => setFilter({ assignee: "all" })} />
                    {members.map((m) => <FilterOption key={m.id} label={m.name} active={assigneeFilter === m.id} onClick={() => setFilter({ assignee: m.id })} />)}
                  </FilterSection>
                )}

                {Object.keys(allTags).length > 0 && (
                  <FilterSection label="Tag">
                    <FilterOption label="Any tag" active={tagFilter === "all"} onClick={() => setFilter({ tag: "all" })} />
                    {Object.entries(allTags).map(([id, t]) => <FilterOption key={id} label={t.label} dot={t.color} active={tagFilter === id} onClick={() => setFilter({ tag: id })} />)}
                  </FilterSection>
                )}

                {/* custom-field filters (dropdown / people fields) */}
                {customFields.filter((f) => f.type === "dropdown" || f.type === "people" || f.type === "multiselect").map((f) => {
                  const cur = customFilter?.[f.id] ?? "all";
                  const opts = f.type === "people" ? members.map((m) => ({ v: m.id, l: m.name })) : f.options.map((o) => ({ v: o, l: o }));
                  return (
                    <FilterSection key={f.id} label={f.name}>
                      <FilterOption label="Any" active={cur === "all"} onClick={() => setFilter({ custom: { ...(customFilter ?? {}), [f.id]: "all" } })} />
                      {opts.map((o) => <FilterOption key={o.v} label={o.l} active={cur === o.v} onClick={() => setFilter({ custom: { ...(customFilter ?? {}), [f.id]: o.v } })} />)}
                    </FilterSection>
                  );
                })}

                <div className="divider" style={{ margin: "6px 4px" }} />
                <button onClick={() => setFilter({ hideDone: !hideDone })} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: "var(--ink-2)", background: "transparent" }}>
                  <span style={{ width: 16, height: 16, borderRadius: 5, border: `1.5px solid ${hideDone ? "var(--accent)" : "var(--hairline-strong)"}`, background: hideDone ? "var(--accent)" : "transparent", display: "grid", placeItems: "center" }}>{hideDone && <Icon name="check" size={11} sw={3} style={{ color: "var(--on-accent)" }} />}</span>
                  Hide completed
                </button>
                {archivedTasks.length > 0 && (
                  <button onClick={() => setFilter({ showArchived: !showArchived })} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: "var(--ink-2)", background: "transparent" }}>
                    <span style={{ width: 16, height: 16, borderRadius: 5, border: `1.5px solid ${showArchived ? "var(--accent)" : "var(--hairline-strong)"}`, background: showArchived ? "var(--accent)" : "transparent", display: "grid", placeItems: "center" }}>{showArchived && <Icon name="check" size={11} sw={3} style={{ color: "var(--on-accent)" }} />}</span>
                    <Icon name="archive" size={13} style={{ color: "var(--ink-4)" }} /> Show archived <span className="mono" style={{ color: "var(--ink-4)", marginLeft: "auto" }}>{archivedTasks.length}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <button onClick={() => setSmart((v) => !v)} className="btn" style={{
          padding: "8px 12px", border: smart ? "1px solid var(--accent)" : "1px solid var(--hairline)",
          background: smart ? "var(--accent-dim)" : "transparent", color: smart ? "var(--accent)" : "var(--ink-2)", fontWeight: 500,
        }}>
          <Icon name="sparkles" size={15} /> AI sort {smart ? "on" : "off"}
        </button>
        {view === "list" && (
          <button onClick={toggleCompact} className="btn" title={compact ? "Switch to comfortable rows" : "Switch to compact rows"} style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}>
            <Icon name={compact ? "list" : "menu"} size={15} /> {compact ? "Comfortable" : "Compact"}
          </button>
        )}
        {!isMobile && (
          <>
            <button onClick={() => exportTasksCsv(filtered, exportName, exportOpts)} className="btn" title="Export these tasks to CSV" style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}><Icon name="arrowUpRight" size={15} /> CSV</button>
            <button onClick={() => printTasks(filtered, "Tasks export")} className="btn" title="Export these tasks to PDF (print)" style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}><Icon name="arrowUpRight" size={15} /> PDF</button>
            {onOpenImport && !readOnly && <button onClick={onOpenImport} className="btn" title="Import tasks (paste a list or upload a file)" style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}><Icon name="plus" size={15} /> Import</button>}
          </>
        )}
        </div>
      </div>
      {(view === "list" || view === "board") && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: isMobile ? "8px 14px" : "8px 24px", flexWrap: "wrap", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
          <span className="kicker" style={{ marginRight: 2 }}>Quick</span>
          {[
            { label: "Overdue", active: dueFilter === "overdue", on: () => setFilter({ due: dueFilter === "overdue" ? "all" : "overdue" }) },
            { label: "Today", active: dueFilter === "today", on: () => setFilter({ due: dueFilter === "today" ? "all" : "today" }) },
            { label: "This week", active: dueFilter === "week", on: () => setFilter({ due: dueFilter === "week" ? "all" : "week" }) },
            { label: "High priority", active: priorityFilter === "high", on: () => setFilter({ priority: priorityFilter === "high" ? "all" : "high" }) },
            { label: "Urgent", active: priorityFilter === "urgent", on: () => setFilter({ priority: priorityFilter === "urgent" ? "all" : "urgent" }) },
            { label: "Hide done", active: hideDone, on: () => setFilter({ hideDone: !hideDone }) },
          ].map((c) => (
            <button key={c.label} onClick={c.on} style={{ padding: "4px 11px", borderRadius: 99, cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500, border: `1px solid ${c.active ? "var(--accent)" : "var(--hairline)"}`, background: c.active ? "var(--accent-dim)" : "transparent", color: c.active ? "var(--accent)" : "var(--ink-3)" }}>{c.label}</button>
          ))}
          {filterActive && <button onClick={() => setFilters({ ...EMPTY_FILTERS, custom: {} })} style={{ marginLeft: 4, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-display)" }}>Clear</button>}
        </div>
      )}
      {hiddenByFilters && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 10, margin: isMobile ? "10px 14px 0" : "12px 24px 0", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--hairline)", background: "var(--fill-1, var(--surface-2))", flexShrink: 0 }}>
          <Icon name="filter" size={15} style={{ color: "var(--ink-4)", flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>No tasks match {q !== "" ? `“${search.trim()}”` : "these filters"}.</span>
          <button onClick={clearFilters} className="btn btn-ghost" style={{ padding: "4px 11px", fontSize: 12.5 }}>Clear filters</button>
        </div>
      )}
      {view === "list" && <ListView tasks={filtered} allTasks={allTasks} projects={projects} compact={compact} onOpen={onOpen} onToggle={onToggle} onToggleSubtask={onToggleSubtask} groupBy={groupBy} smart={smart} sort={sort} onBulkPatch={onBulkPatch} onBulkDelete={onBulkDelete} onPatch={onPatch} onQuickAdd={onQuickAdd} onOpenImport={onOpenImport} members={members} sections={sections} onCreateSection={onCreateSection} onRenameSection={onRenameSection} onDeleteSection={onDeleteSection} customFields={customFields} sectionField={sectionField} sectionProjectId={sectionProjectId}
        filtered={narrowed || showArchived} onClearFilters={clearFilters} readOnly={readOnly} />}
      {view === "board" && <BoardView tasks={filtered} allTasks={allTasks} onOpen={onOpen} onAdd={onAdd} onMove={onMove} onPatch={onPatch} onBulkPatch={onBulkPatch} onBulkDelete={onBulkDelete} members={members} customFields={customFields} readOnly={readOnly} scopeKey={boardScope} />}
      {view === "timeline" && <TimelineView tasks={filtered} allTasks={allTasks} onOpen={onOpen} onPatch={onPatch} readOnly={readOnly} />}
      {view === "calendar" && <CalendarView tasks={filtered} onOpen={onOpen} onPatch={onPatch} readOnly={readOnly} />}
      {view === "files" && <FilesView tasks={filtered} onOpen={onOpen} />}
      {view === "matrix" && <MatrixView tasks={filtered} onOpen={onOpen} />}
    </>
  );
}
