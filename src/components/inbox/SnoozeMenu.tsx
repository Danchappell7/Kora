/* ============================================================
   KANBO — the Inbox's snooze menu (0048).   [u4]
   1 hour · Tomorrow 09:00 · Next week · Pick a date and time…, in the
   person's timezone (lib/notifyPrefs snoozeChoices). Portalled to <body>
   with fixed positioning so no card, scroll container or sticky ancestor
   can clip it; opens upward when the trigger sits near the bottom.
   Menu-button keyboard model: focus lands on the first option, arrows
   move, Escape / Tab close and return focus to the trigger. "Pick a date
   and time…" turns the menu into a small dialog (date and time fields,
   Back / Snooze; Tab stays inside it; Enter snoozes; Escape closes).
   ============================================================ */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Icon } from "../primitives";
import { addDays } from "../../../supabase/functions/_shared/notifyTiming.ts";
import { customSnoozeUntil, localParts, snoozeChoices } from "../../lib/notifyPrefs";

export interface SnoozeMenuProps {
  anchor: HTMLElement;
  itemTitle: string;
  /** a whole thread (a task's updates) or one item */
  thread?: boolean;
  /** the timezone the choices are worked out in (default: this device's) */
  timeZone: string;
  onPick: (until: number) => void;
  onClose: (refocus: boolean) => void;
}

const FOCUSABLE = 'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SnoozeMenu({ anchor, itemTitle, thread, timeZone, onPick, onClose }: SnoozeMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const [mode, setMode] = useState<"menu" | "custom">("menu");
  const options = useMemo(() => snoozeChoices(new Date(), timeZone), [timeZone]);
  const today = useMemo(() => localParts(new Date(), timeZone).date, [timeZone]);
  const [date, setDate] = useState(() => addDays(today, 1));
  const [time, setTime] = useState("09:00");
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const errId = `ksnz-err-${uid}`;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const mh = el.offsetHeight, mw = el.offsetWidth, gap = 6, edge = 8;
    const vh = window.innerHeight, vw = window.innerWidth;
    const below = vh - r.bottom;
    const up = below < mh + gap + edge && r.top > below;
    const top = up ? Math.max(edge, r.top - gap - mh) : Math.max(edge, Math.min(vh - edge - mh, r.bottom + gap));
    const left = Math.max(edge, Math.min(vw - edge - mw, r.right - mw));
    setPos({ top, left, up });
  }, [anchor, mode]);

  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    if (mode === "custom") dateRef.current?.focus({ preventScroll: true });
    else ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [placed, mode]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (ref.current?.contains(t) || anchor.contains(t))) return;
      closeRef.current(false);
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      closeRef.current(false);
    };
    const onResize = () => closeRef.current(false);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor]);

  const submitCustom = () => {
    const r = customSnoozeUntil(date, time, timeZone);
    if (!r.ok) { setError(r.error); return; }
    onPick(r.until.getTime());
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeRef.current(true); return; }
    if (mode === "custom") {
      if (e.key === "Tab") {
        // a small dialog: Tab goes round its own fields and buttons
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i >= items.length - 1 ? 0 : i + 1);
        e.preventDefault();
        items[next]?.focus();
      } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
        e.preventDefault();
        submitCustom();
      }
      return;
    }
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === "Tab") { e.preventDefault(); e.stopPropagation(); closeRef.current(true); }
    else if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };

  const label = `Snooze “${itemTitle}” until`;
  return createPortal(
    <div ref={ref} role={mode === "menu" ? "menu" : "dialog"} aria-label={label} onKeyDown={onKeyDown}
      className="kinbox-menu" data-up={pos?.up || undefined} data-mode={mode}
      style={{
        position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, zIndex: 1100,
        visibility: placed ? "visible" : "hidden", transformOrigin: pos?.up ? "100% 100%" : "100% 0",
      }}>
      {mode === "menu" ? (
        <>
          <div className="kinbox-menu-label" aria-hidden="true">{thread ? "Snooze this thread until" : "Snooze until"}</div>
          {options.map((o) => (
            <button key={o.id} type="button" role="menuitem" tabIndex={-1} className="kinbox-mi" onClick={() => onPick(o.until.getTime())}>
              <span>{o.label}</span>
              <span className="kinbox-mi-hint">{o.hint}</span>
            </button>
          ))}
          <div className="kinbox-msep" role="separator" />
          <button type="button" role="menuitem" tabIndex={-1} className="kinbox-mi" aria-haspopup="dialog" onClick={() => setMode("custom")}>
            <Icon name="calendar" size={16} sw={1.75} />
            <span>Pick a date and time…</span>
          </button>
        </>
      ) : (
        <form className="kinbox-custom" onSubmit={(e) => { e.preventDefault(); submitCustom(); }} noValidate>
          <div className="kinbox-menu-label" id={`ksnz-h-${uid}`}>{thread ? "Snooze this thread until" : "Snooze until"}</div>
          <div className="kinbox-custom-fields">
            <label className="kinbox-field">
              <span>Date</span>
              <input ref={dateRef} type="date" value={date} min={today} max={addDays(today, 365)} required
                aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined}
                onChange={(e) => { setDate(e.target.value); setError(null); }} />
            </label>
            <label className="kinbox-field">
              <span>Time</span>
              <input type="time" value={time} step={900} required
                aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined}
                onChange={(e) => { setTime(e.target.value); setError(null); }} />
            </label>
          </div>
          {error && <p id={errId} className="kinbox-custom-err" role="alert">{error}</p>}
          <div className="kinbox-custom-foot">
            <Button type="button" variant="ghost" size="sm" icon="chevronLeft" onClick={() => { setError(null); setMode("menu"); }}>Back</Button>
            <Button type="submit" variant="primary" size="sm" icon="clock">Snooze</Button>
          </div>
        </form>
      )}
    </div>,
    document.body,
  );
}
