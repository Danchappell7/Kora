// ============================================================
// KORA — open the Stripe customer billing portal (Deno / Supabase)
// Deploy:  supabase functions deploy customer-portal
// Secrets: STRIPE_SECRET_KEY
// ============================================================
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return json({ error: "no STRIPE_SECRET_KEY" }, 400);

  try {
    const { returnUrl } = await req.json();
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: ures } = await supa.auth.getUser();
    if (!ures?.user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: sub } = await admin.from("subscriptions").select("stripe_customer_id").eq("user_id", ures.user.id).maybeSingle();
    if (!sub?.stripe_customer_id) return json({ error: "no_customer" }, 400);

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
    const portal = await stripe.billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: returnUrl });
    return json({ url: portal.url });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
