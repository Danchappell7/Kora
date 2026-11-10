/* ============================================================
   Business pack: agency.
   Plain data: change any words, days, targets or tasks here. The
   shorthand (t, before, after, onTheDay) is explained in ./helpers.
   ============================================================ */
import type { WorkspaceTemplate } from "../data/types";
import { t } from "./helpers";

const BRIEF = `> 🧭 Nothing starts until the client has signed this off. One brief per campaign.
## The client and the job
- **Client:**
- **What they've asked for:**
## Objective
What has to change, and how we'll know it did.
## Audience
Who we're talking to, and what they think now.
## Key message
The one thing they should remember.
## Deliverables
-
## Budget and deadline
- **Budget:**
- **Live date:**
## Approvals
- **Signs off the brief:**
- **Signs off the work:**
- Two rounds of changes are included; more are charged as extra time`;

export const AGENCY_PACK: WorkspaceTemplate = {
  id: "pack-agency", name: "Agency", emoji: "✨", hue: "orchid",
  audience: "Creative, digital and marketing agencies",
  summary: "Take each campaign from signed brief to sign-off in two rounds of changes, see who's on what next week, and keep retainers profitable.",
  updateRhythm: { cadence: "weekly", weekday: 4 },
  projects: [
    {
      key: "campaign", name: "Client campaign", emoji: "📣", hue: "orchid",
      description: "One campaign from signed brief to results, with clear approval rounds.",
      sections: ["Brief", "Concepts", "Production", "Client review", "Live"],
      tasks: [
        t("Brief", "Brief signed off by the client", 3, 1, { priority: "high", description: "Use **Creative brief** in this project's docs. Nothing starts until it's signed off." }),
        t("Concepts", "Three concept routes, reviewed internally", 8, 8, { focusMin: 120 }),
        t("Concepts", "Present the concepts and agree one route", 10, 1.5, { priority: "high", focusMin: 60 }),
        t("Production", "First round of production", 17, 16, { focusMin: 120 }),
        t("Client review", "Client review, round one: all feedback in one place", 20, 1, { priority: "high" }),
        t("Client review", "Client review, round two: final changes", 24, 1, { priority: "high" }),
        t("Client review", "Final sign-off in writing", 26, 0.5, { priority: "urgent" }),
        t("Live", "Launch, and check everything is live", 28, 2, { priority: "urgent" }),
        t("Live", "Results report and case study notes", 45, 3, { focusMin: 90 }),
      ],
      docs: [{ title: "Creative brief", icon: "🧭", markdown: BRIEF }],
    },
    {
      key: "requests", name: "Client requests", emoji: "📨", hue: "amber",
      description: "Changes and small jobs from clients, in one queue, so nothing gets lost in email.",
      sections: ["New", "Doing", "Waiting on client", "Done"],
      tasks: [
        t("New", "Agree turnaround times with each client", 4, 1, { priority: "high", description: "**Urgent**: the same working day\n**Normal**: within three working days\n**Small changes**: batched each week" }),
        t("New", "Send each client the request form link", 6, 0.5),
        t("Waiting on client", "Chase feedback that's holding up work", 5, 0.5, { recurrence: "weekly" }),
      ],
      form: { name: "Change request", description: "Need a change or a small job? Say what, where, and by when.", fields: ["description", "priority", "dueDate"] },
      rule: { name: "New requests land in New", trigger: "task_created", actions: [{ type: "set_section", value: "New" }] },
    },
    {
      key: "newbiz", name: "New business", emoji: "🌱", hue: "jade",
      description: "Pitches we're qualifying, preparing and waiting to hear on.",
      sections: ["Leads", "Pitching", "Proposal out", "Won or lost"],
      tasks: [
        t("Leads", "Qualify the pitch: budget, decision date and fit", 3, 1, { priority: "high" }),
        t("Pitching", "Pitch prep and a full rehearsal", 12, 6, { focusMin: 120 }),
        t("Proposal out", "Follow up open proposals", 5, 0.5, { recurrence: "weekly" }),
        t("Won or lost", "Write up why we won or lost each pitch", 30, 1),
      ],
    },
    {
      key: "studio", name: "Studio operations", emoji: "🗂️", hue: "sky",
      description: "Resourcing, timesheets, retainers and billing.",
      sections: ["Every week", "Every month"],
      tasks: [
        t("Every week", "Resourcing: who's on what next week", 3, 1, { recurrence: "weekly", priority: "high" }),
        t("Every week", "Timesheets in", 3, 0.25, { recurrence: "weekly" }),
        t("Every month", "Retainer check: hours used against hours sold, per client", 10, 1.5, { recurrence: "monthly", focusMin: 60 }),
        t("Every month", "Invoice retainers and chase overdue invoices", 1, 1, { recurrence: "monthly", priority: "high" }),
      ],
      docs: [{ title: "Weekly resourcing meeting", icon: "🗒️", from: "meeting", agenda: ["What's due this week, and is it on track", "Who's over capacity, and who has room", "New work coming in", "Holidays and freelancers"] }],
    },
  ],
  goals: [
    {
      key: "margin", name: "Profitable retainers", icon: "💷", description: "Every retainer pays for the time it takes.",
      links: ["studio"],
      keyResults: [
        { name: "Retainer margin", icon: "📊", unit: "%", target: 45 },
        { name: "Retainers within the hours sold", icon: "⏱️", unit: "%", target: 90 },
      ],
    },
    {
      key: "ontime", name: "Work lands when we said it would", icon: "📦",
      links: ["campaign", "requests"],
      keyResults: [
        { name: "Work delivered on the agreed date", icon: "📅", unit: "%", target: 90 },
        { name: "Jobs signed off within two rounds of changes", icon: "✍️", unit: "%", target: 80 },
      ],
    },
    {
      key: "growth", name: "Win the right new clients", icon: "🌱", links: ["newbiz"],
      keyResults: [
        { name: "New retainers signed", icon: "🤝", unit: "clients", target: 3 },
        { name: "Pitches won", icon: "🏅", unit: "%", target: 35 },
      ],
    },
  ],
  portfolios: [
    { key: "clients", name: "Client work", emoji: "✨", hue: "orchid", description: "Live campaigns and client requests, in one place.", projects: ["campaign", "requests"] },
  ],
};
