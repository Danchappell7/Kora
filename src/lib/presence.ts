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

   How the co-editing converges (DocReplica, below):
   • Every write carries a stamp [n, clientId]: n is a hybrid logical
     clock (≥ the wall clock, past every stamp seen, and published in
     presence so a newcomer is ahead before its first edit). Content and
     position are separate last-writer-wins registers per block, so two
     people editing different blocks never touch each other, and the same
     block ends the same everywhere (highest stamp).
   • Inserts and moves are placed after their anchor, stepping over later
     concurrent inserts (the RGA rule), so two lines added after the same
     paragraph land in the same order for everyone. A deleted block stays
     in the sequence, hidden, so a late op anchored on it still lands where
     it was, and an edit newer than the delete brings it back in place.
     A move racing an insert after the moved block is the one case RGA
     can't order the same everywhere: quiet editors compare their order
     now and then and the highest client id's stands (the order check).
   • The shadow is what everyone has; local edits are the diff between the
     shadow and the editor, sent every DOC_OP_THROTTLE_MS. A remote batch
     is applied to the shadow and the unsent local edits are re-applied on
     top (rebase); the same block edited on both sides: the remote copy
     wins (a conflict, highlighted), except a remote delete never eats
     words you're still typing.
   • Saving: each editor saves its own work (autosave + version check);
     when someone else's save lands, the editor merges it three ways
     (mergeDocVersions: the last saved copy, yours, theirs). A copy of a
     block you've already seen (live) isn't a conflict; only a block both
     sides changed without seeing each other's version shows the banner.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocBlock, DocOp, DocOpBatch, PresencePeer } from "../data/types";
import { normaliseSpans } from "./docBlocks";
import { parseDocBody } from "./docs";
import {
  CARET_THROTTLE_MS, DOC_OP_THROTTLE_MS, NO_PEERS, parseCaret, parseSender, presenceKey, samePeers, toPeers, useStableMe, usePresenceClient,
  type PeerEntry, type PresenceConn, type PresenceMe,
} from "../components/presence/core";

export {
  PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS, TYPING_THROTTLE_MS, TYPING_TTL_MS, DOC_OP_THROTTLE_MS, CARET_THROTTLE_MS,
  presenceKey, presenceSentence, presenceMeFrom, usePresence, useTyping, useProjectPresence, PresenceContext, createPresenceClient,
} from "../components/presence/core";
export type { PresenceKind, PresenceMe, PresenceClient, PresenceTransport } from "../components/presence/core";

/* ======================================================================
   pure: block ops
   ====================================================================== */

const opId = (op: DocOp): string => (op.t === "insert" || op.t === "update" ? op.block.id : op.blockId);

/** A block's content as a canonical string (key order, mark order and absent-vs-default never matter). */
export function blockSig(b: DocBlock): string {
  return JSON.stringify([
    b.type,
    b.type === "divider" ? 0 : (b.spans ?? []).map((s) => [s.text, s.marks?.length ? [...s.marks].sort() : 0, s.href ?? 0, s.mention ?? 0]),
    b.checked ? 1 : 0, b.taskId ?? 0, b.icon ?? 0, b.indent ?? 0,
  ]);
}
const sameBlock = (a: DocBlock | undefined, b: DocBlock | undefined): boolean => a === b || (!!a && !!b && blockSig(a) === blockSig(b));

/** A doc's title + blocks as one canonical string (what "the same doc" means between two tabs). */
export function docSig(title: string, blocks: readonly DocBlock[]): string {
  return JSON.stringify([title.trim(), blocks.map((b) => b.id + "\u0000" + blockSig(b))]);
}

/** A short hash of a string (cyrb53): for "saved" notices and the versions each block has had. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Apply ops to blocks (unknown ids are skipped; a move/insert after a missing block goes to the end).
 *  An insert of a block that's already there replaces it and moves it. Never mutates its input. */
export function applyDocOps(blocks: DocBlock[], ops: DocOp[]): DocBlock[] {
  const list = blocks.slice();
  const find = (id: string) => list.findIndex((b) => b.id === id);
  const place = (afterId: string | null, block: DocBlock) => {
    if (afterId === null) { list.unshift(block); return; }
    const j = find(afterId);
    list.splice(j >= 0 ? j + 1 : list.length, 0, block);
  };
  for (const op of ops) {
    switch (op.t) {
      case "insert": {
        const i = find(op.block.id);
        if (i >= 0) list.splice(i, 1);
        place(op.afterId === op.block.id ? null : op.afterId, op.block);
        break;
      }
      case "update": {
        const i = find(op.block.id);
        if (i >= 0) list[i] = op.block;
        break;
      }
      case "delete": {
        const i = find(op.blockId);
        if (i >= 0) list.splice(i, 1);
        break;
      }
      case "move": {
        if (op.afterId === op.blockId) break;
        const i = find(op.blockId);
        if (i < 0) break;
        const [b] = list.splice(i, 1);
        place(op.afterId, b);
        break;
      }
    }
  }
  return list;
}

/** Longest increasing subsequence (indices into seq), O(n log n). */
function lis(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.add(k);
  return out;
}

/** The ops that turn `before` into `after` (block-level diff, for broadcasting an editor change):
 *  deletes, then inserts and moves in `after`'s order (each after its predecessor there), then updates.
 *  applyDocOps(before, diffDocBlocks(before, after)) is `after`. Blocks that are the same object are equal
 *  without comparing (the editor never mutates a block), so a keystroke costs one comparison. */
export function diffDocBlocks(before: DocBlock[], after: DocBlock[]): DocOp[] {
  const bi = new Map<string, number>();
  before.forEach((b, i) => bi.set(b.id, i));
  const inAfter = new Set(after.map((b) => b.id));
  const ops: DocOp[] = [];
  for (const b of before) if (!inAfter.has(b.id)) ops.push({ t: "delete", blockId: b.id });
  // blocks in both: the longest run that kept its order stays put; the rest move
  const common: number[] = [];
  const commonPos: number[] = [];
  after.forEach((b, j) => { const i = bi.get(b.id); if (i !== undefined) { common.push(i); commonPos.push(j); } });
  const keep = lis(common);
  const stay = new Set<number>();
  keep.forEach((k) => stay.add(commonPos[k]));
  after.forEach((b, j) => {
    const prevId = j === 0 ? null : after[j - 1].id;
    if (!bi.has(b.id)) ops.push({ t: "insert", block: b, afterId: prevId });
    else if (!stay.has(j)) ops.push({ t: "move", blockId: b.id, afterId: prevId });
  });
  for (const b of after) {
    const i = bi.get(b.id);
    if (i !== undefined && !sameBlock(before[i], b)) ops.push({ t: "update", block: b });
  }
  return ops;
}

/** Merge a remote batch into local blocks given the local unsent ops: { blocks, conflicts: block ids both sides changed (remote wins) }.
 *  `blocks` is the copy the unsent ops were made on (the shared copy); the batch goes onto it, then the unsent ops
 *  are re-applied on top, except where the remote batch changed the same block (remote wins: those are the
 *  conflicts). An unsent delete gives way only to a remote edit of that block's words (they come back); an
 *  unsent insert always survives. `changed`: blocks the batch changed, as they are now. */
export function mergeRemoteBatch(blocks: DocBlock[], batch: DocOpBatch, pendingLocal: DocOp[]): { blocks: DocBlock[]; changed: string[]; conflicts: string[] } {
  const touched = new Map<string, DocOp["t"][]>();
  for (const op of batch.ops) touched.set(opId(op), [...(touched.get(opId(op)) ?? []), op.t]);
  const remote = applyDocOps(blocks, batch.ops);
  const conflicts: string[] = [];
  const kept = pendingLocal.filter((op) => {
    if (op.t === "insert") return true;
    const kinds = touched.get(opId(op));
    if (!kinds) return true;
    const lose = op.t === "update" ? kinds.some((k) => k !== "move")
      : op.t === "delete" ? kinds.some((k) => k === "update" || k === "insert")
      : kinds.some((k) => k !== "update");
    if (lose && !conflicts.includes(opId(op))) conflicts.push(opId(op));
    return !lose;
  });
  const out = applyDocOps(remote, kept);
  const local = new Map(applyDocOps(blocks, pendingLocal).map((b) => [b.id, b]));
  const changed: string[] = [];
  for (const b of out) {
    const kinds = touched.get(b.id);
    if (!kinds) continue;
    if (kinds.includes("insert") || kinds.includes("move") || !sameBlock(local.get(b.id), b)) changed.push(b.id);
  }
  return { blocks: out, changed, conflicts };
}

/** Three-way merge of two saved copies of a doc (the editor's reconcile when someone else's save lands):
 *  base = the copy both started from (what the server had when you last saved / loaded), mine = the editor,
 *  theirs = the server's copy now. Their changes come in; yours are re-applied on top. A block both sides
 *  changed differently is a conflict unless `seen(id, theirs)` (you had that copy live and moved on: yours
 *  stays) or `remoteAuthored(id)` with no unsent edit of yours (your copy is someone else's, so the saved one
 *  is at least as new: theirs comes in). A block one side deleted and the other edited is kept (no words are
 *  lost). The title merges the same way. */
export function mergeDocVersions(
  base: { title: string; blocks: DocBlock[] },
  mine: { title: string; blocks: DocBlock[] },
  theirs: { title: string; blocks: DocBlock[] },
  opts: { seen?: (id: string, block: DocBlock) => boolean; seenTitle?: (title: string) => boolean; remoteAuthored?: (id: string) => boolean; mineUnsent?: (id: string) => boolean } = {},
): { title: string; blocks: DocBlock[]; conflicts: string[]; titleConflict: boolean; theirsChanged: string[] } {
  const baseById = new Map(base.blocks.map((b) => [b.id, b]));
  const theirsById = new Map(theirs.blocks.map((b) => [b.id, b]));
  const mineOps = diffDocBlocks(base.blocks, mine.blocks);
  const conflicts: string[] = [];
  const keep: DocOp[] = [];
  for (const op of mineOps) {
    const id = opId(op);
    const b0 = baseById.get(id);
    const t = theirsById.get(id);
    if (op.t === "update") {
      if (!t) {
        // they deleted a block you edited: it stays, where it was
        const i = base.blocks.findIndex((b) => b.id === id);
        let after: string | null = null;
        for (let k = i - 1; k >= 0; k--) if (theirsById.has(base.blocks[k].id)) { after = base.blocks[k].id; break; }
        keep.push({ t: "insert", block: op.block, afterId: after });
        continue;
      }
      if (sameBlock(t, b0) || sameBlock(t, op.block)) { keep.push(op); continue; }
      // both changed it, differently
      if (opts.seen?.(id, t)) { keep.push(op); continue; }
      if (opts.remoteAuthored?.(id) && !opts.mineUnsent?.(id)) continue; // theirs is the newer copy
      conflicts.push(id);
      continue;
    }
    if (op.t === "delete") {
      // you deleted it; if they edited it meanwhile, it stays (theirs)
      if (t && b0 && !sameBlock(t, b0)) continue;
      keep.push(op);
      continue;
    }
    keep.push(op); // inserts and moves: yours, on top of theirs
  }
  // an insert / move after a block they deleted goes after the nearest block before it that's still there
  const mineIds = mine.blocks.map((b) => b.id);
  const placed = new Set(theirs.blocks.map((b) => b.id));
  const anchored = keep.map((op) => {
    if (op.t !== "insert" && op.t !== "move") { if (op.t === "delete") placed.delete(op.blockId); return op; }
    let after = op.afterId;
    if (after !== null && !placed.has(after)) {
      after = null;
      for (let k = mineIds.indexOf(op.afterId!) - 1; k >= 0; k--) if (placed.has(mineIds[k])) { after = mineIds[k]; break; }
    }
    placed.add(opId(op));
    return after === op.afterId ? op : { ...op, afterId: after };
  });
  const blocks = applyDocOps(theirs.blocks, anchored);
  // (titles compare trimmed: the server trims what it's sent)
  const t0 = base.title.trim(), tm = mine.title.trim(), tt = theirs.title.trim();
  let title = theirs.title;
  let titleConflict = false;
  if (tm === tt) title = mine.title;
  else if (tm !== t0) {
    if (tt === t0 || opts.seenTitle?.(theirs.title)) title = mine.title;
    else titleConflict = true;
  }
  const mineById = new Map(mine.blocks.map((b) => [b.id, b]));
  const theirsChanged = blocks.filter((b) => !sameBlock(mineById.get(b.id), b)).map((b) => b.id);
  return { title, blocks: conflicts.length || titleConflict ? mine.blocks : blocks, conflicts, titleConflict, theirsChanged };
}

/** Where an offset in `before` is in `after` (a caret kept in place while someone else's words change around it):
 *  before the change it stays, after it it shifts by the change's length, inside it it goes to the change's end. */
export function mapTextOffset(before: string, after: string, offset: number): number {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let q = 0;
  while (q < before.length - p && q < after.length - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
  const n = Math.max(0, Math.min(offset, before.length));
  if (n <= p) return n;
  if (n >= before.length - q) return n + (after.length - before.length);
  return after.length - q;
}

/* ======================================================================
   the wire
   ====================================================================== */

/** What goes out on a doc channel as "ops": the contract's batch + the sender's colour and, when it changed, the title. */
export interface WireBatch extends DocOpBatch { color?: string; title?: string }

const MAX_OPS = 2000;
const MAX_BLOCK_TEXT = 100_000;
/** a batch bigger than this isn't broadcast (Realtime's message limit): peers catch up from the save */
export const MAX_BATCH_BYTES = 200_000;
const ID_RE = /^[A-Za-z0-9_:.@-]{1,80}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

function parseBlock(raw: unknown): DocBlock | null {
  const [b] = parseDocBody([raw]);
  if (!b || !isId(b.id)) return null;
  if (b.type === "divider") { delete b.spans; return b; }
  const spans = normaliseSpans(b.spans);
  if (spans.reduce((n, s) => n + s.text.length, 0) > MAX_BLOCK_TEXT) return null;
  return { ...b, spans };
}
function parseOp(raw: unknown): DocOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const after = r.afterId === null || r.afterId === undefined ? null : isId(r.afterId) ? r.afterId : undefined;
  switch (r.t) {
    case "insert": { const block = parseBlock(r.block); return block && after !== undefined ? { t: "insert", block, afterId: after } : null; }
    case "update": { const block = parseBlock(r.block); return block ? { t: "update", block } : null; }
    case "delete": return isId(r.blockId) ? { t: "delete", blockId: r.blockId } : null;
    case "move": return isId(r.blockId) && after !== undefined ? { t: "move", blockId: r.blockId, afterId: after } : null;
    default: return null;
  }
}

/** A doc batch from the wire (anything malformed → null; never trusted further than this). */
export function parseWireBatch(raw: unknown): WireBatch | null {
  const sender = parseSender(raw);
  if (!sender || !raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isId(r.docId) || typeof r.seq !== "number" || !Number.isFinite(r.seq) || r.seq < 0 || !Array.isArray(r.ops) || r.ops.length > MAX_OPS) return null;
  const ops: DocOp[] = [];
  for (const o of r.ops) { const op = parseOp(o); if (!op) return null; ops.push(op); }
  const out: WireBatch = {
    docId: r.docId, clientId: sender.clientId, userId: sender.userId, name: sender.name, color: sender.color,
    seq: r.seq, baseVersion: typeof r.baseVersion === "string" ? r.baseVersion.slice(0, 64) : "", ops,
    at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0,
  };
  if (typeof r.title === "string") out.title = r.title.replace(/\n/g, " ").slice(0, 200);
  return out;
}

/* ======================================================================
   the replica (pure, deterministic; one per open editor)
   ====================================================================== */

type Stamp = readonly [number, string];
const ZERO: Stamp = [0, ""];
const gt = (a: Stamp, b: Stamp): boolean => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const SEEN_PER_BLOCK = 64;
/** an op after a block we haven't got yet waits this long for it, then goes to the end */
export const ORPHAN_WAIT_MS = 3000;
/** someone else's words over yours within this long of you writing them: a clash (said) */
export const CLASH_MS = 10_000;
/** stamps further ahead of this clock than this are refused (a batch) or not followed (a clock) */
const MAX_SKEW_MS = 86_400_000;

export interface ReplicaChange {
  blocks: DocBlock[];
  title: string;
  /** blocks the remote batch changed (for the "edited by" highlight) */
  changed: string[];
  /** blocks both sides changed (remote won) */
  conflicts: string[];
  titleChanged: boolean;
  titleConflict: boolean;
}
type Item = { op: DocOp; s: Stamp };
/** one block in the sequence: deleted ones stay, hidden, so whatever was anchored on them keeps its place */
interface Slot { b: DocBlock; dead: boolean }
const visible = (seq: readonly Slot[]): DocBlock[] => seq.filter((x) => !x.dead).map((x) => x.b);

export class DocReplica {
  clock = 0;
  /** what everyone has: the visible blocks of the sequence */
  shadow: DocBlock[];
  shadowTitle: string;
  /** edits of blocks this copy has never had, given up on (we joined after they were made): the next save brings them */
  missing = 0;
  private seq: Slot[];
  /** content, position and delete stamps (last writer wins, each on its own) */
  private cs = new Map<string, Stamp>();
  private ps = new Map<string, Stamp>();
  private ds = new Map<string, Stamp>();
  /** deletes of blocks this copy hasn't had yet (their insert comes round another way) */
  private ghosts = new Map<string, Stamp>();
  private titleStamp: Stamp = ZERO;
  private seenH = new Map<string, string[]>();
  private seenT: string[] = [];
  private waiting: { item: Item; until: number }[] = [];
  /** when you last sent words in a block; a remote write over them soon after is a clash (said, like a conflict) */
  private mineAt = new Map<string, number>();
  private overwritten = new Set<string>();

  /** how long an op waits for what it's anchored on (ORPHAN_WAIT_MS) */
  private orphanWait: number;
  constructor(readonly clientId: string, blocks: DocBlock[], title: string, opts: { orphanWaitMs?: number } = {}) {
    this.orphanWait = opts.orphanWaitMs ?? ORPHAN_WAIT_MS;
    this.seq = blocks.map((b) => ({ b, dead: false }));
    this.shadow = blocks.slice();
    this.shadowTitle = title;
    for (const b of blocks) this.see(b);
    this.seeTitle(title);
  }

  /* ---- clocks and memory ---- */
  /** (a clock more than a day ahead of this one is someone's mistake or mischief: not followed) */
  observe(n: number): void { if (Number.isFinite(n) && n > this.clock && n < Date.now() + MAX_SKEW_MS) this.clock = n; }
  private tick(now: number): number { this.clock = Math.max(this.clock + 1, Math.floor(now)); return this.clock; }
  private see(b: DocBlock): void {
    const h = hashText(blockSig(b));
    const list = this.seenH.get(b.id) ?? [];
    if (list[list.length - 1] === h) return;
    list.push(h);
    if (list.length > SEEN_PER_BLOCK) list.shift();
    this.seenH.set(b.id, list);
  }
  private seeTitle(t: string): void {
    if (this.seenT[this.seenT.length - 1] === t) return;
    this.seenT.push(t);
    if (this.seenT.length > SEEN_PER_BLOCK) this.seenT.shift();
  }
  /** this copy of the block has been here (yours or someone's, live): a saved copy of it is old news */
  seen(id: string, b: DocBlock): boolean { return !!this.seenH.get(id)?.includes(hashText(blockSig(b))); }
  seenTitle(t: string): boolean { return this.seenT.some((x) => x.trim() === t.trim()); }
  /** the latest words in this block came from someone else (or a save) */
  remoteAuthored(id: string): boolean { const s = this.cs.get(id); return !!s && s[1] !== this.clientId; }
  /** you've changed this block since your last batch went out */
  unsent(id: string, current: DocBlock[]): boolean {
    return !sameBlock(this.shadow.find((b) => b.id === id), current.find((x) => x.id === id));
  }
  get waitingCount(): number { return this.waiting.length; }
  private cs0(id: string): Stamp { return this.cs.get(id) ?? ZERO; }
  private ps0(id: string): Stamp { return this.ps.get(id) ?? ZERO; }
  private ds0(id: string): Stamp { return this.ds.get(id) ?? ZERO; }

  /** one op onto a working sequence → the ops it became on the visible list ("wait": its anchor or block isn't here yet) */
  private one(work: Slot[], { op, s }: Item, late: boolean): DocOp[] | "wait" {
    const idx = (id: string) => work.findIndex((x) => x.b.id === id);
    const visPred = (i: number): string | null => { for (let k = i - 1; k >= 0; k--) if (!work[k].dead) return work[k].b.id; return null; };
    // RGA: after the anchor, step over blocks placed later than this op
    const placeIndex = (anchor: string | null, stamp: Stamp) => {
      let i = anchor === null ? 0 : idx(anchor) + 1;
      while (i < work.length && gt(this.ps0(work[i].b.id), stamp)) i++;
      return i;
    };
    const anchorOf = (afterId: string | null, self: string): string | null | "wait" => {
      if (afterId === null || afterId === self) return null;
      if (idx(afterId) >= 0) return afterId;
      return late ? (work.length ? work[work.length - 1].b.id : null) : "wait";
    };
    const out: DocOp[] = [];
    switch (op.t) {
      case "insert":
      case "update": {
        const id = op.block.id;
        const i = idx(id);
        if (i >= 0) {
          const slot = work[i];
          if (gt(s, this.cs0(id))) {
            if (this.cs0(id)[1] === this.clientId && !sameBlock(slot.b, op.block)) this.overwritten.add(id);
            this.cs.set(id, s);
            slot.b = op.block;
            this.see(op.block);
            if (!slot.dead) out.push({ t: "update", block: op.block });
            else if (gt(s, this.ds0(id))) {
              // an edit made after the delete: the block comes back, where it was
              slot.dead = false;
              this.ds.delete(id);
              out.push({ t: "insert", block: op.block, afterId: visPred(i) });
            }
          }
          if (op.t === "insert" && gt(s, this.ps0(id))) {
            const anchor = anchorOf(op.afterId, id);
            if (anchor === "wait") return out.length ? out : "wait";
            work.splice(i, 1);
            const at = placeIndex(anchor, s);
            work.splice(at, 0, slot);
            this.ps.set(id, s);
            if (!slot.dead) out.push({ t: "move", blockId: id, afterId: visPred(at) });
          }
          return out;
        }
        // a block this copy hasn't had: an edit waits for its insert (it came round another way)
        if (op.t === "update") {
          if (!late) return "wait";
          this.missing++;
          return out;
        }
        const anchor = anchorOf(op.afterId, id);
        if (anchor === "wait") return "wait";
        const at = placeIndex(anchor, s);
        const ghost = this.ghosts.get(id);
        const dead = !!ghost && gt(ghost, s);
        work.splice(at, 0, { b: op.block, dead });
        this.cs.set(id, s);
        this.ps.set(id, s);
        if (dead) this.ds.set(id, ghost!);
        this.ghosts.delete(id);
        this.see(op.block);
        if (!dead) out.push({ t: "insert", block: op.block, afterId: visPred(at) });
        return out;
      }
      case "move": {
        const id = op.blockId;
        const i = idx(id);
        if (i < 0) return late ? out : "wait";
        if (!gt(s, this.ps0(id))) return out;
        const anchor = anchorOf(op.afterId, id);
        if (anchor === "wait") return "wait";
        const [slot] = work.splice(i, 1);
        const at = placeIndex(anchor, s);
        work.splice(at, 0, slot);
        this.ps.set(id, s);
        if (!slot.dead) out.push({ t: "move", blockId: id, afterId: visPred(at) });
        return out;
      }
      case "delete": {
        const id = op.blockId;
        const i = idx(id);
        if (i < 0) {
          const g = this.ghosts.get(id);
          if (!g || gt(s, g)) this.ghosts.set(id, s);
          return out;
        }
        // edited after the delete was made: it stays (a later move doesn't count: moving isn't keeping)
        if (!gt(s, this.cs0(id))) return out;
        const slot = work[i];
        if (slot.dead) { if (gt(s, this.ds0(id))) this.ds.set(id, s); return out; }
        slot.dead = true;
        this.ds.set(id, s);
        out.push({ t: "delete", blockId: id });
        return out;
      }
    }
  }

  /* ---- local edits → a batch ---- */
  /** what you've changed since the last batch (null: nothing); the shadow moves on */
  flush(current: DocBlock[], title: string, now: number): { seq: number; ops: DocOp[]; title?: string } | null {
    const ops = diffDocBlocks(this.shadow, current);
    const titleChanged = title !== this.shadowTitle;
    if (!ops.length && !titleChanged) return null;
    const s: Stamp = [this.tick(now), this.clientId];
    // your own ops go through exactly the rules everyone else applies them with (the newest stamp: nothing skips them)
    const work = this.seq.map((x) => ({ ...x }));
    const sent: DocOp[] = [];
    for (const op of ops) if (op.t === "update" || op.t === "insert") this.mineAt.set(op.block.id, now);
    for (const raw of ops) {
      let op = raw;
      if (raw.t === "insert") {
        // a deleted block back where it was (an undo, or words kept from a delete): it goes out as an edit, which
        // brings it back in place everywhere, rather than as an insert (which would move it)
        const i = work.findIndex((x) => x.b.id === raw.block.id);
        if (i >= 0 && work[i].dead) {
          let pred: string | null = null;
          for (let k = i - 1; k >= 0; k--) if (!work[k].dead) { pred = work[k].b.id; break; }
          if (pred === raw.afterId) op = { t: "update", block: raw.block };
        }
      }
      this.one(work, { op, s }, true);
      sent.push(op);
    }
    this.seq = work;
    if (titleChanged) { this.titleStamp = s; this.seeTitle(title); }
    this.shadow = current.slice();
    this.shadowTitle = title;
    return { seq: s[0], ops: sent, ...(titleChanged ? { title } : {}) };
  }

  /* ---- a remote batch ---- */
  receive(batch: WireBatch, current: DocBlock[], curTitle: string, now: number): ReplicaChange | null {
    if (batch.clientId === this.clientId || batch.seq > Math.max(now, Date.now()) + MAX_SKEW_MS) return null;
    this.observe(batch.seq);
    const s: Stamp = [batch.seq, batch.clientId];
    return this.process(batch.ops.map((op) => ({ op, s })), batch.title !== undefined ? { title: batch.title, s } : null, current, curTitle, now);
  }
  /** ops that waited too long for their anchor: placed at the end */
  expire(current: DocBlock[], curTitle: string, now: number): ReplicaChange | null {
    if (!this.waiting.some((w) => w.until <= now)) return null;
    return this.process([], null, current, curTitle, now);
  }

  private process(items: Item[], titleItem: { title: string; s: Stamp } | null, current: DocBlock[], curTitle: string, now: number): ReplicaChange | null {
    // a block deleted from the shared copy that's back on your screen in its old place (you kept typing in it, or
    // undid the delete) counts as there, where it was: your next batch brings it back for everyone, as an edit
    const pendingIns = new Map<string, string | null>();
    for (const op of diffDocBlocks(this.shadow, current)) if (op.t === "insert") pendingIns.set(op.block.id, op.afterId);
    const back = new Set<string>();
    let lastShown: string | null = null;
    for (const x of this.seq) {
      if (!x.dead) { lastShown = x.b.id; continue; }
      if (pendingIns.has(x.b.id) && pendingIns.get(x.b.id) === lastShown) { back.add(x.b.id); lastShown = x.b.id; }
    }
    const shownWith = (seq: Slot[], ids: Set<string>) => (ids.size ? visible(seq.map((x) => (ids.has(x.b.id) ? { ...x, dead: false } : x))) : visible(seq));
    const before = back.size ? shownWith(this.seq, back) : this.shadow;
    const pending = diffDocBlocks(before, current);
    const work = this.seq.map((x) => ({ ...x }));
    const concrete: DocOp[] = [];
    this.overwritten.clear();
    // waiting ops first (what they wait for may be here now), then the new ones; again until nothing moves
    let queue: { item: Item; until: number }[] = [...this.waiting, ...items.map((item) => ({ item, until: now + this.orphanWait }))];
    for (let progress = true; progress && queue.length;) {
      progress = false;
      const next: typeof queue = [];
      for (const w of queue) {
        const r = this.one(work, w.item, w.until <= now);
        if (r === "wait") next.push(w);
        else { concrete.push(...r); progress = true; }
      }
      queue = next;
    }
    this.waiting = queue;
    this.seq = work;
    let title = curTitle;
    let titleChanged = false, titleConflict = false;
    if (titleItem && gt(titleItem.s, this.titleStamp)) {
      const pendingTitle = curTitle !== this.shadowTitle;
      this.titleStamp = titleItem.s;
      this.shadowTitle = titleItem.title;
      this.seeTitle(titleItem.title);
      if (titleItem.title !== curTitle) { titleChanged = true; titleConflict = pendingTitle; title = titleItem.title; }
    }
    if (!concrete.length && !titleChanged) return null;
    const shadowAfter = visible(work);
    // your unsent edits on top. A block the batch deleted while you were typing in it stays on your screen, in its
    // place in the sequence (as do the ones already back); one anchored on a block that's gone follows the nearest
    // block before it on your screen that's still there.
    const wasShown = new Set(before.map((b) => b.id));
    for (const op of pending) if (op.t === "update" && wasShown.has(op.block.id) && work.some((x) => x.dead && x.b.id === op.block.id)) back.add(op.block.id);
    const base = shownWith(work, back);
    const added = new Set(pending.filter((o) => o.t === "insert").map(opId));
    const alive = new Set(base.map((b) => b.id));
    const survives = (id: string) => alive.has(id) || added.has(id);
    const anchorOf = (id: string): string | null => {
      for (let k = current.findIndex((b) => b.id === id) - 1; k >= 0; k--) if (survives(current[k].id)) return current[k].id;
      return null;
    };
    const mine: DocOp[] = pending.map((op) => {
      if ((op.t === "insert" || op.t === "move") && op.afterId !== null && !survives(op.afterId)) return { ...op, afterId: anchorOf(opId(op)) };
      return op;
    });
    // (what the batch did to your screen, as ops on the copy your unsent edits were made on)
    const remoteOps = diffDocBlocks(before, base);
    const merged = mergeRemoteBatch(before, { docId: "", clientId: "", userId: "", name: "", seq: 0, baseVersion: "", ops: remoteOps, at: now }, mine);
    this.shadow = shadowAfter;
    // your words, sent a moment ago and written over by theirs: a clash too
    const clashes = [...merged.conflicts];
    for (const id of this.overwritten) if (now - (this.mineAt.get(id) ?? -Infinity) < CLASH_MS && !clashes.includes(id) && merged.blocks.some((b) => b.id === id)) clashes.push(id);
    return { blocks: merged.blocks, title, changed: merged.changed, conflicts: clashes, titleChanged, titleConflict };
  }

  /* ---- the order check ----
     Content always converges (per-block registers) and so does the order of inserts and deletes (RGA); a move
     racing an insert after the moved block can still leave two copies in different orders. So editors that have
     gone quiet compare orders now and then: the copy of the editor with the highest client id stands, and the
     others take its order (blocks only they have stay after the block they followed). */
  orderIds(): string[] { return this.shadow.map((b) => b.id); }
  orderHash(): string { return hashText(this.orderIds().join(",")); }
  /** take `ids`' order (sent by `from`) if `from` outranks this copy and the common blocks are in another order */
  adoptOrder(ids: readonly string[], from: string, current: DocBlock[], curTitle: string, opts: { force?: boolean } = {}): ReplicaChange | null {
    // (a read-only viewer never announces its own order, so it always takes an editor's)
    if (!opts.force && !(from > this.clientId)) return null;
    const theirs = new Set(ids);
    const mineCommon = this.shadow.filter((b) => theirs.has(b.id)).map((b) => b.id);
    const common = ids.filter((id) => this.shadow.some((b) => b.id === id));
    if (common.join(",") === mineCommon.join(",")) return null;
    // the visible blocks in their order (yours that they haven't got: after the block they followed)…
    const bySlot = new Map(this.seq.map((x) => [x.b.id, x]));
    const order: string[] = [...common];
    this.shadow.forEach((b, i) => {
      if (theirs.has(b.id)) return;
      let at = 0;
      for (let k = i - 1; k >= 0; k--) { const j = order.indexOf(this.shadow[k].id); if (j >= 0) { at = j + 1; break; } }
      order.splice(at, 0, b.id);
    });
    // …and each hidden one still after the visible block it followed
    const tail = new Map<string | null, Slot[]>();
    let lastAlive: string | null = null;
    for (const x of this.seq) {
      if (!x.dead) { lastAlive = x.b.id; continue; }
      tail.set(lastAlive, [...(tail.get(lastAlive) ?? []), x]);
    }
    const seq: Slot[] = [...(tail.get(null) ?? [])];
    for (const id of order) { seq.push(bySlot.get(id)!); seq.push(...(tail.get(id) ?? [])); }
    const pending = diffDocBlocks(this.shadow, current);
    this.seq = seq;
    this.shadow = visible(seq);
    return { blocks: applyDocOps(this.shadow, pending), title: curTitle, changed: [], conflicts: [], titleChanged: false, titleConflict: false };
  }
  /** nothing unsent and nothing waiting: ready to compare orders */
  quiet(current: DocBlock[]): boolean { return !this.waiting.length && !diffDocBlocks(this.shadow, current).length; }

  /* ---- changes that came from a save (the editor's three-way merge) ---- */
  /** the editor took these changes from the server: everyone live does the same, so the shared copy follows */
  absorb(before: { title: string; blocks: DocBlock[] }, after: { title: string; blocks: DocBlock[] }): void {
    const ops = diffDocBlocks(before.blocks, after.blocks);
    // (newer than anything here: it's what the server holds now, decided by the editor's three-way merge)
    const s: Stamp = [this.tick(Date.now()), "~"];
    const work = this.seq.map((x) => ({ ...x }));
    const has = (id: string) => work.some((x) => x.b.id === id);
    for (const op of ops) {
      let o = op;
      if ((o.t === "insert" || o.t === "move") && o.afterId !== null && !has(o.afterId)) {
        // anchored on one of your unsent blocks: the nearest block before it that the shared copy has
        const k = after.blocks.findIndex((b) => b.id === (o as { afterId: string }).afterId);
        let a: string | null = null;
        for (let j = k - 1; j >= 0; j--) if (has(after.blocks[j].id)) { a = after.blocks[j].id; break; }
        o = { ...o, afterId: a };
      }
      this.one(work, { op: o, s }, true);
    }
    this.seq = work;
    this.shadow = visible(work);
    if (after.title !== before.title) { this.shadowTitle = after.title; this.seeTitle(after.title); }
    this.missing = 0;
  }
  /** a copy the server has (loaded, saved or reloaded): remember its blocks as seen */
  remember(blocks: DocBlock[], title: string): void { for (const b of blocks) this.see(b); this.seeTitle(title); }
  /** start again from this copy (Reload after a conflict): nothing of yours is unsent */
  reset(blocks: DocBlock[], title: string): void {
    const dead = this.seq.filter((x) => x.dead);
    this.seq = [...blocks.map((b) => ({ b, dead: false })), ...dead];
    this.shadow = blocks.slice();
    this.shadowTitle = title;
    this.remember(blocks, title);
    this.waiting = [];
    this.missing = 0;
  }
}

/* ======================================================================
   the hook
   ====================================================================== */

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
  /* ---- u5 additions (optional) ---- */
  /** the title (co-edited like a block) */
  getTitle?: () => string;
  /** a remote title change */
  setTitle?: (title: string, by: PresencePeer) => void;
  /** say on the project's channel that you have this doc open (Docs list "Sana is editing") */
  projectId?: string | null;
  /** someone saved: { version, key: hash of docSig } — the editor adopts it when its copy is the same */
  onPeerSaved?: (saved: { version: string; key: string; by: PresencePeer }) => void;
  /** a batch was made on a newer save than yours, or named blocks you've never had: time to fetch and merge */
  onBehind?: () => void;
  /** same-block conflicts (remote won) — for a quiet announcement */
  onConflicts?: (ids: string[], by: PresencePeer) => void;
}
export interface DocCollab {
  peers: PresencePeer[];
  /** send local ops (throttled, batched) */
  broadcast: (ops: DocOp[]) => void;
  /** send your caret / selection (throttled) */
  setCaret: (caret: PresencePeer["caret"]) => void;
  /** remote ops that couldn't be merged since the last save (→ the conflict banner) */
  unmerged: number;
  /* ---- u5 additions ---- */
  /** the channel is up (others can see you) */
  live: boolean;
  /** send what's waiting now (before a save) */
  flushNow: () => void;
  /** keep remote batches back (an IME composition) / let them in */
  hold: () => void;
  release: () => void;
  /** changes taken from the server (a three-way merge, a reload): the shared copy follows */
  absorb: (before: { title: string; blocks: DocBlock[] }, after: { title: string; blocks: DocBlock[] }) => void;
  /** start again from this copy (Reload) */
  reset: (blocks: DocBlock[], title: string) => void;
  /** remember a copy the server has */
  remember: (blocks: DocBlock[], title: string) => void;
  /** tell the others a save landed */
  sendSaved: (version: string, key: string) => void;
  /** for mergeDocVersions */
  seen: (id: string, block: DocBlock) => boolean;
  seenTitle: (title: string) => boolean;
  remoteAuthored: (id: string) => boolean;
  unsent: (id: string) => boolean;
}

const NOOP = () => {};
const FALSE = () => false;

interface Runtime {
  docId: string;
  replica: DocReplica;
  conn: PresenceConn | null;
  entries: PeerEntry[];
  carets: Map<string, { userId: string; caret: PresencePeer["caret"]; at: number }>;
  colors: Map<string, string>;
  myCaret: PresencePeer["caret"];
  caretSentAt: number;
  caretTimer: ReturnType<typeof setTimeout> | undefined;
  lastSent: number;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  expireTimer: ReturnType<typeof setTimeout> | undefined;
  held: boolean;
  queue: WireBatch[];
  orderTimer: ReturnType<typeof setTimeout> | undefined;
}
/** quiet this long after a structural change, an editor tells the others its block order (the order check) */
export const ORDER_CHECK_MS = 1500;
const MAX_ORDER_IDS = 5000;
const structural = (ops: readonly DocOp[]) => ops.some((o) => o.t !== "update");

export function useDocCollab(docId: string | null, opts: DocCollabOptions): DocCollab {
  const client = usePresenceClient();
  const me = useStableMe(opts.me);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [peers, setPeers] = useState<PresencePeer[]>(NO_PEERS);
  const [unmerged, setUnmerged] = useState(0);
  const [live, setLive] = useState(false);
  const rtRef = useRef<Runtime | null>(null);
  if (docId && (!rtRef.current || rtRef.current.docId !== docId)) {
    rtRef.current = {
      docId, replica: new DocReplica(client?.clientId ?? "local", opts.getBlocks(), opts.getTitle?.() ?? ""),
      conn: null, entries: [], carets: new Map(), colors: new Map(), myCaret: null, caretSentAt: 0, caretTimer: undefined,
      lastSent: 0, flushTimer: undefined, expireTimer: undefined, held: false, queue: [], orderTimer: undefined,
    };
  }
  const rt = docId ? rtRef.current : null;
  const readOnly = !!opts.readOnly;
  const projectId = opts.projectId ?? null;

  const publishPeers = useCallback(() => {
    const r = rtRef.current;
    if (!r) return;
    const t = Date.now();
    const present = new Set(r.entries.map((e) => e.clientId));
    for (const k of [...r.carets.keys()]) if (!present.has(k)) r.carets.delete(k);
    for (const e of r.entries) if (e.color) r.colors.set(e.userId, e.color);
    // a broadcast caret is newer than the one in presence (sent with the heartbeat)
    const entries = r.entries.map((e) => {
      const c = r.carets.get(e.clientId);
      return c ? { ...e, caret: c.caret, seenAt: Math.max(e.seenAt, c.at) } : e;
    });
    const next = toPeers(entries, me?.userId).map((p) => (p.at > t ? { ...p, at: t } : p));
    setPeers((prev) => (samePeers(prev, next) ? prev : next));
  }, [me]);

  const byOf = useCallback((b: { userId: string; name: string; color?: string }): PresencePeer => ({
    userId: b.userId, name: b.name, color: b.color || rtRef.current?.colors.get(b.userId) || "", state: "editing", at: Date.now(),
  }), []);

  const applyChange = useCallback((res: ReplicaChange | null, by: PresencePeer) => {
    const r = rtRef.current;
    if (!r) return;
    if (r.replica.missing) setUnmerged(r.replica.missing);
    if (!res) return;
    const o = optsRef.current;
    o.setBlocks(res.blocks, res.changed.map((blockId) => ({ blockId, by })));
    if (res.titleChanged) o.setTitle?.(res.title, by);
    if (res.conflicts.length || res.titleConflict) o.onConflicts?.(res.conflicts, by);
  }, []);

  const scheduleExpire = useCallback(() => {
    const r = rtRef.current;
    if (!r || r.expireTimer !== undefined || !r.replica.waitingCount) return;
    r.expireTimer = setTimeout(() => {
      r.expireTimer = undefined;
      const o = optsRef.current;
      applyChange(r.replica.expire(o.getBlocks(), o.getTitle?.() ?? "", Date.now()), byOf({ userId: "", name: "Someone" }));
      if (r.replica.missing) o.onBehind?.();
      scheduleExpire();
    }, ORPHAN_WAIT_MS + 50);
  }, [applyChange, byOf]);

  // the order check: quiet a moment after a structural change, say what order your blocks are in
  const scheduleOrder = useCallback(() => {
    const r = rtRef.current;
    if (!r || optsRef.current.readOnly) return;
    clearTimeout(r.orderTimer);
    r.orderTimer = setTimeout(() => {
      r.orderTimer = undefined;
      const o = optsRef.current;
      if (!r.conn?.live || !me || !client || o.readOnly) return;
      if (!r.replica.quiet(o.getBlocks())) { scheduleOrderRef.current(); return; }
      const ids = r.replica.orderIds();
      if (ids.length <= MAX_ORDER_IDS) r.conn.send("order", { userId: me.userId, name: me.name, color: me.color, clientId: client.clientId, ids });
    }, ORDER_CHECK_MS);
  }, [client, me]);
  const scheduleOrderRef = useRef(scheduleOrder);
  scheduleOrderRef.current = scheduleOrder;

  const takeOrder = useCallback((raw: unknown) => {
    const r = rtRef.current;
    if (!r || !client) return;
    const s = parseSender(raw);
    const ids = (raw as { ids?: unknown }).ids;
    if (!s || s.clientId === client.clientId || !Array.isArray(ids) || ids.length > MAX_ORDER_IDS || !ids.every(isId)) return;
    const o = optsRef.current;
    const current = o.getBlocks();
    if (!r.replica.quiet(current)) return; // (the next announcement will do)
    if (!o.readOnly && !(s.clientId > client.clientId)) {
      // you outrank them: if your orders differ, say yours so they take it
      if (hashText(ids.join(",")) !== r.replica.orderHash()) scheduleOrder();
      return;
    }
    const res = r.replica.adoptOrder(ids, s.clientId, current, o.getTitle?.() ?? "", { force: !!o.readOnly });
    if (res) o.setBlocks(res.blocks, []);
  }, [client, scheduleOrder]);

  const takeBatch = useCallback((b: WireBatch) => {
    const r = rtRef.current;
    if (!r) return;
    const o = optsRef.current;
    const missingBefore = r.replica.missing;
    const res = r.replica.receive(b, o.getBlocks(), o.getTitle?.() ?? "", Date.now());
    applyChange(res, byOf(b));
    scheduleExpire();
    if (structural(b.ops)) scheduleOrder();
    const base = o.baseVersion ? Date.parse(o.baseVersion) : NaN;
    const theirs = b.baseVersion ? Date.parse(b.baseVersion) : NaN;
    if (r.replica.missing > missingBefore || (Number.isFinite(base) && Number.isFinite(theirs) && theirs > base)) o.onBehind?.();
  }, [applyChange, byOf, scheduleExpire, scheduleOrder]);

  const flushNow = useCallback(() => {
    const r = rtRef.current;
    if (!r) return;
    clearTimeout(r.flushTimer);
    r.flushTimer = undefined;
    const o = optsRef.current;
    if (o.readOnly || !r.conn?.live || !me || !client) return;
    const out = r.replica.flush(o.getBlocks(), o.getTitle?.() ?? "", Date.now());
    if (!out) return;
    r.lastSent = Date.now();
    const payload: WireBatch = {
      docId: r.docId, clientId: client.clientId, userId: me.userId, name: me.name, color: me.color,
      seq: out.seq, baseVersion: o.baseVersion ?? "", ops: out.ops, at: r.lastSent, ...(out.title !== undefined ? { title: out.title } : {}),
    };
    let size = 0;
    try { size = JSON.stringify(payload).length; } catch { return; }
    // too big for a realtime message (a huge paste): the others catch up from the save
    if (size > MAX_BATCH_BYTES) return;
    r.conn.send("ops", payload as unknown as Record<string, unknown>);
    if (structural(out.ops)) scheduleOrder();
  }, [client, me, scheduleOrder]);

  const broadcast = useCallback((_ops: DocOp[]) => {
    const r = rtRef.current;
    if (!r || optsRef.current.readOnly) return;
    if (r.flushTimer !== undefined) return;
    const wait = Math.max(0, r.lastSent + DOC_OP_THROTTLE_MS - Date.now());
    r.flushTimer = setTimeout(flushNow, wait);
  }, [flushNow]);

  const sendCaret = useCallback(() => {
    const r = rtRef.current;
    if (!r || !me || !client) return;
    r.caretTimer = undefined;
    r.caretSentAt = Date.now();
    r.conn?.send("caret", { userId: me.userId, name: me.name, color: me.color, clientId: client.clientId, caret: r.myCaret ?? null });
  }, [client, me]);
  const setCaret = useCallback((caret: PresencePeer["caret"]) => {
    const r = rtRef.current;
    if (!r || optsRef.current.readOnly) return;
    const prev = r.myCaret;
    const same = (prev ?? null) === (caret ?? null) || (!!prev && !!caret && prev.blockId === caret.blockId && prev.offset === caret.offset && (prev.extent ?? 0) === (caret.extent ?? 0));
    if (same) return;
    r.myCaret = caret ?? null;
    if (!prev !== !caret) r.conn?.retrack(); // editing ↔ viewing
    if (r.caretTimer !== undefined) return;
    const wait = Math.max(0, r.caretSentAt + CARET_THROTTLE_MS - Date.now());
    if (wait === 0) sendCaret();
    else r.caretTimer = setTimeout(sendCaret, wait);
  }, [sendCaret]);

  useEffect(() => {
    const r = rtRef.current;
    if (!client || !docId || !me || !r) { setPeers(NO_PEERS); setLive(false); return; }
    const conn = client.join(presenceKey("doc", docId), {
      me,
      contribute: () => ({ state: r.myCaret && !optsRef.current.readOnly ? "editing" : "viewing", caret: optsRef.current.readOnly ? null : r.myCaret, clk: r.replica.clock }),
      onPeers: (list) => {
        for (const e of list) if (e.clk) r.replica.observe(e.clk);
        r.entries = list;
        publishPeers();
      },
      onBroadcast: (event, payload) => {
        if (event === "ops") {
          const b = parseWireBatch(payload);
          if (!b || b.docId !== docId || b.clientId === client.clientId) return;
          if (b.color) r.colors.set(b.userId, b.color);
          if (r.held) { r.queue.push(b); return; }
          takeBatch(b);
        } else if (event === "caret") {
          const s = parseSender(payload);
          if (!s || s.clientId === client.clientId) return;
          if (s.color) r.colors.set(s.userId, s.color);
          r.carets.set(s.clientId, { userId: s.userId, caret: parseCaret((payload as { caret?: unknown }).caret), at: Date.now() });
          publishPeers();
        } else if (event === "order") {
          takeOrder(payload);
        } else if (event === "saved") {
          const s = parseSender(payload);
          const p = payload as { version?: unknown; key?: unknown };
          if (!s || s.clientId === client.clientId || typeof p.version !== "string" || typeof p.key !== "string" || p.version.length > 64 || p.key.length > 32) return;
          optsRef.current.onPeerSaved?.({ version: p.version, key: p.key, by: byOf(s) });
        }
      },
      onLive: (l) => {
        setLive(l);
        if (l && !optsRef.current.readOnly) { r.lastSent = 0; broadcast([]); }
      },
    });
    r.conn = conn;
    const pconn = projectId ? client.join(presenceKey("project", projectId), { me, contribute: () => ({ state: "viewing", docId }) }) : null;
    return () => {
      flushNow();
      clearTimeout(r.flushTimer); r.flushTimer = undefined;
      clearTimeout(r.caretTimer); r.caretTimer = undefined;
      clearTimeout(r.expireTimer); r.expireTimer = undefined;
      clearTimeout(r.orderTimer); r.orderTimer = undefined;
      conn.leave();
      pconn?.leave();
      r.conn = null;
      r.entries = [];
      setPeers(NO_PEERS);
      setLive(false);
    };
  }, [client, docId, me, projectId, publishPeers, takeBatch, takeOrder, flushNow, broadcast, byOf]);

  // a read-only viewer who becomes an editor (or back) says so
  useEffect(() => { rtRef.current?.conn?.retrack(); }, [readOnly]);

  const hold = useCallback(() => { const r = rtRef.current; if (r) r.held = true; }, []);
  const release = useCallback(() => {
    const r = rtRef.current;
    if (!r || !r.held) return;
    r.held = false;
    const q = r.queue;
    r.queue = [];
    q.forEach(takeBatch);
  }, [takeBatch]);
  const absorb = useCallback((before: { title: string; blocks: DocBlock[] }, after: { title: string; blocks: DocBlock[] }) => {
    const r = rtRef.current;
    if (!r) return;
    r.replica.absorb(before, after);
    setUnmerged(0);
  }, []);
  const reset = useCallback((blocks: DocBlock[], title: string) => { rtRef.current?.replica.reset(blocks, title); setUnmerged(0); }, []);
  const remember = useCallback((blocks: DocBlock[], title: string) => { rtRef.current?.replica.remember(blocks, title); }, []);
  const sendSaved = useCallback((version: string, key: string) => {
    const r = rtRef.current;
    if (!r || !me || !client || optsRef.current.readOnly) return;
    r.conn?.send("saved", { userId: me.userId, name: me.name, color: me.color, clientId: client.clientId, version, key });
  }, [client, me]);

  return useMemo<DocCollab>(() => (rt ? {
    peers, broadcast, setCaret, unmerged, live, flushNow, hold, release, absorb, reset, remember, sendSaved,
    seen: (id, b) => rt.replica.seen(id, b),
    seenTitle: (t) => rt.replica.seenTitle(t),
    remoteAuthored: (id) => rt.replica.remoteAuthored(id),
    unsent: (id) => rt.replica.unsent(id, optsRef.current.getBlocks()),
  } : {
    peers: NO_PEERS, broadcast: NOOP, setCaret: NOOP, unmerged: 0, live: false, flushNow: NOOP, hold: NOOP, release: NOOP, absorb: NOOP,
    reset: NOOP, remember: NOOP, sendSaved: NOOP, seen: FALSE, seenTitle: FALSE, remoteAuthored: FALSE, unsent: FALSE,
  }), [rt, peers, broadcast, setCaret, unmerged, live, flushNow, hold, release, absorb, reset, remember, sendSaved]);
}

/** "Sana is viewing" / "Sana and Theo are viewing" / "Sana, Theo and 2 others are viewing" — re-exported above. */
export type { PresencePeer };
