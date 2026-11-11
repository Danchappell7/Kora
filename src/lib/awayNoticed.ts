/* ============================================================
   KANBO — "Kanbo noticed": work due while someone's away (0055).
   For each stretch of time off ahead (today up to two weeks out),
   the open work due inside it: your own (not where you're only a
   guest: guests don't change work), and, in a business you own or
   run, your teammates'. One card per stretch ("Sana's away when
   three tasks are due"), offering to give it all to the teammate with
   the most room that week (when it's all one business's, and someone
   around has room), or to move it to the day they're back (Today's
   rail does either, with Undo). Half days are left alone: a morning
   off rarely moves a deadline.
   Pure: no React, no storage, no clock of its own.
   ============================================================ */
import type { Task } from "../data/types";
import type { Noticed } from "./noticed";
import { countWord } from "./brief";
import { availabilityOn, backOn, capacityInWeek, dayWord, isOffOn, isoOf, roleOf, spanWords, type AvailabilityState } from "./availability";
import { loadForWeek, taskHours } from "./radar";
import { addDays, localDay, startOfWeekMon } from "./weekMath";

const HORIZON = 14;
const MAX = 2;
/** a teammate takes the work on only while they stay under this share of their week */
const ROOM = 0.9;
const short = (s: string) => (s.length > 40 ? s.slice(0, 39).trimEnd() + "…" : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The away cards for Today (at most two, soonest first). `nameOf` gives a person's name. */
export function awayNoticed(input: { tasks: Task[]; today: string; nameOf: (id: string) => string; s: AvailabilityState;
  /** (0058) can this person see this task's project (none given: yes): a teammate offered the work must see all of it */
  canSee?: (userId: string, task: Task) => boolean }): Noticed[] {
  const { tasks, today, s } = input;
  if (!availabilityOn(s) || !s.me) return [];
  const t0 = localDay(today);
  if (!t0) return [];
  const horizon = isoOf(addDays(t0, HORIZON));
  const leadsIn = (ws: string | null | undefined) => { const r = roleOf(ws, s.me, s); return r === "owner" || r === "admin"; };
  // your own work, except in a business where you're a guest (Personal isn't a team: it's yours)
  const mayMoveMine = (ws: string | null | undefined) => !ws || !s.roles[ws] || roleOf(ws, s.me, s) !== "guest";
  const out: Array<Noticed & { first: string }> = [];
  const stretches = s.timeOff.filter((t) => !t.halfDay && t.endsOn >= today && t.startsOn <= horizon)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  for (const off of stretches) {
    const who = off.userId;
    const mine = who === s.me;
    const from = off.startsOn > today ? off.startsOn : today;
    const due = tasks.filter((t) => t.assigneeId === who && t.status !== "done" && !t.archivedAt && !t.isMilestone && !!t.dueDate
      && t.dueDate.slice(0, 10) >= from && t.dueDate.slice(0, 10) <= off.endsOn
      && ((mine && mayMoveMine(t.workspaceId)) || (!!t.workspaceId && leadsIn(t.workspaceId))))
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
    const taker = withRoom(input, who, due);
    const takerFirst = taker ? (input.nameOf(taker) || "Someone").trim().split(/\s+/)[0] : "";
    const them = n === 1 ? "it" : "them";
    out.push({
      id: `away:${who}:${off.startsOn}`, kind: "away", tone: "warn", icon: "calendar",
      title: mine ? (n === 1 ? "You're away when a task is due" : `You're away when ${countWord(n)} of your tasks are due`)
        : n === 1 ? `${first}'s away when a task is due` : `${first}'s away when ${countWord(n)} tasks are due`,
      body: taker
        ? mine ? `You're off ${span}, and ${what}. ${takerFirst} has room then: give ${them} to ${takerFirst}, or move ${them} to ${backWord}, your first day back?`
          : `${first} is off ${span}, and ${what}. ${takerFirst} has room then: give ${them} to ${takerFirst}, or move ${them} to ${backWord}, when ${first}'s back?`
        : mine ? `You're off ${span}, and ${what}. Move ${them} to ${backWord}, your first day back?`
          : `${first} is off ${span}, and ${what}. Move ${them} to ${backWord}, when ${first}'s back?`,
      actions: [
        ...(taker ? [{ kind: "away" as const, label: `Give to ${takerFirst}`, userId: who, taskIds: due.map((t) => t.id), to: back, assignTo: taker }] : []),
        { kind: "away", label: `Move to ${cap(backWord)}`, userId: who, taskIds: due.map((t) => t.id), to: back },
        ...(taker ? [] : [{ kind: "open" as const, label: "Open it", taskId: due[0].id }]),
      ],
      first: due[0].dueDate!.slice(0, 10),
    });
  }
  return out.sort((a, b) => a.first.localeCompare(b.first)).slice(0, MAX).map(({ first: _f, ...n }) => n);
}

/** The teammate with the most room to take this work on in the week it's due: on the team where it all
 *  is (one business, where you may hand it over), not you or the person away, not off on any day it's due,
 *  able to see every task's project (0058), and staying under 90% of their week with it. Null when nobody
 *  has room (or it spans businesses). */
function withRoom(input: { tasks: Task[]; today: string; s: AvailabilityState; canSee?: (userId: string, task: Task) => boolean }, who: string, due: Task[]): string | null {
  const { s } = input;
  const ws = due[0].workspaceId;
  if (!ws || !s.roles[ws] || due.some((t) => t.workspaceId !== ws)) return null;
  const mine = roleOf(ws, s.me, s);
  if (!(mine === "owner" || mine === "admin" || (who === s.me && mine === "member"))) return null;
  const today = localDay(input.today);
  const firstDue = localDay(due[0].dueDate);
  if (!today || !firstDue) return null;
  const weekStart = startOfWeekMon(firstDue);
  const { rows } = loadForWeek(input.tasks.filter((t) => t.workspaceId === ws), weekStart, today);
  const hours = due.reduce((sum, t) => sum + taskHours(t).hours, 0);
  const days = [...new Set(due.map((t) => t.dueDate!.slice(0, 10)))];
  let best: { id: string; room: number } | null = null;
  for (const [id, role] of Object.entries(s.roles[ws])) {
    if (id === who || id === s.me || role === "guest") continue;
    if (days.some((d) => isOffOn(id, d, s))) continue;
    if (input.canSee && due.some((t) => !input.canSee!(id, t))) continue;
    const room = capacityInWeek(ws, id, weekStart, s) * ROOM - (rows.get(id)?.hours ?? 0) - hours;
    if (room < 0) continue;
    if (!best || room > best.room || (room === best.room && id < best.id)) best = { id, room };
  }
  return best?.id ?? null;
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

/** The patches that give the work to someone else (its dates stay), and the ones that give it back. */
export function awayGivePatches(tasks: Task[], taskIds: string[], to: string): { apply: { id: string; patch: Partial<Task> }[]; undo: { id: string; patch: Partial<Task> }[] } {
  const apply: { id: string; patch: Partial<Task> }[] = [];
  const undo: { id: string; patch: Partial<Task> }[] = [];
  for (const id of taskIds) {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.assigneeId === to) continue;
    apply.push({ id, patch: { assigneeId: to } });
    undo.push({ id, patch: { assigneeId: t.assigneeId } });
  }
  return { apply, undo };
}
