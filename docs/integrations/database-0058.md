# Database update 0058: project access (who can see each project)

Migration file: `supabase/migrations/0058_project_access.sql` (the commented
source). It needs 0041, 0042, 0043, 0046 and 0047, works with or without
0048–0057 (run it after 0051–0057 as planned; if any of those comes later, it
puts project access on its own tables), and is safe to run more than once:
re-running keeps every member, visibility and setting.

**Running it changes nothing anyone can see.** Every workspace starts with
Project access switched off, and while it's off every read and write is exactly
what it was before: every member and guest of a workspace reads every project.
The PGlite suite proves this by running the same battery of reads and writes,
as every kind of person, against the live database (0001–0050) and then with
0058 in and the switch off: the answers are identical.

## What it adds

| Part | Table / function | Who can see and do what |
|---|---|---|
| The switch | `workspaces.project_access`, `project_access_default`, `project_access_member_private`, `project_access_changed_at`; `set_project_access(ws, on, default, members_may_make_private)` | The workspace's owner only (Settings › Workspace › Project access). Off by default. "New projects start as" (Whole workspace, Members only or Private) applies to every new project, from the app, the API, MCP, Slack and packs. "Members can make projects private": owners and admins always can. The app can't write these columns any other way. |
| Who can see a project | `projects.visibility` (`workspace`, `members`, `private`); `set_project_visibility(project, visibility)` | **Whole workspace**: everyone in the workspace (guests only if they're added). **Members only**: the project's people, plus the workspace's owners and admins. **Private**: the project's people, plus the workspace's owner. Changed by the workspace's owner, the project's owner, its editors (not guests), and admins (not on Private projects). Nobody but the owner can change it so that they'd lose access themselves. Every project there today is Whole workspace. |
| A project's people | `project_members` (editor, commenter, viewer); `set_project_member`, `remove_project_member` | Filled once from each project's contributors (editors; guests are commenters; never the project's owner, who always edits). A guest is never more than a commenter (someone made a guest after making a project still owns it, and comments on it). Read by anyone who can see the project. Written only through the functions; `contributor_ids` is kept in step both ways, so older tabs keep working. |
| Guests invited onto projects | `project_member_invites`; `set_invite_projects(invite, grants)` | Owners and admins choose the projects a new guest will see; they become that guest's project rows when the invite is accepted. |
| What the bin and the history knew | `trash.access`, `audit_events.project_id` / `access`, `webhooks.url_set_by` | A deleted item keeps the access its project had, so the bin and the history show it only to people who could see it. A webhook's deliveries follow whoever last set its address, and what's still queued when the address changes goes only where that person can see. |

What each person can do on a project (one rank, the same table the app uses,
`src/lib/projectAccessMatrix.json`): **view** (read, follow, plan, mark updates
seen), **comment** (also comment, react, attach files, reply to updates, review
approvals) or **edit** (also change tasks, sections, fields, rules, forms and
docs, and post updates).

| Switch on | Whole workspace | Members only | Private |
|---|---|---|---|
| Workspace owner | edit | edit | edit |
| Admin | edit | edit | their project role, if any |
| Member | edit | their project role, if any | their project role, if any |
| The project's owner | edit | edit | edit |
| Guest | their project role (comment at most; comment on one they own) | the same | the same |

A task (section, rule, form, update) that isn't in one of the workspace's
projects counts as Whole workspace, so guests don't see it. While a project is
in the bin, what it left behind keeps the project's access.

## Owner steps

1. Deploy the functions first (they work before 0058: they fall back to
   today's rule), then run the migration in the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
   (paste the whole file, press **Run**; "Success. No rows returned").
   - *"0058 needs …"*: run the file it names, then this one again.
2. Check it with the VERIFY block at the end of the file: every column should
   say `true`. (`everyone_still_off` turns false once you switch a workspace
   on; that's expected.)
3. Reload Kanbo. Settings › Workspace shows **Project access**, switched off,
   with a preview of what turning it on will do.
4. For each business, when you're ready: add each guest to the projects they
   should see (the project's About tab, or the invite sheet), choose the
   default for new projects, then switch it on. Then mark HR, finance and
   leadership projects Members only or Private in their About tab. Each
   business can be done on a different day.

No new secrets and no new schedule.

## Running other files again

| If you run… | What happens |
|---|---|
| 0025, 0041, 0042, 0043, 0046, 0047, 0048 | Each drops some of these rules or puts back an older helper; each now ends by putting project access back itself. Nothing more to do. |
| 0052, 0053, 0054, 0055, 0056 | The same (they also put project access on their own tables if they're run for the first time after 0058). |
| 0051, 0057 | Nothing changes here. |
| 0058 | Nothing changes: the people, visibility and settings stay; nobody is seeded again. |

## How it works

- **The rules only narrow.** Every check is a *restrictive* policy, added on
  top of the rules that are there today, so nobody gains anything. Rows in a
  workspace whose switch is off, and every row a workspace owner reads, cost
  one array test and no lookups.
- **What it covers.** Tasks, sub-tasks, sections, custom fields, rules, forms,
  projects, comments, files, task history, docs and their versions,
  approvals, kudos, plans, snoozes, status updates and their replies,
  reactions and "seen by", goal links (and a goal's project), shared saved
  views, Notion syncs and links, bill rates, update asks, meeting agendas and
  items, the bin, the workspace history, search, live channels and the
  people a guest sees. The REST API and MCP run as the person, so they follow
  the same rules.
- **What's queued.** The database drops Inbox notices, held email and push
  notices, and webhook deliveries for people who can't see the work, and
  clears what's waiting when a project becomes more private or someone loses
  access. The edge functions deployed in step 1 filter as well; the database's
  checks are the backstop for any that are still old.
- **Meetings.** A team meeting's agenda carries only Whole workspace work; a
  leadership meeting's also Members only. Private projects are never on an
  agenda, and a meeting's notes doc can't be put in one its people can't open.
  A meeting whose notes project narrows while it runs (or that's running when
  the switch goes on) still ends; its recap goes out without the doc.
- **The bin.** A deleted task or project keeps the narrowest access its project
  had: what was captured when it went in, or, once its project is gone too,
  what the project's own bin row (or, after it's deleted for good, its history)
  says, whichever is narrower. So a task binned while its project was Whole
  workspace (or before 0058) stays closed once the project is made Private and
  deleted. A task whose project has gone comes back into the workspace's first
  Whole workspace project if its project was Whole workspace, and only with its
  project if that was Members only or Private ("Restore the project first";
  once the project is deleted for good it can't come back).
- **Sub-tasks** always have their parent's project while the switch is on.
  Turning it on frees any sub-task that was moved to another project on its
  own while it was off: it stays in its project as a task of its own, so
  moving or deleting its old parent (or the parent's project) never takes it
  along. A sub-task back from the bin under a parent that has moved since
  comes back on its own too.
- **While the switch is off** a Whole workspace project's people follow
  today's rule (any owner, admin or member). A Members only or Private one
  keeps the switch-on rule (the workspace's owner, the project's owner, its
  editors, admins on Members only), for its people and its owner alike, so
  nobody can add themselves or take one over while it's off and keep that
  when it's turned back on. Moving a project out of its workspace (to
  Personal, or another workspace) follows the same rule, switch on or off: a
  move there and back can't hand anyone a project or drop its people.
- **The history** of something deleted for good (by hand or by the bin's
  30-day clear-out) keeps the project and access it had, so a Private task's
  or project's name never reaches admins who couldn't see it.
- **Removing someone** from a workspace removes them from its projects.
  Making someone a guest turns their editor roles into commenter. Either way,
  held notices and queued webhooks they can't see any more are dropped, and a
  webhook whose address they set is switched off ("the person who set its
  address no longer has access").
- **Signed-out requests** read none of a workspace's rows, as before: the rules
  apply to signed-in callers.
- **Every change** to the switch, a visibility or a project's people touches
  the workspace, so every open copy of Kanbo reloads.

## Known limits

Turning a project private, or taking someone off it, doesn't take back what
they've already had: Inbox items, emails, push notices, Slack posts and
webhooks already delivered; meeting agendas and recaps already stored; shared
templates; exports; and a device's offline copy until its next load.

- **Notion.** A two-way Notion sync set up on a project keeps copying its tasks
  into its Notion database after the project is made Members only or Private
  (it runs as the person who set it up, who can still see it). Anyone who can
  read that Notion database sees them. Stop the sync first if the database is
  shared more widely than the project. Coming the other way, a page whose
  Owner can't see the project comes in unassigned (the database would refuse
  them as its assignee).
- **Task history names.** A task's history row keeps the name its author had
  when it was written (0038 falls back to their email when they had no name),
  so a guest reading a task in their project can see the name of a teammate
  who isn't one of their project's people.

## Rollback

| Level | How | Effect |
|---|---|---|
| One workspace (normal) | Its owner switches Project access off in Settings › Workspace. In an emergency, in the SQL editor: `update public.workspaces set project_access = false where id = '<workspace id>';` | Instant: the next query uses today's rule, and open apps reload. People, visibility and settings are kept for next time. |
| Every workspace | `update public.workspaces set project_access = false where project_access;` | The same, everywhere. |
| Full undo (only if 0058 itself is broken) | Run `supabase/rollback/0058_project_access_undo.sql`, then its VERIFY block. | Removes 0058's rules and functions, switches every workspace off and puts the older helpers back word for word, **keeping the data** (who's on which project, visibility, settings). While it's out, the app keeps a project's people in its contributors list again (as before 0058). Running 0058 again afterwards puts every rule back and brings project people back to that list: anyone taken off meanwhile, or who left the workspace, loses their place, and anyone added to a Whole workspace project gets one, so nobody who was taken off comes back. Anyone added to a Members only or Private project meanwhile is added again in People & access (with the rules out, anyone could have listed themselves). A commented-out last block drops the data too: only if you're sure. |

## Tests

`node supabase/tests/pglite/run.mjs 0058` builds the live database
(0001–0050), runs the battery, applies 0058, and checks: the switch off equals
before; the switch on equals the rank table for every person, project, table,
helper, live channel, search result, file and person; switching off again
equals the first run; then the functions, triggers, notices, webhooks, bin,
meetings and performance (5 000 tasks behind the switch); then 0058 twice,
the undo file, and every older file run again; and last, 0051–0057 applied
after 0058. The same suite runs on the two full migration sets.
