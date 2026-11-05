/* lib/mcpOAuth against a (mocked) real backend: the RPCs, /oauth/prepare and what each refusal reads as. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, from, getSession } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), getSession: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a), auth: { getSession: () => getSession() } },
  isSupabaseConfigured: true,
}));

import { approveConnection, consentWorkspaces, listConnectedApps, MCP_COPY, MCP_RESOURCE, McpNotReady, prepareClient, revokeConnectedApp } from "./mcpOAuth";

const req = { clientId: "c", redirectUri: "https://claude.ai/cb", state: "st", codeChallenge: "a".repeat(43), resource: MCP_RESOURCE, scope: "kanbo.read kanbo.write", wantsWrite: true };
const client = { name: "Claude", kind: "cimd", clientHost: "claude.ai", redirectHost: "claude.ai", loopback: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  rpc.mockReset(); from.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: "session-jwt" } } });
});

describe("prepareClient", () => {
  it("asks the function on this site, with the person's session", async () => {
    const f = vi.fn(async () => json({ ok: true, client }));
    expect(await prepareClient("c", "https://claude.ai/cb", f as unknown as typeof fetch)).toEqual({ ok: true, client });
    const [url, init] = (f.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("/oauth/prepare");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-jwt");
    expect(JSON.parse(String(init.body))).toEqual({ client_id: "c", redirect_uri: "https://claude.ai/cb" });
  });
  it("signed out", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    expect(await prepareClient("c", "https://x/")).toMatchObject({ ok: false, reason: "signed_out" });
    getSession.mockResolvedValue({ data: { session: { access_token: "x" } } });
    expect(await prepareClient("c", "https://x/", (async () => json({ ok: false, reason: "signed_out" }, 401)) as unknown as typeof fetch)).toMatchObject({ reason: "signed_out" });
  });
  it("the function isn't there yet: a 404 or its own word for it", async () => {
    expect(await prepareClient("c", "https://x/", (async () => json({ error: "x" }, 404)) as unknown as typeof fetch)).toMatchObject({ reason: "not_ready" });
    expect(await prepareClient("c", "https://x/", (async () => new Response("<!doctype html>", { status: 404 })) as unknown as typeof fetch)).toMatchObject({ reason: "not_ready" });
    expect(await prepareClient("c", "https://x/", (async () => json({ ok: false, reason: "not_ready" }, 503)) as unknown as typeof fetch)).toMatchObject({ reason: "not_ready" });
  });
  it.each([
    ["a gateway's HTML 502", () => new Response("<!doctype html><title>Bad gateway</title>", { status: 502, headers: { "Content-Type": "text/html" } })],
    ["a gateway's HTML 504", () => new Response("<html>Gateway time-out</html>", { status: 504 })],
    ["an HTML 429", () => new Response("<html>Slow down</html>", { status: 429 })],
    ["an HTML 403", () => new Response("<html>Blocked</html>", { status: 403 })],
    ["an HTML page with a 200", () => new Response("<!doctype html>", { status: 200 })],
    ["an empty 500", () => new Response("", { status: 500 })],
    ["a gateway's own JSON", () => json({ code: "BOOT_ERROR", message: "Function failed to start (please check logs)" }, 503)],
    ["JSON that isn't an answer", () => json(null)],
  ])("%s is a moment's trouble with Try again, not \"not switched on\"", async (_, answer) => {
    const r = await prepareClient("c", "https://x/", (async () => answer()) as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "unavailable", message: MCP_COPY.checkFailed });
  });
  it("a refusal keeps its words; a failure can be tried again", async () => {
    expect(await prepareClient("c", "https://x/", (async () => json({ ok: false, reason: "bad_redirect", message: "Not that address." })) as unknown as typeof fetch)).toEqual({ ok: false, reason: "refused", message: "Not that address." });
    expect(await prepareClient("c", "https://x/", (async () => json({ ok: false, reason: "unavailable", message: "Later." }, 503)) as unknown as typeof fetch)).toMatchObject({ reason: "unavailable", message: "Later." });
    expect(await prepareClient("c", "https://x/", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toMatchObject({ reason: "unavailable" });
  });
});

describe("approveConnection", () => {
  it("calls the RPC with everything, and returns the code", async () => {
    rpc.mockResolvedValue({ data: { code: "the-code", expires_in: 300 }, error: null });
    expect(await approveConnection(req, "read", "ws-1")).toBe("the-code");
    expect(rpc).toHaveBeenCalledWith("mcp_oauth_approve", { p_client_id: "c", p_redirect_uri: "https://claude.ai/cb", p_code_challenge: "a".repeat(43), p_resource: MCP_RESOURCE, p_scope: "kanbo.read kanbo.write", p_access: "read", p_workspace: "ws-1" });
  });
  it("a refusal reads plainly", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "rate limited" } });
    await expect(approveConnection(req, "write", null)).rejects.toMatchObject({ failure: "rate_limited" });
    rpc.mockResolvedValue({ data: {}, error: null });
    await expect(approveConnection(req, "write", null)).rejects.toMatchObject({ failure: "error" });
  });
});

describe("workspaces at consent", () => {
  it("reads your own, and copes without", async () => {
    const order = vi.fn(async () => ({ data: [{ id: "w", name: "Foundry" }], error: null }));
    from.mockReturnValue({ select: () => ({ order }) });
    expect(await consentWorkspaces()).toEqual([{ id: "w", name: "Foundry" }]);
    expect(from).toHaveBeenCalledWith("workspaces");
    from.mockReturnValue({ select: () => ({ order: async () => ({ data: null, error: { message: "x" } }) }) });
    expect(await consentWorkspaces()).toEqual([]);
  });
});

describe("Settings", () => {
  it("lists connections, dropping malformed rows", async () => {
    rpc.mockResolvedValue({ data: [
      { id: "g", client_name: "Claude", client_kind: "cimd", client_host: "claude.ai", access: "write", workspace_id: null, workspace_name: null, created_at: "2026-11-01T00:00:00Z", last_used_at: null },
      { id: "bad", access: "nope" },
    ], error: null });
    expect(await listConnectedApps()).toEqual([{ id: "g", name: "Claude", host: "claude.ai", access: "write", workspaceId: null, workspaceName: null, createdAt: "2026-11-01T00:00:00Z", lastUsedAt: null }]);
    expect(rpc).toHaveBeenCalledWith("mcp_oauth_list_grants");
  });
  it("before 0050: McpNotReady, nothing worse", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.mcp_oauth_list_grants" } });
    await expect(listConnectedApps()).rejects.toBeInstanceOf(McpNotReady);
    rpc.mockResolvedValue({ data: null, error: { code: "500", message: "other" } });
    await expect(listConnectedApps()).rejects.not.toBeInstanceOf(McpNotReady);
  });
  it("revoke: gone already is fine; anything else is an error", async () => {
    rpc.mockResolvedValue({ data: { id: "g" }, error: null });
    await revokeConnectedApp("g");
    expect(rpc).toHaveBeenCalledWith("mcp_oauth_revoke_grant", { p_id: "g" });
    rpc.mockResolvedValue({ data: null, error: { message: "not found" } });
    await revokeConnectedApp("g");
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(revokeConnectedApp("g")).rejects.toBeTruthy();
  });
});
