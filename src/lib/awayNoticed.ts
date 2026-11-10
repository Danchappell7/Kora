/* ============================================================
   KANBO — "Kanbo noticed": work due while someone's away (0055).
   For each stretch of time off ahead (today up to two weeks out),
   the open work due inside it: your own, and, in a business you own
   or run, your teammates'. One card per stretch ("Sana's away when
   three tasks are due"), offering to move it all to the day they're
   back (Today's rail does the move, with Undo). Half days are left
   alone: a morning off rarely moves a deadline.
   Pure: no React, no storage, no clock of its own.
   ============================================================ */
import type { Task } from "../data/types";
import type { Noticed } from "./noticed";
import { countWord } from "./brief";
import { availabilityOn, backOn, dayWord, isoOf, roleOf, spanWords, type AvailabilityState } from "./availability";
import { addDays, localDay } from "./weekMath";

const HORIZON = 14;
const MAX = 2;
const short = (s: string) => (s.length > 40 ? s.slice(0, 39).trimEnd() + "…" : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The away cards for Today (at most two, soonest first). `nameOf` gives a person's name. */
export function awayNoticed(input: { tasks: Task[]; today: string; nameOf: (id: string) => string; s: AvailabilityState }): Noticed[] {
  const { tasks, today, s } = input;
  if (!availabilityOn(s) || !s.me) return [];
  const t0 = localDay(today);
  if (!t0) return [];
  const horizon = isoOf(addDays(t0, HORIZON));
  const leadsIn = (ws: string | null | undefined) => { const r = roleOf(ws, s.me, s); return r === "owner" || r === "admin"; };
  const out: Array<Noticed & { first: string }> = [];
  const stretches = s.timeOff.filter((t) => !t.halfDay && t.endsOn >= today && t.startsOn <= horizon)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  for (const off of stretches) {
    const who = off.userId;
    const mine = who === s.me;
    const from = off.startsOn > today ? off.startsOn : today;
    const due = tasks.filter((t) => t.assigneeId === who && t.status !== "done" && !t.archivedAt && !t.isMilestone && !!t.dueDate
      && t.dueDate.slice(0, 10) >= from && t.dueDate.slice(0, 10) <= off.endsOn
      && (mine || (!!t.workspaceId && leadsIn(t.workspaceId))))
      .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.title.localeCompare(b.title));
    if (!due.length) continue;
    const back = backOn(who, off.endsOn, due[0].workspaceId, s);
    const backWord = dayWord(back, today);
    const first = (input.nameOf(who) || "Someone").trim().split(/\s+/)[0];
    const n = due.length;
    const what = n === 1 ? `“${short(due[0].title)}” is due ${dayWord(due[0].dueDate!.slice(0, 10), today)}`
      : n === 2 ? `“${short(due[0].title)}” and “${short(due[1].title)}” are due then`
      : `“${short(due[0].title)}” and ${countWord(n - 1)} more are due then`;
    const span = spanWords(off);
    out.push({
      id: `away:${who}:${off.startsOn}`, kind: "away", tone: "warn", icon: "calendar",
      title: mine ? (n === 1 ? "You're away when a task is due" : `You're away when ${countWord(n)} of your tasks are due`)
        : n === 1 ? `${first}'s away when a task is due` : `${first}'s away when ${countWord(n)} tasks are due`,
      body: mine ? `You're off ${span}, and ${what}. Move ${n === 1 ? "it" : "them"} to ${backWord}, your first day back?`
        : `${first} is off ${span}, and ${what}. Move ${n === 1 ? "it" : "them"} to ${backWord}, when ${first}'s back?`,
      actions: [
        { kind: "away", label: `Move to ${cap(backWord)}`, userId: who, taskIds: due.map((t) => t.id), to: back },
        { kind: "open", label: "Open it", taskId: due[0].id },
      ],
      first: due[0].dueDate!.slice(0, 10),
    });
  }
  return out.sort((a, b) => a.first.localeCompare(b.first)).slice(0, MAX).map(({ first: _f, ...n }) => n);
}

/** The patches that move the work to the day they're back (a start date moves with it, keeping
 *  the span), and the ones that put it back. */
export function awayMovePatches(tasks: Task[], taskIds: string[], to: string): { apply: { id: string; patch: Partial<Task> }[]; undo: { id: string; patch: Partial<Task> }[] } {
  const apply: { id: string; patch: Partial<Task> }[] = [];
  const undo: { id: string; patch: Partial<Task> }[] = [];
  const target = localDay(to);
  for (const id of taskIds) {
    const t = tasks.find((x) => x.id === id);
    if (!t || !t.dueDate || !target || t.dueDate.slice(0, 10) >= to) continue;
    const patch: Partial<Task> = { dueDate: to };
    const was: Partial<Task> = { dueDate: t.dueDate };
    const due = localDay(t.dueDate), start = localDay(t.startDate);
    if (due && start) {
      const shift = Math.round((target.getTime() - due.getTime()) / 86400000);
      patch.startDate = isoOf(addDays(start, shift));
      was.startDate = t.startDate;
    }
    apply.push({ id, patch });
    undo.push({ id, patch: was });
  }
  return { apply, undo };
}
