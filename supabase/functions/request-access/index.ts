// ============================================================
// KANBO — public early-access request intake. Records the request and
// emails the admins so they don't have to keep checking the panel.
// Called by the signed-out landing form, so deploy WITHOUT JWT.
//
// Who gets the "new request" email: the ADMIN_NOTIFY_EMAIL secret (one or
// more addresses, comma-separated) plus every platform admin
// (profiles.is_admin). Each email says how many requests are waiting.
//
// Abuse limits (rate_limits from migration 0042; fails open without it):
//   • one request per email address per minute — repeats are a quiet no-op
//   • one pending request per address; a repeat after approval is dropped by
//     0042's trigger (unless that access was revoked since) — no admin email
//   • per IP: the request is still recorded, but at most 5 admin emails per
//     10 minutes (a whole office behind one IP is never turned away)
//   • at most 20 admin emails per hour overall — the rest wait in the panel
//   • name ≤ 120 chars, note ≤ 1,000 chars, email ≤ 254 chars
//
// Deploy:  supabase functions deploy request-access --no-verify-jwt
// Secrets (shared): RESEND_API_KEY, REMINDER_FROM, APP_URL
//          optional: ADMIN_NOTIFY_EMAIL
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminRecipients, appUrlFrom, esc, isEmail, oneLine, renderEmail, sendEmail, whereEmail } from "../_shared/email.ts";
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
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // the per-email throttle key, once taken — handed back if we fail to save,
  // so a retry isn't swallowed as a "repeat" of a request that doesn't exist
  let emailKey = "";
  let saved = false;
  try {
    const raw = await req.json().catch(() => ({})) as { name?: string; email?: string; note?: string };
    const email = String(raw.email ?? "").trim().toLowerCase();
    const name = oneLine(raw.name ?? "", 120);
    const note = String(raw.note ?? "").trim().slice(0, 1000);
    if (!isEmail(email)) return json({ error: "valid email required" }, 400);

    // same address again within a minute (double-submit, a script) → quiet no-op
    const key = `${KEY_PREFIX}ra:email:${await hashKey(email)}`;
    const perEmail = await hit(admin, key, { windowSec: 60 });
    if (!perEmail.allowed) return json({ ok: true });
    emailKey = key;
    await sweep(admin);

    // one open request per address — a repeat while one is pending is a quiet
    // no-op (a failed lookup isn't fatal: the insert below is de-duplicated by
    // 0042 too). An earlier APPROVED request is 0042's call, not ours: its
    // before-insert trigger drops a repeat from someone already let in, but
    // queues it if that account's access was revoked since.
    const { data: existing, error: findErr } = await whereEmail(admin.from("access_requests").select("id").eq("status", "pending"), "email", email).limit(1);
    if (findErr) console.warn("request-access lookup", findErr.message);
    if ((existing ?? []).length) return json({ ok: true });
    const { data: inserted, error } = await admin.from("access_requests").insert({ name, email, note: note || null }).select("id");
    if (error) {
      // a simultaneous duplicate hit the one-pending-per-email index: already recorded
      if (error.code === "23505") return json({ ok: true });
      throw new Error(`insert: ${error.message}`);
    }
    // no row back: the trigger dropped a repeat, so there's nothing new for the admins
    if (!(inserted ?? []).length) return json({ ok: true });
    saved = true;

    // ---- tell the admins (best-effort; the request is already saved) ----
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) return json({ ok: true });
    const ip = clientIp(req.headers);
    if (ip) {
      const perIp = await hit(admin, `${KEY_PREFIX}ra:ip:${await hashKey(ip)}`, { windowSec: 600, max: 5 });
      if (!perIp.allowed) return json({ ok: true });
    }
    const overall = await hit(admin, `${KEY_PREFIX}ra:admin-mail`, { windowSec: 3600, max: 20 });
    if (!overall.allowed) return json({ ok: true });

    const to = await adminRecipients(admin, Deno.env.get("ADMIN_NOTIFY_EMAIL"));
    if (!to.length) {
      console.warn("request-access: no admin recipients — set ADMIN_NOTIFY_EMAIL or mark an admin in profiles.is_admin");
      return json({ ok: true });
    }
    const { count } = await admin.from("access_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
    const waiting = typeof count === "number" && count > 0 ? count : 1;
    const appUrl = appUrlFrom(Deno.env.get("APP_URL"));
    const { html, text } = renderEmail({
      heading: "New early-access request",
      paragraphs: [
        `<strong>${esc(name || "—")}</strong><br>${esc(email)}` + (note ? `<br><span style="color:#71717a">${esc(note).replace(/\n/g, "<br>")}</span>` : ""),
        waiting > 1 ? `${waiting} requests are waiting for review.` : "This is the only request waiting for review.",
      ],
      cta: { label: "Review in admin", href: `${appUrl}/admin` },
    });
    await sendEmail({ resendKey, from: Deno.env.get("REMINDER_FROM") }, {
      to,
      subject: `New Kanbo access request — ${oneLine(name || email, 80)}`,
      html, text,
      replyTo: email,
    });
    return json({ ok: true });
  } catch (e) {
    console.error("request-access error", e);
    // saved already (the admin email is best-effort) → it's recorded; say so
    if (saved) return json({ ok: true });
    if (emailKey) await release(admin, emailKey);
    return json({ error: "couldn't save your request" }, 500);
  }
});
