import { StrictMode, useEffect } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastProvider, useToast, ACTION_TOAST_MIN_MS, MAX_VISIBLE_TOASTS, TOAST_MS } from "./Toast";
import { clearUndo, hasUndo, pushUndo, undoLast } from "../lib/undoStack";

type Api = ReturnType<typeof useToast>;
let api: Api;
function Grab() { api = useToast(); return <input aria-label="Title" />; }
const setup = () => render(<ToastProvider><Grab /></ToastProvider>);

beforeEach(() => { vi.useFakeTimers(); clearUndo(); });
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
    act(() => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS - 1); });
    expect(screen.getByText("Deleted “A”")).toBeInTheDocument(); // 10s by default, as §2.5 asks of an Undo
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText("Deleted “A”")).not.toBeInTheDocument();
  });

  it("plain notes stay up 5s (errors a little longer)", () => {
    setup();
    act(() => { api.success("Saved"); api.error("Couldn't reach the server"); });
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1); });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.getByText("Couldn't reach the server")).toBeInTheDocument();
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

  it("undoLast() (App's ⌘Z) runs the newest Undo first, then the one before", () => {
    setup();
    const first = vi.fn(); const second = vi.fn();
    act(() => { api.action("One", "Undo", first, {}); api.action("Two", "Undo", second, {}); });
    act(() => { expect(undoLast()).toBe("Two"); });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    act(() => { expect(undoLast()).toBe("One"); });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("adds no ⌘Z handler of its own — App's keyboard handler is the one owner", () => {
    setup();
    const run = vi.fn(); const outside = vi.fn();
    act(() => { api.action("Deleted “Z”", "Undo", run, {}); pushUndo("Applied 4 changes", outside); });
    const ev = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(outside).not.toHaveBeenCalled();
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

  it("undoLast() runs a renewed toast's Undo when it is the newest, even though it keeps its slot", () => {
    setup();
    const older = vi.fn(); const other = vi.fn(); const renewed = vi.fn();
    act(() => { api.action("Archived", "Undo", older, { key: "inbox" }); api.action("Deleted “H”", "Undo", other, {}); });
    act(() => api.action("Archived 2", "Undo", renewed, { key: "inbox" }));
    act(() => { undoLast(); });
    expect(renewed).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(older).not.toHaveBeenCalled();
  });

  it("registers every Undo on the ⌘Z stack while its toast is up; undoLast() runs it once", () => {
    setup();
    const run = vi.fn(); const onExpire = vi.fn();
    act(() => api.action("Moved 3 tasks to Monday", "Undo", run, { onExpire }));
    expect(hasUndo()).toBe(true);
    let label: string | null = null;
    act(() => { label = undoLast(); });
    expect(label).toBe("Moved 3 tasks to Monday");
    expect(run).toHaveBeenCalledTimes(1);
    expect(onExpire).not.toHaveBeenCalled();
    expect(screen.queryByText("Moved 3 tasks to Monday")).not.toBeInTheDocument();
    act(() => { expect(undoLast()).toBeNull(); });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("takes the Undo off the stack when the toast goes (its own Undo, ×, or timing out)", () => {
    setup();
    act(() => api.action("A", "Undo", () => {}, {}));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(hasUndo()).toBe(false);
    act(() => api.action("B", "Undo", () => {}, {}));
    fireEvent.click(screen.getByRole("button", { name: /Dismiss: B/ }));
    expect(hasUndo()).toBe(false);
    act(() => api.action("C", "Undo", () => {}, 3000));
    expect(hasUndo()).toBe(true);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(hasUndo()).toBe(false);
    act(() => api.action("Retry the sync", "Retry", () => {}, {})); // not an Undo
    expect(hasUndo()).toBe(false);
  });

  it(`shows at most ${MAX_VISIBLE_TOASTS} at once; later ones wait their turn and appear as a slot frees`, () => {
    setup();
    act(() => { ["One", "Two", "Three", "Four"].forEach((m) => api.action(m, "Undo", () => {}, {})); });
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(screen.getByText("One")).toBeInTheDocument(); // what's up stays up
    expect(screen.queryByText("Four")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Dismiss: One/ }));
    expect(screen.getByText("Four")).toBeInTheDocument();
  });

  it("a burst of failed saves: every Retry is seen, each for its full time (a waiting toast's clock is stopped)", () => {
    setup();
    const seen = new Map<string, number>(); // message → ms it was on screen
    act(() => { for (let i = 1; i <= 5; i++) api.action(`Couldn't save #${i} — change undone`, "Retry", () => {}, 10000); });
    for (let t = 0; t < 25; t++) {
      screen.queryAllByText(/^Couldn't save #/).forEach((n) => seen.set(n.textContent!, (seen.get(n.textContent!) ?? 0) + 1000));
      act(() => { vi.advanceTimersByTime(1000); });
    }
    expect([...seen.keys()].sort()).toEqual([1, 2, 3, 4, 5].map((i) => `Couldn't save #${i} — change undone`));
    for (const ms of seen.values()) expect(ms).toBe(10000);
    expect(screen.queryByText(/^Couldn't save #/)).not.toBeInTheDocument();
  });

  it("a toast holding keyboard focus is never pushed out by newer ones, and its Undo isn't committed under the user", () => {
    setup();
    const onExpire = vi.fn();
    act(() => api.action("Deleted “Brief”", "Undo", () => {}, { onExpire }));
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => { undo.focus(); });
    act(() => { api.error("Couldn't save — change undone"); api.success("Moved to Monday"); api.toast("Synced"); });
    expect(document.activeElement).toBe(undo);
    expect(screen.getByText("Deleted “Brief”")).toBeInTheDocument();
    expect(screen.queryByText("Synced")).not.toBeInTheDocument(); // waits while the stack is held
    act(() => { vi.advanceTimersByTime(60000); });
    expect(onExpire).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(undo);
    // let go: the waiting note takes the place of the plain one, and the clocks run again
    act(() => { undo.blur(); });
    expect(screen.getByText("Synced")).toBeInTheDocument();
    expect(screen.queryByText("Moved to Monday")).not.toBeInTheDocument();
    expect(screen.getByText("Deleted “Brief”")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("plain notes make way for newer toasts; an Undo or an error never does", () => {
    setup();
    act(() => { api.action("Deleted “A”", "Undo", () => {}, {}); api.error("Couldn't save"); api.success("Saved 1"); });
    act(() => { api.success("Saved 2"); });
    expect(screen.queryByText("Saved 1")).not.toBeInTheDocument();
    expect(screen.getByText("Saved 2")).toBeInTheDocument();
    act(() => { api.action("Deleted “B”", "Undo", () => {}, {}); });
    expect(screen.queryByText("Saved 2")).not.toBeInTheDocument();
    expect(screen.getByText("Deleted “A”")).toBeInTheDocument();
    expect(screen.getByText("Couldn't save")).toBeInTheDocument();
    expect(screen.getByText("Deleted “B”")).toBeInTheDocument();
    // …and with no note left to make way, the next one waits
    act(() => { api.success("Saved 3"); });
    expect(screen.queryByText("Saved 3")).not.toBeInTheDocument();
  });

  it("an Undo waiting for a slot is already on the stack, so undoLast() takes back the newest change first", () => {
    setup();
    const runs: string[] = [];
    act(() => { ["One", "Two", "Three", "Four"].forEach((m) => api.action(m, "Undo", () => runs.push(m), {})); });
    expect(screen.queryByText("Four")).not.toBeInTheDocument();
    act(() => { expect(undoLast()).toBe("Four"); });
    expect(runs).toEqual(["Four"]);
    act(() => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS); });
    expect(screen.queryByText("Four")).not.toBeInTheDocument(); // never shows up after it was undone
  });

  it("never leaves a toast stuck on screen after a StrictMode remount", () => {
    function OnMount() { const t = useToast(); useEffect(() => { t.success("Welcome back"); }, [t]); return null; }
    render(<StrictMode><ToastProvider><OnMount /></ToastProvider></StrictMode>);
    act(() => { vi.advanceTimersByTime(60000); });
    expect(screen.queryByText("Welcome back")).not.toBeInTheDocument();
  });
});
