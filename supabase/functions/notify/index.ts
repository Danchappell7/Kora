// ============================================================
// KANBO — event notification emails + web push (Deno / Supabase Edge Function)
// Sends a transactional email for assignment / mention / comment events,
// and a web push to each of the recipient's devices that switched push on.
// In-app notifications are handled by DB triggers; this is the email and
// push side. Each recipient's prefs ("<kind>_email", "<kind>_push" in
// profiles.notify_prefs) are checked server-side, defaulting to ON.
// Email needs RESEND_API_KEY; push needs the VAPID secrets (0043). Either
// works without the other; with neither, 400 as before.
//
// { kind: "test", endpoint? } sends Settings' test notification to the
// caller's own device(s): 200 { ok, sent } · 409 { reason: "no_subscription" }
// · 429 { reason: "rate_limited" } · 503 { reason: "unconfigured" }.
//
// Trust model: the caller must be signed in and able to see the task. The
// task title, link and recipients all come from the database — the client
// only says which task and what happened — so this can't be used to send
// arbitrary Kanbo-branded mail to arbitrary people. "assigned" also needs
// write access (guests are read-only, so they never assign anyone).
//
// Push is stricter, because it lands on a lock screen:
//  - "assigned" pushes only to the task's assignee as the database has it,
//    and only when the database shows the caller just made that assignment
//    (task_events from the last 10 minutes, or they just created the task
//    already assigned) — never to ids the request names;
//  - mention / comment push for the caller's most recent comment only;
//  - each recipient gets one push per event (so replaying a call alerts
//    nobody again) and at most one a minute per task and kind.
//
// Volume cap: 150 calls per person per 10 minutes (room for bulk
// reassignments), then 429 — in-app notifications still arrive via triggers.
// Uses rate_limits from migration 0042; fails open without it.
//
// Deploy:  supabase functions deploy notify        (Verify JWT: ON)
// Secrets: RESEND_API_KEY, REMINDER_FROM, APP_URL   (already set for reminders)
//          VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (push; see docs/integrations/push.md)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hit, KEY_PREFIX } from "../_shared/limits.ts";
import {
  assignmentEventKey, isAllowedPushEndpoint, PUSH_EVENT_WINDOW_SEC, pushOnceKeys, pushToUser, taskEventPush, TEST_PUSH,
  vapidFromEnv, type AssigneeEvent, type VapidKeys,
} from "../_shared/webpush.ts";

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
  followers: string[] | null; collaborators: string[] | null; archived_at: string | null; created_at: string | null;
}
/** roles that may change tasks (0041 can_write); guests are read-only */
const WRITERS = new Set(["owner", "admin", "member"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("REMINDER_FROM") ?? "Kanbo <onboarding@resend.dev>";
    const appUrl = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
    // push is optional: null (skipped quietly) until the VAPID secrets are set
    const vapid = vapidFromEnv((k) => Deno.env.get(k));

    const body = await req.json().catch(() => ({}));
    const kind = String(body?.kind ?? "");
    const supa = createClient(url, serviceKey);
    if (kind === "test") return await testPush(supa, req, body, vapid);

    if (!resendKey && !vapid) return json({ error: "no RESEND_API_KEY" }, 400);
    const taskId = String(body?.taskId ?? "");
    if (!COPY[kind]) return json({ error: "bad kind" }, 400);
    if (!UUID.test(taskId)) return json({ error: "bad taskId" }, 400);

    // the actor must be a real, signed-in, active account
    const actor = await signedInActor(supa, req);
    if (actor instanceof Response) return actor;
    const { actorId, who, ap } = actor;
    const volume = await hit(supa, `${KEY_PREFIX}notify:${actorId}`, { windowSec: 600, max: 150 });
    if (!volume.allowed) return json({ error: "too many notifications — slow down", retryAfter: volume.retryAfter }, 429);
    const actorName = `${ap?.first_name ?? ""} ${ap?.last_name ?? ""}`.trim() || who?.user?.email || "Someone";

    // the task — title/recipients come from here, never from the request
    const { data: t } = await supa.from("tasks")
      .select("id,title,user_id,workspace_id,assignee_id,followers,collaborators,archived_at,created_at")
      .eq("id", taskId).maybeSingle<TaskRow>();
    if (!t) return json({ error: "task not found" }, 404);
    if (t.archived_at) return json({ ok: true, sent: 0, note: "archived" });

    // who can see this task: its creator (personal) or active workspace members
    const members = new Set<string>();
    let actorRole = "none";
    if (t.workspace_id) {
      const { data: ms } = await supa.from("workspace_members").select("user_id,role")
        .eq("workspace_id", t.workspace_id).eq("status", "active");
      for (const m of ms ?? []) {
        if (!m.user_id) continue;
        members.add(m.user_id);
        if (m.user_id === actorId) actorRole = String(m.role ?? "none");
      }
      const { data: ws } = await supa.from("workspaces").select("owner_id").eq("id", t.workspace_id).maybeSingle();
      if (ws?.owner_id) { members.add(ws.owner_id); if (ws.owner_id === actorId) actorRole = "owner"; }
    } else {
      members.add(t.user_id);
      if (t.user_id === actorId) actorRole = "owner";
    }
    if (!members.has(actorId)) return json({ error: "not allowed" }, 403);
    // only someone who can change tasks can have assigned one (guests can still comment)
    if (kind === "assigned" && !WRITERS.has(actorRole)) return json({ error: "not allowed" }, 403);

    // recipients by event, from the database
    let recips: string[] = [];
    // push: the event this call is about (null → no push), and who may get one
    let eventKey: string | null = null;
    let pushTo: Set<string> | null = null;
    if (kind === "assigned") {
      // email: the app fires this alongside the save, so the row may not show
      // the new assignee yet — accept the named assignee too (still members-only below)
      const named = Array.isArray(body?.recipientIds) ? body.recipientIds.slice(0, 3).map(String) : [];
      recips = [t.assignee_id ?? "", ...named];
      // push: only the assignee the database has, and only if it shows this
      // person just made that assignment
      if (vapid && t.assignee_id) {
        const since = new Date(Date.now() - PUSH_EVENT_WINDOW_SEC * 1000).toISOString();
        const { data: evs } = await supa.from("task_events").select("id,actor_id,new_value,created_at")
          .eq("task_id", taskId).eq("field", "assignee").eq("actor_id", actorId).gte("created_at", since)
          .order("created_at", { ascending: false }).limit(5);
        eventKey = assignmentEventKey(t, (evs ?? []) as AssigneeEvent[], actorId);
        pushTo = new Set([String(t.assignee_id)]);
      }
    } else {
      // the actor's most recent comment on this task (the one that triggered this)
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: c } = await supa.from("comments").select("id,mentions,created_at")
        .eq("task_id", taskId).eq("user_id", actorId).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const mentioned = ((c?.mentions as string[] | null) ?? []).map(String);
      if (!c) return json({ ok: true, sent: 0, note: "no recent comment" });
      if (c.id) eventKey = `c:${c.id}`;
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
    const push = vapid && eventKey ? taskEventPush(kind as "assigned" | "mention" | "comment", actorName, t.title || "", taskId) : null;
    // once per recipient per event, and at most once a minute per task and kind
    const pushOnce = (id: string) => async () => {
      for (const k of pushOnceKeys(id, taskId, kind, eventKey!)) {
        if (!(await hit(supa, `${KEY_PREFIX}${k.key}`, { windowSec: k.windowSec })).allowed) return false;
      }
      return true;
    };
    let sent = 0, pushed = 0;
    for (const id of recips) {
      const { data: prof } = await supa.from("profiles").select("notify_prefs,suspended").eq("id", id).maybeSingle();
      if (prof?.suspended) continue;
      const prefs = (prof?.notify_prefs ?? {}) as Record<string, boolean>;
      // push: every device they switched on, unless "<kind>_push" is off
      if (push && vapid && (!pushTo || pushTo.has(id)) && prefs[`${kind}_push`] !== false) {
        try { pushed += (await pushToUser(supa, id, push, vapid, { allow: pushOnce(id) })).sent; }
        catch (e) { console.error("push", String((e as Error)?.message ?? e)); }
      }
      if (!resendKey) continue; // push-only set-up: no email
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
    return json({ ok: true, sent, pushed });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
type Supa = any;

/** The caller: a real, signed-in, active account (else the error response). */
async function signedInActor(supa: Supa, req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who } = token ? await supa.auth.getUser(token) : { data: { user: null } };
  const actorId: string | null = who?.user?.id ?? null;
  if (!actorId) return json({ error: "sign in required" }, 401);
  const { data: ap } = await supa.from("profiles").select("first_name,last_name,approved,suspended").eq("id", actorId).maybeSingle();
  if (ap && (ap.suspended || ap.approved === false)) return json({ error: "not allowed" }, 403);
  return { actorId, who, ap };
}

/** Settings › Notifications › "Send a test notification": to the caller's own
 *  device(s) only (this one when the app names its endpoint). */
async function testPush(supa: Supa, req: Request, body: Record<string, unknown>, vapid: VapidKeys | null): Promise<Response> {
  const actor = await signedInActor(supa, req);
  if (actor instanceof Response) return actor;
  if (!vapid) return json({ error: "push notifications aren't set up", reason: "unconfigured" }, 503);
  const limit = await hit(supa, `${KEY_PREFIX}push-test:${actor.actorId}`, { windowSec: 600, max: 5 });
  if (!limit.allowed) return json({ error: "too many test notifications", reason: "rate_limited", retryAfter: limit.retryAfter }, 429);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
  if (endpoint !== undefined && !isAllowedPushEndpoint(endpoint)) return json({ error: "bad endpoint", reason: "no_subscription" }, 409);
  const r = await pushToUser(supa, actor.actorId, TEST_PUSH, vapid, { endpoint, ttl: 300, urgency: "high" });
  if (r.total === 0 || r.total === r.pruned) return json({ error: "this device isn't subscribed", reason: "no_subscription" }, 409);
  if (r.sent === 0) return json({ error: "the push service didn't accept it", reason: "push_failed" }, 502);
  return json({ ok: true, sent: r.sent });
}

function oneLine(s: string) { return String(s).replace(/[\r\n]+/g, " ").slice(0, 140); }
function esc(s: string) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c)); }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } }); }
