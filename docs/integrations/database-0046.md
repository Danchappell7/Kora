# Database update 0046: API keys, webhooks, Notion

Migration file: `supabase/migrations/0046_api_webhooks_notion.sql` (the
commented source). It needs 0042, is additive and is safe to run more than
once: re-running keeps every key, webhook, secret, delivery, Notion token,
sync and link. It doesn't need 0043 or 0045 and works before or after them.

## What it adds

| Part | Table / function | Who can see what |
|---|---|---|
| Task change time | `tasks.updated_at` + trigger | Set by the server on every real change (a no-op save keeps it; nobody can set it by hand). Existing tasks read as the time 0046 first ran. |
| API keys | `api_keys`, `create_api_key()`, `list_api_keys()`, `revoke_api_key()`, `verify_api_key()` | The key is made in the database and shown **once**; only its SHA-256 is stored. People read their own keys (never the hash). Team keys: owners/admins only. `verify_api_key` is service-role only. A suspended or unapproved person's keys stop at once; a team key stops if its creator is no longer an owner/admin there. |
| Key scope | restrictive policy **"api key scope"** on 16 tables | Only narrows access, and only when the `api` function opens a team key's transaction. The app is unaffected. |
| API limits | `api_rate_hit()`, `api_idempotency`, `api_idempotency_begin/finish()` | Service role only. |
| Webhooks | `webhooks`, `webhook_outbox`, `webhook_deliveries`, management functions, capture triggers on tasks / comments / projects / members | Server-only tables. Workspace writers (never guests) manage the team's endpoints; anyone manages their personal ones. The signing secret is shown once. Nothing is captured while no endpoint listens. |
| Notion | `workspace_integrations.notion_*`, `notion_status/connect/disconnect()`, `notion_syncs`, `notion_links`, `notion_page_cache` | The token is server-only (like the Slack URL). Owners/admins connect and set up syncs; members see the status and read syncs and links; members (not guests) link pages to tasks. |

Until each feature's edge function is deployed, its Settings panel explains
that it isn't switched on yet; the app keeps working as before.

## Owner steps

1. Open the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
2. Paste the whole migration (or the comment-free copy you were given) and
   press **Run**. It should finish with "Success. No rows returned".
   - If it stops with *"0046 needs 0042 first"*, run
     `0042_rollout_hardening.sql` first, then this file again.
3. Check it. Paste this and press **Run**; every column should say `true`:

```sql
select
  exists (select 1 from public.schema_migrations where version = '0046')                       as recorded,
  exists (select 1 from information_schema.columns where table_schema = 'public'
           and table_name = 'tasks' and column_name = 'updated_at')
  and exists (select 1 from pg_trigger where tgname = 'trg_tasks_touch_updated_at')               as tasks_updated_at,
  not has_column_privilege('authenticated', 'public.api_keys', 'key_hash', 'select')
  and has_column_privilege('authenticated', 'public.api_keys', 'prefix', 'select')
  and not has_table_privilege('authenticated', 'public.api_keys', 'insert')                     as key_hashes_hidden,
  not has_function_privilege('authenticated', 'public.verify_api_key(text)', 'execute')          as verify_service_only,
  (select count(*) from pg_policies where schemaname = 'public' and policyname = 'api key scope'
    and permissive = 'RESTRICTIVE') >= 10                                                        as api_key_scope,
  not has_table_privilege('authenticated', 'public.webhooks', 'select')
  and not has_table_privilege('authenticated', 'public.webhook_outbox', 'select')
  and not has_table_privilege('authenticated', 'public.webhook_deliveries', 'select')            as webhooks_server_only,
  (select count(*) from pg_trigger where tgname in ('trg_webhook_task','trg_webhook_comment',
    'trg_webhook_project','trg_webhook_member')) = 4                                            as webhook_triggers,
  not has_table_privilege('authenticated', 'public.workspace_integrations', 'select')            as notion_token_server_only,
  (select relrowsecurity from pg_class where oid = 'public.notion_links'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.notion_syncs'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.notion_page_cache'::regclass)    as notion_rls;
```

### Daily tidy-up (once)

Clears stored idempotency answers after a day, webhook history after 14
days and the API's rate-limit rows. Runs inside the database: no secret
needed.

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'kanbo-api-housekeeping';

select cron.schedule('kanbo-api-housekeeping', '17 3 * * *', $$ select public.api_housekeeping(); $$);
```

(The first line says "0 rows" the first time. That's fine.)

### Instant webhooks (optional, once)

Webhooks go out within a minute from the scheduled job (`docs/api/webhooks.md`).
To send them within seconds, also add the functions address to the Vault;
the database then wakes `webhook-dispatch` right after each change:

```sql
select vault.create_secret('https://htnchiljplrnjkwimgla.supabase.co/functions/v1', 'kanbo_functions_url');
```

It uses the existing `kanbo_cron_secret`. Without it everything still works,
just on the one-minute schedule.

## If 0041 or 0042 is ever run again

Both drop and recreate every policy on the content tables, which removes the
"api key scope" policies. Run 0046 again straight afterwards (the
`api_key_scope` check above turns `false` until you do).

## How it was tested

A PGlite replay of every migration (0046 applied four times, with and
without pgcrypto, and alongside 0045): 215 attack and legit cases. Members
reading key hashes, webhook secrets or the Notion token; guests making write
keys or webhooks; using one workspace's key on another; read keys writing;
suspended people's keys; SSRF-shaped URLs; and the full delivery / retry /
switch-off cycle.
