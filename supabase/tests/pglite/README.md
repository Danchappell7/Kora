# The MCP server against the real migrations

Runs the mcp edge function's code end to end, through the real pipeline and handlers, on
a database built from `supabase/migrations/*.sql` in PGlite (Postgres compiled to WebAssembly,
nothing to install and no real database touched). Supabase's auth schema, roles, storage,
vault, cron and net are stubbed in `harness.ts`.

```bash
export PATH="$HOME/.kora-tools/node-v20.18.1-darwin-arm64/bin:$PATH"
cd ~/Downloads/kora-app
node supabase/tests/pglite/run.mjs         # both migration sets
node supabase/tests/pglite/run.mjs 0047    # 0001..0047 + 0050 only (no 0048, no 0049)
node supabase/tests/pglite/run.mjs 0049    # 0001..0050 only
```

It takes a few seconds and exits non-zero if anything fails. Each set applies 0050 twice.

PGlite comes from `PGLITE_PATH` if that's set, otherwise from
`~/Downloads/standing-portal/node_modules/@electric-sql/pglite`. Anywhere else:

```bash
npm install --prefix /tmp/pglite @electric-sql/pglite
PGLITE_PATH=/tmp/pglite/node_modules/@electric-sql/pglite node supabase/tests/pglite/run.mjs
```

`suite.ts` has the legit flows first, then the attacks: code reuse, expired codes, the wrong
PKCE verifier, the wrong redirect, the wrong audience, refresh reuse, another person's data,
read-only enforcement, workspace pinning, suspended, revoked and deleted people, and migrating twice.

vitest doesn't pick these files up (none is named `*.test.*`). `metadata.test.ts` checks the
harness opens transactions exactly as the live `db.ts` does.
