# Plans that follow you, and team templates

## Plans that follow you (needs database update 0043)

Each person's own plan on a task — its slot on Today, "on today", their
My-tasks section and Kanbo's ranking for them — is saved per person in
`task_user_state`, so it follows them to every device.

- **Teammates' tasks.** Planning a task someone else is assigned to saves your
  plan there (never on the task, which holds its assignee's plan). Before 0043
  this lived only on the device you planned it on.
- **Your own tasks.** The task keeps your plan as it always has, and once the
  task has saved it a copy goes to `task_user_state` too, so a task handed to
  you keeps the plan you'd made on it. A change the server refuses (shown as
  not saved) is never copied, so it can't come back on the next load.
- **A plan is for a day.** A slot or "on today" from an earlier day isn't shown
  as today's.
- **Offline.** Changes show at once, wait on the device, and are saved when the
  connection is back (after the task itself, if it was created offline too).
- **First time on.** Plans kept on a device before 0043 move into the table the
  first time that device loads with it, where the table has nothing for them
  yet.

Until 0043 is run nothing changes: plans stay on each device, and nothing is
reported as an error. Demo mode always keeps them on the device.

### Check it (after running 0043)

1. Sign in on two devices (or a normal and a private window) as the same person.
2. In a team workspace, open a task assigned to a teammate that you collaborate
   on, and add it to Today on the first device.
3. Within a few seconds it is on Today on the second device too. (If it only
   appears after a refresh, realtime is off for the table: see
   `database-0043.md`, the `plan_state_realtime` check.)
4. Your teammate's Today doesn't change.

## Team templates (no setup)

Four ready-made set-ups — Marketing, Operations, Product launch and Client
services — each with three projects (their own emoji and colour), sections,
10–11 starter tasks with due dates counted from the day they're used (a weekend
moves to the Monday) and estimates, a sample request form and a rule. The
starter tasks are all assigned to whoever uses the template, so it's a light
start: no more than four are due in the first week, and no more than three
repeat. They're offered when a workspace is created and from Projects › New
project › "From a team template". They use the same tables as everything else,
so they need no migration, function or secret, and work in demo mode.
