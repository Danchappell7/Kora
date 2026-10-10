import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HelpMenu } from "./HelpMenu";

const sample = (over: Partial<{ exists: boolean; busy: boolean }> = {}) => ({ exists: false, busy: false, onCreate: vi.fn(), onRemove: vi.fn(), ...over });

describe("Help (?)", () => {
  it("a labelled icon button opens a menu: the tour, shortcuts, the sample project", () => {
    const onStartTour = vi.fn();
    render(<HelpMenu onStartTour={onStartTour} onOpenShortcuts={vi.fn()} sample={sample()} />);
    const btn = screen.getByRole("button", { name: "Help" });
    expect(btn).toHaveAttribute("aria-haspopup", "menu");
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Help" });
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((m) => m.querySelector(".khelp-label")?.textContent))
      .toEqual(["Take the tour", "Keyboard shortcuts", "Try the sample project"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Take the tour/ }));
    expect(onStartTour).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("keyboard: focus moves into the menu, arrows move, Escape closes and focus returns", async () => {
    render(<HelpMenu onStartTour={vi.fn()} onOpenShortcuts={vi.fn()} sample={sample()} />);
    const btn = screen.getByRole("button", { name: "Help" });
    btn.focus();
    fireEvent.click(btn);
    const items = screen.getAllByRole("menuitem");
    await vi.waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "End" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(btn).toHaveFocus();
  });
  it("try the sample, or — once it exists — remove it in one click", () => {
    const s = sample();
    const { rerender } = render(<HelpMenu onStartTour={vi.fn()} sample={s} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("menuitem", { name: /Try the sample project/ })).toHaveTextContent("“Kanbo tour”, in Personal");
    fireEvent.click(screen.getByRole("menuitem", { name: /Try the sample project/ }));
    expect(s.onCreate).toHaveBeenCalled();
    const made = sample({ exists: true });
    rerender(<HelpMenu onStartTour={vi.fn()} sample={made} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    const remove = screen.getByRole("menuitem", { name: "Remove the sample project" });
    expect(remove).toHaveAttribute("data-tone", "danger");
    fireEvent.click(remove);
    expect(made.onRemove).toHaveBeenCalled();
  });
  it("while it's being made or removed: disabled, and it says so", () => {
    render(<HelpMenu onStartTour={vi.fn()} sample={sample({ busy: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("menuitem", { name: /Making the sample project/ })).toBeDisabled();
  });
  it("guests (sample: null) and no shortcuts handler: just the tour", () => {
    render(<HelpMenu onStartTour={vi.fn()} sample={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    expect(screen.queryByRole("separator")).toBeNull();
  });
  it("the row variant, and “Get set up” brought back after a dismissal", () => {
    const onShow = vi.fn();
    render(<HelpMenu variant="row" onStartTour={vi.fn()} sample={null} setup={{ done: 1, total: 4, onShow }} />);
    const row = screen.getByRole("button", { name: "Help" });
    expect(row).toHaveClass("khelp-row");
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("menuitem", { name: /Get set up 1 of 4/ }));
    expect(onShow).toHaveBeenCalled();
  });
});
