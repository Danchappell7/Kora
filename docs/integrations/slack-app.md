# Kanbo for Slack: /kanbo, "Create a Kanbo task", link previews

The Kanbo Slack app lets people capture work where it's discussed:

- **`/kanbo <task>`** adds a task, read exactly like Quick capture:
  `/kanbo Send the brief fri 3pm #launch @sana !high ~2h` → due Friday at
  15:00, in the Launch project, assigned to Sana, high priority, a 2-hour
  estimate. `/kanbo help` explains the syntax; `/kanbo` on its own opens a form.
- **More actions › Create a Kanbo task** on any message opens a form prefilled
  from the message (title = its first line, description = its text and
  `From Slack: <link>`). The task keeps the message link (`tasks.slack_permalink`):
  a **From Slack** chip in the task opens it, and the API and webhooks carry it
  as `slackPermalink`.
- **Link previews**: a Kanbo task link (`https://www.kanbo.co.uk/?task=…`) or
  project link (`/p/…`) pasted in Slack shows its title, project, status,
  assignee and due date, with **Complete** and **Open in Kanbo**.
- **Home tab**: "Your tasks today" (due today or overdue) for linked people.

It is separate from the per-workspace Slack *channel* (Incoming Webhook,
`docs/integrations/slack.md`), which keeps posting stand-ups and status
updates. Both sit in **Settings › Calendar & integrations**.

## How it stays safe

- **Only Slack can call it.** Every request is checked against the app's
  Signing Secret before anything is read (v0 HMAC-SHA256 over
  `v0:<timestamp>:<raw body>`, constant-time comparison, rejected if the
  timestamp is more than 5 minutes from now). No secret configured → every
  request is refused.
- **A Slack user id means nothing until its owner links it.** An unlinked
  person only ever gets "Link your Kanbo account": a one-time link
  (`/link/slack?t=…`, 256-bit random, 15 minutes, single use, stored only as
  its SHA-256) that only they can see. Claiming it needs a signed-in, approved,
  active Kanbo account, and if the Slack account's email isn't the Kanbo
  account's (or Slack didn't share one) an explicit "This Slack account is
  mine", so a link someone else sends you can't quietly tie their Slack to your
  Kanbo.
- **Kanbo always acts as the linked person.** Every task read and write runs in
  a transaction as them (`SET LOCAL ROLE authenticated` + their JWT claims), so
  row-level security decides exactly as in the app, through the public API's
  own handlers (validation, automation rules, webhooks). Work is pinned to the
  Slack workspace's chosen Kanbo workspace (the API's "api key scope"
  policies) or the person's own Personal list. Guests and people outside the
  workspace can't add to it; previews only ever show what the sharer can see,
  and never personal tasks.
- **Where a Slack workspace's tasks go is its own owners' call.** Choosing
  the Kanbo workspace takes both sides: an owner or admin of the Slack
  workspace (Slack says so: `users.info`, checked when they link and again
  whenever they use `/kanbo` or open the app's Home tab) who is also an owner
  or admin of the Kanbo workspace. Anyone can make a Kanbo workspace of their
  own, so Kanbo rights alone never decide, and nobody can hold a Slack
  workspace by choosing first: a Slack owner or admin can always point it
  elsewhere. An owner or admin of the Kanbo workspace it points at can always
  set it back to Personal lists.
- **Secrets stay in function secrets.** `SLACK_BOT_TOKEN` and
  `SLACK_SIGNING_SECRET` live only in the slack-app function's secrets: never
  in the database, never in a reply, never in a log line.
- **Everything shown in Slack is escaped** (`&`, `<`, `>`), so a task title
  can't @channel, mention anyone or hide a link.
- **Rate limits** (0046's `api_rate_hit`): 20 commands, clicks and submissions
  a minute per Slack person, 120 picker searches and 60 events (checked first,
  linked or not), and 300 a minute per Slack workspace, which counts only
  linked people within their own limit: someone without a Kanbo account, or
  one person flooding, can't use up everyone else's share. Slack's resent
  events are dropped by event id.

Who can do what:

| | Owner / admin (linked in that Slack) | Member | Guest |
|---|---|---|---|
| Choose which Kanbo workspace a Slack workspace adds to | Only if they're also a Slack owner or admin there (whatever it points at now) | No | No |
| Set it back to Personal lists | Yes, when it points at their workspace (a Slack owner or admin: always) | No | No |
| `/kanbo`, the message shortcut, Assign to me, Complete, Undo | Yes | Yes | Personal list only |
| See link previews they share | Yes | Yes | Yes |
| Link / unlink their own Slack account | Yes | Yes | Yes |

## What it needs

- **Migration 0049** (`supabase/migrations/0049_slack_app.sql`): needs 0043,
  works with or without 0048. `slack_teams`, `slack_user_links`,
  `slack_link_requests`, `tasks.slack_permalink`, and the functions
  `slack_app_status`, `slack_app_set_default`, `slack_link_preview`,
  `claim_slack_link`. Re-runnable.
- **Migration 0046** (already run): `api_rate_hit`, `user_can_act`, and the
  public API the app's writes go through.
- **The `slack-app` edge function**, deployed with `--no-verify-jwt`.
- **Secrets**: `SLACK_BOT_TOKEN` (xoxb-…) and `SLACK_SIGNING_SECRET`. `APP_URL`
  is already set. Optional `SLACK_APP_TZ` (default `Europe/London`): the day
  "fri" counts from when Slack doesn't say the person's time zone.
- **The Slack app**, made from `docs/integrations/slack-app-manifest.json`
  (bot scopes `commands`, `chat:write`, `links:read`, `links:write`,
  `users:read`, `users:read.email`; no message history: the message link comes
  from `chat.getPermalink`, which needs no scope).
- **The web app** with the `/link/slack` page live on www.kanbo.co.uk before
  anyone clicks a link.

## Owner steps

The step-by-step version with copy boxes is in the owner guide. In short:

1. **Create the app**: <https://api.slack.com/apps> → **Create New App** →
   **From an app manifest** → your Slack workspace → paste
   `slack-app-manifest.json` → **Create** → **Install to Workspace**. (Slack
   says the events URL isn't verified yet: that's expected until step 4.)
2. **Set the two secrets** (Basic Information › **Signing Secret**; OAuth &
   Permissions › **Bot User OAuth Token**) with hidden prompts:

   ```zsh
   read -s "SUPABASE_ACCESS_TOKEN?Paste your Supabase token, then press Enter: " && echo && export SUPABASE_ACCESS_TOKEN && read -s "SLACK_BOT?Paste the Bot User OAuth Token (xoxb-…), then press Enter: " && echo && read -s "SLACK_SIGN?Paste the Signing Secret, then press Enter: " && echo && case "$SLACK_BOT" in xoxb-*) ;; *) echo "That isn't a bot token (it starts with xoxb-)."; false;; esac && [ ${#SLACK_SIGN} -ge 20 ] && supabase secrets set --env-file <(printf 'SLACK_BOT_TOKEN=%s\nSLACK_SIGNING_SECRET=%s\n' "$SLACK_BOT" "$SLACK_SIGN") --project-ref htnchiljplrnjkwimgla && echo "Slack secrets set."; unset SUPABASE_ACCESS_TOKEN SLACK_BOT SLACK_SIGN
   ```

3. **Apply 0049** (from the `kora-app` folder, linked to the project):

   ```zsh
   read -s "SUPABASE_ACCESS_TOKEN?Paste your Supabase token, then press Enter: " && echo && export SUPABASE_ACCESS_TOKEN && cd ~/Downloads/kora-app && supabase db query --linked -f supabase/migrations/0049_slack_app.sql && echo "0049 applied."; unset SUPABASE_ACCESS_TOKEN
   ```

4. **Deploy the function** (and `api` and `webhook-dispatch` again, so tasks
   made from Slack carry `slackPermalink` in the API and webhooks), then in
   the Slack app's **Event Subscriptions** page press **Retry** next to the
   request URL (it should say *Verified*):

   ```zsh
   read -s "SUPABASE_ACCESS_TOKEN?Paste your Supabase token, then press Enter: " && echo && export SUPABASE_ACCESS_TOKEN && cd ~/Downloads/kora-app && R=htnchiljplrnjkwimgla && supabase functions deploy slack-app --no-verify-jwt --project-ref $R --use-api && supabase functions deploy api --no-verify-jwt --project-ref $R --use-api && supabase functions deploy webhook-dispatch --no-verify-jwt --project-ref $R --use-api && echo "slack-app, api and webhook-dispatch deployed."; unset SUPABASE_ACCESS_TOKEN
   ```

5. **Link yourself and choose the workspace**: type `/kanbo` in Slack, follow
   the link, then in Kanbo **Settings › Calendar & integrations › Kanbo for
   Slack** choose the workspace under **Adds tasks to**. Only an owner or
   admin of the Slack workspace (who runs the Kanbo workspace) can choose; if
   someone chose before you, choose again: a Slack owner or admin always can.
   If Settings says you aren't one but you are, open the Kanbo app's **Home**
   tab in Slack once (Kanbo checks with Slack again) and reload Settings. The
   owner guide also has a one-line SQL fallback.
6. **Try it**: `/kanbo Try Kanbo from Slack tomorrow 10am`.

## Checking it

The migration ends with a `VERIFY` query (every column should be true). In
Slack: `/kanbo help` answers at once; an unlinked person gets the link prompt;
a pasted task link previews only for linked people who can see it.

If something's wrong, the function logs (Supabase dashboard › Edge Functions
› slack-app › Logs) say which step refused: `refused a request that isn't
signed by Slack` (the signing secret doesn't match), `views.open refused`
(usually `expired_trigger_id`: the form took more than 3 seconds to open),
`chat.unfurl refused` (the app isn't in that conversation, or the link isn't
on an unfurl domain). Slack's error words are logged; tokens and messages
never are.

## For developers

- `supabase/functions/slack-app/index.ts` wires the secrets, the database and
  Slack into `_shared/slackAppHandler.ts` (verify → route → gate → rate limit
  → work, answering Slack within 3 seconds: slow work finishes through
  `response_url` under `EdgeRuntime.waitUntil`).
- `_shared/slackAppVerify.ts` (signatures), `slackAppApi.ts` (the Web API:
  allow-listed methods, form-encoded, the token only in the header,
  `response_url` only on hooks.slack.com), `slackAppBlocks.ts` (every message,
  modal, unfurl and Home tab, escaped and within Slack's limits),
  `slackAppParse.ts` (Slack's escapes → the sentence, mentions → members by
  Slack email), `slackAppData.ts` (the two connections; writes through
  `api/handlers.ts`), `slackPermalink.ts` (the one rule for message links,
  the same as the database check).
- The natural-language grammar has one home: `_shared/nlp.ts`. The app's
  `src/lib/nlp.ts` re-exports it with the live "today" (`nlp.parity.test.ts`
  keeps them identical).
- App: `src/lib/slackApp.ts` (+ demo fakes), `src/lib/slackLinkToken.ts`
  (the link kept through signing in), `src/components/slack/`
  (`SlackAppPanel`, `SlackLinkPage`, `SlackSourceChip`).
- Tests: `_shared/slackApp*.test.ts` (vitest, a stubbed Slack Web API), and the
  PGlite replay of every migration with attacks and full flows
  (`scratchpad/pgtest-slack`: `slack0049.mjs`, `flows.mjs`).
