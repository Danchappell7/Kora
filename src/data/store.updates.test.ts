/* store: status updates with a plan to recover (0053), and the team's update day. Before 0053 the plan and the
   date can't go in their own columns, so they stay with the update, in its words. */
import { describe, it, expect, vi, afterEach } from "vitest";

type Row = Record<string, unknown>;
/** A fake client: status_updates inserts (refusing the columns named in `missing`) and rpc calls. */
function fakeClient(missing: string[] = [], rpcError: unknown = null) {
  const inserts: Row[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const client = {
    from(table: string) {
      return {
        insert(row: Row) {
          return {
            select() {
              return {
                async single() {
                  inserts.push({ table, ...row });
                  const gone = missing.find((c) => c in row);
                  if (gone) return { data: null, error: { code: "PGRST204", message: `Could not find the '${gone}' column of 'status_updates' in the schema cache` } };
                  return { data: { id: "su-1", created_at: "2026-11-13T10:00:00Z", author_id: row.user_id, ...row }, error: null };
                },
              };
            },
          };
        },
      };
    },
    rpc(name: string, args?: unknown) { rpcs.push({ name, args }); return Promise.resolve({ data: null, error: rpcError }); },
    auth: { getSession: async () => ({ data: { session: { user: { id: "user-a" } } }, error: null }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } },
  };
  return { client, inserts, rpcs };
}
async function load(fake: ReturnType<typeof fakeClient>) {
  vi.resetModules();
  vi.doMock("../lib/supabase", () => ({ supabase: fake.client, isSupabaseConfigured: true }));
  vi.doMock("../lib/monitoring", () => ({ reportError: vi.fn(), initMonitoring() {}, setUserContext() {}, monitoringEnabled: false }));
  return (await import("./store")).store;
}
afterEach(() => { vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

describe("store.createStatusUpdate (0053)", () => {
  const input = { workspaceId: "ws", projectId: "p1", summary: "Two weeks behind", status: "at_risk" as const, recoveryPlan: "Maya takes the deck", targetDate: "2026-12-04" };

  it("saves the plan to recover and the new date in their own columns, and reads them back", async () => {
    const fake = fakeClient();
    const s = await load(fake);
    const su = await s.createStatusUpdate(input, "user-a");
    expect(fake.inserts[0]).toMatchObject({ summary: "Two weeks behind", status: "at_risk", recovery_plan: "Maya takes the deck", target_date: "2026-12-04" });
    expect(su).toMatchObject({ recoveryPlan: "Maya takes the deck", targetDate: "2026-12-04", authorId: "user-a" });
  });

  it("before 0053: the plan and the date go into the update's words, and it still posts", async () => {
    const fake = fakeClient(["recovery_plan", "target_date"]);
    const s = await load(fake);
    const su = await s.createStatusUpdate(input, "user-a");
    const last = fake.inserts[fake.inserts.length - 1];
    expect(last).not.toHaveProperty("recovery_plan");
    expect(last).not.toHaveProperty("target_date");
    expect(su.summary).toBe("Two weeks behind\n\nPlan to recover: Maya takes the deck\n\nNew target date: 2026-12-04");
  });

  it("an update without a plan sends neither column (so it posts before 0053 too)", async () => {
    const fake = fakeClient(["recovery_plan", "target_date"]);
    const s = await load(fake);
    await s.createStatusUpdate({ workspaceId: "ws", projectId: "p1", summary: "Paused", status: "on_hold" }, "user-a");
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toMatchObject({ status: "on_hold" });
  });
});

describe("store.setUpdateRhythm (0053)", () => {
  it("asks set_update_rhythm with the rhythm as stored (anchor only for fortnightly), or null for the default", async () => {
    const fake = fakeClient();
    const s = await load(fake);
    await s.setUpdateRhythm("ws", { cadence: "weekly", weekday: 4, anchor: "2026-11-12" });
    await s.setUpdateRhythm("ws", null);
    expect(fake.rpcs).toEqual([
      { name: "set_update_rhythm", args: { p_ws: "ws", p_rhythm: { cadence: "weekly", weekday: 4 } } },
      { name: "set_update_rhythm", args: { p_ws: "ws", p_rhythm: null } },
    ]);
  });
  it("throws a refusal so the caller can undo it", async () => {
    const s = await load(fakeClient([], { code: "P0001", message: "not authorized" }));
    await expect(s.setUpdateRhythm("ws", null)).rejects.toMatchObject({ message: "not authorized" });
  });
});
