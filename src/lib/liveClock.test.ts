import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { startLiveClock, DAY_CHANGE_EVENT } from "./liveClock";
import { refreshClock, todayISO, NOW_MIN, dayOffset } from "../data/data";

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

describe("startLiveClock", () => {
  let stop: (() => void) | null = null;
  beforeEach(() => { visibility = "visible"; vi.useFakeTimers(); });
  afterEach(() => {
    stop?.(); stop = null;
    vi.useRealTimers();
    refreshClock(); // back to the real wall clock for other suites
  });

  it("ticks on the minute and keeps NOW_MIN live", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 14, 0, 20));
    refreshClock();
    const onTick = vi.fn();
    stop = startLiveClock(onTick);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40_000); // 14:01:00 (+50ms grace not yet)
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenLastCalledWith(false);
    expect(NOW_MIN).toBe(14 * 60 + 1);
    vi.advanceTimersByTime(60_000);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(NOW_MIN).toBe(14 * 60 + 2);
  });

  it("rolls a tab left open overnight into the new day", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 30));
    refreshClock();
    expect(todayISO()).toBe("2026-09-30");
    const onTick = vi.fn();
    const onDay = vi.fn();
    window.addEventListener(DAY_CHANGE_EVENT, onDay);
    stop = startLiveClock(onTick);
    vi.advanceTimersByTime(31_000);
    expect(onTick).toHaveBeenLastCalledWith(true);
    expect(onDay).toHaveBeenCalledTimes(1);
    expect(todayISO()).toBe("2026-10-01");
    expect(dayOffset(1)).toBe("2026-10-02");
    window.removeEventListener(DAY_CHANGE_EVENT, onDay);
  });

  it("skips re-rendering hidden tabs but still catches the day change", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 23, 58, 10));
    refreshClock();
    visibility = "hidden";
    const onTick = vi.fn();
    stop = startLiveClock(onTick);
    vi.advanceTimersByTime(60_000); // 23:59 — hidden, same day
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000); // 00:00 — new day
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenLastCalledWith(true);
  });

  it("refreshes when the tab wakes, once per wake", () => {
    // laptop lid closed on Monday evening, opened Tuesday morning: timers
    // didn't run while asleep, the wake events do
    vi.setSystemTime(new Date(2026, 8, 28, 18, 0, 0));
    refreshClock();
    const onTick = vi.fn();
    stop = startLiveClock(onTick);
    vi.setSystemTime(new Date(2026, 8, 29, 8, 30, 5));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus")); // arrives alongside — deduped
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenLastCalledWith(true);
    expect(todayISO()).toBe("2026-09-29");
    expect(NOW_MIN).toBe(8 * 60 + 30);
    // a hidden → visible later on refreshes again
    vi.advanceTimersByTime(5_000);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onTick).toHaveBeenCalledTimes(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("stops cleanly", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 9, 0, 0));
    const onTick = vi.fn();
    const s = startLiveClock(onTick);
    s();
    vi.advanceTimersByTime(5 * 60_000);
    window.dispatchEvent(new Event("focus"));
    expect(onTick).not.toHaveBeenCalled();
  });
});
