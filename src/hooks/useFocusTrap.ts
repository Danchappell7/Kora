import { useEffect, useLayoutEffect, useRef } from "react";

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
// how to put focus back inside each open trap: the control you were last in,
// else [data-autofocus], else the first focusable element, else the dialog
const reentry = new WeakMap<HTMLElement, () => void>();
// where focus should go back to for a trap that replaced another in the same
// update — the closing trap's openers, handed over before the new one's effect runs
const handoff = new WeakMap<HTMLElement, HTMLElement[]>();

export interface FocusTrapOptions {
  /** Escape pressed in a text field, textarea, select or contentEditable.
   *  - "leave" (the default): the first Escape only leaves the field — focus
   *    parks on the dialog and nothing typed is thrown away; the next Escape
   *    calls `onEscape`.
   *  - "dialog": goes straight to `onEscape`, with focus left where it is. For
   *    dialogs whose `onEscape` backs out in stages itself (close a picker,
   *    revert an unsaved rename, clear a filter, then close). Focus never
   *    moves, so no blur handler can commit an edit on the way out. */
  fieldEscape?: "leave" | "dialog";
}

/**
 * Traps focus within the returned ref'd element while `active`, and restores
 * focus to the previously-focused element on close.
 *
 * - On activate, focus moves inside: to `[data-autofocus]`, else the first
 *   focusable element — unless a child already took focus (autoFocus), or a
 *   dialog that opened on top in the same render owns it.
 * - Tab / Shift+Tab wrap; focus that escapes (screen-reader navigation, a
 *   click on the page behind) is pulled back while this is the top trap. When
 *   focus is parked on the dialog itself, Tab carries on from the control you
 *   were last in rather than jumping back to the top.
 * - Escape is handled at the document, after React's handlers (which run at
 *   the app root), so anything inside that handles Escape itself — a menu, a
 *   picker, a field — can stop it (stopPropagation) or mark it handled
 *   (preventDefault) first. Only the topmost trap acts on it, and when it does
 *   it marks the event handled, so App's window-level handler leaves it alone:
 *     · from a text field, textarea, select or contentEditable, the first
 *       Escape just leaves the field (focus parks on the dialog, nothing typed
 *       is thrown away); the next Escape closes — unless the dialog opted into
 *       `{ fieldEscape: "dialog" }` (see FocusTrapOptions);
 *     · from anywhere else in the dialog — or from the page, when focus has
 *       dropped to <body> — it calls `onEscape`.
 * - On close, focus goes back to where it was before the dialog opened. If
 *   that's gone, or a dialog underneath is still open and it isn't in there,
 *   focus goes back into that dialog instead of dropping to <body>. When one
 *   dialog is swapped for another in a single update, the new one inherits
 *   the old one's opener, so closing it still lands where you started.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void, options?: FocusTrapOptions) {
  const ref = useRef<T>(null);
  // keep the latest onEscape without making it an effect dependency — callers
  // usually pass an inline arrow, which would otherwise re-run the effect every
  // render and steal focus back to the previously-focused element.
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  const fieldEscRef = useRef(options?.fieldEscape);
  fieldEscRef.current = options?.fieldEscape;
  // Where focus was before the dialog opened. Read while rendering the open,
  // because by the time any effect runs an autoFocus control inside has already
  // taken focus — and "restoring" to that on close drops focus onto <body>.
  const opener = useRef<{ el: Element | null } | null>(null);
  if (!active) opener.current = null;
  else if (!opener.current) opener.current = { el: typeof document === "undefined" ? null : document.activeElement };

  // Join the stack in the layout phase: when several dialogs open in the same
  // render (a welcome modal over onboarding) they are all stacked, in render
  // order, before any of them moves focus in the effect below.
  useLayoutEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    stack.push(el);
    return () => {
      const i = stack.lastIndexOf(el);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    // where to hand focus back on close: where it was when the dialog opened,
    // else where it is now (a menu that opened us may have put it back on its
    // trigger) — whichever is still on the page by then
    const outside = (x: Element | null | undefined): x is HTMLElement => x instanceof HTMLElement && x !== document.body && !el.contains(x);
    // (plus, last, where a dialog we replaced in this same update started)
    const openers = [opener.current?.el, document.activeElement, ...(handoff.get(el) ?? [])].filter(outside);
    const isTop = () => stack[stack.length - 1] === el;
    const focusable = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((e) => e.tabIndex >= 0 && (e.offsetParent !== null || e === document.activeElement));
    const focusEl = (target: HTMLElement) => { try { target.focus({ preventScroll: true }); } catch { target.focus(); } };
    const focusContainer = () => {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      focusEl(el);
    };
    const focusStart = () => {
      const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? focusable()[0];
      if (first) focusEl(first); else focusContainer();
    };

    // initial focus (effects run after children's autoFocus, so respect it) —
    // only for the top trap: a dialog that opened over us in the same render owns focus
    if (isTop() && !el.contains(document.activeElement)) focusStart();
    // the last control inside that had focus (never the container itself)
    const a0 = document.activeElement;
    let lastInside: HTMLElement | null = a0 instanceof HTMLElement && a0 !== el && el.contains(a0) ? a0 : null;
    reentry.set(el, () => {
      if (lastInside && lastInside.isConnected && el.contains(lastInside)) focusEl(lastInside); else focusStart();
    });

    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const cur = document.activeElement;
      // focus parked on the container itself (or lost) — carry on from the
      // control you were last in, else enter at the right end
      if (cur === el || !el.contains(cur)) {
        e.preventDefault();
        const i = lastInside && lastInside.isConnected ? items.indexOf(lastInside) : -1;
        const next = i < 0 ? (e.shiftKey ? last : first) : items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length];
        focusEl(next);
        return;
      }
      if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
    };
    // every open modal is one of ours (or inside one) — none of App's own overlays
    const onlyTrapsOpen = () =>
      Array.from(document.querySelectorAll('[aria-modal="true"]')).every((d) => stack.some((s) => s === d || s.contains(d)));
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (!isTop()) return;                                   // a dialog above us owns it
      const t = e.target;
      const inside = t instanceof Node && el.contains(t);
      // focus dropped onto the page (the control it was on went away, or a click
      // on plain text): the key still belongs to the top dialog
      const lost = !inside && (t === document.body || t === document.documentElement) && onlyTrapsOpen();
      if (!inside && !lost) return;
      e.preventDefault();                                     // handled — outer handlers leave it alone
      if (inside && isEditableTarget(t) && fieldEscRef.current !== "dialog") { focusContainer(); return; }  // leave the field; the next Escape closes
      escRef.current?.();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof HTMLElement) || t === document.body) return;
      if (t === el) return;
      if (el.contains(t)) { lastInside = t; return; }
      if (!isTop()) return;                                   // a dialog above us owns focus
      if (t.closest(OTHER_LAYER)) return;                     // popover / toast / other dialog
      const back = lastInside && lastInside.isConnected && el.contains(lastInside) ? lastInside : focusable()[0];
      if (back) focusEl(back); else focusContainer();
    };
    el.addEventListener("keydown", onTab);
    document.addEventListener("keydown", onEsc);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      el.removeEventListener("keydown", onTab);
      document.removeEventListener("keydown", onEsc);
      document.removeEventListener("focusin", onFocusIn);
      reentry.delete(el);
      handoff.delete(el);
      // (the stack entry went in the layout cleanup, so the stack is already
      // what's left open, plus anything that opened in this same update)
      // A trap whose effect hasn't run yet opened in this same update, so it
      // isn't beneath us: it replaces us (the command palette closing as the
      // dialog it picked opens). It inherits where we started, so closing it
      // still lands there, and its own effect moves focus in.
      const replacements = stack.filter((s) => !reentry.has(s));
      for (const s of replacements) handoff.set(s, [...(handoff.get(s) ?? []), ...openers]);
      if (replacements.length) return;
      // hand focus back — but never steal it from a dialog that opened on top
      const now = document.activeElement;
      if (now && now !== document.body && !el.contains(now)) return;
      const under = stack[stack.length - 1];
      const prev = openers.find((x) => x.isConnected);
      if (prev && (!under || under.contains(prev))) focusEl(prev);
      else if (under) reentry.get(under)?.();
    };
  }, [active]);
  return ref;
}
