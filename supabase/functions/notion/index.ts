// ============================================================
// KANBO — Notion: connect, import, two-way sync and page links
// (Deno / Supabase Edge Function, migration 0046)                    [a3]
//
// Everything is in ../_shared/notionHandler.ts (requests), notionSync.ts
// (import + the sync engine), notionMap.ts (reading / writing Notion
// properties) and notionApi.ts (the paced Notion client). This file only
// wires them to Postgres (SUPABASE_DB_URL, ../_shared/api/db.ts), fetch and
// the auth server.
//
// Who: signed-in people (verify_jwt ON). The handler asks the database, as
// the caller, what they may do (notion_status / RLS / the definer
// functions). The scheduled run sends x-cron-secret: <CRON_SECRET> with the
// anon key as its bearer (so the gateway lets it through) and
// { "mode": "sync" }: every enabled sync not run in the last 9 minutes.
//
// Every task / project / tag read or write runs as a person with RLS
// (withUser: SET LOCAL ROLE authenticated + their JWT claims, scoped to the
// workspace). The service connection reads the integration token and keeps
// notion_links / notion_page_cache / notion_link_state / the sync's
// bookkeeping (and the per-database lease in rate_limits), nothing else.
//
// Deploy:   supabase functions deploy notion --project-ref htnchiljplrnjkwimgla
// Secrets:  none new (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_DB_URL are
//           injected; CRON_SECRET is already set for the reminder emails)
// Schedule: docs/integrations/notion.md (pg_cron every 10 minutes)
// ============================================================
import { createApiDb } from "../_shared/api/db.ts";
import { notionApi } from "../_shared/notionApi.ts";
import { handleNotionRequest, type HandlerDeps } from "../_shared/notionHandler.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

/** The caller's user id: asks the auth server, so a signed-out or deleted session fails. */
async function authUser(jwt: string): Promise<string | null> {
  if (!SUPABASE_URL || !ANON_KEY || !jwt || jwt === ANON_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const u = (await res.json()) as { id?: unknown };
    return typeof u?.id === "string" ? u.id : null;
  } catch {
    return null;
  }
}

let deps: HandlerDeps | null = null;
function wire(): HandlerDeps {
  if (deps) return deps;
  deps = {
    db: createApiDb(),
    notion: (token, deadline) => notionApi(token, { fetch: (u, i) => fetch(u, i), deadline }),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    // never the token, never a full Notion response
    log: (level, msg, extra) => (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(msg, JSON.stringify(extra ?? {})),
    authUser,
    cronSecret: Deno.env.get("CRON_SECRET") ?? "",
  };
  return deps;
}

Deno.serve((req) => handleNotionRequest(req, wire()));
