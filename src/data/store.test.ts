import { describe, it, expect } from "vitest";
import { store } from "./store";

/* These run in demo mode (no Supabase env in tests), exercising the
   in-memory adapters that mirror the real API shape. */

describe("store (demo mode) — comments", () => {
  it("adds and lists comments per task", async () => {
    const before = await store.listComments("t-test");
    expect(before).toEqual([]);
    const c = await store.addComment("t-test", "First!", "m-self", "Daniel");
    expect(c.body).toBe("First!");
    expect(c.taskId).toBe("t-test");
    const after = await store.listComments("t-test");
    expect(after).toHaveLength(1);
    expect(after[0].authorName).toBe("Daniel");
    // other tasks unaffected
    expect(await store.listComments("t-other")).toEqual([]);
  });
});

describe("store (demo mode) — activity", () => {
  it("logs activity newest-first", async () => {
    await store.logActivity({ taskId: "t-1", taskTitle: "A", kind: "created", detail: "Task created" }, "m-self");
    await store.logActivity({ taskId: "t-1", taskTitle: "A", kind: "completed", detail: "Marked complete" }, "m-self");
    const feed = await store.listActivity();
    expect(feed.length).toBeGreaterThanOrEqual(2);
    expect(feed[0].kind).toBe("completed");
    expect(feed[1].kind).toBe("created");
  });
});
