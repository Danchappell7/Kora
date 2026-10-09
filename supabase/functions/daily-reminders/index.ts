// ============================================================
// KANBO — daily reminder emails + push, the daily digest, and the notify
// queue's drain (Deno / Supabase Edge Function). Three modes, picked by the
// request body's "mode" (or ?mode=):
//
//   "due" (default; once a day, e.g. 07:30): finds open tasks due today or
//     overdue and emails each assignee one list, and pushes one notification
//     to each device they switched push on for. People on the daily digest
//     get this list inside their digest instead. In quiet hours it's held in
//     notify_queue until they end (the drain sends it).
//   "digest" (every 15 minutes): for everyone who chose "Daily digest" in
//     Settings › Notifications, at their digest_time in their timezone (moved
//     to the end of quiet hours if it falls inside them): ONE email with what
//     came into their Inbox since the last digest and is still unread
//     (snoozed threads left out), plus what's due today or overdue. Once a
//     day (rate key per local date); nothing to say → no email.
//   "drain" (every minute): sends the push and email held for bundling and
//     quiet hours (_shared/notifyQueue.ts drainQueue), one message per task
//     per person.
//
// Prefs (profiles.notify_prefs, default ON): "due_email" for the email,
// "due_push" for the push; "delivery", "digest_time", "quiet_hours",
// "timezone" (0048). Email needs RESEND_API_KEY, push the VAPID secrets;
// either runs without the other (with neither: 400, as before).
//
// Only the scheduler may run it: the request must carry the service-role key
// (Authorization: Bearer <service-role-key>) or the CRON_SECRET secret
// (x-cron-secret header). Anyone else gets 401.
//
// Idempotent: each person gets at most one due list (and one push) per
// date, and one digest per local date, even if the job is triggered twice (a
// retry, a manual run). Uses rate_limits from migration 0042 (fails open
// without it) and notify_queue from 0048 (without it, "due" sends as before
// and "drain" / "digest" do nothing harmful).
//
// Deploy:  supabase functions deploy daily-reminders --no-verify-jwt
// Secrets: RESEND_API_KEY, REMINDER_FROM, APP_URL
//          optional: CRON_SECRET, REMINDER_TZ (default Europe/London)
//          push: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (docs/integrations/push.md)
// Schedule: pg_cron + pg_net, with the secret read from Vault — the exact SQL
//   for all three jobs is in docs/integrations/notifications.md.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hit, KEY_PREFIX, release, sweep } from "../_shared/limits.ts";
import { dueDigestPush, pushDueDigest, pushToUser, vapidFromEnv, type VapidKeys } from "../_shared/webpush.ts";
import { sendEmail } from "../_shared/email.ts";
import { addDays, digestDue, digestMoment, localParts, NOTIFY_KINDS, planDelivery, resolveNotifyPrefs, type NotifyKind } from "../_shared/notifyTiming.ts";
import { digestEmail, digestThreads, dueEmail, filterDigestItems, type DigestItem, type DueTask } from "../_shared/notifyCompose.ts";
import { deliverNotice, drainQueue, supabaseDrainDeps, supabaseQueueStore, type SendOutcome } from "../_shared/notifyQueue.ts";

interface TaskRow {
  id: string; title: string | null; due_date: string; status: string; assignee_id: string | null;
  workspace_id: string | null; project_id: string | null; archived_at: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;
/** a held due list carries at most this many tasks (notify_queue.payload ≤ 8 KB) */
const HELD_DUE_TASKS = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Env { resendKey: string | undefined; from: string; appUrl: string; tz: string; vapid: VapidKeys | null }

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const env: Env = {
    resendKey: Deno.env.get("RESEND_API_KEY"),
    from: Deno.env.get("REMINDER_FROM") ?? "Kanbo <onboarding@resend.dev>",
    appUrl: (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, ""),
    tz: Deno.env.get("REMINDER_TZ") ?? "Europe/London",
    // push is optional: null (skipped quietly) until the VAPID secrets are set
    vapid: vapidFromEnv((k) => Deno.env.get(k)),
  };

  // ---- scheduler-only ----
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = req.headers.get("x-cron-secret") ?? "";
  const authed = (!!serviceKey && safeEq(bearer, serviceKey)) || (!!cronSecret && safeEq(secret, cronSecret));
  if (!authed) return json({ error: "unauthorized" }, 401);
  if (!env.resendKey && !env.vapid) return json({ error: "no RESEND_API_KEY" }, 400);

  const body = await req.json().catch(() => ({}));
  const mode = String(body?.mode ?? new URL(req.url).searchParams.get("mode") ?? "due");
  const supa = createClient(url, serviceKey);
  try {
    if (mode === "drain") return json({ mode, ...(await drainQueue(supabaseDrainDeps(supa, { ...env, limit: 500 }))) });
    if (mode === "digest") return json({ mode, ...(await digests(supa, env)) });
    if (mode !== "due") return json({ error: "bad mode" }, 400);
    return await dueReminders(supa, env);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
type Supa = any;

/* ---------------------------- due (daily) ---------------------------- */

async function dueReminders(supa: Supa, env: Env): Promise<Response> {
  const { resendKey, from, appUrl, tz, vapid } = env;
  // "today" in the team's timezone, not UTC (YYYY-MM-DD)
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  // ---- open, unarchived tasks due today or earlier (paged — no silent 1000 cap) ----
  const tasks: TaskRow[] = [];
  for (let fromRow = 0; ; fromRow += PAGE) {
    const { data, error } = await supa.from("tasks")
      .select("id,title,due_date,status,assignee_id,workspace_id,project_id,archived_at")
      .lte("due_date", today).neq("status", "done").is("archived_at", null)
      .not("assignee_id", "is", null)
      .order("id").range(fromRow, fromRow + PAGE - 1);
    if (error) return json({ error: error.message }, 500);
    tasks.push(...((data ?? []) as TaskRow[]));
    if (!data || data.length < PAGE) break;
  }
  if (tasks.length === 0) return json({ sent: 0, note: "nothing due" });

  const archivedProjects = await archivedProjectIds(supa, tasks);

  // team tasks: only remind people who are still active members of that workspace
  const wsIds = [...new Set(tasks.map((t) => t.workspace_id).filter((w): w is string => !!w))];
  const activeIn = new Map<string, Set<string>>();
  for (let i = 0; i < wsIds.length; i += 200) {
    const { data } = await supa.from("workspace_members").select("workspace_id,user_id")
      .in("workspace_id", wsIds.slice(i, i + 200)).eq("status", "active");
    for (const m of data ?? []) {
      if (!m.user_id) continue;
      (activeIn.get(m.workspace_id) ?? activeIn.set(m.workspace_id, new Set()).get(m.workspace_id)!).add(m.user_id);
    }
    const { data: owners } = await supa.from("workspaces").select("id,owner_id").in("id", wsIds.slice(i, i + 200));
    for (const w of owners ?? []) (activeIn.get(w.id) ?? activeIn.set(w.id, new Set()).get(w.id)!).add(w.owner_id);
  }

  const byAssignee = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const a = t.assignee_id ?? "";
    if (!UUID.test(a)) continue;
    if (t.project_id && archivedProjects.has(t.project_id)) continue;
    if (t.workspace_id && !activeIn.get(t.workspace_id)?.has(a)) continue;
    (byAssignee.get(a) ?? byAssignee.set(a, []).get(a)!).push(t);
  }

  // push runs only once 0043's table answers (one probe, not a failed read per
  // person). Devices are then read per person, never in one shared batch: a
  // batch is capped at the API's row limit, so one person with many rows
  // could push everyone after them out of it.
  let pushOn = !!vapid;
  if (pushOn) {
    const { error } = await supa.from("push_subscriptions").select("id").limit(1);
    if (error) { console.warn("[push] subscriptions unavailable:", String(error.message)); pushOn = false; }
  }

  const store = supabaseQueueStore(supa);
  let sent = 0, skipped = 0, failed = 0, already = 0, pushed = 0, held = 0, inDigest = 0;
  await sweep(supa);
  for (const [userId, list] of byAssignee) {
    // respect Settings → Notifications ("Due-date reminders" email / push, delivery, quiet hours); skip locked accounts
    const { data: prof } = await supa.from("profiles").select("notify_prefs,suspended,approved").eq("id", userId).maybeSingle();
    if (prof?.suspended || prof?.approved === false) { skipped++; continue; }
    const prefs = resolveNotifyPrefs(prof?.notify_prefs ?? {});
    // on the daily digest, the due list is part of it
    if (prefs.delivery === "digest") { inDigest++; continue; }
    const sorted = [...list].sort((a, b) => a.due_date.localeCompare(b.due_date));
    const compact: DueTask[] = sorted.slice(0, HELD_DUE_TASKS).map((t) => ({ id: t.id, title: oneLine(t.title || "Untitled task").slice(0, 80), due_date: t.due_date }));
    const payload = { v: 1 as const, line: "", url: "/today", due: { today, tasks: compact, more: sorted.length - compact.length } };
    const base = { userId, kind: "due" as const, eventKey: `due:${today}`, bundleKey: `due:${today}`, taskId: null, actorId: null, actorName: "", title: "" };
    const now = new Date();

    // push: one per person per day, to every device they switched on (their
    // 20 newest). The day's slot is taken only once they have a device, and
    // freed again if nothing reached one, so a re-run today may try again.
    if (vapid && pushOn) {
      const pushKey = `${KEY_PREFIX}digest-push:${userId}:${today}`;
      const r = await deliverNotice({ ...base, channel: "push", payload }, {
        store, now, prefs,
        send: async ({ recorded }): Promise<SendOutcome> => {
          if (recorded) {
            const res = await pushToUser(supa, userId, dueDigestPush(list, today), vapid, { ttl: 12 * 3600 });
            return res.sent > 0 ? "sent" : res.failed > 0 ? "failed" : "nothing";
          }
          const outcome = await pushDueDigest(supa, userId, list, today, vapid, {
            claim: async () => (await hit(supa, pushKey, { windowSec: 36 * 3600 })).allowed,
            unclaim: () => release(supa, pushKey),
          });
          return outcome === "sent" ? "sent" : outcome === "not-delivered" ? "failed" : "nothing";
        },
      });
      if (r.result === "sent") pushed++;
      if (r.result === "held") held++;
    }

    if (!resendKey) { skipped++; continue; }
    const dayKey = `${KEY_PREFIX}digest:${userId}:${today}`;
    let wasAlready = false;
    const r = await deliverNotice({ ...base, channel: "email", payload }, {
      store, now, prefs,
      send: async ({ recorded }): Promise<SendOutcome> => {
        const { data: u } = await supa.auth.admin.getUserById(userId);
        const email = u?.user?.email;
        if (!email) return "nothing";
        // without the queue: one list per person per day, however many times the job runs
        if (!recorded && !(await hit(supa, dayKey, { windowSec: 36 * 3600 })).allowed) { wasAlready = true; return "nothing"; }
        const mail = dueEmail(sorted, today, appUrl);
        const res = await sendEmail({ resendKey, from }, { to: email, subject: mail.subject, html: mail.html });
        if (!res.ok && !recorded) await release(supa, dayKey);   // not sent — a re-run today may try again
        return res.ok ? "sent" : "failed";
      },
    });
    if (r.result === "sent") sent++;
    else if (r.result === "held") held++;
    else if (r.result === "failed") failed++;
    else if (r.result === "duplicate" || wasAlready) already++;
    else skipped++;
    if (r.result === "sent" || r.result === "failed") await sleep(550);   // Resend: ~2 requests a second
  }

  return json({ sent, skipped, failed, alreadySentToday: already, pushed, held, inDigest, people: byAssignee.size, tasks: tasks.length });
}

/** projects among these tasks' that are archived */
async function archivedProjectIds(supa: Supa, tasks: { project_id: string | null }[]): Promise<Set<string>> {
  const projIds = [...new Set(tasks.map((t) => t.project_id).filter((p): p is string => !!p && UUID.test(p)))];
  const out = new Set<string>();
  for (let i = 0; i < projIds.length; i += 200) {
    const { data } = await supa.from("projects").select("id").in("id", projIds.slice(i, i + 200)).not("archived_at", "is", null);
    for (const p of data ?? []) out.add(p.id);
  }
  return out;
}

/* ---------------------------- the daily digest ---------------------------- */

async function digests(supa: Supa, env: Env) {
  const report = { people: 0, due: 0, sent: 0, empty: 0, already: 0, failed: 0 };
  if (!env.resendKey) return { ...report, note: "no RESEND_API_KEY" };
  const now = new Date();
  for (let fromRow = 0; ; fromRow += PAGE) {
    const { data, error } = await supa.from("profiles").select("id,first_name,notify_prefs,suspended,approved")
      .eq("notify_prefs->>delivery", "digest").order("id").range(fromRow, fromRow + PAGE - 1);
    if (error) { console.warn("[digest] profiles:", String(error.message)); break; }
    for (const p of data ?? []) {
      report.people++;
      if (p.suspended || p.approved === false) continue;
      const prefs = resolveNotifyPrefs(p.notify_prefs ?? {});
      const when = digestDue(now, prefs);
      if (!when.due) continue;
      // the email channel's own switches still count (all off → no digest)
      if (planDelivery({ kind: "mention", channel: "email", now, prefs }).action === "skip"
        && planDelivery({ kind: "comment", channel: "email", now, prefs }).action === "skip"
        && planDelivery({ kind: "due", channel: "email", now, prefs }).action === "skip") continue;
      report.due++;
      const key = `${KEY_PREFIX}digest-mail:${p.id}:${when.date}`;
      if (!(await hit(supa, key, { windowSec: 36 * 3600 })).allowed) { report.already++; continue; }
      try {
        const out = await digestFor(supa, env, String(p.id), String(p.first_name ?? ""), prefs, when.date, now);
        if (out === "sent") report.sent++;
        else if (out === "empty") report.empty++;
        else { report.failed++; await release(supa, key); }
      } catch (e) {
        report.failed++;
        console.error("[digest]", String((e as Error)?.message ?? e));
        await release(supa, key);
      }
      await sleep(550);
    }
    if (!data || data.length < PAGE) break;
  }
  return report;
}

async function digestFor(supa: Supa, env: Env, userId: string, firstName: string, prefs: ReturnType<typeof resolveNotifyPrefs>, date: string, now: Date):
  Promise<"sent" | "empty" | "failed"> {
  const { data: u } = await supa.auth.admin.getUserById(userId);
  const email = u?.user?.email;
  if (!email) return "empty";
  // what they can see: their personal tasks and the workspaces they're active in
  const spaces = new Set<string>();
  const { data: ms } = await supa.from("workspace_members").select("workspace_id").eq("user_id", userId).eq("status", "active");
  for (const m of ms ?? []) if (m.workspace_id) spaces.add(String(m.workspace_id));
  const { data: owned } = await supa.from("workspaces").select("id").eq("owner_id", userId);
  for (const w of owned ?? []) spaces.add(String(w.id));
  const canSee = (t: { user_id?: string | null; workspace_id: string | null }) => (t.workspace_id ? spaces.has(String(t.workspace_id)) : String(t.user_id) === userId);

  // unread Inbox items since the last digest
  const since = digestMoment(addDays(date, -1), prefs).toISOString();
  const { data: acts } = await supa.from("activity").select("id,task_id,task_title,kind,detail,created_at,meta")
    .eq("user_id", userId).is("read_at", null).is("archived_at", null).gt("created_at", since)
    .order("created_at", { ascending: false }).limit(200);
  const items = (acts ?? []) as DigestItem[];
  const taskIds = [...new Set(items.map((a) => a.task_id).filter((x): x is string => !!x && UUID.test(x)))];
  const visible = new Set<string>();
  for (let i = 0; i < taskIds.length; i += 200) {
    const { data } = await supa.from("tasks").select("id,user_id,workspace_id,archived_at").in("id", taskIds.slice(i, i + 200));
    for (const t of data ?? []) if (!t.archived_at && canSee(t)) visible.add(String(t.id));
  }
  const { data: sn } = await supa.from("notification_snoozes").select("task_id").eq("user_id", userId).gt("until", now.toISOString());
  const snoozed = new Set<string>((sn ?? []).map((s: { task_id: string }) => String(s.task_id)));
  // a kind whose email they switched off stays out (a doc mention counts as a mention)
  const wants = (kind: string) => {
    const k = (kind === "doc_mention" ? "mention" : kind) as NotifyKind;
    return NOTIFY_KINDS.includes(k) ? prefs.channel(k, "email") : true;
  };
  const threads = digestThreads(filterDigestItems(items, visible, snoozed, wants));

  // what's due today (their timezone) or overdue
  const today = localParts(now, prefs.timezone).date;
  let due: DueTask[] = [];
  if (prefs.channel("due", "email")) {
    const { data: ts } = await supa.from("tasks").select("id,title,due_date,user_id,workspace_id,project_id")
      .eq("assignee_id", userId).lte("due_date", today).neq("status", "done").is("archived_at", null)
      .order("due_date").limit(100);
    const rows = (ts ?? []) as (DueTask & { user_id: string; workspace_id: string | null; project_id: string | null })[];
    const archived = await archivedProjectIds(supa, rows);
    due = rows.filter((t) => canSee(t) && !(t.project_id && archived.has(t.project_id))).map((t) => ({ id: t.id, title: t.title, due_date: t.due_date }));
  }

  const mail = digestEmail(threads, due, today, env.appUrl, { firstName, digestTime: prefs.digestTime });
  if (!mail) return "empty";
  const res = await sendEmail({ resendKey: env.resendKey, from: env.from }, { to: email, subject: mail.subject, html: mail.html, text: mail.text });
  return res.ok ? "sent" : "failed";
}

function safeEq(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function oneLine(s: string) { return String(s).replace(/[\r\n]+/g, " ").slice(0, 160); }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }); }
