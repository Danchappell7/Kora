import { describe, it, expect } from "vitest";
import { contrast, parseColor, over, oklchToRgb, rgbToOklch } from "./contrast";

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

  it("composites translucent foregrounds before measuring", () => {
    const white = parseColor("#fff")!;
    const halfBlack = { r: 0, g: 0, b: 0, a: 0.5 };
    expect(over(halfBlack, white).r).toBeCloseTo(0.5);
    expect(contrast(halfBlack, white)).toBeLessThan(contrast(parseColor("#000")!, white));
  });
});
