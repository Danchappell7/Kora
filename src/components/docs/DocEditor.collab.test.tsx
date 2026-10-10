/* Two people in one doc (two editors, each its own tab on an in-memory Realtime, one mocked server): edits to
   different blocks merge both ways, the same block is last writer wins (and said so), the other's caret and
   name show, a save merges into the other editor without the banner (and what's theirs still saves, on top),
   undo only takes back your own words, a guest sees it all and sends nothing. */
import { createRef, type ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocBlock, DocSaveInput, ProjectDoc } from "../../data/types";
import { MEMBERS, TASKS } from "../../data/data";

type Ping = { type: "UPDATE" | "DELETE"; docId: string; updatedAt: string | null; updatedBy: string | null };
const { server, saves, gets, listeners } = vi.hoisted(() => ({
  server: { doc: null as unknown as ProjectDoc, n: 0 },
  saves: [] as DocSaveInput[],
  gets: { count: 0 },
  listeners: [] as ((c: Ping) => void)[],
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
    setTimeout(() => listeners.forEach((l) => l({ type: "UPDATE", docId: saved.id, updatedAt: saved.updatedAt, updatedBy: "m-x" })), 0);
    return { status: "saved", doc: saved };
  },
  getProjectDoc: async () => { gets.count++; return server.doc; },
  subscribeProjectDocs: (_p: string, fn: (c: Ping) => void) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
}));

import { DocEditor, type DocEditorHandle } from "./DocEditor";
import { setSelectionOffsets } from "./docDom";
import { createPresenceClient, PresenceContext, PRESENCE_LEAVE_GRACE_MS } from "../presence/core";
import { createMemoryBus, type MemoryBus } from "../presence/memoryTransport";

const base: ProjectDoc = {
  id: "d1", projectId: "p-launch", workspaceId: "ws-foundrise", title: "Brief",
  body: [{ id: "a", type: "p", spans: [{ text: "start" }] }, { id: "b", type: "p", spans: [{ text: "second" }] }],
  icon: null, position: 1, mentions: [], createdBy: "m-self", createdByName: "Daniel Okai", updatedBy: "m-self", updatedByName: "Daniel Okai",
  createdAt: "2026-10-09T09:00:00.000Z", updatedAt: "2026-10-09T09:00:00.000Z", archivedAt: null, canEdit: true,
};

let bus: MemoryBus;
function editor(userId: string, clientId: string, opts: { readOnly?: boolean } = {}) {
  const ref = createRef<DocEditorHandle>();
  const client = createPresenceClient(bus.transport(), { clientId, visibility: false });
  const wrap = (children: ReactNode) => <PresenceContext.Provider value={client}>{children}</PresenceContext.Provider>;
  const utils = render(wrap(<DocEditor ref={ref} doc={base} members={MEMBERS} tasks={TASKS} currentUserId={userId} readOnly={!!opts.readOnly}
    onMakeTask={vi.fn()} onOpenTask={vi.fn()} />));
  const blocks = () => Array.from(utils.container.querySelectorAll<HTMLElement>(".kdoc-blocks .kdoc-text"));
  const text = (i: number) => blocks()[i]?.textContent ?? "";
  const type = (i: number, value: string) => {
    const el = blocks()[i];
    el.textContent = value;
    act(() => el.focus());
    setSelectionOffsets(el, value.length);
    fireEvent.input(el, { data: value.slice(-1), inputType: "insertText" });
  };
  const status = () => utils.container.querySelector(".kdoc-editor > p[role='status']")?.textContent ?? "";
  return { ...utils, ref, client, blocks, text, type, status, view: () => within(utils.container) };
}
/** let the throttled batches go out and arrive, timers and promises both */
const tick = async (ms = 200) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  bus = createMemoryBus();
  server.doc = base; server.n = 0;
  saves.length = 0; gets.count = 0; listeners.length = 0;
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
});
