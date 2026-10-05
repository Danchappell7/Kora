// @vitest-environment node
// Project automation rules, folded the way the app runs them (App.tsx
// applyRules / onStatusChange): shared by public forms and the API.
import { describe, expect, it } from "vitest";
import { planRules, type RuleRow } from "./automationRules.ts";

const rule = (trigger: string | null, actions: unknown, extra: Partial<RuleRow> = {}): RuleRow =>
  ({ user_id: "u1", workspace_id: "w1", project_id: "p1", trigger, actions, enabled: true, ...extra });

describe("planRules", () => {
  it("task created by default; later rules win; tags add up with their author", () => {
    const plan = planRules([
      rule("task_created", [{ type: "set_priority", value: "high" }, { type: "add_tag", value: "design" }]),
      rule(null, [{ type: "set_priority", value: "urgent" }, { type: "add_tag", value: "Launch" }], { user_id: "u2" }),
      rule("status_changed", [{ type: "set_priority", value: "low" }]),
    ]);
    expect(plan).toEqual({ priority: "urgent", tags: [{ value: "design", author: "u1" }, { value: "Launch", author: "u2" }] });
  });

  it("a status change: 'status changed' rules, then 'task completed' ones", () => {
    const rules = [
      rule("task_completed", [{ type: "set_assignee", value: "ana" }, { type: "set_priority", value: "low" }]),
      rule("status_changed", [{ type: "set_priority", value: "high" }, { type: "set_section", value: "s1" }]),
      rule("task_created", [{ type: "set_priority", value: "urgent" }]),
    ];
    expect(planRules(rules, ["status_changed"])).toEqual({ priority: "high", sectionId: "s1", tags: [] });
    expect(planRules(rules, ["status_changed", "task_completed"])).toEqual({ priority: "low", sectionId: "s1", assigneeId: "ana", tags: [] });
  });

  it("skips switched-off rules and anything malformed", () => {
    expect(planRules([
      rule("task_created", [{ type: "set_priority", value: "low" }], { enabled: false }),
      rule("task_created", "not a list"),
      rule("task_created", [null, 7, { type: "set_priority" }, { type: "set_priority", value: "" }, { type: "set_priority", value: 3 }, { type: "launch_rockets", value: "now" }]),
    ])).toEqual({ tags: [] });
  });
});
