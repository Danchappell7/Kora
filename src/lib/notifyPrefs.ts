/* ============================================================
   KANBO — calmer notifications, the app's side (0048).   [0048 contract → u4]
     • the prefs: delivery (real-time / daily digest), digest time,
       quiet hours, timezone, bundling — read with readNotifyPrefs, saved
       with mergeNotifyPrefs (merge_notify_prefs: one level deep, null
       removes a key, so Settings on two devices never clobber each other)
     • thread snoozes (public.notification_snoozes, your own rows): snooze
       a task's thread until later; it sends no push or email meanwhile and
       comes back to the top of the Inbox when the snooze ends. The old
       per-device Inbox snoozes (localStorage "kanbo-inbox-snooze", keyed by
       activity id) move across on first load: their item's task, latest
       wake time wins (u4).
   The timing maths is shared with the edge functions:
   supabase/functions/_shared/notifyTiming.ts.
   Demo mode: prefs live on the demo profile; snoozes in memory.
   ============================================================ */
import type { NotificationSnooze, NotifyPrefs } from "../data/types";
import {
  DEFAULT_DIGEST_TIME, DEFAULT_TIMEZONE, DIGEST_PUSH_KINDS, NOTIFY_BUNDLE_WINDOW_SEC, NOTIFY_KINDS,
  inQuietHours, isTimeZone, localParts, nextDigestAt, planDelivery, quietHoursEnd, resolveNotifyPrefs,
  type DeliveryInput, type DeliveryPlan, type LocalParts, type NotifyChannel, type NotifyKind, type QuietHoursPrefs,
  type ResolvedNotifyPrefs,
} from "../../supabase/functions/_shared/notifyTiming.ts";

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

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package u4)`));

/** Save a patch to your notify_prefs (rpc merge_notify_prefs); answers the stored prefs. Demo: the demo profile. */
export function mergeNotifyPrefs(_patch: NotifyPrefs): Promise<NotifyPrefs> { return notBuilt("mergeNotifyPrefs"); }

/** "1 hour", "Tomorrow 09:00", "Next week (Mon 09:00)", in the person's timezone; Custom is the UI's. */
export interface SnoozeChoice { id: "hour" | "tomorrow" | "next_week"; label: string; hint: string; until: Date }
export function snoozeChoices(_now: Date, _timezone: string): SnoozeChoice[] { return []; }

/** Your snoozes (only ones still running, unless all). */
export function listSnoozes(_opts?: { all?: boolean }): Promise<NotificationSnooze[]> { return notBuilt("listSnoozes"); }
/** Snooze a task's thread until a time (upsert). */
export function snoozeThread(_taskId: string, _until: Date | string): Promise<NotificationSnooze> { return notBuilt("snoozeThread"); }
/** End a snooze now. */
export function unsnoozeThread(_taskId: string): Promise<void> { return notBuilt("unsnoozeThread"); }
/** Realtime: your snoozes changed (another device). Returns unsubscribe. */
export function subscribeSnoozes(_userId: string, _onChange: () => void): () => void { return () => undefined; }
/** Is this task's thread snoozed at `now`? */
export function isSnoozed(_taskId: string | null | undefined, _snoozes: readonly NotificationSnooze[], _now: number = Date.now()): boolean { return false; }
