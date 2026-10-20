/* ============================================================
   KANBO — the Kanbo Slack app, from the app's side.              [0049]
   The Slack app itself is the "slack-app" edge function (/kanbo, the
   "Create a Kanbo task" message shortcut, link previews, the Home tab).
   Here: linking a Slack account (/link/slack), the Settings panel's status,
   choosing the Kanbo workspace a Slack workspace adds tasks to, unlinking,
   and the "From Slack" chip's link check.

   Contract (database 0049):
     rpc slack_app_status(p_ws) → status JSON | null (not in the workspace)
         { workspace_id, can_manage, teams: [{ team_id, team_name, connected_at,
           default_set_at, is_default_here, default_workspace_id,
           default_workspace_name, default_elsewhere, linked, can_set_default }],
           links: [{ team_id, team_name, slack_user_id, slack_user_name, linked_at }] }
     rpc slack_app_set_default(p_team, p_ws | null) → status   ('not allowed')
     rpc slack_link_preview(p_token) → { status: 'ok' | 'used' | 'expired', team_name,
         slack_user_name, expires_at, has_email, email_matches, already_linked } | null
     rpc claim_slack_link(p_token, p_accept_mismatch) → { team_id, team_name, slack_user_id,
         slack_user_name, linked_at }
         errors: 'not allowed' | 'invalid link' | 'link already used' | 'link expired' | 'email mismatch'
     delete from slack_user_links where team_id = … and slack_user_id = …   (your own rows only: RLS)

   The one-time link (/link/slack?t=…) survives signing in: Root keeps the
   token in sessionStorage (this tab only, 15 minutes) for a Google sign-in
   that comes back to the home page, and App opens the link page from it.

   Demo mode (no Supabase): an in-memory "Foundrise" Slack workspace
   connected to the demo team workspace, with one linked account; any token
   previews as that Slack workspace. Every failure is a SlackAppError with a
   sentence (British English) as its message.
   ============================================================ */
import { supabase } from "./supabase";
import { SLACK_LINK_TOKEN_RE } from "./slackLinkToken";
import { isSlackPermalink, slackPermalinkOf, SLACK_PERMALINK_RE } from "../../supabase/functions/_shared/slackPermalink.ts";

export { isSlackPermalink, slackPermalinkOf, SLACK_PERMALINK_RE };

export interface SlackAppTeam {
  teamId: string;
  teamName: string | null;
  connectedAt: string | null;
  /** this workspace is the one /kanbo adds to */
  isDefaultHere: boolean;
  /** the Kanbo workspace it adds to, when you're in it */
  defaultWorkspaceId: string | null;
  defaultWorkspaceName: string | null;
  /** it adds to a Kanbo workspace other than this one */
  defaultElsewhere: boolean;
  /** you have a Slack account linked there */
  linked: boolean;
  /** you may point it at this workspace (owner/admin here, linked there, and owner/admin of where it points now) */
  canSetDefault: boolean;
}
export interface SlackAppLink {
  teamId: string;
  teamName: string | null;
  slackUserId: string;
  slackUserName: string | null;
  linkedAt: string | null;
}
export interface SlackAppStatus {
  workspaceId: string | null;
  canManage: boolean;
  teams: SlackAppTeam[];
  links: SlackAppLink[];
}
export interface SlackLinkPreview {
  status: "ok" | "used" | "expired";
  teamId: string | null;
  teamName: string | null;
  slackUserName: string | null;
  expiresAt: string | null;
  /** Slack shared the account's email */
  hasEmail: boolean;
  /** …and it's your Kanbo email */
  emailMatches: boolean;
  /** this Slack account is already linked to you */
  alreadyLinked: boolean;
}
export interface SlackLinkResult { teamId: string; teamName: string | null; slackUserId: string; slackUserName: string | null; linkedAt: string | null }

export type SlackAppFailure = "not_allowed" | "invalid_link" | "used" | "expired" | "email_mismatch" | "unavailable" | "network" | "unknown";

export const SLACK_APP_COPY = {
  notAllowed: "You can't do that. Only owners and admins who've linked their own Slack account there can choose the workspace.",
  invalidLink: "This link isn't valid. Type /kanbo in Slack to get a new one.",
  used: "This link has already been used. Type /kanbo in Slack to get a new one.",
  expired: "This link has expired (they last 15 minutes). Type /kanbo in Slack to get a new one.",
  emailMismatch: "This Slack account's email isn't your Kanbo email. Tick the box to confirm it's yours.",
  unavailable: "Kanbo's Slack app isn't switched on yet.",
  network: "You're offline. Check your connection and try again.",
  unknown: "Something went wrong. Try again.",
} as const;

export class SlackAppError extends Error {
  constructor(public reason: SlackAppFailure, message: string) {
    super(message);
    this.name = "SlackAppError";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => !!x) : []);

/** slack_app_status() JSON → SlackAppStatus; null for null / malformed (not in the workspace). */
export function parseSlackAppStatus(raw: unknown): SlackAppStatus | null {
  const r = obj(raw);
  if (!r || !Array.isArray(r.teams) || !Array.isArray(r.links)) return null;
  return {
    workspaceId: str(r.workspace_id),
    canManage: r.can_manage === true,
    teams: list(r.teams).filter((t) => !!str(t.team_id)).map((t) => ({
      teamId: String(t.team_id),
      teamName: str(t.team_name),
      connectedAt: str(t.connected_at),
      isDefaultHere: t.is_default_here === true,
      defaultWorkspaceId: str(t.default_workspace_id),
      defaultWorkspaceName: str(t.default_workspace_name),
      defaultElsewhere: t.default_elsewhere === true,
      linked: t.linked === true,
      canSetDefault: t.can_set_default === true,
    })),
    links: list(r.links).filter((l) => !!str(l.team_id) && !!str(l.slack_user_id)).map(parseLink),
  };
}
function parseLink(l: Record<string, unknown>): SlackAppLink {
  return { teamId: String(l.team_id), teamName: str(l.team_name), slackUserId: String(l.slack_user_id), slackUserName: str(l.slack_user_name), linkedAt: str(l.linked_at) };
}

export function parseSlackLinkPreview(raw: unknown): SlackLinkPreview | null {
  const r = obj(raw);
  if (!r || (r.status !== "ok" && r.status !== "used" && r.status !== "expired")) return null;
  return {
    status: r.status,
    teamId: str(r.team_id),
    teamName: str(r.team_name),
    slackUserName: str(r.slack_user_name),
    expiresAt: str(r.expires_at),
    hasEmail: r.has_email === true,
    emailMatches: r.email_matches === true,
    alreadyLinked: r.already_linked === true,
  };
}

/** A database / network error → why. */
export function slackAppFailure(e: unknown): SlackAppError {
  if (e instanceof SlackAppError) return e;
  const err = (e ?? {}) as { message?: string; code?: string };
  const msg = String(err.message ?? e ?? "");
  const code = String(err.code ?? "");
  if (/link already used/i.test(msg)) return new SlackAppError("used", SLACK_APP_COPY.used);
  if (/link expired/i.test(msg)) return new SlackAppError("expired", SLACK_APP_COPY.expired);
  if (/invalid link/i.test(msg)) return new SlackAppError("invalid_link", SLACK_APP_COPY.invalidLink);
  if (/email mismatch/i.test(msg)) return new SlackAppError("email_mismatch", SLACK_APP_COPY.emailMismatch);
  if (/not allowed/i.test(msg) || code === "42501") return new SlackAppError("not_allowed", SLACK_APP_COPY.notAllowed);
  if (code === "PGRST202" || code === "42883" || code === "42P01" || code === "PGRST205" || /could not find the function|does not exist|schema cache/i.test(msg)) {
    return new SlackAppError("unavailable", SLACK_APP_COPY.unavailable);
  }
  if (/failed to fetch|network|load failed/i.test(msg)) return new SlackAppError("network", SLACK_APP_COPY.network);
  return new SlackAppError("unknown", SLACK_APP_COPY.unknown);
}

/* ------------------------------------------------------------ the one-time link */
// (in its own small file: Root keeps a signed-out visitor's token without loading the rest)
export { SLACK_LINK_PATH, SLACK_LINK_TOKEN_RE, slackLinkTokenFromUrl, rememberSlackLink, pendingSlackLink, forgetSlackLink, slackLinkToOpen, isSlackLinkPath } from "./slackLinkToken";
/* ------------------------------------------------------------ demo */

const DEMO_WS = "ws-foundrise";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let DEMO_DELAY_MS = 250;
interface DemoState { defaultWs: string | null; links: SlackAppLink[] }
const demo: DemoState = {
  defaultWs: DEMO_WS,
  links: [{ teamId: "T0FOUNDRISE", teamName: "foundrise", slackUserId: "U0DEMO", slackUserName: "You (Slack)", linkedAt: "2026-10-01T09:00:00.000Z" }],
};
function demoStatus(ws: string | null): SlackAppStatus {
  const linked = demo.links.some((l) => l.teamId === "T0FOUNDRISE");
  const team: SlackAppTeam = {
    teamId: "T0FOUNDRISE", teamName: "foundrise", connectedAt: "2026-10-01T09:00:00.000Z",
    isDefaultHere: !!ws && demo.defaultWs === ws, defaultWorkspaceId: demo.defaultWs, defaultWorkspaceName: demo.defaultWs === DEMO_WS ? "Foundrise" : null,
    defaultElsewhere: !!demo.defaultWs && demo.defaultWs !== ws, linked, canSetDefault: linked && ws === DEMO_WS,
  };
  return { workspaceId: ws, canManage: ws === DEMO_WS, teams: linked || (ws && demo.defaultWs === ws) ? [team] : [], links: demo.links.map((l) => ({ ...l })) };
}
/** demo only: back to the seeded state (tests; `delayMs` 0 answers at once) */
export function resetSlackAppDemo(opts: { delayMs?: number } = {}): void {
  if (opts.delayMs !== undefined) DEMO_DELAY_MS = opts.delayMs;
  demo.defaultWs = DEMO_WS;
  demo.links = [{ teamId: "T0FOUNDRISE", teamName: "foundrise", slackUserId: "U0DEMO", slackUserName: "You (Slack)", linkedAt: "2026-10-01T09:00:00.000Z" }];
}

/* ------------------------------------------------------------ calls */

/** The Slack app from a workspace (null = Personal: just your links). Null when you're not in it. */
export async function loadSlackAppStatus(workspaceId: string | null): Promise<SlackAppStatus | null> {
  if (!supabase) { await wait(DEMO_DELAY_MS / 2); return demoStatus(workspaceId); }
  const { data, error } = await supabase.rpc("slack_app_status", { p_ws: workspaceId });
  if (error) throw slackAppFailure(error);
  return parseSlackAppStatus(data);
}

/** Point a Slack workspace's /kanbo at this Kanbo workspace (null: at none). */
export async function setSlackDefaultWorkspace(teamId: string, workspaceId: string | null): Promise<SlackAppStatus | null> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    if (workspaceId && workspaceId !== DEMO_WS) throw new SlackAppError("not_allowed", SLACK_APP_COPY.notAllowed);
    demo.defaultWs = workspaceId;
    return demoStatus(workspaceId ?? DEMO_WS);
  }
  const { data, error } = await supabase.rpc("slack_app_set_default", { p_team: teamId, p_ws: workspaceId });
  if (error) throw slackAppFailure(error);
  return parseSlackAppStatus(data);
}

/** Unlink one of your Slack accounts (RLS: your own rows only). */
export async function unlinkSlackAccount(teamId: string, slackUserId: string): Promise<void> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    demo.links = demo.links.filter((l) => !(l.teamId === teamId && l.slackUserId === slackUserId));
    return;
  }
  const { error } = await supabase.from("slack_user_links").delete().eq("team_id", teamId).eq("slack_user_id", slackUserId);
  if (error) throw slackAppFailure(error);
}

/** Whose Slack account a link is for (null: no such link). */
export async function previewSlackLink(token: string): Promise<SlackLinkPreview | null> {
  if (!SLACK_LINK_TOKEN_RE.test(token)) return null;
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    return { status: "ok", teamId: "T0FOUNDRISE", teamName: "foundrise", slackUserName: "You (Slack)", expiresAt: new Date(Date.now() + 14 * 60_000).toISOString(),
      hasEmail: true, emailMatches: true, alreadyLinked: false };
  }
  const { data, error } = await supabase.rpc("slack_link_preview", { p_token: token });
  if (error) throw slackAppFailure(error);
  return parseSlackLinkPreview(data);
}

/** Claim a link: this Slack account becomes yours in Kanbo. */
export async function claimSlackLink(token: string, acceptMismatch = false): Promise<SlackLinkResult> {
  if (!SLACK_LINK_TOKEN_RE.test(token)) throw new SlackAppError("invalid_link", SLACK_APP_COPY.invalidLink);
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const link: SlackAppLink = { teamId: "T0FOUNDRISE", teamName: "foundrise", slackUserId: "U0DEMO", slackUserName: "You (Slack)", linkedAt: new Date().toISOString() };
    demo.links = [...demo.links.filter((l) => l.slackUserId !== link.slackUserId), link];
    return link;
  }
  const { data, error } = await supabase.rpc("claim_slack_link", { p_token: token, p_accept_mismatch: acceptMismatch });
  if (error) throw slackAppFailure(error);
  const r = obj(data);
  if (!r || !str(r.team_id)) throw new SlackAppError("unknown", SLACK_APP_COPY.unknown);
  return parseLink(r);
}

/** "acme" → "acme.slack.com"; a real name stays as it is. */
export function slackTeamLabel(name: string | null | undefined, teamId?: string): string {
  const n = String(name ?? "").trim();
  if (!n) return teamId ? `Slack workspace ${teamId}` : "your Slack workspace";
  return /^[a-z0-9-]+$/.test(n) ? `${n}.slack.com` : n;
}

/** /kanbo examples for the "How to use" card. */
export const SLACK_EXAMPLES: { text: string; means: string }[] = [
  { text: "/kanbo Send the brief fri 3pm", means: "Due Friday at 15:00, in your Personal list" },
  { text: "/kanbo Review the deck #launch @sana tomorrow", means: "In the Launch project, assigned to Sana, due tomorrow" },
  { text: "/kanbo Book the venue next week !high ~2h", means: "High priority, 2-hour estimate" },
  { text: "/kanbo help", means: "Everything /kanbo understands" },
];
