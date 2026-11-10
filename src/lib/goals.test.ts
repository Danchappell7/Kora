/* Goals 2.0's pure rules: periods, direction-aware progress with weighted roll-ups,
   the pace line and its suggested status, and who may do what (mirroring 0052). */
import { describe, expect, it } from "vitest";
import type { Goal } from "../data/types";
import { isPeriod, periodChoices, periodLabel, periodRange, quarterOf } from "./goalPeriods";
import { goalNumbersGap, goalProgressMap, goalStartValue, goalValuePct, tracksOwnNumber } from "./goalProgress";
import { goalPace, groupGoalPace, paceCurve, paceDisagrees, paceWindow } from "./goalPace";
import { canDeleteGoal, canEditGoal, canHandOverGoal, canMakeCompanyGoal, canPlaceGoal, canSeeGoal, goalLookup, isGoalPerson } from "./goalRules";
import { goalsBehind } from "./group";

const g = (o: Partial<Goal> & { id: string }): Goal => ({ name: o.id, status: "on_track", workspaceId: "ws", ...o });

describe("periods", () => {
  it("a quarter, a half and a year run from their first day to their last (as goal_period_bounds)", () => {
    expect(periodRange("2027-Q1")).toEqual({ start: "2027-01-01", end: "2027-03-31" });
    expect(periodRange("2028-Q1")).toEqual({ start: "2028-01-01", end: "2028-03-31" });
    expect(periodRange("2026-Q4")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(periodRange("2027-H1")).toEqual({ start: "2027-01-01", end: "2027-06-30" });
    expect(periodRange("2027-H2")).toEqual({ start: "2027-07-01", end: "2027-12-31" });
    expect(periodRange("2027-FY")).toEqual({ start: "2027-01-01", end: "2027-12-31" });
    expect(periodRange("2027-Q2")).toEqual({ start: "2027-04-01", end: "2027-06-30" });
  });
  it("your own dates need both ends, in order; anything else isn't a period", () => {
    expect(periodRange("custom", "2027-02-01", "2027-05-15")).toEqual({ start: "2027-02-01", end: "2027-05-15" });
    expect(periodRange("custom", "2027-05-15", "2027-02-01")).toBeNull();
    expect(periodRange("custom", "2027-02-01", null)).toBeNull();
    expect(periodRange("2027-Q5")).toBeNull();
    expect(periodRange(null)).toBeNull();
    expect([isPeriod("2027-Q1"), isPeriod("custom"), isPeriod("Q1"), isPeriod("")]).toEqual([true, true, false, false]);
  });
  it("says them plainly", () => {
    expect(periodLabel("2027-Q1")).toBe("Q1 2027");
    expect(periodLabel("2027-H2")).toBe("H2 2027");
    expect(periodLabel("2027-FY")).toBe("2027");
    expect(periodLabel("custom", "2027-02-01", "2027-05-15")).toBe("1 Feb – 15 May 2027");
    expect(periodLabel("custom", "2026-11-01", "2027-01-31")).toBe("1 Nov 2026 – 31 Jan 2027");
    expect(periodLabel(undefined)).toBe("");
  });
  it("offers this quarter and the next three, this half and the next, this year and the next", () => {
    expect(quarterOf(new Date(2026, 10, 10))).toBe("2026-Q4");
    expect(periodChoices(new Date(2026, 10, 10)).map((c) => c.value)).toEqual([
      "2026-Q4", "2027-Q1", "2027-Q2", "2027-Q3", "2026-H2", "2027-H1", "2026-FY", "2027-FY",
    ]);
    expect(periodChoices(new Date(2027, 1, 3)).slice(0, 2).map((c) => c.label)).toEqual(["Q1 2027", "Q2 2027"]);
  });
});

describe("progress: direction-aware, weighted", () => {
  it("cut churn from 8% to 5% reads 0% on day one, not 100%", () => {
    const churn = { direction: "lower" as const, startValue: 8, target: 5, current: 8 };
    expect(goalValuePct(churn)).toBe(0);
    expect(goalValuePct({ ...churn, current: 6.5 })).toBe(50);
    expect(goalValuePct({ ...churn, current: 5 })).toBe(100);
    expect(goalValuePct({ ...churn, current: 4 })).toBe(100);   // beaten: capped
    expect(goalValuePct({ ...churn, current: 9 })).toBe(0);     // worse than the start: not below 0
  });
  it("higher is better from a start value; with none it's from 0, as before", () => {
    expect(goalValuePct({ startValue: 3200, target: 5000, current: 3900 })).toBeCloseTo(38.9, 1);
    expect(goalValuePct({ target: 5000, current: 3900 })).toBe(78);
    expect(goalValuePct({ target: 0, current: 3 })).toBe(0);
    expect(goalValuePct({ current: 3 })).toBe(0);
  });
  it("lower is better with no start value has nothing to measure from: 0% (never 100%) until it's set", () => {
    expect(goalStartValue({ direction: "lower" })).toBeNull();
    expect(goalNumbersGap({ direction: "lower", target: 5 })).toBe("start");
    expect(goalValuePct({ direction: "lower", target: 5, current: 12 })).toBe(0);
    expect(goalValuePct({ direction: "lower", target: 5, current: 5 })).toBe(0);
    expect(tracksOwnNumber({ direction: "lower", current: 12 })).toBe(false);
    expect(tracksOwnNumber({ current: 4 })).toBe(true);
    expect(tracksOwnNumber({ current: 0 })).toBe(false);
  });
  it("Lower picked before the numbers (a start of 0 under a target of 5) reads 0%, not 'Target reached'", () => {
    const toggledFirst = { direction: "lower" as const, startValue: 0, target: 5, current: 8 };
    expect(goalNumbersGap(toggledFirst)).toBe("start");
    expect(goalValuePct(toggledFirst)).toBe(0);
    expect(goalValuePct({ ...toggledFirst, startValue: 8 })).toBe(0);
    expect(goalValuePct({ ...toggledFirst, startValue: 8, current: 5 })).toBe(100);
    // higher is better: a target at or under its start needs one or the other
    expect(goalNumbersGap({ target: 0 })).toBe("target");
    expect(goalNumbersGap({ startValue: 10, target: 5 })).toBe("start");
    expect(goalNumbersGap({ target: 100 })).toBeNull();
    expect(goalNumbersGap({ startValue: 3 })).toBe("target");
  });
  it("rolls key results up by weight, archived ones not counted", () => {
    const goals = [
      g({ id: "O" }),
      g({ id: "a", parentId: "O", current: 80, target: 100, weight: 3 }),
      g({ id: "b", parentId: "O", current: 20, target: 100 }),
      g({ id: "z", parentId: "O", current: 0, target: 100, archivedAt: "2026-10-01T00:00:00Z" }),
    ];
    expect(goalProgressMap(goals, () => 0).get("O")).toEqual({ pct: 65, source: "subgoals", children: 3, subPct: 65 });
  });
  it("a lower-is-better key result counts the way it's going", () => {
    const goals = [g({ id: "O" }), g({ id: "churn", parentId: "O", direction: "lower", startValue: 8, target: 5, current: 6.5 }), g({ id: "nps", parentId: "O", startValue: 30, target: 50, current: 30 })];
    expect(goalProgressMap(goals, () => 0).get("O")?.pct).toBe(25);
  });
  it("a linked project still drives a goal", () => {
    expect(goalProgressMap([g({ id: "L", projectId: "p", direction: "lower", startValue: 8, target: 5, current: 8 })], () => 60).get("L")).toMatchObject({ pct: 60, source: "project" });
  });
});

describe("pace and the suggested status", () => {
  // a quarter: 1 Oct to 31 Dec (91 days); 10 Nov is day 40, 44% of the way
  const TODAY = new Date(2026, 10, 10);
  const q4 = { periodStart: "2026-10-01", periodEnd: "2026-12-31" };
  it("runs from the period's start (else the day it was made) to the due date (else the period's end)", () => {
    expect(paceWindow(q4)).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    // made before its quarter: from the quarter's first day; made part-way through: from that day
    expect(paceWindow({ ...q4, createdAt: "2026-09-20T09:00:00Z" })).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(paceWindow({ ...q4, createdAt: "2026-11-10T09:00:00Z" })).toEqual({ start: "2026-11-10", end: "2026-12-31" });
    expect(paceWindow({ ...q4, due: "2026-11-30" })).toEqual({ start: "2026-10-01", end: "2026-11-30" });
    expect(paceWindow({ createdAt: "2026-09-15T09:00:00Z", due: "2026-12-15" })).toEqual({ start: "2026-09-15", end: "2026-12-15" });
    expect(paceWindow({ due: "2026-12-15" })).toBeNull();
    expect(paceWindow({ periodStart: "2026-12-31", due: "2026-12-01" })).toBeNull();
  });
  it("says behind, on or ahead of pace, and suggests a status to match", () => {
    expect(goalPace(q4, 44, TODAY)).toMatchObject({ expected: 44, state: "on", line: "On pace", suggest: "on_track" });
    expect(goalPace(q4, 52, TODAY)).toMatchObject({ state: "ahead", line: "Ahead of pace", suggest: "on_track" });
    expect(goalPace(q4, 32, TODAY)).toMatchObject({ gap: -12, state: "behind", line: "Behind pace by 12%", suggest: "at_risk" });
    expect(goalPace(q4, 20, TODAY)).toMatchObject({ line: "Behind pace by 24%", suggest: "off_track" });
  });
  it("a goal made today, mid-quarter, is on pace (not 44% behind with Off track suggested)", () => {
    expect(goalPace({ ...q4, createdAt: new Date(2026, 10, 10, 9).toISOString() }, 0, TODAY)).toMatchObject({ expected: 0, state: "on", line: "On pace" });
    expect(goalPace({ ...q4, createdAt: new Date(2026, 9, 1, 9).toISOString() }, 0, TODAY)).toMatchObject({ state: "behind", suggest: "off_track" });
  });
  it("past its date unfinished is off track; reaching the target suggests Achieved; before it starts, nothing", () => {
    expect(goalPace({ ...q4, due: "2026-11-01" }, 60, TODAY)).toMatchObject({ state: "late", line: "Past due at 60%", suggest: "off_track" });
    expect(goalPace(q4, 100, TODAY)).toMatchObject({ state: "done", line: "Target reached", suggest: "done" });
    expect(goalPace({ periodStart: "2027-01-01", periodEnd: "2027-03-31" }, 0, TODAY)).toMatchObject({ state: "early", line: "Starts 1 Jan", suggest: null });
  });
  it("back-loaded expects little early and most late; off means no pace line", () => {
    expect(paceCurve("backloaded", 0.5)).toBe(0.25);
    expect(goalPace({ ...q4, pace: "backloaded" }, 20, TODAY)).toMatchObject({ expected: 19, state: "on" });
    expect(goalPace({ ...q4, pace: "off" }, 20, TODAY)).toBeNull();
  });
  it("disagrees calmly: only when there's a suggestion, it differs, and the owner hasn't called it achieved", () => {
    const behind = goalPace(q4, 32, TODAY);
    expect(paceDisagrees("on_track", behind)).toBe(true);
    expect(paceDisagrees("at_risk", behind)).toBe(false);
    expect(paceDisagrees("done", behind)).toBe(false);
    expect(paceDisagrees("on_track", goalPace({ periodStart: "2027-01-01", periodEnd: "2027-03-31" }, 0, TODAY))).toBe(false);
    expect(paceDisagrees("on_track", null)).toBe(false);
  });
  it("fills the Group page's hook: a goal behind pace counts as behind, with its line", () => {
    const goals = [g({ id: "slow", ...q4, current: 30, target: 100 }), g({ id: "fine", ...q4, current: 45, target: 100 }), g({ id: "nopace", ...q4, pace: "off", current: 1, target: 100 })];
    const progress = goalProgressMap(goals, () => 0);
    expect(goalsBehind(goals, progress, TODAY, groupGoalPace).map((x) => [x.goal.id, x.why, x.pace?.line])).toEqual([["slow", "pace", "Behind pace by 14%"]]);
    expect(groupGoalPace(goals[1], progress.get("fine")!, TODAY)).toEqual({ behind: false, line: "On pace" });
    // an archived goal's quarter is over: it isn't behind
    expect(goalsBehind([g({ id: "old", ...q4, current: 1, target: 100, status: "off_track", archivedAt: "2026-10-02T00:00:00Z" })], progress, TODAY, groupGoalPace)).toEqual([]);
  });
});

describe("who may do what (as 0052)", () => {
  const me = "me";
  const team = (o: Partial<Goal> = {}) => g({ id: "x", ownerId: "owner", contributors: ["helper"], ...o });
  it("owners and admins edit any team goal; the goal's owner and contributors edit theirs; other members and guests don't", () => {
    expect(canEditGoal(team(), { me, role: "owner" })).toBe(true);
    expect(canEditGoal(team(), { me, role: "admin" })).toBe(true);
    expect(canEditGoal(team(), { me, role: "member" })).toBe(false);
    expect(canEditGoal(team({ ownerId: me }), { me, role: "member" })).toBe(true);
    expect(canEditGoal(team({ contributors: [me] }), { me, role: "member" })).toBe(true);
    expect(canEditGoal(team({ ownerId: me }), { me, role: "guest" })).toBe(false);
    expect(canEditGoal(g({ id: "p", workspaceId: null }), { me, role: null })).toBe(true);
    expect(isGoalPerson(team({ contributors: [me] }), me)).toBe(true);
  });
  it("a team goal with key results under it is deleted by owners and admins only (its key results would become company goals)", () => {
    expect(canDeleteGoal(team({ ownerId: me }), 0, { me, role: "member" })).toBe(true);
    expect(canDeleteGoal(team({ ownerId: me }), 2, { me, role: "member" })).toBe(false);
    expect(canDeleteGoal(team(), 2, { me, role: "admin" })).toBe(true);
    expect(canDeleteGoal(team(), 0, { me, role: "member" })).toBe(false);
    expect(canDeleteGoal(g({ id: "p", workspaceId: null }), 3, { me, role: null })).toBe(true);
  });
  it("only owners, admins and the goal's owner hand it over (not its contributors)", () => {
    expect(canHandOverGoal(team({ contributors: [me] }), { me, role: "member" })).toBe(false);
    expect(canHandOverGoal(team({ ownerId: me }), { me, role: "member" })).toBe(true);
    expect(canHandOverGoal(team(), { me, role: "admin" })).toBe(true);
    expect(canHandOverGoal(g({ id: "p", workspaceId: null }), { me, role: null })).toBe(false);
  });
  it("company goals are for owners and admins; a key result goes under a goal you can edit", () => {
    expect(canPlaceGoal("ws", null, { me, role: "admin" })).toBe(true);
    expect(canPlaceGoal("ws", null, { me, role: "member" })).toBe(false);
    expect(canPlaceGoal("ws", team({ ownerId: me }), { me, role: "member" })).toBe(true);
    expect(canPlaceGoal("ws", team(), { me, role: "member" })).toBe(false);
    expect(canPlaceGoal("ws", team({ workspaceId: "other", ownerId: me }), { me, role: "member" })).toBe(false);
    expect(canPlaceGoal(null, null, { me, role: null })).toBe(true);
    expect([canMakeCompanyGoal("ws", "member"), canMakeCompanyGoal("ws", "owner"), canMakeCompanyGoal(null, null)]).toEqual([false, true, true]);
  });
  it("leadership only: owners, admins, the goal's owner and contributors read it; guests read no team goal", () => {
    const lead = team({ visibility: "leadership" });
    expect(canSeeGoal(lead, { me, role: "member" })).toBe(false);
    expect(canSeeGoal(lead, { me: "helper", role: "member" })).toBe(true);
    expect(canSeeGoal(lead, { me, role: "admin" })).toBe(true);
    expect(canSeeGoal(team(), { me, role: "member" })).toBe(true);
    expect(canSeeGoal(team(), { me, role: "guest" })).toBe(false);
  });
  it("leadership only hides the goals under it too (key results made with no visibility of their own), as goal_readable does", () => {
    const lead = team({ id: "lead", ownerId: "boss", contributors: ["deputy"], visibility: "leadership" });
    const kr = team({ id: "kr", parentId: "lead", ownerId: "boss", contributors: [] });
    const deeper = team({ id: "deeper", parentId: "kr", ownerId: "boss", contributors: [] });
    const all = [lead, kr, deeper];
    const byId = goalLookup(all);
    const seen = (who: string, role: "member" | "admin") => all.filter((x) => canSeeGoal(x, { me: who, role }, byId)).map((x) => x.id);
    expect(seen(me, "member")).toEqual([]);                          // a member: none of the branch
    expect(seen(me, "admin")).toEqual(["lead", "kr", "deeper"]);     // an admin: all of it
    expect(seen("deputy", "member")).toEqual(["lead", "kr", "deeper"]);   // the objective's own people: the whole branch
    expect(all.filter((x) => canSeeGoal(x, { me, role: "member" }, goalLookup([lead, { ...kr, ownerId: me }, deeper]))).map((x) => x.id))
      .toEqual(["deeper"]);   // (deeper's walk passes a kr that's mine)
    expect(canSeeGoal({ ...kr, ownerId: me }, { me, role: "member" }, byId)).toBe(true);   // your own key result, whatever's above it
    // opening the objective up shows its key results again; without the lookup only the goal's own setting counts
    expect(seen(me, "member").length).toBe(0);
    const open = goalLookup([{ ...lead, visibility: "everyone" as const }, kr, deeper]);
    expect([kr, deeper].every((x) => canSeeGoal(x, { me, role: "member" }, open))).toBe(true);
    expect(canSeeGoal(kr, { me, role: "member" })).toBe(true);
  });
});
