/* ============================================================
   KANBO — the task views' anchored popover (Board, Timeline, Month).
   Menus render into <body> with fixed positioning taken from the
   trigger's rect, so they float above neighbouring cards and scroll
   containers instead of being drawn underneath the next card. They
   flip above the trigger when there's no room below and are clamped
   to the viewport. Menus get arrow-key navigation; dialogs trap focus.
   Escape closes and focus returns to the trigger.
   (Moved here from OtherViews so the board's own pieces can share it.)
   ============================================================ */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../primitives";
import { useFocusTrap } from "../../hooks/useFocusTrap";

export function Popover({ anchor, onClose, label, role = "menu", align = "start", minWidth = 160, maxWidth, children }: {
  anchor: HTMLElement | null; onClose: () => void; label: string;
  role?: "menu" | "dialog"; align?: "start" | "end"; minWidth?: number; maxWidth?: number; children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useFocusTrap<HTMLDivElement>(role === "dialog", onClose);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [ready, setReady] = useState(false);

  const place = useCallback(() => {
    const box = boxRef.current, panel = panelRef.current, bd = backdropRef.current;
    if (!box || !panel || !bd || !anchor || !anchor.isConnected) return;
    // calibrate CSS px against client px — Appearance → text size applies `zoom` to <html>
    box.style.left = "0px"; box.style.top = "0px"; panel.style.maxHeight = "";
    const r0 = box.getBoundingClientRect();
    box.style.left = "100px";
    const k = (box.getBoundingClientRect().left - r0.left) / 100 || 1;
    const view = bd.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    const gap = 6 * k, pad = 8 * k;
    const below = view.bottom - a.bottom - gap - pad, above = a.top - view.top - gap - pad;
    const flip = r0.height > below && above > below;
    const room = Math.max(120 * k, flip ? above : below);
    let x = align === "end" ? a.right - r0.width : a.left;
    x = Math.max(view.left + pad, Math.min(x, view.right - r0.width - pad));
    const y = flip ? a.top - gap - Math.min(r0.height, room) : a.bottom + gap;
    box.style.left = `${(x - r0.left) / k}px`;
    box.style.top = `${(y - r0.top) / k}px`;
    panel.style.maxHeight = `${room / k}px`;
    panel.style.transformOrigin = flip ? "50% 100%" : "50% 0";
  }, [anchor, align, panelRef]);

  useLayoutEffect(() => { place(); setReady(true); }, [place]);
  useEffect(() => {
    const onScroll = (e: Event) => { if (!boxRef.current?.contains(e.target as Node)) place(); };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", onScroll, true); };
  }, [place]);
  // initial focus: an explicit target, else the current choice, else the first control
  useEffect(() => {
    if (!ready) return;
    const p = panelRef.current;
    const target = p?.querySelector<HTMLElement>("[data-autofocus]")
      ?? p?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?? p?.querySelector<HTMLElement>('[role^="menuitem"], button:not([disabled]), input, a[href]');
    target?.focus({ preventScroll: true });
  }, [ready, panelRef]);
  // hand focus back to the trigger on close (when it's still on the page)
  useEffect(() => () => {
    const ae = document.activeElement;
    if (anchor?.isConnected && (!ae || ae === document.body)) anchor.focus({ preventScroll: true });
  }, [anchor]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation(); // keep keys away from the card underneath and global shortcuts
    if (role === "dialog") return; // useFocusTrap handles Escape + Tab
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); closeRef.current(); return; }
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };

  return createPortal(
    <>
      <div ref={backdropRef} data-kpop="" onClick={(e) => { e.stopPropagation(); closeRef.current(); }} onPointerDown={(e) => e.stopPropagation()} style={{ position: "fixed", inset: 0, zIndex: 80 }} />
      <div ref={boxRef} style={{ position: "fixed", zIndex: 81, visibility: ready ? "visible" : "hidden" }}>
        <div ref={panelRef} role={role} aria-label={label} aria-modal={role === "dialog" ? true : undefined} data-kpop-panel=""
          onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} className={ready ? "anim-scalein" : undefined}
          style={{ minWidth, maxWidth, overflowY: "auto", padding: 4, borderRadius: "var(--r-lg, 12px)", background: "var(--surface-raised)", boxShadow: "var(--e2, var(--shadow-lg))", border: "1px solid var(--hairline)" }}>
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

export function MenuItem({ checked, onSelect, disabled, title, children }: { checked?: boolean; onSelect: () => void; disabled?: boolean; title?: string; children: ReactNode }) {
  return (
    <button type="button" role={checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={checked} className="ktv-mi"
      disabled={disabled} title={title}
      onClick={onSelect} onMouseEnter={(e) => { if (!disabled) e.currentTarget.focus({ preventScroll: true }); }}>
      {children}
      {checked && <span className="ktv-mi-end"><Icon name="check" size={14} sw={2.2} /></span>}
    </button>
  );
}
