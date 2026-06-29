/* ============================================================
   KANBO — command palette (⌘K): search tasks, jump to any view,
   run quick actions, all keyboard-navigable.
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Icon, StatusDot } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { getProject, getMember } from "../data/data";
import type { IconName, Task, Status } from "../data/types";

export interface Suggestion {
  id: string;
  icon: IconName;
  label: string;
  hint: string;
  accent?: boolean;
}

const ACTIONS: Suggestion[] = [
  { id: "prioritize", icon: "sparkles", label: "Auto-prioritize my day", hint: "AI", accent: true },
  { id: "new-task", icon: "plus", label: "New task", hint: "" },
  { id: "focus", icon: "play", label: "Start a focus block", hint: "" },
  { id: "board", icon: "grid", label: "Switch to board view", hint: "" },
  { id: "manage-tags", icon: "tasks", label: "Manage tags", hint: "" },
];

// subsequence fuzzy match — "bd" matches "board", "anl" matches "analytics"
const fuzzy = (text: string, q: string): boolean => {
  if (!q) return true;
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of q) { i = t.indexOf(ch, i); if (i === -1) return false; i += 1; }
  return true;
};

const NAV: { view: string; label: string; icon: IconName }[] = [
  { view: "home", label: "Go to Home", icon: "home" },
  { view: "plan", label: "Go to Plan my day", icon: "calendarPlus" },
  { view: "tasks", label: "Go to My tasks", icon: "tasks" },
  { view: "search", label: "Go to Search", icon: "search" },
  { view: "inbox", label: "Go to Inbox", icon: "inbox" },
  { view: "calendar", label: "Go to Calendar", icon: "calendar" },
  { view: "team", label: "Go to Team", icon: "user" },
  { view: "analytics", label: "Go to Analytics", icon: "chart" },
];

type Item =
  | { kind: "task"; id: string; label: string; status: Status }
  | { kind: "action"; s: Suggestion }
  | { kind: "nav"; view: string; label: string; icon: IconName };

export function CommandPalette({ open, onClose, onAction, onNavigate, tasks = [], onOpenTask }: {
  open: boolean;
  onClose: () => void;
  onAction: (s: Suggestion) => void;
  onNavigate?: (view: string) => void;
  tasks?: Task[];
  onOpenTask?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  useEffect(() => { setSel(0); }, [q]);
  // keep the highlighted row visible when navigating by keyboard
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" }); }, [sel]);
  if (!open) return null;

  const query = q.trim().toLowerCase();
  // match tasks by title, project name, assignee name, or tag
  const matchTask = (t: Task) => {
    if (t.title.toLowerCase().includes(query)) return true;
    if (getProject(t.projectId)?.name.toLowerCase().includes(query)) return true;
    if (getMember(t.assigneeId)?.name?.toLowerCase().includes(query)) return true;
    return (t.tags || []).some((tg) => tg.toLowerCase().includes(query));
  };
  const taskItems: Item[] = (query ? tasks.filter(matchTask).slice(0, 8) : []).map((t) => ({ kind: "task", id: t.id, label: t.title, status: t.status }));
  const actionItems: Item[] = ACTIONS.filter((a) => fuzzy(a.label, query)).map((s) => ({ kind: "action", s }));
  const navItems: Item[] = NAV.filter((n) => fuzzy(n.label, query) || fuzzy(n.view, query)).map((n) => ({ kind: "nav", view: n.view, label: n.label, icon: n.icon }));
  const items: Item[] = [...taskItems, ...actionItems, ...navItems];
  const asking = query.length > 0 && items.length === 0;

  const activate = (it: Item) => {
    if (it.kind === "task") onOpenTask?.(it.id);
    else if (it.kind === "action") onAction(it.s);
    else onNavigate?.(it.view);
    onClose();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => items.length ? (s + 1) % items.length : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => items.length ? (s - 1 + items.length) % items.length : 0); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[sel]) activate(items[sel]); }
  };

  // render with section headers but a single running index for keyboard nav
  let idx = -1;
  const row = (it: Item, label: string, left: React.ReactNode, hint?: string, accent?: boolean) => {
    idx += 1; const i = idx; const active = i === sel;
    return (
      <button key={it.kind + i} data-idx={i} onMouseEnter={() => setSel(i)} onClick={() => activate(it)} style={{
        display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "10px 11px", borderRadius: 10,
        border: "none", cursor: "pointer", textAlign: "left", background: active ? "var(--surface-2)" : "transparent",
        color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14,
      }}>
        {left}
        <span style={{ flex: 1 }} className="truncate">{label}</span>
        {hint ? <kbd className="mono" style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 5, background: "var(--surface-2)", border: "1px solid var(--hairline)", color: accent ? "var(--accent)" : "var(--ink-4)" }}>{hint}</kbd>
          : <Icon name="arrowRight" size={15} style={{ color: active ? "var(--ink-3)" : "transparent" }} />}
      </button>
    );
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 100, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 580, maxWidth: "90vw", borderRadius: 18, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="sparkles" size={19} style={{ color: "var(--accent)" }} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} placeholder="Search tasks, jump to a view, or ask Kanbo…"
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 16 }} />
          <kbd className="mono" style={{ fontSize: 11, padding: "3px 7px", borderRadius: 6, background: "var(--surface-2)", border: "1px solid var(--hairline)", color: "var(--ink-4)" }}>ESC</kbd>
        </div>
        <div ref={listRef} style={{ padding: 8, maxHeight: 380, overflowY: "auto" }}>
          {asking ? (
            <div style={{ padding: "16px 14px" }}>
              <div className="kicker" style={{ marginBottom: 10, color: "var(--accent)" }}>Kanbo AI</div>
              <div style={{ display: "flex", gap: 11 }}>
                <Icon name="sparkles" size={18} style={{ color: "var(--accent)", marginTop: 2 }} />
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)" }}>
                  Nothing matched “{q.trim()}”. Try a task title, a view (e.g. “analytics”), or hit Enter on a suggestion.
                </p>
              </div>
            </div>
          ) : (
            <>
              {taskItems.length > 0 && <div className="kicker" style={{ padding: "8px 10px 6px" }}>Tasks</div>}
              {taskItems.map((it) => row(it, it.kind === "task" ? it.label : "", <StatusDot status={(it as { status: Status }).status} size={8} />))}
              {actionItems.length > 0 && <div className="kicker" style={{ padding: "8px 10px 6px" }}>Actions</div>}
              {actionItems.map((it) => it.kind === "action" && row(it, it.s.label, <Icon name={it.s.icon} size={17} style={{ color: it.s.accent ? "var(--accent)" : "var(--ink-3)" }} />, it.s.hint, it.s.accent))}
              {navItems.length > 0 && <div className="kicker" style={{ padding: "8px 10px 6px" }}>Navigate</div>}
              {navItems.map((it) => it.kind === "nav" && row(it, it.label, <Icon name={it.icon} size={17} style={{ color: "var(--ink-3)" }} />))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
