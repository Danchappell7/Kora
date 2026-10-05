/* slack.css: the Slack live regions (role="status") must stay in the
   accessibility tree while empty, or screen readers may not announce the
   message that arrives in them (WCAG 4.1.3). jsdom doesn't apply CSS, so
   this guards the stylesheet itself. */
import { describe, it, expect } from "vitest";

const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;
const css = readFileSync(`${cwd()}/src/components/integrations/slack.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule as [selectors, body] (one level of @media unwrapped). */
function rules(src: string): Array<[string[], string]> {
  const out: Array<[string[], string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push([m[1].replace(/@media[^{]*\{/, "").split(",").map((s) => s.trim()), m[2]]);
  return out;
}

describe("Slack live regions stay in the accessibility tree", () => {
  const LIVE = ["kslk-live", "kslk-post-note"];
  const hiders = rules(css).filter(([, body]) => /display:\s*none|visibility:\s*hidden|content-visibility:\s*hidden/.test(body));

  it("no rule hides .kslk-live or .kslk-post-note (empty or not)", () => {
    const bad = hiders.flatMap(([sels]) => sels).filter((s) => LIVE.some((c) => new RegExp(`\\.${c}(?![\\w-])[^\\s>+~]*$`).test(s)));
    expect(bad).toEqual([]);
  });

  it("the empty post note is collapsed visually, not removed", () => {
    const empty = rules(css).filter(([sels]) => sels.includes(".kslk-post-note:empty")).map(([, b]) => b).join(";");
    expect(empty).toMatch(/position:\s*absolute/);
    expect(empty).toMatch(/clip-path:\s*inset\(50%\)/);
  });
});
