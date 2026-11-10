# Database update 0057: rolling Kanbo out to a business

Migration file: `supabase/migrations/0057_adoption_health.sql` (the commented
source). It needs 0016, 0032, 0038, 0041 and 0042, works with or without
0043–0056 (goals change hands only once 0052 is in), and is safe to run more
than once: re-running keeps every join date, rollout plan and handover.

## What it adds

| Part | Table / function | Who can see and do what |
|---|---|---|
| Join dates | `workspace_members.joined_at` | When someone joined (an invite claimed, or added as active). Set by the database, never by the app. People who joined before this file have none ("a while ago"). The "Welcome to …" card on Today is for people who joined in the last 30 days. |
| The rollout plan | `workspaces.rollout`, `set_workspace_rollout(ws, plan)` | A champion, a pilot group (up to 20) and a go-live date. Set by the workspace's owners and admins; the champion and the pilot group must be its owners, admins or members (never a guest or an outsider). |
| Who's been active | `workspace_activity(ws)` | For the workspace's owners and admins only: for each person, how many of the last 7 days they were active and the last day they were, and how many people were active each day. Days only, never a time of day. Active means they opened Kanbo that day, or worked in this workspace (a task changed, a comment, an update). |
| Provision a business | `admin_provision_business(name, owner email, domain, pack)` | Platform admins only (the database checks). Makes the workspace (you own it while you set it up), invites the owner-to-be as an admin, optionally approves their company's email domain (never a public mail domain such as gmail.com or outlook.co.uk), and records a handover. |
| The handover | `workspace_handovers` (no app access at all) | When the owner-to-be accepts that invite, the business becomes theirs: they're the owner, you stay as an admin, and the projects, open tasks, goals and portfolios you set up for them pass to them. Withdrawing that invite, or changing its role, calls the handover off for good. The workspace history credits the role changes to you, not to them. |
| Adoption by workspace | `admin_workspace_adoption()` | Platform admins only: for each workspace, its people, invites, who worked there this week, tasks done and the last day anyone worked there. The admin who provisioned a business isn't counted. |

## Owner steps

1. Run the migration in the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
   (paste the whole file, press **Run**; "Success. No rows returned").
   - *"0057 needs …"*: run the file it names, then this one again.
2. Check it with the VERIFY block at the end of the file: every column should
   say `true`.

No functions to deploy, no new secrets and no new schedule.

## Running other files again

| If you run… | What happens |
|---|---|
| 0041 | Nothing changes here: 0057's table is its own, and 0041 doesn't touch its rules. |
| 0042 | Nothing changes here: 0042 replaces `claim_invites`, and the handover is a trigger on `workspace_members`, so it works with either. |

## How it works

- **Workspace health** (Team › People, owners and admins only): invites not
  accepted yet (Resend all), who was active this week (by day), open tasks
  with no owner or no date (Sort them out), projects whose update is missing
  (Ask for updates, once 0053's update asks are in), goals with no check-in
  for 14 days, and the rollout plan. A new workspace says "Just getting
  started", never "All good". Kanbo noticed on Today offers one of these
  fixes at a time, after your own work (Radar's risks on it included), and
  only while a workspace is being rolled out: one made since 10 Nov 2026 in
  the last 60 days, or one with a rollout plan whose go-live is ahead or was
  in the last 30 days. A business that was already going gets no daily card.
  The "Get set up" list is the same: a workspace made before 10 Nov 2026
  gets it only if its owner never finished the old list.
- **Welcome to …** on Today, for someone who joined lately: their projects,
  their people (with "Off today" from 0055), the team's goal for the
  quarter, who to ask and one or two tasks to start with. Shown once.
- **Provision a business** (/admin): name, pack, the owner's email and,
  if you choose, their company domain. The steps show as they run.
- **Before 0057 is run.** Everything works as it did. Activity and the
  rollout plan say "Not switched on yet", the welcome card goes by account
  age instead of join date, and the /admin panels say to run 0057.
