/* ============================================================
   KANBO — the goal panel, wherever a goal is opened from: a Goals
   row, a "Serves" chip on a project or task, the Today brief, Kanbo
   noticed's one-tap check-in, the Team place, Search and ⌘K. The app
   keeps which goal is open; this finds it and everything the panel
   reads in the goal's own workspace (its goals, projects, tasks,
   people and your role there), and closes when the goal goes (deleted
   here or by someone else, or out of your sight).
   ============================================================ */
import { useEffect, useMemo } from "react";
import type { Goal, GoalCheckin, GoalExtras, GoalLink, GoalLinkKind, GoalPatch, Project, Role, SavedView, StatusUpdate, Task, WorkspaceMember } from "../../data/types";
import { canSeeGoal } from "../../lib/goalRules";
import { GoalPanel } from "./GoalPanel";

export interface GoalWrites {
  checkin: (goal: Goal, value: number, confidence: number | null, note: string) => void;
  removeCheckin: (id: string, goal: Goal, checkins: GoalCheckin[]) => void;
  link: (goal: Goal, kind: GoalLinkKind, targetId: string) => void;
  unlink: (link: GoalLink) => void;
}

export interface GoalPanelHostProps {
  open: { id: string; checkin?: boolean };
  /** every workspace's goals */
  goals: Goal[];
  extras: GoalExtras | null;
  projects: Project[];
  /** every workspace's tasks (archived projects' too) */
  tasks: Task[];
  members: WorkspaceMember[];
  statusUpdates: StatusUpdate[];
  /** the saved views on hand (a goal links its workspace's shared ones; a personal goal, your own) */
  views?: SavedView[];
  me: string;
  roleIn: (wsId: string | null | undefined) => Role | null;
  docked: boolean;
  today?: Date;
  onClose: () => void;
  onOpenGoal: (id: string) => void;
  onOpenGoals: (workspaceId: string | null) => void;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenView?: (id: string) => void;
  onCreate: (name: string, extra: GoalPatch | undefined, workspaceId: string | null) => void;
  onUpdate: (id: string, patch: GoalPatch) => void;
  onDelete: (id: string) => void;
  writes: GoalWrites;
}

export function GoalPanelHost(p: GoalPanelHostProps) {
  const goal = p.goals.find((g) => g.id === p.open.id);
  const ws = goal ? goal.workspaceId ?? null : null;
  const role = ws === null ? null : p.roleIn(ws);
  const seen = !!goal && canSeeGoal(goal, { me: p.me, role });
  const { onClose } = p;
  useEffect(() => { if (!goal || !seen) onClose(); }, [goal, seen, onClose]);
  const scope = useMemo(() => {
    const goals = p.goals.filter((g) => (g.workspaceId ?? null) === ws && canSeeGoal(g, { me: p.me, role }));
    const projects = p.projects.filter((x) => (x.workspaceId ?? null) === ws);
    const tasks = p.tasks.filter((t) => (t.workspaceId ?? null) === ws);
    const members = p.members.filter((m) => (m.workspaceId ?? null) === ws && m.status === "active");
    const views = (p.views ?? []).filter((v) => (ws === null ? v.workspaceId === null && v.userId === p.me : v.workspaceId === ws && v.shared))
      .map((v) => ({ id: v.id, name: v.name, emoji: v.emoji }));
    return { goals, projects, tasks, members, views };
  }, [p.goals, p.projects, p.tasks, p.members, p.views, ws, role, p.me]);
  if (!goal || !seen) return null;
  return (
    <GoalPanel goal={goal} goals={scope.goals} projects={scope.projects} tasks={scope.tasks} extras={p.extras} me={p.me} role={role}
      members={scope.members} statusUpdates={p.statusUpdates} views={scope.views} readOnly={role === "guest"} docked={p.docked}
      composeFirst={!!p.open.checkin} today={p.today}
      onClose={onClose} onOpenGoal={p.onOpenGoal} onOpenGoals={() => p.onOpenGoals(ws)} onOpenTask={p.onOpenTask} onOpenProject={p.onOpenProject} onOpenView={p.onOpenView}
      onCreate={(name, extra) => p.onCreate(name, extra, ws)} onUpdate={p.onUpdate} onDelete={p.onDelete}
      onCheckin={p.writes.checkin} onDeleteCheckin={(id, g) => p.writes.removeCheckin(id, g, p.extras?.checkins ?? [])}
      onLink={p.writes.link} onUnlink={p.writes.unlink} />
  );
}
