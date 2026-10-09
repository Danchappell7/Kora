import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, createEvent } from "@testing-library/react";
import type { TaskDragSourceOptions } from "../../lib/dnd";
import type { Task } from "../../data/types";
import type { GroupBy } from "../../app-types";
import { installPointerEvent, down } from "../phone/testPointer";

installPointerEvent();

// lib/dnd is u3's: here it only has to be bound the way its contract says
const calls = new Map<string, TaskDragSourceOptions>();
const pressed = vi.fn();
vi.mock("../../lib/dnd", async (orig) => {
  const real = await orig<typeof import("../../lib/dnd")>();
  return {
    ...real,
    useTaskDragSource: (o: TaskDragSourceOptions) => {
      calls.set(o.originId, o);
      return o.disabled ? { bind: {}, isDragging: false } : { bind: { onPointerDown: pressed, "data-kdnd-source": o.originId }, isDragging: false };
    },
  };
});
const { ListView } = await import("./ListView");

let n = 0;
const mk = (p: Partial<Task> & { title: string }): Task => ({
  id: p.id ?? `t-${++n}`, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 50, ...p,
});
const base = (tasks: Task[], extra: Partial<Parameters<typeof ListView>[0]> = {}) => ({
  tasks, allTasks: tasks, onOpen: vi.fn(), onToggle: vi.fn(), onToggleSubtask: vi.fn(), groupBy: "none" as GroupBy, smart: false, ...extra,
});
const touch = () => {
  const orig = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: /hover: none|pointer: coarse/.test(q), media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = orig; };
};

describe("ListView rows as drag-to-plan sources (desktop)", () => {
  beforeEach(() => { calls.clear(); pressed.mockClear(); });

  it("the whole row is a source from a list that doesn't reorder (My tasks' own groups)", () => {
    const a = mk({ title: "Send the brief" });
    render(<ListView {...base([a], { onPatch: vi.fn(), groups: [{ key: "open", label: "Open", items: [a] }] })} />);
    const o = calls.get(a.id)!;
    expect(o).toMatchObject({ source: "list", originId: a.id, label: "Send the brief", disabled: false });
    const row = screen.getByRole("group", { name: "Send the brief" });
    expect(row).toHaveAttribute("data-kdnd-source", a.id);
    down(row, 10, 10, { pointerType: "mouse" });
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".kph-grip")).toBeNull();
  });

  it("a selected row carries the whole selection, in the order it's on screen", () => {
    const a = mk({ title: "Alpha", position: 1 }), b = mk({ title: "Bravo", position: 2 }), c = mk({ title: "Charlie", position: 3 });
    render(<ListView {...base([a, b, c], { onPatch: vi.fn(), onBulkPatch: vi.fn(), sort: "title" })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “Charlie”" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “Alpha”" }));
    const ids = (o: TaskDragSourceOptions) => (typeof o.taskIds === "function" ? o.taskIds() : o.taskIds);
    expect(ids(calls.get(c.id)!)).toEqual([a.id, c.id]);
    // an unselected row goes alone
    expect(ids(calls.get(b.id)!)).toEqual([b.id]);
  });

  it("where rows reorder by dragging, the kit starts from the grip and the row keeps its native drag", () => {
    const a = mk({ title: "Draft agenda" });
    render(<ListView {...base([a], { onPatch: vi.fn(), groupBy: "status" })} />);
    const row = screen.getByRole("group", { name: "Draft agenda" });
    expect(row).toHaveAttribute("draggable", "true");
    expect(row).not.toHaveAttribute("data-kdnd-source");
    const grip = row.querySelector<HTMLElement>(".kph-grip")!;
    expect(grip).toHaveAttribute("aria-hidden", "true");
    expect(grip).toHaveAttribute("data-kdnd-source", a.id);
    down(grip, 10, 10, { pointerType: "mouse" });
    expect(pressed).toHaveBeenCalledTimes(1);
    // the grip never starts the browser's own drag (that's the row's reorder)
    const ev = createEvent.dragStart(grip);
    fireEvent(grip, ev);
    expect(ev.defaultPrevented).toBe(true);
    // a press on the row itself is the reorder's, not the kit's
    pressed.mockClear();
    down(within(row).getByRole("button", { name: "Draft agenda" }), 10, 10, { pointerType: "mouse" });
    expect(pressed).not.toHaveBeenCalled();
  });

  it("read-only people and touch screens bind nothing", () => {
    const a = mk({ title: "Look only" });
    const { unmount } = render(<ListView {...base([a], { onPatch: vi.fn(), readOnly: true })} />);
    expect(calls.get(a.id)?.disabled).toBe(true);
    expect(screen.getByRole("group", { name: "Look only" })).not.toHaveAttribute("data-kdnd-source");
    unmount();
    const restore = touch();
    try {
      render(<ListView {...base([a], { onPatch: vi.fn() })} />);
      expect(calls.get(a.id)?.disabled).toBe(true);
    } finally { restore(); }
  });

  it("dragToPlan={false} turns it off", () => {
    const a = mk({ title: "Not today" });
    render(<ListView {...base([a], { onPatch: vi.fn(), dragToPlan: false })} />);
    expect(calls.get(a.id)?.disabled).toBe(true);
  });
});
