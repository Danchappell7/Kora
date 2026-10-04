# Slack: stand-ups, status updates and risks in a Slack channel

Each team workspace can connect one Slack channel. Owners and admins paste a
Slack **Incoming Webhook** link in **Settings › Calendar & integrations ›
Slack**. Then:

- **Pulse** has **Post to Slack** for the stand-up.
- **Radar** has **Post to Slack** for the current risks.
- A project's **Updates** can post a status update (on track / at risk / off
  track) with a link back to the project.
- Owners and admins can have Kanbo **post the stand-up every weekday** at a
  time they choose (UK time).

The webhook link is a secret. Kanbo keeps it on the server
(`workspace_integrations`, migration 0043): once it's saved, nobody can read it
back from the app, owners included. The app only ever learns whether a channel
is connected and the channel name typed beside it.

Who can do what:

| | Owner / admin | Member | Guest |
|---|---|---|---|
| Connect, replace or disconnect the channel | Yes | No | No |
| Send a test message | Yes | No | No |
| Switch the daily stand-up on or off, change its time | Yes | No | No |
| Post a stand-up, status update or risks | Yes | Yes | No |
| See whether Slack is connected (and the channel name) | Yes | Yes | Yes |

Until these steps are done the app keeps working: Settings says Slack "isn't
switched on yet" and no **Post to Slack** buttons appear.

## What it needs

- **Migration 0043** (see `docs/integrations/database-0043.md`). It creates
  `workspace_integrations` and the `slack_status` / `slack_connect` /
  `slack_disconnect` / `slack_set_autopost` functions.
- **Migration 0042** for the `rate_limits` table (already run). Without it the
  limits below are skipped, nothing breaks.
- The **`APP_URL`** and **`CRON_SECRET`** secrets. Both are already set for the
  reminder emails (DEPLOYMENT.md, step 3). Nothing new to add.
- No Slack secret is set by you on the server: each workspace's webhook link
  is pasted into Kanbo by that workspace's owner or admin.

## Owner steps

### 1. Deploy the two functions

From the `kora-app` folder (the same way as the other functions in
DEPLOYMENT.md, with your access token):

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy slack-post --project-ref htnchiljplrnjkwimgla
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy slack-standup --no-verify-jwt --project-ref htnchiljplrnjkwimgla
```

- `slack-post` keeps **Verify JWT** on (it's in `supabase/config.toml`): only
  signed-in people can call it, and it checks their role in the workspace
  itself.
- `slack-standup` has **Verify JWT** off: only the scheduler calls it, with the
  `x-cron-secret` header. Anyone else gets `401`.

### 2. Schedule the daily stand-up

In the SQL editor
(<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>), paste
each box and press **Run**.

**2a. Check the scheduler and the Vault secret are there.** They were set up
for the reminder email (DEPLOYMENT.md, step 5). Both rows should say `true`:

```sql
select
  exists (select 1 from pg_extension where extname = 'pg_cron') as pg_cron_on,
  exists (select 1 from pg_extension where extname = 'pg_net')  as pg_net_on,
  exists (select 1 from vault.secrets where name = 'kanbo_cron_secret') as cron_secret_in_vault;
```

If any is `false`, do DEPLOYMENT.md steps 5a and 5c first.

**2b. Schedule it every 15 minutes.** The function works in UK time itself
(summer and winter), skips weekends, and posts each workspace once a day at
the first run after its chosen time, so there's nothing to adjust for BST.

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'kanbo-slack-standup';

select cron.schedule(
  'kanbo-slack-standup',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://htnchiljplrnjkwimgla.supabase.co/functions/v1/slack-standup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kanbo_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
```

(The first line says "0 rows" the first time. That's fine.)

**2c. Check it after 15 minutes.** The latest `status` should be `succeeded`:

```sql
select start_time, status, return_message
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'kanbo-slack-standup')
order by start_time desc limit 5;
```

The function's logs are at
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions/slack-standup/logs>.
A quiet run returns `{"due":0,"posted":0}`; at the weekend `{"note":"weekend"}`.
A `401` means the Vault secret and the `CRON_SECRET` secret don't match (redo
DEPLOYMENT.md step 5c with the exact same string).

### 3. Connect a channel (each workspace's owner or admin does this)

In Slack:

1. Open <https://api.slack.com/apps> and choose **Create New App › From
   scratch**. Name it **Kanbo**, pick the Slack workspace and choose **Create
   App**.
2. Optional: under **Basic Information › Display Information**, add the Kanbo
   icon and a short description ("Stand-ups and project updates from Kanbo").
3. Under **Features › Incoming Webhooks**, switch **Activate Incoming
   Webhooks** on.
4. Choose **Add New Webhook to Workspace** at the bottom, pick the channel,
   then **Allow**.
5. Copy the **Webhook URL** (`https://hooks.slack.com/services/T…/B…/…`).
   Treat it like a password: anyone with it can post to that channel.

In Kanbo:

6. Switch to the team workspace, open **Settings › Calendar & integrations**
   and find **Slack**.
7. Paste the link, type the channel name (for example `team-updates`, shown as
   `#team-updates`) and choose **Connect**.
8. Choose **Send test**. A "Kanbo is connected" message should appear in the
   channel within a few seconds.
9. Optional: switch on **Post the stand-up every weekday** and pick a time.

To post to a different channel, choose **Replace** and paste a new link. To
stop, choose **Disconnect**: Kanbo forgets the link and the daily stand-up
stops. If the link may have leaked, also remove the webhook in Slack (the
app's **Incoming Webhooks** page): until then anyone holding it can still post
to that channel, though not through Kanbo.

### 4. Check a stand-up without waiting (optional)

Find the workspace's id:

```sql
select w.id, w.name, i.slack_channel_label, i.slack_autopost, i.slack_autopost_time
from public.workspaces w join public.workspace_integrations i on i.workspace_id = w.id
where i.slack_webhook_url is not null;
```

Then post its stand-up now (replace both placeholders; this doesn't use up
the day's automatic post):

```bash
curl -X POST https://htnchiljplrnjkwimgla.supabase.co/functions/v1/slack-standup \
  -H "x-cron-secret: <CRON_SECRET>" -H "Content-Type: application/json" \
  -d '{"workspaceId":"<workspace id>","force":true}'
```

It answers `{"due":1,"posted":1,…}` and the stand-up appears in the channel.

## How it behaves

- **Messages** use Slack's Block Kit: a heading, the words in sections, and a
  footer line "Posted from Kanbo by <name> · <workspace> · Open in Kanbo"
  linking to `APP_URL/team/pulse` (stand-ups and risks) or `APP_URL/p/<id>`
  (status updates). The daily post says "Posted automatically by Kanbo".
- **Safety**: everything people write is escaped, so a post can't `@channel`,
  `@here`, mention anyone or hide a link. Text is capped (12,000 characters,
  then "Cut short to fit Slack"), and Slack's own limits are kept (headings
  150 characters, sections 3,000, 50 blocks). The stored link is checked
  against `https://hooks.slack.com/services/…` before every request, and
  redirects are never followed.
- **Limits**: a test message 3 times a minute per workspace; posts 10 per 10
  minutes per person and 30 an hour per workspace. Over that, people see "Try
  again in N minutes".
- **The daily stand-up** is written on the server from the workspace's tasks
  (what was finished since the last workday, what's in progress, due today,
  overdue and blocked, per person; people with nothing to report are left
  out). It follows Pulse closely but isn't word for word the same. It's
  posted Monday to Friday, once a day, at the first run at or after the chosen
  time (so up to 15 minutes later). Times offered are 06:00 to 20:00 in
  15-minute steps.

## If something's wrong

| What people see | Why | What to do |
|---|---|---|
| Settings: "Not switched on yet" | Migration 0043 hasn't been run | Run it (`database-0043.md`) and reload |
| "Posting to Slack isn't switched on yet." | `slack-post` isn't deployed | Step 1 |
| "Slack no longer accepts this webhook link…" | The webhook was removed in Slack, or the Slack app was uninstalled | An owner/admin chooses **Replace** with a new link (step 3) |
| "That Slack channel has been archived…" | The channel was archived | Connect another channel |
| "Your Slack admins don't allow posts to that channel." | The Slack workspace restricts posting there | Pick another channel |
| "That's a lot of posts in a short time…" | One of the limits above | Wait and try again |
| No daily stand-up | The job isn't scheduled, the time hasn't come yet, it's the weekend, or it already posted today | Step 2c; check `slack_autopost` and `slack_autopost_time` with the query in step 4 |
