/* The board on the drag kit (lib/dnd, u3): with the kit live, cards are its
   sources (not HTML5-draggable) and every column — every column within a row —
   is a "board-column" target whose drop runs the board's own move. The kit is
   mocked here (it's inert in this branch), so these pin the board's half. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup, act } from "@testing-library/react";
import type { TaskDragSourceOptions, TaskDropTargetOptions, TaskDragPayload } from "../../lib/dnd";
import type { Task } from "../../data/types";

const h = vi.hoisted(() => ({
  sources: new Map<string, TaskDragSourceOptions>(),
  targets: new Map<string, TaskDropTargetOptions>(),
  press: vi.fn(),
  drop: vi.fn((_p: unknown, _t: unknown) => true),
}));
vi.mock("../../lib/dnd", async (orig) => {
  const real = await orig<typeof import("../../lib/dnd")>();
  return {
    ...real,
    useTaskDragSource: (o: TaskDragSourceOptions) => {
      h.sources.set(o.originId, o);
      return { bind: o.disabled ? {} : { onPointerDown: h.press, "data-kdnd-source": o.source }, isDragging: false };
    },
    useTaskDropTarget: (o: TaskDropTargetOptions) => {
      if (!o.disabled) h.targets.set(o.target.id, o); else h.targets.delete(o.target.id);
      return { bind: { ref: () => undefined, ...(o.disabled ? {} : { "data-kdnd-target": o.target.kind }) }, isOver: false, canDrop: false, payload: null };
    },
    useDropTargets: () => [{ kind: "project", id: "p-brand", label: "Brand Refresh" }, { kind: "project", id: "p-launch", label: "Q3 Product Launch" }],
    dropOnTarget: h.drop,
  };
});
const { BoardView } = await import("../tasks/OtherViews");

const mk = (over: Partial<Task>): Task => ({
  id: "t", title: "Task", description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...over,
});
const members = [{ id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }];
function board(tasks: Task[], extra: Partial<Parameters<typeof BoardView>[0]> = {}) {
  const props = { tasks, allTasks: tasks, onOpen: vi.fn(), onAdd: vi.fn(), onMove: vi.fn(), onPatch: vi.fn(), onBulkPatch: vi.fn(), members };
  render(<BoardView {...props} {...extra} />);
  return props;
}
const card = (id: string) => document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;
const payload = (ids: string[], source: TaskDragPayload["source"] = "board"): TaskDragPayload => ({ taskIds: ids, source, originId: ids[0] });
const keyDrop = (targetId: string, ids: string[]) => {
  const t = h.targets.get(targetId)!;
  act(() => t.onDrop({ payload: payload(ids), target: t.target, point: null, within: null, via: "keyboard" }));
};

beforeEach(() => { localStorage.clear(); h.sources.clear(); h.targets.clear(); h.press.mockClear(); h.drop.mockClear(); });
afterEach(() => { cleanup(); });

describe("the board on the drag kit", () => {
  it("cards are kit sources, not HTML5-draggable, and a press in a card's menu never picks it up", () => {
    board([mk({ id: "a", title: "Brief" })]);
    expect(card("a")).toHaveAttribute("draggable", "false");
    expect(card("a")).toHaveAttribute("data-kdnd-source", "board");
    expect(h.sources.get("a")).toMatchObject({ source: "board", label: "Brief", disabled: false });
    fireEvent.pointerDown(card("a"));
    expect(h.press).toHaveBeenCalledTimes(1);
    fireEvent.click(within(card("a")).getByRole("button", { name: /Change status of Brief/ }));
    fireEvent.pointerDown(screen.getByRole("menu", { name: "Status of Brief" }));
    expect(h.press).toHaveBeenCalledTimes(1);
  });

  it("every column is a board-column target; a drop runs the board's move", () => {
    const p = board([mk({ id: "a", title: "Brief" }), mk({ id: "b", title: "Deck", status: "progress", position: 5 })]);
    expect([...h.targets.values()].map((t) => t.target.kind)).toEqual(Array(5).fill("board-column"));
    expect(h.targets.get("progress")!.target).toMatchObject({ label: "In progress", data: { column: "progress", lane: null, status: "progress", listed: true } });
    keyDrop("progress", ["a"]);
    expect(p.onMove).toHaveBeenCalledWith("a", "progress", 6); // after the last card
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Brief moved to In progress");
  });

  it("takes only this board's own cards, into a column that can take them", () => {
    board([mk({ id: "a" })]);
    const t = h.targets.get("review")!;
    expect(t.accepts!(payload(["a"]))).toBe(true);
    expect(t.accepts!(payload(["a"], "inbox"))).toBe(false);
    expect(t.accepts!(payload(["somewhere-else"]))).toBe(false);
    cleanup(); h.targets.clear();
    board([mk({ id: "a" })], { readOnly: true });
    expect(h.targets.size).toBe(0);
    expect(h.sources.get("a")!.disabled).toBe(true);
  });

  it("a selected card carries the whole selection, and they land together in order", () => {
    const p = board([mk({ id: "a", title: "One", position: 1 }), mk({ id: "b", title: "Two", position: 2 }), mk({ id: "c", title: "Three", status: "review", position: 1 })]);
    fireEvent.click(within(card("b")).getByRole("checkbox", { name: "Select Two" }));
    fireEvent.click(within(card("a")).getByRole("checkbox", { name: "Select One" }));
    const ids = (h.sources.get("a")!.taskIds as () => string[])();
    expect(ids).toEqual(["a", "b"]);
    expect((h.sources.get("c")!.taskIds as () => string[])()).toEqual(["c"]);
    keyDrop("review", ids);
    const calls = p.onMove.mock.calls.map(([id, status, pos]) => [id, status, pos]);
    expect(calls.map((c) => c.slice(0, 2))).toEqual([["a", "review"], ["b", "review"]]);
    expect(calls[0][2]).toBeLessThan(calls[1][2] as number);
    expect(calls[0][2]).toBeGreaterThan(1); // after "Three"
  });

  it("rows make one target per column per row (left out of Move to… menus)", () => {
    localStorage.setItem("kanbo-board-lanes:project:p1", "assignee");
    const p = board([mk({ id: "a", title: "Brief", assigneeId: "m-1" }), mk({ id: "b", title: "Deck", assigneeId: "m-self" })], { scopeKey: "project:p1" });
    const cell = [...h.targets.values()].find((t) => t.target.data?.column === "review" && t.target.data?.lane === "m-self")!;
    expect(cell.target).toMatchObject({ label: "In review, Daniel Okai", data: { listed: false } });
    keyDrop(cell.target.id, ["a"]);
    expect(p.onMove).toHaveBeenCalledWith("a", "review", expect.any(Number));
    expect(p.onPatch).toHaveBeenCalledWith("a", { assigneeId: "m-self" });
  });

  it("Move to… offers the places on screen that take tasks (not the card's own project)", () => {
    board([mk({ id: "a", title: "Brief" })]);
    fireEvent.click(within(card("a")).getByRole("button", { name: "Move Brief" }));
    const menu = screen.getByRole("menu", { name: "Move Brief to" });
    expect(within(menu).queryByRole("menuitem", { name: /Q3 Product Launch/ })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Brand Refresh/ }));
    expect(h.drop).toHaveBeenCalledWith({ taskIds: ["a"], source: "board", originId: "a" }, expect.objectContaining({ kind: "project", id: "p-brand" }));
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Brief moved to Brand Refresh");
  });
});
