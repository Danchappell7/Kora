import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// minimal fake: only rpc is needed
function fakeClient(result: () => { data?: unknown; error?: unknown }) {
  const calls: { name: string; args: unknown }[] = [];
  return { calls, client: { rpc(name: string, args?: unknown) { calls.push({ name, args }); return Promise.resolve().then(() => { const r = result(); return { data: r.data ?? null, error: r.error ?? null }; }); }, auth: { getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } } } };
}
async function load(fake: ReturnType<typeof fakeClient>) {
  vi.resetModules();
  vi.doMock("../lib/supabase", () => ({ supabase: fake.client, isSupabaseConfigured: true }));
  vi.doMock("../lib/monitoring", () => ({ reportError: vi.fn(), initMonitoring() {}, setUserContext() {}, monitoringEnabled: false }));
  return (await import("./store")).store;
}

describe("store.setTaskFollow (0042's toggle_task_follow)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

  it("sends an explicit follow/unfollow and returns the followers afterwards", async () => {
    const fake = fakeClient(() => ({ data: ["user-a", "user-b"] }));
    const s = await load(fake);
    expect(await s.setTaskFollow("t-1", true)).toEqual(["user-a", "user-b"]);
    expect(await s.setTaskFollow("t-1", false)).toEqual(["user-a", "user-b"]);
    expect(fake.calls).toEqual([
      { name: "toggle_task_follow", args: { p_task: "t-1", p_follow: true } },
      { name: "toggle_task_follow", args: { p_task: "t-1", p_follow: false } },
    ]);
  });

  it("returns null (caller falls back to a normal save) before 0042 is run or when the network drops", async () => {
    for (const error of [{ code: "PGRST202", message: "Could not find the function" }, { code: "42883", message: "function does not exist" }, new TypeError("Failed to fetch")]) {
      const s = await load(fakeClient(() => ({ error })));
      expect(await s.setTaskFollow("t-1", true)).toBeNull();
    }
  });

  it("throws a real refusal (task not found) so the caller can undo and say so", async () => {
    const s = await load(fakeClient(() => ({ error: { code: "P0001", message: "task not found" } })));
    await expect(s.setTaskFollow("t-1", true)).rejects.toMatchObject({ message: "task not found" });
  });

  it("returns null while offline, without calling the server", async () => {
    const fake = fakeClient(() => ({ data: [] }));
    const s = await load(fake);
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try { expect(await s.setTaskFollow("t-1", true)).toBeNull(); } finally { spy.mockRestore(); }
    expect(fake.calls).toHaveLength(0);
  });
});
