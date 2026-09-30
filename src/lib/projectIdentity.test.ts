import { describe, it, expect } from "vitest";
import {
  SPECTRUM, COVER_NEIGHBOUR, firstGrapheme, nearestSpectrum, projectGlyph, projectHue, projectIdentity, projectSpectrum,
  spectrumColor, spectrumHue, stableHash,
} from "./projectIdentity";
import { PERSONAL_PROJECT, PROJECTS } from "../data/data";

// kanbo.css, read from disk (the test config stubs CSS imports)
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;
const css = readFileSync(`${cwd()}/src/styles/kanbo.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const P = (id: string, color: string) => ({ id, color });

describe("the spectrum", () => {
  it("is the twelve named hues, once each, round the wheel from Iris", () => {
    expect(SPECTRUM.map((s) => `${s.name} ${s.hue}`)).toEqual([
      "Iris 270", "Violet 293", "Orchid 318", "Rose 350", "Coral 22", "Tangerine 48",
      "Amber 78", "Citron 110", "Jade 158", "Lagoon 190", "Sky 225", "Cobalt 250",
    ]);
    expect(new Set(SPECTRUM.map((s) => s.key)).size).toBe(12);
    for (const s of SPECTRUM) {
      expect(s.key).toBe(s.name.toLowerCase());
      for (const k of ["fc", "ic"] as const) { expect(s[k], `${s.name} ${k}`).toBeGreaterThan(0.5); expect(s[k]).toBeLessThanOrEqual(1); }
      expect(s.cl).toBeGreaterThanOrEqual(0);
      expect(s.cl).toBeLessThanOrEqual(0.1);
    }
  });

  it("snaps any hue to the nearest spectrum hue, across 0°", () => {
    expect(nearestSpectrum(270).name).toBe("Iris");
    expect(nearestSpectrum(281).name).toBe("Iris");    // 11° from Iris, 12° from Violet
    expect(nearestSpectrum(359).name).toBe("Rose");
    expect(nearestSpectrum(5).name).toBe("Rose");      // 15° back to Rose beats 17° on to Coral
    expect(nearestSpectrum(8).name).toBe("Coral");
    expect(nearestSpectrum(-90).name).toBe("Iris");
    expect(nearestSpectrum(720 + 158).name).toBe("Jade");
    expect(spectrumHue("lagoon").hue).toBe(190);
    expect(spectrumHue(200).key).toBe("lagoon");
  });

  it("stores a spectrum hue as the Paper fill, which every reader maps back to the same hue", () => {
    expect(spectrumColor("iris")).toBe("oklch(0.62 0.154 270)");
    expect(spectrumColor("orchid")).toBe("oklch(0.62 0.16 318)");
    expect(spectrumColor(191)).toBe("oklch(0.62 0.106 190)");
    for (const s of SPECTRUM) expect(projectHue(P("x", spectrumColor(s.key))), s.name).toBe(s.hue);
  });
});

describe("projectHue", () => {
  it("reads today's stored colours (no migration) and keeps the six legacy swatches apart", () => {
    // the six swatches the pickers offered before the spectrum (ProjectHeader PROJECT_COLOURS)
    const legacy = ["oklch(0.74 0.14 230)", "oklch(0.74 0.16 305)", "oklch(0.75 0.13 155)", "oklch(0.78 0.15 70)", "oklch(0.66 0.2 20)", "oklch(0.78 0.1 45)"];
    const hues = legacy.map((c) => projectSpectrum(P("p", c)).name);
    expect(hues).toEqual(["Sky", "Violet", "Jade", "Amber", "Coral", "Tangerine"]);
    expect(projectHue(P("p", "#8B5CF6"))).toBe(293);            // hex: brand violet
    expect(projectHue(P("p", "#e5544b"))).toBe(22);             // hex red → Coral
    expect(projectHue(P("p", "rgb(55, 198, 168)"))).toBe(190);  // rgb() teal → Lagoon
    expect(projectHue(P("p", "oklch(62% 0.15 400deg)"))).toBe(48);
  });

  it("falls back to a stable hash of the id for a grey or unreadable colour", () => {
    for (const color of ["", "oklch(0.7 0.01 240)", "#808080", "var(--accent)", "not a colour"]) {
      const a = projectHue(P("proj-42", color));
      expect(a, color).toBe(SPECTRUM[stableHash("proj-42") % 12].hue);
      expect(projectHue(P("proj-42", color))).toBe(a); // the same every time
    }
    const spread = new Set(Array.from({ length: 48 }, (_, i) => projectHue(P(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, ""))));
    expect(spread.size).toBeGreaterThanOrEqual(9); // UUIDs spread across the wheel
    expect(stableHash("abc")).toBe(stableHash("abc"));
    expect(stableHash("abc")).not.toBe(stableHash("abd"));
  });

  it("makes the Personal project Iris, unless someone chose its colour", () => {
    expect(projectHue(PERSONAL_PROJECT)).toBe(270);
    expect(projectHue(P("p-personal", "oklch(0.78 0.1 45)"))).toBe(270); // its pre-spectrum colour
    expect(projectHue(P("p-personal", ""))).toBe(270);
    expect(projectHue(P("p-personal", spectrumColor("jade")))).toBe(158);
    expect(projectHue(null)).toBe(270);
  });
});

describe("projectIdentity", () => {
  it("returns theme-aware CSS (custom properties, no fixed lightness) and the style that scopes it", () => {
    const id = projectIdentity(P("p-infra", spectrumColor("jade")));
    expect(id).toMatchObject({ hue: 158, key: "jade", name: "Jade" });
    expect(id.fill).toBe("oklch(var(--spec-fill-l, 0.62) calc(var(--spec-fill-c, 0.16) * 0.9) 158)");
    expect(id.ink).toBe("oklch(var(--spec-ink-l, 0.45) calc(var(--spec-ink-c, 0.13) * 0.8) 158)");
    expect(id.tint).toBe(`color-mix(in oklab, ${id.fill} var(--spec-tint, 14%), var(--bg-raised))`);
    expect(id.cover).toContain(` ${158 + COVER_NEIGHBOUR}))`); // runs into its neighbour hue
    expect(id.style).toEqual({ "--p-h": "158", "--p-fc": "0.9", "--p-ic": "0.8", "--p-cl": "0" });
  });

  it("is cached per project colour, so the style object is stable between renders", () => {
    const a = projectIdentity(P("p1", "#37c6a8")), b = projectIdentity({ id: "p1", color: "#37c6a8" });
    expect(b).toBe(a);
    expect(b.style).toBe(a.style);
    expect(projectIdentity(P("p1", spectrumColor("rose")))).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("matches the .kp templates in kanbo.css exactly, for every hue", () => {
    const block = css.match(/\n\.kp \{([^}]*)\}/)![1];
    const decl = (name: string) => block.match(new RegExp(`${name}:\\s*([^;]+);`))![1].trim();
    for (const s of SPECTRUM) {
      const sub = (v: string) => v
        .replace(/calc\(var\(--p-h, 270\) \+ 24\)/g, String(s.hue + COVER_NEIGHBOUR))
        .replace(/var\(--p-h, 270\)/g, String(s.hue))
        .replace(/var\(--p-fc, 1\)/g, String(s.fc))
        .replace(/var\(--p-ic, 1\)/g, String(s.ic))
        .replace(/var\(--p-cl, 0\)/g, String(s.cl));
      const id = projectIdentity(P(`p-${s.key}`, spectrumColor(s.key)));
      expect(sub(decl("--p-fill")), s.name).toBe(id.fill);
      expect(sub(decl("--p-ink")), s.name).toBe(id.ink);
      expect(sub(decl("--p-tint")).replace("var(--p-fill)", id.fill), s.name).toBe(id.tint);
      expect(sub(decl("--p-cover")), s.name).toBe(id.cover);
    }
  });
});

describe("projectGlyph", () => {
  it("shows the emoji, whole (flags, variation selectors, ZWJ sequences), else the name's initial", () => {
    expect(projectGlyph({ name: "Launch", emoji: "🚀" })).toEqual({ kind: "emoji", text: "🚀" });
    expect(projectGlyph({ name: "Infra", emoji: "⚙️" }).text).toBe("⚙️");
    expect(projectGlyph({ name: "Dev", emoji: "👩🏽‍💻 extra" }).text).toBe("👩🏽‍💻");
    expect(projectGlyph({ name: "UK", emoji: "🇬🇧" }).text).toBe("🇬🇧");
    expect(projectGlyph({ name: "  q3 launch", emoji: "  " })).toEqual({ kind: "initial", text: "Q" });
    expect(projectGlyph({ name: "#1 goal" })).toEqual({ kind: "initial", text: "1" });
    expect(projectGlyph({ name: "étude" }).text).toBe("É");
    expect(projectGlyph({ name: "—", emoji: "" })).toEqual({ kind: "none", text: "" });
    expect(projectGlyph(null).kind).toBe("none");
    expect(firstGrapheme("")).toBe("");
  });
});

describe("demo seed", () => {
  it("gives every demo project its own emoji and its own spectrum hue, stored as a spectrum colour", () => {
    expect(new Set(PROJECTS.map((p) => p.emoji)).size).toBe(PROJECTS.length);
    expect(new Set(PROJECTS.map((p) => projectHue(p))).size).toBe(PROJECTS.length);
    for (const p of PROJECTS) expect(p.color, p.name).toBe(spectrumColor(projectHue(p)));
    expect(projectSpectrum(PROJECTS.find((p) => p.id === "p-personal")).name).toBe("Iris");
    expect(projectSpectrum(PROJECTS.find((p) => p.id === "p-launch")).name).toBe("Sky");
  });
});
