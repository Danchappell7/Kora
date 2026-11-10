/* ============================================================
   Business pack: advisory firm.
   Plain data: change any words, days, targets or tasks here. The
   shorthand (t, before, after, onTheDay) is explained in ./helpers.
   ============================================================ */
import type { WorkspaceTemplate } from "../data/types";
import { t } from "./helpers";

const ENGAGEMENT = `> 📋 Every engagement, the same way. Nothing goes to a client without the sign-off marked here.
## Before we say yes
[ ] The problem, budget, timing and who decides are written down
[ ] Conflicts checked
[ ] **Sign-off:** a partner has read the proposal before it goes
## Starting
[ ] Engagement letter signed by the client
[ ] Kick-off held: goals, contacts and how we'll work together
[ ] Everyone on the team knows the deadline and the budget
## Delivering
[ ] Draft reviewed inside the team
[ ] **Sign-off:** a partner has reviewed the draft
[ ] Presented to the client, changes agreed in writing
## Closing
[ ] **Sign-off:** the client has accepted the work in writing
[ ] Invoice sent
[ ] Short review: what we'd do again, and what we wouldn't`;

const REPORT = `> 📈 One page a client reads in five minutes. Copy it for each client each month.
## Summary
Three sentences: where things stand, what changed, what we need.
## What we did this month
-
## The numbers
-
## Risks and what we're doing about them
-
## Next month
-
## What we need from you
[ ] `;

export const ADVISORY_PACK: WorkspaceTemplate = {
  id: "pack-advisory", name: "Advisory firm", emoji: "🧭", hue: "cobalt",
  audience: "Consultancies, accountants and advisers",
  summary: "Run each client engagement through proposal, partner sign-off and close, send a monthly report clients read, and keep an eye on utilisation.",
  updateRhythm: { cadence: "weekly", weekday: 5 },
  projects: [
    {
      key: "engagement", name: "Client engagement", emoji: "🤝", hue: "cobalt",
      description: "One engagement from first call to close, with a sign-off at every step that needs one.",
      sections: ["Proposal", "Kick-off", "Delivery", "Sign-off", "Close"],
      tasks: [
        t("Proposal", "Qualify the enquiry: the problem, budget, timing and who decides", 2, 1, { priority: "high" }),
        t("Proposal", "Write the proposal: scope, approach, team and fees", 5, 4, { priority: "high", focusMin: 120 }),
        t("Proposal", "Partner sign-off on the proposal before it goes", 6, 0.5, { priority: "high" }),
        t("Kick-off", "Engagement letter signed and conflicts checked", 10, 1, { priority: "urgent" }),
        t("Kick-off", "Kick-off meeting: goals, contacts and ways of working", 12, 1.5, { focusMin: 60, description: "**Goals**\n\n**Contacts on both sides**\n\n**How we'll work together**\n\n**Next steps**" }),
        t("Delivery", "Draft the findings and recommendations", 30, 12, { focusMin: 120 }),
        t("Sign-off", "Partner review of the draft", 33, 1.5, { priority: "high", focusMin: 60 }),
        t("Sign-off", "Present to the client and agree changes", 38, 2, { focusMin: 90 }),
        t("Sign-off", "Client sign-off in writing", 42, 0.5, { priority: "high" }),
        t("Close", "Invoice, close the file and hold a short review", 45, 1),
      ],
      docs: [{ title: "Engagement checklist", icon: "📋", markdown: ENGAGEMENT }],
    },
    {
      key: "reporting", name: "Monthly client report", emoji: "📈", hue: "lagoon",
      description: "A report each client reads: what we did, what changed, and what we need from them.",
      sections: ["Gather", "Write", "Review", "Sent"],
      tasks: [
        t("Gather", "Pull the month's numbers and activity", 21, 2, { recurrence: "monthly", focusMin: 60 }),
        t("Write", "Write the monthly client report", 23, 3, { recurrence: "monthly", focusMin: 90 }),
        t("Review", "Partner review of the report", 24, 0.5, { recurrence: "monthly", priority: "high" }),
        t("Sent", "Send the report and book the review call", 25, 0.5, { recurrence: "monthly" }),
      ],
      docs: [{ title: "Monthly client report", icon: "📈", markdown: REPORT }],
    },
    {
      key: "pipeline", name: "Business development", emoji: "🌱", hue: "jade",
      description: "Who we'd like to work with, who we're talking to, and every proposal that's out.",
      sections: ["Leads", "Talking", "Proposal out", "Won or lost"],
      tasks: [
        t("Leads", "List the 20 organisations we'd most like to work with", 7, 2, { focusMin: 60 }),
        t("Talking", "Ask three happy clients for an introduction", 14, 1),
        t("Proposal out", "Follow up every open proposal", 4, 1, { recurrence: "weekly" }),
        t("Leads", "Write one useful note or article for clients", 20, 3, { recurrence: "monthly", focusMin: 90 }),
      ],
      form: { name: "New enquiry", description: "Tell us what you need help with and by when. We'll come back to you within two working days.", fields: ["description", "dueDate"] },
      rule: { name: "New enquiries land in Leads", trigger: "task_created", actions: [{ type: "set_section", value: "Leads" }] },
    },
    {
      key: "practice", name: "Practice operations", emoji: "⚙️", hue: "sky",
      description: "Timesheets, billing and the weekly team meeting.",
      sections: ["Every week", "Every month"],
      tasks: [
        t("Every week", "Timesheets in by Friday 4pm", 3, 0.25, { recurrence: "weekly" }),
        t("Every week", "Weekly team meeting: pipeline, delivery and capacity", 6, 1, { recurrence: "weekly", focusMin: 60 }),
        t("Every month", "Bill last month's work and chase overdue invoices", 3, 2, { recurrence: "monthly", priority: "high", focusMin: 60 }),
        t("Every month", "Review utilisation for each person", 8, 1, { recurrence: "monthly" }),
      ],
      docs: [{ title: "Weekly team meeting", icon: "🗒️", from: "meeting", agenda: ["Pipeline: new enquiries and proposals out", "Delivery: anything at risk or waiting on a client", "Capacity: who's stretched and who has room", "Utilisation and billing"] }],
    },
  ],
  goals: [
    {
      key: "utilisation", name: "Busy, but not too busy", icon: "⚖️", description: "Enough billable work to pay well, and enough slack to do it well.",
      links: ["practice"],
      keyResults: [
        { name: "Billable utilisation", icon: "⏱️", unit: "%", target: 70 },
        { name: "Invoices paid within 30 days", icon: "💷", unit: "%", target: 85 },
      ],
    },
    {
      key: "clients", name: "Clients always know where things stand", icon: "🤝",
      links: ["reporting", "engagement"],
      keyResults: [
        { name: "Monthly reports sent on time", icon: "📈", unit: "%", target: 100 },
        { name: "Engagements signed off in writing", icon: "✍️", unit: "%", target: 100 },
      ],
    },
    {
      key: "pipeline", name: "A healthy pipeline", icon: "🌱", links: ["pipeline"],
      keyResults: [
        { name: "Qualified pipeline", icon: "📥", unit: "£" },
        { name: "Proposals won", icon: "🏅", unit: "%", target: 40 },
      ],
    },
  ],
  portfolios: [
    { key: "delivery", name: "Client delivery", emoji: "🤝", hue: "cobalt", description: "Every client engagement, and the reports that go with it.", projects: ["engagement", "reporting"] },
  ],
};
