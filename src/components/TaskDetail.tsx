/* ============================================================
   KANBO — Task detail slide-over panel (fully editable)
   ============================================================ */
import { useState, useEffect, useRef, useMemo, useId } from "react";
import type { ReactNode, RefObject, MutableRefObject } from "react";
import { Icon, Avatar, Check, StatusDot, PriorityFlag, AiScore, EmojiPicker, Collapse } from "./primitives";
import { useFocusTrap, isEditableTarget } from "../hooks/useFocusTrap";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { TagPicker } from "./TagPicker";
import { useToast } from "./Toast";
import { store, type TaskEvent } from "../data/store";
import { renderRich } from "../lib/richtext";
import { saveTemplate } from "../lib/templates";
import { reportError } from "../lib/monitoring";
import type { Attachment } from "../data/types";
import {
  resolveMentions, dependencyCandidates, wouldCreateCycle, activityLine, isTextEntry,
  canDeleteAttachment, readDraft, writeDraft, stashUnsaved, dropUnsaved, takeUnsaved,
  type MentionCandidate, type UnsavedField,
} from "./taskDetailHelpers";

const REACTION_EMOJIS = ["👍", "❤️", "🎉", "👀", "✅", "🚀"];

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
import {
  getProject, getMember, blockingTasks, dueState, fmtDue, timeAgo, DUE_PRESETS, presetDate,
  STATUS_META, STATUS_ORDER, PRIORITY_META, nextDueDate, nextOccurrence, seriesAnchorDay,
} from "../data/data";
import { timelineStartPatch } from "./tasks/otherViewsLogic";
import type { Task, TagDef, Comment, Activity, WorkspaceMember, Recurrence, Status, Priority, IconName, Project, CustomFieldDef, CustomValue, Section } from "../data/types";

const RECUR_LABEL: Record<Recurrence, string> = { none: "Doesn't repeat", daily: "Daily", weekdays: "Every weekday", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
const CONFLICT_MSG = "Someone else changed this while you were editing. Overwrite with your version?";
// signed download links last an hour; refresh well before they lapse
const FILES_REFRESH_MS = 45 * 60 * 1000;

/** the next few due dates of a repeating task. Every step keeps the series'
 *  day, so a task due 31 Jan previews 28 Feb · 31 Mar · 30 Apr. */
function nextOccurrences(task: Pick<Task, "dueDate" | "originalDueDate">, recurrence: Recurrence, n = 3): string[] {
  const out: string[] = [];
  const anchor = seriesAnchorDay(task);
  let cur = task.dueDate;
  for (let i = 0; i < n; i++) { cur = nextDueDate(cur, recurrence, anchor); out.push(cur); }
  return out;
}
function shortDate(iso: string): string {
  try { return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }); } catch { return iso; }
}

function describeEvent(e: TaskEvent): string {
  if (e.field === "status") return `changed status to ${STATUS_META[e.newValue as Status]?.label ?? e.newValue}`;
  if (e.field === "priority") return `set priority to ${PRIORITY_META[e.newValue as Priority]?.label ?? e.newValue}`;
  if (e.field === "assignee") return e.newValue ? `assigned ${getMember(e.newValue)?.name ?? "someone"}` : "unassigned the task";
  if (e.field === "due") return e.newValue ? `set the due date to ${fmtDue(e.newValue)}` : "cleared the due date";
  return `updated ${e.field}`;
}

// TaskDetail can render outside a ToastProvider (tests, embeds) — toasts are then a no-op
function useOptionalToast() {
  try { return useToast(); } catch { return null; }
}

function MetaRow({ icon, label, children, topAlign, htmlFor }: { icon: IconName; label: string; children: ReactNode; topAlign?: boolean; htmlFor?: string }) {
  const labelStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, width: 104, flexShrink: 0, fontSize: 12.5, color: "var(--ink-4)", height: topAlign ? 32 : undefined };
  return (
    <div style={{ display: "flex", alignItems: topAlign ? "flex-start" : "center", gap: 12, minHeight: 32 }}>
      {htmlFor
        ? <label htmlFor={htmlFor} style={labelStyle}><Icon name={icon} size={14} /> {label}</label>
        : <span style={labelStyle}><Icon name={icon} size={14} /> {label}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** a field's value as plain text, for people who can view but not edit */
function ReadValue({ children, muted, mono }: { children: ReactNode; muted?: boolean; mono?: boolean }) {
  return <span style={{ fontSize: 13, lineHeight: "30px", color: muted ? "var(--ink-4)" : "var(--ink-2)", fontFamily: mono ? "var(--font-mono)" : "var(--font-display)" }}>{children}</span>;
}

/** the look of the completion checkbox, without the button */
function StaticCheck({ done, size = 18 }: { done: boolean; size?: number }) {
  return (
    <span role="img" aria-label={done ? "Done" : "Not done"} style={{
      width: size, height: size, borderRadius: 6, flexShrink: 0, display: "grid", placeItems: "center",
      border: `1.6px solid ${done ? "var(--accent)" : "var(--hairline-strong)"}`, background: done ? "var(--accent)" : "transparent", color: "var(--on-accent)",
    }}>{done && <Icon name="check" size={size * 0.62} sw={3} />}</span>
  );
}

const fieldInputStyle: React.CSSProperties = { height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, maxWidth: 220 };

/**
 * A text/number input that keeps what you type locally and saves once — on
 * blur, Enter, or when the panel closes — instead of writing on every
 * keystroke (which raced, and re-synced every teammate per character).
 *
 * Like the title, it remembers the live value it was loaded from (its base):
 * while you're not in it — or you're in it but haven't typed — it follows the
 * live value; only a real change is saved, so tabbing through never writes a
 * stale number back over a teammate's; and if the value changed underneath
 * your edit you're asked before overwriting it.
 */
function BufferedInput({ value, onCommit, onKeyDown, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur" | "onFocus">) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const draftRef = useRef(value);
  const baseRef = useRef(value);
  const liveRef = useRef(value);
  liveRef.current = value;
  const sync = (v: string) => { setDraft(v); draftRef.current = v; baseRef.current = v; };
  useEffect(() => { if (!editing.current || draftRef.current === baseRef.current) sync(value); }, [value]);
  const commit = () => {
    const mine = draftRef.current, base = baseRef.current, live = liveRef.current;
    if (mine === base) { if (live !== base) sync(live); return; }   // untouched — never writes
    if (mine === live) { baseRef.current = mine; return; }
    if (live !== base && !window.confirm(CONFLICT_MSG)) { sync(live); return; }  // keep theirs
    baseRef.current = mine;
    onCommit(mine);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => { if (editing.current) commitRef.current(); }, []);
  return (
    <input {...rest} value={draft}
      onFocus={() => { editing.current = true; if (draftRef.current === baseRef.current && liveRef.current !== baseRef.current) sync(liveRef.current); }}
      onChange={(e) => { setDraft(e.target.value); draftRef.current = e.target.value; }}
      onBlur={() => { editing.current = false; commit(); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } onKeyDown?.(e); }} />
  );
}
const numOrUndef = (s: string): number | undefined => { if (s.trim() === "") return undefined; const n = Number(s); return Number.isFinite(n) ? n : undefined; };

type MdKind = "bold" | "italic" | "code" | "link" | "bullet";
function applyMd(el: HTMLTextAreaElement, value: string, setValue: (v: string) => void, kind: MdKind) {
  const start = el.selectionStart ?? value.length, end = el.selectionEnd ?? value.length;
  const sel = value.slice(start, end);
  let insert = sel;
  if (kind === "bold") insert = `**${sel || "bold"}**`;
  else if (kind === "italic") insert = `*${sel || "italic"}*`;
  else if (kind === "code") insert = `\`${sel || "code"}\``;
  else if (kind === "link") insert = `[${sel || "text"}](url)`;
  else if (kind === "bullet") insert = (sel || "item").split("\n").map((l) => `- ${l}`).join("\n");
  setValue(value.slice(0, start) + insert + value.slice(end));
  requestAnimationFrame(() => { el.focus(); const p = start + insert.length; try { el.setSelectionRange(p, p); } catch { /* ignore */ } });
}
function MdToolbar({ getEl, value, setValue }: { getEl: () => HTMLTextAreaElement | null; value: string; setValue: (v: string) => void }) {
  const tbtn = (label: React.ReactNode, kind: MdKind, title: string, style: React.CSSProperties = {}) => (
    <button type="button" title={title} aria-label={title}
      onMouseDown={(e) => { e.preventDefault(); const el = getEl(); if (el) applyMd(el, value, setValue, kind); }}
      style={{ minWidth: 26, height: 26, padding: "0 6px", borderRadius: 7, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", cursor: "pointer", fontSize: 13, display: "inline-flex", alignItems: "center", justifyContent: "center", ...style }}>{label}</button>
  );
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
      {tbtn("B", "bold", "Bold", { fontWeight: 700 })}
      {tbtn("I", "italic", "Italic", { fontStyle: "italic" })}
      {tbtn(<Icon name="link" size={13} />, "link", "Link")}
      {tbtn(<Icon name="list" size={13} />, "bullet", "Bullet list")}
      {tbtn(<span className="mono" style={{ fontSize: 12 }}>{"<>"}</span>, "code", "Code")}
    </div>
  );
}

function formatCustomValue(f: CustomFieldDef, v: CustomValue | undefined, people: { id: string; name: string }[]): string | null {
  if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) return f.type === "checkbox" ? "No" : null;
  if (f.type === "checkbox") return v ? "Yes" : "No";
  if (f.type === "multiselect") return Array.isArray(v) ? v.join(", ") : String(v);
  if (f.type === "currency") return typeof v === "number" ? `£${v.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : `£${v}`;
  if (f.type === "date") return typeof v === "string" ? shortDate(v) : String(v);
  if (f.type === "people") return people.find((p) => p.id === v)?.name || getMember(String(v))?.name || "Someone";
  return String(v);
}

function CustomFieldsSection({ task, fields, people, onPatch, onCreate, onDelete, readOnly, projectTaskCount }: {
  task: Task;
  fields: CustomFieldDef[];
  people: { id: string; name: string }[];
  onPatch: (id: string, patch: Partial<Task>) => void;
  onCreate?: (projectId: string, name: string, type: CustomFieldDef["type"], options: string[]) => void;
  onDelete?: (id: string) => void;
  readOnly?: boolean;
  /** how many tasks in this project would lose the field (for the delete confirmation) */
  projectTaskCount?: number;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldDef["type"]>("text");
  const [opts, setOpts] = useState("");
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const values = task.custom ?? {};
  // merge into the freshest copy of the task's values at the moment of saving
  const setValue = (fid: string, v: CustomValue) => onPatch(task.id, { custom: { ...(task.custom ?? {}), [fid]: v } });
  const add = () => {
    const n = name.trim(); if (!n || !onCreate) return;
    onCreate(task.projectId, n, type, (type === "dropdown" || type === "multiselect") ? opts.split(",").map((o) => o.trim()).filter(Boolean) : []);
    setName(""); setOpts(""); setType("text"); setAdding(false);
  };
  const cancelAdd = () => { setAdding(false); requestAnimationFrame(() => addBtnRef.current?.focus()); };
  const remove = (f: CustomFieldDef) => {
    if (!onDelete) return;
    const n = projectTaskCount ?? 0;
    const scope = n > 1 ? `all ${n} tasks in this project` : "all tasks in this project";
    if (!window.confirm(`Delete field “${f.name}” from ${scope}? Its values will be lost. This can't be undone.`)) return;
    onDelete(f.id);
  };
  const canCreate = !!onCreate && !readOnly;
  if (fields.length === 0 && !canCreate) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span className="kicker">Custom fields</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {fields.map((f) => {
          const v = values[f.id];
          if (readOnly) {
            const text = formatCustomValue(f, v, people);
            return (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 30 }}>
                <span className="truncate" style={{ width: 104, flexShrink: 0, fontSize: 12.5, color: "var(--ink-4)" }}>{f.name}</span>
                <ReadValue muted={text == null}>{text ?? "—"}</ReadValue>
              </div>
            );
          }
          return (
            <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 30 }}>
              <span className="truncate" style={{ width: 104, flexShrink: 0, fontSize: 12.5, color: "var(--ink-4)" }}>{f.name}</span>
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {f.type === "text" && <BufferedInput aria-label={f.name} value={(v as string) ?? ""} onCommit={(s) => setValue(f.id, s)} style={{ ...fieldInputStyle, maxWidth: 280, width: "100%" }} />}
                {f.type === "number" && <BufferedInput aria-label={f.name} type="number" value={v == null ? "" : String(v)} onCommit={(s) => setValue(f.id, numOrUndef(s) ?? null)} style={fieldInputStyle} />}
                {f.type === "currency" && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ color: "var(--ink-4)", fontSize: 13 }}>£</span><BufferedInput aria-label={`${f.name} (£)`} type="number" value={v == null ? "" : String(v)} onCommit={(s) => setValue(f.id, numOrUndef(s) ?? null)} style={fieldInputStyle} /></span>}
                {f.type === "multiselect" && (
                  <div role="group" aria-label={f.name} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {f.options.map((o) => { const arr = Array.isArray(v) ? v as string[] : []; const on = arr.includes(o); return <button key={o} aria-pressed={on} onClick={() => setValue(f.id, on ? arr.filter((x) => x !== o) : [...arr, o])} style={{ padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: 12, border: `1px solid ${on ? "var(--accent)" : "var(--hairline)"}`, background: on ? "var(--accent-dim)" : "transparent", color: on ? "var(--ink)" : "var(--ink-3)", fontFamily: "var(--font-display)" }}>{o}</button>; })}
                  </div>
                )}
                {f.type === "date" && <input type="date" aria-label={f.name} value={(v as string) ?? ""} onChange={(e) => setValue(f.id, e.target.value || null)} style={{ ...fieldInputStyle, fontFamily: "var(--font-mono)", fontSize: 12.5 }} />}
                {f.type === "checkbox" && <Check done={!!v} size={18} name={f.name} onToggle={() => setValue(f.id, !v)} />}
                {f.type === "dropdown" && (
                  <select aria-label={f.name} value={(v as string) ?? ""} onChange={(e) => setValue(f.id, e.target.value || null)} style={fieldInputStyle}>
                    <option value="">—</option>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                )}
                {f.type === "people" && (
                  <select aria-label={f.name} value={(v as string) ?? ""} onChange={(e) => setValue(f.id, e.target.value || null)} style={fieldInputStyle}>
                    <option value="">—</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
                {onDelete && <button onClick={() => remove(f)} title="Delete field" aria-label={`Delete field “${f.name}”`} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 14 }}>×</button>}
              </div>
            </div>
          );
        })}
      </div>
      {canCreate && (adding ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <input autoFocus aria-label="New field name" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelAdd(); }
            }} placeholder="Field name" style={{ ...fieldInputStyle, maxWidth: 150 }} />
          <select aria-label="New field type" value={type} onChange={(e) => setType(e.target.value as CustomFieldDef["type"])} style={fieldInputStyle}>
            <option value="text">Text</option><option value="number">Number</option><option value="currency">Currency (£)</option><option value="dropdown">Dropdown</option><option value="multiselect">Multi-select</option><option value="date">Date</option><option value="people">People</option><option value="checkbox">Checkbox</option>
          </select>
          {(type === "dropdown" || type === "multiselect") && <input aria-label="Options, separated by commas" value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="Option A, Option B" style={{ ...fieldInputStyle, maxWidth: 180 }} />}
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={cancelAdd} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      ) : (
        <button ref={addBtnRef} onClick={() => setAdding(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-display)" }}>
          <Icon name="plus" size={15} /> Add custom field
        </button>
      ))}
    </div>
  );
}

export interface TaskDetailProps {
  taskId: string;
  tasks: Task[];
  /** open another task in this panel (used to drill into a sub-task) */
  onOpenTask?: (id: string) => void;
  tags: Record<string, TagDef>;
  activity: Activity[];
  members: WorkspaceMember[];
  currentUserId: string;
  onClose: () => void;
  onToggle: (id: string) => void;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
  onAddDependency?: (taskId: string, dependsOn: string) => void;
  onRemoveDependency?: (taskId: string, dependsOn: string) => void;
  onToggleSubtask: (taskId: string, subId: string) => void;
  onAddSubtask: (taskId: string, title: string) => void;
  projects?: Project[];
  onToggleFollow?: (id: string) => void;
  onToggleTaskReaction?: (id: string, emoji: string) => void;
  onToggleCollaborator?: (id: string, memberId: string) => void;
  customFields?: CustomFieldDef[];
  onCreateCustomField?: (projectId: string, name: string, type: CustomFieldDef["type"], options: string[]) => void;
  onDeleteCustomField?: (id: string) => void;
  sections?: Section[];
  onCreateSection?: (projectId: string, name: string) => void;
  onCreateTag: (label: string, color: string) => void;
  onDeleteTag: (id: string) => void;
  onAddComment: (taskId: string, body: string, mentions?: string[], parentId?: string) => Promise<Comment | null>;
  onConvertComment?: (body: string, projectId: string) => void;
  onFocus: (id: string) => void;
  /** view + comment only (workspace guests): fields, dates, sub-tasks,
   *  dependencies, files and delete become read-only; comments, replies,
   *  comment reactions and Follow stay usable. */
  readOnly?: boolean;
}

export function TaskDetail(props: TaskDetailProps) {
  const { taskId, tasks, onClose } = props;
  const task = tasks.find((t) => t.id === taskId);
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const isMobile = useMediaQuery("(max-width: 860px)");
  // the freshest task list, readable from the panel's unmount cleanup (which
  // runs after this component has re-rendered with the new list)
  const liveTasksRef = useRef(tasks);
  liveTasksRef.current = tasks;

  // if the open task disappears (deleted here or by a realtime sync), close the
  // panel cleanly instead of leaving a blank ghost overlay mounted
  const exists = !!task;
  useEffect(() => {
    if (!exists) onClose();
  }, [exists, onClose]);

  if (!task) return null;
  return (
    <div onClick={onClose} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 90, background: "color-mix(in oklch, var(--bg-deep) 50%, transparent)", backdropFilter: "blur(3px)" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label={`Task: ${task.title}`} tabIndex={-1} onClick={(e) => e.stopPropagation()} style={{
        position: "absolute", top: 0, right: 0, bottom: 0, width: isMobile ? "100%" : 480, maxWidth: "100%",
        background: "var(--surface-raised)", borderLeft: isMobile ? "none" : "1px solid var(--hairline-strong)",
        // no outline override: when Escape parks focus on the panel itself,
        // keyboard users see the global focus ring (drawn just inside the edge)
        boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", outlineOffset: -3,
        animation: `${isMobile ? "slideInUp" : "slideInRight"} .3s var(--ease)`,
      }}>
        {/* keyed by task: switching task (sub-task, dependency) starts from a
            clean slate — no reply target, draft or in-flight upload leaks
            across — and the old task's unsaved title/description are saved */}
        <TaskPanel key={task.id} {...props} task={task} panelRef={trapRef} liveTasksRef={liveTasksRef} />
      </div>
    </div>
  );
}

function TaskPanel({ task, panelRef, liveTasksRef, taskId, tasks, tags, activity, members, currentUserId, onClose, onToggle, onPatch, onDelete, onDuplicate, onArchive, onUnarchive, onAddDependency, onRemoveDependency, onToggleSubtask, onAddSubtask, onCreateTag, onDeleteTag, onAddComment, onFocus, onOpenTask, projects = [], onToggleFollow, onToggleTaskReaction, onToggleCollaborator, customFields = [], onCreateCustomField, onDeleteCustomField, sections = [], onCreateSection, onConvertComment, readOnly = false }: TaskDetailProps & {
  task: Task;
  panelRef: RefObject<HTMLDivElement>;
  liveTasksRef: MutableRefObject<Task[]>;
}) {
  const toast = useOptionalToast();
  const uid = useId();
  const [newSub, setNewSub] = useState("");
  const [aiSubBusy, setAiSubBusy] = useState(false);
  const [aiSubNote, setAiSubNote] = useState<string | null>(null);
  // the unsent comment survives switching task or closing the panel
  const [comment, setCommentState] = useState(() => readDraft(currentUserId, taskId));
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [descMentionQuery, setDescMentionQuery] = useState<string | null>(null);
  const [descMentionIdx, setDescMentionIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [tmplSaved, setTmplSaved] = useState(false);
  const [reactPickerFor, setReactPickerFor] = useState<string | null>(null);
  const [depPickerOpen, setDepPickerOpen] = useState(false);
  const [depQuery, setDepQuery] = useState("");
  const [depIdx, setDepIdx] = useState(0);
  const [reactsOpen, setReactsOpen] = useState(false);
  const [reactMoreOpen, setReactMoreOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [startError, setStartError] = useState(false);
  useEffect(() => { setStartError(false); }, [task.dueDate]);   // a new due date may make room for it
  const [dragOver, setDragOver] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const depAddRef = useRef<HTMLButtonElement>(null);
  const depListRef = useRef<HTMLDivElement>(null);
  const descEditBtnRef = useRef<HTMLButtonElement>(null);
  // Escape / ⌘↵ in the description hands focus to its Edit button once the
  // editor has closed, so keyboard users land somewhere sensible
  const refocusDescEdit = useRef(false);
  const [thread, setThread] = useState<Comment[]>([]);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewers, setViewers] = useState<{ id: string; name: string }[]>([]);
  const [posting, setPosting] = useState(false);
  // Title + description edit buffers. Each remembers the server value it was
  // loaded from (its base): only a real change is saved, a teammate's newer
  // text shows up live while you're not editing, and if it changed underneath
  // you while you were, you're asked before overwriting it.
  const [titleBuf, setTitleBuf] = useState(task.title);
  const [titleFocused, setTitleFocused] = useState(false);
  const titleBase = useRef(task.title);
  const [desc, setDesc] = useState(task.description ?? "");
  const [descEditing, setDescEditing] = useState(false);
  const descBase = useRef(task.description ?? "");
  const descFocused = useRef(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const filesLoadedAt = useRef(0);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // keep the buffers in step with teammates' edits while you aren't editing
  useEffect(() => {
    if (!titleFocused) { setTitleBuf(task.title); titleBase.current = task.title; }
  }, [task.title, titleFocused]);
  useEffect(() => {
    if (!descEditing) { const d = task.description ?? ""; setDesc(d); descBase.current = d; }
  }, [task.description, descEditing]);

  // load the comment thread + change history for this task
  useEffect(() => {
    let cancelled = false;
    // merge, not replace: a live comment may arrive via the realtime channel
    // before this initial query resolves — keep any such rows not already in cs.
    store.listComments(taskId).then((cs) => { if (!cancelled) setThread((prev) => { const ids = new Set(cs.map((c) => c.id)); return [...cs, ...prev.filter((p) => !ids.has(p.id))]; }); }).catch(reportError);
    store.listTaskEvents(taskId).then((es) => { if (!cancelled) setEvents(es); }).catch(reportError);
    return () => { cancelled = true; };
  }, [taskId]);

  // attachments — and re-list before their signed links lapse (an hour), and
  // when you come back to the tab, so links keep working and teammates' new
  // files appear
  useEffect(() => {
    let cancelled = false;
    const load = () => store.listAttachments(taskId)
      .then((fs) => { if (!cancelled) { setFiles([...fs]); filesLoadedAt.current = Date.now(); } })
      .catch(reportError);
    load();
    const iv = window.setInterval(load, FILES_REFRESH_MS);
    const onVis = () => { if (document.visibilityState === "visible" && Date.now() - filesLoadedAt.current > 10 * 60 * 1000) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; window.clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [taskId]);

  // drilling into another task removes the row you clicked — park focus on the
  // panel rather than letting it fall to the page behind
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body) panelRef.current?.focus({ preventScroll: true });
  }, [panelRef]);

  // live presence — who else is viewing this task right now. Depends on the
  // viewer's name string, not the members array (whose identity changes on
  // every realtime reload and used to tear the channel down each time).
  // Re-opening a task hands back the same-topic channel if the old one is still
  // leaving, and that one never joins. So: a short delay covers the quick case
  // (StrictMode, a fast close/re-open), and if no presence sync has arrived a
  // few seconds after subscribing we drop that channel and join again (by then
  // the old one has gone), backing off — however slow the network is.
  const meName = useMemo(() => members.find((m) => m.userId === currentUserId)?.name || "Someone", [members, currentUserId]);
  useEffect(() => {
    if (!store.configured) return;
    let unsub: (() => void) | null = null;
    let stopped = false, synced = false, tries = 0, timer = 0;
    const join = () => {
      if (stopped) return;
      unsub?.();
      synced = false;
      unsub = store.subscribeToTaskPresence(taskId, { id: currentUserId, name: meName }, (people) => {
        synced = true;
        if (!stopped) setViewers(people.filter((p) => p.id !== currentUserId));
      });
      const wait = 3000 * 2 ** tries;
      tries += 1;
      if (tries < 4) timer = window.setTimeout(() => { if (!synced) join(); }, wait);
    };
    timer = window.setTimeout(join, 250);
    return () => { stopped = true; window.clearTimeout(timer); setViewers([]); unsub?.(); };
  }, [taskId, currentUserId, meName]);

  // live comments — append comments posted while the panel is open, including
  // your own from another device (one sent from here is already in the thread:
  // sendComment and this both de-duplicate by id), and take edits and
  // reactions as they change
  useEffect(() => {
    const here = (c: Comment) => !c.taskId || c.taskId === taskId;
    const unsub = store.subscribeToTaskComments(taskId,
      (c) => { if (here(c)) setThread((t) => t.some((x) => x.id === c.id) ? t : [...t, c]); },
      (c) => { if (here(c)) setThread((t) => t.map((x) => x.id === c.id ? c : x)); });
    return unsub;
  }, [taskId]);

  // auto-grow the title textarea to fit long titles instead of clipping them
  useEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = "auto"; if (el.scrollHeight) el.style.height = el.scrollHeight + "px"; }
  }, [titleBuf]);
  // …and the comment box, up to about six lines
  useEffect(() => {
    const el = commentRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (!el.scrollHeight) return;
    const full = el.scrollHeight + (el.offsetHeight - el.clientHeight);   // + borders (border-box)
    el.style.height = Math.min(full, 144) + "px";
    el.style.overflowY = full > 144 ? "auto" : "hidden";
  }, [comment]);

  /* ---------- saving the title / description ---------- */
  const serverTask = () => liveTasksRef.current.find((t) => t.id === task.id);
  // Put your text back in the editor, based on the current server value so
  // saving it doesn't ask again. If the panel has closed meanwhile, "restore"
  // means save it.
  const restoreMine = (field: UnsavedField, mine: string) => {
    const cur = serverTask(); if (!cur) return;
    if (!alive.current) { onPatch(task.id, field === "title" ? { title: mine } : { description: mine }); return; }
    if (field === "title") {
      titleBase.current = cur.title;
      setTitleBuf(mine);
      requestAnimationFrame(() => titleRef.current?.focus());
    } else {
      descBase.current = cur.description ?? "";
      setDesc(mine);
      setDescEditing(true);
    }
  };
  // You chose to keep a teammate's newer text. Yours isn't thrown away: the
  // toast can put it back (and it's copied to the clipboard where the browser
  // allows — it often doesn't when the window isn't focused).
  const keepTheirs = (field: UnsavedField, mine: string) => {
    dropUnsaved(currentUserId, task.id, field);
    try { navigator.clipboard?.writeText(mine)?.catch(() => {}); } catch { /* no clipboard */ }
    toast?.action(`Kept their version of the ${field}.`, "Restore mine", () => restoreMine(field, mine), 20000);
  };
  // "hidden" (tab switched away) and "unload" (page closing) never prompt: a
  // conflict waits for you to come back. In both, what you typed is also kept
  // in this tab's storage and offered back next time you open the task if it
  // didn't reach the server.
  type FlushMode = "blur" | "hidden" | "unload";
  const commitTitle = (mode: FlushMode = "blur") => {
    if (readOnly) return;
    const cur = serverTask(); if (!cur) return;          // deleted meanwhile
    const v = titleBuf.replace(/\s*\n+\s*/g, " ").trim(), base = titleBase.current;
    if (!v || v === base.trim()) return;                  // unchanged (an emptied title just reverts)
    if (v === cur.title) { titleBase.current = v; return; }
    if (mode !== "blur") stashUnsaved(currentUserId, task.id, "title", v);
    if (cur.title !== base) {
      if (mode !== "blur") return;
      if (!window.confirm(CONFLICT_MSG)) { titleBase.current = cur.title; keepTheirs("title", v); return; }
    }
    titleBase.current = v;
    if (mode === "blur") dropUnsaved(currentUserId, task.id, "title");
    onPatch(task.id, { title: v });
  };
  const commitDesc = (mode: FlushMode = "blur") => {
    if (readOnly) return;
    const cur = serverTask(); if (!cur) return;
    const v = desc, base = descBase.current, server = cur.description ?? "";
    if (v === base) return;
    if (v === server) { descBase.current = v; return; }
    if (mode !== "blur") stashUnsaved(currentUserId, task.id, "description", v);
    if (server !== base) {
      if (mode !== "blur") return;
      if (!window.confirm(CONFLICT_MSG)) { descBase.current = server; keepTheirs("description", v); if (alive.current) setDesc(server); return; }
    }
    descBase.current = v;
    if (mode === "blur") dropUnsaved(currentUserId, task.id, "description");
    onPatch(task.id, { description: v });
  };
  // every close path saves: unmount (close button, backdrop, Esc, opening
  // another task), and a best-effort save when the tab is hidden or unloads
  const flushRef = useRef<(mode: FlushMode) => void>(() => {});
  flushRef.current = (mode) => { commitTitle(mode); commitDesc(mode); };
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "hidden") flushRef.current("hidden"); };
    const onPageHide = () => flushRef.current("unload");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onPageHide);
      flushRef.current("blur");
    };
  }, []);
  // text you'd typed when the page last closed (or the tab was hidden) that
  // never reached the server — offer it back
  useEffect(() => {
    if (readOnly) return;
    (["title", "description"] as const).forEach((field) => {
      const text = takeUnsaved(currentUserId, task.id, field);
      const cur = serverTask();
      if (text == null || !cur || text === (field === "title" ? cur.title : cur.description ?? "")) return;
      toast?.action(`Your last change to this task's ${field} may not have been saved.`, "Restore", () => restoreMine(field, text), 20000);
    });
    // once per task (the panel is keyed by task)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // leave the field you're typing in (its blur saves it) but keep the panel open
  // (focus parks on the panel, which shows the focus ring; Tab carries on
  // from the field you left)
  const stepOut = () => panelRef.current?.focus({ preventScroll: true });
  // …except the description, whose Edit button takes focus once it's back
  useEffect(() => {
    if (descEditing || !refocusDescEdit.current) return;
    refocusDescEdit.current = false;
    if (document.activeElement === panelRef.current) descEditBtnRef.current?.focus();
  }, [descEditing, panelRef]);
  const startDescEdit = () => {
    if (readOnly) return;
    descBase.current = task.description ?? "";
    setDesc(task.description ?? "");
    setDescEditing(true);
  };

  const proj = getProject(task.projectId);
  const dependents = tasks.filter((t) => t.dependencies?.includes(task.id));
  const children = tasks.filter((t) => t.parentId === task.id);
  const parent = task.parentId ? tasks.find((t) => t.id === task.parentId) : undefined;
  const following = (task.followers ?? []).includes(currentUserId);
  const taskReactions = task.reactions ?? {};
  // thread as top-level comments each followed by its (one-level) replies.
  // A reply whose parent is gone (deleted) is promoted to top-level so it can
  // never silently disappear from the panel.
  const topLevelIds = new Set(thread.filter((c) => !c.parentId).map((c) => c.id));
  const isTop = (c: Comment) => !c.parentId || !topLevelIds.has(c.parentId);
  const orderedComments = thread.filter(isTop).flatMap((c) => [
    { c, depth: 0 },
    ...thread.filter((r) => r.parentId === c.id && !isTop(r)).map((r) => ({ c: r, depth: 1 })),
  ]);
  const replyingToComment = replyingTo ? thread.find((c) => c.id === replyingTo) : null;
  const done = task.status === "done";
  // comments are already in the thread above (with author and text), and a
  // comment row can't be worded reliably — your own is logged with its text,
  // a teammate's with their name — so they're left out here
  const taskActivity = activity.filter((a) => a.taskId === task.id && a.kind !== "comment").slice(0, 8);
  // Only people who belong to THIS task's workspace can be assigned/collaborate.
  // A personal-project task (no workspace) is therefore just you — never members
  // pulled in from your other team workspaces.
  const taskWs = task.workspaceId ?? null;
  const activeMembers = members.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === taskWs);
  const assignable = activeMembers.length > 0
    ? activeMembers.map((m) => ({ id: m.userId!, name: m.name || m.email }))
    : [{ id: currentUserId, name: getMember(currentUserId)?.name || "You" }];
  const projectTaskCount = tasks.filter((t) => t.projectId === task.projectId).length;
  const ids = { status: `${uid}-status`, priority: `${uid}-priority`, project: `${uid}-project`, section: `${uid}-section`, assignee: `${uid}-assignee`, due: `${uid}-due`, start: `${uid}-start`, repeat: `${uid}-repeat`, estimate: `${uid}-estimate`, logged: `${uid}-logged`, desc: `${uid}-desc`, mentions: `${uid}-mentions`, descMentions: `${uid}-desc-mentions`, deps: `${uid}-deps` };

  // deleting a tag removes it from every task that has it — TagPicker asks
  // first, and says how many tasks that is
  const tagUsage = (id: string) => tasks.filter((t) => t.tags.includes(id)).length;
  // a start date can't come after the due date (the timeline's rule)
  const setStart = (iso: string) => {
    if (!iso) { setStartError(false); if (task.startDate) onPatch(task.id, { startDate: undefined }); return; }
    const r = timelineStartPatch(task, iso);
    setStartError(!r.ok && r.reason === "after-due");
    if (r.ok) onPatch(task.id, r.patch);
  };
  const toggleTag = (id: string) => {
    const next = task.tags.includes(id) ? task.tags.filter((x) => x !== id) : [...task.tags, id];
    onPatch(task.id, { tags: next });
  };
  const addSub = () => { const v = newSub.trim(); if (v) { onAddSubtask(task.id, v); setNewSub(""); } };
  const aiBreakdown = async () => {
    const forTask = task.id;
    setAiSubBusy(true);
    let subs: string[] = [];
    try { subs = await store.aiBreakdown(task.title, desc); } catch (err) { reportError(err, { op: "aiBreakdown" }); }
    // you asked for this task's sub-tasks, so they're added even if you've moved on
    if (subs.length) subs.forEach((s) => onAddSubtask(forTask, s));
    if (!alive.current) return;
    setAiSubBusy(false);
    // the server's reason (daily limit, awaiting approval) when it gave one — shown a little longer
    const why = subs.length ? null : store.aiNotice();
    if (!subs.length) { setAiSubNote(why ?? "AI couldn't suggest subtasks — add them manually."); window.setTimeout(() => { if (alive.current) setAiSubNote(null); }, why ? 6000 : 3000); }
  };

  // @mention autocomplete — suggest teammates as you type "@…". Picks are
  // remembered by id, so the right person is notified even when names clash.
  const mentionable = assignable.filter((m) => m.id !== currentUserId);
  const mentionNames = mentionable.map((m) => m.name);
  const mentionMatches = mentionQuery !== null
    ? mentionable.filter((m) => m.name.toLowerCase().includes(mentionQuery)).slice(0, 6)
    : [];
  const mentionActive = Math.min(mentionIdx, Math.max(0, mentionMatches.length - 1));
  const setComment = (v: string) => { setCommentState(v); writeDraft(currentUserId, task.id, v); };
  const onCommentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setComment(val);
    const caret = e.target.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/(?:^|\s)@([\w'’.-]*)$/);
    setMentionQuery(m ? m[1].toLowerCase() : null);
    setMentionIdx(0);
  };
  const pickMention = (who: MentionCandidate) => {
    const el = commentRef.current;
    const caret = el?.selectionStart ?? comment.length;
    const before = comment.slice(0, caret).replace(/(^|\s)@[\w'’.-]*$/, `$1@${who.name} `);
    const next = before + comment.slice(caret);
    setComment(next);
    setPicked((p) => p.some((x) => x.id === who.id) ? p : [...p, who]);
    setMentionQuery(null);
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(before.length, before.length); } });
  };
  // @mention autocomplete for the description editor (mirrors the comment one)
  const descMatches = descMentionQuery !== null
    ? mentionable.filter((m) => m.name.toLowerCase().includes(descMentionQuery)).slice(0, 6)
    : [];
  const descActive = Math.min(descMentionIdx, Math.max(0, descMatches.length - 1));
  const onDescChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setDesc(val);
    const caret = e.target.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/(?:^|\s)@([\w'’.-]*)$/);
    setDescMentionQuery(m ? m[1].toLowerCase() : null);
    setDescMentionIdx(0);
  };
  const pickDescMention = (name: string) => {
    const el = descRef.current;
    const caret = el?.selectionStart ?? desc.length;
    const before = desc.slice(0, caret).replace(/(^|\s)@[\w'’.-]*$/, `$1@${name} `);
    const next = before + desc.slice(caret);
    setDesc(next);
    setDescMentionQuery(null);
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(before.length, before.length); } });
  };

  const sendComment = async () => {
    const v = comment.trim();
    if (!v || posting) return;
    const forTask = task.id;
    const mentions = resolveMentions(v, picked, mentionable);
    // only reply to a comment that's really in this task's thread
    const parentId = replyingTo && thread.some((c) => c.id === replyingTo) ? replyingTo : undefined;
    setPosting(true);
    let c: Comment | null = null;
    try { c = await onAddComment(forTask, v, mentions, parentId); }
    catch (err) { reportError(err, { op: "addComment" }); toast?.error("Couldn't post the comment."); }
    if (!alive.current) {
      // the panel moved on while this posted — just don't restore the sent text as a draft
      if (c && readDraft(currentUserId, forTask).trim() === v) writeDraft(currentUserId, forTask, "");
      return;
    }
    setPosting(false);
    if (c && (!c.taskId || c.taskId === forTask)) {
      setThread((t) => t.some((x) => x.id === c.id) ? t : [...t, c]);
      // clear the box — unless you kept typing while it posted
      setCommentState((cur) => { const next = cur.trim() === v ? "" : cur; writeDraft(currentUserId, forTask, next); return next; });
      setPicked([]); setMentionQuery(null); setReplyingTo(null);
    }
  };
  const toggleReaction = (c: Comment, emoji: string) => {
    const reactions: Record<string, string[]> = { ...(c.reactions || {}) };
    const list = reactions[emoji] || [];
    reactions[emoji] = list.includes(currentUserId) ? list.filter((x) => x !== currentUserId) : [...list, currentUserId];
    if (reactions[emoji].length === 0) delete reactions[emoji];
    setThread((t) => t.map((x) => x.id === c.id ? { ...x, reactions } : x));
    store.toggleReaction(c.id, emoji, currentUserId).catch(reportError);
  };
  // leaving a comment edit hands focus back to that comment's Edit button
  // (or parks it on the panel if the comment has gone)
  const endCommentEdit = (id: string) => {
    setEditingComment(null);
    requestAnimationFrame(() => {
      if (!alive.current) return;
      const btn = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-edit-comment]") ?? []).find((b) => b.dataset.editComment === id);
      if (btn) btn.focus(); else stepOut();
    });
  };
  const saveCommentEdit = (c: Comment) => {
    const v = editDraft.trim();
    endCommentEdit(c.id);
    if (!v || v === c.body) return;
    setThread((t) => t.map((x) => x.id === c.id ? { ...x, body: v } : x));
    store.updateComment(c.id, v).catch(reportError);
  };
  const removeComment = (c: Comment) => {
    if (!window.confirm("Delete this comment?")) return;
    // drop the comment AND its replies locally, mirroring the DB's parent_id
    // ON DELETE CASCADE so no orphaned reply lingers in the panel.
    const removedIds = new Set([c.id, ...thread.filter((x) => x.parentId === c.id).map((x) => x.id)]);
    setThread((t) => t.filter((x) => !removedIds.has(x.id)));
    if (replyingTo && removedIds.has(replyingTo)) setReplyingTo(null);
    if (editingComment && removedIds.has(editingComment)) setEditingComment(null);
    onPatch(task.id, { comments: Math.max(0, (task.comments || 0) - removedIds.size) });
    store.deleteComment(c.id).catch(reportError);
  };
  const del = () => {
    const n = children.length;
    const msg = n ? `Delete “${task.title}” and its ${n} sub-task${n === 1 ? "" : "s"}?` : `Delete “${task.title}”?`;
    if (!window.confirm(msg)) return;
    onClose(); onDelete(task.id);
  };
  const copyLink = () => {
    const url = `${location.origin}/?task=${task.id}`;
    const ok = () => {
      if (!alive.current) return;
      setCopied(true); window.setTimeout(() => { if (alive.current) setCopied(false); }, 1500);
      toast?.success("Link copied");
    };
    const fallback = () => { window.prompt("Copy this link to the task", url); };
    try {
      const p = navigator.clipboard?.writeText(url);
      if (p) p.then(ok, fallback); else fallback();
    } catch { fallback(); }
  };
  const onPickFiles = async (list: FileList | File[] | null) => {
    if (readOnly || !list || list.length === 0) return;
    const forTask = task.id;
    setUploading(true);
    for (const f of Array.from(list)) {
      if (f.size > 25 * 1024 * 1024) { window.alert(`"${f.name}" is over 25 MB.`); continue; }
      try {
        const a = await store.uploadAttachment(forTask, f, currentUserId);
        // the panel may have moved on to another task while this uploaded
        if (alive.current && a.taskId === forTask) setFiles((xs) => xs.some((x) => x.id === a.id) ? xs : [...xs, a]);
      } catch (e) { reportError(e, { op: "uploadAttachment" }); window.alert("Couldn't upload " + f.name); }
    }
    if (!alive.current) return;
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };
  const canRemoveFile = (a: Attachment) => !readOnly && canDeleteAttachment(a, currentUserId, !store.configured);
  const removeFile = async (a: Attachment) => {
    if (!canRemoveFile(a)) return;
    if (!window.confirm(`Delete “${a.name}” from this task? This can't be undone.`)) return;
    setFiles((xs) => xs.filter((x) => x.id !== a.id));
    try { await store.deleteAttachment(a); }
    catch (e) {
      reportError(e, { op: "deleteAttachment" });
      if (alive.current) setFiles((xs) => xs.some((x) => x.id === a.id) ? xs : [...xs, a]);
      toast?.error(`Couldn't delete “${a.name}”.`);
    }
  };

  /* ---------- dependency picker (combobox) ---------- */
  const depCandidates = depPickerOpen ? dependencyCandidates(task, tasks, depQuery, 8) : [];
  const depActive = Math.min(depIdx, Math.max(0, depCandidates.length - 1));
  const closeDepPicker = (refocus: boolean) => {
    setDepPickerOpen(false); setDepQuery(""); setDepIdx(0);
    if (refocus) requestAnimationFrame(() => depAddRef.current?.focus());
  };
  const addDependency = (c: Task) => {
    if (!onAddDependency) return;
    // re-checked here against the live list: a loop makes both tasks blocked forever
    if (wouldCreateCycle(tasks, task.id, c.id)) { toast?.error(`“${c.title}” already depends on this task.`); return; }
    onAddDependency(task.id, c.id);
    closeDepPicker(true);
  };

  /* ---------- Escape ----------
     Escape belongs to the innermost thing: a menu or picker closes first; in
     a text field it finishes editing (saving via blur) and keeps the panel
     open; only then does it close the panel. preventDefault in the capture
     phase marks it handled for the focus trap (which listens on the document);
     the bubble phase then does the work and stops the event before it reaches
     the trap or App's window-level Escape handler. */
  // (the edit box itself, not the id: the comment may have been deleted under it)
  const commentEditOpen = () => !!editRef.current?.isConnected;
  const hasOpenLayer = () => reactPickerFor !== null || reactMoreOpen || depPickerOpen || mentionMatches.length > 0 || descMatches.length > 0 || commentEditOpen();
  const onEscCapture = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    if (hasOpenLayer() || isEditableTarget(e.target)) e.preventDefault();
  };
  const onEscKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (e.nativeEvent.isComposing) { e.stopPropagation(); return; }   // Esc cancels IME composition, nothing more
    if (reactPickerFor !== null || reactMoreOpen) { setReactPickerFor(null); setReactMoreOpen(false); e.stopPropagation(); return; }
    if (depPickerOpen) { closeDepPicker(true); e.stopPropagation(); return; }
    if (mentionMatches.length > 0 || descMatches.length > 0) { setMentionQuery(null); setDescMentionQuery(null); e.stopPropagation(); return; }
    // a comment edit is open but you're elsewhere — take you back to it rather than lose it
    if (commentEditOpen() && e.target !== editRef.current) { editRef.current?.focus(); e.stopPropagation(); return; }
    if (isTextEntry(e.target)) {
      e.stopPropagation();
      if (e.target === descRef.current) refocusDescEdit.current = true;
      stepOut();
      return;
    }
    // a select / date / checkbox already saved its value — nothing to lose, so close
    if (isEditableTarget(e.target)) { e.stopPropagation(); onClose(); }
  };

  const listOption = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none",
    background: active ? "var(--fill-1, var(--surface-2))" : "transparent", cursor: "pointer", textAlign: "left",
    fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink-2)",
  });
  const selectStyle: React.CSSProperties = { height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13 };
  const totalReacts = Object.values(taskReactions).reduce((n, u) => n + (u?.length ?? 0), 0);
  const chosenCollaborators = (task.collaborators ?? []).filter((id) => id !== task.assigneeId);
  const section = sections.find((s) => s.id === task.sectionId);

  return (
    <div onKeyDownCapture={onEscCapture} onKeyDown={onEscKey} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <button className="btn-icon" onClick={onClose} aria-label="Close task" title="Close (Esc)" style={{ border: "none" }}><Icon name="x" size={18} /></button>
          {readOnly && (
            <span title="Guests can view this task and comment on it" style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", flexShrink: 0, padding: "3px 9px", borderRadius: 999, fontSize: 11.5, color: "var(--ink-3)", background: "var(--fill-1, var(--surface-2))", border: "1px solid var(--hairline)" }}>
              <Icon name="lock" size={12} /> View and comment
            </span>
          )}
          <div style={{ flex: 1 }} />
          {viewers.length > 0 && (
            <span title={`Also viewing: ${viewers.map((v) => v.name).join(", ")}`} aria-label={`Also viewing: ${viewers.map((v) => v.name).join(", ")}`} role="img" style={{ display: "inline-flex", alignItems: "center", marginRight: 4 }}>
              {viewers.slice(0, 3).map((v, i) => <span key={v.id} style={{ marginLeft: i ? -7 : 0, borderRadius: 99, boxShadow: "0 0 0 2px var(--surface-raised), 0 0 0 3px var(--accent)" }}><Avatar id={v.id} size={24} /></span>)}
              {viewers.length > 3 && <span style={{ marginLeft: 4, fontSize: 11.5, color: "var(--ink-4)" }}>+{viewers.length - 3}</span>}
            </span>
          )}
          {proj && <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0, fontSize: 12.5, color: "var(--ink-3)" }}><span style={{ width: 8, height: 8, borderRadius: 2, background: proj.color, flexShrink: 0 }} /><span className="truncate" style={{ maxWidth: 140 }}>{proj.name}</span></span>}
          {onToggleFollow && <button className="btn-icon" onClick={() => onToggleFollow(task.id)} title={following ? "Following — click to unfollow" : "Follow for updates"} aria-label={following ? "Unfollow task" : "Follow task"} aria-pressed={following} style={{ border: "none", color: following ? "var(--accent)" : "var(--ink-3)" }}><Icon name="bell" size={16} /></button>}
          <button className="btn-icon" onClick={copyLink} title="Copy link to task" aria-label="Copy link to task" style={{ border: "none", color: copied ? "var(--accent)" : "var(--ink-3)" }}><Icon name={copied ? "check" : "link"} size={16} /></button>
          {onDuplicate && !readOnly && <button className="btn-icon" onClick={() => { onDuplicate(task.id); onClose(); }} title="Duplicate task" aria-label="Duplicate task" style={{ border: "none", color: "var(--ink-3)" }}><Icon name="layers" size={16} /></button>}
          <button className="btn-icon" onClick={() => { saveTemplate({ name: task.title, title: task.title, priority: task.priority, tags: task.tags, focusMin: task.focusMin, recurrence: task.recurrence ?? "none", description: desc }); setTmplSaved(true); setTimeout(() => { if (alive.current) setTmplSaved(false); }, 1500); }} title="Save as template" aria-label="Save as template" style={{ border: "none", color: tmplSaved ? "var(--accent)" : "var(--ink-3)" }}><Icon name={tmplSaved ? "check" : "briefcase"} size={16} /></button>
          {!readOnly && (task.archivedAt
            ? (onUnarchive && <button className="btn-icon" onClick={() => { onUnarchive(task.id); onClose(); }} title="Unarchive task" aria-label={`Unarchive “${task.title}”`} style={{ border: "none", color: "var(--accent)" }}><Icon name="refresh" size={16} /></button>)
            : (onArchive && <button className="btn-icon" onClick={() => { onArchive(task.id); onClose(); }} title="Archive task" aria-label={`Archive “${task.title}”`} style={{ border: "none", color: "var(--ink-3)" }}><Icon name="archive" size={16} /></button>))}
          {!readOnly && <button className="btn-icon" onClick={del} title="Delete task" aria-label={`Delete “${task.title}”`} style={{ border: "none", color: "var(--ink-3)" }}><Icon name="trash" size={17} /></button>}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px", position: "relative", outline: dragOver ? "2px dashed var(--accent)" : "none", outlineOffset: "-8px" }}
          onDragOver={(e) => { if (!readOnly && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
          onDrop={(e) => { if (!readOnly && e.dataTransfer.files?.length) { e.preventDefault(); setDragOver(false); onPickFiles(e.dataTransfer.files); } }}>
          {/* title — editable */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ marginTop: 3 }}>{readOnly ? <StaticCheck done={done} size={22} /> : <Check done={done} size={22} celebrateKey={task.id} label={task.title} onToggle={() => onToggle(task.id)} />}</div>
            {readOnly ? (
              <h2 style={{ flex: 1, margin: 0, fontFamily: "var(--font-display)", fontSize: 21, fontWeight: 600, lineHeight: 1.25, letterSpacing: "-0.02em", color: done ? "var(--ink-3)" : "var(--ink)", textDecoration: done ? "line-through" : "none", wordBreak: "break-word" }}>{task.title}</h2>
            ) : (
              <textarea
                ref={titleRef}
                aria-label="Task title"
                value={titleBuf}
                onChange={(e) => setTitleBuf(e.target.value)}
                onFocus={() => setTitleFocused(true)}
                onBlur={() => { commitTitle(); setTitleFocused(false); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); stepOut(); } }}
                rows={1}
                style={{ flex: 1, resize: "none", border: "none", borderRadius: 6, background: "transparent", fontFamily: "var(--font-display)", fontSize: 21, fontWeight: 600, lineHeight: 1.25, letterSpacing: "-0.02em", color: done ? "var(--ink-3)" : "var(--ink)", textDecoration: done ? "line-through" : "none", overflow: "hidden" }}
              />
            )}
          </div>

          {/* task reactions — tucked behind a button so the panel opens on fields */}
          {onToggleTaskReaction && !readOnly && (
            <div style={{ margin: "10px 0 2px", paddingLeft: 34 }}>
              {!reactsOpen ? (
                <button onClick={() => setReactsOpen(true)} title="React to this task"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999, cursor: "pointer", fontSize: 12.5,
                    border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-3)" }}>
                  🙂 React{totalReacts > 0 && <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{totalReacts}</span>}
                </button>
              ) : (
                <div style={{ position: "relative", display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {[...new Set([...REACTION_EMOJIS, ...Object.keys(taskReactions)])].map((emoji) => {
                    const uids = taskReactions[emoji] ?? [];
                    const mine = uids.includes(currentUserId);
                    return (
                      <button key={emoji} onClick={() => onToggleTaskReaction(task.id, emoji)} title={uids.length ? `${uids.length} reacted` : "React"} aria-pressed={mine}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, cursor: "pointer", fontSize: 13,
                          border: `1px solid ${mine ? "var(--accent)" : "var(--hairline)"}`, background: mine ? "var(--accent-dim)" : "transparent", opacity: uids.length || mine ? 1 : 0.55 }}>
                        {emoji}{uids.length > 0 && <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{uids.length}</span>}
                      </button>
                    );
                  })}
                  <button onClick={() => setReactMoreOpen((v) => !v)} title="More reactions" aria-label="More reactions" aria-expanded={reactMoreOpen} style={{ padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: 13, border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-3)" }}>＋</button>
                  {reactMoreOpen && (
                    <>
                      <div onClick={() => setReactMoreOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                      <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 41 }}><EmojiPicker height={180} onPick={(e) => { onToggleTaskReaction(task.id, e); setReactMoreOpen(false); }} /></div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {readOnly && totalReacts > 0 && (
            <div style={{ margin: "10px 0 2px", paddingLeft: 34, display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Object.entries(taskReactions).filter(([, u]) => u?.length).map(([emoji, u]) => (
                <span key={emoji} title={`${u.length} reacted`} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, fontSize: 13, border: "1px solid var(--hairline)" }}>
                  {emoji}<span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{u.length}</span>
                </span>
              ))}
            </div>
          )}

          {/* AI recommendation */}
          {task.aiReason && !done && (
            <div style={{ margin: "16px 0 4px", padding: "13px 14px", borderRadius: 12, background: "var(--accent-dim)", border: "1px solid color-mix(in oklch, var(--accent) 26%, transparent)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                <Icon name="sparkles" size={15} style={{ color: "var(--accent)" }} />
                <span className="kicker" style={{ color: "var(--accent)" }}>Kanbo suggests</span>
                <span style={{ marginLeft: "auto" }}><AiScore score={task.aiScore} reason="AI priority score" /></span>
              </div>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--ink-2)" }}>{task.aiReason}</p>
              <button className="btn btn-accent" onClick={() => onFocus(task.id)} style={{ marginTop: 11, padding: "7px 12px", fontSize: 12.5 }}><Icon name="play" size={13} fill="currentColor" /> Start {task.focusMin}m focus block</button>
            </div>
          )}

          {/* meta */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "20px 0", paddingTop: 4 }}>
            <MetaRow icon="circle" label="Status" htmlFor={readOnly ? undefined : ids.status}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <StatusDot status={task.status} size={8} />
                {readOnly ? <ReadValue>{STATUS_META[task.status]?.label ?? task.status}</ReadValue> : (
                  <select id={ids.status} value={task.status} onChange={(e) => {
                    const s = e.target.value as Status;
                    // completing goes the same way as the checkbox: blocker warning,
                    // Undo toast, and a single next occurrence for repeating tasks
                    if (s === "done" && task.status !== "done") { onToggle(task.id); return; }
                    onPatch(task.id, { status: s, completedAt: undefined });
                  }} style={selectStyle}>
                    {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                  </select>
                )}
              </span>
            </MetaRow>
            <MetaRow icon="flag" label="Priority" htmlFor={readOnly ? undefined : ids.priority}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Icon name="flag" size={13} fill={task.priority === "urgent" || task.priority === "high" ? PRIORITY_META[task.priority].color : "none"} style={{ color: PRIORITY_META[task.priority].color }} />
                {readOnly ? <ReadValue>{PRIORITY_META[task.priority]?.label ?? task.priority}</ReadValue> : (
                  <select id={ids.priority} value={task.priority} onChange={(e) => onPatch(task.id, { priority: e.target.value as Priority })} style={selectStyle}>
                    {(Object.keys(PRIORITY_META) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
                  </select>
                )}
              </span>
            </MetaRow>
            <MetaRow icon="grid" label="Project" htmlFor={readOnly ? undefined : ids.project}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {proj && <span style={{ width: 9, height: 9, borderRadius: 3, background: proj.color, flexShrink: 0 }} />}
                {readOnly ? <ReadValue>{proj?.name || "Project"}</ReadValue> : (
                  <select id={ids.project} value={task.projectId} onChange={(e) => onPatch(task.id, { projectId: e.target.value })} style={{ ...selectStyle, maxWidth: 220 }}>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    {!projects.some((p) => p.id === task.projectId) && <option value={task.projectId}>{proj?.name || "Project"}</option>}
                  </select>
                )}
              </span>
            </MetaRow>
            {(sections.length > 0 || onCreateSection) && (!readOnly || section) && (
              <MetaRow icon="layers" label="Section" htmlFor={readOnly ? undefined : ids.section}>
                {readOnly ? <ReadValue>{section?.name}</ReadValue> : (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <select id={ids.section} value={task.sectionId ?? ""} onChange={(e) => onPatch(task.id, { sectionId: e.target.value || undefined })} style={fieldInputStyle}>
                      <option value="">No section</option>
                      {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      {task.sectionId && !sections.some((s) => s.id === task.sectionId) && <option value={task.sectionId}>(section)</option>}
                    </select>
                    {onCreateSection && <button onClick={() => { const n = window.prompt("New section name"); if (n?.trim()) onCreateSection(task.projectId, n.trim()); }} className="btn-icon" title="New section" aria-label="New section" style={{ border: "none", color: "var(--ink-4)", width: 28, height: 28 }}><Icon name="plus" size={15} /></button>}
                  </span>
                )}
              </MetaRow>
            )}
            <MetaRow icon="user" label="Assignee" htmlFor={readOnly ? undefined : ids.assignee}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Avatar id={task.assigneeId} size={22} />
                {readOnly ? <ReadValue>{assignable.find((p) => p.id === task.assigneeId)?.name || getMember(task.assigneeId)?.name || "Unassigned"}</ReadValue> : (
                  <select id={ids.assignee} value={task.assigneeId} onChange={(e) => onPatch(task.id, { assigneeId: e.target.value })} style={selectStyle}>
                    {assignable.map((p) => <option key={p.id} value={p.id}>{p.id === currentUserId ? `${p.name} (you)` : p.name}</option>)}
                    {!assignable.some((p) => p.id === task.assigneeId) && <option value={task.assigneeId}>{getMember(task.assigneeId)?.name || "Unassigned"}</option>}
                  </select>
                )}
              </span>
            </MetaRow>
            {onToggleCollaborator && assignable.length > 1 && (!readOnly || chosenCollaborators.length > 0) && (() => {
              const chosen = chosenCollaborators;
              const addable = readOnly ? [] : assignable.filter((p) => p.id !== task.assigneeId && !chosen.includes(p.id));
              return (
                <MetaRow icon="users" label="Collaborators">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {chosen.map((id) => {
                      const name = assignable.find((p) => p.id === id)?.name || getMember(id)?.name || "Member";
                      return (
                        <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: readOnly ? "3px 9px 3px 4px" : "3px 4px 3px 4px", borderRadius: 999, fontSize: 12.5, border: "1px solid var(--accent)", background: "var(--accent-dim)", color: "var(--ink)" }}>
                          <Avatar id={id} size={18} /> {name}
                          {!readOnly && (
                            <button onClick={() => onToggleCollaborator(task.id, id)} aria-label={`Remove ${name}`}
                              style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-4)", fontSize: 15, lineHeight: 1, padding: "0 2px" }}>×</button>
                          )}
                        </span>
                      );
                    })}
                    {addable.length > 0 && (
                      <select value="" onChange={(e) => { if (e.target.value) onToggleCollaborator(task.id, e.target.value); }}
                        aria-label="Add collaborator"
                        style={{ height: 28, padding: "0 8px", borderRadius: 999, border: "1px dashed var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", fontFamily: "var(--font-display)", fontSize: 12.5, cursor: "pointer" }}>
                        <option value="">+ Add collaborator</option>
                        {addable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                    {!readOnly && chosen.length === 0 && addable.length === 0 && <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>No one else in this workspace</span>}
                  </div>
                </MetaRow>
              );
            })()}
            <MetaRow icon="calendar" label="Due" topAlign={!readOnly} htmlFor={readOnly ? undefined : ids.due}>
              {readOnly ? (
                <ReadValue muted={!task.dueDate} mono={!!task.dueDate}>{task.dueDate ? `${fmtDue(task.dueDate)}${task.dueTime ? ` · ${task.dueTime}` : ""}` : "No due date"}</ReadValue>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <input id={ids.due} type="date" value={task.dueDate || ""} onChange={(e) => onPatch(task.id, { dueDate: e.target.value || undefined })}
                    style={{ height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: dueState(task.dueDate, task.status) === "overdue" ? "var(--prio-urgent)" : "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5 }} />
                  <input type="time" value={task.dueTime || ""} onChange={(e) => onPatch(task.id, { dueTime: e.target.value || undefined })} title="Due time" aria-label="Due time"
                    style={{ height: 30, padding: "0 7px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5 }} />
                  {DUE_PRESETS.map((p) => (
                    <button key={p.kind} onClick={() => onPatch(task.id, { dueDate: presetDate(p.kind) })} style={{ padding: "4px 9px", borderRadius: 7, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", cursor: "pointer", fontSize: 11.5, fontFamily: "var(--font-display)" }}>{p.label}</button>
                  ))}
                  {task.dueDate && <button onClick={() => onPatch(task.id, { dueDate: undefined })} title="Clear due date" aria-label="Clear due date" style={{ padding: "4px 7px", borderRadius: 7, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 13 }}>×</button>}
                </div>
              )}
            </MetaRow>
            {(!readOnly || task.startDate) && (
              <MetaRow icon="timeline" label="Start" topAlign={!readOnly && startError} htmlFor={readOnly ? undefined : ids.start}>
                {readOnly ? (
                  <ReadValue mono>{shortDate(task.startDate!)}</ReadValue>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <input id={ids.start} type="date" value={task.startDate || ""} max={task.dueDate || undefined} onChange={(e) => setStart(e.target.value)}
                      aria-invalid={startError || undefined} aria-describedby={startError ? `${ids.start}-err` : undefined}
                      style={{ height: 30, padding: "0 9px", borderRadius: 8, border: `1px solid ${startError ? "var(--prio-urgent)" : "var(--hairline)"}`, background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5 }} />
                    {task.startDate && <button onClick={() => setStart("")} title="Clear start date" aria-label="Clear start date" style={{ padding: "4px 7px", borderRadius: 7, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 13 }}>×</button>}
                    {startError && <span id={`${ids.start}-err`} role="alert" style={{ flexBasis: "100%", fontSize: 11.5, color: "var(--prio-urgent)" }}>The start date can't be after the due date.</span>}
                  </div>
                )}
              </MetaRow>
            )}
            <button onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}
              style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6, padding: "4px 2px", border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, color: "var(--ink-3)" }}>
              <Icon name={moreOpen ? "chevronDown" : "chevronRight"} size={14} /> {moreOpen ? "Fewer options" : "More options"}
            </button>
            {moreOpen && (<>
            <MetaRow icon="refresh" label="Repeat" topAlign={!!task.recurrence && task.recurrence !== "none"} htmlFor={readOnly ? undefined : ids.repeat}>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {readOnly ? <ReadValue>{RECUR_LABEL[task.recurrence || "none"]}</ReadValue> : (
                    <select id={ids.repeat} value={task.recurrence || "none"} onChange={(e) => onPatch(task.id, { recurrence: e.target.value as Recurrence })} style={selectStyle}>
                      {(Object.keys(RECUR_LABEL) as Recurrence[]).map((r) => <option key={r} value={r}>{RECUR_LABEL[r]}</option>)}
                    </select>
                  )}
                  {!readOnly && task.recurrence && task.recurrence !== "none" && task.dueDate && (
                    <button onClick={() => {
                      // same maths as completing it: the start date moves with it and a month-end series keeps its day
                      const n = nextOccurrence(task, task.id);
                      onPatch(task.id, { dueDate: n.dueDate, startDate: n.startDate, originalDueDate: n.originalDueDate });
                    }} title="Move this task to its next occurrence without completing it"
                      style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", cursor: "pointer", fontSize: 12, fontFamily: "var(--font-display)" }}>Skip →</button>
                  )}
                </span>
                {task.recurrence && task.recurrence !== "none" && (
                  <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Next: {nextOccurrences(task, task.recurrence, 3).map(shortDate).join(" · ")}</span>
                )}
              </div>
            </MetaRow>
            <MetaRow icon="clock" label="Estimate" htmlFor={readOnly ? undefined : ids.estimate}>
              {readOnly ? <ReadValue muted={task.effortHours == null}>{task.effortHours == null ? "—" : `${task.effortHours} hours`}</ReadValue> : (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                  <BufferedInput id={ids.estimate} type="number" min={0} step={0.5} value={task.effortHours == null ? "" : String(task.effortHours)}
                    onCommit={(s) => onPatch(task.id, { effortHours: numOrUndef(s) })}
                    style={{ width: 80, height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5 }} />
                  <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>hours</span>
                </span>
              )}
            </MetaRow>
            <MetaRow icon="clock" label="Logged" htmlFor={readOnly ? undefined : ids.logged}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                {readOnly ? <ReadValue muted={task.loggedHours == null}>{task.loggedHours == null ? "—" : `${task.loggedHours} hours`}</ReadValue> : (<>
                  <BufferedInput id={ids.logged} type="number" min={0} step={0.5} value={task.loggedHours == null ? "" : String(task.loggedHours)}
                    onCommit={(s) => onPatch(task.id, { loggedHours: numOrUndef(s) })}
                    style={{ width: 80, height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5 }} />
                  <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>hours</span>
                </>)}
                {!readOnly && [0.5, 1].map((h) => <button key={h} onClick={() => onPatch(task.id, { loggedHours: Math.round(((task.loggedHours ?? 0) + h) * 2) / 2 })} title={`Log ${h}h`} style={{ padding: "3px 8px", borderRadius: 7, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", cursor: "pointer", fontSize: 11.5, fontFamily: "var(--font-display)" }}>+{h}h</button>)}
                {task.effortHours != null && task.loggedHours != null && task.loggedHours > task.effortHours && <span style={{ fontSize: 11, color: "var(--prio-urgent)" }}>over estimate</span>}
              </span>
            </MetaRow>
            <MetaRow icon="grid" label="Tags">
              {readOnly ? (
                task.tags.length === 0 ? <ReadValue muted>No tags</ReadValue> : (
                  <span style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {task.tags.map((id) => tags[id] && (
                      <span key={id} style={{ display: "inline-flex", alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, padding: "1px 7px", borderRadius: 6, color: tags[id].color, border: `1px solid color-mix(in oklch, ${tags[id].color} 30%, transparent)`, background: `color-mix(in oklch, ${tags[id].color} 12%, transparent)` }}>{tags[id].label}</span>
                    ))}
                  </span>
                )
              ) : (
                <TagPicker tags={tags} selected={task.tags} onToggle={toggleTag} onCreate={onCreateTag} onDelete={onDeleteTag} usage={tagUsage} ownerKey={task.id} small />
              )}
            </MetaRow>
            <MetaRow icon="target" label="Milestone">
              {readOnly ? <ReadValue muted={!task.isMilestone}>{task.isMilestone ? "Yes" : "No"}</ReadValue> : (
                <button onClick={() => onPatch(task.id, { isMilestone: !task.isMilestone })} aria-pressed={!!task.isMilestone} style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink-2)", padding: 0 }}>
                  <span style={{ width: 16, height: 16, borderRadius: 5, border: `1.5px solid ${task.isMilestone ? "var(--st-review)" : "var(--hairline-strong)"}`, background: task.isMilestone ? "var(--st-review)" : "transparent", display: "grid", placeItems: "center" }}>{task.isMilestone && <Icon name="check" size={11} sw={3} style={{ color: "var(--bg-deep)" }} />}</span>
                  Mark as milestone
                </button>
              )}
            </MetaRow>
            </>)}
          </div>

          {/* description — markdown, click to edit */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
              <span className="kicker" id={ids.desc}>Description</span>
              {!readOnly && !descEditing && (
                <button ref={descEditBtnRef} type="button" onClick={startDescEdit} aria-label="Edit description"
                  style={{ marginLeft: "auto", padding: "2px 6px", border: "none", borderRadius: 6, background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12 }}>Edit</button>
              )}
            </div>
            {descEditing && !readOnly ? (
              <div style={{ position: "relative" }}>
              <MdToolbar getEl={() => descRef.current} value={desc} setValue={setDesc} />
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <textarea autoFocus ref={descRef}
                aria-labelledby={ids.desc}
                aria-autocomplete="list"
                aria-controls={descMatches.length > 0 ? ids.descMentions : undefined}
                aria-activedescendant={descMatches.length > 0 ? `${ids.descMentions}-${descActive}` : undefined}
                value={desc}
                onChange={onDescChange}
                onFocus={() => { descFocused.current = true; }}
                onKeyDown={(e) => {
                  if (descMatches.length > 0) {
                    if (e.key === "ArrowDown") { e.preventDefault(); setDescMentionIdx((descActive + 1) % descMatches.length); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); setDescMentionIdx((descActive - 1 + descMatches.length) % descMatches.length); return; }
                    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickDescMention(descMatches[descActive].name); return; }
                    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDescMentionQuery(null); return; }
                  }
                  // ⌘/Ctrl+Enter finishes editing
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); refocusDescEdit.current = true; stepOut(); }
                }}
                onBlur={() => {
                  descFocused.current = false;
                  commitDesc();
                  setDescMentionQuery(null);
                  // swap back to the rendered view a beat later, so the click that
                  // blurred us lands where you aimed before the layout shifts
                  window.setTimeout(() => { if (alive.current && !descFocused.current) setDescEditing(false); }, 120);
                }}
                placeholder="Add a description…  **bold**, *italic*, - bullets, [links](url)"
                rows={Math.max(3, Math.min(10, (desc.match(/\n/g)?.length ?? 0) + 2))}
                style={{ width: "100%", resize: "vertical", padding: "10px 12px", borderRadius: 11, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 14, lineHeight: 1.6 }}
              />
              {descMatches.length > 0 && (
                <div className="glass anim-scalein" style={{ position: "absolute", left: 8, bottom: 8, zIndex: 30, minWidth: 220, padding: 5, borderRadius: 11, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", border: "1px solid var(--hairline)" }}>
                  <div role="listbox" id={ids.descMentions} aria-label="Teammates">
                    {descMatches.map((m, i) => (
                      <button key={m.id} type="button" role="option" id={`${ids.descMentions}-${i}`} aria-selected={i === descActive} tabIndex={-1}
                        onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setDescMentionIdx(i)} onClick={() => pickDescMention(m.name)}
                        style={listOption(i === descActive)}>
                        <Avatar id={m.id} size={22} /><span className="truncate">{m.name}</span>
                      </button>
                    ))}
                  </div>
                  <div style={{ padding: "5px 8px 3px", fontSize: 11, lineHeight: 1.4, color: "var(--ink-4)", borderTop: "1px solid var(--hairline)", marginTop: 4 }}>Names here don't notify anyone — @mention them in a comment to ping them.</div>
                </div>
              )}
              </div>
            ) : (
              <div onClick={(e) => { if (readOnly || (e.target as HTMLElement).closest("a")) return; startDescEdit(); }} style={{ padding: "10px 12px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: desc ? "var(--ink-2)" : "var(--ink-4)", fontSize: 14, lineHeight: 1.6, cursor: readOnly ? "default" : "text", minHeight: 24 }}>
                {desc ? renderRich(desc, mentionNames) : readOnly ? "No description." : "Add a description…"}
              </div>
            )}
          </div>

          {/* dependencies (blocked-by, editable) */}
          {(() => {
            const deps = task.dependencies.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t);
            const openBlockers = deps.filter((d) => d.status !== "done").length;
            const canAdd = !!onAddDependency && !readOnly;
            const relNode = (label: string, tone: "accent" | "blocked" | "muted") => (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 8, whiteSpace: "nowrap", fontSize: 12, fontWeight: 500,
                background: tone === "accent" ? "var(--accent-dim)" : tone === "blocked" ? "color-mix(in oklch, var(--st-blocked) 12%, transparent)" : "var(--surface-2)",
                color: tone === "accent" ? "var(--accent)" : tone === "blocked" ? "var(--st-blocked)" : "var(--ink-3)",
                border: `1px solid ${tone === "accent" ? "var(--accent)" : tone === "blocked" ? "color-mix(in oklch, var(--st-blocked) 30%, transparent)" : "var(--hairline)"}` }}>{label}</span>
            );
            if (readOnly && deps.length === 0 && dependents.length === 0) return null;
            return (
              <div style={{ marginBottom: 20 }}>
                {(deps.length > 0 || dependents.length > 0) && (
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 14, padding: "10px 12px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--hairline)", overflowX: "auto" }}>
                    {relNode(deps.length ? `${deps.length} blocker${deps.length === 1 ? "" : "s"}${openBlockers ? "" : " ✓"}` : "Unblocked", openBlockers ? "blocked" : "muted")}
                    <Icon name="arrowRight" size={13} style={{ color: "var(--ink-4)", flexShrink: 0 }} />
                    {relNode("This task", "accent")}
                    <Icon name="arrowRight" size={13} style={{ color: "var(--ink-4)", flexShrink: 0 }} />
                    {relNode(dependents.length ? `blocks ${dependents.length}` : "blocks nothing", "muted")}
                  </div>
                )}
                {(deps.length > 0 || canAdd) && <div className="kicker" style={{ marginBottom: 10 }}>Blocked by</div>}
                {deps.map((b) => (
                  <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 11px", borderRadius: 9, background: b.status !== "done" ? "color-mix(in oklch, var(--st-blocked) 9%, transparent)" : "var(--surface)", border: `1px solid ${b.status !== "done" ? "color-mix(in oklch, var(--st-blocked) 24%, transparent)" : "var(--hairline)"}`, marginBottom: 6 }}>
                    <StatusDot status={b.status} size={8} />
                    {onOpenTask ? (
                      <button type="button" onClick={() => onOpenTask(b.id)} className="truncate" style={{ flex: 1, minWidth: 0, padding: 0, border: "none", background: "transparent", textAlign: "left", fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink-2)", textDecoration: b.status === "done" ? "line-through" : "none", cursor: "pointer" }}>{b.title}</button>
                    ) : (
                      <span className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink-2)", textDecoration: b.status === "done" ? "line-through" : "none" }}>{b.title}</span>
                    )}
                    {b.status !== "done" && <Icon name="lock" size={13} style={{ color: "var(--st-blocked)" }} />}
                    {onRemoveDependency && !readOnly && <button onClick={() => onRemoveDependency(task.id, b.id)} aria-label={`Remove dependency on “${b.title}”`} title="Remove dependency" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>}
                  </div>
                ))}
                {canAdd && (depPickerOpen ? (
                  <div style={{ position: "relative", marginTop: 2 }}>
                    {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                    <input autoFocus value={depQuery}
                      role="combobox" aria-expanded={depCandidates.length > 0} aria-controls={ids.deps} aria-autocomplete="list"
                      aria-activedescendant={depCandidates.length > 0 ? `${ids.deps}-${depActive}` : undefined}
                      aria-label="Search for a task this one is blocked by"
                      onChange={(e) => { setDepQuery(e.target.value); setDepIdx(0); }}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowDown" && depCandidates.length) { e.preventDefault(); setDepIdx((depActive + 1) % depCandidates.length); }
                        else if (e.key === "ArrowUp" && depCandidates.length) { e.preventDefault(); setDepIdx((depActive - 1 + depCandidates.length) % depCandidates.length); }
                        else if (e.key === "Enter") { e.preventDefault(); const c = depCandidates[depActive]; if (c) addDependency(c); }
                        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDepPicker(true); }
                      }}
                      onBlur={(e) => { if (depListRef.current?.contains(e.relatedTarget as Node)) return; closeDepPicker(false); }}
                      placeholder="Search a task to depend on…"
                      style={{ width: "100%", height: 34, padding: "0 11px", borderRadius: 9, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13 }} />
                    {(depCandidates.length > 0 || depQuery.trim()) && (
                      <div ref={depListRef} className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 5, padding: 5, borderRadius: 11, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)", maxHeight: 220, overflowY: "auto" }}>
                        <div role="listbox" id={ids.deps} aria-label="Open tasks in this workspace">
                          {depCandidates.map((c, i) => (
                            <button key={c.id} type="button" role="option" id={`${ids.deps}-${i}`} aria-selected={i === depActive} tabIndex={-1}
                              onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setDepIdx(i)} onClick={() => addDependency(c)}
                              style={{ ...listOption(i === depActive), padding: "8px 9px" }}>
                              <StatusDot status={c.status} size={7} /> <span className="truncate">{c.title}</span>
                            </button>
                          ))}
                        </div>
                        {depCandidates.length === 0 && <div style={{ padding: "7px 9px", fontSize: 12.5, color: "var(--ink-4)" }}>No open tasks in this workspace match “{depQuery.trim()}”.</div>}
                      </div>
                    )}
                  </div>
                ) : (
                  <button ref={depAddRef} onClick={() => { setDepQuery(""); setDepIdx(0); setDepPickerOpen(true); }} style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 4px", border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13 }}>
                    <Icon name="plus" size={14} /> Add dependency
                  </button>
                ))}
                {dependents.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div className="kicker" style={{ marginBottom: 6 }}>Blocks</div>
                    {dependents.map((d) => (
                      <button key={d.id} onClick={() => onOpenTask?.(d.id)} style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", padding: "7px 11px", borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 6, cursor: onOpenTask ? "pointer" : "default", fontFamily: "var(--font-display)" }}>
                        <StatusDot status={d.status} size={8} />
                        <span className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>{d.title}</span>
                        {onOpenTask && <Icon name="arrowUpRight" size={13} style={{ color: "var(--ink-4)" }} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* custom fields */}
          <CustomFieldsSection task={task} fields={customFields} people={assignable} onPatch={onPatch} onCreate={onCreateCustomField} onDelete={readOnly ? undefined : onDeleteCustomField} readOnly={readOnly} projectTaskCount={projectTaskCount} />

          {/* parent breadcrumb (when this task is itself a sub-task) */}
          {parent && (
            <button onClick={() => onOpenTask?.(parent.id)} className="btn-ghost" style={{ display: "inline-flex", alignItems: "center", gap: 7, marginBottom: 14, padding: "5px 10px", borderRadius: 9, fontSize: 12.5, fontFamily: "var(--font-display)", cursor: "pointer" }}>
              <Icon name="arrowLeft" size={13} style={{ color: "var(--ink-4)" }} />
              <span style={{ color: "var(--ink-4)" }}>Sub-task of</span>
              <span className="truncate" style={{ maxWidth: 220, color: "var(--ink-2)", fontWeight: 500 }}>{parent.title}</span>
            </button>
          )}

          {/* sub-tasks (full tasks) */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <span className="kicker">Subtasks</span>
              {children.length + (task.subtasks?.length ?? 0) > 0 && (
                <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-4)" }}>
                  {children.filter((c) => c.status === "done").length + (task.subtasks ?? []).filter((s) => s.done).length}/{children.length + (task.subtasks?.length ?? 0)}
                </span>
              )}
              {!readOnly && (
                <button onClick={aiBreakdown} disabled={aiSubBusy} title="Let Kanbo break this into subtasks" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "transparent", color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12 }}>
                  <Icon name="sparkles" size={13} /> {aiSubBusy ? "Thinking…" : "Suggest"}
                </button>
              )}
            </div>
            {aiSubNote && <div style={{ fontSize: 12, color: "var(--ink-4)", marginBottom: 8 }}>{aiSubNote}</div>}
            {readOnly && children.length + (task.subtasks?.length ?? 0) === 0 && <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No subtasks.</p>}
            {children.map((c) => {
              const cdone = c.status === "done";
              const cds = dueState(c.dueDate, c.status);
              return (
                <div key={c.id} className="lift-row" onClick={() => onOpenTask?.(c.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", margin: "0 -8px", borderRadius: 9, cursor: "pointer" }}>
                  <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>{readOnly ? <StaticCheck done={cdone} size={17} /> : <Check done={cdone} size={17} celebrateKey={c.id} label={c.title} onToggle={() => onToggle(c.id)} />}</span>
                  <span className="truncate" style={{ flex: 1, fontSize: 13.5, color: cdone ? "var(--ink-4)" : "var(--ink-2)", textDecoration: cdone ? "line-through" : "none" }}>{c.title}</span>
                  {c.priority !== "medium" && <PriorityFlag priority={c.priority} size={13} />}
                  {c.dueDate && <span className="mono" style={{ fontSize: 11, color: cds === "overdue" ? "var(--prio-urgent)" : cds === "today" ? "var(--accent)" : "var(--ink-4)" }}>{fmtDue(c.dueDate)}</span>}
                  <Avatar id={c.assigneeId} size={19} />
                  <Icon name="arrowRight" size={14} style={{ color: "var(--ink-4)" }} />
                </div>
              );
            })}
            {/* legacy lightweight checklist items, if any */}
            {task.subtasks?.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0" }}>
                {readOnly ? <StaticCheck done={s.done} size={17} /> : <Check done={s.done} size={17} label={s.title} onToggle={() => onToggleSubtask(task.id, s.id)} />}
                <span style={{ fontSize: 13.5, color: s.done ? "var(--ink-4)" : "var(--ink-2)", textDecoration: s.done ? "line-through" : "none" }}>{s.title}</span>
              </div>
            ))}
            {!readOnly && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                <Icon name="plus" size={16} style={{ color: "var(--ink-4)" }} />
                <input value={newSub} onChange={(e) => setNewSub(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addSub(); }}
                  placeholder="Add a subtask…" aria-label="Add a subtask"
                  style={{ flex: 1, height: 30, border: "none", borderRadius: 6, background: "transparent", fontFamily: "var(--font-display)", fontSize: 13.5, color: "var(--ink)" }} />
                {newSub.trim() && <button onClick={addSub} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>Add</button>}
              </div>
            )}
          </div>

          {/* attachments */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <span className="kicker">Files</span>
              {files.length > 0 && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-4)" }}>{files.length}</span>}
              {!readOnly && (
                <>
                  <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn btn-ghost" style={{ marginLeft: "auto", padding: "5px 10px", fontSize: 12 }}>
                    <Icon name="plus" size={13} /> {uploading ? "Uploading…" : "Attach"}
                  </button>
                  <input ref={fileRef} type="file" multiple onChange={(e) => onPickFiles(e.target.files)} style={{ display: "none" }} />
                </>
              )}
            </div>
            {files.length === 0 && <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No files attached.</p>}
            {(() => {
              const isImg = (a: Attachment) => a.mime?.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(a.name);
              const images = files.filter(isImg);
              const others = files.filter((a) => !isImg(a));
              return (
                <>
                  {images.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, marginBottom: others.length ? 10 : 0 }}>
                      {images.map((a) => (
                        <div key={a.id} style={{ position: "relative", aspectRatio: "1", borderRadius: 10, overflow: "hidden", border: "1px solid var(--hairline)", background: "var(--surface)" }}>
                          <a href={a.url} target="_blank" rel="noreferrer" title={a.name}>
                            <img src={a.url} alt={a.name} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                          </a>
                          {canRemoveFile(a) && <button onClick={() => removeFile(a)} aria-label={`Delete ${a.name}`} title="Delete file" style={{ position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 6, border: "none", background: "color-mix(in oklch, var(--ink) 55%, transparent)", color: "#fff", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="x" size={13} /></button>}
                        </div>
                      ))}
                    </div>
                  )}
                  {others.map((a) => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 6 }}>
                      <Icon name="folder" size={15} style={{ color: "var(--ink-4)", flexShrink: 0 }} />
                      <a href={a.url} target="_blank" rel="noreferrer" className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink-2)", textDecoration: "none" }} title={a.name}>{a.name}</a>
                      <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", flexShrink: 0 }}>{fmtBytes(a.size)}</span>
                      {canRemoveFile(a) && <button onClick={() => removeFile(a)} className="btn-icon" aria-label={`Delete ${a.name}`} title="Delete file" style={{ border: "none", width: 26, height: 26, color: "var(--ink-4)" }}><Icon name="x" size={14} /></button>}
                    </div>
                  ))}
                </>
              );
            })()}
          </div>

          {/* change history */}
          {events.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <button onClick={() => setHistoryOpen((v) => !v)} aria-expanded={historyOpen} style={{ display: "flex", alignItems: "center", gap: 7, border: "none", background: "transparent", padding: 0, cursor: "pointer" }}>
                <Icon name="chevronRight" size={13} style={{ color: "var(--ink-4)", transform: historyOpen ? "rotate(90deg)" : "none", transition: "transform .18s" }} />
                <span className="kicker">History</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{events.length}</span>
              </button>
              <Collapse open={historyOpen}>
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8, paddingLeft: 4 }}>
                  {events.map((e) => (
                    <div key={e.id} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5, color: "var(--ink-3)" }}>
                      <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--hairline-strong)", flexShrink: 0, transform: "translateY(-1px)" }} />
                      <span style={{ flex: 1 }}><strong style={{ color: "var(--ink-2)", fontWeight: 600 }}>{e.actorName}</strong> {describeEvent(e)}</span>
                      <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", flexShrink: 0 }}>{timeAgo(e.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </Collapse>
            </div>
          )}

          {/* comments thread */}
          <div style={{ marginBottom: 20 }}>
            <div className="kicker" style={{ marginBottom: 12 }}>
              Comments{thread.length > 0 && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-4)" }}>{thread.length}</span>}
            </div>
            {thread.length === 0 && <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No comments yet — start the thread below.</p>}
            {orderedComments.map(({ c, depth }) => (
              <div key={c.id} style={{ display: "flex", gap: 10, marginBottom: 12, marginLeft: depth ? 34 : 0, paddingLeft: depth ? 12 : 0, borderLeft: depth ? "2px solid var(--hairline)" : "none" }}>
                <Avatar id={c.authorId} size={depth ? 22 : 26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <strong style={{ fontSize: 13, color: "var(--ink)" }}>{c.authorName || "You"}</strong>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{timeAgo(c.createdAt)}</span>
                  </div>
                  {editingComment === c.id ? (
                    <div style={{ marginTop: 4 }}>
                      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                      <textarea autoFocus ref={editRef} value={editDraft} onChange={(e) => setEditDraft(e.target.value)} aria-label="Edit comment"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveCommentEdit(c);
                          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endCommentEdit(c.id); }
                        }}
                        rows={Math.max(2, Math.min(8, (editDraft.match(/\n/g)?.length ?? 0) + 1))}
                        style={{ width: "100%", resize: "vertical", padding: "8px 10px", borderRadius: 9, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, lineHeight: 1.5 }} />
                      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                        <button className="btn btn-accent" onClick={() => saveCommentEdit(c)} style={{ padding: "4px 12px", fontSize: 12.5 }}>Save</button>
                        <button className="btn btn-ghost" onClick={() => endCommentEdit(c.id)} style={{ padding: "4px 10px", fontSize: 12.5 }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ margin: "3px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "var(--ink-2)", wordBreak: "break-word" }}>{renderRich(c.body, mentionNames)}</div>
                  )}
                  {editingComment !== c.id && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6, position: "relative", flexWrap: "wrap" }}>
                    {Object.entries(c.reactions || {}).map(([emoji, uids]) => (
                      <button key={emoji} onClick={() => toggleReaction(c, emoji)} title={`${uids.length}`} aria-pressed={uids.includes(currentUserId)}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 99, cursor: "pointer", fontSize: 12, fontFamily: "var(--font-display)",
                          border: `1px solid ${uids.includes(currentUserId) ? "var(--accent)" : "var(--hairline)"}`, background: uids.includes(currentUserId) ? "var(--accent-dim)" : "var(--surface)", color: "var(--ink-2)" }}>
                        {emoji} <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{uids.length}</span>
                      </button>
                    ))}
                    <button onClick={() => setReactPickerFor((v) => v === c.id ? null : c.id)} aria-label={c.authorName ? `Add reaction to ${c.authorName}’s comment` : "Add reaction to this comment"} aria-expanded={reactPickerFor === c.id} style={{ width: 24, height: 22, borderRadius: 99, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-4)", cursor: "pointer", fontSize: 12, display: "grid", placeItems: "center" }}>
                      <Icon name="message" size={12} />
                    </button>
                    <button onClick={() => { setReplyingTo(c.parentId ?? c.id); commentRef.current?.focus(); }} title="Reply" aria-label={`Reply to ${c.authorName || "comment"}`}
                      style={{ height: 22, padding: "0 8px", borderRadius: 99, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-4)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-display)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <Icon name="arrowRight" size={11} /> Reply
                    </button>
                    {onConvertComment && !readOnly && c.body.trim() && (
                      <button onClick={() => onConvertComment(c.body.trim(), task.projectId)} title="Turn this comment into a task"
                        style={{ height: 22, padding: "0 8px", borderRadius: 99, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-4)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-display)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <Icon name="plus" size={11} /> Task
                      </button>
                    )}
                    {reactPickerFor === c.id && (
                      <>
                        <div onClick={() => setReactPickerFor(null)} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
                        <div className="anim-scalein" style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 11 }}>
                          <EmojiPicker height={170} onPick={(e) => { toggleReaction(c, e); setReactPickerFor(null); }} />
                        </div>
                      </>
                    )}
                    {c.authorId === currentUserId && (
                      <>
                        <button data-edit-comment={c.id} onClick={() => { setEditDraft(c.body); setEditingComment(c.id); }} title="Edit comment" style={{ height: 22, padding: "0 8px", borderRadius: 99, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-4)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-display)", display: "inline-flex", alignItems: "center", gap: 4 }}>Edit</button>
                        <button onClick={() => removeComment(c)} title="Delete comment" style={{ height: 22, padding: "0 8px", borderRadius: 99, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--prio-urgent)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-display)", display: "inline-flex", alignItems: "center", gap: 4 }}>Delete</button>
                      </>
                    )}
                  </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* activity history */}
          {taskActivity.length > 0 && (
            <>
              <div className="kicker" style={{ marginBottom: 12 }}>Activity</div>
              {taskActivity.map((a) => (
                <div key={a.id} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, marginTop: 6, flexShrink: 0, background: a.kind === "completed" ? "var(--st-done)" : "var(--ink-4)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{activityLine(a, mentionNames)}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 1 }}>{timeAgo(a.createdAt)}</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* comment box */}
        {replyingToComment && (
          <div style={{ padding: "8px 14px 0", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-3)" }}>
            <Icon name="arrowRight" size={13} style={{ color: "var(--accent)" }} />
            <span className="truncate" style={{ flex: 1 }}>Replying to <strong style={{ color: "var(--ink-2)" }}>{replyingToComment.authorName || "comment"}</strong></span>
            <button onClick={() => setReplyingTo(null)} aria-label="Cancel reply" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 15, lineHeight: 1 }}>×</button>
          </div>
        )}
        <div style={{ padding: 14, borderTop: "1px solid var(--hairline)", display: "flex", gap: 10, alignItems: "flex-end" }}>
          <span style={{ display: "inline-flex", paddingBottom: 5 }}><Avatar id={currentUserId} size={28} /></span>
          <div style={{ position: "relative", flex: 1 }}>
            {mentionMatches.length > 0 && (
              <div className="glass anim-scalein" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, padding: 5, borderRadius: 12, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", zIndex: 5 }}>
                <div className="kicker" style={{ padding: "4px 8px 5px" }}>Mention</div>
                <div role="listbox" id={ids.mentions} aria-label="Teammates to mention">
                  {mentionMatches.map((m, i) => (
                    <button key={m.id} type="button" role="option" id={`${ids.mentions}-${i}`} aria-selected={i === mentionActive} tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setMentionIdx(i)} onClick={() => pickMention(m)}
                      style={listOption(i === mentionActive)}>
                      <Avatar id={m.id} size={22} /> {m.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <textarea ref={commentRef} value={comment} onChange={onCommentChange} rows={1} onBlur={() => setMentionQuery(null)}
              aria-label="Add a comment"
              aria-autocomplete="list"
              aria-controls={mentionMatches.length > 0 ? ids.mentions : undefined}
              aria-activedescendant={mentionMatches.length > 0 ? `${ids.mentions}-${mentionActive}` : undefined}
              onKeyDown={(e) => {
                if (mentionMatches.length > 0) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((mentionActive + 1) % mentionMatches.length); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((mentionActive - 1 + mentionMatches.length) % mentionMatches.length); return; }
                  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mentionMatches[mentionActive]); return; }
                }
                if (e.key === "Escape" && mentionQuery !== null) { e.preventDefault(); e.stopPropagation(); setMentionQuery(null); return; }
                // Enter sends; Shift+Enter is a new line (and IME composition is left alone)
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendComment(); }
              }}
              placeholder="Add a comment…  @ to mention" style={{ display: "block", width: "100%", minHeight: 38, maxHeight: 144, padding: "8px 13px", resize: "none", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, lineHeight: 1.45 }} />
          </div>
          <button className="btn-icon" onClick={sendComment} disabled={!comment.trim() || posting} aria-label="Post comment" style={{ flexShrink: 0, marginBottom: 1, background: "var(--accent)", color: "var(--on-accent)", border: "none", opacity: comment.trim() && !posting ? 1 : 0.5 }}><Icon name="arrowUpRight" size={17} /></button>
        </div>
    </div>
  );
}
