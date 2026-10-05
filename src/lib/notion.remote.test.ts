/* lib/notion against a (mocked) real backend: the definer RPCs, the notion
   edge function, the tables members read, and every way they can fail —
   0046 not run, the function not deployed, refusals, offline. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, invoke, from } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), from: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    from: (...a: unknown[]) => from(...a),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: async () => {},
  },
  isSupabaseConfigured: true,
}));

import {
  NotionError, NOTION_COPY, connectNotion, disconnectNotion, importNotionDatabase, linkNotionPage, listNotionSyncs, listTaskNotionLinks,
  loadNotionStatus, resetNotionDemo, runNotionSyncNow, takeOverNotionSync, testNotion, unlinkNotionPage,
} from "./notion";

const WS = "11111111-2222-4333-8444-555555555555";
const TOKEN = "ntn_" + "Ab12Cd34".repeat(5);
const STATUS = { connected: true, workspace_name: "Acme", bot_id: "b", token_hint: "…Cd34", connected_at: null, connected_by_name: "Ana", can_manage: true, can_link: true, sync_count: 1 };
const httpError = (status: number, body: unknown) => ({
  name: "FunctionsHttpError", message: "Edge Function returned a non-2xx status code",
  context: { status, json: async () => body, clone: () => ({ json: async () => body }) },
});
const setOnline = (on: boolean) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as NotionError; } throw new Error("expected a failure"); };

/** a PostgREST-ish query builder that resolves to `result` */
function table(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order"]) q[k] = vi.fn(() => q);
  (q as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q;
}

beforeEach(() => { resetNotionDemo({ demoDelayMs: 0 }); rpc.mockReset(); invoke.mockReset(); from.mockReset(); setOnline(true); });
afterEach(() => setOnline(true));

describe("status and connection", () => {
  it("reads notion_status() as the person", async () => {
    rpc.mockResolvedValue({ data: STATUS, error: null });
    expect(await loadNotionStatus(WS)).toMatchObject({ connected: true, workspaceName: "Acme", canLink: true });
    expect(rpc).toHaveBeenCalledWith("notion_status", { p_ws: WS });
  });
  it("before 0046: unavailable, and it stops asking", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.notion_status" } });
    expect((await fail(loadNotionStatus(WS))).reason).toBe("unavailable");
    expect((await fail(disconnectNotion(WS))).reason).toBe("unavailable");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("connect goes through the function (the token is checked with Notion there)", async () => {
    invoke.mockResolvedValue({ data: { ok: true, status: STATUS }, error: null });
    expect((await connectNotion(WS, ` ${TOKEN} `)).connected).toBe(true);
    expect(invoke).toHaveBeenCalledWith("notion", { body: { action: "connect", workspaceId: WS, token: TOKEN }, timeout: 30_000 });
  });
  it("the function's refusal comes back as its sentence", async () => {
    invoke.mockResolvedValue({ data: null, error: httpError(400, { error: "Notion didn't accept that secret. Copy it again.", reason: "invalid_token" }) });
    const e = await fail(connectNotion(WS, TOKEN));
    expect(e).toMatchObject({ reason: "invalid_token", message: "Notion didn't accept that secret. Copy it again." });
    invoke.mockResolvedValue({ data: null, error: httpError(429, { error: "Notion asked Kanbo to slow down. Try again in a minute.", reason: "rate_limited", retryAfter: 30 }) });
    expect(await fail(connectNotion(WS, TOKEN))).toMatchObject({ reason: "rate_limited", retryAfter: 30 });
  });
  it("not deployed / relay / offline", async () => {
    invoke.mockResolvedValue({ data: null, error: httpError(404, "Not found") });
    expect((await fail(connectNotion(WS, TOKEN))).reason).toBe("unavailable");
    invoke.mockResolvedValue({ data: null, error: { name: "FunctionsRelayError", message: "relay" } });
    expect(await testNotion(WS)).toEqual({ ok: false, reason: "unavailable", message: NOTION_COPY.unavailable });
    setOnline(false);
    expect((await fail(connectNotion(WS, TOKEN))).message).toBe(NOTION_COPY.offline);
  });
});

describe("syncs, import, links", () => {
  it("lists syncs with the acting person's name", async () => {
    from.mockImplementation((t: string) => t === "notion_syncs"
      ? table({ data: [{ id: "s1", workspace_id: WS, project_id: "p1", database_id: "d1", mapping: { title: "Name" }, direction: "from_notion", enabled: true, stats: { created: 2 }, created_by: "u1" }], error: null })
      : table({ data: [{ user_id: "u1", name: "Ana" }], error: null }));
    const s = await listNotionSyncs(WS);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ direction: "from_notion", createdByName: "Ana", stats: { created: 2 } });
  });
  it("import: the result, and a big database's partial flag", async () => {
    invoke.mockResolvedValue({ data: { ok: true, result: { projectId: "p1", syncId: "s1", created: 1000, skipped: 2, errors: ["That's a big database…"], partial: true } }, error: null });
    const r = await importNotionDatabase({ workspaceId: WS, databaseId: "d1", mapping: { title: "Name" }, projectId: "p1", keepInSync: true, direction: "two_way" });
    expect(r).toMatchObject({ projectId: "p1", syncId: "s1", created: 1000, partial: true });
    expect(invoke.mock.calls[0][1].body).toMatchObject({ action: "import", newProject: null, keepInSync: true });
    expect(invoke.mock.calls[0][1].body).not.toHaveProperty("resume");
  });
  it("import the rest: the resume point goes back, and a new one comes in", async () => {
    invoke.mockResolvedValue({ data: { ok: true, result: { projectId: "p1", syncId: null, created: 1000, skipped: 0, errors: [], partial: true, resume: "2026-03-14T09:30:00.000Z" } }, error: null });
    const r = await importNotionDatabase({ workspaceId: WS, databaseId: "d1", mapping: { title: "Name" }, projectId: "p1", keepInSync: false, direction: "two_way", resume: "2026-03-01T00:00:00.000Z" });
    expect(r).toMatchObject({ partial: true, resume: "2026-03-14T09:30:00.000Z", syncId: null });
    expect(invoke.mock.calls[0][1].body).toMatchObject({ action: "import", projectId: "p1", keepInSync: false, resume: "2026-03-01T00:00:00.000Z" });
    invoke.mockResolvedValue({ data: { ok: true, result: { projectId: "p1", created: 5, resume: "x".repeat(80) } }, error: null });
    expect((await importNotionDatabase({ workspaceId: WS, databaseId: "d1", mapping: { title: "Name" }, projectId: "p1", keepInSync: false, direction: "two_way" })).resume).toBeNull();
  });
  it("sync now: a run that stopped throws its sentence", async () => {
    invoke.mockResolvedValue({ data: { ok: true, stats: { updated: 1 }, error: null, fatal: false }, error: null });
    expect(await runNotionSyncNow("s1")).toEqual({ updated: 1 });
    invoke.mockResolvedValue({ data: { ok: true, stats: {}, error: "Notion no longer accepts Kanbo's integration secret.", fatal: true }, error: null });
    expect((await fail(runNotionSyncNow("s1"))).message).toMatch(/no longer accepts/);
  });
  it("taking a sync over re-saves it with its own settings", async () => {
    const row = { id: "s1", workspace_id: WS, project_id: "p1", database_id: "d1", database_title: "Roadmap", mapping: { title: "Name" }, direction: "two_way", enabled: true, stats: {}, created_by: "u2" };
    rpc.mockResolvedValue({ data: row, error: null });
    const s = await takeOverNotionSync({ id: "s1", workspaceId: WS, projectId: "p1", databaseId: "d1", databaseTitle: "Roadmap", mapping: { title: "Name" }, direction: "two_way",
      enabled: true, lastRunAt: null, lastSuccessAt: null, lastError: "x", lastErrorAt: null, stats: {}, createdBy: null, createdByName: null, createdAt: "", updatedAt: "" });
    expect(rpc).toHaveBeenCalledWith("notion_save_sync", { p_ws: WS, p_project: "p1", p_database_id: "d1", p_database_title: "Roadmap", p_mapping: { title: "Name" }, p_direction: "two_way", p_enabled: true });
    expect(s.createdBy).toBe("u2");
    rpc.mockResolvedValue({ data: null, error: { message: "not allowed" } });
    expect((await fail(takeOverNotionSync(s))).reason).toBe("not_allowed");
  });
  it("a task's links with their cached page details", async () => {
    from.mockImplementation((t: string) => t === "notion_links"
      ? table({ data: [{ id: "l1", workspace_id: WS, task_id: "t1", notion_page_id: "89abcdef-0123-4567-89ab-cdef01234567", kind: "synced", created_at: "x" }], error: null })
      : table({ data: [{ notion_page_id: "89abcdef-0123-4567-89ab-cdef01234567", title: "Brief", icon: "📄", url: "https://www.notion.so/x", archived: false }], error: null }));
    const links = await listTaskNotionLinks("t1");
    expect(links[0]).toMatchObject({ kind: "synced", page: { title: "Brief", icon: "📄" } });
  });
  it("links: a bad URL never leaves the browser; refusals map to sentences", async () => {
    expect((await fail(linkNotionPage("t1", "https://example.com/x"))).message).toBe(NOTION_COPY.invalidLink);
    expect(invoke).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: { message: "link not found" } });
    expect((await fail(unlinkNotionPage("l1"))).reason).toBe("not_found");
    rpc.mockResolvedValue({ data: null, error: { message: "notion links need a team task" } });
    expect((await fail(unlinkNotionPage("l1"))).message).toBe(NOTION_COPY.teamOnly);
  });
});
