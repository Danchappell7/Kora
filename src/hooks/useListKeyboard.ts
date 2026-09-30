/* ============================================================
   KANBO — keyboard triage for lists (My tasks, a project's list,
   the board, Search).
   J / K (and ↓ / ↑ inside the list) move a cursor; focus follows it
   onto the item, so screen readers hear where it is and Enter opens
   it natively. X selects, Shift+J / Shift+K extend the selection,
   ⌘/Ctrl+Enter completes, S · P · D · A (and E · T · M · L) hand the
   item to the list for its status / priority / due / assignee (rename,
   on Today, move, labels) controls, Esc clears.
   Active when focus is inside the list, or nowhere (the page itself);
   never while typing, inside a menu or dialog, or straight after the
   app's "g" go-to prefix. Every action also has a mouse path.
   ============================================================ */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type ListKeyAction = "status" | "priority" | "due" | "assign" | "rename" | "today" | "move" | "labels";

const ACTION_KEYS: Record<string, ListKeyAction> = {
  s: "status", p: "priority", d: "due", a: "assign", e: "rename", t: "today", m: "move", l: "labels",
};

export const HINT_DISMISSED_KEY = "kanbo-hintbar-dismissed";
const G_PREFIX_MS = 1200;

export interface ListKeyboardOptions {
  rootRef: RefObject<HTMLElement>;
  /** the navigable items, matched in document (= visual) order */
  itemSelector: string;
  /** an item element's id */
  idOf: (el: HTMLElement) => string | undefined;
  /** what takes focus when the cursor lands on an item (default: the item) */
  focusTargetOf?: (el: HTMLElement) => HTMLElement | null;
  onOpen?: (id: string) => void;
  onComplete?: (id: string) => void;
  onToggleSelect?: (id: string) => void;
  /** Esc: clear any selection too */
  onClear?: () => void;
  onAction?: (action: ListKeyAction, id: string, el: HTMLElement) => void;
  enabled?: boolean;
}

export interface ListKeyboard {
  cursor: string | null;
  setCursor: (id: string | null) => void;
  /** show the key-hint bar (after the first J/K, until dismissed for good) */
  hint: boolean;
  dismissHint: () => void;
}

/** True for controls that take typed text (keys there are the user's, not ours). */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName !== "INPUT") return false;
  return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"].includes((el as HTMLInputElement).type);
}

const readDismissed = () => { try { return localStorage.getItem(HINT_DISMISSED_KEY) === "1"; } catch { return false; } };

export function useListKeyboard(opts: ListKeyboardOptions): ListKeyboard {
  const [cursor, setCursorState] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const lastG = useRef(0);

  const setCursor = useCallback((id: string | null) => { cursorRef.current = id; setCursorState(id); }, []);
  const dismissHint = useCallback(() => {
    setHint(false);
    try { localStorage.setItem(HINT_DISMISSED_KEY, "1"); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    if (opts.enabled === false) return;
    const items = (): HTMLElement[] => {
      const root = optsRef.current.rootRef.current;
      return root ? Array.from(root.querySelectorAll<HTMLElement>(optsRef.current.itemSelector)) : [];
    };
    const elFor = (id: string | null) => (id ? items().find((el) => optsRef.current.idOf(el) === id) ?? null : null);
    const land = (el: HTMLElement) => {
      const id = optsRef.current.idOf(el);
      if (!id) return;
      setCursor(id);
      const target = optsRef.current.focusTargetOf?.(el) ?? el;
      target.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: "nearest" });
    };
    const move = (dir: 1 | -1): HTMLElement | null => {
      const list = items();
      if (!list.length) return null;
      const i = list.findIndex((el) => optsRef.current.idOf(el) === cursorRef.current);
      const next = i < 0 ? list[0] : list[Math.max(0, Math.min(list.length - 1, i + dir))];
      land(next);
      if (!readDismissed()) setHint(true);
      return next;
    };

    const onKey = (e: KeyboardEvent) => {
      const o = optsRef.current;
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (isTypingTarget(target)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      // the app's "g then …" go-to shortcuts: the next key is theirs
      if (plain && !e.shiftKey && key === "g") { lastG.current = Date.now(); return; }
      if (Date.now() - lastG.current < G_PREFIX_MS) { lastG.current = 0; return; }
      const root = o.rootRef.current;
      if (!root) return;
      const inside = !!target && root.contains(target);
      const onPage = !target || target === document.body || target === document.documentElement;
      if (!inside && !onPage) return;
      // a menu, popover or dialog has the keys
      if (document.querySelector('[aria-modal="true"], [data-kpop]')) return;

      if (plain && (key === "j" || key === "k" || (inside && (key === "ArrowDown" || key === "ArrowUp")))) {
        e.preventDefault();
        const dir = key === "j" || key === "ArrowDown" ? 1 : -1;
        if (e.shiftKey && o.onToggleSelect && (key === "j" || key === "k")) {
          // extend: the row you're on joins the selection, then the next one
          const from = elFor(cursorRef.current);
          const fromId = from ? o.idOf(from) : undefined;
          if (fromId && from?.getAttribute("aria-selected") !== "true" && from?.dataset.selected !== "true") o.onToggleSelect(fromId);
          const next = move(dir);
          const nextId = next ? o.idOf(next) : undefined;
          if (nextId && nextId !== fromId && next?.dataset.selected !== "true") o.onToggleSelect(nextId);
          return;
        }
        move(dir);
        return;
      }

      const current = elFor(cursorRef.current);
      const id = current ? o.idOf(current) : undefined;
      if (key === "Escape" && plain) {
        if (cursorRef.current === null) return;
        setCursor(null);
        o.onClear?.();
        return;
      }
      if (!current || !id) return;
      if (key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        o.onComplete?.(id);
        return;
      }
      if (key === "Enter" && plain) {
        // a focused button or link opens itself; only a bare cursor needs us
        if (target && target !== current && target.closest("button, a, [role='button']")) return;
        e.preventDefault();
        o.onOpen?.(id);
        return;
      }
      if (!plain || e.shiftKey) return;
      if (key === "x" && o.onToggleSelect) { e.preventDefault(); o.onToggleSelect(id); return; }
      const action = ACTION_KEYS[key];
      if (action && o.onAction) { e.preventDefault(); o.onAction(action, id, current); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts.enabled, setCursor]);

  // clicking or tabbing to an item puts the cursor on it
  useEffect(() => {
    const root = opts.rootRef.current;
    if (!root || opts.enabled === false) return;
    const onFocusIn = (e: FocusEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(optsRef.current.itemSelector);
      if (!el || !root.contains(el)) return;
      const id = optsRef.current.idOf(el);
      if (id && id !== cursorRef.current) setCursor(id);
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, [opts.rootRef, opts.enabled, setCursor]);

  return { cursor, setCursor, hint, dismissHint };
}
