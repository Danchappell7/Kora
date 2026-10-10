/* The demo's extra Inbox items fold into a bundle and a kudos row. The demo
   world is built against the clock, so the clock is pinned before it loads. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  vi.resetModules();
});
afterAll(() => { vi.useRealTimers(); });

describe("demoNotifyActivity", () => {
  it("adds two comments that bundle with the seed's, and a kudos for your own finished task", async () => {
    const { demoNotifyActivity } = await import("./notifyDemo");
    const { bundleInbox, triage } = await import("./inboxTriage");
    const { DEMO_ACTIVITY, TASKS } = await import("../data/data");
    const extra = demoNotifyActivity();
    expect(extra.map((a) => a.id)).toEqual(["a-demo-n1", "a-demo-n2", "a-demo-n3"]);
    const kudos = extra[2];
    expect(kudos).toMatchObject({ kind: "kudos", detail: "Theo Vance", meta: { emoji: "🙌" } });
    expect(TASKS.find((t) => t.id === kudos.taskId)?.status).toBe("done");
    const feed = [...extra, ...DEMO_ACTIVITY].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    const fyi = triage(feed, { me: "m-self", tasks: TASKS }).fyi;
    const deck = bundleInbox(fyi, { tasks: TASKS, group: "fyi" }).find((b) => b.taskId === "t-1");
    expect(deck?.summary).toBe("3 comments on Finalise Q3 launch narrative deck from Sana, Maya and Theo");
  });
});
