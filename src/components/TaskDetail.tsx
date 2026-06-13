/* ============================================================
   KORA — Task detail slide-over panel (fully editable)
   ============================================================ */
import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { Icon, Avatar, Check, StatusDot, PriorityFlag, AiScore } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { TagPicker } from "./TagPicker";
import { store } from "../data/store";
import { reportError } from "../lib/monitoring";
import {
  getProject, getMember, blockingTasks, dueState, timeAgo,
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

export function TaskDetail({ taskId, tasks, tags, activity, members, currentUserId, onClose, onToggle, onPatch, onDelete, onToggleSubtask, onAddSubtask, onCreateTag, onDeleteTag, onAddComment, onFocus }: {
  taskId: string;
  tasks: Task[];
  tags: Record<string, TagDef>;
  activity: Activity[];
  members: WorkspaceMember[];
  currentUserId: string;
  onClose: () => void;
  onToggle: (id: string) => void;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onToggleSubtask: (taskId: string, subId: string) => void;
  onAddSubtask: (taskId: string, title: string) => void;
  onCreateTag: (label: string, color: string) => void;
  onDeleteTag: (id: string) => void;
  onAddComment: (taskId: string, body: string) => Promise<Comment | null>;
  onFocus: (id: string) => void;
}) {
  const task = tasks.find((t) => t.id === taskId);
  const [newSub, setNewSub] = useState("");
  const [comment, setComment] = useState("");
  const [thread, setThread] = useState<Comment[]>([]);
  const [posting, setPosting] = useState(false);
  const [desc, setDesc] = useState("");
  const [titleBuf, setTitleBuf] = useState("");
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);

  // load the comment thread + description buffer when a task is opened
  useEffect(() => {
    let cancelled = false;
    setThread([]);
    const cur = tasks.find((t) => t.id === taskId);
    setDesc(cur?.description ?? "");
    setTitleBuf(cur?.title ?? "");
    store.listComments(taskId).then((cs) => { if (!cancelled) setThread(cs); }).catch(reportError);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  if (!task) return null;
  const proj = getProject(task.projectId);
  const blocked = blockingTasks(task, tasks);
  const dependents = tasks.filter((t) => t.dependencies?.includes(task.id));
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
  const sendComment = async () => {
    const v = comment.trim();
    if (!v || posting) return;
    setPosting(true);
    const c = await onAddComment(task.id, v);
    setPosting(false);
    if (c) { setThread((t) => [...t, c]); setComment(""); }
  };
  const del = () => { if (window.confirm(`Delete "${task.title}"? This can't be undone.`)) { onDelete(task.id); onClose(); } };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90, background: "color-mix(in oklch, var(--bg-deep) 50%, transparent)", backdropFilter: "blur(3px)" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label={`Task: ${task.title}`} onClick={(e) => e.stopPropagation()} style={{
        position: "absolute", top: 0, right: 0, bottom: 0, width: 480, maxWidth: "94vw",
        background: "var(--surface-raised)", borderLeft: "1px solid var(--hairline-strong)",
        boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", animation: "slideInRight .34s var(--ease)",
      }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <button className="btn-icon" onClick={onClose} style={{ border: "none" }}><Icon name="x" size={18} /></button>
          <div style={{ flex: 1 }} />
          {proj && <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--ink-3)" }}><span style={{ width: 8, height: 8, borderRadius: 2, background: proj.color }} />{proj.name}</span>}
          <button className="btn-icon" onClick={del} title="Delete task" style={{ border: "none", color: "var(--ink-3)" }}><Icon name="trash" size={17} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>
          {/* title — editable */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ marginTop: 3 }}><Check done={done} size={22} onToggle={() => onToggle(task.id)} /></div>
            <textarea
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
                <span className="kicker" style={{ color: "var(--accent)" }}>Kora suggests</span>
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
            <MetaRow icon="calendar" label="Due">
              <input type="date" value={task.dueDate || ""} onChange={(e) => onPatch(task.id, { dueDate: e.target.value || undefined })}
                style={{ height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: dueState(task.dueDate, task.status) === "overdue" ? "var(--prio-urgent)" : "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12.5, outline: "none" }} />
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
          </div>

          {/* description — editable */}
          <div style={{ marginBottom: 20 }}>
            <div className="kicker" style={{ marginBottom: 8 }}>Description</div>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onBlur={() => { if (desc !== task.description) onPatch(task.id, { description: desc }); }}
              placeholder="Add a description…"
              rows={Math.max(2, Math.min(8, (desc.match(/\n/g)?.length ?? 0) + 2))}
              style={{ width: "100%", resize: "vertical", padding: "10px 12px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 14, lineHeight: 1.6, outline: "none" }}
            />
          </div>

          {/* dependencies */}
          {(blocked.length > 0 || dependents.length > 0) && (
            <div style={{ marginBottom: 20 }}>
              <div className="kicker" style={{ marginBottom: 10 }}>Dependencies</div>
              {blocked.map((b) => (
                <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderRadius: 9, background: "color-mix(in oklch, var(--st-blocked) 9%, transparent)", border: "1px solid color-mix(in oklch, var(--st-blocked) 24%, transparent)", marginBottom: 6 }}>
                  <Icon name="lock" size={14} style={{ color: "var(--st-blocked)" }} />
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Blocked by</span>
                  <span style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>{b.title}</span>
                  <StatusDot status={b.status} size={7} />
                </div>
              ))}
              {dependents.map((d) => (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 6 }}>
                  <Icon name="arrowUpRight" size={14} style={{ color: "var(--ink-4)" }} />
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Blocks</span>
                  <span style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>{d.title}</span>
                </div>
              ))}
            </div>
          )}

          {/* subtasks */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <span className="kicker">Subtasks</span>
              {task.subtasks?.length > 0 && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-4)" }}>{task.subtasks.filter((s) => s.done).length}/{task.subtasks.length}</span>}
            </div>
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
                  <p style={{ margin: "3px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "var(--ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{c.body}</p>
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
          <input value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendComment(); }}
            placeholder="Add a comment…" aria-label="Add a comment" style={{ flex: 1, height: 38, padding: "0 13px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none" }} />
          <button className="btn-icon" onClick={sendComment} disabled={!comment.trim() || posting} aria-label="Post comment" style={{ background: "var(--accent)", color: "var(--on-accent)", border: "none", opacity: comment.trim() && !posting ? 1 : 0.5 }}><Icon name="arrowUpRight" size={17} /></button>
        </div>
      </div>
    </div>
  );
}
