/* store: ai-assist deployed before a mode it's asked for. It answers a mode it doesn't know as "prioritise"
   ({ items, summary }); that mode is skipped from then on, and only that mode (and any newer): a portfolio
   draft against main's function (no "portfolio" yet) never switches off Ask, notes → tasks, standups or
   status drafts. */
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
function fakeClient(knows: readonly string[]) {
  const invokes: Row[] = [];
  const client = {
    functions: {
      invoke: async (_name: string, o: { body: Row }) => {
        invokes.push(o.body);
        const mode = String(o.body.mode);
        if (!knows.includes(mode)) return { data: { items: [], summary: "Nothing open to prioritize." }, error: null };
        if (mode === "status" || mode === "portfolio") return { data: { summary: "Launch is on track.", status: "on_track" }, error: null };
        if (mode === "standup") return { data: { text: "Shipped the beta." }, error: null };
        if (mode === "extract") return { data: { tasks: [{ title: "Send the deck" }] }, error: null };
        return { data: { answer: "Three tasks are overdue." }, error: null };
      },
    },
    auth: { getSession: async () => ({ data: { session: { user: { id: "user-a" } } }, error: null }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } },
  };
  return { client, invokes };
}
async function load(fake: ReturnType<typeof fakeClient>) {
  vi.resetModules();
  vi.doMock("../lib/supabase", () => ({ supabase: fake.client, isSupabaseConfigured: true }));
  vi.doMock("../lib/monitoring", () => ({ reportError: vi.fn(), initMonitoring() {}, setUserContext() {}, monitoringEnabled: false }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  return (await import("./store")).store;
}
afterEach(() => { vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); vi.restoreAllMocks(); });
const ctx = { today: "2026-11-10", me: "user-a", members: [{ id: "user-a", name: "Ada" }], projects: [] };

describe("ai-assist that predates a mode", () => {
  it("main's function (no portfolio mode): a portfolio draft falls back, and every other draft still uses Kanbo's AI", async () => {
    const fake = fakeClient(["command", "extract", "standup", "status"]);
    const s = await load(fake);
    expect((await s.aiPortfolio({ portfolio: "Q4" })).source).toBe("unavailable");
    expect((await s.aiStatus({ project: "Launch" })).source).toBe("ai");
    expect((await s.aiStandup({ team: "Ops" })).source).toBe("ai");
    expect((await s.aiCommand("what's overdue?", [], ctx as never)).source).toBe("ai");
    expect((await s.aiExtract("Send the deck to Maya", ctx as never)).source).toBe("ai");
    // the portfolio mode isn't asked for again this session (no paying for answers that can't be used)
    const n = fake.invokes.length;
    expect((await s.aiPortfolio({ portfolio: "Q4" })).source).toBe("unavailable");
    expect(fake.invokes.length).toBe(n);
  });

  it("a function from before every mode: the first unknown one switches them all off (portfolio too)", async () => {
    const fake = fakeClient([]);
    const s = await load(fake);
    expect((await s.aiStatus({ project: "Launch" })).source).toBe("unavailable");
    const n = fake.invokes.length;
    expect((await s.aiStandup({ team: "Ops" })).source).toBe("unavailable");
    expect((await s.aiPortfolio({ portfolio: "Q4" })).source).toBe("unavailable");
    expect(fake.invokes.length).toBe(n);
  });

  it("a redeployed function: everything, portfolio drafts included", async () => {
    const fake = fakeClient(["command", "extract", "standup", "status", "portfolio"]);
    const s = await load(fake);
    expect((await s.aiPortfolio({ portfolio: "Q4" })).source).toBe("ai");
    expect((await s.aiStatus({ project: "Launch" })).source).toBe("ai");
  });
});
