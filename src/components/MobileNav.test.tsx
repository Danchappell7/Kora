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

  it("marks More as current inside Projects or Team (they live behind it), and says whether its drawer is open", () => {
    const { rerender } = render(<MobileNav route={{ view: "project", projectId: "p-1" }} setRoute={vi.fn()} inboxCount={0} onMore={vi.fn()} />);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-current", "true");
    expect(more).toHaveAttribute("aria-haspopup", "dialog");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Today" })).not.toHaveAttribute("aria-current");
    rerender(<MobileNav route={{ view: "plan" }} setRoute={vi.fn()} inboxCount={0} onMore={vi.fn()} moreOpen />);
    expect(more).not.toHaveAttribute("aria-current");
    expect(more).toHaveAttribute("aria-expanded", "true");
  });

  it("draws the centre + as a plain primary fill, without the hero glow", () => {
    renderNav();
    const css = Array.from(document.querySelectorAll("style")).map((el) => el.textContent ?? "").find((t) => t.includes(".kmnav-plus"))!;
    const plus = css.match(/\.kmnav-plus \{([^}]*)\}/)![1];
    expect(plus).toMatch(/background:\s*var\(--accent-fill/);
    expect(plus).not.toMatch(/hero-glow|box-shadow/);
  });

  it("hides + and More when there's nothing to wire them to (guests, older callers)", () => {
    renderNav({ onCapture: undefined, onMore: undefined });
    expect(screen.queryByRole("button", { name: "Quick capture" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });
});
