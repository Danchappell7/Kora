// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { NotionApiError, notionApi, resetNotionPacing, retryAfterSeconds } from "./notionApi.ts";

const TOKEN = "ntn_" + "A1b2C3d4".repeat(5);
const ID = "89abcdef-0123-4567-89ab-cdef01234567";
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "throw";

function harness(replies: Reply[]) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const seen: { url: string; init: RequestInit }[] = [];
  const http = {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const r = replies.shift() ?? { status: 200, body: {} };
      if (r === "throw") throw new TypeError("fetch failed: https://api.notion.com/v1/… " );
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
    },
  };
  return { http, sleeps, seen, advance: (ms: number) => { t += ms; } };
}
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as NotionApiError; } throw new Error("expected a failure"); };

beforeEach(() => resetNotionPacing());

describe("notionApi", () => {
  it("sends the version and the token as a bearer (never in the URL)", async () => {
    const h = harness([{ status: 200, body: { id: "bot", bot: { workspace_name: "Acme" } } }]);
    const me = await notionApi(TOKEN, h.http).me();
    expect(me.bot?.workspace_name).toBe("Acme");
    const { url, init } = h.seen[0];
    expect(url).toBe("https://api.notion.com/v1/users/me");
    expect((init.headers as Record<string, string>)["Notion-Version"]).toBe("2022-06-28");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(url).not.toContain(TOKEN);
    expect(init.redirect).toBe("error");
  });
  it("paces requests with one token about 3 a second", async () => {
    const h = harness([]);
    const api = notionApi(TOKEN, h.http);
    await api.page(ID); await api.page(ID); await api.page(ID);
    expect(h.sleeps).toEqual([340, 340]);
    expect(api.calls).toBe(3);
    // another token isn't held up
    await notionApi("ntn_" + "Z9".repeat(15), h.http).page(ID);
    expect(h.sleeps).toEqual([340, 340]);
  });
  it("waits out a 429 (Retry-After) and tries again", async () => {
    const h = harness([{ status: 429, body: { code: "rate_limited" }, headers: { "retry-after": "2" } }, { status: 200, body: { id: ID } }]);
    const p = await notionApi(TOKEN, h.http).page(ID);
    expect(p.id).toBe(ID);
    expect(h.sleeps).toContain(2000);
  });
  it("gives up on a 429 that would outlast the deadline", async () => {
    const h = harness([{ status: 429, body: { code: "rate_limited" }, headers: { "retry-after": "30" } }]);
    const e = await fail(notionApi(TOKEN, { ...h.http, deadline: h.http.now() + 5_000 }).page(ID));
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfter).toBe(30);
  });
  it("retries 5xx and network errors twice", async () => {
    const h = harness([{ status: 502 }, { status: 503 }, { status: 200, body: { id: ID } }]);
    expect((await notionApi(TOKEN, h.http).page(ID)).id).toBe(ID);
    const h2 = harness([{ status: 500 }, { status: 500 }, { status: 500 }]);
    expect((await fail(notionApi(TOKEN, h2.http).page(ID))).kind).toBe("unavailable");
    const h3 = harness(["throw", "throw", "throw"]);
    const e = await fail(notionApi(TOKEN, h3.http).page(ID));
    expect(e.kind).toBe("network");
    expect(e.message).not.toContain("https://");
  });
  it("names the failures", async () => {
    const kind = async (r: Reply) => (await fail(notionApi(TOKEN, harness([r]).http).page(ID))).kind;
    expect(await kind({ status: 401, body: { code: "unauthorized", message: "API token is invalid." } })).toBe("invalid_token");
    expect(await kind({ status: 404, body: { code: "object_not_found" } })).toBe("not_shared");
    expect(await kind({ status: 403, body: { code: "restricted_resource" } })).toBe("not_shared");
    expect(await kind({ status: 400, body: { code: "validation_error", message: "Can't edit block that is archived." } })).toBe("archived");
    expect(await kind({ status: 400, body: { code: "validation_error", message: "bad" } })).toBe("validation");
  });
  it("stops at the deadline, and refuses ids that aren't ids before asking", async () => {
    const h = harness([]);
    const api = notionApi(TOKEN, { ...h.http, deadline: h.http.now() - 1 });
    expect((await fail(api.page(ID))).kind).toBe("timeout");
    expect((await fail(notionApi(TOKEN, harness([]).http).page("../users"))).kind).toBe("validation");
    expect(h.seen).toHaveLength(0);
  });
  it("builds the search and query bodies", async () => {
    const h = harness([{ status: 200, body: { results: [], has_more: false, next_cursor: null } }, { status: 200, body: { results: [] } }, { status: 200, body: {} }]);
    const api = notionApi(TOKEN, h.http);
    await api.searchDatabases("  roadmap  ", "bad cursor!");
    expect(JSON.parse(String(h.seen[0].init.body))).toEqual({ query: "roadmap", filter: { property: "object", value: "database" }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100 });
    await api.users("abc-123");
    expect(h.seen[1].url).toBe("https://api.notion.com/v1/users?page_size=100&start_cursor=abc-123");
    await api.updatePage(ID, { Name: { title: [] } });
    expect(h.seen[2].init.method).toBe("PATCH");
    expect(JSON.parse(String(h.seen[2].init.body))).toEqual({ properties: { Name: { title: [] } } });
  });
  it("Retry-After in seconds or as a date", () => {
    expect(retryAfterSeconds(null)).toBe(1);
    expect(retryAfterSeconds("3")).toBe(3);
    expect(retryAfterSeconds(new Date(10_000 + 5_000).toUTCString(), 10_000)).toBeGreaterThanOrEqual(4);
    expect(retryAfterSeconds("soon")).toBe(1);
  });
});
