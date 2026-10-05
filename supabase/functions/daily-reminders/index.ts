// ============================================================
// KANBO — daily reminder emails + push (Deno / Supabase Edge Function)
// Finds open tasks due today or overdue and emails each assignee one digest,
// and pushes one notification to each device they switched push on for.
// Meant to be run once a day by a cron.
//
// Prefs (profiles.notify_prefs, default ON): "due_email" for the email,
// "due_push" for the push. Email needs RESEND_API_KEY, push the VAPID
// secrets; either runs without the other (with neither: 400, as before).
//
// Only the scheduler may run it: the request must carry the service-role key
// (Authorization: Bearer <service-role-key>) or the CRON_SECRET secret
// (x-cron-secret header). Anyone else gets 401.
//
// Idempotent per day: each person gets at most one digest (and one push) per
// date, even if the job is triggered twice (a retry, a manual run). Uses
// rate_limits from migration 0042; without it every run sends (fails open).
//
// Deploy:  supabase functions deploy daily-reminders --no-verify-jwt
// Secrets: RESEND_API_KEY, REMINDER_FROM, APP_URL
//          optional: CRON_SECRET, REMINDER_TZ (default Europe/London)
//          push: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (docs/integrations/push.md)
// Schedule: pg_cron + pg_net, with the secret read from Vault — the exact SQL
//   is in DEPLOYMENT.md ("Schedule the daily reminder email").
//   POST https://<project>.supabase.co/functions/v1/daily-reminders
//   header x-cron-secret: <CRON_SECRET>      (daily, e.g. 07:30)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hit, KEY_PREFIX, release, sweep } from "../_shared/limits.ts";
import { pushDueDigest, vapidFromEnv } from "../_shared/webpush.ts";

interface TaskRow {
  id: string; title: string | null; due_date: string; status: string; assignee_id: string | null;
  workspace_id: string | null; project_id: string | null; archived_at: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("REMINDER_FROM") ?? "Kanbo <onboarding@resend.dev>";
  const appUrl = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
  const tz = Deno.env.get("REMINDER_TZ") ?? "Europe/London";

  // ---- scheduler-only ----
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = req.headers.get("x-cron-secret") ?? "";
  const authed = (!!serviceKey && safeEq(bearer, serviceKey)) || (!!cronSecret && safeEq(secret, cronSecret));
  if (!authed) return json({ error: "unauthorized" }, 401);
  // push is optional: null (skipped quietly) until the VAPID secrets are set
  const vapid = vapidFromEnv((k) => Deno.env.get(k));
  if (!resendKey && !vapid) return json({ error: "no RESEND_API_KEY" }, 400);

  const supa = createClient(url, serviceKey);
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

  // skip tasks in archived projects
  const projIds = [...new Set(tasks.map((t) => t.project_id).filter((p): p is string => !!p && UUID.test(p)))];
  const archivedProjects = new Set<string>();
  for (let i = 0; i < projIds.length; i += 200) {
    const { data } = await supa.from("projects").select("id").in("id", projIds.slice(i, i + 200)).not("archived_at", "is", null);
    for (const p of data ?? []) archivedProjects.add(p.id);
  }

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
    if (error) { console.warn("[push] subscriptions unavailable:", error.message); pushOn = false; }
  }

  let sent = 0, skipped = 0, failed = 0, already = 0, pushed = 0;
  await sweep(supa);
  for (const [userId, list] of byAssignee) {
    // respect Settings → Notifications → "Due-date reminders" email / push toggles; skip locked accounts
    const { data: prof } = await supa.from("profiles").select("notify_prefs,suspended,approved").eq("id", userId).maybeSingle();
    const prefs = (prof?.notify_prefs ?? {}) as Record<string, boolean>;
    if (prof?.suspended || prof?.approved === false) { skipped++; continue; }

    // push: one per person per day, to every device they switched on (their
    // 20 newest). The day's slot is taken only once they have a device, and
    // freed again if nothing reached one, so a re-run today may try again.
    if (vapid && pushOn && prefs["due_push"] !== false) {
      const pushKey = `${KEY_PREFIX}digest-push:${userId}:${today}`;
      const outcome = await pushDueDigest(supa, userId, list, today, vapid, {
        claim: async () => (await hit(supa, pushKey, { windowSec: 36 * 3600 })).allowed,
        unclaim: () => release(supa, pushKey),
      });
      if (outcome === "sent") pushed++;
    }

    if (!resendKey || prefs["due_email"] === false) { skipped++; continue; }
    const { data: u } = await supa.auth.admin.getUserById(userId);
    const email = u?.user?.email;
    if (!email) { skipped++; continue; }
    // one digest per person per day, however many times the job runs
    const dayKey = `${KEY_PREFIX}digest:${userId}:${today}`;
    if (!(await hit(supa, dayKey, { windowSec: 36 * 3600 })).allowed) { already++; continue; }

    const sorted = list.sort((a, b) => a.due_date.localeCompare(b.due_date));
    const rows = sorted.slice(0, 50).map((t) => {
      const overdue = t.due_date < today;
      const title = esc(oneLine(t.title || "Untitled task"));
      const cell = appUrl ? `<a href="${esc(`${appUrl}/?task=${encodeURIComponent(t.id)}`)}" style="color:#1a1a1a;text-decoration:none">${title}</a>` : title;
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${cell}</td>` +
        `<td style="padding:8px 0;border-bottom:1px solid #eee;color:${overdue ? "#c0392b" : "#555"};text-align:right;white-space:nowrap">${overdue ? "Overdue" : "Today"}</td></tr>`;
    }).join("");
    const more = sorted.length > 50 ? `<p style="color:#555;font-size:13px">…and ${sorted.length - 50} more.</p>` : "";

    const html =
      `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">` +
      `<h2 style="font-weight:600">Your day on Kanbo</h2>` +
      `<p style="color:#555">You have <strong>${sorted.length}</strong> task${sorted.length === 1 ? "" : "s"} due today or overdue.</p>` +
      `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>${more}` +
      (appUrl ? `<p style="margin-top:20px"><a href="${esc(appUrl)}" style="background:#6a5cff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open Kanbo</a></p>` : "") +
      `<p style="font-size:12px;color:#888;margin-top:18px">Turn these off in Kanbo → Settings → Notifications.</p>` +
      `</div>`;

    // Resend allows ~2 requests/second on the default plan — pace + one retry on 429
    for (let attempt = 0; attempt < 2; attempt++) {
      let r: Response;
      try {
        r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: email, subject: `${sorted.length} task${sorted.length === 1 ? "" : "s"} due on Kanbo`, html }),
        });
      } catch (e) {
        // network error / timeout: count it, free today's slot and carry on
        // with everyone else rather than failing the whole run
        failed++; console.error("resend fetch", String((e as Error)?.message ?? e));
        await release(supa, dayKey);
        break;
      }
      if (r.ok) { sent++; break; }
      if (r.status === 429 && attempt === 0) { await sleep(1500); continue; }
      failed++; console.error("resend", r.status, await r.text().catch(() => ""));
      await release(supa, dayKey); // not sent — a re-run today may try again
      break;
    }
    await sleep(550);
  }

  return json({ sent, skipped, failed, alreadySentToday: already, pushed, people: byAssignee.size, tasks: tasks.length });
});

function safeEq(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function oneLine(s: string) { return String(s).replace(/[\r\n]+/g, " ").slice(0, 160); }
function esc(s: string) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c)); }
function json(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }); }
