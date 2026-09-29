import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// input types that don't take typing — Escape on them can close the dialog
const NON_TEXT_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"]);

/** True when a keyboard event started in a field the user types or picks
 *  values in. Escape there belongs to the field (or its menu), not the dialog. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName === "INPUT") return !NON_TEXT_INPUTS.has(((t as HTMLInputElement).type || "text").toLowerCase());
  return false;
}

// Focus that lands in one of these belongs to a layer that manages its own
// focus (another dialog, a portalled menu or listbox, the toast region), so the
// trap below it must not pull it back.
const OTHER_LAYER = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[aria-live],[data-focus-trap-ignore]';

// every active trap container, innermost (most recently opened) last
const stack: HTMLElement[] = [];

/**
 * Traps focus within the returned ref'd element while `active`, and restores
 * focus to the previously-focused element on close.
 *
 * - On activate, focus moves inside: to `[data-autofocus]`, else the first
 *   focusable element — unless a child already took focus (autoFocus).
 * - Tab / Shift+Tab wrap; focus that escapes (screen-reader navigation, a
 *   click on the page behind) is pulled back while this is the top trap.
 * - Escape calls `onEscape`, except when the event was already handled
 *   (`defaultPrevented`) or started in a text field, textarea, select or
 *   contentEditable. This native listener runs BEFORE React's onKeyDown
 *   handlers, so fields can't veto it in time; instead they own their own
 *   Escape (and call preventDefault + stopPropagation when they handle it).
 *   A React `onKeyDownCapture` handler DOES run first, so a dialog can
 *   preventDefault there to keep itself open.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void) {
  const ref = useRef<T>(null);
  // keep the latest onEscape without making it an effect dependency — callers
  // usually pass an inline arrow, which would otherwise re-run the effect every
  // render and steal focus back to the previously-focused element.
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    stack.push(el);
    const focusable = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((e) => e.tabIndex >= 0 && (e.offsetParent !== null || e === document.activeElement));
    const focusEl = (target: HTMLElement) => { try { target.focus({ preventScroll: true }); } catch { target.focus(); } };
    const focusContainer = () => {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      focusEl(el);
    };

    // initial focus (effects run after children's autoFocus, so respect it)
    if (!el.contains(document.activeElement)) {
      const auto = el.querySelector<HTMLElement>("[data-autofocus]");
      const first = auto ?? focusable()[0];
      if (first) focusEl(first); else focusContainer();
    }
    let lastInside: HTMLElement | null = el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented || isEditableTarget(e.target)) return;
        escRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const cur = document.activeElement;
      // focus parked on the container itself (or lost) — enter at the right end
      if (cur === el || !el.contains(cur)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof HTMLElement) || t === document.body) return;
      if (el.contains(t)) { lastInside = t; return; }
      if (stack[stack.length - 1] !== el) return;          // a dialog above us owns focus
      if (t.closest(OTHER_LAYER)) return;                  // popover / toast / other dialog
      const back = lastInside && lastInside.isConnected && el.contains(lastInside) ? lastInside : focusable()[0];
      if (back) focusEl(back); else focusContainer();
    };
    el.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      el.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      const i = stack.lastIndexOf(el);
      if (i >= 0) stack.splice(i, 1);
      // hand focus back — but never steal it from a dialog that opened on top
      const now = document.activeElement;
      if (!now || now === document.body || el.contains(now)) prev?.focus?.();
    };
  }, [active]);
  return ref;
}
