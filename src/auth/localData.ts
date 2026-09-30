/* ============================================================
   KANBO — whose data is cached on this device?
   The offline snapshot (store.ts) holds a whole workspace and the
   offline queue (lib/offlineQueue.ts) holds edits that haven't synced.
   On a shared desk or laptop neither may leak into, or replay as,
   the next person who signs in.
   - claimLocalData(uid) runs whenever a session appears, before the
     app sees the user. If this tab's queue or the stored cache belongs
     to another account, their unsynced edits are parked under their id
     (restored when they sign back in, so nothing is lost) and their
     workspace snapshot and view state are dropped. It fails closed:
     the queue is emptied first, whatever storage does afterwards.
   - parkLocalData(uid) runs when a session ends without this tab
     signing out (signed out in another tab, or it expired).
   - clearLocalUserData() runs on an explicit sign-out.
   ============================================================ */
import { offlineQueue, type QueuedMutation } from "../lib/offlineQueue";
import { reportError } from "../lib/monitoring";
import { NEEDS_PASSWORD_KEY } from "./authLinks";

/** must match SNAP_KEY in data/store.ts */
export const SNAPSHOT_KEY = "kanbo-offline-snapshot";
/** must match KEY in lib/offlineQueue.ts */
export const QUEUE_KEY = "kanbo-offline-queue";
/** the account the stored snapshot, queue and view state belong to. Kept
 *  after sign-out, so the next sign-in (and other open tabs) can tell. */
export const OWNER_KEY = "kanbo-local-owner";
export const STASH_PREFIX = "kanbo-offline-stash-";
/** per-account view state that would mislead the next person on this device
 *  (another account's filters can hide your tasks; their "inbox seen" time
 *  can mark your notifications as read; their finished onboarding would
 *  skip yours). Kept across your own sign-out and sign-in. */
export const PER_ACCOUNT_KEYS = ["kanbo-filters", "kanbo-inbox-seen", "kanbo-onboarded"];

/** The account whose edits this tab's in-memory queue holds. offlineQueue
 *  reads storage once per tab, so another tab changing OWNER_KEY doesn't
 *  change whose edits are sitting in this tab's memory. */
let tabOwner: string | null = null;

function storage(): Storage | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

/** Before owner tracking existed: infer the owner from the snapshot or a queued create. */
function inferOwner(s: Storage): string | null {
  try {
    const snap = JSON.parse(s.getItem(SNAPSHOT_KEY) || "null") as { uid?: string } | null;
    if (snap?.uid) return String(snap.uid);
  } catch { /* corrupt snapshot — ignore */ }
  for (const m of offlineQueue.all()) if (m.kind === "create" && m.userId) return m.userId;
  return null;
}

/** Set `ops` aside for `owner` (deduplicated — two tabs can hold the same queued op). */
function stash(s: Storage | null, owner: string, ops: QueuedMutation[]): void {
  if (!ops.length) return;
  try {
    if (!s) throw new Error("storage unavailable");
    let prev: QueuedMutation[] = [];
    try { prev = JSON.parse(s.getItem(STASH_PREFIX + owner) || "[]") as QueuedMutation[]; } catch { /* corrupt — replace */ }
    const seen = new Set(prev.map((m) => m.id));
    s.setItem(STASH_PREFIX + owner, JSON.stringify([...prev, ...ops.filter((m) => !seen.has(m.id))]));
  } catch (e) {
    // storage full or blocked: these edits can't be kept — but they have
    // already left the queue, so they can never replay as someone else
    reportError(e, { op: "stash-offline-edits", count: ops.length });
  }
}

function replay(ops: QueuedMutation[]) {
  for (const m of ops) {
    if (m.kind === "create") offlineQueue.enqueueCreate(m.task, m.userId);
    else if (m.kind === "update") offlineQueue.enqueueUpdate(m.taskId, m.patch);
    else if (m.kind === "delete") offlineQueue.enqueueDelete(m.taskId);
  }
}

/**
 * Make this device's offline data belong to `uid` before the app sees them.
 * Returns true when another account's data was in play on this page — the
 * caller should then reload, because the mounted app already read that
 * account's view state (filters, inbox-seen) into memory.
 */
export function claimLocalData(uid: string): boolean {
  if (!uid) return false;
  const s = storage();
  let storeOwner: string | null = null;
  try { storeOwner = s ? s.getItem(OWNER_KEY) ?? inferOwner(s) : null; } catch { storeOwner = null; }
  const pageOwner = tabOwner;
  const memOwner = pageOwner ?? storeOwner;
  tabOwner = uid;

  // 1. This tab's queue holds someone else's edits: take them out of the
  //    queue before anything else can fail, so they never replay as `uid`.
  if (memOwner && memOwner !== uid) {
    const theirs = offlineQueue.all();
    // clearing persists an empty queue; if the stored queue is already
    // `uid`'s (another tab claimed first), put it back as it was
    let storedForUid: string | null = null;
    try { storedForUid = s && storeOwner === uid ? s.getItem(QUEUE_KEY) : null; } catch { /* ignore */ }
    offlineQueue.clear();
    if (storedForUid) { try { s?.setItem(QUEUE_KEY, storedForUid); } catch { /* ignore */ } }
    // 2. drop the other account's snapshot + view state first (frees space), then park their edits
    if (storeOwner !== uid) {
      try { [SNAPSHOT_KEY, ...PER_ACCOUNT_KEYS].forEach((k) => s?.removeItem(k)); } catch { /* ignore */ }
    }
    stash(s, memOwner, theirs);
  } else if (storeOwner && storeOwner !== uid) {
    // the stored cache is someone else's even though this tab's queue isn't
    try { [SNAPSHOT_KEY, ...PER_ACCOUNT_KEYS].forEach((k) => s?.removeItem(k)); } catch { /* ignore */ }
  }

  // 3. bring back anything of theirs parked earlier
  try {
    const parked = s?.getItem(STASH_PREFIX + uid);
    if (parked) {
      s?.removeItem(STASH_PREFIX + uid);
      replay(JSON.parse(parked) as QueuedMutation[]);
    }
  } catch { /* corrupt stash — nothing to restore */ }

  let owned = false;
  try { s?.setItem(OWNER_KEY, uid); owned = s?.getItem(OWNER_KEY) === uid; } catch { /* storage blocked */ }
  // Reload when this page already showed another account, or mounted with
  // another account's stored state — but only if the claim stuck, so a
  // blocked storage can never cause a reload loop.
  return (!!pageOwner && pageOwner !== uid) || (!!storeOwner && storeOwner !== uid && owned);
}

/** The session ended without this tab signing out (another tab signed out,
 *  or the session expired): set this tab's unsynced edits aside under that
 *  account — restored when they sign back in, never replayed as anyone else. */
export function parkLocalData(uid: string): void {
  const ops = offlineQueue.all();
  if (!ops.length) return;
  offlineQueue.clear();
  stash(storage(), uid, ops);
}

/** Explicit sign-out: drop the workspace snapshot and the queue (the person
 *  chose to discard anything unsynced). The owner marker and view state stay,
 *  so the same person signing back in keeps their filters and unread badge,
 *  and claimLocalData clears them if someone else signs in. */
export function clearLocalUserData(): void {
  offlineQueue.clear();
  const s = storage();
  if (s) {
    try { [SNAPSHOT_KEY, QUEUE_KEY].forEach((k) => s.removeItem(k)); } catch { /* ignore */ }
  }
  try { sessionStorage.removeItem(NEEDS_PASSWORD_KEY); } catch { /* ignore */ }
}

/** supabase-js's persisted session keys (default `sb-<ref>-auth-token`, plus
 *  its PKCE verifier and split user copy) */
export function isAuthStorageKey(key: string, storageKey?: string | null): boolean {
  if (storageKey && (key === storageKey || key === `${storageKey}-code-verifier` || key === `${storageKey}-user`)) return true;
  return /^sb-.+-auth-token(-code-verifier|-user)?$/.test(key);
}

/** Remove the persisted session ourselves. supabase-js only does this when
 *  its /logout call succeeds; offline (or on an Auth 5xx) it keeps the
 *  session, and the next page load would sign the same person back in. */
export function forgetStoredSession(storageKey?: string | null): void {
  const s = storage();
  if (!s) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && isAuthStorageKey(k, storageKey)) doomed.push(k);
    }
    doomed.forEach((k) => s.removeItem(k));
  } catch { /* storage blocked — nothing persisted to forget */ }
}

/** Page navigation, behind an object so tests can stub it (jsdom can't navigate). */
export const pageNav = {
  /** a fresh page load: drops every in-memory cache of the previous account */
  reload(): void { try { window.location.reload(); } catch { /* non-browser */ } },
  /** reload at the bare path (no stale query/hash) */
  restart(): void { try { window.location.replace(window.location.pathname); } catch { /* non-browser */ } },
};
