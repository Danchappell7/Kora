// @vitest-environment node
/* The uptime health check: four checks side by side, each with its own
   timeout, an honest 200/503, nothing secret in the answer. */
import { describe, it, expect, vi } from "vitest";
import { HEALTH_TIMEOUT_MS } from "./health";
import {
  createHealthCache, handleHealthRequest, runHealthChecks, timedCheck, HealthProbeError,
  HEALTH_STORAGE_BUCKET, type HealthDeps, type HealthFetch,
} from "./healthCheck";

const URL_ = "https://ref.supabase.co";
const SERVICE = "eyJservice.role.key-SECRET";
const ANON = "eyJanon.key";
const ENV = { supabaseUrl: URL_, serviceKey: SERVICE, anonKey: ANON };
const CLOCK = () => new Date("2026-10-09T09:00:00.000Z");

type Route = (init: RequestInit) => Response | Promise<Response> | "hang" | "throw";
function fakeFetch(routes: Partial<Record<"db" | "auth" | "storage", Route>> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: HealthFetch = (url, init) => {
    calls.push({ url, init });
    const key = url.includes("/rest/v1/rpc/kanbo_health") ? "db" : url.includes("/auth/v1/health") ? "auth" : url.includes("/storage/v1/bucket/") ? "storage" : null;
    const def: Record<string, Route> = {
      db: () => Response.json({ ok: true, time: "2026-10-09T09:00:00Z", schema: "0047" }),
      auth: () => Response.json({ version: "v2", name: "GoTrue" }),
      storage: () => Response.json({ id: HEALTH_STORAGE_BUCKET, public: false }),
    };
    const r = (key && (routes[key] ?? def[key]))?.(init);
    if (!r) return Promise.reject(new Error("no route " + url));
    if (r === "throw") return Promise.reject(new TypeError("error sending request: connection refused"));
    if (r === "hang") {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return Promise.resolve(r);
  };
  return { f, calls };
}
const deps = (over: Partial<HealthDeps> = {}, routes?: Parameters<typeof fakeFetch>[0]): HealthDeps & { calls: { url: string; init: RequestInit }[] } => {
  const { f, calls } = fakeFetch(routes);
  return { env: ENV, fetch: f, clock: CLOCK, ...over, calls };
};

describe("runHealthChecks", () => {
  it("is ok when every check answers, with timings and the schema version", async () => {
    const d = deps();
    const r = await runHealthChecks(d);
    expect(r.ok).toBe(true);
    expect(r.schema).toBe("0047");
    expect(r.time).toBe("2026-10-09T09:00:00.000Z");
    for (const k of ["db", "auth", "storage", "functions"] as const) {
      expect(r[k].ok).toBe(true);
      expect(r[k].error).toBeNull();
      expect(typeof r[k].ms).toBe("number");
    }
    // the db check is the service-role rpc; auth uses the public key; storage reads the attachments bucket
    const db = d.calls.find((c) => c.url === `${URL_}/rest/v1/rpc/kanbo_health`)!;
    expect(db.init.method).toBe("POST");
    expect((db.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SERVICE}`);
    const auth = d.calls.find((c) => c.url === `${URL_}/auth/v1/health`)!;
    expect((auth.init.headers as Record<string, string>).apikey).toBe(ANON);
    expect(d.calls.some((c) => c.url === `${URL_}/storage/v1/bucket/task-files`)).toBe(true);
  });

  it("names a failing check in a few words, never its body", async () => {
    const r = await runHealthChecks(deps({}, {
      db: () => new Response(JSON.stringify({ message: "relation x does not exist", hint: SERVICE }), { status: 500 }),
      storage: () => new Response("Bucket not found", { status: 404 }),
    }));
    expect(r.ok).toBe(false);
    expect(r.db).toMatchObject({ ok: false, error: "HTTP 500" });
    expect(r.storage).toMatchObject({ ok: false, error: "HTTP 404" });
    expect(r.auth.ok).toBe(true);
    expect(r.functions.ok).toBe(true);
    expect(r.schema).toBeNull();
    const text = JSON.stringify(r);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("relation");
    expect(text).not.toContain("Bucket not found");
  });

  it("treats an unexpected database answer as a failure", async () => {
    const notOk = await runHealthChecks(deps({}, { db: () => Response.json({ ok: false }) }));
    expect(notOk.db).toMatchObject({ ok: false, error: "bad answer" });
    const notJson = await runHealthChecks(deps({}, { db: () => new Response("<html>", { status: 200 }) }));
    expect(notJson.db).toMatchObject({ ok: false, error: "bad answer" });
    const oddSchema = await runHealthChecks(deps({}, { db: () => Response.json({ ok: true, schema: "<script>" }) }));
    expect(oddSchema.db.ok).toBe(true);
    expect(oddSchema.schema).toBeNull();
  });

  it("times a hung check out on its own, without holding the others", async () => {
    const t0 = Date.now();
    const r = await runHealthChecks(deps({ timeoutMs: 60 }, { auth: () => "hang" }));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.auth).toMatchObject({ ok: false, error: "timeout" });
    expect(r.db.ok).toBe(true);
    expect(r.storage.ok).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("says unreachable when the connection fails", async () => {
    const r = await runHealthChecks(deps({}, { storage: () => "throw" }));
    expect(r.storage).toMatchObject({ ok: false, error: "unreachable" });
  });

  it("says not configured (and calls nothing) without the injected keys", async () => {
    const d = deps({ env: { supabaseUrl: null, serviceKey: null, anonKey: null } });
    const r = await runHealthChecks(d);
    expect(r.ok).toBe(false);
    expect(r.db).toEqual({ ok: false, ms: null, error: "not configured" });
    expect(r.auth).toEqual({ ok: false, ms: null, error: "not configured" });
    expect(r.storage).toEqual({ ok: false, ms: null, error: "not configured" });
    expect(d.calls).toHaveLength(0);
    // the anon key is optional: auth falls back to the service key
    const d2 = deps({ env: { supabaseUrl: URL_ + "/", serviceKey: SERVICE, anonKey: null } });
    const r2 = await runHealthChecks(d2);
    expect(r2.ok).toBe(true);
    expect(d2.calls.every((c) => !c.url.includes("co//"))).toBe(true);
  });

  it("uses the shared default timeout", () => {
    expect(HEALTH_TIMEOUT_MS).toBe(3000);
  });
});

describe("timedCheck", () => {
  it("reports how long it took and a probe's own words", async () => {
    let t = 100;
    const now = () => t;
    const ok = await timedCheck(async () => { t += 42; return { schema: "0047" }; }, { timeoutMs: 1000, now });
    expect(ok).toEqual({ ok: true, ms: 42, error: null, schema: "0047" });
    const bad = await timedCheck(async () => { t += 5; throw new HealthProbeError("HTTP 502"); }, { timeoutMs: 1000, now });
    expect(bad).toEqual({ ok: false, ms: 5, error: "HTTP 502" });
    const odd = await timedCheck(async () => { throw new Error("internal detail"); }, { timeoutMs: 1000, now });
    expect(odd.error).toBe("unreachable");
  });
});

describe("handleHealthRequest", () => {
  it("answers 200 with the report and no-store headers", async () => {
    const res = await handleHealthRequest(new Request("https://x/functions/v1/health"), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, schema: "0047", functions: { ok: true } });
  });

  it("answers 503 (with Retry-After) and logs which checks failed", async () => {
    const log = vi.fn();
    const res = await handleHealthRequest(new Request("https://x/health"), { ...deps({}, { db: () => new Response("", { status: 503 }) }), log });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect((await res.json()).ok).toBe(false);
    expect(log).toHaveBeenCalledWith("[health] degraded: db=HTTP 503");
  });

  it("handles HEAD, CORS preflight and wrong methods", async () => {
    const head = await handleHealthRequest(new Request("https://x/health", { method: "HEAD" }), deps());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const pre = await handleHealthRequest(new Request("https://x/health", { method: "OPTIONS" }), deps());
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    const post = await handleHealthRequest(new Request("https://x/health", { method: "POST", body: "{}" }), deps());
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("shares one round of checks between requests in the same few seconds", async () => {
    const d = deps();
    const cache = createHealthCache(5000);
    await Promise.all([1, 2, 3].map(() => handleHealthRequest(new Request("https://x/health"), { ...d, cache })));
    expect(d.calls.filter((c) => c.url.includes("kanbo_health"))).toHaveLength(1);
    cache.clear();
    await handleHealthRequest(new Request("https://x/health"), { ...d, cache });
    expect(d.calls.filter((c) => c.url.includes("kanbo_health"))).toHaveLength(2);
  });

  it("expires a cached report", async () => {
    const cache = createHealthCache(1000);
    const run = vi.fn(async () => ({ ok: true } as never));
    await cache.get(run, 0);
    await cache.get(run, 999);
    expect(run).toHaveBeenCalledTimes(1);
    await cache.get(run, 1000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
