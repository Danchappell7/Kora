/* lib/updateConversation in demo mode (0054): the seeded threads, replies (yours to edit and delete), reactions you
   add and take back, "seen by" never counting the author, and the "Seen by" names. */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addUpdateComment, deleteUpdateComment, editUpdateComment, loadUpdateConversation, markUpdatesSeen, parseUpdateComment, resetUpdateConversation,
  seenByNames, threadOf, toggleUpdateReaction, useUpdateConversation,
} from "./updateConversation";
import { renderHook, act } from "@testing-library/react";

beforeEach(() => resetUpdateConversation());

describe("the conversation on an update, demo", () => {
  it("reads the seeded thread once, as a copy", async () => {
    const { result } = renderHook(() => useUpdateConversation(["su-launch", "su-none"]));
    await act(async () => { await loadUpdateConversation(["su-launch"]); });
    const t = threadOf(result.current.threads, "su-launch");
    expect(t.comments.map((c) => c.authorName)).toEqual(["Maya Lin", "Theo Vance", "Maya Lin"]);
    expect(t.reactions["👍"]).toEqual(["m-1", "m-2"]);
    expect(t.seenBy).toEqual(["m-1", "m-2", "m-3"]);
    expect(threadOf(result.current.threads, "su-none")).toEqual({ comments: [], reactions: {}, seenBy: [] });
    expect(result.current.on).toBe(true);
  });

  it("you reply, edit your reply (marked edited) and delete it", async () => {
    const c = await addUpdateComment("su-brand", "  Approved, go ahead.  ", ["m-3", "m-self"], "m-self");
    expect(c).toMatchObject({ authorId: "m-self", authorName: "Daniel Okai", body: "Approved, go ahead.", mentions: ["m-3"], editedAt: null });
    const e = await editUpdateComment(c, "Approved: go ahead with option B.");
    expect(e.editedAt).toBeTruthy();
    await deleteUpdateComment(e);
    const { result } = renderHook(() => useUpdateConversation(["su-brand"]));
    expect(threadOf(result.current.threads, "su-brand").comments.some((x) => x.id === c.id)).toBe(false);
    await expect(addUpdateComment("su-brand", "   ", [], "m-self")).rejects.toThrow(/Write something first/);
    await expect(editUpdateComment(c, " ")).rejects.toThrow(/can't be empty/);
  });

  it("a reaction is yours to add and take back", async () => {
    resetUpdateConversation({ "su-x": { reactions: { "🎉": ["m-1"] } } });
    await toggleUpdateReaction("su-x", "🎉", "m-self");
    await toggleUpdateReaction("su-x", "👀", "m-self");
    const { result } = renderHook(() => useUpdateConversation(["su-x"]));
    expect(threadOf(result.current.threads, "su-x").reactions).toEqual({ "🎉": ["m-1", "m-self"], "👀": ["m-self"] });
    await act(async () => { await toggleUpdateReaction("su-x", "👀", "m-self"); });
    expect(threadOf(result.current.threads, "su-x").reactions).toEqual({ "🎉": ["m-1", "m-self"] });
  });

  it("seen by: you, on updates you didn't write, once", async () => {
    resetUpdateConversation({ "su-a": {}, "su-b": {} });
    await markUpdatesSeen(["su-a", "su-b", "su-a"], "m-self", (id) => (id === "su-b" ? "m-self" : "m-1"));
    await markUpdatesSeen(["su-a"], "m-self", () => "m-1");
    const { result } = renderHook(() => useUpdateConversation(["su-a", "su-b"]));
    expect(threadOf(result.current.threads, "su-a").seenBy).toEqual(["m-self"]);
    expect(threadOf(result.current.threads, "su-b").seenBy).toEqual([]);
  });

  it("says who's seen it by first name", () => {
    const names: Record<string, string> = { a: "Maya Lin", b: "Theo Vance", c: "Sana Rao", d: "Idris Bell" };
    expect(seenByNames(["a"], (id) => names[id])).toBe("Maya");
    expect(seenByNames(["a", "b", "c"], (id) => names[id])).toBe("Maya, Theo and Sana");
    expect(seenByNames(["a", "b", "c", "d"], (id) => names[id])).toBe("Maya, Theo and 2 others");
  });

  it("reads a comment row, and nothing that isn't one", () => {
    expect(parseUpdateComment({ id: "c1", update_id: "su", user_id: null, author_name: "", body: "Hi", created_at: "2026-11-10T09:00:00Z" }))
      .toMatchObject({ authorId: null, authorName: "Former member", mentions: [], editedAt: null });
    expect(parseUpdateComment({ id: "c1" })).toBeNull();
  });
});
