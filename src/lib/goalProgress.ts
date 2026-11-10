/* ============================================================
   KANBO — how far along a goal is. One rule for every screen that
   shows a goal's % (Goals, the Group page, the pace line):
   · a goal linked to a project reads that project's % (its top-level
     tasks done, lib/countRules), as on the project's own header;
   · a goal that tracks its own number reads how far it has come from
     its start towards its target, whichever way is better: "cut churn
     from 8% to 5%" is 0% at 8% and 100% at 5%, not 100% on day one
     (and 0%, never 100%, until where it started is known);
   · a goal with key results under it, and no number of its own yet,
     rolls up as their weighted average (each counts its weight, 1 when
     unset; archived ones don't count);
   · a goal whose project you can't see (0058, project access on) has
     no % you can know: it's "hidden", and its parent's roll-up leaves
     it out rather than counting it as 0.
   Pure: no React, no I/O.
   ============================================================ */
import type { Goal } from "../data/types";

export interface GoalProgress {
  pct: number;
  /** hidden: its project is one you can't see (pct is 0 and means nothing) */
  source: "project" | "subgoals" | "manual" | "hidden";
  children: number;
  /** the weighted average of the sub-goals, when there are any (shown alongside a goal's own number) */
  subPct?: number;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Where a goal's number started: its start value; else 0 when higher is better. Lower is
 *  better has no start to assume ("cut churn from 8% to 5%" starts at 8, not 0): null until
 *  it's set. */
export function goalStartValue(g: Pick<Goal, "startValue" | "direction">): number | null {
  if (g.startValue != null && isFinite(g.startValue)) return g.startValue;
  return g.direction === "lower" ? null : 0;
}

/** What a goal's own number still needs before its % means anything: a target, or where it
 *  started (lower is better with no start, or a start that's already at or past the target
 *  the wrong way); null once it's measurable. */
export function goalNumbersGap(g: Pick<Goal, "startValue" | "direction" | "target">): "target" | "start" | null {
  const start = goalStartValue(g);
  if (g.target == null || !isFinite(g.target)) return "target";
  if (start == null) return "start";
  if (g.direction === "lower" ? start > g.target : g.target > start) return null;
  return g.startValue == null ? "target" : "start";
}

/** A goal's own number as a % of the way from its start to its target (0–100); 0 until its
 *  numbers are set (never 100% because a start is missing or on the wrong side). */
export function goalValuePct(g: Pick<Goal, "startValue" | "direction" | "current" | "target">): number {
  if (goalNumbersGap(g)) return 0;
  const start = goalStartValue(g)!, target = g.target!;
  return clamp((((g.current ?? start) - start) / (target - start)) * 100);
}

/** Does the goal track a number of its own (has it moved off its start)? */
export const tracksOwnNumber = (g: Pick<Goal, "startValue" | "direction" | "current">): boolean =>
  g.current != null && g.current !== (goalStartValue(g) ?? g.current);

/** A sub-goal's say in its parent's roll-up. */
export const goalWeight = (g: Pick<Goal, "weight">): number => (g.weight != null && g.weight > 0 ? g.weight : 1);

/** Progress for every goal:
 *  - a linked project drives it;
 *  - otherwise a goal that tracks its own number keeps it (start → target, whichever way
 *    is better), so parents that already tracked a figure don't change when sub-goals are added;
 *  - otherwise a goal with sub-goals rolls up as their weighted average (the untouched
 *    0 / 100 parent used to read 0% however far along its sub-goals were);
 *  - otherwise its own number. */
export function goalProgressMap(goals: Goal[], projectPct: (projectId: string) => number, hidden?: (g: Goal) => boolean): Map<string, GoalProgress> {
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
      const vals = counted.map((c) => [calc(c), goalWeight(c)] as const).filter(([p]) => p.source !== "hidden").map(([p, w]) => [p.pct, w] as const);
      visiting.delete(g.id);
      const total = vals.reduce((a, [, w]) => a + w, 0);
      if (total > 0) subPct = vals.reduce((a, [p, w]) => a + p * w, 0) / total;
    }
    const n = children.length;
    const withSub = subPct === undefined ? {} : { subPct };
    let res: GoalProgress;
    if (g.projectId && hidden?.(g)) res = { pct: 0, source: "hidden", children: n, ...withSub };
    else if (g.projectId) res = { pct: projectPct(g.projectId), source: "project", children: n, ...withSub };
    else if (subPct !== undefined && !tracksOwnNumber(g)) res = { pct: subPct, source: "subgoals", children: n, subPct };
    else res = { pct: goalValuePct(g), source: "manual", children: n, ...withSub };
    memo.set(g.id, res);
    return res;
  };
  goals.forEach((g) => calc(g));
  memo.forEach((v, k) => memo.set(k, { ...v, pct: Math.round(v.pct), ...(v.subPct === undefined ? {} : { subPct: Math.round(v.subPct) }) }));
  return memo;
}
