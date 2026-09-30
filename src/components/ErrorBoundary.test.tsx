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

  it("contains a crash to the view and offers Go home / Retry", () => {
    const home = vi.fn();
    render(<div><p>Sidebar still here</p><ErrorBoundary inline onHome={home}><Flaky /></ErrorBoundary></div>);
    expect(screen.getByRole("alert")).toHaveTextContent("This view hit a problem");
    expect(screen.getByText("Sidebar still here")).toBeInTheDocument();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
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
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload Kanbo" })).toBeInTheDocument();
  });
});
