import { describe, it, expect, vi, afterEach } from "vitest";
import {
  readPlanOverlay, writePlanOverlay, prunePlanOverlay, readSectionOverlay, writeSectionOverlay,
  readScoreOverlay, writeScoreOverlay, splitPersonal, withOverlay,
} from "./planOverlay";
import type { Task } from "../data/types";

const task = (o: Partial<Task> & { id: string }): Task => ({
  title: o.id, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "owner",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 10, ...o,
});

const spies: { mockRestore: () => void }[] = [];
afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); localStorage.clear(); });

describe("plan overlay", () => {
  it("keeps each person's plan per day and merges changes", () => {
    writePlanOverlay("me", "2026-09-30", "t1", { planToday: true });
    writePlanOverlay("me", "2026-09-30", "t1", { scheduled: 540 });
    writePlanOverlay("me", "2026-10-01", "t2", { planToday: false, scheduled: null });
    expect(readPlanOverlay("me", "2026-09-30")).toEqual({ t1: { planToday: true, scheduled: 540 } });
    expect(readPlanOverlay("me", "2026-10-01")).toEqual({ t2: { planToday: false, scheduled: null } });
    expect(readPlanOverlay("someone-else", "2026-09-30")).toEqual({});
    expect(localStorage.getItem("kanbo-plan-overlay:me")).not.toBeNull();
  });

  it("prunes days more than keepDays before today, and unreadable ones", () => {
    for (const d of ["2026-09-26", "2026-09-27", "2026-09-30", "2026-10-02"]) writePlanOverlay("me", d, "t1", { planToday: true });
    const raw = JSON.parse(localStorage.getItem("kanbo-plan-overlay:me")!);
    localStorage.setItem("kanbo-plan-overlay:me", JSON.stringify({ ...raw, junk: { t1: { planToday: true } } }));
    prunePlanOverlay("me", 3, "2026-09-30");
    expect(Object.keys(JSON.parse(localStorage.getItem("kanbo-plan-overlay:me")!)).sort()).toEqual(["2026-09-27", "2026-09-30", "2026-10-02"]);
  });

  it("ignores malformed entries", () => {
    localStorage.setItem("kanbo-plan-overlay:me", JSON.stringify({ "2026-09-30": { t1: { scheduled: "9am", planToday: "yes" }, t2: 7, t3: { planToday: true } } }));
    expect(readPlanOverlay("me", "2026-09-30")).toEqual({ t3: { planToday: true } });
    localStorage.setItem("kanbo-plan-overlay:me", "not json");
    expect(readPlanOverlay("me", "2026-09-30")).toEqual({});
  });

  it("files and un-files sections, and keeps scores", () => {
    writeSectionOverlay("me", "t1", "sec-a");
    writeSectionOverlay("me", "t2", "sec-b");
    writeSectionOverlay("me", "t2", null);
    expect(readSectionOverlay("me")).toEqual({ t1: "sec-a" });
    writeScoreOverlay("me", "t1", { aiScore: 80 });
    writeScoreOverlay("me", "t1", { aiReason: "Unblocks two tasks" });
    expect(readScoreOverlay("me")).toEqual({ t1: { aiScore: 80, aiReason: "Unblocks two tasks" } });
  });

  it("gives an empty result, and never throws, when storage throws", () => {
    spies.push(vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); }));
    spies.push(vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); }));
    expect(() => writePlanOverlay("me", "2026-09-30", "t1", { planToday: true })).not.toThrow();
    expect(() => writeSectionOverlay("me", "t1", "s")).not.toThrow();
    expect(() => writeScoreOverlay("me", "t1", { aiScore: 1 })).not.toThrow();
    expect(() => prunePlanOverlay("me")).not.toThrow();
    expect(readPlanOverlay("me", "2026-09-30")).toEqual({});
    expect(readSectionOverlay("me")).toEqual({});
    expect(readScoreOverlay("me")).toEqual({});
  });
});

describe("splitPersonal", () => {
  it("splits the plan fields from the task's own", () => {
    expect(splitPersonal({ planToday: true, scheduled: 600, status: "progress", aiScore: 5 })).toEqual({
      personal: { planToday: true, scheduled: 600, aiScore: 5 },
      shared: { status: "progress" },
    });
    expect(splitPersonal({ title: "x" })).toEqual({ personal: {}, shared: { title: "x" } });
  });
});

describe("withOverlay", () => {
  it("lays your plan over tasks assigned to someone else, never over your own", () => {
    const mine = task({ id: "a", assigneeId: "me", planToday: false });
    const theirs = task({ id: "b", planToday: true, scheduled: 480 });
    writePlanOverlay("me", "2026-09-30", "a", { planToday: true });
    writePlanOverlay("me", "2026-09-30", "b", { planToday: false, scheduled: null });
    writeSectionOverlay("me", "b", "sec-1");
    writeScoreOverlay("me", "b", { aiScore: 90 });
    const [a, b] = withOverlay([mine, theirs], "me", "2026-09-30");
    expect(a).toBe(mine);
    expect(b).toMatchObject({ planToday: false, scheduled: null, mySectionId: "sec-1", aiScore: 90 });
    expect(theirs.planToday).toBe(true);
  });

  it("never shows the assignee's plan as yours: without your own, a teammate's task is unplanned", () => {
    const theirs = task({ id: "b", planToday: true, scheduled: 480, mySectionId: "their-sec", aiScore: 40 });
    const [b] = withOverlay([theirs], "me", "2026-09-30");
    expect(b).toMatchObject({ planToday: false, scheduled: null, mySectionId: undefined, aiScore: 40 });
    // only today's plan counts: yesterday's overlay doesn't carry over
    writePlanOverlay("me", "2026-09-29", "b", { planToday: true, scheduled: 600 });
    expect(withOverlay([theirs], "me", "2026-09-30")[0]).toMatchObject({ planToday: false, scheduled: null });
  });

  it("returns the same array (and tasks) when nothing changes", () => {
    const list = [task({ id: "a" }), task({ id: "b", assigneeId: "me", planToday: true })];
    expect(withOverlay(list, "me", "2026-09-30")).toBe(list);
    writePlanOverlay("me", "2026-09-30", "a", { planToday: true });
    const seen = withOverlay(list, "me", "2026-09-30");
    expect(seen).not.toBe(list);
    expect(seen[1]).toBe(list[1]);
  });
});
