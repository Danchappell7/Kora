/* ============================================================
   KANBO — global quick capture
   Press "q" anywhere → a single-line bar that natural-language-parses
   a whole task (date, @assignee, #project, !priority, focus estimate)
   and creates it instantly. Zero form, zero context-switch.
   ============================================================ */
import { useState, useMemo, useRef, useEffect } from "react";
import { Icon, StatusDot, PriorityFlag, Avatar } from "./primitives";
import { parseTaskTokens, getProject, getMember, fmtDue } from "../data/data";
import type { Task, Status } from "../data/types";

export function QuickCapture({ open, onClose, projects, members, defaultProjectId, onCreate }: {
  open: boolean;
  onClose: () => void;
  projects: { id: string; name: string }[];
  members: { id: string; name: string }[];
  defaultProjectId?: string;
  onCreate: (partial: Partial<Task> & { title: string }) => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setText(""); setTimeout(() => inputRef.current?.focus(), 20); } }, [open]);

  const parsed = useMemo(() => parseTaskTokens(text, projects, members), [text, projects, members]);
  const projectId = parsed.projectId ?? defaultProjectId;

  if (!open) return null;

  const submit = () => {
    const title = parsed.title.trim();
    if (!title) return;
    onCreate({
      title,
      priority: parsed.priority ?? "medium",
      dueDate: parsed.dueDate,
      assigneeId: parsed.assigneeId,
      projectId,
      focusMin: parsed.focusMin,
      status: "todo" as Status,
    });
    onClose();
  };

  const chips: { icon: React.ReactNode; label: string }[] = [];
  if (projectId) chips.push({ icon: <StatusDot status="todo" size={7} />, label: getProject(projectId)?.name ?? "Project" });
  if (parsed.priority) chips.push({ icon: <PriorityFlag priority={parsed.priority} size={12} />, label: parsed.priority });
  if (parsed.dueDate) chips.push({ icon: <Icon name="calendar" size={12} />, label: fmtDue(parsed.dueDate) ?? parsed.dueDate });
  if (parsed.assigneeId) chips.push({ icon: <Avatar id={parsed.assigneeId} size={16} />, label: getMember(parsed.assigneeId)?.name ?? "Assignee" });
  if (parsed.focusMin) chips.push({ icon: <Icon name="zap" size={12} />, label: `${parsed.focusMin}m` });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "color-mix(in oklch, var(--ink) 22%, transparent)", backdropFilter: "blur(3px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "16vh" }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Quick capture" className="glass anim-scalein" style={{ width: 560, maxWidth: "94vw", borderRadius: 16, padding: 16, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <Icon name="zap" size={18} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } else if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
            placeholder="Add a task…  e.g. Pay invoice tomorrow #finance @maya !high"
            style={{ flex: 1, height: 30, border: "none", background: "transparent", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 17, outline: "none" }} />
        </div>
        {(chips.length > 0 || parsed.title.trim()) && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--hairline)" }}>
            {chips.map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, background: "var(--surface)", border: "1px solid var(--hairline)", fontSize: 12, color: "var(--ink-2)", textTransform: c.label === parsed.priority ? "capitalize" : "none" }}>
                {c.icon}{c.label}
              </span>
            ))}
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--ink-4)" }}>↵ to add · esc to cancel</span>
          </div>
        )}
        {chips.length === 0 && !parsed.title.trim() && (
          <p style={{ margin: "12px 0 2px", fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.5 }}>
            Try <code style={{ color: "var(--ink-3)" }}>#project</code> · <code style={{ color: "var(--ink-3)" }}>@person</code> · <code style={{ color: "var(--ink-3)" }}>!high</code> · <code style={{ color: "var(--ink-3)" }}>today/tomorrow</code> · <code style={{ color: "var(--ink-3)" }}>30m</code>
          </p>
        )}
      </div>
    </div>
  );
}
