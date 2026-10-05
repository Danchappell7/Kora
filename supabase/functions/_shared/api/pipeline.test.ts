// @vitest-environment node
// The request pipeline with fake keys, a fake database and fake routes:
// authentication, rate limits, read-only keys, bodies, idempotency, ETags,
// error mapping and the transaction scope every handler gets. (The real
// handlers against the real migrations: scratchpad/pgtest-a1 in PGlite.)
import { describe, expect, it, vi } from "vitest";
import { ApiFail, etagFor, ok } from "./core.ts";
import { etagMatches, handleApiRequest, type ApiDeps } from "./pipeline.ts";
import { coreRoutes } from "./routes.ts";
import type { Route, RouteContext } from "./router.ts";
import type { ApiPrincipal, Tx, UserScope } from "./types.ts";

const BASE = "https://ref.supabase.co/functions/v1/api/v1";
const W = "11111111-0000-4000-8000-000000000001";
const KEYS: Record<string, ApiPrincipal> = {
  ["kanbo_sk_" + "w".repeat(43)]: { keyId: "aaaaaaaa-0000-4000-8000-000000000001", userId: "bbbbbbbb-0000-4000-8000-000000000001", workspaceId: null, access: "write" },
  ["kanbo_pk_" + "r".repeat(43)]: { keyId: "aaaaaaaa-0000-4000-8000-000000000002", userId: "bbbbbbbb-0000-4000-8000-000000000001", workspaceId: null, access: "read" },
  ["kanbo_sk_" + "t".repeat(43)]: { keyId: "aaaaaaaa-0000-4000-8000-000000000003", userId: "bbbbbbbb-0000-4000-8000-000000000001", workspaceId: W, access: "write" },
};
const WRITE = "kanbo_sk_" + "w".repeat(43), READ = "kanbo_pk_" + "r".repeat(43), TEAM = "kanbo_sk_" + "t".repeat(43);

function setup(routes?: Route[], opts: { rateAllowed?: boolean; verifyThrows?: boolean; finishFailures?: number } = {}) {
  const scopes: UserScope[] = [];
  const idem = new Map<string, { hash: string; status: number; response: unknown; committed?: boolean; applied?: boolean }>();
  const serviceCalls: string[] = [];
  /** statements run inside a user transaction (only the idempotency commit mark is allowed) */
  const txCalls: { text: string; params: readonly unknown[]; scope: UserScope }[] = [];
  let finishFailures = opts.finishFailures ?? 0;
  const service: Tx = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      serviceCalls.push(text);
      if (text.includes("api_rate_hit")) {
        return [{ allowed: opts.rateAllowed !== false, remaining: opts.rateAllowed === false ? 0 : 119, retry_after: opts.rateAllowed === false ? 17 : 0 }] as T[];
      }
      if (text.includes("api_idempotency_begin")) {
        const [keyId, k, hash] = params as string[];
        const row = idem.get(`${keyId}:${k}`);
        if (!row) { idem.set(`${keyId}:${k}`, { hash, status: 0, response: null }); return [{ b: { state: "new" } }] as T[]; }
        if (row.hash !== hash) return [{ b: { state: "mismatch" } }] as T[];
        if (row.status === 0) return [{ b: JSON.stringify({ state: row.applied ? "applied" : "in_progress" }) }] as T[];
        return [{ b: { state: "replay", status: row.status, response: row.response } }] as T[];
      }
      if (text.includes("api_idempotency_finish")) {
        if (finishFailures > 0) { finishFailures--; throw new Error("connection reset"); }
        const [keyId, k, status, response] = params as [string, string, number, string];
        if (status >= 500) { if (!idem.get(`${keyId}:${k}`)?.committed) idem.delete(`${keyId}:${k}`); }
        else idem.set(`${keyId}:${k}`, { ...idem.get(`${keyId}:${k}`)!, status, response: JSON.parse(response) });
        return [] as T[];
      }
      throw new Error("unexpected service query: " + text);
    },
  };
  const db = {
    withUser: vi.fn(async <T,>(scope: UserScope, fn: (tx: Tx) => Promise<T>) => {
      scopes.push(scope);
      return fn({
        query: async <R,>(text: string, params: readonly unknown[] = []): Promise<R[]> => {
          if (!text.includes("api_idempotency_commit")) throw new Error("the fake routes don't query");
          txCalls.push({ text, params, scope });
          const [keyId, k] = params as string[];
          const row = idem.get(`${keyId}:${k}`);
          if (row) row.committed = true;
          return [];
        },
      });
    }),
  };
  const logs: unknown[][] = [];
  const deps: ApiDeps = {
    db, service, appUrl: "https://www.kanbo.co.uk", apiBase: BASE, routes,
    verify: async (k) => { if (opts.verifyThrows) throw new Error("db down"); return KEYS[k] ?? null; },
    log: (...a) => logs.push(a),
    sleep: async () => {},
  };
  const call = async (key: string | null, method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers };
    if (body !== undefined && !("Content-Type" in h)) h["Content-Type"] = "application/json";
    const res = await handleApiRequest(new Request(`${BASE}${path}`, { method, headers: h, body }), deps);
    const text = await res.text();
    return { res, status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  return { call, scopes, idem, logs, db, serviceCalls, txCalls };
}

let made = 0;
const routes: Route[] = [
  { method: "GET", path: "/echo", handler: async (ctx: RouteContext) => ctx.db.withUser({ userId: ctx.principal.userId, workspaceId: ctx.principal.workspaceId, readOnly: true }, async () => ok(ctx, { hello: "there", n: 1 })) },
  { method: "POST", path: "/things", handler: async (ctx) => { made++; return ok(ctx, { id: `thing-${made}`, body: ctx.body, again: await ctx.req.json().catch(() => "no body") }, 201, { Location: `${BASE}/things/${made}` }); } },
  { method: "PATCH", path: "/things/:id", handler: async (ctx) => ok(ctx, { id: ctx.params.id, body: ctx.body }) },
  { method: "POST", path: "/fail", handler: async () => { throw new ApiFail(422, "validation_failed", "Some fields need attention.", { fields: { title: "Give the task a title." } }); } },
  { method: "GET", path: "/rls", handler: async () => { throw Object.assign(new Error("new row violates row-level security policy for table \"tasks\""), { code: "42501" }); } },
  { method: "GET", path: "/dupe", handler: async () => { throw Object.assign(new Error("duplicate key value"), { code: "23505" }); } },
  { method: "GET", path: "/boom", handler: async () => { throw Object.assign(new Error("syntax error at or near \"selec\" in select * from secret_table"), { code: "42601" }); } },
  { method: "POST", path: "/boom", handler: async () => { throw new Error("kaput"); } },
  // writes in a transaction as the user (like the real handlers)
  { method: "POST", path: "/tx", handler: async (ctx) => ctx.db.withUser({ userId: ctx.principal.userId, workspaceId: ctx.principal.workspaceId }, async () => ok(ctx, { id: `tx-${++made}` }, 201)) },
  // the work commits, then the connection drops before the handler sees it
  { method: "POST", path: "/tx-lost", handler: async (ctx) => { await ctx.db.withUser({ userId: ctx.principal.userId }, async () => null); throw new Error("connection lost after COMMIT"); } },
];

const isError = (j: { error?: { code?: string; status?: number; requestId?: string } }, status: number, code: string) =>
  j?.error?.code === code && j.error.status === status && /^req_[0-9a-f]{16}$/.test(j.error.requestId ?? "");

describe("who is calling", () => {
  it("401 without a key, with a malformed or unknown key", async () => {
    const { call } = setup(routes);
    for (const key of [null, "nope", "kanbo_sk_" + "z".repeat(43)]) {
      const r = await call(key, "GET", "/echo");
      expect(r.status).toBe(401);
      expect(isError(r.json, 401, "unauthorized")).toBe(true);
      expect(r.res.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
    }
  });
  it("503 (not 401) when the key can't be checked", async () => {
    const { call, logs } = setup(routes, { verifyThrows: true });
    const r = await call(WRITE, "GET", "/echo");
    expect(r.status).toBe(503);
    expect(r.res.headers.get("Retry-After")).toBe("5");
    expect(logs.length).toBe(1);
  });
  it("429 over the rate limit, with Retry-After and the X-RateLimit headers", async () => {
    const { call, db } = setup(routes, { rateAllowed: false });
    const r = await call(WRITE, "GET", "/echo");
    expect(r.status).toBe(429);
    expect(isError(r.json, 429, "rate_limited")).toBe(true);
    expect(r.res.headers.get("Retry-After")).toBe("17");
    expect(r.res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(db.withUser).not.toHaveBeenCalled();
  });
});

describe("routing", () => {
  it("every answer carries the request id and rate headers; no CORS", async () => {
    const { call } = setup(routes);
    const r = await call(WRITE, "GET", "/echo");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ hello: "there", n: 1 });
    expect(r.res.headers.get("X-Request-Id")).toMatch(/^req_/);
    expect(r.res.headers.get("X-RateLimit-Limit")).toBe("120");
    expect(r.res.headers.get("X-RateLimit-Remaining")).toBe("119");
    expect(r.res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(r.res.headers.get("Content-Type")).toContain("application/json");
  });
  it("404 off the base and for unknown endpoints; 405 with Allow", async () => {
    const { call } = setup(routes);
    const off = await handleApiRequest(new Request("https://ref.supabase.co/functions/v1/api/v2/echo"), {} as ApiDeps);
    expect(off.status).toBe(404);
    expect((await call(WRITE, "GET", "/nope")).status).toBe(404);
    const r = await call(WRITE, "DELETE", "/things/1");
    expect(r.status).toBe(405);
    expect(r.res.headers.get("Allow")).toBe("PATCH");
  });
  it("refuses browsers' preflight (no CORS on purpose)", async () => {
    const { call } = setup(routes);
    const r = await call(null, "OPTIONS", "/things");
    expect(r.status).toBe(405);
    expect(r.res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(r.res.headers.get("Allow")).toBe("POST");
  });
  it("the OpenAPI document and GET / need no key", async () => {
    const { call } = setup(routes);
    const doc = await call(null, "GET", "/openapi.json");
    expect(doc.status).toBe(200);
    expect(doc.json.servers[0].url).toBe(BASE);
    expect(doc.res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect((await call(null, "GET", "/")).json.openapi).toBe(`${BASE}/openapi.json`);
  });
  it("mounts the core routes and the webhook routes by default", async () => {
    const { call } = setup();
    expect((await call(WRITE, "PUT", "/tasks")).res.headers.get("Allow")).toBe("GET, POST");
    expect(coreRoutes.length).toBeGreaterThanOrEqual(17);
  });
});

describe("keys and transactions", () => {
  it("a read-only key can't write (before the handler runs)", async () => {
    const { call } = setup(routes);
    const before = made;
    for (const [m, p] of [["POST", "/things"], ["PATCH", "/things/1"]]) {
      const r = await call(READ, m, p, "{}");
      expect(r.status).toBe(403);
      expect(isError(r.json, 403, "forbidden")).toBe(true);
      expect(r.json.error.message).toMatch(/read-only/);
    }
    expect(made).toBe(before);
    expect((await call(READ, "GET", "/echo")).status).toBe(200);
  });
  it("handlers get the key's user and workspace", async () => {
    const { call, scopes } = setup(routes);
    await call(TEAM, "GET", "/echo");
    expect(scopes[0]).toEqual({ userId: KEYS[TEAM].userId, workspaceId: W, readOnly: true });
  });
  it("the real handlers open read-only transactions for GETs and validate before touching the database", async () => {
    const { call, scopes, db } = setup();
    const r = await call(WRITE, "POST", "/tasks", JSON.stringify({ title: "", due_date: "2026-01-01" }));
    expect(r.status).toBe(422);
    expect(r.json.error.details.fields).toHaveProperty("title");
    expect(r.json.error.details.fields.due_date).toMatch(/dueDate/);
    expect(db.withUser).not.toHaveBeenCalled();
    const g = await call(TEAM, "GET", "/tasks?workspace=personal");
    expect(g.status).toBe(403);
    expect(db.withUser).not.toHaveBeenCalled();
    const bad = await call(WRITE, "GET", "/tasks/not-an-id");
    expect(bad.status).toBe(404);
    expect(scopes).toEqual([]);
  });
});

describe("bodies", () => {
  it("JSON objects only, under 64 KB", async () => {
    const { call } = setup(routes);
    expect((await call(WRITE, "POST", "/things", "{oops")).json.error.code).toBe("invalid_body");
    expect((await call(WRITE, "POST", "/things", "[1]")).json.error.code).toBe("invalid_body");
    expect((await call(WRITE, "POST", "/things", "null")).json.error.code).toBe("invalid_body");
    const form = await call(WRITE, "POST", "/things", "a=1", { "Content-Type": "application/x-www-form-urlencoded" });
    expect(form.status).toBe(415);
    const big = await call(WRITE, "POST", "/things", JSON.stringify({ x: "y".repeat(70_000) }));
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("payload_too_large");
  });
  it("an empty body is {}; the handler can still read req.json()", async () => {
    const { call } = setup(routes);
    expect((await call(WRITE, "POST", "/things")).json.body).toEqual({});
    const r = await call(WRITE, "POST", "/things", JSON.stringify({ a: 1 }), { "Content-Type": "application/json; charset=utf-8" });
    expect(r.status).toBe(201);
    expect(r.json.body).toEqual({ a: 1 });
    expect(r.json.again).toEqual({ a: 1 });
  });
});

describe("idempotency", () => {
  it("the same key replays the first answer, with its Location", async () => {
    const { call } = setup(routes);
    const h = { "Idempotency-Key": "abc-123" };
    const a = await call(WRITE, "POST", "/things", JSON.stringify({ n: 1 }), h);
    const b = await call(WRITE, "POST", "/things", JSON.stringify({ n: 1 }), h);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.id).toBe(a.json.id);
    expect(b.res.headers.get("Idempotent-Replayed")).toBe("true");
    expect(b.res.headers.get("Location")).toBe(a.res.headers.get("Location"));
  });
  it("a different request with the same key: 422; still running: 409", async () => {
    const { call, idem } = setup(routes);
    const h = { "Idempotency-Key": "k1" };
    await call(WRITE, "POST", "/things", JSON.stringify({ n: 1 }), h);
    const r = await call(WRITE, "POST", "/things", JSON.stringify({ n: 2 }), h);
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("idempotency_mismatch");
    const [k] = [...idem.keys()];
    idem.set(k, { ...idem.get(k)!, status: 0 });
    const busy = await call(WRITE, "POST", "/things", JSON.stringify({ n: 1 }), h);
    expect(busy.status).toBe(409);
    expect(busy.json.error.code).toBe("idempotency_in_progress");
  });
  it("a 5xx is forgotten (the retry runs); bad keys are refused; GET / PATCH ignore it", async () => {
    const { call, idem, serviceCalls } = setup(routes);
    const r = await call(WRITE, "POST", "/boom", "{}", { "Idempotency-Key": "k2" });
    expect(r.status).toBe(500);
    expect(idem.size).toBe(0);
    expect((await call(WRITE, "POST", "/things", "{}", { "Idempotency-Key": " " })).status).toBe(400);
    expect((await call(WRITE, "POST", "/things", "{}", { "Idempotency-Key": "x".repeat(256) })).status).toBe(400);
    const before = serviceCalls.filter((t) => t.includes("idempotency")).length;
    await call(WRITE, "PATCH", "/things/1", "{}", { "Idempotency-Key": "k3" });
    expect(serviceCalls.filter((t) => t.includes("idempotency")).length).toBe(before);
  });
});

describe("idempotency: committed work never runs twice", () => {
  it("the handler's transaction marks the key committed as its last statement (POST with a key only)", async () => {
    const { call, txCalls } = setup(routes);
    const r = await call(TEAM, "POST", "/tx", "{}", { "Idempotency-Key": "c-1" });
    expect(r.status).toBe(201);
    expect(txCalls).toHaveLength(1);
    expect(txCalls[0].text).toMatch(/select public\.api_idempotency_commit\(\$1::uuid, \$2\)/);
    expect(txCalls[0].params).toEqual([KEYS[TEAM].keyId, "c-1"]);
    expect(txCalls[0].scope).toMatchObject({ workspaceId: W });
    await call(TEAM, "POST", "/tx", "{}");
    await call(TEAM, "GET", "/echo", undefined, { "Idempotency-Key": "c-2" });
    expect(txCalls).toHaveLength(1);
  });
  it("storing the answer is retried; when it never works the request still answers and it's logged", async () => {
    const once = setup(routes, { finishFailures: 1 });
    const a = await once.call(WRITE, "POST", "/tx", "{}", { "Idempotency-Key": "f-1" });
    const b = await once.call(WRITE, "POST", "/tx", "{}", { "Idempotency-Key": "f-1" });
    expect(b.json.id).toBe(a.json.id);
    expect(b.res.headers.get("Idempotent-Replayed")).toBe("true");
    expect(once.logs).toHaveLength(0);
    const never = setup(routes, { finishFailures: 99 });
    const c = await never.call(WRITE, "POST", "/tx", "{}", { "Idempotency-Key": "f-2" });
    expect(c.status).toBe(201);
    expect(never.serviceCalls.filter((t) => t.includes("api_idempotency_finish"))).toHaveLength(3);
    expect(never.logs.some((l) => l[0] === "error" && /idempotent answer/.test(String(l[1])))).toBe(true);
    const busy = await never.call(WRITE, "POST", "/tx", "{}", { "Idempotency-Key": "f-2" });
    expect(busy.json.error.code).toBe("idempotency_in_progress");
  });
  it("a 5xx after the work committed keeps the key; 'applied' answers 409 conflict", async () => {
    const { call, idem } = setup(routes);
    const r = await call(WRITE, "POST", "/tx-lost", "{}", { "Idempotency-Key": "l-1" });
    expect(r.status).toBe(500);
    const [k] = [...idem.keys()];
    expect(idem.get(k)).toMatchObject({ status: 0, committed: true });
    idem.set(k, { ...idem.get(k)!, applied: true });
    const again = await call(WRITE, "POST", "/tx-lost", "{}", { "Idempotency-Key": "l-1" });
    expect(again.status).toBe(409);
    expect(isError(again.json, 409, "conflict")).toBe(true);
    expect(again.json.error.details).toEqual({ idempotency: "applied" });
  });
});

describe("caching", () => {
  it("weak ETags; If-None-Match → 304; HEAD has no body", async () => {
    const { call } = setup(routes);
    const a = await call(WRITE, "GET", "/echo");
    const etag = a.res.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]{16}"$/);
    expect(a.res.headers.get("Cache-Control")).toBe("private, no-cache");
    const b = await call(WRITE, "GET", "/echo", undefined, { "If-None-Match": `"x", ${etag}` });
    expect(b.status).toBe(304);
    expect(b.text).toBe("");
    const head = await call(WRITE, "HEAD", "/echo");
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(head.res.headers.get("ETag")).toBe(etag);
    // the ETag a write's If-Match is checked against is exactly GET's
    expect(await etagFor({ hello: "there", n: 1 })).toBe(etag);
  });
  it("etagMatches", () => {
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches("*", 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"abd", W/"abe"', 'W/"abc"')).toBe(false);
    expect(etagMatches('"x", W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches("", 'W/"abc"')).toBe(false);
  });
});

describe("errors", () => {
  it("handled failures keep their code and details", async () => {
    const { call } = setup(routes);
    const r = await call(WRITE, "POST", "/fail", "{}");
    expect(r.status).toBe(422);
    expect(r.json.error).toMatchObject({ code: "validation_failed", details: { fields: { title: "Give the task a title." } } });
  });
  it("Postgres errors are mapped and never echoed", async () => {
    const { call, logs } = setup(routes);
    expect((await call(WRITE, "GET", "/rls")).json.error.code).toBe("forbidden");
    expect((await call(WRITE, "GET", "/dupe")).status).toBe(409);
    const boom = await call(WRITE, "GET", "/boom");
    expect(boom.status).toBe(500);
    expect(isError(boom.json, 500, "internal")).toBe(true);
    expect(boom.text).not.toMatch(/secret_table|selec/);
    expect(logs.some((l) => String(l[1]).includes(boom.json.error.requestId))).toBe(true);
  });
});
