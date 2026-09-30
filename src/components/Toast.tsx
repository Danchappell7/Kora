/* ============================================================
   KANBO — toast notifications (replaces alert())
   Bottom-left, a raised 40px strip; 5s, 7s for an error, at least 10s with
   an Undo. At most three on screen. A toast that's up stays up until it
   goes (so the one you're reading or focused on never vanishes); later ones
   wait their turn with their clocks stopped, so a Retry or an Undo is always
   seen for its full time. Only a plain note (no action, not an error) makes
   way early for a newer toast, and never while the stack is hovered or
   holds focus. Clocks pause while the stack is hovered, holds keyboard
   focus, or the tab is hidden, so nobody loses an Undo while reaching for
   it (WCAG 2.2.1).
   Every Undo registers in lib/undoStack from the moment it's made until its
   toast goes, so undoLast() takes back changes newest first. ⌘Z / Ctrl+Z
   itself belongs to App's keyboard handler (it calls undoLast()); this
   provider adds no key handler of its own.
   ============================================================ */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Icon } from "./primitives";
import { pushUndo } from "../lib/undoStack";

type ToastType = "error" | "success" | "info";
interface ToastAction { label: string; run: () => void }
interface ToastItem { id: number; message: string; type: ToastType; action?: ToastAction }

/**
 * Options for an action toast. Passing an options OBJECT (even `{}`) opts in to
 * the managed lifecycle: the toast stays up for at least 10s, pauses while
 * hovered / focused / the tab is hidden, and calls `onExpire` exactly once when
 * it goes away without the action being run (timed out, dismissed with ×,
 * flushed, the page being closed or reloaded, or the app unmounting). Put a
 * deferred commit (e.g. the real delete) in `onExpire` so the Undo button can
 * never outlive the thing it undoes.
 *
 * Legacy callers that pass a number (or nothing) keep a FIXED lifetime of
 * `ms` (default 10s) with no pausing, because they may be committing on their
 * own timer of the same length — keeping the toast up longer would offer an
 * Undo that no longer works. (A legacy toast that has to wait for a slot
 * starts its clock when it appears; App's delete Undo still works after its
 * own commit, as it saves the rows back.)
 *
 * `key`: a managed toast with the same key as one still on screen (or waiting
 * for a slot) takes its place (same slot, so keyboard focus on it isn't lost, with a fresh clock)
 * instead of stacking another. The one it replaces ends as if dismissed: its
 * `onExpire` runs. Callers that want one running Undo (e.g. "Archived 3
 * notifications") merge their own state and pass the same key each time.
 */
export interface ToastActionOptions {
  ms?: number;
  onExpire?: () => void;
  key?: string;
}

interface ToastApi {
  toast: (message: string, type?: ToastType) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  /** toast with an action button (e.g. Undo). See ToastActionOptions. */
  action: (message: string, label: string, run: () => void, opts?: number | ToastActionOptions) => void;
  /** commit every pending managed toast now (runs their onExpire) — e.g. before signing out */
  flush: () => void;
}

/** Minimum on-screen time for a managed action toast (Undo). */
export const ACTION_TOAST_MIN_MS = 10000;
const LEGACY_ACTION_MS = ACTION_TOAST_MIN_MS;
/** How long a plain note stays up (§2.5); an error gets a little longer to read. */
export const TOAST_MS = 5000;
const ERROR_TOAST_MS = 7000;
/** Toasts on screen at once; the rest wait their turn, oldest first. */
export const MAX_VISIBLE_TOASTS = 3;

const ToastContext = createContext<ToastApi | null>(null);

let _id = 0;

interface Entry {
  item: ToastItem;             // what it shows (held here while it waits for a slot)
  shown: boolean;              // on screen; a waiting toast's clock doesn't run
  plain: boolean;              // a note with no action that isn't an error: may make way for a newer toast
  remaining: number;           // ms left on the clock
  startedAt: number;           // when the current run of the clock started
  timer: ReturnType<typeof setTimeout> | null;
  pausable: boolean;           // legacy action toasts keep a fixed lifetime
  onExpire?: () => void;
  key?: string;                // a later toast with this key takes this one's place
  unregister?: () => void;     // takes its Undo back off the ⌘Z stack
}
type NewEntry = Pick<Entry, "remaining" | "pausable" | "onExpire" | "key" | "unregister">;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
const UNDO_KEYS = isMac ? "⌘Z" : "Ctrl+Z";
const isUndo = (label: string) => /^undo$/i.test(label.trim());

const alertIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]); // the ones on screen, oldest first
  const entries = useRef<Map<number, Entry>>(new Map()); // every toast, on screen or waiting, in arrival order
  const stackRef = useRef<HTMLDivElement>(null);
  // why the clocks are paused — any one of these holds them
  const hover = useRef(false);
  const focusWithin = useRef(false);
  const hidden = useRef(typeof document !== "undefined" && document.visibilityState === "hidden");
  const paused = useRef(false);

  // take a toast away without filling its slot (close() does both)
  const drop = useCallback((id: number, reason: "expire" | "dismiss" | "action") => {
    // always take it off screen, even without a clock (e.g. a toast whose entry
    // a StrictMode remount cleared) — × must never leave a toast stuck
    setItems((xs) => xs.some((x) => x.id === id) ? xs.filter((x) => x.id !== id) : xs);
    const e = entries.current.get(id);
    if (!e) return; // already gone — never run onExpire twice
    if (e.timer) clearTimeout(e.timer);
    e.unregister?.();
    entries.current.delete(id);
    e.shown = false;
    if (reason !== "action" && e.onExpire) {
      try { e.onExpire(); } catch (err) { console.error(err); }
    }
  }, []);

  // a toast's clock runs only while it's on screen, and (if pausable) while nothing holds the stack
  const closeRef = useRef<(id: number, reason: "expire") => void>(() => {});
  const start = useCallback((id: number) => {
    const e = entries.current.get(id);
    if (!e || !e.shown || e.timer || (e.pausable && paused.current)) return;
    e.startedAt = Date.now();
    e.timer = setTimeout(() => closeRef.current(id, "expire"), Math.max(0, e.remaining));
  }, []);

  // Fill free slots with waiting toasts, oldest first. When the stack is full
  // a plain note makes way — never while someone's hovering or focused on it.
  const promote = useCallback(() => {
    const all = [...entries.current];
    const waiting = all.filter(([, e]) => !e.shown);
    if (!waiting.length) return;
    let onScreen = all.length - waiting.length;
    const held = hover.current || focusWithin.current;
    const appeared: ToastItem[] = [];
    for (const [id, e] of waiting) {
      if (onScreen >= MAX_VISIBLE_TOASTS) {
        const note = held ? undefined : all.find(([, x]) => x.shown && x.plain);
        if (!note) break; // the rest keep waiting, in order
        drop(note[0], "expire");
        onScreen--;
      }
      e.shown = true;
      onScreen++;
      appeared.push(e.item);
      start(id);
    }
    // (a note shown and made way for in this same pass never reaches the screen)
    const add = appeared.filter((it) => entries.current.get(it.id)?.shown);
    if (add.length) setItems((xs) => [...xs, ...add]);
  }, [drop, start]);

  const close = useCallback((id: number, reason: "expire" | "dismiss" | "action") => {
    drop(id, reason);
    promote();
  }, [drop, promote]);
  closeRef.current = close;

  const syncPaused = useCallback(() => {
    const next = hover.current || focusWithin.current || hidden.current;
    if (next !== paused.current) {
      paused.current = next;
      entries.current.forEach((e, id) => {
        if (!e.pausable) return;
        if (next) {
          if (e.timer) {
            clearTimeout(e.timer); e.timer = null;
            e.remaining = Math.max(0, e.remaining - (Date.now() - e.startedAt));
          }
        } else start(id);
      });
    }
    // let go of the stack: a note that was held may now make way
    if (!hover.current && !focusWithin.current) promote();
  }, [start, promote]);

  const push = useCallback((item: ToastItem, entry: NewEntry) => {
    const plain = !item.action && item.type !== "error";
    entries.current.set(item.id, { ...entry, item, shown: false, plain, startedAt: Date.now(), timer: null });
    promote();
  }, [promote]);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    push({ id: ++_id, message, type }, { remaining: type === "error" ? ERROR_TOAST_MS : TOAST_MS, pausable: true });
  }, [push]);

  // run a toast's action once, then take the toast (and its ⌘Z entry) away
  const runById = useCallback((id: number, run: () => void) => {
    if (!entries.current.has(id)) return;
    try { run(); } finally { close(id, "action"); }
  }, [close]);
  const runActionRef = useRef(runById);
  runActionRef.current = runById;
  const runAction = useCallback((it: ToastItem) => { if (it.action) runById(it.id, it.action.run); }, [runById]);

  // an Undo is on the ⌘Z stack from the moment it's made until its toast goes
  // (waiting included, so undoLast() always takes back the newest change first;
  // the toast's own lifecycle takes it off, hence no stack timeout of its own)
  const registerUndo = (id: number, message: string, label: string, run: () => void) =>
    isUndo(label) ? pushUndo(message, () => runActionRef.current(id, run), Infinity) : undefined;

  const action = useCallback((message: string, label: string, run: () => void, opts?: number | ToastActionOptions) => {
    if (typeof opts === "object" && opts !== null) {
      const entry = { remaining: Math.max(ACTION_TOAST_MIN_MS, opts.ms ?? 0), pausable: true, onExpire: opts.onExpire, key: opts.key };
      // (looked up in the clocks, not the rendered list, so two calls in one tick still merge)
      const prev = opts.key ? [...entries.current].find(([, e]) => e.key === opts.key) : undefined;
      if (prev) {
        const [id, old] = prev;
        if (old.timer) clearTimeout(old.timer);
        old.unregister?.();
        // re-registered, so it's the newest Undo for ⌘Z, though it keeps its slot (or its place in the queue)
        const item: ToastItem = { ...old.item, message, action: { label, run } };
        entries.current.set(id, { ...old, ...entry, item, startedAt: Date.now(), timer: null, unregister: registerUndo(id, message, label, run) });
        if (old.shown) setItems((xs) => xs.map((x) => (x.id === id ? item : x)));
        if (old.onExpire) { try { old.onExpire(); } catch (err) { console.error(err); } }
        start(id);
        return;
      }
      const id = ++_id;
      push({ id, message, type: "info", action: { label, run } }, { ...entry, unregister: registerUndo(id, message, label, run) });
    } else {
      const id = ++_id;
      push({ id, message, type: "info", action: { label, run } },
        { remaining: typeof opts === "number" ? opts : LEGACY_ACTION_MS, pausable: false, unregister: registerUndo(id, message, label, run) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push, start]);

  // pause while the tab is in the background
  useEffect(() => {
    const onVis = () => { hidden.current = document.visibilityState === "hidden"; syncPaused(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [syncPaused]);

  // a toast removed from under the pointer / focus never fires leave/blur —
  // re-read the real state whenever the stack changes
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    let hovered = false;
    try { hovered = el.matches(":hover"); } catch { /* selector unsupported */ }
    hover.current = hovered;
    focusWithin.current = el.contains(document.activeElement);
    syncPaused();
  }, [items, syncPaused]);

  // commit pending managed toasts now; Undo is no longer offered for them
  const flush = useCallback(() => {
    [...entries.current.entries()].forEach(([id, e]) => { if (e.onExpire) close(id, "expire"); });
  }, [close]);

  // closing or reloading the tab inside the Undo window still commits what the
  // user did (best effort: the request starts as the page goes away)
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [flush]);

  // on unmount: stop the clocks and honour pending commits (the user never undid them).
  // On (re)mount, drop any toast whose clock a previous unmount cleared —
  // StrictMode's dev-only remount would otherwise leave it on screen for ever
  // with an Undo that no longer works.
  useEffect(() => {
    const map = entries.current;
    setItems((xs) => xs.every((x) => map.has(x.id)) ? xs : xs.filter((x) => map.has(x.id)));
    return () => {
      const pending = [...map.values()];
      map.forEach((e) => { if (e.timer) clearTimeout(e.timer); e.unregister?.(); });
      map.clear();
      pending.forEach((e) => { try { e.onExpire?.(); } catch (err) { console.error(err); } });
    };
  }, []);

  const error = useCallback((m: string) => toast(m, "error"), [toast]);
  const success = useCallback((m: string) => toast(m, "success"), [toast]);
  const api = useMemo<ToastApi>(() => ({ toast, error, success, action, flush }), [toast, error, success, action, flush]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div ref={stackRef} role="status" aria-live="polite" className="ktoasts"
        onMouseEnter={() => { hover.current = true; syncPaused(); }}
        onMouseLeave={() => { hover.current = false; syncPaused(); }}
        onFocus={() => { focusWithin.current = true; syncPaused(); }}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { focusWithin.current = false; syncPaused(); } }}>
        {items.map((it) => {
          const undo = !!it.action && isUndo(it.action.label);
          return (
            <div key={it.id} className="ktoast" data-type={it.type}>
              {it.type === "error" && <span className="ktoast-icon">{alertIcon}</span>}
              {it.type === "success" && <span className="ktoast-icon"><Icon name="check" size={16} sw={2} /></span>}
              <p className="ktoast-msg">
                {it.message}
                {undo && <span className="sr-only">. Press {isMac ? "Command" : "Control"} Z to undo.</span>}
              </p>
              <span className="ktoast-acts">
                {it.action && (
                  <Button variant="ghost" size="sm" onClick={() => runAction(it)} kbd={undo ? UNDO_KEYS : undefined}
                    aria-keyshortcuts={undo ? (isMac ? "Meta+Z" : "Control+Z") : undefined}>{it.action.label}</Button>
                )}
                <button type="button" className="kibtn" data-size="sm" onClick={() => close(it.id, "dismiss")}
                  aria-label={`Dismiss: ${it.message}`} data-tip="Dismiss">
                  <Icon name="x" size={14} sw={1.75} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
