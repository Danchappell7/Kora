/* lib/planOverlay once 0043 is live: the same API, backed by the person's own
   task_user_state rows (data/planState) instead of this device's storage. */
import { describe, it, expect, beforeEach } from "vitest";
import {
  readPlanOverlay, writePlanOverlay, readSectionOverlay, writeSectionOverlay, readScoreOverlay, writeScoreOverlay,
  prunePlanOverlay, withOverlay, __resetPlanAdoptionForTests,
} from "./planOverlay";
import { loadPlanState, pendingPlans, planEntry, __resetPlanStateForTests } from "../data/planState";
import type { Task } from "../data/types";

const DAY = "2026-10-05";
const task = (o: Partial<Task> & { id: string }): Task => ({
  title: o.id, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "owner",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 10, ...o,
});

beforeEach(() => { localStorage.clear(); __resetPlanStateForTests(); __resetPlanAdoptionForTests(); });

describe("plan overlay on task_user_state", () => {
  it("writes go to the person's own plan rows, not this device", () => {
    loadPlanState("me", []);
    writePlanOverlay("me", DAY, "t1", { planToday: true });
    writePlanOverlay("me", DAY, "t1", { scheduled: 540 });
    writeSectionOverlay("me", "t2", "sec-b");
    writeScoreOverlay("me", "t2", { aiScore: 80, aiReason: "Unblocks two tasks" });
    expect(localStorage.getItem("kanbo-plan-overlay:me")).toBeNull();
    expect(localStorage.getItem("kanbo-section-overlay:me")).toBeNull();
    expect(pendingPlans().map((p) => [p.taskId, p.patch])).toEqual([
      ["t1", { planToday: true, planDay: DAY, scheduled: 540 }],
      ["t2", { mySectionId: "sec-b", aiScore: 80, aiReason: "Unblocks two tasks" }],
    ]);
    expect(readPlanOverlay("me", DAY)).toEqual({ t1: { planToday: true, scheduled: 540 } });
    expect(readPlanOverlay("me", "2026-10-06")).toEqual({}); // a plan is for its day
    expect(readSectionOverlay("me")).toEqual({ t2: "sec-b" });
    expect(readScoreOverlay("me")).toEqual({ t2: { aiScore: 80, aiReason: "Unblocks two tasks" } });
    writeSectionOverlay("me", "t2", null); // un-file
    expect(readSectionOverlay("me")).toEqual({});
    expect(planEntry("t2")).toMatchObject({ mySectionId: null });
  });

  it("someone else's (another account's) plans are never read or written through", () => {
    loadPlanState("me", [{ taskId: "t1", userId: "me", planToday: true, planDay: DAY }]);
    expect(readPlanOverlay("bob", DAY)).toEqual({});           // bob's device copy (empty), not my rows
    writePlanOverlay("bob", DAY, "t1", { planToday: false });  // bob isn't signed in: his device copy
    expect(planEntry("t1")).toMatchObject({ planToday: true });
    expect(JSON.parse(localStorage.getItem("kanbo-plan-overlay:bob")!)).toEqual({ [DAY]: { t1: { planToday: false } } });
  });

  it("withOverlay: your plan on teammates' tasks, the row on your own, today's slot only", () => {
    loadPlanState("me", [
      { taskId: "b", userId: "me", planToday: true, scheduled: 600, planDay: DAY, mySectionId: "sec-1", aiScore: 90, aiReason: "why" },
      { taskId: "c", userId: "me", planToday: true, scheduled: 480, planDay: "2026-10-04" },
      { taskId: "a", userId: "me", planToday: false, planDay: DAY }, // your own task: the row decides
    ]);
    const mine = task({ id: "a", assigneeId: "me", planToday: true, scheduled: 540 });
    const theirs = task({ id: "b", planToday: true, scheduled: 700, mySectionId: "their-sec" });
    const stale = task({ id: "c", planToday: true, scheduled: 900 });
    const none = task({ id: "d", planToday: true, scheduled: 300, mySectionId: "x" });
    const [a, b, c, d] = withOverlay([mine, theirs, stale, none], "me", DAY);
    expect(a).toBe(mine);
    expect(b).toMatchObject({ planToday: true, scheduled: 600, mySectionId: "sec-1", aiScore: 90, aiReason: "why" });
    expect(c).toMatchObject({ planToday: false, scheduled: null });   // yesterday's plan isn't today's
    expect(d).toMatchObject({ planToday: false, scheduled: null, mySectionId: undefined, aiScore: 10 }); // no plan: none (the row's score stays)
  });

  it("keeps identity when nothing changes, and picks up a write at once", () => {
    loadPlanState("me", []);
    const list = [task({ id: "a", assigneeId: "me" }), task({ id: "b" })];
    expect(withOverlay(list, "me", DAY)).toBe(list);
    writePlanOverlay("me", DAY, "b", { planToday: true });
    const seen = withOverlay(list, "me", DAY);
    expect(seen).not.toBe(list);
    expect(seen[0]).toBe(list[0]);
    expect(seen[1].planToday).toBe(true);
  });

  it("moves plans kept on this device into the rows once, where the server has none yet", () => {
    // before 0043 these lived on the device
    localStorage.setItem("kanbo-plan-overlay:me", JSON.stringify({ [DAY]: { b: { planToday: true, scheduled: 600 }, c: { planToday: true }, gone: { planToday: true }, a: { planToday: true } }, "2026-10-01": { b: { planToday: true } } }));
    localStorage.setItem("kanbo-section-overlay:me", JSON.stringify({ b: "dev-sec", c: "dev-sec-c" }));
    localStorage.setItem("kanbo-score-overlay:me", JSON.stringify({ b: { aiScore: 70 }, c: { aiScore: 20, aiReason: "device" } }));
    // another device already planned c today, with a section and a score
    loadPlanState("me", [{ taskId: "c", userId: "me", planToday: false, planDay: DAY, mySectionId: "srv-sec", aiScore: 55 }]);
    const list = [task({ id: "a", assigneeId: "me" }), task({ id: "b" }), task({ id: "c" })];
    expect(withOverlay([], "me", DAY)).toEqual([]); // nothing loaded yet: wait for the tasks
    expect(localStorage.getItem("kanbo-plan-overlay:me")).not.toBeNull();
    const seen = withOverlay(list, "me", DAY);
    expect(seen[1]).toMatchObject({ planToday: true, scheduled: 600, mySectionId: "dev-sec", aiScore: 70 });
    expect(seen[2]).toMatchObject({ planToday: false, mySectionId: "srv-sec", aiScore: 55 }); // the server's stays
    expect(pendingPlans().map((p) => p.taskId).sort()).toEqual(["b"]);     // not a (theirs now), not gone (can't see it)
    for (const k of ["kanbo-plan-overlay:me", "kanbo-section-overlay:me", "kanbo-score-overlay:me"]) expect(localStorage.getItem(k)).toBeNull();
    // once per session
    localStorage.setItem("kanbo-section-overlay:me", JSON.stringify({ b: "later" }));
    withOverlay(list, "me", DAY);
    expect(planEntry("b")?.mySectionId).toBe("dev-sec");
  });

  it("before 0043 (or in demo mode) everything stays on the device, exactly as before", () => {
    loadPlanState("me", "missing");
    writePlanOverlay("me", DAY, "b", { planToday: true });
    writeSectionOverlay("me", "b", "sec");
    writeScoreOverlay("me", "b", { aiScore: 5 });
    expect(pendingPlans()).toEqual([]);
    expect(JSON.parse(localStorage.getItem("kanbo-plan-overlay:me")!)).toEqual({ [DAY]: { b: { planToday: true } } });
    expect(withOverlay([task({ id: "b" })], "me", DAY)[0]).toMatchObject({ planToday: true, mySectionId: "sec", aiScore: 5 });
    prunePlanOverlay("me", 3, "2026-10-20");
    expect(localStorage.getItem("kanbo-plan-overlay:me")).toBeNull();
  });
});
