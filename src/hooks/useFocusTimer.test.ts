import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { advanceSession, elapsedMs, freshSession, restState, useFocusTimer, WORK_DEFAULT, BREAK_MIN, todayKey } from "./useFocusTimer";
import type { FocusSession } from "./useFocusTimer";

const MIN = 60_000;
const T0 = new Date(2026, 8, 30, 10, 0, 0).getTime();
const running = (o: Partial<FocusSession>): FocusSession => ({ ...freshSession(), running: true, startedAt: T0, ...o });

describe("advanceSession (wall-clock timer)", () => {
  it("measures elapsed time from timestamps, not ticks", () => {
    const s = running({ accMs: 5 * MIN });
    expect(elapsedMs(s, T0 + 10 * MIN)).toBe(15 * MIN);
    expect(elapsedMs({ ...s, running: false, startedAt: null }, T0 + 99 * MIN)).toBe(5 * MIN);
  });

  it("does nothing before the target", () => {
    const r = advanceSession(running({ targetMin: 50 }), T0 + 49 * MIN);
    expect(r.events).toEqual([]);
    expect(r.session.running).toBe(true);
  });

  it("flow mode: completes the block at the goal and banks exactly the goal, however long the tab slept", () => {
    const r = advanceSession(running({ targetMin: 90 }), T0 + 15 * 60 * MIN);
    expect(r.events).toEqual(["goal"]);
    expect(r.bankedMin).toBe(90);
    expect(r.bankedAt).toBe(T0 + 90 * MIN);
    expect(r.session.running).toBe(false);
    expect(elapsedMs(r.session, T0 + 15 * 60 * MIN)).toBe(0);
  });

  it("pomodoro: switches to the break by wall time, starting when the focus interval ended", () => {
    const r = advanceSession(running({ pomodoro: true, targetMin: WORK_DEFAULT }), T0 + 27 * MIN);
    expect(r.events).toEqual(["break"]);
    expect(r.bankedMin).toBe(WORK_DEFAULT);
    expect(r.bankedCycles).toBe(1);
    expect(r.session.phase).toBe("break");
    expect(r.session.targetMin).toBe(BREAK_MIN);
    // two minutes of the break have already gone
    expect(elapsedMs(r.session, T0 + 27 * MIN)).toBe(2 * MIN);
  });

  it("pomodoro: a long absence banks one interval, ends the break and waits — no phantom cycles", () => {
    const r = advanceSession(running({ pomodoro: true, targetMin: WORK_DEFAULT }), T0 + 5 * 60 * MIN);
    expect(r.events).toEqual(["break", "breakOver"]);
    expect(r.bankedCycles).toBe(1);
    expect(r.bankedMin).toBe(WORK_DEFAULT);
    expect(r.session).toMatchObject({ phase: "work", targetMin: WORK_DEFAULT, running: false, accMs: 0 });
  });

  it("never banks break time", () => {
    const r = advanceSession(running({ pomodoro: true, phase: "break", targetMin: BREAK_MIN }), T0 + 6 * MIN);
    expect(r.events).toEqual(["breakOver"]);
    expect(r.bankedMin).toBe(0);
  });

  it("leaving a break restores a full focus interval", () => {
    const s = restState(running({ pomodoro: true, phase: "break", targetMin: BREAK_MIN, accMs: 3 * MIN }));
    expect(s).toMatchObject({ phase: "work", targetMin: WORK_DEFAULT, running: false, accMs: 0, startedAt: null });
  });
});

describe("useFocusTimer", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps real time while the tab is hidden and throttled", () => {
    const { result } = renderHook(() => useFocusTimer());
    act(() => { result.current.setRunning(true); });
    // the tab is throttled: 10 minutes pass with no interval ticks
    vi.setSystemTime(T0 + 10 * MIN);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.seconds).toBe(600);
  });

  it("banks the elapsed focus time on End, and survives a reload mid-session", () => {
    const first = renderHook(() => useFocusTimer());
    act(() => { first.result.current.setRunning(true); });
    vi.setSystemTime(T0 + 12 * MIN);
    first.unmount();
    // a reload restores the running session from storage
    const { result } = renderHook(() => useFocusTimer());
    expect(result.current.running).toBe(true);
    expect(result.current.seconds).toBe(720);
    let banked = 0;
    act(() => { banked = result.current.endSession(); });
    expect(banked).toBe(12);
    expect(result.current.focusMinToday).toBe(12);
    expect(result.current.seconds).toBe(0);
  });

  it("End during a break banks nothing and the next focus is a full interval", () => {
    const { result } = renderHook(() => useFocusTimer());
    act(() => { result.current.setPomodoro(true); });
    act(() => { result.current.setRunning(true); });
    vi.setSystemTime(T0 + 26 * MIN); // 25m focus done, 1m into the break
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.phase).toBe("break");
    expect(result.current.cyclesToday).toBe(1);
    expect(result.current.focusMinToday).toBe(WORK_DEFAULT);
    let banked = -1;
    act(() => { banked = result.current.endSession(); });
    expect(banked).toBe(0);
    expect(result.current.focusMinToday).toBe(WORK_DEFAULT);
    expect(result.current.phase).toBe("work");
    expect(result.current.targetMin).toBe(WORK_DEFAULT);
  });

  it("Reset during a break restores the focus length", () => {
    const { result } = renderHook(() => useFocusTimer());
    act(() => { result.current.setPomodoro(true); result.current.setRunning(true); });
    vi.setSystemTime(T0 + 25 * MIN + 30_000);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.targetMin).toBe(BREAK_MIN);
    act(() => { result.current.reset(); });
    expect(result.current.phase).toBe("work");
    expect(result.current.targetMin).toBe(WORK_DEFAULT);
  });

  it("badges the tab title when a block completes", () => {
    document.title = "Kanbo";
    const { result } = renderHook(() => useFocusTimer());
    act(() => { result.current.setTargetMin(25); result.current.setRunning(true); });
    vi.setSystemTime(T0 + 25 * MIN + 1000);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(document.title).toBe("(Done) Kanbo");
    expect(result.current.notice?.kind).toBe("goal");
    expect(result.current.focusMinToday).toBe(25);
    act(() => { result.current.setRunning(true); });
    expect(document.title).toBe("Kanbo");
  });

  it("a block that finished before midnight doesn't count towards today", () => {
    const late = new Date(2026, 8, 29, 23, 30).getTime();
    vi.setSystemTime(late);
    const { result } = renderHook(() => useFocusTimer());
    act(() => { result.current.setTargetMin(25); result.current.setRunning(true); });
    vi.setSystemTime(late + 60 * MIN); // it ended at 23:55; noticed at 00:30
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.running).toBe(false);
    expect(result.current.focusMinToday).toBe(0);
    expect(JSON.parse(localStorage.getItem("kanbo-focus-stat") || "{}").date ?? todayKey()).toBe(todayKey());
  });
});

describe("useFocusTimer — stale boundaries", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it("resets quietly when a block ended long ago (closed tab / sleeping laptop)", () => {
    document.title = "Kanbo";
    const first = renderHook(() => useFocusTimer());
    act(() => { first.result.current.setTargetMin(25); first.result.current.setRunning(true); });
    first.unmount();
    vi.setSystemTime(T0 + 3 * 60 * MIN); // reopened three hours later, same day
    const { result } = renderHook(() => useFocusTimer());
    expect(result.current.running).toBe(false);
    expect(result.current.focusMinToday).toBe(25); // the block still counts for today
    expect(result.current.notice).toBeNull();     // …but no stale "complete" alert
    expect(document.title).toBe("Kanbo");
  });
});
