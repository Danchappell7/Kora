import { describe, it, expect } from "vitest";
import {
  addDaysISO, daysBetweenISO, mondayOf, weekOffsetForMonth, monthOffsetForWeek, switchCalendarPeriod,
  hideNestedSubtasks, assigneeColumnKey, UNASSIGNED_COL, FORMER_COL,
  between, planReorder, leadInDays, effectiveStartISO, barSpan, clipSpan,
  timelineMovePatch, timelineStartPatch, wipStorageKey, wipKeyFor, loadWipLimits, LEGACY_WIP_KEY, readWipLimits, parseWipLimit, chunk,
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
    // October's first week is this one (Thu 1 Oct)
    expect(weekOffsetForMonth(wed, 1)).toBe(0);
    // 1 Nov 2026 is a Sunday, so November's first week is Mon 2 Nov, five weeks on
    expect(weekOffsetForMonth(wed, 2)).toBe(5);
    // this week belongs to today's month, even though its Thursday is 1 Oct
    expect(monthOffsetForWeek(wed, 0)).toBe(0);
    expect(monthOffsetForWeek(wed, -1)).toBe(0);
    expect(monthOffsetForWeek(wed, 1)).toBe(1);
  });

  it("month → week → month lands back on the same month (today = Wed 30 Sep 2026)", () => {
    const wed = new Date(2026, 8, 30);
    for (let m = -1; m <= 5; m++) {
      const inWeek = switchCalendarPeriod(wed, "week", { month: m, week: 0 }, null);
      const back = switchCalendarPeriod(wed, "month", inWeek, inWeek);
      expect(back.month).toBe(m);
      // and the week shown is the month's own first week (or this week for the current month)
      expect(inWeek.week).toBe(weekOffsetForMonth(wed, m));
    }
    // the plain helpers are inverses too, except where a month's first week is this week
    for (const m of [-1, 0, 2, 3, 4, 5]) expect(monthOffsetForWeek(wed, weekOffsetForMonth(wed, m))).toBe(m);
  });

  it("week → month → week lands back on the same week, and moving on follows the new period", () => {
    const wed = new Date(2026, 8, 30);
    const inMonth = switchCalendarPeriod(wed, "month", { month: 0, week: 3 }, null);
    expect(inMonth.month).toBe(1); // Thu 22 Oct
    expect(switchCalendarPeriod(wed, "week", inMonth, inMonth).week).toBe(3);
    // after paging to December, week view opens on December's first week (Mon 30 Nov)
    const moved = switchCalendarPeriod(wed, "week", { month: 3, week: 3 }, inMonth);
    expect(moved.week).toBe(9);
    // and after paging weeks, month view follows the week
    expect(switchCalendarPeriod(wed, "month", { month: 3, week: 14 }, moved).month).toBe(4); // Thu 7 Jan 2027
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
  // apply a plan and read the column back the way the views sort it (position, then id)
  const applyPlan = (list: { id: string; position?: number | null }[], plan: { id: string; position: number }[]) => {
    const pos = new Map(plan.map((p) => [p.id, p.position]));
    return list.map((t) => ({ id: t.id, p: pos.get(t.id) ?? t.position ?? 0 }))
      .sort((x, y) => (x.p - y.p) || x.id.localeCompare(y.id)).map((x) => x.id);
  };
  it("moves a card between neighbours that share a position", () => {
    const tied = [{ id: "a", position: 5 }, { id: "b", position: 5 }, { id: "c", position: 5 }];
    const plan = planReorder(tied, "c", 1);
    expect(applyPlan(tied, plan)).toEqual(["a", "c", "b"]);
    expect(plan).toHaveLength(2); // one neighbour shifted, plus the moved card
  });
  it("treats a missing position as 0, as every view sorts it", () => {
    const plan = planReorder([{ id: "a" }, { id: "b" }], "b", 0);
    expect(plan).toEqual([{ id: "b", position: -1 }]);
    expect(applyPlan([{ id: "a" }, { id: "b" }], plan)).toEqual(["b", "a"]);
  });
  it("only rewrites the shorter tied run, not the whole column (bulk imports share a position)", () => {
    const col = Array.from({ length: 100 }, (_, k) => ({ id: `t${String(k).padStart(3, "0")}`, position: 1700000000000 }));
    const ids = col.map((t) => t.id);
    for (const [from, to] of [[99, 3], [0, 96], [50, 49], [10, 0], [10, 99]]) {
      const moving = ids[from];
      const plan = planReorder(col, moving, to);
      const expected = ids.filter((id) => id !== moving);
      expected.splice(to, 0, moving);
      expect(applyPlan(col, plan)).toEqual(expected);
      const others = ids.length - 1;
      expect(plan.length).toBeLessThanOrEqual(Math.min(to, others - to) + 1);
    }
    // moving within a tied run next to distinct neighbours stays small
    const mixed = [{ id: "a", position: 1 }, { id: "b", position: 5 }, { id: "c", position: 5 }, { id: "d", position: 5 }, { id: "e", position: 9 }];
    const plan = planReorder(mixed, "e", 1);
    expect(applyPlan(mixed, plan)).toEqual(["a", "e", "b", "c", "d"]);
    expect(plan).toEqual([{ id: "e", position: 3 }]);
    const plan2 = planReorder(mixed, "a", 2);
    expect(applyPlan(mixed, plan2)).toEqual(["b", "c", "a", "d", "e"]);
    expect(plan2.length).toBeLessThanOrEqual(2);
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
    expect(wipKeyFor("project:p1")).toBe("kanbo-board-wip:project:p1");
    expect(wipKeyFor(undefined)).toBe(LEGACY_WIP_KEY);
  });
  it("carry over limits saved before they were per board", () => {
    const store: Record<string, string> = { [LEGACY_WIP_KEY]: '{"status:progress":3}' };
    const get = (k: string) => store[k] ?? null;
    expect(loadWipLimits(get, undefined)).toEqual({ "status:progress": 3 });
    expect(loadWipLimits(get, "project:p1")).toEqual({ "status:progress": 3 });
    // once a board saves its own (even "no limits"), that wins
    store[wipStorageKey("project:p1")] = "{}";
    expect(loadWipLimits(get, "project:p1")).toEqual({});
    expect(loadWipLimits(get, "project:p2")).toEqual({ "status:progress": 3 });
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
