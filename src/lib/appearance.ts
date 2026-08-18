/* ============================================================
   KANBO — appearance personalization
   Accent hue + text size, persisted locally and applied by overriding
   CSS custom properties / zoom on <html>. No backend — each preference
   is a localStorage key read on boot and re-applied.

   (Accent works via the design-system's CSS vars; text size uses `zoom`
   because the UI is inline-styled in px, so a root font-size wouldn't
   cascade — zoom scales the whole app uniformly, modals included.)
   ============================================================ */

export type AccentId = "violet" | "blue" | "teal" | "green" | "amber" | "rose" | "magenta";
export type TextSize = "small" | "normal" | "large";

export interface Appearance { accent: AccentId; textSize: TextSize; }

// each accent is a single oklch hue; lightness/chroma tuned so every accent
// sits at the same visual weight as the brand violet.
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

const ZOOM: Record<TextSize, string> = { small: "0.94", normal: "1", large: "1.08" };

export const DEFAULT_APPEARANCE: Appearance = { accent: "violet", textSize: "normal" };

export function loadAppearance(): Appearance {
  const get = (k: string, fallback: string) => { try { return localStorage.getItem(k) || fallback; } catch { return fallback; } };
  const accent = get("kanbo-accent", "violet") as AccentId;
  const textSize = get("kanbo-textsize", "normal") as TextSize;
  return {
    accent: ACCENTS.some((a) => a.id === accent) ? accent : "violet",
    textSize: ["small", "normal", "large"].includes(textSize) ? textSize : "normal",
  };
}

export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  const accent = ACCENTS.find((x) => x.id === a.accent) ?? ACCENTS[0];
  const { hue, chroma } = accent;
  // brand default (violet) keeps the original hand-tuned tokens untouched so
  // nothing shifts for existing users; other accents derive from the hue.
  if (a.accent === "violet") {
    ["--accent", "--accent-strong", "--accent-dim", "--accent-glow", "--on-accent"].forEach((v) => root.style.removeProperty(v));
  } else {
    root.style.setProperty("--accent", `oklch(0.605 ${chroma} ${hue})`);
    root.style.setProperty("--accent-strong", `oklch(0.55 ${chroma} ${hue})`);
    root.style.setProperty("--accent-dim", `oklch(0.605 ${chroma} ${hue} / 0.12)`);
    root.style.setProperty("--accent-glow", `oklch(0.605 ${chroma} ${hue} / 0.32)`);
    root.style.setProperty("--on-accent", `oklch(0.99 0.01 ${hue})`);
  }
  root.style.zoom = ZOOM[a.textSize]; // Chromium/WebKit — scales the whole app uniformly
}

export function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem("kanbo-accent", a.accent);
    localStorage.setItem("kanbo-textsize", a.textSize);
  } catch { /* private mode */ }
  applyAppearance(a);
}
