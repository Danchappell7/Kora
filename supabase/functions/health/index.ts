// ============================================================
// KANBO — uptime health check (Deno / Supabase Edge Function).   [w9-ops]
//
//   GET https://htnchiljplrnjkwimgla.supabase.co/functions/v1/health
//   → 200 { "ok": true,  "db": {…}, "auth": {…}, "storage": {…}, "functions": {…}, "time": "…", "schema": "0047" }
//   → 503 { "ok": false, … }  when a check fails or times out
//
// Called without a JWT by GitHub Actions (.github/workflows/uptime.yml, every
// 10 minutes) and by /admin › System status. It answers only ok / timings /
// a short reason — no data, no secrets — and checks the database with
// kanbo_health() (0047, service role only). Everything is in
// ../_shared/healthCheck.ts (pure, unit-tested); this file wires in the
// environment Supabase injects (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_ANON_KEY). No new secrets.
//
// Deploy:  supabase functions deploy health --project-ref htnchiljplrnjkwimgla --no-verify-jwt
//          (config.toml already has [functions.health] verify_jwt = false)
// Needs:   migration 0047 (until then the db check says "HTTP 404").
// ============================================================
import { createHealthCache, handleHealthRequest } from "../_shared/healthCheck.ts";

const cache = createHealthCache();

Deno.serve((req) =>
  handleHealthRequest(req, {
    env: {
      supabaseUrl: Deno.env.get("SUPABASE_URL") ?? null,
      serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? null,
      anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? null,
    },
    fetch: (url, init) => fetch(url, init),
    cache,
    log: (line) => console.warn(line),
  })
);
