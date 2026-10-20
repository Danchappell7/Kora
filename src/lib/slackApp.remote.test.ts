/* lib/slackApp against a (mocked) real backend: the 0049 RPCs and the
   own-rows delete, and what each refusal reads as. */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
  isSupabaseConfigured: true,
}));

import { claimSlackLink, loadSlackAppStatus, previewSlackLink, setSlackDefaultWorkspace, unlinkSlackAccount } from "./slackApp";

const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg";
const WS = "11111111-2222-4333-8444-555555555555";
beforeEach(() => { rpc.mockReset(); from.mockReset(); });

describe("the 0049 contract", () => {
  it("status, as the person", async () => {
    rpc.mockResolvedValue({ data: { workspace_id: WS, can_manage: false, teams: [], links: [] }, error: null });
    expect(await loadSlackAppStatus(WS)).toEqual({ workspaceId: WS, canManage: false, teams: [], links: [] });
    expect(rpc).toHaveBeenCalledWith("slack_app_status", { p_ws: WS });
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await loadSlackAppStatus(WS)).toBeNull();
  });
  it("before 0049: 'not switched on'", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.slack_app_status(p_ws)" } });
    await expect(loadSlackAppStatus(WS)).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("set the default workspace (or none)", async () => {
    rpc.mockResolvedValue({ data: { workspace_id: WS, can_manage: true, teams: [], links: [] }, error: null });
    await setSlackDefaultWorkspace("TACME", WS);
    expect(rpc).toHaveBeenCalledWith("slack_app_set_default", { p_team: "TACME", p_ws: WS });
    await setSlackDefaultWorkspace("TACME", null);
    expect(rpc).toHaveBeenLastCalledWith("slack_app_set_default", { p_team: "TACME", p_ws: null });
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "not allowed" } });
    await expect(setSlackDefaultWorkspace("TACME", WS)).rejects.toMatchObject({ reason: "not_allowed" });
    // Slack's "owner or admin" is over a day old: the Home tab or /kanbo asks again
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "slack admin check needed" } });
    await expect(setSlackDefaultWorkspace("TACME", WS)).rejects.toMatchObject({ reason: "recheck" });
  });
  it("preview and claim (with the explicit 'this is mine')", async () => {
    rpc.mockResolvedValue({ data: { status: "ok", team_id: "TACME", team_name: "acme", slack_user_name: "Mia", has_email: true, email_matches: true, already_linked: false }, error: null });
    expect((await previewSlackLink(TOKEN))?.teamName).toBe("acme");
    expect(rpc).toHaveBeenCalledWith("slack_link_preview", { p_token: TOKEN });
    rpc.mockResolvedValue({ data: { team_id: "TACME", team_name: "acme", slack_user_id: "U1", slack_user_name: "Mia", linked_at: "x" }, error: null });
    expect(await claimSlackLink(TOKEN, true)).toMatchObject({ teamId: "TACME", slackUserId: "U1" });
    expect(rpc).toHaveBeenLastCalledWith("claim_slack_link", { p_token: TOKEN, p_accept_mismatch: true });
    for (const [message, reason] of [["link already used", "used"], ["link expired", "expired"], ["invalid link", "invalid_link"], ["email mismatch", "email_mismatch"]]) {
      rpc.mockResolvedValue({ data: null, error: { code: "P0001", message } });
      await expect(claimSlackLink(TOKEN)).rejects.toMatchObject({ reason });
    }
  });
  it("unlink deletes your own row by its key (RLS keeps it to yours)", async () => {
    const eq2 = vi.fn().mockResolvedValue({ error: null });
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const del = vi.fn(() => ({ eq: eq1 }));
    from.mockReturnValue({ delete: del });
    await unlinkSlackAccount("TACME", "U1");
    expect(from).toHaveBeenCalledWith("slack_user_links");
    expect(eq1).toHaveBeenCalledWith("team_id", "TACME");
    expect(eq2).toHaveBeenCalledWith("slack_user_id", "U1");
  });
});
