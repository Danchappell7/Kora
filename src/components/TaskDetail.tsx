/* ============================================================
   KANBO — Task detail slide-over panel (fully editable)
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon, Avatar, Check, StatusDot, PriorityFlag, AiScore } from "./primitives";
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
  STATUS_META, STATUS_ORDER, PRIORITY_META, toLocalISO,
} from "../data/data";
import type { Task, TagDef, Comment, Activity, WorkspaceMember, Recurrence, Status, Priority, IconName } from "../data/types";

const RECUR_LABEL: Record<Recurrence, string> = { none: "Doesn't repeat", daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

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

export function TaskDetail({ taskId, tasks, tags, activity, members, currentUserId, onClose, onToggle, onPatch, onDelete, onDuplicate, onArchive, onUnarchive, onAddDependency, onRemoveDependency, onToggleSubtask, onAddSubtask, onCreateTag, onDeleteTag, onAddComment, onFocus, onOpenTask }: {
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
  onCreateTag: (label: string, color: string) => void;
  onDeleteTag: (id: string) => void;
  onAddComment: (taskId: string, body: string, mentions?: string[]) => Promise<Comment | null>;
  onFocus: (id: string) => void;
}) {
  const task = tasks.find((t) => t.id === taskId);
  const [newSub, setNewSub] = useState("");
  const [comment, setComment] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tmplSaved, setTmplSaved] = useState(false);
  const [reactPickerFor, setReactPickerFor] = useState<string | null>(null);
  const [depPickerOpen, setDepPickerOpen] = useState(false);
  const [depQuery, setDepQuery] = useState("");
  const commentRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [thread, setThread] = useState<Comment[]>([]);
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
  const done = task.status === "done";
  const taskActivity = activity.filter((a) => a.taskId === task.id).slice(0, 8);
  const activeMembers = members.filter((m) => m.status === "active" && m.userId);
  const assignable = activeMembers.length > 0
    ? activeMembers.map((m) => ({ id: m.userId!, name: m.name || m.email }))
    : [{ id: currentUserId, name: getMember(currentUserId)?.name || "You" }];

  const toggleTag = (id: string) => {
    const next = task.tags.includes(id) ? task.tags.filter((x) => x !== id) : [...task.tags, id];
    onPatch(task.id, { tags: next });
  };
  const addSub = () => { const v = newSub.trim(); if (v) { onAddSubtask(task.id, v); setNewSub(""); } };

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
  const onPickFiles = async (list: FileList | null) => {
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
          {proj && <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--ink-3)" }}><span style={{ width: 8, height: 8, borderRadius: 2, background: proj.color }} />{proj.name}</span>}
          <button className="btn-icon" onClick={() => { try { navigator.clipboard?.writeText(`${location.origin}/?task=${task.id}`); } catch { /* ignore */ } setCopied(true); setTimeout(() => setCopied(false), 1500); }} title="Copy link to task" style={{ border: "none", color: copied ? "var(--accent)" : "var(--ink-3)" }}><Icon name={copied ? "check" : "link"} size={16} /></button>
          {onDuplicate && <button className="btn-icon" onClick={() => { onDuplicate(task.id); onClose(); }} title="Duplicate task" style={{ border: "none", color: "var(--ink-3)" }}><Icon name="layers" size={16} /></button>}
          <button className="btn-icon" onClick={() => { saveTemplate({ name: task.title, title: task.title, priority: task.priority, tags: task.tags, focusMin: task.focusMin, recurrence: task.recurrence ?? "none", description: desc }); setTmplSaved(true); setTimeout(() => setTmplSaved(false), 1500); }} title="Save as template" style={{ border: "none", color: tmplSaved ? "var(--accent)" : "var(--ink-3)" }}><Icon name={tmplSaved ? "check" : "briefcase"} size={16} /></button>
          {task.archivedAt
            ? (onUnarchive && <button className="btn-icon" onClick={() => { onUnarchive(task.id); onClose(); }} title="Unarchive task" style={{ border: "none", color: "var(--accent)" }}><Icon name="refresh" size={16} /></button>)
            : (onArchive && <button className="btn-icon" onClick={() => { onArchive(task.id); onClose(); }} title="Archive task" style={{ border: "none", color: "var(--ink-3)" }}><Icon name="archive" size={16} /></button>)}
          <button className="btn-icon" onClick={del} title="Delete task" style={{ border: "none", color: "var(--ink-3)" }}><Icon name="trash" size={17} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>
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
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {STATUS_ORDER.map((s) => (
                  <button key={s} onClick={() => onPatch(task.id, { status: s, completedAt: s === "done" ? toLocalISO(new Date()) : undefined })} style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px", borderRadius: 7, cursor: "pointer", fontSize: 12,
                    border: `1px solid ${task.status === s ? "var(--hairline-strong)" : "transparent"}`,
                    background: task.status === s ? "var(--surface-2)" : "transparent", color: task.status === s ? "var(--ink)" : "var(--ink-4)",
                  }}><StatusDot status={s} size={7} />{STATUS_META[s].label}</button>
                ))}
              </div>
            </MetaRow>
            <MetaRow icon="flag" label="Priority">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(Object.keys(PRIORITY_META) as Priority[]).map((p) => (
                  <button key={p} onClick={() => onPatch(task.id, { priority: p })} style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px", borderRadius: 7, cursor: "pointer", fontSize: 12,
                    border: `1px solid ${task.priority === p ? "var(--hairline-strong)" : "transparent"}`,
                    background: task.priority === p ? "var(--surface-2)" : "transparent", color: task.priority === p ? "var(--ink)" : "var(--ink-4)",
                  }}><Icon name="flag" size={12} fill={p === "urgent" || p === "high" ? PRIORITY_META[p].color : "none"} style={{ color: PRIORITY_META[p].color }} />{PRIORITY_META[p].label}</button>
                ))}
              </div>
            </MetaRow>
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
            <MetaRow icon="calendar" label="Start">
              <input type="date" value={task.startDate || ""} max={task.dueDate || undefined} onChange={(e) => onPatch(task.id, { startDate: e.target.value || undefined })}
                style={{ height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5, outline: "none" }} />
            </MetaRow>
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
            <MetaRow icon="refresh" label="Repeat">
              <select value={task.recurrence || "none"} onChange={(e) => onPatch(task.id, { recurrence: e.target.value as Recurrence })}
                style={{ height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" }}>
                {(Object.keys(RECUR_LABEL) as Recurrence[]).map((r) => <option key={r} value={r}>{RECUR_LABEL[r]}</option>)}
              </select>
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
          </div>

          {/* description — markdown, click to edit */}
          <div style={{ marginBottom: 20 }}>
            <div className="kicker" style={{ marginBottom: 8 }}>Description</div>
            {descEditing ? (
              // eslint-disable-next-line jsx-a11y/no-autofocus
              <textarea autoFocus
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onBlur={() => { setDescEditing(false); if (desc !== task.description) onPatch(task.id, { description: desc }); }}
                placeholder="Add a description…  **bold**, *italic*, - bullets, [links](url)"
                rows={Math.max(3, Math.min(10, (desc.match(/\n/g)?.length ?? 0) + 2))}
                style={{ width: "100%", resize: "vertical", padding: "10px 12px", borderRadius: 11, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 14, lineHeight: 1.6, outline: "none" }}
              />
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
            </div>
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
                    {reactPickerFor === c.id && (
                      <>
                        <div onClick={() => setReactPickerFor(null)} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
                        <div className="anim-scalein" style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 11, display: "flex", gap: 3, padding: 5, borderRadius: 11, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
                          {REACTION_EMOJIS.map((e) => (
                            <button key={e} onClick={() => { toggleReaction(c, e); setReactPickerFor(null); }} style={{ width: 30, height: 30, borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", fontSize: 17 }}>{e}</button>
                          ))}
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
