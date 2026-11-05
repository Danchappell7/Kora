// ============================================================
// KANBO — the remote MCP server and its OAuth endpoints (Deno / Supabase Edge
// Function). People paste https://www.kanbo.co.uk/mcp into Claude, ChatGPT or
// Cursor; vercel.json proxies it here.
//
// Everything real is in ../_shared/mcp/ (pure, unit-tested and replayed against
// the real migrations in PGlite). This file only wires in the database, DNS, the
// network and the environment:
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
import { dohResolver, getPinned, isRuntimeUnsupported, systemResolver, type Conn, type NetApi } from "../_shared/api/webhookDispatch.ts";
import { handleMcpFunction } from "../_shared/mcp/handler.ts";
import { documentFetcher, type GetDocument } from "../_shared/mcp/oauth.ts";

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

// deno-lint-ignore no-explicit-any
const D = Deno as any;

/** Every address a name resolves to, as webhook-dispatch does: Deno.resolveDns, or DNS-over-HTTPS where it can't answer. */
const resolve = systemResolver(typeof D.resolveDns === "function" ? (host, type) => D.resolveDns(host, type) : null, dohResolver(fetch));

/** Reads an app's description from the checked address itself, so a second DNS answer can't swap in a private one. */
const net: NetApi | null = typeof D.connect === "function" && typeof D.startTls === "function"
  ? {
    connect: (o) => D.connect({ hostname: o.hostname, port: o.port, transport: "tcp" }) as Promise<Conn>,
    startTls: (c, o) => D.startTls(c, { hostname: o.hostname }) as Promise<Conn>,
  }
  : null;
let pinnedUnsupported = false;
const viaFetch = documentFetcher(fetch);
const getDocument: GetDocument = async (target, maxBytes, timeoutMs) => {
  if (net && !pinnedUnsupported) {
    try {
      return await getPinned(net, target, maxBytes, timeoutMs, "Kanbo (+https://www.kanbo.co.uk)");
    } catch (e) {
      // only "this runtime can't do raw TLS" switches to fetch; the far end's own failure never does
      if (!isRuntimeUnsupported(e)) throw e;
      pinnedUnsupported = true;
      console.warn("[mcp] raw TLS isn't available here; reading app descriptions with fetch (checked DNS first, no redirects)");
    }
  }
  return viaFetch(target, maxBytes, timeoutMs);
};

const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };
/** Kanbo's own hosts, which an app's description is never fetched from. */
const OWN_HOSTS = [hostOf(SUPABASE_URL), hostOf(APP_URL), "kanbo.co.uk"].filter(Boolean);

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
    resolve,
    getDocument,
    ownHosts: OWN_HOSTS,
    appUrl: APP_URL,
    apiBase: API_BASE,
  });
});
