// @vitest-environment node
// The plan wire contract's server-side check: whatever the model writes, the
// app only ever gets a plan in shape — capped, titled, owners from the roster,
// offsets in range and in order, prerequisites known and loop-free.
import { describe, expect, it } from "vitest";
import {
  PLAN_DEFAULT_SECTION, PLAN_LIMITS, planEmoji, planLine, planText, resolveRosterHint, validatePlanReply,
  type AiPlanRequest,
} from "./projectPlan.ts";

const roster = [
  { id: "u-maya", name: "Maya Lin", title: "Designer" },
  { id: "u-theo", name: "Theo Vance" },
  { id: "u-sana", name: "Sana Rao" },
  { id: "u-sam1", name: "Sam Hill" },
  { id: "u-sam2", name: "Sam Ortiz" },
];
const req = (over: Partial<AiPlanRequest> = {}): AiPlanRequest => ({ mode: "plan", goal: "Launch the app", today: "2026-10-09", roster, ...over });
const task = (ref: string, over: Record<string, unknown> = {}) => ({
  ref, title: `Task ${ref}`, section: "Build", assigneeHint: null, estimateHours: 2, startOffset: 0, dueOffset: 1, dependsOn: [], isMilestone: false, description: "",
  ...over,
});

describe("validatePlanReply", () => {
  it("passes a well-formed plan through, normalised", () => {
    const out = validatePlanReply({
      project: { name: "  App launch ", emoji: "🚀 rocket" },
      sections: [{ name: "Build" }, { name: "Launch" }],
      tasks: [
        task("t1", { assigneeHint: "u-maya", description: "Line one\n\n\n\nLine two\u0007" }),
        task("t2", { section: "Launch", dependsOn: ["t1"], startOffset: 2, dueOffset: 4, assigneeHint: "Theo Vance" }),
        task("t3", { section: "Launch", isMilestone: true, startOffset: 1, dueOffset: 5, estimateHours: 3, dependsOn: ["t2"] }),
      ],
    }, req());
    expect(out).not.toBeNull();
    expect(out!.project).toEqual({ name: "App launch", emoji: "🚀" });
    expect(out!.sections).toEqual([{ name: "Build" }, { name: "Launch" }]);
    expect(out!.tasks.map((t) => t.assigneeHint)).toEqual(["u-maya", "u-theo", null]);
    expect(out!.tasks[0].description).toBe("Line one\n\nLine two");
    expect(out!.tasks[1].dependsOn).toEqual(["t1"]);
    // a milestone is a point in time, with no estimate
    expect(out!.tasks[2]).toMatchObject({ isMilestone: true, startOffset: 5, dueOffset: 5, estimateHours: null });
  });

  it("is null when there's nothing to plan", () => {
    expect(validatePlanReply(null, req())).toBeNull();
    expect(validatePlanReply("plan", req())).toBeNull();
    expect(validatePlanReply({ sections: [] }, req())).toBeNull();
    expect(validatePlanReply({ tasks: "lots" }, req())).toBeNull();
    expect(validatePlanReply({ tasks: [{ title: "   " }, 7, null] }, req())).toBeNull();
  });

  it("caps tasks and sections, and trims every text", () => {
    const sections = Array.from({ length: 14 }, (_, i) => ({ name: `Section ${i + 1} ${"x".repeat(80)}` }));
    const tasks = Array.from({ length: 90 }, (_, i) => task(`t${i + 1}`, { title: `Do thing ${i + 1} ${"y".repeat(200)}`, section: sections[i % 14].name, description: "z".repeat(3000) }));
    const out = validatePlanReply({ sections, tasks }, req())!;
    expect(out.tasks).toHaveLength(PLAN_LIMITS.tasks);
    expect(out.sections.length).toBeLessThanOrEqual(PLAN_LIMITS.sections);
    for (const s of out.sections) expect(s.name.length).toBeLessThanOrEqual(PLAN_LIMITS.sectionName);
    for (const t of out.tasks) {
      expect(t.title.length).toBeLessThanOrEqual(PLAN_LIMITS.title);
      expect(t.description.length).toBeLessThanOrEqual(PLAN_LIMITS.description);
      // every task's section is one of the reply's sections
      expect(out.sections.some((s) => s.name === t.section)).toBe(true);
    }
  });

  it("clamps offsets into 0…maxOffset with due on or after start, and estimates into range", () => {
    const out = validatePlanReply({
      sections: [{ name: "Build" }],
      tasks: [
        task("a", { startOffset: -5, dueOffset: 9999, estimateHours: 999 }),
        task("b", { startOffset: 10, dueOffset: 3 }),
        task("c", { startOffset: "4", dueOffset: null, estimateHours: -1 }),
        task("d", { startOffset: "soon", dueOffset: 2.6, estimateHours: 0.1 }),
        task("e", { startOffset: undefined, dueOffset: undefined, estimateHours: "3.3" }),
      ],
    }, req())!;
    const by = Object.fromEntries(out.tasks.map((t) => [t.ref, t]));
    expect(by.a).toMatchObject({ startOffset: 0, dueOffset: PLAN_LIMITS.maxOffset, estimateHours: PLAN_LIMITS.estimateHours });
    expect(by.b).toMatchObject({ startOffset: 3, dueOffset: 10 });
    expect(by.c).toMatchObject({ startOffset: 4, dueOffset: 4, estimateHours: null });
    expect(by.d).toMatchObject({ startOffset: 3, dueOffset: 3, estimateHours: 0.25 });
    expect(by.e).toMatchObject({ startOffset: 0, dueOffset: 0, estimateHours: 3.25 });
  });

  it("keeps refs unique and dependsOn to known refs, never itself, without loops", () => {
    const out = validatePlanReply({
      sections: [{ name: "Build" }],
      tasks: [
        task("t1", { dependsOn: ["t3"] }),           // t1 → t3
        task("t2", { dependsOn: ["t1", "t1", "t2", "ghost", 4] }),
        task("t3", { dependsOn: ["t2"] }),           // would close t1 → t3 → t2 → t1: dropped
        task("t1", { title: "Second t1" }),          // a repeated ref gets a fresh one
        task("", { title: "No ref" }),
      ],
    }, req())!;
    const refs = out.tasks.map((t) => t.ref);
    expect(new Set(refs).size).toBe(refs.length);
    const by = Object.fromEntries(out.tasks.map((t) => [t.title, t]));
    expect(by["Task t1"].dependsOn).toEqual(["t3"]);
    expect(by["Task t2"].dependsOn).toEqual(["t1"]);
    expect(by["Task t3"].dependsOn).toEqual([]);
    expect(by["Second t1"].ref).not.toBe("t1");
    expect(by["No ref"].ref).toBeTruthy();
    // and the result really is acyclic
    const graph = new Map(out.tasks.map((t) => [t.ref, t.dependsOn]));
    const visiting = new Set<string>(), done = new Set<string>();
    const dfs = (r: string): boolean => {
      if (visiting.has(r)) return false;
      if (done.has(r)) return true;
      visiting.add(r);
      const ok = (graph.get(r) ?? []).every(dfs);
      visiting.delete(r); done.add(r);
      return ok;
    };
    expect(out.tasks.every((t) => dfs(t.ref))).toBe(true);
  });

  it("adds the sections tasks name, files loose tasks in the first, and drops duplicates and unused sections", () => {
    const out = validatePlanReply({
      sections: [{ name: "Plan" }, "Unused", { name: "plan" }],
      tasks: [
        task("t1", { section: "Plan" }),
        task("t2", { section: "Venue & catering" }),
        task("t3", { section: "" }),
        task("t4", { section: "PLAN", title: "Task t1" }), // same section (any case), same title
      ],
    }, req())!;
    expect(out.sections.map((s) => s.name)).toEqual(["Plan", "Venue & catering"]);
    expect(out.tasks.map((t) => [t.ref, t.section])).toEqual([["t1", "Plan"], ["t2", "Venue & catering"], ["t3", "Plan"]]);
    const loose = validatePlanReply({ tasks: [task("t1", { section: undefined })] }, req())!;
    expect(loose.sections).toEqual([{ name: PLAN_DEFAULT_SECTION }]);
    expect(loose.tasks[0].section).toBe(PLAN_DEFAULT_SECTION);
  });

  it("never invents an owner: ids and unambiguous names only", () => {
    const out = validatePlanReply({
      tasks: ["u-maya", "U-THEO", "sana rao", "Sana", "Sam", "Priya Patel", "", 12, null].map((h, i) => task(`t${i}`, { assigneeHint: h, title: `T${i}` })),
    }, req())!;
    expect(out.tasks.map((t) => t.assigneeHint)).toEqual(["u-maya", "u-theo", "u-sana", "u-sana", null, null, null, null, null]);
    expect(validatePlanReply({ tasks: [task("t1", { assigneeHint: "u-maya" })] }, req({ roster: [] }))!.tasks[0].assigneeHint).toBeNull();
  });

  it("project: the person's own name stands; null when appending; an emoji only when it is one", () => {
    expect(validatePlanReply({ project: { name: "Model's name", emoji: "x" }, tasks: [task("t1")] }, req({ projectName: "My launch" }))!.project)
      .toEqual({ name: "My launch", emoji: "" });
    expect(validatePlanReply({ project: { name: "New", emoji: "🎉" }, tasks: [task("t1")] }, req({ existing: { sections: [], titles: [] } }))!.project).toBeNull();
    expect(validatePlanReply({ tasks: [task("t1")] }, req())!.project).toBeNull();
    expect(validatePlanReply({ project: { name: "Family offsite", emoji: "👨‍👩‍👧 plus" }, tasks: [task("t1")] }, req())!.project).toEqual({ name: "Family offsite", emoji: "👨‍👩‍👧" });
  });

  it("only true is a milestone", () => {
    const out = validatePlanReply({ tasks: [task("a", { isMilestone: "true" }), task("b", { isMilestone: 1 }), task("c", { isMilestone: true })] }, req())!;
    expect(out.tasks.map((t) => t.isMilestone)).toEqual([false, false, true]);
  });
});

describe("text helpers", () => {
  it("planLine collapses whitespace and strips control and bidi characters", () => {
    expect(planLine("  a\tb\n c ‮d​ ", 20)).toBe("a b c d");
    expect(planLine(42, 10)).toBe("");
    expect(planLine("abcdef", 3)).toBe("abc");
  });
  it("planText keeps paragraphs", () => {
    expect(planText("a\r\nb\n\n\n\nc  d", 100)).toBe("a\nb\n\nc d");
  });
  it("planEmoji keeps one whole emoji", () => {
    expect(planEmoji("🇬🇧 flag")).toBe("🇬🇧");
    expect(planEmoji("👍🏽")).toBe("👍🏽");
    expect(planEmoji("A")).toBe("");
    expect(planEmoji(null)).toBe("");
  });
  it("resolveRosterHint matches ids, full names and unique first names", () => {
    expect(resolveRosterHint("Maya", roster)).toBe("u-maya");
    expect(resolveRosterHint("maya lin", roster)).toBe("u-maya");
    expect(resolveRosterHint("Sam", roster)).toBeNull();
    expect(resolveRosterHint("Maya Smith", roster)).toBeNull();
  });
});
