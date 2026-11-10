/* ============================================================
   KANBO — Settings › Workspace › Project updates (0053): the team's
   update day. Weekly (the default, on Friday), every other week, once
   a month (the last <day>), or never; any project can choose its own
   in its About tab. On the day each project's owner finds a drafted
   update on Today, with up to two gentle follow-ups through their
   notifications (digest and quiet hours respected), and a project
   past it shows "Update missing" to the team's leads. Owners and
   admins change it (set_update_rhythm); before 0053 it says it isn't
   switched on yet.
   ============================================================ */
import { KANBO_TODAY } from "../../data/data";
import type { Workspace } from "../../data/types";
import { Button } from "../primitives";
import { SetGroup, SetNote, SetRow } from "../integrations/settingsBits";
import { parseRhythm, rhythmLabel, rhythmOn, rhythmToSave, weekdayName, workspaceRhythm, type UpdateCadence, type UpdateRhythm } from "../../lib/updateRhythm";
import "./updates.css";

const CADENCES: { value: UpdateCadence; label: string }[] = [
  { value: "weekly", label: "Every week" },
  { value: "fortnightly", label: "Every other week" },
  { value: "monthly", label: "Once a month" },
  { value: "never", label: "No update day" },
];
const DAYS = [1, 2, 3, 4, 5, 6, 7];

export function UpdateRhythmPanel({ workspace, onChange }: {
  workspace: Workspace | undefined;
  /** save the team's update day (null: back to weekly on Friday) */
  onChange: (workspaceId: string, rhythm: UpdateRhythm | null) => void;
}) {
  if (!workspace?.id) return null;
  const wsId = workspace.id;
  if (!rhythmOn()) {
    return (
      <div className="kup-set">
        <SetGroup title="Project updates">
          <SetRow label="Not switched on yet" desc="Once it is, you'll choose the day project updates are due here, and each project's owner gets a draft ready on that day." />
        </SetGroup>
      </div>
    );
  }
  const r = workspaceRhythm(workspace);
  const chosen = !!parseRhythm(workspace.updateRhythm);
  const save = (next: UpdateRhythm) => onChange(wsId, rhythmToSave(next, KANBO_TODAY));
  return (
    <div className="kup-set">
      <SetGroup title="Project updates">
        <SetRow label="Update day" desc={r.cadence === "never" ? "Nobody's reminded. A project can still choose its own day in its About tab." : `${rhythmLabel(r)}. Each project's owner finds a drafted update on Today that day.`}>
          <span className="kup-set-ctl">
            <select className="kset-input" aria-label="How often updates are due" value={r.cadence}
              onChange={(e) => save({ ...r, cadence: e.target.value as UpdateCadence })}>
              {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {r.cadence !== "never" && (
              <select className="kset-input" aria-label="Day of the week" value={r.weekday} onChange={(e) => save({ ...r, weekday: Number(e.target.value) })}>
                {DAYS.map((d) => <option key={d} value={d}>{r.cadence === "monthly" ? `Last ${weekdayName(d)}` : weekdayName(d)}</option>)}
              </select>
            )}
          </span>
        </SetRow>
        {chosen && (
          <SetRow label="Back to the default" desc="Every Friday.">
            <Button size="sm" variant="ghost" onClick={() => onChange(wsId, null)}>Reset</Button>
          </SetRow>
        )}
      </SetGroup>
      <SetNote>Owners get up to two gentle follow-ups on the working days after, through their notifications (their digest and quiet hours apply). After that the project shows "Update missing" to the team. On-hold and archived projects are skipped.</SetNote>
    </div>
  );
}
