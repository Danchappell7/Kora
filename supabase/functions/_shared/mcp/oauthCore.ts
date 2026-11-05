// ============================================================
// KANBO — MCP OAuth: the rules, with no I/O.
//
// Shared by the mcp edge function and the consent page (src/lib/mcpOAuth.ts),
// so both read a request the same way. What's stored and what's granted is
// decided in Postgres (0050): the SQL function mcp_oauth_redirect_allowed is the
// last word on a redirect address, and the PGlite suite checks it agrees with
// isAllowedRedirectUri below.
//
// Everything an app says about itself is untrusted: its name is cleaned here
// and labelled as self-supplied on the consent page.
//
// Pure module: oauthCore.test.ts.
// ============================================================
import { MCP_RESOURCE, SCOPE_WRITE } from "./metadata.ts";

/** The one private-use callback a real client needs (some Cursor builds). */
export const CURSOR_CALLBACK = "cursor://anysphere.cursor-mcp/oauth/callback";

const HTTPS_RE = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s#\\]*)?(\?[^\s#\\]*)?$/;
const LOOPBACK_HTTP_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(\/[^\s#\\]*)?(\?[^\s#\\]*)?$/;
const LOOPBACK_ANY_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(\/|\?|$)/;
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

/** https, loopback http or the Cursor callback. Never javascript:, data:, file:, vbscript:, a fragment or userinfo. */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || !uri || uri.length > 2048 || CONTROL_RE.test(uri)) return false;
  return uri === CURSOR_CALLBACK || HTTPS_RE.test(uri) || LOOPBACK_HTTP_RE.test(uri);
}

export const isLoopbackUri = (uri: string): boolean => LOOPBACK_ANY_RE.test(uri);

/** What the consent page says the browser goes back to. */
export function redirectHost(uri: string): string {
  try { return new URL(uri).hostname || uri; } catch { return uri; }
}

/** Control characters, direction overrides and invisible characters out; one line; 120 characters at most. */
export function cleanClientName(raw: unknown): string {
  if (typeof raw !== "string") return "Unnamed app";
  const s = raw
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? Array.from(s).slice(0, 120).join("") : "Unnamed app";
}

/* ------------------------------------------------------------ Client ID Metadata Documents */

/** An address that must never be fetched: loopback, private and other special-use ranges, or names that only mean something inside a network. */
export function isSpecialUseHost(hostRaw: string): boolean {
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")
    || host.endsWith(".intranet") || host.endsWith(".lan") || host.endsWith(".home") || host.endsWith(".corp")
    || host.endsWith(".onion") || host.endsWith(".test") || host.endsWith(".invalid") || host.endsWith(".example")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c] = v4.slice(1, 4).map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  // an all-numeric or hex host is an IPv4 address in disguise (2130706433, 0x7f.1)
  if (/^[0-9.]+$/.test(host) || /^0x/.test(host)) return true;
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    if (/^(fc|fd|fe[89ab]|ff)/.test(host)) return true;       // unique local, link local, multicast
    if (/^(2001:db8|2001:0db8|64:ff9b|100:)/.test(host)) return true;
    const mapped = /^::(?:ffff:)?(.+)$/.exec(host);          // ::ffff:10.0.0.1
    if (mapped) return mapped[1].includes(".") ? isSpecialUseHost(mapped[1]) : true;
    return false;
  }
  return false;
}

export type ClientIdCheck = { ok: true; host: string } | { ok: false; reason: string };

/** The draft's rules for a client_id that is a URL: compared as a plain string, never normalised. */
export function checkClientIdUrl(s: unknown): ClientIdCheck {
  if (typeof s !== "string" || s.length > 512 || CONTROL_RE.test(s) || /\s/.test(s)) return { ok: false, reason: "That app's address isn't valid." };
  if (!s.startsWith("https://")) return { ok: false, reason: "An app's address has to use https." };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, reason: "That app's address isn't valid." }; }
  if (u.href !== s) return { ok: false, reason: "That app's address isn't in its plain form." };
  if (u.username || u.password) return { ok: false, reason: "That app's address has a user name in it." };
  if (s.includes("#")) return { ok: false, reason: "That app's address has a fragment in it." };
  if (u.pathname === "/" || !u.pathname) return { ok: false, reason: "That app's address has no path." };
  if (u.port && u.port !== "443") return { ok: false, reason: "That app's address uses an unusual port." };
  // raw segments: URL has already resolved dots, so a difference from the raw string would have failed above too
  if (/(^|\/)\.\.?(\/|$)/.test(s.slice(8))) return { ok: false, reason: "That app's address has dots in its path." };
  if (isSpecialUseHost(u.hostname)) return { ok: false, reason: "That app's address points somewhere private." };
  return { ok: true, host: u.hostname };
}

export type CimdCheck =
  | { ok: true; name: string; clientUri: string | null; redirectUris: string[] }
  | { ok: false; reason: string };

/** A fetched metadata document, for this client_id. Addresses Kanbo won't use are dropped; with none left it's refused. */
export function checkCimdDocument(doc: unknown, clientId: string): CimdCheck {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, reason: "That app's description isn't a JSON object." };
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) return { ok: false, reason: "That app's description is for a different address." };
  if (typeof d.client_name !== "string" || !d.client_name.trim()) return { ok: false, reason: "That app's description has no name." };
  if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.length) return { ok: false, reason: "That app's description lists nowhere to send you back to." };
  const redirectUris = [...new Set(d.redirect_uris.filter(isAllowedRedirectUri))].slice(0, 20);
  if (!redirectUris.length) return { ok: false, reason: "That app's description lists no address Kanbo can send you back to." };
  const uri = typeof d.client_uri === "string" && /^https:\/\//.test(d.client_uri) && d.client_uri.length <= 2048 ? d.client_uri : null;
  return { ok: true, name: cleanClientName(d.client_name), clientUri: uri, redirectUris };
}

/* ------------------------------------------------------------ Dynamic Client Registration */

export type RegistrationCheck =
  | { ok: true; name: string; clientUri: string | null; redirectUris: string[] }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

/** RFC 7591. Grant types and methods the app lists are ignored: it always gets authorization_code + refresh_token and no secret. */
export function checkRegistration(body: unknown): RegistrationCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_client_metadata", description: "Send the app's details as a JSON object." };
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length) return { ok: false, error: "invalid_redirect_uri", description: "Say where to send people back to: redirect_uris." };
  if (uris.length > 20) return { ok: false, error: "invalid_redirect_uri", description: "List at most 20 redirect_uris." };
  for (const u of uris) {
    if (!isAllowedRedirectUri(u)) {
      return { ok: false, error: "invalid_redirect_uri", description: "A redirect address must be https, or http on localhost, with no fragment." };
    }
  }
  const clientUri = typeof b.client_uri === "string" && /^https:\/\//.test(b.client_uri) && b.client_uri.length <= 2048 ? b.client_uri : null;
  return { ok: true, name: cleanClientName(b.client_name), clientUri, redirectUris: [...new Set(uris as string[])] };
}

/* ------------------------------------------------------------ the authorisation request */

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  /** the scope string as asked for, or "" */
  scope: string;
  /** did the app ask for (or not limit itself from) changing things? */
  wantsWrite: boolean;
}

export type AuthorizeParse =
  /** no client or no usable redirect address: show an error here, never redirect */
  | { kind: "fatal"; reason: "missing_client" | "bad_redirect" }
  /** something else is wrong: once the address is checked against the app, send the error back to it */
  | { kind: "redirect_error"; clientId: string; redirectUri: string; state: string | null; error: "unsupported_response_type" | "invalid_request" | "invalid_target"; description: string }
  | { kind: "ok"; request: AuthorizeRequest };

/** Reads /oauth/authorize's query string. */
export function parseAuthorizeRequest(sp: URLSearchParams): AuthorizeParse {
  const one = (k: string): string | null => {
    const all = sp.getAll(k);
    return all.length === 1 ? all[0] : null;
  };
  const clientId = one("client_id");
  const redirectUri = one("redirect_uri");
  if (!clientId || clientId.length > 512) return { kind: "fatal", reason: "missing_client" };
  if (!redirectUri || !isAllowedRedirectUri(redirectUri)) return { kind: "fatal", reason: "bad_redirect" };
  const stateRaw = one("state");
  const state = stateRaw && stateRaw.length <= 2048 ? stateRaw : null;
  const fail = (error: "unsupported_response_type" | "invalid_request" | "invalid_target", description: string): AuthorizeParse =>
    ({ kind: "redirect_error", clientId, redirectUri, state, error, description });
  if (one("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (sp.getAll("state").length > 1) return fail("invalid_request", "Send state once.");
  const challenge = one("code_challenge");
  if (one("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "code_challenge isn't valid.");
  // a missing resource is bound to the only one served; a different one is refused
  const resources = sp.getAll("resource");
  if (resources.length > 1 || (resources.length === 1 && resources[0] !== MCP_RESOURCE)) return fail("invalid_target", `This server is ${MCP_RESOURCE}.`);
  const scope = (one("scope") ?? "").trim().slice(0, 500);
  const wanted = scope ? scope.split(/\s+/) : [];
  return {
    kind: "ok",
    request: { clientId, redirectUri, state, codeChallenge: challenge, resource: MCP_RESOURCE, scope, wantsWrite: !wanted.length || wanted.includes(SCOPE_WRITE) },
  };
}

/** Where the browser goes next: redirect_uri plus these parameters (always with iss, RFC 9207). */
export function authorizeRedirect(redirectUri: string, issuer: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  u.searchParams.set("iss", issuer);
  return u.href;
}
