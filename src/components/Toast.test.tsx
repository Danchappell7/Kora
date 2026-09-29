import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastProvider, useToast, ACTION_TOAST_MIN_MS } from "./Toast";

type Api = ReturnType<typeof useToast>;
let api: Api;
function Grab() { api = useToast(); return <input aria-label="Title" />; }
const setup = () => render(<ToastProvider><Grab /></ToastProvider>);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Toast", () => {
  it("announces through a polite status region", () => {
    setup();
    act(() => api.success("Saved"));
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("Saved");
  });

  it("keeps legacy action toasts to their fixed lifetime (the caller may commit on its own timer)", () => {
    setup();
    act(() => api.action("Deleted “A”", "Undo", () => {}));
    fireEvent.mouseEnter(screen.getByRole("status"));
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText("Deleted “A”")).not.toBeInTheDocument();
  });

  it("keeps managed Undo toasts up for at least 10s, then commits once", () => {
    setup();
    const onExpire = vi.fn();
    act(() => api.action("Deleted “B”", "Undo", () => {}, { ms: 3000, onExpire }));
    act(() => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS - 1); });
    expect(screen.getByText("Deleted “B”")).toBeInTheDocument();
    expect(onExpire).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText("Deleted “B”")).not.toBeInTheDocument();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("pauses while hovered and resumes with the time that was left", () => {
    setup();
    const onExpire = vi.fn();
    act(() => api.action("Deleted “C”", "Undo", () => {}, { onExpire }));
    act(() => { vi.advanceTimersByTime(4000); });
    fireEvent.mouseEnter(screen.getByRole("status"));
    act(() => { vi.advanceTimersByTime(60000); });
    expect(screen.getByText("Deleted “C”")).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByRole("status"));
    act(() => { vi.advanceTimersByTime(5999); });
    expect(screen.getByText("Deleted “C”")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("pauses while keyboard focus is inside a toast", () => {
    setup();
    act(() => api.action("Deleted “D”", "Undo", () => {}, {}));
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => { undo.focus(); });
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByText("Deleted “D”")).toBeInTheDocument();
  });

  it("runs Undo without committing, and × commits", () => {
    setup();
    const run = vi.fn(); const onExpire = vi.fn();
    act(() => api.action("Deleted “E”", "Undo", run, { onExpire }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onExpire).not.toHaveBeenCalled();

    const onExpire2 = vi.fn();
    act(() => api.action("Deleted “F”", "Undo", () => {}, { onExpire: onExpire2 }));
    fireEvent.click(screen.getByRole("button", { name: /Dismiss: Deleted “F”/ }));
    expect(onExpire2).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(onExpire2).toHaveBeenCalledTimes(1);
  });

  it("⌘Z / Ctrl+Z runs the newest Undo, but not while typing", () => {
    setup();
    const first = vi.fn(); const second = vi.fn();
    act(() => { api.action("One", "Undo", first, {}); api.action("Two", "Undo", second, {}); });
    const input = screen.getByLabelText("Title");
    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    fireEvent.keyDown(input, { key: "z", metaKey: true });
    expect(second).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(first).toHaveBeenCalledTimes(1);
  });
});
