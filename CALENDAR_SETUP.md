# Calendar integration — setup (Google + Microsoft)

The app code is done. To make "Connect calendar" actually work, three things
need doing **once**, using your accounts. Redirect/callback URL used everywhere:

```
https://htnchiljplrnjkwimgla.supabase.co/functions/v1/calendar/callback
```

App URL (where users land after connecting): `https://kanbo.co.uk`

---

## 1. Database migration

Run `supabase/migrations/0011_calendar_connections.sql` in the Supabase SQL
Editor (same paste-and-Run as before). Creates the `calendar_connections` and
`oauth_states` tables (tokens are locked to the server — RLS on, no client access).

## 2. Google Cloud (Google Calendar)

1. <https://console.cloud.google.com> → create a project (e.g. "Kanbo").
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**: User type **External**, fill app
   name/support email. Add scopes: `.../auth/calendar.readonly`, `openid`,
   `email`. Add yourself + testers under **Test users** (testing mode allows up
   to 100 users; they'll see an "unverified app" notice they can click past —
   removing it needs Google's verification review later).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type **Web application**
   - **Authorized redirect URI**: the callback URL above
   - Copy the **Client ID** and **Client secret**.

## 3. Microsoft (Azure / Outlook)

1. <https://portal.azure.com> → **Microsoft Entra ID → App registrations → New**.
2. Supported account types: "Accounts in any org directory and personal Microsoft accounts".
3. **Redirect URI**: platform **Web**, value = the callback URL above.
4. **API permissions → Add → Microsoft Graph → Delegated**: add
   `Calendars.Read`, `offline_access`, `openid`, `email`, `User.Read`.
5. **Certificates & secrets → New client secret** → copy the **Value** (not the ID).
6. From **Overview** copy the **Application (client) ID**.

## 4. Deploy the function + set secrets

Needs the Supabase CLI (`brew install supabase/tap/supabase`), then:

```bash
supabase login                     # opens a browser to authenticate
supabase link --project-ref htnchiljplrnjkwimgla
supabase functions deploy calendar --no-verify-jwt

supabase secrets set GOOGLE_CLIENT_ID=...      GOOGLE_CLIENT_SECRET=...
supabase secrets set MS_CLIENT_ID=...          MS_CLIENT_SECRET=...
supabase secrets set APP_URL=https://kanbo.co.uk
```

(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically — no need to set them.)

`--no-verify-jwt` is required so the OAuth **callback** (reached by Google/MS,
without our token) can run; the function authenticates every other action from
the user's JWT itself, and the callback is protected by a one-time `state` nonce.

---

Once all four are done: open **Calendar → Connect calendar → Google/Microsoft**,
approve, and your real events appear in the month grid alongside tasks. You can
do just Google first and add Microsoft later — each works independently.
