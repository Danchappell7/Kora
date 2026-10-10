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
// Calmer notifications (0048, _shared/notifyQueue.ts): every notice goes
// through planDelivery for its recipient —
//   • a snoozed thread (notification_snoozes) sends nothing;
//   • daily digest: no email per event (daily-reminders sends one a day),
//     push only for mentions and approvals;
//   • quiet hours: held in notify_queue until they end (the Inbox still
//     updates at once — that's the database's triggers);
//   • bundling: the first notice for a task goes now and opens a 2-minute
//     window; the rest are held to its end and the drain sends them as ONE
//     push / email ("3 comments on Launch deck from Sana and Theo"), naming
//     every mention.
// Every notice is recorded under its event key, so a replayed call alerts
// nobody twice. Without 0048's queue it behaves exactly as before.
//
// { kind: "drain" } sends what's due from the queue. Only the scheduler or a
// service-role caller may run it (x-cron-secret: CRON_SECRET, or the service
// key as the bearer). The every-minute schedule calls daily-reminders'
// "drain" mode (no JWT needed there); this one is for a manual run. Each
// event call also drains a little (25 notices), so nothing waits long if
// the schedule is late.
//
// { kind: "replan" }: Settings calls this after the caller changes their
// quiet hours, time zone or delivery. Their own held push and email come
// forward to what the new settings say (never later), so switching quiet
// hours off releases what was waiting for them. Rate-limited; own rows only.
//
// A recipient whose profile can't be read for a fresh event gets it with
// the default settings (as before 0048) rather than being skipped.
//
// { kind: "test", endpoint? } sends Settings' test notification to the
// caller's own device(s): 200 { ok, sent } · 409 { reason: "no_subscription" }
// · 429 { reason: "rate_limited" } · 503 { reason: "unconfigured" }.
//
// { kind: "approval", approvalId } (0047): after the caller asks for approval
// or decides. Who hears what comes from the approval row alone
// (_shared/approvalNotify.ts): a fresh request by the caller → its undecided
// reviewers; the caller's fresh decision → the requester. The caller must be
// an active member of the task's workspace (guests too: they review);
// recipients must be too, and unsuspended. Prefs "approval_email" /
// "approval_push"; each recipient hears about each event once.
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
//    nobody again).
//
// Volume cap: 150 calls per person per 10 minutes (room for bulk
// reassignments), then 429 — in-app notifications still arrive via triggers.
// Uses rate_limits from migration 0042; fails open without it.
//
// Deploy:  supabase functions deploy notify        (Verify JWT: ON)
// Secrets: RESEND_API_KEY, REMINDER_FROM, APP_URL   (already set for reminders)
//          VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (push; see docs/integrations/push.md)
//          CRON_SECRET (the drain)
// See docs/integrations/notifications.md.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hit, KEY_PREFIX } from "../_shared/limits.ts";
import {
  assignmentEventKey, isAllowedPushEndpoint, PUSH_EVENT_WINDOW_SEC, pushOnceKeys, pushToUser, taskEventPush, TEST_PUSH,
  vapidFromEnv, type AssigneeEvent, type PushMessage, type VapidKeys,
} from "../_shared/webpush.ts";
import {
  APPROVAL_EVENT_WINDOW_SEC, approvalEmail, approvalNoticeText, approvalPush, planApprovalNotice, type ApprovalRow, type ReviewerRow,
} from "../_shared/approvalNotify.ts";
import { eventEmail, kudosEmail, kudosPush, noticeLine } from "../_shared/notifyCompose.ts";
import {
  DEFAULT_RECIPIENT, deliverNotice, drainQueue, readRecipient, readSnoozedUntil, rescheduleHeld, supabaseDrainDeps, supabaseQueueStore,
  type Notice, type SendOutcome,
} from "../_shared/notifyQueue.ts";

const EVENT_KINDS = new Set(["assigned", "mention", "comment"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECIPIENTS = 25;
/** what each event call drains on the side */
const SIDE_DRAIN = 25;

interface TaskRow {
  id: string; title: string | null; user_id: string; workspace_id: string | null; assignee_id: string | null;
  followers: string[] | null; collaborators: string[] | null; archived_at: string | null; created_at: string | null;
}
/** roles that may change tasks (0041 can_write); guests are read-only */
const WRITERS = new Set(["owner", "admin", "member"]);

interface Env { resendKey: string | undefined; from: string; appUrl: string; vapid: VapidKeys | null }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const env: Env = {
      resendKey: Deno.env.get("RESEND_API_KEY"),
      from: Deno.env.get("REMINDER_FROM") ?? "Kanbo <onboarding@resend.dev>",
      appUrl: (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, ""),
      // push is optional: null (skipped quietly) until the VAPID secrets are set
      vapid: vapidFromEnv((k) => Deno.env.get(k)),
    };

    const body = await req.json().catch(() => ({}));
    const kind = String(body?.kind ?? "");
    const supa = createClient(url, serviceKey);
    if (kind === "drain") return await drain(supa, req, serviceKey, env, body);
    if (kind === "test") return await testPush(supa, req, body, env.vapid);
    if (kind === "replan") return await replan(supa, req, env);
    if (kind === "approval") return await sideDrain(supa, env, await approvalNotice(supa, req, body, env));
    if (kind === "kudos") return await sideDrain(supa, env, await kudosNotice(supa, req, body, env));

    if (!env.resendKey && !env.vapid) return json({ error: "no RESEND_API_KEY" }, 400);
    const taskId = String(body?.taskId ?? "");
    if (!EVENT_KINDS.has(kind)) return json({ error: "bad kind" }, 400);
    if (!UUID.test(taskId)) return json({ error: "bad taskId" }, 400);
    const ev = kind as "assigned" | "mention" | "comment";

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
    if (ev === "assigned" && !WRITERS.has(actorRole)) return json({ error: "not allowed" }, 403);

    // recipients by event, from the database
    let recips: string[] = [];
    // the event this call is about: push needs proof (null → no push); email falls back to a 10-minute key
    let eventKey: string | null = null;
    let pushTo: Set<string> | null = null;
    if (ev === "assigned") {
      // email: the app fires this alongside the save, so the row may not show
      // the new assignee yet — accept the named assignee too (still members-only below)
      const named = Array.isArray(body?.recipientIds) ? body.recipientIds.slice(0, 3).map(String) : [];
      recips = [t.assignee_id ?? "", ...named];
      // push: only the assignee the database has, and only if it shows this
      // person just made that assignment
      if (t.assignee_id) {
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
      if (ev === "mention") {
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
    const path = `/?task=${encodeURIComponent(taskId)}`;
    const link = env.appUrl ? `${env.appUrl}${path}` : "";
    const push = env.vapid && eventKey ? taskEventPush(ev, actorName, t.title || "", taskId) : null;
    const mail = env.resendKey ? eventEmail(ev, actorName, t.title || "", link) : null;
    const line = noticeLine(ev, actorName);
    // without the queue (0048 not run): the old guard — once per recipient per event, at most once a minute per task and kind
    const pushOnce = (id: string) => async () => {
      for (const k of pushOnceKeys(id, taskId, ev, eventKey!)) {
        if (!(await hit(supa, `${KEY_PREFIX}${k.key}`, { windowSec: k.windowSec })).allowed) return false;
      }
      return true;
    };
    const store = supabaseQueueStore(supa);
    const base = { kind: ev, bundleKey: `task:${taskId}`, taskId, actorId, actorName, title } as const;
    const tally: Record<string, number> = {};
    let sent = 0, pushed = 0;
    for (const id of recips) {
      // can't read the profile right now: the defaults, as before (a fresh event is never lost to it)
      const person = await readRecipient(supa, id).catch(() => DEFAULT_RECIPIENT);
      if (!person) continue;   // suspended, not approved, or gone
      const snoozedUntil = await readSnoozedUntil(supa, id, taskId).catch(() => null);
      const now = new Date();
      // push: every device they switched on — when the event is proven and this person may get it
      if (push && env.vapid && (!pushTo || pushTo.has(id))) {
        const vapid = env.vapid;
        const n: Notice = { ...base, userId: id, channel: "push", eventKey: `${ev}:${eventKey}`, payload: { v: 1, line, url: path, push } };
        const r = await deliverNotice(n, {
          store, now, prefs: person.prefs, snoozedUntil,
          send: async ({ recorded }) => {
            const res = await pushToUser(supa, id, push, vapid, recorded ? {} : { allow: pushOnce(id) });
            return res.sent > 0 ? "sent" : res.failed > 0 ? "failed" : "nothing";
          },
        });
        tally[`push:${r.result}`] = (tally[`push:${r.result}`] ?? 0) + 1;
        if (r.result === "sent") pushed++;
      }
      if (!mail) continue; // push-only set-up: no email
      const emailKey = eventKey ?? `a:${taskId}:${id}:${Math.floor(Date.now() / 600_000)}`;
      const n: Notice = { ...base, userId: id, channel: "email", eventKey: `${ev}:${emailKey}`, payload: { v: 1, line, url: path, email: mail } };
      const r = await deliverNotice(n, {
        store, now, prefs: person.prefs, snoozedUntil,
        send: () => sendMail(supa, env, id, mail.subject, mail.html),
      });
      tally[`email:${r.result}`] = (tally[`email:${r.result}`] ?? 0) + 1;
      if (r.result === "sent") sent++;
    }
    return await sideDrain(supa, env, json({ ok: true, sent, pushed, outcomes: tally }));
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
type Supa = any;

/** Resend, for one person (their address from auth, never from the request). */
async function sendMail(supa: Supa, env: Env, userId: string, subject: string, html: string): Promise<SendOutcome> {
  if (!env.resendKey) return "nothing";
  const { data: u } = await supa.auth.admin.getUserById(userId);
  const email = u?.user?.email;
  if (!email) return "nothing";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.from, to: email, subject, html }),
  });
  if (res.ok) return "sent";
  console.error("resend", res.status, await res.text().catch(() => ""));
  return "failed";
}

/** After an event: send a few held notices that are due (the schedule does the rest). */
async function sideDrain(supa: Supa, env: Env, res: Response): Promise<Response> {
  const work = drainQueue(supabaseDrainDeps(supa, { ...env, limit: SIDE_DRAIN }))
    .catch((e) => console.warn("[notify] side drain:", String((e as Error)?.message ?? e)));
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work); else await work;
  return res;
}

/** { kind: "drain" }: the scheduler (x-cron-secret) or a service-role caller only. */
async function drain(supa: Supa, req: Request, serviceKey: string, env: Env, body: Record<string, unknown>): Promise<Response> {
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = req.headers.get("x-cron-secret") ?? "";
  if (!((!!serviceKey && safeEq(bearer, serviceKey)) || (!!cronSecret && safeEq(secret, cronSecret)))) return json({ error: "unauthorized" }, 401);
  const limit = Math.min(1000, Math.max(1, Number(body?.limit) || 200));
  const report = await drainQueue(supabaseDrainDeps(supa, { ...env, limit }));
  return json({ ok: true, ...report });
}

/** { kind: "replan" }: the caller changed quiet hours, time zone or delivery — their own held
 *  notices come forward to what the new settings say (never later), and what's now due goes. */
async function replan(supa: Supa, req: Request, env: Env): Promise<Response> {
  const actor = await signedInActor(supa, req);
  if (actor instanceof Response) return actor;
  const limit = await hit(supa, `${KEY_PREFIX}notify-replan:${actor.actorId}`, { windowSec: 600, max: 30 });
  if (!limit.allowed) return json({ error: "too many changes — try again shortly", retryAfter: limit.retryAfter }, 429);
  let moved = 0;
  try {
    const person = await readRecipient(supa, actor.actorId);
    if (!person) return json({ ok: true, moved: 0 });
    moved = await rescheduleHeld(supa, actor.actorId, person.prefs, new Date());
  } catch (e) {
    console.warn("[notify] replan:", String((e as Error)?.message ?? e));
    return json({ error: "couldn't check held notifications — they'll still arrive", reason: "unavailable" }, 503);
  }
  const res = json({ ok: true, moved });
  return moved > 0 && (env.resendKey || env.vapid) ? await sideDrain(supa, env, res) : res;
}

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
 *  device(s) only (this one when the app names its endpoint). Never held: it's a test. */
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

/** The task's workspace's active people (and its owner): who can see a team task. */
async function teamMembers(supa: Supa, workspaceId: string): Promise<Set<string>> {
  const members = new Set<string>();
  const { data: ms } = await supa.from("workspace_members").select("user_id,role")
    .eq("workspace_id", workspaceId).eq("status", "active");
  for (const m of ms ?? []) if (m.user_id) members.add(String(m.user_id));
  const { data: ws } = await supa.from("workspaces").select("owner_id").eq("id", workspaceId).maybeSingle();
  if (ws?.owner_id) members.add(String(ws.owner_id));
  return members;
}

/** kind "approval": email + push for a request or a decision the caller just made (0047). */
async function approvalNotice(supa: Supa, req: Request, body: Record<string, unknown>, env: Env): Promise<Response> {
  if (!env.resendKey && !env.vapid) return json({ error: "no RESEND_API_KEY" }, 400);
  const approvalId = String(body?.approvalId ?? "");
  if (!UUID.test(approvalId)) return json({ error: "bad approvalId" }, 400);
  const actor = await signedInActor(supa, req);
  if (actor instanceof Response) return actor;
  const { actorId, who, ap } = actor;
  const volume = await hit(supa, `${KEY_PREFIX}notify:${actorId}`, { windowSec: 600, max: 150 });
  if (!volume.allowed) return json({ error: "too many notifications — slow down", retryAfter: volume.retryAfter }, 429);
  const actorName = `${ap?.first_name ?? ""} ${ap?.last_name ?? ""}`.trim() || who?.user?.email || "Someone";

  // the approval, its reviews and its task — everything comes from here, never from the request
  const { data: a } = await supa.from("approvals")
    .select("id,task_id,workspace_id,requested_by,status,rule,title,note,created_at,resolved_at")
    .eq("id", approvalId).maybeSingle<ApprovalRow>();
  if (!a) return json({ error: "approval not found" }, 404);
  const { data: t } = await supa.from("tasks").select("id,title,archived_at,workspace_id").eq("id", a.task_id)
    .maybeSingle<{ id: string; title: string | null; archived_at: string | null; workspace_id: string | null }>();
  if (!t) return json({ error: "approval not found" }, 404);
  if (t.archived_at) return json({ ok: true, sent: 0, note: "archived" });
  // a task that has left the request's workspace took no request with it (0047 cancels it): nobody
  // there is told about it, and nobody in its new home is told about the old workspace's request
  if (t.workspace_id !== a.workspace_id) return json({ ok: true, sent: 0, note: "moved" });
  // approvals are team-only: the caller can see the task if they're an active member (guests too)
  const members = await teamMembers(supa, a.workspace_id);
  if (!members.has(actorId)) return json({ error: "not allowed" }, 403);
  const { data: revs } = await supa.from("approval_reviewers").select("user_id,decision,comment,decided_at").eq("approval_id", a.id);
  const plan = planApprovalNotice(a, (revs ?? []) as ReviewerRow[], actorId);
  if ("skip" in plan) return json({ ok: true, sent: 0, note: plan.skip });

  const recips = [...new Set(plan.recipients.map(String))]
    .filter((id) => UUID.test(id) && id !== actorId && members.has(id))
    .slice(0, MAX_RECIPIENTS);
  const taskTitle = t.title || a.title || "";
  const path = `/?task=${encodeURIComponent(t.id)}`;
  const link = env.appUrl ? `${env.appUrl}${path}` : "";
  const mail = approvalEmail(plan, actorName, taskTitle, link);
  const push: PushMessage | null = env.vapid ? approvalPush(plan, actorName, taskTitle, t.id, a.id) : null;
  const text = approvalNoticeText(plan, actorName, taskTitle);
  const line = `${oneLine(actorName).slice(0, 60) || "Someone"} ${text.lead.replace(/ (on|for)$/, "")}`.trim();
  const store = supabaseQueueStore(supa);
  const base = { kind: "approval", bundleKey: `task:${t.id}`, taskId: t.id, actorId, actorName, title: oneLine(taskTitle) } as const;
  let sent = 0, pushed = 0;
  for (const id of recips) {
    const person = await readRecipient(supa, id).catch(() => DEFAULT_RECIPIENT);
    if (!person) continue;
    // once per recipient per event, email and push alike (a replayed call tells nobody again)
    const once = await hit(supa, `${KEY_PREFIX}notify:approval:${id}:${plan.eventKey}`, { windowSec: APPROVAL_EVENT_WINDOW_SEC + 60 });
    if (!once.allowed) continue;
    const snoozedUntil = await readSnoozedUntil(supa, id, t.id).catch(() => null);
    const now = new Date();
    if (push && env.vapid) {
      const vapid = env.vapid;
      const r = await deliverNotice({ ...base, userId: id, channel: "push", eventKey: `approval:${plan.eventKey}`, payload: { v: 1, line, url: path, push } }, {
        store, now, prefs: person.prefs, snoozedUntil,
        send: async () => {
          const res = await pushToUser(supa, id, push, vapid);
          return res.sent > 0 ? "sent" : res.failed > 0 ? "failed" : "nothing";
        },
      });
      if (r.result === "sent") pushed++;
    }
    if (!env.resendKey) continue;
    const r = await deliverNotice({ ...base, userId: id, channel: "email", eventKey: `approval:${plan.eventKey}`, payload: { v: 1, line, url: path, email: mail } }, {
      store, now, prefs: person.prefs, snoozedUntil,
      send: () => sendMail(supa, env, id, mail.subject, mail.html),
    });
    if (r.result === "sent") sent++;
  }
  return json({ ok: true, sent, pushed });
}

/** How fresh a kudos must be to be news (give_kudos answers, then the app asks straight away). */
const KUDOS_FRESH_MS = 10 * 60 * 1000;

/** kind "kudos" (0048): email + push to the person thanked, for kudos the caller just gave. Everything comes from
 *  the kudos row (give_kudos made it, with its rules); only its giver may ask, once per kudos; the recipient's
 *  kudos prefs, quiet hours, digest, snoozes and bundling apply as for any notice. */
async function kudosNotice(supa: Supa, req: Request, body: Record<string, unknown>, env: Env): Promise<Response> {
  if (!env.resendKey && !env.vapid) return json({ error: "no RESEND_API_KEY" }, 400);
  const kudosId = String(body?.kudosId ?? "");
  if (!UUID.test(kudosId)) return json({ error: "bad kudosId" }, 400);
  const actor = await signedInActor(supa, req);
  if (actor instanceof Response) return actor;
  const { actorId, who, ap } = actor;
  const volume = await hit(supa, `${KEY_PREFIX}notify:${actorId}`, { windowSec: 600, max: 150 });
  if (!volume.allowed) return json({ error: "too many notifications — slow down", retryAfter: volume.retryAfter }, 429);
  const { data: k } = await supa.from("kudos").select("id,task_id,workspace_id,from_user,to_user,emoji,note,created_at")
    .eq("id", kudosId).maybeSingle<{ id: string; task_id: string; workspace_id: string; from_user: string; to_user: string; emoji: string; note: string | null; created_at: string }>();
  // someone else's kudos (or none): nothing to say, and nothing given away about which exist
  if (!k || k.from_user !== actorId) return json({ error: "kudos not found" }, 404);
  if (Date.now() - Date.parse(k.created_at) > KUDOS_FRESH_MS) return json({ ok: true, sent: 0, note: "not new" });
  const { data: t } = await supa.from("tasks").select("id,title,archived_at,workspace_id").eq("id", k.task_id)
    .maybeSingle<{ id: string; title: string | null; archived_at: string | null; workspace_id: string | null }>();
  if (!t || t.archived_at) return json({ ok: true, sent: 0, note: "no task" });
  const members = await teamMembers(supa, k.workspace_id);
  if (!members.has(actorId) || !members.has(k.to_user) || k.to_user === actorId) return json({ ok: true, sent: 0, note: "not a member" });
  const id = k.to_user;
  const person = await readRecipient(supa, id).catch(() => DEFAULT_RECIPIENT);
  if (!person) return json({ ok: true, sent: 0, note: "recipient unavailable" });
  // once per kudos, email and push alike (a replayed call tells nobody again; an Update changes the row, not this)
  const once = await hit(supa, `${KEY_PREFIX}notify:kudos:${k.id}`, { windowSec: Math.ceil(KUDOS_FRESH_MS / 1000) + 60 });
  if (!once.allowed) return json({ ok: true, sent: 0, note: "already told" });
  const actorName = `${ap?.first_name ?? ""} ${ap?.last_name ?? ""}`.trim() || who?.user?.email || "Someone";
  const taskTitle = t.title || "";
  const path = `/?task=${encodeURIComponent(t.id)}`;
  const link = env.appUrl ? `${env.appUrl}${path}` : "";
  const line = noticeLine("kudos", actorName);
  const store = supabaseQueueStore(supa);
  const base = { kind: "kudos", bundleKey: `task:${t.id}`, taskId: t.id, actorId, actorName, title: oneLine(taskTitle || "a task") } as const;
  const snoozedUntil = await readSnoozedUntil(supa, id, t.id).catch(() => null);
  const now = new Date();
  let sent = 0, pushed = 0;
  if (env.vapid) {
    const vapid = env.vapid;
    const push = kudosPush(actorName, k.emoji, k.note, taskTitle, t.id);
    const r = await deliverNotice({ ...base, userId: id, channel: "push", eventKey: `kudos:${k.id}`, payload: { v: 1, line, url: path, push } }, {
      store, now, prefs: person.prefs, snoozedUntil,
      send: async () => {
        const res = await pushToUser(supa, id, push, vapid);
        return res.sent > 0 ? "sent" : res.failed > 0 ? "failed" : "nothing";
      },
    });
    if (r.result === "sent") pushed++;
  }
  if (env.resendKey) {
    const mail = kudosEmail(actorName, k.emoji, k.note, taskTitle, link);
    const r = await deliverNotice({ ...base, userId: id, channel: "email", eventKey: `kudos:${k.id}`, payload: { v: 1, line, url: path, email: mail } }, {
      store, now, prefs: person.prefs, snoozedUntil,
      send: () => sendMail(supa, env, id, mail.subject, mail.html),
    });
    if (r.result === "sent") sent++;
  }
  return json({ ok: true, sent, pushed });
}

function safeEq(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function oneLine(s: string) { return String(s).replace(/[\r\n]+/g, " ").slice(0, 140); }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } }); }
