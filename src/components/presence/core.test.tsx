/* The presence hub and its hooks over an in-memory Realtime: who's here (never you, one face per person),
   leaving, fading, the shared channel, the project channel's "who has which task", typing, and being alone. */
import { act, render, renderHook } from "@testing-library/react";
import { memo, type ReactNode } from "react";
import type { PresencePeer } from "../../data/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPresenceClient, parseCaret, parseWirePresence, peerHue, PRESENCE_HEARTBEAT_MS, PRESENCE_LEAVE_GRACE_MS, PRESENCE_STALE_MS,
  PresenceContext, presenceKey, presenceMeFrom, presenceSentence, shortNames, toPeers, TYPING_THROTTLE_MS, TYPING_TTL_MS,
  usePresence, useProjectPresence, useTyping, type PresenceClient, type PresenceMe, type PresenceTransport,
} from "./core";
import { createMemoryBus, type MemoryBus } from "./memoryTransport";

const sana: PresenceMe = { userId: "u-sana", name: "Sana Rao", color: "oklch(0.74 0.16 305)" };
const theo: PresenceMe = { userId: "u-theo", name: "Theo Vance", color: "oklch(0.78 0.15 70)" };
const daniel: PresenceMe = { userId: "u-dan", name: "Daniel Okai", color: "oklch(0.72 0.14 264)" };

let bus: MemoryBus;
const tab = (id: string) => createPresenceClient(bus.transport(), { clientId: id, visibility: false });
const wrap = (client: PresenceClient | null) => ({ children }: { children: ReactNode }) => <PresenceContext.Provider value={client}>{children}</PresenceContext.Provider>;
const settle = async (ms = 0) => { await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  bus = createMemoryBus();
});
afterEach(() => { vi.useRealTimers(); });

describe("words", () => {
  it("says who's here", () => {
    expect(presenceSentence([])).toBe("");
    expect(presenceSentence([sana])).toBe("Sana is viewing");
    expect(presenceSentence([sana, theo])).toBe("Sana and Theo are viewing");
    expect(presenceSentence([sana, theo, daniel], "editing")).toBe("Sana, Theo and Daniel are editing");
    expect(presenceSentence([sana, theo, daniel, { name: "Maya Lin" }, { name: "Idris Bell" }], "typing")).toBe("Sana, Theo and 3 others are typing");
  });
  it("first names, unless two people share one", () => {
    expect(shortNames([{ name: "Sana Rao" }, { name: "Sana Patel" }, { name: "Theo Vance" }])).toEqual(["Sana Rao", "Sana Patel", "Theo"]);
  });
  it("you, from the people the app has", () => {
    expect(presenceMeFrom([{ id: "u-sana", name: "Sana Rao", color: "red" }], "u-sana")).toEqual({ userId: "u-sana", name: "Sana Rao", color: "red" });
    expect(presenceMeFrom([], "u-x")).toBeNull();
    expect(presenceMeFrom([], "u-x", "A guest")).toEqual({ userId: "u-x", name: "A guest", color: "" });
    expect(presenceMeFrom([], null)).toBeNull();
  });
  it("only a hue reaches CSS (a grey or odd colour is navy)", () => {
    expect(peerHue("oklch(0.74 0.16 305)")).toBe(305);
    expect(peerHue("oklch(0.5 0 0)")).toBe(268);
    expect(peerHue("url(https://evil.example/x)")).toBe(268);
    expect(peerHue("")).toBe(268);
  });
});

describe("what comes in on the wire is checked", () => {
  it("presence entries: ids, a name, a known state; nothing else survives", () => {
    expect(parseWirePresence({ userId: "u1", name: "  Sana\u0000 Rao ", color: "oklch(0.7 0.1 30)", clientId: "c1", state: "editing", at: 1, email: "sana@x", caret: { blockId: "b1", offset: 3 } }))
      .toEqual({ userId: "u1", name: "Sana Rao", color: "oklch(0.7 0.1 30)", clientId: "c1", state: "editing", at: 1, caret: { blockId: "b1", offset: 3 } });
    expect(parseWirePresence({ userId: "u1", name: "", clientId: "c1" })).toBeNull();
    expect(parseWirePresence({ userId: "<script>", name: "x", clientId: "c1" })).toBeNull();
    expect(parseWirePresence({ userId: "u1", name: "x", clientId: "c1", state: "hacking", color: "red;background:url(x)" })).toMatchObject({ state: "viewing", color: "" });
    expect(parseWirePresence("nope")).toBeNull();
  });
  it("carets", () => {
    expect(parseCaret({ blockId: "b1", offset: 2, extent: 3 })).toEqual({ blockId: "b1", offset: 2, extent: 3 });
    expect(parseCaret({ blockId: "b1", offset: -1 })).toBeNull();
    expect(parseCaret({ blockId: "b1", offset: 1.5 })).toBeNull();
    expect(parseCaret({ blockId: "b1", offset: 0, extent: 0 })).toEqual({ blockId: "b1", offset: 0 });
  });
  it("peers: never you (any of your tabs), one per person, the liveliest tab", () => {
    const e = (userId: string, clientId: string, state: "viewing" | "editing" | "typing", seenAt = 1) => ({ userId, name: userId, color: "", clientId, state, at: 0, seenAt });
    const peers = toPeers([e("u-sana", "a", "viewing"), e("u-dan", "b", "editing"), e("u-sana", "c", "editing", 5), e("u-theo", "d", "viewing")], "u-dan");
    expect(peers.map((p) => [p.userId, p.state, p.at])).toEqual([["u-sana", "editing", 5], ["u-theo", "viewing", 1]]);
  });
});

describe("usePresence", () => {
  it("each sees the other, never themselves; leaving takes them away", async () => {
    const a = tab("tab-a"), b = tab("tab-b");
    const key = presenceKey("task", "t1");
    const ha = renderHook(() => usePresence(key, sana), { wrapper: wrap(a) });
    const hb = renderHook(() => usePresence(key, theo), { wrapper: wrap(b) });
    await settle();
    expect(ha.result.current.peers.map((p) => p.name)).toEqual(["Theo Vance"]);
    expect(hb.result.current.peers.map((p) => [p.name, p.state])).toEqual([["Sana Rao", "viewing"]]);
    hb.unmount();
    await settle(PRESENCE_LEAVE_GRACE_MS + 10);
    expect(ha.result.current.peers).toEqual([]);
    expect(bus.open("kanbo:task:t1")).toBe(1);
  });

  it("your two tabs are one face to others, and none to you", async () => {
    const key = presenceKey("doc", "d1");
    const a1 = renderHook(() => usePresence(key, sana), { wrapper: wrap(tab("s1")) });
    renderHook(() => usePresence(key, sana), { wrapper: wrap(tab("s2")) });
    const t = renderHook(() => usePresence(key, theo), { wrapper: wrap(tab("t1")) });
    await settle();
    expect(t.result.current.peers.map((p) => p.userId)).toEqual(["u-sana"]);
    expect(a1.result.current.peers.map((p) => p.userId)).toEqual(["u-theo"]);
  });

  it("someone whose heartbeat stops fades after PRESENCE_STALE_MS; a beating peer stays", async () => {
    const key = presenceKey("task", "t2");
    const silent: PresenceTransport = {
      open(topic, h) {
        const real = bus.transport().open(topic, h);
        let once = false;
        // tracks once, then never again (a laptop lid closed without a goodbye)
        return { ...real, track: (s) => { if (!once) { once = true; real.track(s); } } };
      },
    };
    const ghost = createPresenceClient(silent, { clientId: "ghost", visibility: false });
    const h = renderHook(() => usePresence(key, sana), { wrapper: wrap(tab("me")) });
    renderHook(() => usePresence(key, theo), { wrapper: wrap(ghost) });
    renderHook(() => usePresence(key, daniel), { wrapper: wrap(tab("dan")) });
    await settle();
    expect(h.result.current.peers.map((p) => p.userId).sort()).toEqual(["u-dan", "u-theo"]);
    for (let t = 0; t < PRESENCE_STALE_MS + PRESENCE_HEARTBEAT_MS; t += PRESENCE_HEARTBEAT_MS / 3) await settle(PRESENCE_HEARTBEAT_MS / 3);
    expect(h.result.current.peers.map((p) => p.userId)).toEqual(["u-dan"]);
  });

  it("a connection knows how many other tabs are there — faded ones too (they still receive) — once the channel has said", async () => {
    const key = presenceKey("doc", "d9");
    const silent: PresenceTransport = {
      open(topic, h) {
        const real = bus.transport().open(topic, h);
        let once = false;
        return { ...real, track: (s) => { if (!once) { once = true; real.track(s); } } };
      },
    };
    const me = tab("me");
    const conn = me.join(key, { me: sana, contribute: () => ({ state: "viewing" }) });
    expect(conn.others).toBeNull(); // (not up yet)
    await settle();
    expect(conn.others).toBe(0);
    const ghost = createPresenceClient(silent, { clientId: "ghost", visibility: false });
    ghost.join(key, { me: theo, contribute: () => ({ state: "viewing" }) });
    await settle();
    expect(conn.others).toBe(1);
    // its beat stops: it fades from the faces, but it's still on the channel
    for (let t = 0; t < PRESENCE_STALE_MS + PRESENCE_HEARTBEAT_MS; t += PRESENCE_HEARTBEAT_MS / 3) await settle(PRESENCE_HEARTBEAT_MS / 3);
    expect(conn.others).toBe(1);
    conn.leave();
    expect(conn.others).toBeNull();
  });

  it("one channel per object per tab, shared by every hook; a quick close and re-open keeps it", async () => {
    const a = tab("one");
    const key = presenceKey("task", "t3");
    const h1 = renderHook(() => usePresence(key, sana), { wrapper: wrap(a) });
    const h2 = renderHook(() => useTyping("t3", sana), { wrapper: wrap(a) });
    await settle();
    expect(bus.opened("kanbo:task:t3")).toBe(1);
    h1.unmount(); h2.unmount();
    await settle(PRESENCE_LEAVE_GRACE_MS / 2);
    renderHook(() => usePresence(key, sana), { wrapper: wrap(a) });
    await settle(PRESENCE_LEAVE_GRACE_MS * 2);
    expect(bus.opened("kanbo:task:t3")).toBe(1);
    expect(bus.open("kanbo:task:t3")).toBe(1);
  });

  it("refused (no Realtime policies), no hub (tests, offline) or no key: alone, quietly", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    bus.refuse.add("kanbo:task:t4");
    const a = renderHook(() => usePresence(presenceKey("task", "t4"), sana), { wrapper: wrap(tab("r1")) });
    renderHook(() => usePresence(presenceKey("task", "t4"), theo), { wrapper: wrap(tab("r2")) });
    await settle();
    expect(a.result.current.peers).toEqual([]);
    const b = renderHook(() => usePresence(presenceKey("task", "t4"), sana), { wrapper: wrap(null) });
    expect(b.result.current.peers).toEqual([]);
    const c = renderHook(() => usePresence(null, sana), { wrapper: wrap(tab("r3")) });
    expect(c.result.current.peers).toEqual([]);
  });
});

describe("the project channel: who has which task open", () => {
  it("a task panel says so on its project; the list sees it per row", async () => {
    const list = renderHook(() => useProjectPresence("p1", daniel), { wrapper: wrap(tab("list")) });
    renderHook(() => usePresence(presenceKey("task", "t9"), sana, { projectId: "p1" }), { wrapper: wrap(tab("panel")) });
    renderHook(() => useProjectPresence("p1", theo), { wrapper: wrap(tab("theo")) });
    await settle();
    expect(list.result.current.viewersOf("t9").map((p) => p.name)).toEqual(["Sana Rao"]);
    expect(list.result.current.viewersOf("t1")).toEqual([]);
    expect(list.result.current.peers.map((p) => p.userId).sort()).toEqual(["u-sana", "u-theo"]);
  });
  it("a heartbeat that changes nothing visible re-renders neither the list nor its rows; someone else's task leaves a row alone", async () => {
    const counts = { list: 0, t1: 0, t2: 0 };
    const Row = memo(function Row({ id, viewers }: { id: string; viewers: PresencePeer[] }) {
      counts[id as "t1" | "t2"]++;
      return <li>{id}:{viewers.length}</li>;
    });
    function List() {
      counts.list++;
      const { viewersOf } = useProjectPresence("p9", daniel, { watchOnly: true });
      return <ul>{["t1", "t2"].map((id) => <Row key={id} id={id} viewers={viewersOf(id)} />)}</ul>;
    }
    render(<PresenceContext.Provider value={tab("dan")}><List /></PresenceContext.Provider>);
    const theoOn = (taskId: string) => renderHook(() => usePresence(presenceKey("task", taskId), theo, { projectId: "p9" }), { wrapper: wrap(tab("theo")) });
    theoOn("t1");
    await settle(10);
    await settle(1000); // (everyone's first track has gone round)
    const before = { ...counts };
    for (let i = 0; i < 4; i++) await settle(PRESENCE_HEARTBEAT_MS);
    expect(counts).toEqual(before);
    // Sana opens t2: the list and t2's row change; t1's row (Theo, still) doesn't
    renderHook(() => usePresence(presenceKey("task", "t2"), sana, { projectId: "p9" }), { wrapper: wrap(tab("sana")) });
    await settle(10);
    expect(counts.list).toBeGreaterThan(before.list);
    expect(counts.t2).toBeGreaterThan(before.t2);
    expect(counts.t1).toBe(before.t1);
  });

  it("rows elsewhere (My tasks, Today) watch without saying you're in the project", async () => {
    const panel = renderHook(() => useProjectPresence("p3", sana), { wrapper: wrap(tab("p3-sana")) });
    const rows = renderHook(() => useProjectPresence("p3", theo, { watchOnly: true }), { wrapper: wrap(tab("p3-theo")) });
    renderHook(() => usePresence(presenceKey("task", "t10"), daniel, { projectId: "p3" }), { wrapper: wrap(tab("p3-dan")) });
    await settle();
    expect(rows.result.current.viewersOf("t10").map((p) => p.name)).toEqual(["Daniel Okai"]);
    expect(panel.result.current.peers.map((p) => p.userId)).toEqual(["u-dan"]);
  });
  it("your own open task never shows on your rows", async () => {
    const list = renderHook(() => useProjectPresence("p2", sana, { taskId: "t5" }), { wrapper: wrap(tab("me-list")) });
    renderHook(() => usePresence(presenceKey("task", "t5"), sana, { projectId: "p2" }), { wrapper: wrap(tab("me-panel")) });
    await settle();
    expect(list.result.current.viewersOf("t5")).toEqual([]);
  });
});

describe("useTyping", () => {
  it("throttled out, shown in, dropped after TYPING_TTL_MS of silence or when they stop", async () => {
    const a = tab("ta"), b = tab("tb");
    const ha = renderHook(() => useTyping("t7", sana), { wrapper: wrap(a) });
    const hb = renderHook(() => useTyping("t7", theo), { wrapper: wrap(b) });
    await settle();
    act(() => { for (let i = 0; i < 10; i++) ha.result.current.notifyTyping(); });
    expect(bus.sent.filter(([, e]) => e === "typing")).toHaveLength(1);
    await settle(10);
    expect(hb.result.current.typers.map((t) => [t.name, t.state])).toEqual([["Sana Rao", "typing"]]);
    expect(ha.result.current.typers).toEqual([]); // never yourself
    await settle(TYPING_THROTTLE_MS + 10);
    act(() => ha.result.current.notifyTyping());
    expect(bus.sent.filter(([, e]) => e === "typing")).toHaveLength(2);
    // they stop: gone at once
    act(() => ha.result.current.stopTyping());
    await settle(10);
    expect(hb.result.current.typers).toEqual([]);
    // they type once and go quiet: the "stopped" goes out by itself, and the line clears
    act(() => ha.result.current.notifyTyping());
    await settle(10);
    expect(hb.result.current.typers).toHaveLength(1);
    await settle(TYPING_TTL_MS + 10);
    expect(hb.result.current.typers).toEqual([]);
  });
  it("…and when the panel closes mid-word", async () => {
    const ha = renderHook(() => useTyping("t8", sana), { wrapper: wrap(tab("x1")) });
    const hb = renderHook(() => useTyping("t8", theo), { wrapper: wrap(tab("x2")) });
    await settle();
    act(() => ha.result.current.notifyTyping());
    await settle(10);
    expect(hb.result.current.typers).toHaveLength(1);
    ha.unmount();
    await settle(10);
    expect(hb.result.current.typers).toEqual([]);
  });
  it("a typing line doesn't count as being on the task", async () => {
    const watcher = renderHook(() => usePresence(presenceKey("task", "t6"), theo), { wrapper: wrap(tab("w")) });
    renderHook(() => useTyping("t6", sana), { wrapper: wrap(tab("y")) });
    await settle();
    expect(watcher.result.current.peers).toEqual([]);
  });
});
