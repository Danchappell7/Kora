/* ============================================================
   Business pack: holding company.
   Plain data: change any words, days, targets or tasks here. The
   shorthand (t, before, after, onTheDay) is explained in ./helpers.
   perBusiness is made once for each business named when the pack is
   used: "{business}" in its words becomes that business's name.
   ============================================================ */
import type { WorkspaceTemplate } from "../data/types";
import { t } from "./helpers";

const BOARD_PACK = `> 📦 What every business sends by the 10th, so the board pack goes out a week before the meeting.
## From each business
[ ] Last month's numbers: revenue, gross margin, operating profit, cash
[ ] Against budget and against last year, with a line on anything more than 10% out
[ ] Headcount: starters, leavers and open roles
[ ] Highlights: three things that went well
[ ] Risks: anything that could hurt the year, and what's being done
[ ] Asks: decisions or help needed from the group
## From the group
[ ] Group cash and the 13-week forecast
[ ] Deals and new ventures
[ ] Actions from the last meeting, and where they stand`;

const AUTHORITY = `> ✍️ Who can approve what, so each business can move quickly and the big calls come to the board.
## Each business's leadership can approve
- Spending within the agreed budget
- Hiring into budgeted roles
- Contracts up to the agreed limit
## The group finance lead approves
- Spending over budget, up to the agreed limit
- New suppliers above the agreed annual value
## The board approves
- Anything outside the budget above the limit
- Borrowing, guarantees and security
- Buying or selling a business, or starting a new one
- Senior hires and their pay`;

export const HOLDING_PACK: WorkspaceTemplate = {
  id: "pack-holding", name: "Holding company", emoji: "🏛️", hue: "iris",
  audience: "Groups that own or run several businesses",
  summary: "A board pack every month, group finance and deals in one place, goals for the whole group, and a portfolio for each business you own.",
  updateRhythm: { cadence: "monthly", weekday: 5 },
  projects: [
    {
      key: "board", name: "Group board", emoji: "🏛️", hue: "iris",
      description: "The monthly board pack, and the meeting it's for.",
      sections: ["Board pack", "Meeting", "Actions"],
      tasks: [
        t("Board pack", "Agree the board calendar for the year", 7, 1, { priority: "high" }),
        t("Board pack", "Collect each business's monthly numbers by the 10th", 10, 1, { recurrence: "monthly" }),
        t("Board pack", "Put the board pack together and send it out", 14, 3, { recurrence: "monthly", focusMin: 90 }),
        t("Meeting", "Board meeting", 21, 2, { recurrence: "monthly", priority: "high", focusMin: 120 }),
        t("Actions", "Send the minutes and actions", 22, 1, { recurrence: "monthly" }),
      ],
      docs: [
        { title: "What goes in the board pack", icon: "📦", markdown: BOARD_PACK },
        { title: "Board meeting", icon: "🗒️", from: "meeting", agenda: ["Minutes and actions from last time", "Group numbers: revenue, margin and cash", "Each business: highlights, risks and asks", "Deals and new ventures", "Decisions needed"] },
      ],
    },
    {
      key: "finance", name: "Group finance", emoji: "💷", hue: "jade",
      description: "Cash across the group, the forecast, intercompany charges and the audit.",
      sections: ["Every week", "Every month", "This year"],
      tasks: [
        t("Every week", "Group cash check", 3, 0.5, { recurrence: "weekly" }),
        t("Every month", "Update the 13-week cash forecast", 8, 2, { recurrence: "monthly", focusMin: 60 }),
        t("Every month", "Intercompany charges and recharges", 12, 1.5, { recurrence: "monthly", focusMin: 60 }),
        t("This year", "Agree who can approve what in each business", 14, 2, { priority: "high", focusMin: 60, description: "Start from **Who can approve what** in this project's docs." }),
        t("This year", "Plan the year end and the audit", 45, 3, { focusMin: 90 }),
      ],
      docs: [{ title: "Who can approve what", icon: "✍️", markdown: AUTHORITY }],
    },
    {
      key: "deals", name: "Deals and new ventures", emoji: "🔭", hue: "amber",
      description: "Businesses we might buy, start or sell, from first look to done.",
      sections: ["Ideas", "Looking", "Due diligence", "Done or dropped"],
      tasks: [
        t("Ideas", "Write down what we look for in a deal", 10, 2, { focusMin: 60 }),
        t("Looking", "Review the deal pipeline", 14, 1, { recurrence: "biweekly" }),
      ],
    },
  ],
  perBusiness: {
    project: {
      key: "business", name: "{business}", emoji: "🏢", hue: "sky",
      description: "{business} as the group sees it: its numbers, its plan and its reviews.",
      sections: ["Every month", "This quarter", "This year"],
      tasks: [
        t("Every month", "{business}: monthly numbers in by the 10th", 10, 0.5, { recurrence: "monthly" }),
        t("This year", "{business}: agree this year's plan and budget", 30, 3, { priority: "high", focusMin: 90 }),
        t("This quarter", "{business}: quarterly review with its leadership", 60, 2, { focusMin: 90 }),
      ],
    },
    portfolio: { name: "{business}", emoji: "🏢", description: "Everything the group is doing with {business}. Add its projects here as they start." },
  },
  goals: [
    {
      key: "reporting", name: "Every business reports on time", icon: "📦", description: "The board decides from this month's numbers, not last quarter's.",
      links: ["board"],
      keyResults: [
        { name: "Monthly numbers in by the 10th", icon: "📅", unit: "%", target: 100 },
        { name: "Board pack out a week before the meeting", icon: "🏛️", unit: "%", target: 100 },
      ],
    },
    {
      key: "growth", name: "Grow the group", icon: "📈", span: "year", links: ["finance"],
      keyResults: [
        { name: "Group revenue", icon: "💷", unit: "£" },
        { name: "Group operating margin", icon: "📊", unit: "%", target: 15 },
      ],
    },
    {
      key: "cash", name: "Cash to grow", icon: "🏦", span: "year", links: ["finance", "deals"],
      keyResults: [{ name: "Months of group costs held in cash", icon: "⏳", unit: "months", target: 6 }],
    },
  ],
};
