/* ============================================================
   KANBO — business packs: what the hosts (New workspace, New
   project) and the app hand the pack flow.
   ============================================================ */
import type { Route } from "../../app-types";
import type { WorkspaceTemplate } from "../../data/types";
import type { AppliedPack, PackPoster } from "../../lib/packApply";
import type { PackContext, PackPick, PackPlan } from "../../lib/packPlan";

/** Where the pack is going, for the preview (lib/packPlan PackContext and the words for what it can't do). */
export interface PackUiContext extends PackContext {
  mode: "workspace" | "project";
  /** why the update day is left out, when it is */
  updateDayNote?: string;
}

/** A pack that was set up: what it was, what was planned and what was made. */
export interface PackOutcome {
  pack: WorkspaceTemplate;
  plan: PackPlan;
  applied: AppliedPack;
  workspaceId: string | null;
}

/** What taking a pack back did. */
export interface PackUndone { failed: string[]; binned?: boolean }

/** What a host needs from the app to offer packs. */
export interface PackHost {
  /** the preview's context (today is the app's) */
  context: PackUiContext;
  /** set it up here (New project); New workspace sets it up through its own onCreate */
  apply?(pack: WorkspaceTemplate, pick: PackPick): Promise<PackOutcome | null>;
  /** take it all back (`binned`: deleted projects wait in the recycle bin) */
  undo(outcome: PackOutcome): Promise<PackUndone>;
  /** switch the form's public link on and print its poster; a message when it couldn't */
  printPoster(poster: PackPoster, outcome: PackOutcome): Promise<string | null>;
  /** go somewhere in the app (the summary's Open buttons); the sheet closes first */
  open?(route: Route): void;
}
