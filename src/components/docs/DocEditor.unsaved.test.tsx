/* Words that haven't reached the server (the save answers stubbed): closing offline keeps them in this tab and
   the doc offers them back; Back waits for the save and asks when it can't land; a doc deleted while open keeps
   its words on screen with a copy; a restore saves what's on screen first, then itself as a version of its own. */
import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocSaveInput, Project, ProjectDoc, ProjectDocVersion } from "../../data/types";
import { MEMBERS, PROJECTS, TASKS } from "../../data/data";

const { save, get, listeners, versions } = vi.hoisted(() => ({
  save: vi.fn(),
  get: vi.fn(),
  versions: [] as ProjectDocVersion[],
  listeners: [] as ((c: { type: "UPDATE" | "DELETE"; docId: string; updatedAt: string | null; updatedBy: string | null }) => void)[],
}));
vi.mock("../../lib/docs", async (orig) => ({
  ...(await orig<typeof import("../../lib/docs")>()),
  saveProjectDoc: (i: DocSaveInput) => save(i),
  getProjectDoc: (id: string) => get(id),
  listDocVersions: async () => versions.map((v) => ({ ...v, body: null })),
  getDocVersion: async (id: string) => versions.find((v) => v.id === id) ?? null,
  subscribeProjectDocs: (_p: string, fn: (typeof listeners)[number]) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
}));

import { DocEditor, type DocEditorHandle } from "./DocEditor";
import { DocPage } from "./DocPage";
import { setSelectionOffsets } from "./docDom";
import { keepDocDraft, peekDocDraft } from "./docDrafts";

const base: ProjectDoc = {
  id: "d1", projectId: "p-launch", workspaceId: "ws-foundrise", title: "Brief", body: [{ id: "a", type: "p", spans: [{ text: "start" }] }],
  icon: null, position: 1, mentions: [], createdBy: "m-self", createdByName: "Daniel Okai", updatedBy: "m-self", updatedByName: "Daniel Okai",
  createdAt: "2026-10-09T09:00:00.000Z", updatedAt: "2026-10-09T09:00:00.000Z", archivedAt: null, canEdit: true,
};
const P = (text: string) => [{ id: "a", type: "p" as const, spans: [{ text }] }];
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const savedAs = (updatedAt: string) => async (i: DocSaveInput) => ({ status: "saved", doc: { ...base, title: i.title, body: i.body, updatedAt } });
const LAUNCH = PROJECTS.find((p) => p.id === "p-launch") as Project;

function typeInto(el: HTMLElement, text: string) {
  el.textContent = text;
  act(() => el.focus());
  setSelectionOffsets(el, text.length);
  fireEvent.input(el, { data: text.slice(-1), inputType: "insertText" });
}
function editor(doc: ProjectDoc = base) {
  const ref = createRef<DocEditorHandle>();
  const utils = render(<DocEditor ref={ref} doc={doc} members={MEMBERS} tasks={TASKS} currentUserId="m-self" readOnly={false} onMakeTask={vi.fn()} onOpenTask={vi.fn()} />);
  const block = () => utils.container.querySelector<HTMLElement>(".kdoc-blocks .kdoc-text")!;
  return { ...utils, ref, block };
}
function page() {
  const onBack = vi.fn();
  const utils = render(<DocPage project={LAUNCH} docId="d1" members={MEMBERS} tasks={TASKS} currentUserId="m-self" readOnly={false}
    onBack={onBack} onMakeTask={vi.fn()} onOpenTask={vi.fn()} />);
  const block = () => utils.container.querySelector<HTMLElement>(".kdoc-blocks .kdoc-text")!;
  const back = () => screen.getByRole("button", { name: /Back to Q3 Product Launch's docs/ });
  return { ...utils, onBack, block, back };
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

beforeEach(() => {
  save.mockReset(); get.mockReset(); listeners.length = 0; versions.length = 0;
  sessionStorage.clear();
});

describe("closing with words the server doesn't have", () => {
  it("offline: they're kept in this tab, and the doc offers them back next time", async () => {
    save.mockImplementation(offline);
    const s = editor();
    typeInto(s.block(), "written on the train");
    await act(async () => { await s.ref.current!.flush(); });
    expect(s.ref.current!.state).toBe("offline");
    s.unmount();
    await settle();
    expect(peekDocDraft("m-self", "d1")).toMatchObject({ body: P("written on the train"), base: base.updatedAt });

    save.mockReset();
    save.mockImplementation(savedAs("2026-10-09T09:30:00.000Z"));
    const again = editor();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/Changes you made at \d\d:\d\d weren't saved\. They're kept in this tab/);
    expect(again.block().textContent).toBe("start");
    fireEvent.click(within(banner).getByRole("button", { name: "Restore" }));
    expect(again.block().textContent).toBe("written on the train");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // saved as a version of its own, so what the doc said instead stays in Version history
    expect(save.mock.calls[0][0]).toMatchObject({ body: P("written on the train"), baseUpdatedAt: base.updatedAt, checkpoint: true });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(peekDocDraft("m-self", "d1")).toBeNull();
  });

  it("the doc moved on since: says so; Discard forgets them and saves nothing", async () => {
    keepDocDraft("m-self", "d1", { title: "Brief", body: P("old offline words"), base: "2026-10-09T08:00:00.000Z" });
    const s = editor();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This doc has been edited since. Restore puts your changes back; the version here now stays in Version history.");
    fireEvent.click(within(banner).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(s.block().textContent).toBe("start");
    expect(peekDocDraft("m-self", "d1")).toBeNull();
    s.unmount();
    await settle();
    expect(save).not.toHaveBeenCalled();
    expect(peekDocDraft("m-self", "d1")).toBeNull();
  });

  it("an offer nobody answered waits for next time; one that matches the doc already is dropped quietly", async () => {
    keepDocDraft("m-self", "d1", { title: "Brief", body: P("kept"), base: base.updatedAt });
    const first = editor();
    await screen.findByRole("alert");
    first.unmount();
    await settle();
    expect(peekDocDraft("m-self", "d1")).toMatchObject({ body: P("kept") });
    keepDocDraft("m-self", "d1", { title: "Brief", body: base.body, base: "2026-10-09T08:00:00.000Z" });
    editor();
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(peekDocDraft("m-self", "d1")).toBeNull();
  });

  it("mid-save: what was typed during the save still goes after the editor has closed", async () => {
    const releases: (() => void)[] = [];
    save.mockImplementation((i: DocSaveInput) => new Promise((r) => releases.push(() => r({ status: "saved", doc: { ...base, body: i.body, updatedAt: `2026-10-09T09:0${releases.length}:00.000Z` } }))));
    const s = editor();
    typeInto(s.block(), "first");
    void s.ref.current!.flush();
    typeInto(s.block(), "first and the last words");
    s.unmount();
    releases[0]();
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({ body: P("first and the last words"), baseUpdatedAt: "2026-10-09T09:01:00.000Z" });
    releases[1]();
    await settle();
    expect(peekDocDraft("m-self", "d1")).toBeNull();
  });
});

describe("restoring a version", () => {
  it("what's on screen saves first; the restore is a version of its own (and ⌘Z undoes it)", async () => {
    versions.push(
      { id: "v2", docId: "d1", title: "Brief", body: base.body, savedBy: "m-self", savedAt: base.updatedAt },
      { id: "v1", docId: "d1", title: "Old brief", body: P("yesterday's words"), savedBy: "m-3", savedAt: "2026-10-08T09:00:00.000Z" },
    );
    let n = 0;
    save.mockImplementation(async (i: DocSaveInput) => ({ status: "saved", doc: { ...base, title: i.title, body: i.body, updatedAt: `2026-10-09T09:1${++n}:00.000Z` } }));
    const s = editor();
    typeInto(s.block(), "an afternoon of writing");
    act(() => s.ref.current!.openHistory());
    const dialog = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click((await within(dialog).findAllByRole("option"))[1]);
    await within(dialog).findByText("yesterday's words");
    expect(within(dialog).getByText("Restoring keeps the current version in this list.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls.map((c) => [c[0].body[0].spans[0].text, !!c[0].checkpoint])).toEqual([["an afternoon of writing", false], ["yesterday's words", true]]);
    expect(save.mock.calls[1][0]).toMatchObject({ title: "Old brief", baseUpdatedAt: "2026-10-09T09:11:00.000Z" });
    expect(s.block().textContent).toBe("yesterday's words");
    act(() => s.block().focus());
    fireEvent.keyDown(s.block(), { key: "z", metaKey: true, ctrlKey: true });
    expect(s.block().textContent).toBe("an afternoon of writing");
  });
});

describe("a doc's page", () => {
  it("deleted while open (realtime): the words stay, the editor says so and offers a copy", async () => {
    get.mockResolvedValue(base);
    const s = page();
    await waitFor(() => expect(s.block()).not.toBeNull());
    typeInto(s.block(), "unsaved words");
    await act(async () => { listeners.forEach((l) => l({ type: "DELETE", docId: "d1", updatedAt: null, updatedBy: null })); });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This doc was deleted");
    expect(within(banner).getByRole("button", { name: "Copy as Markdown" })).toBeInTheDocument();
    expect(s.block().textContent).toBe("unsaved words");
    // nothing to manage on a doc that's gone
    fireEvent.click(screen.getByRole("button", { name: "More for this doc" }));
    const menu = await screen.findByRole("menu", { name: "More for this doc" });
    expect(within(menu).queryByRole("menuitem", { name: /Delete/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Archive/ })).toBeNull();
    // Back asks first, with the copy to hand
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.click(s.back());
    const sheet = await screen.findByRole("dialog", { name: "Leave this doc" });
    expect(sheet).toHaveTextContent("This doc was deleted, or its project went to the recycle bin, so your latest changes can't be saved.");
    expect(within(sheet).getByRole("button", { name: "Copy as Markdown" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Leave" }));
    expect(s.onBack).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("Back waits for the save, then goes", async () => {
    get.mockResolvedValue(base);
    let release!: () => void;
    save.mockImplementation((i: DocSaveInput) => new Promise((r) => { release = () => r({ status: "saved", doc: { ...base, body: i.body, updatedAt: "2026-10-09T09:20:00.000Z" } }); }));
    const s = page();
    await waitFor(() => expect(s.block()).not.toBeNull());
    typeInto(s.block(), "nearly there");
    fireEvent.click(s.back());
    expect(s.back()).toHaveAttribute("aria-busy", "true");
    expect(s.onBack).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await waitFor(() => expect(s.onBack).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Leave this doc" })).toBeNull();
  });

  it("offline: Back says the changes are kept in this tab; Stay stays, Leave goes", async () => {
    get.mockResolvedValue(base);
    save.mockImplementation(offline);
    const s = page();
    await waitFor(() => expect(s.block()).not.toBeNull());
    typeInto(s.block(), "on the train");
    fireEvent.click(s.back());
    const sheet = await screen.findByRole("dialog", { name: "Leave this doc" });
    expect(sheet).toHaveTextContent("You're offline, so your latest changes haven't been saved. They're kept in this tab");
    fireEvent.click(within(sheet).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave this doc" })).toBeNull());
    expect(s.onBack).not.toHaveBeenCalled();
    fireEvent.click(s.back());
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Leave this doc" })).getByRole("button", { name: "Leave" }));
    expect(s.onBack).toHaveBeenCalledTimes(1);
    expect(peekDocDraft("m-self", "d1")).toMatchObject({ body: P("on the train") });
  });

  it("nothing unsaved: Back goes at once", async () => {
    get.mockResolvedValue(base);
    const s = page();
    await waitFor(() => expect(s.block()).not.toBeNull());
    fireEvent.click(s.back());
    expect(s.onBack).toHaveBeenCalledTimes(1);
  });
});
