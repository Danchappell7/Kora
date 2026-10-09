/* ============================================================
   KANBO — Search: everything, from one box. Tasks, comments, docs,
   projects and people; type plainly ("Maya's overdue tasks in Launch",
   "docs mentioning pricing", "blocked this week") and the names,
   projects, statuses and dates are read as filters — tinted in the
   box, listed as chips you can remove — and the rest is searched for.
   What the app holds answers at once (offline and in demo mode too);
   the server's full-text search (search_all, which only ever returns
   what you can see) follows a moment later and is merged in.
   Results come grouped (Tasks, Comments, Docs, Projects, People) with
   the matching words marked. Tasks are the same 36px rows as My tasks
   (the status glyph is the completion checkbox; bulk actions, CSV and
   PDF as before); the other kinds are the Inbox's two-line rows.
   Nothing typed: recent searches and ways to ask. The smart lists and
   saved searches open here too, with the filters panel showing what
   they apply. Keys: ↓ from the box into the results, ↑ / ↓ through
   every group (↑ from the first goes back), Home / End, Esc back to
   the box (Esc in the box clears it); J / K move a cursor, X selects,
   Enter opens, ⌘↵ completes.
   ============================================================ */
import { useMemo, useState, useEffect, useRef, useId, useCallback } from "react";
import { Icon, Avatar, StatusGlyph, PriorityGlyph, DateChip, ProjectTile, EmptyState, Button, IconButton, Kbd } from "../primitives";
import { getProject, getMember, fmtDue, STATUS_META, PRIORITY_META, toLocalISO, presetDate, todayISO } from "../../data/data";
import { exportTasksCsv, printTasks } from "../../lib/exportTasks";
import { hasSearchText, inArchivedProject } from "../../lib/searchQuery";
import { smartListById } from "../../lib/smartLists";
import { removeChipFromInput, todayIn, type SearchNLContext } from "../../lib/searchNL";
import {
  mergeSearchHits, titleTier, recentSearches, rememberSearch, forgetRecentSearch, forgetRecentSearches,
  SEARCH_GROUPS, SEARCH_LIMIT_MAX, SEARCH_VIEW_LIMIT, type LocalSearchInput,
} from "../../lib/searchApi";
import {
  EMPTY_PANEL, panelActive, panelCount, panelsEqual, resolveSearch, localTaskMatches, searchFromPreset, searchFromViewQuery,
  searchToViewQuery, toLegacyQuery, suggestSearchName, type SearchPanel,
} from "../../lib/search/searchSpec";
import { useUniversalSearch, localReasonText } from "../../lib/search/useUniversalSearch";
import { useDemoCorpus } from "../../lib/search/demoCorpus";
import { useTextHighlights } from "../../lib/search/useTextHighlights";
import { makeSnippet } from "../../lib/search/highlight";
import { splitHighlights } from "../../lib/searchRows";
import { supabase } from "../../lib/supabase";
import { useListKeyboard } from "../../hooks/useListKeyboard";
import { useTaskDragSource } from "../../lib/dnd";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useEntrance } from "../../hooks/useEntrance";
import { SaveViewButton } from "./SavedViewEditor";
import {
  SearchBox, SearchChips, FiltersPanel, HitRow, SearchStart, Highlighted, HighlightTitle, withCurrent,
  type Opt, type PanelField,
} from "../search/SearchParts";
import type { Task, Project, SavedSearch, Status, Priority, CustomFieldDef, Comment, SavedView, SavedViewQuery, SearchHit, SearchHitKind, Member } from "../../data/types";
import type { Route } from "../../app-types";
import "../tasks/taskViews.css";
import "../search/search.css";

/** task rows rendered at once; the count, "Select all" and exports say so */
const DISPLAY_CAP = 200;
/** with several kinds on screen, each group shows a few and offers the rest */
const PREVIEW: Record<SearchHitKind, number> = { task: 8, comment: 4, doc: 4, project: 4, person: 4 };
const FILTERS_OPEN_KEY = "kanbo-search-filters-open";
/** the device's Tasks are listed here in full (localTaskMatches); localSearch answers for the rest */
const NOT_TASKS: SearchHitKind[] = ["comment", "doc", "project", "person"];

/** primary pointer is a mouse/trackpad (not a touchscreen) */
const finePointer = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const unknownLabel = (v: string) => `${v.charAt(0).toUpperCase()}${v.slice(1)} (unknown)`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const KIND_WORDS: Record<SearchHitKind, [string, string]> = {
  task: ["task", "tasks"], comment: ["comment", "comments"], doc: ["doc", "docs"], project: ["project", "projects"], person: ["person", "people"],
};
const readFiltersPref = (): boolean | null => {
  try { const v = window.localStorage.getItem(FILTERS_OPEN_KEY); return v === "1" ? true : v === "0" ? false : null; } catch { return null; }
};

export interface SearchViewProps {
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
  /** for the CSV export's Section and custom-field columns (same as the List toolbar's export) */
  sections?: { id: string; name: string }[];
  customFields?: CustomFieldDef[];
  /** ticks a result off (or back on) from its status glyph; without it the glyph only shows the status */
  onToggle?: (id: string) => void;
  /** the task open in the task panel: its row stays marked */
  activeId?: string;

  /* ---- 0048: universal search (all optional) ---- */
  /** a saved search view to open (with presetKey = its id) */
  presetView?: SavedViewQuery;
  /** the workspace you're in; and the ones you can search (Filters › Search in) */
  workspaceId?: string | null;
  workspaces?: { id: string | null; name: string }[];
  /** comments the app has loaded; docs it knows (titles, and their text when on hand) */
  comments?: Comment[];
  docs?: LocalSearchInput["docs"];
  onOpenDoc?: (docId: string, projectId: string) => void;
  onOpenProject?: (projectId: string) => void;
  onOpenPerson?: (userId: string) => void;
  /** a comment: its task, at the comment (default: onOpen(taskId)) */
  onOpenComment?: (taskId: string, commentId: string) => void;
  /** go anywhere: what opens a doc, project or person when their own handler isn't given */
  onGo?: (route: Route) => void;
  /** save as a view (lib/views) instead of the old saved search */
  views?: { workspaceId: string | null; workspaceName?: string; canShare: boolean; onSaved?: (v: SavedView) => void };
  /** the person's timezone for "today", "friday"… (default: the device's day) */
  timezone?: string;
  /** also search the demo docs' text and the demo comments (default: when there's no server) */
  demoCorpus?: boolean;
  /** ask search_all (default: when a server is configured) */
  serverSearch?: boolean;
  /** read-only here (guests): task rows aren't drag sources (the bulk bar and task panel stay the non-drag way) */
  readOnly?: boolean;
}

export function SearchView(props: SearchViewProps) {
  const {
    tasks, projects, members, currentUserId, onOpen, savedSearches, onSaveSearch, onDeleteSavedSearch, preset, presetKey, onBulkPatch,
    onBulkDelete, sections, customFields, onToggle, activeId, presetView, workspaces, comments, docs, onOpenDoc, onOpenProject, onOpenPerson,
    onOpenComment, onGo, views, timezone,
  } = props;
  const uid = currentUserId ?? "";
  const entrance = useEntrance(presetKey);
  const isMobile = useMediaQuery("(max-width: 860px)");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelId = useId(), helpId = useId(), resultsId = useId(), saveHintId = useId();

  // the day relative words count from: the device's day (as the sidebar counts), or the person's timezone
  const today = timezone ? todayIn(new Date(), timezone) : todayISO();
  const everyone = useMemo<Member[]>(() => members.map((m) => getMember(m.id) ?? { id: m.id, name: m.name, email: "", type: "team", color: "" }), [members]);
  const nlCtx = useMemo<SearchNLContext>(() => ({
    members: members.filter((m) => m.name),
    // live projects first: "in launch" means the live one when an archived one shares the word
    projects: [...projects.filter((p) => !p.archivedAt), ...projects.filter((p) => p.archivedAt)],
    currentUserId: uid, today, timezone,
  }), [members, projects, uid, today, timezone]);

  /* ---------------- state: the words, the panel ---------------- */
  const presetKeyJSON = JSON.stringify(presetView ?? preset ?? null);
  // an old saved search's words stay words; words handed over from ⌘K ("See all results") are read as typed
  const fromSavedSearch = !!presetKey && savedSearches.some((s) => s.id === presetKey);
  const presetSearch = useMemo(() => (presetView ? searchFromViewQuery(presetView, nlCtx)
    : preset ? searchFromPreset(preset, nlCtx, { literal: fromSavedSearch }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [presetKeyJSON, fromSavedSearch]);
  const [input, setInput] = useState(presetSearch?.input ?? "");
  const [panel, setPanel] = useState<SearchPanel>(presetSearch?.panel ?? EMPTY_PANEL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  const reset = useCallback(() => { setInput(""); setPanel(EMPTY_PANEL); }, []);
  // apply a smart-list / saved-search preset when selected (or when its content changes, e.g. the signed-in
  // user resolves); reset on plain Search so a stale filter doesn't linger. A preset that merely disappears
  // under the same key (you deleted the saved search you're on) keeps the current search on screen.
  const lastPresetKey = useRef(presetKey);
  useEffect(() => {
    const keyChanged = lastPresetKey.current !== presetKey;
    lastPresetKey.current = presetKey;
    if (presetSearch) { setInput(presetSearch.input); setPanel(presetSearch.panel); }
    else if (keyChanged) reset();
  }, [presetKey, presetSearch, reset]);
  // the cursor goes in the box only for a plain Search on a mouse/trackpad device; a smart list (or a phone)
  // shows results instead of throwing the keyboard over them
  useEffect(() => {
    if (preset || presetView) return;
    if (finePointer()) inputRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetKey]);
  const setP = (patch: Partial<SearchPanel>) => setPanel((p) => ({ ...p, ...patch }));

  /* ---------------- what it means ---------------- */
  const resolved = useMemo(() => resolveSearch(input, panel, nlCtx, today), [input, panel, nlCtx, today]);
  const { parsed, text } = resolved;
  const active = resolved.active;
  useEffect(() => { clearSel(); }, [input, panel, presetKey]);

  /* ---------------- the device's answer: tasks (complete), the rest through localSearch ---------------- */
  const projectById = useMemo(() => { const m = new Map(projects.map((p) => [p.id, p])); return (id: string) => m.get(id) ?? getProject(id); }, [projects]);
  const { taskHits, hiddenArchived } = useMemo(() => {
    if (!active || !resolved.kinds.includes("task")) return { taskHits: [] as Task[], hiddenArchived: 0 };
    // one pass with archived included: the default view drops those, and offers them as a one-click widen
    const wide = localTaskMatches(tasks, { ...resolved, filters: { ...resolved.filters, includeArchived: true } }, projectById);
    const hits = resolved.filters.includeArchived ? wide : wide.filter((t) => !t.archivedAt && !inArchivedProject(t) && !projectById(t.projectId)?.archivedAt);
    if (!hasSearchText(text)) return { taskHits: hits, hiddenArchived: wide.length - hits.length };
    // words: best title matches first, open work above finished, stable otherwise
    const ranked = hits.map((t, i) => ({ t, i, tier: titleTier(t.title, text), done: t.status === "done" ? 1 : 0 }))
      .sort((a, b) => b.tier - a.tier || a.done - b.done || a.i - b.i).map((x) => x.t);
    return { taskHits: ranked, hiddenArchived: wide.length - hits.length };
    // projects: archiving/restoring one changes what matches without touching tasks
  }, [tasks, resolved, active, text, projectById]);

  const corpus = useDemoCorpus(props.demoCorpus ?? !supabase, useMemo(() => projects.map((p) => p.id), [projects]), useMemo(() => tasks.map((t) => t.id), [tasks]));
  const allComments = useMemo(() => dedupe([...(comments ?? []), ...(corpus?.comments ?? [])]), [comments, corpus]);
  const allDocs = useMemo(() => dedupe([...(docs ?? []), ...(corpus?.docs ?? [])]), [docs, corpus]);
  const openable = (k: SearchHitKind) => k === "task" || k === "comment" || (k === "doc" ? !!(onOpenDoc || onGo) : k === "project" ? !!(onOpenProject || onGo) : !!(onOpenPerson || onGo));
  const singleKind = resolved.kinds.length === 1 ? resolved.kinds[0] : null;
  const limit = singleKind && singleKind !== "task" ? SEARCH_LIMIT_MAX : SEARCH_VIEW_LIMIT;
  const search = useUniversalSearch({
    active, text, filters: resolved.filters, limit, debounceMs: 200, server: props.serverSearch, localKinds: NOT_TASKS,
    local: { tasks, projects, members: everyone, comments: allComments, docs: allDocs, currentUserId: uid },
  });

  // server-only task matches (found by stem: "prices" → "pricing") join the device's, if they still pass here
  const serverTasks = useMemo(() => (search.server ?? []).filter((h) => h.kind === "task"), [search.server]);
  const taskRows = useMemo<{ task: Task; snippet: string | null }[]>(() => {
    if (!active || !resolved.kinds.includes("task")) return [];
    const snippets = new Map(serverTasks.map((h) => [h.id, h.snippet]));
    const rows = taskHits.map((t) => ({ task: t, snippet: snippets.get(t.id) ?? (hasSearchText(text) ? makeSnippet(t.description, text) : null) }));
    const have = new Set(taskHits.map((t) => t.id));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const h of serverTasks) {
      if (have.has(h.id)) continue;
      const t = byId.get(h.id);
      if (!t) continue;    // not loaded here (yet): its row would have nothing live to show
      const passes = localTaskMatches([t], { ...resolved, text: "", active: true }, projectById).length === 1;
      if (passes) { rows.push({ task: t, snippet: h.snippet }); have.add(h.id); }
    }
    return rows;
  }, [active, resolved, taskHits, serverTasks, tasks, text, projectById]);
  const matchedTasks = useMemo(() => taskRows.map((r) => r.task), [taskRows]);

  const others = useMemo(() => {
    if (!active) return [] as SearchHit[];
    const local = search.local.filter((h) => h.kind !== "task");
    const server = (search.server ?? []).filter((h) => h.kind !== "task");
    return mergeSearchHits(local, server, { text, limitPerKind: limit }).filter((h) => resolved.kinds.includes(h.kind) && openable(h.kind));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, search.local, search.server, text, limit, resolved.kinds, onOpenDoc, onOpenProject, onOpenPerson, onGo]);

  const counts = useMemo(() => {
    const c: Record<SearchHitKind, number> = { task: matchedTasks.length, comment: 0, doc: 0, project: 0, person: 0 };
    for (const h of others) c[h.kind] += 1;
    return c;
  }, [matchedTasks, others]);
  const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
  const kindsWithHits = SEARCH_GROUPS.filter((g) => counts[g.kind] > 0).map((g) => g.kind);
  const fullGroup = (k: SearchHitKind) => singleKind === k || kindsWithHits.length === 1;
  const results = matchedTasks.slice(0, fullGroup("task") ? DISPLAY_CAP : PREVIEW.task);   // task rows rendered
  const capped = fullGroup("task") && matchedTasks.length > results.length;
  const selectedVisible = results.filter((t) => selected.has(t.id));
  const bulk = !!(onBulkPatch || onBulkDelete);

  /* ---------------- presets, context line ---------------- */
  const smart = smartListById(presetKey);
  const saved = !smart && presetKey ? savedSearches.find((s) => s.id === presetKey) : undefined;
  const presetName = smart?.label ?? saved?.name;
  const onPreset = !!presetSearch && input.trim() === presetSearch.input.trim() && panelsEqual(panel, presetSearch.panel);
  // one-click cross-project presets: My tasks is personal; the "All …" chips are the team-wide views
  const quick: { label: string; panel: Partial<SearchPanel> }[] = [
    ...(uid ? [{ label: "Assigned to me", panel: { assignee: uid, status: "open" } }] : []),
    ...(uid ? [{ label: "My work this week", panel: { assignee: uid, due: "week", status: "open" } }] : []),
    { label: "All due today", panel: { due: "today" } },
    { label: "All due this week", panel: { due: "week", status: "open" } },
    { label: "All overdue", panel: { due: "overdue" } },
    { label: "Urgent", panel: { priority: "urgent", status: "open" } },
  ];

  /* ---------------- the filters panel ---------------- */
  const [filtersPref, setFiltersPref] = useState<boolean | null>(readFiltersPref);
  const filtersOpen = filtersPref ?? panelActive(panel);
  const toggleFilters = () => {
    const next = !filtersOpen;
    setFiltersPref(next);
    try { window.localStorage.setItem(FILTERS_OPEN_KEY, next ? "1" : "0"); } catch { /* per-device nicety only */ }
  };
  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => t.tags || []))].sort((a, b) => a.localeCompare(b)), [tasks]);
  const hasArchived = projects.some((p) => p.archivedAt) || tasks.some((t) => t.archivedAt);
  const memberName = (id: string) => getMember(id)?.name || members.find((m) => m.id === id)?.name || (id === uid ? "You" : "Unknown member");
  const people = members.map((m) => ({ value: m.id, label: m.id === uid ? `${m.name} (you)` : m.name }));
  // the workspace you're in comes first
  const teamSpaces = (workspaces ?? []).filter((w) => w.id !== null)
    .sort((a, b) => (a.id === props.workspaceId ? -1 : b.id === props.workspaceId ? 1 : 0));
  const fields: PanelField[] = [
    ...(teamSpaces.length > 0 ? [{
      key: "scope", title: "Search in", label: "Search in", anyLabel: "Everywhere", value: panel.scope,
      options: withCurrent([
        ...teamSpaces.map((w) => ({ value: w.id as string, label: w.id === props.workspaceId ? `${w.name} (this workspace)` : w.name })),
        { value: "personal", label: props.workspaceId === null ? "Personal (this workspace)" : "Personal" },
      ], panel.scope, () => "A workspace you've left"),
      onChange: (v: string) => setP({ scope: v }),
    }] : []),
    { key: "status", title: "Status", label: "Filter by status", anyLabel: "Any status", value: panel.status,
      options: withCurrent([{ value: "open", label: "Open (not done)" }, ...(Object.keys(STATUS_META) as Status[]).map((s) => ({ value: s, label: STATUS_META[s].label }))], panel.status, unknownLabel),
      onChange: (v) => setP({ status: v }) },
    { key: "priority", title: "Priority", label: "Filter by priority", anyLabel: "Any priority", value: panel.priority,
      options: withCurrent((["urgent", "high", "medium", "low"] as Priority[]).map((p) => ({ value: p, label: PRIORITY_META[p].label })), panel.priority, unknownLabel),
      onChange: (v) => setP({ priority: v }) },
    { key: "assignee", title: "Assignee", label: "Filter by assignee or collaborator", anyLabel: "Anyone", value: panel.assignee,
      options: withCurrent(people, panel.assignee, memberName), onChange: (v) => setP({ assignee: v }) },
    { key: "project", title: "Project", label: "Filter by project", anyLabel: "Any project", value: panel.projectId,
      options: withCurrent([
        ...projects.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: p.name })),
        ...projects.filter((p) => p.archivedAt && (panel.includeArchived || p.id === panel.projectId)).map((p) => ({ value: p.id, label: p.name, group: "Archived projects" })),
      ] as Opt[], panel.projectId, (id) => getProject(id)?.name || "Unknown project"),
      onChange: (v) => setP({ projectId: v }) },
    ...((allTags.length > 0 || panel.tag !== "all") ? [{ key: "tag", title: "Tag", label: "Filter by tag", anyLabel: "Any tag", value: panel.tag,
      options: withCurrent(allTags.map((t) => ({ value: t, label: t })), panel.tag, (t) => t), onChange: (v: string) => setP({ tag: v }) }] : []),
    { key: "due", title: "Due", label: "Filter by due date", anyLabel: "Any due date", value: panel.due,
      options: withCurrent([
        { value: "today", label: "Due today" }, { value: "week", label: "Due this week" }, { value: "overdue", label: "Overdue" },
        { value: "has", label: "Has a due date" }, { value: "none", label: "No due date" },
      ], panel.due, unknownLabel),
      onChange: (v) => setP({ due: v }) },
    { key: "author", title: "Comments by", label: "Filter comments by author", anyLabel: "Anyone", value: panel.author,
      options: withCurrent(people, panel.author, memberName), onChange: (v) => setP({ author: v }) },
  ];

  /* ---------------- recent searches ---------------- */
  const [recents, setRecents] = useState<string[]>(() => recentSearches(uid));
  useEffect(() => { setRecents(recentSearches(uid)); }, [uid]);
  const remember = (t = input) => { if (!hasSearchText(t)) return; rememberSearch(uid, t); setRecents(recentSearches(uid)); };
  const teammate = members.find((m) => m.id !== uid && m.name)?.name.split(/\s+/)[0];
  const liveProject = projects.find((p) => !p.archivedAt && p.workspaceId)?.name ?? projects.find((p) => !p.archivedAt)?.name;
  const examples = [
    "Assigned to me due Friday",
    teammate ? `${teammate}'s overdue tasks` : "Overdue tasks",
    "Blocked this week",
    "Docs mentioning pricing",
    liveProject ? `Due next week in ${liveProject}` : "Comments about the launch",
  ];

  /* ---------------- opening ---------------- */
  const openHit = (h: SearchHit) => {
    remember();
    if (h.kind === "task") onOpen(h.id);
    else if (h.kind === "comment" && h.taskId) (onOpenComment ? onOpenComment(h.taskId, h.id) : onOpen(h.taskId));
    else if (h.kind === "doc" && h.projectId) (onOpenDoc ? onOpenDoc(h.id, h.projectId) : onGo?.({ view: "project", projectId: h.projectId, tab: "docs", docId: h.id }));
    else if (h.kind === "project") (onOpenProject ? onOpenProject(h.id) : onGo?.({ view: "project", projectId: h.id }));
    else if (h.kind === "person") (onOpenPerson ? onOpenPerson(h.id) : onGo?.({ view: "team" }));
  };
  const openTask = (id: string) => { remember(); onOpen(id); };
  const hitByRowId = (rowId: string) => others.find((h) => `${h.kind}:${h.id}` === rowId);
  const openRow = (rowId: string) => { const h = hitByRowId(rowId); if (h) openHit(h); else openTask(rowId); };

  /* ---------------- saving ---------------- */
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => { if (!active) setSaving(null); }, [active]);
  const suggested = suggestSearchName(resolved);
  const saveNow = () => {
    const name = (saving ?? "").trim();
    if (!name) return;
    onSaveSearch(name, toLegacyQuery(input, panel, nlCtx, today));
    remember();
    setSaving(null);
  };

  // the words, painted over the titles in the results (excerpts carry their own <mark>s)
  useTextHighlights(listRef, active ? text : "");

  /* ---------------- keys ---------------- */
  const resultButtons = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-search-result]") ?? []);
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") { const first = resultButtons()[0]; if (first) { e.preventDefault(); first.focus(); } }
    else if (e.key === "Escape" && input) { e.preventDefault(); e.stopPropagation(); setInput(""); }
    else if (e.key === "Enter") {
      remember();
      // results are already live; on a phone the "Search" key just puts the keyboard away so they can be seen
      if (!finePointer()) e.currentTarget.blur();
    }
  };
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      const i = resultButtons().indexOf(document.activeElement as HTMLButtonElement);
      if (i >= 0 && selectedVisible.length === 0) { e.preventDefault(); inputRef.current?.focus(); }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const btns = resultButtons();
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === "Home") btns[0]?.focus();
    else if (e.key === "End") btns[btns.length - 1]?.focus();
    else if (e.key === "ArrowDown") btns[Math.min(i + 1, btns.length - 1)]?.focus();
    else if (i === 0) inputRef.current?.focus();
    else btns[i - 1]?.focus();
  };
  // J / K through every result (↑ ↓ keep their own path back to the box), X selects tasks, ⌘↵ completes one
  const isTaskRow = (id: string) => !id.includes(":");
  const kb = useListKeyboard({
    rootRef: listRef, itemSelector: "[data-row-id]", idOf: (el) => el.dataset.rowId,
    focusTargetOf: (el) => el.querySelector<HTMLElement>("[data-search-result]"),
    onOpen: openRow,
    onComplete: onToggle ? (id) => { if (isTaskRow(id)) onToggle(id); } : undefined,
    onToggleSelect: bulk ? (id) => { if (isTaskRow(id)) toggleSel(id); } : undefined,
    onClear: clearSel,
    enabled: active && total > 0,
  });

  /* ---------------- the kind switcher ---------------- */
  const kindChip = parsed.chips.find((c) => c.kind === "kind");
  const showValue: "all" | SearchHitKind = kindChip ? (kindChip.patch.kinds?.length === 1 ? kindChip.patch.kinds[0] : "all") : panel.kind;
  const pickKind = (k: "all" | SearchHitKind) => {
    if (kindChip) setInput(removeChipFromInput(parsed, kindChip.id));
    setP({ kind: k });
  };

  /* ---------------- words ---------------- */
  const n = matchedTasks.length;
  const exportScope = n === 1 ? "this task" : `all ${n} tasks`;
  const doneKey = isMac() ? "⌘↵" : "Ctrl ↵";
  const spans = useMemo(() => Object.values(parsed.spans).flat(), [parsed]);
  const breakdown = kindsWithHits.length > 1 ? `: ${kindsWithHits.map((k) => plural(counts[k], ...KIND_WORDS[k])).join(", ")}` : "";
  const statusText = !active ? "Type or pick a filter to search"
    : `${plural(total, "result", "results")}${breakdown}${capped ? ` · showing first ${results.length}` : ""}`;
  const reasonText = active ? localReasonText(search.reason) : null;
  const searching = active && search.phase === "searching";
  const panelN = panelCount(panel);

  return (
    <div className="ktv ktv-search ksr">
      <div className="ktv-search-in">
        <SearchBox value={input} onChange={setInput} onKeyDown={onInputKey} spans={spans} inputRef={inputRef}
          label="Search tasks" placeholder="Search tasks, comments, docs, projects and people…" busy={searching}
          onClear={() => { setInput(""); inputRef.current?.focus(); }} describedBy={helpId} controls={resultsId} />
        <span id={helpId} className="sr-only">
          Type words to search for. Names, projects, statuses and dates, such as “Maya's overdue tasks in Launch”, become filters you can remove.
          Press the down arrow to move into the results.
        </span>

        <SearchChips chips={parsed.chips} onRemove={(id) => { setInput(removeChipFromInput(parsed, id)); inputRef.current?.focus({ preventScroll: true }); }}
          onClearAll={() => setInput(parsed.text)} />

        {presetName && presetSearch && (
          <div className="ktv-search-ctx">
            <Icon name={smart?.icon ?? "filter"} size={14} sw={1.75} />
            <span style={{ minWidth: 0 }}>
              <strong>{presetName}</strong>
              {onPreset ? (smart ? ` · ${smart.description}` : " · Saved search") : " · Filters changed"}
            </span>
            {!onPreset && <Button variant="ghost" size="sm" onClick={() => { setInput(presetSearch.input); setPanel(presetSearch.panel); }}>Reset to {presetName}</Button>}
          </div>
        )}

        <div className="ktv-search-row ksr-quick" role="group" aria-label="Quick searches">
          {quick.map((p) => {
            const target = { ...EMPTY_PANEL, ...p.panel };
            const on = !input.trim() && panelsEqual(panel, target);
            return <button key={p.label} type="button" className="ktv-chip" aria-pressed={on} onClick={() => { setInput(""); setPanel(on ? EMPTY_PANEL : target); }}>{p.label}</button>;
          })}
        </div>

        <div className="ksr-bar">
          <div className="kseg ksr-kinds" role="group" aria-label="Show">
            {(["all", ...SEARCH_GROUPS.map((g) => g.kind)] as ("all" | SearchHitKind)[]).map((k) => {
              const label = k === "all" ? "All" : SEARCH_GROUPS.find((g) => g.kind === k)!.label;
              const count = k === "all" ? null : active && resolved.kinds.includes(k) ? counts[k] : null;
              return (
                <button key={k} type="button" className="kseg-btn" data-active={showValue === k} aria-pressed={showValue === k} onClick={() => pickKind(k)}>
                  {label}
                  {count ? <span className="ksr-segn">{count}{(k !== "task" && count >= limit) ? "+" : ""}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="ksr-bar-end">
            <Button variant="ghost" size="sm" icon="sliders" className="ksr-filters-btn" aria-expanded={filtersOpen} aria-controls={panelId} onClick={toggleFilters}>
              Filters{panelN > 0 && <><span className="ksr-count" aria-hidden="true">{panelN}</span><span className="sr-only">, {panelN} on</span></>}
            </Button>
          </div>
        </div>

        {filtersOpen && (
          <FiltersPanel id={panelId} fields={fields}
            archived={hasArchived || panel.includeArchived ? { on: panel.includeArchived, onToggle: () => setP({ includeArchived: !panel.includeArchived }) } : null}
            onReset={panelN > 0 || panel.kind !== "all" ? () => setPanel(EMPTY_PANEL) : undefined} />
        )}

        {savedSearches.length > 0 && (
          <div className="ktv-search-row" role="group" aria-label="Saved searches">
            <span className="ktv-mlabel">Saved</span>
            {savedSearches.map((s) => {
              const sq = searchFromPreset(s.query, nlCtx);
              const on = input.trim() === sq.input.trim() && panelsEqual(panel, sq.panel);
              return (
                <span key={s.id} className="ktv-saved" data-on={on || undefined}>
                  <button type="button" aria-pressed={on} onClick={() => { setInput(sq.input); setPanel(sq.panel); }}>{s.name}</button>
                  <button type="button" onClick={() => onDeleteSavedSearch(s.id)} aria-label={`Delete saved search ${s.name}`} title="Delete saved search"><Icon name="x" size={12} sw={2} /></button>
                </span>
              );
            })}
          </div>
        )}

        <div className="ktv-search-status">
          <span role="status" aria-live="polite" aria-atomic="true">{statusText}</span>
          {searching && <span className="ksr-note" aria-hidden="true"><span className="ksr-dots"><i /><i /><i /></span>Searching everything…</span>}
          {reasonText && <span className="ksr-note"><Icon name={search.reason === "offline" ? "alert" : "eye"} size={13} sw={1.75} />{reasonText}</span>}
          {hiddenArchived > 0 && (
            <Button variant="ghost" size="sm" icon="archive" onClick={() => setP({ includeArchived: true })}>
              {hiddenArchived === 1 ? "Show 1 archived task" : `Show ${hiddenArchived} archived tasks`}
            </Button>
          )}
          {active && (
            <span className="ktv-search-actions">
              {views ? (
                <SaveViewButton kind="search" query={searchToViewQuery(input, panel)} active={active} workspaceId={views.workspaceId}
                  workspaceName={views.workspaceName} canShare={views.canShare} suggestedName={suggested} size="sm" onSaved={views.onSaved} />
              ) : saving === null ? (
                <Button variant="ghost" size="sm" icon="plus" onClick={() => setSaving("")} title="Save this search to your sidebar">Save</Button>
              ) : (
                <span className="ktv-save-wrap ktv-search-name">
                  {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                  <input autoFocus className="ktv-save-field" value={saving} onChange={(e) => setSaving(e.target.value)} placeholder={suggested.length < 30 ? suggested : "Name this search"}
                    aria-label="Name this search" aria-describedby={saveHintId}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") saveNow(); else if (e.key === "Escape") setSaving(null); }}
                    onBlur={() => { if (!(saving ?? "").trim()) setSaving(null); }} />
                  <span id={saveHintId} className="ktv-save-kbd"><span className="sr-only">Press Enter to save, Escape to cancel</span><Kbd>↵</Kbd></span>
                </span>
              )}
              {bulk && results.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setSelected(selectedVisible.length === results.length ? new Set() : new Set(results.map((t) => t.id)))}>
                  {selectedVisible.length === results.length ? "Clear" : capped || results.length < n ? `Select ${results.length} shown` : "Select all"}
                </Button>
              )}
              {/* exports always cover every task match, not just the rows rendered */}
              {n > 0 && <>
                <Button variant="ghost" size="sm" icon="arrowUpRight" onClick={() => exportTasksCsv(matchedTasks, "search", { allTasks: tasks, sections, customFields, members })}
                  aria-label={`Export ${exportScope} as CSV`} title={`Export ${exportScope} as CSV`}>CSV</Button>
                <Button variant="ghost" size="sm" icon="arrowUpRight" onClick={() => printTasks(matchedTasks, presetName && onPreset ? presetName : "Search results")}
                  aria-label={`Print or save ${exportScope} as PDF`} title={`Print or save ${exportScope} as PDF`}>PDF</Button>
              </>}
              <Button variant="ghost" size="sm" onClick={reset}>Clear</Button>
            </span>
          )}
        </div>

        {selectedVisible.length > 0 && bulk && (() => {
          const ids = selectedVisible.map((t) => t.id);
          return (
            <div className="ktv-search-bulk" role="toolbar" aria-label="Bulk actions for selected results">
              <span>{ids.length} selected</span>
              {onBulkPatch && <Button variant="ghost" size="sm" icon="check" onClick={() => { onBulkPatch(ids, { status: "done", completedAt: toLocalISO(new Date()) }); clearSel(); }}>Complete</Button>}
              {onBulkPatch && <Button variant="ghost" size="sm" icon="calendar" onClick={() => { onBulkPatch(ids, { dueDate: toLocalISO(new Date()) }); clearSel(); }}>Due today</Button>}
              {onBulkPatch && <Button variant="ghost" size="sm" icon="calendarPlus" onClick={() => { onBulkPatch(ids, { dueDate: presetDate("nextweek") }); clearSel(); }}>Next week</Button>}
              {onBulkDelete && <Button variant="ghost" size="sm" icon="trash" style={{ color: "var(--tv-signal)" }}
                onClick={() => { if (window.confirm(`Delete ${ids.length} task${ids.length === 1 ? "" : "s"}?`)) { onBulkDelete(ids); clearSel(); } }}>Delete</Button>}
              <IconButton icon="x" size="sm" label="Clear selection" onClick={clearSel} />
            </div>
          );
        })()}

        <div ref={listRef} id={resultsId} onKeyDown={onListKey} className={"ktv-search-results " + entrance} role="region" aria-label="Search results"
          data-selecting={selectedVisible.length > 0 || undefined}>
          {active && SEARCH_GROUPS.map((g) => {
            if (!counts[g.kind]) return null;
            const full = fullGroup(g.kind);
            const headId = `${resultsId}-${g.kind}`;
            const more = g.kind === "task" ? (full ? 0 : counts.task - results.length) : full ? 0 : counts[g.kind] - PREVIEW[g.kind];
            const head = (
              <div className="ksr-ghead">
                <h3 id={headId}>{g.label}<span className="ksr-gcount">{counts[g.kind]}</span></h3>
                {more > 0 && <Button className="ksr-more" variant="ghost" size="sm" onClick={() => pickKind(g.kind)}>Show all {plural(counts[g.kind], ...KIND_WORDS[g.kind])}</Button>}
              </div>
            );
            if (g.kind === "task") {
              return (
                <section key="task" className="ksr-group" aria-labelledby={headId}>
                  {kindsWithHits.length > 1 && head}
                  {taskRows.slice(0, results.length).map(({ task: t, snippet }) => (
                    <TaskRow key={t.id} t={t} snippet={snippet} isMobile={isMobile} bulk={bulk} selected={selected.has(t.id)} cursor={kb.cursor === t.id}
                      active={activeId === t.id} onToggleSel={toggleSel} onOpen={openTask} onToggle={onToggle}
                      dragIds={() => (selected.has(t.id) ? selectedVisible.map((x) => x.id) : [t.id])} readOnly={!!props.readOnly} />
                  ))}
                </section>
              );
            }
            const list = others.filter((h) => h.kind === g.kind);
            return (
              <section key={g.kind} className="ksr-group" aria-labelledby={headId}>
                {head}
                <div className="ksr-hits">
                  {list.slice(0, full ? list.length : PREVIEW[g.kind]).map((h) => {
                    const rowId = `${h.kind}:${h.id}`;
                    return <HitRow key={rowId} hit={h} rowId={rowId} cursor={kb.cursor === rowId} onOpen={openHit}
                      projectOf={(id) => (id ? projectById(id) : undefined)} workspaceName={(id) => (workspaces ?? []).find((w) => w.id === id)?.name} />;
                  })}
                </div>
              </section>
            );
          })}
          {active && total === 0 && !searching && (
            <div className="ktv-empty">
              <EmptyState art="search" title={smart && onPreset && hiddenArchived === 0 ? "All clear" : "Nothing matches"}
                body={hiddenArchived > 0 ? (hiddenArchived === 1 ? "1 archived task matches." : `${hiddenArchived} archived tasks match.`)
                  : smart && onPreset ? "Nothing of yours is in this list right now."
                  : parsed.chips.length ? "Try removing a filter, or search for fewer words."
                  : "Try fewer words, or loosen a filter."}
                action={!(smart && onPreset) && <Button variant="secondary" icon="x" onClick={reset}>Clear search</Button>} />
            </div>
          )}
          {active && total === 0 && searching && <p className="ksr-note" style={{ padding: "8px 0" }}>Searching everything…</p>}
          {!active && (
            <SearchStart recents={recents} examples={examples}
              onPick={(t) => { setInput(t); remember(t); inputRef.current?.focus({ preventScroll: true }); }}
              onForget={(t) => { forgetRecentSearch(uid, t); setRecents(recentSearches(uid)); }}
              onForgetAll={() => { forgetRecentSearches(uid); setRecents([]); }} />
          )}
        </div>
      </div>

      {kb.hint && selectedVisible.length === 0 && (
        <div className="ktv-float ktv-hint" role="note" aria-label="Keyboard shortcuts for these results">
          <span><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
          {bulk && <span><Kbd>X</Kbd> select</span>}
          <span><Kbd>↵</Kbd> open</span>
          {onToggle && <span><Kbd>{doneKey}</Kbd> done</span>}
          <span><Kbd>?</Kbd> all keys</span>
          <IconButton icon="x" size="sm" label="Hide these hints" onClick={kb.dismissHint} />
        </div>
      )}
    </div>
  );
}

function dedupe<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** One task: the same 36px row as My tasks (two lines when its description matches the words). */
function TaskRow({ t, snippet, isMobile, bulk, selected, cursor, active, onToggleSel, onOpen, onToggle, dragIds, readOnly }: {
  t: Task; snippet: string | null; isMobile: boolean; bulk: boolean; selected: boolean; cursor: boolean; active: boolean;
  onToggleSel: (id: string) => void; onOpen: (id: string) => void; onToggle?: (id: string) => void;
  /** what a drag from this row carries (the selection, when the row is in it) */
  dragIds: () => string[];
  readOnly: boolean;
}) {
  // a result can be dragged to Today, a day, a project or a person (lib/dnd); the bulk bar and the task panel do the same without a drag
  const drag = useTaskDragSource({ taskIds: dragIds, source: "search", originId: t.id, disabled: readOnly, label: t.title });
  const proj = getProject(t.projectId);
  const due = fmtDue(t.dueDate);
  const done = t.status === "done";
  const title = t.title || "Untitled task";
  const runs = splitHighlights(snippet);
  const openLabel = `Open ${title} (${[STATUS_META[t.status]?.label, proj && `${proj.name}${proj.archivedAt ? ", archived project" : ""}`, due && `due ${due}`].filter(Boolean).join(", ")})`;
  return (
    <div {...drag.bind} role="group" aria-label={title} data-row-id={t.id} className="ktv-row" data-done={done || undefined} data-snippet={runs.length > 0 || undefined}
      data-selected={selected || undefined} data-cursor={cursor || undefined} data-active={active || undefined} onClick={() => onOpen(t.id)}>
      {bulk && (
        <button type="button" role="checkbox" aria-checked={selected} aria-label={`Select ${title}`} className="ktv-sel"
          onClick={(e) => { e.stopPropagation(); onToggleSel(t.id); }}>
          {selected && <Icon name="check" size={11} sw={3} />}
        </button>
      )}
      <span className="ktv-lead">
        {onToggle
          ? <StatusGlyph status={t.status} size={isMobile ? 20 : 16} label={title} celebrateKey={t.id} onToggle={() => onToggle(t.id)} />
          : <StatusGlyph status={t.status} size={isMobile ? 20 : 16} readOnly />}
      </span>
      <div className="ktv-main">
        {/* a real button: Tab reaches it, Enter/Space open the task */}
        <button type="button" data-search-result className="ktv-title" onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} aria-label={openLabel} title={title}>
          <HighlightTitle text={title} />
        </button>
        {runs.length > 0 && <Highlighted className="ksr-snip" runs={runs} />}
      </div>
      <div className="ktv-cluster">
        {proj && (
          <span className="ktv-proj" title={proj.archivedAt ? `${proj.name} (archived project)` : proj.name}>
            {proj.archivedAt ? <Icon name="archive" size={12} sw={1.75} /> : <ProjectTile project={proj} size={16} />}
            <span>{proj.name}</span>
          </span>
        )}
        <span className="ktv-due">{t.dueDate && <DateChip value={t.dueDate} time={t.dueTime} size="sm" status={t.status} label="Due" readOnly onChange={() => {}} />}</span>
        <span className="ktv-trig" style={{ cursor: "inherit" }}><PriorityGlyph priority={t.priority} /></span>
        <span className="ktv-avatar"><Avatar id={t.assigneeId} size={20} /></span>
      </div>
    </div>
  );
}
