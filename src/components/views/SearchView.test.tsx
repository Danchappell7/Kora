import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within, waitFor } from "@testing-library/react";
import { SearchView } from "./SearchView";
import { setReferenceData, dayOffset } from "../../data/data";
import { smartListQuery } from "../../lib/smartLists";
import { SEARCH_MARK_START as S, SEARCH_MARK_END as E } from "../../lib/searchRows";
import { resetSearchServerMemory } from "../../lib/search/useUniversalSearch";
import type { Task, Project, Member, SavedSearch, Comment, SearchHit } from "../../data/types";

vi.mock("../../lib/exportTasks", () => ({ exportTasksCsv: vi.fn(), printTasks: vi.fn() }));
import { exportTasksCsv, printTasks } from "../../lib/exportTasks";
const api = vi.hoisted(() => ({ searchAll: vi.fn() }));
vi.mock("../../lib/searchApi", async (orig) => ({ ...(await orig<typeof import("../../lib/searchApi")>()), searchAll: api.searchAll }));
const saveView = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("./SavedViewEditor", () => ({
  SaveViewButton: (p: Record<string, unknown>) => { saveView.props = p; return <button type="button">Save view</button>; },
}));

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-live", assigneeId: "u-me", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, workspaceId: "ws", ...o,
});
const member = (id: string, name: string): Member => ({ id, name, email: `${id}@example.com`, type: "team", color: "#888" });
const PROJECTS: Project[] = [
  { id: "p-live", name: "Launch", emoji: "", color: "#888", workspaceId: "ws", description: "Pricing and the launch plan" },
  { id: "p-old", name: "Old Launch", emoji: "", color: "#888", workspaceId: "ws", archivedAt: "2026-09-01T00:00:00Z" },
];
const MEMBERS = [member("u-me", "Dan"), member("u-sarah", "Sarah Price"), member("u-far", "Farah Elsewhere")];

function renderSearch(props: Partial<Parameters<typeof SearchView>[0]> = {}) {
  const onOpen = vi.fn();
  const utils = render(
    <SearchView tasks={[]} projects={PROJECTS} members={[{ id: "u-me", name: "Dan" }, { id: "u-sarah", name: "Sarah Price" }]} currentUserId="u-me"
      onOpen={onOpen} savedSearches={[]} onSaveSearch={vi.fn()} onDeleteSavedSearch={vi.fn()} demoCorpus={false} {...props} />,
  );
  return { onOpen, ...utils };
}
const box = () => screen.getByLabelText("Search tasks") as HTMLInputElement;
const typeIn = (text: string) => fireEvent.change(box(), { target: { value: text } });
const openFilters = () => { if (!screen.queryByRole("region", { name: "Filters" })) fireEvent.click(screen.getByRole("button", { name: /^Filters/ })); };

const realMatchMedia = window.matchMedia;
const setPointer = (fine: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: fine && query === "(pointer: fine)", media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  // only Date is pinned (timers stay real for the server's debounce)
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  setReferenceData({ projects: PROJECTS, members: MEMBERS });
  vi.mocked(exportTasksCsv).mockClear();
  vi.mocked(printTasks).mockClear();
  api.searchAll.mockReset();
  resetSearchServerMemory();
  window.localStorage.clear();
  saveView.props = null;
});
afterEach(() => { window.matchMedia = realMatchMedia; vi.useRealTimers(); });

describe("filter selects always show the active filter", () => {
  it("'Assigned to me' reads 'Open (not done)', not 'Any status' (and the panel is open to show it)", () => {
    renderSearch({ preset: smartListQuery("mine", "u-me"), presetKey: "mine" });
    const status = screen.getByLabelText("Filter by status") as HTMLSelectElement;
    expect(status.value).toBe("open");
    expect(status.selectedOptions[0].textContent).toBe("Open (not done)");
    expect((screen.getByLabelText("Filter by assignee or collaborator") as HTMLSelectElement).selectedOptions[0].textContent).toBe("Dan (you)");
    expect(screen.getByRole("button", { name: /^Filters/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("the user can pick 'Open (not done)' again after changing status", () => {
    renderSearch();
    openFilters();
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

  it("Filters remembers being opened or closed on this device; the button counts what's on", () => {
    const { unmount } = renderSearch({ preset: { status: "open", priority: "high" }, presetKey: "k" });
    const btn = screen.getByRole("button", { name: /^Filters/ });
    expect(btn).toHaveTextContent("2");
    fireEvent.click(btn);
    expect(screen.queryByRole("region", { name: "Filters" })).not.toBeInTheDocument();
    unmount();
    renderSearch({ preset: { status: "open" }, presetKey: "k2" });
    expect(screen.queryByRole("region", { name: "Filters" })).not.toBeInTheDocument();
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
    typeIn("a");
    act(() => box().focus());
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    const first = screen.getByRole("button", { name: /^Open Alpha/ });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Open Beta/ }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(box());
  });

  it("↑ / ↓ run through every group in order; Home / End; Escape goes back to the box, and Escape there clears it", () => {
    const comments: Comment[] = [{ id: "c1", taskId: "a", authorId: "u-sarah", authorName: "Sarah Price", body: "pricing looks right", createdAt: "2026-10-08T09:00:00Z" }];
    renderSearch({ tasks: [task({ id: "a", title: "Pricing deck" })], comments, onOpenProject: vi.fn() });
    typeIn("pricing");
    act(() => box().focus());
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    const order = [document.activeElement];
    for (let i = 0; i < 3; i++) { fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }); order.push(document.activeElement); }
    expect(order.map((el) => (el as HTMLElement).getAttribute("aria-label"))).toEqual([
      "Open Pricing deck (To do, Launch)",
      "Comment by Sarah Price on Pricing deck: pricing looks right, 1d ago",
      "Project Launch: Pricing and the launch plan",
      "Project Launch: Pricing and the launch plan",       // the last one stays put
    ]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Open Pricing deck/ }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toHaveAccessibleName(/^Project Launch/);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(box());
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box().value).toBe("");
  });
});

describe("archived", () => {
  const tasks = [task({ id: "a", title: "Live task" }), task({ id: "b", title: "Old task", projectId: "p-old" }), task({ id: "z", title: "Archived task", archivedAt: "2026-09-02T00:00:00Z" })];

  it("is hidden by default, with a one-click way to include it", () => {
    renderSearch({ tasks, preset: { status: "open" }, presetKey: "k" });
    expect(screen.queryByText("Old task")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 archived tasks" }));
    expect(screen.getByText("Old task")).toBeInTheDocument();
    expect(screen.getByText("Archived task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Include archived/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("drops out as soon as its project is archived (same task list)", () => {
    const { rerender } = renderSearch({ tasks: tasks.slice(0, 2), preset: { status: "open" }, presetKey: "k" });
    expect(screen.getByText("Live task")).toBeInTheDocument();
    const archived = PROJECTS.map((p) => (p.id === "p-live" ? { ...p, archivedAt: "2026-09-30T00:00:00Z" } : p));
    setReferenceData({ projects: archived });
    rerender(
      <SearchView tasks={tasks.slice(0, 2)} projects={archived} members={[{ id: "u-me", name: "Dan" }]} currentUserId="u-me" demoCorpus={false}
        onOpen={vi.fn()} savedSearches={[]} onSaveSearch={vi.fn()} onDeleteSavedSearch={vi.fn()} preset={{ status: "open" }} presetKey="k" />,
    );
    expect(screen.queryByText("Live task")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show 2 archived tasks/ })).toBeInTheDocument();
  });
});

describe("text search", () => {
  it("matches words in any order and puts title hits first", () => {
    const tasks = [
      task({ id: "d", title: "Plan week", description: "budget for Q3" }),
      task({ id: "t", title: "Q3 marketing budget review" }),
    ];
    renderSearch({ tasks });
    typeIn("budget q3");
    const titles = screen.getAllByRole("button", { name: /^Open / }).map((b) => b.textContent);
    expect(titles).toEqual(["Q3 marketing budget review", "Plan week"]);
  });

  it("shows the matching part of a description underneath, and paints the words over titles (the text stays whole)", () => {
    // the CSS Custom Highlight API, as a browser has it
    const painted = new Map<string, { ranges: Range[] }>();
    const g = globalThis as unknown as { CSS?: unknown; Highlight?: unknown };
    const before = { CSS: g.CSS, Highlight: g.Highlight };
    g.CSS = { highlights: painted };
    g.Highlight = class { ranges: Range[]; constructor(...r: Range[]) { this.ranges = r; } };
    try {
      renderSearch({ tasks: [task({ id: "d", title: "Plan week", description: "Set the budget for Q3 with finance" })] });
      typeIn("budget");
      const row = screen.getByRole("group", { name: "Plan week" });
      expect(row).toHaveAttribute("data-snippet", "true");
      expect(within(row).getByText("budget", { selector: "mark" })).toBeInTheDocument();
      expect(painted.has("kanbo-search")).toBe(false);          // no title has the word
      typeIn("plan");
      expect(painted.get("kanbo-search")!.ranges.map((r) => r.toString())).toEqual(["Plan"]);
      expect(screen.getByText("Plan week")).toBeInTheDocument();  // one text node, found whole
      typeIn("");
      expect(painted.has("kanbo-search")).toBe(false);
    } finally { g.CSS = before.CSS; g.Highlight = before.Highlight; }
  });
});

describe("quote-only text", () => {
  const tasks = [task({ id: "a", title: "Alpha" }), task({ id: "b", title: "Beta" })];

  it("a lone opening quote isn't a search yet, so nothing is listed", () => {
    renderSearch({ tasks });
    for (const text of ['"', '""', '" "', "“"]) {
      typeIn(text);
      expect(screen.getByRole("status")).toHaveTextContent("Type or pick a filter to search");
      expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /as CSV/ })).not.toBeInTheDocument();
    }
    typeIn('"alp');
    expect(screen.getByRole("status")).toHaveTextContent("1 result");
  });

  it("with a filter applied, quote-only text doesn't narrow or widen anything", () => {
    renderSearch({ tasks: [...tasks, task({ id: "c", title: "Gamma", status: "done" })], preset: { status: "open" }, presetKey: "k" });
    typeIn('"');
    expect(screen.getByRole("status")).toHaveTextContent("2 results");
  });
});

describe("preset changes", () => {
  const saved: SavedSearch = { id: "s1", name: "Budget", query: { text: "budget" } };
  const tasks = [task({ id: "a", title: "Budget review" }), task({ id: "b", title: "Other" })];
  const view = (over: Partial<Parameters<typeof SearchView>[0]>) => (
    <SearchView tasks={tasks} projects={PROJECTS} members={[{ id: "u-me", name: "Dan" }]} currentUserId="u-me" demoCorpus={false}
      onOpen={vi.fn()} savedSearches={[saved]} onSaveSearch={vi.fn()} onDeleteSavedSearch={vi.fn()} {...over} />
  );

  it("deleting the saved search you're viewing keeps its results on screen", () => {
    const { rerender } = render(view({ preset: { text: "budget" }, presetKey: "s1" }));
    expect(screen.getByRole("button", { name: /^Open Budget review/ })).toBeInTheDocument();
    rerender(view({ savedSearches: [], preset: undefined, presetKey: "s1" }));
    expect(box().value).toBe("budget");
    expect(screen.getByRole("button", { name: /^Open Budget review/ })).toBeInTheDocument();
  });

  it("leaving a smart list for plain Search still starts afresh", () => {
    const { rerender } = render(view({ preset: { text: "budget" }, presetKey: "s1" }));
    rerender(view({ preset: undefined, presetKey: undefined }));
    expect(box().value).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent("Type or pick a filter to search");
  });

  it("a preset whose content resolves later (signed-in user) is applied", () => {
    const { rerender } = render(view({ preset: { assignee: "", status: "open" }, presetKey: "mine" }));
    rerender(view({ preset: { assignee: "u-me", status: "open" }, presetKey: "mine" }));
    expect((screen.getByLabelText("Filter by assignee or collaborator") as HTMLSelectElement).value).toBe("u-me");
  });

  it("an old saved search's words stay words (never read as filters)", () => {
    const s9: SavedSearch = { id: "s9", name: "Reports", query: { text: "overdue report" } };
    render(view({ tasks: [task({ id: "o", title: "Overdue report" })], savedSearches: [s9], preset: { text: "overdue report" }, presetKey: "s9" }));
    expect(box().value).toBe('"overdue" report');
    expect(screen.queryByRole("group", { name: "Filters read from your search" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Open Overdue report/ })).toBeInTheDocument();
  });

  it("words handed over from ⌘K are read as typed", () => {
    render(view({ tasks: [task({ id: "o", title: "Budget", status: "blocked" }), task({ id: "p", title: "Budget two" })], preset: { text: "blocked budget" }, presetKey: "q-123" }));
    expect(box().value).toBe("blocked budget");
    expect(screen.getByRole("button", { name: "Remove filter: status blocked" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(1);
  });

  it("a saved search view opens with its words and filters", () => {
    render(view({ presetView: { v: 1, search: { text: "budget", filters: {} }, filters: { status: "open" } }, presetKey: "v1" }));
    expect(box().value).toBe("budget");
    expect((screen.getByLabelText("Filter by status") as HTMLSelectElement).value).toBe("open");
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
    act(() => box().focus());
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(document.activeElement).not.toBe(box());
  });

  it("leaves focus alone with a mouse or trackpad", () => {
    setPointer(true);
    renderSearch({ tasks: [task({ id: "a", title: "Alpha" })] });
    act(() => box().focus());
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(document.activeElement).toBe(box());
  });
});

describe("autofocus", () => {
  it("focuses the box for plain Search on a fine pointer", () => {
    setPointer(true);
    renderSearch();
    expect(document.activeElement).toBe(box());
  });

  it("doesn't pop the keyboard on touch devices", () => {
    setPointer(false);
    renderSearch();
    expect(document.activeElement).not.toBe(box());
  });

  it("doesn't steal focus when a smart list is opened", () => {
    setPointer(true);
    renderSearch({ preset: smartListQuery("overdue", "u-me"), presetKey: "overdue" });
    expect(document.activeElement).not.toBe(box());
    expect(screen.getByText("Overdue", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/assigned to you or where you're a collaborator/i)).toBeInTheDocument();
  });
});

describe("rows", () => {
  it("the status glyph is the completion checkbox: it ticks the task off without opening it", () => {
    const onToggle = vi.fn();
    const { onOpen } = renderSearch({ tasks: [task({ id: "a", title: "Budget review" })], preset: { status: "open" }, presetKey: "k", onToggle });
    const glyph = screen.getByRole("checkbox", { name: "Done: Budget review" });
    expect(glyph).toHaveAttribute("aria-checked", "false");
    fireEvent.click(glyph);
    expect(onToggle).toHaveBeenCalledWith("a");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("without onToggle the glyph only shows the status", () => {
    renderSearch({ tasks: [task({ id: "a", title: "Budget review", status: "review" })], preset: { status: "open" }, presetKey: "k" });
    expect(screen.queryByRole("checkbox", { name: /^Done:/ })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "In review" })).toBeInTheDocument();
  });

  it("J moves a cursor onto the first result and Enter opens it", () => {
    const { onOpen } = renderSearch({ tasks: [task({ id: "a", title: "Alpha" }), task({ id: "b", title: "Beta" })], preset: { status: "open" }, presetKey: "k" });
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    fireEvent.keyDown(document.body, { key: "j" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Open Alpha/ }));
    expect(screen.getByRole("group", { name: "Alpha" })).toHaveAttribute("data-cursor", "true");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(screen.getByRole("group", { name: "Beta" })).toHaveAttribute("data-cursor", "true");
    fireEvent.keyDown(document.activeElement!, { key: "Enter", metaKey: false });
    fireEvent.click(document.activeElement!);
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("J reaches comments, docs, projects and people too, and Enter on a bare cursor opens them", () => {
    const onOpenProject = vi.fn();
    renderSearch({ tasks: [task({ id: "a", title: "Pricing deck" })], onOpenProject });
    typeIn("pricing");
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "j" });
    const projectRow = document.querySelector('[data-row-id="project:p-live"]')!;
    expect(projectRow).toHaveAttribute("data-cursor", "true");
    // ⌘↵ never "completes" a project, and X never selects one
    fireEvent.keyDown(document.body, { key: "x" });
    expect(screen.queryByRole("toolbar", { name: /Bulk actions/ })).not.toBeInTheDocument();
    act(() => { (document.activeElement as HTMLElement).blur(); });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onOpenProject).toHaveBeenCalledWith("p-live");
  });
});

describe("saving a search", () => {
  it("names it in place, with no prompt", () => {
    const prompt = vi.spyOn(window, "prompt");
    const onSaveSearch = vi.fn();
    renderSearch({ tasks: [task({ id: "a", title: "Alpha" })], onSaveSearch });
    typeIn("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const field = screen.getByRole("textbox", { name: "Name this search" });
    fireEvent.change(field, { target: { value: "Alpha work" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSaveSearch).toHaveBeenCalledWith("Alpha work", expect.objectContaining({ text: "alpha" }));
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Name this search" })).not.toBeInTheDocument();
    prompt.mockRestore();
  });

  it("Escape puts the Save button back without saving", () => {
    const onSaveSearch = vi.fn();
    renderSearch({ tasks: [task({ id: "a", title: "Alpha" })], onSaveSearch, preset: { status: "open" }, presetKey: "k" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name this search" }), { key: "Escape" });
    expect(onSaveSearch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("a plain-English search saves its words as typed (and the old fields, for the sidebar's count)", () => {
    const onSaveSearch = vi.fn();
    renderSearch({ tasks: [task({ id: "a", title: "Alpha", assigneeId: "u-sarah" })], onSaveSearch });
    typeIn("Sarah's tasks");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const field = screen.getByRole("textbox", { name: "Name this search" });
    fireEvent.change(field, { target: { value: "Sarah" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSaveSearch).toHaveBeenCalledWith("Sarah", expect.objectContaining({ assignee: "u-sarah", text: "", input: "Sarah's tasks" }));
  });

  it("with views on, Save is the views' button, handed the search as a view query and a name", () => {
    renderSearch({ tasks: [task({ id: "a", title: "Alpha" })], views: { workspaceId: "ws", workspaceName: "Foundrise", canShare: true } });
    typeIn("alpha blocked");
    expect(screen.getByRole("button", { name: "Save view" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(saveView.props).toMatchObject({ kind: "search", active: true, workspaceId: "ws", canShare: true, suggestedName: "“alpha” · Blocked",
      query: { v: 1, search: { text: "alpha blocked", filters: {} } } });
  });
});

describe("plain English", () => {
  const tasks = [
    task({ id: "a", title: "Pricing deck", assigneeId: "u-sarah", status: "blocked" }),
    task({ id: "b", title: "Pricing page", assigneeId: "u-me" }),
    task({ id: "c", title: "Hiring plan", assigneeId: "u-sarah" }),
  ];
  it("reads names and statuses as chips, tints them in the box, and searches the rest", () => {
    const { container } = renderSearch({ tasks });
    typeIn("Sarah's blocked pricing");
    const chips = screen.getByRole("group", { name: "Filters read from your search" });
    expect(within(chips).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Remove filter: assigned to Sarah Price", "Remove filter: status blocked", "Clear all"]);
    expect([...container.querySelectorAll(".ksr-mirror mark")].map((m) => m.textContent)).toEqual(["Sarah's", "blocked"]);
    expect(screen.getAllByRole("button", { name: /^Open / }).map((b) => b.textContent)).toEqual(["Pricing deck"]);
  });
  it("removing a chip takes its words out of the box", () => {
    renderSearch({ tasks });
    typeIn("Sarah's blocked pricing");
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: status blocked" }));
    expect(box().value).toBe("Sarah's pricing");
    expect(screen.getAllByRole("button", { name: /^Open / }).map((b) => b.textContent)).toEqual(["Pricing deck"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: assigned to Sarah Price" }));
    expect(box().value).toBe("pricing");
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(2);
  });
  it("dates are worked out from today, in the person's timezone", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));   // Friday
    renderSearch({ timezone: "Europe/London", tasks: [task({ id: "f", title: "Friday thing", dueDate: "2026-10-09" }), task({ id: "m", title: "Monday thing", dueDate: "2026-10-12" })] });
    typeIn("due friday");
    expect(screen.getByRole("button", { name: /^Remove filter: due Fri 9 Oct/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Open / }).map((b) => b.textContent)).toEqual(["Friday thing"]);
    typeIn("next week");
    expect(screen.getAllByRole("button", { name: /^Open / }).map((b) => b.textContent)).toEqual(["Monday thing"]);
  });
});

describe("everything, grouped", () => {
  const tasks = [task({ id: "a", title: "Pricing deck" }), task({ id: "b", title: "Hiring plan" })];
  const comments: Comment[] = [
    { id: "c1", taskId: "b", authorId: "u-sarah", authorName: "Sarah Price", body: "We should check the pricing before we hire", createdAt: "2026-10-08T09:00:00Z" },
  ];
  const docs = [{ id: "d1", projectId: "p-live", title: "Launch brief", workspaceId: "ws", text: "Goals\nPricing: three tiers" }];
  const handlers = () => ({ onOpenDoc: vi.fn(), onOpenProject: vi.fn(), onOpenPerson: vi.fn(), onOpenComment: vi.fn() });

  it("Tasks, Comments, Docs, Projects, People — each with a heading, a count and the words marked", () => {
    const h = handlers();
    renderSearch({ tasks, comments, docs, ...h });
    typeIn("pric");
    const headings = screen.getAllByRole("heading", { level: 3 }).map((x) => x.textContent);
    expect(headings).toEqual(["Tasks1", "Comments1", "Docs1", "Projects1", "People1"]);
    expect(screen.getByRole("status")).toHaveTextContent("5 results: 1 task, 1 comment, 1 doc, 1 project, 1 person");
    const comment = screen.getByRole("button", { name: /^Comment by Sarah Price on Hiring plan/ });
    expect(within(comment).getByText("pric", { selector: "mark" })).toBeInTheDocument();
    fireEvent.click(comment);
    expect(h.onOpenComment).toHaveBeenCalledWith("b", "c1");
    fireEvent.click(screen.getByRole("button", { name: /^Doc Launch brief in Launch/ }));
    expect(h.onOpenDoc).toHaveBeenCalledWith("d1", "p-live");
    fireEvent.click(screen.getByRole("button", { name: /^Sarah Price/ }));
    expect(h.onOpenPerson).toHaveBeenCalledWith("u-sarah");
  });

  it("kinds nobody can open aren't offered; onGo opens them when given", () => {
    const { unmount } = renderSearch({ tasks, comments, docs });
    typeIn("pricing");
    expect(screen.queryByRole("heading", { name: /^Docs/ })).not.toBeInTheDocument();
    unmount();
    const onGo = vi.fn();
    renderSearch({ tasks, comments, docs, onGo });
    typeIn("brief");
    fireEvent.click(screen.getAllByRole("button", { name: /^Doc Launch brief/ })[0]);
    expect(onGo).toHaveBeenCalledWith({ view: "project", projectId: "p-live", tab: "docs", docId: "d1" });
  });

  it("Show narrows to one kind; 'docs mentioning…' presses it for you; a few of each until then", () => {
    const many = Array.from({ length: 12 }, (_, i) => task({ id: `t${i}`, title: `Pricing ${i}` }));
    renderSearch({ tasks: many, docs, ...handlers() });
    typeIn("pricing");
    expect(screen.getAllByRole("button", { name: /^Open Pricing/ })).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show all 12 tasks" }));
    expect(screen.getAllByRole("button", { name: /^Open Pricing/ })).toHaveLength(12);
    const show = screen.getByRole("group", { name: "Show" });
    expect(within(show).getByRole("button", { name: /^Tasks/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(show).getByRole("button", { name: "All" }));
    typeIn("docs mentioning pricing");
    expect(within(show).getByRole("button", { name: /^Docs/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /^Open Pricing/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Doc Launch brief/ })).toBeInTheDocument();
    // picking another kind takes the words that asked for docs out of the box
    fireEvent.click(within(show).getByRole("button", { name: /^Tasks/ }));
    expect(box().value).toBe("pricing");
  });

  it("task filters on their own mean tasks", () => {
    renderSearch({ tasks: [task({ id: "a", title: "Pricing deck", status: "blocked" })], comments, docs, ...handlers() });
    typeIn("blocked pricing");
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);   // one group: no headings
    expect(screen.getByRole("status")).toHaveTextContent("1 result");
  });
});

describe("the server's answer", () => {
  const hit = (o: Partial<SearchHit>): SearchHit => ({ kind: "task", id: "x", title: "x", snippet: null, rank: 0.5, taskId: null, projectId: null, workspaceId: "ws", updatedAt: null, source: "server", ...o });

  it("joins the device's after a moment: stemmed task matches, comments it hasn't loaded, its snippets", async () => {
    const tasks = [task({ id: "a", title: "Pricing deck" }), task({ id: "b", title: "Competitor review", description: "Check their prices" })];
    api.searchAll.mockResolvedValue([
      hit({ id: "b", title: "Competitor review", snippet: `Check their ${S}prices${E}`, task: { status: "todo", priority: "medium", dueDate: null, assigneeId: null, parentId: null, archived: false } }),
      hit({ kind: "comment", id: "c9", title: "Pricing deck", taskId: "a", snippet: `the ${S}pricing${E} table`, comment: { authorId: "u-sarah", authorName: "Sarah Price", taskStatus: "todo" } }),
    ]);
    renderSearch({ tasks, serverSearch: true });
    typeIn("pricing");
    expect(screen.getByRole("status")).toHaveTextContent("1 result");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("3 results"));
    expect(api.searchAll).toHaveBeenCalledTimes(1);
    expect(api.searchAll.mock.calls[0][0]).toBe("pricing");
    expect(screen.getByRole("button", { name: /^Open Competitor review/ })).toBeInTheDocument();
    expect(screen.getByText("prices", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Comment by Sarah Price on Pricing deck: the pricing table/ })).toBeInTheDocument();
  });

  it("before 0048 (or offline) the device's answer stands, and says so quietly", async () => {
    api.searchAll.mockRejectedValue(new Error("function public.search_all(text, jsonb, integer) does not exist"));
    renderSearch({ tasks: [task({ id: "a", title: "Pricing deck" })], serverSearch: true });
    typeIn("pricing");
    await waitFor(() => expect(screen.getByText(/Full-text search isn't switched on yet/)).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("1 result");
    // remembered for the session: the next search doesn't ask again
    typeIn("deck");
    await new Promise((r) => setTimeout(r, 260));
    expect(api.searchAll).toHaveBeenCalledTimes(1);
  });

  it("demo mode searches the device alone", () => {
    renderSearch({ tasks: [task({ id: "a", title: "Pricing deck" })] });
    typeIn("pricing");
    expect(screen.getByText("Demo mode: searching on this device")).toBeInTheDocument();
    expect(api.searchAll).not.toHaveBeenCalled();
  });
});

describe("nothing typed", () => {
  it("offers recent searches (opened ones are remembered) and ways to ask", () => {
    setPointer(true);
    const { unmount } = renderSearch({ tasks: [task({ id: "a", title: "Pricing deck" })] });
    expect(screen.getByRole("heading", { name: "Try asking" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sarah's overdue tasks" }));
    expect(box().value).toBe("Sarah's overdue tasks");
    typeIn("pricing");
    fireEvent.click(screen.getByRole("button", { name: /^Open Pricing deck/ }));
    unmount();
    renderSearch({ tasks: [task({ id: "a", title: "Pricing deck" })] });
    const recent = screen.getByRole("region", { name: "Search results" });
    expect(within(recent).getByRole("button", { name: "Search again for pricing" })).toBeInTheDocument();
    fireEvent.click(within(recent).getByRole("button", { name: "Remove pricing from recent searches" }));
    expect(within(recent).queryByRole("button", { name: "Search again for pricing" })).not.toBeInTheDocument();
    expect(within(recent).getByRole("button", { name: "Search again for Sarah's overdue tasks" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent searches" })).toBeInTheDocument();
    fireEvent.click(within(recent).getByRole("button", { name: "Clear recent searches" }));
    expect(screen.queryByRole("heading", { name: /Recent searches/ })).not.toBeInTheDocument();
  });
});
