# Database update 0058: project access (who can see each project)

Migration file: `supabase/migrations/0058_project_access.sql` (the commented
source). It needs 0041, 0042, 0043, 0046 and 0047, works with or without
0048–0057 (run it after 0051–0057 as planned; if any of those comes later, it
puts project access on its own tables), and is safe to run more than once:
re-running keeps every member, visibility and setting.

**Running it changes nothing anyone can see**, with the exceptions below. Every
workspace starts with Project access switched off, and while it's off every read
and write is exactly what it was before: every member and guest of a workspace
reads every project. The PGlite suite proves this by running the same battery of
reads and writes, as every kind of person, against the live database (0001–0050)
and then with 0058 in and the switch off: the answers are identical.

The exceptions. First, a project still owned by someone who has already left
its workspace becomes the workspace owner's (the file does this once, and from then
on whenever someone leaves). Otherwise, invited back later, even as a guest for
one other project, they would own every project they had made, Private ones
included. Nobody's access changes: the departed person has none, and the
workspace's owner already sees everything. The VERIFY column `owners_still_in`
checks it. Second, a webhook endpoint re-pointed after 0058 follows whoever set
its new address, switch on or off (see "Webhooks while the switch is off" below).
Third, a bin entry's summary no longer names a project or a parent task that
isn't in its own workspace (a Personal task's: not its owner's own): 0047 looked
both up by id alone, so a task of your own naming someone else's project and task
showed their name and title in your bin. Rows already there lose that line when
the file runs. Fourth, switch on or off, a task from a Members only or Private
project that has gone comes back from the bin only with its project, never into
the workspace's first project, and such a project leaves its workspace (to
Personal or another one) only once its tasks and updates have gone.

## What it adds

| Part | Table / function | Who can see and do what |
|---|---|---|
| The switch | `workspaces.project_access`, `project_access_default`, `project_access_member_private`, `project_access_changed_at`; `set_project_access(ws, on, default, members_may_make_private)` | The workspace's owner only (Settings › Workspace › Project access). Off by default. "New projects start as" (Whole workspace, Members only or Private) applies to every new project, from the app, the API, MCP, Slack and packs. "Members can make projects private": owners and admins always can. The app can't write these columns any other way. |
| Who can see a project | `projects.visibility` (`workspace`, `members`, `private`); `set_project_visibility(project, visibility)` | **Whole workspace**: everyone in the workspace (guests only if they're added). **Members only**: the project's people, plus the workspace's owners and admins. **Private**: the project's people, plus the workspace's owner. Changed by the workspace's owner, the project's owner, its editors (not guests), and admins (not on Private projects). Nobody but the owner can change it so that they'd lose access themselves. Every project there today is Whole workspace. |
| A project's people | `project_members` (editor, commenter, viewer); `set_project_member`, `remove_project_member` | Filled once from each project's contributors (editors; guests are commenters; never the project's owner, who always edits). A guest is never more than a commenter (someone made a guest after making a project still owns it, and comments on it). Read by anyone who can see the project. Written only through the functions; `contributor_ids` is kept in step both ways, so older tabs keep working. |
| Guests invited onto projects | `project_member_invites`; `set_invite_projects(invite, grants)`, `remove_invite_project(invite, project)` | Owners and admins choose the projects a new guest will see; they become that guest's project rows when the invite is accepted. A pending grant is read by the project's managers (who see it in People & access and can take it off) and by owners and admins on projects they can see. `set_invite_projects` changes only the grants on projects the caller manages: one on a project they can't see (made Private since by its owner) is kept, so an admin's edit of an invite never drops it. Re-inviting a pending guest adds the new projects to what the invite brings. |
| What the bin and the history knew | `trash.access`, `audit_events.project_id` / `access`, `webhooks.url_set_by`, `project_ids_retired` | A deleted item keeps the access its project had, so the bin and the history show it only to people who could see it. A project deleted for good keeps its id: no new project can take it over, with what the bin and the history still hold of the old one. A webhook's deliveries follow whoever last set its address, and what's still queued when the address changes goes only where that person can see. |

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
in the bin, and after it's deleted for good, what it left behind keeps the
project's access, and nobody but the workspace's owner can add to it.

## Owner steps

1. Deploy the functions first (DEPLOYMENT.md Step 19 lists the twelve; they
   work before 0058: they fall back to today's rule), and never switch a
   business on before they're out. Then run the migration in the SQL editor:
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
  access. That backstop covers only what the database queues itself: task
  notices' email and push, Inbox items and webhooks. Slack stand-ups and link
  previews, public form pages, the due-list email, the digest, calendar feeds,
  invites and Notion follow today's rule until the functions in step 1 are
  deployed, so never switch a business on before then.
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
  once the project is deleted for good it can't come back). A project in the
  bin is read-only (an old tab or the offline queue can't add work to it;
  the workspace's owner still can), and anything left in it counts as closed
  on a meeting's agenda and in Slack posts. A bin entry's summary names its
  parent task only when that's in the same project (switching on drops the
  line from entries binned while it was off). When a Members only or Private project is
  deleted for good, anything still in it (written while the switch was off,
  say) goes to the bin as items of its own, with the project's access, rather
  than becoming work everyone reads. Its id is never used for a new project.
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
  move there and back can't hand anyone a project or drop its people. Nor does
  a project leave a workspace whose switch is on (or leave at all, if it's
  Members only or Private) with its tasks, updates, sections, custom fields,
  rules or forms still in it: nothing moves them with it, and what it left
  would be loose work everyone there reads.
  Restoring a task whose Members only or Private project has gone works the
  same with the switch off as on (only with its project).
- **The history** of something deleted for good (by hand or by the bin's
  30-day clear-out) keeps the project and access it had, so a Private task's
  or project's name never reaches admins who couldn't see it.
- **Removing someone** from a workspace (or their leaving) removes them from
  its projects, hands the projects they own there to the workspace's owner, and
  drops them from what the bin and the history captured of its projects'
  people. So inviting them back gives them only what the invite says, and
  restoring a project from the bin never puts them back on it. (Their open
  tasks stay assigned to them until handed on, as before.) Making someone a
  guest turns their editor roles into commenter. Either way, held notices and
  queued webhooks they can't see any more are dropped, and a webhook whose
  address they set is switched off ("the person who set its address no longer
  has access"). The same goes for any other role change: an admin made a
  member, or an owner who hands the business over and becomes an admin, no
  longer gets queued deliveries of work they can't see any more. Deleting the
  account of whoever set an endpoint's address switches it off too, whatever
  the switch says (the endpoint never falls back to its creator's wider
  access). Whoever switches such an endpoint back on takes its address on as
  theirs: from then on it hears what they can see.
- **Assignees.** With the switch on, nobody is given a task in a project they
  can't see. Someone suspended or awaiting approval is judged by the projects
  they'll see once they can act again. Someone who has left the workspace keeps
  a task they already had when it moves (as before: nothing there is theirs to
  see), but is never given a new one: a repeat or a copy of their task, or a
  rule naming them, gives it to whoever made the change instead (the app says
  so).
- **Approvals.** A reviewer who can only view the task now (or can't see it)
  isn't offered a decision (`can_decide`), and the request's asker sees who
  can't review it and, when it can't finish, that it should be cancelled and
  asked again.
- **Update replies.** An @mention in a reply to a project update asks for a
  reply, so it reaches only people who can reply (never a viewer), as Asks do.
- **Asking for an update** about a project you can't see is "not
  authorized", before anything is said about it.
- **Webhooks while the switch is off.** The dispatcher judges an endpoint by
  whoever last set its address (else whoever added it), switch on or off: an
  endpoint an admin re-pointed to their own address stops when that admin
  leaves. Before 0058 the endpoint's creator was the judge. This differs from
  before 0058 with the switch off on purpose: an
  address chosen by someone who has left shouldn't keep receiving the
  workspace's events.
- **Viewers** read and follow; they don't comment, react or give kudos.
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
  shared more widely than the project. With the switch on, a synced task moved
  to another project stops syncing (nothing of it goes out or comes in, and
  archiving its page doesn't archive it) until it's moved back. Coming the
  other way, a page whose Owner can't see the project comes in unassigned (the
  database would refuse them as its assignee), and the rest of the run carries
  on.
- **Names a guest can read.** A task's history row keeps the name its author had
  when it was written (0038 falls back to their email when they had no name),
  so a guest reading a task in their project can see the name of a teammate
  who isn't one of their project's people. The same holds for an update
  reply's author (`status_update_comments.author_name`) and the poster named on
  an update's notice in their Inbox (`activity.detail`), approvals' reviewer
  and requester names, live presence, and the name of whoever connected Notion
  (`notion_status`). Names only: never their work.
- **The full undo.** While the undo file has the rules out, the Owner picker
  is open to any writer again. A Members only or Private project taken over
  then (or kept by someone removed and invited back meanwhile) stays theirs
  when 0058 is run again: check the owners of closed projects afterwards, and
  hand them back in About.

## Rollback

| Level | How | Effect |
|---|---|---|
| One workspace (normal) | Its owner switches Project access off in Settings › Workspace. In an emergency, in the SQL editor: `update public.workspaces set project_access = false where id = '<workspace id>';` | Instant: the next query uses today's rule, and open apps reload. People, visibility and settings are kept for next time. |
| Every workspace | `update public.workspaces set project_access = false where project_access;` | The same, everywhere. |
| Full undo (only if 0058 itself is broken) | Run `supabase/rollback/0058_project_access_undo.sql`, then its VERIFY block. | Removes 0058's rules and functions, switches every workspace off and puts the older helpers back word for word, **keeping the data** (who's on which project, visibility, settings). While it's out, the app keeps a project's people in its contributors list again (as before 0058). Running 0058 again afterwards puts every rule back and brings project people back to that list: anyone taken off meanwhile, or who left the workspace, loses their place, and anyone added to a Whole workspace project gets one, so nobody who was taken off comes back. Anyone added to a Members only or Private project meanwhile is added again in People & access (with the rules out, anyone could have listed themselves). Visibility can't be changed from the app or the API while it's out (the SQL editor still can), so no project is opened up meanwhile. Owners changed meanwhile aren't put back: check the owners of Members only and Private projects. A commented-out last block drops the data too: only if you're sure. |

## Tests

`node supabase/tests/pglite/run.mjs 0058` builds the live database
(0001–0050), runs the battery, applies 0058, and checks: the switch off equals
before; the switch on equals the rank table for every person, project, table,
helper, live channel, search result, file and person; switching off again
equals the first run; then the functions, triggers, notices, webhooks, bin,
meetings and performance (5 000 tasks behind the switch); then 0058 twice,
the undo file, and every older file run again; and last, 0051–0057 applied
after 0058. The same suite runs on the two full migration sets.
