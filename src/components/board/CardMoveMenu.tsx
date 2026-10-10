/* ============================================================
   KANBO — a board card's "Move to…" menu: the keyboard and screen-
   reader way to do what dragging the card does (and the tap way on a
   phone). Another column of this board; on or off Today; and every
   other place on screen that takes tasks right now (the sidebar's
   projects, the Team place's people, My week's days), from the drag
   kit's registry (lib/dnd useDropTargets) — choosing one runs that
   place's own drop handler (dropOnTarget), so its result and toast
   are the same as a drag's.
   ============================================================ */
import type { ReactNode } from "react";
import { Icon } from "../primitives";
import { MenuItem } from "./AnchoredPopover";
import { dropOnTarget, useDropTargets, type DropTargetKind, type DropTargetRef } from "../../lib/dnd";
import type { IconName, Task } from "../../data/types";

export interface MoveColumn { key: string; label: string; lead: ReactNode; accepts: boolean }

const ELSEWHERE: DropTargetKind[] = ["project", "person", "week-day"];
const GROUP: Record<string, { label: string; icon: IconName }> = {
  project: { label: "Projects", icon: "folder" },
  person: { label: "People", icon: "user" },
  "week-day": { label: "This week", icon: "calendar" },
};

export function CardMoveMenu({ task, columns, currentKey, onPickColumn, onToggleToday, onDone, onMoved }: {
  task: Pick<Task, "id" | "title" | "planToday" | "status" | "projectId" | "assigneeId">;
  columns: MoveColumn[];
  currentKey: string | undefined;
  onPickColumn: (key: string) => void;
  /** on / off Today (omitted when the task can't be planned: done, or read-only) */
  onToggleToday?: () => void;
  /** close the menu */
  onDone: () => void;
  /** a place elsewhere took it (for the board's live region) */
  onMoved?: (where: string) => void;
}) {
  const others = useDropTargets(ELSEWHERE).filter((t) =>
    !(t.kind === "project" && t.id === task.projectId) && !(t.kind === "person" && t.id === task.assigneeId));
  const groups = ELSEWHERE.map((k) => ({ kind: k, items: others.filter((t) => t.kind === k) })).filter((g) => g.items.length > 0);
  const send = (t: DropTargetRef) => {
    onDone();
    const ok = dropOnTarget({ taskIds: [task.id], source: "board", originId: task.id }, t);
    if (ok) onMoved?.(t.label ?? t.id);
  };
  return (
    <>
      <div className="ktv-mlabel" aria-hidden>Move to</div>
      {columns.map((c) => (
        <MenuItem key={c.key} checked={c.key === currentKey} disabled={!c.accepts && c.key !== currentKey}
          title={!c.accepts && c.key !== currentKey ? "Cards can't be moved into this column" : undefined}
          onSelect={() => { onDone(); if (c.key !== currentKey) onPickColumn(c.key); }}>
          <span style={{ display: "inline-grid", placeItems: "center", width: 20 }}>{c.lead}</span> <span className="truncate">{c.label}</span>
        </MenuItem>
      ))}
      {onToggleToday && (
        <>
          <div className="ktv-msep" role="separator" />
          <MenuItem onSelect={() => { onDone(); onToggleToday(); }}>
            <Icon name="sun" size={16} /> {task.planToday ? "Take off Today" : "Add to Today"}
          </MenuItem>
        </>
      )}
      {groups.map((g) => (
        <div key={g.kind} role="group" aria-label={GROUP[g.kind].label}>
          <div className="ktv-msep" role="separator" />
          <div className="ktv-mlabel" aria-hidden>{GROUP[g.kind].label}</div>
          {g.items.map((t) => (
            <MenuItem key={`${t.kind}:${t.id}`} onSelect={() => send(t)}>
              <Icon name={GROUP[g.kind].icon} size={16} /> <span className="truncate">{t.label ?? t.id}</span>
            </MenuItem>
          ))}
        </div>
      ))}
    </>
  );
}
