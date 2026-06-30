// ============================================================
// KANBO — self-serve password reset that actually delivers.
// Supabase's built-in resetPasswordForEmail depends on the project's
// SMTP being configured; this generates the recovery link with the
// admin API and sends it via Resend (already used elsewhere), so the
// "Reset password" flow works without project SMTP.
//
// Called by the signed-out login screen → deploy WITHOUT JWT.
//   supabase functions deploy reset-password --no-verify-jwt
// Secrets (shared): RESEND_API_KEY, REMINDER_FROM, APP_URL
//
// Privacy: always returns { ok: true } regardless of whether the email
// has an account, so it can't be used to enumerate users.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  try {
    const { email } = await req.json() as { email?: string };
    if (!email || !email.includes("@")) return json({ ok: true }); // never reveal validity

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const appUrl = Deno.env.get("APP_URL") ?? "https://www.kanbo.co.uk";

    // recovery link only generates for an existing user; swallow otherwise.
    try {
      const { data, error } = await admin.auth.admin.generateLink({
        type: "recovery",
        email: email.trim().toLowerCase(),
        options: { redirectTo: appUrl },
      });
      const link = data?.properties?.action_link;
      if (!error && link) {
        const html =
          `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">` +
          `<h2 style="font-weight:700;font-size:21px;margin:0 0 6px">Reset your Kanbo password</h2>` +
          `<p style="color:#555;line-height:1.55">Click below to choose a new password. This link expires in an hour and can only be used once.</p>` +
          `<p style="margin:22px 0"><a href="${link}" style="background:#8B5CF6;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Set a new password</a></p>` +
          `<p style="color:#999;font-size:12px">If you didn’t request this, you can safely ignore this email — your password won’t change.</p>` +
          `</div>`;
        await sendEmail(email, "Reset your Kanbo password", html);
      }
    } catch (e) { console.error("generateLink", e); }

    return json({ ok: true });
  } catch {
    return json({ ok: true }); // still don't leak
  }
});
