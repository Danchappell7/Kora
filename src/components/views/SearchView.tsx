/* ============================================================
   KANBO — global search: query across every task with field filters,
   plus saved searches. Reads tasks already in memory (instant).
   ============================================================ */
import { useMemo, useState, useEffect, useRef } from "react";
import { Icon, Avatar, StatusDot, PriorityFlag, EmptyArt } from "../primitives";
import { getProject, getMember, fmtDue, dueState, STATUS_META, PRIORITY_META, toLocalISO, presetDate, todayISO } from "../../data/data";
import { exportTasksCsv, printTasks } from "../../lib/exportTasks";
import { taskMatchesQuery, searchRank, isQueryActive, hasSearchText, inArchivedProject, queriesEqual, toQuery, EMPTY_QUERY as EMPTY, type Query } from "../../lib/searchQuery";
import { smartListById } from "../../lib/smartLists";
import type { Task, Project, SavedSearch, Status, Priority, CustomFieldDef } from "../../data/types";
import { useEntrance } from "../../hooks/useEntrance";

/** rows rendered at once; the count, "Select all" and exports say so */
const DISPLAY_CAP = 200;

/* a filter that is narrowing the results is tinted, so an applied filter is
   visible at a glance (and the global :focus-visible ring still shows) */
const selStyle = (on: boolean): React.CSSProperties => ({
  height: 32, padding: "0 9px", borderRadius: 9, maxWidth: "100%",
  border: `1px solid ${on ? "color-mix(in oklch, var(--accent) 55%, var(--hairline))" : "var(--hairline)"}`,
  background: on ? "var(--accent-dim)" : "var(--surface)", color: on ? "var(--ink)" : "var(--ink-2)",
  fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: on ? 600 : 400,
});
const chipStyle = (on: boolean): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 999, cursor: "pointer", fontSize: 12.5, fontFamily: "var(--font-display)",
  border: `1px solid ${on ? "color-mix(in oklch, var(--accent) 55%, var(--hairline))" : "var(--hairline)"}`,
  background: on ? "var(--accent-dim)" : "var(--surface)", color: on ? "var(--ink)" : "var(--ink-2)",
});

type Opt = { value: string; label: string; group?: string };

/** A select must never read "Any …" while a filter is applied. When the active
 *  value isn't one of the offered options (a saved search's colleague from
 *  another workspace, a tag nobody uses any more…), offer it as an extra. */
function withCurrent(opts: Opt[], value: string, label: (v: string) => string): Opt[] {
  return value === "all" || opts.some((o) => o.value === value) ? opts : [...opts, { value, label: label(value) }];
}

function FilterSelect({ label, anyLabel, value, options, onChange }: { label: string; anyLabel: string; value: string; options: Opt[]; onChange: (v: string) => void }) {
  const on = value !== "all";
  const plain = options.filter((o) => !o.group);
  const groups = [...new Set(options.filter((o) => o.group).map((o) => o.group!))];
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} style={selStyle(on)}>
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

const unknownLabel = (v: string) => `${v.charAt(0).toUpperCase()}${v.slice(1)} (unknown)`;

export function SearchView({ tasks, projects, members, currentUserId, onOpen, savedSearches, onSaveSearch, onDeleteSavedSearch, preset, presetKey, onBulkPatch, onBulkDelete, sections, customFields }: {
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
}) {
  const entrance = useEntrance(presetKey);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const presetQuery = useMemo<Query | null>(() => (preset ? toQuery(preset) : null), [preset ? JSON.stringify(preset) : ""]);
  const [q, setQ] = useState<Query>(presetQuery ?? EMPTY);
  const [inputFocused, setInputFocused] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
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
  }, [presetKey]);
  // dropping a selected task out of the current results shouldn't keep it selected
  useEffect(() => { clearSel(); }, [presetKey, q]);
  const set = (patch: Partial<Query>) => setQ((p) => ({ ...p, ...patch }));
  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => t.tags || []))].sort((a, b) => a.localeCompare(b)), [tasks]);
  const hasArchivedProjects = projects.some((p) => p.archivedAt);
  // one-click cross-project presets (combine + save your own). The sidebar's
  // smart lists are personal; the "All …" chips here are the team-wide views.
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
  }, [tasks, q, active, projects, today]);
  const results = matched.slice(0, DISPLAY_CAP);   // rows rendered (capped)
  const capped = matched.length > results.length;  // more matched than shown
  // only tasks still in the current results count as selected — a selection
  // that left the view (bulk action, external update) is ignored.
  const selectedVisible = results.filter((t) => selected.has(t.id));

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

  const n = matched.length;
  const exportScope = n === 1 ? "this task" : `all ${n} tasks`;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 920, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <Icon name="search" size={18} style={{ color: "var(--accent)" }} />
        <input ref={inputRef} value={q.text} onChange={(e) => set({ text: e.target.value })} onKeyDown={onInputKey}
          onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)}
          placeholder="Search every task…" aria-label="Search tasks" enterKeyHint="search" autoComplete="off" spellCheck={false}
          style={{ flex: 1, minWidth: 0, height: 40, padding: "0 12px", borderRadius: 11, border: `1px solid ${inputFocused ? "var(--accent)" : "var(--hairline)"}`, boxShadow: inputFocused ? "0 0 0 3px var(--accent-dim)" : "none", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15, outline: "2px solid transparent", transition: "border-color .15s, box-shadow .15s" }} />
      </div>

      {presetName && presetQuery && (
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, margin: "-4px 0 12px", fontSize: 12.5, color: "var(--ink-3)", minHeight: 26 }}>
          <Icon name={smart?.icon ?? "filter"} size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span style={{ minWidth: 0 }}>
            <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{presetName}</strong>
            {onPreset ? (smart ? ` · ${smart.description}` : " · Saved search") : " · Filters changed"}
          </span>
          {!onPreset && <button type="button" onClick={() => setQ(presetQuery)} className="btn btn-ghost" style={{ padding: "3px 10px", fontSize: 12 }}>Reset to {presetName}</button>}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 12 }}>
        {presets.map((p) => {
          const on = queriesEqual(q, { ...EMPTY, ...p.q });
          return <button key={p.label} type="button" aria-pressed={on} onClick={() => setQ(on ? EMPTY : { ...EMPTY, ...p.q })} className="lift" style={chipStyle(on)}>{p.label}</button>;
        })}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <FilterSelect label="Filter by status" anyLabel="Any status" value={q.status} options={statusOpts} onChange={(v) => set({ status: v })} />
        <FilterSelect label="Filter by priority" anyLabel="Any priority" value={q.priority} options={priorityOpts} onChange={(v) => set({ priority: v })} />
        <FilterSelect label="Filter by assignee or collaborator" anyLabel="Anyone" value={q.assignee} options={assigneeOpts} onChange={(v) => set({ assignee: v })} />
        <FilterSelect label="Filter by project" anyLabel="Any project" value={q.projectId} options={projectOpts} onChange={(v) => set({ projectId: v })} />
        {tagOpts.length > 0 && <FilterSelect label="Filter by tag" anyLabel="Any tag" value={q.tag} options={tagOpts} onChange={(v) => set({ tag: v })} />}
        <FilterSelect label="Filter by due date" anyLabel="Any due date" value={q.due} options={dueOpts} onChange={(v) => set({ due: v })} />
        {(hasArchivedProjects || q.includeArchived) && (
          <button type="button" aria-pressed={!!q.includeArchived} onClick={() => set({ includeArchived: !q.includeArchived })}
            title="Tasks in archived projects are hidden unless this is on"
            style={{ ...chipStyle(!!q.includeArchived), height: 32, padding: "0 11px", borderRadius: 9, fontWeight: q.includeArchived ? 600 : 400 }}>
            <Icon name="archive" size={13} /> Include archived projects
          </button>
        )}
        {active && (
          <>
            <button type="button" onClick={() => { const name = window.prompt("Name this search"); if (name?.trim()) onSaveSearch(name.trim(), q as unknown as Record<string, unknown>); }} className="btn btn-ghost" title="Save this search to your sidebar" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="filter" size={14} /> Save</button>
            <button type="button" onClick={() => setQ(EMPTY)} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}>Clear</button>
          </>
        )}
      </div>

      {savedSearches.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          <span className="kicker" style={{ alignSelf: "center" }}>Saved</span>
          {savedSearches.map((s) => {
            const sq = toQuery(s.query);
            const on = queriesEqual(q, sq);
            return (
              <span key={s.id} style={{ ...chipStyle(on), cursor: "default", gap: 6, padding: "4px 6px 4px 11px" }}>
                <button type="button" aria-pressed={on} onClick={() => setQ(sq)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "inherit", fontFamily: "var(--font-display)", fontSize: 12.5, padding: 0 }}>{s.name}</button>
                <button type="button" onClick={() => onDeleteSavedSearch(s.id)} aria-label={`Delete saved search ${s.name}`} title="Delete saved search" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-4)", fontSize: 13 }}>×</button>
              </span>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <span className="kicker" role="status" aria-live="polite" aria-atomic="true">
          {active ? `${n} result${n === 1 ? "" : "s"}${capped ? ` · showing first ${results.length}` : ""}` : "Type or pick a filter to search"}
        </span>
        {hiddenArchived > 0 && (
          <button type="button" onClick={() => set({ includeArchived: true })} className="btn btn-ghost" style={{ padding: "3px 10px", fontSize: 12 }}>
            <Icon name="archive" size={12} /> Show {hiddenArchived === 1 ? "1 task from an archived project" : `${hiddenArchived} tasks from archived projects`}
          </button>
        )}
        {active && results.length > 0 && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 7, alignItems: "center" }}>
            {(onBulkPatch || onBulkDelete) && (
              <button type="button" onClick={() => setSelected(selectedVisible.length === results.length ? new Set() : new Set(results.map((t) => t.id)))} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>
                {selectedVisible.length === results.length ? "Clear" : capped ? `Select ${results.length} shown` : "Select all"}
              </button>
            )}
            {/* exports always cover every match, not just the rows rendered */}
            <button type="button" onClick={() => exportTasksCsv(matched, "search", { allTasks: tasks, sections, customFields, members })} className="btn btn-ghost" aria-label={`Export ${exportScope} as CSV`} title={`Export ${exportScope} as CSV`} style={{ padding: "4px 10px", fontSize: 12 }}><Icon name="arrowUpRight" size={13} /> CSV</button>
            <button type="button" onClick={() => printTasks(matched, presetName && onPreset ? presetName : "Search results")} className="btn btn-ghost" aria-label={`Print or save ${exportScope} as PDF`} title={`Print or save ${exportScope} as PDF`} style={{ padding: "4px 10px", fontSize: 12 }}><Icon name="arrowUpRight" size={13} /> PDF</button>
          </span>
        )}
      </div>
      {selectedVisible.length > 0 && (onBulkPatch || onBulkDelete) && (() => {
        const ids = selectedVisible.map((t) => t.id);
        return (
        <div className="glass anim-fadeup" style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{ids.length} selected</span>
          <div style={{ flex: 1 }} />
          {onBulkPatch && <button onClick={() => { onBulkPatch(ids, { status: "done", completedAt: toLocalISO(new Date()) }); clearSel(); }} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="check" size={14} /> Complete</button>}
          {onBulkPatch && <button onClick={() => { onBulkPatch(ids, { dueDate: toLocalISO(new Date()) }); clearSel(); }} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="calendar" size={14} /> Due today</button>}
          {onBulkPatch && <button onClick={() => { onBulkPatch(ids, { dueDate: presetDate("nextweek") }); clearSel(); }} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="calendarPlus" size={14} /> Next week</button>}
          {onBulkDelete && <button onClick={() => { if (window.confirm(`Delete ${ids.length} task${ids.length === 1 ? "" : "s"}?`)) { onBulkDelete(ids); clearSel(); } }} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5, color: "var(--prio-urgent)" }}><Icon name="trash" size={14} /> Delete</button>}
          <button onClick={clearSel} className="btn btn-ghost" style={{ padding: "5px 9px", fontSize: 12.5 }}>Cancel</button>
        </div>
        );
      })()}
      <div ref={listRef} onKeyDown={onListKey} className={"glass " + entrance} style={{ borderRadius: 16, overflow: "hidden" }}>
        {active && results.map((t, i) => {
          const proj = getProject(t.projectId);
          const ds = dueState(t.dueDate, t.status);
          const sel = selected.has(t.id);
          const due = fmtDue(t.dueDate);
          const openLabel = `Open ${t.title || "Untitled task"} (${[STATUS_META[t.status]?.label, proj && `${proj.name}${proj.archivedAt ? ", archived project" : ""}`, due && `due ${due}`].filter(Boolean).join(", ")})`;
          return (
            <div key={t.id} className="lift-row" onClick={() => onOpen(t.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", cursor: "pointer", borderTop: i ? "1px solid var(--hairline)" : "none", background: sel ? "var(--accent-dim)" : undefined }}>
              {(onBulkPatch || onBulkDelete) && (
                <input type="checkbox" checked={sel} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(t.id)} aria-label={`Select ${t.title}`} style={{ cursor: "pointer", flexShrink: 0 }} />
              )}
              <StatusDot status={t.status} size={8} />
              {/* a real button: Tab reaches it, Enter/Space open the task */}
              <button type="button" data-search-result onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} aria-label={openLabel} title={t.title}
                className="truncate" style={{ flex: 1, minWidth: 0, display: "block", textAlign: "left", border: "none", background: "transparent", padding: "2px 0", margin: 0, borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 14, color: t.status === "done" ? "var(--ink-4)" : "var(--ink)", textDecoration: t.status === "done" ? "line-through" : "none" }}>
                {t.title || "Untitled task"}
              </button>
              {t.priority !== "medium" && <PriorityFlag priority={t.priority} size={13} />}
              {proj && (
                <span className="truncate hide-sm" title={proj.archivedAt ? `${proj.name} (archived project)` : undefined} style={{ fontSize: 12, color: "var(--ink-4)", maxWidth: 140, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {proj.archivedAt && <Icon name="archive" size={11} style={{ flexShrink: 0 }} />}
                  <span className="truncate">{proj.name}</span>
                </span>
              )}
              {t.dueDate && <span className="mono" style={{ fontSize: 11.5, color: ds === "overdue" ? "var(--prio-urgent)" : ds === "today" ? "var(--accent)" : "var(--ink-4)" }}>{due}</span>}
              <Avatar id={t.assigneeId} size={20} />
            </div>
          );
        })}
        {active && results.length === 0 && (
          <div style={{ padding: "36px 18px 32px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>
            <EmptyArt kind="search" size={112} />
            <p style={{ fontSize: 15.5, color: "var(--ink)", margin: "12px 0 0", fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>{smart && onPreset && hiddenArchived === 0 ? "All clear" : "No tasks match"}</p>
            <p style={{ margin: "4px 0 0" }}>
              {hiddenArchived > 0 ? (hiddenArchived === 1 ? "1 task in an archived project matches." : `${hiddenArchived} tasks in archived projects match.`)
                : smart && onPreset ? "Nothing of yours is in this list right now."
                : "Try loosening a filter, or clear them to start over."}
            </p>
          </div>
        )}
        {!active && (
          <div style={{ padding: "40px 18px 36px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>
            <EmptyArt kind="search" size={112} />
            <p style={{ fontSize: 15.5, color: "var(--ink)", margin: "12px 0 0", fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>Find anything, instantly</p>
            <p style={{ margin: "4px 0 0" }}>Search by text, status, priority, assignee, project, tag or due date. Words can be in any order; use "quotes" for an exact phrase.</p>
          </div>
        )}
      </div>
    </div>
  );
}
