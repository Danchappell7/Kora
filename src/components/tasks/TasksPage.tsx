/* ============================================================
   KANBO — the tasks page: My tasks (Open · Waiting on · Done, saved
   views) and a project's tasks (List · Board · Timeline · Calendar ·
   More, then the project's own tabs). One 44px row carries the tabs
   and every tool: the view menu, a title filter, Filter (quick
   presets + fields), Display (group, sort, density, done) and ⋯
   (export, import, advanced search). Active filters show as pills on
   one quiet line underneath.
   ============================================================ */
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, type ReactNode } from "react";
import { Icon, Avatar, Segmented, Tabs, Button, IconButton, StatusGlyph, ProjectDot, projectPaint, EmptyState, Toggle, type TabItem } from "../primitives";
import { Popover } from "../primitives/Popover";
import { ListView, type ListGroup } from "./ListView";
import { BoardView, TimelineView, CalendarView, FilesView, MatrixView, type BoardGroup } from "./OtherViews";
import { exportTasksCsv, printTasks, type TaskExportOptions } from "../../lib/exportTasks";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { readFilters, validFilters, filtersKey, EMPTY_FILTERS, type TaskFilters } from "../../lib/taskOps";
import { bucketOpen, bucketWaiting, bucketDone, doneToday, dueFocusGroup, firstNameOf, type TaskBucket } from "../../lib/myTaskBuckets";
import { dueState, getMember, KANBO_TODAY, STATUS_META, STATUS_ORDER, PRIORITY_META } from "../../data/data";
import type { Task, Project, Status, TagDef, Section, CustomFieldDef, IconName } from "../../data/types";
import type { TaskView, GroupBy } from "../../app-types";
import { dueDateForBucket } from "./ListView";
import "./taskViews.css";

const VIEWS: { id: TaskView; label: string; icon: IconName }[] = [
  { id: "list", label: "List", icon: "list" },
  { id: "board", label: "Board", icon: "board" },
  { id: "timeline", label: "Timeline", icon: "timeline" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "matrix", label: "Matrix", icon: "grid" },
];
const isTaskView = (s: string | undefined): s is TaskView => !!s && VIEWS.some((v) => v.id === s);
const MORE_VIEWS: TaskView[] = ["files", "matrix"];

const GROUPS: { id: GroupBy; label: string }[] = [
  { id: "due", label: "Due" }, { id: "status", label: "Status" }, { id: "section", label: "Section" },
  { id: "priority", label: "Priority" }, { id: "project", label: "Project" }, { id: "none", label: "None" },
];
const SORTS: { id: string; label: string }[] = [
  { id: "manual", label: "Manual" }, { id: "due", label: "Due" }, { id: "priority", label: "Priority" }, { id: "title", label: "Name" },
];
const BOARD_GROUPS: { id: BoardGroup; label: string }[] = [
  { id: "status", label: "Status" }, { id: "priority", label: "Priority" }, { id: "project", label: "Project" }, { id: "assignee", label: "Assignee" },
];
const DUE_LABEL: Record<string, string> = { overdue: "Overdue", today: "Due today", week: "Next 7 days" };
const MY_GROUP_KEY = "kanbo-groupby-my";
const BOARD_GROUP_KEY = "kanbo-board-group";

/** The page's filters: today's per-page filters plus status and section (kept in the same saved record). */
type PageFilters = TaskFilters & { status?: string; section?: string };

const readLocal = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLocal = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/** A toggle chip (Filter presets, field values, Display choices). */
function Chip({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return <button type="button" className="ktv-chip" aria-pressed={on} aria-label={label} onClick={onClick}>{children}</button>;
}
function PopSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="ktv-pop-sec" role="group" aria-label={title}>
      <h4>{title}{note && <small>{note}</small>}</h4>
      {children}
    </div>
  );
}

export function TasksPage({ tasks, allTasks, projects = [], view, setView, groupBy, setGroupBy, smart, setSmart, onOpen, onToggle, onToggleSubtask, onAdd, onMove, onBulkPatch, onBulkDelete, onPatch, onQuickAdd, onOpenImport, members, allTags, archivedTasks = [], header, sections = [], onCreateSection, onRenameSection, onDeleteSection, customFields = [], sectionField = "sectionId", sectionProjectId, filterScope = "my", readOnly = false, boardScope, exportName = "my-tasks", exportOpts,
  tab: tabProp, onTab, extraTabs, renderExtra, notice, dueFocus, currentUserId, savedViews, onOpenSavedView, onSaveView, onNudge, onAdvancedSearch, onManageTags, density: densityProp, onDensity, loading = false }: {
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
  /** legacy: a block above the tabs row (the old project header) */
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
  /** My tasks: open · waiting · done. A project: a view (list, board…) or one of `extraTabs`. */
  tab?: string;
  onTab?: (id: string) => void;
  /** a project's own tabs after the views: Updates · Requests · Rules · About */
  extraTabs?: TabItem[];
  renderExtra?: (tab: string) => React.ReactNode;
  /** one 32px line under the tabs row (a project's risk / update line) */
  notice?: React.ReactNode;
  /** My tasks ?due=…: scroll to and flash that group */
  dueFocus?: "today" | "overdue" | "week";
  currentUserId?: string;
  savedViews?: { id: string; name: string; count: number }[];
  onOpenSavedView?: (id: string) => void;
  /** name, and the view as a search query (text, status, priority, assignee, tag, due) */
  onSaveView?: (name: string, query?: Record<string, string>) => void;
  /** Waiting on: nudge whoever has the task */
  onNudge?: (taskId: string) => void;
  onAdvancedSearch?: () => void;
  /** Filter › Manage tags… */
  onManageTags?: () => void;
  /** row density (Appearance); without it the page keeps its own */
  density?: "comfortable" | "compact";
  onDensity?: (d: "comfortable" | "compact") => void;
  /** tasks are still arriving: skeleton rows */
  loading?: boolean;
}) {
  const isMy = filterScope === "my";
  const isMobile = useMediaQuery("(max-width: 860px)");

  /* ---------------- tabs ---------------- */
  const [localTab, setLocalTab] = useState<string>(() => (isMy ? "open" : view));
  const rawTab = tabProp ?? localTab;
  const myTab = isMy ? (rawTab === "waiting" || rawTab === "done" ? rawTab : "open") : "open";
  const extraIds = new Set((extraTabs ?? []).map((t) => t.id));
  const extraActive = !isMy && extraIds.has(rawTab) && !!renderExtra;
  // a project's tab names the view it shows (a deep link to /p/:id/board wins over the last one used)
  const shownView: TaskView = !isMy && isTaskView(rawTab) ? rawTab : view;

  /* ---------------- per-page state ---------------- */
  const [myGroup, setMyGroupState] = useState<GroupBy>(() => {
    const s = readLocal(MY_GROUP_KEY) as GroupBy | null;
    return s && GROUPS.some((g) => g.id === s) ? s : "due";
  });
  const setMyGroup = (g: GroupBy) => { setMyGroupState(g); writeLocal(MY_GROUP_KEY, g); };
  const group = isMy ? myGroup : groupBy;
  const setGroup = isMy ? setMyGroup : setGroupBy;
  const [boardGroup, setBoardGroupState] = useState<BoardGroup>(() => {
    const s = readLocal(BOARD_GROUP_KEY) as BoardGroup | null;
    return s && BOARD_GROUPS.some((g) => g.id === s) ? s : "status";
  });
  const setBoardGroup = (g: BoardGroup) => { setBoardGroupState(g); writeLocal(BOARD_GROUP_KEY, g); };
  const [localDensity, setLocalDensity] = useState<"comfortable" | "compact">(() => (readLocal("kanbo-density") === "compact" ? "compact" : "comfortable"));
  const density = densityProp ?? localDensity;
  const setDensity = (d: "comfortable" | "compact") => {
    if (onDensity) { onDensity(d); return; }
    setLocalDensity(d);
    writeLocal("kanbo-density", d);
    // the same switch as Settings › Appearance: every list follows at once
    try { document.documentElement.setAttribute("data-density", d); } catch { /* no DOM */ }
  };
  const [sort, setSort] = useState<string>(() => readLocal("kanbo-sort") || "manual");
  useEffect(() => { writeLocal("kanbo-sort", sort); }, [sort]);

  // The page is keyed by route, so the title filter starts empty on every
  // project / My tasks switch. Filters persist per route (not app-wide), so a
  // filter set in one project can never hide every task in another.
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<PageFilters>(() => readFilters(filterScope));
  useEffect(() => { writeLocal(filtersKey(filterScope), JSON.stringify({ ...filters, showArchived: false })); }, [filters, filterScope]);
  const setFilter = (patch: Partial<PageFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const clearFilters = () => { setFilters({ ...EMPTY_FILTERS, custom: {} }); setSearch(""); };
  // ignore saved filters that can't apply here (another project's custom field,
  // someone who isn't in this workspace, a deleted tag or section)
  const valid = validFilters(filters, {
    memberIds: new Set(members.map((m) => m.id)),
    fieldIds: new Set(customFields.map((f) => f.id)),
    tagIds: new Set(Object.keys(allTags)),
  }) as PageFilters;
  const statusFilter = valid.status && (valid.status === "all" || valid.status in STATUS_META) ? valid.status : "all";
  const sectionFilter = valid.section && (valid.section === "all" || valid.section === "__none" || sections.some((s) => s.id === valid.section)) ? valid.section : "all";
  const { priority: priorityFilter, assignee: assigneeFilter, tag: tagFilter, due: dueFilter, hideDone, showArchived, custom: customFilter } = valid;
  const cfActive = Object.values(customFilter ?? {}).some((v) => v && v !== "all");
  const q = search.trim().toLowerCase();

  /* ---------------- the filter ---------------- */
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
  const passes = (t: Task, ignoreDone = false) =>
    (priorityFilter === "all" || t.priority === priorityFilter) &&
    (statusFilter === "all" || t.status === statusFilter) &&
    (ignoreDone || !hideDone || t.status !== "done") &&
    (assigneeFilter === "all" || t.assigneeId === assigneeFilter) &&
    (tagFilter === "all" || (t.tags || []).includes(tagFilter)) &&
    (sectionFilter === "all" || (sectionFilter === "__none" ? !t[sectionField] : t[sectionField] === sectionFilter)) &&
    dueOk(t) &&
    Object.entries(customFilter ?? {}).every(([fid, v]) => { if (!v || v === "all") return true; const cv = (t.custom ?? {})[fid]; return Array.isArray(cv) ? cv.includes(v) : String(cv ?? "") === v; }) &&
    (q === "" || t.title.toLowerCase().includes(q));
  const activeCount = [priorityFilter !== "all", statusFilter !== "all", assigneeFilter !== "all", tagFilter !== "all", sectionFilter !== "all", dueFilter !== "all", hideDone, !!showArchived]
    .filter(Boolean).length + Object.values(customFilter ?? {}).filter((v) => v && v !== "all").length;
  const filterActive = activeCount > 0 || cfActive;
  const narrowed = filterActive || q !== "";

  /* ---------------- what each tab shows ---------------- */
  const me = currentUserId ?? "";
  const source = showArchived ? archivedTasks : tasks;
  const waiting = useMemo(() => (isMy ? bucketWaiting(allTasks, me) : null), [isMy, allTasks, me]);
  const done = useMemo(() => (isMy ? bucketDone(allTasks.filter((t) => !t.archivedAt), me || "\u0000", 30) : null), [isMy, allTasks, me]);
  const [showOlder, setShowOlder] = useState(false);

  const keep = (list: TaskBucket[], ignoreDone = false): TaskBucket[] =>
    list.map((g) => ({ ...g, items: g.items.filter((t) => passes(t, ignoreDone)) })).filter((g) => g.items.length > 0);

  let shownTasks: Task[];
  let listGroups: ListGroup[] | undefined;
  if (!isMy) {
    shownTasks = source.filter((t) => passes(t));
  } else if (myTab === "waiting") {
    listGroups = keep(waiting?.groups ?? []).map((g) => ({ ...g, addable: false }));
    shownTasks = listGroups.flatMap((g) => g.items);
  } else if (myTab === "done") {
    const all = [...(done?.groups ?? []), ...(showOlder ? done?.older ?? [] : [])];
    listGroups = keep(all, true).map((g) => ({ ...g, addable: false }));
    shownTasks = listGroups.flatMap((g) => g.items);
  } else {
    const openMine = source.filter((t) => t.status !== "done" && passes(t));
    const finished = showArchived || hideDone ? [] : doneToday(source).filter((t) => passes(t));
    shownTasks = [...openMine, ...finished];
    if (group === "due" && !showArchived) {
      listGroups = [
        ...bucketOpen(openMine).map((b) => { const d = dueDateForBucket(b.key); return { ...b, addPatch: d ? { dueDate: d } : {} }; }),
        ...(finished.length ? [{ key: "done-today", label: "Done today", items: finished, addable: false }] : []),
      ];
    }
  }
  const openCount = isMy ? tasks.filter((t) => t.status !== "done").length : 0;
  const waitingCount = waiting ? waiting.groups.reduce((n, g) => n + g.items.length, 0) : 0;

  /* ---------------- the toolbar row ---------------- */
  // The row folds its tools (the title field moves into Filter, labels become icons)
  // only when the tabs and the full set of tools can't share it — a project's nine
  // tabs at 1280, a tablet with the task panel open, phones — so no tab is ever pushed
  // out of sight behind the tools.
  const barRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLDivElement>(null);
  const fullToolsW = useRef(0);
  // 0: everything · 1: the title field folds into Filter · 2: and the tools become icons
  const [fold, setFold] = useState<0 | 1 | 2>(0);
  const foldRef = useRef(fold);
  foldRef.current = fold;
  const fit = useCallback(() => {
    const bar = barRef.current;
    if (!bar || !bar.clientWidth) return; // not laid out (tests, hidden)
    const tools = toolsRef.current;
    if (foldRef.current === 0 && tools) fullToolsW.current = tools.offsetWidth + (saveRef.current?.offsetWidth ?? 0);
    const list = bar.querySelector<HTMLElement>(".ktabs-list");
    const cs = window.getComputedStyle(bar);
    const room = bar.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    const tabsW = (list?.scrollWidth ?? 0) + 24;
    const full = fullToolsW.current || (isMy ? 580 : 460);
    const without = full - 208; // the 200px title field and its gap
    // a little slack on the way back, so the row doesn't flicker at a boundary
    const slack = (level: 0 | 1 | 2) => (foldRef.current > level ? 16 : 0);
    const next: 0 | 1 | 2 = tabsW + full + slack(0) <= room ? 0 : tabsW + without + slack(1) <= room ? 1 : 2;
    if (next !== foldRef.current) setFold(next);
  }, [isMy]);
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  /** the title field lives in the Filter popover */
  const compactBar = fold >= 1 || isMobile;
  /** Filter and Display are icon buttons */
  const iconTools = fold >= 2 || isMobile;

  const [menu, setMenu] = useState<null | "view" | "more" | "filter" | "display" | "actions">(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const viewBtn = useRef<HTMLButtonElement>(null);
  const moreTab = useRef<HTMLElement | null>(null);
  const filterBtn = useRef<HTMLButtonElement>(null);
  const displayBtn = useRef<HTMLButtonElement>(null);
  const actionsBtn = useRef<HTMLButtonElement>(null);

  const pickView = (v: TaskView) => {
    setMenu(null);
    setView(v);
    if (!isMy) { setLocalTab(v); onTab?.(v); }
  };
  const tabItems: TabItem[] = isMy
    ? [
        { id: "open", label: "Open", count: openCount },
        { id: "waiting", label: "Waiting on", count: waitingCount || undefined },
        { id: "done", label: "Done" },
        ...(savedViews ?? []).slice(0, 4).map((s) => ({ id: `view:${s.id}`, label: s.name, count: s.count, secondary: true })),
      ]
    : [
        ...VIEWS.filter((v) => !MORE_VIEWS.includes(v.id)).map((v) => ({ id: v.id, label: v.label })),
        { id: "more", label: MORE_VIEWS.includes(shownView) ? VIEWS.find((v) => v.id === shownView)!.label : "More" },
        ...(extraTabs ?? []).map((t) => ({ ...t, secondary: true })),
      ];
  const tabValue = isMy ? myTab : extraActive ? rawTab : MORE_VIEWS.includes(shownView) ? "more" : shownView;
  const rowKey = tabItems.map((t) => `${t.id}:${t.label}:${t.count ?? ""}`).join("|");
  const onTabChange = (id: string) => {
    if (id === "more") return; // its menu opens on click (below), never on arrow-key focus
    if (id.startsWith("view:")) { onOpenSavedView?.(id.slice(5)); return; }
    if (!isMy && isTaskView(id)) setView(id);
    setLocalTab(id);
    onTab?.(id);
  };

  // save the current filters as a view (named inline, no prompt)
  const [saving, setSaving] = useState<string | null>(null);
  const saveView = () => {
    const name = (saving ?? "").trim();
    setSaving(null);
    if (!name || !onSaveView) return;
    onSaveView(name, {
      text: search.trim(),
      status: statusFilter !== "all" ? statusFilter : myTab === "done" ? "done" : "open",
      priority: priorityFilter,
      assignee: assigneeFilter !== "all" ? assigneeFilter : me || "all",
      tag: tagFilter,
      due: dueFilter,
      projectId: "all",
    });
  };

  const saveControl = isMy && onSaveView && !readOnly && (narrowed || saving !== null) ? (
    <div ref={saveRef} className="ktv-save">
      {saving === null ? (
        <Button variant="ghost" size="sm" icon="plus" onClick={() => setSaving("")}>Save view</Button>
      ) : (
        // eslint-disable-next-line jsx-a11y/no-autofocus
        <input autoFocus className="ktv-save-field" value={saving} onChange={(e) => setSaving(e.target.value)} placeholder="Name this view, then Enter" aria-label="Name this view"
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") saveView(); else if (e.key === "Escape") setSaving(null); }}
          onBlur={() => { if (!(saving ?? "").trim()) setSaving(null); }} />
      )}
    </div>
  ) : null;

  useLayoutEffect(() => { fit(); }, [fit, rowKey, extraActive, saving, isMobile]);

  const findField = (wide: boolean) => (
    <div className="ktv-find" data-wide={wide || undefined}>
      <Icon name="search" size={14} sw={1.75} />
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter…" aria-label="Filter tasks by title"
        onKeyDown={(e) => { if (e.key === "Escape" && search) { e.stopPropagation(); setSearch(""); } }} />
      {search && <button type="button" className="ktv-find-clear" onClick={() => setSearch("")} aria-label="Clear search"><Icon name="x" size={14} sw={1.75} /></button>}
    </div>
  );
  const filterLabel = filterActive ? `Filter · on, ${activeCount || 1} active` : "Filter";
  const currentView = VIEWS.find((v) => v.id === shownView) ?? VIEWS[0];
  const exportList = shownTasks;

  const tools = !extraActive && (
    <div ref={toolsRef} className="ktv-tools">
      {isMy && (iconTools
        ? <IconButton ref={viewBtn} icon={currentView.icon} size="sm" label={`View: ${currentView.label}`} onClick={() => setMenu((m) => (m === "view" ? null : "view"))} aria-haspopup="menu" aria-expanded={menu === "view"} />
        : <Button ref={viewBtn} variant="secondary" size="sm" icon={currentView.icon} iconRight="chevronDown" onClick={() => setMenu((m) => (m === "view" ? null : "view"))} aria-haspopup="menu" aria-expanded={menu === "view"} aria-label={`View: ${currentView.label}`}>{currentView.label}</Button>)}
      {!compactBar && findField(false)}
      {iconTools
        ? <IconButton ref={filterBtn} icon="filter" size="sm" label={filterLabel} badge={filterActive ? activeCount || true : undefined} pressed={filterActive || undefined} onClick={() => setMenu((m) => (m === "filter" ? null : "filter"))} aria-haspopup="dialog" aria-expanded={menu === "filter"} />
        : (
          <Button ref={filterBtn} variant="ghost" size="sm" icon="filter" data-on={filterActive || undefined} aria-label={filterLabel}
            onClick={() => setMenu((m) => (m === "filter" ? null : "filter"))} aria-haspopup="dialog" aria-expanded={menu === "filter"}>
            Filter{filterActive && <span className="ktv-count" aria-hidden="true">{activeCount || 1}</span>}
          </Button>
        )}
      {iconTools
        ? <IconButton ref={displayBtn} icon="sliders" size="sm" label="Display" onClick={() => setMenu((m) => (m === "display" ? null : "display"))} aria-haspopup="dialog" aria-expanded={menu === "display"} />
        : <Button ref={displayBtn} variant="ghost" size="sm" icon="sliders" onClick={() => setMenu((m) => (m === "display" ? null : "display"))} aria-haspopup="dialog" aria-expanded={menu === "display"}>Display</Button>}
      <IconButton ref={actionsBtn} icon="more" size="sm" label="More actions" onClick={() => setMenu((m) => (m === "actions" ? null : "actions"))} aria-haspopup="menu" aria-expanded={menu === "actions"} />
    </div>
  );

  /* ---------------- active-filter pills ---------------- */
  const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? getMember(id)?.name ?? "Someone";
  const pills: { key: string; label: string; clear: () => void }[] = [];
  if (compactBar && q) pills.push({ key: "q", label: `“${search.trim()}”`, clear: () => setSearch("") });
  if (statusFilter !== "all") pills.push({ key: "status", label: STATUS_META[statusFilter as Status].label, clear: () => setFilter({ status: "all" }) });
  if (priorityFilter !== "all") pills.push({ key: "priority", label: `${PRIORITY_META[priorityFilter as keyof typeof PRIORITY_META]?.label ?? priorityFilter} priority`, clear: () => setFilter({ priority: "all" }) });
  if (dueFilter !== "all") pills.push({ key: "due", label: DUE_LABEL[dueFilter] ?? dueFilter, clear: () => setFilter({ due: "all" }) });
  if (assigneeFilter !== "all") pills.push({ key: "assignee", label: memberName(assigneeFilter), clear: () => setFilter({ assignee: "all" }) });
  if (tagFilter !== "all") pills.push({ key: "tag", label: allTags[tagFilter]?.label ?? tagFilter, clear: () => setFilter({ tag: "all" }) });
  if (sectionFilter !== "all") pills.push({ key: "section", label: sectionFilter === "__none" ? "No section" : sections.find((s) => s.id === sectionFilter)?.name ?? "Section", clear: () => setFilter({ section: "all" }) });
  for (const [fid, v] of Object.entries(customFilter ?? {})) {
    if (!v || v === "all") continue;
    const f = customFields.find((x) => x.id === fid);
    pills.push({ key: `cf:${fid}`, label: `${f?.name ?? "Field"}: ${f?.type === "people" ? memberName(v) : v}`, clear: () => setFilter({ custom: { ...(customFilter ?? {}), [fid]: "all" } }) });
  }
  if (hideDone && !(isMy && myTab === "done")) pills.push({ key: "hideDone", label: "Hiding done", clear: () => setFilter({ hideDone: false }) });
  if (showArchived) pills.push({ key: "archived", label: "Showing archived", clear: () => setFilter({ showArchived: false }) });

  /* ---------------- the popovers ---------------- */
  const presetChips = [
    { label: "Overdue", on: dueFilter === "overdue", toggle: () => setFilter({ due: dueFilter === "overdue" ? "all" : "overdue" }) },
    { label: "Today", on: dueFilter === "today", toggle: () => setFilter({ due: dueFilter === "today" ? "all" : "today" }) },
    { label: "This week", on: dueFilter === "week", toggle: () => setFilter({ due: dueFilter === "week" ? "all" : "week" }) },
    { label: "High priority", on: priorityFilter === "high", toggle: () => setFilter({ priority: priorityFilter === "high" ? "all" : "high" }) },
    { label: "Urgent", on: priorityFilter === "urgent", toggle: () => setFilter({ priority: priorityFilter === "urgent" ? "all" : "urgent" }) },
    { label: "Hide done", on: hideDone, toggle: () => setFilter({ hideDone: !hideDone }) },
  ];
  const one = (cur: string, v: string) => (cur === v ? "all" : v);
  const filterPanel = (
    <div className="ktv-pop" style={{ width: 320, maxWidth: "100%" }}>
      {compactBar && findField(true)}
      <PopSection title="Quick filters">
        <div className="ktv-chips">{presetChips.map((c) => <Chip key={c.label} on={c.on} onClick={c.toggle}>{c.label}</Chip>)}</div>
      </PopSection>
      {!(isMy && myTab === "done") && (
        <PopSection title="Status">
          <div className="ktv-chips">
            {STATUS_ORDER.map((s) => (
              <Chip key={s} on={statusFilter === s} onClick={() => setFilter({ status: one(statusFilter, s) })}>
                <StatusGlyph status={s} size={14} readOnly /><span>{STATUS_META[s].label}</span>
              </Chip>
            ))}
          </div>
        </PopSection>
      )}
      <PopSection title="Priority">
        <div className="ktv-chips">
          {(["urgent", "high", "medium", "low"] as const).map((p) => <Chip key={p} on={priorityFilter === p} onClick={() => setFilter({ priority: one(priorityFilter, p) })}>{PRIORITY_META[p].label}</Chip>)}
        </div>
      </PopSection>
      {members.length > 1 && (
        <PopSection title="Assignee">
          <div className="ktv-chips">
            {members.map((m) => (
              <Chip key={m.id} on={assigneeFilter === m.id} onClick={() => setFilter({ assignee: one(assigneeFilter, m.id) })}>
                <Avatar id={m.id} size={16} /><span>{m.id === currentUserId ? "Me" : m.name.split(/\s+/)[0]}</span>
              </Chip>
            ))}
          </div>
        </PopSection>
      )}
      {Object.keys(allTags).length > 0 && (
        <PopSection title="Tags">
          <div className="ktv-chips">
            {Object.entries(allTags).map(([id, t]) => (
              <Chip key={id} on={tagFilter === id} onClick={() => setFilter({ tag: one(tagFilter, id) })}>
                <span className="ktv-dot" style={{ background: projectPaint(t.color).solid }} /><span>{t.label}</span>
              </Chip>
            ))}
          </div>
        </PopSection>
      )}
      {sections.length > 0 && (
        <PopSection title="Section">
          <div className="ktv-chips">
            {[...sections].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((s) => <Chip key={s.id} on={sectionFilter === s.id} onClick={() => setFilter({ section: one(sectionFilter, s.id) })}><span>{s.name}</span></Chip>)}
            <Chip on={sectionFilter === "__none"} onClick={() => setFilter({ section: one(sectionFilter, "__none") })}>No section</Chip>
          </div>
        </PopSection>
      )}
      {customFields.filter((f) => f.type === "dropdown" || f.type === "people" || f.type === "multiselect").map((f) => {
        const cur = customFilter?.[f.id] ?? "all";
        const opts = f.type === "people" ? members.map((m) => ({ v: m.id, l: m.name })) : f.options.map((o) => ({ v: o, l: o }));
        return (
          <PopSection key={f.id} title={f.name}>
            <div className="ktv-chips">
              {opts.map((o) => <Chip key={o.v} on={cur === o.v} onClick={() => setFilter({ custom: { ...(customFilter ?? {}), [f.id]: one(cur, o.v) } })}><span>{o.l}</span></Chip>)}
            </div>
          </PopSection>
        );
      })}
      {(archivedTasks.length > 0 || showArchived) && (
        <Toggle checked={!!showArchived} onChange={(v) => setFilter({ showArchived: v })} label={`Show archived (${archivedTasks.length})`} />
      )}
      {isMy && (
        <PopSection title="Scope">
          <div className="ktv-chips">
            <Chip on onClick={() => {}}>This workspace</Chip>
            {onOpenSavedView && <Chip on={false} onClick={() => { setMenu(null); onOpenSavedView("mine"); }}>All workspaces</Chip>}
          </div>
        </PopSection>
      )}
      <div className="ktv-pop-foot">
        {onManageTags && <Button variant="ghost" size="sm" icon="settings" onClick={() => { setMenu(null); onManageTags(); }}>Manage tags…</Button>}
        {(filterActive || q) && <Button variant="ghost" size="sm" onClick={clearFilters}>Clear all</Button>}
      </div>
    </div>
  );

  const groupNote = isMy && myTab === "waiting" ? "by person" : isMy && myTab === "done" ? "by day" : undefined;
  const displayPanel = (
    <div className="ktv-pop" style={{ width: 280, maxWidth: "100%" }}>
      {shownView === "list" && (
        <>
          <PopSection title="Group" note={groupNote}>
            {groupNote ? null : (
              <div className="ktv-chips">
                {GROUPS.filter((g) => g.id !== "section" || sections.length > 0 || !isMy).map((g) => <Chip key={g.id} on={group === g.id} onClick={() => setGroup(g.id)}>{g.label}</Chip>)}
              </div>
            )}
          </PopSection>
          <PopSection title="Sort">
            <div className="ktv-chips">
              {SORTS.map((s) => <Chip key={s.id} on={!smart && sort === s.id} onClick={() => { setSmart(false); setSort(s.id); }}>{s.label}</Chip>)}
              <Chip on={smart} onClick={() => setSmart((v) => !v)} label="Kanbo's order">Kanbo's order</Chip>
            </div>
          </PopSection>
          <PopSection title="Density">
            <Segmented ariaLabel="Density" value={density} onChange={setDensity}
              options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
          </PopSection>
        </>
      )}
      {shownView === "board" && (
        <PopSection title="Columns">
          <div className="ktv-chips">{BOARD_GROUPS.map((g) => <Chip key={g.id} on={boardGroup === g.id} onClick={() => setBoardGroup(g.id)}>{g.label}</Chip>)}</div>
        </PopSection>
      )}
      {!(isMy && myTab === "done") && (
        <Toggle checked={!hideDone} onChange={(v) => setFilter({ hideDone: !v })} label="Show done"
          description={isMy && myTab === "open" ? "What you finished today stays at the bottom." : undefined} />
      )}
    </div>
  );

  /* ---------------- the views ---------------- */
  const nudged = useRef(new Set<string>());
  const [, bump] = useState(0);
  const waitingMeta = (t: Task): ReactNode => {
    const r = waiting?.reasons.get(t.id);
    if (!r) return null;
    return r.kind === "with"
      ? <span className="ktv-with">with <b>{firstNameOf(r.personId)}</b></span>
      : <span className="ktv-with" title={`Waiting on “${r.blocker}” (${firstNameOf(r.personId)})`}>needs <b>“{r.blocker}”</b></span>;
  };
  const waitingAction = (t: Task): ReactNode => {
    const r = waiting?.reasons.get(t.id);
    if (!r || !onNudge || readOnly) return null;
    const target = r.kind === "needs" && r.blockerId ? r.blockerId : t.id;
    const sent = nudged.current.has(target);
    return (
      <Button variant="ghost" size="sm" icon={sent ? "check" : "send"} disabled={sent}
        aria-label={sent ? `Nudged ${firstNameOf(r.personId)}` : `Nudge ${firstNameOf(r.personId)} about “${r.kind === "needs" ? r.blocker : t.title}”`}
        onClick={() => { onNudge(target); nudged.current.add(target); bump((n) => n + 1); }}>
        {sent ? "Nudged" : "Nudge"}
      </Button>
    );
  };

  const emptyOpen = isMy && myTab === "open" && !loading && !narrowed && !showArchived && tasks.every((t) => t.status === "done") ? (
    <div className="ktv-empty">
      <EmptyState art="tasks" title="You're all clear" body="Nothing open on your plate. Add what's next, or bring in a list."
        action={!readOnly && (
          <>
            <Button variant="primary" icon="plus" onClick={() => onAdd("todo")}>New task</Button>
            {onOpenImport && <Button variant="ghost" onClick={onOpenImport}>Import tasks</Button>}
          </>
        )} />
    </div>
  ) : null;
  const emptyWaiting = <div className="ktv-empty"><EmptyState art="users" title="Nothing waiting on others" body="Tasks you create for teammates show up here." /></div>;
  const emptyDone = <div className="ktv-empty"><EmptyState art="tasks" title="Nothing finished in the last 30 days" body={done?.olderCount ? undefined : "Tasks you complete show up here, by day."}
    action={done?.olderCount && !showOlder ? <Button variant="secondary" onClick={() => setShowOlder(true)}>Show older ({done.olderCount})</Button> : undefined} /></div>;
  const doneFooter = isMy && myTab === "done" && done && done.olderCount > 0 && done.groups.length > 0 ? (
    <button type="button" className="ktv-more" style={{ marginTop: 8 }} onClick={() => setShowOlder((v) => !v)} aria-expanded={showOlder}>
      <Icon name="chevronDown" size={14} style={{ transform: showOlder ? "rotate(180deg)" : undefined }} /> {showOlder ? "Hide older" : `Show older (${done.olderCount})`}
    </button>
  ) : null;

  // filters hide everything: say so (the list view renders its own empty state)
  const hiddenByFilters = narrowed && shownTasks.length === 0 && source.length > 0 && shownView !== "list";
  const listEmpty = isMy ? (myTab === "waiting" ? emptyWaiting : myTab === "done" ? emptyDone : emptyOpen ?? undefined) : undefined;

  const skeleton = (
    <div className="ktv-scroll ktv-skel" aria-busy="true" aria-label="Loading tasks">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="ktv-skel-row"><i /><i style={{ width: `${[46, 38, 52, 30, 44, 36, 48, 34][i]}%` }} /><i style={{ width: 64, marginLeft: "auto" }} /></div>
      ))}
    </div>
  );

  let body: ReactNode;
  if (extraActive) body = <div className="ktv-scroll">{renderExtra!(rawTab)}</div>;
  else if (loading) body = skeleton;
  else if (isMy && myTab === "open" && emptyOpen && shownView === "list") body = <div className="ktv-scroll">{emptyOpen}</div>;
  else if (shownView === "list") {
    body = (
      <ListView tasks={shownTasks} allTasks={allTasks} projects={projects} compact={density === "compact"} onOpen={onOpen} onToggle={onToggle} onToggleSubtask={onToggleSubtask}
        groupBy={group} smart={smart} sort={sort} onBulkPatch={onBulkPatch} onBulkDelete={onBulkDelete} onPatch={onPatch} onQuickAdd={onQuickAdd} onOpenImport={onOpenImport}
        members={members} sections={sections} onCreateSection={onCreateSection} onRenameSection={onRenameSection} onDeleteSection={onDeleteSection} customFields={customFields}
        sectionField={sectionField} sectionProjectId={sectionProjectId} filtered={narrowed || !!showArchived} onClearFilters={clearFilters} readOnly={readOnly}
        groups={listGroups} showProject={isMy} quietAssigneeFor={isMy && myTab !== "waiting" ? currentUserId : undefined}
        renderMeta={isMy && myTab === "waiting" ? waitingMeta : undefined} renderAction={isMy && myTab === "waiting" ? waitingAction : undefined}
        focusGroup={isMy && myTab === "open" && group === "due" ? dueFocusGroup(dueFocus) : undefined} focusKey={dueFocus}
        emptyState={listEmpty} footer={doneFooter} allTags={allTags} label={isMy ? `My tasks: ${myTab === "open" ? "Open" : myTab === "waiting" ? "Waiting on" : "Done"}` : "Tasks"} />
    );
  } else {
    body = (
      <>
        {hiddenByFilters && (
          <div role="status" className="ktv-filtered">
            <Icon name="filter" size={16} sw={1.75} />
            <span>No tasks match {q !== "" ? `“${search.trim()}”` : "these filters"}.</span>
            <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>
          </div>
        )}
        {shownView === "board" && <BoardView tasks={shownTasks} allTasks={allTasks} onOpen={onOpen} onAdd={onAdd} onMove={onMove} onPatch={onPatch} onBulkPatch={onBulkPatch} onBulkDelete={onBulkDelete}
          members={members} customFields={customFields} readOnly={readOnly} scopeKey={boardScope} group={boardGroup} onGroupChange={setBoardGroup} showProject={isMy} onToggle={onToggle} />}
        {shownView === "timeline" && <TimelineView tasks={shownTasks} allTasks={allTasks} onOpen={onOpen} onPatch={onPatch} readOnly={readOnly} />}
        {shownView === "calendar" && <CalendarView tasks={shownTasks} onOpen={onOpen} onPatch={onPatch} readOnly={readOnly} />}
        {shownView === "files" && <FilesView tasks={shownTasks} onOpen={onOpen} />}
        {shownView === "matrix" && <MatrixView tasks={shownTasks} onOpen={onOpen} />}
      </>
    );
  }

  return (
    <div className="ktv ktv-page">
      {header}
      <div ref={barRef} className="ktv-bar"
        onClick={(e) => {
          // "More ▾" opens its menu on click (and on Enter/Space, which click a button)
          const more = (e.target as HTMLElement).closest<HTMLElement>('[data-tab-id="more"]');
          if (more) { moreTab.current = more; setMenu((m) => (m === "more" ? null : "more")); }
        }}>
        <Tabs items={tabItems} value={tabValue} onChange={onTabChange} label={isMy ? "My tasks" : "Project views"} />
        {!compactBar && saveControl}
        {tools}
      </div>
      {pills.length > 0 && !extraActive && (
        <div className="ktv-pills" role="group" aria-label="Active filters">
          {pills.map((p) => (
            <button key={p.key} type="button" className="kpill" data-tone="accent" onClick={p.clear} aria-label={`Remove filter: ${p.label}`}>
              {p.label}<Icon name="x" size={12} sw={2} />
            </button>
          ))}
          <button type="button" className="ktv-pills-clear" onClick={clearFilters}>Clear filters</button>
          {compactBar && saveControl}
        </div>
      )}
      {notice && !extraActive && <div className="ktv-notice">{notice}</div>}
      {body}

      {menu === "view" && (
        <Popover open anchorRef={viewBtn} onClose={closeMenu} label="View" minWidth={200}>
          {VIEWS.filter((v) => !MORE_VIEWS.includes(v.id)).map((v) => (
            <button key={v.id} type="button" role="menuitemradio" aria-checked={shownView === v.id} className="ktv-mi" onClick={() => pickView(v.id)}>
              <Icon name={v.icon} size={16} sw={1.75} /> {v.label}{shownView === v.id && <span className="ktv-mi-end"><Icon name="check" size={14} sw={2.2} /></span>}
            </button>
          ))}
          <div className="ktv-msep" role="separator" />
          <div className="ktv-mlabel" aria-hidden="true">More</div>
          {VIEWS.filter((v) => MORE_VIEWS.includes(v.id)).map((v) => (
            <button key={v.id} type="button" role="menuitemradio" aria-checked={shownView === v.id} className="ktv-mi" onClick={() => pickView(v.id)}>
              <Icon name={v.icon} size={16} sw={1.75} /> {v.label}{shownView === v.id && <span className="ktv-mi-end"><Icon name="check" size={14} sw={2.2} /></span>}
            </button>
          ))}
        </Popover>
      )}
      {menu === "more" && (
        <Popover open anchorRef={moreTab} onClose={closeMenu} label="More views" minWidth={180}>
          {VIEWS.filter((v) => MORE_VIEWS.includes(v.id)).map((v) => (
            <button key={v.id} type="button" role="menuitemradio" aria-checked={shownView === v.id && !extraActive} className="ktv-mi" onClick={() => pickView(v.id)}>
              <Icon name={v.icon} size={16} sw={1.75} /> {v.label}{shownView === v.id && !extraActive && <span className="ktv-mi-end"><Icon name="check" size={14} sw={2.2} /></span>}
            </button>
          ))}
        </Popover>
      )}
      {menu === "filter" && (
        <Popover open anchorRef={filterBtn} onClose={closeMenu} role="dialog" label="Filter" align="end" minWidth={0} maxHeight={560}>
          {filterPanel}
        </Popover>
      )}
      {menu === "display" && (
        <Popover open anchorRef={displayBtn} onClose={closeMenu} role="dialog" label="Display" align="end" minWidth={0}>
          {displayPanel}
        </Popover>
      )}
      {menu === "actions" && (
        <Popover open anchorRef={actionsBtn} onClose={closeMenu} label="More actions" align="end" minWidth={220}>
          <button type="button" role="menuitem" className="ktv-mi" onClick={() => { closeMenu(); exportTasksCsv(exportList, exportName, exportOpts); }}>
            <Icon name="arrowUpRight" size={16} sw={1.75} /> Export CSV
          </button>
          <button type="button" role="menuitem" className="ktv-mi" onClick={() => { closeMenu(); printTasks(exportList, isMy ? "My tasks" : exportName); }}>
            <Icon name="arrowUpRight" size={16} sw={1.75} /> Export PDF
          </button>
          {((onOpenImport && !readOnly) || onAdvancedSearch) && <div className="ktv-msep" role="separator" />}
          {onOpenImport && !readOnly && (
            <button type="button" role="menuitem" className="ktv-mi" onClick={() => { closeMenu(); onOpenImport(); }}>
              <Icon name="plus" size={16} sw={1.75} /> Import tasks…
            </button>
          )}
          {onAdvancedSearch && (
            <button type="button" role="menuitem" className="ktv-mi" onClick={() => { closeMenu(); onAdvancedSearch(); }}>
              <Icon name="search" size={16} sw={1.75} /> Advanced search…
            </button>
          )}
        </Popover>
      )}
    </div>
  );
}
