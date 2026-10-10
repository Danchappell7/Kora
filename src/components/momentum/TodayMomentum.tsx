/* ============================================================
   KANBO — momentum, ready to mount: the pieces the host can lazy-load
   as they are, so lib/momentum never lands in Today's first download.
   · TodayStreak — Today's header chip. Works the streak out from the
     tasks you finished (yours: the assignee) and the days you planned —
     recording today when it sees you put one of your open tasks on
     Today or give it a slot (lib/momentum notePlans: an old "on Today"
     flag never counts) — and copies the focus timer's total for the
     wins recap.
   · TodayWins — Today's wins card on Friday afternoons / Monday
     mornings (the demo shows "your week so far" any day): reads the
     workspace's kudos and the days you planned.
   · TaskKudos — the task panel: KudosButton on a teammate's finished
     team task, or the kudos you got on your own (KudosTally).
   · MomentumSettings — Settings rows (show my streak / my week's wins,
     days off). See ./MomentumSettings.
   Nothing here writes the profile: onChangePrefs / onHide go to the host
   (lib/onboarding saveOnboarding({ momentum }) — momentumPatch shapes it).
   ============================================================ */
import { useEffect, useMemo, useState } from "react";
import type { Member, MomentumPrefs, Project, Task } from "../../data/types";
import { isSupabaseConfigured } from "../../lib/backend";
import {
  activeDaysFor, addDaysISO, computeStreak, localMoment, noteFocusToday, notePlans, readFocusLog, readPlannedDays, recapWindow, streakCompleted,
} from "../../lib/momentum";
import { KudosButton, KudosTally } from "./KudosButton";
import { StreakChip } from "./StreakChip";
import { WinsRecap } from "./WinsRecap";
import { useWorkspaceKudos } from "./useKudos";
import { useMinuteClock } from "./shared";

const sameDays = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((d, i) => d === b[i]);

/** The days you planned (this device). Whenever your tasks change, notePlans looks for a plan
 *  you made today (one of your open tasks put on Today or given a slot since its last look);
 *  then the days are read again (Plan my day, or the other card, may have recorded today). */
function usePlannedDays(currentUserId: string, tasks: readonly Task[], at: Date, timezone?: string): string[] {
  const today = localMoment(at, timezone).date;
  const [days, setDays] = useState(() => readPlannedDays(currentUserId, at));
  useEffect(() => {
    if (currentUserId) notePlans(currentUserId, tasks, at, timezone);
    const next = readPlannedDays(currentUserId, at);
    setDays((prev) => (sameDays(prev, next) ? prev : next));
    // (a new person, a new day, or the tasks changed; not every minute)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, today, timezone, tasks]);
  return days;
}

export function TodayStreak({ currentUserId, tasks, prefs, onChangePrefs, timezone, now }: {
  currentUserId: string;
  /** your tasks as Today has them (all workspaces is best: a streak is yours, not a team's) */
  tasks: Task[];
  prefs?: MomentumPrefs | null;
  onChangePrefs?: (next: MomentumPrefs) => void;
  timezone?: string;
  now?: Date;
}) {
  const at = useMinuteClock(now);
  const day = localMoment(at, timezone).date;
  const plannedDays = usePlannedDays(currentUserId, tasks, at, timezone);
  // keep the focus timer's daily total day by day (the wins recap reads it); every five minutes is plenty
  const fiveMinutes = Math.floor(at.getTime() / 300_000);
  useEffect(() => {
    if (currentUserId) noteFocusToday(currentUserId, at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, fiveMinutes]);
  const completed = useMemo(() => streakCompleted(tasks, currentUserId), [tasks, currentUserId]);
  const streak = useMemo(() => computeStreak({ now: at, timezone, plannedDays, completed, prefs }),
    // (the day, not the minute, moves a streak)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [day, timezone, plannedDays, completed, prefs]);
  const active = useMemo(() => {
    const from = addDaysISO(day, -7);
    return activeDaysFor(plannedDays, completed, timezone).filter((d) => d >= from);
  }, [day, plannedDays, completed, timezone]);
  if (!currentUserId) return null;
  return <StreakChip streak={streak} prefs={prefs} onChangePrefs={onChangePrefs} now={at} timezone={timezone} active={active} />;
}

export function TodayWins({ currentUserId, workspaceId, tasks, projects, members, prefs, onOpenTask, onHide, timezone, now, preview, userName }: {
  currentUserId: string;
  /** the workspace on screen (Slack sharing, and whose kudos are read); null = Personal */
  workspaceId: string | null;
  /** your tasks, all workspaces (the recap is your week) */
  tasks: Task[];
  projects: Project[];
  members: Member[];
  prefs?: MomentumPrefs | null;
  onOpenTask?: (taskId: string) => void;
  onHide?: () => void;
  timezone?: string;
  now?: Date;
  /** "your week so far" outside the Friday / Monday windows; default: on in the demo */
  preview?: boolean;
  userName?: string;
}) {
  const at = useMinuteClock(now);
  const showPreview = preview ?? !isSupabaseConfigured;
  const win = recapWindow(at, timezone, prefs);
  const live = !prefs?.recapHidden && (!!win || showPreview);
  const from = win?.from ?? addDaysISO(localMoment(at, timezone).date, -7);
  // the window's kudos (from the day before, to be safe across timezones)
  const since = useMemo(() => new Date(`${addDaysISO(from, -1)}T00:00:00Z`).toISOString(), [from]);
  const { kudos } = useWorkspaceKudos(live ? workspaceId : null, { since });
  const plannedDays = usePlannedDays(currentUserId, tasks, at, timezone);
  const focusLog = useMemo(() => (live && currentUserId ? readFocusLog(currentUserId, at) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, currentUserId, from]);
  if (!live || !currentUserId) return null;
  return (
    <WinsRecap now={at} currentUserId={currentUserId} tasks={tasks} projects={projects} members={members} kudos={kudos} plannedDays={plannedDays}
      prefs={prefs} workspaceId={workspaceId} onOpenTask={onOpenTask} onHide={onHide} timezone={timezone} focusLog={focusLog}
      preview={showPreview} userName={userName} />
  );
}

export function TaskKudos({ task, currentUserId, recipientName, disabled, size = "md", people }: {
  task: Pick<Task, "id" | "title" | "status" | "assigneeId" | "workspaceId">;
  currentUserId: string;
  recipientName: string;
  disabled?: boolean;
  size?: "sm" | "md";
  people?: readonly { id?: string; userId?: string | null; name?: string; email?: string }[];
}) {
  const show = task.status === "done" && !!task.workspaceId && !!task.assigneeId;
  const taskIds = useMemo(() => [task.id], [task.id]);
  const { kudos, replaceFor } = useWorkspaceKudos(show ? task.workspaceId : null, { taskIds });
  if (!show) return null;
  if (task.assigneeId === currentUserId) return <KudosTally kudos={kudos} taskId={task.id} people={people} />;
  return <KudosButton task={task} currentUserId={currentUserId} recipientName={recipientName} kudos={kudos} size={size} disabled={disabled}
    people={people} onChange={(next) => replaceFor(task.id, next)} />;
}
