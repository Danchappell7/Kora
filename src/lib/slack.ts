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
     4xx/5xx { error: string, reason: SlackFailure, retryAfter?: number }
   Demo mode (no Supabase): an in-memory fake that always succeeds.
   CONTRACT STUB — f6 replaces the bodies, keeps every exported name/signature.
   ============================================================ */
import type { SlackPostKind, SlackPostResult, SlackStatus, StatusKind } from "../data/types";

/** The only webhook shape accepted (same rule as the database check). */
export const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/;

/** True for a Slack Incoming Webhook URL (https://hooks.slack.com/services/…, ≤ 500 chars). */
export function isSlackWebhookUrl(url: string): boolean {
  const u = (url ?? "").trim();
  return u.length <= 500 && SLACK_WEBHOOK_RE.test(u);
}

/** slack_status() JSON (snake_case) → SlackStatus; null for null / anything malformed. */
export function parseSlackStatus(raw: unknown): SlackStatus | null {
  void raw;
  return null;
}

/** The workspace's Slack connection. Null when it can't be known or doesn't
 *  apply: the personal workspace, not a member, 0043 not run, offline. */
export async function getSlackStatus(workspaceId: string | null): Promise<SlackStatus | null> {
  void workspaceId;
  return null;
}

/** Owner/admin: connect (or replace) the channel. Throws an Error with a
 *  sentence for people ("That isn't a Slack webhook link…") on refusal. */
export async function connectSlack(workspaceId: string, webhookUrl: string, channelLabel?: string): Promise<SlackStatus> {
  void workspaceId; void webhookUrl; void channelLabel;
  throw new Error("Slack isn't available yet.");
}

/** Owner/admin: forget the webhook (auto-post switches off too). */
export async function disconnectSlack(workspaceId: string): Promise<SlackStatus> {
  void workspaceId;
  throw new Error("Slack isn't available yet.");
}

/** Owner/admin: the daily stand-up post, on at "HH:MM" (Europe/London) or off. */
export async function setSlackAutopost(workspaceId: string, enabled: boolean, time?: string): Promise<SlackStatus> {
  void workspaceId; void enabled; void time;
  throw new Error("Slack isn't available yet.");
}

/** Owner/admin: send a test message to the connected channel. */
export async function testSlack(workspaceId: string): Promise<SlackPostResult> {
  void workspaceId;
  return { ok: false, reason: "unavailable", message: "Slack isn't available yet." };
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

/** Owner/admin/member: post to the workspace's channel. Never throws. */
export async function postToSlack(workspaceId: string, input: SlackPostInput): Promise<SlackPostResult> {
  void workspaceId; void input;
  return { ok: false, reason: "unavailable", message: "Slack isn't available yet." };
}

/** Told whenever a workspace's status changes here (connect / disconnect / auto-post),
 *  so every SlackPostButton on screen shows or hides itself at once. */
export function onSlackStatusChange(fn: (workspaceId: string, status: SlackStatus | null) => void): () => void {
  void fn;
  return () => {};
}
