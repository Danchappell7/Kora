# The MCP server against the real migrations

Runs the mcp edge function's code end to end, through the real pipeline and handlers and the
real database driver, on a database built from `supabase/migrations/*.sql` in PGlite (Postgres
compiled to WebAssembly, nothing to install and no real database touched). Supabase's auth schema,
roles, storage, vault, cron and net are stubbed in `harness.ts`.

Requests go through postgres@3.4.5 and `db.ts`'s `createApiDb`, the same as live, over the wire
protocol into PGlite (`driver.ts`). PGlite's own `query()` is kinder to parameters than the driver
is, and a suite using it passed while registration, `add_task` and the REST API's `POST /tasks`
were all broken. Test data is still set up with PGlite directly.

```bash
export PATH="$HOME/.kora-tools/node-v20.18.1-darwin-arm64/bin:$PATH"
cd ~/Downloads/kora-app
node supabase/tests/pglite/run.mjs         # both migration sets
node supabase/tests/pglite/run.mjs 0047    # 0001..0047 + 0050 only (no 0048, no 0049)
node supabase/tests/pglite/run.mjs 0049    # 0001..0050 only
```

It takes a few seconds and exits non-zero if anything fails. Each set applies 0050 twice.

PGlite comes from `PGLITE_PATH` if that's set, otherwise from
`~/Downloads/standing-portal/node_modules/@electric-sql/pglite`. postgres@3.4.5 comes from
`POSTGRES_PATH` if that's set, otherwise from Deno's cache. Anywhere else:

```bash
npm install --prefix /tmp/pglite @electric-sql/pglite postgres@3.4.5
PGLITE_PATH=/tmp/pglite/node_modules/@electric-sql/pglite POSTGRES_PATH=/tmp/pglite/node_modules/postgres node supabase/tests/pglite/run.mjs
```

`suite.ts` has the legit flows first, then the attacks: code reuse, expired codes, the wrong
PKCE verifier, the wrong redirect, the wrong audience, refresh reuse (and parallel refreshes whose
answers arrive in any order, which mustn't look like it), another person's data,
read-only enforcement, workspace pinning, suspended, revoked and deleted people, and migrating twice.
Then what a model would actually do (a backlog in `my_day`, editing a long description, the newest
comment on a thread, a forged author, repeating and blocked tasks, handing a task on, `@names`,
writes in a loop), then what a stranger can do with no credentials (flooding the token endpoint,
made-up address headers, filling the registrations table, probing a network through an app's description,
and an app coming back days later with the `client_id` it remembers).

vitest doesn't pick these files up (none is named `*.test.*`). `metadata.test.ts` checks the
harness opens transactions exactly as the live `db.ts` does.
