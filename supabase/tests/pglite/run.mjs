#!/usr/bin/env node
// Bundles suite.ts (TypeScript + the real edge function modules) with esbuild
// and runs it on Node, with db.ts's npm:postgres@3.4.5 pointed at a local copy of
// that same version. See README.md. Not picked up by vitest.
//
//   node supabase/tests/pglite/run.mjs            every migration set
//   node supabase/tests/pglite/run.mjs 0047       only 0001..0047 + 0050..0058
//   node supabase/tests/pglite/run.mjs 0049       every migration
//   node supabase/tests/pglite/run.mjs 0058       only 0001..0050 + 0058 (then 0051..0057 after it)
//   node supabase/tests/pglite/run.mjs 0050       only 0001..0050 (the edge functions before 0058)
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** postgres@3.4.5's entry: POSTGRES_PATH, or the copy Deno cached. */
function postgresEntry() {
  const home = process.env.POSTGRES_PATH || join(homedir(), "Library/Caches/deno/npm/registry.npmjs.org/postgres/3.4.5");
  const entry = join(home, "src/index.js");
  const pkg = join(home, "package.json");
  if (!existsSync(entry) || !existsSync(pkg) || JSON.parse(readFileSync(pkg, "utf8")).version !== "3.4.5") {
    console.error(`This suite needs postgres@3.4.5, the version db.ts pins, and didn't find it at ${home}.\nSee supabase/tests/pglite/README.md.`);
    process.exit(2);
  }
  return entry;
}

const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "kanbo-pglite-"));
const out = join(dir, "suite.mjs");
await build({
  entryPoints: [resolve(here, "suite.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  logLevel: "warning",
  alias: { "npm:postgres@3.4.5": postgresEntry() },
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
try {
  const { main } = await import(pathToFileURL(out).href);
  process.exitCode = await main(process.argv.slice(2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
