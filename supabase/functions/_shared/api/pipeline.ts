// ============================================================
// KANBO — public API v1: one request, start to finish (0046).    [a1]
//
//   1. request id; path under /v1 (else 404); OPTIONS → 405 (no CORS)
//   2. GET /openapi.json and GET / are public; everything else needs a key
//   3. authenticate (verify_api_key, service role) → 401; 503 when it can't
//      check, or (team keys) while the "api key scope" policies are missing
//   4. rate limit per key (120 a minute) → 429 + Retry-After; X-RateLimit-*
//      on every answer from here on
//   5. route → 404 / 405 (+ Allow); read-only key writing → 403
//   6. POST / PATCH body: JSON object, ≤ 64 KB → 415 / 413 / 400
//   7. POST + Idempotency-Key: replay the first answer for 24 hours
//      (api_idempotency_begin / _finish); a different request with the same
//      key → 422; the first still running → 409. The handler's transaction
//      marks the key committed as its last statement (api_idempotency_commit,
//      as the user), so work that committed is never run twice, even if its
//      answer can't be stored: the retry then gets 409 "applied"
//   8. the handler, which reads and writes ONLY as the key's user
//      (core.ts asUser → db.withUser: RLS + the key's workspace scope);
//      If-Match on writes is checked inside its transaction (412)
//   9. errors → { error: { code, message, status, requestId, details? } };
//      Postgres errors are mapped, never echoed; 5xx are logged with the id
//  10. GET 200 → weak ETag; If-None-Match → 304
//
// Pure module (no Deno globals): pipeline.test.ts drives it with fakes and
// the PGlite harness drives it against the real migrations. The Deno entry
// (supabase/functions/api/index.ts) only wires the database and env in.
// ============================================================
import { authenticate, hitRate, isScopeMissing, methodAllowed, rateHeaders, sha256Hex, type VerifyKey } from "./auth.ts";
import { ApiFail, etagMatches, etagOfText, pgFailure } from "./core.ts";
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
  /** waits between attempts to store an idempotent answer (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
}

export { etagMatches };

/** Pauses before each retry of api_idempotency_finish (3 tries in all, ~0.6 s). */
const FINISH_BACKOFF_MS = [100, 500];

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E](?:[\x20-\x7E]{0,253}[\x21-\x7E])?$/;
const NO_CORS = "The Kanbo API doesn't answer browsers' cross-origin checks. Call it from a server or a script: an API key in a web page can be read by anyone.";
const UNREACHABLE = "Kanbo's API can't reach its database right now. Try again in a moment.";
const TEAM_KEYS_PAUSED = "Team keys are paused while Kanbo's database is being updated. Personal keys still work. Try again in a few minutes.";
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

/**
 * What an idempotent answer may keep for 24 h: never a webhook signing secret
 * (POST /webhooks, POST /webhooks/:id/rotate-secret). A replay carries
 * `secret: null`; the secret lives only in webhooks.secret, shown once.
 */
export function withoutSecret(stored: unknown): unknown {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return stored;
  const o = stored as Record<string, unknown>;
  return "secret" in o ? { ...o, secret: null } : stored;
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
  const etag = await etagOfText(text);
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
      if (isScopeMissing(e)) {
        // fail closed: a team key never runs without the policies that keep it in its workspace
        log("error", `[api] ${requestId} team key refused: the "api key scope" policies are missing. Run migration 0046 again.`);
        return fail(503, "internal", TEAM_KEYS_PAUSED, { headers: { "Retry-After": "300" } });
      }
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
      if (state === "applied") {
        return fail(409, "conflict", "The request with this Idempotency-Key was carried out, but Kanbo couldn't keep its answer. Don't send it again: look the result up instead (for example GET /tasks?updated_since=…).",
          { details: { idempotency: "applied" } });
      }
      if (state !== "new") {
        log("error", `[api] ${requestId} idempotency answered ${String(state)}`);
        return fail(503, "internal", UNREACHABLE, { headers: { "Retry-After": "5" } });
      }
      // the handler's writes and "this key's work is done" commit together
      const keyId = principal.keyId, k = idemKey;
      ctx.db = {
        withUser: (scope, fn) => deps.db.withUser(scope, async (tx) => {
          const out = await fn(tx);
          if (!scope.readOnly) await tx.query(`select public.api_idempotency_commit($1::uuid, $2)`, [keyId, k]);
          return out;
        }),
      };
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
      stored = withoutSecret(stored);
      // a few tries: an answer that isn't stored leaves the key "running" (409),
      // then "applied" (409) — never run twice, but the caller can't see the result
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const args = [principal.keyId, idemKey, res.status, JSON.stringify({ body: stored, location: res.headers.get("location") })];
      for (let attempt = 0; ; attempt++) {
        try {
          await deps.service.query(`select public.api_idempotency_finish($1::uuid, $2, $3::int, $4::jsonb)`, args);
          break;
        } catch (e) {
          if (attempt >= FINISH_BACKOFF_MS.length) {
            log("error", `[api] ${requestId} couldn't store the idempotent answer`, errInfo(e));
            break;
          }
          await sleep(FINISH_BACKOFF_MS[attempt]);
        }
      }
    }

    if (routeMethod === "GET") res = await withEtag(req, res, "private, no-cache");
    return done(res);
  } catch (e) {
    return done(errorResponse(e, requestId, log));
  }
}
