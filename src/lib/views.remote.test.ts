import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/* A fake Supabase client: records every call chain and answers from `answer`. */
type Call = { table?: string; rpc?: string; ops: [string, unknown[]][] };
const calls: Call[] = [];
let answer: (c: Call) => { data?: unknown; error?: unknown } = () => ({ data: null, error: null });
const channels: { on: unknown[]; removed: boolean; fire?: () => void }[] = [];

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
    const ch = { on: [] as unknown[], removed: false, fire: undefined as undefined | (() => void) };
    channels.push(ch);
    const api = {
      on: (_kind: string, filter: unknown, cb: () => void) => { ch.on.push(filter); ch.fire = cb; return api; },
      subscribe: () => api,
    };
    return api;
  },
  removeChannel: () => { const ch = channels.slice(-1)[0]; if (ch) ch.removed = true; return Promise.resolve(); },
};
vi.mock("./supabase", () => ({ supabase: fakeClient, isSupabaseConfigured: true }));

const { listSavedViews, createSavedView, updateSavedView, deleteSavedView, resetSavedViewsForTests, useSavedViews, isLegacyView, getSavedView, warmSavedViews } = await import("./views");
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
    expect(channels[0].on[0]).toMatchObject({ table: "saved_views", schema: "public" });
    answer = (c) => (c.rpc ? { data: 0 } : { data: [] });
    const before = calls.filter((c) => c.table === "saved_views").length;
    act(() => { channels[0].fire!(); channels[0].fire!(); channels[0].fire!(); });
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.filter((c) => c.table === "saved_views").length).toBe(before + 1);
    expect(result.current.views).toEqual([]);
    unmount();
    expect(channels[0].removed).toBe(true);
  });
});
