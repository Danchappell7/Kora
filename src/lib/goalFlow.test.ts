/* Goals in the day's work (lib/goalFlow): what a project or task serves, the work behind a goal,
   the quarter a goal belongs to, the page's groups and summary, the brief's one goal line, the key
   results Kanbo noticed are behind pace, and what Ask is told. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal, GoalCheckin, GoalLink, Project, StatusUpdate, Task } from "../data/types";
import {
  askGoals, briefGoalLookup, checkinAge, goalCarriedOver, goalGroup, goalInRange, goalsBehindForMe, goalsForProject, goalsForTask, goalsInQuarter, goalsSummary, goalSpan,
  hasWorkBehind, paceWords, periodShort, projectDot, quarterOptions, readGoals, seeableGoals, servesLabel,
} from "./goalFlow";

const TODAY = new Date(2026, 10, 10);   // 10 Nov 2026: day 40 of Q4's 91 (44% of the way)
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 12)); });
afterEach(() => { vi.useRealTimers(); });

const Q4 = { period: "2026-Q4", periodStart: "2026-10-01", periodEnd: "2026-12-31" };
const goal = (o: Partial<Goal> & { id: string }): Goal => ({ name: o.id, status: "on_track", workspaceId: "ws", ownerId: "me", contributors: [], kind: "objective", pace: "linear", ...Q4, ...o });
const task = (o: Partial<Task> & { id: string }): Task => ({ title: o.id, description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "me", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o });
const link = (goalId: string, kind: GoalLink["kind"], targetId: string): GoalLink => ({ id: `${goalId}-${targetId}`, goalId, kind, targetId, workspaceId: "ws" });

// behind: 10% of the way at 44% expected; on: 45%; a project-driven one at 0% (p1 has one open task)
const behind = goal({ id: "behind", name: "Win back 120 accounts", target: 100, current: 10, startValue: 0, kind: "key_result", parentId: "top" });
const onPace = goal({ id: "on", name: "Grow actives", target: 100, current: 45, startValue: 0 });
const top = goal({ id: "top", name: "Grow the business", target: 100, current: 50, startValue: 0 });
const viaProject = goal({ id: "proj", name: "Launch", projectId: "p1", ownerId: "maya", contributors: ["me"], ...{ period: null, periodStart: null, periodEnd: null }, due: "2026-11-30", createdAt: "2026-10-01T09:00:00Z" });
const GOALS = [top, onPace, behind, viaProject];
const TASKS = [task({ id: "t1" }), task({ id: "t2", projectId: "p2" })];

describe("a goal's read", () => {
  it("says on pace or behind from the pace line, early before it starts, and the status when there's no line", () => {
    const reads = readGoals([...GOALS, goal({ id: "later", period: "2027-Q1", periodStart: "2027-01-01", periodEnd: "2027-03-31", target: 10, current: 0 }),
      goal({ id: "flat", pace: "off", status: "at_risk", target: 10, current: 5 })], TASKS, TODAY);
    expect(reads.get("behind")).toMatchObject({ pct: 10, standing: "behind" });
    expect(reads.get("behind")!.pace!.line).toBe("Behind pace by 34%");
    expect(reads.get("on")!.standing).toBe("on");
    expect(reads.get("proj")).toMatchObject({ pct: 0, standing: "behind" });
    expect(reads.get("later")!.standing).toBe("early");
    expect(reads.get("flat")).toMatchObject({ pace: null, standing: "behind" });   // no pace line: its status speaks
  });
  it("a goal whose own number isn't set up yet has no pace, no suggestion and isn't counted: it asks for what's missing", () => {
    const reads = readGoals([goal({ id: "cut", direction: "lower", startValue: null, target: 5, current: 8 }), goal({ id: "zero", target: 0, current: 0 })], TASKS, TODAY);
    expect(reads.get("cut")).toMatchObject({ pct: 0, pace: null, standing: "early", needs: "start" });
    expect(paceWords(reads.get("cut")!)).toBe("Set where it started");
    expect(reads.get("zero")).toMatchObject({ needs: "target", standing: "early" });
    expect(goalsSummary([...reads.values()]).plain).toBe("2 goals, none started yet.");
  });
});

describe("a quarter's goals", () => {
  it("the quarter you're in carries over open goals whose time ran out before it; other quarters don't", () => {
    const late = goal({ id: "late", period: null, periodStart: null, periodEnd: null, createdAt: "2026-07-01T09:00:00Z", due: "2026-09-15", target: 100, current: 10, startValue: 0 });
    const doneLate = { ...late, id: "doneLate", status: "done" as const };
    const reads = readGoals([late, doneLate, onPace], TASKS, TODAY);
    const [q3, q4, q1] = quarterOptions(TODAY).map((q) => q.range!);
    expect(goalInRange(late, q4)).toBe(false);
    expect(goalCarriedOver(reads.get("late")!, q4)).toBe(true);
    expect(goalsInQuarter([late, doneLate, onPace], reads, q4, TODAY).map((g) => g.id)).toEqual(["late", "on"]);
    expect(goalsInQuarter([late, doneLate, onPace], reads, q3, TODAY).map((g) => g.id)).toEqual(["late", "doneLate"]);
    expect(goalsInQuarter([late, doneLate, onPace], reads, q1, TODAY).map((g) => g.id)).toEqual([]);
    expect(goalsInQuarter([late, onPace], reads, null, TODAY)).toHaveLength(2);
    expect(reads.get("late")!.pace!.line).toBe("Past due at 10%");
  });
});

describe("the work behind a goal", () => {
  const links = [link("behind", "task", "t1"), link("on", "project", "p2")];
  it("a project serves the goals linked to it and the ones reading their % from it (open ones only)", () => {
    expect(goalsForProject("p1", GOALS, links).map((g) => g.id)).toEqual(["proj"]);
    expect(goalsForProject("p2", GOALS, links).map((g) => g.id)).toEqual(["on"]);
    expect(goalsForProject("p2", [{ ...onPace, status: "done" }], links)).toEqual([]);
    expect(goalsForProject("p2", [{ ...onPace, archivedAt: "2026-11-01T00:00:00Z" }], links)).toEqual([]);
  });
  it("a task serves its own goals first, then its project's; a sub-task its parent's", () => {
    expect(goalsForTask(TASKS[0], GOALS, links).map((g) => g.id)).toEqual(["behind", "proj"]);
    expect(goalsForTask(task({ id: "s1", parentId: "t1", projectId: "p9" }), GOALS, links).map((g) => g.id)).toEqual(["behind"]);
    expect(goalsForTask(task({ id: "t9", projectId: "p9" }), GOALS, links)).toEqual([]);
  });
  it("a goal has work behind it when it or any key result under it is linked to something", () => {
    expect(hasWorkBehind(behind, GOALS, links)).toBe(true);
    expect(hasWorkBehind(top, GOALS, links)).toBe(true);           // through its key result
    expect(hasWorkBehind(viaProject, GOALS, [])).toBe(true);       // its % comes from a project
    expect(hasWorkBehind(top, GOALS, [])).toBe(false);
    expect(hasWorkBehind(goal({ id: "loop", parentId: "loop" }), [goal({ id: "loop", parentId: "loop" })], [])).toBe(false);   // never loops
  });
  it("leadership-only goals stay with their people; guests see no team goals; a personal goal is yours", () => {
    const lead = goal({ id: "lead", visibility: "leadership", ownerId: "alice" });
    const mine = goal({ id: "mine", workspaceId: null });
    const roles: Record<string, "member" | "guest"> = { ws: "member", other: "guest" };
    const seen = seeableGoals([lead, onPace, mine, goal({ id: "theirs", workspaceId: "other" })], "me", (ws) => (ws ? roles[ws] : null));
    expect(seen.map((g) => g.id)).toEqual(["on", "mine"]);
  });
});

describe("words", () => {
  it("names the period short (this year's quarter as Q4) and the chip as quarter · name", () => {
    expect(periodShort(onPace, TODAY)).toBe("Q4");
    expect(periodShort({ period: "2027-Q1" }, TODAY)).toBe("Q1 2027");
    expect(periodShort({ period: "2026-H2" }, TODAY)).toBe("H2");
    expect(periodShort({ period: "2026-FY" }, TODAY)).toBe("2026");
    expect(periodShort({ period: null }, TODAY)).toBe("");
    expect(servesLabel(onPace, TODAY)).toBe("Q4 · Grow actives");
    expect(servesLabel(viaProject, TODAY)).toBe("Launch");
  });
  it("says how long since the last check-in", () => {
    const at = (d: string): GoalCheckin => ({ id: d, goalId: "x", authorId: "me", value: 1, createdAt: d });
    expect(checkinAge(undefined, TODAY)).toBeNull();
    expect(checkinAge(at("2026-11-10T08:00:00"), TODAY)).toBe("today");
    expect(checkinAge(at("2026-11-08T08:00:00"), TODAY)).toBe("2d");
    expect(checkinAge(at("2026-10-20T08:00:00"), TODAY)).toBe("3w");
  });
});

describe("quarters and groups", () => {
  it("offers last quarter, this one, the next and All; a goal is in a quarter its span touches", () => {
    expect(quarterOptions(TODAY).map((q) => q.label)).toEqual(["Q3", "Q4", "Q1 2027", "All"]);
    const q4 = quarterOptions(TODAY)[1].range!, q1 = quarterOptions(TODAY)[2].range!;
    expect(goalInRange(onPace, q4)).toBe(true);
    expect(goalInRange(onPace, q1)).toBe(false);
    expect(goalSpan(viaProject)).toEqual({ start: "2026-10-01", end: "2026-11-30" });
    expect(goalInRange(goal({ id: "open", period: null, periodStart: null, periodEnd: null }), q1)).toBe(true);   // no dates: every quarter
    expect(goalInRange(goal({ id: "year", period: "2026-FY", periodStart: "2026-01-01", periodEnd: "2026-12-31" }), quarterOptions(TODAY)[0].range!)).toBe(true);
  });
  it("puts top-level goals in Company, key results you own or help on in Mine, the rest in Team", () => {
    expect(goalGroup(top, GOALS, "me")).toBe("company");
    expect(goalGroup(behind, GOALS, "me")).toBe("mine");
    expect(goalGroup(behind, GOALS, "maya")).toBe("team");
    // a key result under a leadership-only goal you can't see is still a key result, never a company goal
    expect(goalGroup(goal({ id: "orphan", parentId: "hidden", ownerId: "sana", contributors: [] }), GOALS, "maya")).toBe("team");
    expect(goalGroup(goal({ id: "orphan", parentId: "hidden", ownerId: "maya", contributors: [] }), GOALS, "maya")).toBe("mine");
    expect(goalGroup(goal({ id: "p", workspaceId: null }), GOALS, "me")).toBe("mine");
  });
});

describe("the summary sentence", () => {
  it("counts the goals on pace and names the ones behind (the furthest first)", () => {
    const reads = readGoals(GOALS, TASKS, TODAY);
    const s = goalsSummary(GOALS.map((g) => reads.get(g.id)!));
    // (Launch, read from its project, is at 0% two thirds of the way through: the furthest behind)
    expect(s.plain).toBe("2 of 4 goals on pace; Launch and Win back 120 accounts are behind.");
    expect(s.parts.filter((p) => typeof p !== "string")).toEqual([{ goalId: "proj", text: "Launch" }, { goalId: "behind", text: "Win back 120 accounts" }]);
    expect(goalsSummary([reads.get("on")!, reads.get("top")!]).plain).toBe("All 2 goals are on pace.");
    expect(goalsSummary([reads.get("on")!]).plain).toBe("The one goal here is on pace.");
    expect(goalsSummary([]).plain).toBe("No goals here yet.");
    const many = readGoals([0, 1, 2].map((i) => goal({ id: `b${i}`, name: `B${i}`, target: 100, current: i })), TASKS, TODAY);
    expect(goalsSummary([...many.values()]).plain).toBe("0 of 3 goals on pace; B0 and 2 more are behind.");
  });
});

describe("a linked project's health dot", () => {
  const p: Project = { id: "p1", name: "Launch", emoji: "🚀", color: "blue", workspaceId: "ws" };
  it("is its latest update's status, else what its tasks say", () => {
    const upd = (status: StatusUpdate["status"], createdAt: string): StatusUpdate => ({ id: createdAt, projectId: "p1", status, summary: "", createdAt });
    expect(projectDot(p, TASKS, [upd("on_track", "2026-11-01T00:00:00Z"), upd("off_track", "2026-11-05T00:00:00Z")], TODAY).tone).toBe("signal");
    expect(projectDot(p, [], [], TODAY)).toEqual({ tone: "neutral", label: "Launch: no tasks yet" });
    expect(projectDot(p, [task({ id: "late", dueDate: "2026-11-01" })], [], TODAY).tone).toBe("warn");
    expect(projectDot(p, [task({ id: "late", dueDate: "2026-11-01", status: "blocked" })], [], TODAY).tone).toBe("signal");
    expect(projectDot(p, [task({ id: "fine", dueDate: "2026-12-01" })], [], TODAY)).toEqual({ tone: "ok", label: "Launch: 0% done" });
  });
});

describe("the brief's goal line, Kanbo noticed and Ask", () => {
  const links = [link("behind", "task", "t1")];
  const reads = readGoals(GOALS, TASKS, TODAY);
  it("finds the goal of yours a task moves (the furthest behind first); none of yours, nothing", () => {
    const forMe = briefGoalLookup("me", GOALS, links, reads);
    // t1 moves my key result and Launch (I help on it, through its project): Launch is further behind
    expect(forMe(TASKS[0])).toEqual({ goalId: "proj", name: "Launch", behind: true, icon: null, color: null });
    expect(briefGoalLookup("me", GOALS.filter((g) => g.id !== "proj"), links, reads)(TASKS[0])).toEqual({ goalId: "behind", name: "Win back 120 accounts", behind: true, icon: null, color: null });
    expect(forMe(TASKS[1])).toBeNull();
    // Maya owns Launch (p1): t1 moves it for her
    expect(briefGoalLookup("maya", GOALS, links, reads)(TASKS[0])).toEqual({ goalId: "proj", name: "Launch", behind: true, icon: null, color: null });
    expect(briefGoalLookup("sam", GOALS, links, reads)(TASKS[0])).toBeNull();
  });
  it("lists the goals you own that are behind and take a check-in, key results first", () => {
    const checkins: GoalCheckin[] = [{ id: "c", goalId: "behind", authorId: "me", value: 10, createdAt: "2026-11-01T09:00:00Z" }];
    const mine = goalsBehindForMe("me", [...GOALS, goal({ id: "obj-behind", name: "Objective behind", target: 100, current: 20, startValue: 0 })], readGoals([...GOALS, goal({ id: "obj-behind", target: 100, current: 20, startValue: 0 })], TASKS, TODAY), checkins, TODAY);
    expect(mine.map((g) => [g.goalId, g.noun, g.gap, g.sinceCheckin])).toEqual([["behind", "key result", 34, 9], ["obj-behind", "goal", 24, null]]);
    // Maya owns Launch, behind, but it reads its % from a project: no check-in to offer
    expect(goalsBehindForMe("maya", GOALS, reads, [], TODAY)).toEqual([]);
  });
  it("tells Ask each goal's standing, slipping first, and which have no work behind them", () => {
    const told = askGoals(GOALS, links, reads, TODAY, (id) => ({ me: "Daniel Okai", maya: "Maya Lin" })[id ?? ""] ?? "");
    expect(told.map((g) => [g.id, g.slipping])).toEqual([["proj", true], ["behind", true], ["on", false], ["top", false]]);
    expect(told[1]).toMatchObject({ name: "Win back 120 accounts", period: "Q4", pct: 10, expected: 44, pace: "Behind pace by 34%", owner: "Daniel Okai", kind: "key result", noWork: false });
    expect(told.find((g) => g.id === "on")!.noWork).toBe(true);
  });
});
