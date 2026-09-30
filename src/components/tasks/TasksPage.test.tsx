import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { TasksPage } from "./TasksPage";
import { KANBO_TODAY, setReferenceData, toLocalISO } from "../../data/data";
import type { Task, Member, Project } from "../../data/types";
import type { GroupBy, TaskView } from "../../app-types";

const ME = "m-self";
let n = 0;
const mk = (p: Partial<Task> & { title: string }): Task => ({
  id: p.id ?? `t-${++n}`, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: ME,
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 50, ...p,
});
const day = (d: number) => toLocalISO(new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate() + d));
const PROJECTS: Project[] = [{ id: "p-launch", name: "Q3 Product Launch", emoji: "", color: "oklch(0.6 0.15 250)", workspaceId: "ws" }];
const MEMBERS = [{ id: ME, name: "Daniel Okai" }, { id: "m-maya", name: "Maya Lin" }, { id: "m-sana", name: "Sana Rao" }];

beforeAll(() => {
  const m = (id: string, name: string): Member => ({ id, name, email: `${id}@x.test`, type: "team", color: "#888" });
  setReferenceData({ projects: PROJECTS, members: MEMBERS.map((x) => m(x.id, x.name)) });
});
beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

type PageProps = Parameters<typeof TasksPage>[0];
const props = (tasks: Task[], over: Partial<PageProps> = {}): PageProps => ({
  tasks, allTasks: tasks, projects: PROJECTS, view: "list", setView: vi.fn(), groupBy: "status", setGroupBy: vi.fn(), smart: false, setSmart: vi.fn(),
  onOpen: vi.fn(), onToggle: vi.fn(), onToggleSubtask: vi.fn(), onAdd: vi.fn(), onMove: vi.fn(), onBulkPatch: vi.fn(), onBulkDelete: vi.fn(),
  onPatch: vi.fn(), onQuickAdd: vi.fn(), members: MEMBERS, allTags: {}, currentUserId: ME, ...over,
});

/** My tasks the way App wires it: the tab lives in the address (here: state). */
function My({ tasks, all, ...over }: { tasks: Task[]; all?: Task[] } & Partial<PageProps>) {
  const [tab, setTab] = useState("open");
  return <TasksPage {...props(tasks, { allTasks: all ?? tasks, tab, onTab: setTab, ...over })} />;
}

describe("My tasks tabs", () => {
  it("switch through onTab: Open · Waiting on · Done", () => {
    const onTab = vi.fn();
    render(<TasksPage {...props([mk({ title: "Mine" })], { tab: "open", onTab })} />);
    const tabs = screen.getByRole("tablist", { name: "My tasks" });
    expect(within(tabs).getByRole("tab", { name: /^Open/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(tabs).getByRole("tab", { name: /^Waiting on/ }));
    expect(onTab).toHaveBeenCalledWith("waiting");
    fireEvent.click(within(tabs).getByRole("tab", { name: /^Done/ }));
    expect(onTab).toHaveBeenCalledWith("done");
  });

  it("Open groups my work by when it's due", () => {
    const tasks = [
      mk({ title: "Late one", dueDate: day(-2) }),
      mk({ title: "Due now", dueDate: day(0) }),
      mk({ title: "Planned for today", planToday: true }),
      mk({ title: "Later on", dueDate: day(20) }),
      mk({ title: "Someday" }),
    ];
    render(<My tasks={tasks} />);
    const heads = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.replace(/, \d+ tasks?$/, "").replace(/\d+$/, ""));
    expect(heads).toEqual(["Overdue", "Today", "Later", "No date"]);
    expect(within(screen.getByRole("heading", { name: /^Today/ }).closest("section")!).getByText("Planned for today")).toBeInTheDocument();
  });

  it("Waiting on lists the tasks I created for other people, by person", () => {
    const mine = mk({ title: "My own work" });
    const forMaya = mk({ title: "Draft the brief", assigneeId: "m-maya", createdBy: ME });
    const forSana = mk({ title: "Book the venue", assigneeId: "m-sana", createdBy: ME });
    const notMine = mk({ title: "Maya's own thing", assigneeId: "m-maya", createdBy: "m-maya" });
    const onNudge = vi.fn();
    render(<My tasks={[mine]} all={[mine, forMaya, forSana, notMine]} onNudge={onNudge} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Waiting on/ }));
    expect(screen.getByRole("heading", { name: /^With Maya/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^With Sana/ })).toBeInTheDocument();
    expect(screen.getByText("Draft the brief")).toBeInTheDocument();
    expect(screen.queryByText("Maya's own thing")).not.toBeInTheDocument();
    expect(screen.queryByText("My own work")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nudge Maya about “Draft the brief”" }));
    expect(onNudge).toHaveBeenCalledWith(forMaya.id);
    expect(screen.getByRole("button", { name: "Nudged Maya" })).toBeDisabled();
  });

  it("Done is grouped by the day each task was finished", () => {
    const tasks = [
      mk({ title: "Finished today", status: "done", completedAt: day(0) }),
      mk({ title: "Finished yesterday", status: "done", completedAt: day(-1) }),
      mk({ title: "Still open" }),
    ];
    render(<My tasks={tasks} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Done/ }));
    expect(screen.getByRole("heading", { name: /^Today/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Yesterday/ })).toBeInTheDocument();
    expect(screen.queryByText("Still open")).not.toBeInTheDocument();
  });

  it("empty tabs say so in plain words", () => {
    render(<My tasks={[]} onOpenImport={vi.fn()} />);
    expect(screen.getByText("You're all clear")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import tasks" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /^Waiting on/ }));
    expect(screen.getByText("Nothing waiting on others")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /^Done/ }));
    expect(screen.getByText("Nothing finished in the last 30 days")).toBeInTheDocument();
  });
});

describe("the one toolbar row", () => {
  it("Filter presets toggle, name the button “Filter · on” and show as removable pills", () => {
    const tasks = [mk({ title: "Big one", priority: "high" }), mk({ title: "Small one", priority: "low" })];
    render(<My tasks={tasks} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const panel = screen.getByRole("dialog", { name: "Filter" });
    const chip = within(within(panel).getByRole("group", { name: "Quick filters" })).getByRole("button", { name: "High priority" });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Filter · on/ })).toBeInTheDocument();
    expect(screen.queryByText("Small one")).not.toBeInTheDocument();
    const pills = screen.getByRole("group", { name: "Active filters" });
    fireEvent.click(within(pills).getByRole("button", { name: "Remove filter: High priority" }));
    expect(screen.getByText("Small one")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Active filters" })).not.toBeInTheDocument();
  });

  it("a title filter that hides everything says so, and Clear filters brings the tasks back", () => {
    render(<My tasks={[mk({ title: "Budget review" })]} />);
    fireEvent.change(screen.getByLabelText("Filter tasks by title"), { target: { value: "zzz" } });
    expect(screen.getByText("No tasks match these filters")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Clear filters/ })[0]);
    expect(screen.getByText("Budget review")).toBeInTheDocument();
  });

  it("Save view names the view in place (no window.prompt)", () => {
    const prompt = vi.spyOn(window, "prompt");
    const onSaveView = vi.fn();
    render(<My tasks={[mk({ title: "Budget review" })]} onSaveView={onSaveView} />);
    expect(screen.queryByRole("button", { name: "Save view" })).not.toBeInTheDocument(); // only once something is filtered
    fireEvent.change(screen.getByLabelText("Filter tasks by title"), { target: { value: "budget" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    const field = screen.getByRole("textbox", { name: "Name this view" });
    fireEvent.change(field, { target: { value: "Budget work" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSaveView).toHaveBeenCalledWith("Budget work", expect.objectContaining({ text: "budget" }));
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it("saved views sit in the tabs row and open through onOpenSavedView", () => {
    const onOpenSavedView = vi.fn();
    render(<My tasks={[mk({ title: "x" })]} savedViews={[{ id: "s1", name: "Urgent bugs", count: 4 }]} onOpenSavedView={onOpenSavedView} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Urgent bugs/ }));
    expect(onOpenSavedView).toHaveBeenCalledWith("s1");
  });

  it("Display › Sort offers Kanbo's order (the old AI sort)", () => {
    const setSmart = vi.fn();
    render(<My tasks={[mk({ title: "x" })]} setSmart={setSmart} />);
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Display" })).getByRole("button", { name: "Kanbo's order" }));
    expect(setSmart).toHaveBeenCalled();
  });

  it("⋯ holds export, import and advanced search", () => {
    const onOpenImport = vi.fn(), onAdvancedSearch = vi.fn();
    render(<My tasks={[mk({ title: "x" })]} onOpenImport={onOpenImport} onAdvancedSearch={onAdvancedSearch} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(within(menu).getByRole("menuitem", { name: /Export CSV/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Export PDF/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Import tasks/ }));
    expect(onOpenImport).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "More actions" })).getByRole("menuitem", { name: /Advanced search/ }));
    expect(onAdvancedSearch).toHaveBeenCalled();
  });

  it("the view menu switches My tasks to the board", () => {
    const setView = vi.fn();
    render(<My tasks={[mk({ title: "x" })]} setView={setView} />);
    fireEvent.click(screen.getByRole("button", { name: "View: List" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Board/ }));
    expect(setView).toHaveBeenCalledWith("board");
  });
});

describe("a project's tasks", () => {
  function Project({ onTabSpy, ...over }: { onTabSpy?: (t: string) => void } & Partial<PageProps>) {
    const [tab, setTab] = useState("list");
    const [view, setView] = useState<TaskView>("list");
    const [groupBy, setGroupBy] = useState<GroupBy>("status");
    return (
      <TasksPage {...props([mk({ title: "Launch deck" })], { filterScope: "p-launch", view, setView, groupBy, setGroupBy, tab, onTab: (t) => { onTabSpy?.(t); setTab(t); }, ...over })}
        extraTabs={[{ id: "updates", label: "Updates", count: 2 }, { id: "rules", label: "Rules" }]}
        renderExtra={(t) => <p>Panel for {t}</p>} notice={<span>On track · updated 2 days ago</span>} />
    );
  }

  it("shows the views, then the project's own tabs, and renders the extra panel in place of the tasks", () => {
    const onTabSpy = vi.fn();
    render(<Project onTabSpy={onTabSpy} />);
    const tabs = screen.getByRole("tablist", { name: "Project views" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["List", "Board", "Timeline", "Calendar", "More", "Updates", "Rules"]);
    expect(screen.getByText("On track · updated 2 days ago")).toBeInTheDocument();
    expect(screen.getByText("Launch deck")).toBeInTheDocument();
    fireEvent.click(within(tabs).getByRole("tab", { name: /^Updates/ }));
    expect(onTabSpy).toHaveBeenCalledWith("updates");
    expect(screen.getByText("Panel for updates")).toBeInTheDocument();
    expect(screen.queryByText("Launch deck")).not.toBeInTheDocument();
    // the task tools step aside on a project's own tab
    expect(screen.queryByLabelText("Filter tasks by title")).not.toBeInTheDocument();
  });

  it("More ▾ opens Files and Matrix", () => {
    const onTabSpy = vi.fn();
    render(<Project onTabSpy={onTabSpy} />);
    fireEvent.click(screen.getByRole("tab", { name: /^More/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Matrix/ }));
    expect(onTabSpy).toHaveBeenCalledWith("matrix");
  });

  it("keeps filters per page: a My tasks filter doesn't narrow a project", () => {
    const { unmount } = render(<My tasks={[mk({ title: "x", priority: "low" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Quick filters" })).getByRole("button", { name: "Urgent" }));
    expect(screen.getByRole("button", { name: /Filter · on/ })).toBeInTheDocument();
    unmount();
    render(<Project />);
    expect(screen.getByRole("button", { name: /^Filter$/ })).toBeInTheDocument();
  });
});

describe("?due= links", () => {
  it("scroll to and flash that group", async () => {
    const scrolled = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      render(<My tasks={[mk({ title: "Late", dueDate: day(-1) }), mk({ title: "Now", dueDate: day(0) })]} dueFocus="today" />);
      const section = screen.getByRole("heading", { name: /^Today/ }).closest("section")!;
      await waitFor(() => expect(section.classList.contains("ktv-flash")).toBe(true));
      expect(scrolled).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});

describe("guests", () => {
  it("read only: no Save view, no Import, no add", () => {
    render(<My tasks={[mk({ title: "Budget review" })]} readOnly onSaveView={vi.fn()} onOpenImport={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Filter tasks by title"), { target: { value: "budget" } });
    expect(screen.queryByRole("button", { name: "Save view" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /Import tasks/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Add task")).not.toBeInTheDocument();
  });
});
