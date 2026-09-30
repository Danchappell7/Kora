import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SearchView } from "./SearchView";
import { setReferenceData, dayOffset } from "../../data/data";
import { smartListQuery } from "../../lib/smartLists";
import type { Task, Project, Member, SavedSearch } from "../../data/types";

vi.mock("../../lib/exportTasks", () => ({ exportTasksCsv: vi.fn(), printTasks: vi.fn() }));
import { exportTasksCsv, printTasks } from "../../lib/exportTasks";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-live", assigneeId: "u-me", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const member = (id: string, name: string): Member => ({ id, name, email: `${id}@example.com`, type: "team", color: "#888" });
const PROJECTS: Project[] = [
  { id: "p-live", name: "Launch", emoji: "", color: "#888", workspaceId: "ws" },
  { id: "p-old", name: "Old Launch", emoji: "", color: "#888", workspaceId: "ws", archivedAt: "2026-09-01T00:00:00Z" },
];
const MEMBERS = [member("u-me", "Dan"), member("u-sarah", "Sarah"), member("u-far", "Farah Elsewhere")];

function renderSearch(props: Partial<Parameters<typeof SearchView>[0]> = {}) {
  const onOpen = vi.fn();
  const utils = render(
    <SearchView tasks={[]} projects={PROJECTS} members={[{ id: "u-me", name: "Dan" }, { id: "u-sarah", name: "Sarah" }]} currentUserId="u-me"
      onOpen={onOpen} savedSearches={[]} onSaveSearch={vi.fn()} onDeleteSavedSearch={vi.fn()} {...props} />,
  );
  return { onOpen, ...utils };
}

const realMatchMedia = window.matchMedia;
const setPointer = (fine: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: fine && query === "(pointer: fine)", media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  setReferenceData({ projects: PROJECTS, members: MEMBERS });
  vi.mocked(exportTasksCsv).mockClear();
  vi.mocked(printTasks).mockClear();
});
afterEach(() => { window.matchMedia = realMatchMedia; });

describe("filter selects always show the active filter", () => {
  it("'Assigned to me' reads 'Open (not done)', not 'Any status'", () => {
    renderSearch({ preset: smartListQuery("mine", "u-me"), presetKey: "mine" });
    const status = screen.getByLabelText("Filter by status") as HTMLSelectElement;
    expect(status.value).toBe("open");
    expect(status.selectedOptions[0].textContent).toBe("Open (not done)");
    expect((screen.getByLabelText("Filter by assignee or collaborator") as HTMLSelectElement).selectedOptions[0].textContent).toBe("Dan");
  });

  it("the user can pick 'Open (not done)' again after changing status", () => {
    renderSearch();
    const status = screen.getByLabelText("Filter by status") as HTMLSelectElement;
    fireEvent.change(status, { target: { value: "done" } });
    fireEvent.change(status, { target: { value: "open" } });
    expect(status.value).toBe("open");
  });

  it("a saved search for someone outside the workspace names them instead of 'Anyone'", () => {
    const saved: SavedSearch = { id: "s1", name: "Farah's work", query: { assignee: "u-far" } };
    renderSearch({ savedSearches: [saved], preset: { assignee: "u-far" }, presetKey: "s1" });
    const sel = screen.getByLabelText("Filter by assignee or collaborator") as HTMLSelectElement;
    expect(sel.value).toBe("u-far");
    expect(sel.selectedOptions[0].textContent).toBe("Farah Elsewhere");
  });

  it("unknown values get an explicit option too", () => {
    renderSearch({ preset: { assignee: "u-gone", projectId: "p-deleted", tag: "legacy" }, presetKey: "s2" });
    expect((screen.getByLabelText("Filter by assignee or collaborator") as HTMLSelectElement).selectedOptions[0].textContent).toBe("Unknown member");
    expect((screen.getByLabelText("Filter by project") as HTMLSelectElement).selectedOptions[0].textContent).toBe("Unknown project");
    // the tag select appears even though no task carries the tag any more
    expect((screen.getByLabelText("Filter by tag") as HTMLSelectElement).value).toBe("legacy");
  });
});

describe("exports", () => {
  it("CSV and PDF cover every match, not just the 200 rows shown", () => {
    const tasks = Array.from({ length: 340 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
    renderSearch({ tasks, preset: { status: "open" }, presetKey: "big" });
    expect(screen.getByText(/340 results · showing first 200/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export all 340 tasks as CSV" }));
    expect(vi.mocked(exportTasksCsv).mock.calls[0][0]).toHaveLength(340);
    fireEvent.click(screen.getByRole("button", { name: "Print or save all 340 tasks as PDF" }));
    expect(vi.mocked(printTasks).mock.calls[0][0]).toHaveLength(340);
  });
});

describe("keyboard access to results", () => {
  it("each result title is a button that opens the task once", () => {
    const { onOpen } = renderSearch({ tasks: [task({ id: "a", title: "Budget review", dueDate: dayOffset(0) })], preset: { status: "open" }, presetKey: "k" });
    const btn = screen.getByRole("button", { name: /^Open Budget review \(To do, Launch, due Today\)$/ });
    expect(btn.tagName).toBe("BUTTON");
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("ArrowDown moves from the search box into the results and back up", () => {
    renderSearch({ tasks: [task({ id: "a", title: "Alpha" }), task({ id: "b", title: "Beta" })] });
    const input = screen.getByLabelText("Search tasks");
    fireEvent.change(input, { target: { value: "a" } });
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const first = screen.getByRole("button", { name: /^Open Alpha/ });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Open Beta/ }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
  });
});

describe("archived projects", () => {
  const tasks = [task({ id: "a", title: "Live task" }), task({ id: "b", title: "Old task", projectId: "p-old" })];

  it("are hidden by default, with a one-click way to include them", () => {
    renderSearch({ tasks, preset: { status: "open" }, presetKey: "k" });
    expect(screen.queryByText("Old task")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show 1 task from archived projects/ }));
    expect(screen.getByText("Old task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Include archived projects/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("drop out as soon as their project is archived (same task list)", () => {
    const { rerender } = renderSearch({ tasks, preset: { status: "open" }, presetKey: "k" });
    expect(screen.getByText("Live task")).toBeInTheDocument();
    const archived = PROJECTS.map((p) => (p.id === "p-live" ? { ...p, archivedAt: "2026-09-30T00:00:00Z" } : p));
    setReferenceData({ projects: archived });
    rerender(
      <SearchView tasks={tasks} projects={archived} members={[{ id: "u-me", name: "Dan" }]} currentUserId="u-me"
        onOpen={vi.fn()} savedSearches={[]} onSaveSearch={vi.fn()} onDeleteSavedSearch={vi.fn()} preset={{ status: "open" }} presetKey="k" />,
    );
    expect(screen.queryByText("Live task")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show 2 tasks from archived projects/ })).toBeInTheDocument();
  });
});

describe("text search", () => {
  it("matches words in any order and puts title hits first", () => {
    const tasks = [
      task({ id: "d", title: "Plan week", description: "budget for Q3" }),
      task({ id: "t", title: "Q3 marketing budget review" }),
    ];
    renderSearch({ tasks });
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "budget q3" } });
    const titles = screen.getAllByRole("button", { name: /^Open / }).map((b) => b.textContent);
    expect(titles).toEqual(["Q3 marketing budget review", "Plan week"]);
  });
});

describe("autofocus", () => {
  it("focuses the box for plain Search on a fine pointer", () => {
    setPointer(true);
    renderSearch();
    expect(document.activeElement).toBe(screen.getByLabelText("Search tasks"));
  });

  it("doesn't pop the keyboard on touch devices", () => {
    setPointer(false);
    renderSearch();
    expect(document.activeElement).not.toBe(screen.getByLabelText("Search tasks"));
  });

  it("doesn't steal focus when a smart list is opened", () => {
    setPointer(true);
    renderSearch({ preset: smartListQuery("overdue", "u-me"), presetKey: "overdue" });
    expect(document.activeElement).not.toBe(screen.getByLabelText("Search tasks"));
    expect(screen.getByText("Overdue", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/assigned to you or where you're a collaborator/i)).toBeInTheDocument();
  });
});
