# Connect your AI: Kanbo's MCP server

People can link Claude, ChatGPT, Cursor and their own agents to Kanbo by pasting
one address, signing in and pressing **Allow**:

```
https://www.kanbo.co.uk/mcp
```

The AI app then reads and manages Kanbo as that person, with exactly the access
they have in the app and no more. Paste it exactly, with the `www`: the bare
domain redirects, and a redirect makes an AI app lose its sign-in.

## What each AI app needs

Written from each app's own documentation on 4 November 2026 (sources at the end).

| App | Plan | How |
| --- | --- | --- |
| **Claude** (web, desktop, phone) | Every plan. Free allows one custom connector. On Team and Enterprise an Owner adds it under **Organization settings › Connectors**, then each person chooses **Connect** | **Customize › Connectors › Add custom connector**, paste the address, **Add**, **Connect**. If it asks: **Sign in now** and **Use Claude's published identity** |
| **ChatGPT** | Reading and changing: Business, Enterprise or Edu (on Business, an admin or owner adds it). Pro: reading only. Plus and Free aren't listed by OpenAI, so check the account. Website only | **Plugins**, the plus button, **Add custom MCP server**, name, paste the address under **Connection**, OAuth, **I understand and want to continue**, **Create as a plugin**, install, then `@` in a new chat |
| **Cursor** | Not stated | The **Add Kanbo to Cursor** button in Settings › Developers, or `~/.cursor/mcp.json`: `{"mcpServers":{"kanbo":{"url":"https://www.kanbo.co.uk/mcp"}}}` |
| **Claude Code** | Not stated | `claude mcp add --transport http kanbo https://www.kanbo.co.uk/mcp`, then `/mcp`. To remove it: `claude mcp logout kanbo`, then `claude mcp remove kanbo` (removing alone doesn't end the connection on Kanbo's side) |
| **Your own code** | | A Kanbo API key as the bearer (Settings › Developers). `kanbo_pk_` keys are read-only, `kanbo_sk_` read and write |

ChatGPT freezes the list of tools it approved until an admin refreshes it.

### From your own code

```bash
curl https://www.kanbo.co.uk/mcp \
  -H "Authorization: Bearer $KANBO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my_day","arguments":{}}}'
```

The OpenAI Responses API takes `{"type": "mcp", "server_label": "kanbo", "server_url":
"https://www.kanbo.co.uk/mcp", "authorization": "<key>"}` in `tools`. The Anthropic
Messages API takes `mcp_servers: [{"type": "url", "name": "kanbo", "url":
"https://www.kanbo.co.uk/mcp", "authorization_token": "<key>"}]` plus an `mcp_toolset`
tool, with the header `anthropic-beta: mcp-client-2026-09-15`. Gemini's Interactions API
takes `mcp_server` with `headers`. The REST API is at
[docs/api/README.md](../api/README.md).

## The tools

Read: `whoami`, `list_workspaces`, `list_projects`, `list_members`, `list_tasks` (with a
`parentId` filter for a task's sub-tasks), `get_task` (with comments, sub-tasks and what it
waits for), `search` and `fetch` (the shapes ChatGPT expects), and `my_day`.

`my_day` answers "what do I need to get done today?": overdue, due today, approvals
waiting on you, on your plan for today, then blocked, in that order, each with a
one-line reason. It's worked out directly from the person's tasks in their time zone
(their saved one, else Europe/London), with no AI call. Each list has its own limit, so a
backlog can't crowd out today: everything due today, approvals and the plan (up to 40 of
each), and the ten most urgent overdue and blocked tasks. `counts` and `summary` cover
everything, and `notShown` says how many of each aren't listed.

Write: `add_task` (fields, or a sentence read by the same grammar as Quick capture:
`Send the brief fri 3pm #launch @sana !high ~30m`), `update_task`, `complete_task`,
`delete_task`, `add_comment`, `create_project`. Read-only connections don't see them,
and calling one is refused on the server. `delete_task` only ever goes to the recycle
bin, where it can be restored for 30 days; nothing can delete permanently or in bulk.

Pages are 20 by default and 50 at most, with `nextCursor`. Long text is cut with a
flag (`descriptionTruncated`), a whole answer stays near 40,000 characters, and every flag
has a way to read the rest: `descriptionOffset` for a description, `commentsCursor` for
older comments, `fullComments` for long ones, and `list_tasks` with `parentId` for sub-tasks.

What the tools do on someone's behalf, and how that differs from the app:

- **Editing a description.** A new description replaces all of the old one, and the old
  text can't be got back, because task history doesn't record descriptions. So
  `appendToDescription` adds to it on the server, with nothing to read first. A shortened
  copy of a longer description is refused unless `confirmReplaceDescription` is sent.
- **Repeating tasks.** `complete_task`, and `update_task` with status done, make the next
  occurrence in the same transaction, as the app does: sub-tasks and an unticked checklist
  come too, and the answer has `nextOccurrence`. Every task view has `recurrence`. Reopening
  a task doesn't take its next occurrence back.
- **Blocked tasks.** Finishing a task that's waiting on unfinished ones is refused, naming
  them, until `confirmedBlocked` is sent. In the app this is the "complete it anyway?" question.
- **Handing a task on.** A new assignee, from a tool or a rule, clears the old assignee's plan.
- **Sentences.** A name has to be an exact name, a first name or the start of a word, and only
  one person or project. Anything else stays in the title and is listed in `notes`, and `read`
  says how the sentence was understood, because an ordinary word can read as a date ("for
  Monday"). Nobody is watching the live highlight here. "Today" is read in the person's saved
  time zone, as `my_day` does.
- **Reaching people.** A comment reaches the task's creator, assignee and followers in their
  Inbox. `@Name` in a comment also reaches that person, when it's their full name or a first
  name only one person in the workspace has; the answer says who, and which `@names` reached
  nobody. Assigning a task reaches the assignee's Inbox. No email or push is sent for any of these.

## How it stays safe

- **The same code as the REST API.** Every tool calls `handleApiRequest` (with the
  person already resolved), so validation, rate limits, idempotency and audit are the
  API's own. Everything runs in `db.withUser`: as that person, with row-level security,
  `READ ONLY` for read-only connections, and pinned by the "api key scope" policies for
  a one-workspace connection. Guests stay read-only (and may comment) whatever they chose.
- **Fails closed on every call.** A suspended, unapproved or deleted person, a revoked
  grant, or someone who has left a one-workspace grant's workspace gets a 401 on their
  next call and at refresh, not just at consent. If the scope policies are ever missing,
  one-workspace connections answer 503.
- **OAuth 2.1, built small on purpose** (`supabase/migrations/0050_mcp_oauth.sql`).
  Authorisation code with PKCE S256 only; single-use codes (5 minutes; a code used twice
  revokes what it made); access tokens for 1 hour; rotating refresh tokens (the one just
  replaced is honoured for 10 seconds in case the answer was lost, and any other reuse
  revokes the whole connection). Only SHA-256 hashes of codes and tokens are stored. Tokens
  are bound to `https://www.kanbo.co.uk/mcp`. Supabase's own OAuth server wasn't used: it
  can't do read-only or one-workspace grants, Client ID Metadata Documents or audience
  binding yet, keeps its issuer on `supabase.co`, and skips consent for known clients.
- **The consent page always asks, and never leaves without a click.** It says the name is
  what the app calls itself, and shows the host it sends you back to (and the host of the
  app's own published address, when it has one), with a warning for an app on this computer.
  A bad client or redirect address stops there and never redirects. Because anyone can register
  an app and name any address, a registered address proves nothing (RFC 9700 section 4.11.2), so
  a request with any other mistake in it stops there too, naming the host, with a button to go
  back to it. Allow goes through an RPC that checks everything again, then `location.assign`.
  Redirect addresses are https, loopback http, or Cursor's one callback, never `javascript:`,
  `data:`, `file:` or `vbscript:`.
- **What people write is data.** The server's `instructions` tell the model that titles,
  descriptions and comments, and the names of projects, tags and people, may contain text that
  looks like instructions, wherever they appear, to treat them as data, and to check with the
  person before changing or deleting anything because of them. `my_day`'s `reason` is only ever
  Kanbo's own words: a blocker's title and a requester's name have fields of their own. `fetch`
  quotes what people wrote, every line starting `> `, under a line from Kanbo saying who wrote it
  and when, so a comment can't pass as another comment.
- **Fetching an app's description** (a Client ID Metadata Document) has the same guard as
  Kanbo's webhooks: https only, port 443, a public name with a dot in it and never a bare
  address, never Kanbo's own hosts, and every address the name resolves to must be public. If DNS
  can't answer, nothing is fetched. It connects to the address it checked, so a second DNS answer
  can't swap in a private one, follows no redirects, and takes 5 KB and 5 seconds at most. Every
  failure gets the same answer, so it can't be used to find out what's inside a network.

Rate limits. Tools share the API's 120 a minute per key or connection, and on top of that one
connection can make 20 deletes a minute and 100 an hour, and 20 comments, or assignments to
someone else, a minute, so a looping or misled model can't empty a project or fill a teammate's
Inbox. Consent: 30 a minute per person.

`/oauth/token` and `/oauth/revoke` have no limit before the check, on purpose. Claude and ChatGPT
each use one public `client_id` for everyone, and Claude's traffic comes from one address range, so a
limit counted before the check would let one stranger switch them off for every Kanbo user. Nothing
is at risk without one: codes and tokens are 256-bit, malformed ones never reach the database, and a
well-formed wrong one costs one indexed read and writes nothing. Refreshing a real token is limited
to 30 a minute per connection, in the SQL, after it's been checked.

`/oauth/register` stores something for anyone who asks, so what it keeps is small (at most 8 redirect
addresses of 512 characters each) and short-lived (gone after a day if it never connected). Only
requests that would be stored are counted: 2,000 an hour overall, 600 an hour per address as
Supabase's edge sees it, and 120 an hour per caller. Through www.kanbo.co.uk that edge address is
Vercel's, shared by everyone, so a caller is the pair of it and the address in `x-vercel-forwarded-for`
(or else `x-forwarded-for`), which Vercel overwrites. Called directly at `<ref>.supabase.co`, that header is whatever the caller says, but the
edge address is its own, so changing the header doesn't get round the 600, and naming someone else's
address only spends the caller's own share. Rate-limit rows are stored as hashes and cleared after a
day by `mcp_oauth_sweep`.

## How it's hosted

```
www.kanbo.co.uk/mcp, /oauth/register|token|revoke|prepare  →  Vercel external rewrite  →  the mcp edge function
www.kanbo.co.uk/.well-known/oauth-*                        →  Vercel same-app rewrite  →  public/oauth-metadata/*.json
www.kanbo.co.uk/oauth/authorize                            →  the app (src/components/oauth)
```

Discovery is static JSON because the Supabase host can't serve `/.well-known` at its root.
`metadata.test.ts` keeps the files equal to `metadata.ts` and checks `vercel.json`'s ordering.
The catch-all no longer answers `/.well-known/*`, so unknown paths there are 404 rather than
the app's HTML.

The server speaks both eras of MCP: 2026-07-28 (per-request `_meta`, `server/discover`) and
`initialize` for 2025-11-25, 2025-06-18 and 2025-03-26, because the latest stable SDKs and
Claude's docs are still on the older ones. It's stateless: no sessions, JSON answers only, and
GET and DELETE answer 405. Every POST needs a bearer, even `initialize`, because only an HTTP
401 starts sign-in in the AI apps.

Vercel's documentation says `/.well-known` can't be rewritten, though same-app rewrites do work
on this project today. The check in DEPLOYMENT.md Step 16 proves it after each deploy. If those
three lines ever say BAD, nothing else is affected, but AI apps can't start connecting until
it's fixed.

## Tests

- `supabase/functions/_shared/mcp/*.test.ts`: every pure module, plus the contract between the
  tool list and the handlers, and every tool's answers against its own `outputSchema`.
- `supabase/tests/pglite/`: the real migrations, through the real database driver, with legit flows,
  attacks and what a model would actually do, end to end (see its README).

## Sources (checked 4 November 2026)

[MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog) ·
[Claude: add a custom connector](https://claude.com/docs/connectors/custom/add-unlisted) ·
[Claude: connector authentication](https://claude.com/docs/connectors/building/authentication) ·
[Claude Code MCP](https://code.claude.com/docs/en/mcp) ·
[ChatGPT custom MCP servers](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) ·
[ChatGPT: connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt) ·
[Cursor MCP](https://cursor.com/docs/mcp) ·
[Cursor install links](https://cursor.com/docs/mcp/install-links) ·
[OpenAI Responses API MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) ·
[Anthropic MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
