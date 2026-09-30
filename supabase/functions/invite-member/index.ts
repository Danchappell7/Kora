// ============================================================
// KANBO — email a workspace invite (Deno / Supabase Edge Function)
// The app calls this right after the invite_member RPC succeeds (and again
// whenever it re-sends an invite). Body: { memberId } — the
// workspace_members row id.
//
// Trust model: the caller comes from their JWT; the workspace role check is
// the database's own ws_role(), run AS the caller, so only a workspace
// owner/admin can send its invites. Everything that goes into the email
// (workspace name, inviter name, invitee address, role) is read from the
// database and HTML-escaped — nothing is taken from the request body.
//
// What the invitee gets:
//   • brand-new address → a Supabase invite link (creates the account) sent as
//     APP_URL/?token_hash=…&type=invite — the app verifies it only when they
//     press Continue, so mail scanners can't burn it — then they set a password
//   • account that has never signed in → a set-password (recovery) link
//   • account that already signs in → a plain "Open Kanbo" link; the invite is
//     claimed automatically on their next load (claim_invites)
// An invite counts as approval: an approved access_requests row is recorded
// (so the new account is auto-approved) and an existing pending account is
// approved.
//
// Responses: { ok: true, sent: true }
//            { ok: true, sent: false, reason: "throttled" (emailed under a
//                minute ago — that link still works) | "email_not_configured"
//                | "not_sent" (delivery failed, or we won't email this address;
//                the exact cause is only logged, so the reply never tells an
//                inviter whether an address has a Kanbo account) }
//            429 { reason: "inviter_limit", error, retryAfter } — the invite
//                row is saved; only the email is held back
//            401 / 403 / 404 / 409 / 502 { error }
//
// Deploy:  supabase functions deploy invite-member        (Verify JWT: ON)
// Secrets: RESEND_API_KEY, REMINDER_FROM, APP_URL           (shared)
// Uses:    rate_limits from migration 0042 (works without it — fails open)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appUrlFrom, esc, isEmail, isUuid, oneLine, renderEmail, sendEmail, tokenLink, whereEmail } from "../_shared/email.ts";
import { hit, KEY_PREFIX, release, sweep } from "../_shared/limits.ts";
import { findUserByEmail } from "../_shared/users.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ROLE_LINE: Record<string, string> = {
  admin: "an admin",
  member: "a member",
  guest: "a guest (you'll be able to view and comment)",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("REMINDER_FROM");
    const appUrl = appUrlFrom(Deno.env.get("APP_URL"));

    // ---- who's asking ----
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: ures } = await asUser.auth.getUser();
    const me = ures?.user;
    if (!me) return json({ error: "sign in required" }, 401);

    const body = await req.json().catch(() => ({}));
    const memberId = String(body?.memberId ?? "");
    if (!isUuid(memberId)) return json({ error: "bad memberId" }, 400);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: m } = await admin.from("workspace_members")
      .select("id,workspace_id,email,name,role,status").eq("id", memberId).maybeSingle();
    if (!m) return json({ error: "invite not found" }, 404);

    // only the workspace's owner/admins — the database decides, as the caller
    const { data: role, error: roleErr } = await asUser.rpc("ws_role", { ws: m.workspace_id });
    if (roleErr || !["owner", "admin"].includes(String(role))) return json({ error: "not allowed" }, 403);
    if (m.status !== "invited") return json({ ok: false, sent: false, error: "already a member" }, 409);

    const email = String(m.email ?? "").trim().toLowerCase();
    if (!isEmail(email)) return json({ error: "that invite has an invalid email address" }, 400);
    if (!resendKey) return json({ ok: true, sent: false, reason: "email_not_configured" });

    // ---- throttles: one email per invite per minute (double-clicks, re-send
    // mashing — and a second link would kill the first); 500 invites/hour per
    // inviter — room to invite a whole company in one sitting, but invites
    // can't be used to mass-mail from Kanbo's address ----
    const inviteKey = `${KEY_PREFIX}invite:member:${memberId}`;
    const perInvite = await hit(admin, inviteKey, { windowSec: 60 });
    if (!perInvite.allowed) return json({ ok: true, sent: false, reason: "throttled", retryAfter: perInvite.retryAfter });
    const perInviter = await hit(admin, `${KEY_PREFIX}invite:by:${me.id}`, { windowSec: 3600, max: 500 });
    if (!perInviter.allowed) {
      await release(admin, inviteKey);
      return json({ ok: false, sent: false, reason: "inviter_limit", error: "You've sent a lot of invites this hour. They're saved; resend the emails a little later.", retryAfter: perInviter.retryAfter }, 429);
    }
    await sweep(admin);

    // ---- names for the email, from the database ----
    const [{ data: ws }, { data: prof }] = await Promise.all([
      admin.from("workspaces").select("name").eq("id", m.workspace_id).maybeSingle(),
      admin.from("profiles").select("first_name,last_name").eq("id", me.id).maybeSingle(),
    ]);
    const wsName = oneLine(ws?.name || "a team workspace", 60);
    const inviter = oneLine(`${prof?.first_name ?? ""} ${prof?.last_name ?? ""}`.trim() || me.email || "A teammate", 60);
    const inviteeFirst = oneLine(String(m.name ?? "").trim().split(/\s+/)[0] ?? "", 40);

    // ---- an invite counts as approval ----
    await recordApproval(admin, email, String(m.name ?? ""), `Invited to ${wsName} by ${inviter}`);

    // ---- the right way in for this person ----
    let mode: "setup" | "signin" = "setup";
    let link = "";
    const fail = async (why: string, detail?: string) => {
      console.error("invite-member:", why, detail ?? "");
      await release(admin, inviteKey);
      return json({ ok: false, sent: false, error: "Couldn't create the invite link. Please try again." }, 502);
    };

    const existing = await findUserByEmail(admin, email);
    if (existing?.suspended) {
      console.warn("invite-member: not emailing a suspended account");
      await release(admin, inviteKey);
      return json({ ok: true, sent: false, reason: "not_sent" });
    }
    if (existing) {
      if (existing.approved === false) await admin.from("profiles").update({ approved: true }).eq("id", existing.id);
      if (existing.hasSignedIn) {
        mode = "signin";
      } else {
        const r = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: appUrl } });
        const h = r.data?.properties?.hashed_token;
        if (r.error || !h) return await fail("recovery link", r.error?.message);
        link = tokenLink(appUrl, h, "recovery");
      }
    } else {
      const r = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo: appUrl } });
      if (!r.error && r.data?.properties?.hashed_token) {
        link = tokenLink(appUrl, r.data.properties.hashed_token, "invite");
      } else if (r.error && /already|registered|exists/i.test(r.error.message)) {
        // an account with no profile row yet — fall back to a set-password link
        const rr = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: appUrl } });
        const uid = rr.data?.user?.id;
        if (uid) await admin.from("profiles").update({ approved: true }).eq("id", uid).eq("approved", false).eq("suspended", false);
        if (rr.data?.user?.last_sign_in_at) mode = "signin";
        else if (!rr.error && rr.data?.properties?.hashed_token) link = tokenLink(appUrl, rr.data.properties.hashed_token, "recovery");
        else return await fail("recovery link (fallback)", rr.error?.message);
      } else {
        return await fail("invite link", r.error?.message);
      }
    }

    // ---- the email ----
    const host = appUrl.replace(/^https?:\/\//, "");
    const { html, text } = renderEmail({
      heading: `Join ${wsName} on Kanbo`,
      paragraphs: [
        inviteeFirst ? `Hi ${esc(inviteeFirst)},` : "Hi,",
        `<strong>${esc(inviter)}</strong> has invited you to join <strong>${esc(wsName)}</strong> on Kanbo as ${esc(ROLE_LINE[m.role] ?? "a member")}. Kanbo is where the team plans, assigns and tracks its work.`,
        mode === "setup"
          ? "Accept the invite, choose a password and you'll go straight into the workspace."
          : `You already have a Kanbo account, so just sign in as <strong>${esc(email)}</strong> — you'll find ${esc(wsName)} in your workspace switcher.`,
      ],
      cta: mode === "setup" ? { label: "Accept invite & set password", href: link } : { label: "Open Kanbo", href: appUrl },
      footnotes: [
        ...(mode === "setup"
          ? [`For your security the button works once and expires. If it has expired, go to <a href="${esc(appUrl)}" style="color:#71717a">${esc(host)}</a>, choose <strong>Sign in → Forgot password?</strong> and enter ${esc(email)}.`]
          : []),
        `This invitation was sent to ${esc(email)}. If you weren't expecting it, you can safely ignore this email.`,
      ],
    });
    const res = await sendEmail({ resendKey, from }, {
      to: email,
      subject: `${inviter} invited you to ${wsName} on Kanbo`,
      html, text,
    });
    if (!res.ok) {
      await release(admin, inviteKey);
      return json({ ok: true, sent: false, reason: "not_sent" });
    }
    return json({ ok: true, sent: true });
  } catch (e) {
    console.error("invite-member error", e);
    return json({ error: "Something went wrong sending that invite." }, 500);
  }
});

// Mark the address approved for early access (idempotent): reuse a pending
// request if there is one, otherwise record an approved one.
// deno-lint-ignore no-explicit-any
async function recordApproval(admin: any, email: string, name: string, note: string) {
  try {
    const { data: rows, error } = await whereEmail(admin.from("access_requests").select("id,status"), "email", email).limit(20);
    if (error) { console.warn("invite-member: access_requests lookup", error.message); return; }
    const list = (rows ?? []) as { id: string; status: string }[];
    if (list.some((r) => r.status === "approved")) return;
    const pending = list.filter((r) => r.status === "pending").map((r) => r.id);
    const { error: wErr } = pending.length
      ? await admin.from("access_requests").update({ status: "approved" }).in("id", pending)
      : await admin.from("access_requests").insert({ name: oneLine(name, 120), email, note: oneLine(note, 300), status: "approved" });
    if (wErr) console.warn("invite-member: access_requests write", wErr.message);
  } catch (e) {
    console.warn("invite-member: recordApproval", e);
  }
}
