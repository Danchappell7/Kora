import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadPlanState, restorePlanState, resetPlanState, planTableMissing, onPlanWrite, planMode, planUser, planEntry, planEntries,
  writePlan, withPlanDay, pendingPlans, hasPendingPlans, settlePlan, discardPlan, prunePendingPlans, remapPlanTask, applyRemotePlan,
  fillOwnPlan, mergeOwnPlans, theirPlanFields, cleanPlanPatch, planRowToState, toPlanRow, __resetPlanStateForTests,
} from "./planState";
import type { Task, TaskUserState } from "./types";

const DAY = "2026-10-05";
const task = (o: Partial<Task> & { id: string }): Task => ({
  title: o.id, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 50, scheduled: null, planToday: false, ...o,
});
const row = (taskId: string, o: Partial<TaskUserState> = {}): TaskUserState => ({ taskId, userId: "me", ...o });

beforeEach(() => { localStorage.clear(); __resetPlanStateForTests(); });

describe("plan state: modes", () => {
  it("is local until the person's rows are loaded, and only for them", () => {
    expect(planMode("me")).toBe("local");
    loadPlanState("me", []);
    expect(planMode("me")).toBe("server");
    expect(planMode()).toBe("server");
    expect(planMode("someone-else")).toBe("local");
    expect(planUser()).toBe("me");
  });

  it("a missing table keeps plans on the device, and writes are refused", () => {
    loadPlanState("me", "missing");
    expect(planMode("me")).toBe("local");
    expect(writePlan("t1", { planToday: true })).toBe(false);
    expect(pendingPlans()).toEqual([]);
  });

  it("restores the last good copy for an offline reload; none means local", () => {
    loadPlanState("me", [row("t1", { planToday: true, planDay: DAY })]);
    __resetPlanStateForTests();
    expect(restorePlanState("me")).toBe(true);
    expect(planEntry("t1")).toMatchObject({ planToday: true, planDay: DAY });
    __resetPlanStateForTests();
    expect(restorePlanState("nobody")).toBe(false);
    expect(planMode("nobody")).toBe("local");
  });

  it("the table going away mid-session sends plans back to the device", () => {
    loadPlanState("me", [row("t1", { planToday: true, planDay: DAY })]);
    planTableMissing();
    expect(planMode("me")).toBe("local");
    expect(planEntries().size).toBe(0);
  });

  it("sign-out forgets the rows and clears this device's cache, but keeps unsaved writes for their owner", () => {
    loadPlanState("me", [row("t1", { planToday: true, planDay: DAY })]);
    writePlan("t2", { mySectionId: "sec" });
    resetPlanState();
    expect(planUser()).toBeNull();
    expect(localStorage.getItem("kanbo-plan-state:me")).toBeNull();
    expect(localStorage.getItem("kanbo-plan-pending:me")).toBeTruthy();
    loadPlanState("me", []);
    expect(planEntry("t2")).toMatchObject({ mySectionId: "sec" });
  });
});

describe("plan state: writes", () => {
  beforeEach(() => loadPlanState("me", [row("t1", { planToday: true, planDay: "2026-10-04", scheduled: 540, aiScore: 70 })]));

  it("shows a write at once, over the server row, and tells the store", () => {
    const sink = vi.fn();
    onPlanWrite(sink);
    expect(writePlan("t1", { mySectionId: "sec-a" })).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(planEntry("t1")).toMatchObject({ mySectionId: "sec-a", aiScore: 70, scheduled: 540 });
    writePlan("t1", { mySectionId: null });
    expect(pendingPlans()).toEqual([expect.objectContaining({ taskId: "t1", patch: { mySectionId: null } })]);
    expect(hasPendingPlans()).toBe(true);
    onPlanWrite(null);
  });

  it("a slot or 'on today' for a new day carries the day and resets the other (yesterday's slot never returns)", () => {
    const p = withPlanDay(planEntry("t1"), DAY, { planToday: true });
    expect(p).toEqual({ planToday: true, planDay: DAY, scheduled: null });
    writePlan("t1", p);
    // the same day: only what changed
    expect(withPlanDay(planEntry("t1"), DAY, { scheduled: 600 })).toEqual({ scheduled: 600, planDay: DAY });
    // not day-bound: untouched
    expect(withPlanDay(planEntry("t1"), DAY, { aiScore: 3 })).toEqual({ aiScore: 3 });
  });

  it("settling keeps only what changed again while it was in flight", () => {
    writePlan("t2", { planToday: true, planDay: DAY });
    const sent = pendingPlans()[0].patch;
    writePlan("t2", { planToday: false });                // changed mid-flight
    settlePlan("t2", sent);
    expect(pendingPlans()).toEqual([expect.objectContaining({ taskId: "t2", patch: { planToday: false } })]);
    expect(planEntry("t2")).toMatchObject({ planToday: false, planDay: DAY });
    settlePlan("t2", { planToday: false });
    expect(pendingPlans()).toEqual([]);
    expect(planEntry("t2")).toMatchObject({ planToday: false, planDay: DAY }); // now the server copy
  });

  it("discards a refused write, and remaps a task saved under a new id", () => {
    writePlan("t3", { aiScore: 5 });
    discardPlan("t3");
    expect(planEntry("t3")).toBeUndefined();
    writePlan("t-new-1", { mySectionId: "s" });
    remapPlanTask("t1", "u1");
    remapPlanTask("t-new-1", "u2");
    expect(planEntry("t1")).toBeUndefined();
    expect(planEntry("u1")).toMatchObject({ taskId: "u1", scheduled: 540 });
    expect(planEntry("u2")).toMatchObject({ mySectionId: "s" });
  });

  it("gives up on writes for ids that never became real, once they're a week old", () => {
    writePlan("t-new-x", { mySectionId: "s" });
    writePlan("00000000-0000-4000-8000-000000000001", { mySectionId: "s" });
    const real = (id: string) => !id.startsWith("t-new");
    expect(prunePendingPlans(real)).toBe(0);
    expect(prunePendingPlans(real, Date.now() + 8 * 24 * 3600_000)).toBe(1);
    expect(pendingPlans().map((p) => p.taskId)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("re-reads storage before each change, so another tab's writes survive", () => {
    writePlan("t1", { mySectionId: "mine" });
    const other = JSON.parse(localStorage.getItem("kanbo-plan-pending:me")!);
    other["t9"] = { patch: { planToday: true, planDay: DAY }, at: Date.now() };
    localStorage.setItem("kanbo-plan-pending:me", JSON.stringify(other));
    writePlan("t2", { aiScore: 1 });
    expect(pendingPlans().map((p) => p.taskId).sort()).toEqual(["t1", "t2", "t9"]);
  });

  it("keeps writes for the session when storage refuses them", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    try {
      writePlan("t5", { mySectionId: "s" });
      expect(planEntry("t5")).toMatchObject({ mySectionId: "s" });
    } finally { set.mockRestore(); }
  });

  it("realtime: another device's change is news; our own echo isn't", () => {
    writePlan("t1", { mySectionId: "sec-a" });
    expect(applyRemotePlan("t1", row("t1", { planToday: true, planDay: "2026-10-04", scheduled: 540, aiScore: 70, mySectionId: "sec-a" }))).toBe(false);
    expect(applyRemotePlan("t4", row("t4", { planToday: true, planDay: DAY }))).toBe(true);
    expect(applyRemotePlan("t4", null)).toBe(true);
    expect(planEntry("t4")).toBeUndefined();
  });
});

describe("plan state: cleaning", () => {
  it("drops values the database would refuse", () => {
    expect(cleanPlanPatch({ scheduled: 540.4, planToday: "yes", planDay: "5 Oct", mySectionId: "x".repeat(201), aiScore: 72.6, aiReason: "r".repeat(2500), extra: 1 }))
      .toEqual({ scheduled: 540, aiScore: 73, aiReason: "r".repeat(2000) });
    expect(cleanPlanPatch({ mySectionId: "", scheduled: null, planToday: null })).toEqual({ mySectionId: null, scheduled: null, planToday: null });
    expect(cleanPlanPatch(null)).toEqual({});
  });

  it("maps rows both ways", () => {
    expect(planRowToState({ task_id: "t1", user_id: "me", scheduled: 600, plan_today: true, plan_day: "2026-10-05", my_section_id: null, ai_score: 9, ai_reason: "why", updated_at: "x" }, "me"))
      .toEqual({ taskId: "t1", userId: "me", scheduled: 600, planToday: true, planDay: DAY, mySectionId: null, aiScore: 9, aiReason: "why", updatedAt: "x" });
    expect(planRowToState({ nope: 1 }, "me")).toBeNull();
    expect(toPlanRow({ planToday: true, planDay: DAY })).toEqual({ plan_today: true, plan_day: DAY });
    expect(toPlanRow({ mySectionId: null, aiScore: 2, aiReason: "a", scheduled: null })).toEqual({ my_section_id: null, ai_score: 2, ai_reason: "a", scheduled: null });
  });
});

describe("plan precedence", () => {
  it("your own task: the row's plan wins; your plan for today fills in where it has none", () => {
    const e = row("t", { planToday: true, scheduled: 600, planDay: DAY, mySectionId: "mine", aiScore: 99 });
    // handed to you with its plan cleared: yours carries over (never the score: the row's is yours)
    expect(fillOwnPlan(task({ id: "t" }), e, DAY)).toMatchObject({ planToday: true, scheduled: 600, mySectionId: "mine", aiScore: 50 });
    // the row has its own: it stays
    const set = task({ id: "t", planToday: true, scheduled: 480, mySectionId: "row-sec" });
    expect(fillOwnPlan(set, e, DAY)).toBe(set);
    // yesterday's plan: only the section (not day-bound) fills in
    expect(fillOwnPlan(task({ id: "t" }), { ...e, planDay: "2026-10-04" }, DAY)).toMatchObject({ planToday: false, scheduled: null, mySectionId: "mine" });
    // "not on today" in your plan never un-plans the row
    const planned = task({ id: "t", planToday: true });
    expect(fillOwnPlan(planned, row("t", { planToday: false, planDay: DAY }), DAY)).toBe(planned);
    const bare = task({ id: "t" });
    expect(fillOwnPlan(bare, undefined, DAY)).toBe(bare);
  });

  it("someone else's task: your plan only, the slot and 'on today' only when for today", () => {
    expect(theirPlanFields(row("t", { planToday: true, scheduled: 600, planDay: DAY, mySectionId: "s", aiScore: 80, aiReason: "why" }), DAY))
      .toEqual({ scheduled: 600, planToday: true, mySectionId: "s", score: { aiScore: 80, aiReason: "why" } });
    expect(theirPlanFields(row("t", { planToday: true, scheduled: 600, planDay: "2026-10-04" }), DAY))
      .toEqual({ scheduled: null, planToday: false, mySectionId: undefined, score: {} });
    expect(theirPlanFields(undefined, DAY)).toEqual({ scheduled: null, planToday: false, mySectionId: undefined, score: {} });
  });

  it("bootstrap's merge touches only the person's own tasks, and keeps the list when nothing changes", () => {
    const mine = task({ id: "a" }), theirs = task({ id: "b", assigneeId: "bob" });
    const list = [mine, theirs];
    expect(mergeOwnPlans(list, "me", DAY)).toBe(list); // local mode: as loaded
    loadPlanState("me", [row("a", { planToday: true, planDay: DAY }), row("b", { planToday: true, planDay: DAY })]);
    const out = mergeOwnPlans(list, "me", DAY);
    expect(out[0]).toMatchObject({ planToday: true });
    expect(out[1]).toBe(theirs); // a teammate's row stays theirs
    loadPlanState("me", [row("b", { planToday: true, planDay: DAY })]);
    expect(mergeOwnPlans(list, "me", DAY)).toBe(list);
    // an unsaved write counts too
    writePlan("a", { mySectionId: "s1" });
    expect(mergeOwnPlans(list, "me", DAY)[0]).toMatchObject({ mySectionId: "s1" });
  });
});
