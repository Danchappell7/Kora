/* lib/apiKeys in demo mode (no Supabase): realistic example keys that
   create / list / revoke work against, with the server's own rules. */
import { beforeEach, describe, expect, it } from "vitest";
import { API_KEY_COPY, API_KEY_RE, apiKeyMessage, createApiKey, listApiKeys, resetDemoApiKeys, revokeApiKey } from "./apiKeys";

const WS = "11111111-2222-4333-8444-555555555555";
const DAY = 86_400_000;

beforeEach(() => resetDemoApiKeys());

describe("demo keys", () => {
  it("lists realistic examples, newest first", async () => {
    const keys = await listApiKeys();
    expect(keys.map((k) => k.name)).toEqual(["Zapier", "Reporting script", "Old CI token"]);
    expect(keys.find((k) => k.name === "Zapier")).toMatchObject({ prefix: "kanbo_pk_8fQz", access: "read", status: "active", workspaceId: null });
    expect(keys.find((k) => k.name === "Old CI token")).toMatchObject({ status: "revoked", canRevoke: false });
    expect(JSON.stringify(keys)).not.toMatch(/"key"/);
  });
  it("a workspace's team keys (an owner/admin's view) include a teammate's", async () => {
    const team = await listApiKeys(WS);
    expect(team).toHaveLength(1);
    expect(team[0]).toMatchObject({ workspaceId: WS, createdByName: "Priya Shah", canRevoke: true });
    expect((await listApiKeys()).some((k) => k.workspaceId === WS)).toBe(false);
  });
  it("makes a key: the full key once, only its prefix in the list", async () => {
    const made = await createApiKey({ name: "  CI deploys ", workspaceId: null, access: "write", expiresAt: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(made.key).toMatch(API_KEY_RE);
    expect(made.key.startsWith("kanbo_sk_")).toBe(true);
    expect(made.prefix).toBe(made.key.slice(0, 13));
    expect(made.name).toBe("CI deploys");
    const listed = (await listApiKeys()).find((k) => k.id === made.id)!;
    expect(listed).not.toHaveProperty("key");
    expect(JSON.stringify(await listApiKeys())).not.toContain(made.key);
    const read = await createApiKey({ name: "Read", workspaceId: WS, access: "read", expiresAt: null });
    expect(read.key.startsWith("kanbo_pk_")).toBe(true);
    expect((await listApiKeys(WS)).some((k) => k.id === read.id)).toBe(true);
  });
  it("keeps the server's rules", async () => {
    await expect(createApiKey({ name: " ", workspaceId: null, access: "read", expiresAt: null })).rejects.toThrow(/invalid name/);
    await expect(createApiKey({ name: "x", workspaceId: null, access: "read", expiresAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow(/invalid expiry/);
    await expect(createApiKey({ name: "x", workspaceId: null, access: "read", expiresAt: new Date(Date.now() + 6 * 366 * DAY).toISOString() })).rejects.toThrow(/invalid expiry/);
    for (let i = 0; i < 23; i++) await createApiKey({ name: `k${i}`, workspaceId: null, access: "read", expiresAt: null });
    await expect(createApiKey({ name: "one too many", workspaceId: null, access: "read", expiresAt: null })).rejects.toThrow(/too many keys/);
  });
  it("revokes (once)", async () => {
    const [zapier] = (await listApiKeys()).filter((k) => k.name === "Zapier");
    const done = await revokeApiKey(zapier.id);
    expect(done).toMatchObject({ status: "revoked", canRevoke: false });
    await expect(revokeApiKey(zapier.id)).rejects.toThrow(/key not found/);
    await expect(revokeApiKey("nope")).rejects.toThrow(/key not found/);
  });
  it("turns failures into sentences", () => {
    expect(apiKeyMessage(new Error("too many keys"))).toBe(API_KEY_COPY.tooMany);
    expect(apiKeyMessage(new Error("invalid expiry"))).toBe(API_KEY_COPY.invalidExpiry);
    expect(apiKeyMessage(new Error("invalid name"))).toBe(API_KEY_COPY.invalidName);
    expect(apiKeyMessage(new Error("not allowed"))).toBe(API_KEY_COPY.notAllowed);
    expect(apiKeyMessage(new TypeError("Failed to fetch"))).toBe(API_KEY_COPY.offline);
    expect(apiKeyMessage({ code: "PGRST202", message: "Could not find the function" })).toBe(API_KEY_COPY.unavailable);
    expect(apiKeyMessage(new Error("boom"))).toBe(API_KEY_COPY.failed);
  });
});
