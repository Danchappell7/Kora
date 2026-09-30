import { StrictMode, useEffect } from "react";
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

  it("commits pending Undo toasts when the page is closed or reloaded", () => {
    setup();
    const onExpire = vi.fn(); const legacy = vi.fn();
    act(() => { api.action("Deleted “G”", "Undo", () => {}, { onExpire }); api.action("Archived", "Undo", legacy); });
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Deleted “G”")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(20000); });
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("flush() commits every pending Undo toast at once", () => {
    setup();
    const a = vi.fn(); const b = vi.fn();
    act(() => { api.action("A", "Undo", () => {}, { onExpire: a }); api.action("B", "Undo", () => {}, { onExpire: b }); });
    act(() => api.flush());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("a toast with the same key takes the earlier one's place, with a fresh clock", () => {
    setup();
    const first = vi.fn(); const second = vi.fn(); const expire1 = vi.fn(); const expire2 = vi.fn();
    act(() => api.action("Notification archived", "Undo", first, { key: "inbox", onExpire: expire1 }));
    act(() => { vi.advanceTimersByTime(8000); });
    act(() => api.action("Archived 2 notifications", "Undo", second, { key: "inbox", onExpire: expire2 }));
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    expect(screen.queryByText("Notification archived")).not.toBeInTheDocument();
    expect(expire1).toHaveBeenCalledTimes(1); // the replaced one ends as if dismissed
    act(() => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS - 1); });
    expect(screen.getByText("Archived 2 notifications")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(expire2).not.toHaveBeenCalled();
    // other keys (and toasts without one) still stack
    act(() => { api.action("A", "Undo", () => {}, { key: "a" }); api.action("B", "Undo", () => {}, { key: "b" }); api.action("C", "Undo", () => {}, {}); });
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(3);
  });

  it("⌘Z runs a renewed toast's Undo when it is the newest, even though it keeps its slot", () => {
    setup();
    const older = vi.fn(); const other = vi.fn(); const renewed = vi.fn();
    act(() => { api.action("Archived", "Undo", older, { key: "inbox" }); api.action("Deleted “H”", "Undo", other, {}); });
    act(() => api.action("Archived 2", "Undo", renewed, { key: "inbox" }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(renewed).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(older).not.toHaveBeenCalled();
  });

  it("never leaves a toast stuck on screen after a StrictMode remount", () => {
    function OnMount() { const t = useToast(); useEffect(() => { t.success("Welcome back"); }, [t]); return null; }
    render(<StrictMode><ToastProvider><OnMount /></ToastProvider></StrictMode>);
    act(() => { vi.advanceTimersByTime(60000); });
    expect(screen.queryByText("Welcome back")).not.toBeInTheDocument();
  });
});
