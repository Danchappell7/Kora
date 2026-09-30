/* ============================================================
   KANBO — appearance personalization
   Accent hue + text size, persisted locally and applied by overriding
   CSS custom properties / zoom on <html>. No backend — each preference
   is a localStorage key read on boot and re-applied.

   (Accent works via the design-system's CSS vars; text size uses `zoom`
   because the UI is inline-styled in px, so a root font-size wouldn't
   cascade — zoom scales the whole app uniformly, modals included. vh
   units zoom too, so kanbo.css sizes the app shells with the 100% chain
   instead of 100vh; see `#root` there. `--zoom` is published for any code
   that has to convert getBoundingClientRect() pixels back to CSS pixels.)
   ============================================================ */

import { contrast, oklchToRgb, parseColor } from "./contrast";

export type AccentId = "violet" | "blue" | "teal" | "green" | "amber" | "rose" | "magenta";
export type TextSize = "small" | "normal" | "large";
export type ThemeName = "light" | "dark";

// ambient = opt-in slow drift of the background aurora. Off by default: every
// glass card re-blurs whatever moves beneath it, so it costs a little GPU.
export interface Appearance { accent: AccentId; textSize: TextSize; ambient: boolean; }

// each accent is a single oklch hue + chroma; the LIGHTNESS comes from the
// theme (--accent-l in kanbo.css) so every accent is text-safe on paper and
// glows on glass.
export const ACCENTS: { id: AccentId; label: string; hue: number; chroma: number }[] = [
  { id: "violet", label: "Violet", hue: 287, chroma: 0.205 },
  { id: "blue", label: "Blue", hue: 264, chroma: 0.19 },
  { id: "teal", label: "Teal", hue: 195, chroma: 0.13 },
  { id: "green", label: "Green", hue: 155, chroma: 0.15 },
  { id: "amber", label: "Amber", hue: 75, chroma: 0.16 },
  { id: "rose", label: "Rose", hue: 18, chroma: 0.17 },
  { id: "magenta", label: "Magenta", hue: 330, chroma: 0.20 },
];
// preview swatch color (independent of theme) for the settings UI
export const accentSwatch = (id: AccentId) => {
  const a = ACCENTS.find((x) => x.id === id) ?? ACCENTS[0];
  return `oklch(0.62 ${a.chroma} ${a.hue})`;
};

/** Accent lightness per theme — mirrors --accent-l / --accent-strong-l in kanbo.css. */
export const THEME_ACCENT_L: Record<ThemeName, { l: number; strong: number }> = {
  light: { l: 0.54, strong: 0.49 },
  dark: { l: 0.605, strong: 0.55 },
};
/** The darkest light-theme surface accent text sits on (--bg-deep: sidebar, lanes). */
export const LIGHT_PANEL = "oklch(0.944 0.007 266)";

/** Text on an accent fill: white where it reaches AA, otherwise a deep ink. */
export const ON_ACCENT_LIGHT = (hue: number) => `oklch(0.99 0.01 ${hue})`;
export const ON_ACCENT_DARK = (hue: number) => `oklch(0.17 0.02 ${hue})`;
// deepest a button fill may go (color-mix with black) to keep white text;
// beyond ~6% a hue loses its character (amber turns ochre), so it takes ink
const MAX_SHADE = 0.065;

export interface AccentTheme {
  l: number;            // accent lightness in this theme
  strongL: number;      // --accent-strong lightness (deeper emphasis)
  hoverL: number;       // primary-button hover: deeper under white text, lighter under ink
  ink: "light" | "dark"; // --on-accent
  shade: number;        // 0..MAX_SHADE — how much deeper --accent-fill sits than --accent
}

/**
 * How an accent renders in a theme.
 * - Light: the accent is also link/label text, so it steps darker than the
 *   base 0.54 until it reads ≥ 4.5:1 on the darkest panel (WCAG luminance
 *   runs high for teal/green/amber/blue at equal perceived lightness).
 * - White text is the house look, so if white misses 4.5:1 on the accent,
 *   the button fill (--accent-fill) is deepened by up to 6.5%; if even that
 *   isn't enough (teal, green, amber in dark) the accent carries deep ink.
 */
export function accentTheme(id: AccentId, theme: ThemeName): AccentTheme {
  const a = ACCENTS.find((x) => x.id === id) ?? ACCENTS[0];
  const base = THEME_ACCENT_L[theme];
  let l = base.l;
  if (theme === "light") {
    const panel = parseColor(LIGHT_PANEL)!;
    while (l > 0.4 && contrast(oklchToRgb(l, a.chroma, a.hue), panel) < 4.5) l = +(l - 0.005).toFixed(3);
  }
  const strongL = +(l - (base.l - base.strong)).toFixed(3);
  const white = parseColor(ON_ACCENT_LIGHT(a.hue))!;
  for (let step = 0; step <= Math.round(MAX_SHADE * 200); step++) {
    const p = step / 200; // 0.5% steps
    if (contrast(white, oklchToRgb(l * (1 - p), a.chroma * (1 - p), a.hue)) >= 4.5) {
      return { l, strongL, hoverL: strongL, ink: "light", shade: p };
    }
  }
  return { l, strongL, hoverL: +(l + 0.045).toFixed(3), ink: "dark", shade: 0 };
}

const ZOOM: Record<TextSize, string> = { small: "0.94", normal: "1", large: "1.08" };

/** The current text-size zoom on <html> (1 when unset) — divide rect pixels by it. */
export function uiZoom(): number {
  if (typeof document === "undefined") return 1;
  const z = parseFloat(document.documentElement.style.getPropertyValue("--zoom"));
  return Number.isFinite(z) && z > 0 ? z : 1;
}

export const DEFAULT_APPEARANCE: Appearance = { accent: "violet", textSize: "normal", ambient: false };

export function loadAppearance(): Appearance {
  const get = (k: string, fallback: string) => { try { return localStorage.getItem(k) || fallback; } catch { return fallback; } };
  const accent = get("kanbo-accent", "violet") as AccentId;
  const textSize = get("kanbo-textsize", "normal") as TextSize;
  return {
    accent: ACCENTS.some((a) => a.id === accent) ? accent : "violet",
    textSize: ["small", "normal", "large"].includes(textSize) ? textSize : "normal",
    ambient: get("kanbo-ambient", "off") === "on",
  };
}

// every inline property applyAppearance may set — cleared for the brand default
const ACCENT_PROPS = [
  "--accent", "--accent-strong", "--accent-dim", "--accent-glow", "--accent-text-dark", "--aurora-h",
  "--accent-l-light", "--accent-strong-l-light", "--accent-l-dark", "--accent-strong-l-dark",
  "--on-accent-light", "--on-accent-dark", "--accent-shade-light", "--accent-shade-dark",
  "--accent-hover-light", "--accent-hover-dark",
  "--on-accent", // written by earlier versions; the theme blocks own it now
];

export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement) {
  const accent = ACCENTS.find((x) => x.id === a.accent) ?? ACCENTS[0];
  const { hue, chroma } = accent;
  // brand default (violet) keeps the hand-tuned tokens in kanbo.css; other
  // accents derive from the hue, at each theme's lightness (--accent-l is
  // resolved on <html>, so switching theme re-derives with no JS).
  ACCENT_PROPS.forEach((v) => root.style.removeProperty(v));
  if (a.accent !== "violet") {
    const set = (k: string, v: string) => root.style.setProperty(k, v);
    set("--aurora-h", String(hue)); // background aurora follows the accent
    set("--accent", `oklch(var(--accent-l) ${chroma} ${hue})`);
    set("--accent-strong", `oklch(var(--accent-strong-l) ${chroma} ${hue})`);
    set("--accent-dim", `oklch(var(--accent-l) ${chroma} ${hue} / var(--accent-dim-a))`);
    set("--accent-glow", `oklch(var(--accent-l) ${chroma} ${hue} / var(--accent-glow-a))`);
    // text-on-dark tint (light theme uses --accent itself, already text-safe)
    set("--accent-text-dark", `oklch(0.72 ${Math.min(chroma, 0.15)} ${hue})`);
    (["light", "dark"] as const).forEach((theme) => {
      const t = accentTheme(a.accent, theme);
      if (t.l !== THEME_ACCENT_L[theme].l) {
        set(`--accent-l-${theme}`, String(t.l));
        set(`--accent-strong-l-${theme}`, String(t.strongL));
      }
      set(`--on-accent-${theme}`, t.ink === "light" ? ON_ACCENT_LIGHT(hue) : ON_ACCENT_DARK(hue));
      set(`--accent-shade-${theme}`, `${+(t.shade * 100).toFixed(1)}%`);
      if (t.hoverL !== t.strongL) set(`--accent-hover-${theme}`, `oklch(${t.hoverL} ${chroma} ${hue})`);
    });
  }
  root.style.zoom = ZOOM[a.textSize]; // Chromium/WebKit — scales the whole app uniformly
  root.style.setProperty("--zoom", ZOOM[a.textSize]);
  root.setAttribute("data-ambient", a.ambient ? "on" : "off");
}

export function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem("kanbo-accent", a.accent);
    localStorage.setItem("kanbo-textsize", a.textSize);
    localStorage.setItem("kanbo-ambient", a.ambient ? "on" : "off");
  } catch { /* private mode */ }
  applyAppearance(a);
}
