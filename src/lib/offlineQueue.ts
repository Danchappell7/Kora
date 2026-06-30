/* ============================================================
   KANBO — offline write-replay queue
   Persists task mutations made while offline (or that fail mid-flight
   because the connection dropped) and replays them, in order, on
   reconnect. Reads work offline via the bootstrap snapshot cache in
   store.ts; this module is the write half of "true offline support".

   Only TASK mutations are queued — they're ~95% of real offline
   activity. Everything else still requires a connection and surfaces
   an honest error rather than silently pretending to save.
   ============================================================ */
import type { Task } from "../data/types";

export type QueuedMutation =
  | { id: string; ts: number; kind: "create"; task: Task; userId: string }
  | { id: string; ts: number; kind: "update"; taskId: string; patch: Partial<Task> }
  | { id: string; ts: number; kind: "delete"; taskId: string };

const KEY = "kanbo-offline-queue";
let mem: QueuedMutation[] = load();
const listeners = new Set<(n: number) => void>();

function load(): QueuedMutation[] {
  try { const raw = localStorage.getItem(KEY); return raw ? (JSON.parse(raw) as QueuedMutation[]) : []; }
  catch { return []; }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* private mode / quota */ }
  listeners.forEach((l) => l(mem.length));
}
function uid() { return "q-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

export const offlineQueue = {
  size() { return mem.length; },
  all(): QueuedMutation[] { return mem.slice(); },

  /** Subscribe to queue-length changes (for the sync indicator). Returns an unsubscribe. */
  subscribe(fn: (n: number) => void): () => void {
    listeners.add(fn);
    fn(mem.length);
    return () => listeners.delete(fn);
  },

  enqueueCreate(task: Task, userId: string) { mem.push({ id: uid(), ts: Date.now(), kind: "create", task, userId }); persist(); },

  enqueueUpdate(taskId: string, patch: Partial<Task>) {
    // collapse consecutive updates to the same task that haven't synced yet —
    // keeps the queue small and replays the latest intent.
    const last = mem[mem.length - 1];
    if (last && last.kind === "update" && last.taskId === taskId) { last.patch = { ...last.patch, ...patch }; persist(); return; }
    mem.push({ id: uid(), ts: Date.now(), kind: "update", taskId, patch }); persist();
  },

  enqueueDelete(taskId: string) {
    // a delete supersedes any queued create/update for a task created offline:
    // if it never reached the server, just drop its ops and don't replay a delete.
    const hadCreate = mem.some((m) => m.kind === "create" && m.task.id === taskId);
    mem = mem.filter((m) => !((m.kind === "update" || m.kind === "create") && (m.kind === "create" ? m.task.id : m.taskId) === taskId));
    if (!hadCreate) mem.push({ id: uid(), ts: Date.now(), kind: "delete", taskId });
    persist();
  },

  remove(id: string) { mem = mem.filter((m) => m.id !== id); persist(); },

  /** A queued create synced and the server assigned a new id — rewrite later ops. */
  remapId(clientId: string, serverId: string) {
    if (clientId === serverId) return;
    mem.forEach((m) => {
      if (m.kind === "update" && m.taskId === clientId) m.taskId = serverId;
      else if (m.kind === "delete" && m.taskId === clientId) m.taskId = serverId;
      else if (m.kind === "create" && m.task.id === clientId) m.task = { ...m.task, id: serverId };
    });
    persist();
  },

  clear() { mem = []; persist(); },
};
