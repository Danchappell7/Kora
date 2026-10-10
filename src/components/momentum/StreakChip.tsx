/* ============================================================
   KANBO — the streak chip by Today's header.                    [u10]
   "4-day streak" with the five-dot week (no flame). Its popover explains
   it kindly (working days you planned or finished something; days off
   and bank holidays don't count against you), shows this week, and has
   "Take today off", other days off, and "Hide the streak". Nothing at
   0 days or when hidden. Never red, never "you missed a day".
   Mount (integrator): Today's PageHeader titleAddon, through the lazy
   TodayStreak (components/momentum/TodayMomentum), which works the
   streak out from the tasks and the days you planned.
   ============================================================ */
import { useRef, useState } from "react";
import type { MomentumPrefs, StreakInfo } from "../../data/types";
import { Button } from "../primitives";
import { Popover } from "../primitives/Popover";
import { dayLabel, dayOffReason, isBankHoliday, isoWeekday, localMoment, streakLabel, streakWeek, tidyDaysOff, type StreakDay } from "../../lib/momentum";
import { DaysOffEditor } from "./DaysOffEditor";
import { trapTab, WeekDots } from "./shared";
import { useOptionalToast } from "../rituals/shared";
import "./momentum.css";

export interface StreakChipProps {
  streak: StreakInfo;
  prefs?: MomentumPrefs | null;
  /** saves onboarding.momentum (hide, days off) */
  onChangePrefs?: (next: MomentumPrefs) => void;
  /** (optional) the moment it is (tests pin it); default: now */
  now?: Date;
  /** (optional) the person's timezone; default Europe/London */
  timezone?: string;
  /** (optional) the days that counted (lib/momentum activeDaysFor), so this week's strip is exact */
  active?: readonly string[];
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DAY_LETTERS = ["M", "T", "W", "T", "F"];

function dayWords(d: StreakDay, isToday: boolean): string {
  if (d.state === "off") return d.offReason === "bank_holiday" ? "bank holiday" : "day off";
  if (d.state === "future") return d.offReason ? (d.offReason === "bank_holiday" ? "bank holiday" : "day off") : "still to come";
  if (d.state === "done") return isToday ? "today, counted" : "counted";
  if (d.state === "pending") return "today, still open";
  return "not counted";
}

function todayLine(streak: StreakInfo, today: string, prefs?: MomentumPrefs | null): string {
  if (streak.today === "done") return "Today already counts.";
  if (streak.today === "pending") return "Plan your day or finish something and today counts too.";
  const why = dayOffReason(today, prefs);
  return why === "weekend" ? "It's the weekend: enjoy it. Your streak waits for Monday."
    : why === "bank_holiday" ? "It's a bank holiday: your streak waits for you."
    : "Today's a day off: your streak waits for you.";
}

export function StreakChip({ streak, prefs, onChangePrefs, now, timezone, active }: StreakChipProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const toast = useOptionalToast();
  if (prefs?.streakHidden || !(streak.days > 0)) return null;

  const at = now ?? new Date();
  const today = localMoment(at, timezone).date;
  const week = streakWeek(streak, at, timezone, prefs, active);
  const label = streakLabel(streak.days);
  const state = streak.today === "done" ? "today counts" : streak.today === "pending" ? "today still open" : "today's a day off";
  const weekday = isoWeekday(today) <= 5 && !isBankHoliday(today);
  const todayOff = (prefs?.daysOff ?? []).includes(today);

  const change = (next: MomentumPrefs) => onChangePrefs?.(next);
  const toggleToday = () => {
    const list = tidyDaysOff(prefs?.daysOff, today);
    change({ ...(prefs ?? {}), daysOff: todayOff ? list.filter((d) => d !== today) : [...list, today].sort() });
  };
  const hide = () => {
    setOpen(false);
    change({ ...(prefs ?? {}), streakHidden: true });
    toast?.success("Streak hidden. You can show it again in Settings.");
  };

  return (
    <>
      <button ref={btnRef} type="button" className="kstreak" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${label}, ${state}`} title="Working days in a row you planned your day or finished something"
        onClick={() => setOpen((o) => !o)}>
        <WeekDots days={week} />
        <span className="kstreak-n">{label}</span>
      </button>
      <Popover open={open} anchorRef={btnRef} onClose={() => setOpen(false)} role="dialog" label="Your streak" minWidth={280}>
        <div ref={boxRef} className="kstreak-pop" onKeyDown={(e) => trapTab(e, boxRef.current)}>
          <h2>{streak.days} working {streak.days === 1 ? "day" : "days"} in a row</h2>
          <ol className="kstreak-week" aria-label="This week">
            {week.map((d, i) => (
              <li key={d.date} className="kstreak-day" data-today={d.date === today ? "" : undefined}>
                <span className="kstreak-day-name" aria-hidden="true">{DAY_LETTERS[i]}</span>
                <span className="kweek-dot" aria-hidden="true" data-state={d.state === "missed" ? undefined : d.state} />
                <span className="sr-only">{DAY_NAMES[i]} {dayLabel(d.date).split(" ").slice(1).join(" ")}: {dayWords(d, d.date === today)}</span>
              </li>
            ))}
          </ol>
          <p className="kstreak-p">Working days you plan your day or finish something. Weekends, bank holidays and days you take off never break it.</p>
          <p className="kstreak-today">{todayLine(streak, today, prefs)}</p>
          {onChangePrefs && (
            <>
              <DaysOffEditor prefs={prefs} onChange={change} now={at} timezone={timezone} compact />
              <div className="kstreak-acts">
                {weekday && <Button size="sm" variant="secondary" onClick={toggleToday}>{todayOff ? "Count today after all" : "Take today off"}</Button>}
                <Button size="sm" variant="ghost" className="kstreak-hide" onClick={hide}>Hide the streak</Button>
              </div>
            </>
          )}
        </div>
      </Popover>
    </>
  );
}
