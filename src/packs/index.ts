/* ============================================================
   KANBO — business packs: a one-step setup for a kind of business.
   A pack is a team template (data/types WorkspaceTemplate) that also
   brings starter goals with key results, a portfolio, docs (SOPs and
   meeting notes), request forms with a printable QR poster, and the
   workspace's update day. One file per pack, plain data: edit the
   words, tasks, days and targets there.
   What makes a good pack:
   • 3–5 projects, each with sections and a handful of tasks. Every
     task is assigned to whoever uses the pack; due dates count from
     that day (t), or back from the project's anchor day (before,
     after, onTheDay), e.g. 90 days before opening.
   • 2–3 goals with 1–3 key results each. A target only where a sound
     default exists (a %); money and counts start empty.
   • Docs in Markdown (#, ##, -, [ ], > 💡 callout), or a doc template
     ("meeting" with an agenda, "decisions", "brief", "retro").
   • No real companies or people.
   How a pack is shown and applied: lib/packPlan (pure: the preview's
   parts and the plan) and lib/packApply (creating it, and Undo).
   ============================================================ */
import type { WorkspaceTemplate } from "../data/types";
import { FITNESS_PACK } from "./fitness";
import { VENUE_PACK } from "./venue";
import { ADVISORY_PACK } from "./advisory";
import { AGENCY_PACK } from "./agency";
import { STARTUP_PACK } from "./startup";
import { HOLDING_PACK } from "./holding";

/** The packs, in gallery order. */
export const BUSINESS_PACKS: readonly WorkspaceTemplate[] = Object.freeze([
  FITNESS_PACK, VENUE_PACK, ADVISORY_PACK, AGENCY_PACK, STARTUP_PACK, HOLDING_PACK,
]);

export function findPack(id: string): WorkspaceTemplate | undefined {
  return BUSINESS_PACKS.find((p) => p.id === id);
}
