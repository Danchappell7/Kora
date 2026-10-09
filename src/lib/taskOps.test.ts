import { describe, it, expect, beforeEach } from "vitest";
import {
  newTaskId, isTaskId, descendantsOf, parentsFirst, runLimited, createLimiter, swapTmp, keepTmp, pickFields, statusTransition,
  buildRecurrence, cloneTaskTree, topLevelProgress, pickStartWorkspace, readFilters, validFilters, filtersKey, EMPTY_FILTERS,
  unseenCreates, reloadProjects, reloadWorkspaces,
} from "./taskOps";
import type { Task, Workspace, WorkspaceMember } from "../data/types";

const task = (over: Partial<Task> & { id: string }): Task => ({
  title: "Task", description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 50, ...over,
});

describe("task ids", () => {
  it("generates RFC 4122 v4 UUIDs the database accepts", () => {
    const ids = new Set(Array.from({ length: 50 }, newTaskId));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(isTaskId(id)).toBe(true);
      expect(id[14]).toBe("4");
    }
  });
  it("rejects the old temporary ids", () => {
    expect(isTaskId("t-new-1727000000-123")).toBe(false);
    expect(isTaskId("t-new-" + newTaskId())).toBe(false);
    expect(isTaskId("t-cap1")).toBe(false);
    expect(isTaskId(undefined)).toBe(false);
  });
});

describe("sub-task trees", () => {
  const all = [
    task({ id: "a" }), task({ id: "b", parentId: "a" }), task({ id: "c", parentId: "b" }),
    task({ id: "d", parentId: "a" }), task({ id: "x" }),
  ];
  it("collects every descendant, parents before children", () => {
    const ids = descendantsOf(["a"], all).map((t) => t.id);
    expect(ids.sort()).toEqual(["b", "c", "d"]);
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
    expect(descendantsOf(["x"], all)).toEqual([]);
  });
  it("orders inserts so a parent always lands before its children", () => {
    const levels = parentsFirst([all[2], all[1], all[3], all[0]]).map((l) => l.map((t) => t.id).sort());
    expect(levels).toEqual([["a"], ["b", "d"], ["c"]]);
  });
  it("clones a tree with fresh ids and remapped parents", () => {
    let n = 0;
    const rows = cloneTaskTree(all[0], all, () => ({ status: "todo" }), () => `id-${++n}`);
    expect(rows.map((r) => r.id)).toEqual(["id-1", "id-2", "id-3", "id-4"]);
    const byOld = new Map(rows.map((r, i) => [[all[0], ...descendantsOf(["a"], all)][i].id, r]));
    expect(byOld.get("b")!.parentId).toBe(byOld.get("a")!.id);
    expect(byOld.get("c")!.parentId).toBe(byOld.get("b")!.id);
  });
});

describe("statusTransition", () => {
  it("stamps completedAt only on a real move into done", () => {
    expect(statusTransition({ status: "todo" }, "done", "2026-09-30")).toEqual({ completing: true, reopening: false, patch: { completedAt: "2026-09-30" } });
    expect(statusTransition({ status: "done" }, "done", "2026-09-30").patch).toEqual({});
    expect(statusTransition({ status: "todo" }, "progress", "2026-09-30").patch).toEqual({});
  });
  it("clears completedAt when a done task is reopened", () => {
    const r = statusTransition({ status: "done" }, "review");
    expect(r.reopening).toBe(true);
    expect("completedAt" in r.patch && r.patch.completedAt === undefined).toBe(true);
  });
});

describe("buildRecurrence", () => {
  const weekly = task({
    // (dates well in the future: buildRecurrence rolls a series that's fallen behind forward past today)
    id: "r1", title: "Payroll check", recurrence: "weekly", dueDate: "2030-09-30", startDate: "2030-09-28", status: "done",
    completedAt: "2030-09-30", loggedHours: 2, reactions: { "👍": ["me"] }, comments: 3, planToday: true, scheduled: 540,
  });
  const kids = [task({ id: "k1", parentId: "r1", status: "done", dueDate: "2030-09-29" }), task({ id: "k2", parentId: "r1", archivedAt: "2030-09-01" })];

  it("spawns the next occurrence with dates shifted and history reset", () => {
    let n = 0;
    const rows = buildRecurrence(weekly, [weekly, ...kids], () => `n${++n}`)!;
    const [next, child] = rows;
    expect(next.dueDate).toBe("2030-10-07");
    expect(next.startDate).toBe("2030-10-05");
    expect(next).toMatchObject({ status: "todo", completedAt: undefined, loggedHours: undefined, reactions: {}, comments: 0, planToday: false, scheduled: null });
    // live sub-tasks come along as to-do; archived ones don't
    expect(rows).toHaveLength(2);
    expect(child).toMatchObject({ parentId: next.id, status: "todo", dueDate: "2030-10-06" });
  });
  it("is idempotent: no second occurrence when an open one is already due on or after the next date", () => {
    const existing = task({ id: "r2", title: "Payroll check", recurrence: "weekly", dueDate: "2030-10-07" });
    expect(buildRecurrence(weekly, [weekly, existing])).toBeNull();
    // a done or earlier one doesn't count
    expect(buildRecurrence(weekly, [weekly, { ...existing, status: "done" }])).not.toBeNull();
  });
  it("keeps a monthly series on its day through a short month (31 Jan → 28 Feb → 31 Mar)", () => {
    const jan = task({ id: "m1", recurrence: "monthly", dueDate: "2030-01-31", status: "done" });
    const [feb] = buildRecurrence(jan, [jan])!;
    expect(feb).toMatchObject({ dueDate: "2030-02-28", originalDueDate: "2030-01-31" });
    const [mar] = buildRecurrence({ ...feb, status: "done" }, [feb])!;
    expect(mar).toMatchObject({ dueDate: "2030-03-31" });
  });
  it("leaves behind sub-tasks that repeat on their own (they spawn their own next one)", () => {
    const parent = task({ id: "p", recurrence: "weekly", dueDate: "2030-01-07", status: "done" });
    const own = task({ id: "own", parentId: "p", recurrence: "daily", dueDate: "2030-01-06" });
    const under = task({ id: "under", parentId: "own" });
    const plain = task({ id: "plain", parentId: "p" });
    const rows = buildRecurrence(parent, [parent, own, under, plain])!;
    expect(rows.map((r) => r.title)).toHaveLength(2);
    expect(rows[1]).toMatchObject({ parentId: rows[0].id, status: "todo" });
    expect(rows.some((r) => r.recurrence === "daily")).toBe(false);
  });
  it("does nothing for non-recurring tasks", () => {
    expect(buildRecurrence(task({ id: "z" }), [])).toBeNull();
    expect(buildRecurrence(task({ id: "z", recurrence: "none" }), [])).toBeNull();
  });
});

describe("small helpers", () => {
  it("swapTmp replaces the optimistic row, or drops it when a reload already brought the real one", () => {
    expect(swapTmp([{ id: "tmp-1" }, { id: "a" }], "tmp-1", { id: "real" })).toEqual([{ id: "real" }, { id: "a" }]);
    expect(swapTmp([{ id: "tmp-1" }, { id: "real" }], "tmp-1", { id: "real" })).toEqual([{ id: "real" }]);
  });
  it("keepTmp keeps rows that are still saving through a refetch", () => {
    expect(keepTmp([{ id: "a" }], [{ id: "a" }, { id: "tmp-2" }, { id: "old" }])).toEqual([{ id: "a" }, { id: "tmp-2" }]);
  });
  it("pickFields copies exactly the named fields (including undefined ones)", () => {
    const t = task({ id: "p", status: "done", completedAt: undefined });
    expect(pickFields(t, ["status", "completedAt"])).toEqual({ status: "done", completedAt: undefined });
  });
  it("topLevelProgress ignores sub-tasks", () => {
    const ts = [task({ id: "1", status: "done" }), task({ id: "2" }), task({ id: "3", parentId: "2", status: "done" })];
    expect(topLevelProgress(ts)).toEqual({ count: 2, done: 1, pct: 50 });
    expect(topLevelProgress([])).toEqual({ count: 0, done: 0, pct: 0 });
  });
  it("runLimited never exceeds the limit and reports per-item failures", async () => {
    let live = 0, peak = 0;
    const res = await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      if (n === 4) throw new Error("nope");
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(res).toEqual([true, true, true, false, true, true, true]);
  });
  it("createLimiter queues callers beyond the limit and lets them in first-come, first-served", async () => {
    const gate = createLimiter(2);
    let live = 0, peak = 0;
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4, 5].map(async (n) => {
      await gate.acquire();
      live++; peak = Math.max(peak, live); order.push(n);
      await new Promise((r) => setTimeout(r, 2));
      live--; gate.release();
    }));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("pickStartWorkspace", () => {
  const ws: Workspace[] = [{ id: null, name: "Personal", kind: "personal" }, { id: "w1", name: "Acme", kind: "team" }, { id: "w2", name: "Beta", kind: "team" }];
  it("reopens the last workspace you used", () => {
    expect(pickStartWorkspace(ws, null, "w2")).toBe("w2");
    expect(pickStartWorkspace(ws, "w1", "personal")).toBeNull();
  });
  it("falls back to the default, then your first team, then Personal", () => {
    expect(pickStartWorkspace(ws, null, "gone")).toBe("w1");
    expect(pickStartWorkspace(ws, "w2", null)).toBe("w2");
    expect(pickStartWorkspace([ws[0]], null, "w1")).toBeNull();
  });
});

describe("per-route filters", () => {
  beforeEach(() => localStorage.clear());
  it("are stored per project / My tasks", () => {
    localStorage.setItem(filtersKey("p1"), JSON.stringify({ ...EMPTY_FILTERS, priority: "high", showArchived: true }));
    expect(readFilters("p1").priority).toBe("high");
    expect(readFilters("p1").showArchived).toBe(false); // never restored on
    expect(readFilters("my")).toEqual(EMPTY_FILTERS);
  });
  it("ignore filters that can't apply here", () => {
    const f = { ...EMPTY_FILTERS, assignee: "ghost", tag: "deleted", custom: { cfA: "Design", cfB: "x", cfC: "all" } };
    const v = validFilters(f, { memberIds: new Set(["me"]), fieldIds: new Set(["cfB"]), tagIds: new Set(["t1"]) });
    expect(v.assignee).toBe("all");
    expect(v.tag).toBe("all");
    expect(v.custom).toEqual({ cfB: "x" });
    const ok = validFilters({ ...EMPTY_FILTERS, assignee: "me", tag: "t1" }, { memberIds: new Set(["me"]), fieldIds: new Set(), tagIds: new Set(["t1"]) });
    expect(ok.assignee).toBe("me");
    expect(ok.tag).toBe("t1");
  });
});

describe("reload snapshots", () => {
  const P = (id: string) => ({ id });
  const W = (id: string | null, name = String(id)): Workspace => ({ id, name, kind: id ? "team" : "personal" });
  const M = (id: string, workspaceId: string, userId: string, status: "active" | "invited" = "active"): WorkspaceMember =>
    ({ id, workspaceId, userId, email: userId + "@x", name: userId, role: "member", status });

  it("unseenCreates keeps creates a reload started too early to see, and forgets them once a later reload could", () => {
    const recent = new Map([["new", { seq: 5, until: 10_000 }], ["old", { seq: 1, until: 10_000 }], ["stale", { seq: 9, until: 10 }]]);
    expect([...unseenCreates(recent, 4, 100)]).toEqual(["new"]); // started before "new" existed
    expect(recent.has("old")).toBe(false); // reload 4 began after it — it can speak for it now
    expect(recent.has("stale")).toBe(false); // expired
    expect([...unseenCreates(recent, 6, 100)]).toEqual([]);
    expect(recent.size).toBe(0);
  });

  it("reloadProjects keeps a project created after the reload began, and tmp rows still saving", () => {
    const prev = [P("p-personal"), P("a"), P("dup"), P("tmp-proj-1")];
    expect(reloadProjects([P("p-personal"), P("a")], prev, [], new Set(["dup"])).map((p) => p.id)).toEqual(["p-personal", "a", "tmp-proj-1", "dup"]);
  });

  it("reloadProjects follows the server when a project really went", () => {
    const prev = [P("p-personal"), P("a"), P("gone")];
    expect(reloadProjects([P("p-personal"), P("a")], prev, [{ projectId: "a" }], new Set()).map((p) => p.id)).toEqual(["p-personal", "a"]);
  });

  it("reloadProjects keeps the list when the projects query came back empty but tasks still point at them", () => {
    const prev = [P("p-personal"), P("a"), P("b")];
    expect(reloadProjects([P("p-personal")], prev, [{ projectId: "a" }], new Set()).map((p) => p.id)).toEqual(["p-personal", "a", "b"]);
    // every project genuinely deleted (no task points at one): follow the server
    expect(reloadProjects([P("p-personal")], prev, [{ projectId: "p-personal" }], new Set()).map((p) => p.id)).toEqual(["p-personal"]);
  });

  it("reloadWorkspaces keeps a workspace my membership still vouches for (the workspaces query failed)", () => {
    const prev = [W(null, "Personal"), W("ws1"), W("ws2")];
    const r = reloadWorkspaces([W(null, "Personal")], prev, [M("m1", "ws1", "me")], [], "me", new Set());
    expect(r.workspaces.map((w) => w.id)).toEqual([null, "ws1"]); // ws2: no membership — really gone
  });

  it("reloadWorkspaces keeps a workspace created here (and its owner row) through a reload that began before it", () => {
    const prev = [W(null, "Personal"), W("fresh")];
    const r = reloadWorkspaces([W(null, "Personal")], prev, [], [M("owner-fresh", "fresh", "me")], "me", new Set(["fresh"]));
    expect(r.workspaces.map((w) => w.id)).toEqual([null, "fresh"]);
    expect(r.members.map((m) => m.id)).toEqual(["owner-fresh"]);
  });

  it("reloadWorkspaces drops a workspace I was removed from", () => {
    const prev = [W(null, "Personal"), W("ws1")];
    const r = reloadWorkspaces([W(null, "Personal")], prev, [M("m1", "ws1", "me", "invited")], [], "me", new Set());
    expect(r.workspaces.map((w) => w.id)).toEqual([null]);
  });
});
