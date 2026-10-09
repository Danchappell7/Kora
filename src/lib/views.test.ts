import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SavedView, Task } from "../data/types";
import {
  viewMatchesTask, viewCount, viewCountOrNull, viewCounts, viewRoute, isViewActive, viewInScope, orderViews,
  useSavedViews, createSavedView, updateSavedView, deleteSavedView, stageDeleteSavedView, reorderSavedViews, setViewHidden,
  listSavedViews, resetSavedViewsForTests, getSavedView, DEMO_SAVED_VIEWS, VIEW_ME, SAVED_VIEW_COLUMNS, warmSavedViews,
  viewBucketOf, viewWaitingIds,
} from "./views";
import { bucketWaiting, openBucketOf } from "./myTaskBuckets";
import { savedViewMessage } from "./savedViews/messages";

beforeAll(async () => { await warmSavedViews(); });

const TODAY = new Date(2026, 9, 9); // Fri 9 Oct 2026
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, workspaceId: "ws-foundrise", ...extra,
});
const view = (kind: SavedView["kind"], query: SavedView["query"], extra: Partial<SavedView> = {}): SavedView => ({
  id: "v1", workspaceId: "ws-foundrise", userId: "me", name: "A view", emoji: null, kind, query, pinned: true, position: 1024, shared: false,
  createdAt: "2026-10-01T09:00:00Z", updatedAt: "2026-10-01T09:00:00Z", ...extra,
});
const ctx = (tasks: Task[], extra: Partial<Parameters<typeof viewCount>[1]> = {}) => ({ tasks, currentUserId: "me", today: TODAY, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  resetSavedViewsForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe("what a My tasks view shows", () => {
  const tasks = [
    task("mine-urgent", { priority: "urgent", dueDate: "2026-10-12" }),
    task("mine-collab", { assigneeId: "sana", collaborators: ["me"], priority: "urgent" }),
    task("theirs", { assigneeId: "sana", priority: "urgent" }),
    task("mine-done", { priority: "urgent", status: "done", completedAt: "2026-10-08T10:00:00Z" }),
    task("other-ws", { priority: "urgent", workspaceId: "ws-reco", projectId: "p-growth" }),
    task("mine-archived", { priority: "urgent", archivedAt: "2026-10-01" }),
    task("mine-overdue", { dueDate: "2026-10-05" }),
  ];

  it("scopes to your open tasks in the view's workspace (collaborations included), then applies its filters", () => {
    const v = view("my_tasks", { v: 1, list: "open", filters: { priority: "urgent" } });
    expect(tasks.filter((t) => viewMatchesTask(v, t, ctx(tasks))).map((t) => t.id)).toEqual(["mine-urgent", "mine-collab"]);
    expect(viewCount(v, ctx(tasks))).toBe(2);
  });

  it("reads due words against the given today (pinned), never the real clock", () => {
    const week = view("my_tasks", { v: 1, filters: { due: "week" } });
    expect(tasks.filter((t) => viewMatchesTask(week, t, ctx(tasks))).map((t) => t.id)).toEqual(["mine-urgent"]);
    const overdue = view("my_tasks", { v: 1, list: "overdue" });
    expect(tasks.filter((t) => viewMatchesTask(overdue, t, ctx(tasks))).map((t) => t.id)).toEqual(["mine-overdue"]);
    // a week later, the "this week" task is overdue
    expect(viewCount(overdue, ctx(tasks, { today: new Date(2026, 9, 16) }))).toBe(2);
  });

  it("Done counts finished work; Waiting on counts what sits with someone else", () => {
    const done = view("my_tasks", { v: 1, list: "done" });
    expect(viewCount(done, ctx(tasks))).toBe(1);
    const waiting = view("my_tasks", { v: 1, list: "waiting" });
    const list = [task("handed", { createdBy: "me", assigneeId: "theo" }), task("plain", { assigneeId: "theo" })];
    expect(viewCount(waiting, ctx(list))).toBe(1);
    expect(viewMatchesTask(waiting, list[0], ctx(list))).toBe(true);
  });

  it("counts a sub-task only when its parent isn't listed too (like the sidebar's badges)", () => {
    const v = view("my_tasks", { v: 1 });
    const list = [task("parent"), task("child", { parentId: "parent" }), task("orphan", { parentId: "someone-elses" })];
    expect(viewCount(v, ctx(list))).toBe(2);
  });

  it("“@me” means whoever is looking", () => {
    const v = view("project", { v: 1, projectId: "p-launch", filters: { assignee: VIEW_ME } }, { shared: true });
    const list = [task("a", { assigneeId: "me" }), task("b", { assigneeId: "sana" })];
    expect(viewCount(v, ctx(list))).toBe(1);
    expect(viewCount(v, { ...ctx(list), currentUserId: "sana" })).toBe(1);
    expect(list.filter((t) => viewMatchesTask(v, t, { ...ctx(list), currentUserId: "sana" })).map((t) => t.id)).toEqual(["b"]);
  });
});

describe("what a project view shows", () => {
  const list = [
    task("blocked", { status: "blocked", sectionId: "s1", tags: ["eng"] }),
    task("review", { status: "review", tags: ["eng"], custom: { f1: "Web" } }),
    task("done", { status: "done", tags: ["eng"] }),
    task("elsewhere", { projectId: "p-brand", status: "blocked" }),
  ];
  it("lists the project's tasks through the page's filters; the badge counts open ones", () => {
    const v = view("project", { v: 1, projectId: "p-launch", viewType: "board", filters: { tag: "eng" } });
    expect(list.filter((t) => viewMatchesTask(v, t, ctx(list))).map((t) => t.id)).toEqual(["blocked", "review", "done"]);
    expect(viewCount(v, ctx(list))).toBe(2);
    expect(viewCount(view("project", { v: 1, projectId: "p-launch", filters: { status: "blocked" } }), ctx(list))).toBe(1);
    expect(viewCount(view("project", { v: 1, projectId: "p-launch", filters: { status: "done" } }), ctx(list))).toBe(1);
  });
  it("sections, hidden done work and custom fields", () => {
    expect(viewCount(view("project", { v: 1, projectId: "p-launch", filters: { section: "s1" } }), ctx(list))).toBe(1);
    expect(viewCount(view("project", { v: 1, projectId: "p-launch", filters: { section: "__none" } }), ctx(list))).toBe(1);
    expect(list.filter((t) => viewMatchesTask(view("project", { v: 1, projectId: "p-launch", filters: { hideDone: true } }), t, ctx(list))).map((t) => t.id))
      .toEqual(["blocked", "review"]);
    expect(viewCount(view("project", { v: 1, projectId: "p-launch", filters: { "cf:f1": "Web" } }), ctx(list))).toBe(1);
    expect(viewCount(view("project", { v: 1, projectId: "p-launch", filters: { text: "REV" } }), ctx(list))).toBe(1);
  });
  it("a view without its project counts nothing", () => {
    expect(viewCountOrNull(view("project", { v: 1 }), ctx(list))).toBeNull();
  });
});

describe("what a search view shows", () => {
  const list = [
    task("Design tokens", { tags: ["design"], status: "review", assigneeId: "sana", collaborators: ["me"] }),
    task("Hero art", { tags: ["design"], status: "done" }),
    task("Personal errand", { workspaceId: null, projectId: "p-personal", tags: ["design"] }),
    task("Late", { dueDate: "2026-10-01" }),
  ];
  it("an old saved search counts exactly as Search lists it (every workspace; done included unless filtered)", () => {
    const old = view("search", { v: 1, filters: { tag: "design" } }, { workspaceId: null });
    expect(viewCount(old, ctx(list))).toBe(3);
    expect(viewCount(view("search", { v: 1, filters: { tag: "design", status: "open" } }), ctx(list))).toBe(2);
    expect(viewCount(view("search", { v: 1, filters: { assignee: "me", tag: "design" } }), ctx(list))).toBe(3);
    expect(viewCount(view("search", { v: 1, filters: { text: "tokens" } }), ctx(list))).toBe(1);
    expect(viewCount(view("search", { v: 1, filters: { due: "overdue" } }), ctx(list))).toBe(1);
  });
  it("new search views: their filters, scope and kinds (a docs-only search has no count)", () => {
    expect(viewCount(view("search", { v: 1, search: { text: "", filters: { workspaceId: null } }, filters: { tag: "design" } }), ctx(list))).toBe(1);
    expect(viewCountOrNull(view("search", { v: 1, search: { text: "brief", filters: { kinds: ["doc"] } } }), ctx(list))).toBeNull();
    expect(viewCount(view("search", { v: 1, search: { text: "", filters: { excludeDone: true, statuses: ["review", "done"] } } }), ctx(list))).toBe(1);
    expect(viewCount(view("search", { v: 1, search: { text: "", filters: { dueTo: "2026-10-08" } } }), ctx(list))).toBe(1);
  });
  it("reads the words through the natural-language parser when the host has one; literally otherwise", () => {
    const v = view("search", { v: 1, search: { text: "Sana's tokens", filters: {} } });
    expect(viewCount(v, ctx(list))).toBe(0);
    const parseSearchText = (text: string) => ({ text: text.replace("Sana's", ""), filters: { assigneeId: "sana" } });
    expect(viewCount(v, ctx(list, { parseSearchText }))).toBe(1);
  });
  it("viewCounts maps every view (null when not a task list)", () => {
    const a = view("search", { v: 1, filters: { tag: "design" } }, { id: "a" });
    const b = view("search", { v: 1, search: { text: "x", filters: { kinds: ["person"] } } }, { id: "b" });
    expect(viewCounts([a, b], ctx(list))).toEqual({ a: 3, b: null });
  });
});

describe("where a view opens", () => {
  it("My tasks (its tab), a project's view type, or Search's list", () => {
    expect(viewRoute(view("my_tasks", { v: 1, list: "open" }))).toEqual({ view: "tasks", savedViewId: "v1" });
    expect(viewRoute(view("my_tasks", { v: 1, list: "waiting" }))).toEqual({ view: "tasks", tab: "waiting", savedViewId: "v1" });
    expect(viewRoute(view("project", { v: 1, projectId: "p-launch", viewType: "board" }))).toEqual({ view: "project", projectId: "p-launch", tab: "board", savedViewId: "v1" });
    expect(viewRoute(view("project", { v: 1, projectId: "p-launch" }))).toEqual({ view: "project", projectId: "p-launch", tab: "list", savedViewId: "v1" });
    expect(viewRoute(view("project", { v: 1 }))).toEqual({ view: "projects" });
    expect(viewRoute(view("search", { v: 1 }))).toEqual({ view: "search", list: "v1" });
  });
  it("knows when it's the page on screen", () => {
    expect(isViewActive(view("search", { v: 1 }), { view: "search", list: "v1" })).toBe(true);
    expect(isViewActive(view("my_tasks", { v: 1 }), { view: "tasks", savedViewId: "v1" })).toBe(true);
    expect(isViewActive(view("my_tasks", { v: 1 }), { view: "tasks" })).toBe(false);
  });
  it("personal searches follow you into every workspace; the rest stay where they were saved", () => {
    expect(viewInScope({ workspaceId: null, kind: "search" }, "ws-1")).toBe(true);
    expect(viewInScope({ workspaceId: null, kind: "my_tasks" }, "ws-1")).toBe(false);
    expect(viewInScope({ workspaceId: "ws-1", kind: "project" }, "ws-1")).toBe(true);
    expect(viewInScope({ workspaceId: "ws-1", kind: "project" }, null)).toBe(false);
  });
  it("orders by your arrangement, then position, then age", () => {
    const a = view("search", { v: 1 }, { id: "a", position: 3 }), b = view("search", { v: 1 }, { id: "b", position: 1 }), c = view("search", { v: 1 }, { id: "c", position: null });
    expect(orderViews([a, b, c], []).map((v) => v.id)).toEqual(["b", "a", "c"]);
    expect(orderViews([a, b, c], ["c"]).map((v) => v.id)).toEqual(["c", "b", "a"]);
  });
  it("explains failures in a sentence", () => {
    expect(savedViewMessage("too_many")).toMatch(/300 saved views/);
    expect(savedViewMessage("error", "delete")).toBe("Couldn't delete the view. Please try again.");
    expect(SAVED_VIEW_COLUMNS.split(",")).toHaveLength(12);
  });
});

describe("the store, in demo mode", () => {
  const hook = (ws: string | null = "ws-foundrise", uid = "m-self") => renderHook(({ w, u }) => useSavedViews(w, u), { initialProps: { w: ws, u: uid } });
  const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it("starts from realistic demo views: yours, the team's shared ones, and personal searches that follow you", async () => {
    const { result } = hook();
    await flush();
    expect(result.current.status).toBe("ready");
    expect(result.current.views.map((v) => v.id)).toEqual(["sv-demo-urgent", "sv-demo-blocked", "sv-demo-design", "sv-demo-week", "sv-demo-eng"]);
    expect(result.current.pinned.map((v) => v.name)).toEqual(["Urgent and mine", "Blocked in the launch", "Design in review"]);
    expect(DEMO_SAVED_VIEWS.some((v) => v.shared && v.userId !== "m-self")).toBe(true);
    // Personal shows only the personal one
    const personal = hook(null);
    await flush();
    expect(personal.result.current.views.map((v) => v.id)).toEqual(["sv-demo-design"]);
  });

  it("every reader sees a save, an edit and a delete at once", async () => {
    const a = hook(), b = hook();
    await flush();
    let made: SavedView | null = null;
    await act(async () => { made = await createSavedView({ workspaceId: "ws-foundrise", name: "  Bugs  ", emoji: "🐞", kind: "project", query: { v: 1, projectId: "p-infra", filters: { tag: "bug" } } }); });
    expect(made!.name).toBe("Bugs");
    expect(made!.pinned).toBe(true);
    expect(made!.position).toBeGreaterThan(5120);
    expect(b.result.current.pinned.slice(-1)[0]?.name).toBe("Bugs");
    await act(async () => { await updateSavedView(made!.id, { name: "Infra bugs", shared: true }); });
    expect(a.result.current.views.find((v) => v.id === made!.id)).toMatchObject({ name: "Infra bugs", shared: true });
    await act(async () => { await deleteSavedView(made!.id); });
    expect(a.result.current.views.some((v) => v.id === made!.id)).toBe(false);
  });

  it("never shares a personal view, and checks names before the server would", async () => {
    const v = await createSavedView({ workspaceId: null, name: "Mine", kind: "search", query: { v: 1 }, shared: true });
    expect(v.shared).toBe(false);
    await expect(createSavedView({ workspaceId: null, name: "   ", kind: "search", query: { v: 1 } })).rejects.toThrow(/saved_views_shape/);
    await expect(createSavedView({ workspaceId: null, name: "x".repeat(81), kind: "search", query: { v: 1 } })).rejects.toThrow();
    await expect(updateSavedView("nope", { name: "x" })).rejects.toThrow(/not found/);
  });

  it("a staged delete hides at once; Undo brings it back; commit deletes", async () => {
    const { result } = hook();
    await flush();
    let staged!: ReturnType<typeof stageDeleteSavedView>;
    act(() => { staged = stageDeleteSavedView("sv-demo-urgent"); });
    await flush();
    expect(result.current.views.some((v) => v.id === "sv-demo-urgent")).toBe(false);
    act(() => staged.undo());
    expect(result.current.views.some((v) => v.id === "sv-demo-urgent")).toBe(true);
    act(() => { staged = stageDeleteSavedView("sv-demo-urgent"); });
    await act(async () => { await staged.commit(); });
    expect(getSavedView("sv-demo-urgent")).toBeUndefined();
  });

  it("reorder and hide are yours (this device); reorder also moves your own views' positions", async () => {
    const { result } = hook();
    await flush();
    await act(async () => { await reorderSavedViews(["sv-demo-design", "sv-demo-blocked", "sv-demo-urgent"]); });
    expect(result.current.pinned.map((v) => v.id)).toEqual(["sv-demo-design", "sv-demo-blocked", "sv-demo-urgent"]);
    expect(JSON.parse(localStorage.getItem("kanbo-views-order:m-self")!).slice(0, 3)).toEqual(["sv-demo-design", "sv-demo-blocked", "sv-demo-urgent"]);
    expect(getSavedView("sv-demo-design")!.position).toBe(1024);
    // Sana's shared view keeps its position (not yours to move for everyone)
    expect(getSavedView("sv-demo-blocked")!.position).toBe(2048);
    act(() => setViewHidden("sv-demo-blocked", true));
    expect(result.current.pinned.map((v) => v.id)).toEqual(["sv-demo-design", "sv-demo-urgent"]);
    expect(result.current.hiddenIds.has("sv-demo-blocked")).toBe(true);
    act(() => setViewHidden("sv-demo-blocked", false));
    expect(result.current.pinned).toHaveLength(3);
  });

  it("someone else signing in starts afresh", async () => {
    const { result, rerender } = hook();
    await flush();
    await act(async () => { await createSavedView({ workspaceId: "ws-foundrise", name: "Daniel's", kind: "my_tasks", query: { v: 1 } }); });
    rerender({ w: "ws-foundrise", u: "m-3" });
    await flush();
    expect(result.current.views.some((v) => v.name === "Daniel's")).toBe(false);
    // Sana sees her own shared view and the team's shared ones, not Daniel's private ones
    expect(result.current.views.map((v) => v.id)).toEqual(["sv-demo-blocked", "sv-demo-eng"]);
  });

  it("listSavedViews returns the scope in your order", async () => {
    const list = await listSavedViews("ws-reco");
    expect(list.map((v) => v.id)).toEqual(["sv-demo-design"]);
  });

  it("is off until there's someone signed in", async () => {
    const { result } = renderHook(() => useSavedViews("ws-foundrise", "", {}));
    await flush();
    expect(result.current.views).toEqual([]);
    expect(result.current.status).toBe("ready");
  });
});

describe("the first download's own copies of My tasks' rules agree with lib/myTaskBuckets", () => {
  const today = new Date(2026, 9, 9);
  const list = [
    task("over", { dueDate: "2026-10-01" }), task("today", { dueDate: "2026-10-09" }), task("planned", { planToday: true }),
    task("slot", { scheduled: 540 }), task("wip", { status: "progress" }), task("week", { dueDate: "2026-10-16" }),
    task("later", { dueDate: "2026-10-17" }), task("none"), task("stamp", { dueDate: "2026-10-10T08:00:00" }),
    task("handed", { createdBy: "me", assigneeId: "theo" }), task("followed", { followers: ["me"], assigneeId: "sana" }),
    task("blocker", { assigneeId: "sana" }), task("held", { dependencies: ["blocker"] }), task("done-handed", { createdBy: "me", assigneeId: "theo", status: "done" }),
    task("self-blocked", { dependencies: ["today"] }), task("collab", { assigneeId: "theo", collaborators: ["me"], createdBy: "me" }),
  ];
  it("Open buckets", () => {
    for (const t of list) expect(viewBucketOf(t, today), t.id).toBe(openBucketOf(t, today));
  });
  it("Waiting on", () => {
    expect([...viewWaitingIds(list, "me")].sort()).toEqual([...bucketWaiting(list, "me").reasons.keys()].sort());
    expect(viewWaitingIds(list, "").size).toBe(0);
  });
});
