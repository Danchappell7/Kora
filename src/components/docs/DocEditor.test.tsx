/* The block editor in jsdom: typing (read back from the page), Markdown shortcuts, Enter / Backspace,
   the slash and @ menus, marks, Make task, paste, undo, block selection, autosave with conflicts,
   version restore, and the read-only rendering guests get. Demo mode: lib/docs is in memory. */
import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocBlock, ProjectDoc, Task } from "../../data/types";
import { MEMBERS, TASKS } from "../../data/data";
import { getProjectDoc, resetDemoDocs, saveProjectDoc } from "../../lib/docs";
import { DocEditor, type DocEditorHandle } from "./DocEditor";
import { getSelectionOffsets, setSelectionOffsets } from "./docDom";

const ME = "m-self";
let seq = 0;
async function makeDoc(body: DocBlock[], title = "Test doc"): Promise<ProjectDoc> {
  const r = await saveProjectDoc({ id: `doc-test-${++seq}`, projectId: "p-launch", title, body, baseUpdatedAt: null });
  return r.doc;
}
const P = (id: string, text: string, extra: Partial<DocBlock> = {}): DocBlock => ({ id, type: "p", spans: text ? [{ text }] : [], ...extra });

function setup(doc: ProjectDoc, opts: { readOnly?: boolean; tasks?: Task[]; onMakeTask?: (i: { title: string }) => Promise<string | null> } = {}) {
  const ref = createRef<DocEditorHandle>();
  const onMakeTask = vi.fn(opts.onMakeTask ?? (async () => "t-new"));
  const onOpenTask = vi.fn();
  const onSaveState = vi.fn();
  const utils = render(
    <DocEditor ref={ref} doc={doc} members={MEMBERS} tasks={opts.tasks ?? TASKS} currentUserId={ME} readOnly={!!opts.readOnly}
      onMakeTask={onMakeTask} onOpenTask={onOpenTask} onSaveState={onSaveState} />,
  );
  const blockEls = () => Array.from(utils.container.querySelectorAll<HTMLElement>(".kdoc-blocks .kdoc-text"));
  const rows = () => Array.from(utils.container.querySelectorAll<HTMLElement>(".kdoc-blocks > .kdoc-block"));
  return { ...utils, ref, onMakeTask, onOpenTask, onSaveState, blockEls, rows };
}

/** what the browser would do: put the text in the block, the caret after it, and fire input */
function typeInto(el: HTMLElement, text: string, data = text.slice(-1)) {
  el.textContent = text;
  act(() => el.focus());
  setSelectionOffsets(el, text.length);
  fireEvent.input(el, { data, inputType: "insertText" });
}
const caretAt = (el: HTMLElement, start: number, end = start) => { act(() => el.focus()); setSelectionOffsets(el, start, end); };
const types = (rows: HTMLElement[]) => rows.map((r) => r.dataset.type);

beforeEach(() => { resetDemoDocs(); });
afterEach(() => { vi.useRealTimers(); });

describe("typing and saving", () => {
  it("reads what was typed, saves on flush with the loaded base, and the server has it", async () => {
    const doc = await makeDoc([P("a", "")]);
    const { blockEls, ref, onSaveState } = setup(doc);
    typeInto(blockEls()[0], "Hello world");
    expect(onSaveState).toHaveBeenLastCalledWith("saving");
    await act(async () => { await ref.current!.flush(); });
    expect(onSaveState).toHaveBeenLastCalledWith("saved");
    const saved = (await getProjectDoc(doc.id))!;
    expect(saved.body).toEqual([{ id: "a", type: "p", spans: [{ text: "Hello world" }] }]);
    expect(ref.current!.pending).toBe(false);
  });

  it("autosaves after 2 s of quiet", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const doc = await makeDoc([P("a", "")]);
    const { blockEls } = setup(doc);
    typeInto(blockEls()[0], "Draft");
    await act(async () => { vi.advanceTimersByTime(2100); });
    await waitFor(async () => expect((await getProjectDoc(doc.id))!.body[0].spans).toEqual([{ text: "Draft" }]));
  });

  it("the title saves too; Enter in it moves to the first line", async () => {
    const doc = await makeDoc([P("a", "body")], "");
    const { ref, blockEls } = setup(doc);
    const title = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Launch plan" } });
    fireEvent.keyDown(title, { key: "Enter" });
    expect(document.activeElement).toBe(blockEls()[0]);
    await act(async () => { await ref.current!.flush(); });
    expect((await getProjectDoc(doc.id))!.title).toBe("Launch plan");
  });

  it("flushes on blur (leaving the editor)", async () => {
    const doc = await makeDoc([P("a", "")]);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const { blockEls } = setup(doc);
    typeInto(blockEls()[0], "Saved on blur");
    fireEvent.blur(blockEls()[0], { relatedTarget: outside });
    await waitFor(async () => expect((await getProjectDoc(doc.id))!.body[0].spans).toEqual([{ text: "Saved on blur" }]));
  });
});

describe("structure", () => {
  it("Markdown shortcuts: # heading, - list, [] checklist, > quote, --- divider", async () => {
    const doc = await makeDoc([P("a", ""), P("b", ""), P("c", ""), P("d", ""), P("e", "")]);
    const { blockEls, rows } = setup(doc);
    typeInto(blockEls()[0], "# ");
    typeInto(blockEls()[1], "- ");
    typeInto(blockEls()[2], "[] ");
    typeInto(blockEls()[3], "> ");
    typeInto(blockEls()[4], "---", "-");
    expect(types(rows())).toEqual(["h1", "bullet", "todo", "quote", "divider", "p"]);
    expect(blockEls()[0].textContent).toBe("");
    // the caret lands in the new paragraph after the divider
    expect(document.activeElement).toBe(blockEls()[4]);
  });

  it("Enter splits at the caret (a list carries on); Enter on an empty item leaves the list", async () => {
    const doc = await makeDoc([{ id: "l", type: "bullet", spans: [{ text: "milk eggs" }] }]);
    const { blockEls, rows } = setup(doc);
    caretAt(blockEls()[0], 4);
    fireEvent.keyDown(blockEls()[0], { key: "Enter" });
    expect(types(rows())).toEqual(["bullet", "bullet"]);
    expect(blockEls().map((e) => e.textContent)).toEqual(["milk", " eggs"]);
    expect(document.activeElement).toBe(blockEls()[1]);
    expect(getSelectionOffsets(blockEls()[1])).toMatchObject({ start: 0 });
    // an empty item: out of the list
    caretAt(blockEls()[1], 5);
    fireEvent.keyDown(blockEls()[1], { key: "Enter" });
    fireEvent.keyDown(blockEls()[2], { key: "Enter" });
    expect(types(rows())).toEqual(["bullet", "bullet", "p"]);
  });

  it("Shift+Enter is a line break inside the block", async () => {
    const doc = await makeDoc([P("a", "ab")]);
    const { blockEls, ref } = setup(doc);
    caretAt(blockEls()[0], 1);
    fireEvent.keyDown(blockEls()[0], { key: "Enter", shiftKey: true });
    expect(ref.current!.content().body[0].spans).toEqual([{ text: "a\nb" }]);
  });

  it("Backspace at the start: a heading becomes text, then text joins the line above", async () => {
    const doc = await makeDoc([P("a", "One"), { id: "b", type: "h2", spans: [{ text: "Two" }] }]);
    const { blockEls, rows, ref } = setup(doc);
    caretAt(blockEls()[1], 0);
    fireEvent.keyDown(blockEls()[1], { key: "Backspace" });
    expect(types(rows())).toEqual(["p", "p"]);
    caretAt(blockEls()[1], 0);
    fireEvent.keyDown(blockEls()[1], { key: "Backspace" });
    expect(ref.current!.content().body).toEqual([{ id: "a", type: "p", spans: [{ text: "OneTwo" }] }]);
    expect(getSelectionOffsets(blockEls()[0])).toMatchObject({ start: 3 });
  });

  it("Tab indents a list item and Shift+Tab outdents; arrows move between blocks", async () => {
    const doc = await makeDoc([{ id: "a", type: "bullet", spans: [{ text: "x" }] }, P("b", "y")]);
    const { blockEls, rows } = setup(doc);
    caretAt(blockEls()[0], 1);
    fireEvent.keyDown(blockEls()[0], { key: "Tab" });
    expect(rows()[0].dataset.indent).toBe("1");
    fireEvent.keyDown(blockEls()[0], { key: "Tab", shiftKey: true });
    expect(rows()[0].dataset.indent).toBe("0");
    fireEvent.keyDown(blockEls()[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(blockEls()[1]);
    caretAt(blockEls()[1], 0);
    fireEvent.keyDown(blockEls()[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(blockEls()[0]);
    caretAt(blockEls()[0], 0);
    fireEvent.keyDown(blockEls()[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Title" }));
  });

  it("⌘B / ⌘I / ⌘E toggle marks on the selection; ⌘Z undoes and ⌘⇧Z redoes", async () => {
    const doc = await makeDoc([P("a", "make this bold")]);
    const { blockEls, ref } = setup(doc);
    caretAt(blockEls()[0], 10, 14);
    fireEvent.keyDown(blockEls()[0], { key: "b", metaKey: true, ctrlKey: true });
    expect(ref.current!.content().body[0].spans).toEqual([{ text: "make this " }, { text: "bold", marks: ["b"] }]);
    expect(blockEls()[0].querySelector("strong")?.textContent).toBe("bold");
    caretAt(blockEls()[0], 0, 4);
    fireEvent.keyDown(blockEls()[0], { key: "e", metaKey: true, ctrlKey: true });
    expect(blockEls()[0].querySelector("code")?.textContent).toBe("make");
    fireEvent.keyDown(blockEls()[0], { key: "z", metaKey: true, ctrlKey: true });
    expect(blockEls()[0].querySelector("code")).toBeNull();
    fireEvent.keyDown(blockEls()[0], { key: "z", metaKey: true, ctrlKey: true });
    expect(blockEls()[0].querySelector("strong")).toBeNull();
    fireEvent.keyDown(blockEls()[0], { key: "z", metaKey: true, ctrlKey: true, shiftKey: true });
    expect(blockEls()[0].querySelector("strong")?.textContent).toBe("bold");
  });

  it("⌘K links the selection; a bad address is refused with a reason", async () => {
    const doc = await makeDoc([P("a", "see the spec")]);
    const { blockEls, ref } = setup(doc);
    caretAt(blockEls()[0], 8, 12);
    fireEvent.keyDown(blockEls()[0], { key: "k", metaKey: true, ctrlKey: true });
    const box = screen.getByRole("dialog", { name: "Add a link" });
    const input = within(box).getByLabelText("Link address");
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(input.closest("form")!);
    expect(within(box).getByRole("alert")).toHaveTextContent(/web address/);
    fireEvent.change(input, { target: { value: "acme.com/spec" } });
    fireEvent.submit(input.closest("form")!);
    expect(ref.current!.content().body[0].spans).toEqual([{ text: "see the " }, { text: "spec", href: "https://acme.com/spec" }]);
    expect(blockEls()[0].querySelector("a")?.getAttribute("href")).toBe("https://acme.com/spec");
  });

  it("pasting Markdown makes blocks, splitting the line at the caret", async () => {
    const doc = await makeDoc([P("a", "Before after")]);
    const { blockEls, rows, ref } = setup(doc);
    caretAt(blockEls()[0], 7);
    fireEvent.paste(blockEls()[0], { clipboardData: { getData: () => "**bold** start\n- item one\n- [x] done" } });
    expect(types(rows())).toEqual(["p", "bullet", "todo"]);
    const body = ref.current!.content().body;
    expect(body[0].spans).toEqual([{ text: "Before " }, { text: "bold", marks: ["b"] }, { text: " start" }]);
    expect(body[2]).toMatchObject({ type: "todo", checked: true, spans: [{ text: "doneafter" }] });
  });

  it("pasting one plain line goes inline", async () => {
    const doc = await makeDoc([P("a", "ab")]);
    const { blockEls, ref } = setup(doc);
    caretAt(blockEls()[0], 1);
    fireEvent.paste(blockEls()[0], { clipboardData: { getData: () => "XYZ" } });
    expect(ref.current!.content().body).toEqual([{ id: "a", type: "p", spans: [{ text: "aXYZb" }] }]);
  });
});

describe("the slash menu and @mentions", () => {
  it("/ opens the blocks menu; typing filters; Enter turns the line into the pick and drops the /query", async () => {
    const doc = await makeDoc([P("a", "")]);
    const { blockEls, rows } = setup(doc);
    typeInto(blockEls()[0], "/");
    const menu = screen.getByRole("listbox", { name: "Blocks" });
    expect(within(menu).getAllByRole("option").length).toBeGreaterThan(8);
    expect(blockEls()[0].getAttribute("aria-activedescendant")).toBeTruthy();
    typeInto(blockEls()[0], "/head", "d");
    expect(within(screen.getByRole("listbox", { name: "Blocks" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Heading 1"), expect.stringContaining("Heading 2"), expect.stringContaining("Heading 3"),
    ]);
    fireEvent.keyDown(blockEls()[0], { key: "ArrowDown" });
    fireEvent.keyDown(blockEls()[0], { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(types(rows())).toEqual(["h2"]);
    expect(blockEls()[0].textContent).toBe("");
  });

  it("Escape closes the menu and keeps the text; a / inside a word doesn't open it", async () => {
    const doc = await makeDoc([P("a", "")]);
    const { blockEls } = setup(doc);
    typeInto(blockEls()[0], "/");
    fireEvent.keyDown(blockEls()[0], { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(blockEls()[0].textContent).toBe("/");
    typeInto(blockEls()[0], "and/or", "/");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("@ suggests people; picking one inserts a mention, and the save lists them for the server's notice", async () => {
    const doc = await makeDoc([P("a", "")]);
    const { blockEls, ref } = setup(doc);
    typeInto(blockEls()[0], "Ask @");
    const list = screen.getByRole("listbox", { name: "People to mention" });
    expect(within(list).getAllByRole("option").length).toBeGreaterThan(1);
    typeInto(blockEls()[0], "Ask @san", "n");
    const opts = within(screen.getByRole("listbox", { name: "People to mention" })).getAllByRole("option");
    expect(opts[0]).toHaveTextContent("Sana Rao");
    fireEvent.keyDown(blockEls()[0], { key: "Enter" });
    expect(ref.current!.content().body[0].spans).toEqual([{ text: "Ask " }, { text: "@Sana Rao", mention: "m-3" }, { text: " " }]);
    expect(blockEls()[0].querySelector(".kdoc-mention")?.getAttribute("contenteditable")).toBe("false");
    await act(async () => { await ref.current!.flush(); });
    expect((await getProjectDoc(doc.id))!.mentions).toEqual(["m-3"]);
  });
});

describe("Make task", () => {
  it("from the slash menu: makes the task with the line's words, links it, and shows its live status", async () => {
    const doc = await makeDoc([P("a", "")]);
    const made: Task = { ...TASKS[0], id: "t-new", title: "Book the venue", status: "progress", projectId: "p-launch" };
    const s = setup(doc, { onMakeTask: async () => "t-new" });
    typeInto(s.blockEls()[0], "Book the venue /");
    typeInto(s.blockEls()[0], "Book the venue /task", "k");
    fireEvent.keyDown(s.blockEls()[0], { key: "Enter" });
    await waitFor(() => expect(s.onMakeTask).toHaveBeenCalledWith({ title: "Book the venue", projectId: "p-launch", docId: doc.id, blockId: "a" }));
    await waitFor(() => expect(s.ref.current!.content().body[0].taskId).toBe("t-new"));
    // the task arrives in `tasks`: its status shows on the line
    s.rerender(<DocEditor ref={s.ref} doc={doc} members={MEMBERS} tasks={[...TASKS, made]} currentUserId={ME} readOnly={false} onMakeTask={s.onMakeTask} onOpenTask={s.onOpenTask} />);
    const chip = screen.getByRole("button", { name: /Open Task: Book the venue, In progress/ });
    fireEvent.click(chip);
    expect(s.onOpenTask).toHaveBeenCalledWith("t-new");
  });

  it("an empty line says what to do instead; a failed create changes nothing", async () => {
    const doc = await makeDoc([P("a", ""), P("b", "Something")]);
    const s = setup(doc, { onMakeTask: async () => null });
    typeInto(s.blockEls()[0], "/");
    typeInto(s.blockEls()[0], "/task", "k");
    fireEvent.keyDown(s.blockEls()[0], { key: "Enter" });
    await waitFor(() => expect(s.container.querySelector(".kdoc-editor > p[role='status']")).toHaveTextContent(/Write something on the line first/));
    expect(s.onMakeTask).not.toHaveBeenCalled();
    typeInto(s.blockEls()[1], "Something /");
    typeInto(s.blockEls()[1], "Something /task", "k");
    fireEvent.keyDown(s.blockEls()[1], { key: "Enter" });
    await waitFor(() => expect(s.onMakeTask).toHaveBeenCalled());
    expect(s.ref.current!.content().body[1].taskId).toBeUndefined();
  });
});

describe("block selection (Esc)", () => {
  it("Esc selects the block; arrows move; Shift extends; Backspace deletes; Enter edits", async () => {
    const doc = await makeDoc([P("a", "one"), P("b", "two"), P("c", "three")]);
    const { blockEls, rows, container, ref } = setup(doc);
    caretAt(blockEls()[0], 1);
    fireEvent.keyDown(blockEls()[0], { key: "Escape" });
    const root = container.querySelector<HTMLElement>(".kdoc-editor")!;
    expect(document.activeElement).toBe(root);
    expect(rows()[0].dataset.selected).toBe("true");
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true });
    expect(rows().filter((r) => r.dataset.selected === "true")).toHaveLength(2);
    fireEvent.keyDown(root, { key: "Backspace" });
    expect(ref.current!.content().body.map((b) => b.id)).toEqual(["c"]);
    fireEvent.keyDown(blockEls()[0], { key: "Escape" });
    fireEvent.keyDown(root, { key: "Enter" });
    expect(document.activeElement).toBe(blockEls()[0]);
  });

  it("⌘⇧↓ moves a block down", async () => {
    const doc = await makeDoc([P("a", "one"), P("b", "two")]);
    const { blockEls, ref } = setup(doc);
    caretAt(blockEls()[0], 0);
    fireEvent.keyDown(blockEls()[0], { key: "ArrowDown", metaKey: true, ctrlKey: true, shiftKey: true });
    expect(ref.current!.content().body.map((b) => b.id)).toEqual(["b", "a"]);
  });
});

describe("checklists, callouts and the block menu", () => {
  it("ticks a checklist item by click and ⌘Enter", async () => {
    const doc = await makeDoc([{ id: "t", type: "todo", spans: [{ text: "Pack" }], checked: false }]);
    const { blockEls, ref } = setup(doc);
    fireEvent.click(screen.getByRole("checkbox", { name: "Done: Pack" }));
    expect(ref.current!.content().body[0].checked).toBe(true);
    caretAt(blockEls()[0], 0);
    fireEvent.keyDown(blockEls()[0], { key: "Enter", metaKey: true, ctrlKey: true });
    expect(ref.current!.content().body[0].checked).toBe(false);
  });

  it("⌘/ opens a block's actions: turn into, duplicate, delete", async () => {
    const doc = await makeDoc([P("a", "Line")]);
    const { blockEls, ref } = setup(doc);
    caretAt(blockEls()[0], 0);
    fireEvent.keyDown(blockEls()[0], { key: "/", metaKey: true, ctrlKey: true });
    const menu = await screen.findByRole("menu", { name: "Block actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Turn into/ }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Block actions" })).getByRole("menuitemradio", { name: /Quote/ }));
    expect(ref.current!.content().body[0].type).toBe("quote");
    fireEvent.keyDown(blockEls()[0], { key: "/", metaKey: true, ctrlKey: true });
    fireEvent.click(within(await screen.findByRole("menu", { name: "Block actions" })).getByRole("menuitem", { name: /Duplicate/ }));
    expect(ref.current!.content().body).toHaveLength(2);
    expect(ref.current!.content().body[1].id).not.toBe("a");
  });
});

describe("someone else saved", () => {
  it("the same person in another tab: says so, and Keep mine saves over the other copy", async () => {
    const doc = await makeDoc([P("a", "start")]);
    const { blockEls, ref } = setup(doc);
    // Sana saves first (another browser), from the same base
    await saveProjectDoc({ id: doc.id, projectId: doc.projectId, title: "Hers", body: [P("a", "theirs")], baseUpdatedAt: doc.updatedAt });
    typeInto(blockEls()[0], "mine");
    await act(async () => { await ref.current!.flush(); });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/You saved this somewhere else/);
    fireEvent.click(within(banner).getByRole("button", { name: "Keep mine" }));
    await waitFor(async () => expect((await getProjectDoc(doc.id))!.body[0].spans).toEqual([{ text: "mine" }]));
    expect(screen.queryByText(/somewhere else/)).toBeNull();
  });

  it("Reload shows their version instead", async () => {
    const doc = await makeDoc([P("a", "start")], "Mine");
    const { blockEls, ref } = setup(doc);
    await saveProjectDoc({ id: doc.id, projectId: doc.projectId, title: "Theirs", body: [P("a", "their words")], baseUpdatedAt: doc.updatedAt });
    typeInto(blockEls()[0], "my words");
    await act(async () => { await ref.current!.flush(); });
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Reload" }));
    expect(blockEls()[0].textContent).toBe("their words");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Theirs");
    expect(ref.current!.pending).toBe(false);
  });
});

describe("version history", () => {
  it("restores an older version as a new edit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const doc = await makeDoc([P("a", "first draft")], "Draft");
    // a later save by "someone else" ten minutes on: a second version
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const later = await saveProjectDoc({ id: doc.id, projectId: doc.projectId, title: "Final", body: [P("a", "final words")], baseUpdatedAt: doc.updatedAt });
    vi.useRealTimers();
    const { ref, blockEls } = setup(later.doc);
    act(() => ref.current!.openHistory());
    const dialog = await screen.findByRole("dialog", { name: "Version history" });
    const options = await within(dialog).findAllByRole("option");
    expect(options.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(options[options.length - 1]);
    await within(dialog).findByText("first draft");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(blockEls()[0].textContent).toBe("first draft"));
    await waitFor(async () => expect((await getProjectDoc(doc.id))!.title).toBe("Draft"));
  });
});

describe("read only (guests)", () => {
  it("renders headings, lists, links, mentions and task chips without editing", async () => {
    const doc = await makeDoc([
      { id: "h", type: "h1", spans: [{ text: "Plan" }] },
      { id: "b", type: "bullet", spans: [{ text: "see " }, { text: "spec", href: "https://acme.com/spec" }] },
      { id: "m", type: "p", spans: [{ text: "@Sana", mention: "m-3" }, { text: " owns it" }] },
      { id: "t", type: "todo", spans: [{ text: "Write the deck" }], checked: false, taskId: "t-1" },
    ], "Guest view");
    const { container, onOpenTask } = setup(doc, { readOnly: true });
    expect(container.querySelector("[contenteditable='true']")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Guest view" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Plan" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "spec" })).toHaveAttribute("href", "https://acme.com/spec");
    expect(screen.getByText("@Sana Rao")).toHaveClass("kdoc-mention");
    fireEvent.click(screen.getByRole("button", { name: /Open Task: Finalise Q3 launch narrative deck/ }));
    expect(onOpenTask).toHaveBeenCalledWith("t-1");
  });

  it("a doc you can't edit (canEdit false) reads only even without readOnly", async () => {
    const doc = await makeDoc([P("a", "x")]);
    const { container } = setup({ ...doc, canEdit: false });
    expect(container.querySelector("[contenteditable='true']")).toBeNull();
  });
});
