// ============================================================
// KANBO — project automation rules, folded the way the app runs them
// (App.tsx applyRules / onStatusChange). Shared by the public-form
// function ("When a task is created") and the public API (created,
// status changed, completed), so a task made or moved on outside the app
// gets the same rules as one made in it.
//
// This only says what the rules ASK for. Every caller checks each value
// against what the task may hold (a known priority, an assignee who can be
// on the task, a section of its project, a tag it may carry) and skips
// anything that doesn't fit: nothing is ever guessed.
//
// Pure module (no Deno globals, no imports): vitest covers it.
// ============================================================

/** automation_rules.trigger values (0021): when a rule runs. */
export type RuleTrigger = "task_created" | "status_changed" | "task_completed";
export const RULE_TRIGGERS: readonly RuleTrigger[] = ["task_created", "status_changed", "task_completed"];

export interface RuleRow { id?: string; user_id: string; workspace_id: string | null; project_id: string; trigger?: string | null; actions: unknown; enabled?: boolean | null }

/** What the rules ask for, unchecked: later rules win (priority, assignee,
 *  section), tags add up, each remembering whose rule asked for it. */
export interface RulePlan { priority?: string; assigneeId?: string; sectionId?: string; tags: { value: string; author: string }[] }

/**
 * Fold rules (oldest first) for these triggers, in the order given: a status
 * change runs its "status changed" rules and then, when it completes the
 * task, its "task completed" ones (App.tsx onStatusChange). A rule with no
 * trigger counts as "task created" (rules made before triggers existed).
 */
export function planRules(rules: readonly RuleRow[], triggers: readonly RuleTrigger[] = ["task_created"]): RulePlan {
  const plan: RulePlan = { tags: [] };
  for (const trigger of triggers) {
    for (const r of rules) {
      if (r.enabled === false || (r.trigger || "task_created") !== trigger || !Array.isArray(r.actions)) continue;
      for (const a of r.actions as unknown[]) {
        if (!a || typeof a !== "object") continue;
        const { type, value } = a as { type?: unknown; value?: unknown };
        if (typeof value !== "string" || !value) continue;
        if (type === "set_priority") plan.priority = value;
        else if (type === "set_assignee") plan.assigneeId = value;
        else if (type === "set_section") plan.sectionId = value;
        else if (type === "add_tag") plan.tags.push({ value, author: r.user_id });
      }
    }
  }
  return plan;
}
