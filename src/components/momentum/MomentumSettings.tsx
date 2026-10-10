/* ============================================================
   KANBO — Settings › the gentle nudges: "Show my streak on Today",
   "Show my week's wins", and your days off.                     [u10]
   Rows in SettingsModal's own recipe (kset-row + the kit's Toggle), so
   they sit in any Settings group. Saved through onChange (the host:
   onboarding.momentum via saveOnboarding / merge_onboarding).
   ============================================================ */
import type { MomentumPrefs } from "../../data/types";
import { Toggle } from "../primitives";
import { DaysOffEditor } from "./DaysOffEditor";
import "./momentum.css";

export function MomentumSettings({ prefs, onChange, disabled, now, timezone }: {
  prefs?: MomentumPrefs | null;
  onChange: (next: MomentumPrefs) => void;
  disabled?: boolean;
  now?: Date;
  timezone?: string;
}) {
  const p = prefs ?? {};
  return (
    <>
      <div className="kset-row">
        <Toggle checked={!p.streakHidden} disabled={disabled} onChange={(v) => onChange({ ...p, streakHidden: !v })}
          label="Show my streak on Today"
          description="The working days in a row you planned your day or finished something. Weekends, bank holidays and your days off never break it." />
      </div>
      <div className="kset-row">
        <Toggle checked={!p.recapHidden} disabled={disabled} onChange={(v) => onChange({ ...p, recapHidden: !v })}
          label="Show my week's wins"
          description="On Friday afternoons and Monday mornings: what you finished, your focus time and the moments with your team." />
      </div>
      <div className="kset-row" data-momentum-daysoff="">
        <DaysOffEditor prefs={p} onChange={onChange} disabled={disabled} now={now} timezone={timezone} />
      </div>
    </>
  );
}
