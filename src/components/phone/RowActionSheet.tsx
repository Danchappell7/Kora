/* ============================================================
   KANBO — a task row's quick actions (phones: a long press).       [u7]
   What the row's own controls do, at thumb size, plus what a row
   can't show: status, due, priority as chips; then Assign…, Move to…
   (each opens its own list inside the sheet, Back returns), Add to
   Today, Select and Delete. Every change says what it did, with an
   Undo (ListView makes the toasts; Delete is App's, through the bin).
   Read-only people never get here (ListView doesn't offer it).
   Lives in the Sheet ListView renders; the pages keep focus: opening a
   list lands on its Back button, Back lands on the row that opened it.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Icon, Avatar, StatusGlyph, PriorityGlyph, ProjectTile } from "../primitives";
import { getProject, fmtDue, toLocalISO, presetDate, KANBO_TODAY, STATUS_META, STATUS_ORDER, PRIORITY_META } from "../../data/data";
import type { Task, Priority, Project } from "../../data/types";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Thu 1" under a date choice */
export function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return `${WD[d.getDay()]} ${d.getDate()}`;
}

/** The quick due dates a row offers (swipe tray and sheet): Today, Tomorrow, Next week. */
export function quickDueChoices(): { key: "today" | "tomorrow" | "nextweek"; label: string; iso: string }[] {
  return [
    { key: "today", label: "Today", iso: toLocalISO(KANBO_TODAY) },
    { key: "tomorrow", label: "Tomorrow", iso: presetDate("tomorrow") },
    { key: "nextweek", label: "Next week", iso: presetDate("nextweek") },
  ];
}

export interface RowActionSheetProps {
  task: Task;
  canSelect: boolean;
  /** people a task here can be assigned to (none: no Assign row) */
  members: { id: string; name: string }[];
  /** projects it can move to (fewer than two: no Move row) */
  projects: Pick<Project, "id" | "name" | "color" | "emoji">[];
  onOpen: (id: string) => void;
  onStatus: (t: Task, s: Task["status"]) => void;
  onDue: (t: Task, iso: string | undefined) => void;
  onPickDue: (id: string) => void;
  onPriority: (t: Task, p: Priority) => void;
  onToday: (t: Task) => void;
  onSelect: (id: string) => void;
  onAssign?: (t: Task, memberId: string) => void;
  onMove?: (t: Task, projectId: string) => void;
  onDelete?: (t: Task) => void;
}

type Page = "main" | "assign" | "move";

export function RowActionSheet({ task, canSelect, members, projects, onOpen, onStatus, onDue, onPickDue, onPriority, onToday, onSelect, onAssign, onMove, onDelete }: RowActionSheetProps) {
  const [page, setPage] = useState<Page>("main");
  const back = useRef<HTMLButtonElement>(null);
  const assignRow = useRef<HTMLButtonElement>(null);
  const moveRow = useRef<HTMLButtonElement>(null);
  const cameFrom = useRef<Page>("main");
  // a list opens on its Back button; Back returns to the row that opened it
  useEffect(() => {
    if (page !== "main") back.current?.focus({ preventScroll: true });
    else if (cameFrom.current === "assign") assignRow.current?.focus({ preventScroll: true });
    else if (cameFrom.current === "move") moveRow.current?.focus({ preventScroll: true });
  }, [page]);
  const go = (p: Page) => { cameFrom.current = page; setPage(p); };

  const proj = getProject(task.projectId) ?? projects.find((p) => p.id === task.projectId);
  const assignee = members.find((m) => m.id === task.assigneeId);
  const quick = quickDueChoices();
  const canAssign = !!onAssign && members.length > 0;
  const canMove = !!onMove && projects.some((p) => p.id !== task.projectId);

  if (page === "assign" && canAssign) {
    return (
      <div className="ktv-acts kph-page" role="group" aria-label={`Assign “${task.title}”`}>
        <PageHead backRef={back} title="Assign to" onBack={() => go("main")} />
        <div className="kph-list">
          {members.map((m) => {
            const on = m.id === task.assigneeId;
            return (
              <button key={m.id} type="button" className="ktv-act" aria-pressed={on} onClick={() => onAssign!(task, m.id)}>
                <Avatar id={m.id} size={24} /><span className="kph-grow">{m.name}</span>
                {on && <Icon name="check" size={16} sw={2.2} className="kph-tick" />}
              </button>
            );
          })}
          {task.assigneeId && (
            <button type="button" className="ktv-act" onClick={() => onAssign!(task, "")}>
              <span className="kph-none" aria-hidden="true"><Icon name="user" size={14} /></span><span className="kph-grow">Unassigned</span>
            </button>
          )}
        </div>
      </div>
    );
  }
  if (page === "move" && canMove) {
    return (
      <div className="ktv-acts kph-page" role="group" aria-label={`Move “${task.title}” to a project`}>
        <PageHead backRef={back} title="Move to project" onBack={() => go("main")} />
        <div className="kph-list">
          {projects.map((p) => {
            const on = p.id === task.projectId;
            return (
              <button key={p.id} type="button" className="ktv-act" aria-pressed={on} onClick={() => onMove!(task, p.id)}>
                <ProjectTile project={p} size={20} /><span className="kph-grow">{p.name}</span>
                {on && <Icon name="check" size={16} sw={2.2} className="kph-tick" />}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="ktv-acts">
      <p className="ktv-acts-meta">
        <StatusGlyph status={task.status} size={14} readOnly /><span>{STATUS_META[task.status].label}</span>
        {proj && <><span aria-hidden="true">·</span><ProjectTile project={proj} size={16} /><span className="truncate">{proj.name}</span></>}
        {task.dueDate && <><span aria-hidden="true">·</span><span className="ktv-mono">{fmtDue(task.dueDate)}</span></>}
      </p>
      <button type="button" className="ktv-act" onClick={() => onOpen(task.id)}>
        <Icon name="arrowUpRight" size={18} sw={1.75} /><span>Open task</span>
      </button>
      <div className="ktv-acts-sec" role="group" aria-label="Status">
        <h3>Status</h3>
        <div className="ktv-chips">
          {STATUS_ORDER.map((s) => (
            <button key={s} type="button" className="ktv-chip" aria-pressed={task.status === s} onClick={() => onStatus(task, s)}>
              <StatusGlyph status={s} size={14} readOnly /><span>{STATUS_META[s].label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="ktv-acts-sec" role="group" aria-label="Due date">
        <h3>Due</h3>
        <div className="ktv-chips">
          {quick.map((d) => (
            <button key={d.key} type="button" className="ktv-chip" aria-pressed={task.dueDate === d.iso} onClick={() => onDue(task, d.iso)}>
              <span>{d.label}</span><span className="ktv-mono" aria-hidden="true">{shortDay(d.iso)}</span>
            </button>
          ))}
          <button type="button" className="ktv-chip" onClick={() => onPickDue(task.id)}><Icon name="calendar" size={14} sw={1.75} /><span>Pick a date…</span></button>
          {task.dueDate && <button type="button" className="ktv-chip" onClick={() => onDue(task, undefined)}><span>No date</span></button>}
        </div>
      </div>
      <div className="ktv-acts-sec" role="group" aria-label="Priority">
        <h3>Priority</h3>
        <div className="ktv-chips">
          {(["urgent", "high", "medium", "low"] as const).map((p) => (
            <button key={p} type="button" className="ktv-chip" aria-pressed={task.priority === p} onClick={() => onPriority(task, p)}>
              <PriorityGlyph priority={p} /><span>{PRIORITY_META[p].label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="ktv-acts-list">
        {canAssign && (
          <button ref={assignRow} type="button" className="ktv-act" onClick={() => go("assign")}
            aria-label={assignee ? `Assign: ${assignee.name}. Change` : "Assign: unassigned. Choose someone"}>
            <Icon name="user" size={18} sw={1.75} /><span>Assign</span>
            <small className="kph-value">{assignee ? assignee.name : "Unassigned"}</small>
            <Icon name="chevronRight" size={16} sw={1.75} className="kph-chev" />
          </button>
        )}
        {canMove && (
          <button ref={moveRow} type="button" className="ktv-act" onClick={() => go("move")}
            aria-label={proj ? `Move to project: in ${proj.name}. Change` : "Move to project"}>
            <Icon name="folder" size={18} sw={1.75} /><span>Move to project</span>
            {proj && <small className="kph-value">{proj.name}</small>}
            <Icon name="chevronRight" size={16} sw={1.75} className="kph-chev" />
          </button>
        )}
        <button type="button" className="ktv-act" onClick={() => onToday(task)}>
          <Icon name="sun" size={18} sw={1.75} /><span>{task.planToday ? "Take off Today" : "Add to Today"}</span>
        </button>
        {canSelect && (
          <button type="button" className="ktv-act" onClick={() => onSelect(task.id)}>
            <Icon name="check" size={18} sw={1.75} /><span>Select</span><small>to change several at once</small>
          </button>
        )}
        {onDelete && (
          <button type="button" className="ktv-act" data-tone="danger" onClick={() => onDelete(task)}>
            <Icon name="trash" size={18} sw={1.75} /><span>Delete task</span><small>you can undo it</small>
          </button>
        )}
      </div>
    </div>
  );
}

function PageHead({ title, onBack, backRef }: { title: string; onBack: () => void; backRef: React.RefObject<HTMLButtonElement> }) {
  return (
    <div className="kph-head">
      <button ref={backRef} type="button" className="kph-back" onClick={onBack} aria-label="Back to all actions">
        <Icon name="chevronLeft" size={16} sw={2} /><span aria-hidden="true">Back</span>
      </button>
      <h3>{title}</h3>
    </div>
  );
}
