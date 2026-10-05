// ============================================================
// KANBO — the daily Slack stand-up (Deno / Supabase Edge Function)
//                                                                [f6-slack]
// Run by pg_cron every 15 minutes. Posts the stand-up to each workspace whose
// owner/admin switched on Settings › Slack › "Post the stand-up every
// weekday", once its chosen time (Europe/London) has come, Monday to Friday,
// at most once per workspace per day.
//
// The stand-up is written here from the workspace's own tasks and change
// history (done since the last workday, in progress, due today, overdue,
// blocked): buildStandupText in _shared/slack.ts. It follows Pulse closely
// but doesn't need to match it word for word.
//
// Only the scheduler may run it: x-cron-secret: <CRON_SECRET>, or the
// service-role key as a bearer token. Anyone else gets 401.
//
// Once a day: rate_limits key kanbo:slack-standup:<workspace>:<day> (0042).
// Without that table every due run posts (fails open) — the 20-minute window
// still keeps it to one or two posts.
//
// Logs name the workspace, never its webhook: caught errors go through
// safeErrorNote() (Deno's fetch errors quote the URL).
//
// So Settings can tell an owner/admin when the daily post isn't happening
// (_shared/slackHealth.ts, in rate_limits): every scheduled run stamps a
// heartbeat (weekends too), a stand-up that doesn't go out records Slack's
// error word against the workspace and its link, and one that does clears it.
//
// Manual run (for checking): POST { "workspaceId": "<uuid>", "force": true }
// posts that workspace's stand-up now, whatever the time or day, without
// using up today's automatic post.
//
// Deploy:   supabase functions deploy slack-standup --no-verify-jwt
// Secrets:  CRON_SECRET (already set for reminders), APP_URL
//           optional: SLACK_STANDUP_TZ (default Europe/London)
// Schedule: docs/integrations/slack.md (pg_cron, every 15 minutes)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hit, KEY_PREFIX, release, sweep } from "../_shared/limits.ts";
import {
  addDaysIso, buildSlackMessage, buildStandupText, classifySlackResponse, isSlackWebhookUrl, isStandupDue,
  isWeekday, lastWorkdayIso, safeErrorNote, zonedNow, type StandupEventRow, type StandupMember, type StandupTaskRow,
} from "../_shared/slack.ts";
import { clearStandupFailure, markStandupHeartbeat, recordStandupFailure } from "../_shared/slackHealth.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const MAX_TASKS = 5000;
const SLACK_TIMEOUT_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const missingSchema = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(e.message ?? ""));

interface IntegrationRow { workspace_id: string; slack_webhook_url: string | null; slack_autopost_time: string | null }
// deno-lint-ignore no-explicit-any
type Db = any;

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const appUrl = (Deno.env.get("APP_URL") ?? "").trim().replace(/\/+$/, "");
  const tz = Deno.env.get("SLACK_STANDUP_TZ") ?? "Europe/London";

  // ---- scheduler-only ----
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = req.headers.get("x-cron-secret") ?? "";
  const authed = (!!serviceKey && safeEq(bearer, serviceKey)) || (!!cronSecret && safeEq(secret, cronSecret));
  if (!authed) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) ?? {}; } catch { /* pg_net sends {} or nothing */ }
  const force = body.force === true && typeof body.workspaceId === "string" && UUID.test(body.workspaceId);
  const only = force ? String(body.workspaceId) : null;

  const supa = createClient(url, serviceKey);
  // the scheduler is running (a forced manual run doesn't say so)
  if (!force) await markStandupHeartbeat(supa);
  const now = zonedNow(new Date(), tz);
  if (!force && !isWeekday(now.weekday)) return json({ due: 0, posted: 0, note: "weekend" });

  // ---- who's due ----
  let q = supa.from("workspace_integrations").select("workspace_id,slack_webhook_url,slack_autopost_time")
    .not("slack_webhook_url", "is", null);
  q = only ? q.eq("workspace_id", only) : q.eq("slack_autopost", true);
  const { data: rows, error } = await q;
  if (error) {
    if (missingSchema(error)) return json({ due: 0, posted: 0, note: "workspace_integrations is missing: run migration 0043" });
    return json({ error: error.message }, 500);
  }
  const due = ((rows ?? []) as IntegrationRow[]).filter((r) => force || isStandupDue(r.slack_autopost_time, now.minutes));
  if (!due.length) return json({ due: 0, posted: 0 });

  await sweep(supa);
  let posted = 0, already = 0, failed = 0, invalid = 0;
  for (const r of due) {
    const hook = String(r.slack_webhook_url ?? "").trim();
    if (!isSlackWebhookUrl(hook)) { invalid++; console.error("slack-standup: stored webhook fails the rule", r.workspace_id); continue; }
    // once per workspace per day, however many runs land in the window
    const dayKey = `${KEY_PREFIX}slack-standup:${r.workspace_id}:${now.day}`;
    if (!force && !(await hit(supa, dayKey, { windowSec: 36 * 3600 })).allowed) { already++; continue; }

    let ok = false;
    // why it didn't go, for Settings: Slack's word, "unreachable", or our own failure
    let why = "kanbo_error";
    try {
      const text = await standupFor(supa, r.workspace_id, now.day, tz);
      const { data: ws } = await supa.from("workspaces").select("name").eq("id", r.workspace_id).maybeSingle();
      const message = buildSlackMessage({
        kind: "standup", text, workspaceName: ws?.name ?? undefined, actorName: null, day: now.day,
        url: appUrl ? `${appUrl}/team/pulse` : null,
      });
      why = "unreachable";
      const res = await fetch(hook, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message),
        redirect: "manual", signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
      const out = classifySlackResponse(res.status, (await res.text().catch(() => "")).slice(0, 200), res.headers.get("retry-after"));
      ok = out.ok;
      if (!out.ok) {
        why = out.detail;
        console.warn("slack-standup: slack said", res.status, out.detail, r.workspace_id);
      }
    } catch (e) {
      // never e.message as it is: Deno's network errors include the webhook URL
      console.error("slack-standup", r.workspace_id, safeErrorNote(e, [hook]));
    }
    if (ok) {
      posted++;
      await clearStandupFailure(supa, r.workspace_id);
    } else {
      failed++;
      // tell the workspace's owners/admins (Settings › Slack), then free
      // today's slot so the next run in the window tries again
      await recordStandupFailure(supa, r.workspace_id, hook, why);
      if (!force) await release(supa, dayKey);
    }
    await sleep(300);
  }
  return json({ due: due.length, posted, alreadyPostedToday: already, failed, invalid, day: now.day, time: `${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")}` });
});

/** The workspace's stand-up text from its tasks, people and today's changes. */
async function standupFor(supa: Db, workspaceId: string, today: string, tz: string): Promise<string> {
  const since = lastWorkdayIso(today);

  // people: active members and the owner, with their display names
  const { data: ms } = await supa.from("workspace_members").select("user_id,name,email,role")
    .eq("workspace_id", workspaceId).eq("status", "active");
  const { data: w } = await supa.from("workspaces").select("owner_id").eq("id", workspaceId).maybeSingle();
  const people = new Map<string, { name: string; guest: boolean }>();
  for (const m of (ms ?? []) as { user_id: string | null; name: string | null; email: string | null; role: string | null }[]) {
    if (!m.user_id) continue;
    people.set(m.user_id, { name: (m.name ?? "").trim() || (m.email ?? "").split("@")[0] || "", guest: m.role === "guest" });
  }
  if (w?.owner_id && !people.has(w.owner_id)) people.set(w.owner_id, { name: "", guest: false });
  const ids = [...people.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data: profs } = await supa.from("profiles").select("id,first_name,last_name,suspended").in("id", ids.slice(i, i + 200));
    for (const p of (profs ?? []) as { id: string; first_name: string | null; last_name: string | null; suspended: boolean | null }[]) {
      const cur = people.get(p.id);
      if (!cur) continue;
      if (p.suspended) { people.delete(p.id); continue; }
      const full = `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
      if (full) cur.name = full;
    }
  }
  const members: StandupMember[] = [...people].map(([id, p]) => ({ id, name: p.name || "Someone", guest: p.guest || undefined }));

  // tasks: open ones, and ones finished recently (paged; capped)
  const tasks: StandupTaskRow[] = [];
  for (let from = 0; from < MAX_TASKS; from += PAGE) {
    const { data, error } = await supa.from("tasks")
      .select("id,title,status,assignee_id,due_date,completed_at,archived_at,project_id")
      .eq("workspace_id", workspaceId).is("archived_at", null)
      .or(`status.neq.done,completed_at.gte.${since},completed_at.is.null`)
      .order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    tasks.push(...((data ?? []) as StandupTaskRow[]));
    if (!data || data.length < PAGE) break;
  }

  // skip tasks in archived projects
  const projIds = [...new Set(tasks.map((t) => String(t.project_id ?? "")).filter((p) => UUID.test(p)))];
  const archived = new Set<string>();
  for (let i = 0; i < projIds.length; i += 200) {
    const { data } = await supa.from("projects").select("id").in("id", projIds.slice(i, i + 200)).not("archived_at", "is", null);
    for (const p of data ?? []) archived.add(p.id);
  }
  const live = tasks.filter((t) => !archived.has(String(t.project_id ?? "")));

  // status changes to done since the last workday, for tasks without a completed_at
  const doneIds = live.filter((t) => t.status === "done" && !t.completed_at).map((t) => t.id);
  const events: StandupEventRow[] = [];
  const sinceIso = `${addDaysIso(since, -1)}T00:00:00Z`;   // a day early: the zone filter in buildStandupText is exact
  for (let i = 0; i < doneIds.length; i += 150) {
    const { data } = await supa.from("task_events").select("task_id,field,new_value,created_at")
      .in("task_id", doneIds.slice(i, i + 150)).eq("field", "status").gte("created_at", sinceIso);
    events.push(...((data ?? []) as StandupEventRow[]));
  }

  return buildStandupText({ tasks: live, events, members, today, since, tz });
}

function safeEq(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
