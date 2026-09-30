/* ============================================================
   KANBO — the "Paper & Navy" primitive kit.
   Button · IconButton · Kbd · Tabs · Meter · StatusGlyph ·
   PriorityGlyph · DateChip (+ DatePicker) · AiMark · Provenance ·
   Vellum · EmptyState · Sheet · Pill · ProjectDot / projectPaint ·
   SectionLabel · Toggle.
   Styling lives in kanbo.css ("Component classes"), keyed on classes
   and data attributes, so plain markup can wear the same look.
   Import from "components/primitives" (index.tsx re-exports all of it).
   ============================================================ */
import {
  forwardRef, useEffect, useId, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { Popover } from "./Popover";
import { EmptyArt, type EmptyArtKind } from "./EmptyArt";
import { KanboGlyph } from "./KanboLogo";
import { markJustCompleted, wasJustCompleted } from "./celebrate";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { toOklch } from "../../lib/contrast";
import { KANBO_TODAY, PRIORITY_META, STATUS_META, presetDate, toLocalISO } from "../../data/data";
import type { IconName, Priority, Status } from "../../data/types";

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");
/** useId() output made safe for id / url(#…) references */
const useDomId = (prefix: string) => prefix + useId().replace(/[^a-zA-Z0-9_-]/g, "");
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* ============================== Button ============================== */

/** Control heights: sm 28 · md 32 · lg 40. */
export type CtlSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = accent fill · hero = the one gradient action per screen ·
   *  secondary (default) = raised + hairline · ghost = bare · danger = destructive fill */
  variant?: "primary" | "hero" | "secondary" | "ghost" | "danger";
  size?: CtlSize;
  icon?: IconName;
  iconRight?: IconName;
  /** trailing shortcut hint, e.g. "⌘↵" (visual only) */
  kbd?: string;
  /** swaps the icon for a spinner (hero: the thinking Kanbo mark), sets aria-busy, ignores clicks */
  loading?: boolean;
  /** stretch to the container's width */
  full?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconRight, kbd, loading = false, full = false, type = "button", className, children, onClick, ...rest },
  ref,
) {
  const iconSize = size === "sm" ? 14 : 16;
  const lead = loading
    ? (variant === "hero" ? <KanboGlyph size={iconSize} thinking /> : <span className="kspin" aria-hidden="true" />)
    : icon ? <Icon name={icon} size={iconSize} sw={1.75} /> : null;
  return (
    <button ref={ref} type={type} {...rest}
      className={cx("kbtn", className)} data-variant={variant} data-size={size}
      data-full={full || undefined} aria-busy={loading || undefined}
      onClick={(e) => { if (loading) { e.preventDefault(); return; } onClick?.(e); }}>
      {lead}
      {children != null && children !== false && <span className="kbtn-label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={iconSize} sw={1.75} />}
      {kbd && <kbd className="kkbd" aria-hidden="true">{kbd}</kbd>}
    </button>
  );
});

/* ============================== IconButton ============================== */

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /** accessible name AND tooltip */
  label: string;
  size?: CtlSize;
  variant?: "ghost" | "secondary";
  /** danger: hovers in the signal colour (delete, remove) */
  tone?: "default" | "danger";
  /** a count (shown up to 99+) or an unread dot */
  badge?: number | boolean;
  /** a toggle: exposes aria-pressed and turns the icon accent while on */
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = "md", variant = "ghost", tone = "default", badge, pressed, type = "button", className, ...rest },
  ref,
) {
  const count = typeof badge === "number" && badge > 0 ? badge : 0;
  const dot = badge === true;
  return (
    <button ref={ref} type={type} {...rest}
      className={cx("kibtn", className)} data-size={size} data-variant={variant}
      data-tone={tone === "danger" ? "danger" : undefined}
      aria-label={count ? `${label}, ${count}` : label} data-tip={label} aria-pressed={pressed}>
      <Icon name={icon} size={16} sw={1.75} />
      {(count > 0 || dot) && (
        <span className="kibtn-badge" data-dot={dot || undefined} aria-hidden="true">{count > 99 ? "99+" : count || null}</span>
      )}
    </button>
  );
});

/* ============================== Kbd ============================== */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kkbd">{children}</kbd>;
}

/* ============================== Tabs ============================== */

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  icon?: IconName;
  /** signal: the count reads in the signal colour (overdue, at risk) */
  tone?: "signal";
  /** nav mode: the tab is a real link (modified clicks open it normally) */
  href?: string;
  disabled?: boolean;
  /** secondary tabs sit after a divider (Projects: All · Portfolios · Goals | Rules · Requests) */
  secondary?: boolean;
}

/** A 44px tab row (36px when size="sm"). mode="tabs" is a tablist (arrows move
 *  AND select); mode="nav" is a <nav> of links with aria-current="page" (arrows
 *  move focus; Enter follows). `trailing` sits at the right-hand end. */
export function Tabs({ items, value, onChange, label, mode = "tabs", trailing, size = "md" }: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  mode?: "tabs" | "nav";
  trailing?: ReactNode;
  size?: "md" | "sm";
}) {
  const uid = useDomId("kt");
  const listRef = useRef<HTMLDivElement>(null);
  const firstEnabled = items.find((t) => !t.disabled);
  const hasActive = items.some((t) => t.id === value && !t.disabled);

  // keep the active tab in view when the row scrolls sideways (phones)
  const reveal = (el: HTMLElement) => {
    const list = listRef.current;
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const pad = 32; // clear of the edge fade
    if (el.offsetLeft < list.scrollLeft + pad) list.scrollLeft = Math.max(0, el.offsetLeft - pad);
    else if (el.offsetLeft + el.offsetWidth > list.scrollLeft + list.clientWidth - pad) list.scrollLeft = el.offsetLeft + el.offsetWidth - list.clientWidth + pad;
  };
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (el) reveal(el);
  }, [value]);

  // fade whichever edge has more tabs beyond it (only while the row actually scrolls)
  const [fade, setFade] = useState<"start" | "end" | "both" | undefined>();
  const syncFade = () => {
    const list = listRef.current;
    if (!list) return;
    const more = list.scrollWidth - list.clientWidth;
    const start = more > 1 && list.scrollLeft > 1, end = more > 1 && list.scrollLeft < more - 1;
    setFade(start && end ? "both" : start ? "start" : end ? "end" : undefined);
  };
  const syncRef = useRef(syncFade);
  syncRef.current = syncFade;
  useEffect(() => { syncRef.current(); }); // labels and counts change the row's width
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const sync = () => syncRef.current();
    list.addEventListener("scroll", sync, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    ro?.observe(list);
    return () => { list.removeEventListener("scroll", sync); ro?.disconnect(); };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]:not([aria-disabled="true"])') ?? []);
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const n = e.key === "Home" ? 0 : e.key === "End" ? els.length - 1
      : e.key === "ArrowRight" ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
    e.preventDefault();
    const el = els[n];
    el.focus();
    reveal(el);
    if (mode === "tabs" && el.dataset.tabId && el.dataset.tabId !== value) onChange(el.dataset.tabId);
  };

  const body = (t: TabItem) => (
    <>
      {t.icon && <Icon name={t.icon} size={16} sw={1.75} />}
      {/* data-label reserves the bold width, so selecting a tab never nudges its neighbours */}
      <span className="ktab-label" data-label={t.label}>{t.label}</span>
      {t.count != null && <span className="ktab-count" data-tone={t.tone}>{t.count}</span>}
    </>
  );

  const tabs = items.flatMap((t, i) => {
    const active = t.id === value;
    const sep = t.secondary && i > 0 && !items[i - 1].secondary
      ? <span key={`${t.id}-sep`} className="ktabs-sep" aria-hidden="true" /> : null;
    const common = {
      className: "ktab",
      "data-tab-id": t.id,
      "data-active": active || undefined,
      "aria-disabled": t.disabled || undefined,
    };
    let el: ReactNode;
    if (mode === "tabs") {
      el = (
        <button key={t.id} type="button" role="tab" id={`${uid}-${i}`} {...common}
          aria-selected={active} tabIndex={(hasActive ? active : t === firstEnabled) ? 0 : -1}
          onClick={() => { if (!t.disabled && !active) onChange(t.id); }}>
          {body(t)}
        </button>
      );
    } else if (t.href) {
      el = (
        <a key={t.id} href={t.href} {...common} aria-current={active ? "page" : undefined} tabIndex={t.disabled ? -1 : undefined}
          onClick={(e) => {
            if (t.disabled) { e.preventDefault(); return; }
            // a modified or middle click opens the link in a new tab, as a link should
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            if (!active) onChange(t.id);
          }}>
          {body(t)}
        </a>
      );
    } else {
      el = (
        <button key={t.id} type="button" {...common} aria-current={active ? "page" : undefined}
          onClick={() => { if (!t.disabled && !active) onChange(t.id); }}>
          {body(t)}
        </button>
      );
    }
    return sep ? [sep, el] : el;
  });

  const list = mode === "tabs"
    ? <div ref={listRef} role="tablist" aria-label={label} className="ktabs-list" data-fade={fade} onKeyDown={onKeyDown}>{tabs}</div>
    : <div ref={listRef} className="ktabs-list" data-fade={fade} onKeyDown={onKeyDown}>{tabs}</div>;
  const end = trailing ? <div className="ktabs-trailing">{trailing}</div> : null;
  return mode === "nav"
    ? <nav aria-label={label} className="ktabs" data-size={size}>{list}{end}</nav>
    : <div className="ktabs" data-size={size}>{list}{end}</div>;
}

/* ============================== Meter ============================== */

/** A progress bar: 2, 4 or 6px, filled by tone (grad = momentum, the default).
 *  `marker` draws a capacity tick at that value. */
export function Meter({ value, max = 100, tone = "grad", width, height = 4, label, showValue, marker }: {
  value: number;
  max?: number;
  tone?: "grad" | "accent" | "ink" | "ok" | "warn" | "signal";
  width?: number | string;
  height?: 2 | 4 | 6;
  label: string;
  showValue?: boolean;
  marker?: number;
}) {
  const top = max > 0 ? max : 100;
  const v = Math.min(top, Math.max(0, Number.isFinite(value) ? value : 0));
  const pct = (v / top) * 100;
  const tick = marker == null || !Number.isFinite(marker) ? null : Math.min(100, Math.max(0, (marker / top) * 100));
  return (
    <span className="kmeter-wrap" style={width != null ? { width, flex: "none" } : undefined}>
      <span className="kmeter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={top} aria-valuenow={v}
        style={{ height }}>
        <span className="kmeter-fill" data-tone={tone} style={{ width: `${pct}%` }} />
        {tick != null && <span className="kmeter-marker" style={{ left: `${tick}%` }} />}
      </span>
      {showValue && <span className="kmeter-value" aria-hidden="true">{Math.round(pct)}%</span>}
    </span>
  );
}

/* ============================== StatusGlyph ============================== */

const STATUS_FILL: Record<Status, string> = {
  todo: "var(--st-todo-fill, var(--st-todo))",
  progress: "var(--st-progress-fill, var(--st-progress))",
  review: "var(--st-review-fill, var(--st-review))",
  blocked: "var(--st-blocked-fill, var(--st-blocked))",
  done: "var(--st-done-fill, var(--st-done))",
};

/** Shape first, colour second: ring · ring + right half · ring + three-quarters ·
 *  disc with a bar knocked out · disc with a tick knocked out. The knock-outs
 *  are real holes (a mask), so they show the row, card or selection behind. */
function GlyphArt({ status, size, maskId, pop }: { status: Status; size: number; maskId: string; pop: boolean }) {
  const c = STATUS_FILL[status];
  const solid = status === "blocked" || status === "done";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false"
      className={cx("kglyph-art", pop && "kglyph-pop")}>
      {!solid && <circle cx={8} cy={8} r={6.25} fill="none" stroke={c} strokeWidth={1.5} />}
      {status === "progress" && <path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill={c} />}
      {status === "review" && <path d="M8 4.25A3.75 3.75 0 1 1 4.25 8H8z" fill={c} />}
      {solid && (
        <>
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={16} height={16}>
              <rect width={16} height={16} fill="#fff" />
              {status === "blocked"
                ? <rect x={4.5} y={7.1} width={7} height={1.8} rx={0.9} fill="#000" />
                : <path d="M5.1 8.25l2 2 3.8-4.1" pathLength={1} fill="none" stroke="#000" strokeWidth={1.75}
                    strokeLinecap="round" strokeLinejoin="round" className={pop ? "kglyph-draw" : undefined} />}
            </mask>
          </defs>
          <circle cx={8} cy={8} r={7} fill={c} mask={`url(#${maskId})`} />
        </>
      )}
    </svg>
  );
}

/** The status glyph IS the completion checkbox (one completion signal). With
 *  `onToggle` it's `role="checkbox"` named "Done: {label}" — the same contract
 *  as Check. Shift-click or right-click calls `onPick(anchor)` for the status
 *  menu. Without `onToggle` (or `readOnly`) it's a labelled image. */
export function StatusGlyph({ status, size = 16, label, onToggle, onPick, celebrateKey, readOnly }: {
  status: Status;
  size?: 14 | 16 | 20;
  label?: string;
  onToggle?: () => void;
  onPick?: (anchor: HTMLElement) => void;
  celebrateKey?: string;
  readOnly?: boolean;
}) {
  const maskId = useDomId("kg");
  const done = status === "done";
  const [pop, setPop] = useState(() => done && wasJustCompleted(celebrateKey));
  // a completing click only ARMS the pop; it plays when the status actually
  // becomes done (a "complete it anyway?" confirm that's cancelled plays nothing)
  const armedAt = useRef(0);
  useEffect(() => {
    if (!pop) return;
    try { navigator.vibrate?.(10); } catch { /* unsupported (iOS) */ }
    const t = window.setTimeout(() => setPop(false), 400);
    return () => window.clearTimeout(t);
  }, [pop]);
  useEffect(() => {
    if (done && armedAt.current && Date.now() - armedAt.current < 1500) setPop(true);
    armedAt.current = 0;
  }, [done]);

  const meta = STATUS_META[status];
  const style = { "--g": `${size}px` } as CSSProperties;
  const art = <GlyphArt status={status} size={size} maskId={maskId} pop={pop} />;
  if (readOnly || !onToggle) {
    return (
      <span className="kglyph" data-static="true" data-status={status} role="img" style={style}
        aria-label={label ? `${meta.label}: ${label}` : meta.label} title={meta.label}>
        {art}
      </span>
    );
  }
  return (
    <button type="button" role="checkbox" aria-checked={done} aria-label={label ? `Done: ${label}` : "Done"}
      title={meta.label} className="kglyph" data-status={status} style={style}
      onClick={(e) => {
        e.stopPropagation(); // rows open their task on click
        if (e.shiftKey && onPick) { onPick(e.currentTarget); return; }
        const wasDone = done;
        onToggle();
        if (!wasDone) { armedAt.current = Date.now(); markJustCompleted(celebrateKey); }
      }}
      onContextMenu={onPick ? (e) => { e.preventDefault(); e.stopPropagation(); onPick(e.currentTarget); } : undefined}>
      {art}
    </button>
  );
}

/* ============================== PriorityGlyph ============================== */

const PRIORITY_BARS = [{ x: 0.75, h: 4 }, { x: 4.75, h: 7 }, { x: 8.75, h: 10 }];

/** Three ascending ink bars (low 1 · medium 2 · high 3); Urgent is a signal
 *  square with a knocked-out "!". Named by `title`, like PriorityFlag. */
export function PriorityGlyph({ priority, size = 12, withLabel }: { priority: Priority; size?: 12 | 14 | 16; withLabel?: boolean }) {
  const maskId = useDomId("kp");
  const meta = PRIORITY_META[priority];
  const level = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <span className="kprio" data-priority={priority} title={`${meta.label} priority`}>
      {priority === "urgent" ? (
        // 2px larger than the bars' box (and pulled back by a 1px margin), so it
        // reads as the loud one without shifting the row
        <svg width={size + 2} height={size + 2} viewBox="0 0 14 14" aria-hidden="true" focusable="false" style={{ margin: -1 }}>
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={14} height={14}>
              <rect width={14} height={14} fill="#fff" />
              <rect x={6.15} y={2.9} width={1.7} height={5.5} rx={0.85} fill="#000" />
              <circle cx={7} cy={10.5} r={1.05} fill="#000" />
            </mask>
          </defs>
          <rect width={14} height={14} rx={3.5} fill="var(--signal, var(--prio-urgent))" mask={`url(#${maskId})`} />
        </svg>
      ) : (
        <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          {PRIORITY_BARS.map((b, i) => (
            <rect key={i} x={b.x} y={11 - b.h} width={2.5} height={b.h} rx={0.75}
              fill={i < level ? "var(--ink-2)" : "var(--icon-quiet, var(--ink-4))"} opacity={i < level ? 1 : 0.5} />
          ))}
        </svg>
      )}
      {withLabel && <span className="kprio-label">{meta.label}</span>}
    </span>
  );
}

/* ============================== dates (DateChip) ============================== */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTH_WORDS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const localDay = (iso: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
};
const todayLocal = (): Date => { const d = new Date(KANBO_TODAY); d.setHours(0, 0, 0, 0); return d; };
const shiftDays = (d: Date, n: number): Date => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000);
/** same day-of-month n months on, clamped to the month's end (31 Jan + 1 → 28/29 Feb) */
const shiftMonths = (d: Date, n: number): Date => {
  const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
  x.setDate(Math.min(d.getDate(), new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
  return x;
};
const validDay = (y: number, m: number, d: number): Date | null => {
  const x = new Date(y, m, d);
  return x.getFullYear() === y && x.getMonth() === m && x.getDate() === d ? x : null;
};
const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** "Wed 30 Sep" (plus the year when it isn't this year) */
function fmtDay(d: Date): string {
  const s = `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  return d.getFullYear() === todayLocal().getFullYear() ? s : `${s} ${d.getFullYear()}`;
}
/** "Friday 2 October 2026" — a day's accessible name */
const fmtFull = (d: Date) => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** The chip's words: Today / Tomorrow / Yesterday, else "Fri 2 Oct"; a time follows ("Today 15:00"). */
function chipText(iso: string, time?: string): string {
  const d = localDay(iso);
  if (!d) return iso;
  const n = daysBetween(todayLocal(), d);
  const day = n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : fmtDay(d);
  return time ? `${day} ${time}` : day;
}

type DateTone = "plain" | "overdue" | "now";
function dueTone(iso: string, time: string | undefined, status?: Status): DateTone {
  if (status === "done") return "plain";
  const d = localDay(iso);
  if (!d) return "plain";
  const n = daysBetween(todayLocal(), d);
  return n < 0 ? "overdue" : n === 0 && time ? "now" : "plain";
}

const cutMatch = (s: string, m: RegExpMatchArray) =>
  (s.slice(0, m.index) + " " + s.slice((m.index ?? 0) + m[0].length)).replace(/\s+/g, " ").trim();

/** Pull a time out of lower-cased text: "3pm", "3:30pm", "15:00", "9.30", "at 15", "noon". */
function takeTime(s: string): { time?: string; rest: string } {
  let m = s.match(/(^|\s)(?:at\s+)?(noon|midday)(?=\s|$)/);
  if (m) return { time: "12:00", rest: cutMatch(s, m) };
  m = s.match(/(^|\s)(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)(?=\s|$)/);
  if (m) {
    let h = +m[2];
    const min = m[3] ? +m[3] : 0;
    if (h >= 1 && h <= 12 && min < 60) {
      if (m[4] === "pm" && h < 12) h += 12;
      if (m[4] === "am" && h === 12) h = 0;
      return { time: hhmm(h, min), rest: cutMatch(s, m) };
    }
  }
  m = s.match(/(^|\s)(?:at\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s|$)/);
  if (m) return { time: hhmm(+m[2], +m[3]), rest: cutMatch(s, m) };
  m = s.match(/(^|\s)at\s+([01]?\d|2[0-3])(?=\s|$)/);
  if (m) return { time: hhmm(+m[2], 0), rest: cutMatch(s, m) };
  return { rest: s };
}

/** A day from words: today · tomorrow · fri / next fri · this weekend · next week ·
 *  in 2 weeks / 3d · 3 Oct / 3rd of October 2026 / Oct 3 · 3/10 (UK order) · 2026-10-03.
 *  A year-less date more than a month back means next year's. */
function takeDay(raw: string, today: Date): Date | null {
  const s = raw.replace(/^(on|due|by)\s+/, "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^(today|tod|tonight|now)$/.test(s)) return today;
  if (/^(tomorrow|tmrw?|tom|tmw)$/.test(s)) return shiftDays(today, 1);
  if (s === "yesterday") return shiftDays(today, -1);
  if (/^(this\s+)?weekend$/.test(s)) return localDay(presetDate("weekend"));
  if (s === "next week") return localDay(presetDate("nextweek"));
  if (s === "next month") return shiftMonths(today, 1);
  let m = s.match(/^(?:in\s+)?(a|an|one|\d{1,3})\s*(days?|d|weeks?|wks?|w|months?|mo)$/);
  if (m) {
    const n = /^\d/.test(m[1]) ? +m[1] : 1;
    const unit = m[2][0];
    return unit === "d" ? shiftDays(today, n) : unit === "w" ? shiftDays(today, 7 * n) : shiftMonths(today, n);
  }
  m = s.match(/^(?:(this|next)\s+)?([a-z]+)$/);
  if (m && m[2] in DAY_WORDS) {
    const ahead = (DAY_WORDS[m[2]] - today.getDay() + 7) % 7;
    // "fri" on a Friday means next week's; "this fri" allows today
    return shiftDays(today, ahead === 0 && m[1] !== "this" ? 7 : ahead);
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return validDay(+m[1], +m[2] - 1, +m[3]);
  const yearless = (d: Date | null) => (d && daysBetween(d, today) > 31 ? validDay(d.getFullYear() + 1, d.getMonth(), d.getDate()) : d);
  const year = (y?: string) => (!y ? undefined : y.length === 2 ? 2000 + +y : +y);
  const build = (y: number | undefined, mo: number, d: number) =>
    y === undefined ? yearless(validDay(today.getFullYear(), mo, d)) : validDay(y, mo, d);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  if (m) return build(year(m[3]), +m[2] - 1, +m[1]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)(?:\s+(\d{4}))?$/);
  if (m && m[2] in MONTH_WORDS) return build(year(m[3]), MONTH_WORDS[m[2]], +m[1]);
  m = s.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
  if (m && m[1] in MONTH_WORDS) return build(year(m[3]), MONTH_WORDS[m[1]], +m[2]);
  return null;
}

/** The built-in date parser behind DateChip's text field (a `parse` prop goes first). */
function quickParse(text: string, today: Date): { date?: string; time?: string } | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const { time, rest } = takeTime(s);
  const day = rest ? takeDay(rest, today) : null;
  if (rest && !day) return null;
  if (!day && !time) return null;
  return { date: day ? toLocalISO(day) : undefined, time };
}

/** A typed time for the time field: "15", "9" (whole hours) or anything takeTime reads. */
function parseTimeField(text: string): string | null {
  const s = text.trim().toLowerCase();
  const bare = /^([01]?\d|2[0-3])$/.exec(s);
  if (bare) return hhmm(+bare[1], 0);
  const { time, rest } = takeTime(s);
  return time && !rest ? time : null;
}

const TIME_STEPS = Array.from({ length: 96 }, (_, i) => hhmm(Math.floor(i / 4), (i % 4) * 15));
const WEEK_HEAD = [1, 2, 3, 4, 5, 6, 0];
const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';

export interface DateChipProps {
  /** "YYYY-MM-DD" */
  value?: string;
  /** "HH:MM" (24h); shown on the chip whenever it's set */
  time?: string;
  /** (undefined, undefined) = "No date". Without `withTime`, `time` passes through unchanged. */
  onChange: (date: string | undefined, time?: string) => void;
  /** what the date is, e.g. "Due date": names the chip and its picker */
  label: string;
  /** adds the picker's time row (15-minute steps or free entry) */
  withTime?: boolean;
  /** sm = 24px inline in rows · md = 32px */
  size?: "sm" | "md";
  /** plain text, no picker (guests) */
  readOnly?: boolean;
  /** auto: overdue reads in signal, today-with-a-time in accent; plain: always quiet */
  tone?: "auto" | "plain";
  /** a done task is never "overdue" */
  status?: Status;
  /** renders "Moved 2× · first due Fri 2 Oct" under the chip */
  history?: { original?: string; moves?: number };
  /** natural-language parser for the text field; the built-in one covers weekdays, today/tomorrow, dd/mm and more */
  parse?: (text: string) => { date?: string; time?: string } | null;
  /** the empty chip's words (default "Add date") */
  placeholder?: string;
  defaultOpen?: boolean;
}

/** A due-date chip that opens the DatePicker. Replaces the native date/time inputs in task surfaces. */
export function DateChip({ value, time, onChange, label, withTime, size = "sm", readOnly, tone = "auto", status, history, parse, placeholder, defaultOpen }: DateChipProps) {
  const [open, setOpen] = useState(() => !!defaultOpen && !readOnly);
  const ref = useRef<HTMLButtonElement>(null);
  const iso = value && localDay(value) ? value.slice(0, 10) : undefined;
  const text = iso ? chipText(iso, time) : (placeholder ?? "Add date");
  const toneKey: DateTone = iso && tone === "auto" ? dueTone(iso, time, status) : "plain";
  const note = history ? historyNote(history) : null;

  if (readOnly) {
    return (
      <span className="kdate-wrap" data-size={size} data-static="true">
        <span className="kdate" data-size={size} data-tone={toneKey} data-static="true" data-empty={!iso || undefined}>
          <span className="sr-only">{label}: </span>{iso ? text : (placeholder ?? "No date")}
        </span>
        {note && <span className="kdate-note">{note}</span>}
      </span>
    );
  }
  return (
    <span className="kdate-wrap" data-size={size}>
      <button ref={ref} type="button" className="kdate" data-size={size} data-tone={toneKey} data-empty={!iso || undefined}
        aria-haspopup="dialog" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        {!iso && <Icon name="calendar" size={size === "md" ? 16 : 14} sw={1.75} />}
        <span className="sr-only">{label}: </span>
        <span>{text}</span>
      </button>
      {note && <span className="kdate-note">{note}</span>}
      {open && (
        <DatePicker anchorRef={ref} label={label} value={iso} time={time} withTime={withTime} parse={parse}
          onChange={onChange} onClose={() => setOpen(false)} />
      )}
    </span>
  );
}

function historyNote(h: { original?: string; moves?: number }): string | null {
  const first = h.original ? localDay(h.original) : null;
  const parts = [
    h.moves ? `Moved ${h.moves}×` : null,
    first ? `${h.moves ? "first" : "First"} due ${fmtDay(first)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The picker: quick days · a natural-language field · a Monday-first month · an optional time row.
 *  Arrows move by day (↑↓ by week), PageUp/PageDown by month, Enter picks, Esc closes. */
function DatePicker({ anchorRef, label, value, time, withTime, parse, onChange, onClose }: {
  anchorRef: RefObject<HTMLButtonElement>;
  label: string;
  value?: string;
  time?: string;
  withTime?: boolean;
  parse?: DateChipProps["parse"];
  onChange: DateChipProps["onChange"];
  onClose: () => void;
}) {
  const ids = useDomId("kdp");
  const today = todayLocal();
  const todayIso = toLocalISO(today);
  const inputRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const dayRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusDay, setFocusDay] = useState(value ?? todayIso);
  const [view, setView] = useState((value ?? todayIso).slice(0, 7)); // "YYYY-MM"
  const [text, setText] = useState("");
  const [timeDraft, setTimeDraft] = useState(time ?? "");
  // phones: typing isn't the fast path and a keyboard would cover the month
  const coarse = useMemo(() => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches, []);

  // each keyboard move bumps this, so focus follows even when the day doesn't change (↓ from the field)
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (focusRequest) gridRef.current?.querySelector<HTMLElement>(`[data-iso="${focusDay}"]`)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);
  const moveTo = (iso: string) => { setFocusDay(iso); setView(iso.slice(0, 7)); setFocusRequest((n) => n + 1); };

  const commit = (date: string | undefined, t: string | undefined) => { onChange(date, t); onClose(); };
  const pickDay = (iso: string) => commit(iso, time);

  const parsed = text.trim() ? (parse?.(text) ?? quickParse(text, today)) : null;
  const parsedDay = parsed ? (parsed.date ?? value ?? todayIso) : null;
  const parsedTime = withTime ? parsed?.time : undefined;
  const commitText = () => { if (parsed && parsedDay) commit(parsedDay, withTime ? (parsed.time ?? time) : time); };

  const commitTime = (close: boolean) => {
    const s = timeDraft.trim();
    const t = s ? parseTimeField(s) : undefined;
    if (t === null) setTimeDraft(time ?? "");           // not a time: put the saved one back
    else if (t !== time) { setTimeDraft(t ?? ""); onChange(value ?? todayIso, t); }
    if (close) onClose();
  };

  const [vy, vm] = view.split("-").map(Number);
  const first = new Date(vy, vm - 1, 1);
  const start = shiftDays(first, -((first.getDay() + 6) % 7)); // the Monday on or before the 1st
  const days = Array.from({ length: 42 }, (_, i) => shiftDays(start, i)); // always six weeks: the picker never changes height
  const tabbable = focusDay.slice(0, 7) === view ? focusDay : `${view}-01`;
  const shiftView = (n: number) => {
    const d = shiftMonths(localDay(`${view}-01`)!, n);
    const keep = localDay(focusDay)!;
    const next = validDay(d.getFullYear(), d.getMonth(), Math.min(keep.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))!;
    setFocusDay(toLocalISO(next));
    setView(toLocalISO(d).slice(0, 7));
  };

  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const d = localDay(focusDay) ?? today;
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    let next: Date;
    switch (e.key) {
      case "ArrowLeft": next = shiftDays(d, -1); break;
      case "ArrowRight": next = shiftDays(d, 1); break;
      case "ArrowUp": next = shiftDays(d, -7); break;
      case "ArrowDown": next = shiftDays(d, 7); break;
      case "Home": next = shiftDays(d, -dow); break;
      case "End": next = shiftDays(d, 6 - dow); break;
      case "PageUp": next = shiftMonths(d, e.shiftKey ? -12 : -1); break;
      case "PageDown": next = shiftMonths(d, e.shiftKey ? 12 : 1); break;
      case "Enter": case " ": e.preventDefault(); pickDay(focusDay); return;
      default: return;
    }
    e.preventDefault();
    moveTo(toLocalISO(next));
  };

  // a small dialog: Tab cycles inside it
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0);
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const n = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i === els.length - 1 ? 0 : i + 1);
    e.preventDefault();
    els[n].focus();
  };

  const quick = [
    { label: "Today", iso: todayIso },
    { label: "Tomorrow", iso: presetDate("tomorrow") },
    { label: "This weekend", iso: presetDate("weekend") },
    { label: "Next week", iso: presetDate("nextweek") },
  ];
  const preview = !text.trim() ? null
    : parsedDay ? `${fmtDay(localDay(parsedDay)!)}${parsedTime ? ` · ${parsedTime}` : ""}`
    : "No date matches that yet";

  return (
    <Popover open anchorRef={anchorRef} onClose={onClose} role="dialog" label={label} minWidth={280}
      initialFocus={coarse ? dayRef : inputRef} className="kdp-pop"
      style={{ padding: 0, width: 280, borderRadius: "var(--r-lg, 12px)", boxShadow: "var(--e2, var(--shadow-lg))" }}>
      <div className="kdp" onKeyDown={onKeyDown}>
        <div className="kdp-quick" role="group" aria-label="Quick dates">
          {quick.map((q) => (
            <button key={q.label} type="button" className="kdp-q" aria-pressed={value === q.iso}
              title={fmtFull(localDay(q.iso)!)} onClick={() => pickDay(q.iso)}>{q.label}</button>
          ))}
          <button type="button" className="kdp-q" aria-pressed={!value} onClick={() => commit(undefined, undefined)}>No date</button>
        </div>

        <div>
          <input ref={inputRef} className="kdp-field" type="text" value={text} autoComplete="off" spellCheck={false}
            placeholder={withTime ? "Type a date: fri 3pm, 3 Oct…" : "Type a date: fri, 3 Oct, in 2 weeks…"}
            aria-label={`Type a ${label.toLowerCase()}`} aria-describedby={`${ids}-pv`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitText(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); moveTo(focusDay); }
            }} />
          <div id={`${ids}-pv`} className="kdp-preview" aria-live="polite"
            data-state={!text.trim() ? (coarse ? "idle-touch" : "idle") : parsedDay ? "match" : "miss"}>
            {!text.trim()
              ? (coarse ? null : <span aria-hidden="true">↵ sets it · ↓ jumps to the calendar</span>)
              : parsedDay ? <><span aria-hidden="true">→ </span>{preview}<span className="kdp-enter" aria-hidden="true">↵</span></> : preview}
          </div>
        </div>

        <div className="kdp-cal">
          <div className="kdp-head">
            <span className="kdp-month" id={`${ids}-m`} aria-live="polite">{MONTHS[vm - 1]} {vy}</span>
            <span className="kdp-nav">
              <button type="button" className="kibtn" data-size="sm" aria-label="Previous month" onClick={() => shiftView(-1)}>
                <Icon name="chevronLeft" size={16} sw={1.75} />
              </button>
              <button type="button" className="kibtn" data-size="sm" aria-label="Next month" onClick={() => shiftView(1)}>
                <Icon name="chevronRight" size={16} sw={1.75} />
              </button>
            </span>
          </div>
          <div ref={gridRef} role="grid" aria-labelledby={`${ids}-m`} className="kdp-grid" onKeyDown={onGridKey}>
            <div role="row" className="kdp-row">
              {WEEK_HEAD.map((w) => (
                <span key={w} role="columnheader" aria-label={WEEKDAYS[w]} className="kdp-wd">{WEEKDAYS[w][0]}</span>
              ))}
            </div>
            {[0, 1, 2, 3, 4, 5].map((r) => (
              <div key={r} role="row" className="kdp-row">
                {days.slice(r * 7, r * 7 + 7).map((d) => {
                  const iso = toLocalISO(d);
                  return (
                    <button key={iso} ref={iso === tabbable ? dayRef : undefined} type="button" role="gridcell" className="kdp-day"
                      data-iso={iso} tabIndex={iso === tabbable ? 0 : -1}
                      aria-selected={iso === value} aria-current={iso === todayIso ? "date" : undefined} aria-label={fmtFull(d)}
                      data-outside={iso.slice(0, 7) !== view || undefined} data-today={iso === todayIso || undefined}
                      onClick={() => pickDay(iso)}>
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {withTime && (
          <div className="kdp-time">
            <Icon name="clock" size={16} sw={1.75} />
            <input ref={timeRef} className="kdp-field" type="text" list={`${ids}-t`} value={timeDraft} placeholder="Add time" aria-label="Time"
              autoComplete="off" spellCheck={false}
              onChange={(e) => setTimeDraft(e.target.value)} onBlur={() => commitTime(false)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitTime(true); } }} />
            {time && (
              <button type="button" className="kibtn" data-size="sm" aria-label="Clear time"
                onClick={() => { setTimeDraft(""); onChange(value ?? todayIso, undefined); timeRef.current?.focus(); }}>
                <Icon name="x" size={16} sw={1.75} />
              </button>
            )}
            <datalist id={`${ids}-t`}>{TIME_STEPS.map((t) => <option key={t} value={t} />)}</datalist>
          </div>
        )}
      </div>
    </Popover>
  );
}

/* ============================== AiMark ============================== */

/** Kanbo's AI mark (never a generic sparkle). `thinking` animates the columns
 *  only while a request is in flight; under reduced motion it holds still and
 *  shows "…" instead. Decorative unless `title` names it. */
export function AiMark({ size = 14, thinking, title }: { size?: 12 | 14 | 16; thinking?: boolean; title?: string }) {
  return (
    <span className="kaimark-wrap" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <KanboGlyph size={size} thinking={thinking} gradient />
      {thinking && <span className="kaimark-dots" aria-hidden="true">…</span>}
    </span>
  );
}

/* ============================== Provenance & Vellum ============================== */

/** "How I got here · {summary}" under model-written text; expands to the facts used. */
export function Provenance({ summary, details }: { summary: string; details?: string[] }) {
  const [open, setOpen] = useState(false);
  const id = useDomId("kprov");
  const line = `How I got here · ${summary}`;
  if (!details?.length) return <p className="kprov">{line}</p>;
  return (
    <div className="kprov">
      <button type="button" className="kprov-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span>{line}</span>
        <Icon name="chevronDown" size={14} sw={1.75} />
      </button>
      <ul id={id} className="kprov-list" hidden={!open}>
        {details.map((d, i) => <li key={i}>{d}</li>)}
      </ul>
    </div>
  );
}

/** The surface for MODEL-WRITTEN text only (Ask answers, drafted updates, AI summaries). */
export function Vellum({ children, provenance, style }: { children: ReactNode; provenance?: { summary: string; details?: string[] }; style?: CSSProperties }) {
  return (
    <div className="kvellum" style={style}>
      {children}
      {provenance && <Provenance summary={provenance.summary} details={provenance.details} />}
    </div>
  );
}

/* ============================== EmptyState ============================== */

const ART_SIZE = { sm: 64, md: 96, lg: 120 } as const;

/** Art, a title, one line of help and the action that fixes it — centred, max 420px. */
export function EmptyState({ art, title, body, action, size = "md" }: {
  art?: EmptyArtKind;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div className="kempty" data-size={size}>
      {art && <EmptyArt kind={art} size={ART_SIZE[size]} />}
      <p className="kempty-title">{title}</p>
      {body && <div className="kempty-body">{body}</div>}
      {action && <div className="kempty-action">{action}</div>}
    </div>
  );
}

/* ============================== Sheet ============================== */

const SHEET_EXIT_MS = 160;
/** a bottom sheet dragged down this far (or flicked faster than this, px/ms) closes */
const DRAG_CLOSE_PX = 120, DRAG_CLOSE_SPEED = 0.6;

/** The one dialog recipe: scrim (no blur), raised surface, 56px header with a
 *  Sora title and Close, 64px footer with actions on the right. `side` =
 *  centre dialog, right-hand panel or bottom sheet; phones always get a
 *  full-width bottom sheet, which can be dragged down by its handle to close.
 *  Focus is trapped; Escape, Close and the scrim close it. */
export function Sheet({ open, onClose, label, title, side = "center", width, footer, children, initialFocus }: {
  open: boolean;
  onClose: () => void;
  label: string;
  title?: string;
  side?: "center" | "right" | "bottom";
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
  initialFocus?: RefObject<HTMLElement>;
}): JSX.Element | null {
  // stay on screen for the exit fade (decided while rendering, so it never blinks out and back)
  const [prevOpen, setPrevOpen] = useState(open);
  const [leaving, setLeaving] = useState(false);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setLeaving(!open && !reducedMotion());
  }
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(false), SHEET_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  // (declared before the trap, so it runs first and the trap respects it)
  useEffect(() => {
    if (open) initialFocus?.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  const downOnScrim = useRef(false);

  // drag the handle down to dismiss (the handle only shows on a bottom sheet;
  // keyboard and screen-reader users have Escape and Close)
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const settleTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  const onHandleDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || !trapRef.current) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, t: performance.now(), dy: 0 };
    trapRef.current.dataset.dragging = "true";
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current, el = trapRef.current;
    if (!d || !el) return;
    d.dy = Math.max(0, e.clientY - d.y); // down only: the sheet never lifts off its edge
    el.style.translate = `0 ${d.dy}px`;
  };
  const onHandleUp = () => {
    const d = drag.current, el = trapRef.current;
    drag.current = null;
    if (!d || !el) return;
    delete el.dataset.dragging;
    const speed = d.dy / Math.max(1, performance.now() - d.t);
    if (d.dy > Math.min(DRAG_CLOSE_PX, el.offsetHeight / 3) || (d.dy > 24 && speed > DRAG_CLOSE_SPEED)) { onClose(); return; }
    el.dataset.settling = "true";
    el.style.translate = "";
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => { delete el.dataset.settling; }, SHEET_EXIT_MS);
  };

  if ((!open && !leaving) || typeof document === "undefined") return null;
  const closing = !open;
  const w = width ?? (side === "bottom" ? 640 : 480);
  return createPortal(
    <div className="kbackdrop ksheet-layer" data-side={side} data-state={closing ? "closing" : "open"} aria-hidden={closing || undefined}
      // a press that starts inside (selecting text) and ends on the scrim must not close it
      onMouseDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        e.stopPropagation(); // a portal still bubbles to its React parent (e.g. a row that opens its task)
        if (!closing && downOnScrim.current && e.target === e.currentTarget) onClose();
        downOnScrim.current = false;
      }}>
      <div ref={trapRef} className="ksheet" role={closing ? undefined : "dialog"} aria-modal={closing ? undefined : true} aria-label={label}
        style={{ "--sheet-w": `${w}px` } as CSSProperties}>
        <span className="ksheet-handle" aria-hidden="true"
          onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} />
        {title && (
          <div className="ksheet-head">
            <h2 className="ksheet-title">{title}</h2>
            <IconButton icon="x" label="Close" onClick={onClose} />
          </div>
        )}
        <div className="ksheet-body" data-headless={!title || undefined}>{children}</div>
        {footer && <div className="ksheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ============================== Pill ============================== */

/** A 20px status pill: the tone's ink on a 10% tint of itself. */
export function Pill({ tone, children, icon, title, onClick }: {
  tone: "neutral" | "accent" | "ok" | "warn" | "signal";
  children: ReactNode;
  icon?: IconName;
  title?: string;
  onClick?: () => void;
}) {
  const inner = <>{icon && <Icon name={icon} size={12} sw={2} />}{children}</>;
  return onClick
    ? <button type="button" className="kpill" data-tone={tone} title={title} onClick={onClick}>{inner}</button>
    : <span className="kpill" data-tone={tone} title={title}>{inner}</span>;
}

/* ============================== ProjectDot / projectPaint ============================== */

const PC_MIN = 0.08, PC_MAX = 0.16;
const paintCache = new Map<string, { solid: string; tint: string; edge: string }>();

/** A project's colour at the theme's identity lightness (--pl): its hue, with
 *  chroma held between 0.08 and 0.16 so no project shouts or greys out (a
 *  deliberately neutral colour stays neutral). oklch, hex and rgb() all work;
 *  anything else falls back to the brand hue 268.
 *  solid = dots, squares, block edges, the Daybeam · tint = a 14% wash · edge = a 45% hairline. */
export function projectPaint(color: string): { solid: string; tint: string; edge: string } {
  const key = color ?? "";
  const hit = paintCache.get(key);
  if (hit) return hit;
  const o = toOklch(key);
  const c = o ? o.c : 0.12, h = o ? o.h : 268;
  const chroma = c < 0.03 ? c : Math.min(PC_MAX, Math.max(PC_MIN, c));
  const base = `var(--pl, 0.62) ${+chroma.toFixed(3)} ${+(h % 360).toFixed(1)}`;
  const paint = { solid: `oklch(${base})`, tint: `oklch(${base} / 0.14)`, edge: `oklch(${base} / 0.45)` };
  paintCache.set(key, paint);
  return paint;
}

/** A project's identity mark: a small square (or dot) in projectPaint().solid. Decorative unless `title` names it. */
export function ProjectDot({ color, size = 8, shape = "square", title }: { color: string; size?: 8 | 10 | 12; shape?: "square" | "dot"; title?: string }) {
  return (
    <span className="kpdot" title={title} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}
      style={{ width: size, height: size, borderRadius: shape === "dot" ? "50%" : +(size * 0.28).toFixed(1), background: projectPaint(color).solid }} />
  );
}

/* ============================== SectionLabel ============================== */

/** A group heading in lists and rails ("Overdue 3"): 12/600, sentence case, never an uppercase eyebrow. */
export function SectionLabel({ children, count, tone, action, id }: {
  children: ReactNode;
  count?: number;
  tone?: "signal";
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className="ksection" data-tone={tone}>
      <h3 className="ksection-title" id={id}>
        {children}
        {count != null && <span className="ksection-count">{count}</span>}
      </h3>
      {action && <div className="ksection-action">{action}</div>}
    </div>
  );
}

/* ============================== Toggle ============================== */

/** A settings switch: label (and optional description) on the left, the switch on the right. */
export function Toggle({ checked, onChange, label, description, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useDomId("ktg");
  return (
    <div className="ktoggle" data-disabled={disabled || undefined}>
      <span className="ktoggle-text">
        <label htmlFor={id} className="ktoggle-label">{label}</label>
        {description && <span id={`${id}-d`} className="ktoggle-desc">{description}</span>}
      </span>
      <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled} className="ktoggle-switch" onClick={() => onChange(!checked)}>
        <span className="ktoggle-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}
