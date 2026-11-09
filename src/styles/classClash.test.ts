// @vitest-environment node
// Two screens that define the same class name restyle each other as soon as both
// stylesheets have loaded. That broke Today › Week: My Week, the Weekly review and the
// streak dots all used .kweek, so the week grid collapsed after a visit to Today › Day.
// Every class a stylesheet or a component's inline CSS starts a rule with must belong
// to one file.
import { describe, expect, it } from "vitest";

const nodeFs = "node:fs";
const { readdirSync, readFileSync, statSync } = (await import(/* @vite-ignore */ nodeFs)) as {
  readdirSync: (p: string) => string[];
  readFileSync: (p: string, enc: string) => string;
  statSync: (p: string) => { isDirectory(): boolean };
};
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;
const ROOT = cwd();
const SRC = `${ROOT}/src`;
const join = (a: string, b: string) => `${a}/${b}`;
const relative = (p: string) => p.slice(ROOT.length + 1);

/** Clashes that predate this check. Each needs a look; don't add to this list. */
const KNOWN = new Set(["kdoc-head", "kdoc-title", "knt-select", "ksaved-del", "ktv-swipe-done"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(css|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

function definedClasses(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of files(SRC)) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/^\s*\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\s*[{,]/gm)) {
      const set = out.get(m[1]) ?? new Set<string>();
      set.add(relative(f));
      out.set(m[1], set);
    }
  }
  return out;
}

describe("class names", () => {
  it("each class is defined in one file only", () => {
    const clashes = [...definedClasses()]
      .filter(([name, where]) => where.size > 1 && !KNOWN.has(name))
      .map(([name, where]) => `.${name}: ${[...where].sort().join(", ")}`);
    expect(clashes).toEqual([]);
  });

  it("My Week owns .kweek, the Weekly review .kwr and the streak dots .kmom", () => {
    const defs = definedClasses();
    expect([...(defs.get("kweek") ?? [])]).toEqual(["src/components/views/MyWeekView.tsx"]);
    expect([...(defs.get("kwr") ?? [])]).toEqual(["src/components/rituals/WeeklyReview.tsx"]);
    expect([...(defs.get("kmom-week") ?? [])]).toEqual(["src/components/momentum/momentum.css"]);
  });
});
