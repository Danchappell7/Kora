// ============================================================
// KANBO — Stripe webhook → keeps the subscriptions table in sync.
// Deploy:  supabase functions deploy stripe-webhook --no-verify-jwt
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// In Stripe Dashboard → Developers → Webhooks, add the function URL
// and subscribe to: checkout.session.completed,
//   customer.subscription.updated, customer.subscription.deleted
// ============================================================
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY")!;
  const whSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, whSecret);
  } catch (e) {
    return new Response(`bad signature: ${e}`, { status: 400 });
  }

  const upsert = async (customerId: string, fields: Record<string, unknown>) => {
    // find the user by stored customer id; fall back to Stripe metadata
    const { data: existing } = await admin.from("subscriptions").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
    let userId = existing?.user_id as string | undefined;
    if (!userId) {
      const cust = await stripe.customers.retrieve(customerId);
      userId = (cust as Stripe.Customer)?.metadata?.user_id;
    }
    if (!userId) return;
    await admin.from("subscriptions").upsert({ user_id: userId, stripe_customer_id: customerId, updated_at: new Date().toISOString(), ...fields }, { onConflict: "user_id" });
  };

  const mapStatus = (s: string): string =>
    s === "active" || s === "trialing" ? "active" : s === "past_due" || s === "unpaid" ? "past_due" : "canceled";

  // Resolve the plan from metadata first, then from the actual purchased price.
  // Returns undefined if it can't be determined — callers then OMIT plan from the
  // upsert so an existing plan is never silently clobbered to "personal".
  const planFor = (sub: Stripe.Subscription): string | undefined => {
    if (sub.metadata?.plan) return sub.metadata.plan;
    const priceId = sub.items?.data?.[0]?.price?.id;
    if (priceId && priceId === Deno.env.get("STRIPE_PRICE_TEAM")) return "team";
    if (priceId && priceId === Deno.env.get("STRIPE_PRICE_PERSONAL")) return "personal";
    return undefined;
  };

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      const subId = s.subscription as string;
      const sub = await stripe.subscriptions.retrieve(subId);
      const plan = s.metadata?.plan ?? planFor(sub);
      await upsert(s.customer as string, {
        ...(plan ? { plan } : {}),
        status: mapStatus(sub.status),
        stripe_subscription_id: subId,
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        seats: sub.items.data[0]?.quantity ?? 1,
      });
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const plan = planFor(sub);
      await upsert(sub.customer as string, {
        ...(plan ? { plan } : {}),
        status: event.type === "customer.subscription.deleted" ? "canceled" : mapStatus(sub.status),
        stripe_subscription_id: sub.id,
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        seats: sub.items.data[0]?.quantity ?? 1,
      });
    }
  } catch (e) {
    return new Response(`handler error: ${e}`, { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
