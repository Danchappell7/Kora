import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findPack } from "../packs";
import { buildPackPlan, defaultPick, packPart, type PackContext, type PackPick } from "./packPlan";
import { applyPackPlan, isNotYet, NOT_YET_COPY, packOutcomeCounts, packOutcomeTitle, undoAppliedPack, type PackApplyDeps, type PackUndoDeps } from "./packApply";
import type { AutomationRule, FormDef, Goal, GoalLink, Portfolio, Project, Section, Task, WorkspaceTemplate } from "../data/types";

const TODAY = new Date(2026, 10, 10);
const ctx = (over: Partial<PackContext> = {}): PackContext => ({ today: TODAY, goalsV2: true, canSetGoals: true, canSetUpdateDay: true, businesses: [], ...over });
const fitness = findPack("pack-fitness")!;
const pick = (pack: WorkspaceTemplate, over: Partial<PackPick> = {}): PackPick => ({ ...defaultPick(pack, { today: TODAY }), ...over });

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 9, 0)); });
afterEach(() => { vi.useRealTimers(); });

/** Fake creates that record what they were asked, in order. */
function fakeDeps(over: Partial<PackApplyDeps> = {}) {
  let n = 0;
  const id = (k: string) => `${k}-${++n}`;
  const log: string[] = [];
  const goals: { name: string; extra?: Record<string, unknown>; due?: string; target?: number; unit?: string }[] = [];
  const deps: PackApplyDeps = {
    createProject: async (i) => { log.push(`project:${i.name}`); return { id: id("p"), name: i.name, emoji: i.emoji, color: i.color, workspaceId: i.workspaceId } as Project; },
    createSection: async (i) => ({ id: id("s"), projectId: i.projectId, workspaceId: i.workspaceId, name: i.name, position: i.position }) as Section,
    createTasks: async (ts: Task[]) => { log.push(`tasks:${ts.length}`); return ts; },
    createForm: async (i) => { log.push(`form:${i.name}`); return { id: id("f"), projectId: i.projectId, workspaceId: i.workspaceId, name: i.name, fields: i.fields } as FormDef; },
    createRule: async (i) => { log.push(`rule:${i.name}`); return { id: id("r"), projectId: i.projectId, workspaceId: i.workspaceId, name: i.name, trigger: i.trigger ?? "task_created", actions: i.actions, enabled: true } as AutomationRule; },
    createDoc: async (i) => { log.push(`doc:${i.title}`); return { id: id("d"), projectId: i.projectId, title: i.title, icon: i.icon }; },
    createGoal: async (i) => {
      goals.push({ name: i.name, extra: i.extra as Record<string, unknown>, due: i.due, target: i.target, unit: i.unit });
      log.push(`goal:${i.name}`);
      return { id: id("g"), name: i.name, workspaceId: i.workspaceId, status: "on_track", target: i.target, unit: i.unit, due: i.due, ...i.extra } as Goal;
    },
    addGoalLink: async (i) => ({ id: id("l"), goalId: i.goalId, workspaceId: i.workspaceId, kind: i.kind, targetId: i.targetId }) as GoalLink,
    createPortfolio: async (i) => { log.push(`portfolio:${i.name}`); return { id: id("pf"), name: i.name, projectIds: i.projectIds ?? [], workspaceId: i.workspaceId } as Portfolio; },
    updatePortfolio: vi.fn(async () => {}),
    setUpdateRhythm: vi.fn(async () => {}),
    ...over,
  };
  return { deps, log, goals };
}

const missing = (code = "PGRST204") => Object.assign(new Error("Could not find the 'owner_id' column of 'goals' in the schema cache"), { code });

describe("applyPackPlan", () => {
  it("makes everything in order: projects with their tasks, forms and rules; then docs, goals, the portfolio and the update day", async () => {
    const plan = buildPackPlan(fitness, pick(fitness), ctx());
    const { deps, log, goals } = fakeDeps();
    const a = await applyPackPlan(plan, { workspaceId: "ws-1", me: "u-me", rhythmBefore: { cadence: "weekly", weekday: 5 } }, deps);
    expect(a.failed).toEqual([]);
    expect(a.notYet).toEqual([]);
    expect(a.projects.map((p) => p.name)).toEqual(["New studio opening", "Timetable change", "Instructor onboarding", "Studio maintenance", "Studio routines"]);
    expect(a.tasks).toHaveLength(34);
    expect(a.tasks.every((t) => t.assigneeId === "u-me" && t.status === "todo" && !t.planToday)).toBe(true);
    expect(a.tasks.find((t) => t.title === "Opening day")).toMatchObject({ isMilestone: true, dueDate: "2027-02-08" });
    expect(a.forms.map((f) => f.name)).toEqual(["Report a maintenance problem"]);
    expect(a.rules.map((r) => r.name)).toEqual(["New reports land in Reported"]);
    // the order: every project's own things first, then the rest
    const first = (p: string) => log.findIndex((x) => x.startsWith(p));
    expect(first("doc:")).toBeGreaterThan(log.lastIndexOf("rule:New reports land in Reported"));
    expect(first("goal:")).toBeGreaterThan(log.lastIndexOf(log.filter((x) => x.startsWith("doc:")).pop()!));
    expect(first("portfolio:")).toBeGreaterThan(log.lastIndexOf(log.filter((x) => x.startsWith("goal:")).pop()!));
    // docs land in their own projects
    const routines = a.projects.find((p) => p.name === "Studio routines")!;
    expect(a.docs.filter((d) => d.projectId === routines.id).map((d) => d.title)).toEqual(["Opening and closing checklist", "Weekly studio meeting"]);
    // goals: objectives owned by you for the quarter, key results under them
    expect(goals.map((g) => g.name)).toEqual([
      "Full classes, every week", "Average class fill", "Peak-time classes with a waitlist", "Off-peak class fill",
      "Members stay with us", "Members still active after three months", "Members booking twice a week or more",
      "Open the new studio on time", "Founding members signed before opening",
    ]);
    expect(goals[0]).toMatchObject({ due: "2027-03-31", extra: { kind: "objective", ownerId: "u-me", period: "2027-Q1", icon: "🔥", description: "Members get the classes they want, and the studio pays its way." } });
    const fill = a.goals.find((g) => g.name === "Full classes, every week")!;
    expect(goals[1]).toMatchObject({ target: 75, unit: "%", extra: { kind: "key_result", parentId: fill.id, period: "2027-Q1" } });
    const opening = a.projects.find((p) => p.name === "New studio opening")!;
    expect(a.goals.find((g) => g.name === "Open the new studio on time")).toMatchObject({ projectId: opening.id });
    // links: the goal and its key results to the work that serves them
    const timetable = a.projects.find((p) => p.name === "Timetable change")!;
    expect(a.links.filter((l) => l.goalId === fill.id).map((l) => l.targetId)).toEqual([timetable.id, routines.id]);
    expect(a.links.length).toBe(2 + 3 * 2 + 2 + 2 * 2 + 1);   // each goal and key result to its projects
    // the portfolio, with its projects and its look
    expect(a.portfolios[0]).toMatchObject({ name: "Studio growth", projectIds: [opening.id, timetable.id, a.projects[2].id], description: expect.any(String), emoji: "📈" });
    expect(deps.updatePortfolio).toHaveBeenCalledWith(a.portfolios[0].id, expect.objectContaining({ emoji: "📈", color: expect.any(String) }));
    // the update day, and the one it replaced
    expect(deps.setUpdateRhythm).toHaveBeenCalledWith("ws-1", { cadence: "weekly", weekday: 1 });
    expect(a.rhythm).toEqual({ workspaceId: "ws-1", before: { cadence: "weekly", weekday: 5 }, after: { cadence: "weekly", weekday: 1 } });
    // the QR poster belongs to the form that was made
    expect(a.posters).toEqual([{ formId: a.forms[0].id, projectId: a.forms[0].projectId, projectName: "Studio maintenance", formName: "Report a maintenance problem", headline: "Something broken?", line: "Scan to tell the team. It takes less than a minute." }]);
  });

  it("before Goals 2.0 is in: the first goal that's refused for its new fields goes in without them, and so does the rest", async () => {
    const plan = buildPackPlan(fitness, pick(fitness), ctx());
    const calls: { name: string; extra?: Record<string, unknown> }[] = [];
    const { deps } = fakeDeps();
    const make = deps.createGoal;
    deps.createGoal = async (i) => {
      calls.push({ name: i.name, extra: i.extra as Record<string, unknown> });
      if (i.extra && "ownerId" in i.extra) throw missing();
      return make(i);
    };
    deps.addGoalLink = vi.fn(async () => { throw new Error("never asked"); });
    const a = await applyPackPlan(plan, { workspaceId: "ws-1", me: "u-me" }, deps);
    expect(a.notYet).toEqual(["goalsV2"]);
    expect(a.failed).toEqual([]);
    expect(a.goals).toHaveLength(9);
    expect(calls.filter((c) => c.extra && "ownerId" in c.extra)).toHaveLength(1);
    expect(a.goals.find((g) => g.name === "Average class fill")!.parentId).toBe(a.goals[0].id);
    expect(a.goals.every((g) => g.period === undefined && g.ownerId === undefined)).toBe(true);
    expect(deps.addGoalLink).not.toHaveBeenCalled();
    expect(NOT_YET_COPY.goalsV2).toMatch(/aren't switched on yet/);
  });

  it("docs, links and the update day that aren't switched on yet are said so, never failures", async () => {
    const plan = buildPackPlan(fitness, pick(fitness), ctx());
    const { deps } = fakeDeps({
      createDoc: vi.fn(async () => { throw Object.assign(new Error("could not find the function public.save_project_doc"), { code: "PGRST202" }); }),
      addGoalLink: vi.fn(async () => { throw Object.assign(new Error('relation "public.goal_links" does not exist'), { code: "42P01" }); }),
      setUpdateRhythm: vi.fn(async () => { throw Object.assign(new Error("function set_update_rhythm does not exist"), { code: "42883" }); }),
    });
    const a = await applyPackPlan(plan, { workspaceId: "ws-1", me: "u-me" }, deps);
    expect(a.notYet.sort()).toEqual(["docs", "goalLinks", "updateDay"]);
    expect(a.failed).toEqual([]);
    expect(deps.createDoc).toHaveBeenCalledTimes(1);      // once it's known to be missing, the rest aren't tried
    expect(deps.addGoalLink).toHaveBeenCalledTimes(1);
    expect(a.rhythm).toBeNull();
    expect(a.goals).toHaveLength(9);
  });

  it("a step that fails is named and the rest carry on", async () => {
    const plan = buildPackPlan(fitness, pick(fitness), ctx());
    const { deps } = fakeDeps();
    const make = deps.createGoal;
    deps.createGoal = async (i) => { if (i.name === "Members stay with us") throw new Error("boom"); return make(i); };
    deps.createPortfolio = async () => { throw new Error("nope"); };
    deps.setUpdateRhythm = async () => { throw Object.assign(new Error("not allowed"), { code: "42501" }); };
    const a = await applyPackPlan(plan, { workspaceId: "ws-1", me: "u-me" }, deps);
    expect(a.failed).toEqual(["Members stay with us", "Studio growth", "The update day"]);
    // its key results went with it
    expect(a.goals.map((g) => g.name)).not.toContain("Members still active after three months");
    expect(a.goals).toHaveLength(6);
    expect(packOutcomeTitle("Boutique fitness group", a)).toBe("Boutique fitness group is set up, with gaps");
  });

  it("a portfolio's look that can't be saved yet (0054) leaves the portfolio as it is", async () => {
    const plan = buildPackPlan(fitness, pick(fitness), ctx());
    const { deps } = fakeDeps({ updatePortfolio: vi.fn(async () => { throw new Error("Portfolio details aren't switched on yet."); }) });
    const a = await applyPackPlan(plan, { workspaceId: "ws-1", me: "u-me" }, deps);
    expect(a.portfolios[0].emoji).toBeUndefined();
    expect(a.failed).toEqual([]);
  });

  it("in Personal there's no update day to set, and only what was ticked is made", async () => {
    const plan = buildPackPlan(fitness, pick(fitness, { off: [packPart.project("opening"), packPart.goal("fill"), packPart.goal("retention")] }), ctx());
    const { deps } = fakeDeps();
    const a = await applyPackPlan(plan, { workspaceId: null, me: "u-me" }, deps);
    expect(a.projects.map((p) => p.name)).not.toContain("New studio opening");
    expect(a.goals.map((g) => g.name)).toEqual(["Open the new studio on time", "Founding members signed before opening"]);
    // its project wasn't made, so it's a goal of its own
    expect(a.goals[0].projectId).toBeUndefined();
    expect(deps.setUpdateRhythm).not.toHaveBeenCalled();
  });

  it("a holding company's businesses each get their project and portfolio", async () => {
    const holding = findPack("pack-holding")!;
    const plan = buildPackPlan(holding, pick(holding, { businesses: ["North Gym", "Harbour Cafe"] }), ctx());
    const { deps } = fakeDeps();
    const a = await applyPackPlan(plan, { workspaceId: "ws-h", me: "u-me" }, deps);
    const gym = a.projects.find((p) => p.name === "North Gym")!;
    expect(a.portfolios.map((pf) => [pf.name, pf.projectIds])).toEqual([["North Gym", [gym.id]], ["Harbour Cafe", [a.projects.find((p) => p.name === "Harbour Cafe")!.id]]]);
    expect(a.tasks.filter((t) => t.projectId === gym.id).map((t) => t.title)).toContain("North Gym: agree this year's plan and budget");
  });

  it("counts what was made for the summary", async () => {
    const { deps } = fakeDeps();
    const a = await applyPackPlan(buildPackPlan(fitness, pick(fitness), ctx()), { workspaceId: "ws-1", me: "u-me" }, deps);
    expect(packOutcomeCounts(a)).toEqual({ projects: "5 projects and 34 starter tasks", goals: "3 goals with 6 key results", portfolios: "1 portfolio", docs: "4 docs", forms: "1 request form" });
    expect(packOutcomeTitle("Boutique fitness group", a)).toBe("Boutique fitness group is set up");
    expect(packOutcomeTitle("Startup", { projects: [], goals: [], portfolios: [], failed: ["x"] })).toBe("Couldn't set up Startup");
  });
});

describe("undoAppliedPack", () => {
  it("takes it all back, newest first: the update day, the portfolio, key results before their goals, docs, rules, forms, then the projects", async () => {
    const { deps } = fakeDeps();
    const a = await applyPackPlan(buildPackPlan(fitness, pick(fitness), ctx()), { workspaceId: "ws-1", me: "u-me", rhythmBefore: null }, deps);
    const log: string[] = [];
    const undo: PackUndoDeps = {
      setUpdateRhythm: async (ws, r) => { log.push(`rhythm:${ws}:${JSON.stringify(r)}`); },
      deletePortfolio: async (id) => { log.push(`portfolio:${id}`); },
      deleteGoal: async (id) => { log.push(`goal:${a.goals.find((g) => g.id === id)!.parentId ? "kr" : "objective"}`); },
      deleteDoc: async () => { log.push("doc"); },
      deleteRule: async () => { log.push("rule"); },
      deleteForm: async () => { log.push("form"); },
      deleteProject: async () => { log.push("project"); },
    };
    const r = await undoAppliedPack(a, undo);
    expect(r.failed).toEqual([]);
    expect(log[0]).toBe("rhythm:ws-1:null");
    expect(log[1]).toMatch(/^portfolio:/);
    const goals = log.filter((x) => x.startsWith("goal:"));
    expect(goals).toEqual([...Array(6).fill("goal:kr"), ...Array(3).fill("goal:objective")]);
    expect(log.slice(-5)).toEqual(Array(5).fill("project"));
    expect(log.filter((x) => x === "doc")).toHaveLength(4);
    expect(log.indexOf("rule")).toBeLessThan(log.indexOf("project"));
  });

  it("names what it couldn't remove and removes the rest", async () => {
    const { deps } = fakeDeps();
    const a = await applyPackPlan(buildPackPlan(fitness, pick(fitness), ctx()), { workspaceId: "ws-1", me: "u-me" }, deps);
    const r = await undoAppliedPack(a, {
      deleteGoal: async () => {}, deletePortfolio: async () => {},
      deleteProject: async (id) => { if (id === a.projects[1].id) throw new Error("not_deleted"); },
    });
    expect(r.failed).toEqual(["Timetable change"]);
  });
});

describe("isNotYet", () => {
  it("knows a missing table, column or function from any other error", () => {
    for (const code of ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"]) expect(isNotYet({ code, message: "x" })).toBe(true);
    expect(isNotYet(new Error('relation "public.project_docs" does not exist'))).toBe(true);
    expect(isNotYet({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isNotYet(new TypeError("Failed to fetch"))).toBe(false);
    expect(isNotYet(null)).toBe(false);
  });
});
