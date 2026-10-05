# Calendar feed: "Add Kanbo to your calendar"

Each person gets a private calendar link. Google Calendar, Outlook and Apple
Calendar subscribe to it and show that person's planned work in Kanbo. No
Google or Microsoft sign-in and no new OAuth scopes are involved: the
unguessable token in the link is the only key.

What the feed contains:

- **Planned blocks** for today and the next 14 days, shown as busy time.
  - On the person's own tasks, these come from the task's slot ("on today" plus a time).
  - On anyone else's task, they come from that person's own plan (`task_user_state`).
  - Each block is titled "Task · Project". Its length is the task's planned duration, else its focus length, else 30 minutes.
- **Due dates**, which people can switch off. They show as all-day events marked *free* ("Due: Task · Project", or "Due 15:00: …" when a time is set). Due dates are included for:
  - tasks assigned to the person;
  - tasks they collaborate on;
  - their unassigned personal tasks.
- Every event links back to `https://www.kanbo.co.uk/?task=<id>`. The link is in the event's URL and also in its description, because Google ignores the URL field.
- Done and archived tasks never appear, and nor do tasks in an archived project (the app hides those everywhere).
- The feed only includes tasks the person can see in the app: their personal tasks, plus workspaces where they're an active member or guest. A suspended or unapproved account gets an empty feed. Leaving a workspace removes its tasks from the feed straight away.

Where people find it: **Settings › Calendar & integrations › Add Kanbo to your
calendar**. The panel offers:

- Copy the link. It stays hidden until they choose Show.
- Add to Google Calendar, which opens Google with the subscription ready.
- Outlook.com, or Outlook for work or school.
- Steps for Apple Calendar and Outlook for Windows.
- Include due dates (on or off).
- Reset link. This makes a new link, and the old one stops working at once.

## Before you start

- Migration **0043** must have been run (see `database-0043.md`). Until then the panel says "Not switched on yet" and nothing else changes.
- The panel also says "Not switched on yet" until the function below is deployed. It checks with `GET …/functions/v1/ics-feed?ping=1` (no token, no database), which answers `204` once the function is live, so nobody is handed a link Google or Outlook can't read. Running 0043 and deploying the function are separate steps; do both.
- Migration **0042**'s `rate_limits` table is used for throttling. Without it the function still works, just without limits.

## Owner steps

1. **Deploy the function** from the repo root. JWT verification must stay **off**, because calendar apps can't sign in:

   ```sh
   supabase functions deploy ics-feed --no-verify-jwt --project-ref htnchiljplrnjkwimgla
   ```

   `supabase/config.toml` already declares `[functions.ics-feed] verify_jwt = false`, so a plain deploy keeps it off too.

2. **Secrets.** `APP_URL` is already set for the reminder emails; the feed uses it for the links back to tasks. Check it with:

   ```sh
   supabase secrets list --project-ref htnchiljplrnjkwimgla
   ```

   If `APP_URL` is missing, the feed falls back to `https://www.kanbo.co.uk`. To set it explicitly:

   ```sh
   supabase secrets set APP_URL=https://www.kanbo.co.uk --project-ref htnchiljplrnjkwimgla
   ```

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to every function automatically. Nothing else is needed: no new keys and no Vercel change.

## Check it works

0. The function is live and open to calendar apps:

   ```sh
   curl -si "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/ics-feed?ping=1" | head -n 1
   ```

   You should see `HTTP/2 204`. A `404` means it isn't deployed; a `401` means it was deployed with JWT verification on.
1. Sign in on <https://www.kanbo.co.uk>. Open **Settings › Calendar & integrations** and choose **Copy** under "Your private calendar link".
2. In a terminal (paste the link between the quotes):

   ```sh
   curl -si "<the link>" | head -n 20
   ```

   You should see:
   - `HTTP/2 200`
   - `content-type: text/calendar; charset=utf-8`
   - `cache-control: private, max-age=900`
   - an `etag`
   - a body that starts with `BEGIN:VCALENDAR`

   Plan a task on Today with a time and it appears as a `BEGIN:VEVENT` block. The 15-minute cache is a hint to calendar apps; `curl` always gets a fresh copy.
3. Conditional requests: repeat the request with the ETag you got and it should answer `304`:

   ```sh
   curl -si -H 'If-None-Match: "<etag>"' "<the link>" | head -n 1
   ```
4. A wrong token answers `404`:

   ```sh
   curl -si "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/ics-feed?t=0000000000000000000000000000000000000000000000000000000000000000" | head -n 1
   ```
5. In the panel, choose **Add to Google Calendar**. Google opens with "Add calendar?" showing the Kanbo feed; choose **Add**.
   - **Google refreshes subscribed calendars on its own schedule, usually every few hours and sometimes up to a day.** This is Google's behaviour and can't be changed from our side; the panel says so.
   - Apple Calendar can refresh every 15 minutes (the panel tells people to set this).
   - Outlook checks every few hours.
6. **Reset link** in the panel: the old link now answers `404`, and the new one works.

## Limits and privacy

- **Rate limits:**
  - 120 fetches an hour per link (calendar apps poll far less often), then `429` with `Retry-After`.
  - 30 wrong tokens per 10 minutes per IP, then `429`.
  - Keys in `rate_limits` hold a hash of the token or IP, never the value itself.
- **Errors:** a database error answers `503` (with `Retry-After: 300`), never an empty calendar. An empty calendar would wipe people's events until the next refresh.
- **The link is a password.** The function never logs the token. Responses carry `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. The panel keeps the link hidden on screen until asked.
- **If a link leaks:** the person chooses **Reset link**. To cut one off yourself, delete their row in SQL. Their next visit to the panel makes a new link.

  ```sql
  delete from public.calendar_feed_tokens where user_id = '<user id>';
  ```

- **Time zones:** times are written in UTC, so every calendar app places them correctly. Planned slots are read as Europe/London wall-clock times, including on the two clock-change days.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| Panel: "Not switched on yet" | 0043 hasn't been run, or the function isn't deployed (or was deployed with JWT verification on) | Run 0043 (`database-0043.md`) and deploy with `--no-verify-jwt`; check step 0 above answers `204`. Then reload Kanbo: the panel remembers the answer until the page is reloaded |
| `curl` answers `401` "Missing authorization header" | The function was deployed with JWT verification on | Redeploy with `--no-verify-jwt` |
| `curl` answers `404` for a fresh link | The function isn't deployed, or the link was reset | Deploy it, or copy the link again |
| Google says it couldn't add the calendar | Google fetches the link from its own servers; a `401`/`404` breaks this | Fix the `curl` check first, then try again |
| Events look an hour out | The calendar app's own time zone setting is wrong | Times are UTC in the feed. Check the app's settings |

## Turning it off

```sh
supabase functions delete ics-feed --project-ref htnchiljplrnjkwimgla
```

Every subscribed calendar stops updating. The tokens left in the database are harmless.

## Files

| File | Purpose |
|---|---|
| `supabase/functions/ics-feed/index.ts` | The edge function (a thin wrapper) |
| `supabase/functions/_shared/icsFeed.ts` | Request handling: the `?ping=1` check, token lookup, limits, queries, ETag/304. Tests: `icsFeed.test.ts` |
| `supabase/functions/_shared/ics.ts` | RFC 5545 builder and "what goes in the feed". The one copy; the app re-exports it from `src/lib/ics.ts`. Tests: `ics.test.ts` |
| `src/lib/calendarFeed.ts` | The panel's data: `calendar_feed()` plus the once-a-session function check, include due dates, reset, subscribe URLs |
| `src/components/integrations/CalendarFeedPanel.tsx` | The Settings panel. Styles: `calendarFeed.css` |
