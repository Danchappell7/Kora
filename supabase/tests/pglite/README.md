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
node supabase/tests/pglite/run.mjs 0047    # 0001..0047 + 0050..0054 + 0058 (no 0048, no 0049)
node supabase/tests/pglite/run.mjs 0049    # every migration
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
and an app coming back days later with the `client_id` it remembers). Last, 0051: a guest can't
read a team's goals or portfolios by any query while a member still can (personal rows untouched,
and the guest still reads the team's status updates), no function a signed-in person can call hands
them back, an update's author can't be forged, re-pointed or blanked and empties when the account is
deleted, and re-running 0051 or 0041 keeps the lock. Then 0052's goals: a member can't set a company goal
or edit or delete a goal they don't own or help with, a contributor can't hand one over, owners and
contributors are members (never guests or outsiders), a leadership-only goal and its check-ins and links
are hidden from members, a check-in's author, time and value can't be forged or changed later (taking
back the only one puts the value before it back), a link or a goal's project never reaches another
workspace (server-side either), a member can't delete a goal with key results under it (they'd become
company goals), periods, cycles, deleted accounts and parents, a team API key's scope, the backfill, and
re-running 0052, 0041 or 0048 keeps every rule and goals in search.

vitest doesn't pick these files up (none is named `*.test.*`). `metadata.test.ts` checks the
harness opens transactions exactly as the live `db.ts` does.

0054 (project updates people reply to, portfolio pages): only an update's author edits it, and only
the author or the workspace's owners and admins delete it (an owner, an admin, another member, a
guest and an outsider all try); a team update can't be about another workspace's project; sections
and Asks keep their shape, and an Ask names only people who can read the update; posting and
commenting tell exactly the owner, contributors, the asked and the mentioned; comments, reactions
and "seen by" follow who can read the update (a guest comments and reacts, an outsider reads
nothing, a forged author or reaction is refused or ignored, and only the function records a view);
webhooks get status_update.posted; a portfolio's owner and followers come from its members, and
portfolio updates are for members only. Then 0054 twice, 0041 again (the authors-only rules come
back) and 0048 again (a webhook subscribed to status_update.posted keeps working).

0058 (rolling Kanbo out): a workspace's owners and admins see who's been active this week, by day and never
a time of day (a member, a guest, an outsider and a suspended admin are refused, and nobody reads another
person's sessions); join dates are the server's (set when an invite is claimed, never by hand); the rollout
plan is set by owners and admins only, its champion and pilot group are members (never a guest or an
outsider), and any other shape is refused by the function and by the column. Provisioning a business is a
platform admin's alone (a workspace owner, a member, a guest, an outsider, someone who sets their own
is_admin flag and a suspended admin all try): it never approves a public mail domain, a bad address or
junk, and nothing is half made. workspace_handovers has no client access. When the invited owner joins,
the business is theirs (owner, project owners, open tasks, goals); someone else joining doesn't take it, and
an owner chosen by hand stays. Then 0058 twice, and 0041 and 0042 again (a handover still works).
