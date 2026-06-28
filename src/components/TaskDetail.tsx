/* ============================================================
   KANBO — Task detail slide-over panel (fully editable)
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon, Avatar, Check, StatusDot, PriorityFlag, AiScore, EmojiPicker } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { TagPicker } from "./TagPicker";
import { store } from "../data/store";
import { renderRich } from "../lib/richtext";
import { saveTemplate } from "../lib/templates";
import { reportError } from "../lib/monitoring";
import type { Attachment } from "../data/types";

const REACTION_EMOJIS = ["👍", "❤️", "🎉", "👀", "✅", "🚀"];

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
import {
  getProject, getMember, blockingTasks, dueState, fmtDue, timeAgo, DUE_PRESETS, presetDate,
  STATUS_META, STATUS_ORDER, PRIORITY_META, toLocalISO, nextDueDate,
} from "../data/data";
import type { Task, TagDef, Comment, Activity, WorkspaceMember, Recurrence, Status, Priority, IconName, Project, CustomFieldDef, CustomValue, Section } from "../data/types";

const RECUR_LABEL: Record<Recurrence, string> = { none: "Doesn't repeat", daily: "Daily", weekdays: "Every weekday", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };

function MetaRow({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 32 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, width: 104, flexShrink: 0, fontSize: 12.5, color: "var(--ink-4)" }}>
        <Icon name={icon} size={14} /> {label}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const fieldInputStyle: React.CSSProperties = { height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none", maxWidth: 220 };

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

function CustomFieldsSection({ task, fields, people, onPatch, onCreate, onDelete }: {
  task: Task;
  fields: CustomFieldDef[];
  people: { id: string; name: string }[];
  onPatch: (id: string, patch: Partial<Task>) => void;
  onCreate?: (projectId: string, name: string, type: CustomFieldDef["type"], options: string[]) => void;
  onDelete?: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldDef["type"]>("text");
  const [opts, setOpts] = useState("");
  const values = task.custom ?? {};
  const setValue = (fid: string, v: CustomValue) => onPatch(task.id, { custom: { ...(task.custom ?? {}), [fid]: v } });
  const add = () => {
    const n = name.trim(); if (!n || !onCreate) return;
    onCreate(task.projectId, n, type, (type === "dropdown" || type === "multiselect") ? opts.split(",").map((o) => o.trim()).filter(Boolean) : []);
    setName(""); setOpts(""); setType("text"); setAdding(false);
  };
  if (fields.length === 0 && !onCreate) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span className="kicker">Custom fields</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {fields.map((f) => {
          const v = values[f.id];
          return (
            <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 30 }}>
              <span className="truncate" style={{ width: 104, flexShrink: 0, fontSize: 12.5, color: "var(--ink-4)" }}>{f.name}</span>
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {f.type === "text" && <input value={(v as string) ?? ""} onChange={(e) => setValue(f.id, e.target.value)} style={{ ...fieldInputStyle, maxWidth: 280, width: "100%" }} />}
                {f.type === "number" && <input type="number" value={v == null ? "" : (v as number)} onChange={(e) => setValue(f.id, e.target.value === "" ? null : Number(e.target.value))} style={fieldInputStyle} />}
                {f.type === "currency" && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ color: "var(--ink-4)", fontSize: 13 }}>£</span><input type="number" value={v == null ? "" : (v as number)} onChange={(e) => setValue(f.id, e.target.value === "" ? null : Number(e.target.value))} style={fieldInputStyle} /></span>}
                {f.type === "multiselect" && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {f.options.map((o) => { const arr = Array.isArray(v) ? v as string[] : []; const on = arr.includes(o); return <button key={o} onClick={() => setValue(f.id, on ? arr.filter((x) => x !== o) : [...arr, o])} style={{ padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: 12, border: `1px solid ${on ? "var(--accent)" : "var(--hairline)"}`, background: on ? "var(--accent-dim)" : "transparent", color: on ? "var(--ink)" : "var(--ink-3)", fontFamily: "var(--font-display)" }}>{o}</button>; })}
                  </div>
                )}
                {f.type === "date" && <input type="date" value={(v as string) ?? ""} onChange={(e) => setValue(f.id, e.target.value || null)} style={{ ...fieldInputStyle, fontFamily: "var(--font-mono)", fontSize: 12.5 }} />}
                {f.type === "checkbox" && <Check done={!!v} size={18} onToggle={() => setValue(f.id, !v)} />}
                {f.type === "dropdown" && (
                  <select value={(v as string) ?? ""} onChange={(e) => setValue(f.id, e.target.value || null)} style={fieldInputStyle}>
                    <option value="">—</option>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                )}
                {f.type === "people" && (
                  <select value={(v as string) ?? ""} onChange={(e) => setValue(f.id, e.target.value || null)} style={fieldInputStyle}>
                    <option value="">—</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
                {onDelete && <button onClick={() => onDelete(f.id)} title="Remove field" aria-label="Remove field" style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 14 }}>×</button>}
              </div>
            </div>
          );
        })}
      </div>
      {onCreate && (adding ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder="Field name" style={{ ...fieldInputStyle, maxWidth: 150 }} />
          <select value={type} onChange={(e) => setType(e.target.value as CustomFieldDef["type"])} style={fieldInputStyle}>
            <option value="text">Text</option><option value="number">Number</option><option value="currency">Currency (£)</option><option value="dropdown">Dropdown</option><option value="multiselect">Multi-select</option><option value="date">Date</option><option value="people">People</option><option value="checkbox">Checkbox</option>
          </select>
          {(type === "dropdown" || type === "multiselect") && <input value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="Option A, Option B" style={{ ...fieldInputStyle, maxWidth: 180 }} />}
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-display)" }}>
          <Icon name="plus" size={15} /> Add custom field
        </button>
      ))}
    </div>
  );
}

export function TaskDetail({ taskId, tasks, tags, activity, members, currentUserId, onClose, onToggle, onPatch, onDelete, onDuplicate, onArchive, onUnarchive, onAddDependency, onRemoveDependency, onToggleSubtask, onAddSubtask, onCreateTag, onDeleteTag, onAddComment, onFocus, onOpenTask, projects = [], onToggleFollow, onToggleTaskReaction, onToggleCollaborator, customFields = [], onCreateCustomField, onDeleteCustomField, sections = [], onCreateSection, onConvertComment }: {
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
  onAddComment: (taskId: string, body: string, mentions?: string[]) => Promise<Comment | null>;
  onConvertComment?: (body: string, projectId: string) => void;
  onFocus: (id: string) => void;
}) {
  const task = tasks.find((t) => t.id === taskId);
  const [newSub, setNewSub] = useState("");
  const [aiSubBusy, setAiSubBusy] = useState(false);
  const [aiSubNote, setAiSubNote] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [descMentionQuery, setDescMentionQuery] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tmplSaved, setTmplSaved] = useState(false);
  const [reactPickerFor, setReactPickerFor] = useState<string | null>(null);
  const [depPickerOpen, setDepPickerOpen] = useState(false);
  const [depQuery, setDepQuery] = useState("");
  const [reactsOpen, setReactsOpen] = useState(false);
  const [reactMoreOpen, setReactMoreOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const commentRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const [thread, setThread] = useState<Comment[]>([]);
  const [viewers, setViewers] = useState<{ id: string; name: string }[]>([]);
  const [posting, setPosting] = useState(false);
  const [desc, setDesc] = useState("");
  const [descEditing, setDescEditing] = useState(false);
  const [titleBuf, setTitleBuf] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const isMobile = useMediaQuery("(max-width: 860px)");

  // load the comment thread + description buffer when a task is opened
  useEffect(() => {
    let cancelled = false;
    setThread([]);
    const cur = tasks.find((t) => t.id === taskId);
    setDesc(cur?.description ?? "");
    setTitleBuf(cur?.title ?? "");
    setFiles([]);
    store.listComments(taskId).then((cs) => { if (!cancelled) setThread(cs); }).catch(reportError);
    store.listAttachments(taskId).then((fs) => { if (!cancelled) setFiles(fs); }).catch(reportError);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // if the open task disappears (deleted here or by a realtime sync), close the
  // panel cleanly instead of leaving a blank ghost overlay mounted
  useEffect(() => {
    if (!tasks.find((t) => t.id === taskId)) onClose();
  }, [tasks, taskId, onClose]);

  // live presence — who else is viewing this task right now
  useEffect(() => {
    const meName = members.find((m) => m.userId === currentUserId)?.name || "Someone";
    const unsub = store.subscribeToTaskPresence(taskId, { id: currentUserId, name: meName }, (people) => {
      setViewers(people.filter((p) => p.id !== currentUserId));
    });
    return () => { setViewers([]); unsub(); };
  }, [taskId, currentUserId, members]);

  // auto-grow the title textarea to fit long titles instead of clipping them
  useEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
  }, [titleBuf]);

  if (!task) return null;
  const proj = getProject(task.projectId);
  const dependents = tasks.filter((t) => t.dependencies?.includes(task.id));
  const children = tasks.filter((t) => t.parentId === task.id);
  const parent = task.parentId ? tasks.find((t) => t.id === task.parentId) : undefined;
  const following = (task.followers ?? []).includes(currentUserId);
  const taskReactions = task.reactions ?? {};
  const done = task.status === "done";
  const taskActivity = activity.filter((a) => a.taskId === task.id).slice(0, 8);
  // Only people who belong to THIS task's workspace can be assigned/collaborate.
  // A personal-project task (no workspace) is therefore just you — never members
  // pulled in from your other team workspaces.
  const taskWs = task.workspaceId ?? null;
  const activeMembers = members.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === taskWs);
  const assignable = activeMembers.length > 0
    ? activeMembers.map((m) => ({ id: m.userId!, name: m.name || m.email }))
    : [{ id: currentUserId, name: getMember(currentUserId)?.name || "You" }];

  const toggleTag = (id: string) => {
    const next = task.tags.includes(id) ? task.tags.filter((x) => x !== id) : [...task.tags, id];
    onPatch(task.id, { tags: next });
  };
  const addSub = () => { const v = newSub.trim(); if (v) { onAddSubtask(task.id, v); setNewSub(""); } };
  const aiBreakdown = async () => {
    if (!task) return;
    setAiSubBusy(true);
    const subs = await store.aiBreakdown(task.title, desc);
    setAiSubBusy(false);
    if (subs.length) subs.forEach((s) => onAddSubtask(task.id, s));
    else { setAiSubNote("AI couldn't suggest subtasks — add them manually."); window.setTimeout(() => setAiSubNote(null), 3000); }
  };

  // @mention autocomplete — suggest teammates as you type "@…", and on send
  // resolve "@Name" tokens to user ids so the trigger can notify them.
  const mentionable = assignable.filter((m) => m.id !== currentUserId);
  const mentionMatches = mentionQuery !== null
    ? mentionable.filter((m) => m.name.toLowerCase().includes(mentionQuery)).slice(0, 6)
    : [];
  const onCommentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setComment(val);
    const caret = e.target.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/(?:^|\s)@([\w'’.-]*)$/);
    setMentionQuery(m ? m[1].toLowerCase() : null);
  };
  const pickMention = (name: string) => {
    const el = commentRef.current;
    const caret = el?.selectionStart ?? comment.length;
    const before = comment.slice(0, caret).replace(/(^|\s)@[\w'’.-]*$/, `$1@${name} `);
    const next = before + comment.slice(caret);
    setComment(next);
    setMentionQuery(null);
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(before.length, before.length); } });
  };
  // @mention autocomplete for the description editor (mirrors the comment one)
  const descMatches = descMentionQuery !== null
    ? mentionable.filter((m) => m.name.toLowerCase().includes(descMentionQuery)).slice(0, 6)
    : [];
  const onDescChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setDesc(val);
    const caret = e.target.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/(?:^|\s)@([\w'’.-]*)$/);
    setDescMentionQuery(m ? m[1].toLowerCase() : null);
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
    const lower = v.toLowerCase();
    const mentions = [...new Set(mentionable.filter((m) => lower.includes("@" + m.name.toLowerCase())).map((m) => m.id))];
    setPosting(true);
    const c = await onAddComment(task.id, v, mentions);
    setPosting(false);
    if (c) { setThread((t) => [...t, c]); setComment(""); setMentionQuery(null); }
  };
  const toggleReaction = (c: Comment, emoji: string) => {
    const reactions: Record<string, string[]> = { ...(c.reactions || {}) };
    const list = reactions[emoji] || [];
    reactions[emoji] = list.includes(currentUserId) ? list.filter((x) => x !== currentUserId) : [...list, currentUserId];
    if (reactions[emoji].length === 0) delete reactions[emoji];
    setThread((t) => t.map((x) => x.id === c.id ? { ...x, reactions } : x));
    store.toggleReaction(c.id, emoji, currentUserId).catch(reportError);
  };
  const del = () => { onClose(); onDelete(task.id); };
  const onPickFiles = async (list: FileList | File[] | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    for (const f of Array.from(list)) {
      if (f.size > 25 * 1024 * 1024) { window.alert(`"${f.name}" is over 25 MB.`); continue; }
      try { const a = await store.uploadAttachment(task.id, f, currentUserId); setFiles((xs) => [...xs, a]); }
      catch (e) { reportError(e, { op: "uploadAttachment" }); window.alert("Couldn't upload " + f.name); }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };
  const removeFile = async (a: Attachment) => {
    setFiles((xs) => xs.filter((x) => x.id !== a.id));
    try { await store.deleteAttachment(a); } catch (e) { reportError(e, { op: "deleteAttachment" }); }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90, background: "color-mix(in oklch, var(--bg-deep) 50%, transparent)", backdropFilter: "blur(3px)" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label={`Task: ${task.title}`} onClick={(e) => e.stopPropagation()} style={{
        position: "absolute", top: 0, right: 0, bottom: 0, width: isMobile ? "100%" : 480, maxWidth: "100%",
        background: "var(--surface-raised)", borderLeft: isMobile ? "none" : "1px solid var(--hairline-strong)",
        boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column",
        animation: `${isMobile ? "slideInUp" : "slideInRight"} .3s var(--ease)`,
      }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <button className="btn-icon" onClick={onClose} style={{ border: "none" }}><Icon name="x" size={18} /></button>
          <div style={{ flex: 1 }} />
          {viewers.length > 0 && (
            <span title={`Also viewing: ${viewers.map((v) => v.name).join(", ")}`} style={{ display: "inline-flex", alignItems: "center", marginRight: 4 }}>
              {viewers.slice(0, 3).map((v, i) => <span key={v.id} style={{ marginLeft: i ? -7 : 0, borderRadius: 99, boxShadow: "0 0 0 2px var(--surface-raised), 0 0 0 3px var(--accent)" }}><Avatar id={v.id} size={24} /></span>)}
              {viewers.length > 3 && <span style={{ marginLeft: 4, fontSize: 11.5, color: "var(--ink-4)" }}>+{viewers.length - 3}</span>}
            </span>
          )}
          {proj && <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--ink-3)" }}><span style={{ width: 8, height: 8, borderRadius: 2, background: proj.color }} />{proj.name}</span>}
          {onToggleFollow && <button className="btn-icon" onClick={() => onToggleFollow(task.id)} title={following ? "Following — click to unfollow" : "Follow for updates"} aria-pressed={following} style={{ border: "none", color: following ? "var(--accent)" : "var(--ink-3)" }}><Icon name="bell" size={16} /></button>}
          <button className="btn-icon" onClick={() => { try { navigator.clipboard?.writeText(`${location.origin}/?task=${task.id}`); } catch { /* ignore */ } setCopied(true); setTimeout(() => setCopied(false), 1500); }} title="Copy link to task" style={{ border: "none", color: copied ? "var(--accent)" : "var(--ink-3)" }}><Icon name={copied ? "check" : "link"} size={16} /></button>
          {onDuplicate && <button className="btn-icon" onClick={() => { onDuplicate(task.id); onClose(); }} title="Duplicate task" style={{ border: "none", color: "var(--ink-3)" }}><Icon name="layers" size={16} /></button>}
          <button className="btn-icon" onClick={() => { saveTemplate({ name: task.title, title: task.title, priority: task.priority, tags: task.tags, focusMin: task.focusMin, recurrence: task.recurrence ?? "none", description: desc }); setTmplSaved(true); setTimeout(() => setTmplSaved(false), 1500); }} title="Save as template" style={{ border: "none", color: tmplSaved ? "var(--accent)" : "var(--ink-3)" }}><Icon name={tmplSaved ? "check" : "briefcase"} size={16} /></button>
          {task.archivedAt
            ? (onUnarchive && <button className="btn-icon" onClick={() => { onUnarchive(task.id); onClose(); }} title="Unarchive task" style={{ border: "none", color: "var(--accent)" }}><Icon name="refresh" size={16} /></button>)
            : (onArchive && <button className="btn-icon" onClick={() => { onArchive(task.id); onClose(); }} title="Archive task" style={{ border: "none", color: "var(--ink-3)" }}><Icon name="archive" size={16} /></button>)}
          <button className="btn-icon" onClick={del} title="Delete task" style={{ border: "none", color: "var(--ink-3)" }}><Icon name="trash" size={17} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px", position: "relative", outline: dragOver ? "2px dashed var(--accent)" : "none", outlineOffset: "-8px" }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
          onDrop={(e) => { if (e.dataTransfer.files?.length) { e.preventDefault(); setDragOver(false); onPickFiles(e.dataTransfer.files); } }}>
          {/* title — editable */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ marginTop: 3 }}><Check done={done} size={22} onToggle={() => onToggle(task.id)} /></div>
            <textarea
              ref={titleRef}
              value={titleBuf}
              onChange={(e) => setTitleBuf(e.target.value)}
              onBlur={() => { const v = titleBuf.trim(); if (v && v !== task.title) onPatch(task.id, { title: v }); else setTitleBuf(task.title); }}
              rows={1}
              style={{ flex: 1, resize: "none", border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-display)", fontSize: 21, fontWeight: 600, lineHeight: 1.25, letterSpacing: "-0.02em", color: done ? "var(--ink-3)" : "var(--ink)", textDecoration: done ? "line-through" : "none", overflow: "hidden" }}
            />
          </div>

          {/* task reactions — tucked behind a button so the panel opens on fields */}
          {onToggleTaskReaction && (() => {
            const totalReacts = Object.values(taskReactions).reduce((n, u) => n + (u?.length ?? 0), 0);
            return (
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
                        <button key={emoji} onClick={() => onToggleTaskReaction(task.id, emoji)} title={uids.length ? `${uids.length} reacted` : "React"}
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, cursor: "pointer", fontSize: 13,
                            border: `1px solid ${mine ? "var(--accent)" : "var(--hairline)"}`, background: mine ? "var(--accent-dim)" : "transparent", opacity: uids.length || mine ? 1 : 0.55 }}>
                          {emoji}{uids.length > 0 && <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{uids.length}</span>}
                        </button>
                      );
                    })}
                    <button onClick={() => setReactMoreOpen((v) => !v)} title="More reactions" style={{ padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: 13, border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-3)" }}>＋</button>
                    {reactMoreOpen && (
                      <>
                        <div onClick={() => setReactMoreOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 41 }}><EmojiPicker height={180} onPick={(e) => { onToggleTaskReaction(task.id, e); setReactMoreOpen(false); }} /></div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

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
            <MetaRow icon="circle" label="Status">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <StatusDot status={task.status} size={8} />
                <select value={task.status} onChange={(e) => { const s = e.target.value as Status; onPatch(task.id, { status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined }); }}
                  style={{ height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" }}>
                  {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                </select>
              </span>
            </MetaRow>
            <MetaRow icon="flag" label="Priority">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Icon name="flag" size={13} fill={task.priority === "urgent" || task.priority === "high" ? PRIORITY_META[task.priority].color : "none"} style={{ color: PRIORITY_META[task.priority].color }} />
                <select value={task.priority} onChange={(e) => onPatch(task.id, { priority: e.target.value as Priority })}
                  style={{ height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" }}>
                  {(Object.keys(PRIORITY_META) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
                </select>
              </span>
            </MetaRow>
            <MetaRow icon="grid" label="Project">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {proj && <span style={{ width: 9, height: 9, borderRadius: 3, background: proj.color, flexShrink: 0 }} />}
                <select value={task.projectId} onChange={(e) => onPatch(task.id, { projectId: e.target.value })}
                  style={{ height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none", maxWidth: 220 }}>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  {!projects.some((p) => p.id === task.projectId) && <option value={task.projectId}>{proj?.name || "Project"}</option>}
                </select>
              </span>
            </MetaRow>
            {(sections.length > 0 || onCreateSection) && (
              <MetaRow icon="layers" label="Section">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <select value={task.sectionId ?? ""} onChange={(e) => onPatch(task.id, { sectionId: e.target.value || undefined })} style={fieldInputStyle}>
                    <option value="">No section</option>
                    {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    {task.sectionId && !sections.some((s) => s.id === task.sectionId) && <option value={task.sectionId}>(section)</option>}
                  </select>
                  {onCreateSection && <button onClick={() => { const n = window.prompt("New section name"); if (n?.trim()) onCreateSection(task.projectId, n.trim()); }} className="btn-icon" title="New section" aria-label="New section" style={{ border: "none", color: "var(--ink-4)", width: 28, height: 28 }}><Icon name="plus" size={15} /></button>}
                </span>
              </MetaRow>
            )}
            <MetaRow icon="user" label="Assignee">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Avatar id={task.assigneeId} size={22} />
                <select value={task.assigneeId} onChange={(e) => onPatch(task.id, { assigneeId: e.target.value })}
                  style={{ height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" }}>
                  {assignable.map((p) => <option key={p.id} value={p.id}>{p.id === currentUserId ? `${p.name} (you)` : p.name}</option>)}
                  {!assignable.some((p) => p.id === task.assigneeId) && <option value={task.assigneeId}>{getMember(task.assigneeId)?.name || "Unassigned"}</option>}
                </select>
              </span>
            </MetaRow>
            {onToggleCollaborator && assignable.length > 1 && (() => {
              const chosen = (task.collaborators ?? []).filter((id) => id !== task.assigneeId);
              const addable = assignable.filter((p) => p.id !== task.assigneeId && !chosen.includes(p.id));
              return (
                <MetaRow icon="users" label="Collaborators">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {chosen.map((id) => {
                      const name = assignable.find((p) => p.id === id)?.name || getMember(id)?.name || "Member";
                      return (
                        <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 4px 3px 4px", borderRadius: 999, fontSize: 12.5, border: "1px solid var(--accent)", background: "var(--accent-dim)", color: "var(--ink)" }}>
                          <Avatar id={id} size={18} /> {name}
                          <button onClick={() => onToggleCollaborator(task.id, id)} aria-label={`Remove ${name}`}
                            style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-4)", fontSize: 15, lineHeight: 1, padding: "0 2px" }}>×</button>
                        </span>
                      );
                    })}
                    {addable.length > 0 && (
                      <select value="" onChange={(e) => { if (e.target.value) onToggleCollaborator(task.id, e.target.value); }}
                        aria-label="Add collaborator"
                        style={{ height: 28, padding: "0 8px", borderRadius: 999, border: "1px dashed var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none", cursor: "pointer" }}>
                        <option value="">+ Add collaborator</option>
                        {addable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                    {chosen.length === 0 && addable.length === 0 && <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>No one else in this workspace</span>}
                  </div>
                </MetaRow>
              );
            })()}
            <MetaRow icon="calendar" label="Due">
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <input type="date" value={task.dueDate || ""} onChange={(e) => onPatch(task.id, { dueDate: e.target.value || undefined })}
                  style={{ height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: dueState(task.dueDate, task.status) === "overdue" ? "var(--prio-urgent)" : "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5, outline: "none" }} />
                <input type="time" value={task.dueTime || ""} onChange={(e) => onPatch(task.id, { dueTime: e.target.value || undefined })} title="Due time"
                  style={{ height: 30, padding: "0 7px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5, outline: "none" }} />
                {DUE_PRESETS.map((p) => (
                  <button key={p.kind} onClick={() => onPatch(task.id, { dueDate: presetDate(p.kind) })} style={{ padding: "4px 9px", borderRadius: 7, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", cursor: "pointer", fontSize: 11.5, fontFamily: "var(--font-display)" }}>{p.label}</button>
                ))}
                {task.dueDate && <button onClick={() => onPatch(task.id, { dueDate: undefined })} title="Clear due date" style={{ padding: "4px 7px", borderRadius: 7, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 13 }}>×</button>}
              </div>
            </MetaRow>
            <button onClick={() => setMoreOpen((v) => !v)}
              style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6, padding: "4px 2px", border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, color: "var(--ink-3)" }}>
              <Icon name={moreOpen ? "chevronDown" : "chevronRight"} size={14} /> {moreOpen ? "Fewer options" : "More options"}
            </button>
            {moreOpen && (<>
            <MetaRow icon="refresh" label="Repeat">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <select value={task.recurrence || "none"} onChange={(e) => onPatch(task.id, { recurrence: e.target.value as Recurrence })}
                  style={{ height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" }}>
                  {(Object.keys(RECUR_LABEL) as Recurrence[]).map((r) => <option key={r} value={r}>{RECUR_LABEL[r]}</option>)}
                </select>
                {task.recurrence && task.recurrence !== "none" && task.dueDate && (
                  <button onClick={() => onPatch(task.id, { dueDate: nextDueDate(task.dueDate, task.recurrence!) })} title="Move this task to its next occurrence without completing it"
                    style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", cursor: "pointer", fontSize: 12, fontFamily: "var(--font-display)" }}>Skip →</button>
                )}
              </span>
            </MetaRow>
            <MetaRow icon="clock" label="Estimate">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <input type="number" min={0} step={0.5} value={task.effortHours ?? ""} onChange={(e) => onPatch(task.id, { effortHours: e.target.value === "" ? undefined : Number(e.target.value) })}
                  style={{ width: 80, height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5, outline: "none" }} />
                <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>hours</span>
              </span>
            </MetaRow>
            <MetaRow icon="clock" label="Logged">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <input type="number" min={0} step={0.5} value={task.loggedHours ?? ""} onChange={(e) => onPatch(task.id, { loggedHours: e.target.value === "" ? undefined : Number(e.target.value) })}
                  style={{ width: 80, height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5, outline: "none" }} />
                <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>hours</span>
                {[0.5, 1].map((h) => <button key={h} onClick={() => onPatch(task.id, { loggedHours: Math.round(((task.loggedHours ?? 0) + h) * 2) / 2 })} title={`Log ${h}h`} style={{ padding: "3px 8px", borderRadius: 7, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-3)", cursor: "pointer", fontSize: 11.5, fontFamily: "var(--font-display)" }}>+{h}h</button>)}
                {task.effortHours != null && task.loggedHours != null && task.loggedHours > task.effortHours && <span style={{ fontSize: 11, color: "var(--prio-urgent)" }}>over estimate</span>}
              </span>
            </MetaRow>
            <MetaRow icon="grid" label="Tags">
              <TagPicker tags={tags} selected={task.tags} onToggle={toggleTag} onCreate={onCreateTag} onDelete={onDeleteTag} small />
            </MetaRow>
            <MetaRow icon="target" label="Milestone">
              <button onClick={() => onPatch(task.id, { isMilestone: !task.isMilestone })} style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink-2)", padding: 0 }}>
                <span style={{ width: 16, height: 16, borderRadius: 5, border: `1.5px solid ${task.isMilestone ? "var(--st-review)" : "var(--hairline-strong)"}`, background: task.isMilestone ? "var(--st-review)" : "transparent", display: "grid", placeItems: "center" }}>{task.isMilestone && <Icon name="check" size={11} sw={3} style={{ color: "var(--bg-deep)" }} />}</span>
                Mark as milestone
              </button>
            </MetaRow>
            </>)}
          </div>

          {/* description — markdown, click to edit */}
          <div style={{ marginBottom: 20 }}>
            <div className="kicker" style={{ marginBottom: 8 }}>Description</div>
            {descEditing ? (
              <div style={{ position: "relative" }}>
              <MdToolbar getEl={() => descRef.current} value={desc} setValue={setDesc} />
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <textarea autoFocus ref={descRef}
                value={desc}
                onChange={onDescChange}
                onKeyDown={(e) => {
                  if (descMatches.length > 0 && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); pickDescMention(descMatches[0].name); }
                  else if (e.key === "Escape" && descMentionQuery !== null) { e.preventDefault(); setDescMentionQuery(null); }
                }}
                onBlur={() => { setTimeout(() => { setDescEditing(false); setDescMentionQuery(null); if (desc !== task.description) onPatch(task.id, { description: desc }); }, 120); }}
                placeholder="Add a description…  @ to mention, **bold**, *italic*, - bullets, [links](url)"
                rows={Math.max(3, Math.min(10, (desc.match(/\n/g)?.length ?? 0) + 2))}
                style={{ width: "100%", resize: "vertical", padding: "10px 12px", borderRadius: 11, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 14, lineHeight: 1.6, outline: "none" }}
              />
              {descMatches.length > 0 && (
                <div className="glass anim-scalein" style={{ position: "absolute", left: 8, bottom: 8, zIndex: 30, minWidth: 200, padding: 5, borderRadius: 11, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", border: "1px solid var(--hairline)" }}>
                  {descMatches.map((m) => (
                    <button key={m.id} onMouseDown={(e) => { e.preventDefault(); pickDescMention(m.name); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 8px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink-2)" }}>
                      <Avatar id={m.id} size={22} /><span className="truncate">{m.name}</span>
                    </button>
                  ))}
                </div>
              )}
              </div>
            ) : (
              <div onClick={() => setDescEditing(true)} style={{ padding: "10px 12px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: desc ? "var(--ink-2)" : "var(--ink-4)", fontSize: 14, lineHeight: 1.6, cursor: "text", minHeight: 24 }}>
                {desc ? renderRich(desc) : "Add a description…"}
              </div>
            )}
          </div>

          {/* dependencies (blocked-by, editable) */}
          {(() => {
            const deps = task.dependencies.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t);
            const candidates = tasks.filter((t) => t.id !== task.id && !task.dependencies.includes(t.id) && (!depQuery.trim() || t.title.toLowerCase().includes(depQuery.trim().toLowerCase()))).slice(0, 6);
            return (
              <div style={{ marginBottom: 20 }}>
                <div className="kicker" style={{ marginBottom: 10 }}>Blocked by</div>
                {deps.map((b) => (
                  <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 11px", borderRadius: 9, background: b.status !== "done" ? "color-mix(in oklch, var(--st-blocked) 9%, transparent)" : "var(--surface)", border: `1px solid ${b.status !== "done" ? "color-mix(in oklch, var(--st-blocked) 24%, transparent)" : "var(--hairline)"}`, marginBottom: 6 }}>
                    <StatusDot status={b.status} size={8} />
                    <span className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink-2)", textDecoration: b.status === "done" ? "line-through" : "none" }}>{b.title}</span>
                    {b.status !== "done" && <Icon name="lock" size={13} style={{ color: "var(--st-blocked)" }} />}
                    {onRemoveDependency && <button onClick={() => onRemoveDependency(task.id, b.id)} aria-label="Remove dependency" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>}
                  </div>
                ))}
                {onAddDependency && (depPickerOpen ? (
                  <div style={{ position: "relative", marginTop: 2 }}>
                    {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                    <input autoFocus value={depQuery} onChange={(e) => setDepQuery(e.target.value)} onBlur={() => setTimeout(() => setDepPickerOpen(false), 150)} placeholder="Search a task to depend on…"
                      style={{ width: "100%", height: 34, padding: "0 11px", borderRadius: 9, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" }} />
                    {candidates.length > 0 && (
                      <div className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 5, padding: 5, borderRadius: 11, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)", maxHeight: 220, overflowY: "auto" }}>
                        {candidates.map((c) => (
                          <button key={c.id} onMouseDown={(e) => { e.preventDefault(); onAddDependency(task.id, c.id); setDepQuery(""); setDepPickerOpen(false); }}
                            style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "8px 9px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink-2)" }}>
                            <StatusDot status={c.status} size={7} /> <span className="truncate">{c.title}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <button onClick={() => { setDepQuery(""); setDepPickerOpen(true); }} style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 4px", border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13 }}>
                    <Icon name="plus" size={14} /> Add dependency
                  </button>
                ))}
                {dependents.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div className="kicker" style={{ marginBottom: 6 }}>Blocks</div>
                    {dependents.map((d) => (
                      <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 11px", borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 6 }}>
                        <Icon name="arrowUpRight" size={13} style={{ color: "var(--ink-4)" }} />
                        <span className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>{d.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* custom fields */}
          <CustomFieldsSection task={task} fields={customFields} people={assignable} onPatch={onPatch} onCreate={onCreateCustomField} onDelete={onDeleteCustomField} />

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
              <button onClick={aiBreakdown} disabled={aiSubBusy} title="Let Kanbo break this into subtasks" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "transparent", color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12 }}>
                <Icon name="sparkles" size={13} /> {aiSubBusy ? "Thinking…" : "Suggest"}
              </button>
            </div>
            {aiSubNote && <div style={{ fontSize: 12, color: "var(--ink-4)", marginBottom: 8 }}>{aiSubNote}</div>}
            {children.map((c) => {
              const cdone = c.status === "done";
              const cds = dueState(c.dueDate, c.status);
              return (
                <div key={c.id} className="lift-row" onClick={() => onOpenTask?.(c.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", margin: "0 -8px", borderRadius: 9, cursor: "pointer" }}>
                  <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}><Check done={cdone} size={17} onToggle={() => onToggle(c.id)} /></span>
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
                <Check done={s.done} size={17} onToggle={() => onToggleSubtask(task.id, s.id)} />
                <span style={{ fontSize: 13.5, color: s.done ? "var(--ink-4)" : "var(--ink-2)", textDecoration: s.done ? "line-through" : "none" }}>{s.title}</span>
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
              <Icon name="plus" size={16} style={{ color: "var(--ink-4)" }} />
              <input value={newSub} onChange={(e) => setNewSub(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addSub(); }}
                placeholder="Add a subtask…"
                style={{ flex: 1, height: 30, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-display)", fontSize: 13.5, color: "var(--ink)" }} />
              {newSub.trim() && <button onClick={addSub} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>Add</button>}
            </div>
          </div>

          {/* attachments */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <span className="kicker">Files</span>
              {files.length > 0 && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-4)" }}>{files.length}</span>}
              <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn btn-ghost" style={{ marginLeft: "auto", padding: "5px 10px", fontSize: 12 }}>
                <Icon name="plus" size={13} /> {uploading ? "Uploading…" : "Attach"}
              </button>
              <input ref={fileRef} type="file" multiple onChange={(e) => onPickFiles(e.target.files)} style={{ display: "none" }} />
            </div>
            {files.length === 0 && <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No files attached.</p>}
            {files.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 6 }}>
                <Icon name="folder" size={15} style={{ color: "var(--ink-4)", flexShrink: 0 }} />
                <a href={a.url} target="_blank" rel="noreferrer" className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink-2)", textDecoration: "none" }} title={a.name}>{a.name}</a>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", flexShrink: 0 }}>{fmtBytes(a.size)}</span>
                <button onClick={() => removeFile(a)} className="btn-icon" aria-label={`Remove ${a.name}`} style={{ border: "none", width: 26, height: 26, color: "var(--ink-4)" }}><Icon name="x" size={14} /></button>
              </div>
            ))}
          </div>

          {/* comments thread */}
          <div style={{ marginBottom: 20 }}>
            <div className="kicker" style={{ marginBottom: 12 }}>
              Comments{thread.length > 0 && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-4)" }}>{thread.length}</span>}
            </div>
            {thread.length === 0 && <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No comments yet — start the thread below.</p>}
            {thread.map((c) => (
              <div key={c.id} style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <Avatar id={c.authorId} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <strong style={{ fontSize: 13, color: "var(--ink)" }}>{c.authorName || "You"}</strong>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{timeAgo(c.createdAt)}</span>
                  </div>
                  <div style={{ margin: "3px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "var(--ink-2)", wordBreak: "break-word" }}>{renderRich(c.body, mentionable.map((m) => m.name))}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6, position: "relative", flexWrap: "wrap" }}>
                    {Object.entries(c.reactions || {}).map(([emoji, uids]) => (
                      <button key={emoji} onClick={() => toggleReaction(c, emoji)} title={`${uids.length}`}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 99, cursor: "pointer", fontSize: 12, fontFamily: "var(--font-display)",
                          border: `1px solid ${uids.includes(currentUserId) ? "var(--accent)" : "var(--hairline)"}`, background: uids.includes(currentUserId) ? "var(--accent-dim)" : "var(--surface)", color: "var(--ink-2)" }}>
                        {emoji} <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{uids.length}</span>
                      </button>
                    ))}
                    <button onClick={() => setReactPickerFor((v) => v === c.id ? null : c.id)} aria-label="Add reaction" style={{ width: 24, height: 22, borderRadius: 99, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-4)", cursor: "pointer", fontSize: 12, display: "grid", placeItems: "center" }}>
                      <Icon name="message" size={12} />
                    </button>
                    {onConvertComment && c.body.trim() && (
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
                  </div>
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
                    <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{a.detail}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 1 }}>{timeAgo(a.createdAt)}</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* comment box */}
        <div style={{ padding: 14, borderTop: "1px solid var(--hairline)", display: "flex", gap: 10, alignItems: "center" }}>
          <Avatar id={currentUserId} size={28} />
          <div style={{ position: "relative", flex: 1 }}>
            {mentionMatches.length > 0 && (
              <div className="glass anim-scalein" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, padding: 5, borderRadius: 12, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", zIndex: 5 }}>
                <div className="kicker" style={{ padding: "4px 8px 5px" }}>Mention</div>
                {mentionMatches.map((m) => (
                  <button key={m.id} onMouseDown={(e) => { e.preventDefault(); pickMention(m.name); }}
                    style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13, textAlign: "left", color: "var(--ink-2)" }}>
                    <Avatar id={m.id} size={22} /> {m.name}
                  </button>
                ))}
              </div>
            )}
            <input ref={commentRef} value={comment} onChange={onCommentChange}
              onKeyDown={(e) => {
                if (mentionMatches.length > 0 && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); pickMention(mentionMatches[0].name); }
                else if (e.key === "Escape" && mentionQuery !== null) { e.preventDefault(); setMentionQuery(null); }
                else if (e.key === "Enter") sendComment();
              }}
              placeholder="Add a comment…  @ to mention" aria-label="Add a comment" style={{ width: "100%", height: 38, padding: "0 13px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none" }} />
          </div>
          <button className="btn-icon" onClick={sendComment} disabled={!comment.trim() || posting} aria-label="Post comment" style={{ background: "var(--accent)", color: "var(--on-accent)", border: "none", opacity: comment.trim() && !posting ? 1 : 0.5 }}><Icon name="arrowUpRight" size={17} /></button>
        </div>
      </div>
    </div>
  );
}
