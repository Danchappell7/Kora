// ============================================================
// KANBO — approve OR decline an early-access request + email the person.
// Admin-only. Body: { id, action?: "approve" | "decline" } (default approve).
//
// Deploy:  supabase functions deploy approve-access   (Verify JWT ON)
// Secrets (shared with daily-reminders): RESEND_API_KEY, REMINDER_FROM, APP_URL
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAIL = "danchappell7@gmail.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return false;
  const from = Deno.env.get("REMINDER_FROM") ?? "Kanbo <onboarding@resend.dev>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!r.ok) console.error("resend error", await r.text());
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: ures } = await asUser.auth.getUser();
  if (!ures?.user || (ures.user.email ?? "") !== ADMIN_EMAIL) return json({ error: "unauthorized" }, 401);

  try {
    const { id, action = "approve" } = await req.json() as { id: string; action?: "approve" | "decline" };
    if (!id) return json({ error: "missing id" }, 400);

    const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: reqRow } = await admin.from("access_requests").select("*").eq("id", id).maybeSingle();
    if (!reqRow) return json({ error: "request not found" }, 404);
    const first = (reqRow.name || "").trim().split(/\s+/)[0] || "there";
    const appUrl = Deno.env.get("APP_URL") ?? "https://www.kanbo.co.uk";

    if (action === "decline") {
      await admin.from("access_requests").update({ status: "declined" }).eq("id", id);
      const html =
        `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">` +
        `<h2 style="font-weight:700;font-size:20px;margin:0 0 6px">Thanks for your interest in Kanbo, ${first}</h2>` +
        `<p style="color:#555;line-height:1.55">We’re onboarding people in small batches during early access and can’t fit everyone in just yet. We’ve kept your details and will reach out if a spot opens up. Thanks for your patience.</p>` +
        `</div>`;
      const emailed = await sendEmail(reqRow.email, "An update on your Kanbo early-access request", html);
      return json({ ok: true, emailed });
    }

    // approve
    await admin.from("access_requests").update({ status: "approved" }).eq("id", id);
    await admin.from("profiles").update({ approved: true }).ilike("email", reqRow.email);
    const html =
      `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">` +
      `<h2 style="font-weight:700;font-size:22px;margin:0 0 6px">You’re in, ${first} 🎉</h2>` +
      `<p style="color:#555;line-height:1.55">Your Kanbo early access has been approved. Create your account with this email address and Kanbo will plan your day from the first task.</p>` +
      `<p style="margin:22px 0"><a href="${appUrl}" style="background:#8B5CF6;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Get started</a></p>` +
      `<p style="color:#999;font-size:12px">If you didn’t request this, you can ignore this email.</p>` +
      `</div>`;
    const emailed = await sendEmail(reqRow.email, "You’re in — your Kanbo access is approved", html);
    return json({ ok: true, emailed });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
