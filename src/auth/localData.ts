/* ============================================================
   KANBO — whose data is cached on this device?
   The offline snapshot (store.ts) holds a whole workspace and the
   offline queue (lib/offlineQueue.ts) holds edits that haven't synced.
   On a shared desk or laptop neither may leak into, or replay as,
   the next person who signs in.
   - claimLocalData(uid) runs whenever a session appears, before the
     app sees the user. If the cache belongs to another account, their
     unsynced edits are parked under their id (restored when they sign
     back in, so nothing is lost) and their workspace snapshot is dropped.
   - clearLocalUserData() runs on an explicit sign-out.
   ============================================================ */
import { offlineQueue, type QueuedMutation } from "../lib/offlineQueue";
import { NEEDS_PASSWORD_KEY } from "./authLinks";

/** must match SNAP_KEY in data/store.ts */
export const SNAPSHOT_KEY = "kanbo-offline-snapshot";
export const OWNER_KEY = "kanbo-local-owner";
export const STASH_PREFIX = "kanbo-offline-stash-";
/** per-account view state that would mislead the next person on this device
 *  (another account's filters can hide your tasks; their "inbox seen" time
 *  can mark your notifications as read). */
export const PER_ACCOUNT_KEYS = ["kanbo-filters", "kanbo-inbox-seen"];

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

function replay(ops: QueuedMutation[]) {
  for (const m of ops) {
    if (m.kind === "create") offlineQueue.enqueueCreate(m.task, m.userId);
    else if (m.kind === "update") offlineQueue.enqueueUpdate(m.taskId, m.patch);
    else if (m.kind === "delete") offlineQueue.enqueueDelete(m.taskId);
  }
}

export function claimLocalData(uid: string): void {
  const s = storage();
  if (!s || !uid) return;
  try {
    const owner = s.getItem(OWNER_KEY) ?? inferOwner(s);
    if (owner && owner !== uid) {
      const pending = offlineQueue.all();
      if (pending.length) {
        // keep the other account's unsynced edits for when they come back
        const prev = JSON.parse(s.getItem(STASH_PREFIX + owner) || "[]") as QueuedMutation[];
        s.setItem(STASH_PREFIX + owner, JSON.stringify([...prev, ...pending]));
      }
      offlineQueue.clear();
      s.removeItem(SNAPSHOT_KEY);
      PER_ACCOUNT_KEYS.forEach((k) => s.removeItem(k));
    }
    const stash = s.getItem(STASH_PREFIX + uid);
    if (stash) {
      s.removeItem(STASH_PREFIX + uid);
      replay(JSON.parse(stash) as QueuedMutation[]);
    }
    s.setItem(OWNER_KEY, uid);
  } catch { /* storage blocked or corrupt — nothing to protect */ }
}

export function clearLocalUserData(): void {
  offlineQueue.clear();
  const s = storage();
  if (s) {
    try { [SNAPSHOT_KEY, OWNER_KEY, ...PER_ACCOUNT_KEYS].forEach((k) => s.removeItem(k)); } catch { /* ignore */ }
  }
  try { sessionStorage.removeItem(NEEDS_PASSWORD_KEY); } catch { /* ignore */ }
}
