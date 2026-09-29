import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ListView, dropPosition, dueDateForBucket } from "./ListView";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import type { Task, Project } from "../../data/types";
import type { GroupBy } from "../../app-types";

let n = 0;
const mk = (p: Partial<Task> & { title: string }): Task => ({
  id: p.id ?? `t-${++n}`, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 50, ...p,
});

const base = (tasks: Task[], extra: Partial<Parameters<typeof ListView>[0]> = {}) => ({
  tasks, allTasks: tasks, onOpen: vi.fn(), onToggle: vi.fn(), onToggleSubtask: vi.fn(), groupBy: "status" as GroupBy, smart: false, ...extra,
});

const iso = (d: number) => toLocalISO(new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate() + d));

describe("dueDateForBucket", () => {
  it("maps each Due group to a date inside that group", () => {
    const today = new Date(2026, 8, 30);
    expect(dueDateForBucket("overdue", today)).toBe("2026-09-30");
    expect(dueDateForBucket("today", today)).toBe("2026-09-30");
    expect(dueDateForBucket("week", today)).toBe("2026-10-01");
    expect(dueDateForBucket("later", today)).toBe("2026-10-08");
    expect(dueDateForBucket("nodate", today)).toBeUndefined();
  });
});

describe("dropPosition", () => {
  // Priority group, manual order: A (1), C (3), then done B (2) at the bottom
  const A = mk({ id: "A", title: "A", position: 1 });
  const C = mk({ id: "C", title: "C", position: 3 });
  const B = mk({ id: "B", title: "B", position: 2, status: "done" });
  const shown = [A, C, B];

  it("dropping on the top half of a done row means 'after the last open row'", () => {
    const pos = dropPosition(shown, "D", "B", "top", false);
    expect(pos).toBeGreaterThan(3); // after C — not between A and B (1.5), which rendered before C
  });

  it("uses the rendered order for neighbours within the open rows", () => {
    expect(dropPosition(shown, "D", "C", "top", false)).toBe(2); // between A (1) and C (3)
    expect(dropPosition(shown, "D", "A", "top", false)).toBe(0); // before A
  });

  it("a completed task dropped among open rows stays in the done band", () => {
    expect(dropPosition(shown, "E", "A", "top", true)).toBe(1); // before B (2) in the done band
  });

  it("null target drops at the top of the group", () => {
    expect(dropPosition(shown, "D", null, "top", false)).toBe(0);
  });
});

describe("ListView empty states", () => {
  it("says 'No tasks match these filters' (with Clear) when filters empty the list — no quick-add", () => {
    const onClearFilters = vi.fn(), onQuickAdd = vi.fn();
    render(<ListView {...base([], { filtered: true, onClearFilters, onQuickAdd })} />);
    expect(screen.getByText("No tasks match these filters")).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet")).toBeNull();
    expect(screen.queryByPlaceholderText("Task name, then Enter…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("keeps the 'No tasks yet' quick-add for a genuinely empty list", () => {
    const onQuickAdd = vi.fn();
    render(<ListView {...base([], { onQuickAdd })} />);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    const input = screen.getByLabelText("New task name");
    fireEvent.change(input, { target: { value: "First task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onQuickAdd).toHaveBeenCalledWith({ title: "First task", status: "todo" });
  });

  it("never steals focus from the search box when a search empties the list", () => {
    const search = document.createElement("input");
    document.body.appendChild(search);
    search.focus();
    const tasks = [mk({ title: "Invoice run" })];
    const { rerender } = render(<ListView {...base(tasks, { onQuickAdd: vi.fn() })} />);
    rerender(<ListView {...base([], { onQuickAdd: vi.fn() })} />); // filter "inv…" matched nothing (not wired as filtered)
    expect(document.activeElement).toBe(search);
    search.remove();
  });
});

describe("ListView rows", () => {
  it("opens a task from its title button, and labels controls with the task and current value", () => {
    const t = mk({ title: "Q3 budget", status: "progress", priority: "high" });
    const props = base([t], { onPatch: vi.fn(), members: [{ id: "m-self", name: "Daniel Okai" }] });
    render(<ListView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Q3 budget" }));
    expect(props.onOpen).toHaveBeenCalledWith(t.id);
    expect(screen.getByRole("button", { name: "Status: In progress. Change status for “Q3 budget”" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Priority: High. Change priority for “Q3 budget”" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assigned to Daniel Okai. Change assignee for “Q3 budget”" })).toBeInTheDocument();
    expect(screen.getByLabelText("Due date for “Q3 budget”")).toBeInTheDocument();
  });

  it("renders the status menu outside the row (portal) and patches without opening the task", () => {
    const t = mk({ title: "Write brief" });
    const props = base([t], { onPatch: vi.fn() });
    const { container } = render(<ListView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^Status: To do/ }));
    const menu = screen.getByRole("menu", { name: "Status for “Write brief”" });
    expect(container.contains(menu)).toBe(false);
    expect(within(menu).getByRole("menuitemradio", { name: /To do/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /In progress/ }));
    expect(props.onPatch).toHaveBeenCalledWith(t.id, { status: "progress", completedAt: undefined });
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Alt+↓ on a title moves the task below its neighbour (keyboard reorder)", () => {
    const a = mk({ title: "Alpha", position: 1 }), b = mk({ title: "Bravo", position: 2 }), c = mk({ title: "Charlie", position: 3 });
    const props = base([a, b, c], { onPatch: vi.fn() });
    render(<ListView {...props} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Alpha" }), { key: "ArrowDown", altKey: true });
    expect(props.onPatch).toHaveBeenCalledWith(a.id, { position: 2.5 });
  });
});

describe("ListView under Due grouping", () => {
  it("'Add task' under Today creates a task due today; Completed has no 'Add task'", () => {
    const onQuickAdd = vi.fn();
    const tasks = [mk({ title: "Due today", dueDate: iso(0) }), mk({ title: "Shipped", status: "done", dueDate: iso(-2) })];
    render(<ListView {...base(tasks, { groupBy: "due", onQuickAdd })} />);
    expect(screen.queryByRole("button", { name: "Add task to Completed" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add task to Today" }));
    const input = screen.getByLabelText("New task in Today");
    fireEvent.change(input, { target: { value: "Call accountant" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onQuickAdd).toHaveBeenCalledWith({ title: "Call accountant", dueDate: iso(0) });
  });
});

describe("ListView read-only (guests)", () => {
  it("hides add/edit/bulk controls but still opens tasks", () => {
    const t = mk({ title: "Read me" });
    const props = base([t], { readOnly: true, onPatch: vi.fn(), onQuickAdd: vi.fn(), onBulkPatch: vi.fn(), members: [{ id: "m-self", name: "Daniel Okai" }] });
    render(<ListView {...props} />);
    expect(screen.queryByRole("button", { name: /Add task/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Change status/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Mark as done/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByLabelText(/Due date for/)).toBeNull();
    expect(screen.getByRole("img", { name: "Status: To do" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read me" }));
    expect(props.onOpen).toHaveBeenCalledWith(t.id);
  });

  it("offers no quick-add in an empty read-only list", () => {
    render(<ListView {...base([], { readOnly: true, onQuickAdd: vi.fn() })} />);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryByLabelText("New task name")).toBeNull();
  });
});

describe("ListView bulk selection", () => {
  it("shift-click selects a range, and select-all toggles a whole group", () => {
    const tasks = [mk({ title: "One", position: 1 }), mk({ title: "Two", position: 2 }), mk({ title: "Three", position: 3 })];
    render(<ListView {...base(tasks, { onBulkPatch: vi.fn() })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “One”" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “Three”" }), { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    const all = screen.getByRole("checkbox", { name: "Select all tasks in To do" });
    expect(all).toHaveAttribute("aria-checked", "true");
    fireEvent.click(all);
    expect(screen.queryByRole("toolbar")).toBeNull();
    fireEvent.click(all);
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("Escape clears the selection from the list, but not when it's closing something else", () => {
    const tasks = [mk({ title: "One" }), mk({ title: "Two" })];
    render(<ListView {...base(tasks, { onBulkPatch: vi.fn() })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “One”" }));
    const elsewhere = document.createElement("input"); // e.g. the task panel
    document.body.appendChild(elsewhere);
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    elsewhere.remove();
    fireEvent.keyDown(screen.getByRole("button", { name: "One" }), { key: "Escape" });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("bulk-moving a parent to another project brings its sub-tasks and clears their sections", async () => {
    const parent = mk({ id: "par", title: "Website relaunch", projectId: "p-launch", sectionId: "s-old" });
    const kid = mk({ id: "kid", title: "Hero copy", projectId: "p-launch", parentId: "par", sectionId: "s-old" });
    const stay = mk({ id: "stay", title: "Already there", projectId: "p-brand" });
    const projects: Project[] = [
      { id: "p-launch", name: "Q3 Product Launch", emoji: "", color: "red", workspaceId: "ws-foundrise" },
      { id: "p-brand", name: "Brand Refresh", emoji: "", color: "blue", workspaceId: "ws-foundrise" },
    ];
    const onBulkPatch = vi.fn();
    render(<ListView {...base([parent, kid, stay], { onBulkPatch, projects })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “Website relaunch”" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “Already there”" }));
    fireEvent.click(screen.getByRole("button", { name: /Project/ }));
    await waitFor(() => expect(screen.getByRole("menu", { name: "Project" })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("menu", { name: "Project" })).getByRole("menuitem", { name: /Brand Refresh/ }));
    expect(onBulkPatch).toHaveBeenCalledTimes(1);
    const [ids, patch] = onBulkPatch.mock.calls[0];
    expect([...ids].sort()).toEqual(["kid", "par"]); // "stay" is already in Brand Refresh
    expect(patch).toEqual({ projectId: "p-brand", workspaceId: "ws-foundrise", sectionId: undefined });
  });
});
