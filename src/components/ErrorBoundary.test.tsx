import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

let broken = true;
function Flaky() {
  if (broken) throw new Error("boom");
  return <p>View content</p>;
}

describe("ErrorBoundary (inline)", () => {
  let quiet: { mockRestore: () => void };
  beforeEach(() => { broken = true; quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => quiet.mockRestore());

  it("contains a crash to the view and offers Go to Today / Reload", () => {
    const home = vi.fn();
    render(<div><p>Sidebar still here</p><ErrorBoundary inline onHome={home}><Flaky /></ErrorBoundary></div>);
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong on this page");
    expect(screen.getByText("Sidebar still here")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to Today" }));
    expect(home).toHaveBeenCalledTimes(1);
  });

  it("Reload renders the view again", () => {
    render(<ErrorBoundary inline><Flaky /></ErrorBoundary>);
    expect(screen.queryByRole("button", { name: "Go to Today" })).toBeNull(); // nowhere to go without onHome
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByText("View content")).toBeInTheDocument();
    broken = true;
  });

  it("calls onHome from the leave button, with a custom label for panels", () => {
    const close = vi.fn();
    render(<ErrorBoundary inline floating onHome={close} homeLabel="Close"><Flaky /></ErrorBoundary>);
    expect(screen.getByRole("dialog", { name: "Task panel error" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the full-page fallback by default", () => {
    render(<ErrorBoundary><Flaky /></ErrorBoundary>);
    expect(screen.getByRole("heading", { name: "Something went wrong on this page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to Today" })).toBeInTheDocument();
  });
});
