# Database update 0055: shared capacity, working hours, time off and bill rates

Migration file: `supabase/migrations/0055_shared_availability.sql` (the
commented source). It needs 0041 and 0042, works with or without 0043–0054,
and is safe to run more than once: re-running keeps every capacity, working
week, day off, reason and rate.

## What it adds

| Part | Table / function | Who can see and do what |
|---|---|---|
| A person's week at a business | `member_availability`, `set_member_availability(ws, user, hours, days, start, end)` | Weekly capacity (blank = 40h), working days and the working day's start and end. The workspace's owners, admins and members read everyone's; guests read none. You set your own; owners and admins set anyone's. Guests carry no team capacity, so they have none. |
| Time off | `time_off`, `save_time_off(…)`, `delete_time_off(id)` | Days away (from, to, or the morning or afternoon of one day), recorded at a business (the one on screen). What the person records themselves is seen everywhere they're on the team (by the owners, admins and members of each business where they're an owner, admin or member too), so it's entered once. What an owner or admin records for someone stays with that business's team. Being someone's guest, or having them as one, shares nothing; outsiders see nothing. Changed and taken back by the person, or by an owner or admin of the business it was recorded at. No two entries the same people see cover the same day (a morning and an afternoon can). At most 200 per person from any one author. |
| The reason | `time_off_notes` | Private: only the person and the owners and admins of the business it was recorded at read it (and the app shows it only there). Everyone else sees "Off". |
| Bill rates | `bill_rates`, `set_bill_rate(ws, project, rate)` | A project's own hourly rate, and the workspace's default (no project). Only the workspace's owners and admins read or set them. Members see hours only; guests nothing. |
| Live | realtime on `member_availability` and `time_off` | A teammate's change shows without a reload (RLS decides who hears). Reasons and rates are read again when time off changes, never streamed. |

Nobody writes these tables directly: only through the functions above.

## Owner steps

1. Run the migration in the SQL editor:
   <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>
   (paste the whole file, press **Run**; "Success. No rows returned").
   - *"0055 needs 0041 and 0042 first"*: run them, then this file again.
2. Check it with the VERIFY block at the end of the file: every column should
   say `true`.

No functions to deploy, no new secrets and no new schedule.

## Running other files again

| If you run… | What happens |
|---|---|
| 0041 | Nothing changes here: 0055's tables are its own, and 0041 doesn't touch their rules. |
| 0042, 0048 | Nothing changes here. |

## How it works

- **Capacity is the team's.** Workload, Radar, Pulse, People, the Group page
  and the AI planner's "would be overloaded" check all read each person's week
  at that business, less any time off that week ("32h a week, Mon–Thu"; a day
  off takes a day's share away). Two managers see the same answer.
- **Who's off.** People and Pulse say "Off today", "Off until Mon" (the day
  they're back) or "Off from Thu" beside the name; the dates (and, for those
  who may read it, the reason) are on hover. The task panel's and the list's
  assignee pickers say "Off Thu" beside anyone off the day the work's due, and
  New task says it under the field. Workload marks "Off 3 days", and "Off" for
  a week away.
- **Kanbo noticed.** When work is due while someone's away (yours, except where
  you're a guest, or a teammate's in a business you own or run), Today offers
  to give it to the teammate with the most room that week (when someone has
  room), or to move it to the day they're back, with Undo.
- **Setting it.** Team › People › a person: their working week (hours, days,
  start and end) and their time off (with an optional note, which only they
  and that business's owners and admins see). Removing time off has Undo.
  Workload's open row sets capacity too. Your own week also sets Today's
  working day (it was always 08:00–18:00).
- **Workload you can act on.** Drag a task onto a person (it's theirs) or one
  of their weeks (theirs, due that week, never on a day they're off), or use
  the task's Move menu (it says "Off Thu" beside anyone off the day it's due).
  "Preview rebalance" shows Kanbo's moves for the week and everyone's hours
  before and after (never to someone off the day it's due, and someone around
  all week comes first); Apply saves them all, Undo puts them back.
- **Rates.** Team › Insights › Trends › Time & billing: owners and admins set
  the default rate and each project's own; the total prices each project at its
  rate. Members see hours only.
- **Capacities saved in browsers.** Before 0055, Workload kept capacities on
  each device. Once it's run, the first visit hands them over once (only where
  nobody has set one, and only what that person may set); after that the
  device's copy is no longer used.
- **Before 0055 is run.** Everything works as it did: capacities and the rate
  are the device's, the working day is 08:00–18:00, nobody shows as off, and a
  person's profile tells owners and admins that shared hours aren't switched on
  yet.
