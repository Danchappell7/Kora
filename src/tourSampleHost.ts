/* ============================================================
   KANBO — the "Kanbo tour" sample through App's own paths (0048 · u1).
   Help › Try the sample project (and its Remove) load this: the store
   calls that make the project, its tasks, the dependency and the doc
   — shown at once, and kept on screen through any reload already under
   way — and lib/tourSample's create / remove. None of it rides in the
   first download; App hands over what it holds through SampleHost.
   ============================================================ */
import type { Dispatch, SetStateAction } from "react";
import type { OnboardingState, Project, Task } from "./data/types";
import { store } from "./data/store";
import { reportError } from "./lib/monitoring";
import { newTaskId } from "./lib/taskOps";
import type { TourSampleDeps } from "./lib/onboardingSample";
import { createTourSample, removeTourSample } from "./lib/tourSample";

/** What App lends the sample: who's signed in, what's on screen, and its own bookkeeping. */
export interface SampleHost {
  me: () => string;
  projects: () => Project[];
  tasks: () => Task[] | null;
  applyProjects: (next: Project[]) => void;
  setTasks: Dispatch<SetStateAction<Task[] | null>>;
  noteCreated: (id: string) => void;
  noteDelete: (ids: string[]) => void;
  dropPending: (ids: Set<string>) => void;
  /** rows just made, kept on screen through a reload that began before they were saved */
  holdPending: (saved: Task[]) => void;
  /** the sample project is going: leave its page if that's where you are */
  leaveProject: (projectId: string) => void;
}

/** Made in Personal through the store, shown at once, kept through any reload already under way. */
function sampleDeps(h: SampleHost): TourSampleDeps {
  return {
    createProject: async (input) => {
      const p = await store.createProject({ name: input.name, emoji: input.emoji, color: input.color, workspaceId: input.workspaceId }, h.me());
      h.noteCreated(p.id);
      let full: Project = p;
      if (input.description) {
        full = { ...p, description: input.description };
        await store.updateProject(p.id, { description: input.description }).catch((e) => reportError(e, { op: "sampleDescription" }));
      }
      h.applyProjects([...h.projects().filter((x) => x.id !== p.id), full]);
      return full;
    },
    createTasks: async (rows) => {
      const saved = await store.createTasksBatch(rows, h.me());
      h.holdPending(saved);
      h.setTasks((ts) => (ts ? [...saved.filter((t) => !ts.some((x) => x.id === t.id)), ...ts] : saved));
      return saved;
    },
    addDependency: async (taskId, dependsOn) => {
      await store.addDependency(taskId, dependsOn);
      h.setTasks((ts) => ts && ts.map((t) => (t.id === taskId ? { ...t, dependencies: [...new Set([...(t.dependencies ?? []), dependsOn])] } : t)));
    },
    createDoc: async (projectId, title, body) => {
      const { saveProjectDoc } = await import("./lib/docs");
      const r = await saveProjectDoc({ id: newTaskId(), projectId, title, body, baseUpdatedAt: null });
      return { id: r.doc.id };
    },
    deleteProject: async (projectId) => {
      await store.deleteProject(projectId);
      h.leaveProject(projectId);
      const gone = new Set((h.tasks() ?? []).filter((t) => t.projectId === projectId).map((t) => t.id));
      h.applyProjects(h.projects().filter((p) => p.id !== projectId));
      h.setTasks((ts) => ts && ts.filter((t) => !gone.has(t.id)));
      h.noteDelete([...gone]); h.dropPending(gone);
    },
  };
}

/** Make the sample (in Personal) and record it: the new onboarding state. */
export function makeTourSample(h: SampleHost, ctx: { today: Date; current: OnboardingState }): Promise<OnboardingState> {
  return createTourSample(sampleDeps(h), { today: ctx.today, currentUserId: h.me(), workspaceId: null, current: ctx.current });
}

/** Take it away (to the recycle bin) and forget it: the new onboarding state. */
export function takeTourSampleAway(h: SampleHost, state: OnboardingState): Promise<OnboardingState> {
  return removeTourSample(sampleDeps(h), state);
}
