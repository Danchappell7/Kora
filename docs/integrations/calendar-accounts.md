# Calendar accounts: several accounts, chosen calendars

People can connect **several calendar accounts** (a work Google account, a
personal Google account and an Outlook account, say). Inside each account they
choose **which calendars** Kanbo shows, not just the main one, and each
calendar keeps its own colour.

Where people find it: **Settings › Calendar & integrations › Connected
calendars**.

- There's one row per account, showing the email, the provider and "n calendars shown", with a dot in each shown calendar's colour.
- **Choose calendars** opens the account's own list. Each calendar has a tick box, a colour swatch, its name and a *Primary* badge on the main one. Each tick saves straight away, up to 25 calendars per account. Choosing none is allowed: the account stays connected but shows nothing.
- **Disconnect** removes that account only.
- **Add Google account** and **Add Outlook account** are always there. Google and Microsoft always ask *which* account, so adding a second account of the same kind is just another click.
- If an account can't be read any more (access withdrawn, password changed), its row says so: *"Kanbo can no longer read this account. Disconnect it and add it again."* A calendar that failed to load once says so too, and Kanbo tries again on the next sync.

What uses the calendars:

| Where | What changes |
|---|---|
| **Today** (the canvas) | Meetings from every shown calendar, in every account. Each has a thin left edge in its calendar's colour; hover shows the calendar's name, and screen readers hear it. |
| **Plan my day / auto-scheduling** | Busy time includes every shown calendar, so nothing is planned over a personal appointment from another account. |
| **Today › Month** (and Week) | Events show with their calendar's colour edge. A row of chips names every calendar shown. Clicking a chip hides that calendar on Month **on this device only**, until it's clicked again. It's a "not right now" switch: Settings decides what's connected. |

The same meeting in two shown calendars (a work invite copied to a personal
calendar, or a shared team calendar) shows **once**. Kanbo matches the
meeting's calendar ID and its start time.

Colours are the provider's own, with two exceptions. Two calendars that would
share a colour, in the same account or across accounts, get different ones
from Kanbo's palette. And every colour is re-toned to the theme's lightness,
like project colours, so it reads in light and dark mode. The colour is never
the only cue: the calendar's name is in the legend, the hover text and the
screen-reader text.

## What's stored, and where

`calendar_connections` (migration 0011, extended by **0045**):

| Column | Meaning |
|---|---|
| `id` | The connection's id. The app uses it to refer to one account. |
| `user_id`, `provider`, `account_email` | Unique per account: `(user_id, provider, lower(account_email))`. Before 0045 this was one row per provider. |
| `access_token`, `refresh_token`, `expires_at`, `scope` | OAuth tokens. They are **server-side only**. |
| `selected_calendars` | `[{id, name, color, primary}]`, at most 25. `NULL` means "the primary calendar only", which is what every connection made before 0045 has, so nothing changed for anyone until they choose. |

Both `calendar_connections` and `oauth_states` keep RLS on with **no
policies**, and 0045 also revokes every grant to `anon` and `authenticated`.
Only the `calendar` Edge Function (service role) reads or writes them. The
browser only ever sees a connection's id, provider, account email and its
calendar list or choice. Tokens never leave the server: not in responses, and
not in the function's logs.

## The `calendar` function

| Call | What it does |
|---|---|
| `GET ?action=connect&provider=google\|microsoft&finish=app` | The consent URL. It always shows the account chooser: Google `prompt=select_account consent`, Microsoft `prompt=select_account`. |
| `GET ?action=finish&state=…&code=…` | Saves the account. The same account again (any case) refreshes its tokens and keeps its id and calendar choice. A new account starts on its primary calendar, in a colour no other account uses. |
| `GET ?action=list` | `{ connections: [{ id, provider, accountEmail, selectedCalendars }], multi }`. It also returns the old field names (`account_email`, `created_at`) for apps from before this change. |
| `GET ?action=calendars&connection=<id>` | That account's calendars (Google `calendarList`, Microsoft `/me/calendars`) with id, name, colour, primary, access role and whether each is shown. |
| `POST { action: "select", connection, calendarIds }` | Saves the choice. Every id must be in the provider's own list, at most 25. Names and colours come from the provider, never from the request. |
| `GET ?action=events&start=…&end=…` | Every account × every shown calendar (or the primary), fetched in parallel: 6 at a time, 8 s per call, at most 60 calendars. Each event is tagged with `connectionId`, `calendarId`, `calendarName` and `color`. A failing account or calendar goes into `warnings`; the others still arrive. Each account's token is refreshed once and shared by its calendars. |
| `POST { action: "disconnect", connection }` | Removes that one account. `provider` on its own (the old way) removes every account of that provider. |

Scopes are unchanged and still read-only. Google's `calendar.readonly`
already covers listing an account's calendars, and Microsoft's
`Calendars.Read` covers `/me/calendars`. **No Google Cloud or Azure change is
needed:** same client, same redirect URL, same consent screen.

One limit to know about: an Outlook calendar that **someone else** shared with
the account can appear in the list. Reading it needs Microsoft's
`Calendars.Read.Shared`, which Kanbo doesn't ask for. If someone ticks one,
it shows as "Couldn't load …" and everything else carries on. To support those
calendars later, add `Calendars.Read.Shared` to the Azure app and to the
function's Microsoft scope, and people reconnect.

## Order of deployment, and what happens in between

Deploy the updated **function first**, then run **0045**. The old function
saves connections with `ON CONFLICT (user_id, provider)`, and 0045 removes
that rule, so with 0045 in place and the old function still live, *connecting*
a calendar fails until the new function is deployed. Lists and events keep
working either way.

| Function | Database | What people get |
|---|---|---|
| old | before 0045 | Today's behaviour: one account per provider, primary calendar. |
| **new** | before 0045 | It still works. One account per provider (a second one replaces the first, and the app says so). Primary calendars only. "Choose calendars" isn't offered, and Settings says adding a second account of the same kind replaces the first. |
| **new** | **0045** | Everything above. |
| old | 0045 | Avoid: connecting fails. Deploy the function. |

The app copes with all of these. Against an old function it shows each
account's main calendar with no chooser. If the function can't be reached,
Settings shows nothing connected rather than an error.

## Demo mode

The demo has two example accounts:

- `daniel@foundrise.co` (Google): Work, Launch team, Interviews, and Holidays in the United Kingdom, which isn't ticked.
- `daniel.okai@outlook.com` (Outlook): Calendar, Family, and Birthdays, which isn't ticked.

Each calendar has its own colour and there's a believable month of meetings.
Ticking, unticking and disconnecting work for the session. Today's
illustrative day is coloured by the same calendars. *Add Google account* in
the demo explains that connecting needs a Kanbo account.

## Tests

- `supabase/functions/_shared/calendars.test.ts`: provider lists, colours, validation, timeouts, de-duplication.
- `supabase/functions/_shared/calendar.functions.test.ts`: the whole function under a stubbed Deno. It covers several accounts, choosing, events with one broken, slow or revoked account, the behaviour before 0045, and checks that no token reaches a response or the logs.
- `src/components/integrations/CalendarAccountsPanel.test.tsx`, `src/lib/calendars.test.ts`, `src/data/demoCalendars.test.ts`, the CalendarView, PlanView and planCanvas cases, and `store.test.ts` ("several accounts and a choice of calendars").
- Database: the PGlite replay runs 0045 twice on the real migration history, with legacy rows. It also runs on 0011 alone with a hand-made table that has no primary key, and on an empty database. It checks RLS and grants, uniqueness per account, the selection's shape and the 25 limit, and that re-running 0011/0043/0044 afterwards doesn't bring the old rule back.
