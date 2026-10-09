// ============================================================
// KANBO — "Plan a project with Kanbo": the ai-assist mode "plan" wire
// contract, shared by the edge function and the app.          [architect → w3]
//
// The app POSTs an AiPlanRequest to ai-assist; the function prompts Claude
// for STRICT JSON, checks it with validatePlanReply() (server side, so a bad
// reply is a 502 { error: "bad_output" } and never reaches the app half
// formed), and answers { plan: AiPlanReply, usage }. A plan call counts once
// toward the person's daily AI limit (AI_DAILY_LIMIT, ai_usage), like every
// other mode. With no key, a 400 { error: "no_api_key" } (or offline / demo
// mode) the app plans on the device instead: lib/projectPlanner fallbackPlan().
//
// Offsets are WORKING days (Mon–Fri) from the plan's start day (day 0 =
// `today`, Europe/London, or the next working day when today is a weekend).
// `ref`s are the model's own short task keys ("t1", "t2"…): dependsOn names
// them; the app maps them to real ids when it creates the tasks.
//
// Pure module (no Deno globals): the app imports the types and limits.
// Package w3 implements validatePlanReply() (+ tests) and the prompt.
// ============================================================

/** Caps, enforced by validatePlanReply() and by the planner UI. */
export const PLAN_LIMITS = {
  /** tasks in one plan */
  tasks: 60,
  /** sections in one plan */
  sections: 10,
  /** the person's goal text */
  goal: 2000,
  /** constraints text ("no launches on Fridays", "budget £5k") */
  constraints: 1000,
  /** people the plan may assign */
  roster: 50,
  /** a task's title */
  title: 140,
  /** a task's description */
  description: 1000,
  /** a section's name */
  sectionName: 60,
  /** the latest start / due offset, in working days (~1 year) */
  maxOffset: 260,
  /** one task's estimate */
  estimateHours: 200,
} as const;

/** One person the plan may assign work to (the workspace roster). */
export interface AiPlanRosterEntry {
  id: string;
  name: string;
  /** their job title in the workspace ("Designer"), when set */
  title?: string | null;
}

/** POST body for ai-assist { mode: "plan" }. */
export interface AiPlanRequest {
  mode: "plan";
  /** what the person wants to achieve, in their words */
  goal: string;
  /** YYYY-MM-DD, optional: everything should be due by then */
  deadline?: string | null;
  /** YYYY-MM-DD in Europe/London: the plan's day 0 */
  today: string;
  roster: AiPlanRosterEntry[];
  constraints?: string | null;
  /** a name the person already gave the project */
  projectName?: string | null;
  /** "Add tasks with Kanbo" in an existing project: what's already there, so the plan adds rather than repeats */
  existing?: { sections: string[]; titles: string[] } | null;
}

export interface AiPlanTask {
  /** the model's own key for this task ("t1"): unique within the plan */
  ref: string;
  title: string;
  /** one of the reply's section names */
  section: string;
  /** a roster id, a roster name, or null (unassigned) — the app resolves it */
  assigneeHint: string | null;
  estimateHours: number | null;
  /** working days from day 0 */
  startOffset: number;
  /** working days from day 0 (≥ startOffset) */
  dueOffset: number;
  /** refs of tasks that must finish first (no cycles, no unknown refs) */
  dependsOn: string[];
  isMilestone: boolean;
  description: string;
}

/** What the function answers as `plan` (already checked and capped). */
export interface AiPlanReply {
  /** a suggested project: name + one emoji (null in "append" mode) */
  project: { name: string; emoji: string } | null;
  sections: { name: string }[];
  tasks: AiPlanTask[];
}

/**
 * Check and normalise the model's reply: the shape above, PLAN_LIMITS caps
 * (extra tasks / sections dropped, texts trimmed), refs unique, dependsOn
 * only to known refs and acyclic, offsets clamped to 0…maxOffset with
 * dueOffset ≥ startOffset, sections that tasks name all present. null when
 * it can't be salvaged. [stub → w3]
 */
export function validatePlanReply(_raw: unknown, _req: AiPlanRequest): AiPlanReply | null {
  return null;
}
