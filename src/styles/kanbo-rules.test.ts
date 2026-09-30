/* Guards interaction rules in kanbo.css that are easy to regress because
   they only show up in a real browser: keyboard-only reveals, matching
   React's serialised inline styles, and touch-only visibility. */
import { describe, it, expect } from "vitest";

const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;
const css = readFileSync(`${cwd()}/src/styles/kanbo.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every top-level (and one-level @media) rule as [selector list, body]. */
function rules(src: string): Array<[string[], string]> {
  const out: Array<[string[], string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push([m[1].replace(/@media[^{]*\{/, "").split(",").map((s) => s.trim()), m[2]]);
  return out;
}
const all = rules(css);
const selectorsSetting = (prop: RegExp) => all.filter(([, body]) => prop.test(body)).flatMap(([sels]) => sels);

describe("hover-revealed row actions", () => {
  const reveals = selectorsSetting(/opacity:\s*1/);

  it("never reveal on :focus-within (Chrome focuses a clicked button, leaving delete controls stuck on screen)", () => {
    const leaky = reveals.filter((s) => /focus-within/.test(s) && /(kproj-del|tagchip-del|ksaved-del|Select task)/.test(s));
    expect(leaky).toEqual([]);
    expect(selectorsSetting(/opacity:\s*0/).filter((s) => /kproj-row:focus-within/.test(s))).toEqual([]);
  });

  it("reveal for keyboard focus anywhere in the row", () => {
    for (const s of [
      ".kproj-row:has(:focus-visible) .kproj-del",
      ".tagchip:has(:focus-visible) .tagchip-del",
      ".ksaved-row:has(:focus-visible) .ksaved-del",
      '.task-row:has(button:focus-visible) button[aria-label="Select task"]',
    ]) expect(reveals, s).toContain(s);
  });

  it("keep :has() out of the hover rule's selector list (an unsupported selector drops the whole rule)", () => {
    for (const [sels] of all) {
      if (sels.some((s) => /:hover/.test(s) && /-del\b/.test(s))) expect(sels.join(","), "hover rule").not.toMatch(/:has\(/);
    }
  });

  it("hide the sidebar's one-tap Archive on touch, where it would sit permanently beside Delete", () => {
    const touch = css.match(/@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/)![1];
    expect(touch).toMatch(/\.kproj-del\[title\^="Archive"\]\s*\{\s*display:\s*none/);
  });
});

describe("rules that match React's inline border:none", () => {
  // Chrome serialises style.border = "none" as longhands in the style
  // attribute ("border-width: medium; border-style: none; …"); a selector
  // looking only for "border: none" never matched there.
  it.each([
    ["borderless icon buttons are transparent in light", /\.btn-icon:is\(/],
    ["borderless inline editors get the rounded offset ring", /:is\(input,\s*textarea\):is\(/],
  ])("%s", (_name, sel) => {
    const hit = all.find(([sels]) => sels.join(",").match(sel) && /\[style\*="border: none"\]/.test(sels.join(",")));
    expect(hit, "rule present").toBeTruthy();
    expect(hit![0].join(",")).toContain('[style*="border-style: none;"]');
  });
});

describe("progress tracks", () => {
  it("--track is declared in both themes and light tracks use it", () => {
    const light = css.match(/:root, \[data-theme="light"\] \{([\s\S]*?)\n\}/)![1];
    const dark = css.match(/\n\[data-theme="dark"\] \{([\s\S]*?)\n\}/)![1];
    expect(light).toMatch(/--track:\s*var\(--fill-2\)/);
    expect(dark).toMatch(/--track:\s*var\(--surface-2\)/);
    const track = all.find(([sels]) => sels.some((s) => s.includes('background: var(--surface-2); overflow: hidden;')));
    expect(track?.[1]).toMatch(/background:\s*var\(--track\)\s*!important/);
  });
});
