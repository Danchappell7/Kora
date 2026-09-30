/* ============================================================
   KANBO — project identity: the twelve-hue spectrum.
   Every project reads as one of twelve curated hues, rendered at ONE
   lightness per theme (kanbo.css: --spec-*), so a workspace of forty
   projects stays a calm mosaic instead of a pastel quilt, and every
   pairing is AA in Paper and in Navy (src/styles/contrast.test.ts).

   Nothing is migrated: `project.color` keeps whatever string it holds
   (oklch, hex, rgb) and is read for its HUE, snapped to the nearest
   spectrum hue. A colour with no hue (a grey, or garbage) falls back to
   a stable hash of the project id, so a project never changes colour
   between sessions. The Personal project is Iris.

   Theme switches need no re-render: everything below is CSS built from
   custom properties. Put `identity.style` (--p-h and its trims) on an
   element with class `kp` and kanbo.css derives --p-fill, --p-ink,
   --p-tint and --p-cover for it and its children; or use the
   self-contained `fill` / `ink` / `tint` / `cover` strings anywhere.
   Pure: no DOM, no React at runtime.
   ============================================================ */
import type { CSSProperties } from "react";
import { toOklch } from "./contrast";
import type { Project } from "../data/types";

export type SpectrumKey =
  | "iris" | "violet" | "orchid" | "rose" | "coral" | "tangerine"
  | "amber" | "citron" | "jade" | "lagoon" | "sky" | "cobalt";

export interface SpectrumHue {
  key: SpectrumKey;
  /** the swatch's accessible name: "Jade" */
  name: string;
  /** oklch hue, degrees */
  hue: number;
  /** chroma trims (0..1) for the fill and the ink: they keep both inside the
   *  sRGB gamut in both themes, so the colour on screen is the colour tested
   *  (a clipped or wide-gamut colour would drift from its measured contrast) */
  fc: number;
  ic: number;
  /** cover lightness lift: yellows go khaki at the cover's mid lightness, so they sit a little higher */
  cl: number;
}

/** The spectrum, in hue order from Iris round to Cobalt. */
export const SPECTRUM: readonly SpectrumHue[] = Object.freeze([
  { key: "iris", name: "Iris", hue: 270, fc: 0.96, ic: 0.85, cl: 0 },
  { key: "violet", name: "Violet", hue: 293, fc: 1, ic: 0.93, cl: 0 },
  { key: "orchid", name: "Orchid", hue: 318, fc: 1, ic: 1, cl: 0 },
  { key: "rose", name: "Rose", hue: 350, fc: 1, ic: 1, cl: 0 },
  { key: "coral", name: "Coral", hue: 22, fc: 1, ic: 0.93, cl: 0 },
  { key: "tangerine", name: "Tangerine", hue: 48, fc: 1, ic: 0.94, cl: 0.02 },
  { key: "amber", name: "Amber", hue: 78, fc: 0.8, ic: 0.72, cl: 0.08 },
  { key: "citron", name: "Citron", hue: 110, fc: 0.84, ic: 0.75, cl: 0.06 },
  { key: "jade", name: "Jade", hue: 158, fc: 0.9, ic: 0.8, cl: 0 },
  { key: "lagoon", name: "Lagoon", hue: 190, fc: 0.66, ic: 0.6, cl: 0 },
  { key: "sky", name: "Sky", hue: 225, fc: 0.73, ic: 0.65, cl: 0 },
  { key: "cobalt", name: "Cobalt", hue: 250, fc: 1, ic: 0.88, cl: 0 },
].map((s) => Object.freeze(s as SpectrumHue)));

/** The built-in Personal project (always Iris). */
export const PERSONAL_PROJECT_ID = "p-personal";
/** Personal's colour before the spectrum existed: still read as Iris. */
const LEGACY_PERSONAL_COLOUR = "oklch(0.78 0.1 45)";
/** Below this chroma a stored colour has no meaningful hue (a grey). */
const MIN_HUED_CHROMA = 0.02;
/** How far round the wheel the cover's second stop sits (its spectrum neighbour). */
export const COVER_NEIGHBOUR = 24;

/** The fields identity reads. Name and emoji are only needed for the tile's glyph. */
export type ProjectIdentityInput = Pick<Project, "id" | "color"> & Partial<Pick<Project, "name" | "emoji">>;

const byKey = new Map(SPECTRUM.map((s) => [s.key, s]));
const circular = (a: number, b: number) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return Math.min(d, 360 - d); };

/** The spectrum hue nearest a colour wheel angle (ties go to the earlier hue in SPECTRUM order). */
export function nearestSpectrum(hue: number): SpectrumHue {
  let best = SPECTRUM[0], bestD = Infinity;
  for (const s of SPECTRUM) {
    const d = circular(hue, s.hue);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

/** A spectrum entry by key, or the nearest one to a hue angle. */
export function spectrumHue(hueOrKey: number | SpectrumKey): SpectrumHue {
  return typeof hueOrKey === "number" ? nearestSpectrum(hueOrKey) : byKey.get(hueOrKey) ?? SPECTRUM[0];
}

/** FNV-1a: a small, stable string hash (the same id always lands on the same hue). */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** The spectrum entry a project wears. */
export function projectSpectrum(project: Pick<Project, "id" | "color"> | null | undefined): SpectrumHue {
  if (!project) return SPECTRUM[0];
  const color = (project.color ?? "").trim();
  if (project.id === PERSONAL_PROJECT_ID && (!color || color === LEGACY_PERSONAL_COLOUR)) return byKey.get("iris")!;
  const o = color ? toOklch(color) : null;
  if (o && o.c >= MIN_HUED_CHROMA) return nearestSpectrum(o.h);
  return SPECTRUM[stableHash(project.id ?? "") % SPECTRUM.length];
}

/** The project's spectrum hue (one of the twelve): its stored colour's nearest hue, else a stable hash of its id. */
export function projectHue(project: Pick<Project, "id" | "color"> | null | undefined): number {
  return projectSpectrum(project).hue;
}

/** The string to STORE as `project.color` for a spectrum hue (the Paper fill;
 *  every reader, old and new, recovers the hue from it). */
export function spectrumColor(hueOrKey: number | SpectrumKey): string {
  const s = spectrumHue(hueOrKey);
  return `oklch(0.62 ${+(0.16 * s.fc).toFixed(3)} ${s.hue})`;
}

/* ---- the CSS recipes. kanbo.css `.kp` holds the same templates with
   var(--p-h, 270) / var(--p-fc, 1) / var(--p-ic, 1) in place of the numbers
   (src/lib/projectIdentity.test.ts keeps the two in step). ---- */
const fillOf = (h: number, fc: number) => `oklch(var(--spec-fill-l, 0.62) calc(var(--spec-fill-c, 0.16) * ${fc}) ${h})`;
const inkOf = (h: number, ic: number) => `oklch(var(--spec-ink-l, 0.45) calc(var(--spec-ink-c, 0.13) * ${ic}) ${h})`;
const tintOf = (fill: string) => `color-mix(in oklab, ${fill} var(--spec-tint, 14%), var(--bg-raised))`;
const coverOf = (h: number, fc: number, cl: number) =>
  `radial-gradient(120% 160% at 0% 0%, oklch(var(--spec-cover-hi-l, 0.92) calc(var(--spec-cover-hi-c, 0.05) * ${fc}) ${h}), transparent 62%), `
  + `linear-gradient(118deg, oklch(calc(var(--spec-cover-a-l, 0.68) + ${cl}) calc(var(--spec-cover-a-c, 0.15) * ${fc}) ${h}), `
  + `oklch(calc(var(--spec-cover-b-l, 0.8) + ${cl}) calc(var(--spec-cover-b-c, 0.09) * ${fc}) ${h + COVER_NEIGHBOUR}))`;

export interface ProjectIdentity {
  /** the spectrum hue, degrees */
  hue: number;
  key: SpectrumKey;
  /** the spectrum colour's name ("Jade"), not the project's */
  name: string;
  /** marks: tile rings, block edges, the Daybeam, active bars (≥ 3:1 on every surface) */
  fill: string;
  /** project-coloured text and tile initials (≥ 4.5:1 on its tint and on every surface) */
  ink: string;
  /** the project's wash: tiles, Today blocks, hovered chips (opaque, mixed over --bg-raised) */
  tint: string;
  /** the cover's colour field (ProjectCover adds the light sweep, grain and scrim) */
  cover: string;
  /** --p-h, --p-fc, --p-ic, --p-cl: put on an element with class `kp` and kanbo.css derives --p-fill, --p-ink, --p-tint and --p-cover */
  style: CSSProperties;
}

const cache = new Map<string, ProjectIdentity>();

/** A project's identity as theme-aware CSS. Cached, so `style` is referentially stable per project colour. */
export function projectIdentity(project: Pick<Project, "id" | "color"> | null | undefined): ProjectIdentity {
  const key = project ? `${project.id}\u0000${project.color ?? ""}` : "\u0000";
  const hit = cache.get(key);
  if (hit) return hit;
  const s = projectSpectrum(project);
  const fill = fillOf(s.hue, s.fc);
  const id: ProjectIdentity = Object.freeze({
    hue: s.hue,
    key: s.key,
    name: s.name,
    fill,
    ink: inkOf(s.hue, s.ic),
    tint: tintOf(fill),
    cover: coverOf(s.hue, s.fc, s.cl),
    style: Object.freeze({ "--p-h": String(s.hue), "--p-fc": String(s.fc), "--p-ic": String(s.ic), "--p-cl": String(s.cl) } as CSSProperties),
  });
  if (cache.size > 500) cache.clear();
  cache.set(key, id);
  return id;
}

/** The first user-perceived character of a string (keeps flags, skin tones and ZWJ families whole). */
export function firstGrapheme(s: string): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) for (const { segment } of new Seg(undefined, { granularity: "grapheme" }).segment(t)) return segment;
  return Array.from(t)[0] ?? "";
}

/** What a tile shows: the project's emoji, else the first letter or digit of its name, else nothing. */
export function projectGlyph(project: Partial<Pick<Project, "name" | "emoji">> | null | undefined): { kind: "emoji" | "initial" | "none"; text: string } {
  const emoji = firstGrapheme(project?.emoji ?? "");
  if (emoji) return { kind: "emoji", text: emoji };
  const m = /[\p{L}\p{N}]/u.exec(project?.name ?? "");
  return m ? { kind: "initial", text: m[0].toLocaleUpperCase("en-GB") } : { kind: "none", text: "" };
}
