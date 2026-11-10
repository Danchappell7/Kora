/* lib/updateAsks against a (mocked) real backend: the asks you can read, ask_for_update and its refusals, the
   notify call, and before 0053 (no table, no function): nothing offered. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { rpc, invoke, from } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(async () => ({ data: null, error: null })), from: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), functions: { invoke: (...a: unknown[]) => invoke(...(a as [])) }, from: (...a: unknown[]) => from(...a) },
  isSupabaseConfigured: true,
}));

import { askForUpdate, asksOn, loadUpdateAsks, resetUpdateAsks, useAskForUpdate, AskError } from "./updateAsks";

const ROW = { id: "a1", project_id: "p1", workspace_id: "w", asked_by: "me", owner_id: "sana", created_at: "2026-11-13T09:00:00Z" };
/** a select chain that answers `result` */
const reads = (result: { data?: unknown; error?: unknown }) => {
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "gte", "order"]) chain[k] = () => chain;
  chain.limit = async () => ({ data: result.data ?? null, error: result.error ?? null });
  return chain;
};
const project = { id: "p1", workspaceId: "w", ownerId: "sana", name: "Launch", emoji: "", color: "" };

beforeEach(() => { rpc.mockReset(); invoke.mockClear(); from.mockReset(); resetUpdateAsks(); });

describe("update asks, signed in", () => {
  it("reads the last week's asks once per person, and again for someone else", async () => {
    from.mockReturnValue(reads({ data: [ROW, { bogus: true }] }));
    expect(await loadUpdateAsks("me")).toEqual([{ id: "a1", projectId: "p1", workspaceId: "w", askedBy: "me", ownerId: "sana", createdAt: "2026-11-13T09:00:00Z" }]);
    await loadUpdateAsks("me");
    expect(from).toHaveBeenCalledTimes(1);
    from.mockReturnValue(reads({ data: [] }));
    expect(await loadUpdateAsks("theo")).toEqual([]);
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("asks through ask_for_update, then has notify tell the owner", async () => {
    rpc.mockResolvedValue({ data: ROW, error: null });
    const a = await askForUpdate(project, "me");
    expect(rpc).toHaveBeenCalledWith("ask_for_update", { p_project: "p1" });
    expect(a).toMatchObject({ id: "a1", ownerId: "sana" });
    expect(invoke).toHaveBeenCalledWith("notify", { body: { kind: "update_ask", askId: "a1" } });
  });

  it("says why when the database refuses", async () => {
    const cases: [string, string, RegExp][] = [
      ["already asked recently", "recent", /today/], ["too many asks today", "recent", /tomorrow/], ["not authorized", "not_allowed", /owners and admins/],
      // (an admin who can ask hears what's really wrong, not that only admins can)
      ["not allowed: the owner has left", "not_allowed", /^Its owner isn't in the workspace any more/],
      ["not allowed: the owner is a guest", "not_allowed", /^Its owner is a guest here/],
      ["not allowed: the project is archived", "not_allowed", /^This project is archived/],
      ["connection reset", "failed", /Try again/],
    ];
    for (const [message, reason, says] of cases) {
      rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message } });
      await expect(askForUpdate(project, "me")).rejects.toMatchObject({ reason, message: expect.stringMatching(says) });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("before 0053 (no table, no function): nothing to offer, and an ask says it isn't switched on yet", async () => {
    from.mockReturnValue(reads({ error: { code: "PGRST205", message: "Could not find the table 'public.update_asks' in the schema cache" } }));
    const { result } = renderHook(() => useAskForUpdate("me", () => "owner"));
    await waitFor(() => expect(asksOn()).toBe(false));
    await waitFor(() => expect(result.current).toBeUndefined());
    const err = await askForUpdate(project, "me").catch((e) => e);
    expect(err).toBeInstanceOf(AskError);
    expect(err).toMatchObject({ reason: "unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("finding the table missing on a later read (after a blip) still takes the Ask buttons away", async () => {
    from.mockReturnValueOnce(reads({ error: { code: "08006", message: "connection reset" } }));
    await loadUpdateAsks("me");                   // a blip: nothing known yet, so asking is still offered
    from.mockReturnValue(reads({ error: { code: "PGRST205", message: "Could not find the table 'public.update_asks' in the schema cache" } }));
    const { result } = renderHook(() => useAskForUpdate("me", () => "owner"));
    expect(result.current).toBeDefined();
    await waitFor(() => expect(asksOn()).toBe(false));
    await waitFor(() => expect(result.current).toBeUndefined());
  });
});
