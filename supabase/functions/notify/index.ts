// ============================================================
// KANBO — event notification emails (Deno / Supabase Edge Function)
// Sends a transactional email for assignment / mention / comment events.
// In-app notifications are handled by DB triggers; this is the email side.
// Each recipient's email pref ("<kind>_email" in profiles.notify_prefs) is
// checked server-side, defaulting to ON.
//
// Trust model: the caller must be signed in and able to see the task. The
// task title, link and recipients all come from the database — the client
// only says which task and what happened — so this can't be used to send
// arbitrary Kanbo-branded mail to arbitrary people.
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECIPIENTS = 25;

interface TaskRow {
  id: string; title: string | null; user_id: string; workspace_id: string | null; assignee_id: string | null;
  followers: string[] | null; collaborators: string[] | null; archived_at: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("REMINDER_FROM") ?? "Kanbo <onboarding@resend.dev>";
    const appUrl = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
    if (!resendKey) return json({ error: "no RESEND_API_KEY" }, 400);

    const body = await req.json().catch(() => ({}));
    const kind = String(body?.kind ?? "");
    const taskId = String(body?.taskId ?? "");
    if (!COPY[kind]) return json({ error: "bad kind" }, 400);
    if (!UUID.test(taskId)) return json({ error: "bad taskId" }, 400);

    const supa = createClient(url, serviceKey);

    // the actor must be a real, signed-in, active account
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: who } = token ? await supa.auth.getUser(token) : { data: { user: null } };
    const actorId = who?.user?.id ?? null;
    if (!actorId) return json({ error: "sign in required" }, 401);
    const { data: ap } = await supa.from("profiles").select("first_name,last_name,approved,suspended").eq("id", actorId).maybeSingle();
    if (ap && (ap.suspended || ap.approved === false)) return json({ error: "not allowed" }, 403);
    const actorName = `${ap?.first_name ?? ""} ${ap?.last_name ?? ""}`.trim() || who?.user?.email || "Someone";

    // the task — title/recipients come from here, never from the request
    const { data: t } = await supa.from("tasks")
      .select("id,title,user_id,workspace_id,assignee_id,followers,collaborators,archived_at")
      .eq("id", taskId).maybeSingle<TaskRow>();
    if (!t) return json({ error: "task not found" }, 404);
    if (t.archived_at) return json({ ok: true, sent: 0, note: "archived" });

    // who can see this task: its creator (personal) or active workspace members
    const members = new Set<string>();
    if (t.workspace_id) {
      const { data: ms } = await supa.from("workspace_members").select("user_id")
        .eq("workspace_id", t.workspace_id).eq("status", "active");
      for (const m of ms ?? []) if (m.user_id) members.add(m.user_id);
      const { data: ws } = await supa.from("workspaces").select("owner_id").eq("id", t.workspace_id).maybeSingle();
      if (ws?.owner_id) members.add(ws.owner_id);
    } else {
      members.add(t.user_id);
    }
    if (!members.has(actorId)) return json({ error: "not allowed" }, 403);

    // recipients by event, from the database
    let recips: string[] = [];
    if (kind === "assigned") {
      // the app fires this alongside the save, so the row may not show the new
      // assignee yet — accept the named assignee too (still members-only below)
      const named = Array.isArray(body?.recipientIds) ? body.recipientIds.slice(0, 3).map(String) : [];
      recips = [t.assignee_id ?? "", ...named];
    } else {
      // the actor's most recent comment on this task (the one that triggered this)
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: c } = await supa.from("comments").select("mentions,created_at")
        .eq("task_id", taskId).eq("user_id", actorId).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const mentioned = ((c?.mentions as string[] | null) ?? []).map(String);
      if (!c) return json({ ok: true, sent: 0, note: "no recent comment" });
      if (kind === "mention") {
        recips = mentioned;
      } else {
        // creator, assignee, collaborators, followers — minus anyone who already
        // gets the (more specific) mention email for this same comment
        recips = [t.user_id, t.assignee_id ?? "", ...(t.collaborators ?? []), ...(t.followers ?? [])]
          .filter((id) => !mentioned.includes(id));
      }
    }
    recips = [...new Set(recips.map(String))]
      .filter((id) => UUID.test(id) && id !== actorId && members.has(id))
      .slice(0, MAX_RECIPIENTS);

    const title = oneLine(t.title || "a task");
    const link = appUrl ? `${appUrl}/?task=${encodeURIComponent(taskId)}` : "";
    let sent = 0;
    for (const id of recips) {
      const { data: prof } = await supa.from("profiles").select("notify_prefs,suspended").eq("id", id).maybeSingle();
      if (prof?.suspended) continue;
      const prefs = (prof?.notify_prefs ?? {}) as Record<string, boolean>;
      if (prefs[`${kind}_email`] === false) continue;
      const { data: u } = await supa.auth.admin.getUserById(id);
      const email = u.user?.email;
      if (!email) continue;
      const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
        <p style="font-size:15px"><strong>${esc(actorName)}</strong> ${COPY[kind].line} <strong>${esc(title)}</strong>.</p>
        ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#6a5cff;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px">Open in Kanbo</a></p>` : ""}
        <p style="font-size:12px;color:#888">Manage notification emails in Kanbo → Settings.</p>
      </div>`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: email, subject: COPY[kind].subj(title), html }),
      });
      if (res.ok) sent++;
      else console.error("resend", res.status, await res.text().catch(() => ""));
    }
    return json({ ok: true, sent });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

function oneLine(s: string) { return String(s).replace(/[\r\n]+/g, " ").slice(0, 140); }
function esc(s: string) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c)); }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } }); }
