// ============================================================
// KANBO — public API v1: authenticating a request (0046).        [architect]
//
//   Authorization: Bearer kanbo_sk_<43 base64url>   read & write
//   Authorization: Bearer kanbo_pk_<43 base64url>   read-only (GET only)
//
// Keys are generated in Postgres (create_api_key) and stored only as their
// SHA-256. Verification is public.verify_api_key(key) — service role only —
// which also refuses revoked / expired keys, keys whose owner is suspended
// or unapproved, and workspace keys whose creator is no longer an owner or
// admin there. Run it on the privileged connection (db.ts createApiDb().service)
// or through PostgREST with the service key (rpcVerifier).
//
// After authentication, EVERYTHING the request reads or writes runs through
// db.ts withUser(scopeFor(principal, method)) — as the key's user, with RLS —
// never with the service role.
//
// Rate limit: 120 requests a minute per key (api_rate_hit on 0042's
// rate_limits, key "kanbo:api:<key id>").
//
// Pure module (Web Crypto only) so vitest can exercise it: auth.test.ts.
// ============================================================
import type { ApiAccess, ApiPrincipal, Tx, UserScope } from "./types.ts";

/** The shape of every Kanbo API key. */
export const API_KEY_RE = /^kanbo_(sk|pk)_[A-Za-z0-9_-]{43}$/;
export const API_KEY_PREFIX = { write: "kanbo_sk_", read: "kanbo_pk_" } as const;
/** Requests per window per key. */
export const API_RATE = { windowSec: 60, max: 120 } as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for something shaped like a Kanbo API key (says nothing about whether it's valid). */
export function looksLikeApiKey(s: unknown): s is string {
  return typeof s === "string" && API_KEY_RE.test(s);
}

/** The access a key's prefix claims (the database checks it matches what was issued). */
export function accessOfKey(key: string): ApiAccess | null {
  if (!looksLikeApiKey(key)) return null;
  return key.startsWith(API_KEY_PREFIX.write) ? "write" : "read";
}

/** The bearer token from an Authorization header ("Bearer <token>", any case), or null. */
export function bearerToken(headers: Headers): string | null {
  const h = headers.get("authorization") ?? "";
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

/** Hex SHA-256 of a string: the same digest api_key_digest() stores. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A verify_api_key() row → principal (null for anything malformed). */
export function rowToPrincipal(row: unknown): ApiPrincipal | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const keyId = r.key_id, userId = r.user_id, ws = r.workspace_id, access = r.access;
  if (typeof keyId !== "string" || !UUID_RE.test(keyId)) return null;
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;
  if (ws !== null && ws !== undefined && (typeof ws !== "string" || !UUID_RE.test(ws))) return null;
  if (access !== "read" && access !== "write") return null;
  return { keyId, userId, workspaceId: (ws as string | null | undefined) ?? null, access };
}

/** Looks a key up; null when it isn't valid. */
export type VerifyKey = (key: string) => Promise<ApiPrincipal | null>;

/** Verify on the privileged Postgres connection (db.ts createApiDb().service). */
export function sqlVerifier(service: Tx): VerifyKey {
  return async (key) => {
    if (!looksLikeApiKey(key)) return null;
    const rows = await service.query(`select * from public.verify_api_key($1)`, [key]);
    return rowToPrincipal(rows[0]);
  };
}

/** Verify through PostgREST with the service-role key (no Postgres connection needed). */
export function rpcVerifier(supabaseUrl: string, serviceKey: string, fetchImpl: typeof fetch = fetch): VerifyKey {
  const url = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/verify_api_key`;
  return async (key) => {
    if (!looksLikeApiKey(key)) return null;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ p_key: key }),
    });
    if (!res.ok) throw new Error(`verify_api_key failed (${res.status})`);
    const rows = await res.json();
    return rowToPrincipal(Array.isArray(rows) ? rows[0] : rows);
  };
}

export type AuthResult =
  | { ok: true; principal: ApiPrincipal }
  | { ok: false; status: 401; code: "unauthorized"; message: string };

/** Who is calling? Never throws for a bad key (only when verification itself fails). */
export async function authenticate(headers: Headers, verify: VerifyKey): Promise<AuthResult> {
  const token = bearerToken(headers);
  if (!token) {
    return { ok: false, status: 401, code: "unauthorized", message: "Add your API key as a bearer token: Authorization: Bearer kanbo_sk_…" };
  }
  if (!looksLikeApiKey(token)) {
    return { ok: false, status: 401, code: "unauthorized", message: "That isn't a Kanbo API key. Keys start with kanbo_sk_ or kanbo_pk_." };
  }
  const principal = await verify(token);
  if (!principal) {
    return { ok: false, status: 401, code: "unauthorized", message: "This API key isn't valid. It may have been revoked or have expired." };
  }
  return { ok: true, principal };
}

/** May this key make this request? Read-only keys: GET / HEAD / OPTIONS only. */
export function methodAllowed(principal: ApiPrincipal, method: string): boolean {
  const m = method.toUpperCase();
  return principal.access === "write" || m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/** The transaction a request runs in: as the key's user, scoped to the key's workspace, read-only for GETs and read keys. */
export function scopeFor(principal: ApiPrincipal, method: string): UserScope {
  const m = method.toUpperCase();
  return {
    userId: principal.userId,
    workspaceId: principal.workspaceId,
    readOnly: principal.access === "read" || m === "GET" || m === "HEAD",
  };
}

/** rate_limits key for a key. */
export const rateKey = (principal: ApiPrincipal) => `kanbo:api:${principal.keyId}`;

export interface RateResult { allowed: boolean; remaining: number; retryAfter: number; limit: number }

/** Count one request against the key's window (privileged connection). Fails open on a database error. */
export async function hitRate(service: Tx, principal: ApiPrincipal, opts: { windowSec?: number; max?: number } = {}): Promise<RateResult> {
  const windowSec = opts.windowSec ?? API_RATE.windowSec;
  const max = opts.max ?? API_RATE.max;
  try {
    const rows = await service.query<{ allowed: boolean; remaining: number; retry_after: number }>(
      `select * from public.api_rate_hit($1, $2, $3)`, [rateKey(principal), windowSec, max]);
    const r = rows[0];
    if (!r) return { allowed: true, remaining: max, retryAfter: 0, limit: max };
    return { allowed: !!r.allowed, remaining: Number(r.remaining) || 0, retryAfter: Number(r.retry_after) || 0, limit: max };
  } catch (e) {
    console.warn(`[api] rate limit check failed, allowing: ${String((e as Error)?.message ?? e)}`);
    return { allowed: true, remaining: max, retryAfter: 0, limit: max };
  }
}

/** X-RateLimit-* headers for a response. */
export function rateHeaders(r: RateResult): Record<string, string> {
  const h: Record<string, string> = { "X-RateLimit-Limit": String(r.limit), "X-RateLimit-Remaining": String(r.remaining) };
  if (!r.allowed) h["Retry-After"] = String(Math.max(1, r.retryAfter));
  return h;
}
