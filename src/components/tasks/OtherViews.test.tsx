import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor, cleanup, act } from "@testing-library/react";
import { BoardView, TimelineView, CalendarView, MatrixView, FilesView } from "./OtherViews";
import { store } from "../../data/store";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import { addDaysISO } from "./otherViewsLogic";
import type { Task, Attachment, CalendarConnection, ExternalEvent } from "../../data/types";

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

  it("opens cards from a real button, and the card isn't a button wrapping other controls", () => {
    const p = board([mk({ id: "a", title: "Write brief" })]);
    const open = screen.getByRole("button", { name: /^Write brief, To do/ });
    expect(open.tagName).toBe("BUTTON"); // native Enter / Space
    fireEvent.click(open);
    expect(p.onOpen).toHaveBeenCalledTimes(1);
    const card = document.querySelector<HTMLElement>('[data-card-id="a"]')!;
    expect(card).toHaveAttribute("role", "group");
    expect(card).toHaveAccessibleName("Write brief");
    expect(card.querySelector('[role="button"]')).toBeNull();
    expect(open.closest('[role="button"]')).toBeNull();
    // the open button comes first in the card's tab order
    expect(card.querySelector("button")).toBe(open);
    fireEvent.click(card); // mouse clicks anywhere on the card still open it
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

  it("moves archived cards too (they aren't in allTasks), and never announces a move that didn't happen", () => {
    const archived = [mk({ id: "a", title: "Old brief", archivedAt: "2026-09-01" })];
    const p = board(archived, { allTasks: [] });
    fireEvent.keyDown(screen.getByRole("button", { name: /^Old brief, To do/ }), { key: "ArrowRight", altKey: true });
    expect(p.onMove).toHaveBeenCalledWith("a", "progress", expect.any(Number));
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Old brief moved to In progress");
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

  it("never guesses the board from the visible tasks, and keeps limits set before they were per board", () => {
    // a My tasks board (no scopeKey passed) whose tasks all sit in one project doesn't pick up that project's limits
    localStorage.setItem("kanbo-board-wip:project:p-launch", JSON.stringify({ "status:todo": 1 }));
    board([mk({ id: "a" }), mk({ id: "b" })]);
    expect(screen.queryByRole("button", { name: /WIP limit \d/ })).toBeNull();
    cleanup();
    // limits saved under the old device-wide key still show, with or without a scopeKey
    localStorage.clear();
    localStorage.setItem("kanbo-board-wip", JSON.stringify({ "status:todo": 1 }));
    board([mk({ id: "a" }), mk({ id: "b" })]);
    expect(screen.getByRole("button", { name: /WIP limit 1, over the limit/ })).toBeInTheDocument();
    cleanup();
    board([mk({ id: "a" }), mk({ id: "b" })], { scopeKey: "project:p-launch" });
    expect(screen.getByRole("button", { name: /WIP limit 1, over the limit/ })).toBeInTheDocument();
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

  it("pins the marker for a bar after the window to the visible edge, not the far end of the track", () => {
    render(<TimelineView tasks={[mk({ id: "far", title: "Launch", dueDate: addDaysISO(today, 30) }), mk({ id: "old", title: "Audit", dueDate: addDaysISO(today, -30) })]} onOpen={noop} onPatch={vi.fn()} />);
    const after = screen.getByRole("button", { name: /Launch is due .* after these dates/ });
    const before = screen.getByRole("button", { name: /Audit is due .* before these dates/ });
    for (const chip of [after, before]) {
      expect(chip.style.position).toBe("sticky");
      expect(getComputedStyle(chip.parentElement!).display).toBe("flex");
    }
    expect(after.style.right).not.toBe("");
    expect(after.style.marginLeft).toBe("auto");
    expect(before.style.left).not.toBe("");
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

  describe("connected calendars", () => {
    const conns: CalendarConnection[] = [
      { id: "c1", provider: "google", accountEmail: "ada@work.example", canChoose: true, selectedCalendars: [
        { id: "w", name: "Work", color: "#3f7fe0", primary: true }, { id: "t", name: "Launch team", color: "#2e9d6a", primary: false }] },
      { id: "c2", provider: "microsoft", accountEmail: "ada@outlook.example", canChoose: true, selectedCalendars: null },
    ];
    const at = (h: number) => { const d = new Date(KANBO_TODAY); d.setHours(h, 0, 0, 0); return d.toISOString(); };
    const events: ExternalEvent[] = [
      { id: "e1", title: "Standup", start: at(9), end: at(10), allDay: false, provider: "google", connectionId: "c1", calendarId: "w", calendarName: "Work", color: "#3f7fe0" },
      { id: "e2", title: "Launch sync", start: at(11), end: at(12), allDay: false, provider: "google", connectionId: "c1", calendarId: "t", calendarName: "Launch team", color: "#2e9d6a" },
    ];
    const chips = () => screen.getByRole("group", { name: "Calendars shown on Month" });

    it("each event carries its calendar's colour; the legend names every calendar shown", () => {
      render(<CalendarView tasks={[]} onOpen={noop} connections={conns} externalEvents={events} />);
      expect(within(chips()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Work", "Launch team", "ada@outlook.example"]);
      const sync = screen.getByText("Launch sync").closest(".ktv-cal-event") as HTMLElement;
      expect(sync.style.getPropertyValue("--kcal")).toMatch(/^oklch\(/);
      expect(sync.getAttribute("title")).toBe("11:00 · Launch sync · Launch team");
      expect(sync.style.getPropertyValue("--kcal")).not.toBe((screen.getByText("Standup").closest(".ktv-cal-event") as HTMLElement).style.getPropertyValue("--kcal"));
    });

    it("a chip hides that calendar on Month for now (remembered on this device), and shows it again", () => {
      render(<CalendarView tasks={[]} onOpen={noop} connections={conns} externalEvents={events} />);
      const team = within(chips()).getByRole("button", { name: "Launch team" });
      expect(team).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(team);
      expect(team).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByText("Launch sync")).toBeNull();
      expect(screen.getByText("Standup")).toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem("kanbo-cal-hidden")!)).toEqual(["c1|t"]);
      cleanup();
      render(<CalendarView tasks={[]} onOpen={noop} connections={conns} externalEvents={events} />);
      expect(screen.queryByText("Launch sync")).toBeNull();
      fireEvent.click(within(chips()).getByRole("button", { name: "Launch team" }));
      expect(screen.getByText("Launch sync")).toBeInTheDocument();
      expect(localStorage.getItem("kanbo-cal-hidden")).toBeNull();
    });

    it("says when a calendar couldn't load, with a way to Settings", () => {
      const onOpenSettings = vi.fn();
      render(<CalendarView tasks={[]} onOpen={noop} connections={conns} externalEvents={events} onOpenSettings={onOpenSettings}
        warnings={[{ connectionId: "c2", provider: "microsoft", accountEmail: "ada@outlook.example", reason: "reconnect" }]} />);
      expect(screen.getByText("1 calendar couldn't load")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "See Settings" }));
      expect(onOpenSettings).toHaveBeenCalled();
    });

    it("a project's calendar (no connections) has no legend", () => {
      render(<CalendarView tasks={[]} onOpen={noop} />);
      expect(screen.queryByRole("group", { name: "Calendars shown on Month" })).toBeNull();
    });
  });

  it("month → week → month comes back to the same month", () => {
    render(<CalendarView tasks={[]} onOpen={noop} />);
    const label = () => screen.getByText(/^[A-Z][a-z]+ \d{4}$/).textContent;
    for (let step = 0; step < 4; step++) {
      const before = label();
      fireEvent.click(screen.getByRole("button", { name: "Week" }));
      fireEvent.click(screen.getByRole("button", { name: "Month" }));
      expect(label()).toBe(before);
      fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    }
  });

  it("week view moves between weeks", () => {
    render(<CalendarView tasks={[]} onOpen={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
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

  it("switching to another project never shows the previous project's files", async () => {
    spies.push(vi.spyOn(console, "error").mockImplementation(noop));
    const attA: Attachment = { ...att, id: "fa", taskId: "a1", name: "A-secret-plan.pdf" };
    let rejectB!: (e: unknown) => void;
    const list = vi.spyOn(store, "listProjectAttachments");
    spies.push(list);
    list.mockResolvedValueOnce([attA]).mockImplementationOnce(() => new Promise((_, rej) => { rejectB = rej; }));
    const { rerender } = render(<FilesView tasks={[mk({ id: "a1", title: "A task", projectId: "pA" })]} onOpen={noop} />);
    expect(await screen.findByText("A-secret-plan.pdf")).toBeInTheDocument();
    // same FilesView instance (App doesn't remount TasksPage between projects), different tasks
    rerender(<FilesView tasks={[mk({ id: "b1", title: "B task", projectId: "pB" })]} onOpen={noop} />);
    expect(screen.getByText("Loading files…")).toBeInTheDocument();
    expect(screen.queryByText("A-secret-plan.pdf")).toBeNull();
    await act(async () => { rejectB(new Error("network")); });
    expect(screen.getByText("Couldn't load files")).toBeInTheDocument();
    expect(screen.queryByText("A-secret-plan.pdf")).toBeNull();
  });

  it("keeps the list up while a task is added, and doesn't refetch for fewer or re-sorted tasks", async () => {
    const list = vi.spyOn(store, "listProjectAttachments").mockResolvedValue([att]);
    spies.push(list);
    const a = mk({ id: "a", title: "Brief" }), b = mk({ id: "b", title: "Plan" });
    const { rerender } = render(<FilesView tasks={[a, b]} onOpen={noop} />);
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    rerender(<FilesView tasks={[b, a]} onOpen={noop} />); // AI sort / reorder
    rerender(<FilesView tasks={[a]} onOpen={noop} />);    // a filter narrows the view
    expect(list).toHaveBeenCalledTimes(1);
    rerender(<FilesView tasks={[b]} onOpen={noop} />);    // the file's task is filtered out
    expect(screen.queryByText("brief.pdf")).toBeNull();
    expect(screen.getByText("No files yet")).toBeInTheDocument();
    rerender(<FilesView tasks={[a, b, mk({ id: "c", title: "New" })]} onOpen={noop} />); // a task added
    expect(screen.queryByText("Loading files…")).toBeNull();
    expect(screen.getByText("brief.pdf")).toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
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
