/* ============================================================
   KANBO — My tasks buckets (pure, unit-tested).
   Open    — my open work by when it's due: Overdue · Today · This
             week · Later · No date ("Today" also takes what I've
             planned for today, and work in progress with no date).
   Waiting — what I'm waiting on other people for: tasks I created
             (or follow) that sit with someone else, and my own tasks
             held up by someone else's open blocker. By person.
   Done    — what I finished, by day ("Today", "Yesterday",
             "Mon 28 Sep"), with anything older kept aside.
   Every function takes `today` (default KANBO_TODAY, which the live
   clock moves at midnight), so the buckets roll over with the app.
   ============================================================ */
import { KANBO_TODAY, getMember } from "../data/data";
import type { Task } from "../data/types";

export type OpenBucketKey = "overdue" | "today" | "week" | "later" | "nodate";

export interface TaskBucket {
  key: string;
  label: string;
  /** signal: the heading reads in the signal colour (Overdue) */
  tone?: "signal";
  items: Task[];
}

const DAY_MS = 86400000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** A stored day as local midnight. "YYYY-MM-DD" is read as a local date; a full
 *  timestamp ("2026-09-29T23:30:00Z") is converted to the local day it fell on. */
export function localDayOf(value: string | undefined | null): Date | null {
  if (!value) return null;
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) {
    const d = new Date(+plain[1], +plain[2] - 1, +plain[3]);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : midnight(t);
}

/** Whole days from today to `iso` (negative = past); null when there's no usable date. */
export function daysFromToday(iso: string | undefined | null, today: Date = KANBO_TODAY): number | null {
  const d = localDayOf(iso);
  return d ? Math.round((d.getTime() - midnight(today).getTime()) / DAY_MS) : null;
}

/** Assigned to me, or I'm a collaborator on it — the same rule App uses for "mine". */
export const isMine = (t: Task, me: string) => t.assigneeId === me || (t.collaborators ?? []).includes(me);

/** Which Open bucket a (not done) task belongs in. Overdue wins over a plan for today. */
export function openBucketOf(t: Task, today: Date = KANBO_TODAY): OpenBucketKey {
  const n = daysFromToday(t.dueDate, today);
  if (n !== null && n < 0) return "overdue";
  if (n === 0 || t.planToday || t.scheduled != null || (n === null && t.status === "progress")) return "today";
  if (n === null) return "nodate";
  return n <= 7 ? "week" : "later";
}

export const OPEN_BUCKETS: { key: OpenBucketKey; label: string; tone?: "signal" }[] = [
  { key: "overdue", label: "Overdue", tone: "signal" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
  { key: "nodate", label: "No date" },
];

/** My open tasks, by when they're due. Empty buckets are left out. */
export function bucketOpen(mine: Task[], today: Date = KANBO_TODAY): TaskBucket[] {
  const by = new Map<OpenBucketKey, Task[]>();
  for (const t of mine) {
    if (t.status === "done") continue;
    const k = openBucketOf(t, today);
    const list = by.get(k);
    if (list) list.push(t); else by.set(k, [t]);
  }
  return OPEN_BUCKETS.filter((b) => by.has(b.key)).map((b) => ({ ...b, items: by.get(b.key)! }));
}

/** Tasks completed today (so a row ticked off in Open has somewhere to land). */
export function doneToday(mine: Task[], today: Date = KANBO_TODAY): Task[] {
  return mine.filter((t) => t.status === "done" && daysFromToday(t.completedAt, today) === 0);
}

/* ---------------- Waiting on ---------------- */

export interface WaitingReason {
  /** "with": a task of mine sitting with them · "needs": my task, held up by their blocker */
  kind: "with" | "needs";
  personId: string;
  /** the blocker's id and title, for "needs" (a nudge goes to the blocker) */
  blockerId?: string;
  blocker?: string;
}

export interface WaitingBuckets {
  groups: TaskBucket[];
  /** why each task is waiting (for the row's inline "with Maya" / "needs “…”") */
  reasons: Map<string, WaitingReason>;
}

/** A member's first name, for "With Maya". */
export function firstNameOf(id: string): string {
  const name = getMember(id)?.name?.trim();
  if (!name) return "someone";
  return name.includes("@") ? name : name.split(/\s+/)[0];
}

/** What I'm waiting on others for, grouped by person ("With Maya · 3"): open tasks I
 *  created or follow that are assigned to someone else (and I'm not on), plus my own
 *  open tasks that have an open dependency assigned to someone else. Busiest first. */
export function bucketWaiting(allTasks: Task[], me: string): WaitingBuckets {
  const reasons = new Map<string, WaitingReason>();
  const byPerson = new Map<string, Task[]>();
  const add = (t: Task, r: WaitingReason) => {
    if (reasons.has(t.id)) return;
    reasons.set(t.id, r);
    const list = byPerson.get(r.personId);
    if (list) list.push(t); else byPerson.set(r.personId, [t]);
  };
  if (!me) return { groups: [], reasons };
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  for (const t of allTasks) {
    if (t.status === "done" || t.archivedAt) continue;
    const mineToWatch = t.createdBy === me || (t.followers ?? []).includes(me);
    if (mineToWatch && t.assigneeId && t.assigneeId !== me && !isMine(t, me)) {
      add(t, { kind: "with", personId: t.assigneeId });
      continue;
    }
    if (isMine(t, me)) {
      const blocker = (t.dependencies ?? []).map((id) => byId.get(id))
        .find((b): b is Task => !!b && b.status !== "done" && !b.archivedAt && !!b.assigneeId && b.assigneeId !== me);
      if (blocker) add(t, { kind: "needs", personId: blocker.assigneeId, blockerId: blocker.id, blocker: blocker.title });
    }
  }
  const groups = [...byPerson.entries()]
    .map(([personId, items]) => ({ key: personId, label: `With ${firstNameOf(personId)}`, items }))
    .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  return { groups, reasons };
}

/* ---------------- Done ---------------- */

/** "Today", "Yesterday", else "Mon 28 Sep" (with the year when it isn't this year). Fixed
 *  English names, so every browser says "Sep" (some en-GB builds say "Sept"). */
export function dayLabel(d: Date, today: Date = KANBO_TODAY): string {
  const n = Math.round((midnight(d).getTime() - midnight(today).getTime()) / DAY_MS);
  if (n === 0) return "Today";
  if (n === -1) return "Yesterday";
  const s = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === today.getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface DoneBuckets {
  /** the last `days` days, newest first, one group per day */
  groups: TaskBucket[];
  /** anything older (or with no completion date), by month — behind "Show older" */
  older: TaskBucket[];
  olderCount: number;
}

/** My finished tasks, by the day they were completed (newest day first). */
export function bucketDone(allTasks: Task[], me: string, days = 30, today: Date = KANBO_TODAY): DoneBuckets {
  const recent = new Map<string, { d: Date; items: Task[] }>();
  const older = new Map<string, { d: Date | null; items: Task[] }>();
  let olderCount = 0;
  for (const t of allTasks) {
    if (t.status !== "done" || t.archivedAt || !isMine(t, me)) continue;
    const d = localDayOf(t.completedAt);
    const n = d ? Math.round((d.getTime() - midnight(today).getTime()) / DAY_MS) : null;
    if (d && n !== null && n <= 0 && n > -days) {
      const k = dayKey(d);
      const e = recent.get(k);
      if (e) e.items.push(t); else recent.set(k, { d, items: [t] });
    } else {
      olderCount++;
      const k = d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : "earlier";
      const e = older.get(k);
      if (e) e.items.push(t); else older.set(k, { d: d ? new Date(d.getFullYear(), d.getMonth(), 1) : null, items: [t] });
    }
  }
  const groups = [...recent.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([k, e]) => ({ key: `day:${k}`, label: dayLabel(e.d, today), items: e.items }));
  const olderGroups = [...older.entries()]
    .sort((a, b) => (a[0] === "earlier" ? 1 : b[0] === "earlier" ? -1 : a[0] < b[0] ? 1 : -1))
    .map(([k, e]) => ({
      key: `month:${k}`,
      label: e.d ? (e.d.getFullYear() === today.getFullYear() ? MONTHS_LONG[e.d.getMonth()] : `${MONTHS_LONG[e.d.getMonth()]} ${e.d.getFullYear()}`) : "Earlier",
      items: e.items,
    }));
  return { groups, older: olderGroups, olderCount };
}

/** The group a "?due=" link points at on My tasks › Open. */
export function dueFocusGroup(focus: string | undefined): OpenBucketKey | undefined {
  return focus === "overdue" || focus === "today" || focus === "week" ? focus : undefined;
}
