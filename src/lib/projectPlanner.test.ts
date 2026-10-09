/* lib/projectPlanner: the on-device planner, the draft editing helpers, the
   warnings (the Workload model) and making a plan through the host's create
   paths — with progress, and rollback when something fails. */
import { describe, expect, it, vi } from "vitest";
import {
  addPlanSection, addPlanTask, addWorkingDays, applyProjectPlan, dependentsOf, draftFromAiReply, fallbackPlan, goalFacts, isPlanDay, londonToday,
  movePlanTask, nudgePlanTask, offsetForDate, patchPlanTask, PlanApplyError, planCategory, planEdgeCount, PLANNER_EXAMPLES, plannerFailure,
  plannerResultMessage, plannerRoster, planRequestBody, planStartDay, planTimeline, planTotals, planWarnings, planWithAi, PLAN_LIMITS,
  projectNameFrom, removePlanSection, removePlanTasks, renamePlanSection, shiftPlanStart, suggestIdentity, taskDates, tasksBySection, workingDaysBetween,
  PlannerError, plannerDeps, plannerPeople, planLeftovers, mergePlanLeftovers, removePlanLeftovers, leftSections,
} from "./projectPlanner";
import type { AiPlanReply, Member, PlanApplyDeps, PlanDraft, PlannerContext, Project, Section, Task } from "../data/types";

const TODAY = "2026-10-09"; // a Friday
const last = <T,>(xs: readonly T[]): T => xs[xs.length - 1];
const nth = <T,>(xs: readonly T[], i: number): T => xs[i < 0 ? xs.length + i : i];
const mem = (id: string, name: string, type: Member["type"] = "team"): Member => ({ id, name, email: `${id}@x.test`, type, color: "oklch(0.7 0.1 200)" });
const members = [mem("me", "Daniel Okai", "self"), mem("maya", "Maya Lin"), mem("theo", "Theo Vance"), mem("idris", "Idris Bell", "external")];
const ctx = (over: Partial<PlannerContext> = {}): PlannerContext => ({
  today: TODAY, workspaceId: "ws", mode: "new",
  roster: plannerRoster(members, { guestIds: ["idris"], currentUserId: "me" }), ...over,
});

/** every dependency is to a task in the plan, and the graph has no loops */
function acyclic(d: PlanDraft): boolean {
  const keys = new Set(d.tasks.map((t) => t.key));
  if (d.tasks.some((t) => t.dependsOn.some((k) => !keys.has(k) || k === t.key))) return false;
  const state = new Map<string, 1 | 2>();
  const by = new Map(d.tasks.map((t) => [t.key, t]));
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return false;
    if (state.get(k) === 2) return true;
    state.set(k, 1);
    const ok = by.get(k)!.dependsOn.every(visit);
    state.set(k, 2);
    return ok;
  };
  return d.tasks.every((t) => visit(t.key));
}

describe("dates", () => {
  it("working days skip weekends both ways", () => {
    expect(addWorkingDays(TODAY, 0)).toBe(TODAY);
    expect(addWorkingDays(TODAY, 1)).toBe("2026-10-12");
    expect(addWorkingDays(TODAY, 5)).toBe("2026-10-16");
    expect(addWorkingDays(TODAY, 30)).toBe("2026-11-20");
    expect(addWorkingDays("2026-10-12", -1)).toBe("2026-10-09");
    expect(addWorkingDays("2026-10-10", 0)).toBe("2026-10-12"); // a Saturday start counts from Monday
    expect(workingDaysBetween(TODAY, "2026-11-20")).toBe(30);
    expect(workingDaysBetween(TODAY, "2026-10-11")).toBe(0);
    expect(workingDaysBetween("2026-10-12", "2026-10-10")).toBe(-1);
    expect(workingDaysBetween("2026-10-12", "2026-10-08")).toBe(-2);
    for (let n = 0; n < 80; n += 7) expect(workingDaysBetween(TODAY, addWorkingDays(TODAY, n))).toBe(n);
  });
  it("a weekend pick: a start moves to Monday, a due date to Friday", () => {
    expect(offsetForDate(TODAY, "2026-10-17", "start")).toBe(6); // Sat → Mon 19 (day 6)
    expect(offsetForDate(TODAY, "2026-10-17", "due")).toBe(5);   // Sat → Fri 16 (day 5)
    expect(offsetForDate(TODAY, "2026-01-01", "due")).toBe(0);
    expect(offsetForDate(TODAY, "2030-01-01", "due")).toBe(PLAN_LIMITS.maxOffset);
  });
  it("day 0, today in London, real days", () => {
    expect(planStartDay("2026-10-10")).toBe("2026-10-12");
    expect(planStartDay("2026-10-11")).toBe("2026-10-12");
    expect(planStartDay(TODAY)).toBe(TODAY);
    expect(londonToday(new Date("2026-10-09T23:30:00Z"))).toBe("2026-10-10");
    expect(isPlanDay("2026-02-29")).toBe(false);
    expect(isPlanDay("2028-02-29")).toBe(true);
  });
});

describe("reading the goal", () => {
  it("finds the kind of project", () => {
    expect(PLANNER_EXAMPLES.map(planCategory)).toEqual(["launch", "hire", "event", "website"]);
    expect(planCategory("Black Friday campaign across email and social")).toBe("campaign");
    expect(planCategory("Move the office to Shoreditch")).toBe("move");
    expect(planCategory("Run user interviews about onboarding")).toBe("research");
    expect(planCategory("Build an MVP of the booking tool")).toBe("build");
    expect(planCategory("Launch party for the new album")).toBe("event");
    expect(planCategory("Sort out the garden")).toBe("general");
  });
  it("names the project from the goal", () => {
    expect(projectNameFrom("We need to launch our mobile app by 20 November")).toBe("Launch our mobile app");
    expect(projectNameFrom("Plan a two-day team offsite in Lisbon for 30 people, with workshops")).toBe("Two-day team offsite in Lisbon");
    expect(projectNameFrom("Run our annual customer conference")).toBe("Annual customer conference");
    expect(projectNameFrom("Redesign the marketing website with a new pricing page and customer stories")).toBe("Redesign the marketing website");
    expect(projectNameFrom("help me hire a senior product designer before Christmas.")).toBe("Hire a senior product designer");
    expect(projectNameFrom("   ")).toBe("New project");
    expect(projectNameFrom("x".repeat(100)).length).toBeLessThanOrEqual(48);
  });
  it("suggests an identity", () => {
    expect(suggestIdentity(PLANNER_EXAMPLES[0])).toEqual({ emoji: "🚀", hue: "cobalt" });
    const g = suggestIdentity("Sort out the garden");
    expect(g.emoji).toBe("📋");
    expect(suggestIdentity("Sort out the garden")).toEqual(g); // stable
  });
  it("picks out headcount, place and role", () => {
    expect(goalFacts("Run a two-day team offsite in Lisbon for 30 people in March")).toMatchObject({ people: 30, place: "Lisbon", travel: true });
    expect(goalFacts("Workshop in March").place).toBeUndefined();
    expect(goalFacts("Hire a senior product designer before the end of the year").role).toBe("senior product designer");
    expect(goalFacts("We're hiring two backend engineers in Q1").role).toBe("backend engineer");
  });
});

describe("roster", () => {
  it("puts the person planning first and marks guests", () => {
    const r = plannerRoster([mem("a", "Ann"), mem("me", "Me"), { ...mem("g", "Gus"), title: "Freelance designer" } as Member & { title: string }, mem("a", "Dup")], { guestIds: ["g"], currentUserId: "me" });
    expect(r.map((x) => x.id)).toEqual(["me", "a", "g"]);
    expect(r[2]).toEqual({ id: "g", name: "Gus", title: "Freelance designer", guest: true });
  });
});

describe("fallbackPlan", () => {
  it("drafts a sensible plan for every example: sections, milestones, links, owners", () => {
    for (const goal of PLANNER_EXAMPLES) {
      const d = fallbackPlan({ goal }, ctx());
      expect(d.source).toBe("fallback");
      expect(d.startDate).toBe(TODAY);
      expect(d.tasks.length).toBeGreaterThanOrEqual(12);
      expect(d.tasks.length).toBeLessThanOrEqual(PLAN_LIMITS.tasks);
      expect(d.sections.length).toBeGreaterThanOrEqual(3);
      expect(d.sections.length).toBeLessThanOrEqual(PLAN_LIMITS.sections);
      expect(d.tasks.filter((t) => t.isMilestone).length).toBeGreaterThanOrEqual(2);
      expect(acyclic(d)).toBe(true);
      // every task in a section the draft has; owners only from the roster, guests left out while the team can do it
      const sections = new Set(d.sections.map((s) => s.key));
      for (const t of d.tasks) {
        expect(sections.has(t.sectionKey!)).toBe(true);
        expect(t.dueOffset).toBeGreaterThanOrEqual(t.startOffset);
        if (t.isMilestone) expect(t.assigneeId).toBeNull();
        else expect(["me", "maya", "theo"]).toContain(t.assigneeId);
      }
      // the schedule respects its own links
      expect(planWarnings(d, { tasks: [], members }).filter((w) => w.kind === "dependency_order")).toEqual([]);
    }
  });
  it("is deterministic", () => {
    expect(fallbackPlan({ goal: PLANNER_EXAMPLES[2] }, ctx())).toEqual(fallbackPlan({ goal: PLANNER_EXAMPLES[2] }, ctx()));
  });
  it("uses the goal's specifics", () => {
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[2] }, ctx());
    const titles = d.tasks.map((t) => t.title);
    expect(titles).toContain("Shortlist three venues in Lisbon for 30 people");
    expect(titles.some((t) => /travel and accommodation/.test(t))).toBe(true);
    const hire = fallbackPlan({ goal: PLANNER_EXAMPLES[1] }, ctx());
    expect(hire.tasks[0].title).toContain("senior product designer");
    // an event with no travel leaves the travel task out
    expect(fallbackPlan({ goal: "Summer party at the office for 40 people" }, ctx()).tasks.some((t) => /travel/i.test(t.title))).toBe(false);
  });
  it("fits the deadline: squeezed when tight", () => {
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0], deadline: "2026-10-30" }, ctx());
    expect(d.deadline).toBe("2026-10-30");
    for (const t of d.tasks) expect(taskDates(d, t).due <= "2026-10-30").toBe(true);
    expect(planWarnings(d, { tasks: [], members }).some((w) => w.kind === "past_deadline")).toBe(false);
  });
  it("eases out when there's lots of room, but not past the deadline", () => {
    const loose = fallbackPlan({ goal: PLANNER_EXAMPLES[3] }, ctx());
    const roomy = fallbackPlan({ goal: PLANNER_EXAMPLES[3], deadline: "2027-06-30" }, ctx());
    const end = (d: PlanDraft) => Math.max(...d.tasks.map((t) => t.dueOffset));
    expect(end(roomy)).toBeGreaterThan(end(loose));
    expect(end(roomy)).toBeLessThanOrEqual(end(loose) * 2);
  });
  it("ignores a deadline in the past", () => {
    expect(fallbackPlan({ goal: "Launch the app", deadline: "2026-01-01" }, ctx()).deadline).toBeNull();
  });
  it("assigns by job title when people have one", () => {
    const roster = [{ id: "me", name: "Me" }, { id: "des", name: "Dee", title: "Product designer" }, { id: "eng", name: "Ed", title: "Senior engineer" }];
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[3] }, ctx({ roster }));
    const owner = (re: RegExp) => d.tasks.find((t) => re.test(t.title))!.assigneeId;
    expect(owner(/^Wireframe/)).toBe("des");
    expect(owner(/^Build the page templates/)).toBe("eng");
    expect(owner(/^Agree the goals/)).toBe("me");
  });
  it("only the people picked; nobody when there's no one", () => {
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0], memberIds: ["maya"] }, ctx());
    expect(new Set(d.tasks.filter((t) => !t.isMilestone).map((t) => t.assigneeId))).toEqual(new Set(["maya"]));
    const solo = fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx({ roster: [] }));
    expect(solo.tasks.every((t) => t.assigneeId === null)).toBe(true);
    // guests only when they're all there is
    const guests = fallbackPlan({ goal: PLANNER_EXAMPLES[0], memberIds: ["idris"] }, ctx());
    expect(guests.tasks.filter((t) => !t.isMilestone).every((t) => t.assigneeId === "idris")).toBe(true);
  });
  it("append: skips what the project has and files under its sections", () => {
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0], projectName: "Q3 Product Launch" }, ctx({
      mode: "append", existingSections: ["launch assets"], existingTitles: ["Fix the must-fix bugs", "Record a 60-second demo video"],
    }));
    expect(d.name).toBe("Q3 Product Launch");
    expect(d.tasks.some((t) => t.title === "Fix the must-fix bugs")).toBe(false);
    expect(d.sections.some((s) => s.name === "launch assets")).toBe(true);
    expect(acyclic(d)).toBe(true);
    // a dropped task's prerequisites carry over to what waited on it
    const qa = d.tasks.find((t) => t.title.startsWith("Run a full QA pass"))!;
    const freeze = d.tasks.find((t) => t.title.startsWith("Freeze the launch scope"))!;
    expect(qa.dependsOn).toContain(freeze.key);
  });
  it("append: skipping a task the project has keeps the schedule's chain (no task starts before what it waits for)", () => {
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx({ mode: "append", existingTitles: ["Launch day", "Launch plan signed off"] }));
    expect(d.tasks.some((t) => t.title === "Launch day")).toBe(false);
    expect(planWarnings(d, { tasks: [], members }).filter((w) => w.kind === "dependency_order")).toEqual([]);
    const watch = d.tasks.find((t) => t.title.startsWith("Watch launch-day"))!;
    const rc = d.tasks.find((t) => t.title === "Release candidate approved")!;
    expect(watch.dependsOn).toContain(rc.key);
    expect(watch.startOffset).toBeGreaterThan(rc.dueOffset);
  });
  it("a general goal becomes steps from its own words", () => {
    const d = fallbackPlan({ goal: "Clean up the CRM, set up a new sales pipeline and train the team on it" }, ctx());
    const titles = d.tasks.map((t) => t.title);
    expect(titles).toEqual(expect.arrayContaining(["Clean up the CRM", "Set up a new sales pipeline", "Train the team on it"]));
    expect(acyclic(d)).toBe(true);
  });
});

describe("draftFromAiReply", () => {
  const reply: AiPlanReply = {
    project: { name: "App launch", emoji: "📱" },
    sections: [{ name: "Build" }, { name: "Launch" }, { name: "Unused" }],
    tasks: [
      { ref: "t1", title: "Freeze scope", section: "Build", assigneeHint: "maya", estimateHours: 3, startOffset: 0, dueOffset: 1, dependsOn: [], isMilestone: false, description: "d1" },
      { ref: "t2", title: "Fix the login bug", section: "Build", assigneeHint: "Theo", estimateHours: 8, startOffset: 2, dueOffset: 5, dependsOn: ["t1"], isMilestone: false, description: "" },
      { ref: "t3", title: "Launch day", section: "Launch", assigneeHint: "maya", estimateHours: 2, startOffset: 4, dueOffset: 9, dependsOn: ["t2", "t1"], isMilestone: true, description: "" },
      { ref: "t4", title: "Post-mortem", section: "Wrap", assigneeHint: "nobody", estimateHours: null, startOffset: 10, dueOffset: 11, dependsOn: ["t3"], isMilestone: false, description: "" },
    ],
  };
  it("resolves owners, keys, sections and links", () => {
    const d = draftFromAiReply(reply, { goal: "Launch the app", deadline: "2026-11-20" }, ctx());
    expect(d).toMatchObject({ name: "App launch", emoji: "📱", source: "ai", startDate: TODAY, deadline: "2026-11-20" });
    expect(d.sections.map((s) => s.name)).toEqual(["Build", "Launch", "Wrap"]);
    expect(d.tasks.map((t) => t.assigneeId)).toEqual(["maya", "theo", null, null]);
    expect(d.tasks[2]).toMatchObject({ isMilestone: true, startOffset: 9, dueOffset: 9, estimateHours: null });
    expect(d.tasks[2].dependsOn).toEqual([d.tasks[1].key, d.tasks[0].key]);
    expect(acyclic(d)).toBe(true);
  });
  it("append: never repeats an existing task; the project's own name", () => {
    const d = draftFromAiReply(reply, { goal: "More", projectName: "Q3 Product Launch" }, ctx({ mode: "append", existingTitles: ["fix the LOGIN bug"] }));
    expect(d.name).toBe("Q3 Product Launch");
    expect(d.tasks.map((t) => t.title)).toEqual(["Freeze scope", "Launch day", "Post-mortem"]);
    expect(d.tasks[1].dependsOn).toEqual([d.tasks[0].key]);
  });
  it("owners only from the people picked", () => {
    const d = draftFromAiReply(reply, { goal: "x", memberIds: ["maya"] }, ctx());
    expect(d.tasks.map((t) => t.assigneeId)).toEqual(["maya", null, null, null]);
  });
});

describe("planWithAi in demo mode", () => {
  it("is unavailable without a backend (the planner then drafts on the device)", async () => {
    const e = await planWithAi({ goal: "Launch" }, ctx()).catch((x) => x);
    expect(e).toBeInstanceOf(PlannerError);
    expect(plannerFailure(e)).toBe("ai_unavailable");
  });
  it("plannerFailure reads reasons and messages", () => {
    expect(plannerFailure(new PlannerError("daily_limit", "x"))).toBe("daily_limit");
    expect(plannerFailure(new Error("Failed to fetch"))).toBe("network");
    expect(plannerFailure(new Error("no_api_key"))).toBe("ai_unavailable");
    expect(plannerFailure("weird")).toBe("error");
  });
  it("the request: picked people, today, append context", () => {
    const b = planRequestBody({ goal: "  Ship it  ", memberIds: ["maya", "idris"], deadline: "2026-13-01", constraints: "" }, ctx({ mode: "append", existingSections: ["A"], existingTitles: ["B"] }));
    expect(b).toEqual({
      mode: "plan", goal: "Ship it", deadline: null, today: TODAY,
      roster: [{ id: "maya", name: "Maya Lin" }, { id: "idris", name: "Idris Bell" }],
      constraints: null, projectName: null, existing: { sections: ["A"], titles: ["B"] },
    });
  });
});

describe("editing a draft", () => {
  const base = () => fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx());
  it("patches keep dates in order and milestones as points", () => {
    let d = base();
    const k = d.tasks.find((t) => !t.isMilestone)!.key;
    d = patchPlanTask(d, k, { startOffset: 40 });
    expect(d.tasks.find((t) => t.key === k)).toMatchObject({ startOffset: 40, dueOffset: 40 });
    d = patchPlanTask(d, k, { dueOffset: 3 });
    expect(d.tasks.find((t) => t.key === k)).toMatchObject({ startOffset: 3, dueOffset: 3 });
    d = patchPlanTask(d, k, { startOffset: 1, dueOffset: 6, estimateHours: 4 });
    d = patchPlanTask(d, k, { isMilestone: true });
    expect(d.tasks.find((t) => t.key === k)).toMatchObject({ isMilestone: true, startOffset: 6, dueOffset: 6, estimateHours: null });
  });
  it("removing a task removes the links to it; a section takes its tasks", () => {
    let d = base();
    const first = d.tasks[0].key;
    const waiting = d.tasks.filter((t) => t.dependsOn.includes(first)).map((t) => t.key);
    expect(waiting.length).toBeGreaterThan(0);
    d = removePlanTasks(d, [first]);
    expect(d.tasks.some((t) => t.dependsOn.includes(first))).toBe(false);
    const s = d.sections[1].key;
    const n = d.tasks.filter((t) => t.sectionKey === s).length;
    const before = d.tasks.length;
    d = removePlanSection(d, s);
    expect(d.tasks.length).toBe(before - n);
    expect(d.sections.some((x) => x.key === s)).toBe(false);
    expect(acyclic(d)).toBe(true);
  });
  it("moves within and across sections, and nudges over section edges", () => {
    let d = base();
    const [s1, s2] = d.sections;
    const a = tasksBySection(d)[0].tasks;
    d = movePlanTask(d, a[0].key, s1.key, 2);
    expect(tasksBySection(d)[0].tasks.map((t) => t.key)).toEqual([a[1].key, a[2].key, a[0].key]);
    d = movePlanTask(d, a[0].key, s2.key, 0);
    expect(tasksBySection(d)[1].tasks[0].key).toBe(a[0].key);
    expect(d.tasks.find((t) => t.key === a[0].key)!.sectionKey).toBe(s2.key);
    d = nudgePlanTask(d, a[0].key, -1); // first of section 2 → last of section 1
    expect(last(tasksBySection(d)[0].tasks).key).toBe(a[0].key);
    d = nudgePlanTask(d, a[0].key, -1);
    expect(nth(tasksBySection(d)[0].tasks, -2).key).toBe(a[0].key);
    const top = tasksBySection(d)[0].tasks[0].key;
    expect(nudgePlanTask(d, top, -1)).toBe(d); // nowhere to go
  });
  it("moves into an empty section after the sections before it", () => {
    let d = base();
    const added = addPlanSection(d, "Extras")!;
    d = added.draft;
    const k = d.tasks[0].key;
    d = movePlanTask(d, k, added.key, 0);
    expect(last(d.tasks).key).toBe(k);
    expect(last(tasksBySection(d)).tasks.map((t) => t.key)).toEqual([k]);
  });
  it("adds tasks and sections up to the caps", () => {
    let d = base();
    const s = d.sections[0].key;
    const r = addPlanTask(d, s, "Book photographer")!;
    expect(r.draft.tasks.find((t) => t.key === r.key)).toMatchObject({ title: "Book photographer", sectionKey: s, assigneeId: null });
    expect(last(tasksBySection(r.draft)[0].tasks).key).toBe(r.key);
    while (d.tasks.length < PLAN_LIMITS.tasks) d = addPlanTask(d, s)!.draft;
    expect(addPlanTask(d, s)).toBeNull();
    while (d.sections.length < PLAN_LIMITS.sections) d = addPlanSection(d)!.draft;
    expect(addPlanSection(d)).toBeNull();
    expect(new Set(d.tasks.map((t) => t.key)).size).toBe(d.tasks.length);
  });
  it("renames, shifts the start, finds dependents, totals", () => {
    let d = base();
    d = renamePlanSection(d, d.sections[0].key, "  Kick-off  ");
    expect(d.sections[0].name).toBe(" Kick-off ");
    d = shiftPlanStart(d, "2026-10-17");
    expect(d.startDate).toBe("2026-10-19");
    expect(taskDates(d, d.tasks[0]).start).toBe("2026-10-19");
    expect(dependentsOf(d, d.tasks[0].key).size).toBeGreaterThan(3);
    const tot = planTotals(d);
    expect(tot.tasks).toBe(d.tasks.length);
    expect(tot.hours).toBeGreaterThan(50);
    expect(tot.end > tot.start).toBe(true);
    expect(tot.people).toBe(3);
  });
});

describe("planTimeline", () => {
  it("lanes per section, rows packed, ticks on Mondays, late bars flagged", () => {
    const d = { ...fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx()), deadline: "2026-10-23" };
    const tl = planTimeline(d);
    expect(tl.lanes.map((l) => l.name)).toEqual(d.sections.map((s) => s.name));
    expect(tl.deadline).toBe(10);
    // Friday's label would sit on top of Monday's: Monday's wins
    expect(tl.ticks[0]).toEqual({ day: 1, label: "12 Oct" });
    expect(tl.ticks[1]).toEqual({ day: 6, label: "19 Oct" });
    expect(planTimeline({ ...d, startDate: "2026-10-07" }).ticks[0]).toEqual({ day: 0, label: "7 Oct" });
    expect(tl.ticks.length).toBeLessThanOrEqual(9);
    for (const lane of tl.lanes) {
      expect(lane.rows).toBeLessThanOrEqual(4);
      for (const b of lane.bars) {
        expect(b.late).toBe(b.due > 10);
        // no two bars overlap on one row (when the lane had room)
        if (lane.rows < 4) for (const o of lane.bars) if (o !== b && o.row === b.row) expect(o.due < b.start || b.due < o.start).toBe(true);
      }
    }
  });
});

describe("planWarnings", () => {
  const draft = (): PlanDraft => ({
    name: "P", emoji: "", hue: "iris", startDate: "2026-10-12", deadline: "2026-10-16", source: "fallback",
    sections: [{ key: "s1", name: "Build" }],
    tasks: [
      { key: "a", title: "Design", sectionKey: "s1", assigneeId: "maya", estimateHours: 30, startOffset: 0, dueOffset: 4, dependsOn: [], isMilestone: false, description: "" },
      { key: "b", title: "Build", sectionKey: "s1", assigneeId: "maya", estimateHours: 20, startOffset: 2, dueOffset: 4, dependsOn: ["a"], isMilestone: false, description: "" },
      { key: "c", title: "Ship", sectionKey: "s1", assigneeId: null, estimateHours: 2, startOffset: 5, dueOffset: 6, dependsOn: ["b"], isMilestone: false, description: "" },
      { key: "m", title: "Live", sectionKey: "s1", assigneeId: null, estimateHours: null, startOffset: 6, dueOffset: 6, dependsOn: ["c"], isMilestone: true, description: "" },
    ],
  });
  it("overload (with existing work), deadline, order and unassigned", () => {
    const existing = [{ id: "x", title: "Old", description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "maya", tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, dueDate: "2026-10-14", effortHours: 5 } as Task];
    const w = planWarnings(draft(), { tasks: existing, members, capacities: {}, today: TODAY });
    expect(w.map((x) => x.kind)).toEqual(["overloaded", "past_deadline", "dependency_order", "unassigned"]);
    expect(w[0]).toMatchObject({ memberId: "maya", taskKeys: ["a", "b"] });
    expect(w[0].message).toBe("Maya Lin would have 55h of work in the week of 12 Oct, against 40h of capacity.");
    expect(w[1]).toMatchObject({ taskKeys: ["c", "m"] });
    expect(w[1].message).toBe("2 tasks are due after the deadline, Fri 16 Oct: “Ship” and “Live”.");
    expect(w[2].taskKeys).toEqual(["b"]);
    expect(w[2].message).toBe("“Build” starts before “Design” is due, but waits for it.");
    expect(w[3]).toMatchObject({ taskKeys: ["c"], message: "“Ship” has no one assigned." });
  });
  it("respects capacity set in Workload, and guests carry none", () => {
    expect(planWarnings(draft(), { tasks: [], members, capacities: { maya: 60 }, today: TODAY }).some((w) => w.kind === "overloaded")).toBe(false);
    expect(planWarnings(draft(), { tasks: [], members, guestIds: ["maya"], capacities: {}, today: TODAY }).some((w) => w.kind === "overloaded")).toBe(false);
  });
  it("someone already over without the plan isn't the plan's warning", () => {
    const d = draft();
    d.tasks[0].assigneeId = "theo"; d.tasks[1].assigneeId = "theo";
    d.tasks[0].estimateHours = 1; d.tasks[1].estimateHours = 1;
    const heavy = { id: "x", title: "Huge", description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "maya", tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, dueDate: "2026-10-14", effortHours: 80 } as Task;
    expect(planWarnings(d, { tasks: [heavy], members, capacities: {}, today: TODAY }).some((w) => w.kind === "overloaded")).toBe(false);
  });
  it("deadline from ctx wins; no unassigned warning without people", () => {
    const w = planWarnings(draft(), { tasks: [], members: [], deadline: null, capacities: {}, today: TODAY });
    expect(w.map((x) => x.kind)).toEqual(["dependency_order"]);
  });
  it("past the caps says so", () => {
    const d = draft();
    d.tasks = Array.from({ length: 61 }, (_, i) => ({ ...d.tasks[2], key: `t${i}`, dependsOn: [] }));
    expect(planWarnings(d, { tasks: [], members: [], deadline: null }).map((w) => w.kind)).toEqual(["trimmed"]);
  });
});

describe("applyProjectPlan", () => {
  const project: Project = { id: "p-new", name: "Launch our mobile app", emoji: "🚀", color: "c", workspaceId: "ws" };
  function makeDeps(over: Partial<PlanApplyDeps> = {}) {
    const calls: string[] = [];
    let n = 0;
    const deps: PlanApplyDeps = {
      createProject: vi.fn(async (input) => { calls.push(`project:${input.name}`); return { ...project, ...input, id: "p-new" }; }),
      createSection: vi.fn(async (input) => { calls.push(`section:${input.name}:${input.position}`); return { id: `sec-${++n}`, ...input }; }),
      createTasks: vi.fn(async (tasks: Task[]) => { calls.push(`tasks:${tasks.length}`); return tasks; }),
      addDependency: vi.fn(async (a: string, b: string) => { calls.push(`dep:${a}->${b}`); }),
      deleteProject: vi.fn(async (id: string) => { calls.push(`deleteProject:${id}`); }),
      deleteTasks: vi.fn(async (ids: string[]) => { calls.push(`deleteTasks:${ids.length}`); }),
      deleteSection: vi.fn(async (id: string) => { calls.push(`deleteSection:${id}`); }),
      ...over,
    };
    return { deps, calls };
  }
  const draft = () => fallbackPlan({ goal: PLANNER_EXAMPLES[0], deadline: "2026-11-20" }, ctx());

  it("new: project with identity, sections, one batch with final ids, then every link — with progress", async () => {
    const { deps, calls } = makeDeps();
    const d = draft();
    const progress: string[] = [];
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", goal: "Launch our mobile app" }, deps, (p) => progress.push(`${p.step}:${p.done}/${p.total}`));
    expect(deps.createProject).toHaveBeenCalledWith({ name: d.name, emoji: "🚀", color: expect.stringContaining("oklch("), workspaceId: "ws", description: "Launch our mobile app" });
    expect(calls.filter((c) => c.startsWith("section:")).length).toBe(d.sections.length);
    expect(calls.filter((c) => c.startsWith("tasks:"))).toEqual([`tasks:${d.tasks.length}`]);
    expect(r.rolledBack).toBe(false);
    expect(r.failed).toEqual([]);
    expect(r.tasks).toHaveLength(d.tasks.length);
    expect(r.sections).toHaveLength(d.sections.length);
    expect(r.dependencies).toBe(planEdgeCount(d));
    // the tasks as made: uuids, in the project, dated, filed, not on anyone's day
    const batch = (deps.createTasks as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task[];
    for (const [i, t] of batch.entries()) {
      expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(t).toMatchObject({ projectId: "p-new", workspaceId: "ws", status: "todo", planToday: false });
      expect(t.sectionId).toMatch(/^sec-/);
      expect(isPlanDay(t.dueDate)).toBe(true);
      if (t.startDate) expect(t.startDate < t.dueDate!).toBe(true);
      if (i) expect(t.position!).toBeGreaterThan(batch[i - 1].position!);
    }
    const ms = batch.find((t) => t.isMilestone)!;
    expect(ms.effortHours).toBeUndefined();
    expect(ms.startDate).toBeUndefined();
    // the returned tasks carry the links that were made
    const linked = r.tasks.reduce((n, t) => n + t.dependencies.length, 0);
    expect(linked).toBe(r.dependencies);
    expect(progress[0]).toBe("project:0/1");
    expect(progress).toContain(`tasks:0/${d.tasks.length}`);
    expect(last(progress)).toBe("done:1/1");
    expect(progress).toContain(`dependencies:${r.dependencies}/${r.dependencies}`);
  });

  it("the host may give the tasks new ids: links follow them", async () => {
    const { deps } = makeDeps({ createTasks: vi.fn(async (tasks: Task[]) => tasks.map((t, i) => ({ ...t, id: `srv-${i}` }))) });
    const r = await applyProjectPlan(draft(), { workspaceId: "ws", currentUserId: "me" }, deps);
    const calls = (deps.addDependency as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    expect(calls.length).toBeGreaterThan(0);
    for (const [a, b] of calls) { expect(a).toMatch(/^srv-/); expect(b).toMatch(/^srv-/); }
    expect(r.tasks.every((t) => t.id.startsWith("srv-"))).toBe(true);
  });

  it("can't make the project: rejects, nothing made", async () => {
    const { deps } = makeDeps({ createProject: vi.fn(async () => { throw new Error("new row violates row-level security policy"); }) });
    const e = await applyProjectPlan(draft(), { workspaceId: "ws", currentUserId: "me" }, deps).catch((x) => x);
    expect(e).toBeInstanceOf(PlanApplyError);
    expect(e.step).toBe("project");
    expect(e.message).toMatch(/nothing was made/);
    expect(deps.createTasks).not.toHaveBeenCalled();
  });

  it("a section fails: the project is removed (to the bin), nothing else made", async () => {
    let n = 0;
    const { deps, calls } = makeDeps({ createSection: vi.fn(async (input) => { if (++n === 2) throw new Error("boom"); return { id: `sec-${n}`, ...input }; }) });
    const r = await applyProjectPlan(draft(), { workspaceId: "ws", currentUserId: "me" }, deps);
    expect(r.rolledBack).toBe(true);
    expect(r.failed).toHaveLength(1);
    expect(calls).toContain("deleteProject:p-new");
    expect(deps.createTasks).not.toHaveBeenCalled();
    expect(plannerResultMessage(r, "new")).toMatchObject({ tone: "error", text: expect.stringContaining("recycle bin") });
  });

  it("some tasks fail: the project and the ones that saved are removed", async () => {
    const createTasks = vi.fn(async (tasks: Task[]) => {
      const err = Object.assign(new Error("2 of 19 tasks couldn't be imported."), { saved: tasks.slice(2), failed: tasks.slice(0, 2).map((task) => ({ task, message: "x" })) });
      throw err;
    });
    const { deps, calls } = makeDeps({ createTasks });
    const d = draft();
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me" }, deps);
    expect(r.rolledBack).toBe(true);
    expect(r.failed).toEqual(d.tasks.slice(0, 2).map((t) => t.title));
    expect(calls).toContain("deleteProject:p-new");
    expect(calls).toContain(`deleteTasks:${d.tasks.length - 2}`);
    expect(deps.addDependency).not.toHaveBeenCalled();
    expect(r.tasks).toEqual([]);
  });

  it("the tidy-up itself fails: says the half-made project is still there (and isn't listed as a failure)", async () => {
    const { deps } = makeDeps({
      createTasks: vi.fn(async () => { throw new Error("offline"); }),
      deleteProject: vi.fn(async () => { throw new Error("no"); }),
    });
    const d = draft();
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me" }, deps);
    expect(r.rolledBack).toBe(false);
    expect(r.tasks).toEqual([]);
    expect(r.sections).toHaveLength(d.sections.length);
    expect(r.failed).toEqual(d.tasks.map((t) => t.title));
    expect(planLeftovers(r, "new")).toEqual({ project: r.project, sections: r.sections });
    expect(plannerResultMessage(r, "new")).toEqual({ tone: "error", text: expect.stringContaining("“Launch our mobile app in the App Store” is still in Projects with no tasks. Trying again removes it first") });
  });

  it("the tidy-up fails after some tasks saved: what stands is handed over and said", async () => {
    const { deps } = makeDeps({
      createTasks: vi.fn(async (tasks: Task[]) => { throw Object.assign(new Error("x"), { saved: tasks.slice(1), failed: [{ task: tasks[0], message: "x" }] }); }),
      deleteProject: vi.fn(async () => { throw new Error("no"); }),
    });
    const d = draft();
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me" }, deps);
    expect(r.rolledBack).toBe(false);
    expect(r.tasks).toHaveLength(d.tasks.length - 1);
    expect(r.failed).toEqual([d.tasks[0].title]);
    expect(planLeftovers(r, "new")).toBeNull(); // the host gets it like any plan that partly worked
    expect(plannerResultMessage(r, "new")).toMatchObject({ tone: "info", text: expect.stringMatching(/is ready: 18 tasks in 5 sections, but “?.+ couldn't be added\.$/) });
  });

  it("the host hands back no saved tasks: treated as a failure, not an empty project", async () => {
    const { deps, calls } = makeDeps({ createTasks: vi.fn(async () => []) });
    const r = await applyProjectPlan(draft(), { workspaceId: "ws", currentUserId: "me" }, deps);
    expect(r.rolledBack).toBe(true);
    expect(calls).toContain("deleteProject:p-new");
  });

  it("a link fails: reported, the plan stands", async () => {
    let n = 0;
    const { deps } = makeDeps({ addDependency: vi.fn(async () => { if (++n === 1) throw new Error("dup"); }) });
    const r = await applyProjectPlan(draft(), { workspaceId: "ws", currentUserId: "me" }, deps);
    expect(r.rolledBack).toBe(false);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatch(/^the link from “.+” to “.+”$/);
    expect(r.dependencies).toBe(planEdgeCount(draft()) - 1);
    expect(plannerResultMessage(r, "new").tone).toBe("info");
    expect(deps.deleteProject).not.toHaveBeenCalled();
  });

  it("append: reuses the project's sections by name, adds the rest after them, no project made", async () => {
    const { deps, calls } = makeDeps();
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx({ mode: "append" }));
    const target: Project = { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "c", workspaceId: "ws" };
    const existing: Section[] = [
      { id: "old-1", projectId: "p-launch", name: "product READINESS", position: 1700000000000 },
      { id: "other", projectId: "p-other", name: "Launch assets", position: 5 },
    ];
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", project: target, sections: existing }, deps);
    expect(deps.createProject).not.toHaveBeenCalled();
    const made = calls.filter((c) => c.startsWith("section:"));
    expect(made).toHaveLength(d.sections.length - 1);
    expect(made[0]).toBe(`section:${d.sections[0].name}:1700000000001`);
    const batch = (deps.createTasks as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task[];
    expect(batch.filter((t) => t.sectionId === "old-1").length).toBeGreaterThan(0);
    expect(batch.every((t) => t.projectId === "p-launch")).toBe(true);
    expect(r.project).toBe(target);
    expect(plannerResultMessage(r, "append")).toEqual({ tone: "success", text: `Added ${d.tasks.length} tasks to “Q3 Product Launch”.` });
  });

  it("append: a failed batch removes the tasks that saved, then the sections it added — never the project", async () => {
    const { deps, calls } = makeDeps({
      createTasks: vi.fn(async (tasks: Task[]) => { throw Object.assign(new Error("x"), { saved: tasks.slice(1), failed: [{ task: tasks[0], message: "x" }] }); }),
    });
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx({ mode: "append" }));
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", project, sections: [] }, deps);
    expect(r.rolledBack).toBe(true);
    expect(r.sections).toEqual([]);
    expect(r.tasks).toEqual([]);
    expect(calls).not.toContain("deleteProject:p-new");
    const made = calls.filter((c) => c.startsWith("section:")).length;
    expect(made).toBe(d.sections.length);
    // tasks first, then the sections, newest first
    const del = calls.filter((c) => c.startsWith("delete"));
    expect(del).toEqual([`deleteTasks:${d.tasks.length - 1}`, ...Array.from({ length: made }, (_, i) => `deleteSection:sec-${made - i}`)]);
    expect(plannerResultMessage(r, "append").text).toBe("Couldn't add the tasks to “Launch our mobile app”, so Kanbo removed what it had added and the project is as it was. Try again in a moment.");
  });

  it("append: nothing saved — the new sections still go; the reused ones are never touched", async () => {
    const { deps, calls } = makeDeps({ createTasks: vi.fn(async () => { throw new Error("offline"); }) });
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx({ mode: "append" }));
    const existing: Section[] = [{ id: "old-1", projectId: project.id, name: d.sections[1].name, position: 3 }];
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", project, sections: existing }, deps);
    expect(r.rolledBack).toBe(true);
    expect(deps.deleteTasks).not.toHaveBeenCalled();
    const removed = calls.filter((c) => c.startsWith("deleteSection:"));
    expect(removed).toHaveLength(d.sections.length - 1);
    expect(removed).not.toContain("deleteSection:old-1");
  });

  it("append: a failed add and then Try again with the same sections leaves each section once (the review's probe)", async () => {
    // a stand-in for the project's sections as the database has them
    const live = new Map<string, Section>([["old-1", { id: "old-1", projectId: project.id, name: "Discovery", position: 1 }]]);
    let n = 0;
    let fail = true;
    const deps: PlanApplyDeps = {
      createProject: vi.fn(async () => { throw new Error("not in append"); }),
      createSection: vi.fn(async (i) => { const sec = { id: `sec-${++n}`, ...i }; live.set(sec.id, sec); return sec; }),
      createTasks: vi.fn(async (tasks: Task[]) => { if (fail) throw Object.assign(new Error("2 of N failed"), { saved: tasks.slice(0, 3), failed: tasks.slice(3).map((task) => ({ task, message: "rls" })) }); return tasks; }),
      addDependency: vi.fn(async () => {}),
      deleteTasks: vi.fn(async () => {}),
      deleteSection: vi.fn(async (id: string) => { live.delete(id); }),
    };
    const d = fallbackPlan({ goal: "Redesign the marketing website with a new pricing page" }, ctx({ mode: "append", existingSections: ["Discovery"], existingTitles: [] }));
    const sectionsProp = [...live.values()]; // the host's out-of-date prop, the same both times
    const r1 = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", project, sections: sectionsProp }, deps);
    expect(r1.rolledBack).toBe(true);
    expect([...live.keys()]).toEqual(["old-1"]); // nothing left behind
    fail = false;
    const r2 = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", project, sections: sectionsProp }, deps);
    expect(r2.rolledBack).toBe(false);
    const names = [...live.values()].map((s) => s.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length); // none twice
    expect(names.length).toBe(1 + r2.sections.length);
  });

  it("append: a section that won't go is left, said and reused next time — never made twice", async () => {
    const { deps, calls } = makeDeps({
      createTasks: vi.fn(async () => { throw new Error("offline"); }),
      deleteSection: vi.fn(async (id: string) => { if (id === "sec-2") throw new Error("offline"); calls.push(`deleteSection:${id}`); }),
    });
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx({ mode: "append" }));
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", project, sections: [] }, deps);
    expect(r.rolledBack).toBe(false);
    expect(r.tasks).toEqual([]);
    expect(r.sections.map((s) => s.id)).toEqual(["sec-2"]);
    expect(r.failed).toEqual(d.tasks.map((t) => t.title)); // what's left isn't a failure to make
    const left = planLeftovers(r, "append")!;
    expect(left).toEqual({ project: null, sections: r.sections });
    expect(plannerResultMessage(r, "append").text).toBe(`Couldn't add the tasks to “Launch our mobile app”, and Kanbo couldn't remove the new section “${d.sections[1].name}” it had added, so it's still there, empty. Trying again won't add it twice.`);
    // it still won't go: the next try reuses it by name
    const still = await removePlanLeftovers(left, deps);
    expect(still).toEqual(left);
    const before = (deps.createSection as ReturnType<typeof vi.fn>).mock.calls.length;
    (deps.createTasks as ReturnType<typeof vi.fn>).mockImplementation(async (tasks: Task[]) => tasks);
    const r2 = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", project, sections: still!.sections }, deps);
    const madeAgain = (deps.createSection as ReturnType<typeof vi.fn>).mock.calls.slice(before).map((c) => c[0].name);
    expect(madeAgain).not.toContain(d.sections[1].name);
    expect(madeAgain).toHaveLength(d.sections.length - 1);
    expect(r2.tasks.some((t) => t.sectionId === "sec-2")).toBe(true);
  });

  it("append: tasks that won't go keep their sections, and are handed over as what stands", async () => {
    const { deps, calls } = makeDeps({
      createTasks: vi.fn(async (tasks: Task[]) => { throw Object.assign(new Error("x"), { saved: tasks.slice(1), failed: [{ task: tasks[0], message: "x" }] }); }),
      deleteTasks: vi.fn(async () => { throw new Error("offline"); }),
    });
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx({ mode: "append" }));
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", project, sections: [] }, deps);
    expect(r.rolledBack).toBe(false);
    expect(r.tasks).toHaveLength(d.tasks.length - 1);
    expect(r.sections).toHaveLength(d.sections.length);
    expect(calls.some((c) => c.startsWith("deleteSection:"))).toBe(false);
    expect(plannerResultMessage(r, "append").tone).toBe("info");
  });

  it("append without a way to remove sections: they're left and said, not claimed as undone", async () => {
    const { deps } = makeDeps({ createTasks: vi.fn(async () => { throw new Error("offline"); }), deleteSection: undefined });
    const d = fallbackPlan({ goal: PLANNER_EXAMPLES[0] }, ctx({ mode: "append" }));
    const r = await applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me", project, sections: [] }, deps);
    expect(r.rolledBack).toBe(false);
    expect(r.sections).toHaveLength(d.sections.length);
    expect(plannerResultMessage(r, "append").text).toMatch(new RegExp(`couldn't remove the ${d.sections.length} new sections \\(“.+” and 2 more\\) it had added, so they're still there, empty`));
  });

  it("nothing to make is an error, not an empty project", async () => {
    const { deps } = makeDeps();
    const d = { ...draft(), tasks: [] };
    await expect(applyProjectPlan(d, { workspaceId: "ws", currentUserId: "me" }, deps)).rejects.toBeInstanceOf(PlanApplyError);
    expect(deps.createProject).not.toHaveBeenCalled();
  });
});

describe("wiring helpers", () => {
  it("leftovers: merged across tries, removed before the next one", async () => {
    const p: Project = { id: "p1", name: "P", emoji: "", color: "c", workspaceId: "ws" };
    const a = { project: null, sections: [{ id: "s1", projectId: "p1", name: "A" }] };
    const b = { project: null, sections: [{ id: "s1", projectId: "p1", name: "A" }, { id: "s2", projectId: "p1", name: "B" }] };
    expect(mergePlanLeftovers(null, null)).toBeNull();
    expect(mergePlanLeftovers(a, null)).toBe(a);
    expect(mergePlanLeftovers(a, b)!.sections.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(mergePlanLeftovers(null, { project: p, sections: [] })!.project).toBe(p);
    const deleteProject = vi.fn(async () => {});
    const deleteSection = vi.fn(async (id: string) => { if (id === "s2") throw new Error("no"); });
    const base = { createProject: vi.fn(), createSection: vi.fn(), createTasks: vi.fn(), addDependency: vi.fn() } as unknown as PlanApplyDeps;
    expect(await removePlanLeftovers({ project: p, sections: b.sections }, { ...base, deleteProject })).toBeNull();
    expect(deleteProject).toHaveBeenCalledWith("p1");
    expect(await removePlanLeftovers({ project: p, sections: [] }, { ...base, deleteProject: vi.fn(async () => { throw new Error("no"); }) })).toEqual({ project: p, sections: [] });
    expect(await removePlanLeftovers({ project: p, sections: [] }, base)).toEqual({ project: p, sections: [] });
    expect(await removePlanLeftovers(b, { ...base, deleteSection })).toEqual({ project: null, sections: [b.sections[1]] });
    expect(await removePlanLeftovers(b, base)).toEqual(b);
    expect(leftSections([{ name: "Design" }])).toBe("the new section “Design”");
    expect(leftSections([{ name: "A" }, { name: "B" }])).toBe("the 2 new sections (“A”, “B”)");
  });

  it("plannerDeps: the store's paths as the signed-in person; a description is best-effort; deletes reported", async () => {
    const calls: string[] = [];
    const store = {
      createProject: vi.fn(async (i: { name: string; workspaceId: string | null }, uid: string) => { calls.push(`p:${i.name}:${uid}`); return { id: "p1", emoji: "", color: "c", ...i }; }),
      updateProject: vi.fn(async () => { throw new Error("no description column yet"); }),
      createSection: vi.fn(async (i: { projectId: string; name: string }, uid: string) => { calls.push(`s:${i.name}:${uid}`); return { id: "s1", ...i }; }),
      createTasksBatch: vi.fn(async (ts: Task[], uid: string) => { calls.push(`t:${ts.length}:${uid}`); return ts; }),
      addDependency: vi.fn(async (a: string, b: string) => { calls.push(`d:${a}>${b}`); }),
      deleteProject: vi.fn(async () => {}),
      deleteTask: vi.fn(async (id: string) => { if (id === "bad") throw new Error("no"); }),
      deleteSection: vi.fn(async () => {}),
    };
    const deps = plannerDeps(store, "me");
    const p = await deps.createProject({ name: "X", emoji: "", color: "c", workspaceId: "ws", description: "Goal" });
    expect(p.id).toBe("p1");
    expect(store.updateProject).toHaveBeenCalledWith("p1", { description: "Goal" });
    await deps.createSection({ projectId: "p1", workspaceId: "ws", name: "S" });
    await deps.createTasks([{ id: "a" } as Task]);
    await deps.addDependency("a", "b");
    expect(calls).toEqual(["p:X:me", "s:S:me", "t:1:me", "d:a>b"]);
    await deps.deleteTasks!(["x", "y"]);
    expect(store.deleteTask).toHaveBeenCalledTimes(2);
    await expect(deps.deleteTasks!(["x", "bad"])).rejects.toThrow("no");
    await deps.deleteSection!("s1");
    expect(store.deleteSection).toHaveBeenCalledWith("s1");
  });
  it("plannerPeople: active members with titles, guests marked; personal is just you", () => {
    const rows = [
      { workspaceId: "ws", userId: "maya", role: "member", status: "active", title: "Designer" },
      { workspaceId: "ws", userId: "idris", role: "guest", status: "active" },
      { workspaceId: "ws", userId: null, role: "member", status: "invited", email: "new@x.test" },
      { workspaceId: "ws", userId: "theo", role: "member", status: "invited" },
      { workspaceId: "ws", userId: "zed", role: "admin", status: "active", name: "Zed Unknown", title: " " },
      { workspaceId: "other", userId: "me", role: "owner", status: "active" },
    ];
    const r = plannerPeople(members, rows, "ws", "me");
    expect(r.members.map((m) => [m.id, m.title])).toEqual([["maya", "Designer"], ["idris", undefined], ["zed", undefined]]);
    expect(r.members[2].name).toBe("Zed Unknown");
    expect(r.guestIds).toEqual(["idris"]);
    expect(plannerPeople(members, rows, null, "me")).toEqual({ members: [members[0]], guestIds: [] });
  });
});
