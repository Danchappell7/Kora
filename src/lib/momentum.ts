/* ============================================================
   KANBO — momentum: wins, a gentle streak, kudos (0048).  [0048 contract → u10]
   • Wins recap: Friday afternoons (from 14:00) on Today, and Monday
     mornings (until 12:00) looking back at last week — what you finished,
     by project (with its identity), focus time, your streak, and the best
     collaboration moments (kudos given and received, people you unblocked,
     approvals you turned round). Shareable as text to Slack through the
     existing SlackPostButton when connected. Hideable (onboarding.momentum).
     A bank holiday or a day you've marked off moves it: the last working
     day of the week from 14:00, the first one until 12:00.
   • Streak: consecutive working days (Mon–Fri; England & Wales bank
     holidays and your own days off don't count against you) on which you
     planned your day or finished something. A small chip by Today's
     header; no guilt copy, no badges; hideable in Settings
     (profiles.onboarding.momentum.streakHidden; days off in .daysOff).
     Weekend work never adds to it (nobody should feel they have to).
   • Kudos: one tap (🎉 or another of KUDOS_EMOJI, optional note ≤ 140) on
     a teammate's finished task, from Pulse's "Done since yesterday" and the
     task panel. One per giver per task (tap again to take it back). Guests
     may give kudos too (a reaction, not content — the database allows it);
     suspended people can't. The recipient gets an Inbox item (kind
     "kudos", pref "kudos"); Pulse shows counts. Team tasks only; never to
     yourself. Kudos don't come back with a task restored from the bin.
     Another emoji or note changes your kudos in place (update_kudos: no
     new Inbox item, push or webhook); giving on one task over and over
     (give, Undo, give…) is held to a few an hour (kudosCooldownLeft).
   Everything date-based is pure and takes `now` (pin it in tests); the
   person's timezone defaults to Europe/London.
   Where "you planned your day" comes from: the days recorded on this
   device by markDayPlanned, only ever for a plan made that day — "Plan my
   day" (the host calls it), or Today seeing you put one of your open tasks
   on Today or give it a slot since it last looked that day (notePlans),
   or a plan you keep for today on a teammate's task (lib/planOverlay,
   which is kept day by day). An old "on Today" flag left on a task never
   counts: tasks keep it until they're taken off, finished or not.
   Finishing something is read from the tasks you own (assignee; done,
   completedAt), so that half follows you everywhere; a teammate finishing
   a task you only collaborate on isn't yours. Focus time comes from the focus timer's
   daily total, kept day by day here (noteFocusToday), or, when the timer
   wasn't used, from the time logged on / estimated for what you finished.
   Demo mode: fake kudos, a believable streak and a week of focus time
   built from the demo world (data/data.ts).
   ============================================================ */
import type { Activity, Kudos, KudosEmoji, KudosFailure, MomentumPrefs, Project, StreakInfo, Task, WinsMoment, WinsRecap } from "../data/types";
import { MEMBERS, PROJECTS, TASKS } from "../data/data";
import { kudosFailure, KUDOS_EMOJI, KUDOS_NOTE_MAX, parseKudos } from "./kudosRows";
import { readPlanOverlay } from "./planOverlay";
import { errText } from "./rowUtils";
import { supabase } from "./supabase";

export { parseKudos, kudosFailure, KUDOS_EMOJI, KUDOS_NOTE_MAX, KUDOS_PER_DAY } from "./kudosRows";

export const KUDOS_COLUMNS = "id,task_id,workspace_id,from_user,to_user,emoji,note,created_at";

/* ============================================================
   dates: local days in the person's timezone, as "YYYY-MM-DD"
   ============================================================ */

export const DEFAULT_TIMEZONE = "Europe/London";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const fmtCache = new Map<string, Intl.DateTimeFormat | null>();
function formatter(tz: string): Intl.DateTimeFormat | null {
  if (fmtCache.has(tz)) return fmtCache.get(tz)!;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch { f = null; }   // not a timezone this browser knows
  fmtCache.set(tz, f);
  return f;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayNum = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS;
const fromDayNum = (n: number) => { const d = new Date(n * DAY_MS); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

/** "YYYY-MM-DD" + n days (calendar days; no clocks involved, so no DST surprises). */
export function addDaysISO(iso: string, n: number): string { return fromDayNum(dayNum(iso) + n); }
/** ISO weekday of a local date: Monday 1 … Sunday 7. */
export function isoWeekday(iso: string): number { const w = new Date(dayNum(iso) * DAY_MS).getUTCDay(); return w === 0 ? 7 : w; }
/** The Monday of the week a date falls in. */
export function mondayOf(iso: string): string { return addDaysISO(iso, 1 - isoWeekday(iso)); }

export interface LocalMoment { date: string; hour: number; minute: number; weekday: number }

/** A moment as the person sees it: their local date, hour and weekday (unknown timezones: London, then the device). */
export function localMoment(at: Date, timezone?: string | null): LocalMoment {
  const f = formatter(timezone || DEFAULT_TIMEZONE) ?? formatter(DEFAULT_TIMEZONE);
  if (f && Number.isFinite(at.getTime())) {
    const p: Record<string, string> = {};
    for (const part of f.formatToParts(at)) p[part.type] = part.value;
    const date = `${p.year}-${p.month}-${p.day}`;
    if (DAY_RE.test(date)) {
      const hour = Number(p.hour) % 24;
      return { date, hour, minute: Number(p.minute) || 0, weekday: isoWeekday(date) };
    }
  }
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return { date, hour: at.getHours(), minute: at.getMinutes(), weekday: isoWeekday(date) };
}

/** The local day of a completedAt / createdAt value: a plain date stays as it is (demo
 *  data, older rows), a timestamp is read in the person's timezone. null when unreadable. */
export function localDayOf(value: string | null | undefined, timezone?: string | null): string | null {
  if (!value) return null;
  if (DAY_RE.test(value)) return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? localMoment(new Date(t), timezone).date : null;
}

/* ============================================================
   bank holidays (England & Wales) and working days
   ============================================================ */

/** England & Wales bank holidays (YYYY-MM-DD), 2026–2027, as published on gov.uk. */
export const UK_BANK_HOLIDAYS: readonly string[] = Object.freeze([
  "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
  "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28",
]);
const LISTED_YEARS = new Set(UK_BANK_HOLIDAYS.map((d) => d.slice(0, 4)));

/** Easter Sunday (the Gregorian computus). */
function easterSunday(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${pad(month)}-${pad(day)}`;
}

/** The usual England & Wales bank holidays of any year, by the standing rules (substitute
 *  days for a weekend New Year / Christmas / Boxing Day). One-off holidays (a coronation,
 *  a jubilee) aren't in it: the published list (UK_BANK_HOLIDAYS) wins for its years. */
export function ukBankHolidays(year: number): string[] {
  const y = String(year);
  if (LISTED_YEARS.has(y)) return UK_BANK_HOLIDAYS.filter((d) => d.startsWith(y));
  const out: string[] = [];
  const firstMon = (month: number) => { const d = `${y}-${pad(month)}-01`; return addDaysISO(d, (8 - isoWeekday(d)) % 7); };
  const lastMon = (month: number) => { const next = month === 12 ? `${year + 1}-01-01` : `${y}-${pad(month + 1)}-01`; const last = addDaysISO(next, -1); return addDaysISO(last, -((isoWeekday(last) + 6) % 7)); };
  const ny = `${y}-01-01`, nyW = isoWeekday(ny);
  out.push(nyW === 6 ? `${y}-01-03` : nyW === 7 ? `${y}-01-02` : ny);
  const easter = easterSunday(year);
  out.push(addDaysISO(easter, -2), addDaysISO(easter, 1));
  out.push(firstMon(5), lastMon(5), lastMon(8));
  const xmasW = isoWeekday(`${y}-12-25`);
  if (xmasW === 5) out.push(`${y}-12-25`, `${y}-12-28`);          // Boxing Day on Saturday → Monday
  else if (xmasW === 6) out.push(`${y}-12-27`, `${y}-12-28`);     // Christmas Sat → Mon, Boxing Day Sun → Tue
  else if (xmasW === 7) out.push(`${y}-12-26`, `${y}-12-27`);     // Christmas Sun → Tue (Boxing Day Mon)
  else out.push(`${y}-12-25`, `${y}-12-26`);
  return out.sort();
}

const holidayCache = new Map<string, Set<string>>();
export function isBankHoliday(date: string): boolean {
  if (!DAY_RE.test(date)) return false;
  const y = date.slice(0, 4);
  let set = holidayCache.get(y);
  if (!set) { set = new Set(ukBankHolidays(Number(y))); holidayCache.set(y, set); }
  return set.has(date);
}

/** Is this local date a working day for streaks? Mon–Fri, not a bank holiday, not one of your days off. */
export function isWorkingDay(date: string, prefs?: MomentumPrefs | null): boolean {
  if (!DAY_RE.test(date)) return false;
  if (isoWeekday(date) > 5) return false;
  if (isBankHoliday(date)) return false;
  return !(prefs?.daysOff ?? []).includes(date);
}

/** Why a day doesn't count (for the chip's week strip and its words), or null when it's a working day. */
export function dayOffReason(date: string, prefs?: MomentumPrefs | null): "weekend" | "bank_holiday" | "day_off" | null {
  if (!DAY_RE.test(date)) return null;
  if (isoWeekday(date) > 5) return "weekend";
  if (isBankHoliday(date)) return "bank_holiday";
  return (prefs?.daysOff ?? []).includes(date) ? "day_off" : null;
}

/* ============================================================
   the streak
   ============================================================ */

export interface StreakInput {
  now: Date;
  timezone?: string;
  /** local dates (YYYY-MM-DD) on which you planned your day (Plan my day / a planned task) */
  plannedDays: readonly string[];
  /** your finished tasks (completedAt) */
  completed: readonly Pick<Task, "completedAt">[];
  prefs?: MomentumPrefs | null;
}

/** How far back a streak is counted (in calendar days). */
export const STREAK_LOOKBACK_DAYS = 800;

/** Your finished tasks as far as the streak goes: done and assigned to you (a task you only
 *  collaborate on is someone else's to finish). */
export function streakCompleted<T extends Pick<Task, "status" | "assigneeId">>(tasks: readonly T[], userId: string): T[] {
  return userId ? tasks.filter((t) => !!t && t.status === "done" && t.assigneeId === userId) : [];
}

/** The days that count: planned, or something finished (in the person's timezone). */
function activeDays(plannedDays: readonly string[], completed: readonly Pick<Task, "completedAt">[], timezone?: string): Set<string> {
  const active = new Set<string>();
  for (const d of plannedDays) if (typeof d === "string" && DAY_RE.test(d)) active.add(d);
  for (const c of completed) { const d = localDayOf(c?.completedAt, timezone); if (d) active.add(d); }
  return active;
}

export function computeStreak(input: StreakInput): StreakInfo {
  const { now, timezone, prefs } = input;
  const today = localMoment(now, timezone).date;
  const active = activeDays(input.plannedDays ?? [], input.completed ?? [], timezone);
  const todayState: StreakInfo["today"] = !isWorkingDay(today, prefs) ? "off" : active.has(today) ? "done" : "pending";
  let days = 0;
  let since: string | null = null;
  // today counts once it's done; until then the run up to the last working day still stands
  let d = todayState === "done" ? today : addDaysISO(today, -1);
  for (let i = 0; i < STREAK_LOOKBACK_DAYS; i++, d = addDaysISO(d, -1)) {
    if (!isWorkingDay(d, prefs)) continue;   // weekends, bank holidays, days off: skipped, never a break
    if (!active.has(d)) break;
    days++;
    since = d;
  }
  return { days, today: todayState, since };
}

/** One weekday of the chip's week strip. */
export interface StreakDay {
  date: string;
  /** counted (in the run) · today, still open · a working day outside the run · not a working day · still to come */
  state: "done" | "pending" | "missed" | "off" | "future";
  offReason?: "weekend" | "bank_holiday" | "day_off";
}

/** Monday to Friday of this week as the chip draws them (from the streak; never red, never
 *  "missed" in words). `active`: the days that counted (activeDaysFor), when known — then a
 *  day before a break still shows as counted. */
export function streakWeek(streak: StreakInfo, now: Date, timezone?: string | null, prefs?: MomentumPrefs | null, active?: Iterable<string> | null): StreakDay[] {
  const today = localMoment(now, timezone).date;
  const mon = mondayOf(today);
  const known = active ? new Set(active) : null;
  return [0, 1, 2, 3, 4].map((i): StreakDay => {
    const date = addDaysISO(mon, i);
    const off = dayOffReason(date, prefs);
    if (date > today) return off ? { date, state: "future", offReason: off } : { date, state: "future" };
    if (off) return { date, state: "off", offReason: off };
    if (date === today) return { date, state: streak.today === "done" ? "done" : "pending" };
    const counted = known ? known.has(date) : !!streak.since && date >= streak.since && streak.days > 0;
    return { date, state: counted ? "done" : "missed" };
  });
}

/** The local days that count towards a streak (planned, or something finished), for streakWeek. */
export function activeDaysFor(plannedDays: readonly string[], completed: readonly Pick<Task, "completedAt">[], timezone?: string): string[] {
  return [...activeDays(plannedDays, completed, timezone)].sort();
}

/** "4-day streak" */
export function streakLabel(days: number): string { return `${days}-day streak`; }

/* ============================================================
   the wins recap
   ============================================================ */

export type RecapWindow = { kind: WinsRecap["kind"]; from: string; to: string };

/** Which recap (if any) Today shows now: the week's last working day from 14:00 → this week
 *  (kind "friday"); its first working day until 12:00 → last week, Monday to Sunday (kind
 *  "monday"). Usually Friday and Monday; a bank holiday or a day off moves them. */
export function recapWindow(now: Date, timezone?: string, prefs?: MomentumPrefs | null): RecapWindow | null {
  const { date, hour } = localMoment(now, timezone);
  const mon = mondayOf(date);
  const working = [0, 1, 2, 3, 4].map((i) => addDaysISO(mon, i)).filter((d) => isWorkingDay(d, prefs));
  if (!working.length) return null;
  if (date === working[0] && hour < 12) return { kind: "monday", from: addDaysISO(mon, -7), to: addDaysISO(mon, -1) };
  if (date === working[working.length - 1] && hour >= 14) return { kind: "friday", from: mon, to: date };
  return null;
}

/** An approval you decided (optional input; the panel's history or list_my_approvals). */
export interface ApprovalMoment { taskId: string; title: string; requesterId: string | null; decidedAt: string; decision: "approved" | "changes_requested" }

export interface WinsInput {
  now: Date;
  timezone?: string;
  currentUserId: string;
  /** your tasks (what you finished, and the streak, come from these alone) */
  tasks: readonly Task[];
  /** every task you can see, your teammates' too: the titles of the kudos you gave, and who was waiting on
   *  your work ("You unblocked Maya"). Default: `tasks` (then those two moments can only find your own). */
  seen?: readonly Task[];
  projects: readonly Pick<Project, "id" | "name" | "emoji" | "color">[];
  kudos: readonly Kudos[];
  plannedDays: readonly string[];
  prefs?: MomentumPrefs | null;
  /** people's names for the moments' text */
  nameOf: (userId: string) => string;
  /** focus-timer minutes per local day (readFocusLog); without any, focus comes from what you finished */
  focusLog?: Readonly<Record<string, number>>;
  /** approvals you turned round */
  approvals?: readonly ApprovalMoment[];
  /** a window other than recapWindow(now) (e.g. "this week so far" in the demo) */
  window?: RecapWindow;
}

/** buildWinsRecap's answer: the contract's WinsRecap and a few things the card and the text use. */
export interface MomentumRecap extends WinsRecap {
  /** where focusMinutes came from: the focus timer, or the time on what you finished */
  focusFrom: "timer" | "tasks";
  /** project id → name (for the text) */
  projectNames: Record<string, string>;
  /** kudos you received in the window */
  kudosReceived: number;
  /** "this week so far" (outside the usual Friday/Monday window) */
  preview?: boolean;
}

const firstName = (name: string) => { const n = (name || "").trim(); return n.includes("@") ? n : n.split(/\s+/)[0] || "Someone"; };
const quote = (s: string) => `“${s}”`;
/** "Sana" · "Sana and Maya" · "Sana, Maya and Theo" · "Sana, Maya and 2 others" */
export function nameList(names: readonly string[]): string {
  const n = [...new Set(names.filter(Boolean))];
  if (n.length <= 1) return n[0] ?? "";
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]}`;
  return `${n[0]}, ${n[1]} and ${n.length - 2} others`;
}
const mineToFinish = (t: Pick<Task, "assigneeId" | "collaborators">, me: string) => t.assigneeId === me || (t.collaborators ?? []).includes(me);

export function buildWinsRecap(input: WinsInput): MomentumRecap | null {
  const { now, timezone, currentUserId: me, prefs } = input;
  if (!me) return null;
  const win = input.window ?? recapWindow(now, timezone, prefs);
  if (!win) return null;
  const inWin = (value: string | null | undefined) => { const d = localDayOf(value, timezone); return !!d && d >= win.from && d <= win.to; };
  const tasks = input.tasks ?? [];
  // titles and who's waiting are looked up in everything you can see (kudos you gave are on teammates' tasks)
  const seen = input.seen && input.seen !== tasks ? [...tasks, ...input.seen] : tasks;
  const byId = new Map(seen.map((t) => [t.id, t]));
  const lookup = [...byId.values()];
  const titleOf = (id: string) => byId.get(id)?.title?.trim() || "a task";

  const mineDone = tasks.filter((t) => t.status === "done" && mineToFinish(t, me));
  const done = mineDone.filter((t) => inWin(t.completedAt))
    .sort((a, b) => String(b.completedAt ?? "").localeCompare(String(a.completedAt ?? "")) || a.title.localeCompare(b.title));

  // by project, biggest first (ties by name)
  const projectNames: Record<string, string> = {};
  for (const p of input.projects ?? []) projectNames[p.id] = p.name;
  const groups = new Map<string, { id: string; title: string }[]>();
  for (const t of done) {
    const list = groups.get(t.projectId) ?? [];
    list.push({ id: t.id, title: t.title });
    groups.set(t.projectId, list);
  }
  const byProject = [...groups.entries()]
    .map(([projectId, list]) => ({ projectId, count: list.length, tasks: list }))
    .sort((a, b) => b.count - a.count || (projectNames[a.projectId] ?? "").localeCompare(projectNames[b.projectId] ?? ""));

  // focus: the timer's minutes on these days, else the time on what you finished
  let timer = 0;
  if (input.focusLog) for (const [day, min] of Object.entries(input.focusLog)) if (day >= win.from && day <= win.to && Number(min) > 0) timer += Number(min);
  let focusMinutes = Math.round(timer);
  let focusFrom: MomentumRecap["focusFrom"] = "timer";
  if (focusMinutes <= 0) {
    focusFrom = "tasks";
    const est = done.reduce((s, t) => s + (t.loggedHours && t.loggedHours > 0 ? t.loggedHours * 60 : Math.max(0, t.focusMin || 0)), 0);
    focusMinutes = Math.round(est / 15) * 15;
  }

  // collaboration moments: kudos you got, people you unblocked or helped, approvals, kudos you gave
  const name = (id: string) => firstName(input.nameOf(id) || "Someone");
  const kudos = (input.kudos ?? []).filter((k) => inWin(k.createdAt));
  const received = kudos.filter((k) => k.toUser === me && k.fromUser !== me)
    .sort((a, b) => (b.note ? 1 : 0) - (a.note ? 1 : 0) || b.createdAt.localeCompare(a.createdAt));
  const given = kudos.filter((k) => k.fromUser === me && k.toUser !== me).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const moments: WinsMoment[] = [];
  const receivedLine = (k: Kudos): WinsMoment => ({
    kind: "kudos_received", taskId: k.taskId, userId: k.fromUser,
    text: `${name(k.fromUser)} sent you ${k.emoji} for ${quote(titleOf(k.taskId))}${k.note ? ` — ${quote(k.note)}` : ""}`,
  });
  if (received.length) moments.push(receivedLine(received[0]));
  if (received.length === 2) moments.push(receivedLine(received[1]));
  else if (received.length > 2) {
    const rest = received.slice(1);
    moments.push({ kind: "kudos_received", text: `${rest.length} more kudos from ${nameList(rest.map((k) => name(k.fromUser)))}` });
  }
  const unblocked = done.filter((t) => t.assigneeId === me)
    .map((t) => ({ t, waiting: lookup.find((x) => x.id !== t.id && (x.dependencies ?? []).includes(t.id) && x.assigneeId && x.assigneeId !== me) }))
    .find((x) => !!x.waiting);
  if (unblocked?.waiting) {
    moments.push({ kind: "unblocked", taskId: unblocked.t.id, userId: unblocked.waiting.assigneeId,
      text: `You unblocked ${name(unblocked.waiting.assigneeId)}: ${quote(unblocked.t.title)} was holding up ${quote(unblocked.waiting.title)}` });
  }
  const helped = done.find((t) => t.assigneeId && t.assigneeId !== me && (t.collaborators ?? []).includes(me));
  if (helped) moments.push({ kind: "helped", taskId: helped.id, userId: helped.assigneeId, text: `You helped ${name(helped.assigneeId)} finish ${quote(helped.title)}` });
  const approval = (input.approvals ?? []).filter((a) => inWin(a.decidedAt)).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
  if (approval) {
    const whose = approval.requesterId && approval.requesterId !== me ? `${name(approval.requesterId)}'s` : "the";
    moments.push({ kind: "approval", taskId: approval.taskId, userId: approval.requesterId ?? undefined,
      text: approval.decision === "approved" ? `You turned round ${whose} approval on ${quote(approval.title)}` : `You reviewed ${quote(approval.title)} and asked for changes` });
  }
  if (given.length === 1) {
    moments.push({ kind: "kudos_given", taskId: given[0].taskId, userId: given[0].toUser, text: `You thanked ${name(given[0].toUser)} for ${quote(titleOf(given[0].taskId))}` });
  } else if (given.length > 1) {
    moments.push({ kind: "kudos_given", text: `You sent kudos to ${nameList(given.map((k) => name(k.toUser)))}` });
  }

  if (!done.length && !moments.length && !(focusFrom === "timer" && focusMinutes > 0)) return null;

  const streak = computeStreak({ now, timezone, plannedDays: input.plannedDays ?? [], completed: streakCompleted(tasks, me), prefs });
  return {
    kind: win.kind, from: win.from, to: win.to, total: done.length, byProject, focusMinutes, streak,
    moments: moments.slice(0, 3), focusFrom, projectNames, kudosReceived: received.length,
    ...(input.window && !recapWindow(now, timezone, prefs) ? { preview: true } : {}),
  };
}

/* ---------- words ---------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** "5–9 Oct" · "28 Sep – 4 Oct" · "29 Dec 2025 – 2 Jan 2026" */
export function rangeLabel(from: string, to: string): string {
  const d = (iso: string) => +iso.slice(8, 10), m = (iso: string) => MONTHS[+iso.slice(5, 7) - 1] ?? "", y = (iso: string) => iso.slice(0, 4);
  if (from === to) return `${WEEKDAYS[isoWeekday(from) - 1]} ${d(from)} ${m(from)}`;
  if (y(from) !== y(to)) return `${d(from)} ${m(from)} ${y(from)} – ${d(to)} ${m(to)} ${y(to)}`;
  if (m(from) === m(to)) return `${d(from)}–${d(to)} ${m(to)}`;
  return `${d(from)} ${m(from)} – ${d(to)} ${m(to)}`;
}
/** "Fri 9 Oct" */
export function dayLabel(iso: string): string { return `${WEEKDAYS[isoWeekday(iso) - 1]} ${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1] ?? ""}`; }

/** "9h 30m" · "45m" · "2h" */
export function focusLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** The card's (and the text's) heading: "Your week's wins" · "Last week's wins" · "Your week so far". */
export function recapTitle(recap: Pick<MomentumRecap, "kind"> & { preview?: boolean }): string {
  if (recap.preview) return "Your week so far";
  return recap.kind === "monday" ? "Last week's wins" : "Your week's wins";
}

/** The card's opening line: "This week you finished 12 things across Launch, Brand and Infra." */
export function recapHeadline(recap: Pick<MomentumRecap, "kind" | "total" | "byProject" | "projectNames"> & { preview?: boolean }): string {
  const when = recap.kind === "monday" ? "Last week" : "This week";
  if (!recap.total) return recap.kind === "monday" ? "Last week was more about the people than the list." : "A week more about the people than the list.";
  const things = `${recap.total} ${recap.total === 1 ? "thing" : "things"}`;
  const names = recap.byProject.map((p) => recap.projectNames[p.projectId]).filter(Boolean) as string[];
  const where = names.length === 1 ? ` in ${names[0]}` : names.length > 1 && names.length <= 3 ? ` across ${nameList(names)}` : names.length > 3 ? ` across ${names.length} projects` : "";
  return `${when} you finished ${things}${where}.`;
}

/** The recap as plain text for Slack ("This week: 12 done across Launch and Brand…"). The
 *  first line is bold, so the Slack post uses it as its heading. Kudos notes and other
 *  people's words stay out of it; `name` (yours) makes the heading "Daniel's week". */
export function winsRecapText(recap: WinsRecap, opts: { name?: string; projectName?: (id: string) => string | undefined; showStreak?: boolean; maxTitles?: number } = {}): string {
  const r = recap as Partial<MomentumRecap> & WinsRecap;
  const projectName = (id: string) => opts.projectName?.(id) ?? r.projectNames?.[id] ?? "Other work";
  const who = opts.name?.trim() ? `${firstName(opts.name)}'s` : "My";
  const heading = r.preview ? `${who} week so far` : `${who} week`;
  const lines: string[] = [`*${heading} · ${rangeLabel(r.from, r.to)}*`];
  if (r.total) {
    const parts = r.byProject.map((p) => `${projectName(p.projectId)} (${p.count})`);
    lines.push(`✅ ${r.total} done${parts.length ? ` across ${nameList(parts.length > 4 ? [...parts.slice(0, 3), `${parts.length - 3} more`] : parts)}` : ""}`);
  }
  if (r.focusMinutes > 0) lines.push(`⏱️ ${focusLabel(r.focusMinutes)} of focus time`);
  if (opts.showStreak !== false && r.streak.days >= 2) lines.push(`📅 ${r.streak.days} working days in a row`);
  if (r.kudosReceived) lines.push(`🎉 ${r.kudosReceived} kudos from the team`);
  const max = Math.max(1, opts.maxTitles ?? 4);
  if (r.byProject.length) {
    lines.push("", "*Finished*");
    for (const p of r.byProject) {
      const shown = p.tasks.slice(0, max).map((t) => t.title.trim() || "Untitled task");
      lines.push(`• ${projectName(p.projectId)}: ${shown.join(", ")}${p.tasks.length > max ? ` +${p.tasks.length - max} more` : ""}`);
    }
  }
  return lines.join("\n");
}

/* ============================================================
   kudos: pure helpers
   ============================================================ */

/** Kudos per person since a moment (Pulse's counts): received and given. */
export function kudosCounts(kudos: readonly Kudos[], sinceIso: string): Record<string, { received: number; given: number }> {
  const out: Record<string, { received: number; given: number }> = {};
  const since = Date.parse(sinceIso);
  for (const k of kudos) {
    if (Number.isFinite(since) && Date.parse(k.createdAt) < since) continue;
    (out[k.toUser] ??= { received: 0, given: 0 }).received++;
    (out[k.fromUser] ??= { received: 0, given: 0 }).given++;
  }
  return out;
}

/** A task's kudos, oldest first. */
export function kudosOnTask(kudos: readonly Kudos[], taskId: string): Kudos[] {
  return kudos.filter((k) => k.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Swap one task's kudos in a workspace list (after a give / take back). */
export function replaceTaskKudos(all: readonly Kudos[], taskId: string, next: readonly Kudos[]): Kudos[] {
  return [...all.filter((k) => k.taskId !== taskId), ...next.filter((k) => k.taskId === taskId)];
}

/** Can this person give kudos on this task (the database's rules, so the button never offers what it refuses)? */
export function canGiveKudos(task: Pick<Task, "status" | "assigneeId" | "workspaceId">, currentUserId: string): boolean {
  return !!currentUserId && task.status === "done" && !!task.workspaceId && !!task.assigneeId && task.assigneeId !== currentUserId;
}

/** The words for a failure (British English). */
export function kudosErrorText(reason: KudosFailure): string {
  switch (reason) {
    case "not_allowed": return "You can't send kudos here.";
    case "not_found": return "That task isn't there any more.";
    case "not_done": return "Kudos are for finished tasks.";
    case "team_only": return "Kudos are for tasks in a team workspace.";
    case "self": return "Kudos are for your teammates.";
    case "too_many": return "That's a lot of kudos for one day. Try again tomorrow.";
    case "invalid": return `Kudos need one of the emoji, and a note of ${KUDOS_NOTE_MAX} characters or fewer.`;
    case "unavailable": return "Kudos aren't switched on yet.";
    case "network": return "You're offline. Try again when you're back online.";
    default: return "Couldn't send kudos. Try again.";
  }
}

/* ============================================================
   this device: the days you planned, and your focus time per day
   ============================================================ */

const DEMO_ME = "m-self";
const plannedKey = (userId: string) => `kanbo-momentum-planned:${userId || "local"}`;
const focusLogKey = (userId: string) => `kanbo-momentum-focus:${userId || "local"}`;
/** How many planned days / focus days are kept on this device. */
const KEEP_PLANNED = 400, KEEP_FOCUS_DAYS = 42;

function readJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode, or full: remembered for this visit only */ }
}
const memPlanned = new Map<string, string[]>();
const memFocus = new Map<string, Record<string, number>>();

/** The demo's believable history: the last six working days planned (so the chip reads
 *  a week-long streak), and some focus time on most of this week's days. */
function demoPlanned(now: Date): string[] {
  const out: string[] = [];
  let d = addDaysISO(localMoment(now).date, -1);
  for (let i = 0; out.length < 6 && i < 30; i++, d = addDaysISO(d, -1)) if (isWorkingDay(d)) out.push(d);
  return out.sort();
}
function demoFocus(now: Date): Record<string, number> {
  const today = localMoment(now).date;
  const mon = mondayOf(today);
  const mins = [95, 140, 60, 120, 75];
  const out: Record<string, number> = {};
  for (let i = 0; i < 5; i++) { const d = addDaysISO(mon, i); if (d < today && isWorkingDay(d)) out[d] = mins[i]; }
  // last week too, for the Monday look-back
  for (let i = 0; i < 5; i++) { const d = addDaysISO(mon, i - 7); if (isWorkingDay(d)) out[d] = mins[(i + 2) % 5]; }
  return out;
}
const isDemo = () => !supabase;

/** The local dates you planned your day (this device), oldest first. */
export function readPlannedDays(userId: string, now: Date = new Date()): string[] {
  const key = plannedKey(userId);
  const v = readJson(key);
  const stored = Array.isArray(v) ? v.filter((d): d is string => typeof d === "string" && DAY_RE.test(d)) : null;
  const mem = memPlanned.get(key);
  const list = stored ?? mem ?? (isDemo() && userId === DEMO_ME ? demoPlanned(now) : []);
  return [...new Set(list)].sort();
}

/** Record that you planned this day (Today does when it sees a plan; "Plan my day" should too). */
export function markDayPlanned(userId: string, day?: string, now: Date = new Date(), timezone?: string): string[] {
  const d = day && DAY_RE.test(day) ? day : localMoment(now, timezone).date;
  const list = readPlannedDays(userId, now);
  if (list.includes(d)) return list;
  const next = [...list, d].sort().slice(-KEEP_PLANNED);
  const key = plannedKey(userId);
  memPlanned.set(key, next);
  writeJson(key, next);
  return next;
}

/* ---------- did you plan your day? (only a plan made that day counts) ---------- */

type PlanTask = Pick<Task, "id" | "assigneeId" | "status" | "archivedAt" | "planToday" | "scheduled">;
/** What's planned on one task: "" (nothing), "p" (on Today), "s540" (a slot), "ps540" (both). */
const planSig = (t: Pick<Task, "planToday" | "scheduled">) =>
  `${t.planToday === true ? "p" : ""}${typeof t.scheduled === "number" && Number.isFinite(t.scheduled) ? `s${Math.round(t.scheduled)}` : ""}`;

/** Your open tasks' plans — assigned to you, not done, not archived — as task id → what's
 *  planned on it ("" for nothing yet, so a later plan on it can be told from a new task). */
export function planSnapshot(tasks: readonly PlanTask[], userId: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!userId) return out;
  for (const t of tasks) if (t?.id && t.assigneeId === userId && t.status !== "done" && !t.archivedAt) out[t.id] = planSig(t);
  return out;
}

/** Between two looks at your open tasks, did you plan something: put one on Today, or give one
 *  a (new) slot? A task that has only just appeared (new, reopened, handed to you, or the list
 *  arriving) and a plan taken away don't count. */
export function plannedBetween(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): boolean {
  for (const [id, now] of Object.entries(after)) {
    if (!now || !Object.prototype.hasOwnProperty.call(before, id)) continue;
    const was = before[id] ?? "";
    if (now === was) continue;
    const slot = /s(\d+)/.exec(now)?.[1], wasSlot = /s(\d+)/.exec(was)?.[1];
    if ((now.startsWith("p") && !was.startsWith("p")) || (slot !== undefined && slot !== wasSlot)) return true;
  }
  return false;
}

/** Your own plan for today on teammates' tasks (lib/planOverlay keeps those day by day, so
 *  one there was made for today). */
function overlayPlannedFor(userId: string, day: string): boolean {
  try {
    return Object.values(readPlanOverlay(userId, day)).some((e) => e?.planToday === true || (typeof e?.scheduled === "number" && Number.isFinite(e.scheduled)));
  } catch { return false; }
}

const plansSeenKey = (userId: string) => `kanbo-momentum-plans:${userId || "local"}`;
const memPlansSeen = new Map<string, { day: string; plans: Record<string, string> }>();
function readPlansSeen(key: string): { day: string; plans: Record<string, string> } | null {
  const mem = memPlansSeen.get(key);
  if (mem) return mem;
  const v = readJson(key) as { day?: unknown; plans?: unknown } | null;
  if (!v || typeof v.day !== "string" || !DAY_RE.test(v.day) || !v.plans || typeof v.plans !== "object" || Array.isArray(v.plans)) return null;
  const plans: Record<string, string> = {};
  for (const [id, s] of Object.entries(v.plans as Record<string, unknown>)) if (typeof s === "string" && /^p?(s\d+)?$/.test(s)) plans[id] = s;
  return { day: v.day, plans };
}

/** Today looks at your tasks (whenever they change): when, since its last look on the same day
 *  (this visit, or an earlier one on this device), you put one of your open tasks on Today or
 *  gave it a slot — or you have a plan for today on a teammate's task — the day is recorded as
 *  planned (markDayPlanned). A day's first look only remembers what's planned: an old "on
 *  Today" flag never counts. True when today is (now) recorded. */
export function notePlans(userId: string, tasks: readonly PlanTask[], now: Date = new Date(), timezone?: string): boolean {
  if (!userId) return false;
  const day = localMoment(now, timezone).date;
  const key = plansSeenKey(userId);
  const after = planSnapshot(tasks ?? [], userId);
  const before = readPlansSeen(key);
  const planned = (!!before && before.day === day && plannedBetween(before.plans, after)) || overlayPlannedFor(userId, day);
  // (no open tasks yet — the list still loading — keeps the last look rather than forgetting it)
  if (Object.keys(after).length && (!before || before.day !== day || JSON.stringify(before.plans) !== JSON.stringify(after))) {
    const seen = { day, plans: after };
    memPlansSeen.set(key, seen);
    writeJson(key, seen);
  }
  if (!planned) return readPlannedDays(userId, now).includes(day);
  markDayPlanned(userId, day, now, timezone);
  return true;
}

/** Focus-timer minutes per local day (this device). */
export function readFocusLog(userId: string, now: Date = new Date()): Record<string, number> {
  const key = focusLogKey(userId);
  const v = readJson(key);
  const out: Record<string, number> = {};
  const src = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : memFocus.get(key) ?? (isDemo() && userId === DEMO_ME ? demoFocus(now) : {});
  for (const [d, m] of Object.entries(src)) if (DAY_RE.test(d) && typeof m === "number" && Number.isFinite(m) && m > 0) out[d] = Math.round(m);
  return out;
}

/** Copy today's focus-timer total (hooks/useFocusTimer keeps only today's, under
 *  "kanbo-focus-stat:<user>" as { date: "Y-M-D", min }) into the day-by-day log. */
export function noteFocusToday(userId: string, now: Date = new Date()): Record<string, number> {
  const log = readFocusLog(userId, now);
  const stat = readJson(`kanbo-focus-stat:${userId || "local"}`) as { date?: unknown; min?: unknown } | null;
  const m = typeof stat?.date === "string" ? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(stat.date) : null;
  const min = Number(stat?.min);
  if (!m || !Number.isFinite(min) || min <= 0) return log;
  const day = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  if (log[day] === Math.round(min)) return log;
  const next: Record<string, number> = { ...log, [day]: Math.round(min) };
  const keep = Object.keys(next).sort().slice(-KEEP_FOCUS_DAYS);
  const trimmed: Record<string, number> = {};
  for (const d of keep) trimmed[d] = next[d];
  const key = focusLogKey(userId);
  memFocus.set(key, trimmed);
  writeJson(key, trimmed);
  return trimmed;
}

/** The most days off kept (the oldest go first) — years of them, and well inside
 *  profiles.onboarding's 16 KB. */
export const DAYS_OFF_MAX = 400;

/** The patch for profiles.onboarding (merge_onboarding replaces the whole `momentum` key, so send it all). */
export function momentumPatch(next: MomentumPrefs): { momentum: MomentumPrefs } {
  const out: MomentumPrefs = {};
  if (next.streakHidden !== undefined) out.streakHidden = !!next.streakHidden;
  if (next.recapHidden !== undefined) out.recapHidden = !!next.recapHidden;
  if (next.daysOff) out.daysOff = [...new Set(next.daysOff.filter((d) => typeof d === "string" && DAY_RE.test(d)))].sort().slice(-DAYS_OFF_MAX);
  return { momentum: out };
}

/** Days off, tidied for saving: valid, once each, in order, and only those a streak can still
 *  reach (it looks back STREAK_LOOKBACK_DAYS; older ones can never matter), at most
 *  DAYS_OFF_MAX. Editing your days off never drops one a run still stands on. */
export function tidyDaysOff(daysOff: readonly string[] | undefined, today: string): string[] {
  const floor = addDaysISO(today, -STREAK_LOOKBACK_DAYS);
  return [...new Set((daysOff ?? []).filter((d) => typeof d === "string" && DAY_RE.test(d) && d >= floor))].sort().slice(-DAYS_OFF_MAX);
}

/* ============================================================
   kudos: data (Supabase, or the demo's in-memory fakes)
   ============================================================ */

/** How many kudos listKudos reads at most (newest first). */
export const KUDOS_LIST_LIMIT = 1000;
let schemaMissing = false;
/** 0048 without update_kudos: a change of emoji / note is a take back + give (this session) */
let updateMissing = false;
let channelSeq = 0;

let DEMO_DELAY_MS = 180;
const wait = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
const err = (message: string) => new Error(message);
const listeners = new Set<{ ws: string; fn: () => void }>();
const tell = (ws: string) => { for (const l of [...listeners]) if (l.ws === ws) { try { l.fn(); } catch { /* a listener's problem */ } } };

/* ---------- the re-give cooldown (this session) ----------
   Each give is a new Inbox item for the recipient, a push / email and a kudos.given webhook,
   and taking it back only removes the Inbox item: so giving on one task again and again
   (give, Undo, give…) is held to KUDOS_REGIVES_PER_TASK an hour. Changing the emoji or note
   in place (updateKudos) isn't a give. The database keeps its own limits. */
export const KUDOS_REGIVES_PER_TASK = 3;
export const KUDOS_REGIVE_WINDOW_MS = 60 * 60_000;
const gaveAt = new Map<string, number[]>();
const recentGives = (taskId: string, now: number) => (gaveAt.get(taskId) ?? []).filter((t) => t > now - KUDOS_REGIVE_WINDOW_MS && t <= now);
function noteGive(taskId: string): void {
  const now = Date.now();
  gaveAt.set(taskId, [...recentGives(taskId, now), now]);
}
/** How long until you may give kudos on this task again (ms); 0: now. */
export function kudosCooldownLeft(taskId: string, now: number = Date.now()): number {
  const recent = recentGives(taskId, now);
  if (recent.length < KUDOS_REGIVES_PER_TASK) return 0;
  return Math.max(0, recent[recent.length - KUDOS_REGIVES_PER_TASK] + KUDOS_REGIVE_WINDOW_MS - now);
}
const cooldownError = (ms: number) => Object.assign(err("kudos cooldown"), { code: "kudos_cooldown", retryInMs: ms });
/** A give held back by the cooldown (this session's, or the database's 'kudos cooldown'). */
export function isKudosCooldown(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "kudos_cooldown" || /kudos cooldown/i.test(errText(e));
}
/** A change of emoji / note whose old kudos was taken back before the new one failed. */
export function kudosTookBack(e: unknown): boolean {
  return !!(e && typeof e === "object" && (e as { tookBack?: unknown }).tookBack === true);
}
/** What to say when giving, changing or taking back kudos fails (British English). */
export function kudosProblemText(e: unknown): string {
  if (isKudosCooldown(e)) return "You've sent kudos for this a few times just now. Try again later.";
  return kudosErrorText(kudosFailure(e));
}

type DemoTask = { id: string; title: string; status: Task["status"]; assigneeId: string; workspaceId: string | null; collaborators: string[] };
const demoTasks = new Map<string, DemoTask>();
let demoRows: Kudos[] | null = null;
let demoSeq = 0;
const agoIso = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const memberName = (id: string) => MEMBERS.find((m) => m.id === id)?.name ?? "Someone";
const wsOfProject = (projectId: string) => PROJECTS.find((p) => p.id === projectId)?.workspaceId ?? null;

function demoTask(taskId: string): DemoTask | null {
  const seen = demoTasks.get(taskId);
  if (seen) return seen;
  const t = TASKS.find((x) => x.id === taskId);
  return t ? { id: t.id, title: t.title, status: t.status, assigneeId: t.assigneeId, workspaceId: t.workspaceId ?? wsOfProject(t.projectId), collaborators: t.collaborators ?? [] } : null;
}

/** Demo mode: tell the fakes about a task as the app has it now (finished in this session,
 *  reassigned…), so kudos follow the same rules as the database. Real mode ignores it. */
export function rememberKudosTask(t: Pick<Task, "id" | "title" | "status" | "assigneeId"> & { workspaceId?: string | null; collaborators?: string[]; projectId?: string }): void {
  if (supabase) return;
  demoTasks.set(t.id, {
    id: t.id, title: t.title, status: t.status, assigneeId: t.assigneeId,
    workspaceId: t.workspaceId !== undefined ? t.workspaceId ?? null : t.projectId ? wsOfProject(t.projectId) : demoTask(t.id)?.workspaceId ?? null,
    collaborators: t.collaborators ?? [],
  });
}

/* Foundrise this week: Maya and Sana thanked you for the launch budget and the launch date,
   you thanked Sana for the new palette, and Maya loved Theo's demo video (yours to add to). */
function seedDemo(): Kudos[] {
  const k = (id: string, taskId: string, fromUser: string, toUser: string, emoji: KudosEmoji, note: string | null, minutes: number): Kudos => ({
    id, taskId, workspaceId: demoTask(taskId)?.workspaceId ?? "ws-foundrise", fromUser, toUser, emoji, note, createdAt: agoIso(minutes),
  });
  return [
    k("kd-demo-1", "t-12", "m-1", DEMO_ME, "👏", "Thanks for turning the budget round so fast", 22 * 60),
    k("kd-demo-2", "t-13", "m-3", DEMO_ME, "🎉", null, 44 * 60),
    k("kd-demo-3", "t-16", DEMO_ME, "m-3", "🙌", "The new palette sings", 20 * 60),
    k("kd-demo-4", "t-24", "m-1", "m-2", "🔥", "The demo looks brilliant", 50),
    k("kd-demo-5", "t-16", "m-1", "m-3", "⭐", null, 19 * 60),
  ];
}
const rows = () => (demoRows ??= seedDemo());
const withNames = (k: Kudos): Kudos => ({ ...k, fromName: memberName(k.fromUser), toName: memberName(k.toUser) });

/** Demo Inbox items for the kudos you received (kind "kudos", newest first) — store.ts can add
 *  these to its demo activity so the Inbox shows them. */
export function demoKudosActivity(): Activity[] {
  return rows().filter((k) => k.toUser === DEMO_ME).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((k, i) => ({
    id: `a-${k.id}`, taskId: k.taskId, taskTitle: demoTask(k.taskId)?.title ?? "a task", kind: "kudos", detail: memberName(k.fromUser),
    createdAt: k.createdAt, ...(i > 0 ? { readAt: k.createdAt } : {}), meta: { kudosId: k.id, emoji: k.emoji, note: k.note },
  }));
}

/** Tests: forget the demo's changes (and, optionally, make it answer at once). */
export function resetKudosDemo(opts: { demoDelayMs?: number } = {}): void {
  demoRows = null; demoSeq = 0; demoTasks.clear(); schemaMissing = false; updateMissing = false; listeners.clear();
  memPlanned.clear(); memFocus.clear(); memPlansSeen.clear(); gaveAt.clear();
  if (opts.demoDelayMs !== undefined) DEMO_DELAY_MS = opts.demoDelayMs;
}

const isMissingTable = (e: unknown) => {
  const code = String((e as { code?: unknown })?.code ?? "");
  return code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205" || kudosFailure(e) === "unavailable";
};

/** Kudos in a workspace (optionally since a moment, or for some tasks), newest first. Demo: fakes.
 *  Before 0048 (or for Personal): []. */
export async function listKudos(workspaceId: string, opts: { since?: string; taskIds?: string[] } = {}): Promise<Kudos[]> {
  if (!workspaceId) return [];
  const since = opts.since ? Date.parse(opts.since) : NaN;
  const ids = opts.taskIds ? new Set(opts.taskIds) : null;
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    return rows().filter((k) => k.workspaceId === workspaceId && (!Number.isFinite(since) || Date.parse(k.createdAt) >= since) && (!ids || ids.has(k.taskId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(withNames);
  }
  if (schemaMissing || (ids && ids.size === 0)) return [];
  let q = supabase.from("kudos").select(KUDOS_COLUMNS).eq("workspace_id", workspaceId);
  if (Number.isFinite(since)) q = q.gte("created_at", new Date(since).toISOString());
  if (ids) q = q.in("task_id", [...ids].slice(0, 200));
  const { data, error } = await q.order("created_at", { ascending: false }).limit(KUDOS_LIST_LIMIT);
  if (error) {
    if (isMissingTable(error)) { schemaMissing = true; return []; }
    throw error;
  }
  return ((data as unknown[] | null) ?? []).map(parseKudos).filter((k): k is Kudos => !!k);
}

/** Email + push for the recipient: best-effort (the Inbox item is the database's either way). */
function notifyKudos(kudosId: string): void {
  if (!supabase) return;
  try {
    void supabase.functions.invoke("notify", { body: { kind: "kudos", kudosId } }).then(() => undefined, () => undefined);
  } catch { /* not deployed: in-app still works */ }
}

/** The emoji and note as the database takes them, or an "invalid …" error before asking. */
function cleanKudos(emoji: KudosEmoji, note: string | null | undefined): { em: KudosEmoji; nt: string | null } {
  const em = (KUDOS_EMOJI as readonly string[]).includes(emoji) ? emoji : null;
  if (!em) throw err("invalid emoji");
  const nt = (note ?? "").trim() || null;
  if (nt && nt.length > KUDOS_NOTE_MAX) throw err("invalid note");
  return { em, nt };
}

/** rpc give_kudos (idempotent: a second call answers the first). Held back (isKudosCooldown)
 *  after KUDOS_REGIVES_PER_TASK gives on the same task within the hour. */
export async function giveKudos(taskId: string, emoji: KudosEmoji = "🎉", note?: string | null, to?: string | null): Promise<Kudos> {
  const { em, nt } = cleanKudos(emoji, note);
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const t = demoTask(taskId);
    if (!t) throw err("task not found");
    if (!t.workspaceId) throw err("kudos need a team task");
    if (t.status !== "done") throw err("task not done");
    const toUser = to ?? t.assigneeId;
    if (!toUser || (to && to !== t.assigneeId && !t.collaborators.includes(to))) throw err("invalid recipient");
    if (toUser === DEMO_ME) throw err("not for yourself");
    const mine = rows().find((k) => k.taskId === taskId && k.fromUser === DEMO_ME);
    if (mine) return withNames(mine);
    const left = kudosCooldownLeft(taskId);
    if (left > 0) throw cooldownError(left);
    const row: Kudos = { id: `kd-demo-new-${++demoSeq}`, taskId, workspaceId: t.workspaceId, fromUser: DEMO_ME, toUser, emoji: em, note: nt, createdAt: new Date().toISOString() };
    rows().push(row);
    noteGive(taskId);
    tell(row.workspaceId);
    return withNames(row);
  }
  if (schemaMissing) throw Object.assign(err("could not find the function public.give_kudos"), { code: "PGRST202" });
  const left = kudosCooldownLeft(taskId);
  if (left > 0) throw cooldownError(left);
  const { data, error } = await supabase.rpc("give_kudos", { p_task: taskId, p_emoji: em, p_note: nt, p_to: to ?? null });
  if (error) {
    if (kudosFailure(error) === "unavailable") schemaMissing = true;
    throw error;
  }
  const k = parseKudos(data);
  if (!k) throw err("task not found");
  noteGive(taskId);
  notifyKudos(k.id);
  return k;
}

/** Change your kudos on a task (another emoji, a new note) in place: rpc update_kudos — the
 *  same kudos, so no new Inbox item (the recipient's shows the new emoji and note), no second
 *  push / email and no second kudos.given webhook. `inPlace` false: you had none there, so it
 *  was given (giveKudos), or the database has no update_kudos yet and it was taken back and
 *  given again — held to the re-give cooldown first, and if the give then fails the error
 *  says the earlier kudos is gone (kudosTookBack). */
export async function updateKudos(taskId: string, emoji: KudosEmoji, note?: string | null): Promise<{ kudos: Kudos; inPlace: boolean }> {
  const { em, nt } = cleanKudos(emoji, note);
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const mine = rows().find((k) => k.taskId === taskId && k.fromUser === DEMO_ME);
    if (!mine) return { kudos: await giveKudos(taskId, em, nt), inPlace: false };
    const t = demoTask(taskId);
    if (!t) throw err("task not found");
    if (t.status !== "done") throw err("task not done");
    mine.emoji = em;
    mine.note = nt;
    tell(mine.workspaceId);
    return { kudos: withNames(mine), inPlace: true };
  }
  if (schemaMissing) throw Object.assign(err("could not find the function public.update_kudos"), { code: "PGRST202" });
  if (!updateMissing) {
    const { data, error } = await supabase.rpc("update_kudos", { p_task: taskId, p_emoji: em, p_note: nt });
    if (!error) {
      if (data == null) return { kudos: await giveKudos(taskId, em, nt), inPlace: false };   // you had none there
      const k = parseKudos(data);
      if (!k) throw err("task not found");
      return { kudos: k, inPlace: true };
    }
    if (kudosFailure(error) !== "unavailable") throw error;
    updateMissing = true;   // 0048 without update_kudos: the old way, for this session
  }
  const left = kudosCooldownLeft(taskId);
  if (left > 0) throw cooldownError(left);
  const tookBack = await takeBackKudos(taskId);
  try {
    return { kudos: await giveKudos(taskId, em, nt), inPlace: false };
  } catch (e) {
    if (!tookBack) throw e;
    const code = (e as { code?: unknown } | null)?.code;
    throw Object.assign(err(errText(e)), { tookBack: true, cause: e, ...(code !== undefined ? { code } : {}) });
  }
}

/** rpc take_back_kudos: true when there was one. */
export async function takeBackKudos(taskId: string): Promise<boolean> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const all = rows();
    const i = all.findIndex((k) => k.taskId === taskId && k.fromUser === DEMO_ME);
    if (i < 0) return false;
    const [gone] = all.splice(i, 1);
    tell(gone.workspaceId);
    return true;
  }
  if (schemaMissing) throw Object.assign(err("could not find the function public.take_back_kudos"), { code: "PGRST202" });
  const { data, error } = await supabase.rpc("take_back_kudos", { p_task: taskId });
  if (error) {
    if (kudosFailure(error) === "unavailable") schemaMissing = true;
    throw error;
  }
  return data === true;
}

/** Realtime: kudos in this workspace given, changed (update_kudos) or taken back. Returns
 *  unsubscribe. (A delete carries only the row's id, so any delete is passed on; the caller
 *  reads the list again.) */
export function subscribeKudos(workspaceId: string, onChange: () => void): () => void {
  if (!workspaceId) return () => undefined;
  const entry = { ws: workspaceId, fn: onChange };
  listeners.add(entry);
  const off = () => { listeners.delete(entry); };
  if (!supabase || schemaMissing) return off;
  const client = supabase;
  let ch: ReturnType<typeof client.channel> | null = null;
  try {
    ch = client.channel(`kudos-${workspaceId}-${++channelSeq}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "kudos", filter: `workspace_id=eq.${workspaceId}` }, () => onChange())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "kudos", filter: `workspace_id=eq.${workspaceId}` }, () => onChange())
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "kudos" }, () => onChange())
      .subscribe();
  } catch { ch = null; }
  return () => { off(); if (ch) void client.removeChannel(ch); };
}
