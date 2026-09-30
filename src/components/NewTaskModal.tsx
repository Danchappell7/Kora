/* ============================================================
   KANBO — create-task modal (real, persisted task creation)
   ============================================================ */
import { useState, useEffect, useRef, useMemo } from "react";
import { Icon, Collapse } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { TagPicker } from "./TagPicker";
import { PRIORITY_META, energyOf, DUE_PRESETS, presetDate, parseTaskTokens, nextDueDate } from "../data/data";
import { fmtDue } from "../data/data";
import { getTemplates, isBuiltinTemplateId, type TaskTemplate } from "../lib/templates";
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
  const [dueTime, setDueTime] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("none");
  const [focusMin, setFocusMin] = useState(30);
  const [tags, setTags] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [descOpen, setDescOpen] = useState(false);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const focusDescOnMount = useRef(false);
  const wasOpen = useRef(false);
  // true when the next open should start blank (after Create / Cancel). Closing
  // any other way (Escape, the ✕, clicking outside) keeps the draft, so an
  // accidental dismissal never loses what was typed.
  const startFresh = useRef(true);
  const [restored, setRestored] = useState(false);
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

  const resetDraft = () => {
    setTitle(""); setProjectId(defaultProject);
    setPriority("medium"); setAssigneeId(currentUserId); setDueDate(""); setDueTime(""); setRecurrence("none"); setFocusMin(30); setTags([]);
    setDescription(""); setDescOpen(false); setTemplateId(""); setRestored(false);
  };

  // Reset the draft only when the modal OPENS. Props like defaultProject can
  // change while it's open (a realtime reload reorders projects, the user id
  // settles) and must never wipe what the user is typing.
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    const keep = !startFresh.current && (title.trim() !== "" || description.trim() !== "");
    startFresh.current = false;
    if (keep) {
      setRestored(true);
      // opened from a specific project → file the restored draft there
      if (defaultProjectId && defaultProjectId !== projectId) setProjectId(defaultProjectId);
    } else resetDraft();
    setTemplates(getTemplates());
    window.setTimeout(() => inputRef.current?.focus(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProject, currentUserId]);

  // …but if the selected project disappears while open (deleted/archived by a
  // teammate), fall back to the default rather than creating into a ghost.
  useEffect(() => {
    if (open && projects.length > 0 && !projects.some((p) => p.id === projectId)) setProjectId(defaultProject);
  }, [open, projects, projectId, defaultProject]);

  if (!open) return null;

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    // only tags that still exist and have a real (server) id
    const liveTags = tags.filter((id) => !!allTags[id] && !id.startsWith("tmp-"));
    const t: Task = {
      id: newId(), title: parsed.title || trimmed, description: description.trim() ? description.replace(/\s+$/, "") : "",
      status: defaultStatus, priority: parsed.priority ?? priority, projectId: parsed.projectId ?? projectId,
      assigneeId: parsed.assigneeId ?? assigneeId, dueDate: parsed.dueDate ?? (dueDate || undefined), dueTime: dueTime || undefined,
      tags: liveTags, dependencies: [], subtasks: [], comments: 0,
      focusMin: parsed.focusMin ?? focusMin, dur: parsed.focusMin ?? focusMin, energy: energyOf({ tags: liveTags } as Task),
      scheduled: null, planToday: true, aiScore: 50, recurrence,
    };
    onCreate(t);
    startFresh.current = true;
    onClose();
  };
  const cancel = () => { startFresh.current = true; onClose(); };
  const startOver = () => { resetDraft(); window.setTimeout(() => inputRef.current?.focus(), 0); };

  const toggleTag = (id: string) => setTags((ts) => ts.includes(id) ? ts.filter((x) => x !== id) : [...ts, id]);
  // deleting a tag (workspace-wide) also drops it from this draft
  const deleteTag = (id: string) => { setTags((ts) => ts.filter((x) => x !== id)); onDeleteTag(id); };

  // Apply a template's settings. What the user has already chosen or typed is
  // never thrown away: title/description are only filled when empty or still
  // showing the previous template's text, and tags they picked themselves stay
  // (only the previous template's tags are swapped out). "Blank task" undoes it.
  const applyTemplate = (id: string) => {
    const prev = templates.find((x) => x.id === templateId);
    const next = templates.find((x) => x.id === id);
    const untouched = (cur: string, was: string | undefined) => !cur.trim() || (was !== undefined && cur === was);
    const ownTags = tags.filter((t) => !prev?.tags.includes(t));
    setTemplateId(next ? next.id : "");
    if (!next) {
      if (prev) {
        if (untouched(title, prev.title)) setTitle("");
        if (untouched(description, prev.description)) { setDescription(""); setDescOpen(false); }
        setPriority("medium"); setTags(ownTags); setFocusMin(30); setRecurrence("none");
      }
      return;
    }
    const nextTitle = untouched(title, prev?.title) ? next.title : title;
    setTitle(nextTitle);
    if (untouched(description, prev?.description)) setDescription(next.description);
    if (next.description) setDescOpen(true);
    setPriority(next.priority); setFocusMin(next.focusMin); setRecurrence(next.recurrence);
    // skip template tags deleted since it was saved
    setTags([...new Set([...ownTags, ...next.tags.filter((tid) => !!allTags[tid])])]);
    window.setTimeout(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(nextTitle.length, nextTitle.length); } }, 0);
  };
  const showDesc = descOpen || !!description;
  const builtinTemplates = templates.filter((t) => isBuiltinTemplateId(t.id));
  const userTemplates = templates.filter((t) => !isBuiltinTemplateId(t.id));

  return (
    // the body scrolls inside a height-capped dialog so the Create button stays
    // reachable on short/mobile screens (templates + description + tags add up)
    <div onClick={onClose} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 110, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: isMobile ? "12px 12px" : "12vh 16px 16px" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="New task" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) { e.preventDefault(); submit(); } }}
        className="glass anim-scalein" style={{ width: 540, maxWidth: "100%", maxHeight: "100%", display: "flex", flexDirection: "column", borderRadius: 18, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 18px", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
          <Icon name="plus" size={18} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>New task</span>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto", border: "none", width: 30, height: 30 }}><Icon name="x" size={17} /></button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", minHeight: 0 }}>
          {restored && (
            <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: -4, padding: "7px 10px", borderRadius: 9, background: "var(--fill-1, var(--surface-2))", color: "var(--ink-3)", fontSize: 12.5 }}>
              <Icon name="refresh" size={13} />
              <span style={{ flex: 1 }}>Restored your unsaved draft.</span>
              <button type="button" onClick={startOver} style={{ border: "none", background: "transparent", padding: "2px 4px", color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500 }}>Start over</button>
            </div>
          )}
          {templates.length > 0 && (
            <label style={{ ...fieldLabel, marginBottom: -4 }}>Start from template
              <select value={templateId} onChange={(e) => applyTemplate(e.target.value)} style={selectStyle}>
                <option value="">Blank task</option>
                {userTemplates.length > 0 ? (
                  <>
                    <optgroup label="Your templates">
                      {userTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </optgroup>
                    <optgroup label="Kanbo templates">
                      {builtinTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </optgroup>
                  </>
                ) : builtinTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <input ref={inputRef} value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); submit(); } }}
            aria-label="Task title"
            placeholder="Task title…  try “tomorrow 90m #project !high”"
            style={{ width: "100%", height: 44, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15.5, fontWeight: 500 }} />
          {tokenChips.length > 0 && (
            <div aria-live="polite" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: -6 }}>
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
            <label style={fieldLabel}>Due date
              <div style={{ display: "flex", gap: 8 }}>
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={{ ...selectStyle, flex: 1 }} />
                <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} title="Due time" aria-label="Due time" style={{ ...selectStyle, width: 110 }} />
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
              {recurrence !== "none" && (
                <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 400, textTransform: "none", letterSpacing: 0, marginTop: 4 }}>
                  Next: {[1, 2, 3].reduce<string[]>((acc) => { const last = acc[acc.length - 1] || (dueDate || undefined); acc.push(nextDueDate(last, recurrence)); return acc; }, []).map((d) => { try { return new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }); } catch { return d; } }).join(" · ")}
                </span>
              )}
            </label>
            <label style={fieldLabel}>Focus estimate (min)
              <input type="number" min={5} step={5} value={focusMin} onChange={(e) => setFocusMin(Math.max(5, parseInt(e.target.value) || 5))} style={selectStyle} />
            </label>
          </div>

          <div>
            {!showDesc && (
              <button type="button" aria-expanded={false} aria-controls="kanbo-newtask-desc" onClick={() => { focusDescOnMount.current = true; setDescOpen(true); }}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 2px", border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13 }}>
                <Icon name="plus" size={13} /> Add description
              </button>
            )}
            <Collapse open={showDesc}>
              <label style={fieldLabel}>Description
                <textarea id="kanbo-newtask-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
                  ref={(el) => { if (el && focusDescOnMount.current) { focusDescOnMount.current = false; el.focus(); } }}
                  placeholder="Add more detail… **bold**, - lists and links work"
                  style={{ ...selectStyle, width: "100%", height: "auto", minHeight: 88, padding: "9px 11px", lineHeight: 1.5, resize: "vertical", boxSizing: "border-box" }} />
              </label>
            </Collapse>
          </div>

          <div>
            <div style={{ ...fieldLabel, marginBottom: 8 }}>Tags</div>
            <TagPicker tags={allTags} selected={tags} onToggle={toggleTag} onCreate={onCreateTag} onDelete={deleteTag} />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 18px", borderTop: "1px solid var(--hairline)", flexShrink: 0 }}>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button>
          <button type="button" className="btn btn-accent" onClick={submit} disabled={!title.trim()} title="Create task (Ctrl/⌘ + Enter)" style={{ opacity: title.trim() ? 1 : 0.5 }}>
            <Icon name="plus" size={15} /> Create task
          </button>
        </div>
      </div>
    </div>
  );
}

const fieldLabel: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-4)" };
const selectStyle: React.CSSProperties = { height: 38, padding: "0 11px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, fontWeight: 400, textTransform: "none", letterSpacing: "normal" };
