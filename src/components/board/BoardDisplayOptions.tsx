/* ============================================================
   KANBO — the board's display choices, for the page's Display menu
   (TasksPage › Display, under "Columns"): Rows (swimlanes by assignee,
   priority or project — just for you, per board) and "Show project
   covers" (the project's identity cover on cards without an image —
   for everyone on the board; writers only). Styled with the Display
   menu's own sections and chips, so it sits there natively. When the
   page doesn't mount this, the board shows the same choices in its
   own bar.
   ============================================================ */
import { Toggle } from "../primitives";
import { SWIMLANE_OPTIONS, type SwimlaneBy } from "../tasks/otherViewsLogic";

export interface BoardDisplayOptionsProps {
  /** the board's columns ("status" | "priority" | "project" | "assignee"): rows can't repeat them */
  group: string;
  swimlane: SwimlaneBy;
  onSwimlaneChange: (s: SwimlaneBy) => void;
  /** "Show project covers" (a project board's settings); the toggle shows only with onCoversChange */
  covers?: boolean;
  onCoversChange?: (on: boolean) => void;
}

export function BoardDisplayOptions({ group, swimlane, onSwimlaneChange, covers, onCoversChange }: BoardDisplayOptionsProps) {
  return (
    <>
      <div className="ktv-pop-sec" role="group" aria-label="Rows">
        <h4>Rows<small>Just for you</small></h4>
        <div className="ktv-chips">
          {SWIMLANE_OPTIONS.map((o) => {
            const same = o.value !== "none" && o.value === group;
            return (
              <button key={o.value} type="button" className="ktv-chip" aria-pressed={swimlane === o.value && !same} disabled={same}
                title={same ? `The columns are already by ${o.label.toLowerCase()}` : undefined}
                onClick={() => onSwimlaneChange(o.value)}>{o.label}</button>
            );
          })}
        </div>
      </div>
      {onCoversChange && (
        <Toggle checked={!!covers} onChange={onCoversChange} label="Show project covers"
          description="On cards without a cover image, for everyone on this board." />
      )}
    </>
  );
}
