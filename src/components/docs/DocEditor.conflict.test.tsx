/* The conflict banner when someone else saved first (the server's answer stubbed): who, Keep mine on their
   updatedAt, Reload to theirs — and a realtime ping from someone else while nothing's unsaved updates in place. */
import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocSaveInput, ProjectDoc } from "../../data/types";
import { MEMBERS, TASKS } from "../../data/data";

const { save, get, listeners } = vi.hoisted(() => ({
  save: vi.fn(),
  get: vi.fn(),
  listeners: [] as ((c: { type: "UPDATE" | "DELETE"; docId: string; updatedAt: string | null; updatedBy: string | null }) => void)[],
}));
vi.mock("../../lib/docs", async (orig) => ({
  ...(await orig<typeof import("../../lib/docs")>()),
  saveProjectDoc: (i: DocSaveInput) => save(i),
  getProjectDoc: (id: string) => get(id),
  subscribeProjectDocs: (_p: string, fn: (typeof listeners)[number]) => { listeners.push(fn); return () => {}; },
}));

import { DocEditor, type DocEditorHandle } from "./DocEditor";
import { setSelectionOffsets } from "./docDom";

const base: ProjectDoc = {
  id: "d1", projectId: "p-launch", workspaceId: "ws-foundrise", title: "Brief", body: [{ id: "a", type: "p", spans: [{ text: "start" }] }],
  icon: null, position: 1, mentions: [], createdBy: "m-self", createdByName: "Daniel Okai", updatedBy: "m-self", updatedByName: "Daniel Okai",
  createdAt: "2026-10-09T09:00:00.000Z", updatedAt: "2026-10-09T09:00:00.000Z", archivedAt: null, canEdit: true,
};
const theirs: ProjectDoc = { ...base, title: "Sana’s brief", body: [{ id: "a", type: "p", spans: [{ text: "their words" }] }], updatedBy: "m-3", updatedByName: "Sana Rao", updatedAt: "2026-10-09T09:05:00.000Z" };

function setup() {
  const ref = createRef<DocEditorHandle>();
  const utils = render(<DocEditor ref={ref} doc={base} members={MEMBERS} tasks={TASKS} currentUserId="m-self" readOnly={false} onMakeTask={vi.fn()} onOpenTask={vi.fn()} />);
  const block = () => utils.container.querySelector<HTMLElement>(".kdoc-blocks .kdoc-text")!;
  const type = (text: string) => {
    const el = block();
    el.textContent = text;
    act(() => el.focus());
    setSelectionOffsets(el, text.length);
    fireEvent.input(el, { data: text.slice(-1), inputType: "insertText" });
  };
  return { ...utils, ref, block, type };
}

beforeEach(() => { save.mockReset(); get.mockReset(); listeners.length = 0; sessionStorage.clear(); });

describe("someone else saved first", () => {
  it("names them; Keep mine saves again on their updatedAt", async () => {
    save.mockResolvedValueOnce({ status: "conflict", doc: theirs })
      .mockImplementation(async (i: DocSaveInput) => ({ status: "saved", doc: { ...base, title: i.title, body: i.body, updatedAt: "2026-10-09T09:06:00.000Z" } }));
    const s = setup();
    s.type("mine");
    await act(async () => { await s.ref.current!.flush(); });
    expect(save.mock.calls[0][0]).toMatchObject({ baseUpdatedAt: base.updatedAt, body: [{ id: "a", type: "p", spans: [{ text: "mine" }] }] });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Sana Rao edited this while you were writing.");
    // held: more typing doesn't save over them
    s.type("mine, more");
    await act(async () => { await s.ref.current!.flush(); });
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(within(banner).getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    // a version of its own: theirs stays in Version history even if it was you, in another tab
    expect(save.mock.calls[1][0]).toMatchObject({ baseUpdatedAt: theirs.updatedAt, body: [{ id: "a", type: "p", spans: [{ text: "mine, more" }] }], checkpoint: true });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("Reload puts their version in and makes it the base", async () => {
    save.mockResolvedValueOnce({ status: "conflict", doc: theirs })
      .mockImplementation(async (i: DocSaveInput) => ({ status: "saved", doc: { ...theirs, body: i.body, updatedAt: "2026-10-09T09:07:00.000Z" } }));
    const s = setup();
    s.type("mine");
    await act(async () => { await s.ref.current!.flush(); });
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Reload" }));
    expect(s.block().textContent).toBe("their words");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sana’s brief");
    s.type("their words, then mine");
    await act(async () => { await s.ref.current!.flush(); });
    expect(save.mock.calls[1][0].baseUpdatedAt).toBe(theirs.updatedAt);
  });

  it("a realtime ping from someone else while nothing's unsaved: their copy comes in quietly", async () => {
    get.mockResolvedValue(theirs);
    const s = setup();
    await act(async () => { listeners.forEach((l) => l({ type: "UPDATE", docId: "d1", updatedAt: theirs.updatedAt, updatedBy: "m-3" })); });
    await waitFor(() => expect(s.block().textContent).toBe("their words"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(s.container.querySelector(".kdoc-editor > p[role='status']")).toHaveTextContent("Updated with Sana Rao's changes.");
    // my own save's echo is ignored
    get.mockClear();
    await act(async () => { listeners.forEach((l) => l({ type: "UPDATE", docId: "d1", updatedAt: "2026-10-09T10:00:00.000Z", updatedBy: "m-self" })); });
    expect(get).not.toHaveBeenCalled();
  });

  it("…after which undo starts again from their copy: stepping back past it would save over their words", async () => {
    save.mockImplementation(async (i: DocSaveInput) => ({ status: "saved", doc: { ...base, title: i.title, body: i.body, updatedAt: "2026-10-09T09:01:00.000Z" } }));
    const s = setup();
    s.type("mine");
    await act(async () => { await s.ref.current!.flush(); });
    expect(save).toHaveBeenCalledTimes(1);
    get.mockResolvedValue(theirs);
    await act(async () => { listeners.forEach((l) => l({ type: "UPDATE", docId: "d1", updatedAt: theirs.updatedAt, updatedBy: "m-3" })); });
    await waitFor(() => expect(s.block().textContent).toBe("their words"));
    act(() => s.block().focus());
    fireEvent.keyDown(s.block(), { key: "z", metaKey: true, ctrlKey: true });
    expect(s.block().textContent).toBe("their words");
    expect(s.container.querySelector(".kdoc-editor > p[role='status']")).toHaveTextContent("Nothing to undo.");
    await act(async () => { await s.ref.current!.flush(); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    // what I write next saves on their copy, as usual
    s.type("their words, and mine");
    await act(async () => { await s.ref.current!.flush(); });
    expect(save.mock.calls[1][0]).toMatchObject({ baseUpdatedAt: theirs.updatedAt });
  });

  it("…and while you have unsaved words: the banner, before any save is lost", async () => {
    get.mockResolvedValue(theirs);
    const s = setup();
    s.type("half a thought");
    await act(async () => { listeners.forEach((l) => l({ type: "UPDATE", docId: "d1", updatedAt: theirs.updatedAt, updatedBy: "m-3" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Sana Rao edited this");
    expect(s.block().textContent).toBe("half a thought");
    await act(async () => { await s.ref.current!.flush(); });
    expect(save).not.toHaveBeenCalled();
  });

  it("deleted while open: says so and offers a copy", async () => {
    const s = setup();
    await act(async () => { listeners.forEach((l) => l({ type: "DELETE", docId: "d1", updatedAt: null, updatedBy: null })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("This doc was deleted");
    expect(screen.getByRole("button", { name: "Copy as Markdown" })).toBeInTheDocument();
    s.type("lost?");
    await act(async () => { await s.ref.current!.flush(); });
    expect(save).not.toHaveBeenCalled();
  });
});
