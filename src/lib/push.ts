/* ============================================================
   KANBO — web push notifications.                               [f8-push-pwa]
   Subscribes this device with the VAPID public key from
   import.meta.env.VITE_VAPID_PUBLIC_KEY (feature hidden when unset, and in
   demo mode) and saves it to push_subscriptions (0043) — preferably through
   save_push_subscription(endpoint, p256dh, auth, user_agent), which also
   takes the endpoint over from another account that used this browser.
   The server (notify, daily-reminders via _shared/webpush.ts) sends a push
   for kind K unless notify_prefs["K_push"] === false.
   public/sw.js shows it and, on click, focuses/opens payload.url.

   Push payload contract (JSON, encrypted aes128gcm, ≤ 3 KB):
     { title: string, body: string, url: string (same-origin path, e.g. "/?task=<id>"),
       tag?: string (collapse key, e.g. "task-<id>"), kind?: PushKind | "test" }
   CONTRACT STUB — f8 replaces the bodies, keeps every exported name/signature.
   ============================================================ */
import type { PushAvailability, PushKind } from "../data/types";

/** The VAPID public key baked in at build time ("" when unset). */
export const VAPID_PUBLIC_KEY: string = (import.meta.env.VITE_VAPID_PUBLIC_KEY ?? "").trim();

/** The kinds people can switch push on/off for, in Settings order. */
export const PUSH_KINDS: readonly { key: PushKind; label: string; hint: string }[] = [
  { key: "assigned", label: "Assigned to me", hint: "Someone gives you a task." },
  { key: "mention", label: "Mentions", hint: "Someone @mentions you in a comment." },
  { key: "comment", label: "Comments on my tasks", hint: "New comments on tasks you own or follow." },
  { key: "due", label: "Due-date reminders", hint: "Your morning nudge about what's due." },
];

/** notify_prefs key for a kind's push toggle: "assigned" → "assigned_push". */
export const pushPrefKey = (kind: PushKind): string => `${kind}_push`;

/** Can push be offered on this device right now? (Synchronous; no prompts.) */
export function pushAvailability(): PushAvailability {
  return "unconfigured";
}

/** base64url (VAPID key) → bytes for PushManager.subscribe({ applicationServerKey }). */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  void base64;
  return new Uint8Array();
}

/** Is this device subscribed (and saved) for the signed-in person? */
export async function isPushOnHere(): Promise<boolean> {
  return false;
}

export type PushEnableResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "unconfigured" | "denied" | "dismissed" | "save_failed"; message: string };

/** Ask permission (only from a click), subscribe, save. Never throws. */
export async function enablePush(): Promise<PushEnableResult> {
  return { ok: false, reason: "unconfigured", message: "Push notifications aren't set up yet." };
}

/** Unsubscribe this device and delete its row. Never throws. */
export async function disablePush(): Promise<void> {
  /* stub: f8 */
}

/** Send a test notification to this person's devices. */
export async function sendTestPush(): Promise<{ ok: boolean; message: string }> {
  return { ok: false, message: "Push notifications aren't set up yet." };
}
