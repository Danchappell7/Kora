// ============================================================
// KANBO — public API v1: routing + JSON responses (0046).        [architect]
//
// The "api" edge function is reached at
//   https://<ref>.supabase.co/functions/v1/api/v1/<resource>
// Supabase hands the function the path from "/api" on (some runtimes keep
// "/functions/v1"); stripBase() accepts both and returns "/<resource>".
//
// Package a1 owns the route table (coreRoutes) and the handlers; package a2
// adds its webhook routes in webhooks.ts (webhookRoutes) and a1 mounts
// [...coreRoutes, ...webhookRoutes]. Handlers get a RouteContext and return
// a Response built with json() / apiError() so every answer has the same
// headers and error shape.
//
// No CORS: the API is for servers and scripts. A key must never sit in a
// web page, so browsers are not invited.
//
// Pure module: router.test.ts.
// ============================================================
import type { ApiErrorBody, ApiErrorCode, ApiPrincipal, Tx, UserDb } from "./types.ts";

export const API_VERSION = "v1";
export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteContext {
  req: Request;
  url: URL;
  method: Method;
  /** ":id"-style path parameters */
  params: Record<string, string>;
  principal: ApiPrincipal;
  /** user data ONLY through db.withUser(scopeFor(principal, method), …) */
  db: UserDb;
  /** privileged connection: idempotency / bookkeeping only, never user data */
  service: Tx;
  requestId: string;
  /** the app's address (APP_URL) for `url` fields */
  appUrl: string;
  /** the API's own base, e.g. https://<ref>.supabase.co/functions/v1/api/v1 */
  apiBase: string;
  /**
   * POST / PATCH: the JSON body, already read (≤ 64 KB), parsed and checked
   * to be an object by the pipeline ({} when the request had no body).
   * `req` is a fresh copy, so `await ctx.req.json()` also still works.
   */
  body?: Record<string, unknown>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response>;

export interface Route {
  method: Method;
  /** "/tasks/:id/comments" (no base, no trailing slash) */
  path: string;
  handler: RouteHandler;
  /** one line for the docs / OpenAPI summary */
  summary?: string;
}

/** "/functions/v1/api/v1/tasks/x" | "/api/v1/tasks/x" | "/v1/tasks/x" → "/tasks/x"; null when it isn't under /v1. */
export function stripBase(pathname: string): string | null {
  const m = /^(?:\/functions\/v1)?(?:\/api)?\/v1(\/.*)?$/.exec(pathname.replace(/\/+$/, ""));
  if (!m) return null;
  return m[1] && m[1] !== "/" ? m[1] : "/";
}

const segs = (p: string) => p.split("/").filter(Boolean);

export type RouteMatch =
  | { kind: "match"; route: Route; params: Record<string, string> }
  | { kind: "method_not_allowed"; allow: Method[] }
  | { kind: "not_found" };

/** Find the route for a method + path (path from stripBase). Parameters are URI-decoded. */
export function matchRoute(routes: readonly Route[], method: string, path: string): RouteMatch {
  const want = segs(path);
  const allow = new Set<Method>();
  for (const r of routes) {
    const have = segs(r.path);
    if (have.length !== want.length) continue;
    const params: Record<string, string> = {};
    let hit = true;
    for (let i = 0; i < have.length; i++) {
      if (have[i].startsWith(":")) {
        let v: string;
        try { v = decodeURIComponent(want[i]); } catch { hit = false; break; }
        params[have[i].slice(1)] = v;
      } else if (have[i] !== want[i]) { hit = false; break; }
    }
    if (!hit) continue;
    if (r.method === method.toUpperCase()) return { kind: "match", route: r, params };
    allow.add(r.method);
  }
  return allow.size ? { kind: "method_not_allowed", allow: [...allow] } : { kind: "not_found" };
}

/** Headers on every API response. */
export function baseHeaders(requestId?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(requestId ? { "X-Request-Id": requestId } : {}),
    ...extra,
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}, requestId?: string): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: baseHeaders(requestId, headers) });
}

export function errorBody(status: number, code: ApiErrorCode, message: string, requestId?: string, details?: Record<string, unknown>): ApiErrorBody {
  return { error: { code, message, status, ...(requestId ? { requestId } : {}), ...(details ? { details } : {}) } };
}

/** `{ "error": { code, message, status, requestId, details? } }` */
export function apiError(status: number, code: ApiErrorCode, message: string,
  opts: { requestId?: string; details?: Record<string, unknown>; headers?: Record<string, string> } = {}): Response {
  return json(errorBody(status, code, message, opts.requestId, opts.details), status, opts.headers ?? {}, opts.requestId);
}

/** A short random id for X-Request-Id ("req_" + 16 hex). */
export function newRequestId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return "req_" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
