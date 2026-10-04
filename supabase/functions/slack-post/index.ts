// ============================================================
// KANBO — post to a workspace's Slack channel (Deno / Supabase Edge Function)
//                                                                [f6-slack]
// The channel is an Incoming Webhook an owner/admin pasted in Settings
// (workspace_integrations, migration 0043). The URL is a secret: it's read
// here with the service role and never sent back to anyone.
//
//   POST { action: "test" | "post_standup" | "post_status" | "post_risks",
//          workspaceId, text?, projectId?, status?, title? }
//   200  { ok: true }
//   4xx/5xx { error: "<sentence>", reason, retryAfter?, detail? }
//        400 invalid · 401 not signed in · 403 not_allowed · 409 not_connected
//        429 rate_limited · 502 slack_rejected · 503 unavailable (0043 not run)
//
// Who may do what (decided by the database's own slack_status(), called as
// the caller, so it's the same rule as everywhere else):
//   test         owners and admins (can_manage)
//   post_*       owners, admins and members (can_post); never guests,
//                suspended or unapproved accounts, or outsiders
//
// Safety: the URL is re-checked against the webhook rule before every
// request and redirects are never followed (no SSRF through a stored URL);
// everything people wrote is escaped for Slack (no @channel, mentions or
// disguised links) and capped to Slack's limits (_shared/slack.ts). The URL
// never reaches the logs either: caught errors are logged through
// safeErrorNote(), which cuts it out (Deno's fetch errors quote it).
// Rate limits (rate_limits, 0042; fail open without it):
//   test: 3 a minute per workspace · posts: 10 per 10 minutes per person and
//   30 an hour per workspace.
//
// Deploy:  supabase functions deploy slack-post        (Verify JWT: ON, see config.toml)
// Secrets: APP_URL (already set for reminders): the links back to Kanbo
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hit, KEY_PREFIX, sweep } from "../_shared/limits.ts";
import {
  buildSlackMessage, classifySlackResponse, isSlackWebhookUrl, isStatusKind, safeErrorNote, SLACK_LIMITS,
  type SlackMessageKind, type SlackStatusKind,
} from "../_shared/slack.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 64_000;
const SLACK_TIMEOUT_MS = 10_000;
const ACTIONS: Record<string, SlackMessageKind> = { test: "test", post_standup: "standup", post_status: "status", post_risks: "risks" };

type Reason = "invalid" | "not_allowed" | "not_connected" | "rate_limited" | "slack_rejected" | "unavailable";
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const refuse = (status: number, reason: Reason, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, reason, ...extra }, status);
const missingSchema = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42P01" || e.code === "42883" || e.code === "PGRST202" || e.code === "PGRST205" || /does not exist|schema cache|could not find the function/i.test(e.message ?? ""));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const appUrl = (Deno.env.get("APP_URL") ?? "").trim().replace(/\/+$/, "");

  try {
    // ---- the request ----
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return refuse(400, "invalid", "That's too much to post at once.");
    const raw = await req.text();
    if (raw.length > MAX_BODY) return refuse(400, "invalid", "That's too much to post at once.");
    let b: Record<string, unknown>;
    try { b = (JSON.parse(raw || "{}") ?? {}) as Record<string, unknown>; } catch { return refuse(400, "invalid", "That request wasn't understood."); }
    const kind = ACTIONS[String(b.action ?? "")];
    const workspaceId = String(b.workspaceId ?? "");
    if (!kind) return refuse(400, "invalid", "That request wasn't understood.");
    if (!UUID.test(workspaceId)) return refuse(400, "invalid", "Slack is for team workspaces.");
    const text = typeof b.text === "string" ? b.text : "";
    if (kind !== "test" && !text.trim()) return refuse(400, "invalid", "There's nothing to post yet.");
    const title = typeof b.title === "string" ? b.title.slice(0, SLACK_LIMITS.title) : "";
    const projectId = typeof b.projectId === "string" ? b.projectId : "";
    if (kind === "status" && !UUID.test(projectId)) return refuse(400, "invalid", "Choose the project to post about.");
    const status: SlackStatusKind | null = isStatusKind(b.status) ? b.status : null;

    // ---- who's asking ----
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const admin = createClient(url, serviceKey);
    const { data: who } = token ? await admin.auth.getUser(token) : { data: { user: null } };
    const user = who?.user;
    if (!user) return refuse(401, "not_allowed", "Sign in to post to Slack.");
    const { data: prof } = await admin.from("profiles").select("first_name,last_name,approved,suspended").eq("id", user.id).maybeSingle();
    if (prof && (prof.suspended || prof.approved === false)) return refuse(403, "not_allowed", "Your account can't post to Slack.");

    // the database decides, as the caller: null = not in this workspace
    const asUser = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: st, error: stErr } = await asUser.rpc("slack_status", { p_ws: workspaceId });
    if (stErr) {
      if (missingSchema(stErr)) return refuse(503, "unavailable", "Slack isn't switched on for Kanbo yet.");
      console.error("slack_status", stErr.code, stErr.message);
      return refuse(503, "unavailable", "Couldn't check the Slack connection. Try again.");
    }
    const s = (st ?? null) as { connected?: boolean; can_manage?: boolean; can_post?: boolean; channel_label?: string | null } | null;
    if (!s) return refuse(403, "not_allowed", "You're not in this workspace.");
    if (kind === "test" ? !s.can_manage : !s.can_post) {
      return refuse(403, "not_allowed", kind === "test" ? "Only owners and admins can send a test message." : "You can't post to Slack from this workspace.");
    }
    if (!s.connected) return refuse(409, "not_connected", "Slack isn't connected to this workspace.");

    // ---- how often ----
    await sweep(admin);
    const limits = kind === "test"
      ? [hit(admin, `${KEY_PREFIX}slack-test:${workspaceId}`, { windowSec: 60, max: 3 })]
      : [hit(admin, `${KEY_PREFIX}slack-post:u:${user.id}`, { windowSec: 600, max: 10 }),
         hit(admin, `${KEY_PREFIX}slack-post:ws:${workspaceId}`, { windowSec: 3600, max: 30 })];
    for (const r of await Promise.all(limits)) {
      if (!r.allowed) return refuse(429, "rate_limited", "That's a lot of posts in a short time.", { retryAfter: r.retryAfter });
    }

    // ---- the secret, and what the message says ----
    const { data: integ, error: iErr } = await admin.from("workspace_integrations")
      .select("slack_webhook_url,slack_channel_label").eq("workspace_id", workspaceId).maybeSingle();
    if (iErr) {
      if (missingSchema(iErr)) return refuse(503, "unavailable", "Slack isn't switched on for Kanbo yet.");
      console.error("workspace_integrations", iErr.code, iErr.message);
      return refuse(503, "unavailable", "Couldn't read the Slack connection. Try again.");
    }
    const hook = String(integ?.slack_webhook_url ?? "").trim();
    if (!hook) return refuse(409, "not_connected", "Slack isn't connected to this workspace.");
    if (!isSlackWebhookUrl(hook)) {
      // never call anything but hooks.slack.com, whatever is stored
      console.error("slack-post: stored webhook fails the rule; refusing", workspaceId);
      return refuse(409, "not_connected", "The saved Slack link isn't valid. Reconnect Slack in Settings.");
    }

    const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspaceId).maybeSingle();
    let projectName: string | undefined;
    if (kind === "status") {
      const { data: p } = await admin.from("projects").select("id,name,workspace_id").eq("id", projectId).maybeSingle();
      if (!p || String(p.workspace_id ?? "") !== workspaceId) return refuse(400, "invalid", "That project isn't in this workspace.");
      projectName = p.name ?? undefined;
    }
    const actorName = `${prof?.first_name ?? ""} ${prof?.last_name ?? ""}`.trim() || (user.email ? user.email.split("@")[0] : "") || "Someone";
    const link = appUrl ? (kind === "status" ? `${appUrl}/p/${projectId}` : kind === "test" ? appUrl : `${appUrl}/team/pulse`) : null;
    const message = buildSlackMessage({
      kind, text, title, workspaceName: ws?.name ?? undefined, projectName, status, url: link, actorName,
      channelLabel: integ?.slack_channel_label ?? s.channel_label ?? null,
    });

    // ---- to Slack ----
    let res: Response;
    try {
      res = await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
        redirect: "manual",
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
    } catch (e) {
      // never e.message as it is: Deno's network errors include the webhook URL
      console.error("slack-post: couldn't reach Slack", safeErrorNote(e, [hook]), workspaceId);
      return refuse(502, "slack_rejected", "Slack isn't responding.", { detail: "unreachable" });
    }
    const reply = await res.text().catch(() => "");
    const out = classifySlackResponse(res.status, reply.slice(0, 200), res.headers.get("retry-after"));
    if (out.ok) return json({ ok: true });
    console.warn("slack-post: slack said", res.status, out.detail, workspaceId);
    if (out.reason === "rate_limited") return refuse(429, "rate_limited", "Slack asked Kanbo to slow down.", { retryAfter: out.retryAfter, detail: out.detail });
    return refuse(502, "slack_rejected", "Slack didn't accept the message.", { detail: out.detail, ...(out.gone ? { gone: true } : {}) });
  } catch (e) {
    console.error("slack-post", safeErrorNote(e));
    return refuse(503, "unavailable", "Something went wrong. Try again.");
  }
});
