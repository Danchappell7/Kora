/* ============================================================
   KANBO — colour contrast helpers
   Tiny, dependency-free colour maths used to pick legible ink at
   runtime (avatar initials on arbitrary profile colours, text on a
   custom accent) and by the contrast tests that guard the design
   tokens. Supports the formats the app actually uses: oklch(),
   #rgb/#rrggbb and rgb()/rgba(). Anything else → null, and callers
   fall back to their token default.
   ============================================================ */

export interface RGBA { r: number; g: number; b: number; a: number } // gamma-encoded sRGB, 0..1

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** oklch → gamma-encoded sRGB (clipped to the sRGB gamut, as browsers display it on sRGB screens). */
export function oklchToRgb(L: number, C: number, H: number, alpha = 1): RGBA {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const enc = (x: number) => {
    const v = clamp01(x);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };
  return { r: enc(lin[0]), g: enc(lin[1]), b: enc(lin[2]), a: alpha };
}

/** gamma-encoded sRGB → oklch (the inverse of oklchToRgb); hue in degrees 0..360. */
export function rgbToOklch(c: RGBA): { l: number; c: number; h: number } {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const r = lin(c.r), g = lin(c.g), b = lin(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

const num = (s: string, pctScale = 1): number => {
  const t = s.trim();
  if (t === "none") return 0;
  return t.endsWith("%") ? (parseFloat(t) / 100) * pctScale : parseFloat(t);
};

/** Parse a CSS colour string. Returns null for anything we can't resolve (var(), color-mix(), names…). */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  let m = s.match(/^oklch\(\s*([^\s/]+)\s+([^\s/]+)\s+([^\s/)]+)\s*(?:\/\s*([^\s)]+))?\s*\)$/);
  if (m) {
    const L = num(m[1], 1), C = num(m[2], 0.4), H = num(m[3]);
    const A = m[4] === undefined ? 1 : num(m[4], 1);
    if ([L, C, H, A].some((v) => Number.isNaN(v))) return null;
    return oklchToRgb(L, C, H, A);
  }
  m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
    return { r: parseInt(hex.slice(0, 2), 16) / 255, g: parseInt(hex.slice(2, 4), 16) / 255, b: parseInt(hex.slice(4, 6), 16) / 255, a: 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const ch = (v: string) => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v) / 255);
    return { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]), a: m[4] === undefined ? 1 : num(m[4], 1) };
  }
  return null;
}

/**
 * A colour's oklch coordinates — exact for an `oklch()` string (so a stored
 * project hue survives untouched), converted for hex and rgb(). Null for
 * anything unparseable; callers pick their own fallback hue.
 */
export function toOklch(input: string): { l: number; c: number; h: number } | null {
  const m = /^\s*oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)\s*$/i.exec(input ?? "");
  if (m) {
    const l = num(m[1], 1), c = num(m[2], 0.4), h = num(m[3]);
    return [l, c, h].every(Number.isFinite) ? { l, c, h: ((h % 360) + 360) % 360 } : null;
  }
  const rgb = parseColor(input ?? "");
  return rgb ? rgbToOklch(rgb) : null;
}

/** Alpha-composite `top` over an opaque `bottom` (browsers blend in gamma-encoded sRGB). */
export function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

export function luminance(c: RGBA): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio. A translucent foreground is composited over the background first. */
export function contrast(fg: RGBA, bg: RGBA): number {
  const f = fg.a < 1 ? over(fg, bg) : fg;
  const l1 = luminance(f), l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* Inks used on top of arbitrary colour fills (avatars, custom accents). */
export const DARK_INK = "oklch(0.22 0.02 266)";
export const LIGHT_INK = "oklch(0.99 0.005 266)";

/**
 * Make a solid colour carry legible text (≥ 4.5:1): light ink on deep
 * colours, dark ink on pastels, and — for a mid-tone neither ink reaches
 * 4.5:1 on — the fill is lifted toward white (in 5% steps, ≤ 40%) until dark
 * ink does. Unparseable colours come back unchanged with dark ink.
 */
export function legibleFill(color: string): { fill: string; ink: "dark" | "light" } {
  const bg = parseColor(color);
  if (!bg || bg.a < 1) return { fill: color, ink: "dark" };
  const dark = parseColor(DARK_INK)!, light = parseColor(LIGHT_INK)!;
  const cd = contrast(dark, bg), cl = contrast(light, bg);
  if (cd >= 4.5 && cd >= cl) return { fill: color, ink: "dark" };
  if (cl >= 4.5) return { fill: color, ink: "light" };
  const m = color.trim().match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i);
  if (m) {
    const [L, C, H] = [+m[1], +m[2], +m[3]];
    for (let step = 1; step <= 8; step++) {
      const p = step * 0.05; // color-mix toward white: L → L + (1 − L)p, C → C(1 − p)
      if (contrast(dark, oklchToRgb(L + (1 - L) * p, C * (1 - p), H)) >= 4.5) {
        return { fill: `color-mix(in oklch, ${color}, white ${step * 5}%)`, ink: "dark" };
      }
    }
  }
  return { fill: color, ink: cl > cd ? "light" : "dark" };
}
