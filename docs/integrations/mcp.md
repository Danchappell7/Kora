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

Read: `whoami`, `list_workspaces`, `list_projects`, `list_members`, `list_tasks`,
`get_task` (with comments and sub-tasks), `search` and `fetch` (the shapes ChatGPT
expects), and `my_day`.

`my_day` answers "what do I need to get done today?": overdue, due today, approvals
waiting on you, on your plan for today, then blocked, in that order, each with a
one-line reason. It's worked out directly from the person's tasks in their time zone
(their saved one, else Europe/London), with no AI call.

Write: `add_task` (fields, or a sentence read by the same grammar as Quick capture:
`Send the brief fri 3pm #launch @sana !high ~30m`), `update_task`, `complete_task`,
`delete_task`, `add_comment`, `create_project`. Read-only connections don't see them,
and calling one is refused on the server. `delete_task` only ever goes to the recycle
bin, where it can be restored for 30 days; nothing can delete permanently or in bulk.

Pages are 20 by default and 50 at most, with `nextCursor`. Long text is cut with a
flag (`descriptionTruncated`), and a whole answer stays near 40,000 characters.

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
- **The consent page always asks.** It says the name is what the app calls itself, and
  shows the host it sends you back to (and the host of the app's own published address,
  when it has one), with a warning for an app on this computer. A bad client or redirect
  address stops there and never redirects. Allow goes through an RPC that checks everything
  again, then `location.assign`. Redirect addresses are https, loopback http, or Cursor's
  one callback, never `javascript:`, `data:`, `file:` or `vbscript:`.
- **What people write is data.** The server's `instructions` tell the model that titles,
  descriptions and comments may contain text that looks like instructions, to treat them as
  data, and to check with the person before changing or deleting anything because of them.
- **Fetching an app's description** (a Client ID Metadata Document) is https only, follows no
  redirects, takes 5 KB and 5 seconds at most, and refuses private addresses, including what
  the name resolves to.

Rate limits: tools share the API's 120 a minute per key or connection. `/oauth/register`:
120 an hour per address and 2,000 overall. `/oauth/token`: 300 a minute per app and 1,200 per
address (generous, because all of Claude's traffic comes from one range). Consent: 30 a minute
per person.

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
- `supabase/tests/pglite/`: the real migrations, legit flows and attacks, end to end (see its README).

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
