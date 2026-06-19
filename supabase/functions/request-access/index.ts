// ============================================================
// KANBO — public early-access request intake. Records the request and
// emails the admin so they don't have to keep checking the panel.
// Called by the signed-out landing form, so deploy WITHOUT JWT.
//
// Deploy:  supabase functions deploy request-access --no-verify-jwt
// Secrets (shared): RESEND_API_KEY, REMINDER_FROM, APP_URL
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { name, email, note } = await req.json() as { name?: string; email?: string; note?: string };
    if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error } = await admin.from("access_requests").insert({ name: name || "", email, note: note || null });
    if (error) return json({ error: error.message }, 500);

    // notify the admin (best-effort)
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (resendKey) {
      const from = Deno.env.get("REMINDER_FROM") ?? "Kanbo <onboarding@resend.dev>";
      const appUrl = Deno.env.get("APP_URL") ?? "https://www.kanbo.co.uk";
      const html =
        `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">` +
        `<h2 style="font-weight:700;font-size:20px;margin:0 0 6px">New early-access request</h2>` +
        `<p style="color:#555;line-height:1.6"><strong>${(name || "—").replace(/[<>]/g, "")}</strong><br>${email.replace(/[<>]/g, "")}</p>` +
        `<p style="margin:18px 0"><a href="${appUrl}/admin" style="background:#8B5CF6;color:#fff;padding:10px 16px;border-radius:9px;text-decoration:none;font-weight:600">Review in admin</a></p>` +
        `</div>`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: ADMIN_EMAIL, subject: `New Kanbo access request — ${name || email}`, html }),
      }).catch((e) => console.error("notify error", e));
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
