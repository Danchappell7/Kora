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
  it("constant-time comparison", () => {
    expect(safeEq("abc", "abc")).toBe(true);
    expect(safeEq("abc", "abd")).toBe(false);
    expect(safeEq("abc", "abcd")).toBe(false);
    expect(safeEq("", "")).toBe(true);
  });
});
