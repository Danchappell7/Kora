import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { chunkReload } from "../lib/lazyLoad";

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

describe("ErrorBoundary (inline) when a view's code didn't arrive", () => {
  let quiet: { mockRestore: () => void };
  beforeEach(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { quiet.mockRestore(); vi.restoreAllMocks(); });

  let failure: Error | null = null;
  function Screen() {
    if (failure) throw failure;
    return <p>Recycle bin</p>;
  }
  const named = () => new TypeError(`Failed to fetch dynamically imported module: ${window.location.origin}/assets/RecycleBin-abc.js`);

  it("Reload tries in place once when the file can be asked for again, then reloads the page", () => {
    const reload = vi.spyOn(chunkReload, "reload").mockImplementation(() => {});
    failure = named();
    render(<ErrorBoundary inline><Screen /></ErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));     // in place: fails again
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));     // second time: the page
    expect(reload).toHaveBeenCalledTimes(1);
    failure = null;
  });

  it("in place, it comes back once the file arrives", () => {
    const reload = vi.spyOn(chunkReload, "reload").mockImplementation(() => {});
    failure = named();
    render(<ErrorBoundary inline><Screen /></ErrorBoundary>);
    failure = null;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByText("Recycle bin")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads the page straight away when the browser can't fetch it again in place (Safari, a stylesheet)", () => {
    const reload = vi.spyOn(chunkReload, "reload").mockImplementation(() => {});
    for (const e of [new TypeError("Importing a module script failed."), new Error(`Unable to preload CSS for ${window.location.origin}/assets/bin.css`)]) {
      failure = e;
      const r = render(<ErrorBoundary inline><Screen /></ErrorBoundary>);
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      r.unmount();
    }
    expect(reload).toHaveBeenCalledTimes(2);
    failure = null;
  });

  it("an ordinary crash still re-renders in place, never reloading the page", () => {
    const reload = vi.spyOn(chunkReload, "reload").mockImplementation(() => {});
    failure = new TypeError("x is not a function");
    render(<ErrorBoundary inline><Screen /></ErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).not.toHaveBeenCalled();
    failure = null;
  });
});
