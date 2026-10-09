/* ============================================================
   KANBO — "Plan a project with Kanbo" (New project › Plan it with Kanbo,
   the Projects empty state, ⌘K "Plan a project…", and "Add tasks with
   Kanbo" inside a project).                        [0047 contract → w3]

   Flow: describe (goal, deadline, people, constraints) → review (an
   editable PlanDraft grouped by section, a mini timeline, warnings) →
   create (applyProjectPlan through the host's own create paths).
   AI: ai-assist { mode: "plan", …AiPlanRequest } → { plan: AiPlanReply,
   usage } (supabase/functions/_shared/projectPlan.ts; counts toward the
   daily AI limit). No AI (no key, 400 no_api_key, offline, demo mode, the
   Settings switch off): fallbackPlan() — deterministic, from keywords.
   Dates: offsets are working days (Mon–Fri) from the start day (today in
   Europe/London, or the next working day).

   Package w3 implements everything below (real + demo), the ai-assist
   mode and the component; the types and PLAN_LIMITS are final.
   ============================================================ */
import type {
  AiPlanReply, AppliedProjectPlan, Member, PlanApplyDeps, PlanApplyProgress, PlanDraft, PlannerContext, PlannerFailure,
  PlannerInput, PlanWarning, Project, Section, Task,
} from "../data/types";

export { PLAN_LIMITS } from "../../supabase/functions/_shared/projectPlan.ts";

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package w3)`));
const notBuiltSync = (fn: string): never => { throw new Error(`${fn}: not built yet (package w3)`); };

/** A deterministic, template-based plan from the goal's keywords (launch, hire, event, website, campaign…). */
export function fallbackPlan(_input: PlannerInput, _ctx: PlannerContext): PlanDraft { return notBuiltSync("fallbackPlan"); }
/** Ask ai-assist for a plan; rejects with an Error whose `reason` is a PlannerFailure. */
export function planWithAi(_input: PlannerInput, _ctx: PlannerContext): Promise<PlanDraft> { return notBuilt("planWithAi"); }
/** The function's checked reply → an editable draft (assignee hints resolved against the roster). */
export function draftFromAiReply(_reply: AiPlanReply, _input: PlannerInput, _ctx: PlannerContext): PlanDraft { return notBuiltSync("draftFromAiReply"); }
/** Overloaded people (the Workload model, existing work included), dates past the deadline, unassigned work, a task due before what it depends on. */
export function planWarnings(_draft: PlanDraft, _ctx: { tasks: Task[]; members: Member[]; deadline?: string | null }): PlanWarning[] { return notBuiltSync("planWarnings"); }
/** YYYY-MM-DD plus n working days (Mon–Fri). */
export function addWorkingDays(_startISO: string, _n: number): string { return notBuiltSync("addWorkingDays"); }
/** Make it: project (new mode, with identity), sections, tasks (one createTasks batch), dependencies — with progress, and rollback messaging on failure. */
export function applyProjectPlan(
  _draft: PlanDraft,
  _opts: { workspaceId: string | null; currentUserId: string; project?: Project | null; sections?: Section[] },
  _deps: PlanApplyDeps,
  _onProgress?: (p: PlanApplyProgress) => void,
): Promise<AppliedProjectPlan> { return notBuilt("applyProjectPlan"); }
/** An error from planWithAi / the function → why. */
export function plannerFailure(_e: unknown): PlannerFailure { return "error"; }
