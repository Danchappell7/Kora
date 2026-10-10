/* ============================================================
   KANBO — Popover: anchored menus that can't be clipped.
   Renders into document.body, so a row's content-visibility, an
   overflow:auto list or a frosted (backdrop-filter) bar can't clip it or
   trap its "fixed" click-away layer. It positions itself from the
   trigger's rect, flips above the trigger when there isn't room below,
   stays inside the viewport, and follows the trigger on scroll/resize.
   Keyboard: focus moves into the menu (to the checked item, or the
   first), ↑/↓/Home/End move between items, Escape or Tab close it and
   focus returns to the trigger. It enters in 160ms and leaves in 90ms.
   Import directly: import { Popover } from "../primitives/Popover".
   ============================================================ */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

export type PopoverSide = "bottom" | "top";
export type PopoverAlign = "start" | "end";
export interface PopoverRect { top: number; bottom: number; left: number; right: number }
export interface PopoverPlacement { top: number; left: number; side: PopoverSide; maxHeight: number; maxWidth: number }

const EDGE = 8;           // keep this far from the viewport edges
const MIN_USEFUL = 160;   // below this much room on either side, overlay instead of squashing

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/** Pure placement maths (unit-tested): where a panel of `panel` size goes next
 *  to `anchor` inside `viewport`. Prefers `side`, flips when the other side has
 *  more room, clamps horizontally, and caps the height to the room available. */
export function computePopoverPosition(
  anchor: PopoverRect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { side?: PopoverSide; align?: PopoverAlign; offset?: number; edge?: number } = {},
): PopoverPlacement {
  const gap = opts.offset ?? 6, edge = opts.edge ?? EDGE;
  const below = viewport.height - anchor.bottom - gap - edge;
  const above = anchor.top - gap - edge;
  const prefer = opts.side ?? "bottom";
  const preferRoom = prefer === "bottom" ? below : above;
  const otherRoom = prefer === "bottom" ? above : below;
  const side: PopoverSide = panel.height > preferRoom && otherRoom > preferRoom ? (prefer === "bottom" ? "top" : "bottom") : prefer;
  const room = Math.max(0, side === "bottom" ? below : above);
  const fullRoom = Math.max(0, viewport.height - 2 * edge);
  let top: number, maxHeight: number;
  if (panel.height <= room || room >= MIN_USEFUL) {
    maxHeight = room;
    const h = Math.min(panel.height, room);
    // (clamped too, in case the trigger itself is partly off-screen)
    top = clamp(side === "bottom" ? anchor.bottom + gap : anchor.top - gap - h, edge, viewport.height - edge - h);
  } else {
    // cramped both ways (tiny/landscape phone): overlap the trigger rather than squash the menu
    maxHeight = fullRoom;
    const h = Math.min(panel.height, fullRoom);
    top = clamp(side === "bottom" ? anchor.bottom + gap : anchor.top - gap - h, edge, viewport.height - edge - h);
  }
  const maxWidth = Math.max(0, viewport.width - 2 * edge);
  const w = Math.min(panel.width, maxWidth);
  const left = clamp(opts.align === "end" ? anchor.right - w : anchor.left, edge, viewport.width - edge - w);
  return { top: Math.round(top), left: Math.round(left), side, maxHeight: Math.floor(maxHeight), maxWidth };
}

const ITEM_SELECTOR = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((el) => !el.hasAttribute("hidden"));
}

// Hover + keyboard-focus highlight for older, hand-styled menu items. They
// commonly carry an inline `background: transparent`, hence !important. Kit
// controls (Button, IconButton, .kmenu-item, Toggle…) style their own hover
// and focus, and must keep their fill and tone (a danger item stays red, a
// primary Save stays accent), so they're left out. A separator (<hr>) is a
// hairline with 4px of air.
const LEGACY_ITEM = "button:not(.btn, .btn-accent, .btn-ghost, .btn-icon, .kbtn, .kibtn, .kmenu-item, .kpill, .kglyph, .kcheck, .kseg-btn, .ktab, .ktoggle-switch, .kdate, .kprov-btn)";
const PANEL_CSS = `
[data-kpop-panel] ${LEGACY_ITEM}:not(:disabled):hover, [data-kpop-panel] ${LEGACY_ITEM}:focus-visible { background: var(--fill-1, color-mix(in oklch, var(--ink) 7%, transparent)) !important; color: var(--ink) !important; }
[data-kpop-panel] ${LEGACY_ITEM}:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
[data-kpop-panel] > hr { height: 1px; margin: 4px -4px; border: 0; background: var(--hairline); }
@media (prefers-reduced-motion: reduce) { [data-kpop-panel] { animation: none !important; } }
`;

const EXIT_MS = 90;
const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The 90ms exit. The real panel goes at once (so focus, state and anything
 *  reading the DOM never wait on an animation); an inert, hidden-from-AT copy
 *  fades out where it stood. Needs the Web Animations API; skipped under
 *  reduced motion, and for a panel that never got placed. */
function fadeOutCopy(panel: HTMLElement, zIndex: number) {
  if (!panel.isConnected || typeof panel.animate !== "function" || reducedMotion()) return;
  if (panel.style.visibility === "hidden") return;
  const ghost = panel.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("data-kpop-panel");
  ghost.removeAttribute("role");
  ghost.removeAttribute("aria-label");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.classList.remove("anim-scalein");
  Object.assign(ghost.style, { zIndex: String(zIndex), pointerEvents: "none", animation: "none" });
  // what the clone doesn't carry: typed text and the list's scroll position
  const fields = panel.querySelectorAll<HTMLInputElement>("input, textarea");
  ghost.querySelectorAll<HTMLInputElement>("input, textarea").forEach((el, i) => { if (fields[i]) el.value = fields[i].value; });
  document.body.appendChild(ghost);
  ghost.scrollTop = panel.scrollTop;
  let gone = false;
  const remove = () => { if (!gone) { gone = true; ghost.remove(); } };
  try {
    const a = ghost.animate([{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: "0 4px" }], { duration: EXIT_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
    a.onfinish = remove;
    a.oncancel = remove;
  } catch { remove(); return; }
  window.setTimeout(remove, EXIT_MS + 100); // never leave it behind
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

export interface PopoverProps {
  open: boolean;
  /** the trigger — used for placement, and focus returns to it on close */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  side?: PopoverSide;
  align?: PopoverAlign;
  offset?: number;
  role?: "menu" | "listbox" | "dialog";
  /** accessible name for the panel, e.g. `Status for “Q3 budget”` */
  label?: string;
  minWidth?: number;
  maxHeight?: number;
  className?: string;
  style?: CSSProperties;
  /** move focus into the panel when it opens (default true) */
  autoFocus?: boolean;
  /** where that focus lands (e.g. a picker's text field); default: the
   *  checked/selected item, else the first focusable one */
  initialFocus?: RefObject<HTMLElement | null>;
  zIndex?: number;
}

export function Popover({ open, anchorRef, onClose, children, side = "bottom", align = "start", offset = 6, role = "menu", label, minWidth = 150, maxHeight, className, style, autoFocus = true, initialFocus, zIndex = 1100 }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // React detaches the ref (null) while the panel is still in the page, on
  // close or unmount alike: that's the moment to leave the fading copy behind
  const zRef = useRef(zIndex);
  zRef.current = zIndex;
  const setPanel = useCallback((el: HTMLDivElement | null) => {
    if (!el && panelRef.current) fadeOutCopy(panelRef.current, zRef.current);
    panelRef.current = el;
  }, []);
  const [place, setPlace] = useState<PopoverPlacement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // several events can race to close (scroll bursts, Escape + blur…): only
  // tell the owner once per opening, so a toggle-style onClose can't reopen it
  const closedRef = useRef(false);
  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  }, []);
  const focusedRef = useRef(false);
  useLayoutEffect(() => {
    if (open) { closedRef.current = false; return; }
    focusedRef.current = false;
    setPlace(null);
  }, [open]);

  const measure = useCallback(() => {
    const a = anchorRef.current, p = panelRef.current;
    if (!a || !p) return;
    if (!a.isConnected) { close(); return; }
    const r = a.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const natural = { width: p.offsetWidth, height: Math.min(p.scrollHeight + (p.offsetHeight - p.clientHeight), maxHeight ?? Infinity) };
    const next = computePopoverPosition(r, natural, { width: vw, height: vh }, { side, align, offset });
    setPlace((cur) => cur && cur.top === next.top && cur.left === next.left && cur.side === next.side && cur.maxHeight === next.maxHeight && cur.maxWidth === next.maxWidth ? cur : next);
  }, [anchorRef, close, maxHeight, side, align, offset]);

  // (re)place before paint on every render while open — cheap, and keeps the
  // panel glued to its trigger if the row re-renders or moves
  useLayoutEffect(() => { if (open) measure(); });

  // role="menu" must own menu items: give plain buttons the role so any
  // caller's children are announced correctly
  useLayoutEffect(() => {
    if (!open || role !== "menu" || !panelRef.current) return;
    for (const el of Array.from(panelRef.current.children)) {
      if (el.tagName === "BUTTON" && !el.hasAttribute("role")) el.setAttribute("role", "menuitem");
    }
  });

  // follow the trigger on scroll/resize; close if it scrolls out of view
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const a = anchorRef.current;
        if (!a || !a.isConnected) { close(); return; }
        const r = a.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) { close(); return; }
        measure();
      });
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onMove); window.removeEventListener("scroll", onMove, true); };
  }, [open, anchorRef, close, measure]);

  // Escape closes the innermost popover only — captured at the window so it
  // never also closes the task panel / modal underneath (App's Escape handler)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  // hand focus back to the trigger when the menu goes away with focus inside it
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    return () => {
      const ae = document.activeElement;
      if (anchor && anchor.isConnected && (!ae || ae === document.body)) anchor.focus({ preventScroll: true });
    };
  }, [open, anchorRef]);

  // move focus in once it's placed (a visibility:hidden panel can't take focus)
  useEffect(() => {
    if (!open || !place || focusedRef.current || !autoFocus) return;
    focusedRef.current = true;
    const items = focusables(panelRef.current);
    const preferred = initialFocus?.current;
    const current = (preferred && panelRef.current?.contains(preferred) ? preferred : undefined)
      ?? items.find((el) => el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") ?? items[0];
    if (!current) return;
    current.focus({ preventScroll: true }); // (never scroll the page behind the menu)
    // …but preventScroll also stops the panel itself scrolling, so a checked item further down
    // a long list (assignees) would take focus out of sight: centre it in the panel instead
    const panel = panelRef.current;
    if (panel && panel.scrollHeight > panel.clientHeight && panel.contains(current)) {
      const pr = panel.getBoundingClientRect(), cr = current.getBoundingClientRect();
      const within = cr.top - pr.top + panel.scrollTop; // item's offset inside the scrolled content
      if (cr.top < pr.top || cr.bottom > pr.bottom) panel.scrollTop = Math.max(0, within - (panel.clientHeight - cr.height) / 2);
    }
  }, [open, place, autoFocus, initialFocus]);

  if (!open || typeof document === "undefined") return null;

  const isMenu = role === "menu" || role === "listbox";
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // keys used in here must not reach the row (Enter opens a task) or the app's shortcuts
    e.stopPropagation();
    if (!isMenu) return;
    const items = focusables(panelRef.current);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = items[(i + 1) % items.length];
    else if (e.key === "ArrowUp") next = items[(i - 1 + items.length) % items.length];
    else if (e.key === "Home") next = items[0];
    else if (e.key === "End") next = items[items.length - 1];
    else if (e.key === "Tab") { e.preventDefault(); close(); return; }
    if (next) { e.preventDefault(); next.focus(); }
  };

  const flipped = place?.side === "top";
  const cap = Math.min(maxHeight ?? Infinity, place?.maxHeight ?? Infinity);
  return createPortal(
    // the full-viewport root IS the click-away layer; React events from inside
    // a portal still bubble to the trigger's ancestors (e.g. a row that opens
    // its task on click), so they stop here. data-focus-trap-ignore: the menu
    // manages its own focus, so a dialog's focus trap underneath (useFocusTrap)
    // must not pull focus back out of it — whatever role the panel has.
    // (data-kdnd-ignore: a press in a menu never starts a task drag, lib/dnd)
    <div data-kpop="" data-focus-trap-ignore="" data-kdnd-ignore="" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) close(); }}
      onContextMenu={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) { e.preventDefault(); close(); } }}
      onWheel={(e) => { if (e.target === e.currentTarget) close(); }}
      onTouchMove={(e) => { if (e.target === e.currentTarget) close(); }}
      onDoubleClick={stop} onDragStart={stop} onDragOver={stop} onDrop={stop}
      style={{ position: "fixed", inset: 0, zIndex }}>
      <style>{PANEL_CSS}</style>
      <div ref={setPanel} data-kpop-panel="" role={role} aria-label={label} aria-orientation={isMenu && role === "menu" ? "vertical" : undefined}
        className={"anim-scalein" + (className ? " " + className : "")} onKeyDown={onKeyDown}
        style={{
          position: "fixed", top: place?.top ?? 0, left: place?.left ?? 0,
          visibility: place ? "visible" : "hidden",
          minWidth, maxWidth: place?.maxWidth, maxHeight: Number.isFinite(cap) ? cap : undefined,
          overflowY: "auto", overscrollBehavior: "contain", boxSizing: "border-box",
          // the menu recipe: raised surface, r-lg, e2 (which draws its own hairline), 4px of padding
          padding: 4, borderRadius: "var(--r-lg, 12px)", background: "var(--surface-raised, var(--surface-solid))", border: "none", boxShadow: "var(--e2, var(--shadow-lg))",
          transformOrigin: flipped ? "50% 100%" : "50% 0",
          ...style,
        }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
