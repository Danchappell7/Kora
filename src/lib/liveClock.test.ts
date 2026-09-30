import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { startLiveClock, subscribeMinute, useNowMin, DAY_CHANGE_EVENT } from "./liveClock";
import { refreshClock, todayISO, NOW_MIN, dayOffset } from "../data/data";

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

describe("startLiveClock", () => {
  let stop: (() => void) | null = null;
  let unsub: (() => void) | null = null;
  beforeEach(() => { visibility = "visible"; vi.useFakeTimers(); });
  afterEach(() => {
    stop?.(); stop = null;
    unsub?.(); unsub = null;
    cleanup();
    vi.useRealTimers();
    refreshClock(); // back to the real wall clock for other suites
  });

  it("ticks on the minute for minute subscribers only — the app isn't re-rendered", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 14, 0, 20));
    refreshClock();
    const onDay = vi.fn();
    const onMinute = vi.fn();
    unsub = subscribeMinute(onMinute);
    stop = startLiveClock(onDay);
    expect(onMinute).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40_000); // 14:01:00 (+50ms grace not yet)
    expect(onMinute).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onMinute).toHaveBeenCalledTimes(1);
    expect(NOW_MIN).toBe(14 * 60 + 1);
    vi.advanceTimersByTime(60_000);
    expect(onMinute).toHaveBeenCalledTimes(2);
    expect(NOW_MIN).toBe(14 * 60 + 2);
    expect(onDay).not.toHaveBeenCalled();
  });

  it("rolls a tab left open overnight into the new day, once", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 30));
    refreshClock();
    expect(todayISO()).toBe("2026-09-30");
    const onDay = vi.fn();
    const onEvent = vi.fn();
    window.addEventListener(DAY_CHANGE_EVENT, onEvent);
    stop = startLiveClock(onDay);
    vi.advanceTimersByTime(31_000);
    expect(onDay).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(todayISO()).toBe("2026-10-01");
    expect(dayOffset(1)).toBe("2026-10-02");
    vi.advanceTimersByTime(10 * 60_000); // the rest of the night: no more day changes
    expect(onDay).toHaveBeenCalledTimes(1);
    window.removeEventListener(DAY_CHANGE_EVENT, onEvent);
  });

  it("holds minute updates for hidden tabs but still catches the day change", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 23, 58, 10));
    refreshClock();
    visibility = "hidden";
    const onDay = vi.fn();
    const onMinute = vi.fn();
    unsub = subscribeMinute(onMinute);
    stop = startLiveClock(onDay);
    vi.advanceTimersByTime(60_000); // 23:59 — hidden, same day
    expect(onMinute).not.toHaveBeenCalled();
    expect(onDay).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000); // 00:00 — new day
    expect(onDay).toHaveBeenCalledTimes(1);
    expect(onMinute).not.toHaveBeenCalled();
    // shown again: the minute catches up once
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onMinute).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the tab wakes, once per wake, and only if the clock moved", () => {
    // laptop lid closed on Monday evening, opened Tuesday morning: timers
    // didn't run while asleep, the wake events do
    vi.setSystemTime(new Date(2026, 8, 28, 18, 0, 0));
    refreshClock();
    const onDay = vi.fn();
    const onMinute = vi.fn();
    unsub = subscribeMinute(onMinute);
    stop = startLiveClock(onDay);
    vi.setSystemTime(new Date(2026, 8, 29, 8, 30, 5));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus")); // arrives alongside — deduped
    expect(onDay).toHaveBeenCalledTimes(1);
    expect(onMinute).toHaveBeenCalledTimes(1);
    expect(todayISO()).toBe("2026-09-29");
    expect(NOW_MIN).toBe(8 * 60 + 30);
    // alt-tabbing within the same minute costs nothing
    vi.advanceTimersByTime(5_000);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(2_000);
    window.dispatchEvent(new Event("focus"));
    expect(onMinute).toHaveBeenCalledTimes(1);
    expect(onDay).toHaveBeenCalledTimes(1);
  });

  it("useNowMin re-renders only the component that shows the time", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 9, 59, 0));
    refreshClock();
    let parentRenders = 0;
    let clockRenders = 0;
    const Clock = () => { clockRenders++; return createElement("span", { "data-testid": "now" }, String(useNowMin())); };
    const Parent = () => { parentRenders++; return createElement("div", null, createElement(Clock)); };
    const { getByTestId } = render(createElement(Parent));
    stop = startLiveClock(() => {});
    const p0 = parentRenders, c0 = clockRenders;
    expect(getByTestId("now").textContent).toBe(String(9 * 60 + 59));
    act(() => { vi.advanceTimersByTime(60_100); });
    expect(getByTestId("now").textContent).toBe(String(10 * 60));
    expect(clockRenders).toBeGreaterThan(c0);
    expect(parentRenders).toBe(p0);
  });

  it("stops cleanly", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 23, 58, 0));
    refreshClock();
    const onDay = vi.fn();
    const onMinute = vi.fn();
    unsub = subscribeMinute(onMinute);
    const s = startLiveClock(onDay);
    s();
    vi.advanceTimersByTime(5 * 60_000);
    window.dispatchEvent(new Event("focus"));
    expect(onDay).not.toHaveBeenCalled();
    expect(onMinute).not.toHaveBeenCalled();
  });
});
