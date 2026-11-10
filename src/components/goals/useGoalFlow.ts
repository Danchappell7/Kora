/* ============================================================
   KANBO — goals for the rest of the app: everything outside the
   Goals page reads goals through this (lib/goalFlow on the goals you
   can see, in every workspace you're in): which goals a project or a
   task serves (the "Serves" chips), the one goal line the Today brief
   may add, the key results of yours that Kanbo noticed are behind
   pace, and what Ask Kanbo is told about a workspace's goals.
   ============================================================ */
import { useCallback, useMemo } from "react";
import { getMember } from "../../data/data";
import type { Goal, GoalExtras, Role, Task, WorkspaceMember } from "../../data/types";
import { askGoals, briefGoalLookup, goalsBehindForMe, goalsForProject, goalsForTask, readGoals, seeableGoals, type AskGoal, type BriefGoal, type GoalBehind, type GoalRead } from "../../lib/goalFlow";

export interface GoalFlow {
  /** the goals you can see, archived ones left out */
  goals: Goal[];
  reads: Map<string, GoalRead>;
  /** the open goals a project serves */
  forProject: (projectId: string) => Goal[];
  /** the open goals a task serves (its own links, then its project's) */
  forTask: (task: Pick<Task, "id" | "projectId" | "parentId">) => Goal[];
  /** the brief's lookup: the goal of yours a task moves */
  briefGoal: (task: Task) => BriefGoal | null;
  /** your goals and key results behind pace, in a workspace (null: Personal; undefined: everywhere) */
  behind: (workspaceId?: string | null) => GoalBehind[];
  /** what Ask is told about a workspace's goals */
  ask: (workspaceId: string | null) => AskGoal[];
}

export function useGoalFlow({ goals, extras, tasks, me, roleIn, members, today }: {
  goals: Goal[];
  extras: GoalExtras | null;
  /** every workspace's tasks (archived projects' too) */
  tasks: Task[];
  me: string;
  roleIn: (wsId: string | null) => Role | null | undefined;
  members: WorkspaceMember[];
  today: Date;
}): GoalFlow {
  const seen = useMemo(() => seeableGoals(goals, me, roleIn).filter((g) => !g.archivedAt), [goals, me, roleIn]);
  const reads = useMemo(() => readGoals(seen, tasks, today), [seen, tasks, today]);
  const links = useMemo(() => extras?.links ?? [], [extras]);
  const checkins = useMemo(() => extras?.checkins ?? [], [extras]);
  const brief = useMemo(() => briefGoalLookup(me, seen, links, reads), [me, seen, links, reads]);
  const forProject = useCallback((pid: string) => goalsForProject(pid, seen, links), [seen, links]);
  const forTask = useCallback((t: Pick<Task, "id" | "projectId" | "parentId">) => goalsForTask(t, seen, links), [seen, links]);
  // (the same array back while nothing's changed: Today's noticed list doesn't redo itself on every render)
  const behindAll = useMemo(() => goalsBehindForMe(me, seen, reads, checkins, today), [me, seen, reads, checkins, today]);
  const behindIn = useMemo(() => new Map<string, GoalBehind[]>(), [behindAll]);
  const behind = useCallback((ws?: string | null) => {
    if (ws === undefined) return behindAll;
    let hit = behindIn.get(ws ?? "");
    if (!hit) {
      const here = new Set(seen.filter((g) => (g.workspaceId ?? null) === ws).map((g) => g.id));
      hit = behindAll.filter((b) => here.has(b.goalId));
      behindIn.set(ws ?? "", hit);
    }
    return hit;
  }, [behindAll, behindIn, seen]);
  const nameOf = useCallback((id: string | null | undefined) => (id ? getMember(id)?.name ?? members.find((m) => m.userId === id)?.name ?? "" : ""), [members]);
  const ask = useCallback((ws: string | null) => askGoals(seen.filter((g) => (g.workspaceId ?? null) === ws), links, reads, today, nameOf), [seen, links, reads, today, nameOf]);
  return useMemo(() => ({ goals: seen, reads, forProject, forTask, briefGoal: brief, behind, ask }), [seen, reads, forProject, forTask, brief, behind, ask]);
}
