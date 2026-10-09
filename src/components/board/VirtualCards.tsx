/* ============================================================
   KANBO — a long board column (more than VIRTUALISE_AFTER cards)
   renders only the cards near the screen, with spacers standing in
   for the rest, so a 500-card column scrolls like a 20-card one. No
   dependency: cards are measured after they render (estimates until
   then), the window follows any scroll on the page, and the cards
   that matter to the keyboard — the focused one, the one open in the
   task panel, the J/K cursor, one just moved — always render with a
   neighbour each side, so J/K and Alt+arrows never fall off the edge.
   The children are the column's own flex items (the wrapper is
   display: contents), so the column's gap and drop logic are unchanged.
   ============================================================ */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { virtualRanges, virtualSegments, type VirtualRange } from "../tasks/otherViewsLogic";

/** the column's flex gap (taskViews.css .ktv-lane) and top padding */
const GAP = 8;
const PAD = 8;
/** render this far beyond the visible part of the column (px) */
const OVERSCAN = 640;

export interface VirtualCardsProps<T extends { id: string }> {
  items: T[];
  /** the column element (its box is what scrolls past the screen) */
  laneRef: RefObject<HTMLElement>;
  renderCard: (item: T, index: number) => ReactNode;
  /** a card's height before it has been measured */
  estimate: (item: T) => number;
  /** ids that must stay rendered (open in the panel, the keyboard cursor, just moved) */
  pinIds?: readonly (string | null | undefined)[];
  /** "To do": for the screen-reader note */
  label: string;
}

const sameRanges = (a: readonly VirtualRange[], b: readonly VirtualRange[]) =>
  a.length === b.length && a.every((r, i) => r.start === b[i].start && r.end === b[i].end);

export function VirtualCards<T extends { id: string }>({ items, laneRef, renderCard, estimate, pinIds = [], label }: VirtualCardsProps<T>) {
  const measured = useRef(new Map<string, number>());
  const view = useRef({ top: 0, bottom: typeof window !== "undefined" ? window.innerHeight || 800 : 800 });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [, setVersion] = useState(0);
  const rerender = useCallback(() => setVersion((v) => v + 1), []);

  // measured heights live in a ref (a version bump re-renders); the rest are estimates
  const heights = items.map((t) => measured.current.get(t.id) ?? estimate(t));
  const pinned = useMemo(() => {
    const want = new Set([...pinIds, focusId].filter((x): x is string => !!x));
    const out: number[] = [];
    if (want.size) items.forEach((t, i) => { if (want.has(t.id)) out.push(i); });
    return out;
  }, [items, pinIds, focusId]);
  const ranges = virtualRanges(heights, GAP, view.current.top, view.current.bottom, OVERSCAN, pinned);
  const live = useRef({ heights, pinned, ranges });
  live.current = { heights, pinned, ranges };

  // follow the screen: any scroll (the board, or the page on a phone) and resizes
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const lane = laneRef.current;
      if (!lane || !lane.isConnected) return;
      const r = lane.getBoundingClientRect();
      // client px → CSS px (Appearance › text size zooms <html>)
      const k = lane.offsetHeight > 0 && r.height > 0 ? r.height / lane.offsetHeight : 1;
      const vh = window.innerHeight || 800;
      const top = (0 - r.top) / k - PAD, bottom = (vh - r.top) / k - PAD;
      view.current = { top, bottom };
      const L = live.current;
      const next = virtualRanges(L.heights, GAP, top, bottom, OVERSCAN, L.pinned);
      if (!sameRanges(next, L.ranges)) rerender();
    };
    const schedule = () => { if (!raf) raf = window.requestAnimationFrame ? window.requestAnimationFrame(update) : (update(), 0); };
    update();
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (raf && window.cancelAnimationFrame) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [laneRef, rerender]);

  // measure what rendered; a changed height re-plans the window once
  useLayoutEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    let changed = false;
    lane.querySelectorAll<HTMLElement>(":scope > [data-card-id]").forEach((el) => {
      const id = el.dataset.cardId, h = el.offsetHeight;
      if (!id || !(h > 0)) return;
      const was = measured.current.get(id);
      if (was === undefined || Math.abs(was - h) > 1) { measured.current.set(id, h); changed = true; }
    });
    if (changed) rerender();
  });

  // keep the focused card (and a neighbour each side) rendered
  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const onIn = (e: FocusEvent) => {
      const id = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-card-id]")?.dataset.cardId ?? null;
      setFocusId((cur) => (cur === id ? cur : id));
    };
    lane.addEventListener("focusin", onIn);
    return () => lane.removeEventListener("focusin", onIn);
  }, [laneRef]);

  const segments = virtualSegments(heights, GAP, ranges);
  const shown = ranges.reduce((n, r) => n + (r.end - r.start), 0);
  // one flat list of keyed children (cards keyed by task id), so a card never re-mounts — and never
  // loses focus — when the runs around it split or merge
  const nodes: ReactNode[] = [];
  segments.forEach((s, i) => {
    if (s.kind === "space") nodes.push(<div key={`space-${i === 0 ? "top" : i === segments.length - 1 ? "end" : `mid-${i}`}`} aria-hidden="true" className="kbd-vspace" style={{ height: s.height }} />);
    else for (let j = s.start; j < s.end; j++) nodes.push(renderCard(items[j], j));
  });
  return (
    <>
      {nodes}
      <p className="sr-only">{`Showing ${shown} of ${items.length} cards in ${label} as you scroll. J and K move through all of them.`}</p>
    </>
  );
}
