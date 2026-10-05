# Database update 0043: integrations, push, public forms, plans that follow you

Migration file: `supabase/migrations/0043_integrations_push_forms_plans.sql`
(the commented source). It needs 0042, is additive and is safe to run more than
once: re-running keeps every Slack webhook, feed token, form link and plan.

## What it adds

| Part | Table / function | Who can see what |
|---|---|---|
| Slack | `workspace_integrations` (one row per team workspace) | **Nobody** reads the webhook URL from the app, not even the owner. Owners/admins set or clear it with `slack_connect()` / `slack_disconnect()` / `slack_set_autopost()`; everyone in the workspace calls `slack_status()` (connected, channel label, auto-post time). Edge functions read it with the service role. |
| Calendar feed | `calendar_feed_tokens` (one per person), `calendar_feed()`, `rotate_calendar_feed_token()`, `tasks_visible_to(user)` | Your own row only. The server always picks the token. `tasks_visible_to` is service-role only (the `ics-feed` function). |
| Web push | `push_subscriptions` (one per device), `save_push_subscription()` | Your own rows only. Edge functions read them with the service role. |
| Public request forms | `forms.public_token`, `forms.public_enabled`, `rotate_form_public_token()` | People who can edit the form (never guests) switch the link on/off; the token is server-generated. Members can see the link. |
| Plans that follow you | `task_user_state` (your slot, "on today", the day it's for, My-tasks section, Kanbo's ranking, per task) | Your own rows only, and only for tasks you can see. Streams over realtime. |

Nothing in the app needs it to keep working: until it's run, each new feature
hides itself or explains that it isn't switched on yet, and plans stay on the
device as they do today.

## Owner steps

1. Open the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
2. Paste the whole migration (or the comment-free copy you were given) and
   press **Run**. It should finish with "Success. No rows returned".
   - If it stops with *"0043 needs 0042 first"*, run
     `0042_rollout_hardening.sql` first, then this file again.
3. Check it. Paste this and press **Run**; every column should say `true`:

```sql
select
  exists (select 1 from public.schema_migrations where version = '0043')                as recorded,
  (select relrowsecurity from pg_class where oid = 'public.workspace_integrations'::regclass)
  and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workspace_integrations')
  and not has_table_privilege('authenticated', 'public.workspace_integrations', 'select') as slack_url_server_only,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
    and proname in ('slack_status','slack_connect','slack_disconnect','slack_set_autopost')) = 4 as slack_functions,
  (select relrowsecurity from pg_class where oid = 'public.calendar_feed_tokens'::regclass)
  and exists (select 1 from pg_trigger where tgname = 'trg_calendar_feed_token_guard')        as feed_tokens_guarded,
  (select relrowsecurity from pg_class where oid = 'public.push_subscriptions'::regclass)     as push_rls,
  exists (select 1 from information_schema.columns where table_schema = 'public'
           and table_name = 'forms' and column_name = 'public_token')
  and exists (select 1 from pg_trigger where tgname = 'trg_forms_public_guard')               as public_forms,
  (select relrowsecurity from pg_class where oid = 'public.task_user_state'::regclass)
  and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'task_user_state'
               and qual like '%can_see_task%')                                               as plan_state_rls,
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
           and schemaname = 'public' and tablename = 'task_user_state')                     as plan_state_realtime,
  not has_function_privilege('authenticated', 'public.tasks_visible_to(uuid)', 'execute')    as feed_tasks_service_only;
```

If `plan_state_realtime` is `false`, turn realtime on for `task_user_state` in
Database › Publications › `supabase_realtime` (plans still save and load; they
just don't stream between your devices until then).

Run **0044** straight after it (`database-0044.md`). The edge functions,
secrets and cron job for each feature are in their own pages: `slack.md`,
`calendar-feed.md`, `push.md`, `public-forms.md`; DEPLOYMENT.md step 11 has
them all in order, with one command that deploys every function. Running the
SQL alone switches nothing on that needs a function: the calendar feed panel
says "Not switched on yet" until `ics-feed` answers, and a public form's page
says so until `public-form` is deployed, so nobody is handed a dead link.

## Tested

Replayed on a local Postgres (PGlite) on top of 0001–0042, applied twice, with
the existing 0001–0042 security suite (166 cases) still passing and 65 new
ones, 27 attacks and 38 legitimate flows (members
reading the webhook URL, someone else's push subscriptions / feed token / plan
rows, guests switching on a public form, plan state on another workspace's
tasks, a removed or suspended member's plans, client-chosen tokens, and the
legitimate flows for each).
