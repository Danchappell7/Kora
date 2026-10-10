# Database update 0048: the UX wave

Migration file: `supabase/migrations/0048_ux_wave.sql` (the commented
source). It needs 0047, is additive and is safe to run more than once:
re-running keeps every saved view, template, snooze, queued notice and
kudos. Run it **last**: if 0046 or 0047 is ever run again, run 0048 again
straight afterwards (see the end of this page).

## What it adds

| Part | Table / function | Who can see what |
|---|---|---|
| First run | `profiles.onboarding`, `merge_onboarding(patch)` | Your own row only (the existing profile policies). The guided tour's step, the "Get set up" checklist, the sample project and the streak settings. `merge_onboarding` merges one level deep in one statement (a key set to null is removed). |
| Notification prefs | `profiles.notify_prefs` (new keys), `merge_notify_prefs(patch)`, `notif_on()` hardened | Your own row. New keys: `delivery` (`realtime` / `digest`), `digest_time` (`HH:MM`), `quiet_hours` (`{start, end, days}`), `timezone` (IANA, default Europe/London), `bundle`. A light shape check applies to new writes. A malformed pref now counts as "on" instead of breaking the comment or assignment that asks about it. |
| Search | `project_docs.plain_text` (kept by a trigger), four GIN indexes (`kanbo_fts`), `search_all(q, filters, lim)` | `search_all` runs **as the caller** (SECURITY INVOKER), under every row-level policy, so it can never return a row the caller couldn't read. Tasks, comments, docs, projects and people; English stems and as-you-type prefixes; highlighted snippets. |
| Saved views | `saved_views`, `adopt_saved_searches()` | You read your own and the shared ones of workspaces you're in (guests too). Writers share; you edit your own; owners and admins also rename, unpin or delete shared ones (they stay their maker's). Old saved searches move across (same ids). |
| Template library | `task_templates` | The same rules as saved views. |
| Board | `tasks.cover_attachment_id`, `projects.board_settings` | A cover must be an image file on the same task (cleared when the file is deleted; comes back with a task restored from the bin). Board settings (WIP limits, "show project covers") — writers of the project; `merge_board_settings(project, patch)` saves one change atomically (one level deep, two for `wip`; null removes), so two writers never overwrite each other. |
| Snoozes | `notification_snoozes` | Your own rows, for tasks you can see (guests too). Snoozed threads send no push or email. |
| Notify queue | `notify_queue`, `notify_queue_claim()`, `notify_queue_finish()` | Service only. Push and email held back for bundling, quiet hours and digests. |
| Kudos | `kudos`, `give_kudos()`, `take_back_kudos()` | Anyone who can see the task reads them. Anyone who can see a finished team task gives one (guests too; never yourself; one per person per task; 100 a day). The recipient gets an Inbox item (kind `kudos`, pref `kudos`); webhooks get `kudos.given`. |
| Account deletion | `trg_before_user_delete_0048` | Shared views and templates in team workspaces move to the workspace's owner. |
| Live presence | `kanbo_realtime_allowed()`, policies "kanbo presence: read" / "kanbo presence: write" on `realtime.messages` | Realtime Authorization for the private `kanbo:task / doc / project:<id>` channels (who's viewing, "typing…", doc co-editing). Anyone who can see the object reads and says they're there; on a task anyone who can see it may type (guests comment); on a doc only people who can edit its project send edits (never guests; not on an archived doc); on a project nobody broadcasts. The suspended, the unapproved and the signed-out get nothing. **Without these policies every join is refused and presence stays off.** Nothing is stored. See [presence.md](presence.md). |
| Doc versions | `save_project_doc()` (0047's, one rule changed) | A version now covers 10 minutes of a doc's editing **whoever saves** (it names who saved it last), so two people writing together live no longer push the older history out of the last 50. A restore or "Keep mine" still starts a version of its own. |

Realtime streams `saved_views`, `kudos` and `notification_snoozes`.

## Owner steps

1. Open the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
2. Paste the whole migration (or the comment-free copy you were given) and
   press **Run**. It should finish with "Success. No rows returned".
   - *"0048 needs 0047 first"*: run 0047, then this file again.
3. Check it. Paste this and press **Run**; every column should say `true`:

```sql
select
  exists (select 1 from public.schema_migrations where version = '0048')                        as recorded,
  exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'profiles' and column_name = 'onboarding')                                   as onboarding,
  (select count(*) from pg_indexes where schemaname = 'public'
    and indexname in ('tasks_fts_idx', 'comments_fts_idx', 'projects_fts_idx', 'project_docs_fts_idx')) = 4 as search_indexes,
  not (select p.prosecdef from pg_proc p where p.oid = 'public.search_all(text, jsonb, integer)'::regprocedure)
  and not has_function_privilege('anon', 'public.search_all(text, jsonb, integer)', 'execute')    as search_runs_as_caller,
  exists (select 1 from pg_trigger where tgname = 'trg_project_docs_plain_text')                   as doc_plain_text,
  (select count(*) from pg_policies where schemaname = 'public'
    and tablename in ('saved_views', 'task_templates')) = 8                                         as views_and_templates,
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_snoozes') as snoozes,
  not has_table_privilege('authenticated', 'public.kudos', 'insert')
  and has_table_privilege('authenticated', 'public.kudos', 'select')                              as kudos_through_functions,
  not has_table_privilege('authenticated', 'public.notify_queue', 'select')                       as notify_queue_service_only,
  exists (select 1 from pg_constraint where conname = 'tasks_cover_attachment_id_fkey' and condeferrable) as task_covers,
  exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'projects' and column_name = 'board_settings')
  and exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.merge_board_settings(uuid, jsonb)')
    and not p.prosecdef)                                                                         as board_settings,
  'kudos.given' = any (public.webhook_event_names())                                               as kudos_event,
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
    and tablename in ('saved_views', 'kudos', 'notification_snoozes')) = 3                         as realtime,
  (to_regclass('realtime.messages') is null or (select count(*) from pg_policies where schemaname = 'realtime'
    and tablename = 'messages' and policyname in ('kanbo presence: read', 'kanbo presence: write')) = 2) as live_presence,
  position('saved_by = me where id = lastv.id' in (select p.prosrc from pg_proc p
    where p.oid = 'public.save_project_doc(uuid, uuid, text, jsonb, timestamptz, text, uuid[], boolean)'::regprocedure)) > 0 as doc_versions,
  exists (select 1 from pg_trigger where tgname = 'trg_before_user_delete_0048')                  as account_deletion;
```

`live_presence` is the one that turns live presence on: if it says `false`,
the policies didn't go in and nobody will see anyone else live (the app
says so once in the browser console). (On a database whose Realtime has no
Authorization table it reads `true`: there's nothing to install there.)

Nothing new to schedule for the migration itself. The calmer-notifications
work (bundling, quiet hours, the daily digest) adds one scheduled job for
the notify drain; its exact SQL ships with that change in DEPLOYMENT.md.

The search indexes are built when the file runs; on a large database that
takes a few seconds, during which saving tasks waits.

## If an older migration is ever run again

| Run again | What changes until 0048 runs again |
|---|---|
| 0046 or 0047 | Their `webhooks` check doesn't know `kudos.given`, so they **stop with an error** while any webhook subscribes to it (take it off that webhook, run them, run 0048, put it back). Until 0048 runs again, nobody can subscribe to `kudos.given`. 0047 also puts back its `save_project_doc()`: a version per person per save, so people writing together fill Version history again (VERIFY's `doc_versions` turns false). |
| 0037 | `notif_on()` goes back to the version that throws on a malformed pref. |

In every case: run 0048 again straight afterwards.

## How it was tested

A PGlite replay of every migration with 0048 applied twice (and again with
data in place, and after 0047 is re-run), plus the comment-free paste copy
on its own: 63 cases. Attacks — outsiders, guests, removed members,
suspended and signed-out people searching across workspaces (every kind,
every scope and filter, tsquery syntax and junk as input; every hit is
checked against what the caller can select directly), reading or writing
other people's onboarding, prefs, views, templates and snoozes; forging the
maker or moving a view to another workspace; guests sharing; members
editing others' shared views; reading or draining the notify queue; writing
kudos directly, kudos to yourself, on unfinished, personal or invisible
tasks, with a bad emoji, note or recipient, past the daily cap; covers that
aren't images on the same task. Legit — every feature end to end, including
a task with a cover deleted to the bin and restored, a project with board
settings restored, and account deletion handing shared rows to the owner.

Live presence and doc versions (u5) have their own PGlite suites: the
Realtime policies against a stubbed `realtime.messages`, joined the way
Realtime asks (members, guests, the suspended, the unapproved, outsiders,
the signed-out, a personal task, an archived doc, odd topics; applied
twice, before Realtime exists and after a re-run of 0048), and versions
under two people saving in turn (older history kept, a checkpoint still
its own version, a new version after 10 minutes).
