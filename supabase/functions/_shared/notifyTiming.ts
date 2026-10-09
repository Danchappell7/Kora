// ============================================================
// KANBO — when a notification may go out (0048). Pure module: no Deno or
// browser globals, so the notify / daily-reminders functions and the app
// (src/lib/notifyPrefs re-exports it) share one implementation.
//
//   resolveNotifyPrefs   profiles.notify_prefs → the settings with defaults   [architect: final]
//   localParts, inQuietHours, quietHoursEnd, nextDigestAt, planDelivery       [u4]
//   + zonedInstants/zonedTime, digestMoment/digestDue, hhmm helpers           [u4]
//
// Rules (u4 implements; unit tests pin the clock, cover BST ↔ GMT):
//   • quiet hours: "HH:MM"–"HH:MM" in the person's timezone; end ≤ start spans
//     midnight; `days` are the ISO weekdays (Mon = 1) a quiet span STARTS on.
//     Inside them: no push or email — held to their end. The Inbox still updates.
//   • delivery "digest": no email per event (one digest a day at digest_time,
//     summarising unread Inbox items); push only for mentions and approvals.
//   • bundling: per recipient per task, the first event goes now and opens a
//     2-minute window; later ones in it are held to the window's end and sent
//     as one ("3 comments on Launch deck from Sana and Theo"). A mention is
//     never dropped: it rides in the bundle and is named in it.
//   • a snoozed thread (notification_snoozes.until > now) sends nothing.
// ============================================================

export type NotifyKind = "assigned" | "mention" | "comment" | "approval" | "kudos" | "due";
export type NotifyChannel = "push" | "email";

export const NOTIFY_KINDS: readonly NotifyKind[] = ["assigned", "mention", "comment", "approval", "kudos", "due"];
/** per task per recipient */
export const NOTIFY_BUNDLE_WINDOW_SEC = 120;
export const DEFAULT_TIMEZONE = "Europe/London";
export const DEFAULT_DIGEST_TIME = "08:00";
/** in digest mode, these still push in real time */
export const DIGEST_PUSH_KINDS: readonly NotifyKind[] = ["mention", "approval"];

export interface QuietHoursPrefs { start: string; end: string; days: number[] }
export interface ResolvedNotifyPrefs {
  delivery: "realtime" | "digest";
  /** "HH:MM" */
  digestTime: string;
  quietHours: QuietHoursPrefs | null;
  /** a valid IANA name (an unknown one falls back to Europe/London) */
  timezone: string;
  /** false: never bundle (each event on its own) */
  bundle: boolean;
  /** "<kind>" — the Inbox */
  inApp: (kind: NotifyKind) => boolean;
  /** "<kind>_email" / "<kind>_push" */
  channel: (kind: NotifyKind, channel: NotifyChannel) => boolean;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** like the database's notif_on(): on unless explicitly false (or "false") */
const prefOn = (v: unknown): boolean => !(v === false || (typeof v === "string" && v.toLowerCase() === "false"));

/** Is this an IANA timezone this runtime knows? */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}

/** profiles.notify_prefs (anything) → the settings, with every default filled in. Never throws. */
export function resolveNotifyPrefs(raw: unknown): ResolvedNotifyPrefs {
  const p = isObj(raw) ? raw : {};
  let quietHours: QuietHoursPrefs | null = null;
  if (isObj(p.quiet_hours) && typeof p.quiet_hours.start === "string" && typeof p.quiet_hours.end === "string"
      && HHMM.test(p.quiet_hours.start) && HHMM.test(p.quiet_hours.end) && p.quiet_hours.start !== p.quiet_hours.end) {
    const days = Array.isArray(p.quiet_hours.days)
      ? [...new Set(p.quiet_hours.days.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
      : [1, 2, 3, 4, 5, 6, 7];
    quietHours = { start: p.quiet_hours.start, end: p.quiet_hours.end, days: days.length ? days : [1, 2, 3, 4, 5, 6, 7] };
  }
  return {
    delivery: p.delivery === "digest" ? "digest" : "realtime",
    digestTime: typeof p.digest_time === "string" && HHMM.test(p.digest_time) ? p.digest_time : DEFAULT_DIGEST_TIME,
    quietHours,
    timezone: isTimeZone(p.timezone) ? p.timezone : DEFAULT_TIMEZONE,
    bundle: prefOn(p.bundle),
    inApp: (kind) => prefOn(p[kind]),
    channel: (kind, channel) => prefOn(p[`${kind}_${channel}`]),
  };
}

/* ---------- the maths (u4) ----------
   Everything works on the wall clock of the person's timezone through Intl
   (no offsets are assumed), so the clock changes in March and October need
   no special cases: a quiet span "22:00–07:00" is 22:00–07:00 local on the
   night the clocks go back as on any other.
   A local time that doesn't exist (01:30 on the morning the clocks go
   forward) resolves to the same distance past the gap (02:30), and one that
   happens twice (01:30 on the morning they go back) to its first occurrence:
   Temporal's "compatible" rule. */

/** A moment in a timezone: its local date, weekday (ISO, Mon = 1) and minutes since local midnight. */
export interface LocalParts { date: string; weekday: number; minutes: number }

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DAY_MS = 86_400_000;
const FORMATS = new Map<string, Intl.DateTimeFormat>();
const zoneOf = (tz: string): string => (isTimeZone(tz) ? tz : DEFAULT_TIMEZONE);
function formatFor(tz: string): Intl.DateTimeFormat {
  let f = FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    FORMATS.set(tz, f);
  }
  return f;
}
interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number }
function wallOf(ms: number, tz: string): Wall {
  const out: Wall = { y: 1970, mo: 1, d: 1, h: 0, mi: 0, s: 0, wd: 4 };
  for (const p of formatFor(tz).formatToParts(new Date(ms))) {
    if (p.type === "year") out.y = Number(p.value);
    else if (p.type === "month") out.mo = Number(p.value);
    else if (p.type === "day") out.d = Number(p.value);
    else if (p.type === "hour") out.h = Number(p.value) % 24;
    else if (p.type === "minute") out.mi = Number(p.value);
    else if (p.type === "second") out.s = Number(p.value);
    else if (p.type === "weekday") out.wd = WEEKDAY[p.value] ?? 4;
  }
  return out;
}
/** the wall clock at `ms`, read as if it were UTC (ms) */
const wallMs = (ms: number, tz: string): number => {
  const w = wallOf(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
};
/** local − UTC at `ms`, in ms (whole seconds) */
const offsetAt = (ms: number, tz: string): number => wallMs(ms, tz) - Math.floor(ms / 1000) * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** "07:30" → 450; anything else → NaN. */
export function hhmmToMinutes(hhmm: unknown): number {
  if (typeof hhmm !== "string" || !HHMM.test(hhmm)) return NaN;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}
/** 450 → "07:30" (wraps round the day). */
export function minutesToHHMM(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
/** "2026-10-24" + n days (calendar arithmetic; no timezone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, (m || 1) - 1, d || 1) + n * DAY_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function localParts(at: Date, timezone: string): LocalParts {
  const w = wallOf(at.getTime(), zoneOf(timezone));
  return { date: `${w.y}-${pad(w.mo)}-${pad(w.d)}`, weekday: w.wd, minutes: w.h * 60 + w.mi };
}

/**
 * Every instant at which the wall clock in `timezone` reads `date` + `minutes`,
 * earliest first: one normally, two in the hour the clocks go back. A time the
 * clocks skip has none, so it gets the instant the same distance past the gap.
 */
export function zonedInstants(date: string, minutes: number, timezone: string): Date[] {
  const tz = zoneOf(timezone);
  const [y, m, d] = date.split("-").map(Number);
  const W = Date.UTC(y, (m || 1) - 1, d || 1, 0, minutes);
  const before = offsetAt(W - DAY_MS, tz), after = offsetAt(W + DAY_MS, tz);
  const found = [...new Set([W - before, W - after])].filter((t) => wallMs(t, tz) === W).sort((a, b) => a - b);
  return (found.length ? found : [W - before]).map((t) => new Date(t));
}
/** The instant the wall clock reads `date` `HH:MM` (the first, when it happens twice). */
export function zonedTime(date: string, minutes: number, timezone: string): Date {
  return zonedInstants(date, minutes, timezone)[0];
}

const quietSpan = (q: QuietHoursPrefs | null) => {
  if (!q) return null;
  const start = hhmmToMinutes(q.start), end = hhmmToMinutes(q.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return null;
  return { start, end, days: q.days?.length ? q.days : ALL_DAYS };
};

/** Is `at` inside the person's quiet hours? */
export function inQuietHours(at: Date, quiet: QuietHoursPrefs | null, timezone: string): boolean {
  const q = quietSpan(quiet);
  if (!q) return false;
  const lp = localParts(at, timezone);
  if (q.start < q.end) return q.days.includes(lp.weekday) && lp.minutes >= q.start && lp.minutes < q.end;
  // spans midnight: the evening part belongs to today's span, the morning part to yesterday's
  if (lp.minutes >= q.start) return q.days.includes(lp.weekday);
  if (lp.minutes < q.end) return q.days.includes(lp.weekday === 1 ? 7 : lp.weekday - 1);
  return false;
}

/** When the quiet span containing `at` ends (the same instant when not in quiet hours). DST-safe. */
export function quietHoursEnd(at: Date, quiet: QuietHoursPrefs | null, timezone: string): Date {
  const q = quietSpan(quiet);
  if (!q || !inQuietHours(at, quiet, timezone)) return at;
  const lp = localParts(at, timezone);
  const endDate = q.start > q.end && lp.minutes >= q.start ? addDays(lp.date, 1) : lp.date;
  const ends = zonedInstants(endDate, q.end, timezone);
  return ends.find((t) => t.getTime() > at.getTime()) ?? ends[ends.length - 1];
}

/** The next digest moment strictly after `after` (digest_time in the timezone). DST-safe. */
export function nextDigestAt(after: Date, digestTime: string, timezone: string): Date {
  const min = Number.isFinite(hhmmToMinutes(digestTime)) ? hhmmToMinutes(digestTime) : hhmmToMinutes(DEFAULT_DIGEST_TIME);
  const today = localParts(after, timezone).date;
  for (let i = 0; i < 3; i++) {
    const at = zonedTime(addDays(today, i), min, timezone);
    if (at.getTime() > after.getTime()) return at;
  }
  return new Date(after.getTime() + DAY_MS);
}

/** How long after its time a missed digest may still go (the digest job runs every 15 minutes). */
export const DIGEST_CATCH_UP_MIN = 120;

/** When a day's digest goes: its time, moved to the end of quiet hours when it falls inside them. */
export function digestMoment(date: string, prefs: Pick<ResolvedNotifyPrefs, "digestTime" | "quietHours" | "timezone">): Date {
  const min = Number.isFinite(hhmmToMinutes(prefs.digestTime)) ? hhmmToMinutes(prefs.digestTime) : hhmmToMinutes(DEFAULT_DIGEST_TIME);
  return quietHoursEnd(zonedTime(date, min, prefs.timezone), prefs.quietHours, prefs.timezone);
}

/**
 * Is a digest due at `now`? The day's digest (or yesterday's, when quiet hours
 * pushed it past midnight) is due from its moment for DIGEST_CATCH_UP_MIN.
 * `date` is the digest's own local date: the key that makes it once a day.
 */
export function digestDue(now: Date, prefs: Pick<ResolvedNotifyPrefs, "digestTime" | "quietHours" | "timezone">,
  catchUpMin = DIGEST_CATCH_UP_MIN): { due: boolean; date: string; at: Date } {
  const today = localParts(now, prefs.timezone).date;
  let best: { due: boolean; date: string; at: Date } | null = null;
  for (const date of [addDays(today, -1), today]) {
    const at = digestMoment(date, prefs);
    const age = now.getTime() - at.getTime();
    if (age >= 0 && age < catchUpMin * 60_000) best = { due: true, date, at };
  }
  return best ?? { due: false, date: today, at: digestMoment(today, prefs) };
}

export interface DeliveryInput {
  kind: NotifyKind;
  channel: NotifyChannel;
  now: Date;
  prefs: ResolvedNotifyPrefs;
  /** notification_snoozes.until for this recipient and task, if any */
  snoozedUntil?: Date | null;
  /** when this recipient last got something on this channel for this task (opens / extends the bundle window) */
  lastSentForTask?: Date | null;
  /** (u4) the earliest deliver_after of this task's notices still waiting for this recipient on this
   *  channel: a new one joins them, so they go out as one */
  pendingUntil?: Date | null;
}
/** send now · hold until (bundle window, quiet hours) · leave it to the digest · don't send */
export type DeliveryPlan =
  | { action: "send" }
  | { action: "hold"; until: Date; reason: "bundle" | "quiet_hours" }
  | { action: "digest" }
  | { action: "skip"; reason: "pref_off" | "snoozed" | "digest_mode" };

/**
 * What to do with one notice for one recipient on one channel, in this order:
 * their switch for it is off → skip · the thread is snoozed → skip · daily
 * digest: email waits for the digest, push goes only for mentions and
 * approvals · quiet hours → hold to their end · bundling: join notices still
 * waiting for this task, or, within 2 minutes of the last one sent, hold to
 * the window's end · otherwise send now.
 */
export function planDelivery(input: DeliveryInput): DeliveryPlan {
  const { kind, channel, now, prefs } = input;
  if (!prefs.channel(kind, channel)) return { action: "skip", reason: "pref_off" };
  if (input.snoozedUntil && input.snoozedUntil.getTime() > now.getTime()) return { action: "skip", reason: "snoozed" };
  if (prefs.delivery === "digest") {
    if (channel === "email") return { action: "digest" };
    if (!DIGEST_PUSH_KINDS.includes(kind)) return { action: "skip", reason: "digest_mode" };
  }
  if (inQuietHours(now, prefs.quietHours, prefs.timezone)) {
    return { action: "hold", until: quietHoursEnd(now, prefs.quietHours, prefs.timezone), reason: "quiet_hours" };
  }
  if (prefs.bundle) {
    if (input.pendingUntil) return { action: "hold", until: new Date(Math.max(input.pendingUntil.getTime(), now.getTime())), reason: "bundle" };
    const last = input.lastSentForTask?.getTime();
    if (last !== undefined && Number.isFinite(last)) {
      const end = last + NOTIFY_BUNDLE_WINDOW_SEC * 1000;
      if (now.getTime() < end && now.getTime() >= last - 60_000) return { action: "hold", until: new Date(end), reason: "bundle" };
    }
  }
  return { action: "send" };
}
