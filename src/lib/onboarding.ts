/* ============================================================
   KANBO — the guided first run (0048).                 [0048 contract → u1]
   • A 3-minute tour of coach marks pointing at the real UI, by role
     (owner/admin · member · guest), Next / Back / Skip, resumable (the
     step is saved), keyboard and screen-reader complete, no motion with
     prefers-reduced-motion. Replayable from the Help (?) menu.
   • "Try it": a sample project "Kanbo tour" in Personal (its own
     identity; 6 tasks showing sub-tasks, a dependency, an approval
     request and a doc), removable in one click. Approvals need a team
     task, so in Personal the approval step is shown as a task that
     explains it (a real request only when made in a team workspace).
   • "Get set up": a checklist card on Today until done or dismissed —
     owners: invite your team, connect a calendar, add your company
     domain, connect Slack; members (and guests): plan your day, complete
     a task, install the app, set notifications. Items tick themselves from
     what the app can see (SetupSignals) or by hand; progress ring.
   State: profiles.onboarding (keys tour / checklist / sample; momentum is
   u10's), saved with merge_onboarding (one level deep; null removes).
   Demo mode: the same, in memory on the demo profile.
   Coach-mark anchors: TOUR_ANCHORS (data-tour attributes already on the
   sidebar places, ⌘K search, New task, Plan my day, the task panel and
   the Inbox's first triage group). A step whose anchor isn't on screen
   (e.g. phone layout, a closed panel) shows as a centred card instead.

   This module is LEAN on purpose: the shell (App) imports it to decide
   whether to mount the lazy TourHost / SetupChecklist and to save. The
   sample project's content lives in ./onboardingSample and only loads
   when someone asks for it (createTourSample / removeTourSample import
   it on demand; tourSamplePlan is a pass-through re-export, which Rollup
   keeps in whichever lazy chunk uses it).
   ============================================================ */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  OnboardingPatch, OnboardingState, Role, SetupItemId, TourRole,
} from "../data/types";
import { parseOnboardingState } from "./profileState";
import { supabase } from "./supabase";
import type { TourSampleDeps } from "./onboardingSample";
import { setupItemsFor, type ChecklistOpts } from "./onboardingItems";

export { parseOnboardingState } from "./profileState";
export type { TourSampleDeps, TourSamplePlan, TourSampleCtx } from "./onboardingSample";
/** The sample project's content (pure: the same every time, dates relative to `today`). */
export { tourSamplePlan } from "./onboardingSample";

/** CSS selectors for the elements the tour points at (the first visible match wins).  [final] */
export const TOUR_ANCHORS = {
  places: '[data-tour="places"]',
  search: '[data-tour="search"]',
  capture: '[data-tour="capture"]',
  planDay: '[data-tour="plan-day"]',
  taskPanel: '[data-tour="task-panel"]',
  inboxTriage: '[data-tour="inbox-triage"]',
} as const;
export type TourAnchor = keyof typeof TOUR_ANCHORS;

/** The tour's role for a workspace role (Personal: owner).  [final] */
export function tourRoleOf(role: Role | null | undefined, personal: boolean): TourRole {
  if (personal || role === "owner" || role === "admin") return "owner";
  return role === "guest" ? "guest" : "member";
}

/** The checklist's items per role, in order.  [final] (declared in the leaf module ./onboardingItems, unchanged,
 *  so the lazy words module can use it without importing this one) */
export { SETUP_ITEMS, setupItemsFor, type ChecklistOpts } from "./onboardingItems";

/** What the app can see right now (the integrator computes these; any item already true counts as done). */
export type SetupSignals = Partial<Record<SetupItemId, boolean>>;

/** The facts the app has, in its own words (all optional): setupSignals turns them into SetupSignals. */
export interface SetupFacts {
  /** people in the workspace besides you (active or invited) */
  teammates?: number;
  /** calendar connections (lib/calendars) */
  calendars?: number;
  /** auto-approved company domains (Admin) */
  companyDomains?: number;
  /** Slack connected for this workspace */
  slack?: boolean;
  /** any of your tasks on today's plan (planToday or a slot) */
  plannedToday?: boolean;
  /** you've completed at least one task */
  completedAny?: boolean;
  /** running as the installed app (lib/install isStandalone) */
  installed?: boolean;
  /** push on here (lib/push isPushOnHere), or notification preferences saved */
  notificationsChosen?: boolean;
}
export function setupSignals(f: SetupFacts): SetupSignals {
  return {
    invite_team: (f.teammates ?? 0) > 0,
    connect_calendar: (f.calendars ?? 0) > 0,
    add_domain: (f.companyDomains ?? 0) > 0,
    connect_slack: !!f.slack,
    plan_day: !!f.plannedToday,
    complete_task: !!f.completedAny,
    install_app: !!f.installed,
    set_notifications: !!f.notificationsChosen,
  };
}

/* ================================ the tour ================================ */

export type { TourStep } from "./onboardingCopy";
/** About three minutes, whatever the role. */
export const TOUR_MINUTES = 3;
/** The tour for a role, and where a saved step resumes: the words live in ./onboardingCopy (only the lazy
 *  TourHost loads them). */
export { tourSteps, resumeIndex } from "./onboardingCopy";

/** Should the tour start by itself? (a new person who hasn't finished or skipped it, or one part-way through) */
export function shouldAutoStartTour(state: OnboardingState, opts: { isNewAccount: boolean }): boolean {
  const t = state.tour;
  if (t?.done || t?.skipped) return false;
  if (t?.step) return true;                 // part-way: carry on where they left off
  return !!opts.isNewAccount && !t;         // never started: new accounts only
}

/** The tour state after a move (step id), a finish or a skip. */
export function tourState(role: TourRole, at: { step: string } | "done" | "skipped", now = new Date()): NonNullable<OnboardingState["tour"]> {
  const updatedAt = now.toISOString();
  if (at === "done") return { step: null, done: true, skipped: false, role, updatedAt };
  if (at === "skipped") return { step: null, done: false, skipped: true, role, updatedAt };
  return { step: at.step, done: false, skipped: false, role, updatedAt };
}

/* ---------- asking the mounted TourHost to start (or not) ---------- */

export interface TourRequest { from?: string }
type Bus = { kind: "start"; opts: TourRequest } | { kind: "decline"; opts: TourRequest };
const startListeners = new Set<(opts: TourRequest) => void>();
const declineListeners = new Set<(opts: TourRequest) => void>();
const wantedListeners = new Set<() => void>();
let pending: Bus | null = null;
let wanted = false;

function emit(ev: Bus) {
  wanted = true;
  wantedListeners.forEach((cb) => cb());
  const set = ev.kind === "start" ? startListeners : declineListeners;
  // nobody's listening yet (the TourHost is lazy): it gets it as soon as it subscribes
  if (!set.size) { pending = ev; return; }
  pending = null;
  set.forEach((cb) => cb(ev.opts));
}
function deliverPending(kind: Bus["kind"], cb: (opts: TourRequest) => void) {
  if (!pending || pending.kind !== kind) return;
  const ev = pending;
  pending = null;
  queueMicrotask(() => cb(ev.opts));
}

/** Ask the mounted TourHost to (re)start the tour — the Help menu's "Take the tour". */
export function startTour(opts: TourRequest = {}): void { emit({ kind: "start", opts }); }
/** TourHost listens here. Returns unsubscribe. */
export function onTourRequest(cb: (opts: TourRequest) => void): () => void {
  startListeners.add(cb);
  deliverPending("start", cb);
  return () => { startListeners.delete(cb); };
}
/** "Not now" from outside the tour (the first-run dialog's hand-over): the TourHost records it as skipped. */
export function declineTour(opts: TourRequest = {}): void { emit({ kind: "decline", opts }); }
export function onTourDecline(cb: (opts: TourRequest) => void): () => void {
  declineListeners.add(cb);
  deliverPending("decline", cb);
  return () => { declineListeners.delete(cb); };
}
/** True once startTour/declineTour has been called in this page: mount the (lazy) TourHost so it can answer. */
export function tourWanted(): boolean { return wanted; }
function subscribeWanted(cb: () => void) { wantedListeners.add(cb); return () => { wantedListeners.delete(cb); }; }
/** React: `useTourWanted() || shouldAutoStartTour(...)` decides when to mount the lazy TourHost. */
export function useTourWanted(): boolean { return useSyncExternalStore(subscribeWanted, tourWanted, () => false); }
/** (tests) */
export function __resetTourBus(): void { pending = null; wanted = false; startListeners.clear(); declineListeners.clear(); wantedListeners.clear(); }

/* ================================ the checklist ================================ */

/** done / total / complete for a role (no words: the shell uses it to decide whether to mount the card). */
export function checklistProgress(role: TourRole, state: OnboardingState, signals: SetupSignals, opts: ChecklistOpts = {}): { done: number; total: number; complete: boolean } {
  const ticked = state.checklist?.done ?? {};
  const ids = setupItemsFor(role, opts);
  const done = ids.filter((id) => !!signals[id] || !!ticked[id]).length;
  return { done, total: ids.length, complete: ids.length > 0 && done === ids.length };
}
/** The card's items with their words (in ./onboardingCopy, loaded with the card). */
export { checklistView, SETUP_COPY } from "./onboardingCopy";
export type { ChecklistItemView } from "./onboardingCopy";

/** Should the card show on Today? (not dismissed, not complete) */
export function showSetupChecklist(role: TourRole, state: OnboardingState, signals: SetupSignals, opts: ChecklistOpts = {}): boolean {
  if (state.checklist?.dismissedAt) return false;
  const v = checklistProgress(role, state, signals, opts);
  return v.total > 0 && !v.complete;
}

/** How long the card stays to celebrate once everything's done (then it leaves by itself). */
export const CHECKLIST_CELEBRATE_MS = 2400;

/** React: showSetupChecklist, but it stays true for CHECKLIST_CELEBRATE_MS after the card completes
 *  in front of you (so it can celebrate and leave by itself). Use this to mount the card.
 *  The hold is decided while rendering (state from the previous render), not in an effect, so the
 *  render where the last item is ticked already answers true: the card is never unmounted and
 *  remounted in between (which would lose its celebration, its "All set" and the focus). */
export function useShowSetupChecklist(role: TourRole, state: OnboardingState, signals: SetupSignals, opts: ChecklistOpts = {}): boolean {
  const show = showSetupChecklist(role, state, signals, opts);
  const complete = checklistProgress(role, state, signals, opts).complete;
  const dismissed = !!state.checklist?.dismissedAt;
  const [prevShow, setPrevShow] = useState(show);
  const [holding, setHolding] = useState(false);
  let hold = holding;
  if (prevShow !== show) {
    setPrevShow(show);
    // shown → not shown because it's finished (not dismissed): hold it for the celebration
    hold = !show && complete && !dismissed;
    if (hold !== holding) setHolding(hold);
  }
  useEffect(() => {
    if (!holding) return;
    const t = window.setTimeout(() => setHolding(false), CHECKLIST_CELEBRATE_MS);
    return () => window.clearTimeout(t);
  }, [holding]);
  return show || (hold && !dismissed);
}

/** The checklist after a tick / untick (manual), recorded at `now`. */
export function tickSetupItem(state: OnboardingState, id: SetupItemId, done: boolean, now = new Date()): OnboardingState {
  const list = state.checklist ?? {};
  const ticks = { ...(list.done ?? {}) };
  if (done) ticks[id] = ticks[id] ?? now.toISOString();
  else delete ticks[id];
  return { ...state, checklist: { ...list, done: ticks } };
}

/** Record ticks the app can see (signals) that aren't saved yet, so progress sticks (e.g. "installed" is only
 *  visible inside the installed app). Null when there's nothing new. */
export function withSignalTicks(role: TourRole, state: OnboardingState, signals: SetupSignals, now = new Date(), opts: ChecklistOpts = {}): OnboardingState | null {
  const ticks = state.checklist?.done ?? {};
  const fresh = setupItemsFor(role, opts).filter((id) => signals[id] && !ticks[id]);
  if (!fresh.length) return null;
  let next = state;
  for (const id of fresh) next = tickSetupItem(next, id, true, now);
  return next;
}

/** Hide the card (Dismiss) or bring it back (Help › Get set up). */
export function dismissSetupChecklist(state: OnboardingState, dismissed: boolean, now = new Date()): OnboardingState {
  return { ...state, checklist: { ...(state.checklist ?? {}), dismissedAt: dismissed ? now.toISOString() : null } };
}

/* ================================ saving ================================ */

const KEYS = ["v", "tour", "checklist", "sample", "momentum"] as const;

/** What merge_onboarding does, on the client: one level deep, a key set to null is removed. */
export function applyOnboardingPatch(state: OnboardingState, patch: OnboardingPatch): OnboardingState {
  const out: Record<string, unknown> = { ...state };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k]; else out[k] = v;
  }
  return parseOnboardingState(out);
}

/** The patch that turns `prev` into `next` (changed top-level keys; removed ones as null). */
export function onboardingPatch(prev: OnboardingState, next: OnboardingState): OnboardingPatch {
  const patch: Record<string, unknown> = {};
  for (const k of KEYS) {
    const a = prev[k], b = next[k];
    if (b === undefined) { if (a !== undefined) patch[k] = null; continue; }
    if (JSON.stringify(a) !== JSON.stringify(b)) patch[k] = b;
  }
  if (Object.keys(patch).length && next.v === undefined && prev.v === undefined) patch.v = 1;
  return patch as OnboardingPatch;
}

export type OnboardingFailure = "not_allowed" | "invalid" | "too_big" | "unavailable" | "network" | "error";
/** A save error → a failure kind (the RPC's words, PostgREST's codes, the network). */
export function onboardingFailure(e: unknown): OnboardingFailure {
  const err = e as { message?: unknown; code?: unknown } | null;
  const msg = String(err?.message ?? e ?? "");
  const code = String(err?.code ?? "");
  if (/not authorized|permission denied|JWT/i.test(msg) || code === "42501") return "not_allowed";
  if (/invalid patch|profile not found/i.test(msg)) return "invalid";
  if (/profiles_onboarding_shape|check constraint/i.test(msg) || code === "23514") return "too_big";
  if (/could not find the function|does not exist|schema cache/i.test(msg) || code === "PGRST202" || code === "42883") return "unavailable";
  if (/fetch|network|offline|timed? ?out/i.test(msg)) return "network";
  return "error";
}

// demo mode, and a database without 0048 yet: kept for this visit
let memory: OnboardingState = {};

/** Save a patch to profiles.onboarding (rpc merge_onboarding); answers the stored state. Demo: in memory.
 *  `current` (the state the app shows) is the base for demo mode and for a database without 0048 yet
 *  (kept for this visit); with the server, its answer wins. Rejects (Error with .failure) when refused. */
export async function saveOnboarding(patch: OnboardingPatch, current?: OnboardingState): Promise<OnboardingState> {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as OnboardingPatch;
  if (!supabase) {
    memory = applyOnboardingPatch(current ?? memory, clean);
    return memory;
  }
  const { data, error } = await supabase.rpc("merge_onboarding", { p_patch: clean });
  if (error) {
    const failure = onboardingFailure(error);
    if (failure === "unavailable") { memory = applyOnboardingPatch(current ?? memory, clean); return memory; }
    throw Object.assign(new Error(error.message || "Couldn't save your progress."), { failure });
  }
  return parseOnboardingState(data);
}

/** Save the change from `prev` to `next` (the TourHost's / SetupChecklist's onChange): the host's one-liner. */
export function saveOnboardingChange(prev: OnboardingState, next: OnboardingState): Promise<OnboardingState> {
  const patch = onboardingPatch(prev, next);
  if (!Object.keys(patch).length) return Promise.resolve(next);
  return saveOnboarding(patch, prev);
}

/** React, for the host: the person's onboarding state, shown at once and saved behind the scenes.
 *  `fromProfile` is profile.onboarding (it re-syncs when the profile reloads); `change` is what TourHost /
 *  SetupChecklist call (onChange); `adopt` takes a state that's already saved (what createTourSample /
 *  removeTourSample answer). A refused save puts the state back and calls onError (e.g. a quiet toast). */
export function useOnboardingState(fromProfile: OnboardingState | undefined, opts: { onError?: (e: unknown) => void } = {}): [OnboardingState, (next: OnboardingState) => void, (stored: OnboardingState) => void] {
  const [state, setState] = useState<OnboardingState>(() => fromProfile ?? {});
  const ref = useRef(state);
  const onError = useRef(opts.onError);
  onError.current = opts.onError;
  const key = JSON.stringify(fromProfile ?? {});
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const v = fromProfile ?? {};
    ref.current = v;
    setState(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const change = useCallback((next: OnboardingState) => {
    const prev = ref.current;
    if (next === prev) return;
    ref.current = next;
    setState(next);
    saveOnboardingChange(prev, next).then(
      (stored) => { if (ref.current === next) { ref.current = stored; setState(stored); } },
      (e) => { if (ref.current === next) { ref.current = prev; setState(prev); } onError.current?.(e); },
    );
  }, []);
  /** take a state that's already saved (createTourSample / removeTourSample answer one) without saving it again */
  const adopt = useCallback((stored: OnboardingState) => { ref.current = stored; setState(stored); }, []);
  return [state, change, adopt];
}

/** (tests) */
export function __resetOnboardingMemory(state: OnboardingState = {}): void { memory = state; }

/* ================================ demo ================================ */

/** The demo profile's first run: the tour already taken, one setup item done, no sample yet. */
export function demoOnboardingState(now = new Date()): OnboardingState {
  const earlier = new Date(now.getTime() - 26 * 3_600_000).toISOString();
  return { v: 1, tour: { step: null, done: true, skipped: false, role: "owner", updatedAt: earlier }, checklist: { done: { invite_team: earlier } } };
}

/* ================================ the sample project ================================ */

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
