/* The demo's teammates: who's where in the Foundrise week, Theo starting a comment on t-2, and Sana writing a line
   in the launch brief then saving it as her (in the demo's memory) — each once per page load. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectDoc, resetDemoDocs, subscribeProjectDocs } from "../../lib/docs";
import { parseWireBatch } from "../../lib/presence";
import type { TransportHandlers } from "./core";
import { demoTransport } from "./demoPeers";

const handlers = () => {
  const h = { self: "me", onSync: vi.fn(), onBroadcast: vi.fn(), onStatus: vi.fn() } satisfies TransportHandlers;
  return h;
};
const lastSync = (h: ReturnType<typeof handlers>) => (h.onSync.mock.calls[h.onSync.mock.calls.length - 1]?.[0] ?? []) as { userId: string; taskId?: string | null; docId?: string | null; state: string }[];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00")); resetDemoDocs(); });
afterEach(() => { vi.useRealTimers(); });

describe("the demo's teammates", () => {
  it("Maya has t-1 open; nobody's on a quiet task", async () => {
    const h = handlers();
    const ch = demoTransport().open("kanbo:task:t-1", h);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.onStatus).toHaveBeenCalledWith("live");
    expect(lastSync(h).map((e) => e.userId)).toEqual(["m-1"]);
    ch.close();
    const q = handlers();
    demoTransport().open("kanbo:task:t-9", q);
    await vi.advanceTimersByTimeAsync(400);
    expect(lastSync(q)).toEqual([]);
  });
  it("the launch project knows who has which task or doc open; your own presence comes back to you", async () => {
    const h = handlers();
    const ch = demoTransport().open("kanbo:project:p-launch", h);
    await vi.advanceTimersByTimeAsync(400);
    expect(lastSync(h).map((e) => [e.userId, e.taskId ?? e.docId])).toEqual([["m-1", "t-1"], ["m-2", "t-2"], ["m-3", "doc-launch-brief"]]);
    ch.track({ userId: "m-self", name: "Daniel Okai", color: "", clientId: "me", state: "viewing", at: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastSync(h).map((e) => e.userId)).toContain("m-self");
  });
  it("Theo starts a comment on t-2 (once), then stops", async () => {
    const h = handlers();
    const ch = demoTransport().open("kanbo:task:t-2", h);
    await vi.advanceTimersByTimeAsync(7000);
    const typing = h.onBroadcast.mock.calls.filter(([e]) => e === "typing").map(([, p]) => (p as { on: boolean; userId: string }));
    expect(typing.map((p) => p.on)).toEqual([true, true, true, false]);
    expect(typing.every((p) => p.userId === "m-2")).toBe(true);
    ch.close();
    const again = handlers();
    demoTransport().open("kanbo:task:t-2", again);
    await vi.advanceTimersByTimeAsync(7000);
    expect(again.onBroadcast.mock.calls.filter(([e]) => e === "typing")).toEqual([]);
  });
  it("Sana writes a line under the brief's last block, letter by letter, then saves it as her", async () => {
    const pings: { updatedBy: string | null }[] = [];
    const off = subscribeProjectDocs("p-launch", (c) => pings.push(c));
    const h = handlers();
    demoTransport().open("kanbo:doc:doc-launch-brief", h);
    await vi.advanceTimersByTimeAsync(20_000);
    const batches = h.onBroadcast.mock.calls.filter(([e]) => e === "ops").map(([, p]) => parseWireBatch(p));
    expect(batches.every(Boolean)).toBe(true);
    expect(batches[0]!.ops[0]).toMatchObject({ t: "insert", block: { type: "bullet" } });
    const last = batches[batches.length - 1]!.ops[0];
    expect(last.t === "update" && last.block.spans?.[0]?.text).toBe("Legal have the pricing page copy; sign-off is booked for Wednesday.");
    expect(h.onBroadcast.mock.calls.some(([e]) => e === "caret")).toBe(true);
    const saved = await getProjectDoc("doc-launch-brief");
    expect(saved!.updatedBy).toBe("m-3");
    expect(saved!.body[saved!.body.length - 1].spans?.[0]?.text).toMatch(/^Legal have/);
    expect(pings.some((p) => p.updatedBy === "m-3")).toBe(true);
    off();
  });
});
