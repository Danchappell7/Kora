/* ============================================================
   KANBO — Workload you can act on (0055): the parts Team › Workload
   uses to move work.
   · useWorkloadMoves: give tasks to a person and/or move them into a
     week (lib/rebalance moveIntoWeek), in one save, with a toast and
     Undo. Drops on a person's name keep the dates; drops on one of
     their weeks move the due date there too.
   · WorkloadTask: a task in a person's week, picked up by drag
     (lib/dnd) and, for the keyboard, a "Move" menu with the same
     people and weeks.
   · RebalancePreview: Kanbo's rebalance for the week on show (lib/
     rebalance planRebalance), each move and everyone's hours before
     and after; Apply saves it all, Undo puts it back.
   ============================================================ */
import { useCallback, useRef, useState } from "react";
import { Button, Icon, IconButton, StatusGlyph } from "../primitives";
import { Popover } from "../primitives/Popover";
import type { Task } from "../../data/types";
import type { MoveDeps } from "../../lib/dropMoves";
import { useTaskDragSource } from "../../lib/dnd";
import { moveIntoWeek, rebalancePatches, type RebalancePlan } from "../../lib/rebalance";
import { addDays, fmtDayMonth, round1 } from "../../lib/weekMath";
import "./availability.css";

const quote = (s: string) => `“${s.length > 50 ? s.slice(0, 49) + "…" : s}”`;
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;
const fmtH = (h: number) => `${round1(h)}h`;

export interface WorkloadWeek { start: Date; label: string }

/** Give tasks to `userId` and, with `weekStart`, move them into that week. */
export function useWorkloadMoves({ moveDeps, workspaceId, today, nameOf, workDaysOf, isOff }: {
  moveDeps?: () => MoveDeps;
  workspaceId: string | null | undefined;
  today: Date;
  nameOf: (id: string) => string;
  /** the person's working days (ISO), when shared */
  workDaysOf?: (id: string) => readonly number[] | undefined;
  /** is the person away that day */
  isOff?: (id: string, iso: string) => boolean;
}) {
  return useCallback((taskIds: string[], userId: string, weekStart: Date | null) => {
    if (!moveDeps) return;
    const deps = moveDeps();
    const apply: { id: string; patch: Partial<Task> }[] = [];
    const undo: { id: string; patch: Partial<Task> }[] = [];
    const titles: string[] = [];
    let reassigned = 0, dated: string | undefined;
    for (const id of taskIds) {
      const t = deps.tasks.find((x) => x.id === id);
      // only this business's open work moves (a personal or another team's task never lands here)
      if (!t || t.archivedAt || t.status === "done" || !workspaceId || (t.workspaceId ?? null) !== workspaceId) continue;
      const patch: Partial<Task> = {};
      const was: Partial<Task> = {};
      if (t.assigneeId !== userId) { patch.assigneeId = userId; was.assigneeId = t.assigneeId; reassigned++; }
      if (weekStart) {
        const p = moveIntoWeek(t, weekStart, today, { workDays: workDaysOf?.(userId), isOff: isOff ? (iso) => isOff(userId, iso) : undefined });
        if (p) {
          Object.assign(patch, p);
          was.dueDate = t.dueDate;
          if ("startDate" in p) was.startDate = t.startDate;
          dated = p.dueDate;
        }
      }
      if (!Object.keys(patch).length) continue;
      apply.push({ id, patch });
      undo.push({ id, patch: was });
      titles.push(t.title);
    }
    const who = firstName(nameOf(userId));
    if (!apply.length) { deps.toast(taskIds.length === 1 ? "It's already there" : "They're already there"); return; }
    const what = apply.length === 1 ? quote(titles[0]) : `${apply.length} tasks`;
    const when = dated ? new Date(`${dated}T00:00:00`) : null;
    const due = when ? `due ${when.toLocaleDateString("en-GB", { weekday: "short" })} ${fmtDayMonth(when)}` : "";
    const message = reassigned && due ? `Gave ${what} to ${who}, ${due}` : reassigned ? `Gave ${what} to ${who}` : `Moved ${what}, now ${due}`;
    void deps.updateTasks(apply);
    deps.toast(message, () => { void deps.updateTasks(undo); });
  }, [moveDeps, workspaceId, today, nameOf, workDaysOf, isOff]);
}

/** A task in someone's week: open it, drag it to a person or a week, or move it from the menu. */
export function WorkloadTask({ task, hours, overdue, estimated, label, onOpen, canMove, people, weeks, currentWeek, onMove }: {
  task: Task;
  hours: string;
  overdue: boolean;
  estimated: boolean;
  /** the hours' tooltip */
  label?: string;
  onOpen: (id: string) => void;
  canMove: boolean;
  /** teammates it can go to */
  people: { id: string; name: string }[];
  /** the weeks on show */
  weeks: WorkloadWeek[];
  /** the week it's listed in */
  currentWeek: Date;
  onMove: (taskIds: string[], userId: string, weekStart: Date | null) => void;
}) {
  const drag = useTaskDragSource({ taskIds: [task.id], source: "workload", originId: `workload:${task.id}`, disabled: !canMove, label: task.title });
  const [menu, setMenu] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const due = task.dueDate ? new Date(task.dueDate.slice(0, 10) + "T00:00:00") : null;
  const assignee = task.assigneeId;
  const toPeople = people.filter((p) => p.id !== assignee);
  const toWeeks = weeks.filter((w) => w.start.getTime() !== currentWeek.getTime());
  return (
    <span className="kav-wtask">
      <button type="button" className="kload-task" onClick={() => onOpen(task.id)} aria-label={`Open task ${task.title}`} {...drag.bind}>
        <StatusGlyph status={task.status} size={14} />
        <span className="kload-task-title truncate">{task.title}</span>
        {due && <span className="kload-task-due" data-late={overdue || undefined}>{overdue ? "Overdue · " : "Due "}{fmtDayMonth(due)}</span>}
        <span className="kload-task-hours" title={label}>{!estimated ? "~1h" : hours}</span>
      </button>
      {canMove && (toPeople.length > 0 || toWeeks.length > 0) && (
        <>
          <IconButton ref={btn} icon="arrowRight" size="sm" label={`Move ${task.title}`} onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} />
          <Popover open={menu} anchorRef={btn} onClose={() => setMenu(false)} align="end" label={`Move ${task.title}`} minWidth={220} maxHeight={360}>
            {toPeople.length > 0 && <div className="kmenu-label">Give to</div>}
            {toPeople.map((p) => (
              <button key={p.id} type="button" role="menuitem" className="kmenu-item" onClick={() => { setMenu(false); onMove([task.id], p.id, null); }}>
                <Icon name="user" size={16} sw={1.75} />{p.name}
              </button>
            ))}
            {toPeople.length > 0 && toWeeks.length > 0 && assignee && <hr className="kmenu-sep" />}
            {assignee && toWeeks.length > 0 && <div className="kmenu-label">Move to</div>}
            {assignee && toWeeks.map((w) => (
              <button key={w.start.getTime()} type="button" role="menuitem" className="kmenu-item" onClick={() => { setMenu(false); onMove([task.id], assignee, w.start); }}>
                <Icon name="calendar" size={16} sw={1.75} />{w.label}
              </button>
            ))}
          </Popover>
        </>
      )}
    </span>
  );
}

/** Kanbo's rebalance, before it's applied. */
export function RebalancePreview({ plan, nameOf, capacityOf, weekLabel, onApply, onCancel }: {
  plan: RebalancePlan;
  nameOf: (id: string) => string;
  capacityOf: (id: string) => number;
  weekLabel: string;
  onApply: () => void;
  onCancel: () => void;
}) {
  const people = [...new Set(plan.moves.flatMap((m) => [m.from, m.to]))];
  return (
    <section className="kav-reb" aria-label="Rebalance preview">
      <p className="kav-reb-head"><Icon name="kanbo" size={16} sw={1.75} />Kanbo's rebalance for {weekLabel.toLowerCase()}</p>
      <ul className="kav-reb-moves">
        {plan.moves.map((m) => (
          <li key={m.taskId} className="kav-reb-move">
            <span className="kav-reb-title truncate">{m.title}</span>
            <span className="kav-reb-hours">{fmtH(m.hours)}</span>
            <span className="kav-reb-who">{firstName(nameOf(m.from))} <Icon name="arrowRight" size={12} sw={2} /> {firstName(nameOf(m.to))}</span>
          </li>
        ))}
      </ul>
      <p className="kav-reb-after">
        {people.map((id, i) => (
          <span key={id}>{i > 0 && " · "}{firstName(nameOf(id))} <span className="kav-reb-num">{fmtH(plan.before[id] ?? 0)} → {fmtH(plan.after[id] ?? 0)}</span> of {fmtH(capacityOf(id))}</span>
        ))}
      </p>
      <span className="kav-reb-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" icon="check" onClick={onApply}>Apply rebalance</Button>
      </span>
    </section>
  );
}

/** Apply a plan: one save, a toast with Undo. */
export function applyRebalance(plan: RebalancePlan, deps: MoveDeps): void {
  const { apply, undo } = rebalancePatches(plan);
  if (!apply.length) return;
  void deps.updateTasks(apply);
  deps.toast(apply.length === 1 ? `Rebalanced: moved ${quote(plan.moves[0].title)}` : `Rebalanced: moved ${apply.length} tasks`, () => { void deps.updateTasks(undo); });
}

/** "Week of 16 Nov" */
export const weekOfWords = (start: Date) => `Week of ${fmtDayMonth(start)}`;
export const weekRange = (start: Date) => `${fmtDayMonth(start)} – ${fmtDayMonth(addDays(start, 6))}`;
