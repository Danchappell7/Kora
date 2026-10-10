import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocBlock, Project, Task } from "../data/types";
import {
  SAMPLE_KEYS, TOUR_SAMPLE_DOC_TITLE, TourSampleError, addWorkingDays, buildTourSample, deleteTourSample, tourSamplePlan, type TourSampleDeps,
} from "./onboardingSample";

// Friday 9 October 2026, 10:00 in London
const FRIDAY = new Date("2026-10-09T10:00:00+01:00");
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(FRIDAY); });
afterEach(() => { vi.useRealTimers(); });

const ctx = { today: FRIDAY, currentUserId: "me", workspaceId: null };

describe("working days", () => {
  it("skips the weekend", () => {
    expect(addWorkingDays(FRIDAY, 0)).toBe("2026-10-09");
    expect(addWorkingDays(FRIDAY, 1)).toBe("2026-10-12");
    expect(addWorkingDays(FRIDAY, 3)).toBe("2026-10-14");
    expect(addWorkingDays(new Date(2026, 9, 10), 1)).toBe("2026-10-12"); // from a Saturday
    // across the clocks going back (25 October 2026)
    expect(addWorkingDays(new Date(2026, 9, 23), 1)).toBe("2026-10-26");
  });
});

describe("the sample plan", () => {
  const plan = tourSamplePlan(ctx);
  const top = plan.tasks.filter((t) => !t.parentId);
  const subs = plan.tasks.filter((t) => t.parentId);

  it("is pure: the same plan every time", () => {
    expect(tourSamplePlan(ctx)).toEqual(plan);
  });
  it("“Kanbo tour”, with its own identity", () => {
    expect(plan.project).toMatchObject({ name: "Kanbo tour", emoji: "🧭", color: "oklch(0.74 0.14 230)" });
    expect(plan.project.description).toMatch(/Remove it from Help/);
  });
  it("six tasks: one with three sub-tasks, a dependency pair, approvals, the doc, capture", () => {
    expect(top.map((t) => t.title)).toEqual([
      "Start here: open this task", "Draft the plan", "Share the plan", "Get a sign-off", "Read the project doc", "Capture a task with Q",
    ]);
    expect(subs).toHaveLength(3);
    expect(new Set(subs.map((t) => t.parentId))).toEqual(new Set([SAMPLE_KEYS.start]));
    expect(plan.dependencies).toEqual([[SAMPLE_KEYS.share, SAMPLE_KEYS.draft]]);
    expect(plan.tasks[0].id).toBe(SAMPLE_KEYS.start);
    expect(new Set(plan.tasks.map((t) => t.id)).size).toBe(plan.tasks.length);
  });
  it("assigned to you, in the workspace, with dates in working days from today", () => {
    expect(plan.tasks.every((t) => t.assigneeId === "me" && t.workspaceId === null && t.status === "todo")).toBe(true);
    const due = Object.fromEntries(top.map((t) => [t.id, t.dueDate]));
    expect(due).toEqual({
      [SAMPLE_KEYS.start]: "2026-10-09", [SAMPLE_KEYS.draft]: "2026-10-12", [SAMPLE_KEYS.share]: "2026-10-13",
      [SAMPLE_KEYS.signoff]: "2026-10-14", [SAMPLE_KEYS.doc]: "2026-10-12", [SAMPLE_KEYS.capture]: "2026-10-09",
    });
    // the dependency's order holds: what waits is due after what it waits on
    expect(due[SAMPLE_KEYS.share]! > due[SAMPLE_KEYS.draft]!).toBe(true);
  });
  it("in Personal, the approval task explains instead of asking; in a team with a reviewer it says it was sent", () => {
    const personal = plan.tasks.find((t) => t.id === SAMPLE_KEYS.signoff)!.description;
    expect(personal).toMatch(/Request approval/);
    expect(personal).toMatch(/no one to ask/);
    const team = tourSamplePlan({ ...ctx, workspaceId: "ws", reviewerIds: ["sana"] }).tasks.find((t) => t.id === SAMPLE_KEYS.signoff)!.description;
    expect(team).toMatch(/sent for approval/);
    expect(tourSamplePlan({ ...ctx, workspaceId: "ws" }).tasks.find((t) => t.id === SAMPLE_KEYS.signoff)!.description).toMatch(/no one to ask/);
  });
  it("the doc: its checklist lines are the dependency pair (live), and the doc task points at it", () => {
    expect(plan.doc!.title).toBe(TOUR_SAMPLE_DOC_TITLE);
    const linked = plan.doc!.body.filter((b) => b.taskId).map((b) => b.taskId);
    expect(linked).toEqual([SAMPLE_KEYS.draft, SAMPLE_KEYS.share]);
    expect(new Set(plan.doc!.body.map((b) => b.id)).size).toBe(plan.doc!.body.length);
    expect(plan.tasks.find((t) => t.id === SAMPLE_KEYS.doc)!.description).toContain(TOUR_SAMPLE_DOC_TITLE);
    expect(plan.doc!.body.every((b) => b.type === "divider" ? !b.spans : (b.spans?.length ?? 0) > 0)).toBe(true);
  });
});

describe("making it", () => {
  const deps = (over: Partial<TourSampleDeps> = {}) => {
    const made: { tasks: Task[]; deps: [string, string][]; doc: { projectId: string; title: string; body: DocBlock[] } | null; approvals: unknown[] } = { tasks: [], deps: [], doc: null, approvals: [] };
    const d: TourSampleDeps = {
      createProject: vi.fn(async (input) => ({ id: "proj", ...input } as Project)),
      createTasks: vi.fn(async (ts: Task[]) => { made.tasks = ts; return ts.map((t) => ({ ...t })); }),
      addDependency: vi.fn(async (a: string, b: string) => { made.deps.push([a, b]); }),
      createDoc: vi.fn(async (projectId: string, title: string, body: DocBlock[]) => { made.doc = { projectId, title, body }; return { id: "doc" }; }),
      requestApproval: vi.fn(async (...a: unknown[]) => { made.approvals.push(a); }),
      deleteProject: vi.fn(async () => {}),
      ...over,
    };
    return { d, made };
  };

  it("fresh ids every time, sub-tasks under their parent, links with the real ids, recorded in plan order", async () => {
    const { d, made } = deps();
    const sample = await buildTourSample(d, ctx);
    expect(d.createProject).toHaveBeenCalledWith(expect.objectContaining({ name: "Kanbo tour", workspaceId: null, description: expect.any(String) }));
    const ids = made.tasks.map((t) => t.id);
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(made.tasks.every((t) => t.projectId === "proj")).toBe(true);
    const start = made.tasks[0];
    expect(made.tasks.filter((t) => t.parentId === start.id)).toHaveLength(3);
    const byTitle = (s: string) => made.tasks.find((t) => t.title === s)!.id;
    expect(made.deps).toEqual([[byTitle("Share the plan"), byTitle("Draft the plan")]]);
    expect(made.doc!.body.filter((b) => b.taskId).map((b) => b.taskId)).toEqual([byTitle("Draft the plan"), byTitle("Share the plan")]);
    expect(made.approvals).toEqual([]); // Personal: no request
    expect(sample).toEqual({ projectId: "proj", taskIds: ids, docId: "doc", createdAt: FRIDAY.toISOString() });
    const again = await buildTourSample(deps().d, ctx);
    expect(again.taskIds.some((id) => ids.includes(id))).toBe(false);
  });
  it("a real approval request only in a team workspace, with a reviewer (the first)", async () => {
    const { d, made } = deps();
    await buildTourSample(d, { ...ctx, workspaceId: "ws", reviewerIds: ["sana", "theo"] });
    const signoff = made.tasks.find((t) => t.title === "Get a sign-off")!.id;
    expect(made.approvals).toEqual([[signoff, ["sana"], expect.stringMatching(/Kanbo tour/)]]);
    expect(made.tasks.every((t) => t.workspaceId === "ws")).toBe(true);
  });
  it("matches saved copies the host renamed, by position", async () => {
    const { d, made } = deps({ createTasks: vi.fn(async (ts: Task[]) => ts.map((t, i) => ({ ...t, id: `saved-${i}` }))) });
    const sample = await buildTourSample(d, ctx);
    expect(sample.taskIds[0]).toBe("saved-0");
    expect(d.addDependency).toHaveBeenCalledWith("saved-5", "saved-4");
    expect(made.doc!.body.filter((b) => b.taskId).map((b) => b.taskId)).toEqual(["saved-4", "saved-5"]);
  });
  it("the extras are best-effort: a failed link, doc or request leaves them out", async () => {
    const boom = async () => { throw new Error("nope"); };
    const { d } = deps({ addDependency: vi.fn(boom), createDoc: vi.fn(boom), requestApproval: vi.fn(boom) });
    const s = await buildTourSample(d, { ...ctx, workspaceId: "ws", reviewerIds: ["sana"] });
    expect(s.docId).toBeNull();
    expect(s.taskIds).toHaveLength(9);
    const { d: noDoc } = deps({ createDoc: undefined });
    expect((await buildTourSample(noDoc, ctx)).docId).toBeNull();
  });
  it("no project: nothing made, a readable error", async () => {
    const { d } = deps({ createProject: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(buildTourSample(d, ctx)).rejects.toBeInstanceOf(TourSampleError);
    expect(d.createTasks).not.toHaveBeenCalled();
  });
  it("tasks didn't land: the project is taken away again", async () => {
    const { d } = deps({ createTasks: vi.fn(async (ts: Task[]) => ts.slice(0, 2)) });
    await expect(buildTourSample(d, ctx)).rejects.toThrow(/taken away again/);
    expect(d.deleteProject).toHaveBeenCalledWith("proj");
  });
});

describe("removing it", () => {
  it("deletes the project (it goes to the bin with its tasks and doc); already gone counts as removed", async () => {
    const del = vi.fn(async () => {});
    const d = { deleteProject: del } as unknown as TourSampleDeps;
    await deleteTourSample(d, { sample: { projectId: "p", taskIds: [], createdAt: "c" } });
    expect(del).toHaveBeenCalledWith("p");
    await deleteTourSample(d, {});
    expect(del).toHaveBeenCalledTimes(1);
    const gone = { deleteProject: vi.fn(async () => { throw Object.assign(new Error("That project wasn't deleted."), { code: "not_deleted" }); }) } as unknown as TourSampleDeps;
    await expect(deleteTourSample(gone, { sample: { projectId: "p", taskIds: [], createdAt: "c" } })).resolves.toBeUndefined();
    const offline = { deleteProject: vi.fn(async () => { throw new Error("Failed to fetch"); }) } as unknown as TourSampleDeps;
    await expect(deleteTourSample(offline, { sample: { projectId: "p", taskIds: [], createdAt: "c" } })).rejects.toThrow();
  });
});
