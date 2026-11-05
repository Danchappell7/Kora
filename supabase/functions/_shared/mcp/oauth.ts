// ============================================================
// KANBO — MCP OAuth: register, token, revoke and the consent page's "prepare".
//
//   POST /oauth/register   Dynamic Client Registration (RFC 7591): no secret, ever
//   POST /oauth/token      authorization_code + PKCE S256, refresh_token (rotating)
//   POST /oauth/revoke     RFC 7009: either kind of token ends the connection
//   POST /oauth/prepare    for the consent page: fetches a Client ID Metadata
//                          Document (the browser can't, and an RPC can't), then
//                          says whether this app and this address belong together
//
// The rules are in Postgres (0050), where they're atomic and where the PGlite
// suite attacks them; this file reads requests and shapes answers. Per-IP limits
// are generous on purpose: all of Claude's traffic comes from one address range.
//
// Pure module (everything injected): oauth.test.ts.
// ============================================================
import { sha256Hex } from "../api/auth.ts";
import type { Tx } from "../api/types.ts";
import { MCP_RESOURCE } from "./metadata.ts";
import { checkCimdDocument, checkClientIdUrl, checkRegistration, isLoopbackUri, isSpecialUseHost, redirectHost } from "./oauthCore.ts";

export interface OAuthDeps {
  service: Tx;
  fetch: typeof fetch;
  /** every address a host name resolves to, or null when that can't be checked here */
  resolveHost?: (host: string) => Promise<string[] | null>;
  /** the signed-in person behind a Supabase session token, or null */
  verifyUser: (jwt: string) => Promise<string | null>;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

const LIMITS = {
  register: { ipMax: 120, ipWindow: 3600, allMax: 2000, allWindow: 3600 },
  token: { ipMax: 1200, ipWindow: 60, clientMax: 300, clientWindow: 60 },
  revoke: { ipMax: 300, ipWindow: 60 },
  prepare: { userMax: 30, userWindow: 60 },
} as const;
const CIMD_FRESH_MS = 60 * 60_000;
const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_TIMEOUT_MS = 5_000;
const BODY_MAX = 16 * 1024;

export const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

export const oauthError = (error: string, description: string, status = 400, extra: Record<string, string> = {}) =>
  reply({ error, error_description: description }, status, extra);

const UNAVAILABLE = "Kanbo can't reach its database right now. Try again in a moment.";
const NOT_READY = "Connecting AI apps isn't switched on for Kanbo yet.";

/** Postgres says the 0050 functions aren't there yet. */
const isMissingFn = (e: unknown) => {
  const code = String((e as { code?: unknown })?.code ?? "");
  const msg = String((e as { message?: unknown })?.message ?? "");
  return code === "42883" || /function .* does not exist/i.test(msg);
};

function serverTrouble(e: unknown, deps: OAuthDeps, where: string): Response {
  if (isMissingFn(e)) return oauthError("temporarily_unavailable", NOT_READY, 503, { "Retry-After": "300" });
  deps.log?.(`[mcp] ${where} failed`, { message: String((e as Error)?.message ?? e).slice(0, 300) });
  return oauthError("server_error", UNAVAILABLE, 503, { "Retry-After": "5" });
}

/** The caller's address, from the proxy's headers. Only ever a rate limit's key. */
export function clientIp(h: Headers): string {
  const raw = h.get("x-vercel-forwarded-for") || h.get("x-forwarded-for") || h.get("x-real-ip") || "";
  return raw.split(",")[0].trim().slice(0, 64) || "unknown";
}

/** One hit against a limit. Fails open: a rate-limit error must not lock people out. */
async function hit(deps: OAuthDeps, key: string, windowSec: number, max: number): Promise<{ allowed: boolean; retryAfter: number }> {
  try {
    const rows = await deps.service.query<{ allowed: boolean; retry_after: number }>(`select * from public.api_rate_hit($1, $2, $3)`, [key, windowSec, max]);
    const r = rows[0];
    return { allowed: r ? !!r.allowed : true, retryAfter: Number(r?.retry_after) || 0 };
  } catch {
    return { allowed: true, retryAfter: 0 };
  }
}

const tooMany = (retryAfter: number) =>
  oauthError("slow_down", "Too many requests. Try again in a moment.", 429, { "Retry-After": String(Math.max(1, retryAfter)) });

/** A body as text, or null once it passes `cap` bytes. */
export async function readBody(req: Pick<Request, "headers" | "body">, cap: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > cap) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { try { await reader.cancel(); } catch { /* gone */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

const isJson = (req: Request) => /^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test((req.headers.get("content-type") ?? "").trim());
const isForm = (req: Request) => /^application\/x-www-form-urlencoded\s*(;|$)/i.test((req.headers.get("content-type") ?? "").trim());

/* ------------------------------------------------------------ POST /oauth/register */

export async function handleRegister(req: Request, deps: OAuthDeps): Promise<Response> {
  if (!isJson(req)) return oauthError("invalid_client_metadata", "Send the app's details as application/json.");
  const ip = await hit(deps, `kanbo:mcp:register:${clientIp(req.headers)}`, LIMITS.register.ipWindow, LIMITS.register.ipMax);
  if (!ip.allowed) return tooMany(ip.retryAfter);
  const all = await hit(deps, "kanbo:mcp:register:all", LIMITS.register.allWindow, LIMITS.register.allMax);
  if (!all.allowed) return tooMany(all.retryAfter);
  const text = await readBody(req, BODY_MAX);
  if (text === null) return oauthError("invalid_client_metadata", "That's too much to read.", 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return oauthError("invalid_client_metadata", "That isn't valid JSON."); }
  const c = checkRegistration(body);
  if (!c.ok) return oauthError(c.error, c.description);
  try {
    const rows = await deps.service.query<{ r: Record<string, unknown> | string }>(
      `select public.mcp_oauth_register_client($1, $2, array(select jsonb_array_elements_text($3::jsonb))) as r`, [c.name, c.clientUri, JSON.stringify(c.redirectUris)]);
    const raw = rows[0]?.r;
    const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
    if (!r || r.error) return oauthError("invalid_redirect_uri", "A redirect address must be https, or http on localhost, with no fragment.");
    return reply({
      client_id: r.client_id,
      client_id_issued_at: r.client_id_issued_at,
      client_name: r.client_name,
      redirect_uris: r.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  } catch (e) {
    return serverTrouble(e, deps, "register");
  }
}

/* ------------------------------------------------------------ POST /oauth/token */

/** A form parameter sent once (a repeated one is an error, per RFC 6749); null when absent. */
function formOne(sp: URLSearchParams, k: string): { value: string | null; repeated: boolean } {
  const all = sp.getAll(k);
  return { value: all.length ? all[0] : null, repeated: all.length > 1 };
}

export async function handleToken(req: Request, deps: OAuthDeps): Promise<Response> {
  if (!isForm(req)) return oauthError("invalid_request", "Send this as application/x-www-form-urlencoded.");
  const ip = await hit(deps, `kanbo:mcp:token:${clientIp(req.headers)}`, LIMITS.token.ipWindow, LIMITS.token.ipMax);
  if (!ip.allowed) return tooMany(ip.retryAfter);
  const text = await readBody(req, BODY_MAX);
  if (text === null) return oauthError("invalid_request", "That's too much to read.", 413);
  const sp = new URLSearchParams(text);
  for (const k of ["grant_type", "code", "code_verifier", "client_id", "redirect_uri", "refresh_token", "resource"]) {
    if (formOne(sp, k).repeated) return oauthError(k === "resource" ? "invalid_target" : "invalid_request", `Send ${k} once.`);
  }
  const grant = sp.get("grant_type");
  const clientId = sp.get("client_id");
  if (grant !== "authorization_code" && grant !== "refresh_token") return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  if (!clientId) return oauthError("invalid_request", "client_id is required.");
  // the app's own limit: a hash, so a long client_id can't overflow the key
  const perClient = await hit(deps, `kanbo:mcp:token:c:${(await sha256Hex(clientId)).slice(0, 32)}`, LIMITS.token.clientWindow, LIMITS.token.clientMax);
  if (!perClient.allowed) return tooMany(perClient.retryAfter);
  const resource = sp.get("resource");
  if (resource !== null && resource !== MCP_RESOURCE) return oauthError("invalid_target", `This server is ${MCP_RESOURCE}.`);
  try {
    let raw: unknown;
    if (grant === "authorization_code") {
      const code = sp.get("code"), verifier = sp.get("code_verifier"), redirect = sp.get("redirect_uri");
      if (!code || !verifier || !redirect) return oauthError("invalid_request", "code, code_verifier and redirect_uri are required.");
      const rows = await deps.service.query<{ r: unknown }>(
        `select public.mcp_oauth_exchange_code($1, $2, $3, $4, $5) as r`, [code, verifier, clientId, redirect, resource]);
      raw = rows[0]?.r;
    } else {
      const token = sp.get("refresh_token");
      if (!token) return oauthError("invalid_request", "refresh_token is required.");
      const rows = await deps.service.query<{ r: unknown }>(
        `select public.mcp_oauth_refresh($1, $2, $3) as r`, [token, clientId, resource]);
      raw = rows[0]?.r;
    }
    const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
    if (!r) return oauthError("server_error", UNAVAILABLE, 503);
    if (r.error) return reply(r, 400);
    return reply(r);
  } catch (e) {
    return serverTrouble(e, deps, "token");
  }
}

/* ------------------------------------------------------------ POST /oauth/revoke */

export async function handleRevoke(req: Request, deps: OAuthDeps): Promise<Response> {
  if (!isForm(req)) return oauthError("invalid_request", "Send this as application/x-www-form-urlencoded.");
  const ip = await hit(deps, `kanbo:mcp:revoke:${clientIp(req.headers)}`, LIMITS.revoke.ipWindow, LIMITS.revoke.ipMax);
  if (!ip.allowed) return tooMany(ip.retryAfter);
  const text = await readBody(req, BODY_MAX);
  if (text === null) return oauthError("invalid_request", "That's too much to read.", 413);
  const sp = new URLSearchParams(text);
  const token = sp.get("token");
  if (!token) return oauthError("invalid_request", "token is required.");
  try {
    await deps.service.query(`select public.mcp_oauth_revoke_token($1, $2)`, [token, sp.get("client_id")]);
    return reply({});
  } catch (e) {
    return serverTrouble(e, deps, "revoke");
  }
}

/* ------------------------------------------------------------ fetching a Client ID Metadata Document */

export type FetchedClient = { ok: true; name: string; clientUri: string | null; redirectUris: string[] } | { ok: false; reason: string };

/**
 * Fetches and checks an app's document. https only, no redirects followed, nothing but a 200, 5 KB at
 * most, 5 seconds at most, never a private address (checked again against what the name resolves to).
 */
export async function fetchClientDocument(clientId: string, deps: Pick<OAuthDeps, "fetch" | "resolveHost">): Promise<FetchedClient> {
  const shape = checkClientIdUrl(clientId);
  if (!shape.ok) return shape;
  const addresses = deps.resolveHost ? await deps.resolveHost(shape.host).catch(() => null) : null;
  if (addresses && addresses.some(isSpecialUseHost)) return { ok: false, reason: "That app's address points somewhere private." };
  let res: Response;
  try {
    res = await deps.fetch(clientId, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "Kanbo couldn't reach that app's description." };
  }
  if (res.status !== 200) {
    try { await res.body?.cancel(); } catch { /* gone */ }
    return { ok: false, reason: "That app's description couldn't be read." };
  }
  const text = await readBody(res, CIMD_MAX_BYTES).catch(() => null);
  if (text === null) return { ok: false, reason: "That app's description is too long." };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: "That app's description isn't valid JSON." }; }
  return checkCimdDocument(doc, clientId);
}

/* ------------------------------------------------------------ POST /oauth/prepare */

export interface PreparedClient {
  name: string;
  kind: "dcr" | "cimd";
  /** the host of the app's own address (only for an app with one), which Kanbo fetched */
  clientHost: string | null;
  /** the host the browser goes back to */
  redirectHost: string;
  /** it goes back to this computer: only allow it if you just started it */
  loopback: boolean;
}

const REFUSE = {
  unknown_client: "Kanbo doesn't know this app. Start connecting again from the app.",
  bad_redirect: "This app asked to send you back to an address it hasn't registered, so Kanbo stopped here.",
};

/** Says whether this client and this address belong together. A "no" here means the page shows an error and never redirects. */
export async function handlePrepare(req: Request, deps: OAuthDeps): Promise<Response> {
  const jwt = /^\s*bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const user = jwt ? await deps.verifyUser(jwt).catch(() => null) : null;
  if (!user) return reply({ ok: false, reason: "signed_out", message: "Sign in to Kanbo first." }, 401);
  const limit = await hit(deps, `kanbo:mcp:prepare:${user}`, LIMITS.prepare.userWindow, LIMITS.prepare.userMax);
  if (!limit.allowed) return reply({ ok: false, reason: "rate_limited", message: "Too many tries. Wait a minute and try again." }, 429, { "Retry-After": String(Math.max(1, limit.retryAfter)) });
  if (!isJson(req)) return reply({ ok: false, reason: "bad_request", message: "Send JSON." }, 400);
  const text = await readBody(req, BODY_MAX);
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text ?? "") as Record<string, unknown>; } catch { return reply({ ok: false, reason: "bad_request", message: "Send JSON." }, 400); }
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
  if (!clientId || !redirectUri) return reply({ ok: false, reason: "bad_request", message: "This link from the app is incomplete." }, 400);
  try {
    const check = async () => {
      const rows = await deps.service.query<{ r: unknown }>(`select public.mcp_oauth_client_check($1, $2) as r`, [clientId, redirectUri]);
      const raw = rows[0]?.r;
      return ((typeof raw === "string" ? JSON.parse(raw) : raw) ?? {}) as { ok?: boolean; reason?: keyof typeof REFUSE; kind?: "dcr" | "cimd"; client_name?: string; fetched_at?: string | null };
    };
    let c = await check();
    if (clientId.startsWith("https://")) {
      const age = c.fetched_at ? Date.now() - Date.parse(c.fetched_at) : Infinity;
      // a stale description, an unknown one, or an address it didn't list last time: read it again
      if (!(c.ok && age < CIMD_FRESH_MS)) {
        const fetched = await fetchClientDocument(clientId, deps);
        if (!fetched.ok) return reply({ ok: false, reason: "bad_client", message: fetched.reason });
        await deps.service.query(`select public.mcp_oauth_upsert_cimd_client($1, $2, $3, array(select jsonb_array_elements_text($4::jsonb)))`, [clientId, fetched.name, fetched.clientUri, JSON.stringify(fetched.redirectUris)]);
        c = await check();
      }
    }
    if (!c.ok) return reply({ ok: false, reason: c.reason ?? "unknown_client", message: REFUSE[c.reason ?? "unknown_client"] ?? REFUSE.unknown_client });
    const client: PreparedClient = {
      name: c.client_name ?? "Unnamed app",
      kind: c.kind ?? "dcr",
      clientHost: c.kind === "cimd" ? redirectHost(clientId) : null,
      redirectHost: redirectHost(redirectUri),
      loopback: isLoopbackUri(redirectUri),
    };
    return reply({ ok: true, client });
  } catch (e) {
    if (isMissingFn(e)) return reply({ ok: false, reason: "not_ready", message: NOT_READY }, 503);
    deps.log?.("[mcp] prepare failed", { message: String((e as Error)?.message ?? e).slice(0, 300) });
    return reply({ ok: false, reason: "unavailable", message: UNAVAILABLE }, 503, { "Retry-After": "5" });
  }
}
