/* lib/rolloutApi against a (mocked) real backend: workspace_activity, admin_provision_business and
   admin_workspace_adoption, their refusals, and before 0058 (no functions): "off", never an error. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) }, isSupabaseConfigured: true }));
// (signed in, provisioning never touches the demo store)
vi.mock("../data/store", () => ({ store: {} }));

import { loadWorkspaceActivity, provisionBusiness, ProvisionError, publicMailDomain, workspaceAdoption } from "./rolloutApi";
import { noteRolloutSchema, resetRolloutSchema, rolloutOn } from "./rolloutPlan";

const ME = { id: "u-admin", email: "admin@kanbo.app", name: "Admin" };
const MISSING = { code: "PGRST202", message: "Could not find the function public.workspace_activity(p_ws) in the schema cache" };
beforeEach(() => { rpc.mockReset(); });

describe("rolloutApi, signed in", () => {
  it("reads the week's activity, by day", async () => {
    rpc.mockResolvedValue({ data: { today: "2026-11-10", members: [{ user_id: "u1", days: 4, last_day: "2026-11-10" }], days: [{ day: "2026-11-10", people: 1 }] }, error: null });
    expect(await loadWorkspaceActivity("ws-1")).toEqual({ today: "2026-11-10", members: [{ userId: "u1", days: 4, lastDay: "2026-11-10" }], days: [{ day: "2026-11-10", people: 1 }] });
    expect(rpc).toHaveBeenCalledWith("workspace_activity", { p_ws: "ws-1" });
  });
  it("before 0058: off; refused or broken: failed", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    expect(await loadWorkspaceActivity("ws-1")).toBe("off");
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "not authorized" } });
    expect(await loadWorkspaceActivity("ws-1")).toBe("failed");
    rpc.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await loadWorkspaceActivity("ws-1")).toBe("failed");
  });
  it("provisions through admin_provision_business, the domain normalised", async () => {
    rpc.mockResolvedValue({ data: { workspace_id: "ws-9", member_id: "m-9", domain: "acme.co", domain_added: true, approved: 2 }, error: null });
    expect(await provisionBusiness({ name: "Acme", ownerEmail: "boss@acme.co", domain: " ACME.co ", pack: "agency" }, ME))
      .toEqual({ workspaceId: "ws-9", memberId: "m-9", domain: "acme.co", domainAdded: true, approved: 2 });
    expect(rpc).toHaveBeenCalledWith("admin_provision_business", { p_name: "Acme", p_owner_email: "boss@acme.co", p_domain: "acme.co", p_pack: "agency" });
  });
  it("says why it was refused, and that it isn't switched on before 0058", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "not authorized" } });
    await expect(provisionBusiness({ name: "Acme", ownerEmail: "boss@acme.co" }, ME)).rejects.toMatchObject({ reason: "not_allowed" });
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "a public email domain would let anyone in" } });
    await expect(provisionBusiness({ name: "Acme", ownerEmail: "boss@acme.co", domain: "gmail.com" }, ME)).rejects.toMatchObject({ reason: "invalid" });
    rpc.mockResolvedValue({ data: null, error: { ...MISSING, message: "Could not find the function public.admin_provision_business" } });
    const e = await provisionBusiness({ name: "Acme", ownerEmail: "boss@acme.co" }, ME).catch((x) => x);
    expect(e).toBeInstanceOf(ProvisionError);
    expect(e).toMatchObject({ reason: "off", message: expect.stringMatching(/0058/) });
    rpc.mockResolvedValue({ data: {}, error: null });
    await expect(provisionBusiness({ name: "Acme", ownerEmail: "boss@acme.co" }, ME)).rejects.toMatchObject({ reason: "failed" });
  });
  it("reads every workspace's adoption", async () => {
    rpc.mockResolvedValue({ data: [{ id: "w1", name: "Acme", created_at: "2026-11-01", members: 5, invited: 2, weekly_active: 3, done_week: 9, last_day: "2026-11-09", handover_email: "boss@acme.co", handover_done_at: null, pack: "agency" }, { nope: 1 }], error: null });
    expect(await workspaceAdoption()).toEqual([{ id: "w1", name: "Acme", createdAt: "2026-11-01", members: 5, invited: 2, weeklyActive: 3, doneWeek: 9, lastDay: "2026-11-09", handover: { email: "boss@acme.co", done: false }, pack: "agency" }]);
    rpc.mockResolvedValue({ data: null, error: MISSING });
    expect(await workspaceAdoption()).toBe("off");
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "not authorized" } });
    expect(await workspaceAdoption()).toBe("failed");
  });
});

describe("the rollout plan, signed in", () => {
  it("isn't offered until a read says 0058 is in (someone whose first load had no team workspace)", () => {
    resetRolloutSchema();
    expect(rolloutOn()).toBe(false);
    noteRolloutSchema(true);
    expect(rolloutOn()).toBe(true);
    noteRolloutSchema(false);
    expect(rolloutOn()).toBe(false);
    resetRolloutSchema();
  });
});

describe("public mail domains (as 0058's public_mail_domain)", () => {
  it("the big providers under any country ending, and UK ISPs; never a business's own", () => {
    for (const d of ["gmail.com", "outlook.co.uk", "yahoo.fr", "hotmail.fr", "gmx.de", "web.de", "ymail.com", "pm.me", "hey.com", "fastmail.com", "qq.com", "virginmedia.com", "talktalk.net", "ntlworld.com", "aol.co.uk"]) {
      expect(publicMailDomain(d), d).toBe(true);
    }
    for (const d of ["harbourfit.co.uk", "mailchimp.com", "webflow.io", "outlookstudio.com", "kanbo.co.uk"]) expect(publicMailDomain(d), d).toBe(false);
  });
});
