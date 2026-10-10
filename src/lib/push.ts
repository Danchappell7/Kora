/* ============================================================
   KANBO — web push notifications.                               [f8-push-pwa]
   Subscribes this device with the VAPID public key from
   import.meta.env.VITE_VAPID_PUBLIC_KEY (feature hidden when unset) and
   saves it to push_subscriptions (0043) through
   save_push_subscription(endpoint, p256dh, auth, user_agent), which also
   takes the endpoint over from another account that used this browser.
   The server (notify, daily-reminders via _shared/webpush.ts) sends a push
   for kind K unless notify_prefs["K_push"] === false.
   public/sw.js shows it and, on click, focuses/opens payload.url.

   Push payload contract (JSON, encrypted aes128gcm, ≤ 3 KB):
     { title: string, body: string, url: string (same-origin path, e.g. "/?task=<id>"),
       tag?: string (collapse key, e.g. "task-<id>"), kind?: PushKind | "test" }

   Demo mode (no Supabase): pushAvailability() says "unconfigured" (the
   contract), and isPushDemo() lets Settings offer a local stand-in: the
   switch asks the browser for permission and the test notification is
   shown right here, without a server. Nothing leaves the browser.

   Signing out (shared computers): push is only offered while the app runs
   watchPushSession() (mounted once, in AuthProvider). It drops this
   browser's subscription whenever nobody is signed in (but not while an
   expired session is merely waiting to refresh offline), and drops one that
   belongs to a different account when someone signs in. The app also calls
   disablePush() before signing out (deletes the row while it still can)
   and disablePushEverywhere() before "Sign out of all devices".
   ============================================================ */
import type { PushAvailability, PushKind } from "../data/types";
import { isSupabaseConfigured, supabase } from "./supabase";
import { isIos, isStandalone } from "./install";

/** The VAPID public key baked in at build time ("" when unset). */
export const VAPID_PUBLIC_KEY: string = (import.meta.env.VITE_VAPID_PUBLIC_KEY ?? "").trim();

/** The kinds people can switch push on/off for, in Settings order. */
export const PUSH_KINDS: readonly { key: PushKind; label: string; hint: string }[] = [
  { key: "assigned", label: "Assigned to me", hint: "Someone gives you a task." },
  { key: "mention", label: "Mentions", hint: "Someone @mentions you in a comment." },
  { key: "comment", label: "Comments on my tasks", hint: "New comments on tasks you own or follow." },
  { key: "approval", label: "Approvals", hint: "Someone asks for your approval, or decides on a request you made." },
  { key: "kudos", label: "Kudos", hint: "A teammate thanks you for something you finished." },
  { key: "due", label: "Due-date reminders", hint: "Your morning nudge about what's due." },
];

/** notify_prefs key for a kind's push toggle: "assigned" → "assigned_push". */
export const pushPrefKey = (kind: PushKind): string => `${kind}_push`;

/** The same words the server's test push uses (supabase/functions/_shared/webpush.ts TEST_PUSH). */
export const TEST_NOTIFICATION = {
  title: "Notifications are on",
  body: "This is how Kanbo will let you know when something needs you.",
};

/** Demo mode: no backend, so push is a local stand-in (see the header). */
export const isPushDemo = (): boolean => !isSupabaseConfigured;

/** The browser has everything web push needs (service worker, PushManager, Notification). */
export function pushSupported(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined"
    && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

const notifPermission = (): NotificationPermission | "unsupported" => {
  try { return typeof Notification === "undefined" ? "unsupported" : Notification.permission; } catch { return "unsupported"; }
};

let keyBytes: Uint8Array | null | undefined;
/** The VAPID key as bytes, or null when it's unset or isn't a P-256 public key. */
function vapidKey(): Uint8Array | null {
  if (keyBytes !== undefined) return keyBytes;
  try {
    const k = VAPID_PUBLIC_KEY ? urlBase64ToUint8Array(VAPID_PUBLIC_KEY) : null;
    keyBytes = k && k.length === 65 && k[0] === 4 ? k : null;
  } catch { keyBytes = null; }
  return keyBytes;
}

/** How many watchPushSession() guards are running (see the header). */
let sessionWatchers = 0;

/** Can push be offered on this device right now? (Synchronous; no prompts.)
 *  "unconfigured" in demo, without a usable key, or while the app isn't
 *  running the sign-out guard (watchPushSession): a device must never be
 *  left subscribed for someone who has signed out. */
export function pushAvailability(): PushAvailability {
  if (!isSupabaseConfigured || !vapidKey() || sessionWatchers === 0) return "unconfigured";
  if (!pushSupported()) return "unsupported";
  if (notifPermission() === "denied") return "denied";
  return "ready";
}

/** base64url (VAPID key) → bytes for PushManager.subscribe({ applicationServerKey }). */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const clean = String(base64 ?? "").trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new Error("not base64url");
  const raw = atob(clean + "===".slice((clean.length + 3) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ---------- copy for the states Settings explains ---------- */

/** Why push can't work in this browser, in a sentence. */
export function unsupportedMessage(): string {
  if (isIos() && !isStandalone()) return "On iPhone and iPad, add Kanbo to your Home Screen first (Share, then Add to Home Screen), then switch this on from there.";
  return "This browser can't receive push notifications. Chrome, Edge, Firefox and Safari can.";
}

/** How to undo a block, in a sentence. */
export function deniedMessage(): string {
  if (isIos()) return "Notifications are blocked for Kanbo. Allow them in the Settings app, under Notifications, then come back.";
  return "Notifications are blocked for Kanbo in this browser. Allow them in the site settings (the icon beside the address), then come back.";
}

/* ---------- small helpers ---------- */

const changeListeners = new Set<() => void>();
/** Told when push is switched on/off here (so every open panel agrees). */
export function onPushChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}
function changed(): void {
  for (const fn of [...changeListeners]) { try { fn(); } catch { /* ignore */ } }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/** Notification.requestPermission, promise or (old Safari) callback style. */
function requestPermission(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    try {
      const p = Notification.requestPermission((r) => resolve(r));
      if (p && typeof p.then === "function") p.then(resolve, () => resolve(Notification.permission));
    } catch { resolve(notifPermission() === "granted" ? "granted" : "default"); }
  });
}

/** The service worker that receives pushes. Production registers it at
 *  startup (main.tsx); a dev build registers a push-only copy here. */
const SW_URL = import.meta.env.DEV ? "/sw.js?push-only=1" : "/sw.js";
async function registration(create: boolean): Promise<ServiceWorkerRegistration | null> {
  try {
    const existing = await navigator.serviceWorker.getRegistration("/");
    if (existing?.active) return existing;
    if (!existing && !create) return null;
    if (!existing) await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    return await withTimeout(navigator.serviceWorker.ready, 10_000, null as ServiceWorkerRegistration | null);
  } catch { return null; }
}

/** sub.unsubscribe() that never throws or rejects. */
const unsubscribeQuietly = (sub: PushSubscription): Promise<boolean> =>
  Promise.resolve().then(() => sub.unsubscribe()).catch(() => false);

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await registration(false);
  if (!reg?.pushManager) return null;
  try { return await reg.pushManager.getSubscription(); } catch { return null; }
}

/** Was this subscription made with Kanbo's current key? (A rotated key needs a fresh one.) */
function madeWithOurKey(sub: PushSubscription, key: Uint8Array): boolean {
  const k = sub.options?.applicationServerKey;
  if (!k) return true; // the browser doesn't say: assume so
  const a = new Uint8Array(k);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

const isMissingErr = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string; status?: number } | null;
  const code = String(err?.code ?? "");
  return code === "42P01" || code === "PGRST202" || code === "PGRST205" || err?.status === 404
    || /does not exist|schema cache|could not find the function/i.test(String(err?.message ?? ""));
};
const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** A sentence for a failed save (exported for tests). */
export function saveErrorMessage(e: unknown): string {
  const msg = String((e as { message?: string } | null)?.message ?? e ?? "");
  if (isMissingErr(e)) return "Push notifications aren't switched on for Kanbo yet.";
  if (offline() || /failed to fetch|network/i.test(msg)) return "You're offline. Try again when you're back online.";
  if (/not authorized/i.test(msg)) return "Sign in again, then switch this on.";
  if (/invalid subscription/i.test(msg)) return "This browser gave Kanbo a subscription it can't use. Try again.";
  return "Couldn't switch on notifications. Try again.";
}

const OWNER_KEY = "kanbo-push-owner";
const ENDPOINT_KEY = "kanbo-push-endpoint";
const remember = (owner: string | null, endpoint: string | null) => {
  try {
    if (owner && endpoint) { localStorage.setItem(OWNER_KEY, owner); localStorage.setItem(ENDPOINT_KEY, endpoint); }
    else { localStorage.removeItem(OWNER_KEY); localStorage.removeItem(ENDPOINT_KEY); }
  } catch { /* private mode */ }
};
const recalled = (): { owner: string | null; endpoint: string | null } => {
  try { return { owner: localStorage.getItem(OWNER_KEY), endpoint: localStorage.getItem(ENDPOINT_KEY) }; } catch { return { owner: null, endpoint: null }; }
};
async function myId(): Promise<string | null> {
  try { const { data } = await supabase!.auth.getSession(); return data.session?.user?.id ?? null; } catch { return null; }
}

async function saveSubscription(sub: PushSubscription): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: "Push notifications aren't set up yet." };
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return { ok: false, message: saveErrorMessage({ message: "invalid subscription" }) };
  try {
    const { error } = await supabase.rpc("save_push_subscription", {
      p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
      p_user_agent: (navigator.userAgent || "").slice(0, 300) || null,
    });
    if (error) return { ok: false, message: saveErrorMessage(error) };
    remember(await myId(), j.endpoint);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: saveErrorMessage(e) };
  }
}

/* ---------- demo stand-in ---------- */

let demoOn = false;

async function showLocalNotification(): Promise<boolean> {
  if (notifPermission() !== "granted") return false;
  const opts: NotificationOptions = { body: TEST_NOTIFICATION.body, icon: "/icon-192.png", badge: "/badge-96.png", tag: "kanbo-test", lang: "en-GB" };
  try {
    const reg = "serviceWorker" in navigator ? await withTimeout(navigator.serviceWorker.getRegistration("/"), 1500, undefined) : undefined;
    if (reg) { await reg.showNotification(TEST_NOTIFICATION.title, opts); return true; }
  } catch { /* fall back to a page notification */ }
  try { new Notification(TEST_NOTIFICATION.title, opts); return true; } catch { return false; }
}

/* ---------- the API Settings uses ---------- */

/** Is this device subscribed (and saved) for the signed-in person? */
export async function isPushOnHere(): Promise<boolean> {
  if (isPushDemo()) return demoOn;
  const key = vapidKey();
  if (pushAvailability() !== "ready" || !key || notifPermission() !== "granted") return false;
  const sub = await currentSubscription();
  if (!sub || !madeWithOurKey(sub, key)) return false;
  try {
    // RLS: only the caller's own rows are visible, so this is "saved for me"
    const { data, error } = await supabase!.from("push_subscriptions").select("id").eq("endpoint", sub.endpoint).maybeSingle();
    if (error) return isMissingErr(error) ? false : true; // offline / a blip: trust the browser's subscription
    return !!data;
  } catch { return true; }
}

export type PushEnableResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "unconfigured" | "denied" | "dismissed" | "save_failed"; message: string };

const DENIED = (): PushEnableResult => ({ ok: false, reason: "denied", message: deniedMessage() });
const DISMISSED: PushEnableResult = { ok: false, reason: "dismissed", message: "Notifications weren't allowed. Switch this on again when you're ready." };

/** Ask permission (only from a click), subscribe, save. Never throws. */
export async function enablePush(): Promise<PushEnableResult> {
  if (isPushDemo()) {
    if (typeof Notification !== "undefined") {
      let p = notifPermission();
      if (p === "default") p = await requestPermission();
      if (p === "denied") return DENIED();
      if (p !== "granted") return DISMISSED;
    }
    demoOn = true;
    changed();
    return { ok: true };
  }
  const avail = pushAvailability();
  if (avail === "unconfigured") return { ok: false, reason: "unconfigured", message: "Push notifications aren't set up yet." };
  if (avail === "unsupported") return { ok: false, reason: "unsupported", message: unsupportedMessage() };
  if (avail === "denied") return DENIED();
  // ask first, straight from the click (Safari only allows it during a gesture)
  let permission = notifPermission();
  if (permission !== "granted") permission = await requestPermission();
  if (permission === "denied") return DENIED();
  if (permission !== "granted") return DISMISSED;

  const reg = await registration(true);
  if (!reg?.pushManager) return { ok: false, reason: "unsupported", message: "Couldn't start Kanbo's notification service in this browser. Reload the page and try again." };
  const key = vapidKey()!;
  let sub: PushSubscription | null = null;
  try { sub = await reg.pushManager.getSubscription(); } catch { sub = null; }
  if (sub && !madeWithOurKey(sub, key)) { try { await sub.unsubscribe(); } catch { /* replaced below */ } sub = null; }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.slice().buffer as ArrayBuffer });
    } catch (e) {
      if ((e as { name?: string })?.name === "NotAllowedError") return DENIED();
      return { ok: false, reason: "unsupported", message: "This browser couldn't set up push notifications. Try again, or use another browser." };
    }
  }
  const saved = await saveSubscription(sub);
  if (!saved.ok) {
    try { await sub.unsubscribe(); } catch { /* best effort */ }
    return { ok: false, reason: "save_failed", message: saved.message };
  }
  changed();
  return { ok: true };
}

/** Unsubscribe this device and delete its row. Never throws, and gives up
 *  after about 6 s at worst. Call it before signing out: the row can only be
 *  deleted while signed in (if it's left behind, the browser's subscription
 *  is still gone, so the next push gets 410 and the server drops the row). */
export async function disablePush(): Promise<void> {
  if (isPushDemo()) { if (demoOn) { demoOn = false; changed(); } return; }
  try {
    const sub = await withTimeout(currentSubscription(), 3000, null);
    remember(null, null);
    if (!sub) return;
    const endpoint = sub.endpoint;
    const deleteRow = supabase
      ? Promise.resolve(supabase.from("push_subscriptions").delete().eq("endpoint", endpoint)).catch(() => null)
      : Promise.resolve(null);
    // both at once: the browser side matters most, and must not wait on the network
    await withTimeout(Promise.all([deleteRow, unsubscribeQuietly(sub)]), 3000, null);
  } catch { /* never throws */ }
  changed();
}

/** "Sign out of all devices": delete every device's row for this account
 *  (while still signed in), so phones and laptops that are closed right now
 *  stop getting notifications at once, then switch this device off. Never throws. */
export async function disablePushEverywhere(): Promise<void> {
  if (!isPushDemo() && supabase) {
    try {
      const me = await withTimeout(myId(), 3000, null);
      if (me) await withTimeout(Promise.resolve(supabase.from("push_subscriptions").delete().eq("user_id", me)).catch(() => null), 3000, null);
    } catch { /* best effort */ }
  }
  await disablePush();
}

/** Drop this browser's subscription without touching the database (nobody
 *  is signed in to delete the row; the next push to it gets 410 and the
 *  server drops it). Never throws. */
async function dropSubscriptionHere(sub?: PushSubscription | null): Promise<void> {
  try {
    remember(null, null);
    const s = sub ?? await withTimeout(currentSubscription(), 3000, null);
    if (!s) return;
    await withTimeout(unsubscribeQuietly(s), 3000, false);
    changed();
  } catch { /* never throws */ }
}

/** Send a test notification to this device. */
export async function sendTestPush(): Promise<{ ok: boolean; message: string }> {
  if (isPushDemo()) {
    if (!demoOn) return { ok: false, message: "Switch on notifications for this device first." };
    return (await showLocalNotification())
      ? { ok: true, message: "Test notification sent." }
      : { ok: true, message: "In the demo, your test notification would arrive on this device now." };
  }
  if (pushAvailability() !== "ready" || !supabase) return { ok: false, message: "Switch on notifications for this device first." };
  const sub = await currentSubscription();
  if (!sub) return { ok: false, message: "Switch on notifications for this device first." };
  try {
    const { error } = await supabase.functions.invoke("notify", { body: { kind: "test", endpoint: sub.endpoint } });
    if (!error) return { ok: true, message: "Test sent. It should arrive in a few seconds." };
    let reason = "";
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try { reason = String(((await ctx.clone().json()) as { reason?: string })?.reason ?? ""); } catch { /* not JSON */ }
    }
    if ((error as { name?: string }).name === "FunctionsFetchError" || offline()) return { ok: false, message: "You're offline. Try again when you're back online." };
    if (reason === "rate_limited") return { ok: false, message: "You've sent a few tests already. Try again in a few minutes." };
    if (reason === "no_subscription") return { ok: false, message: "This device isn't subscribed any more. Switch notifications off and on again." };
    if (reason === "push_failed") return { ok: false, message: "The browser's push service didn't take it. Try again in a minute." };
    return { ok: false, message: "Kanbo's server can't send push notifications yet." };
  } catch {
    return { ok: false, message: "Couldn't send a test notification. Try again." };
  }
}

/** Is this endpoint saved for the signed-in person? null when we can't tell (offline, before 0043). */
async function savedForMe(endpoint: string): Promise<boolean | null> {
  if (!supabase) return null;
  try {
    // RLS: only the caller's own rows are visible
    const { data, error } = await supabase.from("push_subscriptions").select("id").eq("endpoint", endpoint).maybeSingle();
    if (error) return null;
    return !!data;
  } catch { return null; }
}

/**
 * After sign-in (watchPushSession calls it): make sure this browser only
 * receives the signed-in person's notifications.
 *  - The subscription belongs to another account (someone else switched push
 *    on here and never signed out properly): drop it from this browser.
 *  - It's this person's, and the browser replaced it (sw.js resubscribes on
 *    `pushsubscriptionchange`, e.g. Firefox rotating it): save the new one.
 * A second account signing in never inherits push. Best effort; never throws.
 */
export async function refreshPushSubscription(): Promise<void> {
  if (isPushDemo() || !supabase || !pushSupported()) return;
  try {
    const sub = await withTimeout(currentSubscription(), 3000, null);
    if (!sub) return;
    const me = await myId();
    if (!me) return;
    const { owner, endpoint } = recalled();
    if (owner && owner !== me) { await dropSubscriptionHere(sub); return; }
    if (!owner) {
      // we don't know whose it is (site data was cleared): keep it only if it's saved for this person
      const mine = await savedForMe(sub.endpoint);
      if (mine === true) remember(me, sub.endpoint);
      else if (mine === false) await dropSubscriptionHere(sub);
      return;
    }
    const key = vapidKey();
    if (notifPermission() !== "granted" || !key || !madeWithOurKey(sub, key) || sub.endpoint === endpoint) return;
    await saveSubscription(sub);
  } catch { /* best effort */ }
}

/**
 * Does supabase-js still hold a session it just couldn't use? Opening Kanbo
 * offline (or while Auth is unreachable) with an expired access token makes
 * it report "no session" (INITIAL_SESSION with null) while keeping the
 * stored session and its refresh token, and it signs the same person back
 * in once it can refresh. That isn't a sign-out. A real sign-out (any
 * button, another tab, a revoked or rejected session) removes the stored
 * session first.
 */
function sessionStillHeld(): boolean {
  try {
    const own = (supabase?.auth as unknown as { storageKey?: string } | undefined)?.storageKey;
    const keys = own ? [own] : [];
    if (!keys.length) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^sb-.+-auth-token$/.test(k)) keys.push(k);
      }
    }
    return keys.some((k) => {
      const raw = localStorage.getItem(k);
      if (!raw) return false;
      const s = JSON.parse(raw) as { refresh_token?: unknown } | null;
      return typeof s?.refresh_token === "string" && s.refresh_token.length > 0;
    });
  } catch { return false; }
}

/**
 * The sign-out guard. Mount it once, at startup, for the life of the page
 * (AuthProvider: `useEffect(() => watchPushSession(), [])`); push is only
 * offered while it runs. Nobody signed in (sign-out, a revoked session, a
 * page that opens signed out): this browser's subscription is dropped, so
 * the next person at a shared computer never sees the last person's
 * notifications. An expired session supabase-js couldn't refresh yet
 * (offline) isn't a sign-out: push stays until it's sorted either way.
 * Someone signed in: refreshPushSubscription().
 * Returns the stop function. A no-op in demo mode.
 */
export function watchPushSession(): () => void {
  if (isPushDemo() || !supabase) return () => {};
  let stopped = false;
  let last: string | null | undefined;
  let unsubscribe = () => {};
  try {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const uid = session?.user?.id ?? null;
      if (uid === last) return; // token refreshes, profile updates
      last = uid;
      // outside the auth callback: supabase-js deadlocks when a callback awaits its own client
      setTimeout(() => {
        if (stopped) return;
        if (uid) { void refreshPushSubscription(); return; }
        if (!sessionStillHeld()) { void dropSubscriptionHere(); return; }
        // a held session that couldn't refresh (offline): not settled, so the
        // next event counts even if it's another null (SIGNED_OUT once the
        // session is rejected and removed); a refresh brings the uid back
        if (last === null) last = undefined;
      }, 0);
    });
    unsubscribe = () => data.subscription.unsubscribe();
  } catch { return () => {}; }
  sessionWatchers++;
  changed();
  return () => {
    if (stopped) return;
    stopped = true;
    sessionWatchers = Math.max(0, sessionWatchers - 1);
    try { unsubscribe(); } catch { /* ignore */ }
    changed();
  };
}

/**
 * Messages from the service worker: "kanbo:navigate" (a notification was
 * clicked while Kanbo is open: route there in place, answering on the port so
 * the worker doesn't reload the page) and "kanbo:push-resubscribed".
 * `onNavigate` gets a same-origin path like "/?task=<id>".
 */
export function listenForPushMessages(onNavigate: (path: string) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !navigator.serviceWorker) return () => {};
  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (!d || typeof d !== "object") return;
    if (d.type === "kanbo:navigate") {
      const url = typeof d.url === "string" && d.url.startsWith("/") && !d.url.startsWith("//") ? d.url : null;
      let ok = false;
      if (url) { try { onNavigate(url); ok = true; } catch { ok = false; } }
      try { e.ports?.[0]?.postMessage({ ok }); } catch { /* the worker gave up waiting */ }
    } else if (d.type === "kanbo:push-resubscribed") {
      void refreshPushSubscription();
    }
  };
  // (the same container on the way out, whatever happens to navigator meanwhile)
  const container = navigator.serviceWorker;
  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}

/** Tests only. */
export function __resetPushForTests(): void {
  demoOn = false;
  keyBytes = undefined;
  sessionWatchers = 0;
  changeListeners.clear();
}
