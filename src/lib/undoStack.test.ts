import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pushUndo, undoLast, hasUndo, clearUndo, UNDO_TTL_MS } from "./undoStack";

beforeEach(() => clearUndo());
afterEach(() => vi.useRealTimers());

describe("undoStack", () => {
  it("runs the newest live entry once and returns its label", () => {
    const first = vi.fn(), second = vi.fn();
    pushUndo("Moved 3 tasks", first);
    pushUndo("Completed “Draft deck”", second);
    expect(hasUndo()).toBe(true);
    expect(undoLast()).toBe("Completed “Draft deck”");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(undoLast()).toBe("Moved 3 tasks");
    expect(first).toHaveBeenCalledTimes(1);
    expect(undoLast()).toBeNull();
    expect(hasUndo()).toBe(false);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("lets the pusher take an entry back (its toast's own Undo ran it, or it was committed)", () => {
    const run = vi.fn();
    const remove = pushUndo("Archived", run);
    remove();
    remove(); // safe twice
    expect(hasUndo()).toBe(false);
    expect(undoLast()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("forgets entries after their window (10s by default)", () => {
    vi.useFakeTimers();
    const old = vi.fn(), fresh = vi.fn();
    pushUndo("Old", old);
    vi.advanceTimersByTime(UNDO_TTL_MS - 1000);
    pushUndo("Short", fresh, 500);
    vi.advanceTimersByTime(600);
    expect(hasUndo()).toBe(true);           // "Old" still has ~400ms
    vi.advanceTimersByTime(500);
    expect(hasUndo()).toBe(false);
    expect(undoLast()).toBeNull();
    expect(old).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
  });

  it("still pops an entry whose undo throws, so ⌘Z can't get stuck on it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    pushUndo("Fine", () => {});
    pushUndo("Broken", () => { throw new Error("offline"); });
    expect(undoLast()).toBe("Broken");
    expect(undoLast()).toBe("Fine");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
