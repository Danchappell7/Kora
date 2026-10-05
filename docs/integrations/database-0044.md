# Database update 0044: push devices are saved only through Kanbo

Migration file: `supabase/migrations/0044_push_device_cap.sql`. It needs 0043,
changes nothing the app does, and is safe to run more than once.

## Why

0043 lets each person manage their own `push_subscriptions` rows. Supabase
grants every new table to signed-in users by default, so someone could add
rows straight through the API instead of through `save_push_subscription()`,
which skips its limit of 20 devices per person. With a thousand or so junk
rows, the morning reminder could have skipped other people's push. That's
fixed in `daily-reminders`, which now reads each person's devices on their
own. This update also closes the gap in the database itself.

## What it changes

| | Before (0043) | After (0044) |
|---|---|---|
| Add or change a device row from the app | Own rows, directly or through `save_push_subscription()` | Only through `save_push_subscription()` |
| Read / remove your own device rows | Yes | Yes (sign-out and "switch off everywhere" use this) |
| Devices per person | 20, only when saved through the function | 20 newest, however a row is written (a trigger) |
| Anyone already over 20 | – | Trimmed to their 20 newest, once |

The edge functions (service role) work as before: they read devices, stamp
`last_ok_at` and delete dead ones.

## Owner steps

Run it straight after 0043 (before switching push on).

1. Open the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
2. Paste the whole of `0044_push_device_cap.sql` and press **Run**. It should
   finish with "Success. No rows returned".
   - If it stops with *"0044 needs 0043 first"*, run
     `0043_integrations_push_forms_plans.sql` first, then this file again.
3. Check it. Paste this and press **Run**; every column should say `true`:

```sql
select
  exists (select 1 from public.schema_migrations where version = '0044')                     as recorded,
  not has_any_column_privilege('authenticated', 'public.push_subscriptions', 'insert')
  and not has_any_column_privilege('authenticated', 'public.push_subscriptions', 'update')  as push_writes_via_function_only,
  has_table_privilege('authenticated', 'public.push_subscriptions', 'select')
  and has_table_privilege('authenticated', 'public.push_subscriptions', 'delete')           as push_read_and_remove_own,
  exists (select 1 from pg_trigger where tgname = 'trg_push_subscriptions_cap')              as push_cap_trigger,
  not exists (select 1 from public.push_subscriptions group by user_id having count(*) > 20) as push_within_cap;
```

Running 0043 again later doesn't undo this.

## Tested

Replayed on a local Postgres (PGlite) on top of 0001–0043 with Supabase's
default table grants, applied twice and then 0043 again: 39 checks. Before
0044, a signed-in person could insert 30 rows directly, which reproduces the
problem. After it: 18 attacks are refused or capped. These are direct
inserts, upserts and updates (including handing a row to someone else or
back-dating it to dodge the trim), truncate, anon access, reading or deleting
someone else's devices, a suspended account saving, a flood of 40 saves
through the function (20 kept), and 25 service-role inserts (20 kept). 15
legitimate flows still work: save, re-save, reading your own row, the
shared-browser hand-over (onto a full account too), switching off on one
device or everywhere, a suspended account removing its own devices, the
service role's read, stamp and prune, and account deletion.
