/* Two people in one doc (two editors, each its own tab on an in-memory Realtime, one mocked server): edits to
   different blocks merge both ways, the same block is last writer wins (and said so), the other's caret and
   name show, a save merges into the other editor without the banner (and what's theirs still saves, on top),
   undo only takes back your own words, a guest sees it all and sends nothing. A tab whose channel drops misses
   what's sent meanwhile: back, it catches up before anything it typed goes out — words typed on its old copy
   never write over a save it missed (the banner is its own), and a batch made on an old save is refused. While
   you type the caret rides in the batch; alone, nothing goes out. */
import { createRef, type ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocBlock, DocSaveInput, ProjectDoc } from "../../data/types";
import { MEMBERS, TASKS } from "../../data/data";
import { blockSig, hashText } from "../../lib/presence";

type Ping = { type: "UPDATE" | "DELETE"; docId: string; updatedAt: string | null; updatedBy: string | null };
const { server, saves, gets, listeners, muted } = vi.hoisted(() => ({
  server: { doc: null as unknown as ProjectDoc, n: 0 },
  saves: [] as DocSaveInput[],
  gets: { count: 0, delay: 0 },
  listeners: [] as ((c: Ping) => void)[],
  /** pings a dropped tab doesn't get (Realtime's database changes share its socket) */
  muted: new Set<(c: Ping) => void>(),
}));
vi.mock("../../lib/docs", async (orig) => ({
  ...(await orig<typeof import("../../lib/docs")>()),
  // the server: optimistic concurrency on updatedAt, and a realtime ping to everyone after each save
  saveProjectDoc: async (i: DocSaveInput) => {
    saves.push(JSON.parse(JSON.stringify(i)));
    if (i.baseUpdatedAt !== server.doc.updatedAt) return { status: "conflict", doc: server.doc };
    const updatedAt = new Date(Date.parse(server.doc.updatedAt) + 60_000 * ++server.n).toISOString();
    server.doc = { ...server.doc, title: i.title.trim(), body: JSON.parse(JSON.stringify(i.body)), updatedAt, updatedBy: "m-x", updatedByName: "Someone" };
    const saved = server.doc;
    // (a tab cut off when the save lands never gets this ping: Realtime doesn't replay it)
    const deaf = new Set(muted);
    setTimeout(() => listeners.forEach((l) => { if (!deaf.has(l)) l({ type: "UPDATE", docId: saved.id, updatedAt: saved.updatedAt, updatedBy: "m-x" }); }), 0);
    return { status: "saved", doc: saved };
  },
  // (what the server held when asked; the answer can take a while)
  getProjectDoc: async () => { gets.count++; const d = server.doc; if (gets.delay) await new Promise((r) => setTimeout(r, gets.delay)); return d; },
  subscribeProjectDocs: (_p: string, fn: (c: Ping) => void) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
}));

import { DocEditor, type DocEditorHandle } from "./DocEditor";
import { setSelectionOffsets } from "./docDom";
import { createPresenceClient, PresenceContext, PRESENCE_LEAVE_GRACE_MS, type PresenceTransport, type TransportHandlers } from "../presence/core";
import { createMemoryBus, type MemoryBus } from "../presence/memoryTransport";

const base: ProjectDoc = {
  id: "d1", projectId: "p-launch", workspaceId: "ws-foundrise", title: "Brief",
  body: [{ id: "a", type: "p", spans: [{ text: "start" }] }, { id: "b", type: "p", spans: [{ text: "second" }] }],
  icon: null, position: 1, mentions: [], createdBy: "m-self", createdByName: "Daniel Okai", updatedBy: "m-self", updatedByName: "Daniel Okai",
  createdAt: "2026-10-09T09:00:00.000Z", updatedAt: "2026-10-09T09:00:00.000Z", archivedAt: null, canEdit: true,
};

/** a transport whose connection can drop (nothing in or out) and come back, as a laptop's wifi does */
function flaky(inner: PresenceTransport) {
  const hs: TransportHandlers[] = [];
  let down = false;
  const transport: PresenceTransport = {
    open(topic, h) {
      hs.push(h);
      const ch = inner.open(topic, {
        self: h.self,
        onSync: (e) => { if (!down) h.onSync(e); },
        onBroadcast: (ev, p) => { if (!down) h.onBroadcast(ev, p); },
        onStatus: (st) => { if (!down) h.onStatus(st); },
      });
      return { track: (st) => { if (!down) ch.track(st); }, untrack: () => ch.untrack(), send: (e, p) => (down ? false : ch.send(e, p)), close: () => ch.close() };
    },
  };
  return { transport, drop() { down = true; hs.forEach((h) => h.onStatus("down")); }, back() { down = false; hs.forEach((h) => h.onStatus("live")); } };
}

let bus: MemoryBus;
function editor(userId: string, clientId: string, opts: { readOnly?: boolean; transport?: PresenceTransport } = {}) {
  const ref = createRef<DocEditorHandle>();
  const client = createPresenceClient(opts.transport ?? bus.transport(), { clientId, visibility: false });
  const wrap = (children: ReactNode) => <PresenceContext.Provider value={client}>{children}</PresenceContext.Provider>;
  const utils = render(wrap(<DocEditor ref={ref} doc={base} members={MEMBERS} tasks={TASKS} currentUserId={userId} readOnly={!!opts.readOnly}
    onMakeTask={vi.fn()} onOpenTask={vi.fn()} />));
  const blocks = () => Array.from(utils.container.querySelectorAll<HTMLElement>(".kdoc-blocks .kdoc-text"));
  const text = (i: number) => blocks()[i]?.textContent ?? "";
  /** (focus: false — typing without taking the focus from the other tab, whose blur would save) */
  const type = (i: number, value: string, o: { focus?: boolean } = {}) => {
    const el = blocks()[i];
    el.textContent = value;
    if (o.focus !== false) { act(() => el.focus()); setSelectionOffsets(el, value.length); }
    fireEvent.input(el, { data: value.slice(-1), inputType: "insertText" });
  };
  const status = () => utils.container.querySelector(".kdoc-editor > p[role='status']")?.textContent ?? "";
  const banner = () => utils.container.querySelector(".kdoc-banner[role='alert']");
  return { ...utils, ref, client, blocks, text, type, status, banner, view: () => within(utils.container) };
}
const savedTexts = () => server.doc.body.map((b: DocBlock) => b.spans?.[0]?.text ?? "");
/** let the throttled batches go out and arrive, timers and promises both */
const tick = async (ms = 200) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  bus = createMemoryBus();
  server.doc = base; server.n = 0;
  saves.length = 0; gets.count = 0; gets.delay = 0; listeners.length = 0; muted.clear();
  sessionStorage.clear();
});
afterEach(() => { vi.useRealTimers(); });

describe("two people in one doc", () => {
  it("edits to different blocks merge both ways, no banner; the other's block flashes their name; who's here shows", async () => {
    const dan = editor("m-self", "tab-dan");
    const sana = editor("m-3", "tab-sana");
    await tick();
    // who's here, beside the title
    expect(dan.view().getByRole("img", { name: /^Sana is (viewing|editing)$/ })).toBeInTheDocument();
    expect(sana.view().getByRole("img", { name: /^Daniel is (viewing|editing)$/ })).toBeInTheDocument();

    dan.type(0, "start, Daniel's");
    sana.type(1, "second, Sana's");
    await tick();
    expect([dan.text(0), dan.text(1)]).toEqual(["start, Daniel's", "second, Sana's"]);
    expect([sana.text(0), sana.text(1)]).toEqual(["start, Daniel's", "second, Sana's"]);
    // the block flashes, and the name shows (on the tag, or on their caret's flag while it's still there)
    expect(dan.container.querySelector(".kpres-edit")).toBeInTheDocument();
    expect(dan.container.querySelector(".kpres-layer")).toHaveTextContent("Sana");
    expect(sana.container.querySelector(".kpres-edit")).toBeInTheDocument();
    expect(dan.blocks()[1]).toHaveAttribute("aria-description", "Edited by Sana Rao just now");
    expect(dan.status()).toMatch(/Sana (opened this doc|is making changes to this doc)\./);
    expect(screen.queryByRole("alert")).toBeNull();
    // the highlight fades
    await tick(3000);
    expect(dan.container.querySelector(".kpres-edit")).toBeNull();
  });

  it("the same block at the same moment: one version wins on both screens, and the loser hears why", async () => {
    const dan = editor("m-self", "tab-dan");
    const sana = editor("m-3", "tab-sana");
    await tick();
    // (both batches leave before either arrives: as two laptops typing at once)
    bus.pause();
    dan.type(0, "Daniel's take");
    sana.type(0, "Sana's take");
    await tick();
    bus.flush();
    await tick();
    expect(dan.text(0)).toBe(sana.text(0));
    const lost = dan.text(0) === "Sana's take" ? dan : sana;
    const won = lost === dan ? sana : dan;
    expect(lost.status()).toMatch(/changed the line you were writing at the same moment\. Their version is in\./);
    expect(won.status()).not.toMatch(/changed the line you were writing/);
    expect(lost.container.querySelector(".kpres-edit")).toBeInTheDocument();
  });

  it("someone's save merges into the other editor without the banner, and what's only theirs saves on top", async () => {
    const dan = editor("m-self", "tab-dan");
    const sana = editor("m-3", "tab-sana");
    await tick();
    dan.type(0, "start, Daniel's");
    await tick();
    // Sana writes, and Daniel saves before her words reach him
    bus.pause();
    sana.type(1, "second, Sana's");
    await act(async () => { await dan.ref.current!.flush(); });
    expect(saves).toHaveLength(1);
    expect(saves[0].body.map((b: DocBlock) => b.spans?.[0]?.text)).toEqual(["start, Daniel's", "second"]);
    const v1 = server.doc.updatedAt;
    await tick(1000); // the ping: Sana merges Daniel's save (his words she has; hers stay) and saves hers on his copy
    bus.flush();
    await act(async () => { await sana.ref.current!.flush(); });
    expect(screen.queryByRole("alert")).toBeNull();
    const hers = saves[saves.length - 1];
    expect(hers.baseUpdatedAt).toBe(v1);
    expect(hers.body.map((b: DocBlock) => b.spans?.[0]?.text)).toEqual(["start, Daniel's", "second, Sana's"]);
    await tick(1000);
    expect([dan.text(0), dan.text(1)]).toEqual(["start, Daniel's", "second, Sana's"]);
    expect(dan.ref.current!.pending).toBe(false);
  });

  it("a save that's exactly what's here is taken from the 'saved' notice: no fetch, nothing to save", async () => {
    const dan = editor("m-self", "tab-dan");
    const sana = editor("m-3", "tab-sana");
    await tick();
    // (each catches up once on joining)
    expect(gets.count).toBe(2);
    gets.count = 0;
    dan.type(0, "start, Daniel's");
    await tick();
    await act(async () => { await dan.ref.current!.flush(); });
    await tick(1000);
    expect(gets.count).toBe(0);
    expect(sana.ref.current!.pending).toBe(false);
    // her next words save on his version
    const his = server.doc.updatedAt;
    sana.type(1, "second, Sana's");
    await act(async () => { await sana.ref.current!.flush(); });
    expect(saves).toHaveLength(2);
    expect(saves[1].baseUpdatedAt).toBe(his);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("undo only takes back your own words", async () => {
    const dan = editor("m-self", "tab-dan");
    const sana = editor("m-3", "tab-sana");
    await tick();
    dan.type(0, "start, Daniel's");
    await tick(1500);
    sana.type(1, "second, Sana's");
    await tick();
    expect(dan.text(1)).toBe("second, Sana's");
    act(() => dan.blocks()[0].focus());
    fireEvent.keyDown(dan.blocks()[0], { key: "z", metaKey: true, ctrlKey: true });
    expect(dan.text(0)).toBe("start");
    expect(dan.text(1)).toBe("second, Sana's");
    await tick();
    // and the undo reaches Sana as Daniel's edit
    expect(sana.text(0)).toBe("start");
    expect(sana.text(1)).toBe("second, Sana's");
  });

  it("a guest sees edits and the others live, and never sends a word", async () => {
    const dan = editor("m-self", "tab-dan");
    const guest = editor("m-4", "tab-guest", { readOnly: true });
    await tick();
    expect(guest.view().getByRole("img", { name: /^Daniel is (viewing|editing)$/ })).toBeInTheDocument();
    dan.type(1, "second, live");
    await tick();
    expect(guest.container.querySelector(".kdoc-view")).toHaveTextContent("second, live");
    expect(bus.sent.filter(([, event, p]) => event === "ops" && p.clientId === "tab-guest")).toEqual([]);
    expect(bus.sent.filter(([, event, p]) => (event === "caret" || event === "saved") && p.clientId === "tab-guest")).toEqual([]);
  });

  it("someone leaving takes their face away; alone, the editor is as it always was", async () => {
    const dan = editor("m-self", "tab-dan");
    const sana = editor("m-3", "tab-sana");
    await tick();
    expect(dan.view().queryByRole("img", { name: /Sana/ })).toBeInTheDocument();
    sana.unmount();
    await tick(PRESENCE_LEAVE_GRACE_MS + 50);
    expect(dan.view().queryByRole("img", { name: /Sana/ })).toBeNull();
    expect(dan.status()).toMatch(/Sana left this doc\.|Sana opened this doc\./);
    dan.type(0, "alone now");
    await act(async () => { await dan.ref.current!.flush(); });
    expect(saves[saves.length - 1].body[0].spans?.[0]?.text).toBe("alone now");
  });

  it("typing on goes on as one undo step while someone else types in another line", async () => {
    const dan = editor("m-self", "tab-dan");
    const sana = editor("m-3", "tab-sana");
    await tick();
    dan.type(0, "start x"); await tick(100);
    sana.type(1, "second 1"); await tick(200);
    dan.type(0, "start xy"); await tick(100);
    sana.type(1, "second 12"); await tick(200);
    dan.type(0, "start xyz"); await tick(100);
    act(() => dan.blocks()[0].focus());
    fireEvent.keyDown(dan.blocks()[0], { key: "z", metaKey: true, ctrlKey: true });
    expect(dan.text(0)).toBe("start");
    expect(dan.text(1)).toBe("second 12");
  });
});

describe("a tab cut off, then back", () => {
  /** Sana's channel drops (and her pings with it); Daniel saves new words in the first line meanwhile */
  const cutOff = async () => {
    const dan = editor("m-self", "tab-dan");
    const net = flaky(bus.transport());
    const sana = editor("m-3", "tab-sana", { transport: net.transport });
    await tick();
    const sanaPing = listeners[1];
    const drop = () => { net.drop(); muted.add(sanaPing); };
    const back = () => { net.back(); muted.delete(sanaPing); };
    drop();
    await tick();
    return { dan, sana, drop, back };
  };
  const danSaves = async (dan: ReturnType<typeof editor>) => {
    dan.type(0, "start, Daniel's careful wording");
    await tick();
    await act(async () => { await dan.ref.current!.flush(); });
    expect(savedTexts()[0]).toBe("start, Daniel's careful wording");
  };

  it("words typed on the old copy never write over the save it missed: the banner is hers, his words stay everywhere", async () => {
    const { dan, sana, back } = await cutOff();
    await danSaves(dan);
    await tick(30_000);
    sana.type(0, "Start");
    await tick(500);
    back(); // (before her autosave)
    await tick(300);
    expect(dan.text(0)).toBe("start, Daniel's careful wording");
    expect(dan.banner()).toBeNull();
    expect(sana.banner()).toHaveTextContent(/edited this/);
    // Daniel goes on in another line: it reaches her live; nothing of her clash reaches him or the server
    dan.type(1, "second, more from Daniel");
    await act(async () => { await dan.ref.current!.flush(); });
    await tick(5000);
    expect(savedTexts()).toEqual(["start, Daniel's careful wording", "second, more from Daniel"]);
    expect(sana.text(1)).toBe("second, more from Daniel");
    expect(sana.banner()).not.toBeNull();
    expect(dan.text(0)).toBe("start, Daniel's careful wording");
  });

  it("with her banner already up, coming back sends nothing; Keep mine then puts hers on top, live and saved", async () => {
    const { dan, sana, back } = await cutOff();
    await danSaves(dan);
    const v1 = server.doc.updatedAt;
    sana.type(0, "Start");
    await tick(3000); // her autosave: refused (his save came first) — the banner
    expect(sana.banner()).not.toBeNull();
    back();
    await tick(300);
    expect(dan.text(0)).toBe("start, Daniel's careful wording");
    dan.type(1, "second, Daniel again");
    await act(async () => { await dan.ref.current!.flush(); });
    await tick(1000);
    expect(savedTexts()[0]).toBe("start, Daniel's careful wording");
    expect(sana.banner()).not.toBeNull();
    // she answers: hers
    fireEvent.click(sana.view().getByRole("button", { name: "Keep mine" }));
    await tick(300);
    expect(dan.text(0)).toBe("Start");
    const hers = saves[saves.length - 1];
    expect((hers as DocSaveInput & { checkpoint?: boolean }).checkpoint).toBe(true);
    expect(hers.baseUpdatedAt).not.toBe(v1); // (on his latest copy)
    expect(savedTexts()[0]).toBe("Start");
    await tick(2000);
    expect(dan.banner()).toBeNull();
    expect(dan.ref.current!.pending).toBe(false);
    expect(sana.text(1)).toBe("second, Daniel again");
  });

  it("words typed while cut off that don't clash: the save she missed comes in, hers go out once she's caught up — no banner", async () => {
    const { dan, sana, back } = await cutOff();
    await danSaves(dan);
    sana.type(1, "second, Sana's while away");
    await tick(500);
    back();
    await tick(300);
    expect(sana.text(0)).toBe("start, Daniel's careful wording");
    expect(dan.text(1)).toBe("second, Sana's while away");
    expect(sana.banner()).toBeNull();
    expect(dan.banner()).toBeNull();
    await act(async () => { await sana.ref.current!.flush(); });
    expect(savedTexts()).toEqual(["start, Daniel's careful wording", "second, Sana's while away"]);
  });

  it("what she saved while cut off isn't sent again live over the words he has typed since", async () => {
    const { dan, sana, back } = await cutOff();
    sana.type(0, "start, Sana's");
    await act(async () => { await sana.ref.current!.flush(); }); // (her REST works: only Realtime dropped)
    await tick(500); // the ping: Daniel merges her save
    expect(dan.text(0)).toBe("start, Sana's");
    dan.type(0, "start, Sana's — and Daniel's on top");
    await tick(300);
    back();
    await tick(300);
    expect(dan.text(0)).toBe("start, Sana's — and Daniel's on top");
    await tick(3000); // his autosave, and the ping to her
    expect(sana.text(0)).toBe("start, Sana's — and Daniel's on top");
    expect(sana.banner()).toBeNull();
    expect(dan.banner()).toBeNull();
  });

  it("cut off again while catching up: that catch-up doesn't count; it catches up again before anything goes out", async () => {
    const { dan, sana, drop, back } = await cutOff();
    await danSaves(dan);
    sana.type(1, "second, Sana's while away");
    await tick(300);
    gets.delay = 1000;
    back();
    await tick(200); // (her catch-up is still fetching his first save)
    drop();
    dan.type(0, "start, Daniel's careful wording, twice", { focus: false });
    await act(async () => { await dan.ref.current!.flush(); });
    const v2 = server.doc.updatedAt;
    gets.delay = 0;
    back();
    await tick(1500); // (before her autosave)
    const hers = bus.sent.filter(([, e, p]) => e === "ops" && p.clientId === "tab-sana");
    expect(hers.length).toBeGreaterThan(0);
    expect(hers.every(([, , p]) => p.baseVersion === v2)).toBe(true);
    expect(sana.text(0)).toBe("start, Daniel's careful wording, twice");
    expect(dan.text(1)).toBe("second, Sana's while away");
    expect(sana.banner()).toBeNull();
    expect(dan.banner()).toBeNull();
  });

  it("a fetch that comes back late, older than a save that has landed since, is never merged (the base never winds back)", async () => {
    const { dan, sana, back } = await cutOff();
    await danSaves(dan);
    sana.type(1, "second, Sana's while away");
    await tick(300);
    gets.delay = 1000;
    back(); // her catch-up asks for the server's copy (his save): the answer is slow
    gets.delay = 0;
    // meanwhile she clicks away: her blur saves (refused on his save, merged, saved on top)
    act(() => dan.blocks()[1].focus());
    await tick(100);
    expect(savedTexts()).toEqual(["start, Daniel's careful wording", "second, Sana's while away"]);
    // the slow answer (his save, older than hers now) lands: it changes nothing
    for (let i = 0; i < 10; i++) {
      await tick(200);
      expect(sana.text(1)).toBe("second, Sana's while away");
    }
    expect([dan.text(0), dan.text(1)]).toEqual(savedTexts());
    expect([sana.text(0), sana.text(1)]).toEqual(savedTexts());
    expect(sana.ref.current!.pending).toBe(false);
    expect(sana.banner()).toBeNull();
    expect(dan.banner()).toBeNull();
  });

  it("a batch made on an old save can't write over words saved since: refused, and its sender is told to catch up", async () => {
    const dan = editor("m-self", "tab-dan");
    await tick();
    await danSaves(dan);
    // a tab that missed that save sends an edit made on the old copy (with a new line of its own)
    const heard: [string, Record<string, unknown>][] = [];
    const old = bus.transport().open("kanbo:doc:d1", { self: "tab-old", onSync: () => {}, onBroadcast: (e, p) => heard.push([e, p as Record<string, unknown>]), onStatus: () => {} });
    await tick();
    old.track({ userId: "m-3", name: "Sana Rao", color: "", clientId: "tab-old", state: "editing", at: Date.now() });
    await tick();
    old.send("ops", {
      docId: "d1", clientId: "tab-old", userId: "m-3", name: "Sana Rao", color: "", seq: Date.now() + 60_000, baseVersion: base.updatedAt, at: Date.now(),
      ops: [{ t: "update", block: { id: "a", type: "p", spans: [{ text: "Start" }] } }, { t: "update", block: { id: "b", type: "p", spans: [{ text: "second, Sana's" }] } }],
      prev: { a: hashText(blockSig(base.body[0])), b: hashText(blockSig(base.body[1])) },
    });
    await tick();
    expect(dan.text(0)).toBe("start, Daniel's careful wording");
    expect(dan.text(1)).toBe("second, Sana's");
    expect(heard.some(([e, p]) => e === "stale" && p.to === "tab-old")).toBe(true);
    expect(dan.banner()).toBeNull();
  });

  it("while you type the caret rides in the batch (no caret message a keystroke); alone, nothing goes out", async () => {
    const dan = editor("m-self", "tab-dan");
    await tick();
    for (const v of ["start 1", "start 12", "start 123"]) { dan.type(0, v); await tick(50); }
    await tick(500);
    expect(bus.sent.filter(([, e]) => e === "ops" || e === "caret")).toEqual([]);
    const sana = editor("m-3", "tab-sana");
    await tick();
    const from = bus.sent.length;
    for (let i = 1; i <= 10; i++) { dan.type(0, `start ${"x".repeat(i)}`); await tick(50); }
    await tick(300);
    const his = bus.sent.slice(from).filter(([, , p]) => p.clientId === "tab-dan");
    const ops = his.filter(([, e]) => e === "ops");
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.length).toBeLessThanOrEqual(5); // 10 keystrokes in 0.8 s: one batch per 150 ms at most
    expect(his.filter(([, e]) => e === "caret")).toEqual([]);
    expect(ops[ops.length - 1][2].caret).toMatchObject({ blockId: "a", offset: 16 });
    expect(sana.text(0)).toBe("start xxxxxxxxxx");
  });
});

