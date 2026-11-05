/* lib/mcpOAuth in demo mode (the tests' default: no Supabase). */
import { beforeEach, describe, expect, it } from "vitest";
import {
  allowUrl, approveConnection, approveFailure, consentWorkspaces, cursorInstallLink, denyUrl, listConnectedApps, MCP_RESOURCE, prepareClient, resetDemoConnectedApps, revokeConnectedApp,
} from "./mcpOAuth";

const req = { clientId: "c", redirectUri: "https://claude.ai/cb", state: "st", codeChallenge: "a".repeat(43), resource: MCP_RESOURCE, scope: "", wantsWrite: true };
beforeEach(() => resetDemoConnectedApps());

describe("the way back", () => {
  it("Allow carries the code, the state and iss", () => {
    const u = new URL(allowUrl(req, "the-code"));
    expect(u.origin + u.pathname).toBe("https://claude.ai/cb");
    expect(u.searchParams.get("code")).toBe("the-code");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("iss")).toBe("https://www.kanbo.co.uk");
  });
  it("Cancel is access_denied, with state and iss", () => {
    const u = new URL(denyUrl("https://claude.ai/cb", "st"));
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("iss")).toBe("https://www.kanbo.co.uk");
    expect(new URL(denyUrl("https://claude.ai/cb", null, "invalid_target", "No")).searchParams.get("error_description")).toBe("No");
  });
});

describe("the demo", () => {
  it("prepares an example app, marks loopback", async () => {
    expect(await prepareClient("c", "https://claude.ai/cb")).toMatchObject({ ok: true, client: { name: "Claude", redirectHost: "claude.ai", loopback: false } });
    expect(await prepareClient("c", "http://localhost:8787/cb")).toMatchObject({ client: { loopback: true } });
  });
  it("offers example workspaces, and approves with a pretend code", async () => {
    expect((await consentWorkspaces()).length).toBeGreaterThan(0);
    expect(await approveConnection(req, "write", null)).toBe("demo-code");
  });
  it("lists and revokes example connections", async () => {
    const apps = await listConnectedApps();
    expect(apps.map((a) => a.name)).toEqual(["Claude", "Cursor"]);
    await revokeConnectedApp(apps[0].id);
    expect((await listConnectedApps()).map((a) => a.name)).toEqual(["Cursor"]);
  });
});

describe("approveFailure", () => {
  it.each([
    [{ code: "PGRST202", message: "Could not find the function" }, "not_ready"],
    [{ code: "42883", message: "x" }, "not_ready"],
    [{ message: "rate limited" }, "rate_limited"],
    [{ message: "not authorized" }, "not_allowed"],
    [{ message: "not allowed" }, "not_allowed"],
    [{ message: "invalid redirect" }, "bad_request"],
    [{ message: "invalid access" }, "bad_request"],
    [{ message: "Failed to fetch" }, "network"],
    [{ message: "who knows" }, "error"],
  ])("%j reads as %s", (e, kind) => {
    const f = approveFailure(e);
    expect(f.failure).toBe(kind);
    expect(f.message.length).toBeGreaterThan(5);
  });
});

describe("Cursor's install link", () => {
  it("is the documented deep link, with the address base64 encoded", () => {
    const link = cursorInstallLink();
    expect(link.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=kanbo&config=")).toBe(true);
    const config = decodeURIComponent(link.split("config=")[1]);
    expect(JSON.parse(atob(config))).toEqual({ url: "https://www.kanbo.co.uk/mcp" });
  });
});
