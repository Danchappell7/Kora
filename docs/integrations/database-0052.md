# Database update 0052: Goals 2.0 (owners, quarters, check-ins, links)

Migration file: `supabase/migrations/0052_goals_v2.sql` (the commented
source). It needs 0041, 0042 and 0051, works with or without 0043–0050 (0046's
API key scope and 0048's search and saved views are used when they're there),
and is safe to run more than once: re-running keeps every owner, check-in and
link.

## What it adds

| Part | Table / function | Who can see and do what |
|---|---|---|
| Owners and helpers | `goals.owner_id`, `contributors` | A team goal's owner is whoever made it unless they name someone. Owners and helpers are the workspace's owners, admins and members, never a guest or an outsider. Owners, admins and the goal's owner hand it over. |
| Quarters | `goals.period`, `period_start`, `period_end` | 2027-Q1, 2027-H1, 2027-FY, or custom dates. A named one fills its own dates. |
| Measures | `start_value`, `direction`, `confidence`, `kind`, `pace`, `weight` | Higher or lower is better, confidence 1–5, objective / key result / metric, linear or back-loaded pace, how much a key result counts in its goal's roll-up. |
| Look | `icon`, `color`, `archived_at` | A goal's icon and colour; archived goals leave the list but keep their history. |
| Who reads | `visibility`, `goal_readable(…)` | A team goal: the workspace's owner, admins and members (never guests, 0051). **Leadership only**: owners and admins, the goal's owner and its helpers, and the same for every goal under it (its key results, theirs and so on), without locking each one. A member still sees a key result that's theirs. Opening the goal up again shows its key results as they were. |
| Who edits | `goal_editable(…)` and four restrictive policies | Owners and admins edit and delete any team goal; the goal's owner and helpers edit theirs. Company goals (a team goal with nothing above it) are set by owners and admins. A key result goes under a goal you can edit. A goal with key results under it is deleted by owners and admins only (its key results stay, as goals of their own). Before 0052 any member could do all of this. |
| Check-ins | `goal_checkins` | A value, a confidence and a one-line note. The newest sets the goal's value. Whoever may edit the goal posts one; its author fixes the note; its author, an owner or an admin takes it back (the one before it is the value again). Read with the goal. |
| Links | `goal_links` | A goal to projects, tasks and shared saved views in its own workspace (a personal goal: your own personal work). Whoever may edit the goal adds and removes them. Read with the goal. |
| Search | `search_all` (0048) | Finds goals by name and description, for whoever can read them. |

Personal goals (no workspace) stay their creator's alone.

## Owner steps

1. Run 0051 first if it isn't in (`select version from public.schema_migrations
   where version = '0051'` returns a row when it is).
2. Run the migration in the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
   (paste the whole file, press **Run**; "Success. No rows returned").
   - *"0052 needs 0041, 0042 and 0051 first"*: run them, then this file again.
3. Check it with the VERIFY block at the end of the file: every column should
   say `true`.

No function to deploy for 0052 itself (the app reads and writes goals
directly), no new secrets and no new schedule. For the order with 0053 and
0054, and the functions they need, see DEPLOYMENT.md › Step 17.

## Running other files again

| If you run… | What happens |
|---|---|
| 0041 | It drops every policy on `goals`, then puts 0052's back itself (`goal_rules_restore`). |
| 0048 | It puts its own `search_all` back, then puts goals back into it (`goal_search_restore`). |
| 0051 | Its guest lock and 0052's rules sit side by side; nothing to do. |

## How it works

- **Before it's run.** Goals work as they always did: anyone who writes in a
  workspace adds, edits and deletes its goals, with no owners, quarters or
  check-ins.
- **The goal panel.** Owner and helpers, quarter, start and target, a check-in
  with a confidence and a note, linked work, and key results under it. The ⋯
  menu has Icon and colour, Archive and Delete (Delete is greyed out, with the
  reason, for a member on a goal with key results under it).
- **Leadership only** (on the goal panel, for owners, admins and the goal's
  owner) hides the goal, its check-ins and links, and every goal under it, from
  everyone but owners, admins and the people on those goals.
