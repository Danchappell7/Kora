/* ============================================================
   KANBO — staggered view-entrance choreography.
   Returns "kstagger" for the first moments after a view mounts (or after
   `replayKey` changes), then "" — so the list assembles on arrival, but a
   row that mounts later (drag-drop into a new group, a newly created task)
   appears instantly instead of lagging behind a stagger delay.
   ============================================================ */
import { useEffect, useState } from "react";

export function useEntrance(replayKey?: unknown, ms = 800): string {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(true);
    const t = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(t);
  }, [replayKey, ms]);
  return on ? "kstagger" : "";
}
