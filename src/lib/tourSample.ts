/* ============================================================
   KANBO — making and removing the "Kanbo tour" sample (0048 · u1).
   Recorded in profiles.onboarding.sample; the project itself is made
   through the host's create paths (TourSampleDeps) by
   ./onboardingSample. Loaded on demand (Help › Try the sample project,
   or lib/onboarding createTourSample / removeTourSample), so none of
   it rides in the first download.
   ============================================================ */
import type { OnboardingState } from "../data/types";
import type { TourSampleDeps } from "./onboardingSample";
import { onboardingFailure, parseOnboardingState, saveOnboarding } from "./onboarding";
import { supabase } from "./supabase";

/** The person's stored record, read straight from the database (null when it can't be: demo mode, offline,
 *  a database without 0048 yet). */
async function storedOnboarding(userId: string): Promise<OnboardingState | null> {
  if (!supabase || !userId) return null;
  try {
    const { data, error } = await supabase.from("profiles").select("onboarding").eq("id", userId).maybeSingle();
    if (error || !data) return null;
    return parseOnboardingState((data as { onboarding?: unknown }).onboarding);
  } catch {
    return null;
  }
}

/** Make it (and record it in profiles.onboarding.sample). Loads the sample's module on demand.
 *  One at a time: when a sample is already recorded (in `current`, or in the database, say by another
 *  tab) that state is the answer and nothing new is made.
 *  Rejects with a readable TourSampleError (name "TourSampleError", plus .failure when the record
 *  couldn't be saved) when the project couldn't be made or recorded; nothing is left behind (a made
 *  project that couldn't be recorded is taken away again, best effort). */
export async function createTourSample(deps: TourSampleDeps, ctx: { today: Date; currentUserId: string; workspaceId: string | null; reviewerIds?: string[]; current?: OnboardingState }): Promise<OnboardingState> {
  if (ctx.current?.sample) return ctx.current;
  const stored = await storedOnboarding(ctx.currentUserId);
  if (stored?.sample) return stored;
  const m = await import("./onboardingSample");
  const sample = await m.buildTourSample(deps, ctx);
  try {
    return await saveOnboarding({ sample }, ctx.current);
  } catch (e) {
    // unrecorded, it couldn't be removed in one click (and Help would offer another): take it away again
    let undone = true;
    try { await m.deleteTourSample(deps, { sample }); } catch { undone = false; }
    throw Object.assign(new m.TourSampleError(undone
      ? "Couldn't finish the sample project, so it was taken away again. Check your connection and try again."
      : "Couldn't finish the sample project. If “Kanbo tour” shows in your projects, you can delete it there."),
    { failure: onboardingFailure(e) });
  }
}
/** Remove it (one click) and forget it. A project that's already gone is just forgotten. */
export async function removeTourSample(deps: TourSampleDeps, state: OnboardingState): Promise<OnboardingState> {
  const m = await import("./onboardingSample");
  await m.deleteTourSample(deps, state);
  return saveOnboarding({ sample: null }, state);
}
