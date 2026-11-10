/* store (0054): an update's sections and Asks, an author's edit and delete, and a portfolio's details. Before 0054
   the sections stay with the update, in its words; an edit or delete the database refuses (it isn't yours) says so;
   portfolio details that can't be saved yet say they aren't switched on. */
import { describe, it, expect, vi, afterEach } from "vitest";

type Row = Record<string, unknown>;
/** A fake client: status_updates and portfolios writes, refusing the columns named in `missing`. `own` = the edits
 *  the database lets through (RLS hands back no row otherwise). */
function fakeClient(missing: string[] = [], own = true) {
  const writes: Row[] = [];
  const gone = (row: Row) => missing.find((c) => c in row);
  const refuse = (c: string, table: string) => ({ data: null, error: { code: "PGRST204", message: `Could not find the '${c}' column of '${table}' in the schema cache` } });
  const client = {
    from(table: string) {
      return {
        insert(row: Row) {
          return { select: () => ({ async single() {
            writes.push({ op: "insert", table, ...row });
            const c = gone(row);
            if (c) return refuse(c, table);
            return { data: { id: "su-1", created_at: "2026-11-13T10:00:00Z", author_id: row.user_id, ...row }, error: null };
          } }) };
        },
        update(row: Row) {
          return { eq: (_k: string, id: string) => {
            const run = async () => {
              writes.push({ op: "update", table, id, ...row });
              const c = gone(row);
              if (c) return refuse(c, table);
              return { data: own ? [{ id, project_id: "p1", workspace_id: "ws", summary: "x", status: "on_track", created_at: "2026-11-13T10:00:00Z", author_id: "user-a", edited_at: "2026-11-13T11:00:00Z", ...row }] : [], error: null };
            };
            // awaited directly (portfolios) or through .select() (status updates): one write either way
            return { select: () => run(), then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad) };
          } };
        },
        delete() {
          return { eq: (_k: string, id: string) => ({ select: async () => { writes.push({ op: "delete", table, id }); return { data: own ? [{ id }] : [], error: null }; } }) };
        },
      };
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
    auth: { getSession: async () => ({ data: { session: { user: { id: "user-a" } } }, error: null }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } },
  };
  return { client, writes };
}
async function load(fake: ReturnType<typeof fakeClient>) {
  vi.resetModules();
  vi.doMock("../lib/supabase", () => ({ supabase: fake.client, isSupabaseConfigured: true }));
  vi.doMock("../lib/monitoring", () => ({ reportError: vi.fn(), initMonitoring() {}, setUserContext() {}, monitoringEnabled: false }));
  return (await import("./store")).store;
}
afterEach(() => { vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

const sections = { highlights: "Palette shipped", risks: "", asks: "Daniel, approve the hero?", next: "Review Wednesday" };

describe("store: an update's sections and Asks (0054)", () => {
  it("saves them in their own columns and reads them back (empty sections dropped)", async () => {
    const fake = fakeClient();
    const s = await load(fake);
    const su = await s.createStatusUpdate({ workspaceId: "ws", projectId: "p1", summary: "Moving", status: "on_track", sections, askUserIds: ["u-dan", "u-dan", "u-sana"] }, "user-a");
    expect(fake.writes[0]).toMatchObject({ sections: { highlights: "Palette shipped", asks: "Daniel, approve the hero?", next: "Review Wednesday" }, ask_user_ids: ["u-dan", "u-sana"] });
    expect(su.sections).toEqual({ highlights: "Palette shipped", asks: "Daniel, approve the hero?", next: "Review Wednesday" });
    expect(su.askUserIds).toEqual(["u-dan", "u-sana"]);
  });

  it("before 0054: the sections go into the update's words, and it still posts", async () => {
    const fake = fakeClient(["sections", "ask_user_ids"]);
    const s = await load(fake);
    const su = await s.createStatusUpdate({ workspaceId: "ws", projectId: "p1", summary: "Moving", status: "on_track", sections, askUserIds: ["u-dan"] }, "user-a");
    const last = fake.writes[fake.writes.length - 1];
    expect(last).not.toHaveProperty("sections");
    expect(last).not.toHaveProperty("ask_user_ids");
    expect(su.summary).toBe("Moving\n\nHighlights: Palette shipped\nAsks: Daniel, approve the hero?\nNext: Review Wednesday");
  });
});

describe("store: an author's edit and delete (0054)", () => {
  const u = { id: "su-1", projectId: "p1", workspaceId: "ws", summary: "x", status: "on_track" as const, createdAt: "2026-11-13T10:00:00Z", authorId: "user-a" };

  it("an edit saves the words, the call and the sections, and comes back marked edited", async () => {
    const fake = fakeClient();
    const s = await load(fake);
    const next = await s.editStatusUpdate(u, { summary: "Three weeks behind", status: "at_risk", sections: { risks: "The deck" } });
    expect(fake.writes[0]).toMatchObject({ op: "update", id: "su-1", summary: "Three weeks behind", status: "at_risk", sections: { risks: "The deck" } });
    expect(next).toMatchObject({ summary: "Three weeks behind", status: "at_risk", editedAt: "2026-11-13T11:00:00Z", sections: { risks: "The deck" } });
  });

  it("someone else's update: the database hands nothing back, and the store says only its author can change it", async () => {
    const s = await load(fakeClient([], false));
    await expect(s.editStatusUpdate(u, { summary: "mine now" })).rejects.toThrow(/Only the person who posted an update can change it/);
    await expect(s.deleteStatusUpdate("su-1")).rejects.toThrow(/workspace owner or admin/);
  });

  it("before 0054 an edit still saves, without the sections", async () => {
    const fake = fakeClient(["sections"]);
    const s = await load(fake);
    const next = await s.editStatusUpdate(u, { summary: "Edited", status: "on_track", sections: { next: "Ship" } });
    expect(fake.writes[fake.writes.length - 1]).not.toHaveProperty("sections");
    expect(next.summary).toBe("Edited");
  });
});

describe("store: a portfolio's details (0054)", () => {
  it("saves owner, description, date, followers and look in their columns", async () => {
    const fake = fakeClient();
    const s = await load(fake);
    await s.updatePortfolio("pf-1", { ownerId: "u-dan", description: "Every opening", targetDate: "2026-12-18", followerIds: ["u-maya"], emoji: "🏁", color: "oklch(0.7 0.1 70)" });
    expect(fake.writes[0]).toMatchObject({ op: "update", table: "portfolios", owner_id: "u-dan", description: "Every opening", target_date: "2026-12-18", follower_ids: ["u-maya"], emoji: "🏁" });
  });

  it("before 0054: the name still saves, and it says the details aren't switched on yet", async () => {
    const fake = fakeClient(["owner_id", "follower_ids"]);
    const s = await load(fake);
    await expect(s.updatePortfolio("pf-1", { name: "Openings", ownerId: "u-dan", followerIds: [] })).rejects.toThrow(/aren't switched on yet/);
    expect(fake.writes[fake.writes.length - 1]).toEqual({ op: "update", table: "portfolios", id: "pf-1", name: "Openings" });
    // a name alone is saved as before
    await expect(s.updatePortfolio("pf-1", { name: "Openings" })).resolves.toBeUndefined();
  });

  it("demo: a new portfolio has its details from the start, owned by whoever made it (as the database does)", async () => {
    vi.resetModules();
    vi.doMock("../lib/supabase", () => ({ supabase: null, isSupabaseConfigured: false }));
    const s = (await import("./store")).store;
    expect(await s.createPortfolio({ workspaceId: "ws-courtside", name: "Clubhouse opening" }, "m-self")).toMatchObject({
      name: "Clubhouse opening", ownerId: "m-self", description: null, targetDate: null, followerIds: [], color: null, emoji: null });
  });
});
