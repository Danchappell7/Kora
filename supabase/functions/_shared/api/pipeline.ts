// ============================================================
// KANBO — public API v1: one request, start to finish (0046).    [a1]
//
//   1. request id; path under /v1 (else 404); OPTIONS → 405 (no CORS)
//   2. GET /openapi.json and GET / are public; everything else needs a key
//   3. authenticate (verify_api_key, service role) → 401
//   4. rate limit per key (120 a minute) → 429 + Retry-After; X-RateLimit-*
//      on every answer from here on
//   5. route → 404 / 405 (+ Allow); read-only key writing → 403
//   6. POST / PATCH body: JSON object, ≤ 64 KB → 415 / 413 / 400
//   7. POST + Idempotency-Key: replay the first answer for 24 hours
//      (api_idempotency_begin / _finish); a different request with the same
//      key → 422; the first still running → 409
//   8. the handler, which reads and writes ONLY as the key's user
//      (core.ts asUser → db.withUser: RLS + the key's workspace scope)
//   9. errors → { error: { code, message, status, requestId, details? } };
//      Postgres errors are mapped, never echoed; 5xx are logged with the id
//  10. GET 200 → weak ETag; If-None-Match → 304
//
// Pure module (no Deno globals): pipeline.test.ts drives it with fakes and
// the PGlite harness drives it against the real migrations. The Deno entry
// (supabase/functions/api/index.ts) only wires the database and env in.
// ============================================================
import { authenticate, hitRate, methodAllowed, rateHeaders, sha256Hex, type VerifyKey } from "./auth.ts";
import { ApiFail, pgFailure } from "./core.ts";
import { buildOpenApi } from "./openapi.ts";
import { apiError, json, matchRoute, newRequestId, stripBase, type Method, type Route, type RouteContext } from "./router.ts";
import { coreRoutes } from "./routes.ts";
import type { Tx, UserDb } from "./types.ts";
import { API_LIMITS } from "./validate.ts";
import { webhookRoutes } from "./webhooks.ts";

export interface ApiDeps {
  /** runs a request's work as the key's user (db.ts createApiDb) */
  db: UserDb;
  /** privileged connection: key verification, rate limits, idempotency only */
  service: Tx;
  verify: VerifyKey;
  /** the app's address, for `url` fields */
  appUrl: string;
  /** this API's base, e.g. https://<ref>.supabase.co/functions/v1/api/v1 */
  apiBase: string;
  /** defaults to [...coreRoutes, ...webhookRoutes] */
  routes?: readonly Route[];
  rate?: { windowSec?: number; max?: number };
  log?: (level: "error" | "warn", message: string, extra?: Record<string, unknown>) => void;
}

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E](?:[\x20-\x7E]{0,253}[\x21-\x7E])?$/;
const NO_CORS = "The Kanbo API doesn't answer browsers' cross-origin checks. Call it from a server or a script: an API key in a web page can be read by anyone.";
const UNREACHABLE = "Kanbo's API can't reach its database right now. Try again in a moment.";
const INTERNAL = "Something went wrong on Kanbo's side. Try again; if it keeps happening, send the request id to Kanbo support.";

const defaultLog: NonNullable<ApiDeps["log"]> = (level, message, extra) => {
  const line = `${message}${extra ? " " + JSON.stringify(extra) : ""}`;
  if (level === "error") console.error(line); else console.warn(line);
};

const errInfo = (e: unknown) => ({
  message: String((e as { message?: unknown })?.message ?? e).slice(0, 300),
  code: String((e as { code?: unknown })?.code ?? ""),
});

/** The body as text; null once it passes `cap` bytes; throws on invalid UTF-8. */
async function readCapped(req: Request, cap: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > cap) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

/** Does an If-None-Match header match this ETag (weak comparison)? */
export function etagMatches(header: string, etag: string): boolean {
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

/** Same response, plus the request id and any extra headers (rate limits). */
function decorate(res: Response, requestId: string, extra: Record<string, string>, stripBody = false): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Request-Id", requestId);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  const noBody = stripBody || res.status === 204 || res.status === 304;
  return new Response(noBody ? null : res.body, { status: res.status, headers });
}

/** A thrown error → the API's JSON error. */
function errorResponse(e: unknown, requestId: string, log: NonNullable<ApiDeps["log"]>): Response {
  const fail = e instanceof ApiFail ? e : pgFailure(e);
  if (fail) {
    if (fail.status >= 500) log("error", `[api] ${requestId} ${fail.code}`, errInfo(e));
    return apiError(fail.status, fail.code, fail.message, { requestId, details: fail.details, headers: fail.headers });
  }
  log("error", `[api] ${requestId} unhandled error`, errInfo(e));
  return apiError(500, "internal", INTERNAL, { requestId });
}

/** The answer to GET / (public): where the spec and the docs are. */
function hello(deps: ApiDeps) {
  return {
    object: "api",
    name: "Kanbo API",
    version: "v1",
    openapi: `${deps.apiBase.replace(/\/+$/, "")}/openapi.json`,
    docs: "Make a key and read the reference in Kanbo: Settings › Developers.",
  };
}

async function withEtag(req: Request, res: Response, cacheControl: string): Promise<Response> {
  if (res.status !== 200) return res;
  const text = await res.text();
  const etag = `W/"${(await sha256Hex(text)).slice(0, 16)}"`;
  const headers = new Headers(res.headers);
  headers.set("ETag", etag);
  headers.set("Cache-Control", cacheControl);
  const inm = req.headers.get("if-none-match");
  if (inm && etagMatches(inm, etag)) {
    headers.delete("Content-Type");
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status: 200, headers });
}

export async function handleApiRequest(req: Request, deps: ApiDeps): Promise<Response> {
  const requestId = newRequestId();
  const log = deps.log ?? defaultLog;
  const routes = deps.routes ?? [...coreRoutes, ...webhookRoutes];
  let extra: Record<string, string> = {};
  const method = req.method.toUpperCase();
  const isHead = method === "HEAD";
  const done = (res: Response) => decorate(res, requestId, extra, isHead);
  const fail = (status: number, code: Parameters<typeof apiError>[1], message: string,
    opts: { details?: Record<string, unknown>; headers?: Record<string, string> } = {}) =>
    done(apiError(status, code, message, { requestId, ...opts }));

  try {
    const url = new URL(req.url);
    const path = stripBase(url.pathname);
    if (path === null) return fail(404, "not_found", "There's nothing here. The Kanbo API lives under /v1, for example …/functions/v1/api/v1/tasks.");
    const routeMethod = isHead ? "GET" : method;

    // ---- public: the OpenAPI document and a hello ----
    if (routeMethod === "GET" && (path === "/openapi.json" || path === "/")) {
      const body = path === "/" ? hello(deps) : buildOpenApi(deps.apiBase);
      return done(await withEtag(req, json(body, 200, {}, requestId), "public, max-age=300"));
    }

    // ---- browsers' preflight: refused on purpose ----
    if (method === "OPTIONS") {
      const m = matchRoute(routes, "OPTIONS", path);
      const allow = m.kind === "method_not_allowed" ? m.allow.join(", ") : "";
      return fail(405, "method_not_allowed", NO_CORS, allow ? { headers: { Allow: allow } } : {});
    }

    // ---- who is calling ----
    let auth;
    try {
      auth = await authenticate(req.headers, deps.verify);
    } catch (e) {
      log("error", `[api] ${requestId} key verification failed`, errInfo(e));
      return fail(503, "internal", UNREACHABLE, { headers: { "Retry-After": "5" } });
    }
    if (!auth.ok) return fail(401, "unauthorized", auth.message, { headers: { "WWW-Authenticate": 'Bearer realm="Kanbo API"' } });
    const principal = auth.principal;

    // ---- rate limit (fails open inside hitRate) ----
    const rate = await hitRate(deps.service, principal, deps.rate ?? {});
    extra = rateHeaders(rate);
    if (!rate.allowed) {
      return fail(429, "rate_limited", `Too many requests: a key can make ${rate.limit} a minute. Try again in ${Math.max(1, rate.retryAfter)} seconds.`);
    }

    // ---- route ----
    const m = matchRoute(routes, routeMethod, path);
    if (m.kind === "not_found") return fail(404, "not_found", "There's no such endpoint. GET /v1/openapi.json lists them all.");
    if (m.kind === "method_not_allowed") {
      return fail(405, "method_not_allowed", `Use ${m.allow.join(" or ")} here.`, { headers: { Allow: m.allow.join(", ") } });
    }
    if (!methodAllowed(principal, method)) {
      return fail(403, "forbidden", "This key is read-only. Make a read & write key (kanbo_sk_…) in Settings › Developers to change data.");
    }

    // ---- body ----
    let body: Record<string, unknown> | undefined;
    let raw = "";
    if (method === "POST" || method === "PATCH") {
      let read: string | null;
      try {
        read = await readCapped(req, API_LIMITS.bodyBytes);
      } catch {
        return fail(400, "invalid_body", "The body isn't valid UTF-8 JSON.");
      }
      if (read === null) return fail(413, "payload_too_large", `The body is over ${API_LIMITS.bodyBytes / 1024} KB.`);
      raw = read;
      if (raw.trim()) {
        const ct = (req.headers.get("content-type") ?? "").toLowerCase();
        if (!/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/.test(ct.trim())) {
          return fail(415, "unsupported_media_type", "Send JSON with the header Content-Type: application/json.");
        }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return fail(400, "invalid_body", "The body isn't valid JSON."); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "invalid_body", "Send a JSON object, like {\"title\": \"…\"}.");
        body = parsed as Record<string, unknown>;
      } else {
        body = {};
      }
    }

    const ctx: RouteContext = {
      req: method === "POST" || method === "PATCH" ? new Request(req.url, { method, headers: req.headers, body: raw || undefined }) : req,
      url,
      method: routeMethod as Method,
      params: m.params,
      principal,
      db: deps.db,
      service: deps.service,
      requestId,
      appUrl: deps.appUrl,
      apiBase: deps.apiBase.replace(/\/+$/, ""),
      body,
    };

    // ---- idempotency (POST only: PATCH and DELETE are idempotent already) ----
    const idemHeader = req.headers.get("idempotency-key");
    let idemKey: string | null = null;
    if (method === "POST" && idemHeader !== null) {
      idemKey = idemHeader.trim();
      if (!IDEMPOTENCY_KEY_RE.test(idemKey)) return fail(400, "bad_request", "Idempotency-Key must be 1 to 255 visible ASCII characters (a UUID is ideal).");
      const hash = await sha256Hex(`${method} ${path}${url.search}\n${raw}`);
      let begun: Record<string, unknown> | null;
      try {
        const rs = await deps.service.query<{ b: unknown }>(`select public.api_idempotency_begin($1::uuid, $2, $3) as b`, [principal.keyId, idemKey, hash]);
        const b = rs[0]?.b;
        begun = (typeof b === "string" ? JSON.parse(b) : b) as Record<string, unknown> | null;
      } catch (e) {
        log("error", `[api] ${requestId} idempotency check failed`, errInfo(e));
        return fail(503, "internal", UNREACHABLE, { headers: { "Retry-After": "5" } });
      }
      const state = begun?.state;
      if (state === "replay") {
        const stored = (begun?.response ?? {}) as { body?: unknown; location?: string | null };
        const status = Number(begun?.status) || 200;
        const headers: Record<string, string> = { "Idempotent-Replayed": "true" };
        if (stored.location) headers.Location = stored.location;
        return done(json(stored.body ?? null, status, headers, requestId));
      }
      if (state === "mismatch") return fail(422, "idempotency_mismatch", "This Idempotency-Key was already used for a different request. Use a new key for a new request.");
      if (state === "in_progress") return fail(409, "idempotency_in_progress", "A request with this Idempotency-Key is still running. Try again in a moment.", { headers: { "Retry-After": "2" } });
      if (state !== "new") {
        log("error", `[api] ${requestId} idempotency answered ${String(state)}`);
        return fail(503, "internal", UNREACHABLE, { headers: { "Retry-After": "5" } });
      }
    }

    // ---- the handler ----
    let res: Response;
    try {
      res = await m.route.handler(ctx);
    } catch (e) {
      res = errorResponse(e, requestId, log);
    }

    if (idemKey) {
      let stored: unknown = null;
      try {
        const text = res.status === 204 ? "" : await res.clone().text();
        stored = text ? JSON.parse(text) : null;
      } catch { stored = null; }
      try {
        await deps.service.query(`select public.api_idempotency_finish($1::uuid, $2, $3::int, $4::jsonb)`,
          [principal.keyId, idemKey, res.status, JSON.stringify({ body: stored, location: res.headers.get("location") })]);
      } catch (e) {
        log("warn", `[api] ${requestId} couldn't store the idempotent answer`, errInfo(e));
      }
    }

    if (routeMethod === "GET") res = await withEtag(req, res, "private, no-cache");
    return done(res);
  } catch (e) {
    return done(errorResponse(e, requestId, log));
  }
}
