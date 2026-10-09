/* sign_in_hints() lives in the repository as a one-off paste (supabase/sql/sign_in_hints.sql),
   not in a migration. Guards that the file stays the safe shape the PGlite suite checked
   (scratchpad/pgtest-w9), and that the owner doc pastes exactly that file. */
import { describe, it, expect } from "vitest";

const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;
const read = (p: string) => readFileSync(`${cwd()}/${p}`, "utf8");

/** SQL without comments or blank lines, whitespace evened out. */
const statements = (sql: string) =>
  sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").replace(/\s+/g, " ").trim();

const FILE = read("supabase/sql/sign_in_hints.sql");
const DOC = read("docs/integrations/google-sign-in.md");

describe("sign_in_hints() paste", () => {
  it("is a pinned-search-path definer that only reads, callable signed out", () => {
    const sql = statements(FILE);
    expect(sql).toMatch(/^create or replace function public\.sign_in_hints\(\) returns jsonb language sql security definer stable set search_path = public as \$\$/);
    expect(sql).toContain("case when count(*) = 1 then min(d.domain) end from public.approved_domains d");
    expect(sql).toContain("revoke execute on function public.sign_in_hints() from public;");
    expect(sql).toContain("grant execute on function public.sign_in_hints() to anon, authenticated, service_role;");
    expect(sql).not.toMatch(/\b(insert|update|delete|truncate|alter|drop)\b/i);
  });

  it("says it isn't a migration, and that the one auto-approved domain is public", () => {
    expect(FILE).toMatch(/ONE-OFF PASTE, not a migration/);
    expect(FILE).toMatch(/anon may call it/);
  });

  it("is what the owner doc tells people to paste", () => {
    const block = [...DOC.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => /create or replace function public\.sign_in_hints/.test(b));
    expect(block).toBeDefined();
    expect(statements(block!)).toBe(statements(FILE));
  });
});
