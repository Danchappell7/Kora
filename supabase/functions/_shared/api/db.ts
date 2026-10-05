// ============================================================
// KANBO — public API v1: the Postgres connection (0046).         [architect]
//
// DENO ONLY (npm:postgres). Never import this file from the app or from a
// module the app imports; pure code depends on the Tx / UserDb interfaces in
// types.ts instead.
//
// SUPABASE_DB_URL is injected into every edge function. It connects as the
// database owner, so this file is the ONE place that decides what runs with
// that power:
//
//   • withUser(scope, fn) — everything a request does to user data. One
//     transaction: SET LOCAL ROLE authenticated, request.jwt.claims =
//     {sub: <key's user>, role: "authenticated"} (so auth.uid() is the
//     key's user and every RLS policy applies exactly as in the app), and
//     kanbo.api_workspace = the workspace key's workspace (the restrictive
//     "api key scope" policies then refuse every other workspace and every
//     personal row). Read keys and GETs run BEGIN READ ONLY.
//     Inside it, query tables only: SECURITY DEFINER functions bypass the
//     api key scope (the can_* helpers in policies are fine).
//
//   • service — the privileged connection, ONLY for key verification, rate
//     limits, idempotency bookkeeping, webhook dispatch and Notion sync
//     bookkeeping. Never for reading or writing user data for a key.
//
// Supavisor (transaction mode) can't keep prepared statements, so prepare:false.
// ============================================================
import postgres from "npm:postgres@3.4.5";
import type { Tx, UserDb, UserScope } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
type Sql = any;

let shared: Sql | null = null;

/** One small pool per isolate (reused across requests). */
export function connect(url: string | undefined = Deno.env.get("SUPABASE_DB_URL")): Sql {
  if (shared) return shared;
  if (!url) throw new Error("SUPABASE_DB_URL is not set");
  shared = postgres(url, {
    prepare: false,          // transaction pooler
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    // keep date-only columns as "YYYY-MM-DD" strings (serialise.ts takes strings or Dates either way)
    types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
  });
  return shared;
}

/** postgres.js transaction / sql → the Tx interface (parameterised text queries). */
export function txOf(sql: Sql): Tx {
  return {
    async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as unknown[]);
      return Array.from(rows) as T[];
    },
  };
}

/** Opens a request's transaction as the user (tested in the PGlite harness). */
export const WITH_USER_SQL =
  "select set_config('role', 'authenticated', true), set_config('statement_timeout', '15s', true), " +
  "set_config('request.jwt.claims', $1, true), set_config('kanbo.api_workspace', $2, true)";

export interface ApiDb extends UserDb {
  /** privileged connection: verification, rate limits, idempotency, dispatch bookkeeping only */
  service: Tx;
}

/** The database for one edge function. */
export function createApiDb(sql: Sql = connect()): ApiDb {
  return {
    service: txOf(sql),
    async withUser<T>(scope: UserScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
      if (!UUID_RE.test(scope.userId)) throw new Error("withUser: invalid user id");
      if (scope.workspaceId != null && !UUID_RE.test(scope.workspaceId)) throw new Error("withUser: invalid workspace id");
      return await sql.begin(scope.readOnly ? "read only" : "read write", async (t: Sql) => {
        // one round trip, the way PostgREST does it (set_config('role', …, true) = SET LOCAL ROLE)
        await t.unsafe(WITH_USER_SQL, [JSON.stringify({ sub: scope.userId, role: "authenticated" }), scope.workspaceId ?? ""]);
        return await fn(txOf(t));
      });
    },
  };
}

/** Postgres error → what kind of failure it is (for the API's JSON errors). */
export function pgErrorKind(e: unknown): "rls" | "not_null" | "check" | "fk" | "unique" | "read_only" | "invalid_text" | "other" {
  const code = String((e as { code?: unknown })?.code ?? "");
  const msg = String((e as { message?: unknown })?.message ?? "");
  if (code === "42501" || /row-level security|permission denied/i.test(msg)) return "rls";
  if (code === "25006") return "read_only";
  if (code === "23502") return "not_null";
  if (code === "23514") return "check";
  if (code === "23503") return "fk";
  if (code === "23505") return "unique";
  if (code === "22P02" || code === "22007" || code === "22008") return "invalid_text";
  return "other";
}
