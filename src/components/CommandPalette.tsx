/* ============================================================
   KORA — AI command palette (⌘K)
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Icon, StatusDot } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { IconName, Task } from "../data/types";

export interface Suggestion {
  icon: IconName;
  label: string;
  hint: string;
  accent?: boolean;
}

const AI_SUGGESTIONS: Suggestion[] = [
  { icon: "sparkles", label: "Auto-prioritize my day", hint: "AI", accent: true },
  { icon: "calendarPlus", label: "Schedule a deep work block", hint: "AI", accent: true },
  { icon: "zap", label: "What should I focus on next?", hint: "AI", accent: true },
  { icon: "plus", label: "New task", hint: "C" },
  { icon: "board", label: "Switch to board view", hint: "" },
  { icon: "chart", label: "Open analytics", hint: "" },
];

export function CommandPalette({ open, onClose, onAction, tasks = [], onOpenTask }: {
  open: boolean;
  onClose: () => void;
  onAction: (s: Suggestion) => void;
  tasks?: Task[];
  onOpenTask?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  useEffect(() => { if (open) { setQ(""); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  if (!open) return null;
  const query = q.trim().toLowerCase();
  const list = AI_SUGGESTIONS.filter((s) => s.label.toLowerCase().includes(query));
  const matchingTasks = query.length > 0 ? tasks.filter((t) => t.title.toLowerCase().includes(query)).slice(0, 6) : [];
  const asking = query.length > 0 && list.length === 0 && matchingTasks.length === 0;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 100, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 580, maxWidth: "90vw", borderRadius: 18, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="sparkles" size={19} style={{ color: "var(--accent)" }} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, or ask Kora anything…"
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 16 }} />
          <kbd className="mono" style={{ fontSize: 11, padding: "3px 7px", borderRadius: 6, background: "var(--surface-2)", border: "1px solid var(--hairline)", color: "var(--ink-4)" }}>ESC</kbd>
        </div>
        <div style={{ padding: 8, maxHeight: 360, overflowY: "auto" }}>
          {asking ? (
            <div style={{ padding: "16px 14px" }}>
              <div className="kicker" style={{ marginBottom: 10, color: "var(--accent)" }}>Kora AI</div>
              <div style={{ display: "flex", gap: 11 }}>
                <Icon name="sparkles" size={18} style={{ color: "var(--accent)", marginTop: 2 }} />
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)" }}>
                  I'll prioritize your most urgent, unblocking work first and protect your morning for deep focus. Want me to auto-plan your day?
                </p>
              </div>
            </div>
          ) : (
            <>
              {matchingTasks.length > 0 && (
                <>
                  <div className="kicker" style={{ padding: "8px 10px 6px" }}>Tasks</div>
                  {matchingTasks.map((t) => (
                    <button key={t.id} onClick={() => { onOpenTask?.(t.id); onClose(); }} style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "10px 11px", borderRadius: 10,
                      border: "none", cursor: "pointer", textAlign: "left", background: "transparent",
                      color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14,
                    }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                      <StatusDot status={t.status} size={8} />
                      <span style={{ flex: 1 }}>{t.title}</span>
                      <Icon name="arrowRight" size={15} style={{ color: "var(--ink-4)" }} />
                    </button>
                  ))}
                </>
              )}
              <div className="kicker" style={{ padding: "8px 10px 6px" }}>Suggested</div>
              {list.map((s, i) => (
                <button key={i} onClick={() => { onAction(s); onClose(); }} style={{
                  display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "10px 11px", borderRadius: 10,
                  border: "none", cursor: "pointer", textAlign: "left", background: "transparent", transition: "background .14s",
                  color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14,
                }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <Icon name={s.icon} size={17} style={{ color: s.accent ? "var(--accent)" : "var(--ink-3)" }} />
                  <span style={{ flex: 1 }}>{s.label}</span>
                  {s.hint && <kbd className="mono" style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 5, background: "var(--surface-2)", border: "1px solid var(--hairline)", color: s.accent ? "var(--accent)" : "var(--ink-4)" }}>{s.hint}</kbd>}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
