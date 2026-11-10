/* ============================================================
   Business pack: boutique fitness group.
   Plain data: change any words, days, targets or tasks here. The
   shorthand (t, before, after, onTheDay) is explained in ./helpers.
   ============================================================ */
import type { WorkspaceTemplate } from "../data/types";
import { after, before, onTheDay, t } from "./helpers";

const OPENING_CHECKLIST = `> 🏗️ The jobs that make or break an opening, by when they need doing. The project has the dates; this is the detail.
## 90 days out
[ ] Lease signed and the fit-out plan agreed
[ ] Opening budget agreed: fit-out, kit, marketing and the first month's wages
[ ] Founding-member offer set: the price, how many spots, when it closes
## 60 days out
[ ] Booking system set up: rooms, capacity, class types and prices
[ ] Studio manager and front-of-house team hired
[ ] Signage, reception kit and retail stock ordered
## 30 days out
[ ] Instructors booked for the first four weeks
[ ] Fit-out handed over and the snagging list closed
[ ] Fire risk assessment done, first aid kit and accident book in place
[ ] Insurance covers the new site
## Opening week
[ ] Preview classes run, and what people said acted on
[ ] Run sheet and rota shared with the team
[ ] Founding members sent their first week's timetable`;

const INSTRUCTOR_HANDBOOK = `> 📘 What every instructor needs to know before their first class. Keep it short, and keep it current.
## Before class
- Arrive 15 minutes early: check the room, the kit and the music
- Check the class list for new members and injuries
## Teaching
- Welcome new members by name and show them the set-up
- Give an easier and a harder option for every move
## Safety
- Know where the first aid kit, the accident book and the fire exits are
- Anything broken or unsafe: stop using it, then report it with the maintenance form
## After class
- Reset the room for the next class
- Add anything members told you to the class notes
## Pay and cover
- How to claim, when you're paid, and how to find cover`;

const OPEN_CLOSE = `> 🔑 Whoever opens or closes ticks these off. Something wrong? Report it with the maintenance form.
## Opening (30 minutes before the first class)
[ ] Lights, music and air con on, studio at 18–20°C
[ ] Walk the floor: equipment, mats and anything left out
[ ] Changing rooms and toilets clean and stocked
[ ] Check today's classes, the waitlists and any new members
[ ] Reception tidy, card machine on, water and towels out
## Closing
[ ] Equipment wiped down and put away
[ ] Changing rooms checked, lost property bagged
[ ] Takings counted and the till closed
[ ] Windows shut, lights and music off, alarm set`;

export const FITNESS_PACK: WorkspaceTemplate = {
  id: "pack-fitness", name: "Boutique fitness group", emoji: "🧘", hue: "coral",
  audience: "Studios and small fitness groups",
  summary: "Open a new studio counted back from opening day, change the timetable without losing members, bring instructors on board and fix what breaks.",
  updateRhythm: { cadence: "weekly", weekday: 1 },
  projects: [
    {
      key: "opening", name: "New studio opening", emoji: "🏗️", hue: "amber",
      description: "Everything between signing the lease and the first class, counted back from opening day.",
      anchor: { label: "Opening day", defaultInDays: 90 },
      sections: ["90 days out", "60 days out", "30 days out", "Opening week", "After opening"],
      tasks: [
        before("90 days out", "Agree the fit-out plan with the contractor", 90, 3, { priority: "high", focusMin: 90, description: "**Budget**\n\n**Handover date**\n\n**What's in and what's out**\n\n**Who signs off changes**" }),
        before("90 days out", "Set the opening timetable and class mix", 84, 2, { focusMin: 60 }),
        before("90 days out", "Open founding-member presales", 80, 2, { priority: "high", focusMin: 60, description: "**Founding rate**\n\n**How many spots**\n\n**When presales close**\n\n**Where we'll promote it**\n- " }),
        before("60 days out", "Order signage, reception kit and retail stock", 60, 2, { focusMin: 60 }),
        before("60 days out", "Hire a studio manager and the front-of-house team", 56, 6, { priority: "high", focusMin: 90 }),
        before("60 days out", "Set the studio up in the booking system: rooms, capacity and class types", 50, 3, { focusMin: 90 }),
        before("30 days out", "Book instructors for the first four weeks of classes", 30, 2, { priority: "high", focusMin: 60 }),
        before("30 days out", "Fit-out handover and snagging walk-round", 21, 3, { priority: "high", focusMin: 90 }),
        before("30 days out", "Fire risk assessment, first aid kit and health and safety checks", 14, 2, { priority: "urgent", focusMin: 60 }),
        before("Opening week", "Friends-and-family preview classes", 5, 3, { focusMin: 90 }),
        before("Opening week", "Opening-day run sheet and staff rota", 3, 1.5, { priority: "high", focusMin: 60 }),
        onTheDay("Opening week", "Opening day"),
        after("After opening", "Opening review: what worked and what to fix", 14, 1.5, { focusMin: 60, description: "**Class fill in the first two weeks**\n\n**Founding members signed**\n\n**What members told us**\n\n**What we'll fix**\n- " }),
      ],
      docs: [{ title: "Studio opening checklist", icon: "📋", markdown: OPENING_CHECKLIST }],
    },
    {
      key: "timetable", name: "Timetable change", emoji: "🗓️", hue: "sky",
      description: "Change the timetable without losing members: plan from the numbers, tell people early, check how it lands.",
      anchor: { label: "New timetable starts", defaultInDays: 56 },
      sections: ["Plan", "Tell members", "Go live", "Check"],
      tasks: [
        before("Plan", "Pull class fill and waitlists for the last eight weeks", 42, 2, { focusMin: 60 }),
        before("Plan", "Draft the new timetable: what moves, what's new, what goes", 35, 3, { priority: "high", focusMin: 90 }),
        before("Plan", "Agree the new timetable with instructors", 28, 1.5, { focusMin: 60 }),
        before("Tell members", "Tell members: email, app notice and a sign at reception", 21, 2, { priority: "high", focusMin: 60, description: "Say what's changing, why, and from when. Name the classes that move, and offer something to anyone whose usual class goes." }),
        before("Go live", "Update the booking system and move existing bookings", 10, 3, { priority: "high", focusMin: 90 }),
        onTheDay("Go live", "New timetable starts"),
        after("Check", "Check class fill four weeks on", 28, 1, { description: "Compare with the eight weeks before. Anything under half full two weeks running: move it or drop it." }),
      ],
    },
    {
      key: "instructors", name: "Instructor onboarding", emoji: "🤸", hue: "jade",
      description: "From offer to a confident first month, for every new instructor.",
      sections: ["Before their first class", "First class", "First month"],
      tasks: [
        t("Before their first class", "Collect qualifications, insurance and right-to-work documents", 2, 0.5, { priority: "high" }),
        t("Before their first class", "Set them up in the booking, payroll and messaging tools", 4, 1),
        t("Before their first class", "Shadow two classes and walk through the studio's safety routine", 7, 2, { focusMin: 60 }),
        t("First class", "Teach their first class with a senior instructor in the room", 10, 1, { priority: "high", focusMin: 60 }),
        t("First month", "First-month check-in: member feedback, class fill and their goals", 30, 0.5),
      ],
      docs: [{ title: "Instructor handbook", icon: "📘", markdown: INSTRUCTOR_HANDBOOK }],
    },
    {
      key: "maintenance", name: "Studio maintenance", emoji: "🛠️", hue: "tangerine",
      description: "Anything broken, leaking or unsafe, reported in seconds and fixed in days.",
      sections: ["Reported", "Booked in", "Fixed"],
      tasks: [
        t("Reported", "Put the QR poster up at reception and in the changing rooms", 2, 0.5),
        t("Reported", "List our contractors: plumber, electrician, equipment servicing", 5, 1, { priority: "high" }),
        t("Booked in", "Walk the studio: equipment, changing rooms, lockers and lights", 3, 0.5, { recurrence: "weekly" }),
        t("Booked in", "Clean and check the equipment: bikes, reformers, mats and weights", 14, 2, { recurrence: "monthly", focusMin: 60 }),
      ],
      form: {
        name: "Report a maintenance problem", description: "Something broken, leaking or unsafe? Say what it is and where it is. We'll get on it.",
        fields: ["description", "priority"],
        poster: { headline: "Something broken?", line: "Scan to tell the team. It takes less than a minute." },
      },
      rule: { name: "New reports land in Reported", trigger: "task_created", actions: [{ type: "set_section", value: "Reported" }] },
    },
    {
      key: "routines", name: "Studio routines", emoji: "🔁", hue: "lagoon",
      description: "The daily, weekly and monthly jobs that keep the studio running and members coming back.",
      sections: ["Every day", "Every week", "Every month"],
      tasks: [
        t("Every day", "Opening checklist", 0, 0.25, { recurrence: "daily", focusMin: 15, forTeam: true, description: "Work through **Opening and closing checklist** in this project's docs." }),
        t("Every day", "Closing checklist", 0, 0.25, { recurrence: "daily", focusMin: 15, forTeam: true, description: "Work through **Opening and closing checklist** in this project's docs." }),
        t("Every week", "Check class fill and waitlists for next week", 3, 0.5, { recurrence: "weekly" }),
        t("Every week", "Call members who haven't booked in two weeks", 4, 1, { recurrence: "weekly", focusMin: 60 }),
        t("Every month", "Count retail stock and reorder", 20, 1, { recurrence: "monthly" }),
      ],
      docs: [
        { title: "Opening and closing checklist", icon: "🔑", markdown: OPEN_CLOSE },
        { title: "Weekly studio meeting", icon: "🗒️", from: "meeting", agenda: ["Last week's class fill and waitlists", "Members: new, at risk and cancelled", "Anything broken or unsafe", "This week's priorities"] },
      ],
    },
  ],
  goals: [
    {
      key: "fill", name: "Full classes, every week", icon: "🔥", description: "Members get the classes they want, and the studio pays its way.",
      links: ["timetable", "routines"],
      keyResults: [
        { name: "Average class fill", icon: "📊", unit: "%", target: 75 },
        { name: "Peak-time classes with a waitlist", icon: "⏳", unit: "%", target: 50 },
        { name: "Off-peak class fill", icon: "🌙", unit: "%", target: 55 },
      ],
    },
    {
      key: "retention", name: "Members stay with us", icon: "💛", description: "Keeping a member is cheaper than finding a new one.",
      links: ["routines", "instructors"],
      keyResults: [
        { name: "Members still active after three months", icon: "🔁", unit: "%", target: 80 },
        { name: "Members booking twice a week or more", icon: "📅", unit: "%", target: 40 },
      ],
    },
    {
      key: "opening", name: "Open the new studio on time", icon: "🏗️", description: "Its progress is the opening project's.",
      project: "opening",
      keyResults: [{ name: "Founding members signed before opening", icon: "🎟️", unit: "members", target: 150 }],
    },
  ],
  portfolios: [
    { key: "growth", name: "Studio growth", emoji: "📈", hue: "coral", description: "The projects that grow the group: new studios, timetable changes and new instructors.", projects: ["opening", "timetable", "instructors"] },
  ],
};
