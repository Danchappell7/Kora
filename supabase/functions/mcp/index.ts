// ============================================================
// KANBO — the remote MCP server and its OAuth endpoints (Deno / Supabase Edge
// Function). People paste https://www.kanbo.co.uk/mcp into Claude, ChatGPT or
// Cursor; vercel.json proxies it here.
//
// Everything real is in ../_shared/mcp/ (pure, unit-tested and replayed against
// the real migrations in PGlite). This file only wires in the database, DNS and
// the environment:
//
//   • SUPABASE_DB_URL (injected) — db.ts opens one small pool. Every read and
//     write for a person runs in db.withUser, exactly as in the REST API.
//   • SUPABASE_URL + SUPABASE_ANON_KEY (injected) — who's signed in, for the
//     consent page's /oauth/prepare call.
//   • APP_URL (already set) — the app's address for `url` fields.
//
// Deploy:  supabase functions deploy mcp --no-verify-jwt --use-api
//          (config.toml has verify_jwt = false: callers send an API key or an
//          OAuth token, not a Supabase JWT.)
// Needs:   migration 0050 for OAuth. API keys work with 0046 alone. No new secrets.
// ============================================================
import { sqlVerifier } from "../_shared/api/auth.ts";
import { createApiDb, type ApiDb } from "../_shared/api/db.ts";
import { handleMcpFunction } from "../_shared/mcp/handler.ts";

const APP_URL = (Deno.env.get("APP_URL") || "https://www.kanbo.co.uk").replace(/\/+$/, "");
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const API_BASE = `${SUPABASE_URL || "https://htnchiljplrnjkwimgla.supabase.co"}/functions/v1/api/v1`;

let db: ApiDb | null = null;

/** The person behind a Supabase session token, asked of Supabase Auth itself. */
async function verifyUser(jwt: string): Promise<string | null> {
  if (!SUPABASE_URL || !ANON_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); return null; }
  const user = await res.json().catch(() => null) as { id?: unknown } | null;
  return typeof user?.id === "string" ? user.id : null;
}

/** Every address a name resolves to; null where the runtime won't say (the fetch itself is still sandboxed). */
async function resolveHost(host: string): Promise<string[] | null> {
  try {
    const [a, aaaa] = await Promise.all([
      Deno.resolveDns(host, "A").catch(() => [] as string[]),
      Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
    ]);
    return [...a, ...aaaa];
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  try {
    db ??= createApiDb();
  } catch (e) {
    console.error(`[mcp] database not configured: ${String((e as Error)?.message ?? e)}`);
    return new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "Kanbo isn't available right now. Try again in a moment." }),
      { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "30" } });
  }
  return handleMcpFunction(req, {
    db,
    service: db.service,
    verifyKey: sqlVerifier(db.service),
    verifyUser,
    resolveHost,
    appUrl: APP_URL,
    apiBase: API_BASE,
  });
});
