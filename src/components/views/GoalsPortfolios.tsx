/* ============================================================
   KANBO — Goals (a number you want to hit, with its progress) and
   Portfolios (projects rolled up: cards to manage them, a table to
   read them at a glance). Both pages live in their own folders now
   (components/goals, components/portfolios); this module keeps them
   in one lazily loaded chunk and holds the update status labels.
   ============================================================ */
import type { StatusKind } from "../../data/types";

export const STATUS_KIND_META: Record<StatusKind, { label: string; color: string }> = {
  on_track: { label: "On track", color: "var(--st-done)" },
  at_risk: { label: "At risk", color: "var(--st-review)" },
  off_track: { label: "Off track", color: "var(--prio-urgent)" },
  on_hold: { label: "On hold", color: "var(--ink-4)" },
};

/* ---------------- GOALS ---------------- */
// (the Goals page lives in components/goals since Goals 2.0; it's still reachable from here)
export { GoalsView } from "../goals/GoalsView";

/* ---------------- PORTFOLIOS ---------------- */
export { PortfoliosView } from "../portfolios/PortfoliosView";
// 0054: a portfolio's own page, in the same lazily loaded chunk
export { PortfolioPage } from "../portfolios/PortfolioPage";
