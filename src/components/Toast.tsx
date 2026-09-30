/* ============================================================
   KANBO — toast notifications (replaces alert())
   Timers pause while the stack is hovered, holds keyboard focus, or the tab
   is hidden, so nobody loses an Undo while reaching for it (WCAG 2.2.1).
   The most recent Undo can also be run from anywhere with ⌘Z / Ctrl+Z.
   ============================================================ */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
 * `ms` (default 6s) with no pausing, because they may be committing on their
 * own timer of the same length — keeping the toast up longer would offer an
 * Undo that no longer works.
 */
export interface ToastActionOptions {
  ms?: number;
  onExpire?: () => void;
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
const LEGACY_ACTION_MS = 6000;

const ToastContext = createContext<ToastApi | null>(null);

let _id = 0;

interface Entry {
  remaining: number;           // ms left on the clock
  startedAt: number;           // when the current run of the clock started
  timer: ReturnType<typeof setTimeout> | null;
  pausable: boolean;           // legacy action toasts keep a fixed lifetime
  onExpire?: () => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
const UNDO_KEYS = isMac ? "⌘Z" : "Ctrl+Z";
const isUndo = (label: string) => /^undo$/i.test(label.trim());

const isEditable = (el: EventTarget | null): boolean => {
  const n = el as HTMLElement | null;
  if (!n || typeof n.closest !== "function") return false;
  return !!n.isContentEditable || !!n.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const itemsRef = useRef<ToastItem[]>([]);
  itemsRef.current = items;
  const entries = useRef<Map<number, Entry>>(new Map());
  const stackRef = useRef<HTMLDivElement>(null);
  // why the clocks are paused — any one of these holds them
  const hover = useRef(false);
  const focusWithin = useRef(false);
  const hidden = useRef(typeof document !== "undefined" && document.visibilityState === "hidden");
  const paused = useRef(false);

  const close = useCallback((id: number, reason: "expire" | "dismiss" | "action") => {
    // always take it off screen, even without a clock (e.g. a toast whose entry
    // a StrictMode remount cleared) — × must never leave a toast stuck
    setItems((xs) => xs.some((x) => x.id === id) ? xs.filter((x) => x.id !== id) : xs);
    const e = entries.current.get(id);
    if (!e) return; // already gone — never run onExpire twice
    if (e.timer) clearTimeout(e.timer);
    entries.current.delete(id);
    if (reason !== "action" && e.onExpire) {
      try { e.onExpire(); } catch (err) { console.error(err); }
    }
  }, []);

  const start = useCallback((id: number) => {
    const e = entries.current.get(id);
    if (!e || e.timer) return;
    e.startedAt = Date.now();
    e.timer = setTimeout(() => close(id, "expire"), Math.max(0, e.remaining));
  }, [close]);

  const syncPaused = useCallback(() => {
    const next = hover.current || focusWithin.current || hidden.current;
    if (next === paused.current) return;
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
  }, [start]);

  const push = useCallback((item: ToastItem, entry: Omit<Entry, "startedAt" | "timer">) => {
    entries.current.set(item.id, { ...entry, startedAt: Date.now(), timer: null });
    setItems((xs) => [...xs, item]);
    // a pausable toast that arrives while the stack is held waits its turn
    if (!(entry.pausable && paused.current)) start(item.id);
  }, [start]);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    push({ id: ++_id, message, type }, { remaining: type === "error" ? 7000 : 4000, pausable: true });
  }, [push]);

  const action = useCallback((message: string, label: string, run: () => void, opts?: number | ToastActionOptions) => {
    const item: ToastItem = { id: ++_id, message, type: "info", action: { label, run } };
    if (typeof opts === "object" && opts !== null) {
      push(item, { remaining: Math.max(ACTION_TOAST_MIN_MS, opts.ms ?? 0), pausable: true, onExpire: opts.onExpire });
    } else {
      push(item, { remaining: typeof opts === "number" ? opts : LEGACY_ACTION_MS, pausable: false });
    }
  }, [push]);

  const runAction = useCallback((it: ToastItem) => {
    if (!it.action || !entries.current.has(it.id)) return;
    try { it.action.run(); } finally { close(it.id, "action"); }
  }, [close]);

  // pause while the tab is in the background
  useEffect(() => {
    const onVis = () => { hidden.current = document.visibilityState === "hidden"; syncPaused(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [syncPaused]);

  // ⌘Z / Ctrl+Z runs the newest Undo from anywhere (text fields keep their own undo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      if (isEditable(e.target) || isEditable(document.activeElement)) return;
      const latest = [...itemsRef.current].reverse().find((x) => x.action && isUndo(x.action.label));
      if (!latest) return;
      e.preventDefault();
      runAction(latest);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runAction]);

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
      map.forEach((e) => { if (e.timer) clearTimeout(e.timer); });
      map.clear();
      pending.forEach((e) => { try { e.onExpire?.(); } catch (err) { console.error(err); } });
    };
  }, []);

  const error = useCallback((m: string) => toast(m, "error"), [toast]);
  const success = useCallback((m: string) => toast(m, "success"), [toast]);
  const api = useMemo<ToastApi>(() => ({ toast, error, success, action, flush }), [toast, error, success, action, flush]);

  const color = (t: ToastType) => t === "error" ? "var(--st-blocked)" : t === "success" ? "var(--st-done)" : "var(--accent)";

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div ref={stackRef} role="status" aria-live="polite"
        onMouseEnter={() => { hover.current = true; syncPaused(); }}
        onMouseLeave={() => { hover.current = false; syncPaused(); }}
        onFocus={() => { focusWithin.current = true; syncPaused(); }}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { focusWithin.current = false; syncPaused(); } }}
        style={{ position: "fixed", bottom: 20, right: 20, zIndex: 300, display: "flex", flexDirection: "column", gap: 10, maxWidth: "calc(100vw - 40px)", pointerEvents: "none" }}>
        {items.map((it) => {
          const undo = !!it.action && isUndo(it.action.label);
          return (
            <div key={it.id} className="glass anim-fadeup" style={{ pointerEvents: "auto", display: "flex", alignItems: "flex-start", gap: 11, padding: "12px 14px", borderRadius: 13, width: 340, maxWidth: "100%", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", borderLeft: `3px solid ${color(it.type)}` }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 99, marginTop: 5, flexShrink: 0, background: color(it.type) }} />
              <p style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 13.5, lineHeight: 1.45, color: "var(--ink-2)", overflowWrap: "anywhere" }}>
                {it.message}
                {undo && <span className="sr-only">. Press {isMac ? "Command" : "Control"} Z to undo.</span>}
              </p>
              {it.action && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
                  <button onClick={() => runAction(it)} aria-keyshortcuts={undo ? (isMac ? "Meta+Z" : "Control+Z") : undefined}
                    style={{ border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", padding: "0 2px", fontSize: 13, fontWeight: 650, fontFamily: "var(--font-display)", lineHeight: 1.45 }}>{it.action.label}</button>
                  {undo && <kbd aria-hidden="true" className="mono hide-sm" style={{ fontSize: 10.5, padding: "1px 5px", borderRadius: 5, background: "var(--fill-1, color-mix(in oklch, var(--ink) 6%, transparent))", border: "1px solid var(--hairline)", color: "var(--ink-4)", lineHeight: 1.5 }}>{UNDO_KEYS}</kbd>}
                </span>
              )}
              <button onClick={() => close(it.id, "dismiss")} aria-label={`Dismiss: ${it.message}`} title="Dismiss" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", padding: 0, fontSize: 16, lineHeight: 1, flexShrink: 0 }}>×</button>
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
