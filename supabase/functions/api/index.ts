// ============================================================
// KANBO — the public REST API (Deno / Supabase Edge Function). [0046 · a1]
//
//   https://<ref>.supabase.co/functions/v1/api/v1/<resource>
//   Authorization: Bearer kanbo_sk_…   (read & write)
//                  Bearer kanbo_pk_…   (read-only: GET only)
//
// Everything is in ../_shared/api/pipeline.ts (pure, unit-tested and
// replayed against the real migrations in PGlite); this file only wires in
// the database and the environment:
//
//   • SUPABASE_DB_URL (injected by Supabase) — db.ts opens one small pool.
//     verify_api_key / api_rate_hit / api_idempotency_* run on the privileged
//     connection; EVERY read and write for a key runs in db.withUser(): a
//     transaction as the key's user (SET LOCAL ROLE authenticated +
//     request.jwt.claims), so RLS applies exactly as in the app, and a team
//     key's transaction is pinned to its workspace (kanbo.api_workspace).
//   • SUPABASE_URL — the API's own base address for Location headers and the
//     OpenAPI document's server.
//   • APP_URL (already set for reminders) — the app's address for `url` fields.
//
// No CORS: keys belong on servers and in scripts, never in web pages.
//
// Deploy:  supabase functions deploy api --no-verify-jwt
//          (config.toml has verify_jwt = false: callers send a Kanbo key,
//          not a Supabase JWT.)
// Needs:   migration 0046. No new secrets.
// ============================================================
import { sqlVerifier } from "../_shared/api/auth.ts";
import { createApiDb, type ApiDb } from "../_shared/api/db.ts";
import { handleApiRequest } from "../_shared/api/pipeline.ts";
import { apiError, newRequestId } from "../_shared/api/router.ts";

const APP_URL = (Deno.env.get("APP_URL") || "https://www.kanbo.co.uk").replace(/\/+$/, "");
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const API_BASE = `${SUPABASE_URL || "https://htnchiljplrnjkwimgla.supabase.co"}/functions/v1/api/v1`;

let db: ApiDb | null = null;

Deno.serve(async (req) => {
  try {
    db ??= createApiDb();
  } catch (e) {
    const requestId = newRequestId();
    console.error(`[api] ${requestId} database not configured: ${String((e as Error)?.message ?? e)}`);
    return apiError(503, "internal", "Kanbo's API isn't available right now. Try again in a moment.",
      { requestId, headers: { "Retry-After": "30" } });
  }
  return handleApiRequest(req, {
    db,
    service: db.service,
    verify: sqlVerifier(db.service),
    appUrl: APP_URL,
    apiBase: API_BASE,
  });
});
