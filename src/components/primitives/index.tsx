/* ============================================================
   KANBO — shared primitives (Avatar, StatusDot, Checkbox, Tag,
   PriorityFlag, Segmented, Tooltip, AiScore), restyled for Paper &
   Navy with their props and accessible names unchanged. The new kit
   (Button, Tabs, StatusGlyph, DateChip, Sheet…) is in kit.tsx.
   ============================================================ */
import { useState, useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import { legibleFill, LIGHT_INK, toOklch } from "../../lib/contrast";
import {
  getMember, memberInitials, STATUS_META, TAGS,
} from "../../data/data";
import type { Status, Priority, IconName } from "../../data/types";
import { markJustCompleted, wasJustCompleted } from "./celebrate";
import { AiMark, PriorityGlyph, projectPaint } from "./kit";

export { Icon };
export { KanboLogo, KanboGlyph } from "./KanboLogo";
export { EmptyArt } from "./EmptyArt";
export { EmojiPicker } from "./EmojiPicker";
export { markJustCompleted, wasJustCompleted, markJustLanded, wasJustLanded } from "./celebrate";
// Paper & Navy kit (Button, Tabs, StatusGlyph, DateChip, Sheet…): see kit.tsx
export * from "./kit";

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
// avatarPaint: legible ink on ANY raw profile colour (dark ink on pastels,
// white on deep colours, a mid-tone lifted toward white until dark ink
// reaches 4.5:1). Avatar itself no longer paints the raw colour: it keeps
// only the member's hue (see below). Kept for callers that fill with the raw
// colour; cached per colour, since avatars are in every row.
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

/** The member colour's hue (a grey or unreadable colour takes the brand navy). */
const avatarHue = (color: string) => {
  const o = toOklch(color);
  return o && o.c >= 0.03 ? Math.round(o.h) : 268;
};

// A tinted disc in the member's hue with initials in a deeper (Paper) or
// lighter (Navy) shade of the same hue: every hue reads ≥ 6.3:1, and a team
// of avatars reads as one family instead of a box of crayons.
export function Avatar({ id, size = 24, ring }: { id: string; size?: number; ring?: boolean }) {
  const m = getMember(id);
  if (!m) return null;
  const h = avatarHue(m.color);
  const shadow = ring ? `0 0 0 2px var(--bg), 0 0 0 3.5px oklch(var(--pl) 0.14 ${h})` : "0 0 0 1.5px var(--bg)";
  if (m.avatarUrl) {
    return (
      <img src={m.avatarUrl} alt={m.name} title={m.name} style={{
        width: size, height: size, borderRadius: 99, flexShrink: 0, objectFit: "cover",
        display: "inline-block", boxShadow: shadow,
      }} />
    );
  }
  return (
    <span title={m.name} style={{
      width: size, height: size, borderRadius: 99, flexShrink: 0,
      display: "inline-grid", placeItems: "center",
      fontFamily: "var(--font-ui)", fontWeight: 600, fontSize: Math.max(10, Math.round(size * 0.42)), lineHeight: 1, letterSpacing: "0.02em",
      color: `oklch(var(--av-fg-l) var(--av-fg-c) ${h})`, background: `oklch(var(--av-bg-l) var(--av-bg-c) ${h})`,
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
   out in the card colour (--surface-solid), so they read in both themes.
   Painted with the status FILL tokens (glyph-weight colour); no glow, no
   pulse (`glow` is accepted and ignored). */
const KNOCK = "var(--surface-solid)";
export function StatusDot({ status, size = 9 }: { status: Status; size?: number; glow?: boolean }) {
  const c = `var(--st-${status}-fill, ${STATUS_META[status].color})`;
  const u = 16 / size;            // viewBox units per CSS pixel
  const ring = 1.6 * u;           // a 1.6px outline at any size
  const r = 8 - ring / 2;
  const solid = status === "blocked" || status === "done";
  return (
    <span data-status={status} style={{ position: "relative", width: size, height: size, flexShrink: 0, display: "inline-block", borderRadius: 99 }}>
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ display: "block" }}>
        {solid
          ? <circle cx={8} cy={8} r={8} fill={c} />
          : <circle cx={8} cy={8} r={r} fill="none" stroke={c} strokeWidth={ring} />}
        {status === "progress" && <path d="M8 0A8 8 0 0 1 8 16Z" fill={c} />}
        {status === "review" && <path d="M8 0A8 8 0 1 1 0 8H8Z" fill={c} />}
        {status === "blocked" && <rect x={3.4} y={8 - Math.max(1.3, 0.7 * u)} width={9.2} height={2 * Math.max(1.3, 0.7 * u)} rx={0.6} fill={KNOCK} />}
        {status === "done" && <path d="M4.4 8.4l2.5 2.5 4.8-5" fill="none" stroke={KNOCK} strokeWidth={Math.max(2.2, 1.3 * u)} strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
    </span>
  );
}

/* ---------- Checkbox ---------- */
// The "just completed" / "just landed" registries live in celebrate.ts so the
// kit's StatusGlyph shares them with Check (same names, re-exported here).

// The square checkbox, for sub-tasks, yes/no fields and bulk-select (task rows
// use StatusGlyph: one completion signal). Checking something off pops the
// fill (0.6 → 1 on the spring), draws the tick and gives phones a light
// haptic tap. Un-checking (and anything already done on first render) is calm.
// Pass `celebrateKey` (the task id) so the moment survives a row re-mount, and
// `label` (the task or subtask title) so screen readers hear WHICH item
// ("Done: Write brief"). When the box isn't a completion toggle at all (a
// yes/no custom field), `name` replaces the whole accessible name ("Approved").
export function Check({ done, onToggle, size = 16, celebrateKey, label, name }: { done?: boolean; onToggle?: () => void; size?: number; celebrateKey?: string; label?: string; name?: string }) {
  const [pop, setPop] = useState(() => !!done && wasJustCompleted(celebrateKey));
  // A complete-click only ARMS the celebration; it plays when `done` actually
  // flips. So if completion is cancelled (e.g. "this task is blocked — mark it
  // complete anyway?" → Cancel) nothing pops or vibrates.
  const armedAt = useRef(0);
  useEffect(() => {
    if (!pop) return;
    try { navigator.vibrate?.(10); } catch { /* unsupported (iOS) — no-op */ }
    const t = window.setTimeout(() => setPop(false), 400);
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
  const tick = Math.round(size * 0.75);
  return (
    // A checkbox (state is aria-checked) with a name that doesn't flip with
    // the state, so it never reads as "Mark as not done, pressed". Its look
    // (r-xs, 1.5px control border ≥ 3:1, accent fill when done) is .kcheck in
    // kanbo.css; only the size is inline.
    <button type="button" role="checkbox" aria-checked={!!done} onClick={click}
      aria-label={name || (label ? `Done: ${label}` : "Done")}
      className={"kcheck" + (pop ? " kcheck-pop" : "")}
      style={{ width: size, height: size }}>
      {done && (
        <svg width={tick} height={tick} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block" }}>
          <path d="M5 12.5l4.2 4.2L19 7" pathLength={1} fill="none" stroke="currentColor" strokeWidth={3.4}
            strokeLinecap="round" strokeLinejoin="round" className={pop ? "kcheck-draw" : undefined} />
        </svg>
      )}
    </button>
  );
}

/* ---------- AppBg ----------
   The shared backdrop: Navy's single static violet halo, top right (Paper
   has none). No aurora, no intro, no drift; `grid` is accepted for the
   callers that still pass it and draws nothing. */
export function AppBg({ grid }: { grid?: boolean }) {
  return (
    <>
      <div className="app-bg" aria-hidden="true" />
      {grid && <div className="app-grid" aria-hidden="true" />}
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

/* ---------- Tag ----------
   A dot in the tag's hue (at the theme's identity lightness) and a quiet
   label. No filled pill: colour marks identity, it isn't a background. */
export function Tag({ id, small }: { id: string; small?: boolean }) {
  const tg = TAGS[id];
  if (!tg) return null;
  return (
    <span className="ktag" data-size={small ? "sm" : undefined}>
      <span className="ktag-dot" aria-hidden="true" style={{ background: projectPaint(tg.color).solid }} />
      <span className="ktag-label">{tg.label}</span>
    </span>
  );
}

/* ---------- Priority flag ----------
   Now drawn as the PriorityGlyph: ascending ink bars (low 1 · medium 2 ·
   high 3) and, for Urgent, a signal square with a "!", so urgent differs
   from high by shape as well as colour. Keeps `data-priority` and the
   "{Label} priority" title. */
export function PriorityFlag({ priority, size = 14, withLabel }: { priority: Priority; size?: number; withLabel?: boolean }) {
  return <PriorityGlyph priority={priority} size={size <= 12 ? 12 : size <= 14 ? 14 : 16} withLabel={withLabel} />;
}

/* ---------- AI score ----------
   Kanbo's mark and a mono number, no pill: accent ink from 80 up (do this
   first), ink-2 from 60, quiet below. The reason is the tooltip. */
export function AiScore({ score, reason }: { score: number; reason?: string }) {
  return (
    <span data-tip={reason} className="ai-score kscore" data-tone={score >= 80 ? "high" : score >= 60 ? "mid" : undefined}>
      <AiMark size={12} />{score}
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
          {o.icon && <Icon name={o.icon} size={14} sw={1.75} />}{o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Tooltip (CSS via data-tip) ----------
   Inverse (ink on the page colour), 12/16, no arrow. It waits 400ms before
   showing, so sweeping the pointer across a toolbar doesn't flicker, and
   fades in 90ms. Hidden on touch, where there's no hover. Controls at the
   top of the window (the page header) add data-tip-pos="bottom". */
export function GlobalTipStyles() {
  return (
    <style>{`
      [data-tip]::after {
        content: attr(data-tip);
        position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translate(-50%, 2px);
        width: max-content; max-width: 240px; padding: 4px 8px; border-radius: var(--r-sm, 6px);
        background: var(--ink); color: var(--bg);
        font: 500 12px/16px var(--font-ui, var(--font-display)); letter-spacing: 0; text-transform: none; text-align: center; white-space: normal;
        opacity: 0; pointer-events: none; z-index: 200;
        transition: opacity var(--d-1, 90ms) var(--ease) 0s, transform var(--d-1, 90ms) var(--ease) 0s;
      }
      [data-tip]:hover::after { opacity: 1; transform: translate(-50%, 0); transition-delay: 400ms; }
      [data-tip-pos="bottom"]::after { top: calc(100% + 6px); bottom: auto; transform: translate(-50%, -2px); }
      [data-tip=""]::after { display: none; }
      @media (hover: none) { [data-tip]::after { display: none; } }
    `}</style>
  );
}
