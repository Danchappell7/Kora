/* ============================================================
   KANBO — a project's update day, in its About tab (0053), and what
   an update's plan to recover said, in its history.
   · UpdateDayField: the team's day, or the project's own (every
     week, every other week, once a month on the last <day>, or
     never), and where this round's update stands. Whoever runs the
     project (its owner, the workspace's owners and admins) changes
     it; everyone else reads it. Hidden in Personal, and before 0053.
   · UpdatePlanNote: an At risk or Off track update's plan to recover
     and new target date, under its words.
   ============================================================ */
import { useMemo } from "react";
import { KANBO_TODAY, todayISO } from "../../data/data";
import type { Project, StatusUpdate, Task } from "../../data/types";
import { fmtShortDay } from "../../lib/statusDraft";
import {
  dueDayWords, parseRhythm, projectRhythmState, rhythmLabel, rhythmOn, rhythmToSave, weekdayName, workspaceOf, workspaceRhythm,
  type RhythmState, type UpdateCadence,
} from "../../lib/updateRhythm";
import "./updates.css";

const CADENCE_OPTIONS: { value: UpdateCadence; label: string }[] = [
  { value: "weekly", label: "Every week" },
  { value: "fortnightly", label: "Every other week" },
  { value: "monthly", label: "Once a month (the last of the month)" },
  { value: "never", label: "Never" },
];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
/** "Every Tuesday" → "every Tuesday" (inside a sentence) */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Where this round's update stands, in a few words (and whether it's worth a warning). */
export function rhythmStateLine(s: RhythmState, today: string): { text: string; warn?: boolean } {
  switch (s.kind) {
    case "off": return { text: s.why === "paused" ? "No reminders while it's on hold or archived" : s.why === "empty" ? "Reminders start once it has tasks" : "No reminders" };
    case "ok": return { text: s.next ? `Next update due ${dueDayWords(s.next, today)}` : "This round's update is in" };
    case "due": return { text: s.followUp === 0 ? "Update due today" : `Update due ${dueDayWords(s.due, today)}`, warn: s.lapsed };
    case "missing": return { text: `Update missing: one was due ${dueDayWords(s.due, today)}`, warn: true };
  }
}

/** About › Update day (a <dt>/<dd> pair for its list). */
export function UpdateDayField({ project, tasks, latest, canManage, onUpdate }: {
  project: Project;
  /** the project's tasks */
  tasks: Task[];
  latest?: StatusUpdate;
  lastUpdateDays?: number | null;
  canManage: boolean;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
}): JSX.Element | null {
  const today = todayISO();
  const ws = workspaceOf(project);
  const team = workspaceRhythm(ws);
  const own = parseRhythm(project.updateRhythm);
  const state = useMemo(() => projectRhythmState(project, tasks, latest, KANBO_TODAY),
    // (the workspace's day is read through it: a change there re-renders the page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, tasks, latest, today, ws]);
  if (!project.workspaceId || !rhythmOn() || !state) return null;
  const line = rhythmStateLine(state, today);
  const pick = (v: string) => {
    if (v === "team") { onUpdate(project.id, { updateRhythm: null }); return; }
    onUpdate(project.id, { updateRhythm: rhythmToSave({ cadence: v as UpdateCadence, weekday: own?.weekday ?? team.weekday, anchor: own?.anchor }, KANBO_TODAY) });
  };
  const pickDay = (wd: number) => {
    if (!own) return;
    onUpdate(project.id, { updateRhythm: rhythmToSave({ ...own, weekday: wd }, KANBO_TODAY) });
  };
  return (
    <>
      <dt>Update day</dt>
      <dd>
        {canManage ? (
          <>
            <select className="kpj-field" data-size="sm" value={own ? own.cadence : "team"} aria-label="Update day" onChange={(e) => pick(e.target.value)}>
              <option value="team">The team's day: {lowerFirst(rhythmLabel(team))}</option>
              {CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {own && own.cadence !== "never" && (
              <select className="kpj-field" data-size="sm" value={own.weekday} aria-label="Day of the week" onChange={(e) => pickDay(Number(e.target.value))}>
                {WEEKDAYS.map((d) => <option key={d} value={d}>{weekdayName(d)}</option>)}
              </select>
            )}
          </>
        ) : (
          <span style={{ color: "var(--ink)" }}>{rhythmLabel(own ?? team)}{own ? "" : " (the team's day)"}</span>
        )}
        <span className={line.warn ? "kpj-card-meta kpj-warn" : "kpj-card-meta"}>{line.text}</span>
      </dd>
    </>
  );
}

/** An update's plan to recover and new target date, under its words in the history. */
export function UpdatePlanNote({ update }: { update: Pick<StatusUpdate, "recoveryPlan" | "targetDate"> }): JSX.Element | null {
  if (!update.recoveryPlan && !update.targetDate) return null;
  return (
    <div className="kup-hist-plan">
      {update.recoveryPlan && <p><b>Plan to recover:</b> {update.recoveryPlan}</p>}
      {update.targetDate && <span className="kup-hist-date">New target date: <span>{fmtShortDay(update.targetDate, KANBO_TODAY)}</span></span>}
    </div>
  );
}
