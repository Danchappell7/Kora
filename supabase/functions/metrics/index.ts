// ============================================================
// KANBO — read-only metrics endpoint for an external dashboard.
// Deploy:  supabase functions deploy metrics --no-verify-jwt
// Secret:  supabase secrets set METRICS_TOKEN=<long-random-string>
//
// The dashboard does:  GET https://<ref>.supabase.co/functions/v1/metrics
//   with header        Authorization: Bearer <METRICS_TOKEN>
// and receives:
//   { "mrr_cents": 0, "active_users": 12, "monthly_actions": 340, "new_signups": 5 }
//
// --no-verify-jwt is required because the caller sends our own bearer token,
// not a Supabase JWT; we verify that token ourselves below.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const DAY = 86_400_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // bearer-token gate — FAIL CLOSED. Without METRICS_TOKEN set the endpoint is
  // disabled, so a forgotten secret can never expose business metrics publicly.
  const token = Deno.env.get("METRICS_TOKEN");
  if (!token) return json({ error: "not configured" }, 503);
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const since = new Date(Date.now() - 30 * DAY).toISOString();

    // monthly_actions — activity rows in the last 30 days
    const { count: monthlyActions } = await admin
      .from("activity").select("*", { count: "exact", head: true }).gte("created_at", since);

    // users — total, active (signed in last 30d), new (created last 30d)
    let total = 0, active = 0, newSignups = 0, page = 1;
    for (;;) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error || !data?.users?.length) break;
      for (const u of data.users) {
        total++;
        if (u.created_at && new Date(u.created_at).toISOString() >= since) newSignups++;
        if (u.last_sign_in_at && new Date(u.last_sign_in_at).toISOString() >= since) active++;
      }
      if (data.users.length < 1000) break;
      page++;
      if (page > 20) break; // safety cap (20k users)
    }

    // mrr_cents — sum of active paid subscriptions (0 while billing is off / no amount tracked)
    let mrrCents = 0;
    try {
      const { data: subs } = await admin
        .from("subscriptions").select("status, amount_cents").in("status", ["active", "trialing"]);
      mrrCents = (subs ?? []).reduce((sum: number, s: { amount_cents?: number }) => sum + (s.amount_cents || 0), 0);
    } catch { /* subscriptions table or amount column not present — leave 0 */ }

    return json({
      mrr_cents: mrrCents,
      active_users: active || total, // fall back to total if last_sign_in isn't populated
      monthly_actions: monthlyActions ?? 0,
      new_signups: newSignups,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
