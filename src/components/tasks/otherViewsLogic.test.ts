import { describe, it, expect, vi, afterEach } from "vitest";
import {
  addDaysISO, daysBetweenISO, mondayOf, weekOffsetForMonth, monthOffsetForWeek, switchCalendarPeriod,
  hideNestedSubtasks, assigneeColumnKey, UNASSIGNED_COL, FORMER_COL,
  between, planReorder, leadInDays, effectiveStartISO, barSpan, clipSpan,
  timelineMovePatch, timelineStartPatch, wipStorageKey, wipKeyFor, loadWipLimits, LEGACY_WIP_KEY, readWipLimits, parseWipLimit, chunk,
  NO_PROJECT_COL, VIRTUALISE_AFTER, swimlanes, swimlaneKeyOf, lanePatch, effectiveSwimlane, readSwimlane, swimlaneStorageKey, laneCollapseStorageKey,
  wipSettingKey, localWipToSettings, withWipLimit, withCovers, wipBreachMessage, wipState, cardProgress, cardHeightEstimate,
  planInsertMany, stackOffsets, virtualRanges, virtualSegments,
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

/* ---------------- board upgrade (u8) ---------------- */

describe("swimlanes", () => {
  const names: Record<string, string> = { "m-self": "Daniel Okai", "m-1": "Maya Lin", "m-2": "Theo Vance" };
  const projects: Record<string, string> = { "p-launch": "Q3 Product Launch", "p-brand": "Brand Refresh" };
  const ctx = { memberName: (id: string) => names[id], projectName: (id: string) => projects[id], memberOrder: ["m-2", "m-self", "m-1"] };
  const t = (id: string, o: Partial<{ assigneeId: string; priority: "urgent" | "high" | "medium" | "low"; projectId: string }> = {}) =>
    ({ id, assigneeId: "m-self", priority: "medium" as const, projectId: "p-launch", ...o });

  it("one lane for none, keeping the board's order", () => {
    expect(swimlanes([t("a"), t("b")], "none", ctx)).toEqual([{ key: "all", label: "", taskIds: ["a", "b"] }]);
  });

  it("people in the board's order, then Unassigned, then Former members — only lanes with tasks", () => {
    const lanes = swimlanes([
      t("a", { assigneeId: "m-1" }), t("b", { assigneeId: "" }), t("c", { assigneeId: "m-gone" }), t("d", { assigneeId: "m-2" }), t("e", { assigneeId: "m-1" }),
    ], "assignee", ctx);
    expect(lanes.map((l) => [l.label, l.taskIds])).toEqual([
      ["Theo Vance", ["d"]], ["Maya Lin", ["a", "e"]], ["Unassigned", ["b"]], ["Former members", ["c"]],
    ]);
    // without an order, people go by name
    expect(swimlanes([t("a", { assigneeId: "m-2" }), t("b", { assigneeId: "m-1" })], "assignee", { ...ctx, memberOrder: undefined }).map((l) => l.label)).toEqual(["Maya Lin", "Theo Vance"]);
  });

  it("priorities urgent → low; projects by name, then Other projects", () => {
    expect(swimlanes([t("a", { priority: "low" }), t("b", { priority: "urgent" }), t("c", { priority: "low" })], "priority", ctx).map((l) => [l.key, l.taskIds]))
      .toEqual([["urgent", ["b"]], ["low", ["a", "c"]]]);
    const byProject = swimlanes([t("a"), t("b", { projectId: "p-hidden" }), t("c", { projectId: "p-brand" })], "project", ctx);
    expect(byProject.map((l) => [l.label, l.taskIds])).toEqual([["Brand Refresh", ["c"]], ["Q3 Product Launch", ["a"]], ["Other projects", ["b"]]]);
    expect(byProject[2].key).toBe(NO_PROJECT_COL);
  });

  it("a lane's drop writes its field; catch-all lanes take nothing from elsewhere", () => {
    expect(lanePatch("assignee", "m-1")).toEqual({ assigneeId: "m-1" });
    expect(lanePatch("priority", "high")).toEqual({ priority: "high" });
    expect(lanePatch("project", "p-brand")).toEqual({ projectId: "p-brand" });
    for (const k of [UNASSIGNED_COL, FORMER_COL, NO_PROJECT_COL]) expect(lanePatch("assignee", k)).toBeNull();
    expect(lanePatch("priority", "nonsense")).toBeNull();
    expect(lanePatch("none", "all")).toBeNull();
    expect(swimlaneKeyOf(t("x", { assigneeId: "—" }), "assignee", ctx)).toBe(UNASSIGNED_COL);
  });

  it("rows never repeat the columns, and a stored choice is read safely", () => {
    expect(effectiveSwimlane("assignee", "assignee")).toBe("none");
    expect(effectiveSwimlane("assignee", "status")).toBe("assignee");
    expect(readSwimlane("priority")).toBe("priority");
    expect(readSwimlane("sideways")).toBe("none");
    expect(readSwimlane(null)).toBe("none");
    expect(swimlaneStorageKey("project:p1")).toBe("kanbo-board-lanes:project:p1");
    expect(swimlaneStorageKey(undefined)).toBe("kanbo-board-lanes:all");
    expect(laneCollapseStorageKey("my:ws")).toBe("kanbo-board-lanes-collapsed:my:ws");
  });
});

describe("WIP limits on board settings", () => {
  it("status columns keep their plain key; other groupings are qualified", () => {
    expect(wipSettingKey("status", "progress")).toBe("progress");
    expect(wipSettingKey("priority", "urgent")).toBe("priority:urgent");
    expect(wipSettingKey("assignee", "m-1")).toBe("assignee:m-1");
  });

  it("copies this device's limits into the settings' shape", () => {
    expect(localWipToSettings({ "status:todo": 3, "priority:high": 2, "status:review": 0, junk: 1.5 } as Record<string, number>))
      .toEqual({ todo: 3, "priority:high": 2 });
  });

  it("sets, clears and clamps a limit without touching the rest", () => {
    const s = withWipLimit({ covers: true }, "progress", 3);
    expect(s).toEqual({ covers: true, wip: { progress: 3 } });
    expect(withWipLimit(s, "review", 5000)).toEqual({ covers: true, wip: { progress: 3, review: 999 } });
    expect(withWipLimit(s, "progress", null)).toEqual({ covers: true }); // an empty wip goes
    expect(withWipLimit(undefined, "todo", 0)).toEqual({ wip: { todo: 1 } });
    expect(withCovers({ wip: { todo: 2 } }, true)).toEqual({ wip: { todo: 2 }, covers: true });
    expect(withCovers({ covers: true }, false)).toEqual({});
  });

  it("says when a move takes a column past its limit, and only then", () => {
    expect(wipState(3, 3)).toBe("at");
    expect(wipBreachMessage("In progress", 4, 3)).toBe("In progress is over its WIP limit: 4 of 3");
    expect(wipBreachMessage("In progress", 3, 3)).toBeNull();
    expect(wipBreachMessage("In progress", 9, undefined)).toBeNull();
  });
});

describe("card progress", () => {
  it("counts sub-tasks first, else the checklist; nothing when there's neither", () => {
    const checklist = [{ id: "s1", title: "a", done: true }, { id: "s2", title: "b", done: false }, { id: "s3", title: "c", done: true }];
    expect(cardProgress({ subtasks: checklist }, [{ status: "done" }, { status: "todo" }])).toEqual({ done: 1, total: 2 });
    expect(cardProgress({ subtasks: checklist }, [])).toEqual({ done: 2, total: 3 });
    expect(cardProgress({ subtasks: [] }, [])).toBeNull();
    expect(cardProgress({ subtasks: undefined as unknown as [] }, [])).toBeNull();
  });

  it("guesses taller cards for covers, tags, progress and long titles", () => {
    const base = cardHeightEstimate({});
    expect(cardHeightEstimate({ cover: "image" })).toBeGreaterThan(cardHeightEstimate({ cover: "project" }));
    expect(cardHeightEstimate({ cover: "project" })).toBeGreaterThan(base);
    expect(cardHeightEstimate({ tags: true, progress: true, titleLength: 60 })).toBeGreaterThan(base + 40);
  });
});

describe("moving several cards", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("puts a run of cards together at the drop, in their order, between the neighbours", () => {
    const list = [{ id: "a", position: 1 }, { id: "b", position: 2 }, { id: "c", position: 3 }, { id: "x", position: 10 }, { id: "y", position: 11 }];
    const writes = planInsertMany(list, ["x", "y"], 1); // after "a"
    const pos = new Map(writes.map((w) => [w.id, w.position]));
    expect(pos.get("x")! > 1 && pos.get("x")! < pos.get("y")! && pos.get("y")! < 2).toBe(true);
    expect(writes.every((w) => w.id === "x" || w.id === "y")).toBe(true);
  });

  it("works into an empty column and through tied positions (pinned clock)", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
    const empty = planInsertMany([], ["a", "b"], 0);
    expect(empty.map((w) => w.id)).toEqual(["a", "b"]);
    expect(empty[0].position).toBeLessThan(empty[1].position);
    const tied = [{ id: "p", position: 0 }, { id: "q", position: 0 }, { id: "r", position: 0 }];
    const order = (ws: { id: string; position: number }[]) => {
      const pos = new Map([...tied.map((t) => [t.id, t.position] as const), ...ws.map((w) => [w.id, w.position] as const)]);
      return [...pos.entries()].sort((a, b) => (a[1] - b[1]) || a[0].localeCompare(b[0])).map(([id]) => id);
    };
    expect(order(planInsertMany(tied, ["m", "n"], 1))).toEqual(["p", "m", "n", "q", "r"]);
  });
});

describe("virtual window", () => {
  const H = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 180 : 100));
  /** where each rendered card lands when the segments are laid out in a column with this gap */
  const layout = (heights: number[], gap: number, segs: ReturnType<typeof virtualSegments>) => {
    const tops = new Map<number, number>();
    let y = 0, first = true;
    for (const s of segs) {
      if (s.kind === "space") { if (!first) y += gap; y += s.height; first = false; continue; }
      for (let i = s.start; i < s.end; i++) { if (!first) y += gap; tops.set(i, y); y += heights[i]; first = false; }
    }
    return { tops, total: y };
  };

  it("renders what's near the screen, from the top", () => {
    const r = virtualRanges(H, 8, 0, 800, 200);
    expect(r).toHaveLength(1);
    expect(r[0].start).toBe(0);
    const { offsets } = stackOffsets(H, 8);
    expect(offsets[r[0].end - 1]).toBeLessThanOrEqual(1000);
    expect(offsets[r[0].end] ?? Infinity).toBeGreaterThan(1000);
  });

  it("follows the scroll, and keeps pinned cards with a neighbour each side", () => {
    const r = virtualRanges(H, 8, 5000, 5600, 0, [150]);
    expect(r.length).toBe(2);
    expect(r[0].start).toBeGreaterThan(30);
    expect(r[1]).toEqual({ start: 149, end: 152 });
    // a pinned card inside the window just merges
    const inside = virtualRanges(H, 8, 0, 800, 0, [2]);
    expect(inside).toHaveLength(1);
  });

  it("never renders nothing (a column far off screen keeps one card)", () => {
    expect(virtualRanges(H, 8, -5000, -4000, 100)).toEqual([{ start: 0, end: 1 }]);
    expect(virtualRanges(H, 8, 1e7, 1e7 + 800, 100)).toEqual([{ start: 199, end: 200 }]);
    expect(virtualRanges([], 8, 0, 800, 100)).toEqual([]);
  });

  it("sizes the spacers so every rendered card sits exactly where it would in the full column", () => {
    const { offsets, total } = stackOffsets(H, 8);
    for (const ranges of [virtualRanges(H, 8, 5000, 5600, 300, [150]), virtualRanges(H, 8, 0, 600, 0), virtualRanges(H, 8, 20000, 21000, 0), [{ start: 0, end: 200 }]]) {
      const segs = virtualSegments(H, 8, ranges);
      const { tops, total: laid } = layout(H, 8, segs);
      expect(laid).toBe(total);
      for (const [i, y] of tops) expect(y).toBe(offsets[i]);
    }
    expect(virtualSegments(H, 8, [])).toEqual([{ kind: "space", height: total }]);
  });

  it("starts virtualising past fifty cards", () => {
    expect(VIRTUALISE_AFTER).toBe(50);
  });
});
