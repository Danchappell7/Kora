/* ============================================================
   KANBO — live presence and co-editing (0048).         [0048 contract → u5]
   Supabase Realtime only (presence + broadcast on one channel per object,
   "kanbo:<kind>:<id>"); no tables. Nothing beyond a name, an avatar colour
   and a user id ever goes on the wire.
   • usePresence(key, me): who else has this task / doc / row open
     ("Sana is viewing"). Join on mount, leave on unmount; heartbeat;
     peers that stop beating fade after PRESENCE_STALE_MS.
   • useTyping(taskId, me): "Theo is typing…" in task comments (broadcast,
     throttled; a typer drops off after TYPING_TTL_MS of silence).
   • useDocCollab(docId, …): block-level operations (insert / update /
     delete / move, each batch with the sender's base version and client
     id) broadcast as you edit and applied as they arrive: edits to
     different blocks merge without conflict; the same block —
     last writer wins, with a subtle "edited by Sana" highlight; remote
     carets / selections in each person's colour. Saving stays the
     existing autosave + version check; the conflict banner only when ops
     couldn't be merged. Broadcasts throttled (DOC_OP_THROTTLE_MS).
   • Graceful: demo mode, offline, or no realtime → you're alone (empty
     peers; ops apply locally only). Never throws into a render.
   The pure parts (applyDocOps, mergeRemoteBatch, peers) are unit-tested.
   ============================================================ */
import type { DocBlock, DocOp, DocOpBatch, PresencePeer } from "../data/types";

export const PRESENCE_HEARTBEAT_MS = 15_000;
export const PRESENCE_STALE_MS = 45_000;
export const TYPING_THROTTLE_MS = 1_500;
export const TYPING_TTL_MS = 4_000;
export const DOC_OP_THROTTLE_MS = 150;
export const CARET_THROTTLE_MS = 100;

export type PresenceKind = "task" | "doc" | "project";
/** the channel key for an object: "task:<id>" (the realtime channel is "kanbo:" + it).  [final] */
export function presenceKey(kind: PresenceKind, id: string): string {
  return `${kind}:${id}`;
}

/** who you are on the wire */
export interface PresenceMe { userId: string; name: string; color: string }

/** Others on this object (never you). key null = not joined. */
export function usePresence(_key: string | null, _me: PresenceMe | null, _opts?: { state?: PresencePeer["state"] }): { peers: PresencePeer[] } {
  return { peers: NO_PEERS };
}

/** Comment typing on a task: others typing, and a function to call on each keystroke (throttled inside). */
export function useTyping(_taskId: string | null, _me: PresenceMe | null): { typers: PresencePeer[]; notifyTyping: () => void; stopTyping: () => void } {
  return { typers: NO_PEERS, notifyTyping: noop, stopTyping: noop };
}

export interface DocCollabOptions {
  me: PresenceMe | null;
  /** the editor's current blocks (read when a remote batch arrives) */
  getBlocks: () => DocBlock[];
  /** apply merged blocks (remote edits) to the editor */
  setBlocks: (blocks: DocBlock[], changed: { blockId: string; by: PresencePeer }[]) => void;
  /** the version (updatedAt) the editor's copy is based on */
  baseVersion: string | null;
  /** read-only viewers still see edits and carets; they never broadcast ops */
  readOnly?: boolean;
}
export interface DocCollab {
  peers: PresencePeer[];
  /** send local ops (throttled, batched) */
  broadcast: (ops: DocOp[]) => void;
  /** send your caret / selection (throttled) */
  setCaret: (caret: PresencePeer["caret"]) => void;
  /** remote ops that couldn't be merged since the last save (→ the conflict banner) */
  unmerged: number;
}
export function useDocCollab(_docId: string | null, _opts: DocCollabOptions): DocCollab {
  return { peers: NO_PEERS, broadcast: noop, setCaret: noop, unmerged: 0 };
}

/* ---------- pure (unit-tested by u5) ---------- */

/** Apply ops to blocks (unknown ids are skipped; a move/insert after a missing block goes to the end). */
export function applyDocOps(blocks: DocBlock[], _ops: DocOp[]): DocBlock[] {
  return blocks;
}

/** Merge a remote batch into local blocks given the local unsent ops: { blocks, conflicts: block ids both sides changed (remote wins) }. */
export function mergeRemoteBatch(blocks: DocBlock[], _batch: DocOpBatch, _pendingLocal: DocOp[]): { blocks: DocBlock[]; changed: string[]; conflicts: string[] } {
  return { blocks, changed: [], conflicts: [] };
}

/** The ops that turn `before` into `after` (block-level diff, for broadcasting an editor change). */
export function diffDocBlocks(_before: DocBlock[], _after: DocBlock[]): DocOp[] {
  return [];
}

/** "Sana is viewing" / "Sana and Theo are viewing" / "Sana, Theo and 2 others are viewing" */
export function presenceSentence(peers: readonly Pick<PresencePeer, "name">[], verb: "viewing" | "typing" | "editing" = "viewing"): string {
  return peers.length ? `${peers[0].name} is ${verb}` : "";
}

const NO_PEERS: PresencePeer[] = [];
function noop(): void { /* u5 */ }
