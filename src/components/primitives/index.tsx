/* ============================================================
   KANBO — shared primitives (Avatar, StatusDot, Checkbox, Tag,
   PriorityFlag, Segmented, Tooltip, AiScore)
   ============================================================ */
import { useState, useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import { legibleFill, LIGHT_INK } from "../../lib/contrast";
import {
  getMember, memberInitials, STATUS_META, TAGS, PRIORITY_META,
} from "../../data/data";
import type { Status, Priority, IconName } from "../../data/types";

export { Icon };
export { KanboLogo } from "./KanboLogo";
export { EmptyArt } from "./EmptyArt";
export { EmojiPicker } from "./EmojiPicker";

/* ---------- colour chips ----------
   Chips tinted with a RAW palette colour (tags, energy levels, calendar
   providers) keep their colour identity with a translucent fill + edge,
   while the TEXT is pushed away from the background: 42% toward black on
   paper, 12% toward white on glass, so every tag colour stays ≥ 4.5:1 on its
   own tint. Black and white have no hue, so the mix keeps the tag's own hue.
   Chips coloured with a status/priority TOKEN (AiScore, "At risk") don't
   need this: those tokens are tuned per theme to pass on their own tint. */
export const chipInk = (c: string) => `color-mix(in oklch, ${c}, var(--chip-ink-mix, black) var(--chip-ink-shift, 0%))`;
export const chipFill = (c: string) => `color-mix(in oklch, ${c} var(--chip-fill, 12%), transparent)`;
export const chipEdge = (c: string) => `color-mix(in oklch, ${c} var(--chip-edge, 30%), transparent)`;

/* ---------- Avatar ---------- */
// Initials must read on ANY profile colour: dark ink (--avatar-ink) on the
// pastel palette, white on deep colours, and a mid-tone neither reaches
// 4.5:1 on (e.g. the old default self violet, oklch 0.585) is lifted toward
// white just enough for dark ink. Cached per colour — avatars are in every row.
const avatarCache = new Map<string, { fill: string; ink: string }>();
export function avatarPaint(color: string): { fill: string; ink: string } {
  let paint = avatarCache.get(color);
  if (!paint) {
    const { fill, ink } = legibleFill(color);
    paint = { fill, ink: ink === "light" ? LIGHT_INK : "var(--avatar-ink)" };
    avatarCache.set(color, paint);
  }
  return paint;
}

export function Avatar({ id, size = 24, ring }: { id: string; size?: number; ring?: boolean }) {
  const m = getMember(id);
  if (!m) return null;
  const shadow = ring ? `0 0 0 2px var(--bg), 0 0 0 3.5px ${m.color}` : "0 0 0 1.5px var(--bg)";
  if (m.avatarUrl) {
    return (
      <img src={m.avatarUrl} alt={m.name} title={m.name} style={{
        width: size, height: size, borderRadius: 99, flexShrink: 0, objectFit: "cover",
        display: "inline-block", boxShadow: shadow,
      }} />
    );
  }
  const paint = avatarPaint(m.color);
  return (
    <span title={m.name} style={{
      width: size, height: size, borderRadius: 99, flexShrink: 0,
      display: "inline-grid", placeItems: "center",
      fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: size * 0.36,
      color: paint.ink, background: paint.fill,
      boxShadow: shadow,
    }}>{memberInitials(m.name)}</span>
  );
}

export function AvatarStack({ ids, size = 22 }: { ids: string[]; size?: number }) {
  return (
    <span style={{ display: "inline-flex" }}>
      {ids.map((id, i) => (
        <span key={id} style={{ marginLeft: i ? -size * 0.32 : 0, zIndex: ids.length - i }}>
          <Avatar id={id} size={size} />
        </span>
      ))}
    </span>
  );
}

/* ---------- StatusDot ----------
   Colour alone can't tell "Blocked" from "Done" for a colour-blind user
   (red/green), so every status also has its own SHAPE, legible down to 6px:
   to do = empty ring · in progress = half full · in review = three-quarters
   full · blocked = no-entry bar · done = tick. The bar and tick are knocked
   out in the card colour (--surface-solid), so they read in both themes. */
const KNOCK = "var(--surface-solid)";
export function StatusDot({ status, size = 9, glow }: { status: Status; size?: number; glow?: boolean }) {
  const c = STATUS_META[status].color;
  const isProgress = status === "progress";
  const u = 16 / size;            // viewBox units per CSS pixel
  const ring = 1.6 * u;           // a 1.6px outline at any size
  const r = 8 - ring / 2;
  const solid = status === "blocked" || status === "done";
  return (
    <span data-status={status} style={{
      position: "relative", width: size, height: size, flexShrink: 0, display: "inline-block", borderRadius: 99,
      boxShadow: glow ? `0 0 var(--glow-r, 8px) ${c}` : "none", // no glow on paper (light: 0px)
    }}>
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ display: "block" }}>
        {solid
          ? <circle cx={8} cy={8} r={8} fill={c} />
          : <circle cx={8} cy={8} r={r} fill="none" stroke={c} strokeWidth={ring} />}
        {status === "progress" && <path d="M8 0A8 8 0 0 1 8 16Z" fill={c} />}
        {status === "review" && <path d="M8 0A8 8 0 1 1 0 8H8Z" fill={c} />}
        {status === "blocked" && <rect x={3.4} y={8 - Math.max(1.3, 0.7 * u)} width={9.2} height={2 * Math.max(1.3, 0.7 * u)} rx={0.6} fill={KNOCK} />}
        {status === "done" && <path d="M4.4 8.4l2.5 2.5 4.8-5" fill="none" stroke={KNOCK} strokeWidth={Math.max(2.2, 1.3 * u)} strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
      {isProgress && <span style={{ position: "absolute", inset: -3, borderRadius: 99, border: `1.5px solid ${c}`, opacity: 0.35, animation: "pulseGlow 2s var(--ease) infinite" }} />}
    </span>
  );
}

/* ---------- Checkbox ---------- */
// "Just completed" registry. Completing a task often MOVES its row (e.g. into
// the Done group), which unmounts the checkbox mid-animation; the re-mounted
// checkbox/row look themselves up here and finish the celebration in place.
const recentlyCompleted = new Map<string, number>();
const CELEBRATE_MS = 700;
export function markJustCompleted(key?: string) {
  if (!key) return;
  const now = Date.now();
  recentlyCompleted.forEach((t, k) => { if (now - t > 5000) recentlyCompleted.delete(k); });
  recentlyCompleted.set(key, now);
}
export function wasJustCompleted(key?: string): boolean {
  const t = key ? recentlyCompleted.get(key) : undefined;
  return !!t && Date.now() - t < CELEBRATE_MS;
}
// Same idea for drag-and-drop: a dropped card/row often re-mounts in its new
// column/group, so the "landed" settle is looked up by id on mount.
const recentlyLanded = new Map<string, number>();
export function markJustLanded(key?: string) {
  if (!key) return;
  const now = Date.now();
  recentlyLanded.forEach((t, k) => { if (now - t > 5000) recentlyLanded.delete(k); });
  recentlyLanded.set(key, now);
}
export function wasJustLanded(key?: string): boolean {
  const t = key ? recentlyLanded.get(key) : undefined;
  return !!t && Date.now() - t < CELEBRATE_MS;
}

// The signature completion moment: when the user checks something off, the box
// springs, a ring bursts outward, the tick draws itself, and phones get a light
// haptic tap. Un-checking (and anything already done on first render) is calm.
// Pass `celebrateKey` (the task id) so the moment survives a row re-mount, and
// `label` (the task or subtask title) so screen readers hear WHICH item
// ("Done: Write brief"). When the box isn't a completion toggle at all (a
// yes/no custom field), `name` replaces the whole accessible name ("Approved").
export function Check({ done, onToggle, size = 18, celebrateKey, label, name }: { done?: boolean; onToggle?: () => void; size?: number; celebrateKey?: string; label?: string; name?: string }) {
  const [pop, setPop] = useState(() => !!done && wasJustCompleted(celebrateKey));
  // A complete-click only ARMS the celebration; it plays when `done` actually
  // flips. So if completion is cancelled (e.g. "this task is blocked — mark it
  // complete anyway?" → Cancel) nothing pops or vibrates.
  const armedAt = useRef(0);
  useEffect(() => {
    if (!pop) return;
    try { navigator.vibrate?.(10); } catch { /* unsupported (iOS) — no-op */ }
    const t = window.setTimeout(() => setPop(false), 650);
    return () => window.clearTimeout(t);
  }, [pop]);
  useEffect(() => {
    if (done && armedAt.current && Date.now() - armedAt.current < 1500) setPop(true);
    armedAt.current = 0;
  }, [done]);
  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    const wasDone = !!done;
    onToggle?.(); // may block on a confirm dialog; state updates commit after this handler
    if (!wasDone) {
      armedAt.current = Date.now();
      markJustCompleted(celebrateKey); // lets a re-mounted row (moved to "Done") pick it up
    }
  };
  const tick = size * 0.7;
  return (
    // A checkbox (state is aria-checked) with a name that doesn't flip with
    // the state, so it never reads as "Mark as not done, pressed".
    <button type="button" role="checkbox" aria-checked={!!done} onClick={click}
      aria-label={name || (label ? `Done: ${label}` : "Done")}
      className={"kcheck" + (pop ? " kcheck-pop" : "")}
      style={{
        width: size, height: size, borderRadius: 6, flexShrink: 0, cursor: "pointer", padding: 0,
        display: "grid", placeItems: "center", transition: "background .2s var(--ease), border-color .2s var(--ease), box-shadow .3s var(--ease)",
        // the empty outline IS the control: ≥ 3:1 on every surface (WCAG 1.4.11)
        border: `1.6px solid ${done ? "var(--accent)" : "var(--control-border, var(--hairline-strong))"}`,
        background: done ? "var(--accent)" : "transparent",
        boxShadow: done ? "0 0 calc(var(--glow-r, 8px) * 1.5) var(--accent-glow)" : "none",
        color: "var(--on-accent)",
      }}>
      {done && (
        <svg width={tick} height={tick} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block" }}>
          <path d="M5 12.5l4.2 4.2L19 7" pathLength={1} fill="none" stroke="currentColor" strokeWidth={3.2}
            strokeLinecap="round" strokeLinejoin="round" className={pop ? "kcheck-draw" : undefined} />
        </svg>
      )}
    </button>
  );
}

/* ---------- AppBg ----------
   The shared aurora background. Its breathe-in plays ONCE per page load: the
   first AppBg starts the clock; any AppBg mounted later (e.g. the loader
   swapping for the app shell) continues the same intro via a negative delay
   instead of restarting it, and after the intro window none animate. */
let bgIntroStart: number | null = null;
const BG_INTRO_MS = 1600;
export function AppBg({ grid }: { grid?: boolean }) {
  const [introDelay] = useState<number | null>(() => {
    const now = performance.now();
    if (bgIntroStart === null) { bgIntroStart = now; return 0; }
    const elapsed = now - bgIntroStart;
    return elapsed < BG_INTRO_MS ? -elapsed : null;
  });
  return (
    <>
      <div className={"app-bg" + (introDelay !== null ? " app-bg-intro" : "")} style={introDelay ? { animationDelay: `${Math.round(introDelay)}ms` } : undefined} />
      {grid && <div className="app-grid" />}
    </>
  );
}

/* ---------- Collapse ----------
   Smooth height expand/collapse without measuring: animates grid rows
   0fr <-> 1fr. Content mounts on open and unmounts after the close
   transition; overflow is only clipped while moving, so popovers inside
   an open section aren't cut off. Reduced-motion makes it instant. */
export function Collapse({ open, children, ms = 280 }: { open: boolean; children: ReactNode; ms?: number }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const a = window.setTimeout(() => setExpanded(true), 16);
      const b = window.setTimeout(() => setSettled(true), ms + 30);
      return () => { window.clearTimeout(a); window.clearTimeout(b); };
    }
    setSettled(false);
    setExpanded(false);
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  if (!mounted) return null;
  return (
    // opacity floor 0.35 (house rule): a throttled frame never shows a blank section
    <div style={{ display: "grid", gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0.35,
      transition: `grid-template-rows ${ms}ms var(--ease-out), opacity ${ms}ms var(--ease-out)` }}>
      <div style={{ minHeight: 0, overflow: settled ? "visible" : "hidden" }}>{children}</div>
    </div>
  );
}

/* ---------- CountUp ----------
   Animates a KPI value from its previous number to the new one (from 0 on
   mount). Only values with exactly ONE number animate ("67%", "0.4/wk",
   "£1,200" is left alone because of the comma grouping); multi-number values
   like "12h 3m" or "—" render as-is. Screen readers get the final value
   straight away via a visually-hidden copy. Reduced-motion jumps to the end. */
export function CountUp({ value, ms = 750 }: { value: string | number; ms?: number }) {
  const str = String(value);
  const nums = str.match(/\d+(?:\.\d+)?/g);
  const m = nums && nums.length === 1 && !/\d,\d/.test(str) ? str.match(/^(.*?)(\d+(?:\.\d+)?)(.*)$/) : null;
  const target = m ? parseFloat(m[2]) : 0;
  const decimals = m && m[2].includes(".") ? m[2].split(".")[1].length : 0;
  const [shown, setShown] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    if (!m) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { fromRef.current = target; setShown(target); return; }
    const from = fromRef.current, start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const v = from + (target - from) * (1 - Math.pow(1 - p, 3)); // ease-out cubic
      fromRef.current = v; setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // if rAF never runs (background tab), land on the true value anyway
    const safety = window.setTimeout(() => { cancelAnimationFrame(raf); fromRef.current = target; setShown(target); }, ms + 400);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(safety); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ms, !!m]);
  if (!m) return <>{str}</>;
  return (
    <>
      <span className="sr-only">{str}</span>
      <span aria-hidden="true">{m[1]}{shown.toFixed(decimals)}{m[3]}</span>
    </>
  );
}

/* ---------- Tag chip ---------- */
export function Tag({ id, small }: { id: string; small?: boolean }) {
  const tg = TAGS[id];
  if (!tg) return null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontFamily: "var(--font-mono)", fontSize: small ? 10 : 11, fontWeight: 500,
      padding: small ? "1px 7px" : "2px 8px", borderRadius: 6,
      color: chipInk(tg.color),
      border: `1px solid ${chipEdge(tg.color)}`,
      backgroundColor: chipFill(tg.color),
    }}>{tg.label}</span>
  );
}

/* ---------- Priority flag ----------
   Filled = high or urgent, outline = medium or low. Urgent also carries an
   exclamation mark beside the flag, so it differs from High by shape as well
   as colour (red and amber look alike to many colour-blind users). */
export function PriorityFlag({ priority, size = 14, withLabel }: { priority: Priority; size?: number; withLabel?: boolean }) {
  const p = PRIORITY_META[priority];
  const filled = priority === "urgent" || priority === "high";
  return (
    <span data-priority={priority} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: p.color }} title={p.label + " priority"}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
        <path d="M5 21V4" />
        <path d="M5 4h11l-2 4 2 4H5" fill={filled ? "currentColor" : "none"} />
        {priority === "urgent" && <path d="M20.5 4v5.2M20.5 12.6v.01" strokeWidth={2.6} />}
      </svg>
      {withLabel && <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{p.label}</span>}
    </span>
  );
}

/* ---------- AI score pill ---------- */
export function AiScore({ score, reason }: { score: number; reason?: string }) {
  const c = score >= 80 ? "var(--prio-urgent)" : score >= 60 ? "var(--prio-high)" : "var(--ink-3)";
  return (
    <span data-tip={reason} className="ai-score" style={{
      display: "inline-flex", alignItems: "center", gap: 5, position: "relative",
      fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: c,
      padding: "2px 7px 2px 6px", borderRadius: 6,
      background: `color-mix(in oklch, ${c} 12%, transparent)`,
      border: `1px solid color-mix(in oklch, ${c} 26%, transparent)`,
    }}>
      <Icon name="sparkles" size={11} />{score}
    </span>
  );
}

/* ---------- Segmented control ---------- */
export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  icon?: IconName;
}
// A single-select toggle group: each option is a toggle button whose pressed
// state is exposed (aria-pressed), inside a named group ("View", "Group by").
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="kseg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" className="kseg-btn" data-active={o.value === value} aria-pressed={o.value === value}
          onClick={() => onChange(o.value)} title={o.label}>
          {o.icon && <Icon name={o.icon} size={15} />}{o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Tooltip (CSS via data-tip) ---------- */
export function GlobalTipStyles() {
  return (
    <style>{`
      [data-tip]::after {
        content: attr(data-tip);
        position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%) translateY(4px);
        background: var(--surface-raised); color: var(--ink); border: 1px solid var(--hairline-strong);
        font-family: var(--font-display); font-size: 11.5px; font-weight: 400; line-height: 1.4;
        padding: 7px 10px; border-radius: 9px; white-space: normal; width: max-content; max-width: 220px;
        box-shadow: var(--shadow-lg); opacity: 0; pointer-events: none; transition: all .16s var(--ease); z-index: 200;
      }
      [data-tip]:hover::after { opacity: 1; transform: translateX(-50%) translateY(0); }
    `}</style>
  );
}
