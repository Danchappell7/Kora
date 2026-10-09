/* lib/docs against a (mocked) real backend: the 0047 RPCs and tables as the signed-in person,
   their JSON parsed, their errors passed through, realtime as a ping. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; ops: [string, unknown[]][] };
const { rpc, from, channel, removeChannel, calls, next, handlers } = vi.hoisted(() => {
  const calls: Call[] = [];
  const next: { data: unknown; error: unknown }[] = [];
  const handlers: { filter: Record<string, unknown>; fn: (p: unknown) => void }[] = [];
  const builder = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const b: Record<string, unknown> = {};
    for (const op of ["select", "eq", "order", "limit", "in"]) b[op] = (...a: unknown[]) => { call.ops.push([op, a]); return b; };
    b.maybeSingle = () => { call.ops.push(["maybeSingle", []]); return Promise.resolve(next.shift() ?? { data: null, error: null }); };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next.shift() ?? { data: [], error: null }).then(res, rej);
    return b;
  };
  const ch: Record<string, unknown> = {};
  ch.on = (_kind: string, filter: Record<string, unknown>, fn: (p: unknown) => void) => { handlers.push({ filter, fn }); return ch; };
  ch.subscribe = () => ch;
  return {
    rpc: vi.fn(), from: vi.fn((t: string) => builder(t)), channel: vi.fn((_name: string) => ch), removeChannel: vi.fn(),
    calls, next, handlers,
  };
});
vi.mock("./supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (t: string) => from(t), channel: (n: string) => channel(n), removeChannel: (c: unknown) => removeChannel(c) }, isSupabaseConfigured: true }));

import { deleteProjectDoc, docFailure, getDocVersion, getProjectDoc, listDocVersions, listProjectDocs, saveProjectDoc, setProjectDocProps, subscribeProjectDocs, DOC_LIST_COLUMNS } from "./docs";

const DOC = {
  id: "d0c00000-0000-4000-8000-000000000001", project_id: "11111111-0000-4000-8000-000000000001", workspace_id: "22222222-0000-4000-8000-000000000001",
  title: "Project brief", body: [{ id: "b1", type: "h1", spans: [{ text: "Why" }] }], icon: "📄", position: 1, mentions: ["m-1"],
  created_by: "u1", updated_by: "u2", created_at: "2026-10-09T00:10:11.387Z", updated_at: "2026-10-09T00:20:11.387Z", archived_at: null,
};
const setOnline = (on: boolean) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });

beforeEach(() => { rpc.mockReset(); from.mockClear(); calls.length = 0; next.length = 0; handlers.length = 0; setOnline(true); });
afterEach(() => setOnline(true));

describe("docs over PostgREST", () => {
  it("lists a project's docs without bodies, in order", async () => {
    next.push({ data: [{ ...DOC, body: undefined }, { bad: true }], error: null });
    const list = await listProjectDocs(DOC.project_id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: DOC.id, title: "Project brief", position: 1 });
    expect(calls[0].table).toBe("project_docs");
    expect(calls[0].ops).toEqual([
      ["select", [DOC_LIST_COLUMNS]],
      ["eq", ["project_id", DOC.project_id]],
      ["order", ["position", { ascending: true, nullsFirst: false }]],
      ["order", ["created_at", { ascending: true }]],
    ]);
  });

  it("gets one doc with whether you can edit it (can_edit_project)", async () => {
    next.push({ data: DOC, error: null });
    rpc.mockResolvedValue({ data: true, error: null });
    const d = await getProjectDoc(DOC.id);
    expect(d).toMatchObject({ id: DOC.id, canEdit: true, body: DOC.body, mentions: ["m-1"] });
    expect(rpc).toHaveBeenCalledWith("can_edit_project", { p_project: DOC.project_id });
    // a guest: the check says no (or fails): read only
    next.push({ data: DOC, error: null });
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    expect((await getProjectDoc(DOC.id))?.canEdit).toBe(false);
    // gone
    next.push({ data: null, error: null });
    expect(await getProjectDoc(DOC.id)).toBeNull();
  });

  it("saves through save_project_doc with the base, icon and mentions", async () => {
    rpc.mockResolvedValue({ data: { status: "saved", doc: { ...DOC, can_edit: true, updated_by_name: "Sana" } }, error: null });
    const r = await saveProjectDoc({ id: DOC.id, projectId: DOC.project_id, title: " Brief ", body: DOC.body as never, baseUpdatedAt: DOC.updated_at, mentions: ["m-1", "m-1", "m-2"] });
    expect(rpc).toHaveBeenCalledWith("save_project_doc", {
      p_doc: DOC.id, p_project: DOC.project_id, p_title: "Brief", p_body: DOC.body, p_base_updated_at: DOC.updated_at, p_icon: null, p_mentions: ["m-1", "m-2"],
    });
    expect(r).toMatchObject({ status: "saved", doc: { updatedByName: "Sana", canEdit: true } });
    rpc.mockResolvedValue({ data: { status: "conflict", doc: { ...DOC, title: "Theirs" } }, error: null });
    expect(await saveProjectDoc({ id: DOC.id, projectId: DOC.project_id, title: "Mine", body: [], baseUpdatedAt: "2026-01-01T00:00:00Z", icon: "", mentions: null }))
      .toMatchObject({ status: "conflict", doc: { title: "Theirs" } });
    expect(rpc).toHaveBeenLastCalledWith("save_project_doc", expect.objectContaining({ p_icon: "", p_mentions: null }));
  });

  it("an answer it can't read is an error, never a silent success", async () => {
    rpc.mockResolvedValue({ data: { status: "saved" }, error: null });
    await expect(saveProjectDoc({ id: DOC.id, projectId: DOC.project_id, title: "x", body: [], baseUpdatedAt: null })).rejects.toThrow();
  });

  it("passes the database's refusals through for docFailure", async () => {
    for (const [message, why] of [["not allowed", "not_allowed"], ["doc not found", "not_found"], ["too many docs", "too_many"], ["doc too large", "too_large"], ["invalid body", "invalid"]] as const) {
      rpc.mockResolvedValue({ data: null, error: { message, code: "P0001" } });
      const e = await saveProjectDoc({ id: DOC.id, projectId: DOC.project_id, title: "x", body: [], baseUpdatedAt: null }).catch((x) => x);
      expect(docFailure(e), message).toBe(why);
    }
    rpc.mockResolvedValue({ data: null, error: { message: "Could not find the function public.save_project_doc", code: "PGRST202" } });
    expect(docFailure(await saveProjectDoc({ id: DOC.id, projectId: DOC.project_id, title: "x", body: [], baseUpdatedAt: null }).catch((x) => x))).toBe("unavailable");
  });

  it("props and delete", async () => {
    rpc.mockResolvedValue({ data: { ...DOC, icon: null, archived_at: "2026-10-09T01:00:00Z" }, error: null });
    const d = await setProjectDocProps(DOC.id, { icon: "", archived: true });
    expect(rpc).toHaveBeenCalledWith("set_project_doc_props", { p_doc: DOC.id, p_icon: "", p_position: null, p_archived: true });
    expect(d).toMatchObject({ icon: null, archivedAt: "2026-10-09T01:00:00Z" });
    await setProjectDocProps(DOC.id, { position: 2.5 });
    expect(rpc).toHaveBeenLastCalledWith("set_project_doc_props", { p_doc: DOC.id, p_icon: null, p_position: 2.5, p_archived: null });
    rpc.mockResolvedValue({ data: true, error: null });
    await deleteProjectDoc(DOC.id);
    expect(rpc).toHaveBeenLastCalledWith("delete_project_doc", { p_doc: DOC.id });
  });

  it("versions: newest first without bodies, then one with its body", async () => {
    next.push({ data: [{ id: "v1", doc_id: DOC.id, title: "t", saved_by: "u1", saved_at: "2026-10-09T00:10:11Z" }], error: null });
    const list = await listDocVersions(DOC.id);
    expect(list).toEqual([{ id: "v1", docId: DOC.id, title: "t", body: null, savedBy: "u1", savedAt: "2026-10-09T00:10:11Z" }]);
    expect(calls[0]).toEqual({ table: "project_doc_versions", ops: [
      ["select", ["id,doc_id,title,saved_by,saved_at"]], ["eq", ["doc_id", DOC.id]],
      ["order", ["saved_at", { ascending: false }]], ["order", ["id", { ascending: false }]], ["limit", [50]],
    ] });
    next.push({ data: { id: "v1", doc_id: DOC.id, title: "t", body: DOC.body, saved_by: "u1", saved_at: "2026-10-09T00:10:11Z" }, error: null });
    expect((await getDocVersion("v1"))?.body).toEqual(DOC.body);
  });

  it("offline: fails fast without calling the server", async () => {
    setOnline(false);
    await expect(listProjectDocs("p")).rejects.toThrow(/Failed to fetch/);
    await expect(saveProjectDoc({ id: DOC.id, projectId: DOC.project_id, title: "x", body: [], baseUpdatedAt: null })).rejects.toThrow(/Failed to fetch/);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("realtime: inserts and updates for the project, deletes by id; a ping, then unsubscribe", () => {
    const seen: unknown[] = [];
    const off = subscribeProjectDocs("p1", (c) => seen.push(c));
    expect(handlers.map((h) => h.filter)).toEqual([
      { event: "INSERT", schema: "public", table: "project_docs", filter: "project_id=eq.p1" },
      { event: "UPDATE", schema: "public", table: "project_docs", filter: "project_id=eq.p1" },
      { event: "DELETE", schema: "public", table: "project_docs" },
    ]);
    handlers[1].fn({ new: { id: "d1", updated_at: "2026-10-09T00:00:00Z", updated_by: "u2" } });   // a big row: just the ping
    handlers[2].fn({ old: { id: "d2" } });
    handlers[0].fn({ new: {} });
    handlers[1].fn({ new: { ...DOC, icon: "📌", archived_at: "2026-10-09T02:00:00Z" } });             // the row came with it
    expect(seen).toEqual([
      { type: "UPDATE", docId: "d1", updatedAt: "2026-10-09T00:00:00Z", updatedBy: "u2", item: null },
      { type: "DELETE", docId: "d2", updatedAt: null, updatedBy: null, item: null },
      { type: "UPDATE", docId: DOC.id, updatedAt: DOC.updated_at, updatedBy: "u2", item: expect.objectContaining({ id: DOC.id, icon: "📌", archivedAt: "2026-10-09T02:00:00Z" }) },
    ]);
    expect((seen[2] as { item: object }).item).not.toHaveProperty("body");
    off();
    expect(removeChannel).toHaveBeenCalled();
    handlers[1].fn({ new: { id: "d3" } });
    expect(seen).toHaveLength(3);
  });
});
