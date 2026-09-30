/* ============================================================
   KANBO — Search: every task, by text and field filters, plus the
   team-wide presets and your saved searches. Reads tasks already in
   memory (instant). Results are the same 36px rows as My tasks: the
   status glyph is the completion checkbox (it never opens the task),
   then the title, then project · due · priority · assignee.
   J / K move, X selects, Enter opens, ⌘↵ completes.
   ============================================================ */
import { useMemo, useState, useEffect, useRef, useId } from "react";
import { Icon, Avatar, StatusGlyph, PriorityGlyph, DateChip, ProjectDot, EmptyState, Button, IconButton, Kbd } from "../primitives";
import { getProject, getMember, fmtDue, STATUS_META, PRIORITY_META, toLocalISO, presetDate, todayISO } from "../../data/data";
import { exportTasksCsv, printTasks } from "../../lib/exportTasks";
import { taskMatchesQuery, searchRank, isQueryActive, hasSearchText, inArchivedProject, queriesEqual, toQuery, EMPTY_QUERY as EMPTY, type Query } from "../../lib/searchQuery";
import { smartListById } from "../../lib/smartLists";
import { useListKeyboard } from "../../hooks/useListKeyboard";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { Task, Project, SavedSearch, Status, Priority, CustomFieldDef } from "../../data/types";
import { useEntrance } from "../../hooks/useEntrance";
import "../tasks/taskViews.css";

/** rows rendered at once; the count, "Select all" and exports say so */
const DISPLAY_CAP = 200;

type Opt = { value: string; label: string; group?: string };

/** A select must never read "Any …" while a filter is applied. When the active
 *  value isn't one of the offered options (a saved search's colleague from
 *  another workspace, a tag nobody uses any more…), offer it as an extra. */
function withCurrent(opts: Opt[], value: string, label: (v: string) => string): Opt[] {
  return value === "all" || opts.some((o) => o.value === value) ? opts : [...opts, { value, label: label(value) }];
}

/** A filter that is narrowing the results is tinted, so an applied filter reads at a glance. */
function FilterSelect({ label, anyLabel, value, options, onChange }: { label: string; anyLabel: string; value: string; options: Opt[]; onChange: (v: string) => void }) {
  const plain = options.filter((o) => !o.group);
  const groups = [...new Set(options.filter((o) => o.group).map((o) => o.group!))];
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="ktv-search-select" data-on={value !== "all" || undefined}>
      <option value="all">{anyLabel}</option>
      {plain.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {options.filter((o) => o.group === g).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/** primary pointer is a mouse/trackpad (not a touchscreen) */
const finePointer = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

const unknownLabel = (v: string) => `${v.charAt(0).toUpperCase()}${v.slice(1)} (unknown)`;

export function SearchView({ tasks, projects, members, currentUserId, onOpen, savedSearches, onSaveSearch, onDeleteSavedSearch, preset, presetKey, onBulkPatch, onBulkDelete, sections, customFields, onToggle, activeId }: {
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
}) {
  const entrance = useEntrance(presetKey);
  const isMobile = useMediaQuery("(max-width: 860px)");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const presetQuery = useMemo<Query | null>(() => (preset ? toQuery(preset) : null), [preset ? JSON.stringify(preset) : ""]);
  const [q, setQ] = useState<Query>(presetQuery ?? EMPTY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  // apply a smart-list / saved-search preset when selected (or when its content
  // changes, e.g. the signed-in user resolves); reset to EMPTY on plain Search
  // so a stale smart-list filter doesn't linger when you leave it. A preset
  // that merely disappears under the same key (you deleted the saved search
  // you're looking at, or its temporary id was swapped for the real one) keeps
  // the current search on screen instead of wiping it.
  const lastPresetKey = useRef(presetKey);
  useEffect(() => {
    const keyChanged = lastPresetKey.current !== presetKey;
    lastPresetKey.current = presetKey;
    if (presetQuery) setQ(presetQuery);
    else if (keyChanged) setQ(EMPTY);
  }, [presetKey, presetQuery]);
  // Put the cursor in the box only for a plain Search on a mouse/trackpad
  // device. Opening a smart list (or anything on a phone) shows results
  // instead of throwing the on-screen keyboard over them.
  useEffect(() => {
    if (preset) return;
    if (finePointer()) inputRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetKey]);
  // dropping a selected task out of the current results shouldn't keep it selected
  useEffect(() => { clearSel(); }, [presetKey, q]);
  const set = (patch: Partial<Query>) => setQ((p) => ({ ...p, ...patch }));
  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => t.tags || []))].sort((a, b) => a.localeCompare(b)), [tasks]);
  const hasArchivedProjects = projects.some((p) => p.archivedAt);
  // one-click cross-project presets (combine + save your own). My tasks is
  // personal; the "All …" chips here are the team-wide views.
  const presets: { label: string; q: Partial<Query> }[] = [
    ...(currentUserId ? [{ label: "Assigned to me", q: { assignee: currentUserId, status: "open" } as Partial<Query> }] : []),
    ...(currentUserId ? [{ label: "My work this week", q: { assignee: currentUserId, due: "week", status: "open" } as Partial<Query> }] : []),
    { label: "All due today", q: { due: "today" } },
    { label: "All due this week", q: { due: "week", status: "open" } },
    { label: "All overdue", q: { due: "overdue" } },
    { label: "Urgent", q: { priority: "urgent", status: "open" } },
  ];

  const active = isQueryActive(q);
  // due = today / overdue / this week read the date, so the results move at
  // midnight with the sidebar counts instead of disagreeing with them
  const today = todayISO();
  const { matched, hiddenArchived } = useMemo(() => {
    // nothing is listed until there's a search, so don't scan every task for it
    if (!active) return { matched: [] as Task[], hiddenArchived: 0 };
    // one pass with archived projects included: the default view then drops
    // those tasks, and how many it dropped is offered as a one-click widen
    const wide = tasks.filter((t) => taskMatchesQuery(t, { ...q, includeArchived: true }));
    const hits = q.includeArchived ? wide : wide.filter((t) => !inArchivedProject(t));
    const hidden = wide.length - hits.length;
    if (!hasSearchText(q.text)) return { matched: hits, hiddenArchived: hidden };
    // text search: best matches (title hits, open work) first; stable otherwise
    const ranked = hits.map((t, i) => ({ t, i, r: searchRank(t, q) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.t);
    return { matched: ranked, hiddenArchived: hidden };
    // projects: archiving/restoring one changes what matches without touching tasks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, q, active, projects, today]);
  const results = matched.slice(0, DISPLAY_CAP);   // rows rendered (capped)
  const capped = matched.length > results.length;  // more matched than shown
  // only tasks still in the current results count as selected — a selection
  // that left the view (bulk action, external update) is ignored.
  const selectedVisible = results.filter((t) => selected.has(t.id));
  const bulk = !!(onBulkPatch || onBulkDelete);

  // context line for an open smart list / saved search
  const smart = smartListById(presetKey);
  const saved = !smart && presetKey ? savedSearches.find((s) => s.id === presetKey) : undefined;
  const presetName = smart?.label ?? saved?.name;
  const onPreset = !!presetQuery && queriesEqual(q, presetQuery);

  // filter options — every select can always show its active value
  const statusOpts = withCurrent([{ value: "open", label: "Open (not done)" }, ...(Object.keys(STATUS_META) as Status[]).map((s) => ({ value: s, label: STATUS_META[s].label }))], q.status, unknownLabel);
  const priorityOpts = withCurrent((["urgent", "high", "medium", "low"] as Priority[]).map((p) => ({ value: p, label: PRIORITY_META[p].label })), q.priority, unknownLabel);
  const memberName = (id: string) => getMember(id)?.name || (id === currentUserId ? "You" : "Unknown member");
  const assigneeOpts = withCurrent(members.map((m) => ({ value: m.id, label: m.name })), q.assignee, memberName);
  const projectOpts = withCurrent([
    ...projects.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: p.name })),
    ...projects.filter((p) => p.archivedAt && (q.includeArchived || p.id === q.projectId)).map((p) => ({ value: p.id, label: p.name, group: "Archived projects" })),
  ], q.projectId, (id) => getProject(id)?.name || "Unknown project");
  const tagOpts = withCurrent(allTags.map((t) => ({ value: t, label: t })), q.tag, (t) => t);
  const dueOpts = withCurrent([
    { value: "today", label: "Due today" }, { value: "week", label: "Due this week" }, { value: "overdue", label: "Overdue" },
    { value: "has", label: "Has a due date" }, { value: "none", label: "No due date" },
  ], q.due, unknownLabel);

  // save the current search under a name typed in place (no prompt)
  const [saving, setSaving] = useState<string | null>(null);
  const saveHintId = useId();
  useEffect(() => { if (!active) setSaving(null); }, [active]);
  const saveNow = () => {
    const name = (saving ?? "").trim();
    if (!name) return;
    onSaveSearch(name, q as unknown as Record<string, unknown>);
    setSaving(null);
  };

  // keyboard: ↓ from the search box into the results, ↑/↓ between them
  const resultButtons = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-search-result]") ?? []);
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { const first = resultButtons()[0]; if (first) { e.preventDefault(); first.focus(); } }
    // results are already live; on a phone the "Search" key just puts the
    // keyboard away so they can be seen
    else if (e.key === "Enter" && !e.nativeEvent.isComposing && !finePointer()) e.currentTarget.blur();
  };
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const btns = resultButtons();
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === "ArrowDown") btns[Math.min(i + 1, btns.length - 1)]?.focus();
    else if (i === 0) inputRef.current?.focus();
    else btns[i - 1]?.focus();
  };
  // J / K through the results (↑ ↓ keep their own path back to the box), X selects, ⌘↵ completes
  const kb = useListKeyboard({
    rootRef: listRef, itemSelector: "[data-row-id]", idOf: (el) => el.dataset.rowId,
    focusTargetOf: (el) => el.querySelector<HTMLElement>("[data-search-result]"),
    onOpen,
    onComplete: onToggle,
    onToggleSelect: bulk ? toggleSel : undefined,
    onClear: clearSel,
    enabled: active && results.length > 0,
  });

  const n = matched.length;
  const exportScope = n === 1 ? "this task" : `all ${n} tasks`;
  const doneKey = isMac() ? "⌘↵" : "Ctrl ↵";

  return (
    <div className="ktv ktv-search">
      <div className="ktv-search-in">
        <div className="ktv-search-box">
          <Icon name="search" size={16} sw={1.75} />
          <input ref={inputRef} value={q.text} onChange={(e) => set({ text: e.target.value })} onKeyDown={onInputKey}
            placeholder="Search every task…" aria-label="Search tasks" enterKeyHint="search" autoComplete="off" spellCheck={false} />
        </div>

        {presetName && presetQuery && (
          <div className="ktv-search-ctx">
            <Icon name={smart?.icon ?? "filter"} size={14} sw={1.75} />
            <span style={{ minWidth: 0 }}>
              <strong>{presetName}</strong>
              {onPreset ? (smart ? ` · ${smart.description}` : " · Saved search") : " · Filters changed"}
            </span>
            {!onPreset && <Button variant="ghost" size="sm" onClick={() => setQ(presetQuery)}>Reset to {presetName}</Button>}
          </div>
        )}

        <div className="ktv-search-row" role="group" aria-label="Quick searches">
          {presets.map((p) => {
            const on = queriesEqual(q, { ...EMPTY, ...p.q });
            return <button key={p.label} type="button" className="ktv-chip" aria-pressed={on} onClick={() => setQ(on ? EMPTY : { ...EMPTY, ...p.q })}>{p.label}</button>;
          })}
        </div>

        <div className="ktv-search-row">
          <FilterSelect label="Filter by status" anyLabel="Any status" value={q.status} options={statusOpts} onChange={(v) => set({ status: v })} />
          <FilterSelect label="Filter by priority" anyLabel="Any priority" value={q.priority} options={priorityOpts} onChange={(v) => set({ priority: v })} />
          <FilterSelect label="Filter by assignee or collaborator" anyLabel="Anyone" value={q.assignee} options={assigneeOpts} onChange={(v) => set({ assignee: v })} />
          <FilterSelect label="Filter by project" anyLabel="Any project" value={q.projectId} options={projectOpts} onChange={(v) => set({ projectId: v })} />
          {tagOpts.length > 0 && <FilterSelect label="Filter by tag" anyLabel="Any tag" value={q.tag} options={tagOpts} onChange={(v) => set({ tag: v })} />}
          <FilterSelect label="Filter by due date" anyLabel="Any due date" value={q.due} options={dueOpts} onChange={(v) => set({ due: v })} />
          {(hasArchivedProjects || q.includeArchived) && (
            <button type="button" className="ktv-chip ktv-chip-lg" aria-pressed={!!q.includeArchived} onClick={() => set({ includeArchived: !q.includeArchived })}
              title="Tasks in archived projects are hidden unless this is on">
              <Icon name="archive" size={14} sw={1.75} /><span>Include archived projects</span>
            </button>
          )}
          {active && (
            <span className="ktv-search-name">
              {saving === null ? (
                <Button variant="ghost" size="sm" icon="plus" onClick={() => setSaving("")} title="Save this search to your sidebar">Save</Button>
              ) : (
                <span className="ktv-save-wrap">
                  {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                  <input autoFocus className="ktv-save-field" value={saving} onChange={(e) => setSaving(e.target.value)} placeholder="Name this search" aria-label="Name this search"
                    aria-describedby={saveHintId}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") saveNow(); else if (e.key === "Escape") setSaving(null); }}
                    onBlur={() => { if (!(saving ?? "").trim()) setSaving(null); }} />
                  <span id={saveHintId} className="ktv-save-kbd"><span className="sr-only">Press Enter to save, Escape to cancel</span><Kbd>↵</Kbd></span>
                </span>
              )}
              <Button variant="ghost" size="sm" onClick={() => setQ(EMPTY)}>Clear</Button>
            </span>
          )}
        </div>

        {savedSearches.length > 0 && (
          <div className="ktv-search-row" role="group" aria-label="Saved searches">
            <span className="ktv-mlabel">Saved</span>
            {savedSearches.map((s) => {
              const sq = toQuery(s.query);
              const on = queriesEqual(q, sq);
              return (
                <span key={s.id} className="ktv-saved" data-on={on || undefined}>
                  <button type="button" aria-pressed={on} onClick={() => setQ(sq)}>{s.name}</button>
                  <button type="button" onClick={() => onDeleteSavedSearch(s.id)} aria-label={`Delete saved search ${s.name}`} title="Delete saved search"><Icon name="x" size={12} sw={2} /></button>
                </span>
              );
            })}
          </div>
        )}

        <div className="ktv-search-status">
          <span role="status" aria-live="polite" aria-atomic="true">
            {active ? `${n} result${n === 1 ? "" : "s"}${capped ? ` · showing first ${results.length}` : ""}` : "Type or pick a filter to search"}
          </span>
          {hiddenArchived > 0 && (
            <Button variant="ghost" size="sm" icon="archive" onClick={() => set({ includeArchived: true })}>
              {hiddenArchived === 1 ? "Show 1 task from an archived project" : `Show ${hiddenArchived} tasks from archived projects`}
            </Button>
          )}
          {active && results.length > 0 && (
            <span className="ktv-search-actions">
              {bulk && (
                <Button variant="ghost" size="sm" onClick={() => setSelected(selectedVisible.length === results.length ? new Set() : new Set(results.map((t) => t.id)))}>
                  {selectedVisible.length === results.length ? "Clear" : capped ? `Select ${results.length} shown` : "Select all"}
                </Button>
              )}
              {/* exports always cover every match, not just the rows rendered */}
              <Button variant="ghost" size="sm" icon="arrowUpRight" onClick={() => exportTasksCsv(matched, "search", { allTasks: tasks, sections, customFields, members })}
                aria-label={`Export ${exportScope} as CSV`} title={`Export ${exportScope} as CSV`}>CSV</Button>
              <Button variant="ghost" size="sm" icon="arrowUpRight" onClick={() => printTasks(matched, presetName && onPreset ? presetName : "Search results")}
                aria-label={`Print or save ${exportScope} as PDF`} title={`Print or save ${exportScope} as PDF`}>PDF</Button>
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

        <div ref={listRef} onKeyDown={onListKey} className={"ktv-search-results " + entrance} role="region" aria-label="Search results"
          data-selecting={selectedVisible.length > 0 || undefined}>
          {active && results.map((t) => {
            const proj = getProject(t.projectId);
            const sel = selected.has(t.id);
            const due = fmtDue(t.dueDate);
            const done = t.status === "done";
            const title = t.title || "Untitled task";
            const openLabel = `Open ${title} (${[STATUS_META[t.status]?.label, proj && `${proj.name}${proj.archivedAt ? ", archived project" : ""}`, due && `due ${due}`].filter(Boolean).join(", ")})`;
            return (
              <div key={t.id} role="group" aria-label={title} data-row-id={t.id} className="ktv-row" data-done={done || undefined}
                data-selected={sel || undefined} data-cursor={kb.cursor === t.id || undefined} data-active={activeId === t.id || undefined} onClick={() => onOpen(t.id)}>
                {bulk && (
                  <button type="button" role="checkbox" aria-checked={sel} aria-label={`Select ${title}`} className="ktv-sel"
                    onClick={(e) => { e.stopPropagation(); toggleSel(t.id); }}>
                    {sel && <Icon name="check" size={11} sw={3} />}
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
                    {title}
                  </button>
                </div>
                <div className="ktv-cluster">
                  {proj && (
                    <span className="ktv-proj" title={proj.archivedAt ? `${proj.name} (archived project)` : proj.name}>
                      {proj.archivedAt ? <Icon name="archive" size={12} sw={1.75} /> : <ProjectDot color={proj.color} />}
                      <span>{proj.name}</span>
                    </span>
                  )}
                  <span className="ktv-due">{t.dueDate && <DateChip value={t.dueDate} time={t.dueTime} size="sm" status={t.status} label="Due" readOnly onChange={() => {}} />}</span>
                  <span className="ktv-trig" style={{ cursor: "inherit" }}><PriorityGlyph priority={t.priority} /></span>
                  <span className="ktv-avatar"><Avatar id={t.assigneeId} size={20} /></span>
                </div>
              </div>
            );
          })}
          {active && results.length === 0 && (
            <div className="ktv-empty">
              <EmptyState art="search" title={smart && onPreset && hiddenArchived === 0 ? "All clear" : "No tasks match"}
                body={hiddenArchived > 0 ? (hiddenArchived === 1 ? "1 task in an archived project matches." : `${hiddenArchived} tasks in archived projects match.`)
                  : smart && onPreset ? "Nothing of yours is in this list right now."
                  : "Try loosening a filter, or clear them to start over."}
                action={!(smart && onPreset) && <Button variant="secondary" icon="x" onClick={() => setQ(EMPTY)}>Clear search</Button>} />
            </div>
          )}
          {!active && (
            <div className="ktv-empty">
              <EmptyState art="search" title="Find anything, instantly"
                body={<>Search by text, status, priority, assignee, project, tag or due date. Words can be in any order; use "quotes" for an exact phrase.</>} />
            </div>
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
