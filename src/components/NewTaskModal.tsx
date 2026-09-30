/* ============================================================
   KANBO — New task: the full form (real, persisted task creation).
   The title reads a whole task as you type ("Email Sana fri 3pm #launch
   !high"), highlighting each token it understood; the properties below
   always show what will be created, and a token the title set is tinted
   to match its highlight. Choosing a property yourself takes over from
   the token (it comes out of the title), so the two never disagree.
   Dates use the DateChip (no native date or time inputs).
   ============================================================ */
import { useState, useEffect, useRef, useMemo, useId } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Icon, Collapse, Button, DateChip, PriorityGlyph, ProjectDot, Sheet } from "./primitives";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { TagPicker } from "./TagPicker";
import { TokenField, TokenChips, PersonMark, CAPTURE_CSS } from "./QuickCapture";
import { PRIORITY_META, energyOf, nextDueDate, seriesAnchorDay, todayISO, KANBO_TODAY } from "../data/data";
import { parseTask, parseDateText, stripTokens, dayLabel, fmtMinutes, type NlpKind } from "../lib/nlp";
import { getTemplates, isBuiltinTemplateId, type TaskTemplate } from "../lib/templates";
import type { Task, Project, TagDef, WorkspaceMember, Recurrence, Priority, Status } from "../data/types";

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? "t-new-" + crypto.randomUUID() : "t-new-" + Date.now());
/** what the form held when it was last dismissed without Create/Cancel —
 *  offered back (never forced) the next time the modal opens */
interface SavedDraft {
  title: string; description: string; projectId: string; projectName: string;
  priority: Priority; assigneeId: string; dueDate: string; dueTime: string; startDate: string;
  recurrence: Recurrence; focusMin: number; tags: string[]; templateId: string;
}
const RECUR_OPTS: { v: Recurrence; label: string }[] = [
  { v: "none", label: "Doesn't repeat" }, { v: "daily", label: "Daily" }, { v: "weekdays", label: "Every weekday" }, { v: "weekly", label: "Weekly" }, { v: "biweekly", label: "Every 2 weeks" }, { v: "monthly", label: "Monthly" },
];
const PRIORITY_ORDER: Priority[] = ["urgent", "high", "medium", "low"];
const FOCUS_STEPS = [15, 30, 45, 60, 90, 120, 180, 240];
/** the title tokens each property takes over from */
const OWNS: Record<"due" | "start" | "priority" | "project" | "person" | "focus" | "repeat", NlpKind[]> = {
  due: ["date", "time"], start: ["start"], priority: ["priority"], project: ["project"], person: ["person"], focus: ["duration"], repeat: ["repeat"],
};
/** tokens a property row (or the tag picker) shows; the rest are chips under the title */
const HAS_ROW: NlpKind[] = ["date", "time", "start", "priority", "project", "person", "duration", "repeat", "tag"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "9 Oct" — the repeat preview's short dates */
const shortDay = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}` : iso; };

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
  const [startDate, setStartDate] = useState("");
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
  const isMobile = useMediaQuery("(max-width: 859px)");
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const idOf = (k: string) => `knt${uid}-${k}`;

  // assignable people = active members of the SELECTED project's workspace only
  // (a personal project has no team members, so it's just you).
  const peopleIn = (pid: string) => {
    const ws = projects.find((p) => p.id === pid)?.workspaceId ?? null;
    const active = members.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === ws);
    return active.length > 0 ? active.map((m) => ({ id: m.userId!, name: m.name || m.email })) : [{ id: currentUserId, name: "You" }];
  };
  const wsOf = (pid: string) => projects.find((p) => p.id === pid)?.workspaceId ?? null;

  // The title's natural-language tokens ("… fri 3pm 90m #launch !high @sana +design").
  // "@sana" is looked up among the people of the project the task will land
  // in, so a "#project" typed in the same title is read first. `today` keeps
  // "today"/"fri" right in a modal left open past midnight.
  const today = todayISO();
  const parsed = useMemo(() => {
    const ctx = { today: new Date(KANBO_TODAY), projects, tags: allTags };
    const first = parseTask(title, { ...ctx, members: peopleIn(projectId) });
    const lands = first.projectId ?? projectId;
    return wsOf(lands) === wsOf(projectId) ? first : parseTask(title, { ...ctx, members: peopleIn(lands) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, projects, members, allTags, projectId, currentUserId, today]);
  const typed = (kinds: NlpKind[]) => parsed.spans.some((s) => kinds.includes(s.kind));

  // what will be created: a token in the title, else the property's own value
  const targetProject = parsed.projectId ?? projectId;
  const people = peopleIn(targetProject);
  const effPriority = parsed.priority ?? priority;
  const effAssignee = parsed.assigneeId ?? assigneeId;
  const dueFromTitle = typed(OWNS.due);
  // a repeat typed with no day starts on its first occurrence (unless a date was chosen)
  const effDue = dueFromTitle ? (parsed.dueDate ?? "") : (dueDate || parsed.dueDate || "");
  const effTime = effDue ? (dueFromTitle ? (parsed.dueTime ?? "") : dueTime) : "";
  const effStart = parsed.startDate ?? startDate;
  const effRecurrence = parsed.recurrence ?? recurrence;
  const effFocus = parsed.focusMin ?? focusMin;
  const titleTags = (parsed.tags ?? []).filter((id) => !!allTags[id]);

  // when the project (and so the workspace) changes, keep the assignee valid
  useEffect(() => {
    if (!people.some((p) => p.id === assigneeId)) {
      setAssigneeId(people.some((p) => p.id === currentUserId) ? currentUserId : (people[0]?.id ?? currentUserId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetProject]);

  const resetDraft = () => {
    setTitle(""); setProjectId(defaultProject);
    setPriority("medium"); setAssigneeId(currentUserId); setDueDate(""); setDueTime(""); setStartDate(""); setRecurrence("none"); setFocusMin(30); setTags([]);
    setDescription(""); setDescOpen(false); setTemplateId(""); setMissingProject(null);
  };
  /** the form as a saved draft, or null when there's nothing worth keeping */
  const snapshot = (): SavedDraft | null => (title.trim() || description.trim()) ? {
    title, description, projectId, projectName: projects.find((p) => p.id === projectId)?.name ?? missingProject ?? "",
    priority, assigneeId, dueDate, dueTime, startDate, recurrence, focusMin, tags, templateId,
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

  const needsProject = !targetProject;
  const canCreate = !!title.trim() && !needsProject;
  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (needsProject) { projectRef.current?.focus(); return; }
    // only tags that still exist and have a real (server) id; "+design" in the title adds to them
    const liveTags = [...new Set([...tags, ...titleTags])].filter((id) => !!allTags[id] && !id.startsWith("tmp-"));
    const t: Task = {
      id: newId(), title: parsed.title || trimmed, description: description.trim() ? description.replace(/\s+$/, "") : "",
      status: defaultStatus, priority: effPriority, projectId: targetProject,
      assigneeId: effAssignee, dueDate: effDue || undefined, dueTime: effTime || undefined,
      ...(effStart ? { startDate: effStart } : {}),
      tags: liveTags, dependencies: [], subtasks: [], comments: 0,
      focusMin: effFocus, dur: effFocus, energy: parsed.energy ?? energyOf({ tags: liveTags } as Task),
      ...(parsed.effortHours ? { effortHours: parsed.effortHours } : {}),
      scheduled: null, planToday: true, aiScore: 50, recurrence: effRecurrence,
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
    setPriority(d.priority); setDueDate(d.dueDate); setDueTime(d.dueTime); setStartDate(d.startDate); setRecurrence(d.recurrence); setFocusMin(d.focusMin);
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

  // a "+design" in the title shows as picked; un-picking it takes the token out of the title
  const toggleTag = (id: string) => {
    if (titleTags.includes(id)) {
      const label = allTags[id]?.label;
      setTitle(stripTokens(title, parsed.spans.filter((s) => s.kind === "tag" && s.label === label), ["tag"]));
      setTags((ts) => ts.filter((x) => x !== id));
      return;
    }
    setTags((ts) => ts.includes(id) ? ts.filter((x) => x !== id) : [...ts, id]);
  };
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

  /** a property was chosen by hand: it takes over from any token typed for it */
  const takeOver = (kinds: NlpKind[]) => { if (typed(kinds)) setTitle(stripTokens(title, parsed.spans, kinds)); };
  const pickProject = (id: string) => { takeOver(OWNS.project); setProjectId(id); setMissingProject(null); };
  const pickPriority = (p: Priority) => { takeOver(OWNS.priority); setPriority(p); };
  const pickAssignee = (id: string) => { takeOver(OWNS.person); setAssigneeId(id); };
  const pickDue = (date: string | undefined, time?: string) => { takeOver(OWNS.due); setDueDate(date ?? ""); setDueTime(date ? (time ?? "") : ""); };
  const pickStart = (date: string | undefined) => { takeOver(OWNS.start); setStartDate(date ?? ""); };
  const pickRepeat = (r: Recurrence) => { takeOver(OWNS.repeat); setRecurrence(r); };
  const pickFocus = (m: number) => { takeOver(OWNS.focus); setFocusMin(m); };

  const showDesc = descOpen || !!description;
  const builtinTemplates = templates.filter((t) => isBuiltinTemplateId(t.id));
  const userTemplates = templates.filter((t) => !isBuiltinTemplateId(t.id));
  const project = projects.find((p) => p.id === targetProject);
  const assignee = people.find((p) => p.id === effAssignee);
  const focusOpts = [...new Set([...FOCUS_STEPS, effFocus])].sort((a, b) => a - b);
  const nextRuns = effRecurrence !== "none"
    ? [1, 2, 3].reduce<string[]>((acc) => {
      const last = acc[acc.length - 1] || (effDue || undefined);
      acc.push(nextDueDate(last, effRecurrence, seriesAnchorDay({ dueDate: effDue || undefined })));
      return acc;
    }, []).map(shortDay)
    : [];
  // what the title set, for screen readers (the highlight and the tint are visual)
  const heard = [
    dueFromTitle && effDue ? `Due ${dayLabel(effDue)}${effTime ? ` at ${effTime}` : ""}` : null,
    parsed.startDate ? `Starts ${dayLabel(parsed.startDate)}` : null,
    parsed.recurrence ? RECUR_OPTS.find((o) => o.v === parsed.recurrence)?.label : null,
    parsed.priority ? `${PRIORITY_META[parsed.priority].label} priority` : null,
    parsed.projectId && project ? `In ${project.name}` : null,
    parsed.assigneeId && assignee ? `For ${assignee.name}` : null,
    parsed.focusMin ? `${fmtMinutes(parsed.focusMin)} of focus` : null,
  ].filter(Boolean).join(" · ");

  const onTitleKey = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); submit(); }
  };
  const size = isMobile ? "lg" : "md";
  const footer = (
    <div className="knt-foot">
      <Button variant="ghost" size={size} onClick={cancel}>Cancel</Button>
      <Button variant="primary" size={size} icon="plus" kbd={isMobile ? undefined : "⌘↵"} onClick={submit}
        disabled={!canCreate} title="Create task (Ctrl/⌘ + Enter)">Create task</Button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} label="New task" title="New task" width={640} footer={footer}
      initialFocus={inputRef as React.RefObject<HTMLElement>}>
      <style>{CAPTURE_CSS}{NEW_TASK_CSS}</style>
      <div className="knt" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) { e.preventDefault(); submit(); } }}>
        {open && savedDraft && (
          <div role="status" className="knt-draft">
            <Icon name="refresh" size={14} sw={1.75} />
            <span className="knt-draft-text" title={savedDraft.title}>Unsaved draft: “{draftName}”</span>
            <button type="button" className="knt-link" data-tone="accent" onClick={restoreDraft} aria-label={`Restore draft “${draftName}”`}>Restore</button>
            <button type="button" className="knt-link" onClick={discardDraft} aria-label={`Discard draft “${draftName}”`}>Discard</button>
          </div>
        )}
        {templates.length > 0 && (
          <label className="knt-template">
            <Icon name="layers" size={14} sw={1.75} />
            <span>Template</span>
            <select className="knt-select" value={templateId} onChange={(e) => applyTemplate(e.target.value)} aria-label="Start from template">
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

        <div className="knt-title">
          <TokenField ref={inputRef as React.Ref<HTMLInputElement | HTMLTextAreaElement>} value={title} onValueChange={setTitle}
            spans={parsed.spans} label="Task title" focusRing="none" onKeyDown={onTitleKey}
            placeholder="Task title — try “Email Sana fri 3pm #launch !high”" />
        </div>
        <TokenChips parsed={parsed} projects={projects} members={people} tags={allTags} skip={HAS_ROW} />
        <p className="sr-only" aria-live="polite">{heard}</p>

        <div className="knt-desc">
          {!showDesc && (
            <Button variant="ghost" size="sm" icon="plus" aria-expanded={false} aria-controls={idOf("desc")}
              onClick={() => { focusDescOnMount.current = true; setDescOpen(true); }}>Add description</Button>
          )}
          <Collapse open={showDesc}>
            <label className="knt-desc-label">
              <span className="sr-only">Description</span>
              <textarea id={idOf("desc")} className="knt-desc-field" value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
                ref={(el) => { if (el && focusDescOnMount.current) { focusDescOnMount.current = false; el.focus(); } }}
                placeholder="Add a description… **bold**, - lists and links work" />
            </label>
          </Collapse>
        </div>

        <div className="knt-props" role="group" aria-label="Task details">
          <Prop label="Project" htmlFor={idOf("project")} fromTitle={!!parsed.projectId} note={needsProject ? (
            <span id={idOf("projnote")} className="knt-note" data-tone="signal">
              {missingProject ? `“${missingProject}” isn't in this workspace — choose a project for this draft.` : "Choose a project for this draft."}
            </span>
          ) : null}>
            <span className="knt-ctl">
              {project ? <ProjectDot color={project.color} /> : <Icon name="folder" size={14} sw={1.75} />}
              <select ref={projectRef} id={idOf("project")} className="knt-select" value={targetProject} onChange={(e) => pickProject(e.target.value)}
                aria-invalid={needsProject || undefined} aria-describedby={needsProject ? idOf("projnote") : undefined}>
                {targetProject === "" && <option value="" disabled>Choose a project…</option>}
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </span>
          </Prop>
          <Prop label="Assignee" htmlFor={idOf("assignee")} fromTitle={!!parsed.assigneeId}>
            <span className="knt-ctl">
              {assignee ? <PersonMark id={assignee.id} name={assignee.name} /> : <Icon name="user" size={14} sw={1.75} />}
              <select id={idOf("assignee")} className="knt-select" value={effAssignee} onChange={(e) => pickAssignee(e.target.value)}>
                {people.map((p) => <option key={p.id} value={p.id}>{p.id === currentUserId && p.name !== "You" ? `${p.name} (you)` : p.name}</option>)}
              </select>
            </span>
          </Prop>
          <Prop label="Priority" htmlFor={idOf("priority")} fromTitle={!!parsed.priority}>
            <span className="knt-ctl">
              <PriorityGlyph priority={effPriority} />
              <select id={idOf("priority")} className="knt-select" value={effPriority} onChange={(e) => pickPriority(e.target.value as Priority)}>
                {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
              </select>
            </span>
          </Prop>
          <Prop label="Due" fromTitle={dueFromTitle}>
            <DateChip value={effDue || undefined} time={effTime || undefined} withTime size="md" label="Due date"
              placeholder="No due date" parse={(s) => parseDateText(s)} onChange={pickDue} />
          </Prop>
          <Prop label="Repeat" htmlFor={idOf("repeat")} fromTitle={!!parsed.recurrence} note={nextRuns.length ? (
            <span className="knt-note">Then {nextRuns.join(", ")}</span>
          ) : null}>
            <span className="knt-ctl">
              <Icon name="refresh" size={14} sw={1.75} />
              <select id={idOf("repeat")} className="knt-select" value={effRecurrence} onChange={(e) => pickRepeat(e.target.value as Recurrence)} data-empty={effRecurrence === "none" || undefined}>
                {RECUR_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
            </span>
          </Prop>
          <Prop label="Starts" fromTitle={!!parsed.startDate}>
            <DateChip value={effStart || undefined} size="md" label="Start date" placeholder="No start date"
              parse={(s) => parseDateText(s)} onChange={(d) => pickStart(d)} />
          </Prop>
          <Prop label="Focus time" htmlFor={idOf("focus")} fromTitle={!!parsed.focusMin}>
            <span className="knt-ctl">
              <Icon name="clock" size={14} sw={1.75} />
              <select id={idOf("focus")} className="knt-select knt-mono" value={effFocus} onChange={(e) => pickFocus(Number(e.target.value))}>
                {focusOpts.map((m) => <option key={m} value={m}>{fmtMinutes(m)}</option>)}
              </select>
            </span>
          </Prop>
          <div className="knt-prop knt-prop-tags">
            <span className="knt-prop-k" id={idOf("tags")}>Tags</span>
            <div className="knt-prop-v" role="group" aria-labelledby={idOf("tags")}>
              <TagPicker tags={allTags} selected={[...new Set([...tags, ...titleTags])]} onToggle={toggleTag} onCreate={onCreateTag} onDelete={deleteTag} usage={tagUsage} ownerKey="new-task" small />
            </div>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

/** One property row: its name on the left, its control on the right. `htmlFor`
 *  makes the name a <label> for a native control (so it's the control's
 *  name); a DateChip names itself, so its row's name is plain text. A note
 *  sits under the control, outside the label, so it never joins the name. */
function Prop({ label, htmlFor, children, note, fromTitle }: { label: string; htmlFor?: string; children: ReactNode; note?: ReactNode; fromTitle?: boolean }) {
  return (
    <div className="knt-prop" data-from-title={fromTitle || undefined}>
      {htmlFor ? <label className="knt-prop-k" htmlFor={htmlFor}>{label}</label> : <span className="knt-prop-k" aria-hidden="true">{label}</span>}
      <div className="knt-prop-v">{children}{note}</div>
    </div>
  );
}

/* Kept beside the component (as the capture sheets do), with fallbacks to
   today's tokens so it reads right before and after the token pass. */
const NEW_TASK_CSS = `
.knt { display: flex; flex-direction: column; min-width: 0; }

.knt-draft { display: flex; align-items: center; gap: 8px; min-height: 36px; margin: 0 0 12px; padding: 0 8px 0 12px;
  border-radius: var(--r-md, 8px); background: var(--fill-1); font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.knt-draft > svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.knt-draft-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.knt-link { flex-shrink: 0; height: 28px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px); background: transparent; cursor: pointer;
  font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease); }
.knt-link:hover { background: var(--fill-1); color: var(--ink); }
.knt-link[data-tone="accent"] { color: var(--accent-text, var(--accent)); }
.knt-link[data-tone="accent"]:hover { color: var(--accent-text, var(--accent)); background: var(--accent-tint, var(--accent-dim)); }

.knt-template { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; margin: 0 0 12px;
  font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.knt-template > svg { color: var(--icon-quiet, var(--ink-4)); }
.knt-template .knt-select { height: 28px; font-size: 12px; color: var(--ink-2); }

/* the title: an 18px field that reads tokens as you type */
.knt-title { display: flex; align-items: center; min-height: 48px; padding: 0 12px; box-sizing: border-box;
  border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface));
  transition: border-color var(--d-1, 90ms) var(--ease), box-shadow var(--d-1, 90ms) var(--ease); }
.knt-title:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.knt-title:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.knt-title .ktok { flex: 1; font: 500 18px/28px var(--font-ui, var(--font-display)); letter-spacing: -0.005em; color: var(--ink); }
.knt-title .ktok-field { height: 28px; }
.knt .kcap-facts { margin-top: 8px; }

.knt-desc { margin-top: 12px; }
.knt-desc > .kbtn { margin-left: -10px; color: var(--ink-3); }
.knt-desc > .kbtn:hover:not(:disabled) { color: var(--ink); }
.knt-desc-label { display: block; }
.knt-desc-field { display: block; width: 100%; min-height: 88px; box-sizing: border-box; padding: 8px 12px; resize: vertical;
  border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface));
  font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink); transition: border-color var(--d-1, 90ms) var(--ease); }
.knt-desc-field:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.knt-desc-field::placeholder { color: var(--ink-4); opacity: 1; }

/* properties: name · control, two columns on wide screens */
.knt-props { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 24px; row-gap: 4px;
  margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--hairline); }
.knt-prop { display: grid; grid-template-columns: 84px minmax(0, 1fr); align-items: start; column-gap: 8px; min-width: 0; }
.knt-prop-k { display: flex; align-items: center; height: 32px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); white-space: nowrap; }
.knt-prop-v { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.knt-prop-tags { grid-column: 1 / -1; margin-top: 4px; }
.knt-prop-tags .knt-prop-v { padding-top: 4px; min-height: 28px; }

.knt-ctl { position: relative; display: inline-flex; align-items: center; max-width: 100%; }
.knt-ctl > svg, .knt-ctl > .kpdot, .knt-ctl > .kprio, .knt-ctl > .kcap-face, .knt-ctl > .kcap-initials {
  position: absolute; left: 8px; top: 50%; translate: 0 -50%; pointer-events: none; z-index: 1; }
.knt-ctl > svg { color: var(--icon-quiet, var(--ink-4)); }
.knt-ctl > .kcap-face, .knt-ctl > .kcap-initials { left: 6px; }
.knt-select {
  min-width: 0; max-width: 100%; height: 32px; padding: 0 28px 0 8px; box-sizing: border-box;
  border-radius: var(--r-sm, 6px); border: 1px solid transparent; background-color: transparent;
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); text-overflow: ellipsis; field-sizing: content;
  transition: background-color var(--d-1, 90ms) var(--ease), border-color var(--d-1, 90ms) var(--ease);
}
.knt-ctl > .knt-select { padding-left: 30px; }
.knt-select:hover { background-color: var(--fill-1); }
.knt-select[data-empty] { color: var(--ink-3); }
.knt-select[aria-invalid="true"] { border-color: var(--signal, var(--st-blocked)) !important; }
.knt-mono { font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.knt-props .kdate-wrap { flex-direction: row; }
.knt-props .kdate { height: 32px; padding: 0 8px; border-radius: var(--r-sm, 6px); color: var(--ink); font-size: 12px; }
.knt-props .kdate[data-empty="true"] { color: var(--ink-3); font-family: var(--font-ui, var(--font-display)); font-size: 13px; font-weight: 500; }
.knt-props .kdate[data-tone="overdue"] { color: var(--signal, var(--st-blocked)); }
.knt-props .kdate[data-tone="now"] { color: var(--accent-text, var(--accent)); }

/* a property the title set wears the token highlight's colours */
.knt-prop[data-from-title] .knt-select, .knt-prop[data-from-title] .kdate {
  background-color: var(--accent-tint, var(--accent-dim)); color: var(--accent-text, var(--accent)); }
.knt-prop[data-from-title] .knt-ctl > svg { color: var(--accent-text, var(--accent)); }

.knt-note { display: block; padding: 2px 8px 4px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.knt-note[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }

.knt-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; min-width: 0; }

@media (max-width: 859px) {
  .knt-props { grid-template-columns: minmax(0, 1fr); row-gap: 2px; }
  .knt-prop { grid-template-columns: 96px minmax(0, 1fr); }
  .knt-prop-k, .knt-select, .knt-props .kdate { height: 40px; }
  .knt-title .ktok { font-size: 17px; }
  .knt-foot { flex-direction: column-reverse; align-items: stretch; gap: 4px; }
  .knt-foot .kbtn { width: 100%; height: var(--h-touch, 44px); justify-content: center; }
}
`;
