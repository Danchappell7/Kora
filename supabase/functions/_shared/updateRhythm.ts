// ============================================================
// KANBO — the update rhythm (0053): when a project's status update is due,
// whether it's been posted, and when it's missing. Pure module (no Deno or
// browser globals, no clock of its own): daily-reminders' "rhythm" step and
// the app (src/lib/updateRhythm re-exports it) share one implementation.
//
//   • A workspace picks its update day (workspaces.update_rhythm; unset:
//     weekly on Friday): weekly, fortnightly, monthly (the last <day> of the
//     month) or never. A project can follow it or choose its own, "Never"
//     included (projects.update_rhythm; unset: the workspace's).
//   • Fortnightly counts weeks from its anchor (the first due day, set when
//     it's chosen; without one, from Monday 1 January 2024).
//   • An update is due on the due day D when nothing was posted after the
//     previous due day. The owner is reminded on D and on the next two
//     working days (Mon–Fri); after those it's "Update missing".
//   • Archived and on-hold projects, and projects with no tasks, are skipped.
//     A project that started within 3 days of D isn't expected to post on D.
// Days are "YYYY-MM-DD" in the reader's own timezone (the app: the device;
// the reminder: the owner's notify_prefs timezone). All arithmetic is on
// calendar dates, so no timezone or clock change can move a due day.
// ============================================================

export type UpdateCadence = "weekly" | "fortnightly" | "monthly" | "never";
export const UPDATE_CADENCES: readonly UpdateCadence[] = ["weekly", "fortnightly", "monthly", "never"];

export interface UpdateRhythm {
  cadence: UpdateCadence;
  /** ISO weekday, Mon = 1 … Sun = 7 */
  weekday: number;
  /** fortnightly: a due day the fortnights count from ("YYYY-MM-DD") */
  anchor?: string;
}

/** A workspace that hasn't chosen: weekly, on Friday. */
export const DEFAULT_RHYTHM: UpdateRhythm = { cadence: "weekly", weekday: 5 };
/** Reminders after the due day: on this many working days. */
export const FOLLOW_UPS = 2;
/** A project this new on the due day (days since its first task) isn't expected to post yet. */
export const NEW_PROJECT_DAYS = 3;
const FORTNIGHT_EPOCH = "2024-01-01"; // a Monday

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

const toUtc = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
};
const fromUtc = (ms: number): string => {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

/** Is it a real calendar day, "YYYY-MM-DD"? */
export function isDay(v: unknown): v is string {
  return typeof v === "string" && DAY_RE.test(v) && fromUtc(toUtc(v)) === v;
}
/** "2026-11-13" + n days. */
export function shiftDay(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * DAY_MS);
}
/** Days from a to b (b − a). */
export function daysFrom(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}
/** ISO weekday of a day: Mon = 1 … Sun = 7. */
export function isoWeekday(day: string): number {
  const d = new Date(toUtc(day)).getUTCDay();
  return d === 0 ? 7 : d;
}
const isWorkingDay = (day: string) => isoWeekday(day) <= 5;
/** The Monday of the week a day is in. */
const mondayOf = (day: string) => shiftDay(day, 1 - isoWeekday(day));

/** n working days (Mon–Fri) after a day (a weekend day counts from the next Monday). */
export function addWorkingDays(day: string, n: number): string {
  let d = day, left = n;
  while (left > 0) {
    d = shiftDay(d, 1);
    if (isWorkingDay(d)) left--;
  }
  return d;
}
/** Working days in (a, b]: how many follow-up days have begun since a. */
export function workingDaysAfter(a: string, b: string): number {
  let n = 0;
  for (let d = shiftDay(a, 1); d <= b; d = shiftDay(d, 1)) if (isWorkingDay(d)) n++;
  return n;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** workspaces.update_rhythm / projects.update_rhythm (anything) → a rhythm, or null when unset or unreadable. Never throws. */
export function parseRhythm(raw: unknown): UpdateRhythm | null {
  if (!isObj(raw)) return null;
  const cadence = raw.cadence;
  if (typeof cadence !== "string" || !(UPDATE_CADENCES as readonly string[]).includes(cadence)) return null;
  const wd = Number(raw.weekday);
  const weekday = Number.isInteger(wd) && wd >= 1 && wd <= 7 ? wd : DEFAULT_RHYTHM.weekday;
  const out: UpdateRhythm = { cadence: cadence as UpdateCadence, weekday };
  if (cadence === "fortnightly" && isDay(raw.anchor)) out.anchor = raw.anchor;
  return out;
}

/** The rhythm as the database stores it (anchor only for fortnightly). */
export function rhythmRow(r: UpdateRhythm): Record<string, unknown> {
  return { cadence: r.cadence, weekday: r.weekday, ...(r.cadence === "fortnightly" && r.anchor ? { anchor: r.anchor } : {}) };
}

/** A project's rhythm: its own when it chose one, else its workspace's, else weekly on Friday. */
export function effectiveRhythm(projectRhythm: unknown, workspaceRhythm: unknown): UpdateRhythm {
  return parseRhythm(projectRhythm) ?? parseRhythm(workspaceRhythm) ?? DEFAULT_RHYTHM;
}

/** For fortnightly: the next `weekday` on or after a day (what a newly chosen rhythm counts from). */
export function anchorFrom(day: string, weekday: number): string {
  return shiftDay(day, (weekday - isoWeekday(day) + 7) % 7);
}

/** The last `weekday` of the month a day is in. */
function lastWeekdayOfMonth(day: string, weekday: number): string {
  const [y, m] = day.split("-").map(Number);
  const last = fromUtc(Date.UTC(y, m, 0)); // day 0 of next month
  return shiftDay(last, -((isoWeekday(last) - weekday + 7) % 7));
}

/** The latest due day on or before `day` (null: never). */
export function dueOnOrBefore(r: UpdateRhythm, day: string): string | null {
  if (r.cadence === "never") return null;
  if (r.cadence === "monthly") {
    const here = lastWeekdayOfMonth(day, r.weekday);
    if (here <= day) return here;
    const [y, m] = day.split("-").map(Number);
    return lastWeekdayOfMonth(fromUtc(Date.UTC(y, m - 2, 1)), r.weekday);
  }
  const weekly = shiftDay(day, -((isoWeekday(day) - r.weekday + 7) % 7));
  if (r.cadence === "weekly") return weekly;
  const from = mondayOf(r.anchor ?? FORTNIGHT_EPOCH);
  const weeks = Math.round(daysFrom(from, mondayOf(weekly)) / 7);
  return ((weeks % 2) + 2) % 2 === 0 ? weekly : shiftDay(weekly, -7);
}
/** The due day before `day` (strictly). */
export function dueBefore(r: UpdateRhythm, day: string): string | null {
  return dueOnOrBefore(r, shiftDay(day, -1));
}
/** The first due day on or after `day` (null: never). */
export function dueOnOrAfter(r: UpdateRhythm, day: string): string | null {
  if (r.cadence === "never") return null;
  // the latest due day up to five weeks ahead, walked back to the first one on or after `day`
  let next = dueOnOrBefore(r, shiftDay(day, 35));
  while (next) {
    const prev = dueBefore(r, next);
    if (!prev || prev < day) return next;
    next = prev;
  }
  return null;
}

export type RhythmState =
  /** no update day (Never, archived, on hold, no tasks yet), or no rhythm at all */
  | { kind: "off"; why: "never" | "paused" | "empty" }
  /** this round's update is in (or none's expected yet); `next` is the next due day */
  | { kind: "ok"; next: string | null; due: string | null }
  /** due today or in its follow-up days: `followUp` 0 on the day, then 1 and 2 on the working days after.
   *  `lapsed`: the round before went without one too (a leader reads it as missing) */
  | { kind: "due"; due: string; followUp: number; lapsed: boolean }
  /** past the due day and its follow-ups with nothing posted */
  | { kind: "missing"; due: string };

export interface RhythmInput {
  rhythm: UpdateRhythm;
  /** the reader's today, "YYYY-MM-DD" */
  today: string;
  /** the day the latest update was posted (same timezone), or null */
  lastUpdate: string | null;
  /** the day the project's first (live) task was added, or null when it has none */
  startedOn: string | null;
  /** archived, or on hold */
  paused?: boolean;
}

/** Was an update expected for due day D, and posted? */
function covered(r: UpdateRhythm, due: string, lastUpdate: string | null, startedOn: string): boolean {
  if (startedOn > shiftDay(due, -NEW_PROJECT_DAYS)) return true;           // too new to owe one
  const prev = dueBefore(r, due);
  return !!lastUpdate && (!prev || lastUpdate > prev);
}

/** Where a project's update stands today (see the file note). */
export function rhythmState({ rhythm, today, lastUpdate, startedOn, paused }: RhythmInput): RhythmState {
  if (paused) return { kind: "off", why: "paused" };
  if (rhythm.cadence === "never") return { kind: "off", why: "never" };
  if (!startedOn) return { kind: "off", why: "empty" };
  const due = dueOnOrBefore(rhythm, today);
  if (!due || covered(rhythm, due, lastUpdate, startedOn)) {
    return { kind: "ok", next: dueOnOrAfter(rhythm, shiftDay(today, 1)), due };
  }
  if (today <= addWorkingDays(due, FOLLOW_UPS)) {
    const prev = dueBefore(rhythm, due);
    return { kind: "due", due, followUp: Math.min(FOLLOW_UPS, workingDaysAfter(due, today)), lapsed: !!prev && !covered(rhythm, prev, lastUpdate, startedOn) };
  }
  return { kind: "missing", due };
}

/** Is today one of the days the owner hears about it (the due day, or a working follow-up day)? */
export function isReminderDay(s: RhythmState, today: string): boolean {
  return s.kind === "due" && (today === s.due || (isWorkingDay(today) && s.followUp > 0));
}

/** Does a leader read it as missing (past its follow-ups, or the round before lapsed too)? */
export const readsMissing = (s: RhythmState): boolean => s.kind === "missing" || (s.kind === "due" && s.lapsed);

/* ---------- words ---------- */

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Friday" */
export const weekdayName = (wd: number): string => WEEKDAY_NAMES[(wd - 1 + 7) % 7] ?? "Friday";

/** "Every Friday" · "Every other Friday" · "The last Friday of the month" · "Never" */
export function rhythmLabel(r: UpdateRhythm): string {
  const day = weekdayName(r.weekday);
  switch (r.cadence) {
    case "weekly": return `Every ${day}`;
    case "fortnightly": return `Every other ${day}`;
    case "monthly": return `The last ${day} of the month`;
    default: return "Never";
  }
}

/** "Fri 13 Nov", or "today" / "yesterday" / "tomorrow" next to `today`. */
export function dueDayWords(day: string, today: string): string {
  const n = daysFrom(today, day);
  if (n === 0) return "today";
  if (n === -1) return "yesterday";
  if (n === 1) return "tomorrow";
  const [, m, d] = day.split("-").map(Number);
  return `${SHORT_WEEKDAYS[isoWeekday(day) - 1]} ${d} ${MONTHS[m - 1]}`;
}
