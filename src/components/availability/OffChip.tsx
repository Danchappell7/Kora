/* ============================================================
   KANBO — "Off today" on People, Pulse and the assignee picker
   (0055). OffChip: someone's time off now or this week ("Off until
   Mon", "Off from Thu"), with the dates (and, for those who may read
   it, the reason) on hover and for screen readers. OffTag: the
   picker's warning that they're off the day the work's due. OffNote:
   the same as a sentence under a field ("Sana is off Thu").
   Nothing shows before 0055 is run, or to a guest.
   ============================================================ */
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import { awayNote, offOnDayNote, seesTimeOff } from "../../lib/availability";
import { useAvailability } from "./useAvailability";
import "./availability.css";

export function OffChip({ userId, workspaceId, size = "sm" }: { userId: string | null | undefined; workspaceId: string | null | undefined; size?: "sm" | "xs" }) {
  const s = useAvailability();
  if (!userId || !seesTimeOff(workspaceId, s)) return null;
  const note = awayNote(userId, toLocalISO(KANBO_TODAY), { ws: workspaceId }, s);
  if (!note) return null;
  return (
    <span className="kav-chip" data-now={note.now || undefined} data-size={size} title={note.title}>
      <span aria-hidden="true">{note.label}</span>
      <span className="sr-only">{note.title}</span>
    </span>
  );
}

export function OffTag({ userId, workspaceId, due }: { userId: string; workspaceId: string | null | undefined; due?: string | null }) {
  const s = useAvailability();
  if (!seesTimeOff(workspaceId, s)) return null;
  const note = offOnDayNote(userId, due, toLocalISO(KANBO_TODAY), s);
  if (!note) return null;
  return <span className="kav-tag" title={due ? `${note}, the day it's due` : note}>{note}</span>;
}

export function OffNote({ userId, name, workspaceId, due }: { userId: string; name: string; workspaceId: string | null | undefined; due?: string | null }) {
  const s = useAvailability();
  if (!userId || !seesTimeOff(workspaceId, s)) return null;
  const note = offOnDayNote(userId, due, toLocalISO(KANBO_TODAY), s);
  if (!note) return null;
  const first = name.trim().split(/\s+/)[0] || name;
  const who = first === "You" ? "You're" : `${first} is`;
  return <span className="kav-note" role="status">{who} {note.charAt(0).toLowerCase()}{note.slice(1)}{due ? ", the day it's due" : ""}.</span>;
}
