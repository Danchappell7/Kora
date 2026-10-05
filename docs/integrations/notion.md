# Notion: import databases, sync both ways, link pages to tasks

Each team workspace can connect one Notion workspace. An owner or admin
pastes a Notion **internal integration** secret in **Settings › Calendar &
integrations › Notion**. Then:

- **Import a Notion database** into a project (an existing one, or a new one
  with its own icon and colour), with a preview of the first five pages and a
  say over which Notion field feeds which Kanbo field.
- **Keep it in sync**, both ways or from Notion only. Kanbo checks every 10
  minutes; owners and admins can also choose **Sync now**.
- **Link any Notion page to a task.** The task shows a chip with the page's
  icon, title and when it was last edited, and opens it in Notion.

The secret is server-only (`workspace_integrations.notion_token`, migration
0046): once saved, nobody can read it back from the app, owners included.
Owners and admins see its last four characters.

Who can do what:

| | Owner / admin | Member | Guest |
|---|---|---|---|
| Connect, test, replace or disconnect Notion | Yes | No | No |
| Import a database, set up / pause / remove a sync, Sync now | Yes | No | No |
| Link a Notion page to a task (and unlink their links) | Yes | Yes | No |
| Unlink a page that a sync manages | Yes | No | No |
| See the connection, the syncs and the page chips | Yes | Yes | Yes |

Until the steps below are done the app keeps working: Settings says Notion
"isn't switched on yet" and tasks show no Notion section.

## What it needs

- **Migration 0046** (`docs/integrations/database-0046.md`). It adds the token
  column, `notion_status` / `notion_connect` / `notion_disconnect` /
  `notion_save_sync` / … and the `notion_syncs`, `notion_links` and
  `notion_page_cache` tables.
- The **`notion`** edge function (step 1). It needs no new secret:
  `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_DB_URL` are injected, and
  `CRON_SECRET` is already set for the reminder emails.
- One new Vault entry for the 10-minute schedule: the project's **anon** key
  (step 2b). It's public (the app ships it), but the schedule needs it to
  get past the gateway's JWT check.

## Owner steps

### 1. Deploy the function

From the `kora-app` folder, with your access token:

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy notion --project-ref htnchiljplrnjkwimgla
```

It keeps **Verify JWT** on (`supabase/config.toml`): only signed-in people and
the schedule (with the anon key and the cron secret) get through.

### 2. Schedule the sync every 10 minutes

Open the SQL editor:
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>, paste
each box and press **Run**.

**2a. Check the scheduler and the cron secret are there** (set up for the
reminder email, DEPLOYMENT.md step 5). Every column should say `true`:

```sql
select
  exists (select 1 from pg_extension where extname = 'pg_cron') as pg_cron_on,
  exists (select 1 from pg_extension where extname = 'pg_net')  as pg_net_on,
  exists (select 1 from vault.secrets where name = 'kanbo_cron_secret') as cron_secret_in_vault,
  exists (select 1 from vault.secrets where name = 'kanbo_anon_key')    as anon_key_in_vault;
```

The last one is `false` until 2b. If any of the first three is `false`, do
DEPLOYMENT.md steps 5a and 5c first.

**2b. Put the anon key in the Vault (once).** Copy the **anon public** key
from <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/settings/api-keys>
(the **Legacy API keys** tab; it starts with `eyJ`), paste it between the
quotes and run:

```sql
select vault.create_secret('<paste the anon public key here>', 'kanbo_anon_key');
```

**2c. Schedule it.**

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'kanbo-notion-sync';

select cron.schedule(
  'kanbo-notion-sync',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://htnchiljplrnjkwimgla.supabase.co/functions/v1/notion',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kanbo_anon_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kanbo_cron_secret')
    ),
    body := '{"mode":"sync"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
```

(The first line says "0 rows" the first time. That's fine.)

**2d. Check it after 10 minutes.** The latest `status` should be `succeeded`:

```sql
select start_time, status, return_message
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'kanbo-notion-sync')
order by start_time desc limit 5;
```

and the function's answers should be `200` with `{"ok":true,"due":…,"ran":…}`:

```sql
select created, status_code, left(content::text, 200) as answer
from net._http_response order by created desc limit 5;
```

A `401` with `{"error":"unauthorized"}` means the Vault's `kanbo_cron_secret`
and the `CRON_SECRET` secret don't match (redo DEPLOYMENT.md step 5c with the
same string). A `401` mentioning a JWT means `kanbo_anon_key` isn't the anon
key (redo 2b: delete it in **Project Settings › Vault** first). Logs:
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions/notion/logs>.

### 3. Connect Notion (each workspace's owner or admin)

In Notion:

1. Open <https://www.notion.so/profile/integrations> and choose **New
   integration**. Name it **Kanbo**, pick the Notion workspace and keep the
   type **Internal**. Save.
2. Under **Capabilities**, tick **Read content**, **Update content** and
   **Read user information including email addresses** (this is how Notion
   people are matched to Kanbo members). Save.
3. Copy the **Internal Integration Secret** (it starts with `ntn_`; older
   ones start with `secret_`). Treat it like a password.
4. Share what Kanbo should see: open each database (or a parent page) and
   choose **•••** › **Connections** › **Kanbo**. Sharing a page shares
   everything inside it.

In Kanbo:

5. Switch to the team workspace, open **Settings › Calendar & integrations**
   and find **Notion**.
6. Paste the secret and choose **Connect**. Kanbo checks it with Notion first;
   the Notion workspace's name appears.
7. Choose **Test** any time to check Kanbo can still reach Notion.

To use a new secret, choose **Replace**. To stop, choose **Disconnect**: Kanbo
forgets the secret and pauses every sync; tasks stay, and so do their links.
If the secret may have leaked, also delete or refresh it on Notion's
integrations page.

### 4. Import a database

**Settings › Notion › Import a database**:

1. **Choose a database.** The list shows what the integration can see
   (search narrows it). Missing one? Share it with the integration (step 3.4).
2. **Check the fields.** The first five pages are shown, with Kanbo's guess
   at the mapping. Change any of it:
   - **Task title**: always the database's title field.
   - **Status**: a status or select field, and what each option means in
     Kanbo (To do, In progress, In review, Blocked, Done). Options left as
     "Leave as it is" don't change a task's status.
   - **Due date**: a date field. A date range sets the start date and due
     date.
   - **Assignee**: a people field, matched to members by email.
   - **Tags**: a multi-select field. Missing tags are made in the workspace,
     in Notion's colours.
   - **Description**: a text field's first paragraph.
3. **Choose a project**: an existing one, or a new one (named after the
   database, with an icon and colour). Leave **Keep it in sync** on to have
   later changes flow, both ways or from Notion only.
4. **Import.** It says how many tasks it made. A big database comes in
   1,000 tasks at a time. Kept in sync, the sync brings in the rest over its
   next runs. Imported once (not kept in sync), the last step offers
   **Import the rest**, which carries on from where the import stopped (it
   reads the oldest pages first), into the same project, as many times as it
   takes. The wizard stays open until an import finishes.

Importing the same database again into the same project skips pages it
already brought in (only new tasks count towards the 1,000). Turning a
one-off import into a sync later (import again with **Keep it in sync**)
takes over the tasks it made instead of copying them, merging each field
as below. A database is imported or synced by one person at a time: a
second import of it (a double click, or two admins at once), or **Sync
now** while it's being imported, is asked to try again in a minute.

### 5. Link pages to tasks

Open a team task, choose **Link a page** in its **Notion** section and paste
the page's link (in Notion: **Share › Copy link**). The page must be shared
with the integration. A task can have up to 20 linked pages. Chips refresh
their title and icon when they're over an hour old.

## How the sync behaves

- **Every 10 minutes** (or **Sync now**), for each enabled sync whose
  workspace is connected: Notion pages edited since the last run come in
  (oldest first; Kanbo reads from two minutes earlier, because Notion's
  edit times are whole minutes). A page with no task becomes a task in the
  project.
- **Two-way**: tasks changed in Kanbo since their last sync go to Notion.
  Only the fields Kanbo changed are sent (title, status, dates, assignee,
  tags, description's first paragraph).
- **Field by field.** For each task, Kanbo remembers what every synced field
  was when the two sides last agreed (a fingerprint, kept server-side in
  `notion_link_state`). A field changed only in Notion comes into Kanbo; a
  field changed only in Kanbo goes to Notion (or, from Notion only, stays
  as it is in Kanbo); a field nobody changed is left alone. So a change to
  the status in Kanbo survives someone editing a different property, or the
  page's text, in Notion later, and a status changed in Notion survives
  someone changing the priority or the order in Kanbo later.
- **Same field, both sides: the later edit wins.** Kanbo compares the task's
  last change with the page's last edit. Notion's edit times are whole
  minutes, so a tie goes to Kanbo. Kanbo never mistakes its own writes for
  someone's change, in either direction.
- **Taking over**: a sync only takes over pages its database's importer
  linked (a one-off import, or a removed sync of the same database). A page
  someone linked to a task by hand, for context, is never taken over: the
  task is left exactly as it is, and the page becomes its own task in the
  synced project.
- **What can't be said isn't forced.** A Kanbo status with no Notion option
  (say Blocked), an assignee with no Notion account, a Notion person who
  isn't a member, or a Notion option mapped to nothing: that field is left
  alone on the other side. A page's option that already means the task's
  status is kept (several options can mean In progress). An empty Notion
  status is filled in from Kanbo the next time the task's status changes.
- **Descriptions**: only the first paragraph is shared. The rest of the
  description in Kanbo, and the rest of the text in Notion, stay as they are.
- **Archived pages**: a page archived or moved to the trash in Notion
  archives its task (Kanbo checks a few linked pages every run, and any page
  it tries to update).
- **Deleted tasks**: a task deleted in Kanbo isn't brought back when its page
  changes, and its Notion page is left alone. A page moved into the database
  from elsewhere is imported like a new one.
- **Not synced**: new Kanbo tasks don't create Notion pages, and nothing is
  ever deleted in Notion.
- **The sync acts as the person who set it up** (shown in Settings). Every
  task, project and tag it reads or writes goes through that person's
  permissions (row-level security), limited to the workspace. If they leave
  or become a guest, the sync stops and Settings says "The person who set up
  this sync no longer has access. An owner or admin can save it again."; an
  owner or admin chooses **Run as me** on it, and it acts as them from then on.
- **Limits**: Notion allows about three requests a second per integration;
  Kanbo paces itself and waits when Notion asks it to slow down. A run stops
  after about 90 requests or 30 seconds and the next run carries on.

## Security

- The integration secret is read only by the `notion` function, with the
  service role, after the database has said the caller may act. It's never
  sent back, logged or put in a URL.
- Everything people do runs as them: the function opens a transaction as the
  caller (`set local role authenticated` + their JWT claims, scoped to the
  workspace) and the database's own rules decide. The service role only
  reads the secret and keeps `notion_links`, `notion_page_cache`,
  `notion_link_state` (no one can read it from the app) and the syncs'
  bookkeeping.
- Kanbo only fetches a page's title and icon for pages linked in that
  workspace, and only shows icons that are emoji or `https` images.
- Limits per person: 60 requests a minute; 30 links a minute; 60 chip
  refreshes a minute. Per workspace: connecting 10 times and importing 10
  times per 10 minutes. **Sync now**: 5 per 5 minutes per sync. Per
  database: one import or sync run at a time (a lease that lets go when the
  run ends, or after 3 minutes if it never does).

## If something's wrong

| What people see | Why | What to do |
|---|---|---|
| Settings: "Not switched on yet" | Migration 0046 hasn't been run, or the `notion` function isn't deployed | `database-0046.md`, then step 1 |
| "Notion didn't accept that secret…" | Not the Internal Integration Secret, or it was refreshed | Copy it again (step 3.3) |
| The database isn't in the list | It isn't shared with the integration | Step 3.4 |
| A sync says "Kanbo can't see this Notion database any more…" | The database was unshared, moved or deleted | Share it again, then **Sync now** |
| "Notion no longer accepts Kanbo's integration secret…" | The integration was deleted or its secret refreshed | **Replace** with the new secret |
| "The person who set up this sync no longer has access…" | They left the workspace, became a guest or were suspended | An owner or admin chooses **Run as me** on the sync |
| "This database is being imported or synced right now…" | Someone else's import (or a run) of the same database hasn't finished | Wait a minute and try again |
| People don't come across | The integration can't read emails, or the Notion email differs from the Kanbo one | Tick the email capability (step 3.2) |
| Nothing syncs on its own | The schedule isn't running | Steps 2c and 2d |

## The function (for reference)

`POST https://htnchiljplrnjkwimgla.supabase.co/functions/v1/notion`, with the
person's JWT. Body `{ "action": …, … }`; answers `200 { "ok": true, … }` or
`4xx/5xx { "error": "<sentence>", "reason": "<code>", "retryAfter"? }`.

| action | who | body | answer |
|---|---|---|---|
| `connect` | owner/admin | `workspaceId, token` | `status` |
| `test` | owner/admin | `workspaceId` | `workspaceName` |
| `databases` | owner/admin | `workspaceId, query?` | `databases` |
| `schema` | owner/admin | `workspaceId, databaseId` | `schema` |
| `preview` | owner/admin | `workspaceId, databaseId` | `rows` (5) |
| `import` | owner/admin | `workspaceId, databaseId, mapping, projectId \| newProject, keepInSync, direction, resume?` | `result` (`created, skipped, errors, partial, resume`) |
| `sync_now` | owner/admin | `syncId` | `stats, error, fatal` |
| `page` | members | `workspaceId, pageId, force?` | `page` (linked pages only) |
| `link_page` | can edit the task | `taskId, url` | `link` |
| (schedule) | `x-cron-secret` | `{ "mode": "sync" }` | `due, ran, results` |

Reasons: `not_connected`, `not_allowed`, `invalid_token`, `not_shared`,
`rate_limited`, `notion_error`, `invalid`, `not_found`, `unavailable`,
`error`.

## How it was tested

- `supabase/functions/_shared/notionMap.test.ts`, `notionApi.test.ts`,
  `notionHandler.test.ts`, `notionSync.test.ts` (vitest): reading and
  writing Notion properties, the mapping checks, the per-field merge (each
  side's change, both sides, ties, no baseline yet, what can't be said),
  round trips that settle, the per-database lease, pacing, retries and
  errors.
- A PGlite replay of every migration with the real function code against an
  in-memory Notion (121 cases): who may connect / import / sync / link; the
  token never leaving the server; import into new and existing projects;
  Notion → Kanbo and Kanbo → Notion; last-writer-wins and same-minute ties;
  first-paragraph descriptions; archived pages; deleted tasks staying
  deleted; take-over of one-off imports; big databases over several runs; a
  stale cursor; 429 and 502 from Notion; a revoked token; a sync whose
  person lost access; a link smuggled onto another workspace's task; limits.
- A second replay of the review fixes (52 cases): a Kanbo change surviving a
  later edit to an unmapped Notion property, and a Notion change surviving a
  later Kanbo edit to priority / order / Today (in both time orders);
  different fields on each side; an untouched page writing nothing; an
  empty Notion status filled in; from-Notion-only syncs never undoing Kanbo;
  a push refused with a 429 tried again without losing what came in; the
  baseline table out of every app role's reach; hand-made links never taken
  over (one, and two on one task, with no failed runs); a one-off import
  taken over field by field; two imports of one database at once (one runs,
  one waits, no copies); Sync now and the schedule during an import; a
  stale lease expiring; a 1,050-page one-off import finishing with **Import
  the rest** or by importing again; bad resume points refused.
