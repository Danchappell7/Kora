// ============================================================
// KANBO — the `health` edge function's logic (pure, unit-tested). [w9-ops]
//
//   GET https://<ref>.supabase.co/functions/v1/health   (verify_jwt OFF)
//   → 200 { ok: true,  db, auth, storage, functions, time, schema }
//   → 503 { ok: false, … }   when any check fails (GitHub's uptime job fails on it)
//
// The four checks run side by side, each with its own HEALTH_TIMEOUT_MS and an
// AbortController, and never throw:
//   db        POST /rest/v1/rpc/kanbo_health (service role): one cheap query (0047)
//   auth      GET  /auth/v1/health
//   storage   GET  /storage/v1/bucket/task-files (service role): the attachments bucket
//   functions this function answering at all: ok, with how long the whole check took
// The answer names nothing secret: no keys, no response bodies, no stacks — only
// "timeout", "HTTP 500", "unreachable", "bad answer" or "not configured".
// One isolate shares a report for HEALTH_CACHE_MS, so hammering the public URL costs
// Supabase one round of checks per few seconds, not one per request.
// No Deno globals, no remote imports (vitest runs it: healthCheck.test.ts).
// ============================================================
import { HEALTH_TIMEOUT_MS, type HealthCheck, type HealthReport } from "./health.ts";

/** the bucket the storage check reads (0008: attachments) */
export const HEALTH_STORAGE_BUCKET = "task-files";
/** how long one isolate reuses a report */
export const HEALTH_CACHE_MS = 5000;

export interface HealthEnv {
  supabaseUrl: string | null;
  serviceKey: string | null;
  anonKey: string | null;
}
export type HealthFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HealthDeps {
  env: HealthEnv;
  fetch: HealthFetch;
  /** per-check timeout (default HEALTH_TIMEOUT_MS) */
  timeoutMs?: number;
  /** a monotonic clock in ms (default performance.now / Date.now) */
  now?: () => number;
  /** wall clock for `time` */
  clock?: () => Date;
}

/** A failure we can name in a few words (the only text a check ever reports). */
export class HealthProbeError extends Error {}

type Probe = (signal: AbortSignal) => Promise<{ schema?: string | null } | void>;
type Timed = HealthCheck & { schema?: string | null };

const monotonic = (): number => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
const ms = (n: number): number => Math.max(0, Math.round(n));

/** Run one probe with its own timeout. Never throws. */
export async function timedCheck(probe: Probe, opts: { timeoutMs: number; now: () => number }): Promise<Timed> {
  const start = opts.now();
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { ac.abort(); resolve("timeout"); }, opts.timeoutMs);
  });
  try {
    const out = await Promise.race([probe(ac.signal).then((v) => ({ v })), timeout]);
    if (out === "timeout") return { ok: false, ms: ms(opts.now() - start), error: "timeout" };
    const schema = out.v && typeof out.v === "object" ? out.v.schema ?? null : null;
    return { ok: true, ms: ms(opts.now() - start), error: null, ...(schema !== null ? { schema } : {}) };
  } catch (e) {
    const error = e instanceof HealthProbeError ? e.message : ac.signal.aborted ? "timeout" : "unreachable";
    return { ok: false, ms: ms(opts.now() - start), error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Free a response we don't read (Deno keeps the connection otherwise). */
async function discard(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* already consumed */ }
}

const notConfigured = (): Timed => ({ ok: false, ms: null, error: "not configured" });

/** Every check, side by side; then the report. Never throws. */
export async function runHealthChecks(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now ?? monotonic;
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const started = now();
  const base = (deps.env.supabaseUrl ?? "").trim().replace(/\/+$/, "");
  const service = (deps.env.serviceKey ?? "").trim();
  const publicKey = (deps.env.anonKey ?? "").trim() || service;
  const serviceHeaders = { apikey: service, Authorization: `Bearer ${service}` };

  const db: Probe = async (signal) => {
    const res = await deps.fetch(`${base}/rest/v1/rpc/kanbo_health`, {
      method: "POST", signal,
      headers: { ...serviceHeaders, "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    if (!res.ok) { await discard(res); throw new HealthProbeError(`HTTP ${res.status}`); }
    let body: unknown;
    try { body = await res.json(); } catch { throw new HealthProbeError("bad answer"); }
    const o = body && typeof body === "object" ? body as Record<string, unknown> : null;
    if (!o || o.ok !== true) throw new HealthProbeError("bad answer");
    const schema = typeof o.schema === "string" && /^[0-9A-Za-z_.-]{1,16}$/.test(o.schema) ? o.schema : null;
    return { schema };
  };
  const auth: Probe = async (signal) => {
    const res = await deps.fetch(`${base}/auth/v1/health`, { method: "GET", signal, headers: { apikey: publicKey } });
    await discard(res);
    if (!res.ok) throw new HealthProbeError(`HTTP ${res.status}`);
  };
  const storage: Probe = async (signal) => {
    const res = await deps.fetch(`${base}/storage/v1/bucket/${HEALTH_STORAGE_BUCKET}`, { method: "GET", signal, headers: serviceHeaders });
    await discard(res);
    if (!res.ok) throw new HealthProbeError(`HTTP ${res.status}`);
  };

  const opts = { timeoutMs, now };
  const [dbR, authR, storageR] = await Promise.all([
    base && service ? timedCheck(db, opts) : Promise.resolve(notConfigured()),
    base && publicKey ? timedCheck(auth, opts) : Promise.resolve(notConfigured()),
    base && service ? timedCheck(storage, opts) : Promise.resolve(notConfigured()),
  ]);
  const functions: HealthCheck = { ok: true, ms: ms(now() - started), error: null };
  const strip = ({ ok, ms: t, error }: Timed): HealthCheck => ({ ok, ms: t, error: error ?? null });
  return {
    ok: dbR.ok && authR.ok && storageR.ok && functions.ok,
    db: strip(dbR),
    auth: strip(authR),
    storage: strip(storageR),
    functions,
    time: (deps.clock ? deps.clock() : new Date()).toISOString(),
    schema: dbR.schema ?? null,
  };
}

/** One isolate's shared report: concurrent and back-to-back requests within `ttlMs` reuse it. */
export function createHealthCache(ttlMs = HEALTH_CACHE_MS) {
  let entry: { at: number; report: Promise<HealthReport> } | null = null;
  return {
    get(run: () => Promise<HealthReport>, now: number = Date.now()): Promise<HealthReport> {
      if (entry && now - entry.at < ttlMs) return entry.report;
      const report = run();
      entry = { at: now, report };
      // a run that somehow rejects isn't kept
      report.catch(() => { if (entry?.report === report) entry = null; });
      return report;
    },
    clear() { entry = null; },
  };
}
export type HealthCache = ReturnType<typeof createHealthCache>;

export const HEALTH_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

/** The whole request: OPTIONS (CORS), GET/HEAD (the report; 200 or 503), anything else 405. */
export async function handleHealthRequest(
  req: Request,
  deps: HealthDeps & { cache?: HealthCache; log?: (line: string) => void },
): Promise<Response> {
  const base = { ...HEALTH_CORS, "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: base });
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405, headers: { ...base, Allow: "GET, HEAD, OPTIONS", "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const run = () => runHealthChecks(deps);
  let report: HealthReport;
  try {
    report = await (deps.cache ? deps.cache.get(run) : run());
  } catch {
    // runHealthChecks doesn't throw; this is belt and braces
    report = {
      ok: false, time: new Date().toISOString(), schema: null,
      db: { ok: false, ms: null, error: "unreachable" }, auth: { ok: false, ms: null, error: "unreachable" },
      storage: { ok: false, ms: null, error: "unreachable" }, functions: { ok: true, ms: null, error: null },
    };
  }
  if (!report.ok && deps.log) {
    const failing = (["db", "auth", "storage", "functions"] as const).filter((k) => !report[k].ok).map((k) => `${k}=${report[k].error ?? "failed"}`);
    deps.log(`[health] degraded: ${failing.join(" ")}`);
  }
  const status = report.ok ? 200 : 503;
  const headers: Record<string, string> = { ...base, "Content-Type": "application/json; charset=utf-8" };
  if (!report.ok) headers["Retry-After"] = "30";
  return new Response(req.method === "HEAD" ? null : JSON.stringify(report), { status, headers });
}
