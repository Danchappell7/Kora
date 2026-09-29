// ============================================================
// KANBO — approve OR decline an early-access request + email the person.
// Platform-admin only (public.is_admin(): profiles.is_admin or the founding
// account). Body: { id, action?: "approve" | "decline" } (default approve).
//
// Approve → marks the request approved, makes sure an account exists and is
// approved, then emails the right way in:
//   • never signed in → a scanner-safe set-password link
//     APP_URL/?token_hash=…&type=recovery (the app verifies it only when the
//     person presses Continue, so mail scanners can't burn it)
//   • already signs in (e.g. signed up and was waiting) → "you're in, sign in"
// Clicking Approve twice within a minute sends one email, not two (a second
// link would invalidate the first).
//
// Deploy AFTER the app with the ?token_hash= landing is live:
//          supabase functions deploy approve-access   (Verify JWT ON)
// Secrets (shared with daily-reminders): RESEND_API_KEY, REMINDER_FROM, APP_URL
// Uses:    rate_limits from migration 0042 (works without it — fails open)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appUrlFrom, esc, isEmail, isUuid, renderEmail, sendEmail, tokenLink } from "../_shared/email.ts";
import { hashKey, hit, KEY_PREFIX, release } from "../_shared/limits.ts";
import { findUserByEmail } from "../_shared/users.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: ures } = await asUser.auth.getUser();
  if (!ures?.user) return json({ error: "unauthorized" }, 401);
  // platform admins only — is_admin() covers the founding account too
  const { data: isAdmin } = await asUser.rpc("is_admin");
  if (!isAdmin) return json({ error: "unauthorized" }, 401);

  try {
    const { id, action = "approve" } = await req.json().catch(() => ({})) as { id?: string; action?: string };
    if (!isUuid(id)) return json({ error: "missing id" }, 400);
    if (action !== "approve" && action !== "decline") return json({ error: "bad action" }, 400);

    const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: reqRow } = await admin.from("access_requests").select("*").eq("id", id).maybeSingle();
    if (!reqRow) return json({ error: "request not found" }, 404);
    const first = String(reqRow.name || "").trim().split(/\s+/)[0]?.slice(0, 40) || "there";
    const appUrl = appUrlFrom(Deno.env.get("APP_URL"));
    const mail = { resendKey: Deno.env.get("RESEND_API_KEY"), from: Deno.env.get("REMINDER_FROM") };
    const email = String(reqRow.email ?? "").trim().toLowerCase();
    if (!isEmail(email)) return json({ error: "that request has an invalid email address" }, 400);

    if (action === "decline") {
      // declining twice doesn't email twice
      if (reqRow.status === "declined") return json({ ok: true, emailed: false, note: "already declined" });
      await admin.from("access_requests").update({ status: "declined" }).eq("id", id);
      const { html, text } = renderEmail({
        heading: `Thanks for your interest in Kanbo, ${first}`,
        paragraphs: [
          "We’re onboarding people in small batches during early access and can’t fit everyone in just yet. We’ve kept your details and will be in touch if a place opens up.",
          "Thanks for your patience.",
        ],
      });
      const sent = await sendEmail(mail, { to: email, subject: "An update on your Kanbo early-access request", html, text });
      return json({ ok: true, emailed: sent.ok });
    }

    // approve — mark the request approved FIRST so the profile auto-approve
    // trigger (which looks for an approved request) fires when we create the
    // account below.
    await admin.from("access_requests").update({ status: "approved" }).eq("id", id);

    // Provision the auth account up-front so the person never has to hunt for a
    // signup form (hidden in invite-only mode). Harmless if they already have one.
    const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createErr && !/already|registered|exists/i.test(createErr.message)) console.error("createUser", createErr.message);

    // approve their profile by email (covers a pre-existing, unapproved account)
    // (exact match — ilike would treat _ and % in the address as wildcards)
    const { data: au } = await admin.from("profiles").select("id").eq("email", email);
    const ids = (au ?? []).map((r) => r.id);
    if (ids.length) await admin.from("profiles").update({ approved: true }).in("id", ids);

    // one email per person per minute — a double-click would otherwise send a
    // second set-password link that silently kills the first
    const onceKey = `${KEY_PREFIX}approve:${await hashKey(email)}`;
    const once = await hit(admin, onceKey, { windowSec: 60 });
    if (!once.allowed) return json({ ok: true, emailed: true, note: "already emailed in the last minute" });

    const existing = await findUserByEmail(admin, email);
    const host = appUrl.replace(/^https?:\/\//, "");
    let rendered: { html: string; text: string };
    let subject: string;
    let link = false;

    if (existing?.hasSignedIn) {
      // they already have a password (or Google) — just let them in
      subject = "You’re in — your Kanbo access is approved";
      rendered = renderEmail({
        heading: `You’re in, ${first} 🎉`,
        paragraphs: [
          `Your Kanbo early access has been approved. Sign in as <strong>${esc(email)}</strong> with the password you chose and Kanbo will plan your day from the first task.`,
        ],
        cta: { label: "Sign in to Kanbo", href: appUrl },
        footnotes: [`Forgotten your password? Choose <strong>Sign in → Forgot password?</strong> on ${esc(host)}.`],
      });
    } else {
      // one-time set-password link, delivered via Resend (independent of project SMTP)
      let href = appUrl;
      try {
        const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
          type: "recovery", email, options: { redirectTo: appUrl },
        });
        const h = linkData?.properties?.hashed_token;
        if (!linkErr && h) { href = tokenLink(appUrl, h, "recovery"); link = true; }
        else console.error("generateLink", linkErr?.message ?? "no hashed_token");
      } catch (e) { console.error("generateLink", e); }
      subject = "You’re in — set your Kanbo password";
      rendered = renderEmail({
        heading: `You’re in, ${first} 🎉`,
        paragraphs: [
          link
            ? "Your Kanbo early access has been approved. Set your password below and you’ll be signed straight in — Kanbo will plan your day from the first task."
            : `Your Kanbo early access has been approved. Go to ${esc(host)}, choose <strong>Sign in → Forgot password?</strong> and enter ${esc(email)} to set your password.`,
        ],
        cta: link ? { label: "Set your password & sign in", href } : { label: "Open Kanbo", href: appUrl },
        footnotes: [
          ...(link ? [`For your security the button works once and expires. If it has expired, choose <strong>Sign in → Forgot password?</strong> on ${esc(host)} and enter ${esc(email)}.`] : []),
          "If you didn’t request this, you can ignore this email.",
        ],
      });
    }

    const sent = await sendEmail(mail, { to: email, subject, ...rendered });
    if (!sent.ok) await release(admin, onceKey); // let the admin retry straight away
    return json({ ok: true, emailed: sent.ok, link });
  } catch (e) {
    console.error("approve-access error", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
