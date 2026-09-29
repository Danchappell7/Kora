import { describe, it, expect } from "vitest";
import {
  addDaysISO, daysBetweenISO, mondayOf, weekOffsetForMonth, monthOffsetForWeek,
  hideNestedSubtasks, assigneeColumnKey, UNASSIGNED_COL, FORMER_COL,
  between, planReorder, leadInDays, effectiveStartISO, barSpan, clipSpan,
  timelineMovePatch, timelineStartPatch, wipStorageKey, readWipLimits, parseWipLimit, chunk,
} from "./otherViewsLogic";

describe("calendar maths", () => {
  it("adds and diffs local days across month and DST boundaries", () => {
    expect(addDaysISO("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDaysISO("2026-03-01", -1)).toBe("2026-02-28");
    // UK clocks change on 29 Mar and 25 Oct 2026 — still whole days
    expect(addDaysISO("2026-03-28", 2)).toBe("2026-03-30");
    expect(daysBetweenISO("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetweenISO("2026-10-26", "2026-10-24")).toBe(-2);
  });

  it("finds Monday and converts between month and week offsets", () => {
    const wed = new Date(2026, 8, 30); // Wed 30 Sep 2026
    expect(mondayOf(wed).getDate()).toBe(28);
    expect(weekOffsetForMonth(wed, 0)).toBe(0);
    // 1 Oct 2026 is a Thursday in the same week → still this week
    expect(weekOffsetForMonth(wed, 1)).toBe(0);
    // 1 Nov 2026 is a Sunday → the week of Mon 26 Oct, four weeks on
    expect(weekOffsetForMonth(wed, 2)).toBe(4);
    expect(monthOffsetForWeek(wed, 0)).toBe(1); // this week's Thursday is 1 Oct
    expect(monthOffsetForWeek(wed, -1)).toBe(0);
  });
});

describe("hideNestedSubtasks", () => {
  const parent = { id: "p", parentId: undefined };
  const child = { id: "c", parentId: "p" };
  const orphan = { id: "o", parentId: "someone-elses-parent" };
  it("hides a sub-task only when its parent is also present", () => {
    expect(hideNestedSubtasks([parent, child, orphan]).map((t) => t.id)).toEqual(["p", "o"]);
    // e.g. My tasks: Maya's assigned sub-task shows even though the parent isn't hers
    expect(hideNestedSubtasks([child]).map((t) => t.id)).toEqual(["c"]);
  });
  it("can check against a different 'shown' set", () => {
    expect(hideNestedSubtasks([child], new Set(["p"]))).toEqual([]);
  });
});

describe("assigneeColumnKey", () => {
  const members = new Set(["u1", "u2"]);
  it("routes to the member, Unassigned, or Former members", () => {
    expect(assigneeColumnKey("u1", members)).toBe("u1");
    expect(assigneeColumnKey("", members)).toBe(UNASSIGNED_COL);
    expect(assigneeColumnKey(undefined, members)).toBe(UNASSIGNED_COL);
    expect(assigneeColumnKey("left-the-company", members)).toBe(FORMER_COL);
  });
});

describe("planReorder", () => {
  const col = [{ id: "a", position: 10 }, { id: "b", position: 20 }, { id: "c", position: 30 }];
  it("writes one fractional position in the normal case", () => {
    expect(planReorder(col, "c", 1)).toEqual([{ id: "c", position: 15 }]);
    expect(planReorder(col, "a", 2)).toEqual([{ id: "a", position: 31 }]);
    expect(planReorder(col, "x", 0)).toEqual([{ id: "x", position: 9 }]);
  });
  it("renumbers when neighbours share a position, so the move is visible", () => {
    const tied = [{ id: "a", position: 5 }, { id: "b", position: 5 }, { id: "c", position: 5 }];
    const plan = planReorder(tied, "c", 1);
    const pos = new Map(plan.map((p) => [p.id, p.position]));
    const order = ["a", "b", "c"].map((id) => ({ id, p: pos.get(id) ?? 5 })).sort((x, y) => x.p - y.p).map((x) => x.id);
    expect(order).toEqual(["a", "c", "b"]);
  });
  it("renumbers when a neighbour has no position", () => {
    const plan = planReorder([{ id: "a" }, { id: "b" }], "b", 0);
    expect(plan.find((p) => p.id === "b")!.position).toBeLessThan(plan.find((p) => p.id === "a")!.position);
  });
  it("between() falls back to the ends of the list", () => {
    expect(between(undefined, 4)).toBe(3);
    expect(between(4, undefined)).toBe(5);
    expect(between(2, 4)).toBe(3);
  });
});

describe("timeline geometry", () => {
  it("draws an implied lead-in only when there's no valid start date", () => {
    expect(leadInDays(30)).toBe(2);
    expect(leadInDays(undefined)).toBe(1);
    expect(effectiveStartISO({ dueDate: "2026-10-09", startDate: "2026-10-05", focusMin: 30 })).toBe("2026-10-05");
    expect(effectiveStartISO({ dueDate: "2026-10-09", focusMin: 30 })).toBe("2026-10-07");
    // a start after the due date is ignored, not drawn backwards
    expect(effectiveStartISO({ dueDate: "2026-10-09", startDate: "2026-10-12", focusMin: 0 })).toBe("2026-10-08");
  });

  it("clips bars to the window and reports bars fully outside it", () => {
    const win = "2026-10-01";
    const inside = barSpan({ dueDate: "2026-10-05", startDate: "2026-10-03", focusMin: 0 }, win)!;
    expect(clipSpan(inside, 16)).toEqual({ vs: 2, ve: 4, clipL: false, clipR: false });
    const spills = barSpan({ dueDate: "2026-10-30", startDate: "2026-09-20", focusMin: 0 }, win)!;
    expect(clipSpan(spills, 16)).toEqual({ vs: 0, ve: 15, clipL: true, clipR: true });
    expect(clipSpan(barSpan({ dueDate: "2026-09-10", focusMin: 0 }, win)!, 16)).toBe("before");
    expect(clipSpan(barSpan({ dueDate: "2026-11-20", focusMin: 0 }, win)!, 16)).toBe("after");
    expect(barSpan({ focusMin: 0 }, win)).toBeNull();
  });
});

describe("timeline drag", () => {
  it("moves by the distance dragged, not to the day under the cursor", () => {
    // 30-minute task due Fri 9 Oct draws Wed–Fri; grab the Wednesday end, drop one day right
    const t = { dueDate: "2026-10-09", focusMin: 30 };
    expect(timelineMovePatch(t, "2026-10-07", "2026-10-08")).toEqual({ dueDate: "2026-10-10" });
  });
  it("shifts an explicit start date with the due date so the bar keeps its length", () => {
    const t = { dueDate: "2026-10-09", startDate: "2026-10-05" };
    expect(timelineMovePatch(t, "2026-10-06", "2026-10-02")).toEqual({ dueDate: "2026-10-05", startDate: "2026-10-01" });
  });
  it("is a no-op when dropped where it was grabbed, and schedules undated tasks on the drop day", () => {
    expect(timelineMovePatch({ dueDate: "2026-10-09" }, "2026-10-08", "2026-10-08")).toBeNull();
    expect(timelineMovePatch({}, null, "2026-10-14")).toEqual({ dueDate: "2026-10-14" });
  });
  it("rejects a start handle dropped after the due date", () => {
    const t = { dueDate: "2026-10-09" };
    expect(timelineStartPatch(t, "2026-10-10")).toEqual({ ok: false, reason: "after-due" });
    expect(timelineStartPatch(t, "2026-10-09")).toEqual({ ok: true, patch: { startDate: "2026-10-09" } });
    expect(timelineStartPatch({ ...t, startDate: "2026-10-01" }, "2026-10-01")).toEqual({ ok: false, reason: "unchanged" });
  });
});

describe("WIP limits", () => {
  it("are stored per board", () => {
    expect(wipStorageKey("project:p1")).not.toBe(wipStorageKey("project:p2"));
    expect(wipStorageKey("")).toBe("kanbo-board-wip:all");
  });
  it("parse input and ignore junk in storage", () => {
    expect(parseWipLimit("")).toBeNull();
    expect(parseWipLimit(" 3 ")).toBe(3);
    expect(parseWipLimit("0")).toBe("invalid");
    expect(parseWipLimit("2.5")).toBe("invalid");
    expect(parseWipLimit("abc")).toBe("invalid");
    expect(readWipLimits('{"status:progress":3,"status:todo":"x","status:done":-1}')).toEqual({ "status:progress": 3 });
    expect(readWipLimits("not json")).toEqual({});
    expect(readWipLimits(null)).toEqual({});
  });
});

describe("chunk", () => {
  it("splits evenly with a short tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
