# Calmer notifications (database update 0048)

Kanbo's push and email now arrive the way each person asks for them, in
**Settings › Notifications** (below the In-app / Email table and the push
panel):

- **Bundling.** The first push or email about a task goes straight away and
  opens a 2-minute window for that person. Anything else about the same task
  in that window is held to its end and sent as **one** message: "3 comments
  on Launch deck from Sana and Theo". A mention is never dropped: it rides in
  the bundle and is named in it ("Sana mentioned you"). The Inbox folds the
  same way ("3 comments on Launch deck from Sana and Theo", opened with the
  arrow or →). "Bundle related notifications" off sends each one on its own.
- **Real time or a daily digest.** Digest: no email per event; one email a day
  at the person's chosen time, in their time zone, with what came into their
  Inbox since the last digest and is still unread, plus what's due today or
  overdue (the morning due-date email is folded into it). Push still comes for
  mentions and approvals only.
- **Quiet hours.** No push or email inside them (for example 22:00–07:00 on
  weeknights, in the person's time zone, clocks changing included). They're
  held and go out, bundled, when quiet hours end. The Inbox still updates
  straight away, and says "Quiet hours until 07:00" while they're on.
- **Snooze a thread** from the Inbox (1 hour, Tomorrow 09:00, Next week, or a
  date and time). A snoozed thread sends no push or email; when the snooze
  ends it comes back to the top of the Inbox ("Back from snooze") on every
  device. Snoozes made on one device before this update move across on their
  own the first time the Inbox opens.

Nothing changes for anyone until 0048 is run: the notify function sends
exactly as before while `notify_queue` doesn't exist, and the Inbox keeps
snoozes on the device.

## What you need first

- Database update **0048** run (`database-0048.md`): it adds the prefs keys,
  `notification_snoozes`, `notify_queue`, `notify_queue_claim()` and
  `notify_queue_finish()`.
- The scheduler already set up for the daily reminder email (DEPLOYMENT.md
  step 5: `pg_cron`, `pg_net` and the `kanbo_cron_secret` Vault secret, the
  same string as the `CRON_SECRET` function secret).

## Owner steps

### 1. Deploy the two functions

```sh
supabase functions deploy notify --project-ref htnchiljplrnjkwimgla --use-api
supabase functions deploy daily-reminders --no-verify-jwt --project-ref htnchiljplrnjkwimgla --use-api
```

`notify` keeps Verify JWT on. `daily-reminders` stays off (the scheduler calls
it with the cron secret). No new secrets.

### 2. Schedule the drain and the digest

Open the SQL editor
(<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>), paste
this box and press **Run**. It's safe to run again: it replaces the two jobs.

```sql
select cron.unschedule(jobid) from cron.job where jobname in ('kanbo-notify-drain', 'kanbo-daily-digest');

-- every minute: send what bundling and quiet hours held back
select cron.schedule(
  'kanbo-notify-drain',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://htnchiljplrnjkwimgla.supabase.co/functions/v1/daily-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kanbo_cron_secret')
    ),
    body := '{"mode":"drain"}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- every 15 minutes: the daily digest, for whoever's time it is
select cron.schedule(
  'kanbo-daily-digest',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://htnchiljplrnjkwimgla.supabase.co/functions/v1/daily-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kanbo_cron_secret')
    ),
    body := '{"mode":"digest"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
```

The morning job (`kanbo-daily-reminders`, DEPLOYMENT.md step 5d) stays as it
is: with no `mode` it sends the due-date list, now skipping people on the
digest (it's in their digest) and holding the list for anyone in quiet hours.

**Careful:** DEPLOYMENT.md step 5b removes every job whose command mentions
`daily-reminders`, which now includes these two. If you ever run 5b again, run
this box again straight afterwards.

### 3. Check it

After a few minutes:

```sql
select j.jobname, d.start_time, d.status, d.return_message
from cron.job_run_details d join cron.job j using (jobid)
where j.jobname in ('kanbo-notify-drain', 'kanbo-daily-digest')
order by d.start_time desc limit 10;
```

The latest `status` for each should be `succeeded`. And the queue (empty or
small is healthy; `waiting` should never grow for long):

```sql
select channel, kind,
       count(*) filter (where sent_at is null and attempts < 5)  as waiting,
       count(*) filter (where sent_at is not null)               as sent_last_week,
       count(*) filter (where sent_at is null and attempts >= 5) as gave_up
from public.notify_queue group by 1, 2 order by 1, 2;
```

A manual drain, if you ever need one (from a terminal, with the service-role
key from Project Settings › API; it never leaves your machine):

```sh
curl -sS -X POST "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/notify" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d '{"kind":"drain"}'
```

## How it works

- `notify` (assigned / mention / comment / approval) works out who hears about
  the event exactly as before (from the database, never the request). Then,
  for each person and channel, `planDelivery` (`_shared/notifyTiming.ts`)
  decides: switched off → nothing; thread snoozed → nothing; digest → email
  waits for the digest, push only for mentions and approvals; quiet hours →
  held to their end; within 2 minutes of the last one about this task (or
  while others about it are due within those 2 minutes) → held to join them;
  otherwise sent now. A notice never joins a longer wait: if others about the
  task are still held for quiet hours the person has since switched off,
  shortened or moved to another time zone, they come forward to go with it.
- Changing quiet hours, the time zone or delivery in Settings also asks
  `notify` (`{ "kind": "replan" }`) to plan the person's own held notices
  again: switching quiet hours off releases what was waiting for them. Only
  ever earlier; a wait that grew is caught when it comes due.
- Every notice is written to `notify_queue` under its event key (the comment,
  the task_events row, the approval decision), so a replayed call alerts
  nobody twice. Held ones wait with `deliver_after`; sent ones are kept a week
  (they open the next bundle window), then tidied.
- The drain (`daily-reminders` mode `drain`, every minute; also a little after
  every `notify` call) claims what's due, groups it by person, channel and
  task, checks each again (still in the workspace? snoozed since? switched to
  the digest? quiet hours begun?) and sends one message per group. A send that
  fails is retried after 2, 4, 6 and 8 minutes, then given up (kept two days
  for a look). So is a check that can't be made (a passing database error):
  that's never taken to mean someone has left.
- A run claims up to 200 notices with a 10-minute lease (longer than an edge
  function can run, so the next minute's run never claims them too), starts
  no group after 40 seconds and hands back what it didn't reach at once.
  Emails are paced for Resend (about two a second), as the morning list and
  the digest are. A bundle that straddles the 200 goes as two messages.
- The digest (`daily-reminders` mode `digest`, every 15 minutes) goes to each
  digest person once per local date, from their digest time (moved to the end
  of quiet hours if it falls inside them) for up to two hours, so a late
  scheduler run still catches it. Nothing unread and nothing due → no email.
- Time maths use the person's time zone (Settings, default Europe/London)
  through the browser's and Deno's own time-zone data: 22:00–07:00 is 22:00
  to 07:00 on the wall clock on the nights the clocks change too. A time the
  clocks skip (01:30 on the last Sunday in March) means the moment just past
  the gap (02:30); one that happens twice means the first.
- Snoozes are `notification_snoozes` rows: your own, for tasks you can see
  (guests too: it's your Inbox). The Inbox deletes a row once you've dealt
  with the thread that came back; the database tidies ended ones after 30 days.

## Limits

- A digest lists 25 threads and 15 due tasks at most (the rest: "…and N more").
- Held due-date lists carry 25 tasks (the email says how many more).
- Without the drain scheduled, held notices wait for the next `notify` call
  (each drains up to 25), so schedule it.
- Kudos have an Inbox row and an email/push pref ("kudos_email",
  "kudos_push"), but nothing sends kudos by email or push yet.
