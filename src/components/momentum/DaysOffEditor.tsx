/* ============================================================
   KANBO — your days off: a streak never breaks over them.       [u10]
   A date field + Add, and the days off from today on as chips you can
   remove. Days in the past month can be added too ("I was off ill
   on Tuesday"), so a streak picks up where it was. Saved through
   onChange (the host: onboarding.momentum.daysOff).
   ============================================================ */
import { useId, useState } from "react";
import type { MomentumPrefs } from "../../data/types";
import { Button, Icon } from "../primitives";
import { addDaysISO, dayLabel, dayOffReason, localMoment, tidyDaysOff } from "../../lib/momentum";
import "./momentum.css";

/** How far back a day off can be added, and how far ahead. */
export const DAYS_OFF_BACK = 31, DAYS_OFF_AHEAD = 366;
const SHOWN = 8;

export function DaysOffEditor({ prefs, onChange, now, timezone, disabled, compact }: {
  prefs?: MomentumPrefs | null;
  onChange: (next: MomentumPrefs) => void;
  now?: Date;
  timezone?: string;
  disabled?: boolean;
  /** the chip's popover: no heading line */
  compact?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const today = localMoment(now ?? new Date(), timezone).date;
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState("");
  const all = tidyDaysOff(prefs?.daysOff, today);
  const upcoming = all.filter((d) => d >= addDaysISO(today, -DAYS_OFF_BACK));
  const min = addDaysISO(today, -DAYS_OFF_BACK), max = addDaysISO(today, DAYS_OFF_AHEAD);

  const save = (daysOff: string[]) => onChange({ ...(prefs ?? {}), daysOff });
  const add = () => {
    const d = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { setProblem("Choose a date."); return; }
    if (d < min || d > max) { setProblem("Choose a day within the last month or the next year."); return; }
    const why = dayOffReason(d);
    if (why === "weekend") { setProblem("That's a weekend: it never counts against you."); return; }
    if (why === "bank_holiday") { setProblem("That's a bank holiday: it never counts against you."); return; }
    if (all.includes(d)) { setProblem("That day is already off."); return; }
    setProblem("");
    setValue("");
    save([...all, d].sort());
  };
  const remove = (d: string) => save(all.filter((x) => x !== d));

  return (
    <div className="kdaysoff">
      <div className="kdaysoff-add">
        <div className="kdaysoff-field">
          <label htmlFor={`${uid}-d`}>{compact ? "Add a day off" : "Days off"}</label>
          <input id={`${uid}-d`} className="kdaysoff-input" type="date" min={min} max={max} value={value} disabled={disabled}
            aria-describedby={problem ? `${uid}-err` : undefined} aria-invalid={problem ? true : undefined}
            onChange={(e) => { setValue(e.target.value); setProblem(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        </div>
        <Button size="sm" variant="secondary" icon="plus" onClick={add} disabled={disabled || !value}>Add</Button>
      </div>
      {problem && <p id={`${uid}-err`} className="kdaysoff-err" role="alert">{problem}</p>}
      {upcoming.length > 0 ? (
        <ul className="kdaysoff-list" aria-label="Your days off">
          {upcoming.slice(0, SHOWN).map((d) => (
            <li key={d} className="kdaysoff-chip">
              <span>{d === today ? "Today" : dayLabel(d)}</span>
              <button type="button" aria-label={`Remove ${dayLabel(d)} from your days off`} disabled={disabled} onClick={() => remove(d)}>
                <Icon name="x" size={12} sw={2} />
              </button>
            </li>
          ))}
          {upcoming.length > SHOWN && <li className="kdaysoff-none">and {upcoming.length - SHOWN} more</li>}
        </ul>
      ) : !compact ? <p className="kdaysoff-none">No days off marked. Weekends and bank holidays never count against you.</p> : null}
    </div>
  );
}
