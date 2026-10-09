/* ============================================================
   KANBO — the planner as App mounts it (loaded on demand).
   Works out the workspace's people (with their job titles and which
   of them are guests) and the store-backed create/rollback calls, so
   App never pulls lib/projectPlanner into the first download. App
   gets the result and the toast's words in onCreated.
   ============================================================ */
import { useMemo } from "react";
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
}

export function PlannerHost({ open, mode, workspaceId, workspaceName, project, sections, wsMembers, tasks, currentUserId, aiEnabled, initialGoal, store, onClose, onCreated }: PlannerHostProps) {
  const people = useMemo(() => plannerPeople(MEMBERS, wsMembers, workspaceId, currentUserId), [wsMembers, workspaceId, currentUserId]);
  const deps = useMemo(() => plannerDeps(store, currentUserId), [store, currentUserId]);
  return (
    <ProjectPlanner open={open} mode={mode} workspaceId={workspaceId} workspaceName={workspaceName}
      project={project} sections={sections} members={people.members} guestIds={people.guestIds}
      tasks={tasks} currentUserId={currentUserId} aiEnabled={aiEnabled} initialGoal={initialGoal}
      deps={deps} onClose={onClose} onCreated={(r) => onCreated(r, plannerResultMessage(r, mode))} />
  );
}
