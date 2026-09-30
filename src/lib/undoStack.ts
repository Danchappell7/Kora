/* ============================================================
   KANBO — the app-wide undo stack behind ⌘Z.
   Anything undoable (a toast's Undo, an applied Ask, a bulk move)
   registers here for a short window. ⌘Z runs the newest live entry
   once; entries expire after `ttlMs` (10s by default, the same window
   an Undo toast stays up), and the remover a push returns takes an
   entry off early — e.g. when its toast's own Undo button ran it, or
   the change it undoes has been committed.
   Module state, not React state: it has to be reachable from key
   handlers, toasts and stores alike. Nothing here re-renders.
   ============================================================ */

export const UNDO_TTL_MS = 10000;

interface Entry { id: number; label: string; run: () => void; expiresAt: number }

let entries: Entry[] = [];
let seq = 0;

const prune = (now = Date.now()) => { entries = entries.filter((e) => e.expiresAt > now); };

/** Register an undoable change. Returns a remover (safe to call more than once). */
export function pushUndo(label: string, run: () => void, ttlMs: number = UNDO_TTL_MS): () => void {
  const id = ++seq;
  entries.push({ id, label, run, expiresAt: Date.now() + Math.max(0, ttlMs) });
  return () => { entries = entries.filter((e) => e.id !== id); };
}

/** Run the newest live entry (once) and return its label for a toast, or null when there is nothing to undo. */
export function undoLast(): string | null {
  prune();
  const entry = entries.pop();
  if (!entry) return null;
  try { entry.run(); } catch (err) { console.error(err); }
  return entry.label;
}

/** Whether ⌘Z would do anything right now. */
export function hasUndo(): boolean {
  prune();
  return entries.length > 0;
}

/** Drop every entry (sign-out, workspace switch, tests). */
export function clearUndo(): void {
  entries = [];
}
