/* ============================================================
   Business pack: startup.
   Plain data: change any words, days, targets or tasks here. The
   shorthand (t, before, after, onTheDay) is explained in ./helpers.
   ============================================================ */
import type { WorkspaceTemplate } from "../data/types";
import { after, before, onTheDay, t } from "./helpers";

const STRATEGY = `> 🧭 Why we exist, who for, and what we're betting on. One page, rewritten every quarter.
## The problem
Who has it, how often, and what it costs them.
## Who it's for
The customer we're building for first, and the ones we're not.
## What we do about it
Our answer, in one sentence.
## Why us, why now
-
## This quarter's three bets
1.
2.
3.
## How we'll know it's working
- The number we watch every week
- What it is today, and what it should be at the end of the quarter
## Not doing
- `;

export const STARTUP_PACK: WorkspaceTemplate = {
  id: "pack-startup", name: "Startup", emoji: "🌱", hue: "violet",
  audience: "Early-stage teams of two to twenty",
  summary: "A roadmap built on customer conversations, a launch counted back from launch day, a fundraise, and the weekly rhythm that holds it together.",
  updateRhythm: { cadence: "weekly", weekday: 5 },
  projects: [
    {
      key: "roadmap", name: "Product roadmap", emoji: "🧭", hue: "violet",
      description: "What we're building now, next and later, and why.",
      sections: ["Now", "Next", "Later", "Shipped"],
      tasks: [
        t("Now", "Write the product strategy on a page", 5, 3, { priority: "high", focusMin: 90 }),
        t("Now", "Agree this quarter's three big bets", 7, 2, { priority: "high", focusMin: 60 }),
        t("Now", "Talk to five customers", 4, 3, { recurrence: "weekly", focusMin: 60 }),
        t("Shipped", "Write the changelog: what went out and why", 11, 1, { recurrence: "biweekly" }),
      ],
      docs: [
        { title: "Product strategy on a page", icon: "🧭", markdown: STRATEGY },
        { title: "Decision log", icon: "⚖️", from: "decisions" },
      ],
    },
    {
      key: "launch", name: "Launch", emoji: "🚀", hue: "rose",
      description: "A launch counted back from launch day.",
      anchor: { label: "Launch day", defaultInDays: 42 },
      sections: ["Plan", "Build up", "Launch", "After"],
      tasks: [
        before("Plan", "Pick the launch goal and the one number we'll judge it by", 42, 1.5, { priority: "high", focusMin: 60 }),
        before("Plan", "Write the positioning and the launch story", 35, 3, { focusMin: 90 }),
        before("Build up", "Line up early customers for quotes and case studies", 28, 2, { focusMin: 60 }),
        before("Build up", "Build the launch page and the launch email", 21, 6, { focusMin: 120 }),
        before("Build up", "Brief press, partners and investors", 14, 2, { focusMin: 60 }),
        before("Launch", "Go / no-go check", 3, 1, { priority: "urgent", focusMin: 45 }),
        onTheDay("Launch", "Launch day"),
        after("After", "Launch review: the numbers and what we learned", 7, 1.5, { focusMin: 60 }),
      ],
    },
    {
      key: "fundraise", name: "Fundraising", emoji: "💷", hue: "jade",
      description: "From the deck to money in the bank.",
      sections: ["Prep", "Meetings", "Due diligence", "Close"],
      tasks: [
        t("Prep", "Update the deck and the financial model", 7, 8, { priority: "high", focusMin: 120 }),
        t("Prep", "Build the investor list and ask for warm introductions", 10, 3, { focusMin: 90 }),
        t("Meetings", "Investor pipeline review", 7, 0.5, { recurrence: "weekly" }),
        t("Due diligence", "Set up the data room", 14, 4, { focusMin: 90 }),
        t("Close", "Close the round and tell existing investors", 75, 2, { priority: "high" }),
      ],
    },
    {
      key: "feedback", name: "Customer feedback", emoji: "💬", hue: "lagoon",
      description: "Bugs and ideas from customers, answered and sorted every week.",
      sections: ["New", "Looking into it", "Planned", "Closed"],
      tasks: [
        t("New", "Agree what counts as urgent", 3, 0.5, { priority: "high", description: "**Urgent**: broken for paying customers, fix today\n**Soon**: a key flow is broken but there's a workaround\n**Later**: everything else goes on the roadmap" }),
        t("New", "Sort new feedback and reply to everyone", 2, 1, { recurrence: "weekly" }),
      ],
      form: { name: "Bug or idea", description: "Found a bug, or have an idea? Tell us what happened, or what you'd love it to do.", fields: ["description", "priority"] },
      rule: { name: "New feedback lands in New", trigger: "task_created", actions: [{ type: "set_section", value: "New" }] },
    },
    {
      key: "company", name: "Company rhythm", emoji: "🔁", hue: "sky",
      description: "The weekly meeting, the monthly numbers and the investor update.",
      sections: ["Every week", "Every month"],
      tasks: [
        t("Every week", "Weekly team meeting: numbers, priorities and blockers", 6, 1, { recurrence: "weekly", focusMin: 60 }),
        t("Every month", "Review burn and runway", 5, 1, { recurrence: "monthly", priority: "high" }),
        t("Every month", "Send the investor update", 7, 1.5, { recurrence: "monthly", focusMin: 60 }),
      ],
      docs: [{ title: "Weekly team meeting", icon: "🗒️", from: "meeting", agenda: ["The numbers: users, revenue and burn", "Last week's priorities: done or not", "This week's three priorities", "Blockers and decisions"] }],
    },
  ],
  goals: [
    {
      key: "love", name: "Customers love the product", icon: "💛", description: "People use it every week and tell their friends.",
      links: ["roadmap", "feedback"],
      keyResults: [
        { name: "Weekly active users", icon: "📈", unit: "users" },
        { name: "Users still active after four weeks", icon: "🔁", unit: "%", target: 40 },
        { name: "Customers talked to this quarter", icon: "💬", unit: "customers", target: 60 },
      ],
    },
    {
      key: "revenue", name: "Grow revenue", icon: "💷", links: ["launch"],
      keyResults: [
        { name: "Monthly recurring revenue", icon: "📊", unit: "£" },
        { name: "Paying customers", icon: "🧾", unit: "customers" },
      ],
    },
    {
      key: "runway", name: "Money for the next stage", icon: "🏦", description: "Its progress is the fundraising project's.",
      project: "fundraise",
      keyResults: [{ name: "Months of runway", icon: "⏳", unit: "months", target: 18 }],
    },
  ],
  portfolios: [
    { key: "bets", name: "This quarter's bets", emoji: "🎯", hue: "violet", description: "The work that decides this quarter.", projects: ["roadmap", "launch", "fundraise"] },
  ],
};
