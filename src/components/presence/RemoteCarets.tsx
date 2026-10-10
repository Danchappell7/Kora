/* ============================================================
   KANBO — other people in a doc: their carets and selections, and the
   blocks they just changed ("Sana" on a soft tint that fades).  [0048, u5]
   An overlay inside the editor (or the read-only view): measured from
   the blocks' own text, so it never touches what you're typing; nothing
   in it takes the pointer or focus (aria-hidden). Screen readers get the
   same news in words: a changed block's text says "Edited by Sana just
   now" (aria-description) while it's highlighted, and the editor
   announces who's here (DocEditor).
   Each person's colour is their avatar hue; the name flag shows while
   their caret moves, then shrinks to a dot. Reduced motion: no fades.
   ============================================================ */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PresencePeer } from "../../data/types";
import { locateOffset } from "../docs/docDom";
import { peerHue, shortNames } from "./core";
import "./presence.css";

/** how long an "edited by" highlight lasts */
export const FLASH_MS = 2600;
/** a caret's name flag stays this long after it moves */
export const FLAG_MS = 2500;

export interface RemoteEdit { blockId: string; by: PresencePeer; at: number }

export interface RemoteCaretsProps {
  /** the positioned element the overlay sits in (the editor's root) */
  rootRef: RefObject<HTMLElement>;
  /** others in the doc (their carets) */
  peers: readonly PresencePeer[];
  /** blocks others just changed */
  edits: readonly RemoteEdit[];
  /** a block's text element (where caret offsets count); null when it isn't on screen */
  locate: (blockId: string) => HTMLElement | null;
  /** a block's row, for the highlight (default: its text element) */
  locateRow?: (blockId: string) => HTMLElement | null;
  /** measure again when this changes (the blocks) */
  layoutKey: unknown;
}

type Rect = { top: number; left: number; width: number; height: number };
interface CaretBox { userId: string; name: string; hue: number; caret: Rect; sel: Rect[]; recent: boolean; below: boolean }
interface EditBox { blockId: string; name: string; hue: number; box: Rect; at: number; tag: boolean }

const rel = (r: DOMRect | Rect, root: DOMRect): Rect => ({ top: r.top - root.top, left: r.left - root.left, width: r.width, height: r.height });

/** Where a plain-text offset is in a block (a zero-width rect), and the rects of a selection. */
function geometry(el: HTMLElement, offset: number, extent: number | undefined): { caret: DOMRect | Rect | null; sel: (DOMRect | Rect)[] } {
  const doc = el.ownerDocument;
  const len = el.textContent?.length ?? 0;
  const focus = Math.max(0, Math.min(len, offset + (extent ?? 0)));
  const anchor = Math.max(0, Math.min(len, offset));
  const range = doc.createRange();
  const at = (n: number) => locateOffset(el, n);
  let caret: DOMRect | Rect | null = null;
  try {
    const p = at(focus);
    range.setStart(p.node, p.offset);
    range.collapse(true);
    const r = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    if (r && r.height > 0) caret = r;
    else if (focus > 0) {
      // at an element boundary a collapsed range has no box: the character before it does
      const q = at(focus - 1);
      range.setStart(q.node, q.offset);
      range.setEnd(p.node, p.offset);
      const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
      const last = rects[rects.length - 1];
      if (last && last.height > 0) caret = { top: last.top, left: last.right, width: 0, height: last.height };
    }
  } catch { caret = null; }
  if (!caret) {
    // an empty block (or no layout to ask): the start of its first line
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    caret = { top: box.top + (parseFloat(cs.paddingTop) || 0), left: box.left, width: 0, height: parseFloat(cs.lineHeight) || 24 };
  }
  const sel: (DOMRect | Rect)[] = [];
  if (extent && focus !== anchor) {
    try {
      const a = at(Math.min(anchor, focus)), b = at(Math.max(anchor, focus));
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      if (typeof range.getClientRects === "function") for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) sel.push(r);
    } catch { /* no selection box */ }
  }
  return { caret, sel };
}

export function RemoteCarets({ rootRef, peers, edits, locate, locateRow, layoutKey }: RemoteCaretsProps) {
  const [carets, setCarets] = useState<CaretBox[]>([]);
  const [boxes, setBoxes] = useState<EditBox[]>([]);
  const [size, setSize] = useState(0);
  const moved = useRef(new Map<string, { sig: string; at: number }>());
  const [clock, setClock] = useState(0);

  // when each caret last moved (its flag shows for FLAG_MS after)
  const now = Date.now();
  for (const p of peers) {
    const sig = p.caret ? `${p.caret.blockId}:${p.caret.offset}:${p.caret.extent ?? 0}` : "";
    const prev = moved.current.get(p.userId);
    if (!prev || prev.sig !== sig) moved.current.set(p.userId, { sig, at: now });
  }
  useEffect(() => {
    const pending = [...moved.current.values()].map((m) => m.at + FLAG_MS - Date.now()).filter((ms) => ms > 0);
    if (!pending.length) return;
    const t = window.setTimeout(() => setClock((n) => n + 1), Math.min(...pending) + 20);
    return () => window.clearTimeout(t);
  }, [peers, clock]);

  // the editor's size changes (a resize, the panel docking): measure again
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const bump = () => setSize((n) => n + 1);
    const RO = (window as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const ro = RO ? new RO(bump) : null;
    ro?.observe(root);
    window.addEventListener("resize", bump);
    return () => { ro?.disconnect(); window.removeEventListener("resize", bump); };
  }, [rootRef]);

  // (on the first mount the host's ref isn't attached yet when this runs: measure again once it is)
  const missed = useRef(false);
  const [again, setAgain] = useState(0);
  useEffect(() => { if (missed.current) { missed.current = false; setAgain((n) => n + 1); } });
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) { missed.current = true; return; }
    const rr = root.getBoundingClientRect();
    const t = Date.now();
    const names = new Map(peers.map((p, i) => [p.userId, shortNames(peers)[i]]));
    const next: CaretBox[] = [];
    for (const p of peers) {
      if (!p.caret) continue;
      const el = locate(p.caret.blockId);
      if (!el || !root.contains(el)) continue;
      const g = geometry(el, p.caret.offset, p.caret.extent);
      if (!g.caret) continue;
      const caret = rel(g.caret, rr);
      const m = moved.current.get(p.userId);
      next.push({
        userId: p.userId, name: names.get(p.userId) ?? p.name, hue: peerHue(p.color), caret, sel: g.sel.map((r) => rel(r, rr)),
        recent: !!m && t - m.at < FLAG_MS, below: caret.top < 18,
      });
    }
    setCarets(next);
    const eb: EditBox[] = [];
    for (const e of edits) {
      const row = locateRow?.(e.blockId) ?? locate(e.blockId);
      if (!row || !root.contains(row)) continue;
      // (their caret's flag already says who, when they're still in the block)
      const caretHere = peers.some((p) => p.userId === e.by.userId && p.caret?.blockId === e.blockId);
      eb.push({ blockId: e.blockId, name: shortNames([e.by])[0], hue: peerHue(e.by.color), box: rel(row.getBoundingClientRect(), rr), at: e.at, tag: !caretHere });
    }
    setBoxes(eb);
  }, [rootRef, peers, edits, locate, locateRow, layoutKey, size, clock, again]);

  // the same news for screen readers, on the block's own text
  useEffect(() => {
    const set: HTMLElement[] = [];
    for (const e of edits) {
      const el = locate(e.blockId);
      if (!el) continue;
      el.setAttribute("aria-description", `Edited by ${e.by.name} just now`);
      set.push(el);
    }
    return () => { for (const el of set) el.removeAttribute("aria-description"); };
  }, [edits, locate, layoutKey]);

  if (!carets.length && !boxes.length) return null;
  return (
    <div className="kpres-layer" aria-hidden="true">
      {boxes.map((b) => (
        <div key={`${b.blockId}-${b.at}`} className="kpres-edit" style={{ "--kp-h": b.hue, "--kp-flash": `${FLASH_MS}ms`, top: b.box.top, left: b.box.left - 6, width: b.box.width + 12, height: b.box.height } as CSSProperties}>
          {b.tag && <span className="kpres-edit-tag">{b.name}</span>}
        </div>
      ))}
      {carets.map((c) => (
        <div key={c.userId} style={{ "--kp-h": c.hue } as CSSProperties}>
          {c.sel.map((r, i) => <div key={i} className="kpres-sel" style={{ top: r.top, left: r.left, width: r.width, height: r.height }} />)}
          <div className="kpres-caret" data-recent={c.recent || undefined} data-below={c.below || undefined}
            style={{ top: c.caret.top, left: c.caret.left, height: c.caret.height }}>
            <span className="kpres-flag">{c.name}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
