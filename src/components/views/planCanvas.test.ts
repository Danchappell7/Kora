import { describe, it, expect, vi, afterEach } from "vitest";
import {
  layoutLanes, mergeIntervals, totalMinutes, durOf, energyMetaOf, energyKindOf,
  carryOver, recordSeen, markSeen, touchSeen, readSeen, writeSeen, planSeenKey, isMine, carryLabel, localDayKey, todaysEvents,
} from "./planCanvas";
import type { SeenMap } from "./planCanvas";
import { ENERGY } from "../../data/data";
import type { Task, ExternalEvent } from "../../data/types";

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
  const TODAY = "2026-09-30", YEST = "2026-09-29";
  const tasks = [
    task({ id: "mine", planToday: true, scheduled: 540 }),
    task({ id: "done", planToday: true, scheduled: 600, status: "done" }),
    task({ id: "theirs", planToday: true, scheduled: 660, assigneeId: "maya" }),
    task({ id: "intake", planToday: true, scheduled: null }),
    task({ id: "archived", planToday: true, scheduled: 700, archivedAt: "2026-09-01" }),
  ];
  const seenYesterday: SeenMap = { mine: { day: YEST, at: 540 }, done: { day: YEST, at: 600 }, theirs: { day: YEST, at: 660 }, archived: { day: YEST, at: 700 } };

  it("offers only my unfinished blocks this device saw on an earlier day, at the same time", () => {
    expect(carryOver(tasks, seenYesterday, TODAY, "m-self")).toEqual({ ids: ["mine"], from: YEST });
  });
  it("never offers a block it hasn't seen before — planned today, or on another device", () => {
    expect(carryOver(tasks, {}, TODAY, "m-self").ids).toEqual([]);
  });
  it("never offers a block that has been moved since", () => {
    expect(carryOver(tasks, { mine: { day: YEST, at: 600 } }, TODAY, "m-self").ids).toEqual([]);
  });
  it("never offers a block already seen today", () => {
    expect(carryOver(tasks, { mine: { day: TODAY, at: 540 } }, TODAY, "m-self").ids).toEqual([]);
  });
  it("names no single day when the blocks come from different days", () => {
    const two = [task({ id: "a", planToday: true, scheduled: 540 }), task({ id: "b", planToday: true, scheduled: 600 })];
    expect(carryOver(two, { a: { day: YEST, at: 540 }, b: { day: "2026-09-27", at: 600 } }, TODAY, "m-self")).toEqual({ ids: ["a", "b"], from: null });
  });
  it("counts the local placeholder and unassigned personal tasks as mine, never a teammate's", () => {
    expect(isMine(task({ assigneeId: "u-1" }), "u-1")).toBe(true);
    expect(isMine(task({ assigneeId: "m-self" }), "u-1")).toBe(true);
    expect(isMine(task({ assigneeId: "", workspaceId: null }), "u-1")).toBe(true);
    expect(isMine(task({ assigneeId: "", workspaceId: "ws-team" }), "u-1")).toBe(false);
    expect(isMine(task({ assigneeId: "maya" }), "u-1")).toBe(false);
  });

  it("first open: stamps everything with today, so nothing is offered", () => {
    const next = recordSeen({}, tasks, TODAY, "m-self")!;
    expect(next).toEqual({ mine: { day: TODAY, at: 540 } });
    expect(carryOver(tasks, next, TODAY, "m-self").ids).toEqual([]);
    // …and tomorrow the unfinished block is offered
    expect(carryOver(tasks, next, "2026-10-01", "m-self")).toEqual({ ids: ["mine"], from: TODAY });
  });
  it("leaves a waiting block's earlier day alone, and forgets blocks that left the canvas", () => {
    const next = recordSeen(seenYesterday, tasks, TODAY, "m-self")!;
    expect(next.mine).toEqual({ day: YEST, at: 540 }); // still waiting on the prompt
    expect(next.done).toBeUndefined();
    expect(next.archived).toBeUndefined();
    expect(next.theirs).toBeUndefined();
  });
  it("re-stamps a block that was moved", () => {
    const moved = [task({ id: "mine", planToday: true, scheduled: 600 })];
    expect(recordSeen(seenYesterday, moved, TODAY, "m-self")!.mine).toEqual({ day: TODAY, at: 600 });
  });
  it("leaves other workspaces' blocks alone (they aren't in this list)", () => {
    const seen: SeenMap = { elsewhere: { day: YEST, at: 540 } };
    expect(recordSeen(seen, [task({ id: "here", planToday: true, scheduled: 600 })], TODAY, "m-self")!.elsewhere).toEqual({ day: YEST, at: 540 });
  });
  it("returns null when nothing changed", () => {
    expect(recordSeen({ mine: { day: TODAY, at: 540 } }, tasks, TODAY, "m-self")).toBeNull();
  });
  it("forgets blocks not seen for two months", () => {
    const next = recordSeen({ old: { day: "2026-07-01", at: 540 }, recent: { day: "2026-09-01", at: 540 } }, [], TODAY, "m-self")!;
    expect(next).toEqual({ recent: { day: "2026-09-01", at: 540 } });
  });
  it("an answered prompt stays answered, even if Undo puts a block back", () => {
    const answered = markSeen(seenYesterday, [{ id: "mine", at: 540 }], TODAY);
    expect(carryOver(tasks, answered, TODAY, "m-self").ids).toEqual([]);
  });
  it("touchSeen re-stamps a moved block and forgets one taken off the day", () => {
    expect(touchSeen(seenYesterday, "mine", 600, TODAY)!.mine).toEqual({ day: TODAY, at: 600 });
    expect(touchSeen(seenYesterday, "mine", null, TODAY)!.mine).toBeUndefined();
    expect(touchSeen({}, "nope", null, TODAY)).toBeNull();
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

describe("the per-device record", () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); localStorage.clear(); });
  it("is kept per person", () => {
    expect(planSeenKey("u-1")).not.toBe(planSeenKey("u-2"));
    writeSeen(planSeenKey("u-1"), { a: { day: "2026-09-29", at: 540 } });
    expect(readSeen(planSeenKey("u-2"))).toEqual({});
    expect(readSeen(planSeenKey("u-1"))).toEqual({ a: { day: "2026-09-29", at: 540 } });
  });
  it("ignores corrupt entries", () => {
    localStorage.setItem(planSeenKey("u-1"), JSON.stringify({ a: { day: 5 }, b: { day: "2026-09-29", at: 600 } }));
    expect(readSeen(planSeenKey("u-1"))).toEqual({ b: { day: "2026-09-29", at: 600 } });
    localStorage.setItem(planSeenKey("u-1"), "{not json");
    expect(readSeen(planSeenKey("u-1"))).toEqual({ b: { day: "2026-09-29", at: 600 } }); // last good copy
  });
  it("carries on in memory when storage is blocked", () => {
    spies.push(vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); }));
    spies.push(vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); }));
    writeSeen(planSeenKey("u-3"), { a: { day: "2026-09-30", at: 540 } });
    expect(readSeen(planSeenKey("u-3"))).toEqual({ a: { day: "2026-09-30", at: 540 } });
  });
});

describe("todaysEvents: every connected calendar's meetings, in their colours", () => {
  const now = new Date(2026, 9, 5, 8, 0);
  const at = (h: number, m = 0) => new Date(2026, 9, 5, h, m).toISOString();
  const ext = (o: Partial<ExternalEvent>): ExternalEvent => ({ id: "x", title: "M", start: at(9), end: at(10), allDay: false, provider: "google", ...o });
  it("keeps each meeting's calendar name and colour, from every account; all-day and other days stay off", () => {
    const evs = todaysEvents([
      ext({ id: "a", title: "Standup", start: at(9), end: at(9, 30), connectionId: "c1", calendarId: "w", calendarName: "Work", color: "#3f7fe0" }),
      ext({ id: "b", title: "Dentist", start: at(14), end: at(14, 30), provider: "microsoft", connectionId: "c2", calendarId: "primary", calendarName: "Calendar", color: "#c98a1b" }),
      ext({ id: "c", title: "Half term", start: "2026-10-05", end: "2026-10-06", allDay: true, color: "#a35bc4" }),
      ext({ id: "d", title: "Tomorrow", start: new Date(2026, 9, 6, 9).toISOString(), end: new Date(2026, 9, 6, 10).toISOString() }),
      ext({ id: "e", title: "Old server", start: at(11), end: at(11, 30) }),
    ], now);
    expect(evs.map((e) => [e.title, e.calendarName, e.color])).toEqual([
      ["Standup", "Work", "#3f7fe0"], ["Old server", undefined, undefined], ["Dentist", "Calendar", "#c98a1b"],
    ]);
    expect(evs.every((e) => e.kind === "meeting")).toBe(true);
    expect(evs[1]).not.toHaveProperty("color");
  });
});
