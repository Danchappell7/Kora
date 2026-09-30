import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WhatMoved, WHAT_MOVED_KEY, whatMovedSeen, markWhatMovedSeen } from "./WhatMoved";

// the card never shows in tests (it would sit over every App test), so pretend to be the app
const asApp = () => vi.stubEnv("MODE", "development");
afterEach(() => { vi.unstubAllEnvs(); localStorage.clear(); });

describe("WhatMoved", () => {
  it("never shows under test", () => {
    render(<WhatMoved onShowMe={() => {}} />);
    expect(screen.queryByRole("complementary", { name: "Kanbo's had a tidy-up" })).not.toBeInTheDocument();
  });

  it("shows the five moves once; Got it remembers it", () => {
    asApp();
    const { unmount } = render(<WhatMoved onShowMe={() => {}} />);
    const card = screen.getByRole("complementary", { name: "Kanbo's had a tidy-up" });
    expect(card.querySelectorAll("li")).toHaveLength(5);
    expect(card).toHaveTextContent("Home and Plan my day are now Today.");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(localStorage.getItem(WHAT_MOVED_KEY)).toBe("1");
    unmount();
    render(<WhatMoved onShowMe={() => {}} />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("Show me around opens the command bar; Escape dismisses too", () => {
    asApp();
    const show = vi.fn();
    const { unmount } = render(<WhatMoved onShowMe={show} />);
    fireEvent.click(screen.getByRole("button", { name: "Show me around" }));
    expect(show).toHaveBeenCalledTimes(1);
    expect(whatMovedSeen()).toBe(true);
    unmount();
    localStorage.clear();
    render(<WhatMoved onShowMe={show} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Got it" }), { key: "Escape" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("steps aside while a task panel is open, and comes back after (still unseen)", () => {
    asApp();
    const { rerender } = render(<WhatMoved onShowMe={() => {}} hidden />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(whatMovedSeen()).toBe(false);
    rerender(<WhatMoved onShowMe={() => {}} />);
    expect(screen.getByRole("complementary", { name: "Kanbo's had a tidy-up" })).toBeInTheDocument();
  });

  it("on a phone it points at the search button, not a key", () => {
    asApp();
    render(<WhatMoved onShowMe={() => {}} isMobile />);
    const card = screen.getByRole("complementary", { name: "Kanbo's had a tidy-up" });
    expect(card).toHaveTextContent("Search and Ask are behind the search button at the top.");
    expect(card).not.toHaveTextContent("⌘K");
  });

  it("stays away when it has been marked seen (someone new, after the tour)", () => {
    asApp();
    markWhatMovedSeen();
    render(<WhatMoved onShowMe={() => {}} />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});
