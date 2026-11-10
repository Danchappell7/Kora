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
node supabase/tests/pglite/run.mjs         # every migration set
node supabase/tests/pglite/run.mjs 0047    # 0001..0047 + 0050..0058 (no 0048, no 0049)
node supabase/tests/pglite/run.mjs 0049    # every migration
node supabase/tests/pglite/run.mjs 0058    # 0001..0050 + 0058, then 0051..0057 after it
node supabase/tests/pglite/run.mjs 0050    # 0001..0050: the edge functions as they'll run before 0058
```

It takes a minute or two and exits non-zero if anything fails. Each full set applies 0050 twice.

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

0057 (rolling Kanbo out): a workspace's owners and admins see who's been active this week, by day and never
a time of day (a member, a guest, an outsider and a suspended admin are refused, and nobody reads another
person's sessions); join dates are the server's (set when an invite is claimed, never by hand); the rollout
plan is set by owners and admins only, its champion and pilot group are members (never a guest or an
outsider), and any other shape is refused by the function and by the column. Provisioning a business is a
platform admin's alone (a workspace owner, a member, a guest, an outsider, someone who sets their own
is_admin flag and a suspended admin all try): it never approves a public mail domain, a bad address or
junk, and nothing is half made. workspace_handovers has no client access. When the invited owner joins,
the business is theirs (owner, project owners, open tasks, goals); someone else joining doesn't take it, and
an owner chosen by hand stays. Then 0057 twice, and 0041 and 0042 again (a handover still works).

0058 (project access, `projectAccess.ts`): one world of a workspace's owner, an admin, four members (an
editor, a commenter, a viewer and one on nothing), three guests, a removed member and a suspended one (each
with a stale editor row) and an outsider, four projects (Whole workspace, Members only, Private, and a
Private one a member owns) and two loose tasks, each with everything that hangs off a project. One battery
reads and writes every path as every person (every table, the helpers, live channels, search, the people a
guest sees, the calendar feed); the model is `src/lib/projectAccessMatrix.json`, the same rank table the
app's tests use. On the live database (0001..0050) the battery runs first; with 0058 in and the switch off it
must give exactly the same answers, with it on exactly the model's, and off again exactly the first run's.
Then the switch (owner only), new projects and visibility, project people and invites, the contributor_ids
mirror, owner changes, assignees, sub-tasks, docs, approvals, kudos, update replies and Asks, goal links,
Notion, rates, asks, form links, meeting agendas, the bin and the history, the Inbox, held notices and
webhooks, a published-table and a security-definer audit, VERIFY, 5 000 tasks behind the switch, 0058
twice, the undo file, every older file run again, and 0051..0057 applied after 0058. MCP and the REST API
(an API key) get their own checks on the shared world.

The edge functions' own project access (wave 4, stage B), on both full sets with the switch off, on and off
again: `_shared/projectAccess.ts`'s service checks over the SQL driver follow the rank table; the API's rank
for a colleague (`personRankSql`, worked out as the caller) equals `pa_rank_for` for every person and project,
read as the owner and as a viewer; the REST API's answers on writing into a project, commenting, assignees,
rules' assignees, moves, a repeating task's next occurrence, the database's own assignee refusal and
`visibility`; MCP's @mentions; the Slack app's neutral link cards; and the real webhook dispatcher
(`runDispatch`) sending a private project's event only to the endpoint whose viewer can see it. A last set,
0001..0050 (`run.mjs 0050`), runs the legit and attack flows on the live database with those changes in, and
shows every check answers today's rule there.
