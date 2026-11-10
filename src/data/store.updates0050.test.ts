/* store: editing and posting project updates on a database without 0053 / 0054 (status_updates has 0020's
   seven columns; PostgREST answers PGRST204 for any other). What was typed for a column that isn't there
   yet stays with the update, in its words, and the store learns that 0054 isn't in (so nobody is offered
   the Ask people). */
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const BASE = ["id", "user_id", "workspace_id", "project_id", "summary", "status", "created_at"];
const WITH_0053 = [...BASE, "recovery_plan", "target_date"];
const WITH_0054 = [...WITH_0053, "author_id", "edited_at", "sections", "ask_user_ids"];

function fakeClient(columns: readonly string[]) {
  const cols = new Set(columns);
  const writes: { op: string; row: Row }[] = [];
  const stored: Row = { id: "su-1", user_id: "user-a", workspace_id: "ws", project_id: "p1", summary: "Old words", status: "on_track", created_at: "2026-11-01T10:00:00Z" };
  for (const c of columns) if (!(c in stored)) stored[c] = null;
  const missing = (row: Row) => Object.keys(row).find((k) => !cols.has(k));
  const refuse = (col: string) => ({ data: null, error: { code: "PGRST204", message: `Could not find the '${col}' column of 'status_updates' in the schema cache` } });
  const client = {
    from() {
      return {
        update(row: Row) {
          return { eq() { return { async select() {
            writes.push({ op: "update", row });
            const gone = missing(row);
            if (gone) return refuse(gone);
            Object.assign(stored, row);
            return { data: [{ ...stored }], error: null };
          } }; } };
        },
        insert(row: Row) {
          return { select() { return { async single() {
            writes.push({ op: "insert", row });
            const gone = missing(row);
            if (gone) return refuse(gone);
            const saved: Row = { id: "su-2", created_at: "2026-11-10T10:00:00Z" };
            for (const c of columns) saved[c] = c in row ? row[c] : saved[c] ?? null;
            return { data: saved, error: null };
          } }; } };
        },
      };
    },
    auth: { getSession: async () => ({ data: { session: { user: { id: "user-a" } } }, error: null }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } },
  };
  return { client, writes, stored };
}
async function load(fake: ReturnType<typeof fakeClient>) {
  vi.resetModules();
  vi.doMock("../lib/supabase", () => ({ supabase: fake.client, isSupabaseConfigured: true }));
  vi.doMock("../lib/monitoring", () => ({ reportError: vi.fn(), initMonitoring() {}, setUserContext() {}, monitoringEnabled: false }));
  const store = (await import("./store")).store;
  const schema = await import("../lib/updateSchema");
  return { store, schema };
}
afterEach(() => { vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

const update = { id: "su-1", workspaceId: "ws", projectId: "p1", summary: "Old words", status: "on_track" as const, createdAt: "2026-11-01T10:00:00Z", authorId: "user-a" };
const edit = { summary: "New words", status: "at_risk" as const, sections: { risks: "Vendor slips two weeks", asks: "Maya: sign off the budget" },
  askUserIds: ["user-b"], recoveryPlan: "Move the launch", targetDate: "2026-12-04" };

describe("editStatusUpdate before 0053 and 0054 (live at 0050)", () => {
  it("keeps the plan, the date and the sections in the update's words, and saves", async () => {
    const fake = fakeClient(BASE);
    const { store, schema } = await load(fake);
    expect(schema.updateAsksOn()).toBe(false);   // (not known yet: not offered)
    const next = await store.editStatusUpdate(update, edit);
    const last = fake.writes[fake.writes.length - 1].row;
    expect(Object.keys(last).sort()).toEqual(["status", "summary"]);
    expect(next.summary).toBe("New words\n\nPlan to recover: Move the launch\n\nNew target date: 2026-12-04\n\nRisks: Vendor slips two weeks\nAsks: Maya: sign off the budget");
    expect(fake.stored.summary).toBe(next.summary);
    expect(next.status).toBe("at_risk");
    expect(schema.updateColumns()).toBe("old");
    expect(schema.updateAsksOn()).toBe(false);
  });

  it("an edit that only changes the call keeps the update's words as they were", async () => {
    const fake = fakeClient(BASE);
    const { store } = await load(fake);
    const next = await store.editStatusUpdate(update, { status: "off_track", sections: null, recoveryPlan: null, targetDate: null, askUserIds: [] });
    expect(next.summary).toBe("Old words");
    expect(fake.writes[fake.writes.length - 1].row).toEqual({ status: "off_track" });
  });

  it("with 0053 but not 0054: the plan and date in their own columns, the sections in the words", async () => {
    const fake = fakeClient(WITH_0053);
    const { store } = await load(fake);
    const next = await store.editStatusUpdate(update, edit);
    expect(fake.writes[fake.writes.length - 1].row).toMatchObject({ recovery_plan: "Move the launch", target_date: "2026-12-04" });
    expect(next).toMatchObject({ recoveryPlan: "Move the launch", targetDate: "2026-12-04" });
    expect(next.summary).toBe("New words\n\nRisks: Vendor slips two weeks\nAsks: Maya: sign off the budget");
  });

  it("with 0054: everything in its own column, and the Ask people are offered from then on", async () => {
    const fake = fakeClient(WITH_0054);
    const { store, schema } = await load(fake);
    const next = await store.editStatusUpdate(update, edit);
    expect(fake.writes).toHaveLength(1);
    expect(next).toMatchObject({ summary: "New words", sections: edit.sections, askUserIds: ["user-b"] });
    expect(schema.updateColumns()).toBe("full");
    expect(schema.updateAsksOn()).toBe(true);
  });
});

describe("createStatusUpdate before 0054", () => {
  it("posts with the Asks in its words, and learns 0054 isn't in (so the Ask people aren't offered)", async () => {
    const fake = fakeClient(BASE);
    const { store, schema } = await load(fake);
    const su = await store.createStatusUpdate({ workspaceId: "ws", projectId: "p1", summary: "Deck is late", status: "on_track", sections: { asks: "Theo: approve the budget" }, askUserIds: ["user-t"] }, "user-a");
    expect(su.summary).toBe("Deck is late\n\nAsks: Theo: approve the budget");
    expect(su.askUserIds).toBeUndefined();
    expect(schema.updateColumns()).toBe("old");
    expect(schema.updateAsksOn()).toBe(false);
  });
});
