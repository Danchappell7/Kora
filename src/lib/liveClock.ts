/* ============================================================
   KANBO — live clock
   Keeps "today" (KANBO_TODAY) and "now" (NOW_MIN) current in a tab that
   stays open for days — a normal way to use a team tool. Ticks on each
   minute boundary (so the Plan "now" line moves and midnight rolls over
   within a second), and again whenever the tab wakes up (visibility,
   focus, back/forward cache), because timers are paused or throttled
   while a laptop sleeps or the tab is in the background.
   ============================================================ */
import { refreshClock } from "../data/data";

/* fired on window when the local date changes, for anything that wants to
   reset per-day state (e.g. yesterday's plan blocks) */
export const DAY_CHANGE_EVENT = "kanbo:daychange";

/**
 * Start the clock. `onTick` runs after each refresh while the page is
 * visible (hidden tabs skip the work and catch up when they're shown), and
 * always when the day has changed. Returns a stop function.
 */
export function startLiveClock(onTick: (dayChanged: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let lastWake = 0;

  const run = () => {
    const dayChanged = refreshClock();
    if (dayChanged) {
      try { window.dispatchEvent(new CustomEvent(DAY_CHANGE_EVENT)); } catch { /* old browser — the re-render still happens */ }
    }
    if (dayChanged || document.visibilityState !== "hidden") onTick(dayChanged);
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
