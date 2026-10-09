import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/* A fake Supabase client: records every call chain and answers from `answer`. */
type Call = { table?: string; rpc?: string; ops: [string, unknown[]][] };
const calls: Call[] = [];
let answer: (c: Call) => { data?: unknown; error?: unknown } = () => ({ data: null, error: null });
type Listener = { filter: Record<string, unknown>; cb: (payload: unknown) => void };
const channels: { on: Listener[]; removed: boolean }[] = [];
/** The server delivers a change to the channel's listener for that event (and filter). */
const deliver = (event: string, payload: unknown, filter?: string) => {
  const l = channels.slice(-1)[0]!.on.find((x) => x.filter.event === event && (filter === undefined || x.filter.filter === filter));
  if (!l) throw new Error(`no ${event} listener${filter ? ` for ${filter}` : ""}`);
  l.cb(payload);
};

function chain(c: Call) {
  const self: Record<string, unknown> = {};
  for (const op of ["select", "insert", "update", "delete", "eq", "is", "or", "order", "limit", "single"]) {
    self[op] = (...args: unknown[]) => { c.ops.push([op, args]); return self; };
  }
  self.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(answer(c)).then(res, rej);
  return self;
}
const fakeClient = {
  from: (table: string) => { const c: Call = { table, ops: [] }; calls.push(c); return chain(c); },
  rpc: (name: string, args?: unknown) => { const c: Call = { rpc: name, ops: [["args", [args]]] }; calls.push(c); return Promise.resolve(answer(c)); },
  auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "u-1" } } } }) },
  channel: () => {
    const ch = { on: [] as Listener[], removed: false };
    channels.push(ch);
    const api = {
      on: (_kind: string, filter: Record<string, unknown>, cb: (payload: unknown) => void) => { ch.on.push({ filter, cb }); return api; },
      subscribe: () => api,
    };
    return api;
  },
  removeChannel: () => { const ch = channels.slice(-1)[0]; if (ch) ch.removed = true; return Promise.resolve(); },
};
vi.mock("./supabase", () => ({ supabase: fakeClient, isSupabaseConfigured: true }));

const { listSavedViews, createSavedView, updateSavedView, deleteSavedView, resetSavedViewsForTests, useSavedViews, isLegacyView, getSavedView, warmSavedViews, reorderSavedViews, savedViewFailure } = await import("./views");
await warmSavedViews();

const ROW = {
  id: "11111111-1111-1111-1111-111111111111", workspace_id: "22222222-2222-2222-2222-222222222222", user_id: "u-1", name: "Blocked",
  emoji: "🚧", kind: "project", query: { v: 1, projectId: "p1", filters: { status: "blocked" } }, pinned: true, position: 1024, shared: true,
  created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T09:00:00Z",
};
const WS = ROW.workspace_id;
const missing = { message: 'relation "public.saved_views" does not exist', code: "42P01" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  calls.length = 0; channels.length = 0;
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  resetSavedViewsForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe("saved views on the server", () => {
  it("adopts the old saved searches once a session, then reads this workspace's views and your personal searches", async () => {
    answer = (c) => (c.rpc ? { data: 2 } : c.table === "saved_views" ? { data: [ROW] } : { data: [] });
    const list = await listSavedViews(WS);
    expect(list.map((v) => v.name)).toEqual(["Blocked"]);
    expect(calls.filter((c) => c.rpc === "adopt_saved_searches")).toHaveLength(1);
    const q = calls.find((c) => c.table === "saved_views")!;
    expect(q.ops.find(([op]) => op === "or")?.[1][0]).toBe(`workspace_id.eq.${WS},and(workspace_id.is.null,kind.eq.search)`);
    // adopted: the old table isn't read again
    expect(calls.some((c) => c.table === "saved_searches")).toBe(false);
    await listSavedViews(null);
    expect(calls.filter((c) => c.rpc === "adopt_saved_searches")).toHaveLength(1);
    expect(calls.slice(-1)[0]!.ops.find(([op]) => op === "is")?.[1]).toEqual(["workspace_id", null]);
  });

  it("never puts an unexpected workspace id into a filter", async () => {
    answer = () => ({ data: [] });
    expect(await listSavedViews("x),or(user_id.neq.u-1")).toEqual([]);
    expect(calls.some((c) => c.table === "saved_views")).toBe(false);
  });

  it("reads both tables while 0048 isn't live: old saved searches show as (personal, pinned) search views", async () => {
    answer = (c) => (c.rpc ? { error: { message: "function public.adopt_saved_searches() does not exist" } }
      : c.table === "saved_views" ? { error: missing }
      : { data: [{ id: "ss-1", name: "Urgent bugs", query: { priority: "urgent" }, created_at: "2026-09-01T00:00:00Z" }] });
    const list = await listSavedViews(WS);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "ss-1", kind: "search", workspaceId: null, pinned: true, query: { v: 1, filters: { priority: "urgent" } } });
    expect(isLegacyView("ss-1")).toBe(true);
    // rename goes to the old table; pinning needs 0048
    answer = () => ({ error: null });
    await updateSavedView("ss-1", { name: "Urgent" });
    const upd = calls.slice(-1)[0]!;
    expect(upd.table).toBe("saved_searches");
    expect(upd.ops[0]).toEqual(["update", [{ name: "Urgent" }]]);
    await expect(updateSavedView("ss-1", { pinned: false })).rejects.toThrow(/does not exist/);
    expect(getSavedView("ss-1")!.pinned).toBe(true);
    await deleteSavedView("ss-1");
    expect(calls.slice(-1)[0]!.table).toBe("saved_searches");
  });

  it("a failed adoption still shows the rows it didn't move", async () => {
    answer = (c) => (c.rpc ? { error: { message: "network error: Failed to fetch" } }
      : c.table === "saved_views" ? { data: [ROW] }
      : { data: [{ id: "ss-2", name: "Old one", query: {} }, { id: ROW.id, name: "dupe", query: {} }] });
    const list = await listSavedViews(WS);
    expect(list.map((v) => v.name).sort()).toEqual(["Blocked", "Old one"]);
  });

  it("creates with your id and every field; falls back to an old saved search before 0048", async () => {
    answer = () => ({ data: { ...ROW, id: "33333333-3333-3333-3333-333333333333", name: "New", shared: false } });
    const v = await createSavedView({ workspaceId: WS, name: "New", kind: "my_tasks", query: { v: 1, filters: { priority: "high" } } });
    expect(v.name).toBe("New");
    const ins = calls.slice(-1)[0]!;
    expect(ins.ops[0][0]).toBe("insert");
    expect(ins.ops[0][1][0]).toMatchObject({ user_id: "u-1", workspace_id: WS, name: "New", kind: "my_tasks", pinned: true, shared: false });

    answer = (c) => (c.table === "saved_views" ? { error: missing } : { data: { id: "ss-9", name: "Fallback", query: { priority: "high" }, created_at: "2026-10-09T09:00:00Z" } });
    const old = await createSavedView({ workspaceId: WS, name: "Fallback", kind: "search", query: { v: 1, filters: { priority: "high" } } });
    expect(old.id).toBe("ss-9");
    expect(calls.slice(-1)[0]!.ops[0]).toEqual(["insert", [{ user_id: "u-1", name: "Fallback", query: { priority: "high" } }]]);
    expect(isLegacyView("ss-9")).toBe(true);
  });

  it("an update shows at once and rolls back when the server refuses", async () => {
    answer = (c) => (c.rpc ? { data: 0 } : { data: [ROW] });
    await listSavedViews(WS);
    let release: (v: { data?: unknown; error?: unknown }) => void = () => undefined;
    answer = () => new Promise((r) => { release = r; }) as never;
    const p = updateSavedView(ROW.id, { name: "Renamed" });
    expect(getSavedView(ROW.id)!.name).toBe("Renamed");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    release({ error: { message: 'new row violates row-level security policy for table "saved_views"' } });
    await expect(p).rejects.toThrow(/row-level security/);
    expect(getSavedView(ROW.id)!.name).toBe("Blocked");
  });

  it("the hook loads, listens for changes and loads again (once per burst)", async () => {
    answer = (c) => (c.rpc ? { data: 0 } : { data: [ROW] });
    const { result, unmount } = renderHook(() => useSavedViews(WS, "u-1"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.views.map((v) => v.id)).toEqual([ROW.id]);
    expect(channels).toHaveLength(1);
    expect(channels[0].on[0].filter).toMatchObject({ table: "saved_views", schema: "public" });
    answer = (c) => (c.rpc ? { data: 0 } : { data: [] });
    const before = calls.filter((c) => c.table === "saved_views").length;
    const upd = { eventType: "UPDATE", new: { ...ROW, name: "x" } };
    act(() => { deliver("UPDATE", upd); deliver("UPDATE", upd); deliver("UPDATE", upd); });
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.filter((c) => c.table === "saved_views").length).toBe(before + 1);
    expect(result.current.views).toEqual([]);
    unmount();
    expect(channels[0].removed).toBe(true);
  });
});

describe("saved views over realtime, and coming back to a workspace", () => {
  const WB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const row = (id: string, ws: string | null, name: string, extra: Record<string, unknown> = {}) => ({ ...ROW, id, workspace_id: ws, user_id: "u-2", name, ...extra });
  const settle = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
  const fetches = () => calls.filter((c) => c.table === "saved_views" && c.ops[0]?.[0] === "select").length;
  const debounce = async () => { await act(async () => { vi.advanceTimersByTime(300); }); await settle(); };

  it("listens only to this workspace's rows and your own; a delete counts only for a view held here", async () => {
    answer = (c) => (c.rpc ? { data: 0 } : { data: [ROW] });
    const { unmount } = renderHook(() => useSavedViews(WS, "u-1"));
    await settle();
    expect(channels[0].on.map((l) => [l.filter.event, l.filter.filter ?? null])).toEqual([
      ["INSERT", `workspace_id=eq.${WS}`], ["UPDATE", `workspace_id=eq.${WS}`],
      ["INSERT", "user_id=eq.u-1"], ["UPDATE", "user_id=eq.u-1"],
      ["DELETE", null],
    ]);
    const n = fetches();
    // somebody's view in another account went: not ours to look at
    act(() => deliver("DELETE", { eventType: "DELETE", old: { id: "99999999-9999-9999-9999-999999999999" } }));
    // your own view in another workspace changed: not this sidebar's
    act(() => deliver("UPDATE", { eventType: "UPDATE", new: row("88888888-8888-8888-8888-888888888888", WB, "Elsewhere", { user_id: "u-1", kind: "my_tasks" }) }, "user_id=eq.u-1"));
    await debounce();
    expect(fetches()).toBe(n);
    // a personal search follows you here; a view held here was deleted
    act(() => deliver("INSERT", { eventType: "INSERT", new: row("77777777-7777-7777-7777-777777777777", null, "Mine", { user_id: "u-1", kind: "search" }) }, "user_id=eq.u-1"));
    act(() => deliver("DELETE", { eventType: "DELETE", old: { id: ROW.id } }));
    await debounce();
    expect(fetches()).toBe(n + 1);
    unmount();
  });

  it("a reload that finds nothing new leaves readers alone (no re-render)", async () => {
    answer = (c) => (c.rpc ? { data: 0 } : { data: [ROW] });
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useSavedViews(WS, "u-1"); });
    await settle();
    const views = result.current.views, seen = renders, n = fetches();
    act(() => deliver("UPDATE", { eventType: "UPDATE", new: ROW }));
    await debounce();
    expect(fetches()).toBe(n + 1);
    expect(renders).toBe(seen);
    expect(result.current.views).toBe(views);
    // …and one that does, re-renders
    answer = (c) => (c.rpc ? { data: 0 } : { data: [{ ...ROW, name: "Renamed" }] });
    act(() => deliver("UPDATE", { eventType: "UPDATE", new: ROW }));
    await debounce();
    expect(result.current.views[0].name).toBe("Renamed");
  });

  it("back in a workspace: what it had shows at once, and a look in the background brings teammates' changes", async () => {
    const server: Record<string, unknown[]> = { [WS]: [row("11111111-1111-1111-1111-11111111111a", WS, "A view")], [WB]: [row("22222222-2222-2222-2222-22222222222b", WB, "B view")] };
    answer = (c) => {
      if (c.rpc) return { data: 0 };
      const or = c.ops.find(([op]) => op === "or")?.[1][0] as string | undefined;
      return { data: or?.includes(WS) ? server[WS] : server[WB] };
    };
    const { result, rerender } = renderHook(({ ws }) => useSavedViews(ws, "u-1"), { initialProps: { ws: WB } });
    await settle();
    expect(result.current.views.map((v) => v.name)).toEqual(["B view"]);
    rerender({ ws: WS });
    await settle();
    expect(result.current.views.map((v) => v.name)).toEqual(["A view"]);
    // a teammate shares a view in B while you're in A (A's channel never hears of it)
    server[WB] = [...server[WB], row("33333333-3333-3333-3333-33333333333b", WB, "B new shared", { position: 2048 })];
    const n = fetches();
    rerender({ ws: WB });
    expect(result.current.views.map((v) => v.name)).toEqual(["B view"]);
    expect(result.current.status).toBe("ready");
    await settle();
    expect(fetches()).toBe(n + 1);
    expect(result.current.views.map((v) => v.name)).toEqual(["B view", "B new shared"]);
  });

  it("several readers arriving together share one load", async () => {
    answer = (c) => (c.rpc ? { data: 0 } : { data: [ROW] });
    renderHook(() => { useSavedViews(WS, "u-1"); useSavedViews(WS, "u-1"); });
    await settle();
    expect(fetches()).toBe(1);
  });

  it("a fetch that began before a save or a delete here doesn't undo it", async () => {
    answer = (c) => (c.rpc ? { data: 0 } : { data: [ROW] });
    const { result } = renderHook(() => useSavedViews(WS, "u-1"));
    await settle();
    let release: (v: { data?: unknown; error?: unknown }) => void = () => undefined;
    const made = { ...ROW, id: "44444444-4444-4444-4444-444444444444", name: "Made here", user_id: "u-1" };
    answer = (c) => (c.rpc ? { data: 0 } : c.ops[0]?.[0] === "insert" ? { data: made } : c.ops[0]?.[0] === "delete" ? { error: null }
      : new Promise((r) => { release = r; }) as never);
    act(() => deliver("UPDATE", { eventType: "UPDATE", new: { ...ROW, name: "x" } }));
    await debounce();                       // the reload is on its way, reading the old list
    await act(async () => { await createSavedView({ workspaceId: WS, name: "Made here", kind: "my_tasks", query: { v: 1 } }); });
    await act(async () => { await deleteSavedView(ROW.id); });
    release({ data: [ROW] });               // …and arrives: ROW still there, the new one not yet
    await settle();
    expect(result.current.views.map((v) => v.name)).toEqual(["Made here"]);
  });

  it("reordering writes only the view that moved (not every adopted search)", async () => {
    const own = Array.from({ length: 40 }, (_, i) => row(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, null, `S${i}`, { user_id: "u-1", kind: "search", shared: false, position: 1727000000 + i }));
    answer = (c) => (c.rpc ? { data: 0 } : c.ops[0]?.[0] === "update" ? { data: own[0] } : { data: own });
    const { result } = renderHook(() => useSavedViews(WS, "u-1"));
    await settle();
    const ids = result.current.views.map((v) => v.id);
    calls.length = 0;
    await act(async () => { await reorderSavedViews([ids[1], ids[0], ...ids.slice(2, 6)]); });
    const patches = calls.filter((c) => c.ops[0]?.[0] === "update");
    expect(patches).toHaveLength(1);
    expect(patches[0].ops.find(([op]) => op === "eq")?.[1]).toEqual(["id", ids[1]]);
    expect((patches[0].ops[0][1][0] as { position: number }).position).toBeLessThan(1727000000);
  });

  it("only its maker may share a view or stop sharing it: refused here, before any request", async () => {
    answer = (c) => (c.rpc ? { data: 0 } : { data: [{ ...ROW, user_id: "u-2" }] });
    renderHook(() => useSavedViews(WS, "u-1"));
    await settle();
    calls.length = 0;
    let err: unknown = null;
    await act(async () => { await updateSavedView(ROW.id, { shared: false }).catch((e: unknown) => { err = e; }); });
    expect(savedViewFailure(err)).toBe("not_allowed");
    expect(calls).toHaveLength(0);
    expect(getSavedView(ROW.id)!.shared).toBe(true);
    // an owner/admin's rename goes through
    answer = () => ({ data: { ...ROW, user_id: "u-2", name: "Renamed" } });
    await act(async () => { await updateSavedView(ROW.id, { name: "Renamed" }); });
    expect(calls.filter((c) => c.ops[0]?.[0] === "update")).toHaveLength(1);
  });
});
