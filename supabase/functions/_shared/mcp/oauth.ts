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
// suite attacks them; this file reads requests and shapes answers.
//
// What a stranger can do, with no credentials, is the thing these limits are about.
//   /oauth/token and /oauth/revoke have no limit before the check. Claude and ChatGPT
//   each use one public client_id for everyone, and all of Claude's traffic comes from
//   one address range, so any limit counted before the check would let one stranger
//   switch them off for every Kanbo user. Nothing is at risk without one: codes and
//   tokens are 256-bit, malformed ones never reach the database, and a well-formed
//   wrong one costs an indexed read or two and writes nothing. Use of a real refresh token
//   is limited per connection, in the SQL, after it has been checked.
//   /oauth/register stores something, so it's limited: see registerLimits.
//
// Pure module (everything injected): oauth.test.ts.
// ============================================================
import { checkDestination, type Resolver, type SendTarget } from "../api/webhookDispatch.ts";
import type { Tx } from "../api/types.ts";
import { clientIp, hashKey } from "../limits.ts";
import { MCP_RESOURCE } from "./metadata.ts";
import { checkCimdDocument, checkClientIdUrl, checkRegistration, isLoopbackUri, redirectHost } from "./oauthCore.ts";

/** One read of an app's description: its status, and its text (null: longer than the cap, or not a 200). */
export type GetDocument = (target: SendTarget, maxBytes: number, timeoutMs: number) => Promise<{ status: number; text: string | null }>;

export interface OAuthDeps {
  service: Tx;
  fetch: typeof fetch;
  /** every address a host resolves to; throws when it can't tell. Without one, no description is ever fetched. */
  resolve?: Resolver;
  /** reads a description from a checked address; by default fetch, which looks the name up again */
  getDocument?: GetDocument;
  /** Kanbo's own hosts, which are never fetched */
  ownHosts?: readonly string[];
  /** the signed-in person behind a Supabase session token, or null */
  verifyUser: (jwt: string) => Promise<string | null>;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

const LIMITS = {
  register: { callerMax: 120, peerMax: 600, allMax: 2000, window: 3600 },
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

/**
 * The limit keys for one registration. The only address a caller can't make up is the one Supabase's
 * own edge saw (limits.ts clientIp). Through www.kanbo.co.uk that's Vercel, shared by everyone, and
 * the person's address is in the headers Vercel overwrites, which a direct caller at <ref>.supabase.co
 * can set to anything. So a caller is counted twice: as the pair of the two, which a direct caller
 * can't use to spend anyone else's allowance, and as the edge's address alone, with a higher limit,
 * which stops one that changes the header each time. Only hashes are stored.
 * No address at all (limits.ts: "callers then skip the per-IP limit") leaves the overall cap.
 */
export async function registerLimits(h: Headers): Promise<{ key: string; max: number }[]> {
  const peer = clientIp(h);
  if (!peer) return [];
  const claimed = (h.get("x-vercel-forwarded-for") || h.get("x-forwarded-for") || "").split(",")[0].trim().slice(0, 64);
  return [
    { key: `kanbo:mcp:register:p:${await hashKey(peer)}`, max: LIMITS.register.peerMax },
    { key: `kanbo:mcp:register:c:${await hashKey(`${peer}|${claimed}`)}`, max: LIMITS.register.callerMax },
  ];
}

/** One hit against a limit. Fails open: a rate-limit error must not lock people out. */
export async function rateHit(service: Tx, key: string, windowSec: number, max: number): Promise<{ allowed: boolean; retryAfter: number }> {
  try {
    const rows = await service.query<{ allowed: boolean; retry_after: number }>(`select * from public.api_rate_hit($1, $2, $3)`, [key, windowSec, max]);
    const r = rows[0];
    return { allowed: r ? !!r.allowed : true, retryAfter: Number(r?.retry_after) || 0 };
  } catch {
    return { allowed: true, retryAfter: 0 };
  }
}

const hit = (deps: OAuthDeps, key: string, windowSec: number, max: number) => rateHit(deps.service, key, windowSec, max);

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
  // nothing is counted or written until the request is one that would be stored
  const text = await readBody(req, BODY_MAX);
  if (text === null) return oauthError("invalid_client_metadata", "That's too much to read.", 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return oauthError("invalid_client_metadata", "That isn't valid JSON."); }
  const c = checkRegistration(body);
  if (!c.ok) return oauthError(c.error, c.description);
  for (const limit of await registerLimits(req.headers)) {
    const r = await hit(deps, limit.key, LIMITS.register.window, limit.max);
    if (!r.allowed) return tooMany(r.retryAfter);
  }
  const all = await hit(deps, "kanbo:mcp:register:all", LIMITS.register.window, LIMITS.register.allMax);
  if (!all.allowed) return tooMany(all.retryAfter);
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

const CODE_SHAPE = /^kmcp_ac_[A-Za-z0-9_-]{43}$/;
const REFRESH_SHAPE = /^kmcp_rt_[A-Za-z0-9_-]{43}$/;
const TOKEN_SHAPE = /^kmcp_(at|rt)_[A-Za-z0-9_-]{43}$/;
const BAD_CODE = "This sign-in code isn't valid any more. Start connecting again.";
const BAD_REFRESH = "This connection has ended. Connect the app to Kanbo again.";

export async function handleToken(req: Request, deps: OAuthDeps): Promise<Response> {
  if (!isForm(req)) return oauthError("invalid_request", "Send this as application/x-www-form-urlencoded.");
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
  const resource = sp.get("resource");
  if (resource !== null && resource !== MCP_RESOURCE) return oauthError("invalid_target", `This server is ${MCP_RESOURCE}.`);
  try {
    let raw: unknown;
    if (grant === "authorization_code") {
      const code = sp.get("code"), verifier = sp.get("code_verifier"), redirect = sp.get("redirect_uri");
      if (!code || !verifier || !redirect) return oauthError("invalid_request", "code, code_verifier and redirect_uri are required.");
      if (!CODE_SHAPE.test(code)) return oauthError("invalid_grant", BAD_CODE);
      const rows = await deps.service.query<{ r: unknown }>(
        `select public.mcp_oauth_exchange_code($1, $2, $3, $4, $5) as r`, [code, verifier, clientId, redirect, resource]);
      raw = rows[0]?.r;
    } else {
      const token = sp.get("refresh_token");
      if (!token) return oauthError("invalid_request", "refresh_token is required.");
      if (!REFRESH_SHAPE.test(token)) return oauthError("invalid_grant", BAD_REFRESH);
      const rows = await deps.service.query<{ r: unknown }>(
        `select public.mcp_oauth_refresh($1, $2, $3) as r`, [token, clientId, resource]);
      raw = rows[0]?.r;
    }
    const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
    if (!r) return oauthError("server_error", UNAVAILABLE, 503);
    if (r.error === "slow_down") return tooMany(Number(r.retry_after) || 60);
    if (r.error) return reply(r, 400);
    return reply(r);
  } catch (e) {
    return serverTrouble(e, deps, "token");
  }
}

/* ------------------------------------------------------------ POST /oauth/revoke */

export async function handleRevoke(req: Request, deps: OAuthDeps): Promise<Response> {
  if (!isForm(req)) return oauthError("invalid_request", "Send this as application/x-www-form-urlencoded.");
  const text = await readBody(req, BODY_MAX);
  if (text === null) return oauthError("invalid_request", "That's too much to read.", 413);
  const sp = new URLSearchParams(text);
  const token = sp.get("token");
  if (!token) return oauthError("invalid_request", "token is required.");
  // RFC 7009: the same answer whether or not there was anything
  if (!TOKEN_SHAPE.test(token)) return reply({});
  try {
    await deps.service.query(`select public.mcp_oauth_revoke_token($1, $2)`, [token, sp.get("client_id")]);
    return reply({});
  } catch (e) {
    return serverTrouble(e, deps, "revoke");
  }
}

/* ------------------------------------------------------------ fetching a Client ID Metadata Document */

export type FetchedClient = { ok: true; name: string; clientUri: string | null; redirectUris: string[] } | { ok: false; reason: string };

/** One answer for every way a fetch can fail, so this can't be used to find out what's inside a network. */
export const CANT_READ_DESCRIPTION = "Kanbo couldn't read this app's description, so it can't connect it. Check the address with whoever made the app.";

/** A plain GET with no redirects followed. fetch looks the name up again, so index.ts uses a connection to the checked address instead. */
export function documentFetcher(fetchImpl: typeof fetch): GetDocument {
  return async (target, maxBytes, timeoutMs) => {
    const res = await fetchImpl(target.url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) {
      try { await res.body?.cancel(); } catch { /* gone */ }
      return { status: res.status, text: null };
    }
    return { status: 200, text: await readBody(res, maxBytes) };
  };
}

/**
 * Fetches and checks an app's document, with the same guard as Kanbo's webhooks (checkDestination):
 * https only, a name with a dot in it, never Kanbo's own hosts, and every address the name resolves to
 * must be public. If DNS can't answer, nothing is fetched. No redirects followed, nothing but a 200,
 * 5 KB at most, 5 seconds at most. Every failure after the address's own shape reads the same.
 */
export async function fetchClientDocument(clientId: string, deps: Pick<OAuthDeps, "fetch" | "resolve" | "getDocument" | "ownHosts" | "log">): Promise<FetchedClient> {
  const shape = checkClientIdUrl(clientId);
  if (!shape.ok) return shape;
  const fail = (why: string): FetchedClient => {
    deps.log?.("[mcp] an app's description wasn't usable", { host: shape.host, why });
    return { ok: false, reason: CANT_READ_DESCRIPTION };
  };
  if (!deps.resolve) return fail("no resolver");
  const dest = await checkDestination(clientId, deps.resolve, deps.ownHosts ?? []);
  if (!dest.ok) return fail(dest.error);
  const get = deps.getDocument ?? documentFetcher(deps.fetch);
  let answer: { status: number; text: string | null } | null = null;
  let error = "no address";
  for (const address of dest.addresses.slice(0, 2)) {
    try {
      answer = await get({ url: dest.url, host: dest.host, port: dest.port, path: dest.path, address }, CIMD_MAX_BYTES, CIMD_TIMEOUT_MS);
      break;
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 160);
      // only a connection that never happened moves on to the next address
      if ((e as { kind?: unknown })?.kind !== "connect") break;
    }
  }
  if (!answer) return fail(error);
  if (answer.status !== 200) return fail(`HTTP ${answer.status}`);
  if (answer.text === null) return fail("too long");
  let doc: unknown;
  try { doc = JSON.parse(answer.text); } catch { return fail("not JSON"); }
  const checked = checkCimdDocument(doc, clientId);
  return checked.ok ? checked : fail(checked.reason);
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
  // apps remember their client_id, so starting again from the app would only send the same one
  unknown_client: "Kanbo doesn't know this app. Remove Kanbo from the app and add it again.",
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
