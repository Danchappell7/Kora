/* ============================================================
   KANBO — where the tour's coach card goes (pure maths, unit-tested),
   and which element a step points at.
   • Wide screens: beside the anchor — to the right of a tall one (the
     sidebar's places), to the left of one on the right-hand edge (the
     task panel), otherwise below it (or above when there's no room).
     Never off-screen; when nothing fits (a huge anchor) it sits in the
     bottom corner away from it.
   • Phones (< 860px): docked to the bottom edge — or the top, when the
     anchor sits in the bottom part of the screen and would be covered.
   • No anchor on screen: a centred card.
   ============================================================ */

export interface Box { top: number; left: number; width: number; height: number }
export interface Size { width: number; height: number }
export type CardSide = "right" | "left" | "bottom" | "top";
export interface CardPlacement {
  /** beside the anchor · docked full-width to an edge (phones) · in a bottom corner (nothing beside fits) · centred */
  mode: "beside" | "dock" | "corner" | "centre";
  /** beside: which side of the anchor · dock / corner: which edge of the screen */
  side?: CardSide;
  top: number;
  left: number;
}

/** under this width the card docks to an edge (the app's phone layout) */
export const DOCK_BELOW = 860;
export const CARD_GAP = 14;
export const CARD_EDGE = 12;
/** the spotlight ring's breathing room around the anchor */
export const SPOT_PAD = 6;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

export function placeCoachCard(anchor: Box | null, card: Size, viewport: Size, opts: { gap?: number; edge?: number } = {}): CardPlacement {
  const gap = opts.gap ?? CARD_GAP, edge = opts.edge ?? CARD_EDGE;
  const vw = viewport.width, vh = viewport.height;
  if (vw < DOCK_BELOW) {
    // the anchor's middle in the lower 45% of the screen: dock at the top instead, so it stays in view
    const low = !!anchor && anchor.top + anchor.height / 2 > vh * 0.55;
    return low
      ? { mode: "dock", side: "top", top: edge, left: edge }
      : { mode: "dock", side: "bottom", top: Math.max(edge, vh - edge - card.height), left: edge };
  }
  if (!anchor) {
    return { mode: "centre", top: Math.round(clamp((vh - card.height) / 2, edge, vh - edge - card.height)), left: Math.round(clamp((vw - card.width) / 2, edge, vw - edge - card.width)) };
  }
  const right = anchor.left + anchor.width, bottom = anchor.top + anchor.height;
  const room = {
    right: vw - right - gap - edge,
    left: anchor.left - gap - edge,
    bottom: vh - bottom - gap - edge,
    top: anchor.top - gap - edge,
  };
  // a tall, narrow anchor (a docked panel, a column): beside it · one hugging the left edge (the sidebar): to
  // its right · anything else (header controls, a card, a list): below it, or above
  const tall = anchor.height > vh * 0.45 && anchor.width < vw * 0.5;
  const onRightEdge = right > vw * 0.6 && anchor.left > vw * 0.4;
  const onLeftEdge = anchor.left < vw * 0.2 && right < vw * 0.4;
  const order: CardSide[] = tall
    ? (onRightEdge ? ["left", "right", "bottom", "top"] : ["right", "left", "bottom", "top"])
    : onLeftEdge ? ["right", "bottom", "top", "left"] : ["bottom", "top", "right", "left"];
  const fits = (s: CardSide) => (s === "right" || s === "left" ? room[s] >= card.width : room[s] >= card.height);
  const side = order.find(fits);
  if (!side) {
    // nothing beside it fits (a big list, a full-screen panel): dock to the bottom corner away from its middle
    const away = anchor.left + anchor.width / 2 < vw / 2 ? vw - edge - card.width : edge;
    return { mode: "corner", side: "bottom", top: Math.max(edge, vh - edge - card.height), left: Math.round(clamp(away, edge, vw - edge - card.width)) };
  }
  let top: number, left: number;
  if (side === "right" || side === "left") {
    left = side === "right" ? right + gap : anchor.left - gap - card.width;
    // a tall anchor (a panel): level with its title, below its header; else centred on it
    top = tall ? anchor.top + 56 : anchor.top + anchor.height / 2 - card.height / 2;
  } else {
    top = side === "bottom" ? bottom + gap : anchor.top - gap - card.height;
    left = anchor.left;
    // an anchor near the right edge: line the card's right edge up with it
    if (left + card.width > vw - edge) left = right - card.width;
  }
  return {
    mode: "beside", side,
    top: Math.round(clamp(top, edge, vh - edge - card.height)),
    left: Math.round(clamp(left, edge, vw - edge - card.width)),
  };
}

/** The spotlight ring: the anchor plus SPOT_PAD, kept inside the viewport. */
export function spotlightBox(anchor: Box, viewport: Size, pad = SPOT_PAD): Box {
  const top = Math.max(2, anchor.top - pad), left = Math.max(2, anchor.left - pad);
  const bottom = Math.min(viewport.height - 2, anchor.top + anchor.height + pad);
  const right = Math.min(viewport.width - 2, anchor.left + anchor.width + pad);
  return { top: Math.round(top), left: Math.round(left), width: Math.max(0, Math.round(right - left)), height: Math.max(0, Math.round(bottom - top)) };
}

/** Two boxes the same to the pixel (skip a re-render). */
export const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

/* ---------------- the DOM side ---------------- */

/** On screen and perceivable: has a size, isn't hidden or inert, and some of it is inside the viewport. */
export function isShown(el: Element, viewport: Size = { width: window.innerWidth, height: window.innerHeight }): boolean {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (el.closest("[inert], [hidden], [aria-hidden='true']")) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.bottom <= 0 || r.right <= 0 || r.top >= viewport.height || r.left >= viewport.width) return false;
  try {
    const cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || (cs.opacity !== "" && Number(cs.opacity) === 0)) return false;
  } catch { /* jsdom without layout: the rect decided */ }
  return true;
}

/** The first match of `selector` that's on screen (the tour's anchors have a desktop and a phone copy). */
export function findTourAnchor(selector: string, root: ParentNode = document): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll(selector))) if (isShown(el)) return el as HTMLElement;
  return null;
}

export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}
