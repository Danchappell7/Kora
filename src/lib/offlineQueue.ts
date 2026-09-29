/* ============================================================
   KANBO — offline write-replay queue
   Persists task mutations made while offline (or that fail mid-flight
   because the connection dropped) and replays them, in order, on
   reconnect. Reads work offline via the bootstrap snapshot cache in
   store.ts; this module is the write half of "true offline support".

   Only TASK mutations are queued — they're ~95% of real offline
   activity. Everything else still requires a connection and surfaces
   an honest error rather than silently pretending to save.

   Safety rules (shared office PCs, several tabs, flaky Wi-Fi):
   - Every op is stamped with the user who made it, and each user's ops
     live under their own key (kanbo-offline-queue:<uid>). The store only
     replays the signed-in user's ops, so one person's queued edits can
     never be written under someone else's account.
   - localStorage is the source of truth: the queue is re-read before
     every mutation and on the cross-tab 'storage' event, so two open tabs
     can't overwrite each other's queued edits.
   - Ops that keep failing are parked in a dead-letter list
     (kanbo-offline-deadletter:<uid>) rather than dropped, so nothing the
     user typed is silently thrown away.
   ============================================================ */
import type { Task } from "../data/types";

interface OpBase { id: string; ts: number; attempts?: number; userId: string }
export type QueuedMutation =
  /** serverId: the row id this create is (or may already have been) written
   *  under. Set before the first send, so a lost response can be retried
   *  without creating a duplicate, and a later delete knows what to remove. */
  | (OpBase & { kind: "create"; task: Task; serverId?: string })
  | (OpBase & { kind: "update"; taskId: string; patch: Partial<Task> })
  | (OpBase & { kind: "delete"; taskId: string });

export interface DeadLetter { op: QueuedMutation; failedAt: number; error: string }

const QUEUE_PREFIX = "kanbo-offline-queue:";
const DEAD_PREFIX = "kanbo-offline-deadletter:";
/** Pre-namespacing key (one shared queue for whoever was signed in). */
export const LEGACY_QUEUE_KEY = "kanbo-offline-queue";

/* localStorage can be missing or throw (private mode, blocked site data).
   Without it the queue still works in memory for the life of the tab. */
const storage: Storage | null = (() => {
  try {
    if (typeof localStorage === "undefined") return null;
    const k = "__kanbo_probe";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return localStorage;
  } catch { return null; }
})();

let user: string | null = null;
let mem: QueuedMutation[] = [];
let dead: DeadLetter[] = [];
// true when the last write to storage failed (quota): memory holds ops that
// storage doesn't, so don't re-read over them until a write succeeds again.
let dirty = false;
const listeners = new Set<(n: number) => void>();
const deadListeners = new Set<(items: DeadLetter[]) => void>();

const opTaskId = (m: QueuedMutation) => (m.kind === "create" ? m.task.id : m.taskId);
const isOp = (x: unknown): x is QueuedMutation =>
  !!x && typeof x === "object" && typeof (x as QueuedMutation).id === "string" &&
  ["create", "update", "delete"].includes((x as QueuedMutation).kind);

function readList<T>(key: string): T[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as T[]) : [];
  } catch { return []; }
}
function writeList(key: string, list: unknown[]): boolean {
  if (!storage) return false;
  try {
    if (list.length) storage.setItem(key, JSON.stringify(list));
    else storage.removeItem(key);
    return true;
  } catch { return false; } // quota — keep the in-memory copy
}
function readQueue(uid: string): QueuedMutation[] {
  return readList<QueuedMutation>(QUEUE_PREFIX + uid).filter((m) => isOp(m) && m.userId === uid);
}

/** Pull the latest queue from storage (another tab may have changed it). */
function refresh() {
  if (!user || !storage || dirty) return;
  mem = readQueue(user);
}
function notify() { const n = mem.length; listeners.forEach((l) => l(n)); }
function notifyDead() { const d = dead.slice(); deadListeners.forEach((l) => l(d)); }
function persist() {
  if (user && storage) dirty = !writeList(QUEUE_PREFIX + user, mem);
  notify();
}
function persistDead() {
  if (user && storage) writeList(DEAD_PREFIX + user, dead);
  notifyDead();
}
function newOpId() { return "q-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
/** Mutations are scoped to the user who made them. */
function scopeTo(userId?: string) {
  if (userId && userId !== user) offlineQueue.setUser(userId);
  refresh();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!user) return;
    if ((e.key === null || e.key === QUEUE_PREFIX + user) && !dirty) { mem = readQueue(user); notify(); }
    if (e.key === null || e.key === DEAD_PREFIX + user) { dead = readList<DeadLetter>(DEAD_PREFIX + user); notifyDead(); }
  });
}

export const offlineQueue = {
  /** Scope the queue to the signed-in user (null when signed out). */
  setUser(uid: string | null) {
    if (uid === user) { refresh(); notify(); return; }
    user = uid;
    dirty = false;
    mem = uid ? readQueue(uid) : [];
    dead = uid ? readList<DeadLetter>(DEAD_PREFIX + uid) : [];
    notify();
    notifyDead();
  },
  currentUser(): string | null { return user; },

  size() { refresh(); return mem.length; },
  /** Copies, so an op being replayed can't change under the caller (a later
   *  edit collapsing into it must not alter what's recorded as sent). */
  all(): QueuedMutation[] { refresh(); return mem.map((m) => ({ ...m })); },
  /** True if a queued op touches this task — live writes must queue behind it
   *  so a stale queued value can't be replayed over a newer edit. */
  hasPending(taskId: string): boolean { refresh(); return mem.some((m) => opTaskId(m) === taskId); },

  /** Subscribe to queue-length changes (for the sync indicator). Returns an unsubscribe. */
  subscribe(fn: (n: number) => void): () => void {
    listeners.add(fn);
    refresh();
    fn(mem.length);
    return () => { listeners.delete(fn); };
  },

  enqueueCreate(task: Task, userId: string, serverId?: string) {
    scopeTo(userId);
    mem.push({ id: newOpId(), ts: Date.now(), kind: "create", task, userId: userId || user || "", ...(serverId ? { serverId } : {}) });
    persist();
  },

  /** Queue many creates with one storage write (an import that lost its
   *  connection). mayExist: each row may already have reached the server
   *  under its own id. */
  enqueueCreates(tasks: Task[], userId: string, mayExist = false) {
    if (!tasks.length) return;
    scopeTo(userId);
    const who = userId || user || "";
    const ts = Date.now();
    for (const task of tasks) mem.push({ id: newOpId(), ts, kind: "create", task, userId: who, ...(mayExist ? { serverId: task.id } : {}) });
    persist();
  },

  enqueueUpdate(taskId: string, patch: Partial<Task>, userId?: string) {
    scopeTo(userId);
    const who = userId || user || "";
    // collapse consecutive updates to the same task that haven't synced yet —
    // keeps the queue small and replays the latest intent. (A collapse into an
    // op that's mid-replay is safe: ack() only clears the fields it sent.)
    const last = mem[mem.length - 1];
    if (last && last.kind === "update" && last.taskId === taskId && last.userId === who) {
      last.patch = { ...last.patch, ...patch };
      persist();
      return;
    }
    mem.push({ id: newOpId(), ts: Date.now(), kind: "update", taskId, patch, userId: who });
    persist();
  },

  enqueueDelete(taskId: string, userId?: string) {
    scopeTo(userId);
    const who = userId || user || "";
    // a delete supersedes any queued create/update for a task created offline.
    // If its create was never sent, just drop its ops. If it may already have
    // reached the server (a send was attempted), still delete that row.
    const create = mem.find((m): m is Extract<QueuedMutation, { kind: "create" }> => m.kind === "create" && m.task.id === taskId);
    mem = mem.filter((m) => !((m.kind === "update" || m.kind === "create") && opTaskId(m) === taskId));
    if (!create) mem.push({ id: newOpId(), ts: Date.now(), kind: "delete", taskId, userId: who });
    else if (create.serverId || create.attempts) mem.push({ id: newOpId(), ts: Date.now(), kind: "delete", taskId: create.serverId ?? taskId, userId: who });
    persist();
  },

  remove(id: string) { refresh(); mem = mem.filter((m) => m.id !== id); persist(); },

  /** An op replayed successfully. For an update, only the fields that were
   *  sent are cleared, so an edit collapsed into it mid-flight still syncs.
   *  Returns false if the op had already gone (e.g. its task was deleted
   *  while the request was in flight). */
  ack(id: string, sentPatch?: Partial<Task>): boolean {
    refresh();
    const m = mem.find((x) => x.id === id);
    if (!m) return false;
    if (m.kind === "update" && sentPatch) {
      const rest: Record<string, unknown> = { ...m.patch };
      for (const k of Object.keys(sentPatch)) {
        if (JSON.stringify(rest[k]) === JSON.stringify((sentPatch as Record<string, unknown>)[k])) delete rest[k];
      }
      if (Object.keys(rest).length) { m.patch = rest as Partial<Task>; m.attempts = 0; persist(); return true; }
    }
    mem = mem.filter((x) => x.id !== id);
    persist();
    return true;
  },

  /** Record a failed replay attempt; returns the new attempt count so the
   *  caller can dead-letter an op only after it has failed several times
   *  (a transient 500 shouldn't park a user's task on the first miss). */
  bumpAttempts(id: string): number {
    refresh();
    const m = mem.find((x) => x.id === id);
    if (!m) return 0;
    m.attempts = (m.attempts ?? 0) + 1;
    persist();
    return m.attempts;
  },

  /** Pin the row id a queued create will be written under (before sending). */
  setServerId(id: string, serverId: string) {
    refresh();
    const m = mem.find((x) => x.id === id);
    if (m && m.kind === "create") { m.serverId = serverId; persist(); }
  },

  /** A queued create synced under a different id — rewrite later ops. */
  remapId(clientId: string, serverId: string) {
    if (clientId === serverId) return;
    refresh();
    mem.forEach((m) => {
      if (m.kind === "update" && m.taskId === clientId) m.taskId = serverId;
      else if (m.kind === "delete" && m.taskId === clientId) m.taskId = serverId;
      else if (m.kind === "create" && m.task.id === clientId) m.task = { ...m.task, id: serverId };
    });
    persist();
  },

  /** Park an op that keeps failing (and, for a create, the later ops on the
   *  same task, which can't apply without it) instead of dropping it. */
  deadLetter(id: string, error: string) {
    refresh();
    const idx = mem.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const m = mem[idx];
    const moving = m.kind === "create"
      ? mem.filter((x, i) => i === idx || (i > idx && opTaskId(x) === m.task.id))
      : [m];
    const ids = new Set(moving.map((x) => x.id));
    mem = mem.filter((x) => !ids.has(x.id));
    persist();
    if (user && storage) dead = readList<DeadLetter>(DEAD_PREFIX + user);
    const failedAt = Date.now();
    dead = [...dead, ...moving.map((op) => ({ op, failedAt, error }))];
    persistDead();
  },

  /** Changes that couldn't be synced after several attempts. */
  deadLetters(): DeadLetter[] { return dead.slice(); },
  subscribeDeadLetters(fn: (items: DeadLetter[]) => void): () => void {
    deadListeners.add(fn);
    fn(dead.slice());
    return () => { deadListeners.delete(fn); };
  },
  /** Put parked changes back in the queue for another try (all when no ids). */
  retryDeadLetters(opIds?: string[]): number {
    refresh();
    if (user && storage) dead = readList<DeadLetter>(DEAD_PREFIX + user);
    const pick = new Set(opIds ?? dead.map((d) => d.op.id));
    const back = dead.filter((d) => pick.has(d.op.id));
    if (!back.length) return 0;
    dead = dead.filter((d) => !pick.has(d.op.id));
    mem = [...mem, ...back.map((d) => ({ ...d.op, attempts: 0 }))];
    persist();
    persistDead();
    return back.length;
  },
  /** Throw parked changes away for good (all when no ids). */
  discardDeadLetters(opIds?: string[]): number {
    if (user && storage) dead = readList<DeadLetter>(DEAD_PREFIX + user);
    const before = dead.length;
    dead = opIds ? dead.filter((d) => !opIds.includes(d.op.id)) : [];
    persistDead();
    return before - dead.length;
  },

  /** One-off upgrade from the old shared queue. Creates keep the user they
   *  were stamped with; updates/deletes (never stamped) go to ownerHint —
   *  the user the offline snapshot belongs to, i.e. who was last signed in —
   *  or to the only user who queued creates. Anything with no clear owner is
   *  discarded rather than replayed under the wrong account. */
  migrateLegacy(ownerHint: string | null): { moved: number; discarded: number } {
    if (!storage) return { moved: 0, discarded: 0 };
    let raw: string | null = null;
    try { raw = storage.getItem(LEGACY_QUEUE_KEY); } catch { return { moved: 0, discarded: 0 }; }
    if (raw === null) return { moved: 0, discarded: 0 };
    let ops: unknown[] = [];
    try { const v = JSON.parse(raw); if (Array.isArray(v)) ops = v; } catch { /* corrupt — discard */ }
    const legacy = ops.filter(isOp) as (QueuedMutation & { userId?: string })[];
    const creators = [...new Set(legacy.filter((m) => m.kind === "create" && m.userId).map((m) => m.userId as string))];
    const fallback = ownerHint ?? (creators.length === 1 ? creators[0] : null);
    const buckets = new Map<string, QueuedMutation[]>();
    let discarded = ops.length - legacy.length;
    for (const m of legacy) {
      const who = (m.kind === "create" && m.userId) ? m.userId : fallback;
      if (!who) { discarded++; continue; }
      const list = buckets.get(who) ?? [];
      list.push({ ...m, userId: who } as QueuedMutation);
      buckets.set(who, list);
    }
    let moved = 0;
    for (const [who, list] of buckets) {
      if (!writeList(QUEUE_PREFIX + who, [...readQueue(who), ...list])) { discarded += list.length; continue; }
      moved += list.length;
    }
    try { storage.removeItem(LEGACY_QUEUE_KEY); } catch { /* ignore */ }
    if (user && buckets.has(user) && !dirty) { mem = readQueue(user); notify(); }
    return { moved, discarded };
  },

  /** Remove everything stored for a user (e.g. after account deletion). */
  purgeUser(uid: string) {
    if (storage) {
      try { storage.removeItem(QUEUE_PREFIX + uid); storage.removeItem(DEAD_PREFIX + uid); } catch { /* ignore */ }
    }
    if (uid === user) { mem = []; dead = []; dirty = false; notify(); notifyDead(); }
  },

  /** Empty the current user's queue. */
  clear() { mem = []; dirty = false; persist(); },
};
