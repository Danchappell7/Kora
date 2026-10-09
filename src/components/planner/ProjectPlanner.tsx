/* ============================================================
   KANBO — "Plan a project with Kanbo".                 [0047 stub → w3]
   1 Describe: a goal (+ deadline, people, constraints) with four example
     prompts. 2 Review: the draft grouped by section — rename, delete,
     reassign, change dates, drag to reorder, toggle milestone — a mini
     timeline, and warnings (overloaded people via the Workload model,
     dates past the deadline). 3 Create: the project (emoji + spectrum hue
     suggestion), sections, tasks and dependencies through `deps`, with
     progress and rollback messaging on failure. "append" mode adds tasks
     to an existing project ("Add tasks with Kanbo").
   Data: lib/projectPlanner. Renders nothing until package w3 builds it.
   ============================================================ */
import type { AppliedProjectPlan, Member, PlanApplyDeps, Project, Section, Task } from "../../data/types";

export interface ProjectPlannerProps {
  open: boolean;
  /** new: plan a new project · append: add tasks to `project` */
  mode: "new" | "append";
  workspaceId: string | null;
  workspaceName: string;
  /** append mode: the project to add to */
  project?: Project | null;
  /** append mode: that project's sections */
  sections?: Section[];
  /** the workspace's people: who the plan may assign */
  members: Member[];
  /** which of `members` are guests (assignable; no team capacity) */
  guestIds?: string[];
  /** the workspace's tasks (Workload warnings) */
  tasks: Task[];
  currentUserId: string;
  /** Settings › "Use Kanbo AI" is on and this isn't demo mode; off → the on-device planner */
  aiEnabled: boolean;
  /** prefilled goal (⌘K "Plan a project…" passes what was typed) */
  initialGoal?: string;
  /** the host's create paths (so its state updates as things are made) */
  deps: PlanApplyDeps;
  onClose: () => void;
  /** everything made: the host opens the project and toasts */
  onCreated: (result: AppliedProjectPlan) => void;
}

export function ProjectPlanner(_props: ProjectPlannerProps) {
  return null;
}
