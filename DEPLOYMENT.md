# Deploying Kanbo

This is the checklist for putting Kanbo live for whole teams. Work through the
**Rollout runbook** from top to bottom. Each step has a link that opens the
right page, and any SQL or Terminal command is in its own box so you can copy
it in one go.

- **Supabase project:** `htnchiljplrnjkwimgla`
- **App:** <https://www.kanbo.co.uk>
- **Time needed:** about 45 minutes, plus a quick test the next morning (step 5),
  and about 20 minutes for the integrations (step 11).

Everything below fails safe. If a step hasn't been done yet, that feature
stays switched off; nothing else breaks. For example, until migration 0042 has
run, the new limits are simply skipped, and if an email can't be sent through
Resend, password reset uses Supabase's own email instead.

---

## Before you start

1. **The new app must be live.** Make sure the latest `main` shows **Ready** on
   Vercel: <https://vercel.com/danchappell7-gmailcoms-projects/kora/deployments>.
   The new emails link to a "Set your password" page that only exists in the
   new app. To check it, open
   <https://www.kanbo.co.uk/?token_hash=test&type=recovery>. You should see
   Kanbo's set-password screen, not the normal home page. (If you press
   Continue it will say the link isn't valid. That's expected for this test.)
2. **Create a Supabase access token** for the Terminal commands at
   <https://supabase.com/dashboard/account/tokens> (**Generate new token**,
   name it "Kanbo deploy"). Wherever a command below says `<token>`, paste
   this token instead. Treat it like a password.
3. **Open Terminal in the project folder** and fetch the latest code:

```bash
cd ~/Downloads/kora-app && git pull
```

---

## Rollout runbook

### Step 1: Back up the database

1. **Be on the Pro plan.** The Free plan pauses the project when it's quiet
   (that's what took Kanbo offline on 29 September) and has no backups. You
   can upgrade here: <https://supabase.com/dashboard/org/_/billing>
2. **Confirm there's a recent backup:**
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/database/backups/scheduled>.
   You should see one dated today or yesterday. If you've only just upgraded,
   wait for the first daily backup to appear before carrying on.

### Step 2: Check migrations 0036–0041 are applied

As of 30 September these are all live, so this is just a check. Open the SQL
editor at <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>,
paste the query below and press **Run**. Every row should say `ok`.

```sql
select check_name, case when ok then 'ok' else 'MISSING' end as status
from (values
  ('0036 recurrence options', exists (select 1 from pg_constraint where conname = 'tasks_recurrence_check' and pg_get_constraintdef(oid) like '%weekdays%')),
  ('0037 notification settings', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'notify_prefs')),
  ('0038 task history', to_regclass('public.task_events') is not null),
  ('0039 project archive', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'archived_at')),
  ('0040 comment threads', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'comments' and column_name = 'parent_id')),
  ('0041 security hardening', to_regclass('public.approved_domains') is not null
                              and to_regprocedure('public.can_act()') is not null
                              and exists (select 1 from pg_trigger where tgname = 'trg_before_user_delete'))
) as t(check_name, ok);
```

If a row says `MISSING`, open that file in `supabase/migrations/`, copy the
whole file into a new SQL editor tab and press **Run**. They're all safe to
re-run, **except `0026_access_requests.sql`. Never re-run 0026 as it is**,
because it would approve everyone who is waiting.

### Step 3: Email sending and secrets

**3a. Check the sending domain in Resend.** Open <https://resend.com/domains>.
`kanbo.co.uk` should say **Verified**. If it doesn't, Resend will only deliver
to your own address, and colleagues will never get invite or reset emails.
Add the DNS records Resend shows at GoDaddy, then wait for it to verify.

**3b. Generate a cron secret.** This is a long random password that only the
daily reminder job knows. Run the command below and copy what it prints. You'll
paste it twice: once in 3c and once in step 5.

```bash
openssl rand -hex 32
```

**3c. Set the secrets.** Go to
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions/secrets>,
choose **Add new secret** for each row, then **Save**. Some may already be
there. If so, just check the value.

| Name | Value | Notes |
|---|---|---|
| `RESEND_API_KEY` | `re_…` from <https://resend.com/api-keys> | Probably already set |
| `REMINDER_FROM` | `Kanbo <no-reply@kanbo.co.uk>` | Must use the verified domain from 3a |
| `APP_URL` | `https://www.kanbo.co.uk` | No slash at the end |
| `ANTHROPIC_API_KEY` | `sk-ant-…` from <https://console.anthropic.com/settings/keys> | Powers the AI features |
| `CRON_SECRET` | the string from 3b | **New.** Guards the daily reminder email |
| `ADMIN_NOTIFY_EMAIL` | e.g. `danchappell7@gmail.com` | Optional. Who gets "new access request" emails. Every platform admin gets them anyway; separate several addresses with commas |
| `AI_DAILY_LIMIT` | `200` | Optional. AI requests per person per day (UK time). Default 200 |

You don't need to set `SUPABASE_URL` or the Supabase keys. Supabase adds
those automatically.

### Step 4: Deploy the edge functions

Run each command below in Terminal, one at a time, replacing `<token>` with
the token from "Before you start". Each one ends with **Deployed Function**.
The flags matter: `--no-verify-jwt` goes **only** on `request-access`,
`reset-password`, `daily-reminders` and `calendar`, the functions that are
called without a signed-in user. The same settings are recorded in
`supabase/config.toml`.

`invite-member` is new. It emails people when a team owner or admin invites
them.

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy invite-member --project-ref htnchiljplrnjkwimgla
```

`ai-assist` now has per-person daily limits and blocks unapproved or
suspended accounts.

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy ai-assist --project-ref htnchiljplrnjkwimgla
```

`approve-access` handles admin approvals. It now sends link-scanner-safe
"set your password" emails.

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy approve-access --project-ref htnchiljplrnjkwimgla
```

`notify` sends assignment, mention and comment emails.

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy notify --project-ref htnchiljplrnjkwimgla
```

`delete-account` is redeployed so the live copy matches the code.

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy delete-account --project-ref htnchiljplrnjkwimgla
```

`request-access` backs the public "request early access" form, so it runs
**without** a JWT check.

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy request-access --project-ref htnchiljplrnjkwimgla --no-verify-jwt
```

`reset-password` backs the public "Forgot password?" form, so it also runs
**without** a JWT check.

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy reset-password --project-ref htnchiljplrnjkwimgla --no-verify-jwt
```

`daily-reminders` is called by the scheduled job using `CRON_SECRET`, so it
runs **without** a JWT check.

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy daily-reminders --project-ref htnchiljplrnjkwimgla --no-verify-jwt
```

Only deploy `calendar` if you've set up Google or Microsoft calendar
connections (see `CALENDAR_SETUP.md`). It also runs **without** a JWT check.
It works with the app as it is today: connecting a calendar behaves exactly as
before. It also has a safer way to finish connecting, which the app will start
using in a later update (see **Calendar sync** under Reference).

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy calendar --project-ref htnchiljplrnjkwimgla --no-verify-jwt
```

To check it worked, open
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions>. Each
function above should show an update from a few minutes ago. Then run this
command. It should print `401`, which means strangers can't trigger the
reminder emails:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://htnchiljplrnjkwimgla.supabase.co/functions/v1/daily-reminders
```

### Step 5: Schedule the daily reminder email

Do each part in the SQL editor
(<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>). Paste
one box, press **Run**, then do the next.

**5a. Switch on the scheduler.** These are safe to run even if they're already
on. (You can also do this at
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/database/extensions>
by switching on `pg_cron` and `pg_net`.)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
```

**5b. Remove any old reminder job.** An old job doesn't send the secret, so it
would now fail every day.

```sql
select cron.unschedule(jobid) from cron.job where command ilike '%daily-reminders%';
```

**5c. Store the cron secret in the Vault.** Replace
`PASTE-THE-CRON-SECRET-HERE` with the string from step 3b, keeping the quotes.

```sql
delete from vault.secrets where name = 'kanbo_cron_secret';
select vault.create_secret('PASTE-THE-CRON-SECRET-HERE', 'kanbo_cron_secret', 'x-cron-secret header for the daily-reminders function');
```

**5d. Schedule the job.** The scheduler runs on UTC, so `30 6 * * *` means
07:30 in UK summer time and 06:30 in winter. Use `30 7 * * *` if you'd rather
send at 07:30 during the winter.

```sql
select cron.schedule(
  'kanbo-daily-reminders',
  '30 6 * * *',
  $$
  select net.http_post(
    url := 'https://htnchiljplrnjkwimgla.supabase.co/functions/v1/daily-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kanbo_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
```

**5e. Check it the morning after.** Run the query below. The latest `status`
should be `succeeded`. You can also see the job at
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/integrations/cron/jobs>.

```sql
select start_time, status, return_message
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'kanbo-daily-reminders')
order by start_time desc limit 5;
```

Then open the function's logs at
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions/daily-reminders/logs>.
A good run returns something like `{"sent":12,"skipped":1,"failed":0,…}`. A
`401` means the Vault secret and the `CRON_SECRET` secret don't match. Redo 5c
with the exact same string.

### Step 6: Run migration 0042

In a new SQL editor tab
(<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>), paste
the whole of `supabase/migrations/0042_rollout_hardening.sql` and press
**Run**. It's safe to re-run. It adds:

- the tables the functions use for limits: one reset or request email per
  address per minute, the daily AI allowance, and one reminder email per
  person per day
- the remaining security fixes

### Step 7: Turn on "Confirm email"

Do these parts **in this order**. Without 7a, confirmation emails never
arrive and new people can't get in.

**7a. Send Supabase's own emails through Resend (custom SMTP).** Go to
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/smtp>,
switch on **Enable custom SMTP** and fill in:

| Field | Value |
|---|---|
| Sender email | `no-reply@kanbo.co.uk` |
| Sender name | `Kanbo` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | a Resend API key. Create one called "Supabase SMTP" at <https://resend.com/api-keys> |

**7b. Raise the sign-in limits for shared office networks.** A whole office
often shares one internet address, so on Monday morning everyone can look like
the same person. Go to
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/rate-limits>
and set:

| Setting | Value |
|---|---|
| Emails sent per hour | `100` |
| Sign-ups and sign-ins (per 5 min, per IP) | `150` |
| Token verifications (per 5 min, per IP) | `150` |
| Token refreshes (per 5 min, per IP) | `1800` |

**7c. Make email links last 24 hours.** Go to
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/providers>,
open **Email** and set **Email OTP Expiration** to `86400`. This is the longest
Supabase allows. If someone's link does expire, **Sign in → Forgot password?**
sends them a fresh one.

**7d. Make Supabase's own emails safe from link scanners (recommended).**
Company email filters such as Microsoft Safe Links open links before the person
does, which uses up one-time links. Kanbo's own emails already avoid this. To
make Supabase's built-in emails do the same, go to
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/templates>
and replace the message body of these three templates. Do **Confirm signup**
before 7e: once "Confirm email" is on, it's the email every new colleague
gets, and without this change their company's mail filter can use up the
link before they click it.

For **Confirm signup**:

```html
<h2>Confirm your email for Kanbo</h2>
<p>Press the button below to confirm your email address and finish signing up.</p>
<p><a href="{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=email">Confirm your email</a></p>
<p>If you didn't sign up for Kanbo, you can ignore this email.</p>
```

For **Reset password**:

```html
<h2>Reset your Kanbo password</h2>
<p>Press the button below to choose a new password. You'll be signed straight in.</p>
<p><a href="{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=recovery">Set a new password</a></p>
<p>If you didn't ask for this, you can ignore this email. Your password won't change.</p>
```

For **Invite user**, which is only used if you invite someone from the
Supabase dashboard:

```html
<h2>You've been invited to Kanbo</h2>
<p>Accept the invite, choose a password and you'll go straight in.</p>
<p><a href="{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=invite">Accept invite &amp; set password</a></p>
```

While you're in Authentication, open **URL Configuration** at
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/url-configuration>.
**Site URL** should be `https://www.kanbo.co.uk`, and **Redirect URLs** should
include `https://www.kanbo.co.uk/**` and `https://kanbo.co.uk/**`.

**7e. Turn it on.** Go to
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/providers>,
open **Email**, switch on **Confirm email** and press **Save**. Then sign up
with a spare address. You should get a confirmation email within a minute, and
the sign-up screen should tell you to check your inbox.

### Step 8: Approve your company's email domain

Anyone who signs up with an approved domain gets in straight away, with no
waiting for approval.

The easiest way: go to <https://www.kanbo.co.uk/admin>, open **Approved
domains** and add your company's domain (for example `yourcompany.co.uk`).

Or use the SQL editor. Change the domain first:

```sql
insert into public.approved_domains (domain) values ('yourcompany.co.uk') on conflict (domain) do nothing;
```

Then let in anyone from those domains who signed up earlier and is still
waiting:

```sql
update public.profiles set approved = true
where approved = false and not suspended
  and split_part(lower(email), '@', 2) in (select domain from public.approved_domains);
```

### Step 9: Final check

Paste this into the SQL editor and press **Run**. Every row should say `ok`.
Anything else tells you which step to revisit.

```sql
create or replace function pg_temp.kanbo_n(q text) returns bigint language plpgsql as $f$
declare r bigint;
begin
  execute q into r;
  return r;
exception when others then
  return null;  -- table / schema not there yet
end $f$;

select check_name,
       case when ok then 'ok' else 'CHECK: ' || fix end as status,
       detail
from (values
  ('Migrations 0036–0041',
     to_regclass('public.approved_domains') is not null and to_regclass('public.task_events') is not null,
     'step 2', ''),
  ('Migration 0042 recorded',
     coalesce(pg_temp.kanbo_n('select count(*) from public.schema_migrations where version = ''0042''') > 0, false),
     'step 6', ''),
  ('Throttle table (rate_limits)',
     pg_temp.kanbo_n('select count(*) from public.rate_limits') is not null,
     'step 6', coalesce(pg_temp.kanbo_n('select count(*) from public.rate_limits')::text || ' rows', '')),
  ('AI allowance table (ai_usage)',
     pg_temp.kanbo_n('select count(*) from public.ai_usage') is not null,
     'step 6', coalesce(pg_temp.kanbo_n('select coalesce(sum(calls),0) from public.ai_usage where day = current_date')::text || ' AI calls today', '')),
  ('Team tags (tags.workspace_id)',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tags' and column_name = 'workspace_id'),
     'step 6', ''),
  ('Daily reminder job scheduled',
     coalesce(pg_temp.kanbo_n('select count(*) from cron.job where jobname = ''kanbo-daily-reminders'' and active') = 1, false),
     'step 5d', ''),
  ('No old reminder jobs left',
     coalesce(pg_temp.kanbo_n('select count(*) from cron.job where command ilike ''%daily-reminders%'' and jobname is distinct from ''kanbo-daily-reminders''') = 0, true),
     'step 5b', ''),
  ('Cron secret stored in Vault',
     coalesce(pg_temp.kanbo_n('select count(*) from vault.decrypted_secrets where name = ''kanbo_cron_secret'' and length(decrypted_secret) >= 32') = 1, false),
     'step 5c', ''),
  ('Approved company domains',
     (select count(*) from public.approved_domains) > 0,
     'step 8', (select string_agg(domain, ', ') from public.approved_domains)),
  ('Nobody on an approved domain stuck waiting',
     not exists (select 1 from public.profiles p where p.approved = false and not p.suspended
                   and split_part(lower(p.email), '@', 2) in (select domain from public.approved_domains)),
     'step 8 (second query)', ''),
  ('Platform admins (get access-request emails)',
     exists (select 1 from public.profiles where is_admin and not suspended),
     'mark an admin in /admin', (select string_agg(email, ', ') from public.profiles where is_admin and not suspended))
) as t(check_name, ok, fix, detail);
```

The secrets, the SMTP settings and the "Confirm email" switch can't be seen
from SQL. Step 10 tests those.

### Step 10: Five-minute smoke test

1. **Invite:** in Kanbo, go to **Team → Invite** and invite a personal email
   address. An email titled "*Your name* invited you to *workspace name* on
   Kanbo" should arrive. Its button should open the set-password screen, and after choosing
   a password you should land in the workspace.
2. **Password reset:** sign out, then choose **Sign in → Forgot password?**.
   One email should arrive and its link should work. Press the send button
   twice quickly: you should still get only one email.
3. **Request access:** signed out, use the landing page's request form with
   another address. The admins should receive "New early-access request".
4. **Sign up on your company domain:** in a private window, sign up with an
   address on a domain from step 8. A "Confirm your email" email should
   arrive. Its button should open Kanbo with a **Continue** button, and after
   pressing it you should be signed straight in, with no waiting for approval.
5. **AI:** go to **Analytics**, type a question in the **Ask Kanbo** box and
   press **Ask**. You should get an answer. The next day,
   `select * from public.ai_usage order by day desc limit 10;` shows usage per
   person.
6. If anything misbehaves, the function's logs say why:
   `https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions/<function-name>/logs`
   (for example `…/functions/invite-member/logs`).

### Step 11: Integrations (database updates 0043 and 0044)

Slack, the calendar feed, push notifications and the installable app, public
request forms, team templates and plans that follow you. Each one stays
switched off (or says it isn't switched on yet) until its part below is done,
so you can do them in any order and nothing else breaks meanwhile. Team
templates need nothing.

The details, checks and troubleshooting for each are in
`docs/integrations/`: [database-0043.md](docs/integrations/database-0043.md),
[database-0044.md](docs/integrations/database-0044.md),
[slack.md](docs/integrations/slack.md),
[calendar-feed.md](docs/integrations/calendar-feed.md),
[push.md](docs/integrations/push.md),
[public-forms.md](docs/integrations/public-forms.md) and
[plans-and-templates.md](docs/integrations/plans-and-templates.md).

**11a. Run 0043, then 0044.** In a new SQL editor tab
(<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>), paste
the whole of `supabase/migrations/0043_integrations_push_forms_plans.sql` and
press **Run**, then the same for `0044_push_device_cap.sql`. Both are safe to
re-run. Check them with the queries in database-0043.md and database-0044.md
(every column `true`).

**11b. Push keys (once).** Make a VAPID key pair and give it to the edge
functions, without the private key ever appearing on screen. This writes the
pair to `~/.kanbo-vapid.env` (readable only by you; never put it in the
`kora-app` folder), sets the three secrets, and copies the **public** key to
the clipboard for 11c. Run it again later and it reuses the same pair.

```bash
read -s "SUPABASE_ACCESS_TOKEN?Paste your Supabase token, then press Enter: " && echo && export SUPABASE_ACCESS_TOKEN && N="$(command -v node || echo "$HOME/.kora-tools/node-v20.18.1-darwin-arm64/bin/node")" && F="$HOME/.kanbo-vapid.env" && { [ -f "$F" ] || KANBO_VAPID_FILE="$F" "$N" -e 'const c=require("crypto"),fs=require("fs"),f=process.env.KANBO_VAPID_FILE;const j=c.generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({format:"jwk"});const pub=Buffer.concat([Buffer.from([4]),Buffer.from(j.x,"base64url"),Buffer.from(j.y,"base64url")]).toString("base64url");fs.writeFileSync(f,"VAPID_PUBLIC_KEY="+pub+"\nVAPID_PRIVATE_KEY="+j.d+"\nVAPID_SUBJECT=mailto:hello@kanbo.co.uk\n",{mode:0o600,flag:"wx"});console.log("Made a new key pair (kept in "+f+")")'; } && supabase secrets set --env-file "$F" --project-ref htnchiljplrnjkwimgla && grep '^VAPID_PUBLIC_KEY=' "$F" | cut -d= -f2- | tr -d '\n' | pbcopy && echo "Push keys set. The PUBLIC key is on your clipboard."; unset SUPABASE_ACCESS_TOKEN
```

**11c. The public key in Vercel.** At
<https://vercel.com/danchappell7-gmailcoms-projects/kora/settings/environment-variables>
add `VITE_VAPID_PUBLIC_KEY`, paste the public key from 11b as its value, tick
Production and Preview, and **Save**. The next deploy builds it in. (To copy
it again: `grep '^VAPID_PUBLIC_KEY=' ~/.kanbo-vapid.env | cut -d= -f2- | tr -d '\n' | pbcopy`.)

**11d. Deploy the functions.** Four are new and two changed. `slack-post` and
`notify` keep the JWT check; `slack-standup` (pg_cron), `ics-feed` (calendar
apps), `public-form` (signed-out visitors) and `daily-reminders` (pg_cron)
run without it, as `supabase/config.toml` records. From the project folder,
once the new code is in it:

```bash
read -s "SUPABASE_ACCESS_TOKEN?Paste your Supabase token, then press Enter: " && echo && export SUPABASE_ACCESS_TOKEN && cd ~/Downloads/kora-app && { [ -f supabase/functions/slack-post/index.ts ] || { echo "The new code isn't in this folder yet."; false; }; } && R=htnchiljplrnjkwimgla && supabase functions deploy slack-post --project-ref $R --use-api && supabase functions deploy notify --project-ref $R --use-api && supabase functions deploy slack-standup --no-verify-jwt --project-ref $R --use-api && supabase functions deploy ics-feed --no-verify-jwt --project-ref $R --use-api && supabase functions deploy public-form --no-verify-jwt --project-ref $R --use-api && supabase functions deploy daily-reminders --no-verify-jwt --project-ref $R --use-api && echo "All six functions deployed."; unset SUPABASE_ACCESS_TOKEN
```

Then check they answer: `ics-feed` should say `204`, `public-form`
`{"ok":true}` and `slack-standup` `401` (strangers can't trigger it):

```bash
curl -s -o /dev/null -w "ics-feed: %{http_code}\n" "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/ics-feed?ping=1"; curl -s -w "  (public-form)\n" "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/public-form?ping"; curl -s -o /dev/null -w "slack-standup: %{http_code}\n" -X POST "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/slack-standup"
```

**11e. Schedule the daily Slack stand-up.** It reuses step 5's scheduler and
Vault secret. In the SQL editor:

```sql
do $check$ begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'Switch on pg_cron and pg_net first (step 5a)';
  end if;
  if not exists (select 1 from vault.secrets where name = 'kanbo_cron_secret') then
    raise exception 'Store the cron secret in the Vault first (step 5c)';
  end if;
end $check$;

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

The function works in UK time itself and only posts on weekdays, at each
workspace's chosen time. Check it after 15 minutes with the query in slack.md
(step 2c): the latest `status` should be `succeeded`.

**11f. Connect a Slack channel.** Each team workspace's owner or admin makes an
Incoming Webhook at <https://api.slack.com/apps> and pastes it in **Settings ›
Calendar & integrations › Slack** (slack.md, step 3, has the clicks).

---

## Reference

### Which functions check for a signed-in user

This matches `supabase/config.toml`. Deploy the "no" rows with
`--no-verify-jwt`.

| Function | Gateway JWT check | Who calls it |
|---|---|---|
| `ai-assist`, `approve-access`, `create-checkout`, `customer-portal`, `delete-account`, `invite-member`, `notify`, `slack-post` | yes | the signed-in app |
| `request-access`, `reset-password` | no | signed-out forms (throttled per email and per network) |
| `daily-reminders`, `slack-standup` | no | pg_cron with `x-cron-secret` (anyone else gets 401) |
| `ics-feed` | no | calendar apps, with the person's private feed token |
| `public-form` | no | signed-out visitors to a public request form (token, honeypot and limits) |
| `calendar` | no | Google/Microsoft redirect back without a JWT. Every other action checks the user itself |
| `stripe-webhook` | no | Stripe, checked by signature |
| `metrics` | no | an external dashboard with `METRICS_TOKEN` |

### Vercel (the app)

These are set under Project → Settings → Environment Variables at
<https://vercel.com/danchappell7-gmailcoms-projects/kora/settings/environment-variables>.
The app redeploys automatically on every push to `main`.

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://htnchiljplrnjkwimgla.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the project's anon key |
| `VITE_SENTRY_DSN` | optional, for error monitoring |
| `VITE_APP_ENV` | `production` |
| `VITE_BILLING_ENABLED` | leave unset to keep billing off |
| `VITE_DISABLE_SIGNUP` | set to `true` for invite-only |
| `VITE_ENABLE_GOOGLE` | set only once the Google provider is configured in Supabase |
| `VITE_VAPID_PUBLIC_KEY` | the **public** VAPID key (step 11b). Push stays hidden without it |

### Billing (Stripe), when you switch it on

1. In Stripe, create a monthly **Personal** price and a per-seat **Team**
   price, and copy both `price_…` IDs.
2. Add the secrets `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PERSONAL`,
   `STRIPE_PRICE_TEAM` and `STRIPE_WEBHOOK_SECRET` at
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions/secrets>.
3. Deploy the three billing functions:

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy create-checkout --project-ref htnchiljplrnjkwimgla
```

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy customer-portal --project-ref htnchiljplrnjkwimgla
```

```bash
SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy stripe-webhook --project-ref htnchiljplrnjkwimgla --no-verify-jwt
```

4. In Stripe, go to **Developers → Webhooks** and add
   `https://htnchiljplrnjkwimgla.supabase.co/functions/v1/stripe-webhook` for
   `checkout.session.completed`, `customer.subscription.updated` and
   `customer.subscription.deleted`.
5. Set `VITE_BILLING_ENABLED=true` in Vercel and redeploy.

### Calendar sync

The Google and Microsoft set-up is in `CALENDAR_SETUP.md`. Deploy `calendar`
with `--no-verify-jwt` (step 4). The Google/Microsoft redirect URL is
`https://htnchiljplrnjkwimgla.supabase.co/functions/v1/calendar/callback`.

The old way of connecting could let someone connect a colleague's calendar
to their own account by sending them the Google approval link. Switch it off
once the app update that finishes calendar connections itself is live. You
can tell the update is in when `grep -n "finishInApp: true" src/App.tsx` and
`grep -n "=== \"finish\"" src/App.tsx`, run in the project folder, both
print a line, and connecting a calendar on www.kanbo.co.uk shows "Google
calendar connected" (or "Outlook calendar connected"), with the provider's
name. The old way says just "Calendar connected". Then add this secret at
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions/secrets>:

| Name | Value |
|---|---|
| `CALENDAR_APP_FINISH_ONLY` | `true` |

Don't add it before that app update is live, or connecting a calendar will
fail with "Couldn't connect that calendar".

**Several accounts and chosen calendars (0045).** People can connect more
than one Google or Outlook account and choose which calendars Kanbo shows
from each. Deploy the updated `calendar` function **first**, then run
`supabase/migrations/0045_multi_calendar.sql`: the old function can't save a
connection once 0045 has dropped the one-per-provider rule. No Google Cloud
change is needed. Outlook now also asks for `User.Read`, which the Azure app's
API permissions already list (CALENDAR_SETUP.md), and the standard sign-in
scope `profile`. Details, and what happens in between, are in
[calendar-accounts.md](docs/integrations/calendar-accounts.md).

### Local development

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run dev
```

Checks before pushing: `npx tsc --noEmit -p .`, `npx vitest run` and
`npx vite build`. If the Supabase values in `.env` are left blank, the app
runs in demo mode.
