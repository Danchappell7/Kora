#!/usr/bin/env node
// Joins a run of migration files into ONE file the owner pastes into the
// Supabase SQL editor once, with a single check at the end.
//
//   node scripts/bundle-migrations.mjs 0051 0057            writes supabase/deploy/0051-0057_one_paste.sql
//   node scripts/bundle-migrations.mjs 0051 0057 --stdout   prints it instead (the drift test uses this)
//
// The SQL editor sends the whole paste as one request, which Postgres runs as one
// transaction: if any statement fails, nothing in the paste has happened. Each
// file's own "-- VERIFY" comment block becomes one column of the final check.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(root, "supabase", "migrations");

/** The VERIFY block's select, uncommented, without its closing semicolon. */
export function verifySelect(sql, file) {
  const at = sql.indexOf("-- VERIFY");
  if (at < 0) throw new Error(`${file} has no "-- VERIFY" block`);
  const lines = [];
  for (const line of sql.slice(at).split("\n").slice(1)) {
    if (/^-- ={10,}/.test(line)) break;
    if (!line.startsWith("--")) break;
    const body = line.replace(/^--\s?/, "");
    if (body.trim()) lines.push(body);
    // the select ends at its semicolon; any notes after it (0058 has some) aren't part of it
    if (/;\s*$/.test(body)) break;
  }
  const text = lines.join("\n").trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(text)) throw new Error(`${file}: its VERIFY block isn't a single select`);
  return text;
}

export function bundle(from, to) {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => f.slice(0, 4) >= from && f.slice(0, 4) <= to);
  if (!files.length) throw new Error(`no migrations between ${from} and ${to}`);
  const versions = files.map((f) => f.slice(0, 4));
  const parts = [];
  parts.push(`-- ============================================================
-- KANBO — database updates ${from} to ${to} in ONE paste.
-- Made by scripts/bundle-migrations.mjs from: ${files.join(", ")}.
-- Don't edit this file: change the migration files, then run
--   node scripts/bundle-migrations.mjs ${from} ${to}
--
-- Paste ALL of it into the Supabase SQL editor and press Run. It runs as one:
-- if anything stops it, nothing has changed. It's safe to run again.
-- The last result is ONE row: every column says true and "not true" says none.
-- ============================================================
`);
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    verifySelect(sql, f); // fail early if a block can't be read
    parts.push(`\n-- >>>>>>>>>> ${f} >>>>>>>>>>\n${sql.trimEnd()}\n-- <<<<<<<<<< end of ${f} <<<<<<<<<<\n`);
  }
  const ctes = files.map((f, i) => {
    const sel = verifySelect(readFileSync(join(MIGRATIONS, f), "utf8"), f).split("\n").map((l) => "    " + l).join("\n");
    return `  v${versions[i]} as (\n${sel}\n  )`;
  });
  const cols = versions.map((v) => `  (select bool_and(e.value = 'true'::jsonb) from v${v} v, jsonb_each(to_jsonb(v)) e) as "${v}"`);
  const misses = versions.map((v) => `    select '${v} ' || e.key as k from v${v} v, jsonb_each(to_jsonb(v)) e where e.value is distinct from 'true'::jsonb`);
  parts.push(`
-- ============================================================
-- CHECK: one row. Every column true, and "not true" = none.
-- ============================================================
with
${ctes.join(",\n")}
select
${cols.join(",\n")},
  (select coalesce(string_agg(k, ', '), 'none') from (
${misses.join("\n    union all\n")}
  ) m) as "not true";
`);
  return parts.join("");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [from, to, flag] = process.argv.slice(2);
  if (!/^\d{4}$/.test(from || "") || !/^\d{4}$/.test(to || "")) {
    console.error("usage: node scripts/bundle-migrations.mjs 0051 0057 [--stdout]");
    process.exit(2);
  }
  const out = bundle(from, to);
  if (flag === "--stdout") process.stdout.write(out);
  else {
    const dir = join(root, "supabase", "deploy");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${from}-${to}_one_paste.sql`);
    writeFileSync(file, out);
    console.log(`wrote ${file.slice(root.length + 1)}`);
  }
}
