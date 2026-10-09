/* The board upgrade (u8): covers, rename in place, progress, the due chip,
   rows (swimlanes), shared WIP limits (saved as one change on the freshest
   copy; this device's offered up once, on a yes), the WIP toast, the
   Move to… menu and long columns. Dates are relative to KANBO_TODAY (fixed
   when data.ts loads), so nothing here depends on the real date. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup, act } from "@testing-library/react";

// these pin the board's own (HTML5) drag, used while the drag kit is inert: keep the kit inert here
// even once it's live (boardKit.test.tsx covers the board on the kit)
vi.mock("../../lib/dnd", async (orig) => {
  const real = await orig<typeof import("../../lib/dnd")>();
  const inert = { bind: {}, isDragging: false };
  return {
    ...real,
    useTaskDragSource: () => inert,
    useTaskDropTarget: () => ({ bind: { ref: () => undefined }, isOver: false, canDrop: false, payload: null }),
    useDropTargets: () => [],
  };
});
const { BoardView } = await import("../tasks/OtherViews");
import { addDaysISO } from "../tasks/otherViewsLogic";
import { BoardDisplayOptions } from "./BoardDisplayOptions";
import { ToastProvider } from "../Toast";
import { KANBO_TODAY, toLocalISO, PROJECTS, setReferenceData } from "../../data/data";
import type { Task, BoardSettings } from "../../data/types";

const mk = (over: Partial<Task>): Task => ({
  id: "t", title: "Task", description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...over,
});
const today = toLocalISO(KANBO_TODAY);
const members = [{ id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }, { id: "m-2", name: "Theo Vance" }];

function board(tasks: Task[], extra: Partial<Parameters<typeof BoardView>[0]> = {}, opts: { toasts?: boolean } = {}) {
  const props = { tasks, allTasks: tasks, onOpen: vi.fn(), onAdd: vi.fn(), onMove: vi.fn(), onPatch: vi.fn(), members };
  const ui = <BoardView {...props} {...extra} />;
  render(opts.toasts ? <ToastProvider>{ui}</ToastProvider> : ui);
  return props;
}
const cardEl = (id: string) => document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;
const cardIds = () => Array.from(document.querySelectorAll<HTMLElement>("[data-card-id]")).map((n) => n.dataset.cardId);
/** a native (HTML5) drag of one card onto another element */
function nativeDrag(fromId: string, onto: HTMLElement) {
  const data = new Map<string, string>();
  const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", get types() { return [...data.keys()]; }, effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(cardEl(fromId), { dataTransfer });
  fireEvent.dragOver(onto, { dataTransfer });
  fireEvent.drop(onto, { dataTransfer });
  fireEvent.dragEnd(cardEl(fromId), { dataTransfer });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("cards", () => {
  it("shows a cover image, else the project's cover when the board shows them, else nothing", () => {
    board([
      mk({ id: "img", title: "Deck", coverAttachmentId: "att-1" }),
      mk({ id: "plain", title: "Brief" }),
      mk({ id: "elsewhere", title: "Pricing", projectId: "p-growth" }),
    ], { coverUrls: { "att-1": "https://files.example/deck.png" }, scopeKey: "project:p-launch", boardSettings: { covers: true } });
    const img = cardEl("img").querySelector("img")!;
    expect(img).toHaveAttribute("src", "https://files.example/deck.png");
    expect(img).toHaveAttribute("alt", ""); // decorative: the title names the card
    expect(cardEl("img")).toHaveAttribute("data-cover", "image");
    expect(cardEl("plain")).toHaveAttribute("data-cover", "project");
    expect(cardEl("plain").querySelector(".kpcover")).not.toBeNull();
    expect(cardEl("elsewhere")).not.toHaveAttribute("data-cover"); // another project, covers off there
    // a link that fails falls back to the project's cover
    fireEvent.error(img);
    expect(cardEl("img")).toHaveAttribute("data-cover", "project");
  });

  it("renames in place from a click on the title: Enter saves, Escape keeps the old title", () => {
    const p = board([mk({ id: "a", title: "Write brief" })]);
    fireEvent.click(within(cardEl("a")).getByText("Write brief"));
    expect(p.onOpen).not.toHaveBeenCalled();
    const field = screen.getByRole("textbox", { name: "Rename Write brief" });
    fireEvent.change(field, { target: { value: "  Write the  launch brief " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(p.onPatch).toHaveBeenCalledWith("a", { title: "Write the launch brief" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Renamed to Write the launch brief");

    p.onPatch.mockClear();
    fireEvent.click(within(cardEl("a")).getByText("Write brief"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Nope" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(p.onPatch).not.toHaveBeenCalled();
    // an empty title is never saved
    fireEvent.click(within(cardEl("a")).getByText("Write brief"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(p.onPatch).not.toHaveBeenCalled();
  });

  it("gives focus back to the card when the field closes from the keyboard (Escape, or Enter with nothing changed)", () => {
    const p = board([mk({ id: "a", title: "Alpha" }), mk({ id: "b", title: "Beta" })]);
    const open = () => screen.getByRole("button", { name: /^Alpha, To do/ });
    open().focus();
    fireEvent.keyDown(open(), { key: "F2" });
    expect(screen.getByRole("textbox", { name: "Rename Alpha" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(open()).toHaveFocus();
    fireEvent.keyDown(open(), { key: "F2" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename Alpha" }), { key: "Enter" });
    expect(p.onPatch).not.toHaveBeenCalled();
    expect(open()).toHaveFocus();
    // a click on something else keeps what was clicked
    fireEvent.keyDown(open(), { key: "F2" });
    const other = screen.getByRole("button", { name: /^Beta, To do/ });
    act(() => other.focus());
    expect(other).toHaveFocus();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renames from the keyboard (F2 on the card) and never on a read-only board", () => {
    const p = board([mk({ id: "a", title: "Write brief" })]);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Write brief, To do/ }), { key: "F2" });
    expect(screen.getByRole("textbox", { name: "Rename Write brief" })).toHaveFocus();
    cleanup();
    const ro = board([mk({ id: "a", title: "Write brief" })], { readOnly: true });
    fireEvent.click(within(cardEl("a")).getByText("Write brief"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(ro.onOpen).toHaveBeenCalledWith("a"); // the title just opens the task
  });

  it("E renames the card under the keyboard cursor, once (a card moved afterwards doesn't reopen it)", () => {
    const p = board([mk({ id: "a", title: "Write brief" })]);
    const open = screen.getByRole("button", { name: /^Write brief, To do/ });
    open.focus();
    fireEvent.keyDown(open, { key: "e" });
    const field = screen.getByRole("textbox", { name: "Rename Write brief" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Write brief, To do/ }), { key: "ArrowRight", altKey: true });
    expect(p.onMove).toHaveBeenCalledWith("a", "progress", expect.any(Number));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("draws sub-task progress (else the checklist) and names it", () => {
    const parent = mk({ id: "p", title: "Offsite", subtasks: [{ id: "s", title: "x", done: true }] });
    const kids = [mk({ id: "k1", parentId: "p", status: "done" }), mk({ id: "k2", parentId: "p" })];
    const list = mk({ id: "c", title: "Checklist", subtasks: [{ id: "s1", title: "a", done: true }, { id: "s2", title: "b", done: true }] });
    board([parent, list], { allTasks: [parent, list, ...kids] });
    expect(within(cardEl("p")).getByRole("progressbar", { name: "1 of 2 sub-tasks done" })).toHaveAttribute("aria-valuenow", "1");
    expect(within(cardEl("c")).getByRole("progressbar", { name: "2 of 2 checklist items done" })).toBeInTheDocument();
    expect(cardEl("c").querySelector(".kbd-progress")).toHaveAttribute("data-complete", "true");
    expect(screen.getByRole("button", { name: /^Offsite, .*1 of 2 sub-tasks done/ })).toBeInTheDocument();
  });

  it("marks an overdue due date as a chip with a sign, not colour alone, and says so", () => {
    board([mk({ id: "late", title: "Late", dueDate: addDaysISO(today, -2) }), mk({ id: "now", title: "Now", dueDate: today }), mk({ id: "done", title: "Done", status: "done", dueDate: addDaysISO(today, -2) })]);
    const chip = cardEl("late").querySelector("[data-card-due]")!;
    expect(chip).toHaveAttribute("data-tone", "overdue");
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Late, .*overdue/ })).toBeInTheDocument();
    expect(cardEl("now").querySelector("[data-card-due]")).toHaveAttribute("data-tone", "today");
    expect(cardEl("done").querySelector("[data-card-due]")).not.toHaveAttribute("data-tone");
  });

  it("Move to… moves a card to another column, or onto Today, without dragging", () => {
    const p = board([mk({ id: "a", title: "Write brief" })]);
    fireEvent.click(within(cardEl("a")).getByRole("button", { name: "Move Write brief" }));
    const menu = screen.getByRole("menu", { name: "Move Write brief to" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /In review/ }));
    expect(p.onMove).toHaveBeenCalledWith("a", "review", expect.any(Number));
    fireEvent.click(within(cardEl("a")).getByRole("button", { name: "Move Write brief" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Add to Today/ }));
    expect(p.onPatch).toHaveBeenCalledWith("a", { planToday: true });
  });
});

describe("rows (swimlanes)", () => {
  const tasks = [
    mk({ id: "a", title: "Brief", assigneeId: "m-1", position: 1 }),
    mk({ id: "b", title: "Deck", assigneeId: "m-2", status: "progress", position: 2 }),
    mk({ id: "c", title: "Venue", assigneeId: "m-1", status: "progress", position: 3 }),
  ];

  it("groups rows by assignee from the board's own bar, remembered per board", () => {
    board(tasks, { scopeKey: "project:p-launch" });
    fireEvent.click(screen.getByRole("button", { name: "Rows" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Rows" })).getByRole("menuitemradio", { name: "Assignee" }));
    const maya = screen.getByRole("group", { name: "Maya Lin, 2 tasks" });
    expect(within(maya).getByRole("group", { name: "To do, Maya Lin" })).toContainElement(cardEl("a"));
    expect(within(maya).getByRole("group", { name: "In progress, Maya Lin" })).toContainElement(cardEl("c"));
    expect(screen.getByRole("group", { name: "Theo Vance, 1 task" })).toContainElement(cardEl("b"));
    expect(localStorage.getItem("kanbo-board-lanes:project:p-launch")).toBe("assignee");
    // the column heads show once, above the rows
    expect(screen.getAllByRole("button", { name: /tasks? in To do\. Set WIP limit/ })).toHaveLength(1);
    cleanup();
    board(tasks, { scopeKey: "project:p-other" });
    expect(document.querySelector(".kbd-swim")).toBeNull(); // another board keeps its own choice
  });

  it("folds a row away (and keeps it folded), its count still showing", () => {
    localStorage.setItem("kanbo-board-lanes:project:p-launch", "assignee");
    board(tasks, { scopeKey: "project:p-launch" });
    const toggle = screen.getByRole("button", { name: /Maya Lin\s*2/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(cardIds()).toEqual(["b"]);
    expect(JSON.parse(localStorage.getItem("kanbo-board-lanes-collapsed:project:p-launch")!)).toEqual(["assignee:m-1"]);
  });

  it("dropping a card in another row reassigns it; Alt+→ stays in its row", () => {
    localStorage.setItem("kanbo-board-lanes:project:p-launch", "assignee");
    const p = board(tasks, { scopeKey: "project:p-launch" });
    nativeDrag("a", screen.getByRole("group", { name: "In progress, Theo Vance" }));
    expect(p.onMove).toHaveBeenCalledWith("a", "progress", expect.any(Number));
    expect(p.onPatch).toHaveBeenCalledWith("a", { assigneeId: "m-2" });
    p.onMove.mockClear(); p.onPatch.mockClear();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Brief, To do/ }), { key: "ArrowRight", altKey: true });
    expect(p.onMove).toHaveBeenCalledWith("a", "progress", expect.any(Number));
    expect(p.onPatch).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Brief moved to In progress, Maya Lin");
  });

  it("never offers rows by what the columns already are", () => {
    board(tasks, { group: "assignee", onGroupChange: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Rows" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Assignee" })).toBeDisabled();
  });

  it("the page can take over the choice (Display › Rows)", () => {
    const onSwimlaneChange = vi.fn();
    board(tasks, { swimlane: "priority", onSwimlaneChange, onGroupChange: vi.fn(), group: "status" });
    expect(screen.queryByRole("button", { name: /^Rows/ })).toBeNull(); // no bar of its own
    expect(screen.getByRole("group", { name: "Medium, 3 tasks" })).toBeInTheDocument();
    render(<BoardDisplayOptions group="status" swimlane="priority" onSwimlaneChange={onSwimlaneChange} covers={false} onCoversChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Assignee" }));
    expect(onSwimlaneChange).toHaveBeenCalledWith("assignee");
    expect(screen.getByRole("switch", { name: "Show project covers" })).toHaveAttribute("aria-checked", "false");
  });
});

describe("WIP limits", () => {
  const two = [mk({ id: "a", title: "Brief" }), mk({ id: "b", title: "Deck" })];

  it("on a project board they're the project's, edited in the column menu for everyone", () => {
    const onChangeBoardSettings = vi.fn();
    board(two, { scopeKey: "project:p1", boardSettings: { wip: { todo: 1 } }, onChangeBoardSettings });
    const count = screen.getByRole("button", { name: /2 tasks in To do, WIP limit 1, over the limit/ });
    expect(count).toHaveTextContent("2/1");
    expect(count).toHaveAttribute("data-wip", "over");
    expect(document.querySelector(".kbd-lane")).toHaveAttribute("data-wip", "over");
    fireEvent.click(screen.getByRole("button", { name: "Options for To do column" }));
    const dialog = screen.getByRole("dialog", { name: "Options for To do" });
    expect(within(dialog).getByText("2 of 1: 1 over the limit.")).toBeInTheDocument();
    expect(within(dialog).getByText(/Shared with everyone on this board/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "One more" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "One more" }));
    expect(within(dialog).getByText("2 of 3: room for 1 more.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    // the whole object for the app's own copy, and just the change for the database to merge
    expect(onChangeBoardSettings).toHaveBeenCalledWith({ wip: { todo: 3 } }, { wip: { todo: 3 } });
    expect(localStorage.getItem("kanbo-board-wip:project:p1")).toBeNull();
  });

  it("people who can't change the board's settings see the limit, not an editor", () => {
    board(two, { scopeKey: "project:p1", boardSettings: { wip: { todo: 3 } } });
    fireEvent.click(screen.getByRole("button", { name: /2 tasks in To do, WIP limit 3\. Set WIP limit/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("spinbutton")).toBeNull();
    expect(within(dialog).getByText("2 of 3: room for 1 more.")).toBeInTheDocument();
  });

  it("offers this device's limits for this board up to the project once, and shares them only on a yes", () => {
    localStorage.setItem("kanbo-board-wip:project:p1", JSON.stringify({ "status:progress": 2, "priority:urgent": 1 }));
    const onChangeBoardSettings = vi.fn();
    board(two, { scopeKey: "project:p1", boardSettings: {}, onChangeBoardSettings }, { toasts: true });
    expect(onChangeBoardSettings).not.toHaveBeenCalled(); // nothing written just by opening the board
    expect(screen.getByText("You set WIP limits for this board on this device. Share them with everyone on it?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Share limits" }));
    expect(onChangeBoardSettings).toHaveBeenCalledTimes(1);
    expect(onChangeBoardSettings).toHaveBeenCalledWith({ wip: { progress: 2, "priority:urgent": 1 } }, { wip: { progress: 2, "priority:urgent": 1 } });
    expect(screen.getByText("WIP limits shared with everyone on this board.")).toBeInTheDocument();
    cleanup();
    board(two, { scopeKey: "project:p1", boardSettings: {}, onChangeBoardSettings }, { toasts: true });
    expect(screen.queryByRole("button", { name: "Share limits" })).toBeNull(); // asked once, ever
    expect(onChangeBoardSettings).toHaveBeenCalledTimes(1);
  });

  it("never offers the old device-wide limits, or anything to a board that already shares some", () => {
    localStorage.setItem("kanbo-board-wip", JSON.stringify({ "status:progress": 2 }));
    const onChangeBoardSettings = vi.fn();
    board(two, { scopeKey: "project:p1", boardSettings: {}, onChangeBoardSettings }, { toasts: true });
    expect(screen.queryByRole("button", { name: "Share limits" })).toBeNull();
    expect(onChangeBoardSettings).not.toHaveBeenCalled();
    // the board shows its own (none), not the device-wide ones
    expect(screen.getByRole("button", { name: /0 tasks in In progress\. Set WIP limit/ })).toHaveTextContent(/^0$/);
    cleanup(); localStorage.clear();
    localStorage.setItem("kanbo-board-wip:project:p2", JSON.stringify({ "status:todo": 9 }));
    board(two, { scopeKey: "project:p2", boardSettings: { wip: { review: 1 } }, onChangeBoardSettings }, { toasts: true });
    expect(screen.queryByRole("button", { name: "Share limits" })).toBeNull();
    expect(onChangeBoardSettings).not.toHaveBeenCalled();
  });

  it("a yes given late shares only what the board still doesn't have", () => {
    localStorage.setItem("kanbo-board-wip:project:p-late", JSON.stringify({ "status:progress": 2, "status:review": 4 }));
    const before = PROJECTS;
    setReferenceData({ projects: [...before, { id: "p-late", name: "Late", emoji: "📁", color: "oklch(0.7 0.1 200)", workspaceId: null }] });
    try {
      const onChangeBoardSettings = vi.fn();
      board(two, { scopeKey: "project:p-late", boardSettings: {}, onChangeBoardSettings }, { toasts: true });
      // meanwhile a teammate set In review's limit (a live update into the app's copy)
      setReferenceData({ projects: PROJECTS.map((x) => (x.id === "p-late" ? { ...x, boardSettings: { wip: { review: 1 } } } : x)) });
      fireEvent.click(screen.getByRole("button", { name: "Share limits" }));
      expect(onChangeBoardSettings).toHaveBeenCalledWith({ wip: { review: 1, progress: 2 } }, { wip: { progress: 2 } });
    } finally { setReferenceData({ projects: before }); }
  });

  it("builds the saved settings from the freshest copy, not the one the board last rendered", () => {
    const before = PROJECTS;
    setReferenceData({ projects: [...before, { id: "p-fresh", name: "Fresh", emoji: "📁", color: "oklch(0.7 0.1 200)", workspaceId: null, boardSettings: { wip: { todo: 4 } } }] });
    try {
      const onChangeBoardSettings = vi.fn();
      board(two, { scopeKey: "project:p-fresh", boardSettings: { wip: { todo: 4 } }, onChangeBoardSettings });
      // a teammate's limit arrives in the app's copy; this board hasn't re-rendered
      setReferenceData({ projects: PROJECTS.map((x) => (x.id === "p-fresh" ? { ...x, boardSettings: { wip: { todo: 4, review: 2 } } } : x)) });
      fireEvent.click(screen.getByRole("button", { name: /Project covers/ }));
      expect(onChangeBoardSettings).toHaveBeenLastCalledWith({ wip: { todo: 4, review: 2 }, covers: true }, { covers: true });
    } finally { setReferenceData({ projects: before }); }
  });

  it("a move that takes a column past its limit says so (toast and screen reader)", () => {
    const tasks = [mk({ id: "a", title: "Brief" }), mk({ id: "b", title: "Deck", status: "progress" })];
    const p = board(tasks, { scopeKey: "project:p1", boardSettings: { wip: { progress: 1 } }, onChangeBoardSettings: vi.fn() }, { toasts: true });
    fireEvent.keyDown(screen.getByRole("button", { name: /^Brief, To do/ }), { key: "ArrowRight", altKey: true });
    expect(p.onMove).toHaveBeenCalledWith("a", "progress", expect.any(Number));
    expect(screen.getAllByText(/In progress is over its WIP limit: 2 of 1/).length).toBeGreaterThanOrEqual(2);
  });

  it("removing a limit clears it", () => {
    const onChangeBoardSettings = vi.fn();
    board(two, { scopeKey: "project:p1", boardSettings: { wip: { todo: 5 }, covers: true } as BoardSettings, onChangeBoardSettings });
    fireEvent.click(screen.getByRole("button", { name: "Options for To do column" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove limit" }));
    expect(onChangeBoardSettings).toHaveBeenCalledWith({ covers: true }, { wip: { todo: null } });
  });
});

describe("project covers toggle", () => {
  it("writers turn the project's covers on for everyone from the board's bar", () => {
    const onChangeBoardSettings = vi.fn();
    board([mk({ id: "a" })], { scopeKey: "project:p1", boardSettings: { wip: { todo: 4 } }, onChangeBoardSettings });
    const t = screen.getByRole("button", { name: /Project covers/ });
    expect(t).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(t);
    expect(onChangeBoardSettings).toHaveBeenCalledWith({ wip: { todo: 4 }, covers: true }, { covers: true });
  });
  it("read-only boards don't offer it", () => {
    board([mk({ id: "a" })], { scopeKey: "project:p1", boardSettings: {}, readOnly: true });
    expect(screen.queryByRole("button", { name: /Project covers/ })).toBeNull();
  });
});

describe("demo", () => {
  it("seeded tasks wear their covers and the launch board its WIP limits", () => {
    const deck = mk({ id: "t-1", title: "Finalise Q3 launch narrative deck", status: "progress" });
    board([deck], { scopeKey: "project:p-launch", boardSettings: {}, onChangeBoardSettings: vi.fn() });
    expect(cardEl("t-1").querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByRole("button", { name: /1 task in In progress, WIP limit 3\./ })).toHaveTextContent("1/3");
    cleanup();
    // choosing "no cover" sticks
    board([{ ...deck, coverAttachmentId: null }]);
    expect(cardEl("t-1").querySelector("img")).toBeNull();
  });
});

describe("long columns", () => {
  it("keeps the card open in the task panel rendered, however far down", () => {
    const many = Array.from({ length: 150 }, (_, i) => mk({ id: `t${i}`, title: `Task ${i}`, position: i }));
    board(many, { activeId: "t140" });
    expect(cardIds()).toContain("t140");
    expect(cardIds()).toContain("t139");
    expect(cardIds()).toContain("t141");
    expect(cardIds().length).toBeLessThan(60);
  });

  it("J moves through the cards and past the rendered window", () => {
    const many = Array.from({ length: 80 }, (_, i) => mk({ id: `t${i}`, title: `Task ${i}`, position: i }));
    board(many);
    const first = cardIds().length;
    for (let i = 0; i < first + 3; i++) fireEvent.keyDown(window, { key: "j" });
    const focused = (document.activeElement as HTMLElement).closest<HTMLElement>("[data-card-id]")?.dataset.cardId;
    expect(focused).toBe(`t${first + 2}`);
  });
});
