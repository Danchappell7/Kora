/* ============================================================
   KANBO — command palette (⌘K): search tasks, jump to a project or any
   view, run quick actions — all keyboard-navigable and announced to
   screen readers (ARIA combobox + listbox).
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Icon, StatusDot } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { getProject, getMember, STATUS_META } from "../data/data";
import type { IconName, Task, Status, Project, Workspace } from "../data/types";

export interface Suggestion {
  id: string;
  icon: IconName;
  label: string;
  hint: string;
  accent?: boolean;
}

const ACTIONS: Suggestion[] = [
  { id: "prioritize", icon: "sparkles", label: "Auto-prioritise my day", hint: "AI", accent: true },
  { id: "new-task", icon: "plus", label: "New task", hint: "c" },
  { id: "quick-capture", icon: "zap", label: "Quick capture", hint: "q" },
  { id: "new-project", icon: "briefcase", label: "New project", hint: "" },
  { id: "focus", icon: "play", label: "Start a focus block", hint: "" },
  { id: "board", icon: "grid", label: "Switch to board view", hint: "" },
  { id: "manage-tags", icon: "tasks", label: "Manage tags", hint: "" },
  { id: "toggle-theme", icon: "sun", label: "Toggle light / dark theme", hint: "" },
  { id: "settings", icon: "settings", label: "Open settings", hint: "" },
];

// subsequence fuzzy match — "bd" matches "board", "anl" matches "analytics"
const fuzzy = (text: string, q: string): boolean => {
  if (!q) return true;
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of q) { i = t.indexOf(ch, i); if (i === -1) return false; i += 1; }
  return true;
};

// how well a name matches: whole prefix > word prefix > substring > fuzzy
const nameScore = (name: string, q: string): number => {
  const t = name.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.split(/[\s\-_/·]+/).some((w) => w.startsWith(q))) return 3;
  if (t.includes(q)) return 2;
  return q.length >= 2 && fuzzy(t, q) ? 1 : 0;
};

const NAV: { view: string; label: string; icon: IconName; alias?: string }[] = [
  { view: "home", label: "Go to Home", icon: "home" },
  { view: "plan", label: "Go to Plan my day", icon: "calendarPlus" },
  { view: "myweek", label: "Go to My week", icon: "sun", alias: "week" },
  { view: "tasks", label: "Go to My tasks", icon: "tasks" },
  { view: "search", label: "Go to Search", icon: "search" },
  { view: "inbox", label: "Go to Inbox", icon: "inbox", alias: "notifications" },
  { view: "calendar", label: "Go to Calendar", icon: "calendar" },
  { view: "team", label: "Go to Team", icon: "users", alias: "members people" },
  { view: "analytics", label: "Go to Analytics", icon: "chart" },
  { view: "reports", label: "Go to Reports", icon: "trendingUp" },
  { view: "workload", label: "Go to Workload", icon: "users", alias: "capacity" },
  { view: "goals", label: "Go to Goals", icon: "target", alias: "okrs objectives" },
  { view: "portfolios", label: "Go to Portfolios", icon: "briefcase" },
  { view: "automations", label: "Go to Automations", icon: "zap", alias: "rules" },
  { view: "forms", label: "Go to Forms", icon: "inbox", alias: "intake requests" },
];

type Item =
  | { kind: "task"; id: string; label: string; status: Status; where?: string }
  | { kind: "project"; id: string; label: string; color: string; emoji: string; where?: string }
  | { kind: "search"; label: string }
  | { kind: "action"; s: Suggestion }
  | { kind: "nav"; view: string; label: string; icon: IconName };

const LIST_ID = "kcmd-list";
const optId = (i: number) => `kcmd-opt-${i}`;

export function CommandPalette({ open, onClose, onAction, onNavigate, tasks = [], onOpenTask, projects, onOpenProject, workspaces, onSearchAll, canCreateProject = true }: {
  open: boolean;
  onClose: () => void;
  onAction: (s: Suggestion) => void;
  onNavigate?: (view: string) => void;
  tasks?: Task[];
  onOpenTask?: (id: string) => void;
  /** projects to offer as jump targets (archived ones are skipped) */
  projects?: Project[];
  /** navigate to a project; the Projects group only appears when this is given */
  onOpenProject?: (id: string) => void;
  /** lets results show which workspace a project/task lives in */
  workspaces?: Workspace[];
  /** open the Search view pre-filled with the text; adds a "See all results" row */
  onSearchAll?: (text: string) => void;
  /** false drops the "New project" action (guests can view and comment, not create) */
  canCreateProject?: boolean;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  useEffect(() => { setSel(0); }, [q]);
  // keep the highlighted row visible when navigating by keyboard
  useEffect(() => { if (open) document.getElementById(optId(sel))?.scrollIntoView?.({ block: "nearest" }); }, [sel, open]);
  if (!open) return null;

  const query = q.trim().toLowerCase();
  // workspace names are only worth showing when results can span several
  const wsName = (id: string | null | undefined): string | undefined => {
    if (!workspaces || workspaces.length < 2) return undefined;
    return workspaces.find((w) => w.id === (id ?? null))?.name;
  };

  // ---- projects ----
  const projectItems: Item[] = !onOpenProject || !projects || !query ? [] : projects
    .filter((p) => !p.archivedAt)
    .map((p) => ({ p, score: nameScore(p.name, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, 5)
    .map(({ p }) => ({ kind: "project", id: p.id, label: p.name, color: p.color, emoji: p.emoji, where: wsName(p.workspaceId) }));

  // ---- tasks: title, project name, assignee name or tag; best matches and open work first ----
  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? getProject(id)?.name;
  const taskScore = (t: Task): number => {
    const title = t.title.toLowerCase();
    let s = title.startsWith(query) ? 6 : title.includes(query) ? 4 : 0;
    if (!s) {
      if (projectName(t.projectId)?.toLowerCase().includes(query)) s = 2;
      else if (getMember(t.assigneeId)?.name?.toLowerCase().includes(query)) s = 2;
      else if ((t.tags || []).some((tg) => tg.toLowerCase().includes(query))) s = 1;
    }
    return s && t.status !== "done" ? s + 0.5 : s;
  };
  const taskItems: Item[] = !query ? [] : tasks
    .filter((t) => !t.archivedAt)
    .map((t) => ({ t, score: taskScore(t) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ t }) => {
      const pn = projectName(t.projectId);
      const ws = wsName(t.workspaceId);
      return { kind: "task", id: t.id, label: t.title, status: t.status, where: [pn, ws].filter(Boolean).join(" · ") || undefined };
    });
  const searchItems: Item[] = query && onSearchAll ? [{ kind: "search", label: `See all results for “${q.trim()}” in Search` }] : [];

  // actions and views keep their curated order when idle; while typing, the
  // best-named match rises ("goals" → Goals before Analytics)
  const ranked = <T,>(list: T[], score: (x: T) => number): T[] => !query ? list : list
    .map((x, i) => ({ x, i, s: score(x) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.x);
  const actions = canCreateProject ? ACTIONS : ACTIONS.filter((a) => a.id !== "new-project");
  const actionItems: Item[] = ranked(actions, (a) => Math.max(nameScore(a.label, query), fuzzy(a.label, query) ? 0.5 : 0))
    .map((s) => ({ kind: "action", s }));
  const navItems: Item[] = ranked(NAV, (n) => Math.max(
    nameScore(n.label.replace(/^Go to /, ""), query), nameScore(n.view, query),
    ...(n.alias ? n.alias.split(" ").map((a) => nameScore(a, query)) : [0]),
    fuzzy(n.label, query) ? 0.5 : 0,
  )).map((n) => ({ kind: "nav", view: n.view, label: n.label, icon: n.icon }));
  const items: Item[] = [...projectItems, ...taskItems, ...searchItems, ...actionItems, ...navItems];
  const nothing = query.length > 0 && items.length === 0;
  const active = items[sel] ? sel : -1;

  const activate = (it: Item) => {
    if (it.kind === "task") onOpenTask?.(it.id);
    else if (it.kind === "project") onOpenProject?.(it.id);
    else if (it.kind === "search") onSearchAll?.(q.trim());
    else if (it.kind === "action") onAction(it.s);
    else onNavigate?.(it.view);
    onClose();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => items.length ? (s + 1) % items.length : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => items.length ? (s - 1 + items.length) % items.length : 0); }
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); if (items[sel]) activate(items[sel]); }
    // the query is throwaway: one Escape closes the palette (as the ESC hint
    // says), rather than the focus trap's "leave the field first"
    else if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.preventDefault(); onClose(); }
  };

  // render with section headers but a single running index for keyboard nav
  let idx = -1;
  const row = (it: Item, label: string, left: React.ReactNode, opts: { hint?: string; accent?: boolean; sub?: string; sr?: string } = {}) => {
    idx += 1; const i = idx; const isActive = i === sel;
    return (
      <div key={it.kind + i} id={optId(i)} role="option" aria-selected={isActive}
        onMouseMove={() => { if (sel !== i) setSel(i); }}
        onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
        onClick={() => activate(it)}
        style={{
          display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "9px 11px", borderRadius: 10,
          cursor: "pointer", textAlign: "left", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14,
          background: isActive ? "var(--fill-2, color-mix(in oklch, var(--ink) 7%, transparent))" : "transparent",
          boxShadow: isActive ? "inset 2px 0 0 var(--accent)" : "none",
          transition: "background .12s var(--ease)",
        }}>
        {left}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="truncate" style={{ display: "block" }}>{label}</span>
          {opts.sub && <span className="truncate" style={{ display: "block", fontSize: 11.5, color: "var(--ink-4)", marginTop: 1 }}>{opts.sub}</span>}
          {opts.sr && <span className="sr-only">, {opts.sr}</span>}
        </span>
        {opts.hint ? <kbd aria-hidden="true" className="mono" style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 5, background: "var(--fill-1, color-mix(in oklch, var(--ink) 5%, transparent))", border: "1px solid var(--hairline)", color: opts.accent ? "var(--accent)" : "var(--ink-4)" }}>{opts.hint}</kbd>
          : <Icon name="arrowRight" size={15} style={{ color: isActive ? "var(--ink-3)" : "transparent", flexShrink: 0 }} />}
      </div>
    );
  };
  const group = (key: string, heading: string, list: Item[], render: (it: Item) => React.ReactNode) => list.length > 0 && (
    <div key={key} role="group" aria-labelledby={`kcmd-h-${key}`}>
      <div id={`kcmd-h-${key}`} role="presentation" className="kicker" style={{ padding: "8px 10px 6px" }}>{heading}</div>
      {list.map(render)}
    </div>
  );

  const count = items.length;
  return (
    <div onClick={onClose} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 100, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh", paddingLeft: 16, paddingRight: 16 }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 580, maxWidth: "100%", borderRadius: 18, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="sparkles" size={19} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder={onOpenProject ? "Search tasks and projects, or jump to a view…" : "Search tasks, jump to a view, or ask Kanbo…"}
            role="combobox" aria-label="Search or run a command" aria-expanded={count > 0} aria-controls={LIST_ID}
            aria-activedescendant={active >= 0 ? optId(active) : undefined} aria-autocomplete="list" aria-describedby="kcmd-help"
            autoComplete="off" spellCheck={false} data-focus-ring="none"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 16 }} />
          <kbd aria-hidden="true" className="mono" style={{ fontSize: 11, padding: "3px 7px", borderRadius: 6, background: "var(--fill-1, color-mix(in oklch, var(--ink) 5%, transparent))", border: "1px solid var(--hairline)", color: "var(--ink-4)" }}>ESC</kbd>
        </div>
        <span id="kcmd-help" className="sr-only">Use the up and down arrow keys to move through results and Enter to choose.</span>
        <div className="sr-only" aria-live="polite">{query ? (count ? `${count} result${count === 1 ? "" : "s"}` : "No results") : ""}</div>
        <div ref={listRef} id={LIST_ID} role="listbox" aria-label="Results" style={{ padding: 8, maxHeight: 380, overflowY: "auto" }}>
          {nothing ? (
            <div role="presentation" style={{ padding: "16px 14px" }}>
              <div className="kicker" style={{ marginBottom: 10, color: "var(--accent)" }}>Kanbo AI</div>
              <div style={{ display: "flex", gap: 11 }}>
                <Icon name="sparkles" size={18} style={{ color: "var(--accent)", marginTop: 2, flexShrink: 0 }} />
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)" }}>
                  Nothing matched “{q.trim()}”. Try a task title, a project, or a view (e.g. “analytics”).
                </p>
              </div>
            </div>
          ) : (
            <>
              {group("projects", "Projects", projectItems, (it) => it.kind === "project" && row(it, it.label,
                <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 17, height: 17, flexShrink: 0 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: it.color, boxShadow: `0 0 8px color-mix(in oklch, ${it.color} 55%, transparent)` }} />
                </span>, { sub: it.where, sr: it.where ? `project in ${it.where}` : "project" }))}
              {group("tasks", "Tasks", [...taskItems, ...searchItems], (it) => it.kind === "task"
                ? row(it, it.label, <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 17, flexShrink: 0 }}><StatusDot status={it.status} size={8} /></span>, { sub: it.where, sr: STATUS_META[it.status]?.label })
                : it.kind === "search" && row(it, it.label, <Icon name="search" size={17} style={{ color: "var(--accent)", flexShrink: 0 }} />))}
              {group("actions", "Actions", actionItems, (it) => it.kind === "action" && row(it, it.s.label, <Icon name={it.s.icon} size={17} style={{ color: it.s.accent ? "var(--accent)" : "var(--ink-3)", flexShrink: 0 }} />, { hint: it.s.hint, accent: it.s.accent }))}
              {group("nav", "Navigate", navItems, (it) => it.kind === "nav" && row(it, it.label, <Icon name={it.icon} size={17} style={{ color: "var(--ink-3)", flexShrink: 0 }} />))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
