// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  accessOfKey, API_KEY_RE, API_RATE, authenticate, bearerToken, hitRate, looksLikeApiKey, methodAllowed, rateHeaders,
  isScopeMissing, rateKey, rowToPrincipal, rpcVerifier, SCOPE_MISSING, scopeFor, sha256Hex, sqlVerifier,
} from "./auth.ts";
import type { ApiPrincipal, Tx } from "./types.ts";

// a key exactly as create_api_key() makes it (captured from the 0046 PGlite run)
const READ_KEY = "kanbo_pk_G6V69SndWErk4HgPZh10jg2WURvdp-MjLekw7j-G-hs";
const WRITE_KEY = "kanbo_sk_" + READ_KEY.slice(9);
const U = "bbbbbbbb-0000-4000-8000-000000000002", W = "11111111-0000-4000-8000-000000000001", K = "9c78f0f3-412c-4a1f-b393-3124631da302";
const principal: ApiPrincipal = { keyId: K, userId: U, workspaceId: null, access: "read" };
const headers = (h: Record<string, string>) => new Headers(h);

describe("key shapes", () => {
  it("recognises both kinds and their access", () => {
    expect(looksLikeApiKey(READ_KEY)).toBe(true);
    expect(accessOfKey(READ_KEY)).toBe("read");
    expect(accessOfKey(WRITE_KEY)).toBe("write");
    expect(API_KEY_RE.source).toContain("{43}");
  });
  it("refuses anything else", () => {
    for (const k of ["", "kanbo_sk_short", READ_KEY + "x", "kanbo_xx_" + READ_KEY.slice(9), "sk_live_" + "a".repeat(43), `kanbo_sk_${"a".repeat(42)}!`, null, 42]) {
      expect(looksLikeApiKey(k)).toBe(false);
    }
    expect(accessOfKey("nope")).toBeNull();
  });
});

describe("bearerToken", () => {
  it("reads Bearer in any case, trimmed", () => {
    expect(bearerToken(headers({ Authorization: `Bearer ${READ_KEY}` }))).toBe(READ_KEY);
    expect(bearerToken(headers({ authorization: `  bearer   ${READ_KEY}  ` }))).toBe(READ_KEY);
  });
  it("null for missing / other schemes / extra words", () => {
    expect(bearerToken(headers({}))).toBeNull();
    expect(bearerToken(headers({ Authorization: `Basic ${READ_KEY}` }))).toBeNull();
    expect(bearerToken(headers({ Authorization: `Bearer a b` }))).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("is plain SHA-256 hex (what api_key_digest stores)", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(READ_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("rowToPrincipal", () => {
  it("maps verify_api_key's row", () => {
    expect(rowToPrincipal({ key_id: K, user_id: U, workspace_id: W, access: "write" })).toEqual({ keyId: K, userId: U, workspaceId: W, access: "write" });
    expect(rowToPrincipal({ key_id: K, user_id: U, workspace_id: null, access: "read" })?.workspaceId).toBeNull();
  });
  it("refuses malformed rows", () => {
    expect(rowToPrincipal(undefined)).toBeNull();
    expect(rowToPrincipal({ key_id: "x", user_id: U, access: "read" })).toBeNull();
    expect(rowToPrincipal({ key_id: K, user_id: U, workspace_id: "W", access: "read" })).toBeNull();
    expect(rowToPrincipal({ key_id: K, user_id: U, access: "admin" })).toBeNull();
  });
});

describe("authenticate", () => {
  const verify = vi.fn(async (k: string) => (k === READ_KEY ? principal : null));
  it("401s without a key, with a non-key, with an unknown key", async () => {
    const a = await authenticate(headers({}), verify);
    expect(a).toMatchObject({ ok: false, status: 401, code: "unauthorized" });
    const b = await authenticate(headers({ Authorization: "Bearer eyJhbGciOi.jwt.token" }), verify);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.message).toMatch(/kanbo_sk_/);
    const c = await authenticate(headers({ Authorization: `Bearer ${WRITE_KEY}` }), verify);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.message).toMatch(/revoked|expired/);
  });
  it("never sends a non-key to the database", async () => {
    verify.mockClear();
    await authenticate(headers({ Authorization: "Bearer nope" }), verify);
    expect(verify).not.toHaveBeenCalled();
  });
  it("returns the principal for a valid key", async () => {
    expect(await authenticate(headers({ Authorization: `Bearer ${READ_KEY}` }), verify)).toEqual({ ok: true, principal });
  });
});

describe("what a key may do", () => {
  it("read keys: GET / HEAD / OPTIONS only", () => {
    for (const m of ["GET", "head", "OPTIONS"]) expect(methodAllowed(principal, m)).toBe(true);
    for (const m of ["POST", "PATCH", "DELETE", "put"]) expect(methodAllowed(principal, m)).toBe(false);
    for (const m of ["POST", "PATCH", "DELETE"]) expect(methodAllowed({ ...principal, access: "write" }, m)).toBe(true);
  });
  it("scopeFor: the key's user, its workspace, read-only for reads", () => {
    expect(scopeFor(principal, "GET")).toEqual({ userId: U, workspaceId: null, readOnly: true });
    expect(scopeFor({ ...principal, access: "write", workspaceId: W }, "GET").readOnly).toBe(true);
    expect(scopeFor({ ...principal, access: "write", workspaceId: W }, "PATCH")).toEqual({ userId: U, workspaceId: W, readOnly: false });
    expect(scopeFor(principal, "POST").readOnly).toBe(true); // a read key never gets a writable transaction
  });
});

describe("verifiers", () => {
  it("sqlVerifier calls verify_api_key with the key as a parameter", async () => {
    const calls: unknown[][] = [];
    const tx: Tx = { query: async (text, params) => { calls.push([text, params]); return [{ key_id: K, user_id: U, workspace_id: null, access: "read" }] as never; } };
    expect(await sqlVerifier(tx)(READ_KEY)).toEqual(principal);
    expect(calls).toEqual([["select * from public.verify_api_key($1)", [READ_KEY]]]);
    expect(await sqlVerifier(tx)("not a key")).toBeNull();
    expect(calls.length).toBe(1);
  });
  it("rpcVerifier posts to PostgREST with the service key", async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify([{ key_id: K, user_id: U, workspace_id: null, access: "read" }]), { status: 200 }));
    const v = rpcVerifier("https://abc.supabase.co/", "service-key", f as unknown as typeof fetch);
    expect(await v(READ_KEY)).toEqual(principal);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://abc.supabase.co/rest/v1/rpc/verify_api_key");
    expect(JSON.parse(String(init?.body))).toEqual({ p_key: READ_KEY });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer service-key");
    const empty = rpcVerifier("https://abc.supabase.co", "k", (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch);
    expect(await empty(READ_KEY)).toBeNull();
    const broken = rpcVerifier("https://abc.supabase.co", "k", (async () => new Response("x", { status: 500 })) as unknown as typeof fetch);
    await expect(broken(READ_KEY)).rejects.toThrow(/500/);
  });
  it("team keys switched off (the scope policies are missing) is told apart from a database failure", async () => {
    const raised = Object.assign(new Error("api key scope incomplete: run 0046_api_webhooks_notion.sql again"), { code: "P0001" });
    const sql = sqlVerifier({ query: async () => { throw raised; } });
    const err = await sql(WRITE_KEY).catch((e) => e);
    expect(isScopeMissing(err)).toBe(true);
    expect(isScopeMissing(new Error("connection refused"))).toBe(false);
    expect(isScopeMissing(null)).toBe(false);
    const rpc = rpcVerifier("https://abc.supabase.co", "k", (async () => new Response(JSON.stringify({ code: "P0001", message: raised.message }), { status: 400 })) as unknown as typeof fetch);
    expect(isScopeMissing(await rpc(WRITE_KEY).catch((e) => e))).toBe(true);
    expect(SCOPE_MISSING).toBe("api key scope incomplete");
  });
});

describe("rate limits", () => {
  it("uses api_rate_hit with the key's id, 120 a minute", async () => {
    const calls: unknown[][] = [];
    const tx: Tx = { query: async (text, params) => { calls.push([text, params]); return [{ allowed: true, remaining: 119, retry_after: 0 }] as never; } };
    expect(await hitRate(tx, principal)).toEqual({ allowed: true, remaining: 119, retryAfter: 0, limit: 120 });
    expect(calls[0]).toEqual(["select * from public.api_rate_hit($1, $2, $3)", [`kanbo:api:${K}`, 60, 120]]);
    expect(rateKey(principal)).toBe(`kanbo:api:${K}`);
    expect(API_RATE).toEqual({ windowSec: 60, max: 120 });
  });
  it("over the limit: Retry-After", async () => {
    const tx: Tx = { query: async () => [{ allowed: false, remaining: 0, retry_after: 17 }] as never };
    const r = await hitRate(tx, principal);
    expect(r.allowed).toBe(false);
    expect(rateHeaders(r)).toEqual({ "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "0", "Retry-After": "17" });
  });
  it("fails open if the database can't count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx: Tx = { query: async () => { throw new Error("boom"); } };
    expect((await hitRate(tx, principal)).allowed).toBe(true);
    warn.mockRestore();
  });
});
