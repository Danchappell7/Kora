/* ============================================================
   KANBO — Today's "Kanbo noticed" cards for work due while someone's
   away (0055, lib/awayNoticed), and the move they offer: every task
   to the day the person's back, in one save, with Undo.
   ============================================================ */
import { useCallback, useMemo, useRef } from "react";
import type { Task } from "../../data/types";
import { getMember } from "../../data/data";
import type { MoveDeps } from "../../lib/dropMoves";
import type { Noticed } from "../../lib/noticed";
import { awayMovePatches, awayNoticed } from "../../lib/awayNoticed";
import { dayWord } from "../../lib/availability";
import { useAvailability } from "./useAvailability";

export function useAwayNoticed({ tasks, today, moveDeps, names }: {
  /** the tasks Today can see (the workspace's, and yours everywhere) */
  tasks: Task[];
  /** YYYY-MM-DD */
  today: string;
  /** the app's update path and toast (none: read-only, no cards) */
  moveDeps?: () => MoveDeps;
  /** a person's name, when the reference list doesn't know it */
  names?: (id: string) => string | undefined;
}): { noticed: Noticed[]; onMove: (taskIds: string[], to: string) => void } | undefined {
  const s = useAvailability();
  const nameRef = useRef(names);
  nameRef.current = names;
  const noticed = useMemo(() => (moveDeps ? awayNoticed({ tasks, today, s, nameOf: (id) => getMember(id)?.name || nameRef.current?.(id) || "" }) : []),
    [tasks, today, s, moveDeps]);
  const onMove = useCallback((taskIds: string[], to: string) => {
    if (!moveDeps) return;
    const deps = moveDeps();
    const { apply, undo } = awayMovePatches([...deps.tasks], taskIds, to);
    if (!apply.length) return;
    void deps.updateTasks(apply);
    const when = dayWord(to, today);
    deps.toast(`Moved ${apply.length === 1 ? "1 task" : `${apply.length} tasks`} to ${when}`, () => { void deps.updateTasks(undo); });
  }, [moveDeps, today]);
  return useMemo(() => (noticed.length ? { noticed, onMove } : undefined), [noticed, onMove]);
}
