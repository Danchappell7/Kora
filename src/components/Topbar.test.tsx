import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Topbar } from "./Topbar";

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
