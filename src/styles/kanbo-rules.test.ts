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
/** The body of every `@media …` block (brace-matched, so nested rules come whole). */
function mediaBlocks(src: string): Array<{ query: string; body: string }> {
  const out: Array<{ query: string; body: string }> = [];
  const re = /@media([^{]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth; i++) depth += src[i] === "{" ? 1 : src[i] === "}" ? -1 : 0;
    out.push({ query: m[1].trim(), body: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}
const bodyOf = (selector: string) => all.filter(([sels]) => sels.includes(selector)).map(([, body]) => body).join(";");

describe("hover-revealed row actions", () => {
  const reveals = selectorsSetting(/opacity:\s*1/);

  it("never reveal on :focus-within (Chrome focuses a clicked button, leaving delete controls stuck on screen)", () => {
    const leaky = reveals.filter((s) => /focus-within/.test(s) && /(tagchip-del|ksaved-del|Select task)/.test(s));
    expect(leaky).toEqual([]);
  });

  it("reveal for keyboard focus anywhere in the row", () => {
    for (const s of [
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

  // (the sidebar's project actions live in Sidebar.tsx; Sidebar.test.tsx guards them)
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

describe("kit primitives", () => {
  const KIT = /^\.k(btn|ibtn|kbd|tabs?|meter|glyph|prio|date|dp|aimark|prov|vellum|empty|sheet|pill|pdot|section|toggle|spin)\b/;

  it("an element the kit toggles with [hidden] isn't forced visible by a display rule", () => {
    const hit = all.find(([sels]) => sels.includes(".kprov-list[hidden]"));
    expect(hit?.[1]).toMatch(/display:\s*none/);
  });

  it("switches off every kit animation and transform under reduced motion", () => {
    const block = css.split("@media (prefers-reduced-motion: reduce)").slice(1)
      .map((b) => b.slice(0, b.indexOf("\n}"))).find((b) => b.includes(".kglyph-pop")) ?? "";
    for (const cls of [".kglyph-pop", ".kglyph-draw", ".kspin", ".ksheet", ".kaimark", ".kbtn:active"]) expect(block, cls).toContain(cls);
  });

  it("never blurs what's behind a kit surface (no glass)", () => {
    const blurred = all.filter(([sels, body]) => sels.some((s) => KIT.test(s)) && /backdrop-filter/.test(body)).flatMap(([sels]) => sels);
    expect(blurred).toEqual([]);
  });
});

describe("Paper & Navy", () => {
  it("has no glass: cards and overlays never blur what's behind them", () => {
    for (const sel of [".glass", ".kbackdrop", ".kbackdrop::before"]) {
      const body = bodyOf(sel);
      expect(body, sel).not.toMatch(/backdrop-filter:(?!\s*none)/);
    }
    expect(bodyOf(".glass::before"), "the glass top edge is retired").toBe("");
  });

  it("the backdrop is one static halo: no aurora drift, intro or grain", () => {
    expect(bodyOf(".app-bg")).toMatch(/background:\s*var\(--halo\)/);
    expect(bodyOf(".app-bg")).not.toMatch(/animation/);
    expect(bodyOf(".app-bg::after")).toBe("");
    expect(all.some(([sels, body]) => sels.some((x) => x.includes(".app-bg")) && /animation/.test(body))).toBe(false);
    expect(bodyOf(".app-grid")).toMatch(/display:\s*none/);
  });

  it("section labels are sentence case, never uppercase eyebrows", () => {
    const kicker = bodyOf(".kicker");
    expect(kicker).toMatch(/text-transform:\s*none/);
    expect(kicker).not.toMatch(/uppercase/);
    expect(kicker).toMatch(/letter-spacing:\s*0/);
  });

  it("switches off the route change and the completion pop under reduced motion", () => {
    const reduced = mediaBlocks(css).filter((b) => /prefers-reduced-motion:\s*reduce/.test(b.query)).map((b) => b.body).join("\n");
    for (const cls of [".kroute", ".kglyph-pop", ".kcheck-pop", ".kstagger", ".ktoast", ".kland"]) expect(reduced, cls).toContain(cls);
  });

  it("never declares a bare :root inside @media (the token parser would read it as a theme token)", () => {
    for (const { query, body } of mediaBlocks(css)) {
      const bare = rules(body).flatMap(([sels]) => sels).filter((sel) => sel === ":root");
      expect(bare, `@media ${query}`).toEqual([]);
    }
  });

  it("buttons only come in three heights (28 · 32 · 40) and never lift on hover", () => {
    // (the controls themselves: not things inside them such as a button's kbd,
    // nor the invisible 44px touch target drawn on ::before)
    const heights = all.filter(([sels]) => !sels.join(",").includes("::") && sels.some((x) => /^\.(btn|btn-icon|btn-accent|btn-ghost|kbtn|kibtn|kseg)(?![\w-])[^ >]*$/.test(x)))
      .flatMap(([, body]) => [...body.matchAll(/(?:^|;|\s)height:\s*([^;!]+)/g)].map((m) => m[1].trim()));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(["var(--h-sm)", "var(--h-md)", "var(--h-lg)"], h).toContain(h);
    const lifts = all.filter(([sels, body]) => sels.some((x) => /:hover/.test(x)) && /translateY\(-/.test(body)).flatMap(([sels]) => sels);
    expect(lifts).toEqual([]);
  });

  it("legacy buttons sized by inline padding land on the scale", () => {
    // (an :is() list holds commas, so match on the whole selector text)
    const sm = all.find(([sels]) => { const x = sels.join(","); return x.startsWith(".btn:is(") && x.includes('[style*="padding: 5px"]'); });
    const lg = all.find(([sels]) => { const x = sels.join(","); return x.startsWith(".btn:is(") && x.includes('[style*="padding: 11px"]'); });
    expect(sm?.[1]).toMatch(/height:\s*var\(--h-sm\)/);
    expect(lg?.[1]).toMatch(/height:\s*var\(--h-lg\)/);
  });

  it("menu items fill on hover and keyboard focus themselves, and a danger item stays in the signal colour", () => {
    expect(bodyOf(".kmenu-item:hover:not(:disabled)")).toMatch(/background:\s*var\(--fill-1\)/);
    expect(bodyOf(".kmenu-item:focus-visible")).toMatch(/background:\s*var\(--fill-1\)/);
    const danger = [".kmenu-item[data-tone=\"danger\"]:hover:not(:disabled)", ".kmenu-item[data-tone=\"danger\"]:focus-visible"];
    for (const s of danger) {
      const body = bodyOf(s);
      expect(body, s).toMatch(/background:\s*var\(--signal-tint\)/);
      for (const m of body.matchAll(/(?:^|;|\s)color:\s*([^;]+)/g)) expect(m[1].trim(), s).toBe("var(--signal)");
    }
  });

  it("a bottom sheet let go mid-drag exits on downward from where it was, and dragging never restarts its entrance", () => {
    expect(css).toMatch(/@keyframes ksheetOutDown \{ to \{[^}]*translate: 0 calc\(var\(--drag-y, 0px\)[^}]*\} \}/);
    // switching the animation off while dragging would replay the entrance on release
    expect(bodyOf(".ksheet[data-dragging=\"true\"]")).not.toMatch(/animation/);
  });

  it("docks the task panel at 1280px and wider", () => {
    const wide = mediaBlocks(css).find((b) => /min-width:\s*1280px/.test(b.query));
    expect(wide?.body).toMatch(/\[data-panel="open"\] #main\s*\{[^}]*margin-right:\s*var\(--detail-w\)/);
  });
});
