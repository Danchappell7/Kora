/* lib/apiKeys against a (mocked) real backend: the 0046 RPCs as the
   signed-in person, their JSON parsed, their errors passed through. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) }, isSupabaseConfigured: true }));

import { apiKeyFailure, createApiKey, listApiKeys, revokeApiKey } from "./apiKeys";

const ROW = {
  id: "9c78f0f3-412c-4a1f-b393-3124631da302", name: "Zapier", access: "read", prefix: "kanbo_pk_G6V6", status: "active",
  user_id: "bbbbbbbb-0000-4000-8000-000000000002", can_revoke: true, created_at: "2026-10-05T18:04:26.19+00:00", expires_at: null,
  revoked_at: null, last_used_at: null, workspace_id: null, workspace_name: null, created_by_name: "Bob",
};
const KEY = "kanbo_pk_G6V69SndWErk4HgPZh10jg2WURvdp-MjLekw7j-G-hs";
const setOnline = (on: boolean) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });

beforeEach(() => { rpc.mockReset(); setOnline(true); });
afterEach(() => setOnline(true));

describe("API keys over RPC", () => {
  it("lists yours, or a workspace's", async () => {
    rpc.mockResolvedValue({ data: [ROW, { bad: true }], error: null });
    const keys = await listApiKeys();
    expect(rpc).toHaveBeenCalledWith("list_api_keys", { p_workspace: null });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: "Zapier", createdByName: "Bob", canRevoke: true });
    await listApiKeys("11111111-0000-4000-8000-000000000001");
    expect(rpc).toHaveBeenLastCalledWith("list_api_keys", { p_workspace: "11111111-0000-4000-8000-000000000001" });
  });
  it("creates with the trimmed name, access and expiry; returns the key once", async () => {
    rpc.mockResolvedValue({ data: { ...ROW, key: KEY }, error: null });
    const made = await createApiKey({ name: " Zapier ", workspaceId: null, access: "read", expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(rpc).toHaveBeenCalledWith("create_api_key", { p_name: "Zapier", p_workspace: null, p_access: "read", p_expires_at: "2027-01-01T00:00:00.000Z" });
    expect(made.key).toBe(KEY);
  });
  it("an answer without a well-formed key is an error, not a silent success", async () => {
    rpc.mockResolvedValue({ data: ROW, error: null });
    await expect(createApiKey({ name: "x", workspaceId: null, access: "read", expiresAt: null })).rejects.toThrow();
  });
  it("revokes", async () => {
    rpc.mockResolvedValue({ data: { ...ROW, status: "revoked", revoked_at: "2026-10-06T00:00:00Z", can_revoke: false }, error: null });
    expect(await revokeApiKey(ROW.id)).toMatchObject({ status: "revoked", canRevoke: false });
    expect(rpc).toHaveBeenCalledWith("revoke_api_key", { p_id: ROW.id });
  });
  it("passes the database's refusals through for apiKeyFailure", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "not allowed", code: "P0001" } });
    await listApiKeys("11111111-0000-4000-8000-000000000001").catch((e) => expect(apiKeyFailure(e)).toBe("not_allowed"));
    rpc.mockResolvedValue({ data: null, error: { message: "too many keys", code: "P0001" } });
    await createApiKey({ name: "x", workspaceId: null, access: "read", expiresAt: null }).catch((e) => expect(apiKeyFailure(e)).toBe("too_many"));
    expect.assertions(2);
  });
  it("offline: fails fast without calling the server", async () => {
    setOnline(false);
    await expect(listApiKeys()).rejects.toThrow(/Failed to fetch/);
    expect(rpc).not.toHaveBeenCalled();
  });
});
