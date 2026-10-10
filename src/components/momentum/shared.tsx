/* ============================================================
   KANBO — momentum's small shared pieces: the five-dot week glyph
   (the streak's mark: no flame), a minute clock for "now", and how a
   person's id becomes a name.                                    [u10]
   ============================================================ */
import { useEffect, useState } from "react";
import { getMember } from "../../data/data";
import type { StreakDay } from "../../lib/momentum";

/** Monday to Friday as five dots: counted (filled), today still open (ring), off (a dash), to come (hairline). Decorative. */
export function WeekDots({ days, size = "sm" }: { days: readonly Pick<StreakDay, "state">[]; size?: "sm" | "md" }) {
  return (
    <span className="kweek" data-size={size} aria-hidden="true">
      {days.map((d, i) => <span key={i} className="kweek-dot" data-state={d.state === "missed" ? undefined : d.state} />)}
    </span>
  );
}

/** "now", moving on every minute (or the pinned `now` when one is given). */
export function useMinuteClock(now?: Date): Date {
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    if (now) return;
    const id = window.setInterval(() => setTick(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [now]);
  return now ?? tick;
}

/** A person's name from the people given (workspace members), then the app's directory. */
export function nameFrom(people: readonly { id?: string; userId?: string | null; name?: string; email?: string }[] | undefined, id: string): string {
  const p = people?.find((m) => (m.id === id || m.userId === id));
  return p?.name?.trim() || getMember(id)?.name || p?.email || "Someone";
}

export const firstWord = (name: string) => { const n = (name || "").trim(); return n.includes("@") ? n : n.split(/\s+/)[0] || "your teammate"; };

/** The kit's reduced-motion check (no animation when someone has asked for less). */
export const reducedMotion = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Keep Tab inside a popover dialog (the kit's Popover traps it for menus only). */
export function trapTab(e: { key: string; shiftKey: boolean; preventDefault: () => void }, box: HTMLElement | null): void {
  if (e.key !== "Tab" || !box) return;
  const els = Array.from(box.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])"))
    .filter((el) => el.tabIndex !== -1);
  if (!els.length) return;
  const first = els[0], last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
