// ============================================================
// KANBO — public API v1: what every handler shares (0046).       [a1]
//
//   ApiFail      throw it from a handler; the pipeline answers with the
//                standard { error: { code, message, status, … } } body
//   pgFailure    a Postgres error → the API error it means (never the SQL)
//   asUser       run work as the key's user (RLS + key scope; read-only
//                for GETs and read keys) — the ONLY way handlers touch data
//   ok / list    JSON answers with the request id
//   Sql          a tiny parameter builder ($1, $2 … with explicit casts)
//   etagFor      the weak ETag of a JSON answer (GET's ETag, If-Match checks)
//
// Pure module (no Deno globals): pipeline.test.ts / the PGlite harness.
// ============================================================
import { scopeFor, sha256Hex } from "./auth.ts";
import { json, type RouteContext } from "./router.ts";
import type { ApiErrorCode, ApiList, ApiPrincipal, Tx } from "./types.ts";
import type { FieldErrors } from "./validate.ts";

/** A handled failure: becomes `{ error: { code, message, status, details? } }`. */
export class ApiFail extends Error {
  constructor(public status: number, public code: ApiErrorCode, message: string, public details?: Record<string, unknown>,
    public headers?: Record<string, string>) {
    super(message);
    this.name = "ApiFail";
  }
}

export const notFound = (what: string) => new ApiFail(404, "not_found", `${what} not found.`);
export const forbidden = (message: string) => new ApiFail(403, "forbidden", message);
export const invalid = (fields: FieldErrors, message = "Some fields need attention.") =>
  new ApiFail(422, "validation_failed", message, { fields });
export const badQuery = (fields: FieldErrors) =>
  new ApiFail(400, "bad_request", "Some query parameters need attention.", { fields });

/** The message a workspace key gets when it reaches outside its workspace. */
export const OUTSIDE_WORKSPACE = "This key is limited to one workspace. Use a personal key to reach other workspaces or your Personal list.";

/** Postgres error → kind. Same mapping as db.ts pgErrorKind, plus timeouts and bad text. */
export function pgKind(e: unknown): "rls" | "read_only" | "not_null" | "check" | "fk" | "unique" | "invalid_text" | "too_long" | "timeout" | "other" {
  const code = String((e as { code?: unknown })?.code ?? "");
  const msg = String((e as { message?: unknown })?.message ?? "");
  if (code === "42501" || /row-level security|permission denied/i.test(msg)) return "rls";
  if (code === "25006" || /read-only transaction/i.test(msg)) return "read_only";
  if (code === "23502") return "not_null";
  if (code === "23514") return "check";
  if (code === "23503") return "fk";
  if (code === "23505") return "unique";
  if (code === "22001") return "too_long";
  if (code === "57014" || /statement timeout/i.test(msg)) return "timeout";
  if (code === "22P02" || code === "22007" || code === "22008" || code === "22021" || code === "22003") return "invalid_text";
  return "other";
}

/** The API error for a Postgres error; null for "other" (the pipeline logs it and answers 500). */
export function pgFailure(e: unknown): ApiFail | null {
  switch (pgKind(e)) {
    case "rls": return forbidden("You don't have permission to do that.");
    case "read_only": return forbidden("This key is read-only. Make a read & write key (kanbo_sk_…) in Settings › Developers to change data.");
    case "not_null":
    case "check":
    case "invalid_text":
    case "too_long":
      return new ApiFail(422, "validation_failed", "A value isn't valid.");
    case "fk": return new ApiFail(422, "validation_failed", "Something this refers to doesn't exist.");
    case "unique": return new ApiFail(409, "conflict", "That already exists.");
    case "timeout": return new ApiFail(503, "internal", "That took too long. Narrow the request (filters, a smaller limit) and try again.", undefined, { "Retry-After": "5" });
    default: return null;
  }
}

/** The weak ETag of an answer's exact text: W/"<first 16 hex of its SHA-256>". */
export async function etagOfText(text: string): Promise<string> {
  return `W/"${(await sha256Hex(text)).slice(0, 16)}"`;
}

/** The ETag GET gives this body (json() sends JSON.stringify(body)). */
export const etagFor = (body: unknown): Promise<string> => etagOfText(JSON.stringify(body));

/** Does an If-None-Match / If-Match header match this ETag ("*", or any listed tag, weak comparison)? */
export function etagMatches(header: string, etag: string): boolean {
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

/** If-Match on a write: the caller's copy (its ETag from GET) must still be current. */
export function preconditionFailed(what: string): ApiFail {
  return new ApiFail(412, "precondition_failed",
    `This ${what} has changed since you read it (If-Match doesn't match its ETag). GET it again, merge your change and retry with the new ETag.`);
}

/** Run work as the key's user: RLS, the key's workspace scope, read-only for GETs and read keys. */
export function asUser<T>(ctx: RouteContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.withUser(scopeFor(ctx.principal, ctx.method), fn);
}

export function ok(ctx: RouteContext, body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return json(body, status, headers, ctx.requestId);
}

export function list<T>(data: T[], nextCursor: string | null): ApiList<T> {
  return { object: "list", data, nextCursor, hasMore: nextCursor !== null };
}

/** A workspace key may only name its own workspace (null = Personal → never). */
export function assertInScope(p: ApiPrincipal, workspaceId: string | null): void {
  if (p.workspaceId && workspaceId !== p.workspaceId) throw forbidden(OUTSIDE_WORKSPACE);
}

/**
 * The workspace every row a key reads must be in: a team key's own (lower case), or null for a
 * personal key (no extra filter). The handlers add it to their own queries as a second layer, so
 * a team key stays inside its workspace even if the "api key scope" policies were ever missing.
 */
export function keyWorkspace(p: ApiPrincipal): string | null {
  return p.workspaceId ? p.workspaceId.toLowerCase() : null;
}

/** Parameters for one statement: `q.p(value)` → "$n". */
export class Sql {
  readonly params: unknown[] = [];
  p(v: unknown): string {
    this.params.push(v === undefined ? null : v);
    return `$${this.params.length}`;
  }
}

/** Built-in tag ids the app ships with (data.ts BUILTIN_TAGS): labels for tasks that use them. */
export const BUILTIN_TAGS: Readonly<Record<string, { label: string; color: string }>> = {
  design: { label: "Design", color: "oklch(0.74 0.16 305)" },
  eng: { label: "Engineering", color: "oklch(0.74 0.14 230)" },
  research: { label: "Research", color: "oklch(0.75 0.13 155)" },
  writing: { label: "Writing", color: "oklch(0.78 0.15 70)" },
  ops: { label: "Ops", color: "oklch(0.7 0.02 240)" },
  bug: { label: "Bug", color: "oklch(0.66 0.2 20)" },
};
