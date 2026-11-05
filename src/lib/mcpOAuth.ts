/* ============================================================
   KANBO — connecting AI apps: what the consent page and Settings call. [0050]

   Contract:
     POST /oauth/prepare (mcp edge function, the person's session token)
       { client_id, redirect_uri } → { ok: true, client } | { ok: false, reason, message }
     rpc mcp_oauth_approve(p_client_id, p_redirect_uri, p_code_challenge, p_resource,
                           p_scope, p_access, p_workspace) → { code, expires_in }
     rpc mcp_oauth_list_grants() → grant JSON[]
     rpc mcp_oauth_revoke_grant(p_id) → { id, revoked }

   Real: those, as the signed-in person. Nothing is ever stored in the browser
   beyond the request itself. Demo mode (no Supabase): an in-memory example,
   so the consent page and Settings can be tried end to end.
   Until migration 0050 and the mcp function are live, list and prepare say so
   (McpNotReady), and the rest of the app carries on as before.
   ============================================================ */
import { authorizeRedirect, type AuthorizeRequest } from "../../supabase/functions/_shared/mcp/oauthCore.ts";
import { MCP_ISSUER, MCP_RESOURCE } from "../../supabase/functions/_shared/mcp/metadata.ts";
import type { PreparedClient } from "../../supabase/functions/_shared/mcp/oauth.ts";
import { supabase } from "./supabase";

export { MCP_ISSUER, MCP_RESOURCE };
export type { AuthorizeRequest, PreparedClient };

export type McpAccess = "read" | "write";

export type PrepareResult =
  | { ok: true; client: PreparedClient }
  | { ok: false; reason: "signed_out" | "not_ready" | "unavailable" | "refused"; message: string };

export interface ConnectedApp {
  id: string;
  name: string;
  host: string | null;
  access: McpAccess;
  workspaceId: string | null;
  workspaceName: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface ConsentWorkspace { id: string; name: string }

/** The function or the migration isn't there yet. */
export class McpNotReady extends Error {
  constructor() { super("not ready"); this.name = "McpNotReady"; }
}

export const MCP_COPY = {
  notReady: "Connecting AI apps isn't switched on for Kanbo yet. Everything else carries on as normal.",
  offline: "You're offline. Try again when you're back online.",
  failed: "Couldn't do that. Try again.",
  checkFailed: "Kanbo couldn't check this app just now. Try again in a moment.",
} as const;

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/* ---------- the demo ---------- */

const DEMO_APPS: ConnectedApp[] = [
  { id: "demo-claude", name: "Claude", host: "claude.ai", access: "write", workspaceId: null, workspaceName: null, createdAt: "2026-10-28T09:12:00Z", lastUsedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
  { id: "demo-cursor", name: "Cursor", host: null, access: "read", workspaceId: "ws-foundrise", workspaceName: "Foundrise", createdAt: "2026-10-12T16:40:00Z", lastUsedAt: null },
];
let demoApps = [...DEMO_APPS];
/** Puts the demo's example connections back (tests). */
export function resetDemoConnectedApps(): void { demoApps = [...DEMO_APPS]; }

export const DEMO_CONSENT_WORKSPACES: ConsentWorkspace[] = [{ id: "ws-foundrise", name: "Foundrise" }, { id: "ws-side", name: "Side project" }];

/* ---------- the consent page ---------- */

/** Asks the mcp function whether this app and this address belong together (it fetches an app's published description). */
export async function prepareClient(clientId: string, redirectUri: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<PrepareResult> {
  if (!supabase) {
    return { ok: true, client: { name: "Claude", kind: "cimd", clientHost: "claude.ai", redirectHost: new URL(redirectUri).hostname, loopback: /^http:\/\/(localhost|127\.0\.0\.1)/.test(redirectUri) } };
  }
  if (offline()) return { ok: false, reason: "unavailable", message: MCP_COPY.offline };
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, reason: "signed_out", message: "Sign in to Kanbo first." };
  let res: Response;
  try {
    res = await fetchImpl("/oauth/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri }),
    });
  } catch {
    return { ok: false, reason: "unavailable", message: MCP_COPY.checkFailed };
  }
  let body: { ok?: boolean; client?: PreparedClient; reason?: string; message?: string } | null = null;
  try { body = await res.json(); } catch { body = null; }
  // the proxy has nothing there yet, or the function isn't deployed
  if (!body || res.status === 404 || body.reason === "not_ready") return { ok: false, reason: "not_ready", message: MCP_COPY.notReady };
  if (body.ok && body.client) return { ok: true, client: body.client };
  if (res.status === 401) return { ok: false, reason: "signed_out", message: "Sign in to Kanbo first." };
  if (res.status >= 500 || res.status === 429) return { ok: false, reason: "unavailable", message: body.message || MCP_COPY.checkFailed };
  return { ok: false, reason: "refused", message: body.message || "Kanbo can't connect this app." };
}

/** The workspaces offered at consent (RLS: yours). A failure just means "all my workspaces" is the only offer. */
export async function consentWorkspaces(): Promise<ConsentWorkspace[]> {
  if (!supabase) return DEMO_CONSENT_WORKSPACES;
  const { data, error } = await supabase.from("workspaces").select("id, name").order("name");
  if (error || !Array.isArray(data)) return [];
  return data.map((w) => ({ id: String(w.id), name: String(w.name ?? "Workspace") }));
}

export type ApproveFailure = "not_ready" | "rate_limited" | "not_allowed" | "bad_request" | "network" | "error";

export class ApproveError extends Error {
  constructor(public failure: ApproveFailure, message: string) { super(message); this.name = "ApproveError"; }
}

const APPROVE_MESSAGES: Record<ApproveFailure, string> = {
  not_ready: MCP_COPY.notReady,
  rate_limited: "Too many tries. Wait a minute and try again.",
  not_allowed: "Your Kanbo account can't connect apps right now, or isn't in that workspace.",
  bad_request: "This request from the app isn't valid any more. Start connecting again from the app.",
  network: "Couldn't reach Kanbo. Check your connection and try again.",
  error: MCP_COPY.failed,
};

export function approveFailure(e: unknown): ApproveError {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  const kind: ApproveFailure =
    code === "42883" || code === "PGRST202" || /could not find the function|does not exist/i.test(msg) ? "not_ready"
    : /rate limited/i.test(msg) ? "rate_limited"
    : /not authorized|not allowed/i.test(msg) ? "not_allowed"
    : /invalid (client|redirect|challenge|target|access)/i.test(msg) ? "bad_request"
    : /failed to fetch|network|load failed/i.test(msg) ? "network"
    : "error";
  return new ApproveError(kind, APPROVE_MESSAGES[kind]);
}

/** Allow: the one-time code for the app. Postgres checks everything again. */
export async function approveConnection(req: AuthorizeRequest, access: McpAccess, workspaceId: string | null): Promise<string> {
  if (!supabase) return "demo-code";
  if (offline()) throw new ApproveError("network", MCP_COPY.offline);
  const { data, error } = await supabase.rpc("mcp_oauth_approve", {
    p_client_id: req.clientId,
    p_redirect_uri: req.redirectUri,
    p_code_challenge: req.codeChallenge,
    p_resource: req.resource,
    p_scope: req.scope,
    p_access: access,
    p_workspace: workspaceId,
  });
  if (error) throw approveFailure(error);
  const code = (typeof data === "string" ? JSON.parse(data) : data)?.code;
  if (typeof code !== "string") throw new ApproveError("error", MCP_COPY.failed);
  return code;
}

/** Where Allow sends the browser. */
export const allowUrl = (req: AuthorizeRequest, code: string) => authorizeRedirect(req.redirectUri, MCP_ISSUER, { code, state: req.state });
/** Where Cancel, or choosing to go back after a request with a mistake in it, sends the browser. */
export const denyUrl = (redirectUri: string, state: string | null, error = "access_denied", description?: string) =>
  authorizeRedirect(redirectUri, MCP_ISSUER, { error, ...(description ? { error_description: description } : {}), state });

/* ---------- Settings ---------- */

const isMissing = (e: unknown) => {
  const msg = String((e as { message?: unknown })?.message ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  return code === "42883" || code === "PGRST202" || /could not find the function|does not exist/i.test(msg);
};

function parseApp(raw: unknown): ConnectedApp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const id = str(r.id);
  if (!id || (r.access !== "read" && r.access !== "write")) return null;
  return {
    id,
    name: str(r.client_name) ?? "Unnamed app",
    host: str(r.client_host),
    access: r.access,
    workspaceId: str(r.workspace_id),
    workspaceName: str(r.workspace_name),
    createdAt: str(r.created_at),
    lastUsedAt: str(r.last_used_at),
  };
}

/** Your connected AI apps. Throws McpNotReady until 0050 is live. */
export async function listConnectedApps(): Promise<ConnectedApp[]> {
  if (!supabase) return demoApps;
  const { data, error } = await supabase.rpc("mcp_oauth_list_grants");
  if (error) throw isMissing(error) ? new McpNotReady() : error;
  const list = typeof data === "string" ? JSON.parse(data) : data;
  return (Array.isArray(list) ? list : []).map(parseApp).filter((a): a is ConnectedApp => a !== null);
}

/** Disconnect one: it stops working on its next call. */
export async function revokeConnectedApp(id: string): Promise<void> {
  if (!supabase) { demoApps = demoApps.filter((a) => a.id !== id); return; }
  if (offline()) throw new TypeError("Failed to fetch");
  const { error } = await supabase.rpc("mcp_oauth_revoke_grant", { p_id: id });
  if (error && !/not found/i.test(String(error.message))) throw error;
}

/** Cursor's own one-click install link. */
export function cursorInstallLink(address = MCP_RESOURCE): string {
  const config = btoa(JSON.stringify({ url: address }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=kanbo&config=${encodeURIComponent(config)}`;
}
