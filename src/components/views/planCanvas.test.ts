import { describe, it, expect } from "vitest";
import {
  layoutLanes, mergeIntervals, totalMinutes, durOf, energyMetaOf, energyKindOf,
  staleBlockIds, nextCarry, carryLabel, localDayKey,
} from "./planCanvas";
import { ENERGY } from "../../data/data";
import type { Task } from "../../data/types";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "m-self", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

describe("energy fallbacks (quick-added / imported tasks have no energy)", () => {
  it("never returns undefined metadata", () => {
    const t = task({ energy: undefined, tags: [] });
    expect(energyMetaOf(t)).toBe(ENERGY.admin);
    expect(energyKindOf(t)).toBe("admin");
  });
  it("derives energy from tags when missing", () => {
    expect(energyKindOf(task({ energy: undefined, tags: ["design"] }))).toBe("create");
    expect(energyMetaOf(task({ energy: undefined, tags: ["eng"] }))).toBe(ENERGY.deep);
  });
  it("survives an unknown energy value from the database", () => {
    const t = task({ energy: "bogus" as Task["energy"] });
    expect(energyMetaOf(t)).toBe(ENERGY.admin);
    expect(energyKindOf(t)).toBe("admin");
  });
  it("durOf never returns 0 or NaN", () => {
    expect(durOf({ dur: 45, focusMin: 30 })).toBe(45);
    expect(durOf({ dur: undefined, focusMin: 60 })).toBe(60);
    expect(durOf({ dur: 0, focusMin: 0 })).toBe(30);
    expect(durOf({ dur: undefined, focusMin: undefined as unknown as number })).toBe(30);
  });
});

describe("layoutLanes", () => {
  it("gives non-overlapping blocks the full width", () => {
    const l = layoutLanes([{ id: "a", start: 540, end: 600 }, { id: "b", start: 600, end: 660 }]);
    expect(l.a).toEqual({ lane: 0, lanes: 1 });
    expect(l.b).toEqual({ lane: 0, lanes: 1 });
  });
  it("puts overlapping blocks side by side", () => {
    const l = layoutLanes([{ id: "a", start: 540, end: 600 }, { id: "b", start: 570, end: 630 }]);
    expect(l.a).toEqual({ lane: 0, lanes: 2 });
    expect(l.b).toEqual({ lane: 1, lanes: 2 });
  });
  it("reuses a freed lane and shares the group's lane count", () => {
    // a overlaps b; c starts after a ends but while b is still running
    const l = layoutLanes([
      { id: "a", start: 540, end: 600 },
      { id: "b", start: 560, end: 680 },
      { id: "c", start: 600, end: 640 },
      { id: "d", start: 700, end: 730 },
    ]);
    expect(l.a.lanes).toBe(2);
    expect(l.b.lanes).toBe(2);
    expect(l.c).toEqual({ lane: 0, lanes: 2 });
    expect(l.d).toEqual({ lane: 0, lanes: 1 });
  });
  it("handles three at once", () => {
    const l = layoutLanes([{ id: "a", start: 0, end: 60 }, { id: "b", start: 10, end: 60 }, { id: "c", start: 20, end: 60 }]);
    expect(new Set([l.a.lane, l.b.lane, l.c.lane]).size).toBe(3);
    expect(l.a.lanes).toBe(3);
  });
});

describe("busy-time maths", () => {
  it("merges overlaps so shared time counts once", () => {
    const m = mergeIntervals([{ start: 540, end: 600 }, { start: 570, end: 630 }, { start: 700, end: 720 }], 420, 1320);
    expect(m).toEqual([{ start: 540, end: 630 }, { start: 700, end: 720 }]);
    expect(totalMinutes(m)).toBe(110);
  });
  it("clips to the window", () => {
    expect(totalMinutes(mergeIntervals([{ start: 400, end: 450 }, { start: 1300, end: 1400 }], 420, 1320))).toBe(30 + 20);
  });
});

describe("new-day carry-over", () => {
  const tasks = [
    task({ id: "mine", planToday: true, scheduled: 540 }),
    task({ id: "done", planToday: true, scheduled: 600, status: "done" }),
    task({ id: "theirs", planToday: true, scheduled: 660, assigneeId: "maya" }),
    task({ id: "intake", planToday: true, scheduled: null }),
    task({ id: "archived", planToday: true, scheduled: 700, archivedAt: "2026-09-01" }),
  ];
  it("only offers my unfinished, still-placed blocks", () => {
    expect(staleBlockIds(tasks, "m-self")).toEqual(["mine"]);
    expect(staleBlockIds(tasks)).toEqual(["mine", "theirs"]);
  });
  it("snapshots on the first open of a new day", () => {
    const r = nextCarry("2026-09-30", "2026-09-29", null, ["mine"]);
    expect(r.markDay).toBe(true);
    expect(r.carry).toEqual({ day: "2026-09-30", from: "2026-09-29", ids: ["mine"] });
  });
  it("offers nothing when there's nothing left over", () => {
    expect(nextCarry("2026-09-30", "2026-09-29", null, [])).toEqual({ carry: null, markDay: true });
  });
  it("keeps today's pending prompt, and never re-snapshots blocks planned today", () => {
    const pending = { day: "2026-09-30", from: "2026-09-29", ids: ["mine"] };
    expect(nextCarry("2026-09-30", "2026-09-30", pending, ["mine", "planned-this-morning"])).toEqual({ carry: pending, markDay: false });
    expect(nextCarry("2026-09-30", "2026-09-30", null, ["planned-this-morning"])).toEqual({ carry: null, markDay: false });
  });
  it("drops a stale pending prompt from an earlier day", () => {
    const old = { day: "2026-09-28", from: "2026-09-27", ids: ["x"] };
    expect(nextCarry("2026-09-30", "2026-09-30", old, []).carry).toBeNull();
  });
  it("labels the prompt by when the plan was made", () => {
    expect(carryLabel("2026-09-29", "2026-09-30")).toBe("Yesterday's plan");
    expect(carryLabel(null, "2026-09-30")).toBe("An earlier plan");
    expect(carryLabel("2026-09-28", "2026-09-30")).toMatch(/^Your plan from Monday$/);
    // month boundary
    expect(carryLabel("2026-09-30", "2026-10-01")).toBe("Yesterday's plan");
  });
  it("formats day keys locally", () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
