# Database update 0054: project updates people reply to, and portfolio pages

Migration file: `supabase/migrations/0054_update_conversation.sql` (the
commented source). It needs 0041, 0042, 0046 and 0051, works with or without
0047–0050 and 0053, and is safe to run more than once: re-running keeps every
update, section, reply, reaction, "seen by" and portfolio detail.

## What it adds

| Part | Table / function | Who can see and do what |
|---|---|---|
| Authors only | `status_updates` (three restrictive policies) | Only an update's author edits it. Its author, or the workspace's owners and admins, delete it. Until now any member could change or delete anyone's. A team update must be about a project in its own workspace. Who, where and when it was posted can't be changed. Personal updates are unchanged (their creator's). |
| Edited mark | `status_updates.edited_at` | Set when the author changes what it says. The app shows "edited". |
| Sections | `status_updates.sections` | Optional Highlights / Risks / Asks / Next (each ≤ 2000 characters, nothing else). Kanbo's drafts fill them; portfolio roll-ups read them. |
| Asks | `status_updates.ask_user_ids` | The people an Ask is for (≤ 20). Only people who can read the update are kept, never its author. |
| Replies | `status_update_comments` | Anyone who reads the update replies, guests too. You edit your own (marked edited) and delete your own. Owners and admins remove any. 120 an hour each. |
| Reactions | `status_update_reactions` | One of 👍 ❤️ 🎉 👀 ✅ 🚀 per person per update. You add and take back only your own. |
| Seen by | `status_update_views`, `mark_status_updates_seen(ids)` | Recorded by the function for the updates you read (never your own). Read by whoever reads the update. |
| Inbox | `activity` kind `update` | Posting tells the project's owner and contributors (FYI, pref `update`) and the people an Ask names ("Needs your reply", pref `mention`). A reply tells the update's author and anyone it @mentions. A deleted update takes its Inbox items with it. |
| Webhooks | `status_update.posted` | Team and personal endpoints. The update, its sections and Asks, who posted it and its project. |
| Portfolio details | `portfolios.owner_id`, `description`, `target_date`, `follower_ids`, `color`, `emoji` | A team portfolio's owner and followers are its owners, admins and members (guests can't read portfolios, 0051). Its writers change them. |
| Portfolio updates | `portfolio_updates` | Read like the portfolio (members and above; a Personal one by you). Its writers post; the author edits; the author or the workspace's owners and admins delete. The owner and followers hear (FYI). |

## Owner steps

1. Run the migration in the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
   (paste the whole file, press **Run**; "Success. No rows returned").
   - *"0054 needs 0041 and 0042 first"*, *"needs 0046"* or *"needs 0051"*: run
     that file, then this one again.
2. Check it with the VERIFY block at the end of the file: every column should
   say `true`.
3. Redeploy the two functions that use it:

```sh
supabase functions deploy notify --project-ref htnchiljplrnjkwimgla --use-api
supabase functions deploy ai-assist --project-ref htnchiljplrnjkwimgla --use-api
```

`webhook-dispatch` and `api` read the new event from a shared module (the
dispatcher sends it, the API's docs describe it), so redeploy them too if
webhooks are in use:

```sh
supabase functions deploy webhook-dispatch --no-verify-jwt --project-ref htnchiljplrnjkwimgla --use-api
supabase functions deploy api --no-verify-jwt --project-ref htnchiljplrnjkwimgla --use-api
```

No new secrets and no new schedule.

## Running other files again

| If you run… | What happens |
|---|---|
| 0041 | It drops every policy on `status_updates`, then puts 0054's three back itself. |
| 0048 | It lists `status_update.posted` in its own copy of the webhook events, so nothing breaks. |
| 0046 or 0047 | Their copy of the webhook events doesn't know `status_update.posted`: they **stop with an error** while any webhook subscribes to it. Take it off that webhook, run them, run 0048 and this file again, then put it back. |

## How it works

- **Writing an update.** Under the words there's an optional
  Highlights / Risks / Asks / Next block. Kanbo's draft fills Highlights,
  Risks and Next (its AI when it's on, else written on the device). Asks are
  yours: write what you need and pick who it's for.
- **Who hears.** The owner and contributors see it in their Inbox as FYI and
  get an email (their daily digest takes it instead if they have one; quiet
  hours hold it). The people an Ask names see it under "Needs your reply" and
  get a push too. The Inbox has an "Updates" filter.
- **The conversation.** Under each update: reactions, "Seen by 6" (names on
  hover), and Reply. Replies notify the update's author; an @mention in a reply
  notifies that person too.
- **Editing.** An update's ⋯ offers Edit to its author and Delete to its author
  and the workspace's owners and admins.
- **Portfolio pages.** Each portfolio opens at `/projects/portfolios/:id` with
  its look, owner, description, target date and followers, and a sentence like
  "6 projects: 4 on track, 1 at risk, 1 silent for 3 weeks". Table and Updates
  tabs; projects are added several at once; Export CSV and Print or PDF. On
  Updates, Kanbo drafts the portfolio's update from its projects' latest ones
  for its owner to post. Team › Insights can be narrowed to one portfolio.
- **Before 0054 is run.** Updates still post (the sections go into the words);
  replies, reactions and "seen by" aren't offered; a portfolio's details and
  updates say they aren't switched on yet.
