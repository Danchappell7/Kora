import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SearchHit, Task } from "../../data/types";

const api = vi.hoisted(() => ({ searchAll: vi.fn() }));
vi.mock("../searchApi", async (orig) => ({ ...(await orig<typeof import("../searchApi")>()), searchAll: api.searchAll }));
import { useUniversalSearch, resetSearchServerMemory, localReasonText, type UniversalSearchArgs } from "./useUniversalSearch";

const task = (id: string, title: string): Task => ({
  id, title, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "m", tags: [], dependencies: [], subtasks: [],
  focusMin: 0, comments: 0, aiScore: 0,
});
const TASKS = [task("a", "Pricing deck"), task("b", "Hiring plan")];
const LOCAL = { tasks: TASKS, projects: [], members: [], currentUserId: "m" };
const hit = (id: string): SearchHit => ({ kind: "task", id, title: id, snippet: null, rank: 0.5, taskId: id, projectId: null, workspaceId: null, updatedAt: null, source: "server" });
const args = (text: string, o: Partial<UniversalSearchArgs> = {}): UniversalSearchArgs =>
  ({ active: !!text, text, filters: {}, local: LOCAL, limit: 5, debounceMs: 100, server: true, ...o });
const flush = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  api.searchAll.mockReset();
  resetSearchServerMemory();
});
afterEach(() => { vi.useRealTimers(); });

describe("useUniversalSearch", () => {
  it("answers from the device at once, then the server after the pause", async () => {
    api.searchAll.mockResolvedValue([hit("srv")]);
    const { result } = renderHook((p: UniversalSearchArgs) => useUniversalSearch(p), { initialProps: args("pricing") });
    expect(result.current.local.map((h) => h.id)).toEqual(["a"]);
    expect(result.current).toMatchObject({ server: null, phase: "searching", reason: null });
    await flush(99);
    expect(api.searchAll).not.toHaveBeenCalled();
    await flush(1);
    expect(api.searchAll).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ phase: "done", reason: null });
    expect(result.current.server!.map((h) => h.id)).toEqual(["srv"]);
  });

  it("0058: a comment, doc or project hit of a project that's no longer here (lost access, then the reload) is dropped at once", async () => {
    const base = { rank: 1, workspaceId: "ws-1", updatedAt: null, source: "server" as const, snippet: null };
    api.searchAll.mockResolvedValue([
      { ...base, kind: "comment", id: "c-1", title: "Draft SPA for Target Co", taskId: "t-priv", projectId: "p-priv" },
      { ...base, kind: "doc", id: "d-1", title: "Target Co price memo", taskId: null, projectId: "p-priv" },
      { ...base, kind: "project", id: "p-priv", title: "Acquisition of Target Co", taskId: null, projectId: "p-priv" },
      { ...base, kind: "doc", id: "d-2", title: "Price list notes", taskId: null, projectId: "p-open" },
      { ...base, kind: "doc", id: "d-3", title: "Pricing handbook", taskId: null, projectId: null },
      { ...base, kind: "person", id: "m-2", title: "Sana Rao", taskId: null, projectId: null },
    ] as SearchHit[]);
    const P = (id: string) => ({ id, name: id, emoji: "", color: "#555", workspaceId: "ws-1" }) as never;
    const before = { ...LOCAL, projects: [P("p-open"), P("p-priv")], tasks: [...TASKS, { ...task("t-priv", "Draft SPA for Target Co"), projectId: "p-priv" }] };
    const { result, rerender } = renderHook((p: UniversalSearchArgs) => useUniversalSearch(p), { initialProps: args("price", { local: before }) });
    await flush(100);
    expect(result.current.server!.map((h) => h.id)).toEqual(["c-1", "d-1", "p-priv", "d-2", "d-3", "m-2"]);
    // the reload hands the page its projects and tasks without p-priv: nothing of it stays, no new request needed
    rerender(args("price", { local: { ...LOCAL, projects: [P("p-open")] } }));
    expect(result.current.server!.map((h) => h.id)).toEqual(["d-2", "d-3", "m-2"]);
    // (a comment on a task that's gone, its project still here: gone too)
    rerender(args("price", { local: { ...LOCAL, projects: [P("p-open"), P("p-priv")] } }));
    expect(result.current.server!.map((h) => h.id)).toEqual(["d-1", "p-priv", "d-2", "d-3", "m-2"]);
    expect(api.searchAll).toHaveBeenCalledTimes(1);
  });

  it("a newer keystroke cancels the older request, and an answer for older words is never used", async () => {
    let resolveFirst: (v: SearchHit[]) => void = () => {};
    const signals: AbortSignal[] = [];
    api.searchAll.mockImplementationOnce((_t: string, _f: unknown, o: { signal: AbortSignal }) => { signals.push(o.signal); return new Promise((r) => { resolveFirst = r; }); })
      .mockImplementationOnce(async (_t: string, _f: unknown, o: { signal: AbortSignal }) => { signals.push(o.signal); return [hit("second")]; });
    const { result, rerender } = renderHook((p: UniversalSearchArgs) => useUniversalSearch(p), { initialProps: args("pri") });
    await flush(100);
    rerender(args("pricing"));
    expect(signals[0].aborted).toBe(true);
    await act(async () => { resolveFirst([hit("first")]); });
    expect(result.current.server).toBeNull();
    await flush(100);
    expect(result.current.server!.map((h) => h.id)).toEqual(["second"]);
  });

  it("typing quickly asks once", async () => {
    api.searchAll.mockResolvedValue([]);
    const { rerender } = renderHook((p: UniversalSearchArgs) => useUniversalSearch(p), { initialProps: args("p") });
    for (const t of ["pr", "pri", "pric", "prici", "pricing"]) { await flush(40); rerender(args(t)); }
    await flush(100);
    expect(api.searchAll).toHaveBeenCalledTimes(1);
    expect(api.searchAll.mock.calls[0][0]).toBe("pricing");
  });

  it("no server, offline, or no search_all yet: the device's answer, with the reason", async () => {
    const demo = renderHook(() => useUniversalSearch(args("pricing", { server: false })));
    expect(demo.result.current).toMatchObject({ reason: "demo", phase: "done" });
    expect(localReasonText("demo")).toMatch(/demo/i);

    const online = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const off = renderHook(() => useUniversalSearch(args("pricing")));
    expect(off.result.current.reason).toBe("offline");
    online.mockRestore();

    api.searchAll.mockRejectedValue(new Error("function public.search_all(text, jsonb, integer) does not exist"));
    const { result, rerender } = renderHook((p: UniversalSearchArgs) => useUniversalSearch(p), { initialProps: args("pricing") });
    await flush(100);
    expect(result.current.reason).toBe("unavailable");
    rerender(args("deck"));
    await flush(200);
    expect(api.searchAll).toHaveBeenCalledTimes(1);
    expect(result.current.reason).toBe("unavailable");
    expect(result.current.local.map((h) => h.id)).toEqual(["a"]);
  });

  it("nothing to search: idle, and no call", async () => {
    const { result } = renderHook(() => useUniversalSearch(args("")));
    await flush(200);
    expect(result.current).toEqual({ local: [], server: null, phase: "idle", reason: null });
    expect(api.searchAll).not.toHaveBeenCalled();
  });

  it("a host that lists tasks itself can leave them out of the device's answer", () => {
    const { result } = renderHook(() => useUniversalSearch(args("pricing", { localKinds: ["comment", "doc", "project", "person"] })));
    expect(result.current.local).toEqual([]);
  });
});
