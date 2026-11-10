# Database update 0056: meetings

Migration file: `supabase/migrations/0056_meetings.sql` (the commented source).
It needs 0041, 0042, 0046 and 0047, works with or without 0048–0055, and is
safe to run more than once: re-running keeps every meeting, attendee, note,
decision and action.

## What it adds

| Part | Table / function | Who can see and do what |
|---|---|---|
| A meeting | `meetings`, `start_meeting(…)` | One meeting at a business, as a **team** meeting or a **leadership** meeting. A team meeting is read by the business's owners, admins and members (never its guests). A leadership meeting is read by its owners and admins. A Group meeting (from the Group page) covers several businesses, and only someone who is an owner or admin of every one of them reads it. The agenda is Kanbo's snapshot, made by whoever starts it. One live meeting of a kind over the same businesses at a time, whichever of them hosts it; one left running for 12 hours is closed without a recap (and the app stops offering to join it). |
| The presenter's place | `move_meeting`, `present_meeting`, `hand_meeting` | Only the presenter moves the agenda; everyone watching follows (realtime). Anyone in the meeting can take over; the presenter (or an owner or admin) can hand over to someone who has joined. |
| Who came | `meeting_attendees`, `join_meeting` | Who was asked (only people who may read it) and who joined. |
| Notes, decisions, actions | `meeting_items`, `add_meeting_item`, `update_meeting_item`, `delete_meeting_item` | Logged by anyone who may read the meeting, while it runs and for 7 days after. An action's owner must be an owner, admin or member of the business (never a guest); the task it became must be the business's own. |
| The notes doc | `set_meeting_doc` | A project doc (0047) in one of the business's own projects. |
| Ending it | `end_meeting` | The presenter, whoever started it, or the business's owners and admins. The recap goes once into the Inbox of everyone asked or there (not the person ending it, and not anyone who switched update notices off): activity kind `meeting`. The daily digest carries it for people on one. |
| Deleting it | `delete_meeting` | Whoever started it, or the business's owners and admins. Its recaps go with it. |
| Live | realtime on `meetings`, `meeting_attendees`, `meeting_items` | RLS decides who hears what. |

Nobody writes these tables directly: only through the functions above.

## Owner steps

1. Run the migration in the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
   (paste the whole file, press **Run**; "Success. No rows returned").
   - *"0056 needs 0041 and 0042 first"* or *"needs 0046"* / *"needs … 0047"*:
     run those, then this file again.
2. Check it with the VERIFY block at the end of the file: every column should
   say `true`.
3. Redeploy **daily-reminders** (`supabase functions deploy daily-reminders`)
   so the daily digest words a recap properly ("Maya shared the recap: 2
   decisions and 3 actions") and follows each person's "update" email switch.
   Until then the digest still includes recaps, as a plain "1 update" line.

No new secrets and no new schedule.

## Running other files again

| If you run… | What happens |
|---|---|
| 0041 | Nothing changes here: 0056's tables are its own, and 0041 doesn't touch their rules. |
| 0042, 0046, 0047, 0048 | Nothing changes here. |

## How it works

- **Run meeting.** Team › Pulse (a team meeting, or a leadership one for
  owners and admins), each business on Projects › Group (its leadership
  meeting) and the Group page itself (one over every business you run, hosted
  by the first of them in the switcher so last week's actions follow it).
  When one of that kind is already live there, the button says **Join ·
  Live**; a live one of the other kind sits beside Run meeting.
- **The agenda Kanbo builds.** Kanbo's read in a sentence or two, then each
  person (done since the last workday, on today, blocked, and "Off today" from
  0055, never the reason), Radar's risks, goals behind pace, projects to look
  at (an update missing, or a lead's call rosier than the work), and last
  meeting's actions with where each stands now, then the wrap-up. Team and
  leadership meetings are one engine with different sections switched on;
  the start sheet lets you switch any of them, choose who's coming and where
  the notes go: the recap only, or a doc in one of the business's projects (a
  team meeting suggests making a "Meetings" project). A team meeting never
  shows a leadership-only goal. Goals are counted as Pulse counts them, each
  with its key results that are behind inside it.
- **The room.** Full screen, calm, set large to read on a shared screen, one
  column on a phone. ← → (or J / K, Home / End) move through it; N writes a
  note; F follows the presenter again. A timer runs against the meeting's time
  box (15 minutes for a team meeting, 45 for leadership).
- **Into tasks.** An action becomes a task with its owner and day in one
  click (Make task, with Undo); a note or a decision leads to one through
  Extract tasks (Follow-up task). The meeting keeps the link, so the next
  meeting shows whether it's done; last meeting's actions that never became
  tasks can be made into one, or carried over, right there.
- **The notes doc** is the Meeting notes template filled in: date, who came,
  the agenda, notes, decisions and actions (as to-dos linked to their tasks).
  Everyone at a business, guests too, can read the docs in its projects, so a
  team meeting's doc is saved as it ends, but a leadership or Group meeting's
  only when someone presses "Save notes to…" (which says who'll read it).
  Until then its notes stay in the recap, read only by the people the meeting
  is for.
- **Leaving** (Esc or ×) never ends a meeting: a note says it's still live,
  with a way back.
- **Before 0056 is run.** Run meeting still works, on your screen only: the
  start sheet says so, nobody else can follow it, and no recap is sent. A
  notes doc and the tasks are saved as usual.
