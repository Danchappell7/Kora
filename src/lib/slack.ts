/* ============================================================
   KANBO — Slack (per-workspace Incoming Webhook).                [f6-slack]
   The webhook URL is a secret kept server-side (workspace_integrations,
   0043): owners/admins set it through slack_connect(), nobody reads it
   back. Everyone in the workspace sees slack_status(). Posting goes
   through the "slack-post" edge function (verify_jwt ON).

   Edge-function contract (POST /functions/v1/slack-post, user JWT):
     body  { action: "test" | "post_standup" | "post_status" | "post_risks",
             workspaceId: uuid, text?: string, projectId?: string,
             status?: StatusKind, title?: string }
     200   { ok: true }
     4xx/5xx { error: string, reason: SlackFailure, retryAfter?: number, detail?: string }
     body  { action: "status", workspaceId }   (owners/admins; read-only)
     200   { ok: true, autopostReady: boolean | null,
             lastAutopostError: { detail, at, day } | null }
   Demo mode (no Supabase): an in-memory fake that always succeeds.

   Degrades gracefully: before 0043 runs (slack_status missing) every read
   answers "unavailable" for the rest of the session; before slack-post is
   deployed a post answers "unavailable"; offline answers "network". Nothing
   here throws except the three owner/admin actions, whose Error messages
   are sentences ready to show.
   ============================================================ */
import type { SlackFailure, SlackPostKind, SlackPostResult, SlackStatus, StatusKind } from "../data/types";
import { supabase } from "./supabase";
import { fmtDay, SLACK_LIMITS, SLACK_URL_MAX, SLACK_WEBHOOK_RE, isSlackWebhookUrl as isWebhook } from "../../supabase/functions/_shared/slack.ts";
import { FAILURE_DETAIL_RE } from "../../supabase/functions/_shared/slackHealth.ts";

/** The only webhook shape accepted (same rule as the database check; one copy, shared with the edge functions). */
export { SLACK_WEBHOOK_RE };

/** True for a Slack Incoming Webhook URL (https://hooks.slack.com/services/…, ≤ 500 chars). */
export function isSlackWebhookUrl(url: string): boolean {
  return isWebhook(url);
}

/* ------------------------------------------------------------ copy */

export const SLACK_COPY = {
  invalidUrl: "That isn't a Slack webhook link. It starts with https://hooks.slack.com/services/",
  tooLong: `That link is too long for a Slack webhook (${SLACK_URL_MAX} characters at most).`,
  notAllowed: "Only workspace owners and admins can change the Slack connection.",
  invalidTime: "Choose a time like 09:00.",
  notConnected: "Connect Slack first, then switch on the daily stand-up.",
  unavailable: "Slack isn't switched on for Kanbo yet.",
  offline: "You're offline. Try again when you're back online.",
  saveFailed: "Couldn't save the Slack settings. Try again.",
  nothingToPost: "There's nothing to post yet.",
} as const;

/* ------------------------------------------------------------ status */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** slack_status() JSON (snake_case; camelCase is read too) → SlackStatus; null for null / anything malformed. */
export function parseSlackStatus(raw: unknown): SlackStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const pick = (snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);
  const connected = pick("connected", "connected");
  if (typeof connected !== "boolean") return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const time = str(pick("autopost_time", "autopostTime"));
  return {
    connected,
    channelLabel: str(pick("channel_label", "channelLabel")),
    autopost: connected && pick("autopost", "autopost") === true,
    autopostTime: time && TIME_RE.test(time) ? time : null,
    canManage: pick("can_manage", "canManage") === true,
    canPost: pick("can_post", "canPost") === true,
    updatedAt: str(pick("updated_at", "updatedAt")),
  };
}

/** Why the status couldn't be read: 0043 isn't run (or slack_status is missing), offline, or another error. */
export type SlackProblem = "unavailable" | "offline" | "error";
export interface SlackStatusLoad { status: SlackStatus | null; problem?: SlackProblem }

const STATUS_TTL_MS = 60_000;
const cache = new Map<string, { status: SlackStatus | null; at: number }>();
const inflight = new Map<string, Promise<SlackStatusLoad>>();
const listeners = new Set<(workspaceId: string, status: SlackStatus | null) => void>();
/** slack_status() doesn't exist (0043 not run): don't ask again this session. */
let schemaMissing = false;

/* demo mode: one in-memory connection per workspace, owner's view */
const demo = new Map<string, SlackStatus>();
let DEMO_DELAY_MS = 450;
const demoStatus = (ws: string): SlackStatus => demo.get(ws) ?? {
  connected: false, channelLabel: null, autopost: false, autopostTime: null, canManage: true, canPost: true, updatedAt: null,
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const same = (a: SlackStatus | null | undefined, b: SlackStatus | null) => JSON.stringify(a ?? null) === JSON.stringify(b);
function publish(workspaceId: string, status: SlackStatus | null) {
  const before = cache.get(workspaceId)?.status;
  cache.set(workspaceId, { status, at: Date.now() });
  if (same(before, status) && before !== undefined) return;
  listeners.forEach((fn) => { try { fn(workspaceId, status); } catch { /* a listener's problem isn't ours */ } });
}

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const errText = (e: unknown) => String((e as { message?: unknown })?.message ?? e ?? "");
const errCode = (e: unknown) => String((e as { code?: unknown })?.code ?? "");
/** slack_status / slack_connect … aren't there yet (0043 not run). */
function isMissingSchema(e: unknown): boolean {
  const code = errCode(e);
  return code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205"
    || (e as { status?: unknown })?.status === 404
    || /does not exist|schema cache|could not find the function/i.test(errText(e));
}
const isNetworkError = (e: unknown) =>
  isOffline() || e instanceof TypeError || /failed to fetch|network|load failed|fetch failed/i.test(errText(e));

/** The status as last known here (undefined: never asked). Lets a component render at once. */
export function peekSlackStatus(workspaceId: string | null): SlackStatus | null | undefined {
  if (!workspaceId) return null;
  if (!supabase) return demoStatus(workspaceId);
  return cache.get(workspaceId)?.status;
}

/** The workspace's Slack connection and, when it can't be read, why. Cached
 *  per workspace for a minute (`fresh` skips the cache). Never throws. */
export async function loadSlackStatus(workspaceId: string | null, opts: { fresh?: boolean } = {}): Promise<SlackStatusLoad> {
  if (!workspaceId) return { status: null };
  if (!supabase) return { status: demoStatus(workspaceId) };
  if (schemaMissing) return { status: null, problem: "unavailable" };
  const hit = cache.get(workspaceId);
  if (hit && !opts.fresh && Date.now() - hit.at < STATUS_TTL_MS) return { status: hit.status };
  if (isOffline()) return hit ? { status: hit.status } : { status: null, problem: "offline" };
  const running = inflight.get(workspaceId);
  if (running) return running;
  const client = supabase;
  const run = (async (): Promise<SlackStatusLoad> => {
    try {
      const { data, error } = await client.rpc("slack_status", { p_ws: workspaceId });
      if (error) {
        if (isMissingSchema(error)) { schemaMissing = true; return { status: null, problem: "unavailable" }; }
        return { status: hit?.status ?? null, problem: isNetworkError(error) ? "offline" : "error" };
      }
      const status = parseSlackStatus(data);
      publish(workspaceId, status);
      return { status };
    } catch (e) {
      return { status: hit?.status ?? null, problem: isNetworkError(e) ? "offline" : "error" };
    } finally {
      inflight.delete(workspaceId);
    }
  })();
  inflight.set(workspaceId, run);
  return run;
}

/** The workspace's Slack connection. Null when it can't be known or doesn't
 *  apply: the personal workspace, not a member, 0043 not run, offline. */
export async function getSlackStatus(workspaceId: string | null): Promise<SlackStatus | null> {
  return (await loadSlackStatus(workspaceId)).status;
}

/* ------------------------------------------------------------ owner/admin actions */

/** A channel name as people type it ("team-updates") shown the way Slack does
 *  ("#team-updates"); anything else ("Marketing team") is kept as written. ≤ 80. */
export function normaliseChannelLabel(label: string | null | undefined): string | null {
  const t = String(label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!t) return null;
  return /^[a-z0-9][a-z0-9._-]*$/.test(t) && t.length < 80 ? `#${t}` : t;
}

/** A refused owner/admin action → a sentence. */
function actionError(e: unknown): Error {
  const msg = errText(e).toLowerCase();
  if (isMissingSchema(e)) { schemaMissing = true; return new Error(SLACK_COPY.unavailable); }
  if (isNetworkError(e)) return new Error(SLACK_COPY.offline);
  if (msg.includes("not allowed")) return new Error(SLACK_COPY.notAllowed);
  if (msg.includes("invalid webhook url")) return new Error(SLACK_COPY.invalidUrl);
  if (msg.includes("invalid time")) return new Error(SLACK_COPY.invalidTime);
  if (msg.includes("not connected")) return new Error(SLACK_COPY.notConnected);
  return new Error(SLACK_COPY.saveFailed);
}

async function callAction(workspaceId: string, fn: string, args: Record<string, unknown>): Promise<SlackStatus> {
  if (!supabase) throw new Error(SLACK_COPY.unavailable);
  if (schemaMissing) throw new Error(SLACK_COPY.unavailable);
  if (isOffline()) throw new Error(SLACK_COPY.offline);
  let res: { data: unknown; error: unknown };
  try { res = await supabase.rpc(fn, args); } catch (e) { throw actionError(e); }
  if (res.error) throw actionError(res.error);
  const status = parseSlackStatus(res.data);
  if (!status) throw new Error(SLACK_COPY.saveFailed);
  publish(workspaceId, status);
  return status;
}

/** Owner/admin: connect (or replace) the channel. Throws an Error with a
 *  sentence for people ("That isn't a Slack webhook link…") on refusal. */
export async function connectSlack(workspaceId: string, webhookUrl: string, channelLabel?: string): Promise<SlackStatus> {
  const url = String(webhookUrl ?? "").trim();
  if (url.length > SLACK_URL_MAX) throw new Error(SLACK_COPY.tooLong);
  if (!isSlackWebhookUrl(url)) throw new Error(SLACK_COPY.invalidUrl);
  const label = normaliseChannelLabel(channelLabel);
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const s: SlackStatus = { ...demoStatus(workspaceId), connected: true, channelLabel: label, updatedAt: new Date().toISOString() };
    demo.set(workspaceId, s);
    demoHealth = { ...demoHealth, lastError: null };   // as the server: the old link's failures don't apply
    publish(workspaceId, s);
    return s;
  }
  return callAction(workspaceId, "slack_connect", { p_ws: workspaceId, p_url: url, p_channel_label: label });
}

/** Owner/admin: forget the webhook (auto-post switches off too). */
export async function disconnectSlack(workspaceId: string): Promise<SlackStatus> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const s: SlackStatus = { ...demoStatus(workspaceId), connected: false, autopost: false, updatedAt: new Date().toISOString() };
    demo.set(workspaceId, s);
    publish(workspaceId, s);
    return s;
  }
  return callAction(workspaceId, "slack_disconnect", { p_ws: workspaceId });
}

/** Owner/admin: the daily stand-up post, on at "HH:MM" (Europe/London) or off. */
export async function setSlackAutopost(workspaceId: string, enabled: boolean, time?: string): Promise<SlackStatus> {
  const t = time?.trim() || undefined;
  if (t !== undefined && !TIME_RE.test(t)) throw new Error(SLACK_COPY.invalidTime);
  if (!supabase) {
    await wait(DEMO_DELAY_MS / 2);
    const cur = demoStatus(workspaceId);
    if (enabled && !cur.connected) throw new Error(SLACK_COPY.notConnected);
    const at = t ?? cur.autopostTime;
    if (enabled && !at) throw new Error(SLACK_COPY.invalidTime);
    const s: SlackStatus = { ...cur, autopost: enabled, autopostTime: at ?? null, updatedAt: new Date().toISOString() };
    demo.set(workspaceId, s);
    publish(workspaceId, s);
    return s;
  }
  return callAction(workspaceId, "slack_set_autopost", { p_ws: workspaceId, p_enabled: enabled, p_time: t ?? null });
}

/* ------------------------------------------------------------ posting */

const FAILURES: readonly SlackFailure[] = ["not_connected", "not_allowed", "rate_limited", "slack_rejected", "invalid", "unavailable", "network"];
const isFailure = (v: unknown): v is SlackFailure => typeof v === "string" && (FAILURES as readonly string[]).includes(v);

/** "a minute", "3 minutes", "an hour". */
export function waitWords(seconds: number | undefined): string {
  const s = Math.max(1, Math.round(seconds ?? 60));
  if (s <= 60) return "a minute";
  if (s < 3600) return `${Math.ceil(s / 60)} minutes`;
  if (s < 5400) return "an hour";
  return `${Math.round(s / 3600)} hours`;
}

/** Why a post or test didn't go, in a sentence. */
export function slackFailureMessage(reason: SlackFailure, opts: { detail?: string; retryAfter?: number; action?: "test" | "post"; serverMessage?: string } = {}): string {
  switch (reason) {
    case "not_connected": return "Slack isn't connected to this workspace any more.";
    case "not_allowed": return opts.action === "test" ? "Only owners and admins can send a test message." : "You can't post to Slack from this workspace.";
    case "rate_limited": return `That's a lot of posts in a short time. Try again in ${waitWords(opts.retryAfter)}.`;
    case "slack_rejected":
      switch (opts.detail) {
        case "no_service": case "no_team": case "team_disabled": case "invalid_token": case "channel_not_found": case "no_active_hooks":
          return "Slack no longer accepts this webhook link. An owner or admin can reconnect Slack in Settings.";
        case "channel_is_archived":
          return "That Slack channel has been archived. An owner or admin can connect another channel in Settings.";
        case "action_prohibited": case "posting_to_general_channel_denied":
          return "Your Slack admins don't allow posts to that channel.";
        case "slack_unavailable": case "unreachable":
          return "Slack isn't responding. Try again in a few minutes.";
        default:
          return "Slack didn't accept the message. Try again in a moment.";
      }
    case "invalid": return opts.serverMessage && /^[A-Z].{3,200}[.]$/.test(opts.serverMessage) ? opts.serverMessage : "That couldn't be posted.";
    case "unavailable": return "Posting to Slack isn't switched on yet.";
    case "network": return isOffline() ? SLACK_COPY.offline : "Couldn't reach Kanbo. Check your connection and try again.";
  }
}

const fail = (reason: SlackFailure, opts: Parameters<typeof slackFailureMessage>[1] = {}): SlackPostResult =>
  ({ ok: false, reason, message: slackFailureMessage(reason, opts), ...(opts.retryAfter ? { retryAfter: opts.retryAfter } : {}) });

/** A failed functions.invoke → the result to show. */
async function invokeFailure(error: unknown, action: "test" | "post", workspaceId: string): Promise<SlackPostResult> {
  const name = String((error as { name?: unknown })?.name ?? "");
  if (name === "FunctionsFetchError" || isNetworkError(error)) return fail("network", { action });
  if (name === "FunctionsRelayError") return fail("unavailable", { action });
  const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown>; clone?: () => { json: () => Promise<unknown> } } })?.context;
  const status = typeof ctx?.status === "number" ? ctx.status : undefined;
  let body: Record<string, unknown> = {};
  try {
    const raw = await (ctx?.clone ? ctx.clone().json() : ctx?.json?.());
    if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
  } catch { /* not JSON */ }
  const retryAfter = typeof body.retryAfter === "number" && body.retryAfter > 0 ? body.retryAfter : undefined;
  const detail = typeof body.detail === "string" ? body.detail : undefined;
  const serverMessage = typeof body.error === "string" ? body.error : undefined;
  if (isFailure(body.reason)) {
    if (body.reason === "not_connected") void loadSlackStatus(workspaceId, { fresh: true });
    return fail(body.reason, { action, retryAfter, detail, serverMessage });
  }
  if (status === 404) return fail("unavailable", { action });               // the function isn't deployed
  if (status === 401 || status === 403) return fail("not_allowed", { action });
  if (status === 429) return fail("rate_limited", { action, retryAfter });
  return fail("unavailable", { action });
}

const POST_TIMEOUT_MS = 20_000;

async function invokeSlack(workspaceId: string, body: Record<string, unknown>, action: "test" | "post"): Promise<SlackPostResult> {
  if (!supabase) return fail("unavailable", { action });
  if (isOffline()) return fail("network", { action });
  try {
    const { data, error } = await supabase.functions.invoke("slack-post", { body: { ...body, workspaceId }, timeout: POST_TIMEOUT_MS });
    if (error) return invokeFailure(error, action, workspaceId);
    const d = (data ?? {}) as { ok?: unknown };
    return d.ok === true ? { ok: true } : fail("slack_rejected", { action });
  } catch (e) {
    return isNetworkError(e) ? fail("network", { action }) : fail("unavailable", { action });
  }
}

/** Owner/admin: send a test message to the connected channel. Never throws. */
export async function testSlack(workspaceId: string): Promise<SlackPostResult> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    if (!demoStatus(workspaceId).connected) return fail("not_connected", { action: "test" });
    demoHealth = { ...demoHealth, lastError: null };   // as the server: a delivered post clears a failed daily one
    return { ok: true };
  }
  return invokeSlack(workspaceId, { action: "test" }, "test");
}

export interface SlackPostInput {
  kind: SlackPostKind;
  /** the write-up: Pulse's stand-up text, the status update, Radar's summary (capped server-side) */
  text: string;
  /** "status": the project it's about (the server reads its name and links /p/:id) */
  projectId?: string;
  /** "status": on track / at risk / off track */
  status?: StatusKind;
  /** optional heading override */
  title?: string;
}

const KIND_ACTION: Record<SlackPostKind, string> = { standup: "post_standup", status: "post_status", risks: "post_risks" };

/** Owner/admin/member: post to the workspace's channel. Never throws. */
export async function postToSlack(workspaceId: string, input: SlackPostInput): Promise<SlackPostResult> {
  const action = KIND_ACTION[input?.kind];
  if (!workspaceId || !action) return fail("invalid", { action: "post" });
  const text = String(input.text ?? "").trim();
  if (!text) return { ok: false, reason: "invalid", message: SLACK_COPY.nothingToPost };
  if (input.kind === "status" && !input.projectId) return fail("invalid", { action: "post" });
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const s = demoStatus(workspaceId);
    return s.connected ? { ok: true } : fail("not_connected", { action: "post" });
  }
  return invokeSlack(workspaceId, {
    action,
    text: text.slice(0, SLACK_LIMITS.text),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.title?.trim() ? { title: input.title.trim().slice(0, SLACK_LIMITS.title) } : {}),
  }, "post");
}

/** Told whenever a workspace's status changes here (connect / disconnect / auto-post),
 *  so every SlackPostButton on screen shows or hides itself at once. */
export function onSlackStatusChange(fn: (workspaceId: string, status: SlackStatus | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/* ------------------------------------------------------------ helpers for the integrator */

/** Auto-post times offered in Settings: every 15 minutes (the cron's step), 06:00–20:00. */
export const SLACK_AUTOPOST_TIMES: readonly string[] = Array.from({ length: (20 - 6) * 4 + 1 }, (_, i) => {
  const m = 6 * 60 + i * 15;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});
export const DEFAULT_AUTOPOST_TIME = "09:00";

/** A Radar risk, as much of it as Slack needs (lib/radar's Risk fits). */
export interface SlackRisk { title: string; reason?: string; severity?: "signal" | "warn" | "neutral" }

/**
 * Radar's risks as Slack text (for SlackPostButton kind "risks"): a bold
 * count, then one line per risk, most serious first. At most `max` lines
 * (default 15), then "+N more in Kanbo".
 */
export function risksSlackText(risks: readonly SlackRisk[], opts: { max?: number } = {}): string {
  const max = Math.max(1, opts.max ?? 15);
  if (!risks.length) return "*Nothing on the Radar*\nNothing is blocked, slipping or over capacity right now.";
  const rank = { signal: 0, warn: 1, neutral: 2 } as const;
  const sorted = [...risks].sort((a, b) => rank[a.severity ?? "neutral"] - rank[b.severity ?? "neutral"]);
  const line = (r: SlackRisk) => {
    const title = r.title.replace(/\s+/g, " ").trim();
    const reason = (r.reason ?? "").replace(/\s+/g, " ").trim();
    return `• *${title.replace(/\*/g, "")}*${reason ? ` — ${reason}` : ""}`;
  };
  const lines = sorted.slice(0, max).map(line);
  if (sorted.length > max) lines.push(`+${sorted.length - max} more in Kanbo`);
  return [`*${risks.length} ${risks.length === 1 ? "risk" : "risks"} on the Radar*`, ...lines].join("\n");
}

/* ------------------------------------------------------------ is the daily post going out? */

/** Is Kanbo's daily stand-up really being posted? (Settings, owners/admins.) */
export interface SlackAutopostHealth {
  /** true: Kanbo's scheduler ran in the last hour · false: it isn't running
   *  (slack-standup not deployed or its pg_cron job not scheduled) · null: can't tell */
  ready: boolean | null;
  /** the last daily post that didn't go out with the current link, if none has since */
  lastError: { detail: string; at: string; day: string } | null;
}
export interface SlackHealthLoad {
  health: SlackAutopostHealth | null;
  /** why it couldn't be checked: slack-post isn't deployed (or predates "status"), offline, or another error */
  problem?: "unavailable" | "offline" | "error";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let demoHealth: SlackAutopostHealth = { ready: true, lastError: null };

/** slack-post's "status" answer → SlackAutopostHealth; null for anything malformed. */
export function parseAutopostHealth(raw: unknown): SlackAutopostHealth | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!("autopostReady" in r)) return null;
  const ready = typeof r.autopostReady === "boolean" ? r.autopostReady : null;
  const e = r.lastAutopostError as Record<string, unknown> | null | undefined;
  const lastError = e && typeof e === "object" && typeof e.detail === "string" && FAILURE_DETAIL_RE.test(e.detail)
    && typeof e.day === "string" && DAY_RE.test(e.day) && typeof e.at === "string"
    ? { detail: e.detail, at: e.at, day: e.day } : null;
  return { ready, lastError };
}

/** Owner/admin: is the daily stand-up going out? Never throws; not cached
 *  (Settings asks once when it opens). */
export async function loadSlackAutopostHealth(workspaceId: string | null): Promise<SlackHealthLoad> {
  if (!workspaceId) return { health: null };
  if (!supabase) {
    await wait(DEMO_DELAY_MS / 2);
    return { health: { ...demoHealth } };
  }
  if (schemaMissing) return { health: null, problem: "unavailable" };
  if (isOffline()) return { health: null, problem: "offline" };
  try {
    const { data, error } = await supabase.functions.invoke("slack-post", { body: { action: "status", workspaceId }, timeout: POST_TIMEOUT_MS });
    if (error) {
      const r = await invokeFailure(error, "test", workspaceId);
      if (r.ok) return { health: null, problem: "error" };
      // an older slack-post doesn't know "status" (400 invalid): as good as not deployed
      return { health: null, problem: r.reason === "network" ? "offline" : r.reason === "unavailable" || r.reason === "invalid" ? "unavailable" : "error" };
    }
    const health = parseAutopostHealth(data);
    return health ? { health } : { health: null, problem: "unavailable" };
  } catch (e) {
    return { health: null, problem: isNetworkError(e) ? "offline" : "error" };
  }
}

/** What to tell an owner/admin under the daily stand-up switch (null: nothing). */
export interface AutopostNote { tone: "warn" | "signal" | "quiet"; text: string }

const GONE_WORDS = new Set(["no_service", "no_team", "team_disabled", "invalid_token", "channel_not_found", "no_active_hooks", "http_404", "http_410"]);
const PROHIBITED_WORDS = new Set(["action_prohibited", "posting_to_general_channel_denied"]);
const UNREACHABLE_WORDS = new Set(["slack_unavailable", "unreachable", "rate_limited", "timeout"]);

/** The sentence for a daily post that's on but not (or not reliably) going out. */
export function autopostNote(load: SlackHealthLoad | null): AutopostNote | null {
  if (!load) return null;
  const h = load.health;
  if (!h) {
    if (load.problem === "offline" || !load.problem) return null;
    return { tone: "quiet", text: "Kanbo couldn't check that the daily post is running. If a stand-up doesn't arrive, send a test to check the channel." };
  }
  if (h.ready === false) {
    return { tone: "warn", text: "The daily post isn't scheduled on Kanbo's server yet, so nothing will be posted until it is. Your choice is saved." };
  }
  const e = h.lastError;
  if (!e) return null;
  const day = fmtDay(e.day);
  if (GONE_WORDS.has(e.detail)) return { tone: "signal", text: `Slack refused the stand-up on ${day}: it no longer accepts this webhook link. Replace the link to start posting again.` };
  if (e.detail === "channel_is_archived") return { tone: "signal", text: `Slack refused the stand-up on ${day}: the channel has been archived. Replace the link with one for another channel.` };
  if (PROHIBITED_WORDS.has(e.detail)) return { tone: "signal", text: `Slack refused the stand-up on ${day}: your Slack admins don't allow posts to that channel. Replace the link with one for another channel.` };
  if (UNREACHABLE_WORDS.has(e.detail)) return { tone: "warn", text: `The stand-up on ${day} didn't reach Slack because Slack wasn't responding. Kanbo will post again on the next weekday.` };
  if (e.detail === "kanbo_error") return { tone: "warn", text: `Kanbo couldn't put together the stand-up on ${day}. It will try again on the next weekday.` };
  return { tone: "signal", text: `Slack refused the stand-up on ${day}. Send a test to check the channel, or replace the link.` };
}

/** Tests only: forget the cache, the demo connections, listeners and the
 *  "0043 missing" flag; optionally shorten the demo's pretend network delay. */
export function resetSlackState(opts: { demoDelayMs?: number } = {}): void {
  cache.clear(); inflight.clear(); demo.clear(); listeners.clear(); schemaMissing = false;
  DEMO_DELAY_MS = opts.demoDelayMs ?? 450;
  demoHealth = { ready: true, lastError: null };
}

/** Tests only: what the demo says about the daily post (default: running, nothing refused). */
export function setDemoAutopostHealth(health: SlackAutopostHealth): void {
  demoHealth = { ready: health.ready, lastError: health.lastError ? { ...health.lastError } : null };
}
