import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor, cleanup } from "@testing-library/react";
import { BoardView, TimelineView, CalendarView, MatrixView, FilesView } from "./OtherViews";
import { store } from "../../data/store";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import { addDaysISO } from "./otherViewsLogic";
import type { Task, Attachment } from "../../data/types";

const mk = (over: Partial<Task>): Task => ({
  id: "t", title: "Task", description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...over,
});
const today = toLocalISO(KANBO_TODAY);
const members = [{ id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }];
const noop = () => {};

function board(tasks: Task[], extra: Partial<Parameters<typeof BoardView>[0]> = {}) {
  const props = { tasks, allTasks: tasks, onOpen: vi.fn(), onAdd: vi.fn(), onMove: vi.fn(), onPatch: vi.fn(), members, ...extra };
  render(<BoardView {...props} />);
  return props;
}
const cardIds = () => Array.from(document.querySelectorAll<HTMLElement>("[data-card-id]")).map((n) => n.dataset.cardId);

// restore only our own spies — the global matchMedia mock from test/setup must survive
const spies: { mockRestore: () => void }[] = [];
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); spies.splice(0).forEach((s) => s.mockRestore()); });

describe("BoardView", () => {
  it("hides a sub-task only when its parent is on the board", () => {
    board([
      mk({ id: "parent", title: "Offsite" }),
      mk({ id: "kid", title: "Book venue", parentId: "parent" }),
      mk({ id: "orphan", title: "Order badges", parentId: "not-here" }),
    ]);
    expect(cardIds()).toEqual(expect.arrayContaining(["parent", "orphan"]));
    expect(cardIds()).not.toContain("kid");
  });

  it("collects tasks of people who left into a Former members column", () => {
    localStorage.setItem("kanbo-board-group", "assignee");
    board([mk({ id: "mine", assigneeId: "m-self" }), mk({ id: "gone", title: "Old work", assigneeId: "m-3" })]);
    const former = screen.getByRole("group", { name: "Former members column" });
    expect(within(former).getByRole("button", { name: /^Old work, / })).toBeInTheDocument();
  });

  it("caps each column at 50 cards with Show more", () => {
    board(Array.from({ length: 60 }, (_, i) => mk({ id: `t${i}`, title: `Task ${i}`, position: i })));
    expect(cardIds()).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more tasks in To do" }));
    expect(cardIds()).toHaveLength(60);
  });

  it("opens cards from the keyboard", () => {
    const p = board([mk({ id: "a", title: "Write brief" })]);
    const card = screen.getByRole("button", { name: /^Write brief, To do/ });
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    expect(p.onOpen).toHaveBeenCalledTimes(2);
  });

  it("renders the status menu in a portal and applies the choice", () => {
    const p = board([mk({ id: "a", title: "Write brief" })]);
    const card = document.querySelector<HTMLElement>('[data-card-id="a"]')!;
    fireEvent.click(within(card).getByRole("button", { name: /Change status of Write brief/ }));
    const menu = screen.getByRole("menu", { name: "Status of Write brief" });
    expect(card.contains(menu)).toBe(false);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /In progress/ }));
    expect(p.onPatch).toHaveBeenCalledWith("a", expect.objectContaining({ status: "progress" }));
    expect(p.onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves cards with Alt+arrows (reorder only touches position)", () => {
    const p = board([mk({ id: "a", title: "First", position: 1 }), mk({ id: "b", title: "Second", position: 2 })]);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Second, To do/ }), { key: "ArrowUp", altKey: true });
    expect(p.onPatch).toHaveBeenCalledWith("b", { position: 0 });
    expect(p.onMove).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: /^First, To do/ }), { key: "ArrowRight", altKey: true });
    expect(p.onMove).toHaveBeenCalledWith("a", "progress", expect.any(Number));
  });

  it("read-only boards open cards but offer no drag, menus or add", () => {
    const p = board([mk({ id: "a", title: "Write brief" })], { readOnly: true, onBulkPatch: vi.fn() });
    const card = document.querySelector<HTMLElement>('[data-card-id="a"]')!;
    expect(card.getAttribute("draggable")).toBe("false");
    expect(within(card).queryByRole("button", { name: /Change status/ })).toBeNull();
    expect(within(card).queryByRole("button", { name: /Select/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add task/ })).toBeNull();
    fireEvent.keyDown(card, { key: "ArrowRight", altKey: true });
    expect(p.onMove).not.toHaveBeenCalled();
    fireEvent.click(card);
    expect(p.onOpen).toHaveBeenCalledWith("a");
  });

  it("keeps WIP limits per board", () => {
    localStorage.setItem("kanbo-board-wip:project:p-launch", JSON.stringify({ "status:todo": 1 }));
    const tasks = [mk({ id: "a" }), mk({ id: "b" })];
    board(tasks, { scopeKey: "project:p-launch" });
    expect(screen.getByRole("button", { name: /2 tasks in To do, WIP limit 1, over the limit/ })).toHaveTextContent("2/1");
    cleanup();
    board(tasks, { scopeKey: "__my" });
    expect(screen.getByRole("button", { name: /^2 tasks in To do\. Set WIP limit/ })).toHaveTextContent(/^2$/);
  });

  it("sets a WIP limit from the dialog and rejects nonsense", () => {
    board([mk({ id: "a" })], { scopeKey: "project:p-launch" });
    fireEvent.click(screen.getByRole("button", { name: /1 task in To do\. Set WIP limit/ }));
    const dialog = screen.getByRole("dialog", { name: "WIP limit for To do" });
    const input = within(dialog).getByLabelText("WIP limit for To do");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/whole number/);
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(JSON.parse(localStorage.getItem("kanbo-board-wip:project:p-launch")!)).toEqual({ "status:todo": 3 });
    expect(screen.getByRole("button", { name: /WIP limit 3/ })).toHaveTextContent("1/3");
  });
});

describe("TimelineView", () => {
  it("navigates the window and jumps to bars outside it", () => {
    const due = addDaysISO(today, 30);
    render(<TimelineView tasks={[mk({ id: "far", title: "Launch", dueDate: due })]} onOpen={noop} onPatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Jump to today" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Launch: / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Launch is due .* after these dates\. Show it/ }));
    expect(screen.getByRole("button", { name: /^Launch: due / })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Jump to today" }));
    expect(screen.queryByRole("button", { name: /^Launch: / })).toBeNull();
  });

  it("reschedules from the keyboard and refuses a start after the due date", () => {
    const onPatch = vi.fn();
    render(<TimelineView tasks={[mk({ id: "a", title: "Brief", dueDate: today, startDate: addDaysISO(today, -1) })]} onOpen={noop} onPatch={onPatch} />);
    const bar = screen.getByRole("button", { name: /^Brief: starts/ });
    fireEvent.keyDown(bar, { key: "ArrowRight", altKey: true });
    expect(onPatch).toHaveBeenLastCalledWith("a", { dueDate: addDaysISO(today, 1), startDate: today });
    fireEvent.keyDown(bar, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(onPatch).toHaveBeenLastCalledWith("a", { startDate: today });
    onPatch.mockClear();
    // start already equals the due date in this variant → one more day would pass it
    cleanup();
    render(<TimelineView tasks={[mk({ id: "b", title: "Memo", dueDate: today, startDate: today })]} onOpen={noop} onPatch={onPatch} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Memo: starts/ }), { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(onPatch).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/can't be after the due date/);
  });

  it("read-only bars aren't draggable or focusable", () => {
    render(<TimelineView tasks={[mk({ id: "a", title: "Brief", dueDate: today })]} onOpen={noop} onPatch={vi.fn()} readOnly />);
    expect(screen.queryByRole("button", { name: /^Brief: / })).toBeNull();
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Brief" })).toBeInTheDocument(); // the row label still opens it
  });
});

describe("CalendarView", () => {
  it("'+N more' opens a list of everything on that day", () => {
    const onOpen = vi.fn();
    const tasks = Array.from({ length: 5 }, (_, i) => mk({ id: `c${i}`, title: `Due thing ${i}`, dueDate: today }));
    render(<CalendarView tasks={tasks} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Show all 5 items on/ }));
    const dialog = screen.getByRole("dialog", { name: /Everything on/ });
    expect(within(dialog).getAllByRole("button", { name: /Due thing/ })).toHaveLength(5);
    fireEvent.click(within(dialog).getByRole("button", { name: /Due thing 4/ }));
    expect(onOpen).toHaveBeenCalledWith("c4");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("week view moves between weeks", () => {
    render(<CalendarView tasks={[]} onOpen={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "week" }));
    expect(screen.getByText("This week")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.queryByText("This week")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByText("This week")).toBeInTheDocument();
  });
});

describe("MatrixView", () => {
  it("shows an open sub-task whose parent isn't on the matrix", () => {
    render(<MatrixView tasks={[mk({ id: "kid", title: "Book venue", parentId: "elsewhere" }), mk({ id: "p", title: "Plan" }), mk({ id: "k2", title: "Nested", parentId: "p" })]} onOpen={noop} />);
    expect(screen.getByText("Book venue")).toBeInTheDocument();
    expect(screen.queryByText("Nested")).toBeNull();
  });
});

describe("FilesView", () => {
  const att: Attachment = { id: "f1", taskId: "a", name: "brief.pdf", size: 2048, mime: "application/pdf", path: "x/brief.pdf", url: "https://example.test/brief.pdf", createdAt: "2026-09-01T10:00:00Z" };

  it("shows an error with Retry instead of 'No files yet'", async () => {
    spies.push(vi.spyOn(console, "error").mockImplementation(noop));
    const list = vi.spyOn(store, "listProjectAttachments").mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce([att]);
    spies.push(list);
    render(<FilesView tasks={[mk({ id: "a", title: "Brief" })]} onOpen={noop} />);
    expect(await screen.findByText("Couldn't load files")).toBeInTheDocument();
    expect(screen.queryByText("No files yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("queries attachments in chunks rather than one huge list", async () => {
    const list = vi.spyOn(store, "listProjectAttachments").mockResolvedValue([]);
    spies.push(list);
    render(<FilesView tasks={Array.from({ length: 170 }, (_, i) => mk({ id: `t${i}` }))} onOpen={noop} />);
    await waitFor(() => expect(screen.getByText("No files yet")).toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.every(([ids]) => ids.length <= 80)).toBe(true);
  });
});
