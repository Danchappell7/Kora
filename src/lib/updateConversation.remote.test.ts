/* lib/updateConversation against a (mocked) real backend (0054): a thread's three reads, a reply and its refusals,
   a reaction the database turns down put back, "seen by" through its function, the notify call for a posted update,
   and before 0054 (no tables): nothing offered. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, invoke } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(async () => ({ data: 1, error: null })), invoke: vi.fn(async () => ({ data: null, error: null })) }));
vi.mock("./supabase", () => ({
  supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...(a as [])), functions: { invoke: (...a: unknown[]) => invoke(...(a as [])) } },
  isSupabaseConfigured: true,
}));

import {
  addUpdateComment, conversationOn, ConversationError, loadUpdateConversation, markUpdatesSeen, notifyUpdatePosted, resetUpdateConversation, threadOf,
  toggleUpdateReaction, useUpdateConversation,
} from "./updateConversation";
import { renderHook, waitFor } from "@testing-library/react";

/** a select chain answering `result` (any filters) */
const reads = (result: { data?: unknown; error?: unknown }) => {
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "in", "order", "eq"]) chain[k] = () => chain;
  chain.limit = async () => ({ data: result.data ?? null, error: result.error ?? null });
  return chain;
};
const COMMENT = { id: "c1", update_id: "su-1", user_id: "maya", author_name: "Maya Lin", body: "What do you need?", mentions: [], created_at: "2026-11-10T09:00:00Z", edited_at: null };

beforeEach(() => { from.mockReset(); rpc.mockClear(); invoke.mockClear(); resetUpdateConversation(); });

describe("update conversation, signed in", () => {
  it("reads replies, reactions and who's seen it, for the updates shown", async () => {
    from.mockImplementation((table: string) => reads({ data: table === "status_update_comments" ? [COMMENT, { bogus: 1 }]
      : table === "status_update_reactions" ? [{ update_id: "su-1", user_id: "theo", emoji: "👍" }] : [{ update_id: "su-1", user_id: "sana" }] }));
    const { result } = renderHook(() => useUpdateConversation(["su-1"]));
    await waitFor(() => expect(threadOf(result.current.threads, "su-1").comments).toHaveLength(1));
    expect(threadOf(result.current.threads, "su-1")).toMatchObject({ reactions: { "👍": ["theo"] }, seenBy: ["sana"] });
    expect(from.mock.calls.map((c) => c[0]).sort()).toEqual(["status_update_comments", "status_update_reactions", "status_update_views"]);
  });

  it("a reply is inserted as you; the database's refusals are said plainly", async () => {
    const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { ...COMMENT, id: "c2", user_id: "me", body: "On it" }, error: null }) }) }));
    from.mockReturnValue({ insert });
    const c = await addUpdateComment("su-1", "On it", ["maya"], "me");
    expect(insert).toHaveBeenCalledWith({ update_id: "su-1", user_id: "me", body: "On it", mentions: ["maya"] });
    expect(c.id).toBe("c2");
    from.mockReturnValue({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "42501", message: "new row violates row-level security policy" } }) }) }) });
    await expect(addUpdateComment("su-1", "Hi", [], "me")).rejects.toMatchObject({ reason: "not_allowed" });
    from.mockReturnValue({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "P0001", message: "too many comments" } }) }) }) });
    await expect(addUpdateComment("su-1", "Hi", [], "me")).rejects.toThrow(/a lot of replies/);
  });

  it("a reaction the database turns down is put back", async () => {
    resetUpdateConversation({ "su-1": { reactions: {} } });
    from.mockReturnValue({ insert: async () => ({ error: { code: "23514", message: "violates check constraint" } }) });
    await expect(toggleUpdateReaction("su-1", "👍", "me")).rejects.toBeInstanceOf(ConversationError);
    const { result } = renderHook(() => useUpdateConversation(["su-1"]));
    expect(threadOf(result.current.threads, "su-1").reactions).toEqual({});
  });

  it("seen by goes through mark_status_updates_seen, never for your own", async () => {
    resetUpdateConversation({ "su-1": {}, "su-2": {} });
    await markUpdatesSeen(["su-1", "su-2"], "me", (id) => (id === "su-2" ? "me" : "maya"));
    expect(rpc).toHaveBeenCalledWith("mark_status_updates_seen", { p_ids: ["su-1"] });
  });

  it("a posted update asks notify to tell people (a draft's temporary id never does)", () => {
    notifyUpdatePosted("su-9");
    notifyUpdatePosted("tmp-su-1");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("notify", { body: { kind: "status_update", updateId: "su-9" } });
  });

  it("before 0054 (no tables): nothing to offer, and a reply says it isn't switched on yet", async () => {
    from.mockReturnValue(reads({ error: { code: "PGRST205", message: "Could not find the table 'public.status_update_comments' in the schema cache" } }));
    await loadUpdateConversation(["su-1"]);
    expect(conversationOn()).toBe(false);
    await expect(addUpdateComment("su-1", "Hi", [], "me")).rejects.toMatchObject({ reason: "unavailable" });
  });
});
