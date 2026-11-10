# Database update 0053: project updates on schedule, and honest status

Migration file: `supabase/migrations/0053_update_rhythm.sql` (the commented
source). It needs 0041 and 0042, works with or without 0043–0052, and is safe
to run more than once: re-running keeps every update day, plan and ask.

## What it adds

| Part | Table / function | Who can see what |
|---|---|---|
| The team's update day | `workspaces.update_rhythm`, `set_update_rhythm(ws, rhythm)` | Everyone in the workspace reads it. Its owners and admins set it (Settings › Workspace › Project updates). Unset means weekly on Friday. Weekly, every other week, once a month (the last chosen day of the month) or no update day. |
| A project's own day | `projects.update_rhythm` | Read with the project. Its writers set it (About › Update day); "Never" included. Unset follows the workspace. |
| Plan to recover | `status_updates.recovery_plan` (≤ 2000 characters), `status_updates.target_date` | Read with the update (guests too, as updates are). An At risk or Off track update's plan and new date. "On hold" is an update status of its own (no change needed). |
| Ask for an update | `update_asks`, `ask_for_update(project)` | The workspace's owners and admins ask, about a live project someone else in the workspace owns: once per project in 20 hours, 30 a day per asker. Only the asker and the owner read an ask. Nobody writes the table but the function. Kept 30 days. |
| Notify queue | `notify_queue` kind `update` | Service only. The update-day reminders and the asks' push and email (prefs `update_email` / `update_push`, default on). |

## Owner steps

1. Run the migration in the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
   (paste the whole file, press **Run**; "Success. No rows returned").
   - *"0053 needs 0041 and 0042 first"*: run them, then this file again.
2. Check it with the VERIFY block at the end of the file: every column should
   say `true`.
3. Redeploy the three functions that use it:

```sh
supabase functions deploy daily-reminders --no-verify-jwt --project-ref htnchiljplrnjkwimgla --use-api
supabase functions deploy notify --project-ref htnchiljplrnjkwimgla --use-api
supabase functions deploy slack-post --project-ref htnchiljplrnjkwimgla --use-api
```

No new secrets and **no new schedule**: the reminders run inside the
existing every-15-minutes `kanbo-daily-digest` job.

If 0048 is ever run again, nothing breaks (it lists the `update` kind too).

## How it works

- **On the day.** In the workspace's update day (or the project's own), the
  project's owner finds one line under Today's brief ("Your update on Q3
  Product Launch is due today. Kanbo has drafted it from this week's 10
  changes.") and one Kanbo noticed card. Either opens the update in a sheet
  with Kanbo's draft already written (its AI when it's on, the on-device draft
  otherwise). Nothing posts on its own.
- **Reminders.** `daily-reminders` (mode `digest`) sends the owner one push and
  one email a day, from 09:00 to 18:00 in their time zone, on the day and the
  next two working days, while nothing's been posted since the round before.
  Quiet hours hold it; people on the daily digest get it inside their digest.
  Archived and on-hold projects, Never, and projects with no tasks are
  skipped; a project that started in the last three days isn't chased yet.
- **Update missing.** After those two working days the project shows "Update
  missing" in portfolios, the project directory and the Group page (and the
  round after, while the one before still hasn't come in). This replaces the
  fixed "no update in 14 days" once 0053 is run; before it, the 14-day rule
  stands.
- **Ask for an update.** Owners and admins see it on project rows. The owner
  hears once, by push and email (`notify` `{ kind: "update_ask" }`), and in
  Today's line until they post.
- **Honest status.** Picking On track while Kanbo sees overdue or blocked work
  asks one question ("Kanbo sees 4 overdue and 2 blocked. Keep On track, or
  add a plan to recover?") and never blocks the post. Portfolios and the Group
  page show one pill per project: the lead's call, with a small mark when it's
  rosier than the work, "Lead says / Kanbo sees" on hover and focus, and those
  mismatches listed first.
