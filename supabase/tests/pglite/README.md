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
node supabase/tests/pglite/run.mjs 0047    # 0001..0047 + 0050..0056 (no 0048, no 0049)
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

0055 (shared capacity, working hours, time off, bill rates): you set your own week at a business and its
owners and admins set anyone's (a member, a guest and an outsider all try someone else's, and a guest has
none to set); the team reads everyone's week and its guests and outsiders don't; time off is the person's
in every business they're in, read by everyone who works beside them (never a guest or an outsider),
with the reason only for the person and the owners and admins of a business they're in; nobody but the
person or such a lead records, changes or takes back time off, and no two entries cover the same day
(the morning and afternoon of one day can); rates are read and set by owners and admins only, and a rate
can't be put on another business's project; a suspended person reads and saves nothing; nobody writes
the tables directly. Then 0055 twice and 0041 again.

0056 (meetings): a member starts the team meeting and the team reads it while its guests and outsiders
don't (and are never asked); a guest or outsider can't start one, a member can't start a leadership one,
and a team meeting covers one business; one live meeting of a kind at a time (one left 12 hours is closed
without a recap); a leadership meeting is its owners' and admins', and a Group one only theirs who lead
every business it covers; only the presenter moves the agenda, anyone in it can take over, nobody else
can; items are the team's, an action's owner is on the team (never a guest or outsider) and its task is
the host's; the notes doc is a doc in one of the host's projects; ending sends one recap to everyone asked
or there (never the ender, a guest, or someone who switched update notices off), and items still go in for
7 days; the next meeting carries the last one's actions (never another business's); deleting a meeting
takes its recaps; a suspended person reads and runs nothing; nobody writes the tables directly. Then 0056
twice and 0041 again.
