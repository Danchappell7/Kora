/* ============================================================
   KORA — List view (the showpiece) + TaskRow
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar, Check, StatusDot, Tag, PriorityFlag, AiScore } from "../primitives";
import {
  getProject, blockingTasks, dueState, fmtDue,
  STATUS_META, STATUS_ORDER, PRIORITY_META, PROJECTS,
} from "../../data/data";
import type { Task, Subtask, IconName } from "../../data/types";
import type { GroupBy } from "../../app-types";

export function SubtaskProgress({ subtasks }: { subtasks?: Subtask[] }) {
  if (!subtasks?.length) return null;
  const done = subtasks.filter((s) => s.done).length;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>
      <Icon name="layers" size={12} /> {done}/{subtasks.length}
    </span>
  );
}

function TaskRow({ task, allTasks, onOpen, onToggle, onToggleSubtask, smart, depth = 0 }: {
  task: Task; allTasks: Task[]; onOpen: (id: string) => void; onToggle: (id: string) => void; onToggleSubtask: (taskId: string, subId: string) => void; smart: boolean; depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const proj = getProject(task.projectId);
  const blocked = blockingTasks(task, allTasks);
  const done = task.status === "done";
  const ds = dueState(task.dueDate, task.status);
  const dueColor = ds === "overdue" ? "var(--prio-urgent)" : ds === "today" ? "var(--accent)" : "var(--ink-3)";
  const hasSubs = (task.subtasks?.length ?? 0) > 0;

  return (
    <div style={{ borderBottom: "1px solid var(--hairline)" }}>
      <div onClick={() => onOpen(task.id)} className="task-row lift-row" style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 18px 10px " + (18 + depth * 22) + "px",
        cursor: "pointer", position: "relative",
        opacity: done ? 0.55 : 1,
      }}>
        {/* priority accent bar */}
        <span style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderRadius: 99,
          background: PRIORITY_META[task.priority].color,
          opacity: task.priority === "urgent" || task.priority === "high" ? 0.9 : 0.3 }} />

        <Check done={done} onToggle={() => onToggle(task.id)} />

        {hasSubs ? (
          <button onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }} className="btn-icon" style={{ width: 20, height: 20, border: "none", background: "transparent", color: "var(--ink-4)" }}>
            <Icon name="chevronRight" size={14} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .18s" }} />
          </button>
        ) : <StatusDot status={task.status} />}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span className="truncate" style={{ fontSize: 14.5, fontWeight: 450, color: done ? "var(--ink-4)" : "var(--ink)", textDecoration: done ? "line-through" : "none" }}>{task.title}</span>
            {blocked.length > 0 && (
              <span data-tip={"Blocked by " + blocked.map((b) => b.title).join(", ")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--st-blocked)", flexShrink: 0, position: "relative" }}>
                <Icon name="lock" size={12} />
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            {(task.tags || []).slice(0, 2).map((tg) => <Tag key={tg} id={tg} small />)}
            <SubtaskProgress subtasks={task.subtasks} />
            {task.comments > 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}><Icon name="message" size={12} /> {task.comments}</span>}
          </div>
        </div>

        {/* right meta */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
          {smart && task.status !== "done" && <AiScore score={task.aiScore} reason={task.aiReason} />}
          {proj && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-3)" }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: proj.color }} />
              <span className="truncate" style={{ maxWidth: 110 }}>{proj.name}</span>
            </span>
          )}
          <PriorityFlag priority={task.priority} size={14} />
          {task.dueDate && (
            <span className="mono tnum" style={{ fontSize: 12, color: dueColor, minWidth: 56, textAlign: "right", fontWeight: ds === "overdue" || ds === "today" ? 600 : 400 }}>
              {fmtDue(task.dueDate)}
            </span>
          )}
          <Avatar id={task.assigneeId} size={24} />
        </div>
      </div>

      {/* subtasks */}
      {expanded && hasSubs && (
        <div className="anim-fadein" style={{ background: "color-mix(in oklch, var(--bg-deep) 30%, transparent)" }}>
          {task.subtasks.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 18px 8px " + (52 + depth * 22) + "px", borderTop: "1px solid var(--hairline)" }}>
              <Check done={s.done} size={16} onToggle={() => onToggleSubtask(task.id, s.id)} />
              <span style={{ fontSize: 13.5, color: s.done ? "var(--ink-4)" : "var(--ink-2)", textDecoration: s.done ? "line-through" : "none", flex: 1 }}>{s.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupHeader({ label, color, count, icon }: { label: string; color: string; count: number; icon?: IconName }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px 9px", position: "sticky", top: 0, zIndex: 2, background: "color-mix(in oklch, var(--bg) 86%, transparent)", backdropFilter: "blur(8px)" }}>
      {icon ? <Icon name={icon} size={14} style={{ color }} /> : <span style={{ width: 9, height: 9, borderRadius: 99, background: color, boxShadow: `0 0 8px color-mix(in oklch, ${color} 70%, transparent)` }} />}
      <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em" }}>{label}</span>
      <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{count}</span>
    </div>
  );
}

interface Group { key: string; label: string; color: string; icon?: IconName; items: Task[]; }

export function ListView({ tasks, allTasks, onOpen, onToggle, onToggleSubtask, groupBy, smart }: {
  tasks: Task[]; allTasks: Task[]; onOpen: (id: string) => void; onToggle: (id: string) => void; onToggleSubtask: (taskId: string, subId: string) => void; groupBy: GroupBy; smart: boolean;
}) {
  const sortFn = (a: Task, b: Task) => {
    if (smart) return b.aiScore - a.aiScore;
    if (a.status === "done" && b.status !== "done") return 1;
    if (b.status === "done" && a.status !== "done") return -1;
    return PRIORITY_META[b.priority].rank - PRIORITY_META[a.priority].rank;
  };

  let groups: Group[] = [];
  if (groupBy === "status") {
    groups = STATUS_ORDER.map((s) => ({ key: s, label: STATUS_META[s].label, color: STATUS_META[s].color, items: tasks.filter((t) => t.status === s).sort(sortFn) })).filter((g) => g.items.length);
  } else if (groupBy === "priority") {
    groups = (["urgent", "high", "medium", "low"] as const).map((p) => ({ key: p, label: PRIORITY_META[p].label + " priority", color: PRIORITY_META[p].color, icon: "flag" as IconName, items: tasks.filter((t) => t.priority === p).sort(sortFn) })).filter((g) => g.items.length);
  } else if (groupBy === "project") {
    groups = PROJECTS.map((p) => ({ key: p.id, label: p.name, color: p.color, items: tasks.filter((t) => t.projectId === p.id).sort(sortFn) })).filter((g) => g.items.length);
  } else {
    groups = [{ key: "all", label: smart ? "Smart order" : "All tasks", color: "var(--accent)", icon: (smart ? "sparkles" : "list") as IconName, items: [...tasks].sort(sortFn) }];
  }

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      {smart && (
        <div className="anim-fadein" style={{ margin: "16px 18px 0", display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", borderRadius: 12, background: "var(--accent-dim)", border: "1px solid color-mix(in oklch, var(--accent) 28%, transparent)" }}>
          <Icon name="sparkles" size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Sorted by Kora's recommended focus order — urgent, unblocking work first.</span>
        </div>
      )}
      {tasks.length === 0 ? (
        <div style={{ textAlign: "center", padding: "80px 24px", color: "var(--ink-4)" }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="tasks" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>No tasks yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 0" }}>Capture one from <strong style={{ color: "var(--ink-3)" }}>Plan my day</strong> or hit <strong style={{ color: "var(--ink-3)" }}>New task</strong> up top.</p>
        </div>
      ) : groups.map((g) => (
        <div key={g.key}>
          <GroupHeader label={g.label} color={g.color} count={g.items.length} icon={g.icon} />
          <div>{g.items.map((t) => <TaskRow key={t.id} task={t} allTasks={allTasks} onOpen={onOpen} onToggle={onToggle} onToggleSubtask={onToggleSubtask} smart={smart} />)}</div>
        </div>
      ))}
      <div style={{ height: 40 }} />
    </div>
  );
}
