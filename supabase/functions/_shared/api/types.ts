// ============================================================
// KANBO — public API v1: shared types (0046).                    [architect]
//
// Pure: no Deno globals, no remote / npm imports. Imported by the api,
// webhook-dispatch and notion edge functions, by vitest, and (type-only or
// constants) by the app. db.ts is the only Deno-only module in this folder.
// ============================================================

/** What a key may do: "read" keys can only make GET requests. */
export type ApiAccess = "read" | "write";

/** Who a verified API key acts as (public.verify_api_key). */
export interface ApiPrincipal {
  keyId: string;
  /** the key's creator: every request runs as this person, with RLS */
  userId: string;
  /** null = personal key; otherwise the only workspace the key can reach */
  workspaceId: string | null;
  access: ApiAccess;
}

/** One SQL statement runner (a transaction, or the privileged connection). */
export interface Tx {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/** How a request's transaction is opened (db.ts withUser). */
export interface UserScope {
  /** auth.uid() inside the transaction */
  userId: string;
  /** sets kanbo.api_workspace: the "api key scope" policies then refuse every other workspace (and personal rows) */
  workspaceId?: string | null;
  /** BEGIN READ ONLY: any write fails in Postgres itself */
  readOnly?: boolean;
}

/** Runs work as a person, with RLS (db.ts createApiDb implements it). */
export interface UserDb {
  withUser<T>(scope: UserScope, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export type ApiErrorCode =
  | "bad_request"            // malformed query string / path
  | "invalid_body"           // not JSON, or not an object
  | "validation_failed"      // fields failed validation (details.fields)
  | "unauthorized"           // no key, unknown, revoked, expired, or the owner can't act
  | "forbidden"              // a read-only key writing; outside the key's workspace; RLS refused
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "idempotency_mismatch"   // Idempotency-Key reused for a different request (422)
  | "idempotency_in_progress"// the first request with this key is still running (409)
  | "precondition_failed"    // If-Match: the resource changed since the caller read it (412)
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"           // 429 with Retry-After
  | "internal";

/** Every error response: `{ "error": { … } }` with the HTTP status repeated. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** a sentence for people (British English), safe to show */
    message: string;
    status: number;
    /** echo of the X-Request-Id response header */
    requestId?: string;
    details?: Record<string, unknown>;
  };
}

/** A page of results (cursor pagination). */
export interface ApiList<T> {
  object: "list";
  data: T[];
  /** pass as ?cursor= for the next page; null on the last page */
  nextCursor: string | null;
  hasMore: boolean;
}
