// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  authorizeRedirect, checkCimdDocument, checkClientIdUrl, checkRegistration, cleanClientName, CURSOR_CALLBACK, isAllowedRedirectUri, isLoopbackUri,
  isSpecialUseHost, parseAuthorizeRequest, redirectHost,
} from "./oauthCore.ts";
import { MCP_RESOURCE } from "./metadata.ts";

const CHALLENGE = "a".repeat(43);
const good = (o: Record<string, string> = {}) => new URLSearchParams({
  response_type: "code", client_id: "kmcp_client_abc", redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  code_challenge: CHALLENGE, code_challenge_method: "S256", state: "xyz", scope: "kanbo.read kanbo.write", resource: MCP_RESOURCE, ...o,
});

describe("redirect addresses", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/abc",
    "http://localhost:8787/callback", "http://127.0.0.1:53682/callback", "http://[::1]:3000/cb", "http://localhost/cb", "https://www.cursor.com/agents/mcp/oauth/callback",
    CURSOR_CALLBACK, "https://x.example/cb?a=1&b=2",
  ])("allows %s", (u) => expect(isAllowedRedirectUri(u)).toBe(true));

  it.each([
    "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:x", "http://evil.example/cb",
    "http://localhost.evil.example/", "http://127.0.0.1.evil.example/", "https://user:pw@x.example/", "https://claude.ai@evil.example/", "https://x.example/cb#frag",
    "https://x.example/ cb", "https://x.example\\y", "cursor://anysphere.cursor-mcp/oauth/callback/x", "cursor://anysphere.cursor-deeplink/x", "myapp://cb", "//x.example/", "https://x.example/cb\nSet-Cookie: x",
    "", "https://", "ftp://x.example/", "https:/x.example/",
  ])("refuses %j", (u) => expect(isAllowedRedirectUri(u)).toBe(false));

  it("refuses anything but a string, and very long ones", () => {
    expect(isAllowedRedirectUri(null)).toBe(false);
    expect(isAllowedRedirectUri(42)).toBe(false);
    expect(isAllowedRedirectUri(`https://x.example/${"a".repeat(2100)}`)).toBe(false);
  });

  it("knows loopback from the rest", () => {
    expect(isLoopbackUri("http://localhost:1/cb")).toBe(true);
    expect(isLoopbackUri("http://127.0.0.1/cb")).toBe(true);
    expect(isLoopbackUri("http://[::1]:9/")).toBe(true);
    expect(isLoopbackUri("https://localhost.example/")).toBe(false);
    expect(isLoopbackUri(CURSOR_CALLBACK)).toBe(false);
  });

  it("shows a host", () => {
    expect(redirectHost("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(redirectHost("http://localhost:8787/cb")).toBe("localhost");
    expect(redirectHost(CURSOR_CALLBACK)).toBe("anysphere.cursor-mcp");
  });
});

describe("app names are untrusted text", () => {
  it("loses control characters, direction overrides and invisible characters", () => {
    expect(cleanClientName("Claude‮evil\u0000  \n x")).toBe("Claude evil x");
    expect(cleanClientName("A​pp﻿")).toBe("A pp");
  });
  it("has a limit and a fallback", () => {
    expect(cleanClientName("x".repeat(500))).toHaveLength(120);
    expect(cleanClientName(null)).toBe("Unnamed app");
    expect(cleanClientName("   ")).toBe("Unnamed app");
  });
  it("keeps markup as plain text (React escapes it)", () => {
    expect(cleanClientName("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("client ids that are URLs", () => {
  it("accepts the documents real clients use", () => {
    expect(checkClientIdUrl("https://claude.ai/oauth/mcp-oauth-client-metadata")).toEqual({ ok: true, host: "claude.ai" });
    expect(checkClientIdUrl("https://chatgpt.com/oauth/client.json")).toEqual({ ok: true, host: "chatgpt.com" });
  });
  it.each([
    ["http", "http://x.example/c.json"], ["no path", "https://x.example/"], ["no path 2", "https://x.example"], ["userinfo", "https://u:p@x.example/c.json"],
    ["fragment", "https://x.example/c.json#a"], ["dots", "https://x.example/a/../c.json"], ["dot", "https://x.example/./c.json"], ["port", "https://x.example:8443/c.json"],
    ["not normal: upper-case host", "https://X.example/c.json"], ["loopback", "https://localhost/c.json"], ["private", "https://10.0.0.1/c.json"],
    ["metadata service", "https://169.254.169.254/latest"], ["link local v6", "https://[fe80::1]/c.json"], ["loopback v6", "https://[::1]/c.json"], ["mapped v6", "https://[::ffff:7f00:1]/c.json"],
    ["internal name", "https://intranet.internal/c.json"], ["decimal ip", "https://2130706433/c.json"], ["spaces", "https://x.example/a b"],
  ])("refuses %s", (_w, u) => expect(checkClientIdUrl(u).ok).toBe(false));
  it("refuses non-strings and long ones", () => {
    expect(checkClientIdUrl(1).ok).toBe(false);
    expect(checkClientIdUrl(`https://x.example/${"a".repeat(600)}`).ok).toBe(false);
  });
});

describe("special-use hosts", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "203.0.113.5", "::1", "[::1]", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "localhost", "foo.localhost", "x.local", "x.internal", "x.onion", ""])(
    "%s is", (h) => expect(isSpecialUseHost(h)).toBe(true));
  it.each(["claude.ai", "8.8.8.8", "172.32.0.1", "11.0.0.1", "2606:4700::1111", "chatgpt.com"])("%s isn't", (h) => expect(isSpecialUseHost(h)).toBe(false));
});

describe("metadata documents", () => {
  const id = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  it("reads a good one, keeping only addresses Kanbo will use", () => {
    const r = checkCimdDocument({ client_id: id, client_name: "Claude‮", redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "javascript:alert(1)"], client_uri: "https://claude.ai", token_endpoint_auth_method: "none" }, id);
    expect(r).toEqual({ ok: true, name: "Claude", clientUri: "https://claude.ai", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] });
  });
  it("copes with ChatGPT's document, which lists private_key_jwt as well as none", () => {
    const u = "https://chatgpt.com/oauth/client.json";
    const r = checkCimdDocument({ client_id: u, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods: ["none", "private_key_jwt"] }, u);
    expect(r.ok).toBe(true);
  });
  it.each([
    ["not an object", []], ["a different address", { client_id: "https://evil.example/c.json", client_name: "x", redirect_uris: ["https://x.example/"] }],
    ["no name", { client_id: id, redirect_uris: ["https://x.example/"] }], ["blank name", { client_id: id, client_name: " ", redirect_uris: ["https://x.example/"] }],
    ["no addresses", { client_id: id, client_name: "x" }], ["empty addresses", { client_id: id, client_name: "x", redirect_uris: [] }],
    ["only bad addresses", { client_id: id, client_name: "x", redirect_uris: ["javascript:alert(1)", "http://x.example/"] }],
  ])("refuses %s", (_w, doc) => expect(checkCimdDocument(doc, id).ok).toBe(false));
  // what these documents really said on 5 November 2026
  it.each([
    ["https://claude.ai/oauth/mcp-oauth-client-metadata", { client_name: "Claude", client_uri: "https://claude.ai", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], response_types: ["code"], token_endpoint_auth_method: "none" }],
    ["https://claude.ai/oauth/claude-code-client-metadata", { client_name: "Claude Code", client_uri: "https://claude.ai", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }],
    ["https://chatgpt.com/oauth/client.json", { client_uri: "https://chatgpt.com/", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "ChatGPT", logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png", token_endpoint_auth_signing_alg: "RS256", jwks_uri: "https://chatgpt.com/oauth/jwks.json" }],
  ])("accepts the real document at %s", (url, doc) => {
    expect(checkClientIdUrl(url).ok).toBe(true);
    const r = checkCimdDocument({ client_id: url, ...doc }, url);
    expect(r).toMatchObject({ ok: true, name: doc.client_name, redirectUris: doc.redirect_uris });
  });
  it("drops a client_uri that isn't https", () => {
    const r = checkCimdDocument({ client_id: id, client_name: "x", redirect_uris: ["https://x.example/"], client_uri: "javascript:alert(1)" }, id);
    expect(r).toMatchObject({ ok: true, clientUri: null });
  });
});

describe("dynamic client registration", () => {
  it("takes what real clients send, ignoring grant types it doesn't know", () => {
    const r = checkRegistration({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], token_endpoint_auth_method: "none", application_type: "web" });
    expect(r).toEqual({ ok: true, name: "Claude", clientUri: null, redirectUris: ["https://claude.ai/api/mcp/auth_callback"] });
  });
  it("names the problem, and de-duplicates", () => {
    expect(checkRegistration(null)).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(checkRegistration({})).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(checkRegistration({ redirect_uris: ["javascript:alert(1)"] })).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(checkRegistration({ redirect_uris: Array(21).fill("https://x.example/") })).toMatchObject({ ok: false });
    expect(checkRegistration({ redirect_uris: ["https://x.example/", "https://x.example/"] })).toMatchObject({ redirectUris: ["https://x.example/"], name: "Unnamed app" });
  });
});

describe("the authorisation request", () => {
  it("reads a good one", () => {
    const r = parseAuthorizeRequest(good());
    expect(r).toEqual({ kind: "ok", request: { clientId: "kmcp_client_abc", redirectUri: "https://claude.ai/api/mcp/auth_callback", state: "xyz", codeChallenge: CHALLENGE, resource: MCP_RESOURCE, scope: "kanbo.read kanbo.write", wantsWrite: true } });
  });
  it("binds a missing resource to the only one served", () => {
    const sp = good(); sp.delete("resource");
    expect(parseAuthorizeRequest(sp)).toMatchObject({ kind: "ok", request: { resource: MCP_RESOURCE } });
  });
  it("knows when an app only asked to read, and treats no scope as asking for both", () => {
    expect(parseAuthorizeRequest(good({ scope: "kanbo.read" }))).toMatchObject({ request: { wantsWrite: false } });
    expect(parseAuthorizeRequest(good({ scope: "" }))).toMatchObject({ request: { wantsWrite: true } });
    const sp = good(); sp.delete("scope");
    expect(parseAuthorizeRequest(sp)).toMatchObject({ request: { wantsWrite: true, scope: "" } });
  });
  it("stops with no redirect for a bad client or a bad address", () => {
    const noClient = good(); noClient.delete("client_id");
    expect(parseAuthorizeRequest(noClient)).toEqual({ kind: "fatal", reason: "missing_client" });
    const noRedirect = good(); noRedirect.delete("redirect_uri");
    expect(parseAuthorizeRequest(noRedirect)).toEqual({ kind: "fatal", reason: "bad_redirect" });
    expect(parseAuthorizeRequest(good({ redirect_uri: "javascript:alert(1)" }))).toEqual({ kind: "fatal", reason: "bad_redirect" });
    expect(parseAuthorizeRequest(good({ redirect_uri: "http://evil.example/" }))).toEqual({ kind: "fatal", reason: "bad_redirect" });
    const twice = good(); twice.append("redirect_uri", "https://evil.example/");
    expect(parseAuthorizeRequest(twice)).toEqual({ kind: "fatal", reason: "bad_redirect" });
  });
  it.each([
    ["response_type=token", { response_type: "token" }, "unsupported_response_type"],
    ["PKCE plain", { code_challenge_method: "plain" }, "invalid_request"],
    ["bad challenge", { code_challenge: "short" }, "invalid_request"],
    ["another server", { resource: "https://evil.example/mcp" }, "invalid_target"],
    ["bare domain as resource", { resource: "https://kanbo.co.uk/mcp" }, "invalid_target"],
  ])("sends other mistakes back to the app: %s", (_w, o, error) => {
    const r = parseAuthorizeRequest(good(o as Record<string, string>));
    expect(r).toMatchObject({ kind: "redirect_error", error, state: "xyz" });
  });
  it("needs PKCE", () => {
    const sp = good(); sp.delete("code_challenge_method");
    expect(parseAuthorizeRequest(sp)).toMatchObject({ kind: "redirect_error", error: "invalid_request" });
    const sp2 = good(); sp2.delete("code_challenge");
    expect(parseAuthorizeRequest(sp2)).toMatchObject({ kind: "redirect_error", error: "invalid_request" });
  });
  it("refuses two resources", () => {
    const sp = good(); sp.append("resource", MCP_RESOURCE);
    expect(parseAuthorizeRequest(sp)).toMatchObject({ kind: "redirect_error", error: "invalid_target" });
  });
});

describe("the way back", () => {
  it("always carries iss, and keeps what's on the address", () => {
    const u = new URL(authorizeRedirect("https://claude.ai/cb?x=1", "https://www.kanbo.co.uk", { code: "c", state: "s t" }));
    expect(u.searchParams.get("x")).toBe("1");
    expect(u.searchParams.get("code")).toBe("c");
    expect(u.searchParams.get("state")).toBe("s t");
    expect(u.searchParams.get("iss")).toBe("https://www.kanbo.co.uk");
  });
  it("leaves out what's missing, and works on Cursor's callback", () => {
    const u = authorizeRedirect(CURSOR_CALLBACK, "https://www.kanbo.co.uk", { error: "access_denied", state: null });
    expect(u).toMatch(/^cursor:\/\/anysphere\.cursor-mcp\/oauth\/callback\?/);
    expect(u).toContain("error=access_denied");
    expect(u).not.toContain("state");
    expect(u).toContain("iss=");
  });
});
