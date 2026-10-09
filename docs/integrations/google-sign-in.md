# Sign in with Google

"Continue with Google" sits above the email box on the sign-in page (and on
`/admin`). It opens Google's account chooser, comes back to Kanbo, and lands
people in the same account they'd reach with their email and password.

## What has to be in place

Do these **in this order**. Until every row is done, the button stays hidden
and email and password work as before.

| Piece | Where | Until it's done |
|---|---|---|
| **"Confirm email" ON** | DEPLOYMENT.md Step 7 (7a–7e), then <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/providers> › **Email** | **Blocking.** The button stays hidden while Supabase reports `mailer_autoconfirm: true`. See "Why Confirm email comes first". |
| Google Cloud web client with the redirect URI `https://htnchiljplrnjkwimgla.supabase.co/auth/v1/callback` | <https://console.cloud.google.com/auth/clients> (the **Kanbo** project) | Nothing to see yet. |
| Google provider switched on, with that client's ID and secret | <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/providers> › **Google** | The button stays hidden: Supabase reports `google: false`. |
| `VITE_ENABLE_GOOGLE=true` on Vercel (Production and Preview), then a redeploy | Vercel › kora › Settings › Environment Variables | The button isn't built into the page at all. |
| Optional: the company hint, `sign_in_hints()` | the SQL below | No hint: Google lists every account on the device. |

The sign-in page reads Supabase's public settings
(`GET /auth/v1/settings`, public key only) on every visit. It shows the
button only when they say Google is on **and** Confirm email is on. If they
can't be read, the button stays hidden. A press made before they arrive waits
for them.

## Why Confirm email comes first

Supabase links a Google sign-in to an existing Kanbo account with the same
email address. Kanbo relies on that: someone who has always used a password
can press "Continue with Google" and land in their own work.

While **Confirm email** is off, every password sign-up counts as confirmed,
even though nobody has proved they own the address. Someone could sign up as
`sam@yourcompany.co.uk` with a password of their choosing. When the real Sam
later presses "Continue with Google", Supabase would link Sam's Google login to
that account. The stranger's password would still open it, including any team
workspace Sam is invited into.

With Confirm email on, a sign-up nobody confirmed stays unconfirmed. When the
real owner signs in with Google, Supabase removes that account's password and
any other unconfirmed logins before linking. That's why the app checks the
switch itself, as well as these steps.

**Accounts made while Confirm email was off** were never proven. Before you
switch Google on, look through
<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/users> for
addresses at your company that nobody recognises, and delete them.

## The company hint (optional): `sign_in_hints()`

When exactly **one** company domain is auto-approved (**/admin › Auto-approved
company domains**), Google's account chooser can list that company's accounts
first. "Use another Google account" sits underneath for everyone else. It's
only a hint: it never decides who gets in.

The app asks the database for that one domain through `sign_in_hints()`. That
function is **not part of any migration**, 0047 included. It's a one-off paste,
kept in the repository as
[`supabase/sql/sign_in_hints.sql`](../../supabase/sql/sign_in_hints.sql). It's
safe to run more than once.

1. Open <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>.
2. Paste this and press **Run**. It says **Success. No rows returned**.

```sql
create or replace function public.sign_in_hints()
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object('google_hd',
    (select case when count(*) = 1 then min(d.domain) end from public.approved_domains d));
$$;
revoke execute on function public.sign_in_hints() from public;
grant execute on function public.sign_in_hints() to anon, authenticated, service_role;
```

3. Check it. Paste this and press **Run**. Both columns should say `true`:

```sql
select
  to_regprocedure('public.sign_in_hints()') is not null                  as hint_function,
  has_function_privilege('anon', 'public.sign_in_hints()', 'execute')    as sign_in_page_can_ask;
```

**What it makes public.** Anyone, signed in or not, can call it and learn the
one auto-approved domain. It returns nothing when there are none or several,
and never a list. That's the same domain the sign-in page shows ("Shows your
@yourcompany.co.uk Google accounts first"). The approved-domains list itself
stays admins-only.

**Without it**, or with a database rebuilt from the migrations alone, there's
simply no hint. Browsers remember "no hint" for six hours, so after running the
SQL a returning visitor may not see the hint until then. A private window shows
it straight away.

**Prefer to set it by hand?** Set `VITE_GOOGLE_HD` on Vercel to your domain (for
example `yourcompany.co.uk`), or to `off` for no hint at all, and redeploy. The
setting wins over the database.

## If the button doesn't appear

Check these in order:

1. **Confirm email** is on: <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/auth/providers>
   › **Email**. While it's off the button stays hidden on purpose.
2. **Google** is switched on, on the same page, with the client ID and secret
   filled in.
3. `VITE_ENABLE_GOOGLE` is `true` for that environment on Vercel, and you
   redeployed after setting it.

Supabase can take a minute to report a changed switch. Reload the sign-in page
in a private window after that.
