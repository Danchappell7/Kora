/* ============================================================
   KANBO — a workspace's rollout plan (0057 workspaces.rollout): who
   champions Kanbo there, the pilot group that tries it first, and the
   go-live date. A leaf module the store reads it with at sign-in, and
   the Workspace health card writes it through.
   Before 0057 the column isn't there: the plan reads as "not switched
   on yet" (rolloutOn()), never as empty.
   ============================================================ */
import type { RolloutPlan } from "../data/types";
import { supabase } from "./supabase";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** the most people a pilot group holds (as the database allows) */
export const PILOT_MAX = 20;

/** workspaces.rollout (anything) → a plan, or null. Unknown keys dropped; never throws. */
export function parseRollout(raw: unknown): RolloutPlan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: RolloutPlan = {};
  if (typeof r.champion === "string" && r.champion) out.champion = r.champion;
  if (Array.isArray(r.pilot)) out.pilot = [...new Set(r.pilot.filter((x): x is string => typeof x === "string" && !!x))].slice(0, PILOT_MAX);
  if (typeof r.go_live === "string" && DAY.test(r.go_live)) out.goLive = r.go_live;
  return Object.keys(out).length ? out : null;
}

/** A plan as the database stores it (snake_case; empty parts left out; nothing left: null). */
export function rolloutRow(plan: RolloutPlan | null): Record<string, unknown> | null {
  if (!plan) return null;
  const row: Record<string, unknown> = {};
  if (plan.champion) row.champion = plan.champion;
  if (plan.pilot?.length) row.pilot = [...new Set(plan.pilot)].slice(0, PILOT_MAX);
  if (plan.goLive && DAY.test(plan.goLive)) row.go_live = plan.goLive;
  return Object.keys(row).length ? row : null;
}

/* ---------- is 0057 in? (the sign-in read says; the demo always has it) ---------- */

let schema: boolean | null = null;
/** The sign-in read saw workspaces.rollout come back (even empty): 0057 is in. */
export function noteRolloutSchema(on: boolean): void { schema = on; }
/** Can the rollout plan be read and saved here? Unknown (no team workspace read yet): only in the demo,
 *  as for update days (store.createWorkspace notes it for someone whose first load had no team workspace). */
export function rolloutOn(): boolean { return schema ?? !supabase; }
/** (tests) */
export function resetRolloutSchema(): void { schema = null; }
