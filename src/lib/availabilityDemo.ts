/* ============================================================
   KANBO — the demo's shared weeks, time off and rates (0055),
   set from today so there's always something to show: Theo is off
   today, Sana is away from tomorrow for five days with three of her
   tasks due while she's gone (Kanbo noticed offers to move them),
   Maya works a four-day, 32-hour week (so Workload has someone to
   rebalance) and has a dentist's afternoon next week. Each was recorded
   at Foundrise, so its owner (you) reads why there, and nowhere else
   (at Harbour, where you're a member, Sana is just "Off"). Foundrise bills
   £85 an hour, the launch £95 and the brand work £110.
   ============================================================ */
import { KANBO_TODAY } from "../data/data";
import type { BillRate, MemberWeek, TimeOff } from "./availability";
import { isoOf } from "./availability";
import { addDays } from "./weekMath";

const day = (n: number) => isoOf(addDays(KANBO_TODAY, n));

export function demoWeeks(): MemberWeek[] {
  return [
    { workspaceId: "ws-foundrise", userId: "m-1", weeklyHours: 32, workDays: [1, 2, 3, 4], dayStart: 9 * 60, dayEnd: 17 * 60 + 30 },
    { workspaceId: "ws-foundrise", userId: "m-3", weeklyHours: 35, workDays: [1, 2, 3, 4, 5], dayStart: 9 * 60 + 30, dayEnd: 17 * 60 + 30 },
    { workspaceId: "ws-reco", userId: "m-1", weeklyHours: 8, workDays: [5], dayStart: 9 * 60, dayEnd: 17 * 60 },
  ];
}

export function demoTimeOff(): TimeOff[] {
  return [
    { id: "off-demo-theo", userId: "m-2", workspaceId: "ws-foundrise", createdBy: "m-2", startsOn: day(0), endsOn: day(0), halfDay: null, reason: "Moving house" },
    { id: "off-demo-sana", userId: "m-3", workspaceId: "ws-foundrise", createdBy: "m-3", startsOn: day(1), endsOn: day(5), halfDay: null, reason: "Family wedding" },
    { id: "off-demo-maya", userId: "m-1", workspaceId: "ws-foundrise", createdBy: "m-1", startsOn: day(9), endsOn: day(9), halfDay: "pm", reason: "Dentist" },
  ];
}

export function demoRates(): BillRate[] {
  return [
    { workspaceId: "ws-foundrise", projectId: null, rate: 85 },
    { workspaceId: "ws-foundrise", projectId: "p-launch", rate: 95 },
    { workspaceId: "ws-foundrise", projectId: "p-brand", rate: 110 },
    { workspaceId: "ws-courtside", projectId: null, rate: 60 },
  ];
}
