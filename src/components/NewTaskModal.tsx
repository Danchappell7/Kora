/* ============================================================
   KORA — create-task modal (real, persisted task creation)
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Icon } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { TagPicker } from "./TagPicker";
import { PRIORITY_META, energyOf } from "../data/data";
import type { Task, Project, TagDef, Priority, Status } from "../data/types";

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? "t-new-" + crypto.randomUUID() : "t-new-" + Date.now());

export function NewTaskModal({ open, onClose, onCreate, onCreateTag, onDeleteTag, projects, allTags, currentUserId, defaultStatus = "todo", defaultProjectId }: {
  open: boolean;
  onClose: () => void;
  onCreate: (t: Task) => void;
  onCreateTag: (label: string, color: string) => void;
  onDeleteTag: (id: string) => void;
  projects: Project[];
  allTags: Record<string, TagDef>;
  currentUserId: string;
  defaultStatus?: Status;
  defaultProjectId?: string;
}) {
  const firstProject = defaultProjectId || projects[0]?.id || "p-personal";
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(firstProject);
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [focusMin, setFocusMin] = useState(30);
  const [tags, setTags] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);

  useEffect(() => {
    if (open) {
      setTitle(""); setProjectId(defaultProjectId || projects[0]?.id || "p-personal");
      setPriority("medium"); setDueDate(""); setFocusMin(30); setTags([]);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open, defaultProjectId, projects]);

  if (!open) return null;

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const t: Task = {
      id: newId(), title: trimmed, description: "",
      status: defaultStatus, priority, projectId,
      assigneeId: currentUserId, dueDate: dueDate || undefined,
      tags, dependencies: [], subtasks: [], comments: 0,
      focusMin, dur: focusMin, energy: energyOf({ tags } as Task),
      scheduled: null, planToday: true, aiScore: 50,
    };
    onCreate(t);
    onClose();
  };

  const toggleTag = (id: string) => setTags((ts) => ts.includes(id) ? ts.filter((x) => x !== id) : [...ts, id]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 110, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="New task" onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 540, maxWidth: "92vw", borderRadius: 18, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="plus" size={18} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>New task</span>
          <button className="btn-icon" onClick={onClose} style={{ marginLeft: "auto", border: "none", width: 30, height: 30 }}><Icon name="x" size={17} /></button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <input ref={inputRef} value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Task title…"
            style={{ width: "100%", height: 44, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15.5, fontWeight: 500, outline: "none" }} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={fieldLabel}>Project
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={selectStyle}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>)}
              </select>
            </label>
            <label style={fieldLabel}>Priority
              <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} style={selectStyle}>
                {(Object.keys(PRIORITY_META) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
              </select>
            </label>
            <label style={fieldLabel}>Due date
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={selectStyle} />
            </label>
            <label style={fieldLabel}>Focus estimate (min)
              <input type="number" min={5} step={5} value={focusMin} onChange={(e) => setFocusMin(Math.max(5, parseInt(e.target.value) || 5))} style={selectStyle} />
            </label>
          </div>

          <div>
            <div style={{ ...fieldLabel, marginBottom: 8 }}>Tags</div>
            <TagPicker tags={allTags} selected={tags} onToggle={toggleTag} onCreate={onCreateTag} onDelete={onDeleteTag} />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 18px", borderTop: "1px solid var(--hairline)" }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-accent" onClick={submit} disabled={!title.trim()} style={{ opacity: title.trim() ? 1 : 0.5 }}>
            <Icon name="plus" size={15} /> Create task
          </button>
        </div>
      </div>
    </div>
  );
}

const fieldLabel: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-4)" };
const selectStyle: React.CSSProperties = { height: 38, padding: "0 11px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, fontWeight: 400, textTransform: "none", letterSpacing: "normal", outline: "none" };
