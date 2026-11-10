/* ============================================================
   KANBO — how far along a goal is. One rule for every screen that
   shows a goal's % (Goals, the Group page, the pace line):
   · a goal linked to a project reads that project's % (its top-level
     tasks done, lib/countRules), as on the project's own header;
   · a goal that tracks its own number reads how far it has come from
     its start towards its target, whichever way is better: "cut churn
     from 8% to 5%" is 0% at 8% and 100% at 5%, not 100% on day one;
   · a goal with key results under it, and no number of its own yet,
     rolls up as their weighted average (each counts its weight, 1 when
     unset; archived ones don't count).
   Pure: no React, no I/O.
   ============================================================ */
import type { Goal } from "../data/types";

export interface GoalProgress {
  pct: number;
  source: "project" | "subgoals" | "manual";
  children: number;
  /** the weighted average of the sub-goals, when there are any (shown alongside a goal's own number) */
  subPct?: number;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Where a goal's number started: its start value; else 0 when higher is better, and
 *  for lower is better wherever it stands now (so it reads 0% until it moves). */
export function goalStartValue(g: Pick<Goal, "startValue" | "direction" | "current">): number {
  if (g.startValue != null && isFinite(g.startValue)) return g.startValue;
  return g.direction === "lower" ? (g.current ?? 0) : 0;
}

/** A goal's own number as a % of the way from its start to its target (0–100). */
export function goalValuePct(g: Pick<Goal, "startValue" | "direction" | "current" | "target">): number {
  if (g.target == null || !isFinite(g.target)) return 0;
  const start = goalStartValue(g);
  const span = g.target - start;
  if (span === 0) return 0;
  return clamp((((g.current ?? start) - start) / span) * 100);
}

/** Does the goal track a number of its own (has it moved off its start)? */
export const tracksOwnNumber = (g: Pick<Goal, "startValue" | "direction" | "current">): boolean =>
  g.current != null && g.current !== goalStartValue(g);

/** A sub-goal's say in its parent's roll-up. */
export const goalWeight = (g: Pick<Goal, "weight">): number => (g.weight != null && g.weight > 0 ? g.weight : 1);

/** Progress for every goal:
 *  - a linked project drives it;
 *  - otherwise a goal that tracks its own number keeps it (start → target, whichever way
 *    is better), so parents that already tracked a figure don't change when sub-goals are added;
 *  - otherwise a goal with sub-goals rolls up as their weighted average (the untouched
 *    0 / 100 parent used to read 0% however far along its sub-goals were);
 *  - otherwise its own number. */
export function goalProgressMap(goals: Goal[], projectPct: (projectId: string) => number): Map<string, GoalProgress> {
  const ids = new Set(goals.map((g) => g.id));
  const kids = new Map<string, Goal[]>();
  for (const g of goals) if (g.parentId && g.parentId !== g.id && ids.has(g.parentId)) { const a = kids.get(g.parentId) ?? []; a.push(g); kids.set(g.parentId, a); }
  const memo = new Map<string, GoalProgress>();
  const visiting = new Set<string>();
  const calc = (g: Goal): GoalProgress => {
    const hit = memo.get(g.id); if (hit) return hit;
    const children = kids.get(g.id) ?? [];
    let subPct: number | undefined;
    if (children.length && !visiting.has(g.id)) {
      visiting.add(g.id);
      const counted = children.filter((c) => !visiting.has(c.id) && !c.archivedAt);
      const vals = counted.map((c) => [calc(c).pct, goalWeight(c)] as const);
      visiting.delete(g.id);
      const total = vals.reduce((a, [, w]) => a + w, 0);
      if (total > 0) subPct = vals.reduce((a, [p, w]) => a + p * w, 0) / total;
    }
    const n = children.length;
    const withSub = subPct === undefined ? {} : { subPct };
    let res: GoalProgress;
    if (g.projectId) res = { pct: projectPct(g.projectId), source: "project", children: n, ...withSub };
    else if (subPct !== undefined && !tracksOwnNumber(g)) res = { pct: subPct, source: "subgoals", children: n, subPct };
    else res = { pct: goalValuePct(g), source: "manual", children: n, ...withSub };
    memo.set(g.id, res);
    return res;
  };
  goals.forEach((g) => calc(g));
  memo.forEach((v, k) => memo.set(k, { ...v, pct: Math.round(v.pct), ...(v.subPct === undefined ? {} : { subPct: Math.round(v.subPct) }) }));
  return memo;
}
