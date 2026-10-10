/* createTourSample against a database (lib/supabase mocked): one sample at a time, and nothing left
   behind when the record can't be saved. (onboarding.test.ts covers demo mode, with no database.) */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingState, Project, Task } from "../data/types";

const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  from: vi.fn(),
}));
vi.mock("./supabase", () => ({
  supabase: {
    rpc: db.rpc,
    from: (table: string) => { db.from(table); return { select: () => ({ eq: () => ({ maybeSingle: db.maybeSingle }) }) }; },
  },
}));

import { createTourSample, type TourSampleDeps } from "./onboarding";

const NOW = new Date("2026-10-09T10:00:00+01:00");
const ctx = (current?: OnboardingState) => ({ today: NOW, currentUserId: "me", workspaceId: null, current });
const fakeDeps = () => {
  const deps: TourSampleDeps = {
    createProject: vi.fn(async (input) => ({ id: "proj-1", ...input } as Project)),
    createTasks: vi.fn(async (ts: Task[]) => ts),
    addDependency: vi.fn(async () => {}),
    createDoc: vi.fn(async () => ({ id: "doc-1" })),
    deleteProject: vi.fn(async () => {}),
  };
  return deps;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db.rpc.mockReset(); db.maybeSingle.mockReset(); db.from.mockReset();
  db.maybeSingle.mockResolvedValue({ data: { onboarding: { v: 1 } }, error: null });
  db.rpc.mockImplementation(async (_fn: string, args: { p_patch: OnboardingState }) => ({ data: { v: 1, ...args.p_patch }, error: null }));
});
afterEach(() => { vi.useRealTimers(); });

describe("making the sample, with a database", () => {
  it("records it with merge_onboarding and answers the stored state", async () => {
    const deps = fakeDeps();
    const state = await createTourSample(deps, ctx({ v: 1 }));
    expect(db.from).toHaveBeenCalledWith("profiles");
    expect(db.rpc).toHaveBeenCalledWith("merge_onboarding", { p_patch: { sample: expect.objectContaining({ projectId: "proj-1" }) } });
    expect(state.sample).toMatchObject({ projectId: "proj-1", docId: "doc-1", createdAt: NOW.toISOString() });
    expect(deps.deleteProject).not.toHaveBeenCalled();
  });

  it("the record can't be saved: the project is taken away again, and the error is readable", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "TypeError: Failed to fetch" } });
    const deps = fakeDeps();
    const err = await createTourSample(deps, ctx({})).catch((e: unknown) => e) as Error & { failure?: string };
    expect(deps.createProject).toHaveBeenCalledTimes(1);
    expect(deps.deleteProject).toHaveBeenCalledWith("proj-1");
    expect(err.name).toBe("TourSampleError");
    expect(err.message).toBe("Couldn't finish the sample project, so it was taken away again. Check your connection and try again.");
    expect(err.failure).toBe("network");
  });

  it("…and when taking it away fails too, it says where to find it", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "permission denied for table profiles", code: "42501" } });
    const deps = fakeDeps();
    deps.deleteProject = vi.fn(async () => { throw new Error("Failed to fetch"); });
    const err = await createTourSample(deps, ctx({})).catch((e: unknown) => e) as Error & { failure?: string };
    expect(deps.deleteProject).toHaveBeenCalledWith("proj-1");
    expect(err.name).toBe("TourSampleError");
    expect(err.message).toMatch(/If “Kanbo tour” shows in your projects, you can delete it there\./);
    expect(err.failure).toBe("not_allowed");
  });

  it("one already recorded here: that's the answer, and nothing new is made", async () => {
    const deps = fakeDeps();
    const current: OnboardingState = { v: 1, sample: { projectId: "proj-0", taskIds: ["t"], createdAt: "c" } };
    expect(await createTourSample(deps, ctx(current))).toBe(current);
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("one already recorded in the database (another tab made it): that's the answer, and nothing new is made", async () => {
    db.maybeSingle.mockResolvedValue({ data: { onboarding: { v: 1, tour: { step: null, done: true }, sample: { projectId: "proj-0", taskIds: ["t"], docId: null, createdAt: "c" } } }, error: null });
    const deps = fakeDeps();
    const state = await createTourSample(deps, ctx({ v: 1 }));
    expect(state.sample?.projectId).toBe("proj-0");
    expect(state.tour).toEqual({ step: null, done: true });
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("the stored record can't be read (offline, no 0048 yet): it goes ahead with what the app shows", async () => {
    db.maybeSingle.mockResolvedValue({ data: null, error: { message: "column profiles.onboarding does not exist" } });
    const deps = fakeDeps();
    const state = await createTourSample(deps, ctx({ v: 1 }));
    expect(deps.createProject).toHaveBeenCalledTimes(1);
    expect(state.sample?.projectId).toBe("proj-1");
    db.maybeSingle.mockRejectedValue(new TypeError("Failed to fetch"));
    expect((await createTourSample(fakeDeps(), ctx({ v: 1 }))).sample?.projectId).toBe("proj-1");
  });
});
