/* lib/portfolioUpdates (0054): a portfolio's updates in demo mode (seeded, posted, edited, deleted) and against a
   mocked backend (read newest first; before 0054 it says it isn't switched on). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const { from, configured } = vi.hoisted(() => ({ from: vi.fn(), configured: { on: false } }));
vi.mock("./supabase", () => ({
  get supabase() { return configured.on ? { from: (...a: unknown[]) => from(...a) } : null; },
  isSupabaseConfigured: false,
}));

import { deletePortfolioUpdate, editPortfolioUpdate, loadPortfolioUpdates, postPortfolioUpdate, portfolioUpdatesOn, resetPortfolioUpdates, usePortfolioUpdates } from "./portfolioUpdates";

beforeEach(() => { configured.on = false; from.mockReset(); resetPortfolioUpdates(); });

describe("portfolio updates, demo", () => {
  it("the Q3 launch portfolio's seeded update, then one posted, edited and deleted", async () => {
    const { result } = renderHook(() => usePortfolioUpdates("pf-q3"));
    await waitFor(() => expect(result.current.updates.map((u) => u.id)).toEqual(["pu-demo-1"]));
    let u = await act(async () => postPortfolioUpdate("pf-q3", { summary: "  All on track.  ", status: "on_track", sections: { next: "Launch day", risks: " " } }, "m-self"));
    expect(u).toMatchObject({ summary: "All on track.", authorId: "m-self", sections: { next: "Launch day" } });
    expect(result.current.updates[0].id).toBe(u.id);
    u = await act(async () => editPortfolioUpdate(u, { summary: "Nearly all on track." }));
    expect(u.editedAt).toBeTruthy();
    await act(async () => { await deletePortfolioUpdate(u); });
    expect(result.current.updates.map((x) => x.id)).toEqual(["pu-demo-1"]);
    await expect(postPortfolioUpdate("pf-q3", { summary: " ", status: "on_track" }, "m-self")).rejects.toThrow(/Write something first/);
  });
});

describe("portfolio updates, signed in", () => {
  const reads = (result: { data?: unknown; error?: unknown }) => {
    const chain: Record<string, unknown> = {};
    for (const k of ["select", "eq", "order"]) chain[k] = () => chain;
    chain.limit = async () => ({ data: result.data ?? null, error: result.error ?? null });
    return chain;
  };
  it("reads a portfolio's updates newest first", async () => {
    configured.on = true;
    from.mockReturnValue(reads({ data: [
      { id: "pu-1", portfolio_id: "pf", author_id: "a", summary: "Older", status: "on_track", created_at: "2026-11-01T09:00:00Z" },
      { id: "pu-2", portfolio_id: "pf", author_id: null, summary: "Newer", status: "great", sections: { asks: "Help" }, created_at: "2026-11-08T09:00:00Z" },
    ] }));
    const list = await loadPortfolioUpdates("pf");
    expect(list.map((u) => [u.id, u.status, u.authorId])).toEqual([["pu-2", "on_track", null], ["pu-1", "on_track", "a"]]);
    expect(list[0].sections).toEqual({ asks: "Help" });
  });
  it("before 0054: nothing to read, and posting says it isn't switched on yet", async () => {
    configured.on = true;
    from.mockReturnValue(reads({ error: { code: "PGRST205", message: "Could not find the table 'public.portfolio_updates' in the schema cache" } }));
    expect(await loadPortfolioUpdates("pf")).toEqual([]);
    expect(portfolioUpdatesOn()).toBe(false);
    await expect(postPortfolioUpdate("pf", { summary: "Hi", status: "on_track" }, "me")).rejects.toMatchObject({ reason: "unavailable" });
  });
});
