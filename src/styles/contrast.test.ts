/* Guards the design tokens in kanbo.css against contrast regressions:
   resolves every token per theme (exactly as <html> sees it — `:root` matches
   in BOTH themes) and checks WCAG 2.x ratios for text, chips, controls and
   every accent colour. */
import { describe, it, expect } from "vitest";
import { contrast, over, oklchToRgb, parseColor, type RGBA } from "../lib/contrast";
import { ACCENTS, applyAppearance, accentTheme, LIGHT_CANVAS, LIGHT_PANEL, LIGHT_WELL } from "../lib/appearance";
import { projectPaint } from "../components/primitives/kit";
import { MEMBERS, PROJECTS, TAGS } from "../data/data";

type Theme = "light" | "dark";

// Read the stylesheet from disk (the test config stubs CSS imports, `?raw`
// included). The module name is a variable so tsc doesn't need @types/node.
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process; // vitest runs from the project root
const css = readFileSync(`${cwd()}/src/styles/kanbo.css`, "utf8");

/** Custom properties declared on <html> for a theme (top-level rules only). */
function tokens(theme: Theme, inline: Record<string, string> = {}): Record<string, string> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^\n]*\n/g, "");
  const out: Record<string, string> = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const sels = m[1].split(",").map((s) => s.trim());
    if (!sels.some((s) => s === ":root" || s === `[data-theme="${theme}"]`)) continue;
    for (const d of m[2].split(/;(?![^(]*\))/)) {
      const i = d.indexOf(":");
      const k = d.slice(0, i).trim();
      if (i > 0 && k.startsWith("--")) out[k] = d.slice(i + 1).trim();
    }
  }
  return { ...out, ...inline };
}

function resolve(value: string, t: Record<string, string>, depth = 0): string {
  if (depth > 20) throw new Error("var() cycle: " + value);
  const re = /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/;
  let v = value, m: RegExpMatchArray | null;
  while ((m = v.match(re))) {
    const rep = t[m[1]] !== undefined ? resolve(t[m[1]], t, depth + 1) : m[2] ?? "";
    v = v.slice(0, m.index) + rep + v.slice((m.index ?? 0) + m[0].length);
  }
  return v.trim();
}

/** Evaluate the colour forms the tokens use: oklch/hex, and color-mix with transparent / black / white. */
function color(expr: string): RGBA {
  const s = expr.trim();
  let m = s.match(/^color-mix\(in oklch,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/);
  if (m) { const c = color(m[1]); return { ...c, a: c.a * parseFloat(m[2]) / 100 }; }
  m = s.match(/^color-mix\(in oklch,\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)\s*,\s*(black|white)\s+([\d.]+)%\s*\)$/);
  if (m) {
    const [L, C, H, p] = [+m[1], +m[2], +m[3], +m[5] / 100];
    return m[4] === "black" ? oklchToRgb(L * (1 - p), C * (1 - p), H) : oklchToRgb(L + (1 - L) * p, C * (1 - p), H);
  }
  const c = parseColor(s);
  if (!c) throw new Error("unparsed colour: " + s);
  return c;
}

const tok = (name: string, t: Record<string, string>) => color(resolve(`var(${name})`, t));
const solid = (c: RGBA, bg: RGBA) => (c.a < 1 ? over(c, bg) : c);

function surfaces(t: Record<string, string>) {
  const bg = tok("--bg", t);
  return {
    canvas: bg,
    panel: solid(tok("--bg-deep", t), bg),
    card: solid(tok("--surface", t), bg),
    well: solid(tok("--surface-2", t), bg),
    raised: solid(tok("--surface-raised", t), bg),
    solid: solid(tok("--surface-solid", t), bg),
  };
}
const worst = (fg: RGBA, bgs: Record<string, RGBA>) => Math.min(...Object.values(bgs).map((b) => contrast(fg, b)));

/** The inline properties applyAppearance() writes on <html> for an accent. */
function accentInline(accent: (typeof ACCENTS)[number]["id"]): Record<string, string> {
  const props: Record<string, string> = {};
  const root = {
    style: { setProperty: (k: string, v: string) => { props[k] = v; }, removeProperty: (k: string) => { delete props[k]; }, zoom: "" },
    setAttribute() { /* data-ambient */ },
  } as unknown as HTMLElement;
  applyAppearance({ accent, textSize: "normal", ambient: false }, root);
  delete props["--zoom"];
  return props;
}

const TEXT_STATUS = ["--st-todo", "--st-progress", "--st-review", "--st-blocked", "--st-done", "--prio-low", "--prio-medium", "--prio-high", "--prio-urgent", "--signal", "--warn", "--ok"];
const STATUS_FILLS = ["--st-todo-fill", "--st-progress-fill", "--st-review-fill", "--st-blocked-fill", "--st-done-fill", "--warn-fill"];
/** the colour stops of a gradient token, e.g. the three oklch() stops of --grad-action */
const stops = (gradient: string) => gradient.match(/(oklch\([^)]*\)|#[0-9a-f]{3,6}\b)/gi) ?? [];
const WHITE = parseColor("#fff")!;
const TAG_PALETTE = ["oklch(0.74 0.16 305)", "oklch(0.74 0.14 230)", "oklch(0.75 0.13 155)", "oklch(0.78 0.15 70)", "oklch(0.66 0.2 20)", "oklch(0.7 0.02 240)", "oklch(0.78 0.1 45)"];

describe.each(["light", "dark"] as const)("%s theme tokens", (theme) => {
  const t = tokens(theme);
  const bgs = surfaces(t);

  it("declares every light-block token again in the dark block (no light leaks)", () => {
    const lightBlock = css.match(/:root, \[data-theme="light"\] \{([\s\S]*?)\n\}/)![1];
    const darkBlock = css.match(/\n\[data-theme="dark"\] \{([\s\S]*?)\n\}/)![1];
    const names = (b: string) => new Set([...b.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing = [...names(lightBlock)].filter((n) => !names(darkBlock).has(n));
    expect(missing).toEqual([]);
  });

  it("body text ≥ 7:1 and secondary/tertiary/meta text ≥ 4.5:1 on every surface", () => {
    expect(worst(tok("--ink", t), bgs)).toBeGreaterThanOrEqual(7);
    for (const n of ["--ink-2", "--ink-3", "--ink-4"]) expect(worst(tok(n, t), bgs), n).toBeGreaterThanOrEqual(4.5);
  });

  it("status and priority colours read as text, including on their own chip tint", () => {
    const fill = 0.14; // the heaviest tint status pills use (project health pill: 14%)
    for (const n of TEXT_STATUS) {
      const c = tok(n, t);
      expect(worst(c, { canvas: bgs.canvas, card: bgs.card, raised: bgs.raised, solid: bgs.solid }), n).toBeGreaterThanOrEqual(4.5);
      for (const under of [bgs.canvas, bgs.card]) expect(contrast(c, over({ ...c, a: fill }, under)), `${n} on tint`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("accent-coloured text (--accent-text) ≥ 4.5:1 on every surface, for every accent", () => {
    for (const a of ACCENTS) expect(worst(tok("--accent-text", tokens(theme, accentInline(a.id))), bgs), a.id).toBeGreaterThanOrEqual(4.5);
  });

  it("text on an accent button (--on-accent on --accent-fill, and on its hover) ≥ 4.5:1, for every accent", () => {
    for (const a of ACCENTS) {
      const ta = tokens(theme, accentInline(a.id));
      expect(contrast(tok("--on-accent", ta), tok("--accent-fill", ta)), a.id).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tok("--on-accent", ta), tok("--accent-hover", ta)), `${a.id} hover`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("focus ring (--accent) and the empty-checkbox outline are ≥ 3:1 (WCAG 1.4.11)", () => {
    for (const a of ACCENTS) expect(contrast(tok("--accent", tokens(theme, accentInline(a.id))), bgs.canvas), a.id).toBeGreaterThanOrEqual(3);
    expect(worst(tok("--control-border", t), bgs)).toBeGreaterThanOrEqual(3);
  });

  it("white text on the destructive fill ≥ 4.5:1", () => {
    expect(contrast(parseColor("oklch(0.99 0.01 20)")!, tok("--danger-fill", t))).toBeGreaterThanOrEqual(4.5);
  });

  it("status fills (glyphs, bars, charts) are ≥ 3:1 on the canvas and on cards", () => {
    for (const n of STATUS_FILLS) {
      for (const [k, under] of [["canvas", bgs.canvas], ["card", bgs.card]] as const) expect(contrast(tok(n, t), under), `${n} on ${k}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("quiet icons (--icon-quiet) are ≥ 3:1 on every surface", () => {
    expect(worst(tok("--icon-quiet", t), bgs)).toBeGreaterThanOrEqual(3);
  });

  it("the focus ring (--accent) is ≥ 3:1 on every surface, for every accent", () => {
    for (const a of ACCENTS) expect(worst(tok("--accent", tokens(theme, accentInline(a.id))), bgs), a.id).toBeGreaterThanOrEqual(3);
  });

  it("brand gradient marks (--grad: meters, rings, the AI mark) are ≥ 3:1 on the canvas", () => {
    const marks = stops(resolve("var(--grad)", t));
    expect(marks).toHaveLength(3);
    for (const c of marks) expect(contrast(color(c), bgs.canvas), c).toBeGreaterThanOrEqual(3);
  });

  it("pill tones read on their own 10% tint (and accent pills, for every accent)", () => {
    const tinted = (c: RGBA, under: RGBA) => contrast(c, over({ ...c, a: 0.1 }, under));
    for (const n of ["--ok", "--warn", "--signal", "--ink-3"]) {
      for (const under of [bgs.canvas, bgs.card]) expect(tinted(tok(n, t), under), n).toBeGreaterThanOrEqual(4.5);
    }
    for (const a of ACCENTS) {
      const c = tok("--accent-text", tokens(theme, accentInline(a.id)));
      for (const under of [bgs.canvas, bgs.card]) expect(tinted(c, under), a.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("meta text stays AA on hovered, pressed and selected rows", () => {
    const rows = {
      hover: over(tok("--fill-1", t), bgs.canvas),
      pressed: over(tok("--fill-2", t), bgs.canvas),
      selected: over(tok("--bg-selected", t), bgs.canvas),
      "sidebar hover": over(tok("--fill-1", t), bgs.panel),
      "sidebar active": bgs[theme === "dark" ? "well" : "card"],
    };
    for (const n of ["--ink-3", "--ink-4"]) expect(worst(tok(n, t), rows), n).toBeGreaterThanOrEqual(4.5);
    expect(worst(tok("--accent-text", t), rows), "accent text").toBeGreaterThanOrEqual(4.5);
  });

  it("tooltips (--bg on --ink) and avatar initials read clearly", () => {
    expect(contrast(tok("--bg", t), tok("--ink", t))).toBeGreaterThanOrEqual(7);
    const n = (k: string) => parseFloat(resolve(`var(${k})`, t));
    for (let h = 0; h < 360; h += 15) {
      const disc = oklchToRgb(n("--av-bg-l"), n("--av-bg-c"), h);
      expect(contrast(oklchToRgb(n("--av-fg-l"), n("--av-fg-c"), h), disc), `hue ${h}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("project and tag dots (projectPaint at --pl) are ≥ 3:1 on the canvas and the sidebar", () => {
    const palette = [...PROJECTS.map((p) => p.color), ...Object.values(TAGS).map((g) => g.color), ...MEMBERS.map((m) => m.color), "#1f6feb", "not a colour"];
    for (const c of palette) {
      const dot = color(resolve(projectPaint(c).solid, t));
      for (const [k, under] of [["canvas", bgs.canvas], ["sidebar", bgs.panel]] as const) expect(contrast(dot, under), `${c} on ${k}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("tag chips (chipInk on chipFill) ≥ 4.5:1 for the whole tag palette", () => {
    const fill = parseFloat(resolve("var(--chip-fill)", t)) / 100;
    const mix = resolve("var(--chip-ink-mix)", t), shift = resolve("var(--chip-ink-shift)", t);
    for (const c of TAG_PALETTE) {
      const ink = color(`color-mix(in oklch, ${c}, ${mix} ${shift})`);
      for (const under of [bgs.card, bgs.canvas]) expect(contrast(ink, over({ ...parseColor(c)!, a: fill }, under)), c).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("accent model (appearance.ts ↔ kanbo.css)", () => {
  it("CSS violet defaults match what appearance.ts would derive", () => {
    const light = tokens("light"), dark = tokens("dark");
    expect(resolve("var(--accent-l)", light)).toBe("0.54");
    expect(resolve("var(--accent-l)", dark)).toBe("0.605");
    expect(accentTheme("violet", "light")).toMatchObject({ l: 0.54, ink: "light", shade: 0 });
    // dark violet buttons sit 4.5% deeper so white text passes
    expect(accentTheme("violet", "dark")).toMatchObject({ l: 0.605, ink: "light", shade: 0.045 });
    expect(resolve("var(--accent-fill)", dark)).toContain("black 4.5%");
  });

  it("LIGHT_PANEL mirrors the light --bg-deep (and LIGHT_CANVAS --bg, LIGHT_WELL --surface-2)", () => {
    expect(resolve("var(--bg-deep)", tokens("light"))).toBe(LIGHT_PANEL);
    expect(resolve("var(--bg)", tokens("light"))).toBe(LIGHT_CANVAS);
    expect(resolve("var(--surface-2)", tokens("light"))).toBe(LIGHT_WELL);
  });

  it("teal, green and amber carry deep ink in dark; every accent keeps white text in light", () => {
    for (const id of ["teal", "green", "amber"] as const) expect(accentTheme(id, "dark").ink).toBe("dark");
    for (const a of ACCENTS) expect(accentTheme(a.id, "light").ink).toBe("light");
  });

  it("white text on the hero gradient (--grad-action and its hover) ≥ 4.5:1 at every stop", () => {
    for (const name of ["--grad-action", "--grad-action-hover"]) {
      const ss = stops(resolve(`var(${name})`, tokens("light")));
      expect(ss, name).toHaveLength(3);
      for (const c of ss) expect(contrast(WHITE, color(c)), `${name} ${c}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("switching back to violet clears every inline accent override", () => {
    expect(Object.keys(accentInline("violet"))).toEqual([]);
    expect(Object.keys(accentInline("teal"))).toContain("--on-accent-dark");
  });
});
