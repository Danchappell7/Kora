import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MobileNav } from "./MobileNav";
import type { Route } from "../app-types";

const renderNav = (over: Partial<Parameters<typeof MobileNav>[0]> = {}) => {
  const props = { route: { view: "plan" } as Route, setRoute: vi.fn(), inboxCount: 0, onCapture: vi.fn(), onMore: vi.fn(), ...over };
  render(<MobileNav {...props} />);
  return props;
};

describe("MobileNav", () => {
  it("has five slots: Today, My tasks, +, Inbox, More", () => {
    renderNav();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Today", "My tasks", "Quick capture", "Inbox", "More"]);
  });

  it("goes to each place, and marks the current one", () => {
    const p = renderNav({ route: { view: "myweek" } });
    expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "My tasks" }));
    expect(p.setRoute).toHaveBeenCalledWith({ view: "tasks" });
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
    expect(p.setRoute).toHaveBeenCalledWith({ view: "inbox" });
  });

  it("the centre + opens quick capture, and More opens the drawer", () => {
    const p = renderNav();
    fireEvent.click(screen.getByRole("button", { name: "Quick capture" }));
    expect(p.onCapture).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(p.onMore).toHaveBeenCalledTimes(1);
  });

  it("names the Inbox badge with the unread count", () => {
    renderNav({ inboxCount: 4 });
    expect(screen.getByRole("button", { name: "Inbox, 4 unread" })).toHaveTextContent("4");
  });

  it("hides + and More when there's nothing to wire them to (guests, older callers)", () => {
    renderNav({ onCapture: undefined, onMore: undefined });
    expect(screen.queryByRole("button", { name: "Quick capture" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });
});
