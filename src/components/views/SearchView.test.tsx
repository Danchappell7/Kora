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

describe("export columns", () => {
  it("hands the CSV export sections, custom fields and every task (for parent names), like the List toolbar's", () => {
    const parent = task({ id: "p", title: "Launch plan", status: "done" });
    const child = task({ id: "c", title: "Book venue", parentId: "p", sectionId: "s1" });
    const sections = [{ id: "s1", name: "Logistics" }];
    const customFields = [{ id: "f1", projectId: child.projectId, name: "Budget", type: "number" }] as never[];
    renderSearch({ tasks: [parent, child], preset: { status: "open" }, presetKey: "k", sections, customFields });
    fireEvent.click(screen.getByRole("button", { name: "Export this task as CSV" }));
    const [rows, name, opts] = vi.mocked(exportTasksCsv).mock.calls[0];
    expect(rows.map((t) => t.id)).toEqual(["c"]);
    expect(name).toBe("search");
    expect(opts).toEqual(expect.objectContaining({ sections, customFields, allTasks: [parent, child] }));
  });
});

describe("export copy", () => {
  it("names a single result as 'this task'", () => {
    renderSearch({ tasks: [task({ id: "a", title: "Only one" })], preset: { status: "open" }, presetKey: "k" });
    fireEvent.click(screen.getByRole("button", { name: "Export this task as CSV" }));
    expect(vi.mocked(exportTasksCsv).mock.calls[0][0]).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Print or save this task as PDF" })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Show 1 task from an archived project" }));
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

describe("quote-only text", () => {
  const tasks = [task({ id: "a", title: "Alpha" }), task({ id: "b", title: "Beta" })];

  it("a lone opening quote isn't a search yet, so nothing is listed", () => {
    renderSearch({ tasks });
    const input = screen.getByLabelText("Search tasks");
    for (const text of ['"', '""', '" "', "“"]) {
      fireEvent.change(input, { target: { value: text } });
      expect(screen.getByRole("status")).toHaveTextContent("Type or pick a filter to search");
      expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /as CSV/ })).not.toBeInTheDocument();
    }
    fireEvent.change(input, { target: { value: '"alp' } });
    expect(screen.getByRole("status")).toHaveTextContent("1 result");
  });

  it("with a filter applied, quote-only text doesn't narrow or widen anything", () => {
    renderSearch({ tasks: [...tasks, task({ id: "c", title: "Gamma", status: "done" })], preset: { status: "open" }, presetKey: "k" });
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: '"' } });
    expect(screen.getByRole("status")).toHaveTextContent("2 results");
  });
});

describe("preset changes", () => {
  const saved: SavedSearch = { id: "s1", name: "Budget", query: { text: "budget" } };
  const tasks = [task({ id: "a", title: "Budget review" }), task({ id: "b", title: "Other" })];
  const view = (over: Partial<Parameters<typeof SearchView>[0]>) => (
    <SearchView tasks={tasks} projects={PROJECTS} members={[{ id: "u-me", name: "Dan" }]} currentUserId="u-me"
      onOpen={vi.fn()} savedSearches={[saved]} onSaveSearch={vi.fn()} onDeleteSavedSearch={vi.fn()} {...over} />
  );

  it("deleting the saved search you're viewing keeps its results on screen", () => {
    const { rerender } = render(view({ preset: { text: "budget" }, presetKey: "s1" }));
    expect(screen.getByText("Budget review")).toBeInTheDocument();
    // App: the saved search is gone, route.list still points at its id
    rerender(view({ savedSearches: [], preset: undefined, presetKey: "s1" }));
    expect((screen.getByLabelText("Search tasks") as HTMLInputElement).value).toBe("budget");
    expect(screen.getByText("Budget review")).toBeInTheDocument();
  });

  it("leaving a smart list for plain Search still starts afresh", () => {
    const { rerender } = render(view({ preset: { text: "budget" }, presetKey: "s1" }));
    rerender(view({ preset: undefined, presetKey: undefined }));
    expect((screen.getByLabelText("Search tasks") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent("Type or pick a filter to search");
  });

  it("a preset whose content resolves later (signed-in user) is applied", () => {
    const { rerender } = render(view({ preset: { assignee: "", status: "open" }, presetKey: "mine" }));
    rerender(view({ preset: { assignee: "u-me", status: "open" }, presetKey: "mine" }));
    expect((screen.getByLabelText("Filter by assignee or collaborator") as HTMLSelectElement).value).toBe("u-me");
  });
});

describe("presets", () => {
  it("offers a team-wide 'All due today' chip", () => {
    const tasks = [task({ id: "a", title: "Mine today", dueDate: dayOffset(0) }), task({ id: "b", title: "Sarah today", assigneeId: "u-sarah", dueDate: dayOffset(0) }), task({ id: "c", title: "Tomorrow", dueDate: dayOffset(1) })];
    renderSearch({ tasks });
    const chip = screen.getByRole("button", { name: "All due today" });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("2 results");
    expect((screen.getByLabelText("Filter by due date") as HTMLSelectElement).value).toBe("today");
  });
});

describe("the phone's Search key", () => {
  it("puts the keyboard away on a touch device", () => {
    setPointer(false);
    renderSearch({ tasks: [task({ id: "a", title: "Alpha" })] });
    const input = screen.getByLabelText("Search tasks");
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).not.toBe(input);
  });

  it("leaves focus alone with a mouse or trackpad", () => {
    setPointer(true);
    renderSearch({ tasks: [task({ id: "a", title: "Alpha" })] });
    const input = screen.getByLabelText("Search tasks");
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).toBe(input);
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
