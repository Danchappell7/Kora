/* ============================================================
   KANBO — create-task modal (real, persisted task creation)
   ============================================================ */
import { useState, useEffect, useRef, useMemo } from "react";
import { Icon } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { TagPicker } from "./TagPicker";
import { PRIORITY_META, energyOf, DUE_PRESETS, presetDate, parseTaskTokens } from "../data/data";
import { fmtDue } from "../data/data";
import { getTemplates, type TaskTemplate } from "../lib/templates";
import type { Task, Project, TagDef, WorkspaceMember, Recurrence, Priority, Status } from "../data/types";

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? "t-new-" + crypto.randomUUID() : "t-new-" + Date.now());
const RECUR_OPTS: { v: Recurrence; label: string }[] = [
  { v: "none", label: "Doesn't repeat" }, { v: "daily", label: "Daily" }, { v: "weekdays", label: "Every weekday" }, { v: "weekly", label: "Weekly" }, { v: "biweekly", label: "Every 2 weeks" }, { v: "monthly", label: "Monthly" },
];

export function NewTaskModal({ open, onClose, onCreate, onCreateTag, onDeleteTag, projects, allTags, members, currentUserId, defaultStatus = "todo", defaultProjectId }: {
  open: boolean;
  onClose: () => void;
  onCreate: (t: Task) => void;
  onCreateTag: (label: string, color: string) => void;
  onDeleteTag: (id: string) => void;
  projects: Project[];
  allTags: Record<string, TagDef>;
  members: WorkspaceMember[];
  currentUserId: string;
  defaultStatus?: Status;
  defaultProjectId?: string;
}) {
  // Default to the project you're in (defaultProjectId); otherwise the neutral
  // "Personal" bucket rather than auto-picking a real project.
  const defaultProject = defaultProjectId
    || (projects.some((p) => p.id === "p-personal") ? "p-personal" : projects[0]?.id)
    || "p-personal";
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(defaultProject);
  const [priority, setPriority] = useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = useState(currentUserId);
  const [dueDate, setDueDate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("none");
  const [focusMin, setFocusMin] = useState(30);
  const [tags, setTags] = useState<string[]>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  const isMobile = useMediaQuery("(max-width: 860px)");

  // assignable people = active members of the SELECTED project's workspace only
  // (a personal project has no team members, so it's just you).
  const projWs = projects.find((p) => p.id === projectId)?.workspaceId ?? null;
  const assignable = members.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === projWs);
  const people = assignable.length > 0 ? assignable.map((m) => ({ id: m.userId!, name: m.name || m.email })) : [{ id: currentUserId, name: "You" }];
  // natural-language tokens in the title (e.g. "… tomorrow 90m #Foundrise !high @dan")
  const parsed = useMemo(() => parseTaskTokens(title, projects, people), [title, projects, people]);
  const tokenChips = [
    parsed.dueDate ? { k: "due", label: fmtDue(parsed.dueDate) } : null,
    parsed.priority ? { k: "prio", label: PRIORITY_META[parsed.priority].label } : null,
    parsed.projectId ? { k: "proj", label: projects.find((p) => p.id === parsed.projectId)?.name ?? "Project" } : null,
    parsed.assigneeId ? { k: "asgn", label: people.find((p) => p.id === parsed.assigneeId)?.name ?? "Assignee" } : null,
    parsed.focusMin != null ? { k: "dur", label: `${parsed.focusMin}m` } : null,
  ].filter(Boolean) as { k: string; label: string }[];

  // when the project (and thus workspace) changes, keep the assignee valid
  useEffect(() => {
    if (!people.some((p) => p.id === assigneeId)) {
      setAssigneeId(people.some((p) => p.id === currentUserId) ? currentUserId : (people[0]?.id ?? currentUserId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (open) {
      setTitle(""); setProjectId(defaultProject);
      setPriority("medium"); setAssigneeId(currentUserId); setDueDate(""); setStartDate(""); setDueTime(""); setRecurrence("none"); setFocusMin(30); setTags([]);
      setTemplates(getTemplates());
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open, defaultProject, currentUserId]);

  if (!open) return null;

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const t: Task = {
      id: newId(), title: parsed.title || trimmed, description: "",
      status: defaultStatus, priority: parsed.priority ?? priority, projectId: parsed.projectId ?? projectId,
      assigneeId: parsed.assigneeId ?? assigneeId, dueDate: parsed.dueDate ?? (dueDate || undefined), startDate: startDate || undefined, dueTime: dueTime || undefined,
      tags, dependencies: [], subtasks: [], comments: 0,
      focusMin: parsed.focusMin ?? focusMin, dur: parsed.focusMin ?? focusMin, energy: energyOf({ tags } as Task),
      scheduled: null, planToday: true, aiScore: 50, recurrence,
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
          {templates.length > 0 && (
            <label style={{ ...fieldLabel, marginBottom: -4 }}>Start from template
              <select value="" onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) { setTitle(t.title); setPriority(t.priority); setTags(t.tags); setFocusMin(t.focusMin); setRecurrence(t.recurrence); } }} style={selectStyle}>
                <option value="">Blank task</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <input ref={inputRef} value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Task title…  try “tomorrow 90m #project !high”"
            style={{ width: "100%", height: 44, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15.5, fontWeight: 500, outline: "none" }} />
          {tokenChips.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: -6 }}>
              <span style={{ fontSize: 11, color: "var(--ink-4)", alignSelf: "center" }}>Detected:</span>
              {tokenChips.map((c) => (
                <span key={c.k} className="pchip" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>{c.label}</span>
              ))}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
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
            <label style={fieldLabel}>Assignee
              <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} style={selectStyle}>
                {people.map((p) => <option key={p.id} value={p.id}>{p.id === currentUserId ? `${p.name} (you)` : p.name}</option>)}
              </select>
            </label>
            <label style={fieldLabel}>Start date
              <input type="date" value={startDate} max={dueDate || undefined} onChange={(e) => setStartDate(e.target.value)} style={selectStyle} />
            </label>
            <label style={fieldLabel}>Due date
              <div style={{ display: "flex", gap: 8 }}>
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={{ ...selectStyle, flex: 1 }} />
                <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} title="Due time" style={{ ...selectStyle, width: 110 }} />
              </div>
              <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
                {DUE_PRESETS.map((p) => (
                  <button key={p.kind} type="button" onClick={() => setDueDate(presetDate(p.kind))} style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-display)" }}>{p.label}</button>
                ))}
              </div>
            </label>
            <label style={fieldLabel}>Repeat
              <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)} style={selectStyle}>
                {RECUR_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
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
