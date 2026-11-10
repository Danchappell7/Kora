/* ============================================================
   KANBO — shared capacity, working hours, time off and bill rates
   (0055), the app's side.
   One copy for everyone, where each browser used to keep its own:
   a person's week at a business (capacity, working days, start and
   end), their time off (the reason only for them and their owners
   and admins: everyone else sees "Off"), and bill rates (owners and
   admins only). Workload, Radar, Pulse, the AI planner, Time &
   billing and Today's working day all read from here.
   Before 0055 is run (status "off") every reader falls back to what
   it did before: capacities saved on this device, 08:00–18:00, the
   device's hourly rate, and no one is ever "Off".
   This module is the model and a small store (subscribe / get, no
   React): lib/availabilitySync loads and saves it, and
   components/availability binds it to the screen. Everything else in
   here is pure: pass a state to ask about it (the store's by default).
   ============================================================ */
import type { Role } from "../data/types";
import { addDays, fmtDayMonth, localDay, round1 } from "./weekMath";

/* ---------- shapes ---------- */

export const DEFAULT_WEEKLY_HOURS = 40;
/** ISO weekdays, Mon = 1 … Sun = 7 */
export const DEFAULT_WORK_DAYS: readonly number[] = [1, 2, 3, 4, 5];
/** minutes from midnight */
export const DEFAULT_DAY_START = 8 * 60;
export const DEFAULT_DAY_END = 18 * 60;
export const MIN_WEEKLY_HOURS = 1, MAX_WEEKLY_HOURS = 168;

/** A person's week at one business (member_availability). */
export interface MemberWeek {
  workspaceId: string;
  userId: string;
  /** null: the 40h default */
  weeklyHours: number | null;
  workDays: number[];
  dayStart: number;
  dayEnd: number;
}

/** A person's days away (time_off). `reason` only reaches the person and their owners and admins. */
export interface TimeOff {
  id: string;
  userId: string;
  /** YYYY-MM-DD, both days included */
  startsOn: string;
  endsOn: string;
  /** half of a single day: the morning or the afternoon */
  halfDay: "am" | "pm" | null;
  reason?: string | null;
}

/** An hourly rate: a project's own, or the workspace's default (projectId null). */
export interface BillRate { workspaceId: string; projectId: string | null; rate: number }

/** "unknown" until the first load; "off" before 0055 is run (every reader falls back). */
export type AvailabilityStatus = "unknown" | "on" | "off";

export interface AvailabilityState {
  status: AvailabilityStatus;
  weeks: MemberWeek[];
  timeOff: TimeOff[];
  rates: BillRate[];
  /** the signed-in person */
  me: string;
  /** the workspace on screen (null: Personal) */
  activeWs: string | null;
  /** each team workspace's active people and their roles */
  roles: Record<string, Record<string, Role>>;
}

export const EMPTY_AVAILABILITY: AvailabilityState = Object.freeze({
  status: "unknown", weeks: [], timeOff: [], rates: [], me: "", activeWs: null, roles: {},
}) as AvailabilityState;

/* ---------- the store ---------- */

let state: AvailabilityState = EMPTY_AVAILABILITY;
const listeners = new Set<() => void>();

export function getAvailability(): AvailabilityState { return state; }
export function subscribeAvailability(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** Replace part of the state (a new object each time, so React sees the change). */
export function updateAvailability(patch: Partial<AvailabilityState> | ((s: AvailabilityState) => Partial<AvailabilityState>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((fn) => fn());
}
/** Tests: back to nothing known. */
export function resetAvailability(): void { state = EMPTY_AVAILABILITY; listeners.forEach((fn) => fn()); }

/** Are the shared values switched on (0055 run, or the demo)? */
export const availabilityOn = (s: AvailabilityState = state): boolean => s.status === "on";

/* ---------- days ---------- */

const pad = (n: number) => String(n).padStart(2, "0");
/** YYYY-MM-DD in local time */
export const isoOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Mon = 1 … Sun = 7 */
export const isoWeekday = (d: Date): number => (d.getDay() === 0 ? 7 : d.getDay());
const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_LONG = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayDiff = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000);

/* ---------- a person's week ---------- */

export const roleOf = (ws: string | null | undefined, user: string, s: AvailabilityState = state): Role | undefined =>
  ws ? s.roles[ws]?.[user] : undefined;

/** A person's week at a business, with the defaults filled in where nothing's set. */
export function weekOf(ws: string | null | undefined, user: string, s: AvailabilityState = state): MemberWeek {
  const row = ws ? s.weeks.find((w) => w.workspaceId === ws && w.userId === user) : undefined;
  return row ?? { workspaceId: ws ?? "", userId: user, weeklyHours: null, workDays: [...DEFAULT_WORK_DAYS], dayStart: DEFAULT_DAY_START, dayEnd: DEFAULT_DAY_END };
}
/** Has the person (or a lead) set their week at this business? */
export const hasOwnWeek = (ws: string | null | undefined, user: string, s: AvailabilityState = state): boolean =>
  !!ws && s.weeks.some((w) => w.workspaceId === ws && w.userId === user);

/** The days of a person's week in words: "Mon–Fri", "Mon–Thu", "Mon, Wed, Fri", "Every day". */
export function workDaysWords(days: readonly number[]): string {
  const d = [...new Set(days)].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
  if (d.length === 7) return "Every day";
  if (!d.length) return "No days";
  const run = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  if (run && d.length >= 3) return `${WEEKDAY[d[0]]}–${WEEKDAY[d[d.length - 1]]}`;
  return d.map((x) => WEEKDAY[x]).join(", ");
}
/** "09:30" */
export const clockOf = (min: number): string => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
/** "09:30–17:30" (an end at midnight reads 24:00) */
export const hoursWords = (w: Pick<MemberWeek, "dayStart" | "dayEnd">): string =>
  `${clockOf(w.dayStart)}–${w.dayEnd >= 1440 ? "24:00" : clockOf(w.dayEnd)}`;

/* ---------- time off ---------- */

/** The person's time off that covers a day (YYYY-MM-DD), if any (a whole day before a half). */
export function timeOffOn(user: string, iso: string, s: AvailabilityState = state): TimeOff | undefined {
  let half: TimeOff | undefined;
  for (const t of s.timeOff) {
    if (t.userId !== user || iso < t.startsOn || iso > t.endsOn) continue;
    if (!t.halfDay) return t;
    half ??= t;
  }
  return half;
}
/** How much of a day the person is off: 0, 0.5 (a morning or an afternoon) or 1. */
export function offShare(user: string, iso: string, s: AvailabilityState = state): number {
  let share = 0;
  for (const t of s.timeOff) {
    if (t.userId !== user || iso < t.startsOn || iso > t.endsOn) continue;
    if (!t.halfDay) return 1;
    share = Math.min(1, share + 0.5);
  }
  return share;
}
/** Is the person off on that day (any part of it)? */
export const isOffOn = (user: string, iso: string, s: AvailabilityState = state): boolean => offShare(user, iso, s) > 0;

/** The next day after `iso` that's one of the person's working days and not off (within 60 days). */
export function backOn(user: string, iso: string, ws?: string | null, s: AvailabilityState = state): string {
  const days = weekOf(ws, user, s).workDays;
  let d = localDay(iso) ?? new Date();
  for (let i = 0; i < 60; i++) {
    d = addDays(d, 1);
    const day = isoOf(d);
    if (days.includes(isoWeekday(d)) && offShare(user, day, s) < 1) return day;
  }
  return isoOf(addDays(localDay(iso) ?? new Date(), 1));
}

/** "today", "tomorrow", "Thu" (within the week ahead), "Thu 26 Nov" beyond. */
export function dayWord(iso: string, todayISO: string): string {
  const d = localDay(iso), t = localDay(todayISO);
  if (!d || !t) return iso;
  const n = dayDiff(t, d);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n > 1 && n < 7) return WEEKDAY[isoWeekday(d)];
  return `${WEEKDAY[isoWeekday(d)]} ${fmtDayMonth(d)}`;
}
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
/** "11–15 Nov", "30 Nov – 2 Dec", "Thu 12 Nov" */
export function spanWords(t: Pick<TimeOff, "startsOn" | "endsOn" | "halfDay">): string {
  const a = localDay(t.startsOn), b = localDay(t.endsOn);
  if (!a || !b) return `${t.startsOn} – ${t.endsOn}`;
  if (t.startsOn === t.endsOn) return `${WEEKDAY[isoWeekday(a)]} ${fmtDayMonth(a)}${t.halfDay === "am" ? " (morning)" : t.halfDay === "pm" ? " (afternoon)" : ""}`;
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${a.getDate()}–${fmtDayMonth(b)}`;
  return `${fmtDayMonth(a)} – ${fmtDayMonth(b)}`;
}

/** What People, Pulse and the assignee picker say about someone who's away. */
export interface AwayNote {
  /** "Off today", "Off until Mon", "Off this afternoon", "Off from Thu" */
  label: string;
  /** "Off 11–15 Nov · back Mon 16 Nov" (plus the reason, for those who may read it) */
  title: string;
  /** off now (today), rather than soon */
  now: boolean;
  /** the private reason, when it reached this person */
  reason?: string;
}

/** Someone's time off as one short label: off today ("Off today", "Off until Mon"), or starting
 *  within the next `soonDays` days ("Off from Thu", "Off tomorrow"). Null when they're around. */
export function awayNote(user: string, todayISO: string, opts: { ws?: string | null; soonDays?: number } = {}, s: AvailabilityState = state): AwayNote | null {
  const soonDays = opts.soonDays ?? 7;
  const now = timeOffOn(user, todayISO, s);
  const reasonPart = (t: TimeOff) => (t.reason ? ` · ${t.reason}` : "");
  if (now) {
    // the whole stretch they're off from today (back-to-back entries read as one)
    let last = now.endsOn;
    if (now.halfDay) {
      const label = now.halfDay === "am" ? "Off this morning" : "Off this afternoon";
      return { label, title: `${label}${reasonPart(now)}`, now: true, reason: now.reason ?? undefined };
    }
    for (let i = 0; i < 40; i++) {
      const next = isoOf(addDays(localDay(last)!, 1));
      const t = s.timeOff.find((x) => x.userId === user && !x.halfDay && x.startsOn <= next && x.endsOn >= next);
      if (!t) break;
      last = t.endsOn;
    }
    const back = backOn(user, last, opts.ws, s);
    const backDay = localDay(back)!;
    const firstBack = dayDiff(localDay(todayISO)!, backDay);
    // "until" names the day they're back
    const label = last === todayISO ? "Off today" : firstBack < 7 ? `Off until ${WEEKDAY[isoWeekday(backDay)]}` : `Off until ${fmtDayMonth(backDay)}`;
    const span = last === todayISO ? "Off today" : `Off ${spanWords({ startsOn: now.startsOn < todayISO ? now.startsOn : todayISO, endsOn: last, halfDay: null })}`;
    return { label, title: `${span} · back ${WEEKDAY_LONG[isoWeekday(backDay)]} ${fmtDayMonth(backDay)}${reasonPart(now)}`, now: true, reason: now.reason ?? undefined };
  }
  const today = localDay(todayISO);
  if (!today) return null;
  const horizon = isoOf(addDays(today, soonDays));
  const soon = s.timeOff.filter((t) => t.userId === user && t.startsOn > todayISO && t.startsOn <= horizon)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0];
  if (!soon) return null;
  const when = dayWord(soon.startsOn, todayISO);
  const single = soon.startsOn === soon.endsOn;
  const label = single
    ? `Off ${when}${soon.halfDay === "am" ? " morning" : soon.halfDay === "pm" ? " afternoon" : ""}`
    : `Off from ${when}`;
  return { label, title: `Off ${spanWords(soon)}${reasonPart(soon)}`, now: false, reason: soon.reason ?? undefined };
}

/** The assignee picker's warning: is the person off on the day the work's due? "Off Thu",
 *  "Off tomorrow", "Off Thu 26 Nov" (or, with no date, whether they're off today). */
export function offOnDayNote(user: string, dueISO: string | null | undefined, todayISO: string, s: AvailabilityState = state): string | null {
  const day = dueISO ? dueISO.slice(0, 10) : todayISO;
  if (day < todayISO) return null;
  const t = timeOffOn(user, day, s);
  if (!t) return null;
  return `Off ${dayWord(day, todayISO)}${t.halfDay === "am" ? " morning" : t.halfDay === "pm" ? " afternoon" : ""}`;
}

/* ---------- capacity ---------- */

/** The person's capacity (hours) in the week starting `weekStart` (a Monday): their weekly hours,
 *  less the share of their working days they're off. */
export function capacityInWeek(ws: string | null | undefined, user: string, weekStart: Date, s: AvailabilityState = state): number {
  const w = weekOf(ws, user, s);
  const hours = w.weeklyHours ?? DEFAULT_WEEKLY_HOURS;
  let working = 0, off = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    if (!w.workDays.includes(isoWeekday(d))) continue;
    working++;
    off += offShare(user, isoOf(d), s);
  }
  if (!working) return round1(hours);
  return round1(hours * Math.max(0, working - off) / working);
}

/** Working days the person is off in that week (half days count a half). */
export function daysOffInWeek(ws: string | null | undefined, user: string, weekStart: Date, s: AvailabilityState = state): { off: number; working: number } {
  const w = weekOf(ws, user, s);
  let working = 0, off = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    if (!w.workDays.includes(isoWeekday(d))) continue;
    working++;
    off += offShare(user, isoOf(d), s);
  }
  return { off, working };
}

/** Everyone's capacity at a business for one week: its active owners, admins and members (guests
 *  carry none), and anyone with a week set there. */
export function weekCapacities(ws: string | null | undefined, weekStart: Date, s: AvailabilityState = state): Record<string, number> {
  const out: Record<string, number> = {};
  if (!ws) return out;
  const ids = new Set<string>();
  for (const [id, role] of Object.entries(s.roles[ws] ?? {})) if (role !== "guest") ids.add(id);
  for (const w of s.weeks) if (w.workspaceId === ws) ids.add(w.userId);
  for (const id of ids) out[id] = capacityInWeek(ws, id, weekStart, s);
  return out;
}

/* ---------- Today's working day ---------- */

/** Your working day: your week at the business on screen; in Personal, the span of your weeks
 *  everywhere (the earliest start to the latest end). 08:00–18:00 until one is set. */
export function myWorkingDay(s: AvailabilityState = state): { start: number; end: number } {
  if (!availabilityOn(s) || !s.me) return { start: DEFAULT_DAY_START, end: DEFAULT_DAY_END };
  if (s.activeWs) {
    const w = weekOf(s.activeWs, s.me, s);
    return { start: w.dayStart, end: w.dayEnd };
  }
  const mine = s.weeks.filter((w) => w.userId === s.me && s.roles[w.workspaceId]?.[s.me]);
  if (!mine.length) return { start: DEFAULT_DAY_START, end: DEFAULT_DAY_END };
  return { start: Math.min(...mine.map((w) => w.dayStart)), end: Math.max(...mine.map((w) => w.dayEnd)) };
}

/* ---------- who may do what (the server checks again) ---------- */

const leads = (role: Role | undefined) => role === "owner" || role === "admin";
const onTeam = (role: Role | undefined) => role === "owner" || role === "admin" || role === "member";

/** You set your own week (as an owner, admin or member there); owners and admins set anyone's but a guest's. */
export function canEditWeek(ws: string | null | undefined, user: string, s: AvailabilityState = state): boolean {
  if (!ws || !availabilityOn(s)) return false;
  const mine = roleOf(ws, s.me, s), theirs = roleOf(ws, user, s);
  if (!onTeam(theirs)) return false;
  return user === s.me ? onTeam(mine) : leads(mine);
}
/** Your own time off, or that of someone in a business you own or run. */
export function canEditTimeOff(user: string, s: AvailabilityState = state): boolean {
  if (!availabilityOn(s) || !s.me) return false;
  if (user === s.me) return true;
  return Object.values(s.roles).some((people) => leads(people[s.me]) && !!people[user]);
}
/** Does this person see others' time off at this business (not as a guest)? */
export const seesTimeOff = (ws: string | null | undefined, s: AvailabilityState = state): boolean =>
  availabilityOn(s) && onTeam(roleOf(ws, s.me, s));

/* ---------- bill rates ---------- */

/** Rates are for a business's owners and admins: everyone else sees hours only. */
export const canSeeRates = (ws: string | null | undefined, s: AvailabilityState = state): boolean =>
  availabilityOn(s) && leads(roleOf(ws, s.me, s));
export const defaultRate = (ws: string | null | undefined, s: AvailabilityState = state): number | null =>
  s.rates.find((r) => r.workspaceId === ws && r.projectId === null)?.rate ?? null;
export const projectRate = (ws: string | null | undefined, projectId: string, s: AvailabilityState = state): number | null =>
  s.rates.find((r) => r.workspaceId === ws && r.projectId === projectId)?.rate ?? null;
/** A project's hourly rate: its own, else the workspace's default, else 0. */
export const rateFor = (ws: string | null | undefined, projectId: string, s: AvailabilityState = state): number =>
  projectRate(ws, projectId, s) ?? defaultRate(ws, s) ?? 0;

/* ---------- capacities saved on this device, uploaded once ---------- */

/** The capacities this device can hand over: for each business where you're on the team, a
 *  person on its team (you, or anyone when you own or run it) whose week has no hours set yet.
 *  A value someone already shared is never overwritten. */
export function capacityUploads(local: Record<string, number>, s: AvailabilityState = state): { workspaceId: string; userId: string; hours: number }[] {
  const out: { workspaceId: string; userId: string; hours: number }[] = [];
  for (const [ws, people] of Object.entries(s.roles)) {
    const mine = people[s.me];
    if (!onTeam(mine)) continue;
    for (const [id, raw] of Object.entries(local)) {
      const hours = round1(Number(raw));
      if (!(hours >= MIN_WEEKLY_HOURS && hours <= MAX_WEEKLY_HOURS) || hours === DEFAULT_WEEKLY_HOURS) continue;
      if (!onTeam(people[id]) || (id !== s.me && !leads(mine))) continue;
      const row = s.weeks.find((w) => w.workspaceId === ws && w.userId === id);
      if (row && row.weeklyHours != null) continue;
      out.push({ workspaceId: ws, userId: id, hours });
    }
  }
  return out;
}
