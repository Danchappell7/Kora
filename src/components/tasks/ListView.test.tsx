import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { ToastProvider } from "../Toast";
import { ListView, dropPosition, planDrop, dueDateForBucket } from "./ListView";
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

// a ListView whose onPatch / onToggle really update its tasks (like App), so rows regroup and reorder
function Live({ initial, ...extra }: { initial: Task[] } & Partial<Parameters<typeof ListView>[0]>) {
  const [tasks, setTasks] = useState(initial);
  const onPatch = (id: string, p: Partial<Task>) => setTasks((ts) => ts.map((t) => t.id === id ? { ...t, ...p } : t));
  const onToggle = (id: string) => setTasks((ts) => ts.map((t) => t.id === id ? { ...t, status: t.status === "done" ? "todo" : "done" } : t));
  return <ListView {...base(tasks, { onPatch, onToggle, ...extra })} />;
}
const rowOrder = (root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLElement>("[data-row-title]")).map((el) => el.textContent);

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
    // the status glyph IS the completion checkbox; it still says which status the task is in
    const glyph = screen.getByRole("checkbox", { name: "Done: Q3 budget" });
    expect(glyph).toHaveAttribute("aria-checked", "false");
    expect(glyph).toHaveAccessibleDescription("In progress");
    expect(screen.getByRole("button", { name: "Priority: High. Change priority for “Q3 budget”" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assigned to Daniel Okai. Change assignee for “Q3 budget”" })).toBeInTheDocument();
    // a date chip (with its picker), not a native date input
    expect(screen.getByRole("button", { name: /^Due date for “Q3 budget”/ })).toHaveAttribute("aria-haspopup", "dialog");
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  it("shows one completion signal per row: the glyph, and no second tick", () => {
    const t = mk({ title: "Shipped it", status: "done" });
    render(<ListView {...base([t], { onPatch: vi.fn() })} />);
    const row = screen.getByRole("group", { name: "Shipped it" });
    expect(within(row).getAllByRole("checkbox")).toHaveLength(1); // the select box only appears with bulk actions
    expect(within(row).getByRole("checkbox", { name: "Done: Shipped it" })).toHaveAttribute("aria-checked", "true");
    expect(within(row).queryByRole("img", { name: /Completed/ })).toBeNull();
  });

  it("renders the status menu outside the row (portal) and patches without opening the task", () => {
    const t = mk({ title: "Write brief" });
    const props = base([t], { onPatch: vi.fn() });
    const { container } = render(<ListView {...props} />);
    // right-click (or shift-click) the status glyph for the status menu
    fireEvent.contextMenu(screen.getByRole("checkbox", { name: "Done: Write brief" }));
    const menu = screen.getByRole("menu", { name: "Status for “Write brief”" });
    expect(container.contains(menu)).toBe(false);
    expect(within(menu).getByRole("menuitemradio", { name: /To do/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /In progress/ }));
    expect(props.onPatch).toHaveBeenCalledWith(t.id, { status: "progress", completedAt: undefined });
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    // shift-click opens it too, and doesn't complete the task
    fireEvent.click(screen.getByRole("checkbox", { name: "Done: Write brief" }), { shiftKey: true });
    expect(screen.getByRole("menu", { name: "Status for “Write brief”" })).toBeInTheDocument();
    expect(props.onToggle).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("checkbox", { name: /^Done/ })).toBeNull();
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

describe("planDrop with tied positions", () => {
  // rendered order = stable sort by position (a missing position counts as 0), like the list
  const render_ = (ts: Task[]) => [...ts].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const PATTERNS: (number | undefined)[][] = [
    [5, 5, 5, 5],                          // a pasted list: one timestamp for every row
    [1, 2, 2, 2, 3],                       // a tied run between distinct neighbours
    [undefined, undefined, 3, 3],          // legacy rows with no position
    [1.727e12, 1.727e12, 1.727e12, 1.727e12 + 1],
    [0, 0, 1, 1, 1, 2, 2],
  ];
  it("every move lands exactly where it was dropped, re-spacing as few neighbours as it can", () => {
    for (const pat of PATTERNS) {
      const items = render_(pat.map((p, i) => mk({ id: "r" + i, title: "R" + i, position: p })));
      for (const d of items) for (const t of items) for (const half of ["top", "bottom"] as const) {
        if (d.id === t.id) continue;
        const rest = items.filter((x) => x.id !== d.id);
        const ti = rest.findIndex((x) => x.id === t.id);
        const at = half === "top" ? ti : ti + 1;
        const expected = [...rest.slice(0, at), d].concat(rest.slice(at)).map((x) => x.id);
        const plan = planDrop(items, d.id, t.id, half, false);
        const moved = new Map([...plan.respace.map((r) => [r.id, r.position] as const), [d.id, plan.position] as const]);
        const after = render_(items.map((x) => moved.has(x.id) ? { ...x, position: moved.get(x.id) } : x)).map((x) => x.id);
        expect({ pat, d: d.id, t: t.id, half, after }).toEqual({ pat, d: d.id, t: t.id, half, after: expected });
        expect(plan.unchanged).toBe(expected.join() === items.map((x) => x.id).join());
        expect(plan.respace.length).toBeLessThanOrEqual(Math.ceil(items.length / 2));
      }
    }
  });

  it("needs no re-spacing when the neighbours already differ", () => {
    const [a, b, c] = [mk({ id: "a", title: "a", position: 1 }), mk({ id: "b", title: "b", position: 2 }), mk({ id: "c", title: "c", position: 3 })];
    expect(planDrop([a, b, c], "a", "b", "bottom", false)).toEqual({ position: 2.5, respace: [], unchanged: false });
  });
});

describe("ListView keyboard reorder with tied positions", () => {
  it("Alt+↓ really moves a task in a pasted list (all rows share one position), and says so", async () => {
    const tasks = [mk({ id: "A", title: "Alpha", position: 5 }), mk({ id: "B", title: "Bravo", position: 5 }), mk({ id: "C", title: "Charlie", position: 5 })];
    render(<Live initial={tasks} />);
    expect(rowOrder()).toEqual(["Alpha", "Bravo", "Charlie"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Alpha" }), { key: "ArrowDown", altKey: true });
    expect(rowOrder()).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(screen.getByText("Moved “Alpha” below “Bravo”")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alpha" })));
    fireEvent.keyDown(screen.getByRole("button", { name: "Alpha" }), { key: "ArrowDown", altKey: true });
    expect(rowOrder()).toEqual(["Bravo", "Charlie", "Alpha"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Charlie" }), { key: "ArrowUp", altKey: true });
    expect(rowOrder()).toEqual(["Charlie", "Bravo", "Alpha"]);
  });
});

describe("ListView keeps keyboard focus when a change moves the row to another group", () => {
  it("picking a new status (grouped by Status) returns focus to that task's status control in its new group", async () => {
    const tasks = [mk({ title: "Finalise deck", status: "progress" }), mk({ title: "Other", status: "todo" })];
    render(<Live initial={tasks} />);
    const before = screen.getByRole("checkbox", { name: "Done: Finalise deck" });
    fireEvent.contextMenu(before);
    const menu = await screen.findByRole("menu", { name: "Status for “Finalise deck”" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /In review/ })); // detail 0 = Enter/Space
    const moved = within(screen.getByRole("group", { name: "Finalise deck" })).getByRole("checkbox", { name: "Done: Finalise deck" });
    expect(moved).not.toBe(before); // re-mounted under "In review"
    expect(moved).toHaveAccessibleDescription("In review");
    await waitFor(() => expect(document.activeElement).toBe(moved));
  });

  it("…and the same for priority under Priority grouping, and for completing a task", async () => {
    const tasks = [mk({ title: "Book venue", priority: "medium" }), mk({ title: "Other", priority: "low" })];
    const { unmount } = render(<Live initial={tasks} groupBy="priority" />);
    fireEvent.click(screen.getByRole("button", { name: "Priority: Medium. Change priority for “Book venue”" }));
    const menu = await screen.findByRole("menu", { name: "Priority for “Book venue”" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Urgent/ }), { detail: 1 }); // a mouse pick too
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Priority: Urgent. Change priority for “Book venue”" })));
    unmount();

    render(<Live initial={[mk({ id: "sd", title: "Send invoice" }), mk({ title: "Other" })]} />);
    // the completion box is a checkbox named after its task (it doesn't flip name with the state)
    const box = within(screen.getByRole("group", { name: "Send invoice" })).getByRole("checkbox", { name: "Done: Send invoice" });
    expect(box).toHaveAttribute("aria-checked", "false");
    fireEvent.click(box);
    // it settles in place first (ticked, struck through), then moves to "Done"
    expect(screen.queryByRole("heading", { name: /^Done/ })).toBeNull();
    expect(box).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByRole("heading", { name: /^Done/ })).toBeInTheDocument();
    // the row re-mounted under "Done": focus is back on ITS box, now checked
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByRole("group", { name: "Send invoice" })).getByRole("checkbox", { name: "Done: Send invoice" })));
    expect(document.activeElement).not.toBe(box);
    expect(document.activeElement).toHaveAttribute("aria-checked", "true");
  });
});

describe("ListView group drop targets", () => {
  const dt = (id: string) => ({ types: ["text/kanbo-task"], getData: () => id, setData: () => {}, effectAllowed: "" });
  const setup = () => {
    const tasks = [mk({ id: "A", title: "Alpha", position: 1 }), mk({ id: "B", title: "Bravo", position: 2 }), mk({ id: "C", title: "Charlie", position: 3 }), mk({ id: "D", title: "Delta", status: "progress", position: 0 })];
    const onPatch = vi.fn();
    render(<ListView {...base(tasks, { onPatch, onQuickAdd: vi.fn() })} />);
    return onPatch;
  };

  it("a task dropped on the 'Add task' row goes to the END of that group, with the hint line there", () => {
    const onPatch = setup();
    fireEvent.dragStart(screen.getByRole("group", { name: "Delta" }), { dataTransfer: dt("D") });
    const add = screen.getByRole("button", { name: "Add task to To do" });
    fireEvent.dragOver(add, { dataTransfer: dt("D") });
    expect(add).toHaveAttribute("data-drop", "true");
    fireEvent.drop(add, { dataTransfer: dt("D") });
    expect(onPatch).toHaveBeenCalledWith("D", { status: "todo", completedAt: undefined, position: 4 }); // after Charlie (3)
  });

  it("a task dropped on a group header goes to the top of that group", () => {
    const onPatch = setup();
    const header = screen.getByRole("heading", { name: /^To do/ }).closest(".kgrouphdr")!;
    fireEvent.drop(header, { dataTransfer: dt("D") });
    expect(onPatch).toHaveBeenCalledWith("D", { status: "todo", completedAt: undefined, position: 0 }); // before Alpha (1)
  });

  it("dropping a task back where it already was writes nothing", () => {
    const onPatch = setup();
    // (jsdom has no layout, so a row drop reads as its bottom half) — the bottom of Alpha is Bravo's own slot
    fireEvent.drop(screen.getByRole("group", { name: "Alpha" }), { dataTransfer: dt("B") });
    expect(onPatch).not.toHaveBeenCalled();
  });
});

describe("ListView first-task focus", () => {
  it("takes focus from a clicked button (the sidebar link that opened the empty project)", () => {
    const nav = document.createElement("button");
    document.body.appendChild(nav);
    nav.focus();
    const { rerender } = render(<ListView {...base([], { onQuickAdd: vi.fn(), sectionProjectId: "p-one" })} />);
    expect(document.activeElement).toBe(screen.getByLabelText("New task name"));
    nav.focus(); // …then another empty project is opened from the sidebar
    rerender(<ListView {...base([], { onQuickAdd: vi.fn(), sectionProjectId: "p-two" })} />);
    expect(document.activeElement).toBe(screen.getByLabelText("New task name"));
    nav.remove();
  });

  it("never reaches behind an open modal", () => {
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    const ok = document.createElement("button");
    modal.appendChild(ok);
    document.body.appendChild(modal);
    ok.focus();
    render(<ListView {...base([], { onQuickAdd: vi.fn() })} />);
    expect(document.activeElement).toBe(ok);
    modal.remove();
  });
});

describe("ListView bulk selection — Escape and touch", () => {
  it("Escape that closes a task panel (or cancels a rename) keeps the selection", () => {
    const tasks = [mk({ title: "One" }), mk({ title: "Two" })];
    render(<ListView {...base(tasks, { onBulkPatch: vi.fn(), onPatch: vi.fn() })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “One”" }));
    const panel = document.createElement("div"); // the task panel App opened
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    document.body.appendChild(panel);
    fireEvent.keyDown(screen.getByRole("button", { name: "Two" }), { key: "Escape" }); // focus was left on the clicked title
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    panel.remove();
    fireEvent.keyDown(screen.getByRole("button", { name: "Two" }), { key: "F2" });
    fireEvent.keyDown(screen.getByLabelText("Rename “Two”"), { key: "Escape" });
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Two" }), { key: "Escape" });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("on touch screens the group select-all only appears once a selection is under way", () => {
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: /hover: none/.test(q), media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    try {
      render(<ListView {...base([mk({ title: "One" }), mk({ title: "Two" })], { onBulkPatch: vi.fn() })} />);
      expect(screen.queryByRole("checkbox", { name: /Select all tasks in/ })).toBeNull();
      fireEvent.click(screen.getByRole("checkbox", { name: "Select “One”" }));
      expect(screen.getByRole("checkbox", { name: "Select all tasks in To do" })).toBeInTheDocument();
    } finally {
      window.matchMedia = orig;
    }
  });
});

describe("ListView on phones: swipe and long press", () => {
  // a phone: narrow and touch-first
  const phone = () => {
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: /max-width|hover: none|pointer: coarse/.test(q), media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    return () => { window.matchMedia = orig; };
  };
  const swipe = (el: Element, dx: number) => {
    fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 20 }] });
    for (const f of [0.25, 0.5, 0.75, 1]) fireEvent.touchMove(el, { touches: [{ clientX: 200 + dx * f, clientY: 22 }] });
    fireEvent.touchEnd(el, { touches: [] });
  };

  it("a swipe right completes the task; a short one springs back and does nothing", () => {
    const restore = phone();
    try {
      const t = mk({ title: "Send the brief" });
      const props = base([t], { onPatch: vi.fn() });
      render(<ListView {...props} />);
      const row = screen.getByRole("group", { name: "Send the brief" });
      swipe(row, 40);
      expect(props.onToggle).not.toHaveBeenCalled();
      swipe(row, 160);
      expect(props.onToggle).toHaveBeenCalledWith(t.id);
      // the click a swipe leaves behind doesn't open the task
      fireEvent.click(row);
      expect(props.onOpen).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("a swipe left offers Tomorrow · Next week · Pick, and a date comes with an Undo toast", async () => {
    const restore = phone();
    try {
      const t = mk({ title: "Approve naming", dueDate: iso(0) });
      const onPatch = vi.fn();
      render(<ToastProvider><ListView {...base([t], { onPatch })} /></ToastProvider>);
      const row = screen.getByRole("group", { name: "Approve naming" });
      swipe(row, -150);
      const tray = screen.getByRole("group", { name: "Reschedule “Approve naming”" });
      expect(within(tray).getByRole("button", { name: /^Due next week/ })).toBeInTheDocument();
      expect(within(tray).getByRole("button", { name: "Pick a due date" })).toBeInTheDocument();
      fireEvent.click(within(tray).getByRole("button", { name: /^Due tomorrow/ }));
      expect(onPatch).toHaveBeenCalledWith(t.id, { dueDate: iso(1) });
      expect(await screen.findByText("“Approve naming” is now due tomorrow")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
      expect(onPatch).toHaveBeenLastCalledWith(t.id, { dueDate: iso(0) });
    } finally { restore(); }
  });

  it("a vertical drag is a scroll: the row stays put", () => {
    const restore = phone();
    try {
      const t = mk({ title: "Scroll past me" });
      const props = base([t], { onPatch: vi.fn() });
      render(<ListView {...props} />);
      const row = screen.getByRole("group", { name: "Scroll past me" });
      fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 100 }] });
      fireEvent.touchMove(row, { touches: [{ clientX: 130, clientY: 180 }] });
      fireEvent.touchMove(row, { touches: [{ clientX: 300, clientY: 190 }] });
      fireEvent.touchEnd(row, { touches: [] });
      expect(row.style.transform).toBe("");
      expect(screen.queryByRole("group", { name: /^Reschedule/ })).toBeNull();
      expect(props.onToggle).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("a long press opens the row's action sheet, whose choices apply and close it", () => {
    vi.useFakeTimers();
    const restore = phone();
    try {
      const t = mk({ title: "Book the venue", priority: "low" });
      const onPatch = vi.fn();
      const props = base([t], { onPatch, onBulkPatch: vi.fn() });
      render(<ListView {...props} />);
      const row = screen.getByRole("group", { name: "Book the venue" });
      const title = within(row).getByRole("button", { name: "Book the venue" });
      fireEvent.touchStart(title, { touches: [{ clientX: 100, clientY: 20 }] });
      act(() => { vi.advanceTimersByTime(500); });
      fireEvent.touchEnd(title, { touches: [] });
      // the click some browsers send after a long press isn't also a tap that opens the task
      fireEvent.click(title);
      expect(props.onOpen).not.toHaveBeenCalled();
      const sheet = screen.getByRole("dialog", { name: "Actions for “Book the venue”" });
      expect(within(sheet).getByRole("button", { name: "Open task" })).toBeInTheDocument();
      expect(within(sheet).getByRole("button", { name: /Select/ })).toBeInTheDocument();
      fireEvent.click(within(within(sheet).getByRole("group", { name: "Priority" })).getByRole("button", { name: /High/ }));
      expect(onPatch).toHaveBeenCalledWith(t.id, { priority: "high" });
      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.queryByRole("dialog", { name: /Actions for/ })).toBeNull();
      // the next tap opens it as usual
      fireEvent.click(title);
      expect(props.onOpen).toHaveBeenCalledWith(t.id);
    } finally { restore(); vi.useRealTimers(); }
  });

  it("guests get neither: no tray, no sheet", () => {
    vi.useFakeTimers();
    const restore = phone();
    try {
      const t = mk({ title: "Read only" });
      render(<ListView {...base([t], { onPatch: vi.fn(), readOnly: true })} />);
      const row = screen.getByRole("group", { name: "Read only" });
      swipe(row, -150);
      fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 20 }] });
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.queryByRole("group", { name: /^Reschedule/ })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally { restore(); vi.useRealTimers(); }
  });
});
