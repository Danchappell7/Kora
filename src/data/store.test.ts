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

describe("store (demo mode) — workspaces & invites", () => {
  it("creates a workspace and invites a member", async () => {
    const ws = await store.createWorkspace("Acme", { id: "m-self", email: "me@kora.app", name: "Me" });
    expect(ws.name).toBe("Acme");
    expect(ws.kind).toBe("team");
    expect(ws.id).toBeTruthy();
    const invite = await store.inviteMember(ws.id!, "teammate@acme.com");
    expect(invite.status).toBe("invited");
    expect(invite.email).toBe("teammate@acme.com");
    // bootstrap reflects the new workspace + members
    const b = await store.bootstrap({ id: "m-self" });
    expect(b.workspaces.some((w) => w.id === ws.id)).toBe(true);
    expect(b.members.some((m) => m.email === "teammate@acme.com")).toBe(true);
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
