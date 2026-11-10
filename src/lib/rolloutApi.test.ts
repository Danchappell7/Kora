/* lib/rolloutApi in the demo (no backend): who's been active this week, by day; provisioning a business into
   the demo store; and the console's adoption numbers. */
import { describe, expect, it } from "vitest";
import { store } from "../data/store";
import { demoActivity, loadWorkspaceActivity, provisionBusiness, provisionRefusal, workspaceAdoption, notYet } from "./rolloutApi";

describe("rolloutApi (demo)", () => {
  it("a believable week, by day: someone in every day, someone gone quiet", () => {
    const a = demoActivity(["a", "b", "c", "d"], new Date(2026, 10, 10));
    expect(a.today).toBe("2026-11-10");
    expect(a.members.map((m) => [m.userId, m.days, m.lastDay])).toEqual([["a", 7, "2026-11-10"], ["b", 5, "2026-11-10"], ["c", 2, "2026-11-09"], ["d", 0, "2026-11-01"]]);
    expect(a.days.map((d) => d.day)).toEqual(["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"]);
    expect(a.days[6].people).toBe(2);
    expect(JSON.stringify(a)).not.toMatch(/T\d\d:/);
  });
  it("loads the workspace's own active members", async () => {
    const a = await loadWorkspaceActivity("ws-x", [
      { id: "1", workspaceId: "ws-x", userId: "u1", email: "", name: "", role: "owner", status: "active" },
      { id: "2", workspaceId: "ws-x", userId: null, email: "a@b.co", name: "", role: "member", status: "invited" },
      { id: "3", workspaceId: "ws-y", userId: "u3", email: "", name: "", role: "member", status: "active" },
    ]);
    expect(a !== "off" && a !== "failed" && a.members.map((m) => m.userId)).toEqual(["u1"]);
  });
  it("provisions into the demo: the workspace, the owner invited as an admin, and its row in the console", async () => {
    const r = await provisionBusiness({ name: "Harbour Fitness", ownerEmail: "Nina@HarbourFit.co.uk", domain: "HarbourFit.co.uk", pack: "fitness" }, { id: "m-self", email: "daniel@kanbo.app", name: "Daniel" });
    const b = await store.bootstrap({ id: "m-self" });
    expect(b.workspaces.find((w) => w.id === r.workspaceId)?.name).toBe("Harbour Fitness");
    expect(b.members.find((m) => m.id === r.memberId)).toMatchObject({ email: "nina@harbourfit.co.uk", role: "admin", status: "invited" });
    expect(r.domain).toBe("harbourfit.co.uk");
    const rows = await workspaceAdoption();
    expect(Array.isArray(rows) && rows[0]).toMatchObject({ id: r.workspaceId, name: "Harbour Fitness", handover: { email: "nina@harbourfit.co.uk", done: false }, pack: "fitness" });
    expect(Array.isArray(rows) && rows.some((x) => x.id === "ws-foundrise" && x.weeklyActive === 3)).toBe(true);
  });
  it("words the database's refusals for the console", () => {
    expect(provisionRefusal("not authorized")).toMatchObject({ reason: "not_allowed", message: "Only platform admins can provision a business." });
    expect(provisionRefusal("a public email domain would let anyone in").message).toMatch(/public email domain/);
    expect(provisionRefusal("invalid email").reason).toBe("invalid");
    expect(provisionRefusal("the owner has to be someone else: you stay on as an admin").message).toMatch(/someone other than you/);
    expect(provisionRefusal("boom")).toMatchObject({ reason: "failed" });
    expect(notYet({ code: "PGRST202" })).toBe(true);
    expect(notYet({ message: "Could not find the function public.workspace_activity(p_ws) in the schema cache" })).toBe(true);
    expect(notYet({ code: "42501", message: "not authorized" })).toBe(false);
  });
});
