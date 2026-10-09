# Database update 0047: recycle bin, history, approvals, docs

Migration file: `supabase/migrations/0047_bin_history_approvals_docs.sql`
(the commented source). It needs 0043 and 0046, is additive and is safe to
run more than once: re-running keeps every bin item, history row, approval
and doc. Run it **last**: if 0046, 0037, 0041, 0042, 0012 or 0014 is ever
run again, run 0047 again straight afterwards (see the end of this page).

## What it adds

| Part | Table / function | Who can see what |
|---|---|---|
| Recycle bin | `trash`, BEFORE DELETE triggers on `tasks` and `projects`, `restore_from_trash()`, `restore_trash_items()`, `purge_trash()`, `trash_housekeeping()` | Deleting a task (with its sub-tasks) or a project keeps a snapshot of everything that hangs off it for 30 days: sub-tasks, checklist, dependencies both ways, comments, file rows, history, everyone's plans, Notion links, approvals; a project also its sections, docs and Notion sync. The bin row is readable by the same people as the original (personal: its creator; team: the workspace's members) — every column except the snapshot. Writers (never guests) restore; owners/admins delete team items for good, creators their personal ones. Closing a workspace or deleting an account still destroys outright (nobody could see that bin). |
| Storage after a purge | `storage_cleanup` | Service only. A purge removes the database rows; the files of purged attachments are queued here. **TODO:** a housekeeping edge function drains the queue (re-checks no attachment row points at the path, removes the object from `task-files`, deletes the queue row). Until then those files stay in storage. |
| Workspace history | `audit_events` + capture triggers | Deletes / restores / purges, project archive, invites, joins, removals, role changes, renames, Slack/Notion connections, team API keys and webhooks. Owners/admins read the whole workspace's; everyone else only their own actions. Nobody writes it directly. Kept 365 days. Never holds a secret (no Slack URL, Notion token, API key or full webhook URL). |
| Approvals | `approvals`, `approval_reviewers`, `request_approval()`, `decide_approval()`, `cancel_approval()`, `task_approvals()`, `list_my_approvals()` | Anyone who can see the task reads them. People who can edit a team task ask 1–10 workspace members (guests may review); reviewers decide only their own row; the requester or an owner/admin cancels. One open request per task. Inbox notices (kind `approval`, pref `approval`), an `approval` entry in the task's history, and webhooks `approval.requested` / `approval.decided`. |
| Project docs | `project_docs`, `project_doc_versions`, `save_project_doc()`, `set_project_doc_props()`, `delete_project_doc()` | The project's audience reads (guests too); people who can edit the project write, only through the functions. A save with a stale base comes back as a conflict with the other person's copy. Versions: one per 10 minutes of one person's editing, last 50 kept; a save with `p_checkpoint` (a restore from Version history, or "Keep mine") always starts a new one, so the words it replaces stay in the history. New @mentions get one Inbox notice (kind `doc_mention`). |
| Inbox details | `activity.meta` | `{ approval_id, event, status }` or `{ doc_id, project_id }`. |
| Quiet restores | the notification, comment-author and comment-webhook triggers | Skip rows a restore puts back: no repeated notices, comments keep their authors' names. Restored tasks and projects do send `task.created` / `project.created` to webhooks. |
| Health | `kanbo_health()` | Service role only (the `health` edge function). |
| Sign-in hint | `sign_in_hints()` | Anyone, signed in or not: the one auto-approved company domain when there is exactly one, otherwise nothing (never a list). The sign-in page uses it for Google's `hd` hint. See `google-sign-in.md`. |

Realtime streams `approvals`, `approval_reviewers` and `project_docs`.

## Owner steps

1. Open the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
2. Paste the whole migration (or the comment-free copy you were given) and
   press **Run**. It should finish with "Success. No rows returned".
   - *"0047 needs 0046 first"* or *"needs 0043 first"*: run those, then this file again.
3. Check it. Paste this and press **Run**; every column should say `true`:

```sql
select
  exists (select 1 from public.schema_migrations where version = '0047')                        as recorded,
  (select count(*) from pg_trigger where tgname in ('trg_trash_task', 'trg_trash_project')) = 2     as bin_triggers,
  not has_column_privilege('authenticated', 'public.trash', 'snapshot', 'select')
  and has_column_privilege('authenticated', 'public.trash', 'summary', 'select')                   as bin_snapshot_hidden,
  not has_table_privilege('authenticated', 'public.audit_events', 'insert')
  and not has_table_privilege('authenticated', 'public.approvals', 'insert')
  and not has_table_privilege('authenticated', 'public.project_docs', 'update')                   as writes_through_functions,
  not has_table_privilege('authenticated', 'public.storage_cleanup', 'select')                     as cleanup_queue_service_only,
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
    and tablename in ('approvals', 'approval_reviewers', 'project_docs')) = 3                       as realtime,
  'approval.decided' = any (public.webhook_event_names())                                          as approval_events,
  (select count(*) from pg_trigger where tgname in ('trg_notify_assignee', 'trg_notify_mentioned',
    'trg_notify_comment', 'trg_comment_author', 'trg_webhook_comment')
    and pg_get_triggerdef(oid) like '%kanbo.restoring%') = 5                                        as restores_quiet,
  exists (select 1 from pg_trigger where tgname = 'trg_before_user_delete_0047')                  as account_deletion,
  not has_function_privilege('authenticated', 'public.kanbo_health()', 'execute')                 as health_service_only,
  to_regprocedure('public.sign_in_hints()') is not null
  and has_function_privilege('anon', 'public.sign_in_hints()', 'execute')                         as sign_in_hint;
```

### Emptying the bin

Nothing new to schedule: the daily `kanbo-api-housekeeping` job (from 0046)
now also deletes bin items older than 30 days and history older than a
year. If that job isn't set up yet, see `database-0046.md` › Daily tidy-up.

## If an older migration is ever run again

| Run again | What changes until 0047 runs again |
|---|---|
| 0046 | Its `webhooks` check only knows 8 events, so it **stops with an error** if any webhook subscribes to an approval event; the daily job stops emptying the bin; restored comments go to webhooks again. |
| 0012, 0014, 0037, 0041 | Restoring from the bin sends assignment / mention / comment notices again, and restored comments take the restorer's name. |

In every case: run 0047 again straight afterwards.

## How it was tested

A PGlite replay of every migration with 0047 applied twice (and 0046 + 0047
re-run), plus the comment-free paste copy on its own: 40 cases. Attacks —
outsiders, guests, members and suspended people restoring or purging;
reading another workspace's bin or history, or the snapshot column; writing
the bin, history, approvals, reviews or docs directly; calling the internal
helpers; deciding someone else's review; guests asking for approval or
editing docs. Legit — delete → bin → restore round trips with sub-tasks,
checklist, comments (threaded, authors kept), dependencies both ways, files,
history, plans, Notion links and approvals, with no repeated notices; a
sub-task deleted on its own; parent and child in one statement; bulk restore
order; conflicts; restores into the first project / Personal with a note;
project delete → restore with sections, docs, versions and its Notion sync;
a stranger's task naming the project left alone; closing a workspace and
deleting accounts (team bin rows move to the owner); housekeeping; webhooks;
approvals any/all; doc conflicts, versions and mentions; 0041/0042/0046
behaviours unchanged; 1,500 tasks to the bin and back.
