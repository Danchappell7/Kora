// ============================================================
// KANBO — event notification emails (Deno / Supabase Edge Function)
// Sends a transactional email for assignment / mention / comment events.
// In-app notifications are handled by DB triggers; this is the email side.
// Each recipient's email pref ("<kind>_email" in profiles.notify_prefs) is
// checked server-side, defaulting to ON.
//
// Deploy:  supabase functions deploy notify        (Verify JWT: ON)
// Secrets: RESEND_API_KEY, REMINDER_FROM, APP_URL   (already set for reminders)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const COPY: Record<string, { subj: (t: string) => string; line: string }> = {
  assigned: { subj: (t) => `You were assigned: ${t}`, line: "assigned you a task" },
  mention:  { subj: (t) => `You were mentioned: ${t}`, line: "mentioned you in" },
  comment:  { subj: (t) => `New comment: ${t}`,        line: "commented on" },
};

Deno.serve(async (req) => {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("REMINDER_FROM") ?? "Kanbo <onboarding@resend.dev>";
    const appUrl = Deno.env.get("APP_URL") ?? "";
    if (!resendKey) return json({ error: "no RESEND_API_KEY" }, 400);

    const { kind, taskId, taskTitle, recipientIds } = await req.json();
    if (!kind || !COPY[kind]) return json({ error: "bad kind" }, 400);

    const supa = createClient(url, serviceKey);

    // actor (the person who triggered it) — from the caller's JWT — never email them
    let actorId: string | null = null;
    let actorName = "Someone";
    const auth = req.headers.get("Authorization");
    if (auth) {
      const { data } = await supa.auth.getUser(auth.replace("Bearer ", ""));
      actorId = data.user?.id ?? null;
      if (actorId) {
        const { data: ap } = await supa.from("profiles").select("first_name,last_name").eq("id", actorId).maybeSingle();
        const n = `${ap?.first_name ?? ""} ${ap?.last_name ?? ""}`.trim();
        if (n) actorName = n;
      }
    }

    // resolve recipients
    let recips: string[] = Array.isArray(recipientIds) ? recipientIds : [];
    if (kind === "comment" && recips.length === 0) {
      const { data: t } = await supa.from("tasks").select("user_id,followers").eq("id", taskId).maybeSingle();
      if (t) recips = [t.user_id, ...((t.followers as string[] | null) ?? [])];
    }
    recips = [...new Set(recips)].filter((id) => id && id !== actorId);

    let sent = 0;
    for (const id of recips) {
      const { data: prof } = await supa.from("profiles").select("notify_prefs").eq("id", id).maybeSingle();
      const prefs = (prof?.notify_prefs ?? {}) as Record<string, boolean>;
      if (prefs[`${kind}_email`] === false) continue;
      const { data: u } = await supa.auth.admin.getUserById(id);
      const email = u.user?.email;
      if (!email) continue;
      const link = appUrl ? `${appUrl}/?task=${taskId}` : "";
      const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
        <p style="font-size:15px"><strong>${esc(actorName)}</strong> ${COPY[kind].line} <strong>${esc(taskTitle || "a task")}</strong>.</p>
        ${link ? `<p><a href="${link}" style="display:inline-block;background:#6a5cff;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px">Open in Kanbo</a></p>` : ""}
        <p style="font-size:12px;color:#888">Manage notification emails in Kanbo → Settings.</p>
      </div>`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: email, subject: COPY[kind].subj(taskTitle || "a task"), html }),
      });
      if (res.ok) sent++;
    }
    return json({ ok: true, sent });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

function esc(s: string) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c)); }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }); }
