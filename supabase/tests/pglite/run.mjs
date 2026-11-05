#!/usr/bin/env node
// Bundles suite.ts (TypeScript + the real edge function modules) with esbuild
// and runs it on Node. See README.md. Not picked up by vitest.
//
//   node supabase/tests/pglite/run.mjs            both migration sets
//   node supabase/tests/pglite/run.mjs 0047       only 0001..0047 + 0050
//   node supabase/tests/pglite/run.mjs 0049       only 0001..0050
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
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
});
try {
  const { main } = await import(pathToFileURL(out).href);
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
