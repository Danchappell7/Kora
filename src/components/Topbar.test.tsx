import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Topbar, PageHeader } from "./Topbar";

const makeCreate = () => ({ onNewTask: vi.fn(), onQuickCapture: vi.fn(), onPasteNotes: vi.fn(), onImport: vi.fn(), onNewProject: vi.fn() });
const openCreateMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "More ways to create" }));
  return screen.getByRole("menu", { name: "Create" });
};

describe("PageHeader", () => {
  it("draws the title as the page's heading, with its meta", () => {
    render(<PageHeader title="Today" meta="Wed 30 Sep" onSearch={vi.fn()} create={makeCreate()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    expect(screen.getByText("Wed 30 Sep")).toBeInTheDocument();
  });

  it("opens the palette from “Search or ask Kanbo”, which names its ⌘K shortcut", () => {
    const onSearch = vi.fn();
    render(<PageHeader title="Inbox" onSearch={onSearch} create={makeCreate()} />);
    const search = screen.getByRole("button", { name: "Search or ask Kanbo" });
    expect(search).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K");
    fireEvent.click(search);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("creates a task from the New task button", () => {
    const create = makeCreate();
    render(<PageHeader title="Inbox" onSearch={vi.fn()} create={create} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(create.onNewTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("lists every way to create behind the chevron, and each one runs and closes the menu", () => {
    const create = makeCreate();
    render(<PageHeader title="Inbox" onSearch={vi.fn()} create={create} />);
    const chevron = screen.getByRole("button", { name: "More ways to create" });
    expect(chevron).toHaveAttribute("aria-haspopup", "menu");
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    const menu = openCreateMenu();
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    const items = within(menu).getAllByRole("menuitem").map((m) => m.textContent);
    expect(items).toEqual(["New taskC", "Quick captureQ", "Paste notes → tasks", "Import tasks…", "New project"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Quick capture" }));
    expect(create.onQuickCapture).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(within(openCreateMenu()).getByRole("menuitem", { name: /Paste notes/ }));
    expect(create.onPasteNotes).toHaveBeenCalledTimes(1);
  });

  it("follows the menu-button keyboard pattern: focus moves in, arrows move, Escape closes back to the chevron", () => {
    render(<PageHeader title="Inbox" onSearch={vi.fn()} create={makeCreate()} />);
    const chevron = screen.getByRole("button", { name: "More ways to create" });
    chevron.focus();
    const menu = openCreateMenu();
    const [first, second] = within(menu).getAllByRole("menuitem");
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(chevron).toHaveFocus();
  });

  it("leaves New project out when it isn't offered", () => {
    const { onNewProject: _omit, ...create } = makeCreate();
    render(<PageHeader title="Inbox" onSearch={vi.fn()} create={create} />);
    const menu = openCreateMenu();
    expect(within(menu).getByRole("menuitem", { name: /Quick capture/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /New project/ })).not.toBeInTheDocument();
  });

  it("has neither New task nor the create menu for guests (create = null)", () => {
    render(<PageHeader title="Today" onSearch={vi.fn()} create={null} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More ways to create" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search or ask Kanbo" })).toBeInTheDocument();
  });

  it("renders tabs as a nav with the current tab marked, and reports the tab picked", () => {
    const onTab = vi.fn();
    render(<PageHeader title="Projects" meta="Foundrise" onSearch={vi.fn()} create={makeCreate()} tabsLabel="Projects views" tabValue="projects" onTab={onTab}
      tabs={[{ id: "projects", label: "All" }, { id: "goals", label: "Goals" }, { id: "automations", label: "Rules", count: 3, secondary: true }]} />);
    const nav = screen.getByRole("navigation", { name: "Projects views" });
    expect(within(nav).getByRole("button", { name: "All" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: "Goals" })).not.toHaveAttribute("aria-current");
    fireEvent.click(within(nav).getByRole("button", { name: /Rules/ }));
    expect(onTab).toHaveBeenCalledWith("automations");
  });

  it("draws the switcher as a labelled group", () => {
    const onChange = vi.fn();
    render(<PageHeader title="Today" onSearch={vi.fn()} create={makeCreate()}
      switcher={{ label: "Today view", value: "plan", onChange, items: [{ id: "plan", label: "Day" }, { id: "myweek", label: "Week" }, { id: "calendar", label: "Month" }] }} />);
    const group = screen.getByRole("group", { name: "Today view" });
    expect(within(group).getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: "Week" }));
    expect(onChange).toHaveBeenCalledWith("myweek");
  });

  it("shows momentum as a labelled progress bar, and nothing when it's null", () => {
    const { rerender } = render(<PageHeader title="Today" onSearch={vi.fn()} create={null} momentum={0.29} momentumLabel="Today's work done, 2 of 7" />);
    const bar = screen.getByRole("progressbar", { name: "Today's work done, 2 of 7" });
    expect(bar).toHaveAttribute("aria-valuenow", "29");
    rerender(<PageHeader title="Today" onSearch={vi.fn()} create={null} momentum={null} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("on a phone: search and the account button, and no New task (the bottom bar's + captures)", () => {
    const onSearch = vi.fn(), onOpenSettings = vi.fn();
    render(<PageHeader title="Today" meta="Wed 30 Sep" onSearch={onSearch} create={makeCreate()} isMobile onOpenSettings={onOpenSettings} userId="nobody" />);
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search or ask Kanbo" }));
    expect(onSearch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });
});

describe("Topbar (legacy alias)", () => {
  it("draws the old props as a PageHeader: title, search, New task and New project", () => {
    const onCommand = vi.fn(), onNewTask = vi.fn(), onNewProject = vi.fn();
    render(<Topbar title="My tasks" subtitle="Foundrise" onCommand={onCommand} onNewTask={onNewTask} onNewProject={onNewProject} onBell={vi.fn()} theme="light" toggleTheme={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "My tasks" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search or ask Kanbo" }));
    expect(onCommand).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(onNewTask).toHaveBeenCalled();
    fireEvent.click(within(openCreateMenu()).getByRole("menuitem", { name: "New project" }));
    expect(onNewProject).toHaveBeenCalled();
    // the bell and the theme button moved out of the header
    expect(screen.queryByRole("button", { name: /^Notifications/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Switch to/ })).not.toBeInTheDocument();
  });

  it("offers New project only to people who can create projects, and nothing to create for guests", () => {
    const { unmount } = render(<Topbar title="Inbox" onCommand={vi.fn()} onNewTask={vi.fn()} onNewProject={vi.fn()} canCreateProject={false} />);
    expect(within(openCreateMenu()).queryByRole("menuitem", { name: "New project" })).not.toBeInTheDocument();
    unmount();
    render(<Topbar title="Inbox" onCommand={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });
});
