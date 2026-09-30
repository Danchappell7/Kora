/* ============================================================
   KANBO — live clock
   Keeps "today" (KANBO_TODAY) and "now" (NOW_MIN) current in a tab that
   stays open for days — a normal way to use a team tool. Ticks on each
   minute boundary (so the Plan "now" line moves and midnight rolls over
   within a second), and again whenever the tab wakes up (visibility,
   focus, back/forward cache), because timers are paused or throttled
   while a laptop sleeps or the tab is in the background.

   Two audiences, kept apart so the whole app isn't re-rendered every minute:
   - the day: `onDayChange` (main.tsx re-renders the app once) plus the
     window event DAY_CHANGE_EVENT, for per-day state;
   - the minute: `useNowMin()` re-renders only the components that show the
     current time (Plan's now-line and its active block).
   ============================================================ */
import { useSyncExternalStore } from "react";
import { refreshClock, NOW_MIN } from "../data/data";

/* fired on window when the local date changes, for anything that wants to
   reset per-day state (e.g. yesterday's plan blocks) */
export const DAY_CHANGE_EVENT = "kanbo:daychange";

const minuteListeners = new Set<() => void>();

/* Called when the minute of the day moves while the tab is visible (hidden
   tabs are told when they're shown again). Returns an unsubscribe function. */
export function subscribeMinute(fn: () => void): () => void {
  minuteListeners.add(fn);
  return () => { minuteListeners.delete(fn); };
}

const nowMinSnapshot = (): number => NOW_MIN;

/* The live minute of the day (NOW_MIN) as a hook. Only the component that
   calls it re-renders when the minute moves. */
export function useNowMin(): number {
  return useSyncExternalStore(subscribeMinute, nowMinSnapshot, nowMinSnapshot);
}

/**
 * Start the clock. `onDayChange` runs once each time the local date changes
 * (a tab left open overnight, or woken the next morning), whether or not the
 * tab is visible. Minute subscribers are told only when the minute actually
 * moved, so a focus or visibility wake within the same minute costs nothing.
 * Returns a stop function.
 */
export function startLiveClock(onDayChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let lastWake = 0;
  let shownMin = NOW_MIN; // the minute subscribers last rendered

  const run = () => {
    const dayChanged = refreshClock();
    if (dayChanged) {
      try { window.dispatchEvent(new CustomEvent(DAY_CHANGE_EVENT)); } catch { /* old browser — the re-render still happens */ }
      onDayChange();
    }
    if (NOW_MIN !== shownMin && document.visibilityState !== "hidden") {
      shownMin = NOW_MIN;
      [...minuteListeners].forEach((fn) => fn());
    }
  };
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    // just past the next whole minute; re-armed each time so it never drifts
    timer = setTimeout(() => { run(); schedule(); }, 60_000 - (Date.now() % 60_000) + 50);
  };
  const wake = () => {
    if (stopped || document.visibilityState === "hidden") return;
    // focus + visibilitychange usually arrive together — one refresh is enough
    const now = Date.now();
    if (now - lastWake < 1000) return;
    lastWake = now;
    run();
    schedule();
  };

  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("pageshow", wake);
  schedule();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
    window.removeEventListener("pageshow", wake);
  };
}
