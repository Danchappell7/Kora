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
   `Request via <form name> (public link).` then `From: <name> <email>` and
   `Reference: KB-…` (the reference the requester was given, so searching for
   it finds the task). The project owner has an Inbox item "New request: …".
5. The project's rules: in **Projects › Rules**, add a rule for this project,
   "When a task is created → Set section" (or Add tag, or Set assignee to a teammate) and send
   another request. The new task lands in that section, with that tag, for
   that teammate (and their Inbox), just as a form filled in inside Kanbo
   would. Delete the test rule afterwards.
6. Switch the link off and reload the public page: "This form isn't taking
   requests". Switch it on again: the same link works again.
7. **Regenerate link** › confirm: the old link now says "We couldn't find this
   form"; the new one works.
8. `https://www.kanbo.co.uk/f/demo` always shows the preview (demo data, nothing
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
| `GET ?t=<token>` | `200 { form }` — name, intro (the form's description), project name / emoji / colour (the hue the project wears in Kanbo, worked out on the server when its stored colour is a grey), team name and logo, which of description / priority / due date it asks for. Nothing else: no ids, no people, no token. |
| | `404 not_found` (no such link), `410 disabled` (switched off, or the project was archived or deleted, or the account behind it is suspended, or the form points at a project it can't file into), `429 rate_limited` (+ `Retry-After`), `503 unavailable` (0043 missing or a database error) |
| `POST ?t=<token>` | `200 { ok: true, reference }`, `400 invalid` (+ `field`, `fields`: the same messages the page shows), `404`, `410`, `429` (+ `scope`: `sender` for this network or email address, `form` when the form's hourly allowance is used up; the page words each one), `503` |
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
  reads 120 per IP per 10 minutes. Sends are checked narrowest first:
  30 per IP per 10 minutes across every form (an office or event Wi-Fi is
  one address, and a QR code on a poster invites a queue); 20 per IP per form
  per hour, so one network can never use more than a fifth of a form's hour;
  3 per email address per 10 minutes; and last, 100 per form per hour. The
  form's allowance only counts a request that is actually filed: one the
  narrower limits refuse, a bad submission or the honeypot costs it nothing,
  and a task that fails to save gives its slot back. Regenerating the link
  starts the form's hourly allowance afresh.
- **Whose project.** A team form only files into a project of its own team,
  and a personal form only into its creator's own projects (`forms.project_id`
  is free text, so the function checks it every time with the service role).
  Anything else answers `410` and shows nothing about the project.
- **The project's rules.** A request runs the project's enabled "When a task
  is created" rules, just as a form filled in inside Kanbo does (set priority,
  set assignee, set section, add tag; rules apply oldest first, so a later one
  wins, and a rule's priority wins over the requester's). Every value is
  checked first and skipped if it doesn't fit: an assignee only if they could
  be given the request anyway (below), a section only if it belongs to the
  form's project, a tag only if it's built in, the team's, or the rule
  author's own (by id, or by name for older rules when exactly one tag has
  it). On a personal form only its creator's own rules count. If the rules
  can't be read, the request is still filed, without them.
- **Who gets the task.** On a team form: the rules' assignee if they're an
  active owner, admin or member in good standing; otherwise the project's
  owner on the same terms; otherwise the form's creator; otherwise the team's
  owner. On a personal form: always its creator, whatever a rule says. The
  Inbox item goes to whoever gets it and respects their "assigned"
  notification setting.

To clear the limits while testing:

1. Open the SQL editor: https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new
2. Paste this and press **Run**:

   ```sql
   delete from public.rate_limits where key like 'kanbo:pf:%';
   ```

3. Send from the public page again.

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
