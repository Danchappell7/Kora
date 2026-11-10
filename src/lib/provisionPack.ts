/* ============================================================
   KANBO — a business pack set up while provisioning a business (the
   platform console, 0058). The admin owns the new workspace until its
   owner joins, so the pack goes in through the same creates as
   anywhere else (the store's, as the admin), everything ticked; when
   the owner joins, the handover gives them what was set up for them
   (project owners, open tasks, goals). What isn't switched on yet
   (0052 goals' owners and links, docs, 0053's update day) is left
   out or simplified, as lib/packApply does everywhere.
   Loaded only when someone provisions with a pack.
   ============================================================ */
import { store } from "../data/store";
import { findPack } from "../packs";
import { buildPackPlan, defaultPick } from "./packPlan";
import { applyPackPlan, type PackApplyDeps, type PackFeature } from "./packApply";
import { saveProjectDoc } from "./docs";

export interface ProvisionedPack { name: string; projects: number; goals: number; tasks: number; notYet: PackFeature[]; failed: string[] }

const uuid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `doc-${Date.now()}-${Math.round(Math.random() * 1e9)}`);

/** Set the pack up in the workspace, as `me` (who owns it for now). Null when the pack isn't one Kanbo knows. */
export async function provisionPack(packId: string, workspaceId: string, me: string, today: Date): Promise<ProvisionedPack | null> {
  const pack = findPack(packId);
  if (!pack) return null;
  const deps: PackApplyDeps = {
    ...store.templateDeps(me),
    createGoal: (g) => store.createGoal(g, me),
    addGoalLink: (l) => store.addGoalLink(l),
    createPortfolio: (pf) => store.createPortfolio(pf, me),
    updatePortfolio: (id, patch) => store.updatePortfolio(id, patch),
    createDoc: async ({ projectId, title, icon, body }) => {
      const r = await saveProjectDoc({ id: uuid(), projectId, title, body, baseUpdatedAt: null, icon });
      return { id: r.doc.id, projectId, title: r.doc.title, icon: r.doc.icon };
    },
    setUpdateRhythm: (ws, r) => store.setUpdateRhythm(ws, r),
  };
  const ctx = { today, goalsV2: true, canSetGoals: true, canSetUpdateDay: true, businesses: [] as string[] };
  const plan = buildPackPlan(pack, defaultPick(pack, { today, businesses: [], mode: "workspace" }), ctx);
  const a = await applyPackPlan(plan, { workspaceId, me, rhythmBefore: null }, deps);
  return { name: pack.name, projects: a.projects.length, goals: a.goals.length, tasks: a.tasks.length, notYet: a.notYet, failed: a.failed };
}
