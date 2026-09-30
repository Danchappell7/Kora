import { describe, it, expect } from "vitest";
import { contrast, parseColor, over, oklchToRgb, rgbToOklch, toOklch, mixOklab } from "./contrast";

describe("contrast maths", () => {
  it("matches the WCAG reference points", () => {
    const white = parseColor("#fff")!, black = parseColor("#000")!;
    expect(contrast(black, white)).toBeCloseTo(21, 5);
    expect(contrast(white, white)).toBeCloseTo(1, 5);
    // #767676 is the classic "just passes AA" grey on white (4.54:1)
    expect(contrast(parseColor("#767676")!, white)).toBeCloseTo(4.54, 2);
  });

  it("converts oklch to the same sRGB the browser shows", () => {
    const w = oklchToRgb(1, 0, 0);
    expect(w.r).toBeCloseTo(1, 3); expect(w.g).toBeCloseTo(1, 3); expect(w.b).toBeCloseTo(1, 3);
    // oklch(0.628 0.2577 29.23) is sRGB red
    const red = oklchToRgb(0.628, 0.2577, 29.23);
    expect(red.r).toBeCloseTo(1, 2); expect(red.g).toBeCloseTo(0, 2); expect(red.b).toBeCloseTo(0, 2);
  });

  it("parses the colour formats the app uses", () => {
    expect(parseColor("oklch(0.5 0.1 200 / 0.3)")!.a).toBeCloseTo(0.3);
    expect(parseColor("oklch(50% 25% 200)")).not.toBeNull();
    expect(parseColor("rgb(10, 20, 30)")).toMatchObject({ a: 1 });
    expect(parseColor("#abc")).not.toBeNull();
    expect(parseColor("var(--accent)")).toBeNull();
    expect(parseColor("color-mix(in oklch, red, blue)")).toBeNull();
  });

  it("converts sRGB back to oklch (the inverse of oklchToRgb)", () => {
    for (const [L, C, H] of [[0.74, 0.14, 230], [0.62, 0.15, 25], [0.54, 0.215, 288], [0.75, 0.13, 155]]) {
      const o = rgbToOklch(oklchToRgb(L, C, H));
      expect(o.l).toBeCloseTo(L, 3);
      expect(o.c).toBeCloseTo(C, 3);
      expect(o.h).toBeCloseTo(H, 1);
    }
    const violet = rgbToOklch(parseColor("#8B5CF6")!); // brand violet
    expect(violet.h).toBeGreaterThan(285);
    expect(violet.h).toBeLessThan(300);
    expect(rgbToOklch(parseColor("#808080")!).c).toBeLessThan(0.001); // greys have no chroma
  });

  it("reads a colour's oklch coordinates: exactly from oklch(), converted from hex or rgb()", () => {
    expect(toOklch("oklch(0.74 0.14 230)")).toEqual({ l: 0.74, c: 0.14, h: 230 });
    expect(toOklch("oklch(62% 0.15 400deg / 0.5)")).toEqual({ l: 0.62, c: 0.15, h: 40 });
    const v = toOklch("#8B5CF6")!;
    expect(v.h).toBeGreaterThan(285);
    expect(v.h).toBeLessThan(300);
    expect(toOklch("rgb(128, 128, 128)")!.c).toBeLessThan(0.001);
    expect(toOklch("var(--accent)")).toBeNull();
    expect(toOklch("")).toBeNull();
  });

  it("mixes in OKLAB like color-mix(in oklab, …): the ends are exact and the midpoint is the perceptual middle", () => {
    const white = parseColor("#fff")!, black = parseColor("#000")!;
    const jade = oklchToRgb(0.62, 0.144, 158);
    const at1 = mixOklab(jade, white, 1), at0 = mixOklab(jade, white, 0);
    for (const k of ["r", "g", "b"] as const) { expect(at1[k]).toBeCloseTo(jade[k], 4); expect(at0[k]).toBeCloseTo(1, 4); }
    // OKLAB lightness is linear in the mix: half of black and white is L 0.5 (sRGB ~#636363), not #808080
    expect(rgbToOklch(mixOklab(black, white, 0.5)).l).toBeCloseTo(0.5, 3);
    expect(mixOklab(black, white, 0.5).r).toBeCloseTo(0x63 / 255, 1);
    // a 14% tint keeps the hue and carries 14% of the chroma
    const tint = rgbToOklch(mixOklab(jade, white, 0.14));
    expect(tint.h).toBeCloseTo(158, 0);
    expect(tint.c).toBeCloseTo(0.144 * 0.14, 2);
    expect(mixOklab({ ...jade, a: 1 }, { ...white, a: 0 }, 0.25).a).toBeCloseTo(0.25);
  });

  it("composites translucent foregrounds before measuring", () => {
    const white = parseColor("#fff")!;
    const halfBlack = { r: 0, g: 0, b: 0, a: 0.5 };
    expect(over(halfBlack, white).r).toBeCloseTo(0.5);
    expect(contrast(halfBlack, white)).toBeLessThan(contrast(parseColor("#000")!, white));
  });
});
