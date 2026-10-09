// ============================================================
// KANBO — when a notification may go out (0048). Pure module: no Deno or
// browser globals, so the notify / daily-reminders functions and the app
// (src/lib/notifyPrefs re-exports it) share one implementation.
//
//   resolveNotifyPrefs   profiles.notify_prefs → the settings with defaults   [architect: final]
//   localParts, inQuietHours, quietHoursEnd, nextDigestAt, planDelivery       [0048 stub → u4]
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

/* ---------- the maths [0048 stub → u4] ---------- */

/** A moment in a timezone: its local date, weekday (ISO, Mon = 1) and minutes since local midnight. */
export interface LocalParts { date: string; weekday: number; minutes: number }

export function localParts(_at: Date, _timezone: string): LocalParts {
  return { date: "1970-01-01", weekday: 4, minutes: 0 };
}

/** Is `at` inside the person's quiet hours? */
export function inQuietHours(_at: Date, _quiet: QuietHoursPrefs | null, _timezone: string): boolean {
  return false;
}

/** When the quiet span containing `at` ends (the same instant when not in quiet hours). DST-safe. */
export function quietHoursEnd(at: Date, _quiet: QuietHoursPrefs | null, _timezone: string): Date {
  return at;
}

/** The next digest moment strictly after `after` (digest_time in the timezone). DST-safe. */
export function nextDigestAt(after: Date, _digestTime: string, _timezone: string): Date {
  return after;
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
}
/** send now · hold until (bundle window, quiet hours) · leave it to the digest · don't send */
export type DeliveryPlan =
  | { action: "send" }
  | { action: "hold"; until: Date; reason: "bundle" | "quiet_hours" }
  | { action: "digest" }
  | { action: "skip"; reason: "pref_off" | "snoozed" | "digest_mode" };

export function planDelivery(_input: DeliveryInput): DeliveryPlan {
  return { action: "send" };
}
