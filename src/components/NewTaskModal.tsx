/* ============================================================
   KANBO — create-task modal (real, persisted task creation)
   ============================================================ */
import { useState, useEffect, useRef, useMemo } from "react";
import { Icon, Collapse } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { TagPicker } from "./TagPicker";
import { PRIORITY_META, energyOf, DUE_PRESETS, presetDate, parseTaskTokens, nextDueDate, seriesAnchorDay, todayISO } from "../data/data";
import { fmtDue } from "../data/data";
import { getTemplates, isBuiltinTemplateId, type TaskTemplate } from "../lib/templates";
import type { Task, Project, TagDef, WorkspaceMember, Recurrence, Priority, Status } from "../data/types";

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? "t-new-" + crypto.randomUUID() : "t-new-" + Date.now());
/** what the form held when it was last dismissed without Create/Cancel —
 *  offered back (never forced) the next time the modal opens */
interface SavedDraft {
  title: string; description: string; projectId: string; projectName: string;
  priority: Priority; assigneeId: string; dueDate: string; dueTime: string;
  recurrence: Recurrence; focusMin: number; tags: string[]; templateId: string;
}
const RECUR_OPTS: { v: Recurrence; label: string }[] = [
  { v: "none", label: "Doesn't repeat" }, { v: "daily", label: "Daily" }, { v: "weekdays", label: "Every weekday" }, { v: "weekly", label: "Weekly" }, { v: "biweekly", label: "Every 2 weeks" }, { v: "monthly", label: "Monthly" },
];

export function NewTaskModal({ open, onClose, onCreate, onCreateTag, onDeleteTag, projects, allTags, members, currentUserId, defaultStatus = "todo", defaultProjectId, tagUsage }: {
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
  /** how many tasks carry a tag, so deleting one from here says how many lose it */
  tagUsage?: (id: string) => number;
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
  const projectRef = useRef<HTMLSelectElement>(null);
  const focusDescOnMount = useRef(false);
  const wasOpen = useRef(false);
  // true after Create / Cancel: that form is finished with. Closing any other
  // way (Escape, the ✕, clicking outside) keeps what was typed as a saved draft.
  const startFresh = useRef(true);
  // The next open always starts BLANK (so "c", type, Enter creates exactly what
  // was typed) and offers the saved draft in a banner instead.
  const [savedDraft, setSavedDraft] = useState<SavedDraft | null>(null);
  // a restored draft whose project isn't in this workspace: its name, so we can
  // ask for a project rather than silently re-filing it (null = nothing to ask)
  const [missingProject, setMissingProject] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  const isMobile = useMediaQuery("(max-width: 860px)");

  // assignable people = active members of the SELECTED project's workspace only
  // (a personal project has no team members, so it's just you).
  const peopleIn = (pid: string) => {
    const ws = projects.find((p) => p.id === pid)?.workspaceId ?? null;
    const active = members.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === ws);
    return active.length > 0 ? active.map((m) => ({ id: m.userId!, name: m.name || m.email })) : [{ id: currentUserId, name: "You" }];
  };
  const people = peopleIn(projectId);
  // natural-language tokens in the title (e.g. "… tomorrow 90m #Foundrise !high @dan");
  // `today` keeps "today"/"tomorrow" right in a modal left open past midnight
  const today = todayISO();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parsed = useMemo(() => parseTaskTokens(title, projects, people), [title, projects, people, today]);
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
    setDescription(""); setDescOpen(false); setTemplateId(""); setMissingProject(null);
  };
  /** the form as a saved draft, or null when there's nothing worth keeping */
  const snapshot = (): SavedDraft | null => (title.trim() || description.trim()) ? {
    title, description, projectId, projectName: projects.find((p) => p.id === projectId)?.name ?? missingProject ?? "",
    priority, assigneeId, dueDate, dueTime, recurrence, focusMin, tags, templateId,
  } : null;

  // Reset the form only when the modal OPENS. Props like defaultProject can
  // change while it's open (a realtime reload reorders projects, the user id
  // settles) and must never wipe what the user is typing.
  useEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (was && !open) {
      // dismissed without Create/Cancel: what's in the form becomes the offered
      // draft (a newer one replaces an older one; an empty form keeps the old
      // offer). Taken now, while `projects` still describes its workspace.
      const left = startFresh.current ? null : snapshot();
      if (left) setSavedDraft(left);
      return;
    }
    if (!open || was) return;
    startFresh.current = false;
    resetDraft();
    setTemplates(getTemplates());
    window.setTimeout(() => inputRef.current?.focus(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProject, currentUserId]);

  // …but if the selected project disappears while open (deleted/archived by a
  // teammate), fall back to the default rather than creating into a ghost.
  // ("" means we're deliberately asking for a project — leave it.)
  useEffect(() => {
    if (open && projectId !== "" && projects.length > 0 && !projects.some((p) => p.id === projectId)) setProjectId(defaultProject);
  }, [open, projects, projectId, defaultProject]);

  if (!open) return null;

  const targetProject = parsed.projectId ?? projectId;
  const needsProject = !targetProject;
  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (needsProject) { projectRef.current?.focus(); return; }
    // only tags that still exist and have a real (server) id
    const liveTags = tags.filter((id) => !!allTags[id] && !id.startsWith("tmp-"));
    const t: Task = {
      id: newId(), title: parsed.title || trimmed, description: description.trim() ? description.replace(/\s+$/, "") : "",
      status: defaultStatus, priority: parsed.priority ?? priority, projectId: targetProject,
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

  // Bring the saved draft back. It's a swap: anything already typed becomes the
  // offered draft, so restoring never loses work. A draft is never moved to
  // another workspace's project behind the user's back — if its project isn't
  // here (workspace switched, project archived) we ask for one instead.
  const restoreDraft = () => {
    const d = savedDraft;
    if (!d) return;
    setSavedDraft(snapshot());
    const here = projects.some((p) => p.id === d.projectId);
    const pid = here ? d.projectId : "";
    setTitle(d.title); setDescription(d.description); setDescOpen(!!d.description.trim());
    setProjectId(pid); setMissingProject(here ? null : d.projectName);
    setAssigneeId(peopleIn(pid).some((p) => p.id === d.assigneeId) ? d.assigneeId : currentUserId);
    setPriority(d.priority); setDueDate(d.dueDate); setDueTime(d.dueTime); setRecurrence(d.recurrence); setFocusMin(d.focusMin);
    setTags(d.tags.filter((id) => !!allTags[id]));
    setTemplateId(templates.some((t) => t.id === d.templateId) ? d.templateId : "");
    window.setTimeout(() => {
      if (!here) { projectRef.current?.focus(); return; }
      const el = inputRef.current;
      if (el) { el.focus(); el.setSelectionRange(d.title.length, d.title.length); }
    }, 0);
  };
  const discardDraft = () => { setSavedDraft(null); window.setTimeout(() => inputRef.current?.focus(), 0); };
  const draftName = savedDraft ? (savedDraft.title.trim() || "Untitled task") : "";

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
          {savedDraft && (
            <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: -4, padding: "7px 10px", borderRadius: 9, background: "var(--fill-1, var(--surface-2))", color: "var(--ink-3)", fontSize: 12.5 }}>
              <Icon name="refresh" size={13} style={{ flexShrink: 0 }} />
              <span title={savedDraft.title} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Unsaved draft: “{draftName}”</span>
              <button type="button" onClick={restoreDraft} aria-label={`Restore draft “${draftName}”`} style={{ ...bannerBtn, color: "var(--accent)" }}>Restore</button>
              <button type="button" onClick={discardDraft} aria-label={`Discard draft “${draftName}”`} style={{ ...bannerBtn, color: "var(--ink-3)" }}>Discard</button>
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
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={fieldLabel}>Project
                <select ref={projectRef} value={projectId} onChange={(e) => { setProjectId(e.target.value); setMissingProject(null); }}
                  aria-invalid={needsProject || undefined} aria-describedby={needsProject ? "kanbo-newtask-projnote" : undefined}
                  style={{ ...selectStyle, ...(needsProject ? { border: "1px solid var(--prio-urgent)" } : null) }}>
                  {projectId === "" && <option value="" disabled>Choose a project…</option>}
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>)}
                </select>
              </label>
              {needsProject && (
                <span id="kanbo-newtask-projnote" style={{ fontSize: 11.5, lineHeight: 1.4, color: "var(--prio-urgent)" }}>
                  {missingProject ? `“${missingProject}” isn't in this workspace — choose a project for this draft.` : "Choose a project for this draft."}
                </span>
              )}
            </div>
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
                  Next: {[1, 2, 3].reduce<string[]>((acc) => { const last = acc[acc.length - 1] || (dueDate || undefined); acc.push(nextDueDate(last, recurrence, seriesAnchorDay({ dueDate: dueDate || undefined }))); return acc; }, []).map((d) => { try { return new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }); } catch { return d; } }).join(" · ")}
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
            <TagPicker tags={allTags} selected={tags} onToggle={toggleTag} onCreate={onCreateTag} onDelete={deleteTag} usage={tagUsage} ownerKey="new-task" />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 18px", borderTop: "1px solid var(--hairline)", flexShrink: 0 }}>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button>
          <button type="button" className="btn btn-accent" onClick={submit} disabled={!title.trim() || needsProject} title="Create task (Ctrl/⌘ + Enter)" style={{ opacity: title.trim() && !needsProject ? 1 : 0.5 }}>
            <Icon name="plus" size={15} /> Create task
          </button>
        </div>
      </div>
    </div>
  );
}

const fieldLabel: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-4)" };
const bannerBtn: React.CSSProperties = { flexShrink: 0, border: "none", background: "transparent", padding: "2px 4px", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500 };
const selectStyle: React.CSSProperties = { height: 38, padding: "0 11px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, fontWeight: 400, textTransform: "none", letterSpacing: "normal" };
