// @vitest-environment node
// The OAuth endpoints with a fake database: what they accept and how they answer.
// The rules themselves are attacked on the real migrations by the PGlite suite.
import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../api/types.ts";
import { clientIp, fetchClientDocument, handlePrepare, handleRegister, handleRevoke, handleToken, type OAuthDeps } from "./oauth.ts";
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
  const d: OAuthDeps = { service, fetch: vi.fn() as unknown as typeof fetch, verifyUser: async (j) => (j === "good" ? "user-1" : null), log: () => undefined, ...o };
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
  const code = { grant_type: "authorization_code", client_id: "c", code: "kmcp_ac_x", code_verifier: "v", redirect_uri: "https://x.example/cb" };
  const ok = { access_token: "a", token_type: "Bearer", expires_in: 3600, refresh_token: "r", scope: "kanbo.read" };

  it("passes a code to Postgres and answers with no-store", async () => {
    const { d, queries } = deps((q) => (q.text.includes("mcp_oauth_exchange_code") ? [{ r: ok }] : []));
    const res = await handleToken(form(code), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(ok);
    expect(queries.find((q) => q.text.includes("exchange"))!.params).toEqual(["kmcp_ac_x", "v", "c", "https://x.example/cb", null]);
  });
  it("passes a refresh token to Postgres", async () => {
    const { d, queries } = deps((q) => (q.text.includes("mcp_oauth_refresh") ? [{ r: ok }] : []));
    expect((await handleToken(form({ grant_type: "refresh_token", client_id: "c", refresh_token: "kmcp_rt_x", resource: MCP_RESOURCE }), d)).status).toBe(200);
    expect(queries.find((q) => q.text.includes("mcp_oauth_refresh"))!.params).toEqual(["kmcp_rt_x", "c", MCP_RESOURCE]);
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
    const { d } = deps(() => { throw new Error("boom kmcp_rt_secret"); });
    const text = await (await handleToken(form({ grant_type: "refresh_token", client_id: "c", refresh_token: "kmcp_rt_secret" }), d)).text();
    expect(text).not.toContain("secret");
  });
  it("rate limits per app, keyed by a hash", async () => {
    const seen: string[] = [];
    const { d } = deps();
    d.service.query = (async (text: string, p: unknown[]) => {
      if (text.includes("api_rate_hit")) { seen.push(String(p[0])); return [{ allowed: !String(p[0]).includes(":c:"), retry_after: 3 }]; }
      return [];
    }) as Tx["query"];
    const res = await handleToken(form({ grant_type: "refresh_token", client_id: `https://x.example/${"y".repeat(300)}`, refresh_token: "x" }), d);
    expect(res.status).toBe(429);
    expect(seen[1].length).toBeLessThan(200);
  });
});

describe("revoke", () => {
  it("answers 200 whether or not there was anything", async () => {
    const { d, queries } = deps();
    expect((await handleRevoke(form({ token: "kmcp_rt_x", client_id: "c" }), d)).status).toBe(200);
    expect(queries.find((q) => q.text.includes("mcp_oauth_revoke_token"))!.params).toEqual(["kmcp_rt_x", "c"]);
  });
  it("wants a token, in a form", async () => {
    const { d } = deps();
    expect((await handleRevoke(form({}), d)).status).toBe(400);
    expect((await handleRevoke(json({ token: "x" }), d)).status).toBe(400);
  });
});

describe("clientIp", () => {
  it("takes the first address Vercel passes on", () => {
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("fetching an app's description", () => {
  const url = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const doc = JSON.stringify({ client_id: url, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  const f = (res: Response) => vi.fn(async () => res) as unknown as typeof fetch;

  it("reads a good one, following no redirects", async () => {
    const fetchImpl = f(new Response(doc));
    expect(await fetchClientDocument(url, { fetch: fetchImpl })).toMatchObject({ ok: true, name: "Claude" });
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("GET");
  });
  it("anything but a 200 is an error, redirects included", async () => {
    for (const status of [301, 302, 404, 500]) {
      expect((await fetchClientDocument(url, { fetch: f(new Response(null, { status })) })).ok, String(status)).toBe(false);
    }
  });
  it("has a read limit", async () => {
    expect((await fetchClientDocument(url, { fetch: f(new Response("x".repeat(6000))) })).ok).toBe(false);
  });
  it("refuses bad JSON, and a network failure", async () => {
    expect((await fetchClientDocument(url, { fetch: f(new Response("nope")) })).ok).toBe(false);
    expect((await fetchClientDocument(url, { fetch: vi.fn(async () => { throw new Error("x"); }) as unknown as typeof fetch })).ok).toBe(false);
  });
  it("won't even ask a private address, or a name that resolves to one", async () => {
    const fetchImpl = f(new Response(doc));
    expect((await fetchClientDocument("https://10.0.0.1/c.json", { fetch: fetchImpl })).ok).toBe(false);
    expect((await fetchClientDocument(url, { fetch: fetchImpl, resolveHost: async () => ["93.184.216.34", "169.254.169.254"] })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("carries on when DNS can't be checked here", async () => {
    expect((await fetchClientDocument(url, { fetch: f(new Response(doc)), resolveHost: async () => null })).ok).toBe(true);
    expect((await fetchClientDocument(url, { fetch: f(new Response(doc)), resolveHost: async () => { throw new Error("no"); } })).ok).toBe(true);
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
    expect(await (await handlePrepare(json({ client_id: "x", redirect_uri: "https://x.example/" }, auth), d)).json()).toMatchObject({ ok: false, reason: "unknown_client" });
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
    const url = "https://x.example/c.json";
    const { d, queries } = deps(client({ ok: false, reason: "unknown_client" }), { fetch: vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch });
    expect(await (await handlePrepare(json({ client_id: url, redirect_uri: "https://x.example/" }, auth), d)).json()).toMatchObject({ ok: false, reason: "bad_client" });
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
