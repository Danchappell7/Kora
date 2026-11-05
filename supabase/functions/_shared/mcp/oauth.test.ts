// @vitest-environment node
// The OAuth endpoints with a fake database: what they accept and how they answer.
// The rules themselves are attacked on the real migrations by the PGlite suite.
import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../api/types.ts";
import { CANT_READ_DESCRIPTION, fetchClientDocument, handlePrepare, handleRegister, handleRevoke, handleToken, registerLimits, type OAuthDeps } from "./oauth.ts";
import { MCP_RESOURCE } from "./metadata.ts";

type Q = { text: string; params: readonly unknown[] };

function deps(answer: (q: Q) => unknown = () => [], o: Partial<OAuthDeps> = {}) {
  const queries: Q[] = [];
  const service: Tx = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      queries.push({ text, params });
      if (text.includes("api_rate_hit")) return [{ allowed: true, remaining: 1, retry_after: 0 }] as T[];
      return answer({ text, params }) as T[];
    },
  };
  const d: OAuthDeps = { service, fetch: vi.fn() as unknown as typeof fetch, resolve: async () => ["93.184.216.34"], verifyUser: async (j) => (j === "good" ? "user-1" : null), log: () => undefined, ...o };
  return { d, queries };
}
const form = (o: Record<string, string>, h: Record<string, string> = {}) =>
  new Request("https://f/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...h }, body: new URLSearchParams(o).toString() });
const json = (o: unknown, h: Record<string, string> = {}) =>
  new Request("https://f/oauth/x", { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(o) });
const missingFn = () => { throw Object.assign(new Error("function public.mcp_oauth_refresh does not exist"), { code: "42883" }); };

describe("register", () => {
  it("answers 201 with no secret, whatever the app asked for", async () => {
    const { d, queries } = deps((q) => (q.text.includes("mcp_oauth_register_client") ? [{ r: { client_id: "kmcp_client_x", client_id_issued_at: 123, client_name: "App", redirect_uris: ["https://x.example/cb"] } }] : []));
    const res = await handleRegister(json({ client_name: "App", redirect_uris: ["https://x.example/cb"], grant_types: ["urn:ietf:params:oauth:grant-type:jwt-bearer"], token_endpoint_auth_method: "client_secret_post" }), d);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ client_id: "kmcp_client_x", client_id_issued_at: 123, client_name: "App", redirect_uris: ["https://x.example/cb"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    expect(body).not.toHaveProperty("client_secret");
    // the array goes as JSON: postgres.js can't bind a JS array in unsafe()
    expect(queries.find((q) => q.text.includes("mcp_oauth_register_client"))!.params[2]).toBe(`["https://x.example/cb"]`);
  });
  it("refuses bad input in OAuth's words", async () => {
    const { d } = deps();
    expect(await (await handleRegister(json({ redirect_uris: ["javascript:alert(1)"] }), d)).json()).toMatchObject({ error: "invalid_redirect_uri" });
    expect((await handleRegister(json({}), d)).status).toBe(400);
    expect(await (await handleRegister(new Request("https://f", { method: "POST", headers: { "Content-Type": "application/json" }, body: "nope" }), d)).json()).toMatchObject({ error: "invalid_client_metadata" });
    expect(await (await handleRegister(new Request("https://f", { method: "POST", body: "x" }), d)).json()).toMatchObject({ error: "invalid_client_metadata" });
    expect((await handleRegister(json({ client_name: "x".repeat(20000), redirect_uris: ["https://x.example/"] }), d)).status).toBe(413);
  });
  it("is rate limited per address and overall", async () => {
    const { d } = deps();
    d.service.query = (async (text: string) => (text.includes("api_rate_hit") ? [{ allowed: false, remaining: 0, retry_after: 42 }] : [])) as Tx["query"];
    const res = await handleRegister(json({ redirect_uris: ["https://x.example/"] }), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
  });
  it("counts nothing, and writes nothing, for a request that wouldn't be stored", async () => {
    for (const bad of [
      new Request("https://f", { method: "POST", headers: { "Content-Type": "application/json" }, body: "garbage" }),
      json({}),
      json({ redirect_uris: ["javascript:alert(1)"] }),
      json({ redirect_uris: Array(9).fill("https://x.example/") }),
      json({ redirect_uris: [`https://x.example/${"a".repeat(600)}`] }),
    ]) {
      const { d, queries } = deps();
      expect((await handleRegister(bad, d)).status).toBe(400);
      expect(queries).toEqual([]);
    }
  });
  it("the overall cap only counts what's about to be stored", async () => {
    const { d, queries } = deps((q) => (q.text.includes("register_client") ? [{ r: { client_id: "c" } }] : []));
    await handleRegister(json({ redirect_uris: ["https://x.example/"] }, { "cf-connecting-ip": "203.0.113.9" }), d);
    const keys = queries.filter((q) => q.text.includes("api_rate_hit")).map((q) => String(q.params[0]));
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe("kanbo:mcp:register:all");
  });
  it("a rate-limit failure doesn't lock people out", async () => {
    const { d } = deps();
    d.service.query = (async (text: string) => {
      if (text.includes("api_rate_hit")) throw new Error("down");
      return [{ r: { client_id: "c", client_id_issued_at: 1, client_name: "n", redirect_uris: [] } }];
    }) as Tx["query"];
    expect((await handleRegister(json({ redirect_uris: ["https://x.example/"] }), d)).status).toBe(201);
  });
  it("says so plainly before 0050 is in", async () => {
    const { d } = deps(missingFn);
    const res = await handleRegister(json({ redirect_uris: ["https://x.example/"] }), d);
    expect(res.status).toBe(503);
    expect((await res.json()).error_description).toMatch(/isn't switched on/);
  });
});

describe("token", () => {
  const AC = `kmcp_ac_${"a".repeat(43)}`, RT = `kmcp_rt_${"r".repeat(43)}`;
  const code = { grant_type: "authorization_code", client_id: "c", code: AC, code_verifier: "v", redirect_uri: "https://x.example/cb" };
  const ok = { access_token: "a", token_type: "Bearer", expires_in: 3600, refresh_token: "r", scope: "kanbo.read" };

  it("passes a code to Postgres and answers with no-store", async () => {
    const { d, queries } = deps((q) => (q.text.includes("mcp_oauth_exchange_code") ? [{ r: ok }] : []));
    const res = await handleToken(form(code), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(ok);
    expect(queries.find((q) => q.text.includes("exchange"))!.params).toEqual([AC, "v", "c", "https://x.example/cb", null]);
  });
  it("passes a refresh token to Postgres", async () => {
    const { d, queries } = deps((q) => (q.text.includes("mcp_oauth_refresh") ? [{ r: ok }] : []));
    expect((await handleToken(form({ grant_type: "refresh_token", client_id: "c", refresh_token: RT, resource: MCP_RESOURCE }), d)).status).toBe(200);
    expect(queries.find((q) => q.text.includes("mcp_oauth_refresh"))!.params).toEqual([RT, "c", MCP_RESOURCE]);
  });
  it("Postgres's errors go out as 400s", async () => {
    const { d } = deps((q) => (q.text.includes("mcp_oauth") ? [{ r: { error: "invalid_grant", error_description: "x" } }] : []));
    const res = await handleToken(form(code), d);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
  it.each([
    ["grant type", { grant_type: "password", client_id: "c" }, "unsupported_grant_type"],
    ["no grant type", { client_id: "c" }, "unsupported_grant_type"],
    ["no client", { grant_type: "refresh_token", refresh_token: "x" }, "invalid_request"],
    ["no code", { grant_type: "authorization_code", client_id: "c" }, "invalid_request"],
    ["no refresh token", { grant_type: "refresh_token", client_id: "c" }, "invalid_request"],
    ["another server", { ...{ grant_type: "refresh_token", client_id: "c", refresh_token: "x" }, resource: "https://evil.example/mcp" }, "invalid_target"],
  ])("%s", async (_w, body, error) => {
    const { d, queries } = deps();
    const res = await handleToken(form(body as Record<string, string>), d);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(queries.some((q) => q.text.includes("mcp_oauth_"))).toBe(false);
  });
  it("a repeated parameter is refused", async () => {
    const { d } = deps();
    const res = await handleToken(new Request("https://f", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&client_id=a&client_id=b&refresh_token=x" }), d);
    expect((await res.json()).error).toBe("invalid_request");
  });
  it("wants a form", async () => {
    const { d } = deps();
    expect((await handleToken(json(code), d)).status).toBe(400);
  });
  it("never echoes a token in an error", async () => {
    const { d } = deps(() => { throw new Error(`boom ${RT}`); });
    const text = await (await handleToken(form({ grant_type: "refresh_token", client_id: "c", refresh_token: RT }), d)).text();
    expect(text).not.toContain(RT);
  });
  it("a stranger can't use up anything: no limit is counted before the code or token has been checked", async () => {
    const { d, queries } = deps((q) => (q.text.includes("mcp_oauth_") ? [{ r: { error: "invalid_grant", error_description: "x" } }] : []));
    const junk = await handleToken(form({ grant_type: "refresh_token", client_id: "claude", refresh_token: "junk" }), d);
    expect(junk.status).toBe(400);
    expect((await junk.json()).error).toBe("invalid_grant");
    expect((await handleToken(form({ ...code, code: "junk" }), d)).status).toBe(400);
    // malformed never reaches the database at all
    expect(queries).toEqual([]);
    expect((await handleToken(form({ grant_type: "refresh_token", client_id: "claude", refresh_token: RT }), d)).status).toBe(400);
    expect(queries.some((q) => q.text.includes("api_rate_hit"))).toBe(false);
  });
  it("too many refreshes of one real token slows that connection down, and says when to try again", async () => {
    const { d } = deps((q) => (q.text.includes("mcp_oauth_refresh") ? [{ r: { error: "slow_down", retry_after: 17 } }] : []));
    const res = await handleToken(form({ grant_type: "refresh_token", client_id: "c", refresh_token: RT }), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect((await res.json()).error).toBe("slow_down");
  });
});

describe("revoke", () => {
  it("answers 200 whether or not there was anything", async () => {
    const { d, queries } = deps();
    const token = `kmcp_rt_${"r".repeat(43)}`;
    expect((await handleRevoke(form({ token, client_id: "c" }), d)).status).toBe(200);
    expect(queries.find((q) => q.text.includes("mcp_oauth_revoke_token"))!.params).toEqual([token, "c"]);
    expect(queries.some((q) => q.text.includes("api_rate_hit"))).toBe(false);
  });
  it("something that can't be a token never reaches the database", async () => {
    const { d, queries } = deps();
    expect((await handleRevoke(form({ token: "junk" }), d)).status).toBe(200);
    expect(queries).toEqual([]);
  });
  it("wants a token, in a form", async () => {
    const { d } = deps();
    expect((await handleRevoke(form({}), d)).status).toBe(400);
    expect((await handleRevoke(json({ token: "x" }), d)).status).toBe(400);
  });
});

describe("who a registration counts against", () => {
  const keys = async (h: Record<string, string>) => (await registerLimits(new Headers(h))).map((l) => l.key);
  it("never a header a direct caller can set on its own", async () => {
    const one = await keys({ "cf-connecting-ip": "203.0.113.9", "x-vercel-forwarded-for": "1.1.1.1" });
    const two = await keys({ "cf-connecting-ip": "203.0.113.9", "x-vercel-forwarded-for": "2.2.2.2" });
    // changing the header makes a new pair, but the address the edge saw stays the same, so it runs out
    expect(one[0]).toBe(two[0]);
    expect(one[1]).not.toBe(two[1]);
    // naming someone else's address reaches a different bucket from theirs
    const them = await keys({ "cf-connecting-ip": "76.76.21.21", "x-vercel-forwarded-for": "160.79.104.10" });
    const namingThem = await keys({ "cf-connecting-ip": "203.0.113.9", "x-vercel-forwarded-for": "160.79.104.10" });
    expect(namingThem[1]).not.toBe(them[1]);
    expect(namingThem[0]).not.toBe(them[0]);
  });
  it("the first hop of x-forwarded-for stands in for Vercel's own header, and buys nothing more", async () => {
    const one = await keys({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1, 203.0.113.9" });
    const two = await keys({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "9.9.9.9, 203.0.113.9" });
    expect(one[0]).toBe(two[0]);
    expect(one[1]).not.toBe(two[1]);
    expect(one[1]).toBe((await keys({ "cf-connecting-ip": "203.0.113.9", "x-vercel-forwarded-for": "1.1.1.1" }))[1]);
  });
  it("addresses are stored as hashes", async () => {
    for (const k of await keys({ "cf-connecting-ip": "203.0.113.9", "x-vercel-forwarded-for": "1.1.1.1" })) {
      expect(k).toMatch(/^kanbo:mcp:register:[pc]:[0-9a-f]{32}$/);
    }
  });
  it("no address at all: only the overall cap", async () => {
    expect(await registerLimits(new Headers({ "x-vercel-forwarded-for": "1.1.1.1" }))).toEqual([]);
  });
  it("the last hop is the one that counts when there's no edge header", async () => {
    const one = await keys({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" });
    expect(one[0]).toBe((await keys({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" }))[0]);
    expect(one[0]).not.toBe((await keys({ "x-forwarded-for": "1.1.1.1, 203.0.113.10" }))[0]);
  });
});

describe("fetching an app's description", () => {
  const url = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const doc = JSON.stringify({ client_id: url, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  const f = (res: Response) => vi.fn(async () => res) as unknown as typeof fetch;
  const pub = async () => ["93.184.216.34"];
  const refused = { ok: false, reason: CANT_READ_DESCRIPTION };

  it("reads a good one, following no redirects", async () => {
    const fetchImpl = f(new Response(doc));
    expect(await fetchClientDocument(url, { fetch: fetchImpl, resolve: pub })).toMatchObject({ ok: true, name: "Claude" });
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("GET");
  });
  it("goes to the address it checked, when it's given a way to", async () => {
    const seen: unknown[] = [];
    const getDocument = vi.fn(async (t) => { seen.push(t); return { status: 200, text: doc }; });
    expect((await fetchClientDocument(url, { fetch: f(new Response("no")), resolve: pub, getDocument })).ok).toBe(true);
    expect(seen[0]).toMatchObject({ address: "93.184.216.34", host: "claude.ai", port: 443, path: "/oauth/mcp-oauth-client-metadata" });
  });
  it("tries a second address only if the first never connected", async () => {
    const both = async () => ["93.184.216.34", "93.184.216.35"];
    const connect = vi.fn(async () => { throw Object.assign(new Error("refused"), { kind: "connect" }); });
    expect(await fetchClientDocument(url, { fetch: f(new Response("no")), resolve: both, getDocument: connect })).toEqual(refused);
    expect(connect).toHaveBeenCalledTimes(2);
    const later = vi.fn(async () => { throw Object.assign(new Error("reset"), { kind: "network" }); });
    await fetchClientDocument(url, { fetch: f(new Response("no")), resolve: both, getDocument: later });
    expect(later).toHaveBeenCalledTimes(1);
  });
  it("every failure reads the same, so it can't probe a network", async () => {
    const answers: (typeof fetch)[] = [
      f(new Response(null, { status: 301 })), f(new Response(null, { status: 302 })), f(new Response("x", { status: 404 })), f(new Response("x", { status: 500 })),
      f(new Response("x".repeat(6000))), f(new Response("nope")), f(new Response("[]")),
      f(new Response(JSON.stringify({ client_id: "https://other.example/x", client_name: "x", redirect_uris: ["https://x.example/"] }))),
      f(new Response(JSON.stringify({ client_id: url, redirect_uris: ["https://x.example/"] }))),
      vi.fn(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
    ];
    for (const fetchImpl of answers) expect(await fetchClientDocument(url, { fetch: fetchImpl, resolve: pub })).toEqual(refused);
  });
  it("says what really went wrong in the log, by host only", async () => {
    const log = vi.fn();
    await fetchClientDocument(url, { fetch: f(new Response("x", { status: 404 })), resolve: pub, log });
    expect(log.mock.calls[0][1]).toEqual({ host: "claude.ai", why: "HTTP 404" });
  });
  it("won't even ask a private address, or a name that resolves to one", async () => {
    const fetchImpl = f(new Response(doc));
    expect((await fetchClientDocument("https://10.0.0.1/c.json", { fetch: fetchImpl, resolve: pub })).ok).toBe(false);
    expect(await fetchClientDocument(url, { fetch: fetchImpl, resolve: async () => ["93.184.216.34", "169.254.169.254"] })).toEqual(refused);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["fec0::1", "2002:7f00:1::", "2002:a00:1::", "2001:0:a00:1::", "3fff::1", "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:0:0:1", "::1", "::ffff:10.0.0.1", "10.0.0.1", "not an address"])("refuses a name that resolves to %s", async (address) => {
    const fetchImpl = f(new Response(doc));
    expect(await fetchClientDocument(url, { fetch: fetchImpl, resolve: async () => [address] })).toEqual(refused);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    ["no answer", async () => { throw new Error("DNS failed"); }],
    ["nothing", async () => []],
  ])("fetches nothing when DNS gives %s", async (_w, resolve) => {
    const fetchImpl = f(new Response(doc));
    expect(await fetchClientDocument(url, { fetch: fetchImpl, resolve })).toEqual(refused);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("fetches nothing with no way to check DNS", async () => {
    const fetchImpl = f(new Response(doc));
    expect(await fetchClientDocument(url, { fetch: fetchImpl })).toEqual(refused);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["https://kong/client.json", "https://internal/client.json", "https://[fec0::1]/c.json", "https://[2606:4700::1111]/c.json", "https://8.8.8.8/c.json"])("refuses %s without looking it up", async (u) => {
    const resolve = vi.fn(pub);
    const fetchImpl = f(new Response(doc));
    expect((await fetchClientDocument(u, { fetch: fetchImpl, resolve })).ok).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("never Kanbo's own hosts", async () => {
    const fetchImpl = f(new Response(doc));
    const ownHosts = ["htnchiljplrnjkwimgla.supabase.co", "kanbo.co.uk"];
    for (const u of ["https://htnchiljplrnjkwimgla.supabase.co/functions/v1/notify", "https://www.kanbo.co.uk/x.json", "https://kanbo.co.uk/x.json"]) {
      expect(await fetchClientDocument(u, { fetch: fetchImpl, resolve: pub, ownHosts })).toEqual(refused);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("prepare", () => {
  const auth = { Authorization: "Bearer good" };
  const client = (r: unknown) => (q: Q) => (q.text.includes("mcp_oauth_client_check") ? [{ r }] : []);

  it("needs someone signed in", async () => {
    const { d } = deps();
    expect((await handlePrepare(json({ client_id: "c", redirect_uri: "https://x/" }), d)).status).toBe(401);
    expect((await handlePrepare(json({ client_id: "c", redirect_uri: "https://x/" }, { Authorization: "Bearer bad" }), d)).status).toBe(401);
  });
  it("describes a registered app, marking a loopback address", async () => {
    const { d } = deps(client({ ok: true, kind: "dcr", client_name: "Tool" }));
    const body = await (await handlePrepare(json({ client_id: "kmcp_client_x", redirect_uri: "http://localhost:8787/cb" }, auth), d)).json();
    expect(body).toEqual({ ok: true, client: { name: "Tool", kind: "dcr", clientHost: null, redirectHost: "localhost", loopback: true } });
    expect((d.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toEqual([]);
  });
  it("says no to an unknown app or a bad address", async () => {
    const { d } = deps(client({ ok: false, reason: "unknown_client" }));
    const unknown = await (await handlePrepare(json({ client_id: "x", redirect_uri: "https://x.example/" }, auth), d)).json();
    expect(unknown).toMatchObject({ ok: false, reason: "unknown_client" });
    // apps remember their client_id, so "start again from the app" would only send the same one
    expect(unknown.message).toMatch(/Remove Kanbo from the app and add it again/);
    const b = deps(client({ ok: false, reason: "bad_redirect", kind: "dcr" }));
    expect(await (await handlePrepare(json({ client_id: "x", redirect_uri: "https://x.example/" }, auth), b.d)).json()).toMatchObject({ ok: false, reason: "bad_redirect" });
  });
  it("fetches a document app when it's new or stale, not when it's fresh", async () => {
    const url = "https://claude.ai/oauth/mcp-oauth-client-metadata";
    const doc = JSON.stringify({ client_id: url, client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] });
    const fresh = deps(client({ ok: true, kind: "cimd", client_name: "Claude", fetched_at: new Date().toISOString() }), { fetch: vi.fn(async () => new Response(doc)) as unknown as typeof fetch });
    expect(await (await handlePrepare(json({ client_id: url, redirect_uri: "https://claude.ai/cb" }, auth), fresh.d)).json()).toMatchObject({ ok: true, client: { clientHost: "claude.ai", kind: "cimd" } });
    expect(fresh.d.fetch).not.toHaveBeenCalled();
    const stale = deps(client({ ok: true, kind: "cimd", client_name: "Claude", fetched_at: "2020-01-01T00:00:00Z" }), { fetch: vi.fn(async () => new Response(doc)) as unknown as typeof fetch });
    await handlePrepare(json({ client_id: url, redirect_uri: "https://claude.ai/cb" }, auth), stale.d);
    expect(stale.d.fetch).toHaveBeenCalledTimes(1);
    expect(stale.queries.some((q) => q.text.includes("mcp_oauth_upsert_cimd_client"))).toBe(true);
  });
  it("a bad document stops there", async () => {
    const url = "https://apps.example.org/c.json";
    const { d, queries } = deps(client({ ok: false, reason: "unknown_client" }), { fetch: vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch });
    expect(await (await handlePrepare(json({ client_id: url, redirect_uri: "https://x.example/" }, auth), d)).json()).toMatchObject({ ok: false, reason: "bad_client", message: CANT_READ_DESCRIPTION });
    expect(queries.some((q) => q.text.includes("upsert"))).toBe(false);
  });
  it("says when it isn't switched on, or can't reach the database", async () => {
    const { d } = deps(missingFn);
    const res = await handlePrepare(json({ client_id: "x", redirect_uri: "https://x.example/" }, auth), d);
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("not_ready");
    const down = deps(() => { throw new Error("down"); });
    expect((await (await handlePrepare(json({ client_id: "x", redirect_uri: "https://x.example/" }, auth), down.d)).json()).reason).toBe("unavailable");
  });
  it("wants JSON with both fields", async () => {
    const { d } = deps();
    expect((await handlePrepare(json({}, auth), d)).status).toBe(400);
    expect((await handlePrepare(new Request("https://f", { method: "POST", headers: auth, body: "x" }), d)).status).toBe(400);
  });
});
