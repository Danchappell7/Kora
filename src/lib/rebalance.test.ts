import { describe, expect, it } from "vitest";
import type { Task } from "../data/types";
import { moveIntoWeek, planRebalance, rebalancePatches } from "./rebalance";

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "rb" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "maya", workspaceId: "ws",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...o,
});
// the week of Monday 9 November 2026; today is Tuesday the 10th
const MON = new Date(2026, 10, 9), TODAY = new Date(2026, 10, 10);
const members = [{ id: "maya" }, { id: "theo" }, { id: "sana" }, { id: "gus", guest: true }];

describe("planRebalance", () => {
  it("hands the biggest work not yet started to whoever has most room, until the person's under capacity", () => {
    const tasks = [
      task({ id: "big", title: "Load test", dueDate: "2026-11-13", effortHours: 10 }),
      task({ id: "mid", dueDate: "2026-11-12", effortHours: 6 }),
      task({ id: "busy", status: "progress", dueDate: "2026-11-12", effortHours: 20 }),
      task({ id: "small", dueDate: "2026-11-11", effortHours: 4 }),
      task({ id: "theos", assigneeId: "theo", dueDate: "2026-11-12", effortHours: 8 }),
    ];
    const plan = planRebalance({ tasks, members, weekStart: MON, today: TODAY, capacityOf: (id) => (id === "maya" ? 32 : 40) });
    // Maya has 40h against 32h: the 10h "Load test" goes to Sana (most room), and that's enough
    expect(plan.moves).toEqual([{ taskId: "big", title: "Load test", from: "maya", to: "sana", due: "2026-11-13", hours: 10 }]);
    expect(plan.before).toMatchObject({ maya: 40, theo: 8, sana: 0 });
    expect(plan.after).toMatchObject({ maya: 30, sana: 10 });
    expect(plan.after.gus).toBeUndefined();
    expect(rebalancePatches(plan)).toEqual({ apply: [{ id: "big", patch: { assigneeId: "sana" } }], undo: [{ id: "big", patch: { assigneeId: "maya" } }] });
  });
  it("never gives work to a guest, to someone away the day it's due, or past 90% of their capacity", () => {
    const tasks = [task({ id: "a", dueDate: "2026-11-12", effortHours: 30 }), task({ id: "b", dueDate: "2026-11-12", effortHours: 20 })];
    const plan = planRebalance({ tasks, members, weekStart: MON, today: TODAY, capacityOf: (id) => (id === "maya" ? 20 : id === "theo" ? 20 : 40),
      isOff: (id, iso) => id === "sana" && iso === "2026-11-12" });
    // Sana is off that day and Theo has room for 18h only: nothing fits
    expect(plan.moves).toEqual([]);
  });
  it("puts someone around the whole time before it's due ahead of someone off for part of it", () => {
    const tasks = [task({ id: "big", dueDate: "2026-11-13", effortHours: 10 }), task({ id: "started", status: "progress", dueDate: "2026-11-13", effortHours: 25 })];
    // Sana has more room, but she's off today: Theo (around all week) takes it
    const plan = planRebalance({ tasks, members, weekStart: MON, today: TODAY, capacityOf: (id) => (id === "maya" ? 32 : id === "theo" ? 30 : 40),
      isOff: (id, iso) => id === "sana" && iso === "2026-11-10" });
    expect(plan.moves.map((m) => [m.taskId, m.to])).toEqual([["big", "theo"]]);
    // nobody else with room: she still can
    expect(planRebalance({ tasks, members: members.filter((m) => m.id !== "theo"), weekStart: MON, today: TODAY, capacityOf: (id) => (id === "maya" ? 32 : 40),
      isOff: (id, iso) => id === "sana" && iso === "2026-11-10" }).moves.map((m) => m.to)).toEqual(["sana"]);
  });
  it("asks the business's owner last", () => {
    const tasks = [task({ id: "big", dueDate: "2026-11-13", effortHours: 10 }), task({ id: "started", status: "progress", dueDate: "2026-11-13", effortHours: 25 })];
    const plan = planRebalance({ tasks, members, weekStart: MON, today: TODAY, capacityOf: (id) => (id === "maya" ? 32 : id === "theo" ? 30 : 40), lastResort: (id) => id === "sana" });
    expect(plan.moves.map((m) => m.to)).toEqual(["theo"]);
  });
  it("leaves sub-tasks, milestones and personal work where they are", () => {
    const tasks = [task({ parentId: "x", dueDate: "2026-11-12", effortHours: 50 }), task({ isMilestone: true, dueDate: "2026-11-12", effortHours: 50 }),
      task({ workspaceId: null, dueDate: "2026-11-12", effortHours: 50 })];
    expect(planRebalance({ tasks, members, weekStart: MON, today: TODAY, capacityOf: () => 40 }).moves).toEqual([]);
  });
  it("(0058) never puts in work you can only view: the next biggest goes instead", () => {
    const tasks = [task({ id: "fees", projectId: "p-fees", dueDate: "2026-11-13", effortHours: 10 }), task({ id: "mid", dueDate: "2026-11-12", effortHours: 8 }),
      task({ id: "busy", status: "progress", dueDate: "2026-11-12", effortHours: 22 })];
    const plan = planRebalance({ tasks, members, weekStart: MON, today: TODAY, capacityOf: (id) => (id === "maya" ? 32 : 40), canMove: (t) => t.projectId !== "p-fees" });
    expect(plan.moves.map((m) => m.taskId)).toEqual(["mid"]);
  });
});

describe("moveIntoWeek", () => {
  const NEXT = new Date(2026, 10, 16);
  it("keeps the weekday, moves the start with it, and is nothing when it's already due that week", () => {
    expect(moveIntoWeek({ dueDate: "2026-11-12", startDate: "2026-11-10" }, NEXT, TODAY)).toEqual({ dueDate: "2026-11-19", startDate: "2026-11-17" });
    expect(moveIntoWeek({ dueDate: "2026-11-18" }, NEXT, TODAY)).toBeNull();
  });
  it("lands on Friday when there was no due date, and never before today", () => {
    expect(moveIntoWeek({}, NEXT, TODAY)).toEqual({ dueDate: "2026-11-20" });
    expect(moveIntoWeek({ dueDate: "2026-11-02" }, MON, TODAY)).toEqual({ dueDate: "2026-11-10" });
  });
  it("steps off days the person doesn't work or is away", () => {
    expect(moveIntoWeek({ dueDate: "2026-11-13" }, NEXT, TODAY, { workDays: [1, 2, 3, 4] })).toEqual({ dueDate: "2026-11-19" });
    expect(moveIntoWeek({ dueDate: "2026-11-10" }, NEXT, TODAY, { isOff: (iso) => iso >= "2026-11-17" && iso <= "2026-11-20" })).toEqual({ dueDate: "2026-11-16" });
  });
});

describe("planRebalance and project access (0058)", () => {
  it("never hands work to someone who can't see its project: the next person with room takes it, or nobody", () => {
    const tasks = [
      task({ id: "pay", title: "Renew contract", projectId: "p-payroll", dueDate: "2026-11-13", effortHours: 10 }),
      task({ id: "busy", status: "progress", dueDate: "2026-11-12", effortHours: 30 }),
    ];
    const base = { tasks, members, weekStart: MON, today: TODAY, capacityOf: (id: string) => (id === "maya" ? 32 : 40) };
    // Sana has the most room, but only Maya and Theo can see Payroll
    const seen = (id: string, t: Task) => t.projectId !== "p-payroll" || id === "maya" || id === "theo";
    expect(planRebalance({ ...base, canReceive: seen }).moves.map((m) => [m.taskId, m.to])).toEqual([["pay", "theo"]]);
    expect(planRebalance({ ...base, canReceive: (id, t) => t.projectId !== "p-payroll" || id === "maya" }).moves).toEqual([]);
    // (none given: as before)
    expect(planRebalance(base).moves.map((m) => m.to)).toEqual(["sana"]);
  });
});
