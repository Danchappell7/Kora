// @vitest-environment node
// The request edges of the notion function (the full flows run against
// Postgres in the PGlite replay: scratchpad/pgtest-a3).
import { describe, expect, it } from "vitest";
import { CORS, handleNotionRequest, safeEq, type HandlerDeps } from "./notionHandler.ts";
import type { Tx } from "./api/types.ts";

function deps(over: Partial<HandlerDeps> = {}, sql: string[] = []): HandlerDeps {
  const tx: Tx = {
    query: async (text: string) => {
      sql.push(text);
      if (/user_can_act/.test(text)) return [{ ok: true }] as never[];
      if (/api_rate_hit/.test(text)) return [{ allowed: true, retry_after: 0 }] as never[];
      return [] as never[];
    },
  };
  return {
    db: { service: tx, withUser: async (_scope, fn) => fn(tx) },
    notion: () => { throw new Error("Notion shouldn't be asked"); },
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    log: () => {},
    authUser: async () => null,
    cronSecret: "s3cret",
    ...over,
  };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://x.supabase.co/functions/v1/notion", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const read = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null), cors: r.headers.get("access-control-allow-origin") });

describe("notion function: the edges", () => {
  it("answers the browser's preflight; refuses other methods", async () => {
    const pre = await handleNotionRequest(new Request("https://x/functions/v1/notion", { method: "OPTIONS" }), deps());
    expect(pre.status).toBe(200);
    expect(pre.headers.get("access-control-allow-methods")).toBe(CORS["Access-Control-Allow-Methods"]);
    expect((await read(await handleNotionRequest(new Request("https://x/functions/v1/notion"), deps()))).status).toBe(405);
  });
  it("signed out → 401 with a sentence, before the database is asked", async () => {
    const sql: string[] = [];
    const r = await read(await handleNotionRequest(post({ action: "test", workspaceId: crypto.randomUUID() }), deps({}, sql)));
    expect(r).toMatchObject({ status: 401, cors: "*", body: { reason: "not_allowed", error: "Sign in to use Notion." } });
    expect(sql).toEqual([]);
  });
  it("junk and over-size bodies", async () => {
    expect((await read(await handleNotionRequest(post("{nope"), deps()))).status).toBe(400);
    expect((await read(await handleNotionRequest(post("[1,2]"), deps()))).status).toBe(400);
    expect((await read(await handleNotionRequest(post("x".repeat(70_000)), deps()))).status).toBe(413);
  });
  it("the scheduled run needs the exact cron secret (and one being set)", async () => {
    const sql: string[] = [];
    expect((await handleNotionRequest(post({ mode: "sync" }, { "x-cron-secret": "nope" }), deps({}, sql))).status).toBe(401);
    expect((await handleNotionRequest(post({ mode: "sync" }, { "x-cron-secret": "" }), deps({ cronSecret: "" }, sql))).status).toBe(401);
    expect((await handleNotionRequest(post({ mode: "other" }, { "x-cron-secret": "s3cret" }), deps({}, sql))).status).toBe(400);
    expect(sql).toEqual([]);
    const ok = await read(await handleNotionRequest(post({ mode: "sync" }, { "x-cron-secret": "s3cret" }), deps({}, sql)));
    expect(ok).toMatchObject({ status: 200, body: { ok: true, due: 0, ran: 0 } });
    expect(sql.some((s) => /notion_syncs/.test(s))).toBe(true);
  });
  it("a signed-in person with an unknown action, or a bad workspace", async () => {
    const d = deps({ authUser: async () => "aaaaaaaa-0000-4000-8000-000000000001" });
    expect((await read(await handleNotionRequest(post({ action: "nope" }, { Authorization: "Bearer jwt" }), d))).status).toBe(400);
    const r = await read(await handleNotionRequest(post({ action: "databases", workspaceId: "personal" }, { Authorization: "Bearer jwt" }), d));
    expect(r).toMatchObject({ status: 400, body: { reason: "invalid" } });
  });
  it("a suspended or unapproved person is refused before anything else", async () => {
    const sql: string[] = [];
    const d = deps({ authUser: async () => "aaaaaaaa-0000-4000-8000-000000000001" }, sql);
    d.db.service.query = async (text: string) => { sql.push(text); return (/user_can_act/.test(text) ? [{ ok: false }] : []) as never[]; };
    const r = await read(await handleNotionRequest(post({ action: "databases", workspaceId: crypto.randomUUID() }, { Authorization: "Bearer jwt" }), d));
    expect(r).toMatchObject({ status: 403, body: { reason: "not_allowed" } });
    expect(sql.filter((s) => !/user_can_act/.test(s))).toEqual([]);
  });
  it("Project access: a database that syncs with a project the caller can't see is never shown or imported (Notion isn't asked)", async () => {
    const ws = crypto.randomUUID();
    const sql: string[] = [];
    const answer = (hidden: boolean | null) => async (text: string) => {
      sql.push(text);
      if (/user_can_act/.test(text)) return [{ ok: true }] as never[];
      if (/api_rate_hit/.test(text)) return [{ allowed: true, retry_after: 0 }] as never[];
      if (/notion_status/.test(text)) return [{ s: { connected: true, can_manage: true, can_link: true, workspace_name: null } }] as never[];
      if (/notion_token/.test(text)) return [{ t: "secret_" + "x".repeat(30) }] as never[];
      if (/to_regprocedure/.test(text)) return [{ on: hidden !== null }] as never[];
      if (/user_notion_database_hidden/.test(text)) return [{ hidden }] as never[];
      return [] as never[];
    };
    const tx: Tx = { query: answer(true) };
    const d = deps({ authUser: async () => "aaaaaaaa-0000-4000-8000-000000000001", db: { service: tx, withUser: async (_s, fn) => fn(tx) } });
    const databaseId = "0123456789abcdef0123456789abcdef";
    for (const body of [{ action: "schema" }, { action: "preview" },
                        { action: "import", projectId: crypto.randomUUID(), keepInSync: true, mapping: { title: "Name" } },
                        { action: "import", projectId: crypto.randomUUID(), keepInSync: false, mapping: { title: "Name" } }]) {
      const r = await read(await handleNotionRequest(post({ ...body, workspaceId: ws, databaseId }, { Authorization: "Bearer jwt" }), d));
      expect(r, body.action).toMatchObject({ status: 403, body: { reason: "not_allowed", error: "This Notion database's pages are tasks in a project here that you can't see, so it can't be previewed or imported." } });
    }
    expect(sql.some((x) => /user_notion_database_hidden/.test(x))).toBe(true);
    // (before 0058: nothing to ask, and Notion is asked as before)
    const tx0: Tx = { query: answer(null) };
    let asked = 0;
    const d0 = deps({ authUser: async () => "aaaaaaaa-0000-4000-8000-000000000001", db: { service: tx0, withUser: async (_s, fn) => fn(tx0) },
      notion: () => ({ query: async () => { asked++; return { results: [], has_more: false, next_cursor: null }; } }) as never });
    const r0 = await read(await handleNotionRequest(post({ action: "preview", workspaceId: ws, databaseId }, { Authorization: "Bearer jwt" }), d0));
    expect([r0.status, asked]).toEqual([200, 1]);
  });
  it("Project access on: nothing of Notion comes into a Members only or Private project. An import into one, or a page linked to one of its tasks, is refused with its sentence before Notion is asked; the database's own refusal reads as its hint", async () => {
    const ws = crypto.randomUUID();
    const task = crypto.randomUUID();
    const project = crypto.randomUUID();
    const sql: string[] = [];
    let shut = true;
    let linkErr: unknown = null;
    const tx: Tx = {
      query: async (text: string) => {
        sql.push(text);
        if (/user_can_act/.test(text)) return [{ ok: true }] as never[];
        if (/api_rate_hit/.test(text)) return [{ allowed: true, retry_after: 0 }] as never[];
        if (/notion_status/.test(text)) return [{ s: { connected: true, can_manage: true, can_link: true, workspace_name: null } }] as never[];
        if (/notion_token/.test(text)) return [{ t: "secret_" + "x".repeat(30) }] as never[];
        if (/to_regprocedure/.test(text)) return [{ on: true }] as never[];
        if (/user_notion_database_hidden/.test(text)) return [{ hidden: false }] as never[];
        if (/as shut/.test(text)) return [{ shut }] as never[];
        if (/from public\.tasks where id/.test(text)) return [{ ws, project }] as never[];
        if (/notion_link_page/.test(text)) { if (linkErr) throw linkErr; return [{ l: { id: "l1" } }] as never[]; }
        return [] as never[];
      },
    };
    let asked = 0;
    const d = deps({
      authUser: async () => "aaaaaaaa-0000-4000-8000-000000000001", db: { service: tx, withUser: async (_s, fn) => fn(tx) },
      notion: () => ({
        page: async () => { asked++; return { object: "page", id: "89abcdef-0123-4567-89ab-cdef01234567", properties: {}, url: "https://www.notion.so/x" }; },
        database: async () => { asked++; throw new Error("not this"); },
      }) as never,
    });
    const auth = { Authorization: "Bearer jwt" };
    const imp = await read(await handleNotionRequest(post({ action: "import", workspaceId: ws, databaseId: "0123456789abcdef0123456789abcdef", projectId: project,
      keepInSync: true, mapping: { title: "Name" } }, auth), d));
    expect(imp).toMatchObject({ status: 409, body: { reason: "invalid", error: "Members only and Private projects don't connect to Notion yet. Choose a Whole workspace project." } });
    const link = await read(await handleNotionRequest(post({ action: "link_page", taskId: task, url: "https://www.notion.so/x-89abcdef0123456789abcdef01234567" }, auth), d));
    expect(link).toMatchObject({ status: 409, body: { reason: "invalid",
      error: "Members only and Private projects don't connect to Notion yet. Make this project Whole workspace to link Notion pages to its tasks." } });
    expect(asked).toBe(0);
    expect(sql.some((x) => /notion_link_page/.test(x))).toBe(false);
    // (the project narrowed after that check: the database's refusal, its hint as the sentence)
    shut = false;
    linkErr = Object.assign(new Error("notion closed project"), { code: "P0001", hint: "Members only and Private projects don't connect to Notion yet. Make this project Whole workspace to link Notion pages to its tasks." });
    const late = await read(await handleNotionRequest(post({ action: "link_page", taskId: task, url: "https://www.notion.so/x-89abcdef0123456789abcdef01234567" }, auth), d));
    expect(late).toMatchObject({ status: 409, body: { reason: "invalid", error: "Members only and Private projects don't connect to Notion yet. Make this project Whole workspace to link Notion pages to its tasks." } });
    linkErr = Object.assign(new Error("notion closed project"), { code: "P0001" });
    const bare = await read(await handleNotionRequest(post({ action: "link_page", taskId: task, url: "https://www.notion.so/x-89abcdef0123456789abcdef01234567" }, auth), d));
    expect(bare).toMatchObject({ status: 409, body: { error: "Members only and Private projects don't connect to Notion yet." } });
  });
  it("constant-time comparison", () => {
    expect(safeEq("abc", "abc")).toBe(true);
    expect(safeEq("abc", "abd")).toBe(false);
    expect(safeEq("abc", "abcd")).toBe(false);
    expect(safeEq("", "")).toBe(true);
  });
});
