/* ============================================================
   KANBO — New task: the full form (real, persisted task creation).
   The title reads a whole task as you type ("Email Sana fri 3pm #launch
   !high"), highlighting each token it understood; the properties below
   always show what will be created, and a token the title set is tinted
   to match its highlight. Choosing a property yourself takes over from
   the token (it comes out of the title), so the two never disagree.
   Dates use the DateChip (no native date or time inputs).
   Templates (lib/templates, the library): type "/" in the title (or
   "/template") for a fuzzy list of them, or press Template. Applying one
   fills the form (title with its {placeholders} selected, description,
   priority, focus time, tags, due date) and shows what else it makes —
   its sub-tasks, dated from the task's due date and given to people by
   role, and its checklist — all created with the task. Remove takes it
   off again, keeping anything typed since.
   ============================================================ */
import { useState, useEffect, useRef, useMemo, useId, useCallback } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Icon, Collapse, Button, DateChip, PriorityGlyph, ProjectDot, Sheet, Kbd } from "./primitives";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { TagPicker } from "./TagPicker";
import { TokenField, TokenChips, PersonMark, CAPTURE_CSS } from "./QuickCapture";
import { PRIORITY_META, energyOf, nextDueDate, seriesAnchorDay, todayISO, KANBO_TODAY } from "../data/data";
import { parseTask, parseDateText, stripTokens, dayLabel, fmtMinutes, type NlpKind } from "../lib/nlp";
import {
  planTemplate, resolveTemplateTags, templatePlaceholders, templateQueryOf, type AppliedTemplatePlan,
} from "../lib/templatePlan";
import { TemplatePicker } from "./templates/TemplatePicker";
import { TemplateChooser } from "./templates/TemplateChooser";
import { TemplateTile } from "./templates/parts";
import { useLibraryTemplates } from "./templates/useLibraryTemplates";
import type { Task, Project, TagDef, WorkspaceMember, Recurrence, Priority, Status, LibraryTemplate } from "../data/types";

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
/** the fields a template fills (and Remove puts back) */
interface TemplateFields { title: string; description: string; descOpen: boolean; priority: Priority; focusMin: number; tags: string[]; dueDate: string; dueTime: string }
interface AppliedTemplate { tpl: LibraryTemplate; before: TemplateFields; set: TemplateFields }
const BLANK_FIELDS: TemplateFields = { title: "", description: "", descOpen: false, priority: "medium", focusMin: 30, tags: [], dueDate: "", dueTime: "" };
/** the fields with the template's still-untouched values put back as they were before it */
function withoutTemplate(cur: TemplateFields, a: AppliedTemplate): TemplateFields {
  const keep = <K extends keyof TemplateFields>(k: K): TemplateFields[K] => (cur[k] === a.set[k] ? a.before[k] : cur[k]);
  const added = a.set.tags.filter((t) => !a.before.tags.includes(t));
  return {
    title: keep("title"), description: keep("description"), descOpen: cur.description === a.set.description ? a.before.descOpen : cur.descOpen,
    priority: keep("priority"), focusMin: keep("focusMin"), tags: cur.tags.filter((t) => !added.includes(t)),
    dueDate: keep("dueDate"), dueTime: cur.dueDate === a.set.dueDate ? a.before.dueTime : cur.dueTime,
  };
}
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
/** a template's sub-task as a full new task under `parent` (when the host has no template path) */
function subtaskOf(s: Partial<Task> & { title: string }, parent: Task, position: number): Task {
  return {
    id: newId(), title: s.title, description: "", status: "todo", priority: s.priority ?? "medium",
    projectId: parent.projectId, assigneeId: s.assigneeId ?? parent.assigneeId, parentId: parent.id,
    tags: [], dependencies: [], subtasks: [], comments: 0, focusMin: 30, dur: 30, aiScore: 50,
    scheduled: null, planToday: false, recurrence: "none", position,
    ...(s.dueDate ? { dueDate: s.dueDate } : {}),
  };
}
/** "9 Oct" — the repeat preview's short dates */
const shortDay = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}` : iso; };

export function NewTaskModal({ open, onClose, onCreate, onCreateTag, onDeleteTag, projects, allTags, members, currentUserId, defaultStatus = "todo", defaultProjectId, tagUsage, templates: templatesProp, onApplyTemplate, initialTemplate, onBrowseTemplates, workspaceId }: {
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
  /** the template library (lib/templates listLibraryTemplates). Omitted: the modal loads it itself when first needed. */
  templates?: readonly LibraryTemplate[];
  /** Create from a template: `plan.task` is the task as the form has it (a full Task), `plan.subtasks` its
   *  sub-tasks (dated, assigned by role; the host links them with parentId: lib/templates templateTasks),
   *  `plan.checklist` its checklist items. Omitted: the task and its sub-tasks go through onCreate one by
   *  one (parentId set) and the checklist is written into the description. */
  onApplyTemplate?: (plan: AppliedTemplatePlan, template: LibraryTemplate) => void;
  /** open with this template applied (the library's "Use template") */
  initialTemplate?: LibraryTemplate | null;
  /** "Browse all templates" in the Template menu (opens the library) */
  onBrowseTemplates?: () => void;
  /** whose library to load when `templates` isn't given (default: the default project's workspace) */
  workspaceId?: string | null;
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
  // the template applied, and the fields as they were just before (Remove puts back what's untouched)
  const [applied, setApplied] = useState<AppliedTemplate | null>(null);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [showSubs, setShowSubs] = useState(false);
  const [wantLibrary, setWantLibrary] = useState(false);
  const templateBtn = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
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
    setDescription(""); setDescOpen(false); setMissingProject(null);
    setApplied(null); setPickerDismissed(false); setChooserOpen(false); setShowSubs(false);
  };
  /** the form as a saved draft, or null when there's nothing worth keeping */
  const snapshot = (): SavedDraft | null => (title.trim() || description.trim()) ? {
    title, description, projectId, projectName: projects.find((p) => p.id === projectId)?.name ?? missingProject ?? "",
    priority, assigneeId, dueDate, dueTime, startDate, recurrence, focusMin, tags, templateId: applied?.tpl.id ?? "",
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
    if (initialTemplate) applyTemplate(initialTemplate, { fresh: true });
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
    const plan = applied ? templatePlanFor(applied.tpl, t.dueDate ?? null, t.assigneeId) : null;
    if (applied && plan) {
      const full: AppliedTemplatePlan = { task: t, subtasks: plan.subtasks, checklist: plan.checklist };
      if (onApplyTemplate) onApplyTemplate(full, applied.tpl);
      else {
        // no template path: the task, then its sub-tasks (each waits for it), the checklist in its notes
        const list = plan.checklist.length ? `**Checklist**\n${plan.checklist.map((c) => `- ${c}`).join("\n")}` : "";
        const parent = list ? { ...t, description: t.description ? `${t.description}\n\n${list}` : list } : t;
        onCreate(parent);
        const stamp = Date.now();
        plan.subtasks.forEach((s, i) => onCreate(subtaskOf(s, parent, stamp + i + 1)));
      }
    } else onCreate(t);
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
    const tpl = d.templateId ? library.find((t) => t.id === d.templateId) : undefined;
    setApplied(tpl ? { tpl, before: BLANK_FIELDS, set: { title: d.title, description: d.description, descOpen: !!d.description.trim(), priority: d.priority, focusMin: d.focusMin, tags: d.tags, dueDate: d.dueDate, dueTime: d.dueTime } } : null);
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

  /* ---- templates ---- */
  // the library: the host's, or loaded here the first time it's wanted ("/", the Template button)
  const libWs = workspaceId !== undefined ? workspaceId : wsOf(defaultProject);
  const lib = useLibraryTemplates(libWs, open && !templatesProp && (wantLibrary || !!savedDraft?.templateId));
  const library = templatesProp ?? lib.templates;
  const libLoading = !templatesProp && lib.status !== "ready" && lib.status !== "error";
  const pickerQuery = applied ? null : templateQueryOf(title);
  const pickerOpen = open && pickerQuery !== null && !pickerDismissed;
  useEffect(() => { if (pickerQuery === null && pickerDismissed) setPickerDismissed(false); }, [pickerQuery, pickerDismissed]);
  useEffect(() => { if (pickerOpen && !wantLibrary) setWantLibrary(true); }, [pickerOpen, wantLibrary]);

  const fieldsNow = (): TemplateFields => ({ title, description, descOpen, priority, focusMin, tags, dueDate, dueTime });
  const setFields = (f: TemplateFields) => {
    setTitle(f.title); setDescription(f.description); setDescOpen(f.descOpen); setPriority(f.priority);
    setFocusMin(f.focusMin); setTags(f.tags); setDueDate(f.dueDate); setDueTime(f.dueTime);
  };
  const focusTitle = (text: string) => window.setTimeout(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // the first {placeholder} is selected, ready to type over
    const ph = templatePlaceholders(text)[0];
    if (ph) el.setSelectionRange(ph.start, ph.end); else el.setSelectionRange(text.length, text.length);
  }, 0);

  // Apply a template. What's already chosen or typed is never thrown away: the
  // title and description are only filled when empty (or a "/" search), tags
  // join the ones picked, and a due date chosen by hand stays (the sub-tasks
  // follow it). A template replacing another starts from before the first.
  const applyTemplate = (tpl: LibraryTemplate, opts: { fresh?: boolean } = {}) => {
    const cur = opts.fresh ? BLANK_FIELDS : fieldsNow();
    const prior = opts.fresh ? null : applied;
    const undone = prior ? withoutTemplate(cur, prior) : cur;
    const base = templateQueryOf(undone.title) !== null ? { ...undone, title: "" } : undone;
    const pid = opts.fresh ? defaultProject : targetProject;
    const plan = planTemplate(tpl, {
      today: new Date(KANBO_TODAY), currentUserId, projectId: pid,
      projectOwnerId: projects.find((p) => p.id === pid)?.ownerId, workspaceId: wsOf(pid), tags: allTags,
    });
    const desc = base.description.trim() ? base.description : (tpl.body.description ?? "");
    const next: TemplateFields = {
      title: base.title.trim() ? base.title : tpl.body.title,
      description: desc, descOpen: base.descOpen || !!desc.trim(),
      priority: plan.task.priority ?? "medium", focusMin: plan.task.focusMin ?? 30,
      tags: [...new Set([...base.tags, ...resolveTemplateTags(tpl.body.tags, allTags)])],
      dueDate: base.dueDate || plan.task.dueDate || "", dueTime: base.dueDate ? base.dueTime : "",
    };
    setFields(next);
    setApplied({ tpl, before: base, set: next });
    setPickerDismissed(false); setShowSubs(false);
    focusTitle(next.title);
  };
  const removeTemplate = () => {
    if (!applied) return;
    const back = withoutTemplate(fieldsNow(), applied);
    setFields(back);
    setApplied(null); setShowSubs(false);
    window.setTimeout(() => templateBtn.current?.focus(), 0);
  };
  const closePicker = useCallback(() => setPickerDismissed(true), []);
  /** what the template makes with the form as it is: dated from the task's due date, people by role in its project */
  const templatePlanFor = (tpl: LibraryTemplate, due: string | null, who: string) => planTemplate(tpl, {
    today: new Date(KANBO_TODAY), currentUserId, projectId: targetProject,
    projectOwnerId: projects.find((p) => p.id === targetProject)?.ownerId, workspaceId: wsOf(targetProject),
    dueDate: due, assigneeId: who, tags: allTags,
  });

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

  // what the applied template adds, as it stands (it follows the due date, project and assignee)
  const preview = applied ? templatePlanFor(applied.tpl, effDue || null, effAssignee) : null;
  const whoIs = (id: string) => (!id ? "Unassigned" : id === currentUserId ? "You" : people.find((p) => p.id === id)?.name
    ?? members.find((m) => m.userId === id)?.name ?? "Project owner");

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
        {applied ? (
          <div className="ktpl-applied" role="group" aria-label={`Template: ${applied.tpl.name}`}>
            <TemplateTile template={applied.tpl} size={20} />
            <span className="ktpl-applied-text">
              <span className="ktpl-applied-name">From “{applied.tpl.name}”</span>
              {preview && (preview.subtasks.length > 0 || preview.checklist.length > 0) && (
                <span className="ktpl-applied-meta">
                  {[preview.subtasks.length ? `+ ${plural(preview.subtasks.length, "sub-task")}` : "", preview.checklist.length ? plural(preview.checklist.length, "checklist item") : ""].filter(Boolean).join(" · ")}
                </span>
              )}
            </span>
            {preview && (preview.subtasks.length > 0 || preview.checklist.length > 0) && (
              <button type="button" className="knt-link" aria-expanded={showSubs} aria-controls={idOf("tplsubs")} onClick={() => setShowSubs((v) => !v)}>
                {showSubs ? "Hide" : "Show"}<span className="sr-only"> what “{applied.tpl.name}” adds</span>
              </button>
            )}
            <button type="button" className="knt-link" onClick={removeTemplate} aria-label={`Remove template “${applied.tpl.name}”`}>Remove</button>
          </div>
        ) : (
          <div className="knt-template">
            <button ref={templateBtn} type="button" className="knt-tplbtn" aria-haspopup="dialog" aria-expanded={chooserOpen}
              onClick={() => { setWantLibrary(true); setChooserOpen((v) => !v); }}>
              <Icon name="layers" size={14} sw={1.75} /><span>Template</span><Icon name="chevronDown" size={14} sw={1.75} />
            </button>
            <span className="knt-template-hint" aria-hidden="true">or type <Kbd>/</Kbd> in the title</span>
          </div>
        )}
        <TemplateChooser open={chooserOpen} anchorRef={templateBtn} onClose={() => setChooserOpen(false)} templates={library}
          loading={libLoading} currentUserId={currentUserId} onPick={(t) => applyTemplate(t)} onBrowse={onBrowseTemplates} />
        {applied && preview && (
          <Collapse open={showSubs}>
            <div id={idOf("tplsubs")} className="ktpl-applied-list">
              {preview.subtasks.length > 0 && (
                <ol className="ktpl-pv-subs" aria-label="Sub-tasks it adds">
                  {preview.subtasks.map((s, i) => (
                    <li key={i}>
                      <span className="ktpl-ring" aria-hidden="true" />
                      <span className="ktpl-pv-subtitle">{s.title}</span>
                      <span className="ktpl-pv-when mono">{s.dueDate ? dayLabel(s.dueDate) : "No date"}</span>
                      <span className="ktpl-pv-role" data-role={s.assigneeId ? undefined : "unassigned"}>
                        <Icon name="user" size={12} sw={2} />{whoIs(s.assigneeId ?? "")}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {preview.checklist.length > 0 && (
                <ul className="ktpl-pv-check" aria-label="Checklist it adds">
                  {preview.checklist.map((c, i) => <li key={i}><span className="ktpl-box" aria-hidden="true" />{c}</li>)}
                </ul>
              )}
            </div>
          </Collapse>
        )}

        <div className="knt-title">
          {/* wraps rather than scrolling sideways, so every token stays in view (a phone
              shows the whole sentence); it's still one line of text: ⏎ creates, and a
              pasted line break becomes a space */}
          <TokenField ref={inputRef} id={idOf("title")} multiline maxHeight={112} value={title} onValueChange={(v) => setTitle(v.replace(/[ \t]*[\r\n]+[ \t]*/g, " "))}
            spans={pickerOpen ? [] : parsed.spans} label="Task title" focusRing="none" onKeyDown={onTitleKey} describedBy={idOf("title-hint")}
            placeholder="Task title — try “Email Sana fri 3pm #launch !high”" />
        </div>
        <span id={idOf("title-hint")} className="sr-only">Type a slash to start from a template.</span>
        {pickerOpen && (
          <TemplatePicker query={pickerQuery ?? ""} templates={library} inputId={idOf("title")} loading={libLoading}
            currentUserId={currentUserId} onPick={(t) => applyTemplate(t)} onClose={closePicker} />
        )}
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

/* "Template ▾" (or "/" in the title) — and, once one's applied, its strip (templates.css) */
.knt-template { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; min-width: 0;
  font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.knt-tplbtn { display: inline-flex; align-items: center; gap: 6px; height: 28px; margin-left: -8px; padding: 0 8px; border: 0;
  border-radius: var(--r-sm, 6px); background: transparent; cursor: pointer;
  font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2);
  transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease); }
.knt-tplbtn:hover, .knt-tplbtn[aria-expanded="true"] { background: var(--fill-1); color: var(--ink); }
.knt-tplbtn > svg { color: var(--icon-quiet, var(--ink-4)); }
.knt-template-hint { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
@media (hover: none) { .knt-template-hint { display: none; } }
.knt .ktpl-applied { margin: 0 0 12px; }
.knt .ktpl-applied-list { margin: -4px 0 12px; }
.knt .ktpl-pick { margin-top: 8px; }

/* the title: an 18px field that reads tokens as you type */
.knt-title { display: flex; align-items: stretch; min-height: 48px; padding: 9px 12px; box-sizing: border-box;
  border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface));
  transition: border-color var(--d-1, 90ms) var(--ease), box-shadow var(--d-1, 90ms) var(--ease); }
.knt-title:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.knt-title:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.knt-title .ktok { flex: 1; font: 500 18px/28px var(--font-ui, var(--font-display)); letter-spacing: -0.005em; color: var(--ink); }
.knt-title .ktok-field { min-height: 28px; }
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
  .knt-tplbtn { height: 40px; }
  .knt-props { grid-template-columns: minmax(0, 1fr); row-gap: 2px; }
  .knt-prop { grid-template-columns: 96px minmax(0, 1fr); }
  .knt-prop-k, .knt-select, .knt-props .kdate { height: 40px; }
  .knt-title .ktok { font-size: 17px; }
  .knt-foot { flex-direction: column-reverse; align-items: stretch; gap: 4px; }
  .knt-foot .kbtn { width: 100%; height: var(--h-touch, 44px); justify-content: center; }
}
`;
