/* ============================================================
   KANBO — setting up a business pack, and taking it back.
   applyPackPlan creates a PackPlan (lib/packPlan) through the same
   creates as everything else (the caller hands them over: the
   store's, bound to the signed-in person, work in the demo too):
     1. the projects, with their sections, starter tasks, request
        forms and rules (templates applyWorkspacePlan);
     2. their docs;
     3. the goals, each owned by whoever used the pack, with their key
        results under them and links to the work that serves them;
     4. the portfolios (a holding company's business that's already in
        Kanbo: in Personal, with that business's own projects);
     5. the workspace's update day.
   A step that fails is named in `failed` and the rest carry on, as
   for a team template. A step whose migration isn't run yet is named
   in `notYet` instead (0052: goals go in without owners, quarters or
   links; 0047 docs; 0053 the update day), never a failure.
   undoAppliedPack takes all of it back (the update day goes back to
   what it was); a project goes with its tasks and sections, into the
   recycle bin, as any deleted project does.
   ============================================================ */
import type {
  AutomationRule, DocBlock, FormDef, Goal, GoalLink, GoalLinkKind, GoalPatch, GoalStatus, Portfolio, Project, UpdateRhythm,
} from "../data/types";
import { applyWorkspacePlan, type AppliedPlan, type TemplateApplyDeps } from "./templates";
import type { PackPlan } from "./packPlan";

/** Something a pack sets up whose migration isn't in yet. */
export type PackFeature = "goalsV2" | "goalLinks" | "docs" | "updateDay";

export interface PackDocRef { id: string; projectId: string; title: string; icon?: string | null }

export interface PackApplyDeps extends TemplateApplyDeps {
  createGoal(input: { workspaceId: string | null; name: string; target?: number; current?: number; unit?: string; due?: string; status?: GoalStatus; extra?: GoalPatch }): Promise<Goal>;
  addGoalLink?(input: { goalId: string; workspaceId: string | null; kind: GoalLinkKind; targetId: string }): Promise<GoalLink>;
  createPortfolio(input: { workspaceId: string | null; name: string; projectIds?: string[] }): Promise<Portfolio>;
  /** a portfolio's description and look (0054; before it, they're left off) */
  updatePortfolio?(id: string, patch: { description?: string | null; emoji?: string | null; color?: string | null }): Promise<void>;
  createDoc?(input: { projectId: string; title: string; icon: string; body: DocBlock[] }): Promise<PackDocRef>;
  setUpdateRhythm?(workspaceId: string, rhythm: UpdateRhythm | null): Promise<void>;
}

/** A form the pack made that comes with a QR poster. */
export interface PackPoster { formId: string; projectId: string; projectName: string; formName: string; headline: string; line?: string }

export interface AppliedPack extends AppliedPlan {
  goals: Goal[];
  links: GoalLink[];
  portfolios: Portfolio[];
  docs: PackDocRef[];
  /** the update day it set, and the one it replaced (Undo puts that back) */
  rhythm: { workspaceId: string; before: UpdateRhythm | null; after: UpdateRhythm } | null;
  posters: PackPoster[];
  notYet: PackFeature[];
}

/** A missing table, column or function: the migration that brings it isn't run yet. */
export function isNotYet(e: unknown): boolean {
  const err = e as { code?: string; message?: string; status?: number } | null;
  const code = String(err?.code ?? "");
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(code)
    || /does not exist|schema cache|could not find the (function|table|column)/i.test(String(err?.message ?? ""));
}

/** Create everything in the plan, in `workspaceId`, for `me` (who owns the goals and gets the tasks). */
export async function applyPackPlan(plan: PackPlan, ctx: { workspaceId: string | null; me: string; rhythmBefore?: UpdateRhythm | null }, deps: PackApplyDeps): Promise<AppliedPack> {
  // which project each plan key became (applyWorkspacePlan makes them in the plan's order, one at a time)
  const idByKey: Record<string, string> = {};
  const nameById: Record<string, string> = {};
  let next = 0;
  const base = await applyWorkspacePlan(plan, { workspaceId: ctx.workspaceId, assigneeId: ctx.me }, {
    ...deps,
    createProject: async (input) => {
      const key = plan.projects[next++]?.key;
      const p: Project = await deps.createProject(input);
      if (key) idByKey[key] = p.id;
      nameById[p.id] = p.name;
      return p;
    },
  });
  const out: AppliedPack = { ...base, goals: [], links: [], portfolios: [], docs: [], rhythm: null, posters: [], notYet: [] };
  const notYet = (f: PackFeature) => { if (!out.notYet.includes(f)) out.notYet.push(f); };
  const wsOf = (projectId: string) => base.projects.find((p) => p.id === projectId)?.workspaceId ?? ctx.workspaceId;

  // the QR posters, for the forms that were made
  for (const poster of plan.posters) {
    const projectId = idByKey[poster.projectKey];
    const form = projectId ? base.forms.find((f: FormDef) => f.projectId === projectId) : undefined;
    if (form) out.posters.push({ formId: form.id, projectId, projectName: nameById[projectId] ?? "", formName: form.name, headline: poster.headline, ...(poster.line ? { line: poster.line } : {}) });
  }

  // docs
  if (deps.createDoc) {
    for (const d of plan.docs) {
      const projectId = idByKey[d.projectKey];
      if (!projectId) continue;
      if (out.notYet.includes("docs")) break;
      try { out.docs.push(await deps.createDoc({ projectId, title: d.title, icon: d.icon, body: d.body })); }
      catch (e) { if (isNotYet(e)) notYet("docs"); else out.failed.push(d.title); }
    }
  }

  // goals: an objective, then its key results under it (0052's fields while they take)
  let v2 = plan.goalsV2;
  const makeGoal = async (name: string, v2Extra: GoalPatch, v1Extra: GoalPatch, nums: { target?: number; unit?: string; due: string }): Promise<Goal> => {
    const input = { workspaceId: ctx.workspaceId, name, status: "on_track" as GoalStatus, due: nums.due, ...(nums.unit ? { unit: nums.unit } : {}), ...(typeof nums.target === "number" ? { target: nums.target } : {}) };
    if (v2) {
      try { return await deps.createGoal({ ...input, extra: { ...v1Extra, ...v2Extra } }); }
      catch (e) { if (!isNotYet(e)) throw e; v2 = false; notYet("goalsV2"); }
    }
    return deps.createGoal({ ...input, extra: v1Extra });
  };
  const link = async (goal: Goal, keys: readonly string[]) => {
    if (!v2 || !deps.addGoalLink) return;
    for (const key of keys) {
      const targetId = idByKey[key];
      if (!targetId || out.notYet.includes("goalLinks")) continue;
      try { out.links.push(await deps.addGoalLink({ goalId: goal.id, workspaceId: ctx.workspaceId, kind: "project", targetId })); }
      catch (e) { if (isNotYet(e)) notYet("goalLinks"); else out.failed.push(`${goal.name} › ${nameById[targetId] ?? key}`); }
    }
  };
  const look = (x: { icon?: string; direction?: GoalPatch["direction"]; startValue?: number }): GoalPatch => ({
    ...(x.icon ? { icon: x.icon } : {}), ...(x.direction ? { direction: x.direction } : {}), ...(typeof x.startValue === "number" ? { startValue: x.startValue } : {}),
  });
  for (const g of plan.goals) {
    const projectId = g.projectKey ? idByKey[g.projectKey] : undefined;
    let goal: Goal;
    try {
      goal = await makeGoal(g.name,
        { kind: "objective", ownerId: ctx.me, period: g.period, periodStart: g.periodStart, periodEnd: g.periodEnd, ...look(g) },
        { ...(g.description ? { description: g.description } : {}), ...(projectId ? { projectId } : {}) },
        { target: g.target, unit: g.unit, due: g.due });
    } catch { out.failed.push(g.name); continue; }
    out.goals.push(goal);
    for (const kr of g.keyResults) {
      let made: Goal;
      try {
        made = await makeGoal(kr.name,
          { kind: "key_result", ownerId: ctx.me, period: g.period, periodStart: g.periodStart, periodEnd: g.periodEnd, ...look(kr) },
          { parentId: goal.id },
          { target: kr.target, unit: kr.unit, due: g.due });
      } catch { out.failed.push(kr.name); continue; }
      out.goals.push(made);
      await link(made, kr.linkKeys);
    }
    await link(goal, g.linkKeys);
  }

  // portfolios
  for (const pf of plan.portfolios) {
    const projectIds = pf.projectKeys.map((k) => idByKey[k]).filter((x): x is string => !!x);
    if (!projectIds.length) continue;
    let made: Portfolio;
    // (a business already in Kanbo: in Personal, its own projects beside the one made for it)
    try { made = await deps.createPortfolio({ workspaceId: pf.personal ? null : wsOf(projectIds[0]), name: pf.name, projectIds: [...new Set([...projectIds, ...(pf.projectIds ?? [])])] }); }
    catch { out.failed.push(pf.name); continue; }
    const look = { ...(pf.description ? { description: pf.description } : {}), ...(pf.emoji ? { emoji: pf.emoji } : {}), ...(pf.color ? { color: pf.color } : {}) };
    if (deps.updatePortfolio && Object.keys(look).length) {
      // a description and a look are a nice-to-have (0054): the portfolio stands without them
      try { await deps.updatePortfolio(made.id, look); made = { ...made, ...look }; } catch { /* not switched on yet */ }
    }
    out.portfolios.push(made);
  }

  // the workspace's update day
  if (plan.updateRhythm && ctx.workspaceId && deps.setUpdateRhythm) {
    try {
      await deps.setUpdateRhythm(ctx.workspaceId, plan.updateRhythm);
      out.rhythm = { workspaceId: ctx.workspaceId, before: ctx.rhythmBefore ?? null, after: plan.updateRhythm };
    } catch (e) { if (isNotYet(e)) notYet("updateDay"); else out.failed.push("The update day"); }
  }
  return out;
}

export interface PackUndoDeps {
  deleteGoal(id: string): Promise<void>;
  deletePortfolio(id: string): Promise<void>;
  deleteDoc?(id: string): Promise<void>;
  deleteRule?(id: string): Promise<void>;
  deleteForm?(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  setUpdateRhythm?(workspaceId: string, rhythm: UpdateRhythm | null): Promise<void>;
}

/** Take a pack back: everything it made, newest first, and the update day it replaced. Says what
 *  couldn't be removed (by name). */
export async function undoAppliedPack(a: AppliedPack, deps: PackUndoDeps): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  const run = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch { failed.push(name); } };
  if (a.rhythm && deps.setUpdateRhythm) { const r = a.rhythm; await run("The update day", () => deps.setUpdateRhythm!(r.workspaceId, r.before)); }
  for (const pf of a.portfolios) await run(pf.name, () => deps.deletePortfolio(pf.id));
  // key results before their goals (a goal's key results would otherwise become goals of their own)
  const goals = [...a.goals].sort((x, y) => Number(!x.parentId) - Number(!y.parentId));
  for (const g of goals) await run(g.name, () => deps.deleteGoal(g.id));
  if (deps.deleteDoc) for (const d of a.docs) await run(d.title, () => deps.deleteDoc!(d.id));
  if (deps.deleteRule) for (const r of a.rules as AutomationRule[]) await run(r.name, () => deps.deleteRule!(r.id));
  if (deps.deleteForm) for (const f of a.forms) await run(f.name, () => deps.deleteForm!(f.id));
  for (const p of a.projects) await run(p.name, () => deps.deleteProject(p.id));
  return { failed };
}

/* ---------- words ---------- */

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** What isn't switched on yet, in a sentence each. */
export const NOT_YET_COPY: Readonly<Record<PackFeature, string>> = {
  goalsV2: "Goal owners and quarters aren't switched on yet, so the goals went in without them.",
  goalLinks: "Linking goals to projects isn't switched on yet, so the goals aren't linked to their work.",
  docs: "Project docs aren't switched on yet, so the docs were left out.",
  updateDay: "Update days aren't switched on yet, so the workspace's update day wasn't set.",
};

/** The one line that heads the summary. */
export function packOutcomeTitle(name: string, a: Pick<AppliedPack, "projects" | "goals" | "portfolios" | "failed">): string {
  if (!a.projects.length && !a.goals.length && !a.portfolios.length) return `Couldn't set up ${name}`;
  return a.failed.length ? `${name} is set up, with gaps` : `${name} is set up`;
}

/** "5 projects and 41 starter tasks" · "3 goals with 7 key results" … for the summary. */
export function packOutcomeCounts(a: AppliedPack): { projects: string; goals: string; portfolios: string; docs: string; forms: string } {
  const objectives = a.goals.filter((g) => !g.parentId).length;
  const krs = a.goals.length - objectives;
  return {
    projects: a.projects.length ? `${plural(a.projects.length, "project")} and ${plural(a.tasks.length, "starter task")}` : "",
    goals: objectives ? `${plural(objectives, "goal")}${krs ? ` with ${plural(krs, "key result")}` : ""}` : "",
    portfolios: a.portfolios.length ? plural(a.portfolios.length, "portfolio") : "",
    docs: a.docs.length ? plural(a.docs.length, "doc") : "",
    forms: a.forms.length ? plural(a.forms.length, "request form") : "",
  };
}
