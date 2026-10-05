# Public request forms

"Anyone with the link can submit": a request form can have a public link
(`https://www.kanbo.co.uk/f/<token>`) that people outside the team open without
an account. What they send becomes a task in the form's project, assigned to
the project's owner, with an Inbox item for them ("New request: …"). The link
can be copied, opened, shown as a QR code (downloadable SVG), switched off
(the same link comes back when it's switched on again) and regenerated (the old
link and QR code stop working straight away).

## What has to be in place

| Piece | Where | Status before you do anything |
|---|---|---|
| Migration 0043 (`forms.public_token`, `forms.public_enabled`, `rotate_form_public_token()`) | [database-0043.md](database-0043.md) | Until it's run, the form card says "Public links aren't switched on for Kanbo yet" and nothing else changes. |
| Migration 0042 (`rate_limits`) | already live | The function's rate limits fail open without it. |
| Edge function `public-form` | below | Until it's deployed, a switched-on link shows "This form isn't available right now", and the form card warns "The public page isn't live yet". |

No secrets to add: the function only uses the built-in `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. Nothing changes on Vercel: `/f/<token>` is served by
the existing catch-all rewrite and rendered before sign-in.

## Owner steps

1. Run migration 0043 if you haven't yet ([database-0043.md](database-0043.md)).
2. Deploy the function (the gateway JWT check is off for it in
   `supabase/config.toml`; the flag makes that explicit):

   ```sh
   supabase functions deploy public-form --no-verify-jwt --project-ref htnchiljplrnjkwimgla
   ```

3. Check it answers:

   ```sh
   curl -s "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/public-form?ping"
   # {"ok":true}
   ```

## How to test it with a real form

1. In Kanbo, open a team project › **Requests**, pick a form (or make one) and
   switch on **Anyone with the link can submit**. A link appears.
2. **Copy link**, then open it in a private window (signed out). You should see
   the form with the project's cover and emoji, the team's name, and only the
   fields the form asks for (never "assignee").
3. Fill it in and press **Send request**. You get "Request sent" and a
   reference like `KB-7F3A9C`.
4. Back in Kanbo: the task is in the project, assigned to the project's owner,
   status To do, its description starting
   `Request via <form name> (public link).` then `From: <name> <email>`. The
   project owner has an Inbox item "New request: …".
5. Switch the link off and reload the public page: "This form isn't taking
   requests". Switch it on again: the same link works again.
6. **Regenerate link** › confirm: the old link now says "We couldn't find this
   form"; the new one works.
7. `https://www.kanbo.co.uk/f/demo` always shows the preview (demo data, nothing
   is sent).

From a terminal (replace `TOKEN` with the part of the link after `/f/`):

```sh
curl -s "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/public-form?t=TOKEN"
curl -s -X POST "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/public-form?t=TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test request","name":"Test Person","email":"test@example.com","description":"Sent with curl"}'
# {"ok":true,"reference":"KB-…"}   (delete the test task afterwards)
```

## What the function answers

| Call | Answer |
|---|---|
| `GET ?t=<token>` | `200 { form }` — name, intro (the form's description), project name / emoji / colour, team name and logo, which of description / priority / due date it asks for. Nothing else: no ids, no people, no token. |
| | `404 not_found` (no such link), `410 disabled` (switched off, or the project was archived or deleted, or the account behind it is suspended), `429 rate_limited` (+ `Retry-After`), `503 unavailable` (0043 missing or a database error) |
| `POST ?t=<token>` | `200 { ok: true, reference }`, `400 invalid` (+ `field`, `fields`: the same messages the page shows), `404`, `410`, `429`, `503` |
| `GET ?ping` | `200 { ok: true }` (lets the app see the function is deployed) |

## The rules it enforces

- **Strict whitelist.** Only `title`, `name`, `email`, `description`,
  `priority`, `dueDate` (and the honeypot `website`) are read; a field the
  form doesn't ask for is ignored. Everything else in the task (project,
  team, creator, assignee, status) comes from the form's own row.
- **Caps.** Title 200 characters, name 120, email 254, details 5,000; the body
  is cut off at 24 KB. Control characters and invisible direction marks are
  stripped. The page enforces the same rules (one shared module:
  `supabase/functions/_shared/publicForm.ts`).
- **Honeypot.** A hidden "website" field people never see. If it's filled in,
  the function answers with a normal-looking reference and stores nothing.
- **Rate limits** (in `rate_limits`; IPs, emails and tokens are hashed):
  reads 120 per IP per 10 minutes; sends 5 per IP per 10 minutes, 50 per form
  per hour, 3 per email address per 10 minutes.
- **Who gets the task.** The project's owner if they're an active owner, admin
  or member in good standing; otherwise the form's creator; otherwise the
  team's owner. The Inbox item respects their "assigned" notification setting.

To clear the limits while testing:

```sql
delete from public.rate_limits where key like 'kanbo:pf:%';
```

## Where it lives

- Page: `src/public/PublicFormPage.tsx` (+ `publicForm.css`), rendered by
  `src/main.tsx` for `/f/<token>` before sign-in, in Paper unless the visitor's
  system is dark.
- In the app: `src/components/integrations/PublicLinkPanel.tsx` (+ `publicLink.css`),
  inside each form's card.
- Library: `src/lib/publicForms.ts`; QR codes: `src/lib/qr.ts` (pure SVG, no
  dependencies).
- Function: `supabase/functions/public-form/index.ts` (HTTP) and `handler.ts`
  (everything it decides, unit-tested).
