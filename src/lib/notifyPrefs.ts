/* ============================================================
   KANBO — calmer notifications, the app's side (0048).   [u4]
     • the prefs: delivery (real-time / daily digest), digest time,
       quiet hours, timezone, bundling — read with readNotifyPrefs, saved
       with mergeNotifyPrefs (merge_notify_prefs: one level deep, null
       removes a key, so Settings on two devices never clobber each other)
     • thread snoozes (public.notification_snoozes, your own rows): snooze
       a task's thread until later; it sends no push or email meanwhile and
       comes back to the top of the Inbox when the snooze ends. The old
       per-device Inbox snoozes (localStorage "kanbo-inbox-snooze", keyed by
       activity id) move across on first load: their item's task, latest
       wake time wins (planLegacySnoozeMigration).
   The timing maths is shared with the edge functions:
   supabase/functions/_shared/notifyTiming.ts.
   Demo mode: prefs live on the demo profile (and in memory here for
   mergeNotifyPrefs); snoozes in memory, seeded with one realistic thread.
   ============================================================ */
import type { Activity, NotificationSnooze, NotifyPrefs } from "../data/types";
import {
  DEFAULT_DIGEST_TIME, DEFAULT_TIMEZONE, DIGEST_PUSH_KINDS, NOTIFY_BUNDLE_WINDOW_SEC, NOTIFY_KINDS,
  addDays, hhmmToMinutes, inQuietHours, isTimeZone, localParts, nextDigestAt, planDelivery, quietHoursEnd, resolveNotifyPrefs,
  zonedTime,
  type DeliveryInput, type DeliveryPlan, type LocalParts, type NotifyChannel, type NotifyKind, type QuietHoursPrefs,
  type ResolvedNotifyPrefs,
} from "../../supabase/functions/_shared/notifyTiming.ts";
import { parseSnooze, SNOOZE_MAX_DAYS } from "./snoozeRows";
import { supabase } from "./supabase";

export {
  DEFAULT_DIGEST_TIME, DEFAULT_TIMEZONE, DIGEST_PUSH_KINDS, NOTIFY_BUNDLE_WINDOW_SEC, NOTIFY_KINDS,
  inQuietHours, isTimeZone, localParts, nextDigestAt, planDelivery, quietHoursEnd,
};
export type { DeliveryInput, DeliveryPlan, LocalParts, NotifyChannel, NotifyKind, QuietHoursPrefs, ResolvedNotifyPrefs };
export { parseSnooze, SNOOZE_MAX_DAYS, SNOOZES_PER_PERSON } from "./snoozeRows";

/** profiles.notify_prefs → every setting with its default.  [final] */
export function readNotifyPrefs(prefs: NotifyPrefs | null | undefined): ResolvedNotifyPrefs {
  return resolveNotifyPrefs(prefs ?? {});
}

/** The whole object with a patch applied (null removes a key) — what merge_notify_prefs stores.  [final] */
export function applyNotifyPrefsPatch(prefs: NotifyPrefs | null | undefined, patch: NotifyPrefs): NotifyPrefs {
  const out: NotifyPrefs = { ...(prefs ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/* ---------- saving prefs ---------- */

let demoPrefs: NotifyPrefs = {};

/** Save a patch to your notify_prefs (rpc merge_notify_prefs); answers the stored prefs. Demo: the demo profile. */
export async function mergeNotifyPrefs(patch: NotifyPrefs): Promise<NotifyPrefs> {
  if (!supabase) {
    demoPrefs = applyNotifyPrefsPatch(demoPrefs, patch);
    return { ...demoPrefs };
  }
  const { data, error } = await supabase.rpc("merge_notify_prefs", { p_patch: patch });
  if (error) throw error;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as NotifyPrefs) : {};
}

/**
 * Settings' In-app / Email table and the push panel hand over the whole prefs object: only what changed from
 * `before` is sent (merge_notify_prefs; null removes a key), so a stale tab never overwrites another
 * device's change. A database without merge_notify_prefs (before 0048) saves the whole object (`whole`).
 * Answers the stored prefs, or null when nothing changed.
 */
export async function saveNotifyPrefsChange(before: NotifyPrefs, after: NotifyPrefs, whole: () => Promise<unknown>): Promise<NotifyPrefs | null> {
  const diff: NotifyPrefs = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) diff[k] = (after[k] ?? null) as NotifyPrefs[string];
  }
  if (!Object.keys(diff).length) return null;
  try {
    return await mergeNotifyPrefs(diff);
  } catch (e) {
    const msg = String((e as { message?: unknown } | null)?.message ?? e);
    if ((e as { code?: string } | null)?.code === "PGRST202" || /could not find the function|merge_notify_prefs/i.test(msg)) { await whole(); return null; }
    throw e;
  }
}

/** The keys that decide when held push and email may go: a change to one plans them again. */
export const TIMING_PREF_KEYS = ["quiet_hours", "timezone", "delivery"] as const;
export const touchesTiming = (patch: NotifyPrefs): boolean => TIMING_PREF_KEYS.some((k) => k in patch);

/**
 * After a change to quiet hours, time zone or delivery: what's already held
 * for you is planned again by the new settings (notify { kind: "replan" }),
 * so switching quiet hours off releases what was waiting for them. Only ever
 * earlier. Best-effort: if it can't be reached, held notices still go when
 * their old wait ends. Demo: nothing is held.
 */
export async function rescheduleHeldNotices(): Promise<void> {
  if (!supabase) return;
  try { await supabase.functions.invoke("notify", { body: { kind: "replan" } }); } catch { /* best-effort */ }
}

/* ---------- words for the settings ---------- */

/** The browser's timezone (or London when it can't say). */
export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
  } catch { return DEFAULT_TIMEZONE; }
}

/** "Europe/London" → "London time", "America/New_York" → "New York time", "UTC" → "UTC". */
export function zoneLabel(tz: string): string {
  if (!tz || /^(UTC|Etc\/UTC|GMT|Etc\/GMT)$/i.test(tz)) return "UTC";
  const city = tz.split("/").pop()!.replace(/_/g, " ");
  return `${city} time`;
}

/** "Europe/London" → "London (GMT+1)" at `at`: the picker's option label. */
export function zoneOption(tz: string, at: Date = new Date()): string {
  const city = tz.split("/").slice(1).join(" / ").replace(/_/g, " ") || tz;
  let off = "";
  try {
    off = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "shortOffset" } as unknown as Intl.DateTimeFormatOptions)
      .formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { /* old engines: no offset */ }
  return off ? `${city} (${off})` : city;
}

const COMMON_ZONES = [
  "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome",
  "Europe/Amsterdam", "Europe/Stockholm", "Europe/Warsaw", "Europe/Athens", "Europe/Istanbul", "Africa/Lagos",
  "Africa/Johannesburg", "Africa/Nairobi", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Singapore",
  "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul", "Australia/Perth", "Australia/Sydney",
  "Pacific/Auckland", "America/Sao_Paulo", "America/Halifax", "America/New_York", "America/Chicago",
  "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "UTC",
];

/** The timezones the picker offers: every one the runtime knows (or a common list), always with these. */
export function timeZoneChoices(...include: (string | null | undefined)[]): string[] {
  let all: string[] = [];
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (sv) all = sv("timeZone");
  } catch { /* fall back */ }
  if (!all.length) all = COMMON_ZONES;
  const set = new Set(all.filter(isTimeZone));
  for (const z of include) if (z && isTimeZone(z)) set.add(z);
  return [...set].sort((a, b) => (a === "UTC" ? 1 : b === "UTC" ? -1 : a.localeCompare(b)));
}

const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** [1..5] → "on weekdays", [6, 7] → "at weekends", all → "every day", else "on Mon, Wed and Fri". */
export function quietDaysLabel(days: readonly number[] | undefined): string {
  const d = [...new Set((days?.length ? days : [1, 2, 3, 4, 5, 6, 7]).filter((x) => x >= 1 && x <= 7))].sort();
  const key = d.join("");
  if (key === "1234567") return "every day";
  if (key === "12345") return "on weekdays";
  if (key === "67") return "at weekends";
  return `on ${listJoin(d.map((x) => DAY_SHORT[x]))}`;
}

/** "Real time, quiet 22:00–07:00 on weekdays, London time" — Settings' summary line. */
export function describeNotifyPrefs(p: ResolvedNotifyPrefs): string {
  const parts = [p.delivery === "digest" ? `Daily digest at ${p.digestTime}` : p.bundle ? "Real time, bundled" : "Real time"];
  if (p.quietHours) parts.push(`quiet ${p.quietHours.start}–${p.quietHours.end} ${quietDaysLabel(p.quietHours.days)}`);
  parts.push(zoneLabel(p.timezone));
  return parts.join(", ");
}

/** Right now: are push and email waiting (quiet hours), and until when? null when they're flowing. */
export function quietNow(p: ResolvedNotifyPrefs, now: Date = new Date()): { until: Date } | null {
  return inQuietHours(now, p.quietHours, p.timezone) ? { until: quietHoursEnd(now, p.quietHours, p.timezone) } : null;
}

/* ---------- thread snoozes ---------- */

/** "1 hour", "Tomorrow 09:00", "Next week (Mon 09:00)", in the person's timezone; Custom is the UI's. */
export interface SnoozeChoice { id: "hour" | "tomorrow" | "next_week"; label: string; hint: string; until: Date }

const NINE = 9 * 60;
const fmtIn = (tz: string, o: Intl.DateTimeFormatOptions) => {
  try { return new Intl.DateTimeFormat("en-GB", { ...o, timeZone: tz }); } catch { return new Intl.DateTimeFormat("en-GB", o); }
};

export function snoozeChoices(now: Date, timezone: string): SnoozeChoice[] {
  const tz = isTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const lp = localParts(now, tz);
  const hour = new Date(now.getTime() + 3_600_000);
  const tomorrow = zonedTime(addDays(lp.date, 1), NINE, tz);
  // next Monday 09:00; on a Sunday that's tomorrow, so the Monday after
  let ahead = 8 - lp.weekday;
  if (ahead === 1) ahead = 8;
  const nextWeek = zonedTime(addDays(lp.date, ahead), NINE, tz);
  const time = fmtIn(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const wd = fmtIn(tz, { weekday: "short" });
  const wdm = fmtIn(tz, { weekday: "short", day: "numeric", month: "short" });
  // "Mon 12 Oct" whatever punctuation this engine's en-GB uses
  const dayMonth = (d: Date) => {
    const parts = wdm.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("weekday")} ${get("day")} ${get("month")}`;
  };
  return [
    { id: "hour", label: "1 hour", hint: time.format(hour), until: hour },
    { id: "tomorrow", label: "Tomorrow 09:00", hint: wd.format(tomorrow), until: tomorrow },
    { id: "next_week", label: "Next week", hint: `${dayMonth(nextWeek)}, 09:00`, until: nextWeek },
  ];
}

/** A custom snooze ("2026-10-12", "14:30") in a timezone → the instant, or why not. */
export function customSnoozeUntil(date: string, time: string, timezone: string, now: Date = new Date()):
  { ok: true; until: Date } | { ok: false; error: string } {
  const min = hhmmToMinutes(time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(min)) return { ok: false, error: "Pick a date and a time." };
  const until = zonedTime(date, min, isTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE);
  if (Number.isNaN(until.getTime())) return { ok: false, error: "Pick a date and a time." };
  if (until.getTime() <= now.getTime() + 60_000) return { ok: false, error: "Pick a time later than now." };
  if (until.getTime() > now.getTime() + SNOOZE_MAX_DAYS * 86_400_000 - 60_000) return { ok: false, error: "Snoozes can last up to a year." };
  return { ok: true, until };
}

/** Why a snooze call failed, for the Inbox's words. */
export type SnoozeFailure = "unavailable" | "not_allowed" | "invalid" | "too_many" | "network" | "error";
export function snoozeFailure(err: unknown): SnoozeFailure {
  const msg = String((err as { message?: string })?.message ?? err ?? "");
  const code = String((err as { code?: string })?.code ?? "");
  if (code === "42P01" || code === "PGRST205" || /does not exist|schema cache|not built yet/i.test(msg)) return "unavailable";
  if (/too many snoozes/i.test(msg)) return "too_many";
  if (/invalid snooze/i.test(msg)) return "invalid";
  if (code === "42501" || /row-level security|permission denied|not authori[sz]ed|sign in/i.test(msg)) return "not_allowed";
  if (/fetch|network|offline|Failed to fetch|timeout/i.test(msg)) return "network";
  return "error";
}
export function snoozeFailureMessage(f: SnoozeFailure): string {
  switch (f) {
    case "unavailable": return "Snoozes aren't set up on the server yet.";
    case "not_allowed": return "You can't snooze this thread.";
    case "invalid": return "Pick a time within the next year.";
    case "too_many": return "You have too many snoozes. Bring some back first.";
    case "network": return "You're offline. Try again when you're connected.";
    default: return "Couldn't snooze that. Try again.";
  }
}

const byUntil = (a: NotificationSnooze, b: NotificationSnooze) => a.until.localeCompare(b.until);

/* demo: in memory, seeded once with a realistic thread (the staging mention, back tomorrow at nine) */
let demoSnoozes: Map<string, NotificationSnooze> | null = null;
const demoListeners = new Set<() => void>();
const tellDemo = () => { for (const fn of [...demoListeners]) { try { fn(); } catch { /* a listener's problem */ } } };
function demoRows(): Map<string, NotificationSnooze> {
  if (!demoSnoozes) {
    const now = new Date();
    const until = snoozeChoices(now, deviceTimeZone())[1].until.toISOString();
    demoSnoozes = new Map([["t-2", { taskId: "t-2", until, createdAt: new Date(now.getTime() - 3 * 3_600_000).toISOString() }]]);
  }
  return demoSnoozes;
}
/** The demo's snoozes right now, every one (null with a real backend: read them with listSnoozes). */
export function demoSnoozesNow(): NotificationSnooze[] | null {
  return supabase ? null : [...demoRows().values()].map((s) => ({ ...s })).sort(byUntil);
}
/** Tests and sign-out: forget the demo's snoozes (or start from these). */
export function resetDemoSnoozes(seed: NotificationSnooze[] = []): void {
  demoSnoozes = new Map(seed.map((s) => [s.taskId, { ...s }]));
  tellDemo();
}

const COLUMNS = "task_id,until,created_at";
async function myId(): Promise<string | null> {
  try { const { data } = await supabase!.auth.getSession(); return data.session?.user?.id ?? null; } catch { return null; }
}

/** Your snoozes (only ones still running, unless all: those that ended too, until they're settled). */
export async function listSnoozes(opts: { all?: boolean } = {}): Promise<NotificationSnooze[]> {
  const nowIso = new Date().toISOString();
  if (!supabase) {
    return [...demoRows().values()].filter((s) => opts.all || s.until > nowIso).map((s) => ({ ...s })).sort(byUntil);
  }
  let q = supabase.from("notification_snoozes").select(COLUMNS);
  if (!opts.all) q = q.gt("until", nowIso);
  const { data, error } = await q.order("until", { ascending: true }).limit(1000);
  if (error) throw error;
  return ((data ?? []) as unknown[]).map(parseSnooze).filter((s): s is NotificationSnooze => !!s);
}

/** Snooze a task's thread until a time (upsert). A time in the past ends it now (it comes "back"). */
export async function snoozeThread(taskId: string, until: Date | string): Promise<NotificationSnooze> {
  const at = typeof until === "string" ? new Date(until) : until;
  if (!taskId || Number.isNaN(at.getTime())) throw new Error("invalid snooze");
  const iso = at.toISOString();
  if (!supabase) {
    // the database's own rule (0048 snooze_guard): no further back than a day, no more than a year ahead
    const now = Date.now();
    if (at.getTime() < now - 86_400_000 || at.getTime() > now + SNOOZE_MAX_DAYS * 86_400_000) throw new Error("invalid snooze");
    const rows = demoRows();
    const row: NotificationSnooze = { taskId, until: iso, createdAt: rows.get(taskId)?.createdAt ?? new Date().toISOString() };
    rows.set(taskId, row);
    tellDemo();
    return { ...row };
  }
  const uid = await myId();
  if (!uid) throw new Error("sign in required");
  const { data, error } = await supabase.from("notification_snoozes")
    .upsert({ user_id: uid, task_id: taskId, until: iso }, { onConflict: "user_id,task_id" })
    .select(COLUMNS).single();
  if (error) throw error;
  return parseSnooze(data) ?? { taskId, until: iso, createdAt: iso };
}

/** End a snooze now (and forget it: no "Back from snooze"). */
export async function unsnoozeThread(taskId: string): Promise<void> {
  if (!supabase) {
    if (demoRows().delete(taskId)) tellDemo();
    return;
  }
  const uid = await myId();
  let q = supabase.from("notification_snoozes").delete().eq("task_id", taskId);
  if (uid) q = q.eq("user_id", uid);
  const { error } = await q;
  if (error) throw error;
}

let channelSeq = 0;
/** Realtime: your snoozes changed (another device). Returns unsubscribe. */
export function subscribeSnoozes(userId: string, onChange: () => void): () => void {
  if (!supabase) {
    demoListeners.add(onChange);
    return () => { demoListeners.delete(onChange); };
  }
  if (!userId) return () => undefined;
  const client = supabase;
  const ch = client.channel(`snoozes-${userId}-${++channelSeq}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "notification_snoozes", filter: `user_id=eq.${userId}` }, () => onChange())
    .subscribe();
  return () => { void client.removeChannel(ch); };
}

/** Is this task's thread snoozed at `now`? */
export function isSnoozed(taskId: string | null | undefined, snoozes: readonly NotificationSnooze[], now: number = Date.now()): boolean {
  if (!taskId) return false;
  return snoozes.some((s) => s.taskId === taskId && Date.parse(s.until) > now);
}

/* ---------- the old per-device snoozes ---------- */

/** localStorage key of the Inbox's per-device snoozes (activity id → wake time, ms). */
export const LEGACY_SNOOZE_KEY = "kanbo-inbox-snooze";

/**
 * Which per-device snoozes become thread snoozes: a running one for an item
 * in this Inbox that has a task (latest wake time per task wins, capped at a
 * year). Everything else stays on the device: items without a task (a doc
 * mention, an integration notice), snoozes that have already ended (the
 * Inbox still flags those "Back from snooze" once), and ids this Inbox
 * doesn't show (another workspace's).
 */
export function planLegacySnoozeMigration(stored: Record<string, number>, activity: readonly Pick<Activity, "id" | "taskId">[], now: number = Date.now()):
  { threads: { taskId: string; until: number }[]; keep: Record<string, number> } {
  const taskOf = new Map(activity.map((a) => [a.id, a.taskId]));
  const latest = new Map<string, number>();
  const keep: Record<string, number> = {};
  const cap = now + SNOOZE_MAX_DAYS * 86_400_000 - 3_600_000;
  for (const [id, until] of Object.entries(stored)) {
    if (typeof until !== "number" || !Number.isFinite(until)) continue;
    const taskId = taskOf.get(id);
    if (taskId && until > now) latest.set(taskId, Math.max(latest.get(taskId) ?? 0, Math.min(until, cap)));
    else keep[id] = until;
  }
  return { threads: [...latest].map(([taskId, until]) => ({ taskId, until })), keep };
}
