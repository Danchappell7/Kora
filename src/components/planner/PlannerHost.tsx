/* ============================================================
   KANBO — the planner as App mounts it (loaded on demand).
   Works out the workspace's people (with their job titles and which
   of them are guests) and the store-backed create/rollback calls, so
   App never pulls lib/projectPlanner into the first download. App
   gets the result and the toast's words in onCreated.
   ============================================================ */
import { useMemo, useRef } from "react";
import { MEMBERS } from "../../data/data";
import type { AppliedProjectPlan, Project, Section, Task, WorkspaceMember } from "../../data/types";
import { plannerDeps, plannerPeople, plannerResultMessage, type PlannerStore } from "../../lib/projectPlanner";
import { ProjectPlanner } from "./ProjectPlanner";

export interface PlannerHostProps {
  open: boolean;
  mode: "new" | "append";
  workspaceId: string | null;
  workspaceName: string;
  /** append mode: the project to add to (and its sections) */
  project?: Project | null;
  sections?: Section[];
  /** every workspace membership App knows (plannerPeople picks this workspace's active ones) */
  wsMembers: WorkspaceMember[];
  tasks: Task[];
  currentUserId: string;
  aiEnabled: boolean;
  initialGoal?: string;
  store: PlannerStore;
  onClose: () => void;
  onCreated: (r: AppliedProjectPlan, message: { tone: "success" | "info" | "error"; text: string }) => void;
  /** 0058, project access on: `canSee` (adding to a project) keeps the plan to the people who can see it;
   *  `addPeople` (a new project that starts Members only or Private) makes the people it gives work to its
   *  people; `canAssign` is the last word on who may be given a task (lib/projectPlanner plannerDeps) */
  access?: { canSee?: (userId: string) => boolean; addPeople?: boolean; canAssign?: (project: Project, userId: string) => boolean };
}

export function PlannerHost({ open, mode, workspaceId, workspaceName, project, sections, wsMembers, tasks, currentUserId, aiEnabled, initialGoal, store, onClose, onCreated, access }: PlannerHostProps) {
  // (the host's functions are new each render: the lists below change only when who can see it does)
  const canSee = access?.canSee;
  const hidden = canSee ? wsMembers.filter((m) => m.workspaceId === workspaceId && m.userId && m.userId !== currentUserId && !canSee(m.userId)).map((m) => m.userId!).sort().join(",") : "";
  const people = useMemo(() => {
    const all = plannerPeople(MEMBERS, wsMembers, workspaceId, currentUserId);
    if (!hidden) return all;
    const out = new Set(hidden.split(","));
    return { members: all.members.filter((m) => !out.has(m.id)), guestIds: all.guestIds.filter((g) => !out.has(g)) };
  }, [wsMembers, workspaceId, currentUserId, hidden]);
  const addPeople = !!access?.addPeople;
  const canAssignRef = useRef(access?.canAssign); canAssignRef.current = access?.canAssign;
  const deps = useMemo(() => plannerDeps(store, currentUserId, { addPeople, canAssign: (p, u) => canAssignRef.current?.(p, u) ?? true }), [store, currentUserId, addPeople]);
  return (
    <ProjectPlanner open={open} mode={mode} workspaceId={workspaceId} workspaceName={workspaceName}
      project={project} sections={sections} members={people.members} guestIds={people.guestIds}
      tasks={tasks} currentUserId={currentUserId} aiEnabled={aiEnabled} initialGoal={initialGoal}
      deps={deps} onClose={onClose} onCreated={(r) => onCreated(r, plannerResultMessage(r, mode))} />
  );
}
