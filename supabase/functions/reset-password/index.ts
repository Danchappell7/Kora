// ============================================================
// KANBO — self-serve password reset that actually delivers.
// Supabase's built-in resetPasswordForEmail depends on the project's
// SMTP being configured; this generates the recovery link with the
// admin API and sends it via Resend (already used elsewhere), so the
// "Reset password" flow works without project SMTP.
//
// The emailed link is scanner-safe: APP_URL/?token_hash=…&type=recovery.
// The app only verifies it when the person presses Continue, so corporate
// link scanners (Safe Links, Mimecast) can't use it up first.
// Deploy AFTER the app with the ?token_hash= landing is live.
//
// Called by the signed-out login screen → deploy WITHOUT JWT.
//   supabase functions deploy reset-password --no-verify-jwt
// Secrets (shared): RESEND_API_KEY, REMINDER_FROM, APP_URL
//
// Responses (never reveal whether an account exists):
//   { ok: true }                          handled (sent, or no such account)
//   { ok: true, throttled: true, retryAfter }
//                                         a link went to this address under a
//                                         minute ago — that one still works
//   { ok: true, fallback: true }          we couldn't deliver (Resend down or
//                                         not configured, or this network has
//                                         sent a lot of resets) — the app then
//                                         uses Supabase's built-in reset email
// Limits (rate_limits from migration 0042; fails open without it):
//   one email per address per minute and 5 per hour; 20 per IP per 10 min.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appUrlFrom, esc, isEmail, renderEmail, sendEmail, tokenLink } from "../_shared/email.ts";
import { clientIp, hashKey, hit, KEY_PREFIX, release, sweep } from "../_shared/limits.ts";

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
    const body = await req.json().catch(() => ({})) as { email?: string };
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!isEmail(email)) return json({ ok: true }); // never reveal validity
    // no mail provider configured → tell the app to use Supabase's built-in
    // reset email instead (says nothing about whether the account exists)
    if (!Deno.env.get("RESEND_API_KEY")) return json({ ok: true, fallback: true });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const appUrl = appUrlFrom(Deno.env.get("APP_URL"));

    // ---- throttles ----
    // per address: a second link would invalidate the first, and nobody's
    // inbox should be floodable from our sender
    const emailHash = await hashKey(email);
    const minuteKey = `${KEY_PREFIX}rp:email:${emailHash}`;
    const perMinute = await hit(admin, minuteKey, { windowSec: 60 });
    if (!perMinute.allowed) return json({ ok: true, throttled: true, retryAfter: perMinute.retryAfter });
    const perHour = await hit(admin, `${KEY_PREFIX}rp:email-hour:${emailHash}`, { windowSec: 3600, max: 5 });
    if (!perHour.allowed) return json({ ok: true, throttled: true, retryAfter: perHour.retryAfter });
    // per network: generous (an office shares one IP); beyond it the app falls
    // back to Supabase's own (separately rate-limited) reset email
    const ip = clientIp(req.headers);
    if (ip) {
      const perIp = await hit(admin, `${KEY_PREFIX}rp:ip:${await hashKey(ip)}`, { windowSec: 600, max: 20 });
      if (!perIp.allowed) { await release(admin, minuteKey); return json({ ok: true, fallback: true }); }
    }
    await sweep(admin);

    // recovery link only generates for an existing user; swallow otherwise.
    let hashed: string | undefined;
    try {
      const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: appUrl } });
      if (error) {
        const notFound = error.status === 404 || /not.?found|no user/i.test(error.message) || (error as { code?: string }).code === "user_not_found";
        if (notFound) return json({ ok: true });
        console.error("generateLink", error.status, error.message);
        await release(admin, minuteKey);
        return json({ ok: true, fallback: true });
      }
      hashed = data?.properties?.hashed_token;
    } catch (e) {
      console.error("generateLink", e);
      await release(admin, minuteKey);
      return json({ ok: true, fallback: true });
    }
    if (!hashed) return json({ ok: true });

    const host = appUrl.replace(/^https?:\/\//, "");
    const { html, text } = renderEmail({
      heading: "Reset your Kanbo password",
      paragraphs: ["Press the button below to choose a new password. You’ll be signed straight in."],
      cta: { label: "Set a new password", href: tokenLink(appUrl, hashed, "recovery") },
      footnotes: [
        `The button works once and expires for your security. If it has expired, request a new link from <a href="${esc(appUrl)}" style="color:#71717a">${esc(host)}</a>.`,
        "If you didn’t ask for this, you can safely ignore this email — your password won’t change.",
      ],
    });
    const sent = await sendEmail({ resendKey: Deno.env.get("RESEND_API_KEY"), from: Deno.env.get("REMINDER_FROM") }, {
      to: email, subject: "Reset your Kanbo password", html, text,
    });
    if (!sent.ok) {
      // couldn't deliver: let the app send Supabase's own reset email instead
      await release(admin, minuteKey);
      return json({ ok: true, fallback: true });
    }
    return json({ ok: true });
  } catch (e) {
    console.error("reset-password error", e);
    return json({ ok: true, fallback: true }); // still don't leak
  }
});
