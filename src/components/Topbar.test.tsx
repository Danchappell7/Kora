import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Topbar, PageHeader } from "./Topbar";

const renderTopbar = (props: Partial<React.ComponentProps<typeof Topbar>> = {}) =>
  render(<Topbar title="Home" onNewTask={vi.fn()} onNewProject={vi.fn()} onCommand={vi.fn()} onBell={vi.fn()} theme="light" toggleTheme={vi.fn()} {...props} />);

describe("Topbar", () => {
  it("names the bell with the unread count", () => {
    renderTopbar({ unreadCount: 3 });
    expect(screen.getByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
  });

  it("offers New project in the Create menu only to people who can create projects", () => {
    const { unmount } = renderTopbar();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("menuitem", { name: /New project/ })).toBeInTheDocument();
    unmount();
    renderTopbar({ canCreateProject: false });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("menuitem", { name: /New task/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /New project/ })).not.toBeInTheDocument();
  });
});

describe("PageHeader", () => {
  const create = { onNewTask: vi.fn(), onQuickCapture: vi.fn(), onPasteNotes: vi.fn() };
  it("draws the title, meta and tabs, and reports the tab picked", () => {
    const onTab = vi.fn();
    render(<PageHeader title="Projects" meta="Foundrise" onSearch={vi.fn()} create={create} tabsLabel="Projects views" tabValue="projects" onTab={onTab}
      tabs={[{ id: "projects", label: "All" }, { id: "goals", label: "Goals" }, { id: "automations", label: "Rules", count: 3, secondary: true }]} />);
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText("Foundrise")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Projects views" });
    expect(nav.querySelector('[aria-current="page"]')).toHaveTextContent("All");
    fireEvent.click(screen.getByRole("button", { name: /Rules/ }));
    expect(onTab).toHaveBeenCalledWith("automations");
  });

  it("has no Create menu for guests, and search opens the palette", () => {
    const onSearch = vi.fn();
    render(<PageHeader title="Today" onSearch={onSearch} create={null} />);
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search or open command palette" }));
    expect(onSearch).toHaveBeenCalled();
  });
});
