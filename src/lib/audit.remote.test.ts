/* lib/audit against a (mocked) real backend: the page query PostgREST gets
   (filters, UK days, keyset cursor), the next cursor, and failures. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from: (...a: unknown[]) => from(...a) }, isSupabaseConfigured: true }));

import { AUDIT_ACTOR_KANBO, AUDIT_COLUMNS, auditFailure, exportAuditEvents, listAuditEvents } from "./audit";

const WS = "851dadfe-dfce-497d-bf03-4e4a1394ad30";
const ME = "228cd532-0fa5-41b7-83d6-4d5cf399b0dd";
const row = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, workspace_id: WS, actor_id: ME, actor_name: "Sana Rao", action: "task.deleted",
  target_kind: "task", target_id: "t", target_title: `Task ${i}`, detail: {}, created_at: `2026-10-09T10:00:${String(59 - (i % 60)).padStart(2, "0")}.123456+00:00`,
});

function table(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = { calls };
  for (const k of ["select", "eq", "in", "is", "order", "limit", "or", "gte", "lt"]) q[k] = vi.fn((...a: unknown[]) => { calls.push([k, a]); return q; });
  (q as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q as Record<string, unknown> & { calls: [string, unknown[]][] };
}

beforeEach(() => from.mockReset());

describe("listAuditEvents", () => {
  it("one page: the workspace, newest first, one extra row to know there's more", async () => {
    const q = table({ data: [row(1), row(2), row(3)], error: null });
    from.mockReturnValue(q);
    const page = await listAuditEvents({ workspaceId: WS, limit: 2 });
    expect(from).toHaveBeenCalledWith("audit_events");
    expect(q.calls).toEqual([
      ["select", [AUDIT_COLUMNS]],
      ["eq", ["workspace_id", WS]],
      ["order", ["created_at", { ascending: false }]],
      ["order", ["id", { ascending: false }]],
      ["limit", [3]],
    ]);
    expect(page.events.map((e) => e.targetTitle)).toEqual(["Task 1", "Task 2"]);
    // the cursor keeps the server's own timestamp (microseconds and all)
    expect(page.next).toEqual({ createdAt: row(2).created_at, id: row(2).id });
  });
  it("filters: a person, Kanbo, actions, and UK days (inclusive) as UTC instants", async () => {
    let q = table({ data: [], error: null });
    from.mockReturnValue(q);
    const page = await listAuditEvents({ workspaceId: WS, actorId: ME, actions: ["role.changed", "member.removed"], from: "2026-07-01", to: "2026-10-25" });
    expect(page).toEqual({ events: [], next: null });
    expect(q.calls).toContainEqual(["eq", ["actor_id", ME]]);
    expect(q.calls).toContainEqual(["in", ["action", ["role.changed", "member.removed"]]]);
    expect(q.calls).toContainEqual(["gte", ["created_at", "2026-06-30T23:00:00.000Z"]]);
    expect(q.calls).toContainEqual(["lt", ["created_at", "2026-10-26T00:00:00.000Z"]]);
    q = table({ data: [], error: null });
    from.mockReturnValue(q);
    await listAuditEvents({ workspaceId: WS, actorId: AUDIT_ACTOR_KANBO, from: "garbage" });
    expect(q.calls).toContainEqual(["is", ["actor_id", null]]);
    expect(q.calls.some(([k]) => k === "gte")).toBe(false);
  });
  it("keyset: older than the cursor, ties broken by id, the timestamp quoted", async () => {
    const q = table({ data: [], error: null });
    from.mockReturnValue(q);
    const before = { createdAt: "2026-10-09T10:00:11.392123+00:00", id: "c9f6a701-059e-4795-b6cf-8055436f54f8" };
    await listAuditEvents({ workspaceId: WS, before });
    expect(q.calls).toContainEqual(["or", [`created_at.lt."${before.createdAt}",and(created_at.eq."${before.createdAt}",id.lt.${before.id})`]]);
    // a cursor that isn't one never reaches the filter string
    await expect(listAuditEvents({ workspaceId: WS, before: { createdAt: '2026-10-09"),or(true', id: before.id } })).rejects.toThrow(/invalid cursor/);
  });
  it("caps a page at 500", async () => {
    const q = table({ data: [], error: null });
    from.mockReturnValue(q);
    await listAuditEvents({ workspaceId: WS, limit: 10_000 });
    expect(q.calls).toContainEqual(["limit", [501]]);
  });
  it("before 0047: unavailable; offline: network", async () => {
    from.mockReturnValue(table({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.audit_events' in the schema cache" } }));
    expect(auditFailure(await listAuditEvents({ workspaceId: WS }).catch((x) => x))).toBe("unavailable");
    from.mockReturnValue(table({ data: null, error: { message: "TypeError: Failed to fetch" } }));
    expect(auditFailure(await listAuditEvents({ workspaceId: WS }).catch((x) => x))).toBe("network");
  });
  it("export walks every page with the cursor", async () => {
    const pages = [Array.from({ length: 501 }, (_, i) => row(i)), [row(600), row(601)]];
    from.mockImplementation(() => table({ data: pages.shift() ?? [], error: null }));
    const seen: number[] = [];
    const out = await exportAuditEvents({ workspaceId: WS }, (n) => seen.push(n));
    expect(out.events).toHaveLength(502);
    expect(out.truncated).toBe(false);
    expect(seen).toEqual([500, 502]);
    expect(from).toHaveBeenCalledTimes(2);
  });
});
