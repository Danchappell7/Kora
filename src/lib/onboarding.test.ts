import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { OnboardingState, Project, Task } from "../data/types";
import {
  CHECKLIST_CELEBRATE_MS, SETUP_ITEMS, checklistProgress, TOUR_ANCHORS, __resetOnboardingMemory, __resetTourBus, applyOnboardingPatch, checklistView,
  createTourSample, declineTour, demoOnboardingState, dismissSetupChecklist, onTourDecline, onTourRequest, onboardingFailure,
  onboardingPatch, removeTourSample, resumeIndex, saveOnboarding, saveOnboardingChange, setupItemsFor, shouldAutoStartTour,
  setupSignals, showSetupChecklist, startTour, tickSetupItem, tourSamplePlan, tourState, tourSteps, tourWanted, useShowSetupChecklist,
  useOnboardingState, useTourWanted, withSignalTicks, type TourSampleDeps,
} from "./onboarding";

const NOW = new Date("2026-10-09T10:00:00+01:00");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); __resetTourBus(); __resetOnboardingMemory(); });
afterEach(() => { vi.useRealTimers(); });

describe("the tour's steps", () => {
  it("owners and admins: the five places, ⌘K, capture Q, Plan my day P, the task panel, Inbox triage, then inviting the team", () => {
    const s = tourSteps("owner");
    expect(s.map((x) => x.id)).toEqual(["places", "search", "capture", "plan-day", "task-panel", "inbox-triage", "invite"]);
    expect(s.map((x) => x.kbd ?? null)).toEqual([null, "⌘K", "Q", "P", null, null, null]);
    expect(s.find((x) => x.id === "plan-day")!.route).toEqual({ view: "plan" });
    expect(s.find((x) => x.id === "inbox-triage")!.route).toEqual({ view: "inbox" });
    expect(s.find((x) => x.id === "task-panel")!.opensTask).toBe(true);
    // every anchor is one of the contract's
    for (const x of s) if (x.anchor) expect(Object.keys(TOUR_ANCHORS)).toContain(x.anchor);
  });
  it("members: the same, without the admin step", () => {
    expect(tourSteps("member").map((x) => x.id)).toEqual(["places", "search", "capture", "plan-day", "task-panel", "inbox-triage"]);
  });
  it("guests: reading-only steps, never one that creates or plans", () => {
    const s = tourSteps("guest");
    expect(s.map((x) => x.id)).toEqual(["places", "search", "task-panel", "inbox-triage"]);
    const words = s.map((x) => `${x.body} ${x.touchBody ?? ""}`).join(" ");
    expect(words).not.toMatch(/Press Q|Plan my day|adds to Today|New task/);
    expect(words).toMatch(/comment/);
  });
  it("every step has words for a phone too, and British spelling", () => {
    for (const role of ["owner", "member", "guest"] as const) {
      for (const x of tourSteps(role)) {
        if (x.id !== "invite") expect(x.touchBody, `${role} ${x.id}`).toBeTruthy();
        expect(`${x.title} ${x.body} ${x.touchBody ?? ""}`).not.toMatch(/\b(color|organize|prioritize|favorite)\b/i);
      }
    }
  });
  it("resumes at the saved step (or the start when the role's tour doesn't have it)", () => {
    expect(resumeIndex("owner", "plan-day")).toBe(3);
    expect(resumeIndex("guest", "inbox-triage")).toBe(3);
    expect(resumeIndex("guest", "capture")).toBe(0);
    expect(resumeIndex("member", "invite")).toBe(0);
    expect(resumeIndex("member", null)).toBe(0);
  });
});

describe("when the tour starts by itself", () => {
  it("a new person who hasn't started it; one part-way through (any account); never once done or skipped", () => {
    expect(shouldAutoStartTour({}, { isNewAccount: true })).toBe(true);
    expect(shouldAutoStartTour({}, { isNewAccount: false })).toBe(false);
    expect(shouldAutoStartTour({ tour: { step: "search", done: false } }, { isNewAccount: false })).toBe(true);
    expect(shouldAutoStartTour({ tour: { step: null, done: true } }, { isNewAccount: true })).toBe(false);
    expect(shouldAutoStartTour({ tour: { step: null, done: false, skipped: true } }, { isNewAccount: true })).toBe(false);
    expect(shouldAutoStartTour({ tour: { step: "search", done: false, skipped: true } }, { isNewAccount: true })).toBe(false);
    // a tour record with no step that's neither done nor skipped (never got going): only new accounts aren't asked twice
    expect(shouldAutoStartTour({ tour: { step: null, done: false } }, { isNewAccount: true })).toBe(false);
  });
  it("tour states: a move, a finish, a skip", () => {
    expect(tourState("member", { step: "search" })).toEqual({ step: "search", done: false, skipped: false, role: "member", updatedAt: NOW.toISOString() });
    expect(tourState("owner", "done")).toMatchObject({ step: null, done: true, skipped: false });
    expect(tourState("guest", "skipped")).toMatchObject({ step: null, done: false, skipped: true, role: "guest" });
  });
});

describe("asking the TourHost", () => {
  it("a request made before the (lazy) TourHost listens is delivered when it subscribes", async () => {
    expect(tourWanted()).toBe(false);
    startTour({ from: "help" });
    expect(tourWanted()).toBe(true);
    const cb = vi.fn();
    const off = onTourRequest(cb);
    await Promise.resolve();
    expect(cb).toHaveBeenCalledWith({ from: "help" });
    startTour({ from: "again" });
    expect(cb).toHaveBeenLastCalledWith({ from: "again" });
    off();
    startTour();
    expect(cb).toHaveBeenCalledTimes(2);
  });
  it("a decline goes to decline listeners only", async () => {
    const start = vi.fn(), decline = vi.fn();
    declineTour({ from: "onboarding" });
    onTourRequest(start);
    onTourDecline(decline);
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(decline).toHaveBeenCalledWith({ from: "onboarding" });
  });
  it("useTourWanted turns true once asked (so the host mounts the TourHost)", () => {
    const { result } = renderHook(() => useTourWanted());
    expect(result.current).toBe(false);
    act(() => startTour());
    expect(result.current).toBe(true);
  });
});

describe("the “Get set up” checklist", () => {
  it("items by role; guests only get the ones they can do", () => {
    expect(setupItemsFor("owner")).toEqual([...SETUP_ITEMS.owner]);
    expect(setupItemsFor("member")).toEqual([...SETUP_ITEMS.member]);
    expect(setupItemsFor("guest")).toEqual(["install_app", "set_notifications"]);
  });
  it("the host can leave out what this person can't do here (the company domain is a site admin's)", () => {
    expect(setupItemsFor("owner", { hidden: ["add_domain"] })).toEqual(["invite_team", "connect_calendar", "connect_slack"]);
    const v = checklistView("owner", {}, { invite_team: true, connect_calendar: true, connect_slack: true }, { hidden: ["add_domain"] });
    expect([v.done, v.total, v.complete]).toEqual([3, 3, true]);
    expect(showSetupChecklist("owner", {}, { invite_team: true, connect_calendar: true, connect_slack: true }, { hidden: ["add_domain"] })).toBe(false);
  });
  it("signals from the app's own facts", () => {
    expect(setupSignals({ teammates: 2, calendars: 0, slack: true, plannedToday: true, installed: false })).toEqual({
      invite_team: true, connect_calendar: false, add_domain: false, connect_slack: true,
      plan_day: true, complete_task: false, install_app: false, set_notifications: false,
    });
  });
  it("counts manual ticks and what the app can see; signal ticks can't be unticked", () => {
    const state: OnboardingState = { checklist: { done: { invite_team: "2026-10-08T09:00:00.000Z" } } };
    const v = checklistView("owner", state, { connect_calendar: true, plan_day: true });
    expect(v.items.map((i) => [i.id, i.done, !!i.auto])).toEqual([
      ["invite_team", true, false], ["connect_calendar", true, true], ["add_domain", false, false], ["connect_slack", false, false],
    ]);
    expect([v.done, v.total, v.complete]).toEqual([2, 4, false]);
    expect(v.items[0]).toMatchObject({ label: "Invite your team", action: "Invite" });
    expect(showSetupChecklist("owner", state, {})).toBe(true);
  });
  it("the shell's word-free count agrees with the card's view, for every role and mix of ticks", () => {
    const state: OnboardingState = { checklist: { done: { plan_day: "a", connect_slack: "b", install_app: "c" } } };
    const signals = { invite_team: true, set_notifications: true, complete_task: true };
    for (const role of ["owner", "member", "guest"] as const) {
      for (const opts of [{}, { hidden: ["add_domain", "plan_day"] as const }]) {
        const { items: _items, ...v } = checklistView(role, state, signals, opts);
        expect(checklistProgress(role, state, signals, opts)).toEqual(v);
      }
    }
  });
  it("complete or dismissed: no card", () => {
    const all = { install_app: true, set_notifications: true };
    expect(checklistView("guest", {}, all).complete).toBe(true);
    expect(showSetupChecklist("guest", {}, all)).toBe(false);
    expect(showSetupChecklist("member", { checklist: { dismissedAt: NOW.toISOString() } }, {})).toBe(false);
    expect(showSetupChecklist("member", dismissSetupChecklist(dismissSetupChecklist({}, true), false), {})).toBe(true);
  });
  it("ticks and unticks by hand, keeping the first tick's time", () => {
    const a = tickSetupItem({}, "plan_day", true);
    expect(a.checklist?.done).toEqual({ plan_day: NOW.toISOString() });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect(tickSetupItem(a, "plan_day", true).checklist?.done?.plan_day).toBe(NOW.toISOString());
    expect(tickSetupItem(a, "plan_day", false).checklist?.done).toEqual({});
  });
  it("records what the app can see, once (only the role's items)", () => {
    const s = withSignalTicks("member", { checklist: { done: { plan_day: "x" } } }, { plan_day: true, install_app: true, invite_team: true });
    expect(s?.checklist?.done).toEqual({ plan_day: "x", install_app: NOW.toISOString() });
    expect(withSignalTicks("member", s!, { install_app: true })).toBeNull();
  });
  it("useShowSetupChecklist keeps the card for its celebration, then lets it go", () => {
    let state: OnboardingState = { checklist: { done: { install_app: "a" } } };
    const { result, rerender } = renderHook(() => useShowSetupChecklist("guest", state, {}));
    expect(result.current).toBe(true);
    state = tickSetupItem(state, "set_notifications", true);
    rerender();
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(CHECKLIST_CELEBRATE_MS - 10); });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current).toBe(false);
  });
  it("…but never celebrates a list that was already complete, or one that was dismissed", () => {
    const { result } = renderHook(() => useShowSetupChecklist("guest", {}, { install_app: true, set_notifications: true }));
    expect(result.current).toBe(false);
    let state: OnboardingState = {};
    const h = renderHook(() => useShowSetupChecklist("guest", state, {}));
    state = dismissSetupChecklist(state, true);
    h.rerender();
    expect(h.result.current).toBe(false);
  });
});

describe("saving (merge_onboarding's rules)", () => {
  it("one level deep; null removes a key; unknown keys dropped", () => {
    const s: OnboardingState = { v: 1, tour: { step: "search", done: false }, momentum: { streakHidden: true } };
    expect(applyOnboardingPatch(s, { tour: { step: null, done: true }, sample: null })).toEqual({ v: 1, tour: { step: null, done: true }, momentum: { streakHidden: true } });
    expect(applyOnboardingPatch(s, { momentum: null })).toEqual({ v: 1, tour: { step: "search", done: false } });
    expect(applyOnboardingPatch({}, { pwned: true } as never)).toEqual({});
  });
  it("the patch from one state to the next: changed keys only, removed ones as null, never someone else's key", () => {
    const prev: OnboardingState = { v: 1, tour: { step: "search", done: false }, momentum: { streakHidden: true }, sample: { projectId: "p", taskIds: [], createdAt: "x" } };
    const next: OnboardingState = { v: 1, tour: { step: "capture", done: false }, momentum: { streakHidden: true } };
    expect(onboardingPatch(prev, next)).toEqual({ tour: { step: "capture", done: false }, sample: null });
    expect(onboardingPatch(next, next)).toEqual({});
    expect(onboardingPatch({}, { checklist: { dismissedAt: "d" } })).toEqual({ checklist: { dismissedAt: "d" }, v: 1 });
  });
  it("demo mode keeps it in memory, on top of the state the app shows", async () => {
    expect(await saveOnboarding({ tour: { step: "places", done: false } }, { momentum: { recapHidden: true } }))
      .toEqual({ tour: { step: "places", done: false }, momentum: { recapHidden: true } });
    expect(await saveOnboarding({ checklist: { done: { plan_day: "t" } } })).toEqual({
      tour: { step: "places", done: false }, momentum: { recapHidden: true }, checklist: { done: { plan_day: "t" } },
    });
    const prev = { tour: { step: "places", done: false } };
    expect(await saveOnboardingChange(prev, { ...prev, checklist: { dismissedAt: "d" } })).toEqual({ v: 1, tour: { step: "places", done: false }, checklist: { dismissedAt: "d" } });
  });
  it("useOnboardingState: shows a change at once, keeps what was saved, follows a reloaded profile", async () => {
    let profile: OnboardingState | undefined = { momentum: { recapHidden: true } };
    const { result, rerender } = renderHook(() => useOnboardingState(profile));
    expect(result.current[0]).toEqual({ momentum: { recapHidden: true } });
    act(() => result.current[1](tickSetupItem(result.current[0], "plan_day", true)));
    expect(result.current[0].checklist?.done?.plan_day).toBe(NOW.toISOString());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current[0]).toEqual({ v: 1, momentum: { recapHidden: true }, checklist: { done: { plan_day: NOW.toISOString() } } });
    profile = { tour: { step: null, done: true } };
    rerender();
    expect(result.current[0]).toEqual({ tour: { step: null, done: true } });
    const stored: OnboardingState = { tour: { step: null, done: true }, sample: { projectId: "p", taskIds: [], createdAt: "c" } };
    act(() => result.current[2](stored));
    expect(result.current[0]).toBe(stored);
  });
  it("failures by kind", () => {
    expect(onboardingFailure({ message: "not authorized" })).toBe("not_allowed");
    expect(onboardingFailure({ message: "permission denied for function merge_onboarding", code: "42501" })).toBe("not_allowed");
    expect(onboardingFailure({ message: "invalid patch" })).toBe("invalid");
    expect(onboardingFailure({ message: 'new row violates check constraint "profiles_onboarding_shape"', code: "23514" })).toBe("too_big");
    expect(onboardingFailure({ message: "Could not find the function public.merge_onboarding(p_patch) in the schema cache", code: "PGRST202" })).toBe("unavailable");
    expect(onboardingFailure(new TypeError("Failed to fetch"))).toBe("network");
    expect(onboardingFailure("boom")).toBe("error");
  });
  it("the demo profile's first run: tour done, one item ticked", () => {
    const d = demoOnboardingState(NOW);
    expect(d.tour).toMatchObject({ done: true, step: null });
    expect(checklistView("owner", d, {}).done).toBe(1);
  });
});

describe("the sample project, through the lean module", () => {
  const fakeDeps = () => {
    const tasks: Task[] = [];
    const deps: TourSampleDeps = {
      createProject: vi.fn(async (input) => ({ id: "proj-1", ...input } as Project)),
      createTasks: vi.fn(async (ts: Task[]) => { tasks.push(...ts); return ts; }),
      addDependency: vi.fn(async () => {}),
      createDoc: vi.fn(async () => ({ id: "doc-1" })),
      deleteProject: vi.fn(async () => {}),
    };
    return { deps, tasks };
  };
  it("plan is re-exported and pure", () => {
    const ctx = { today: NOW, currentUserId: "me", workspaceId: null };
    expect(tourSamplePlan(ctx)).toEqual(tourSamplePlan(ctx));
  });
  it("create records it in profiles.onboarding.sample; remove forgets it", async () => {
    const { deps, tasks } = fakeDeps();
    const state = await createTourSample(deps, { today: NOW, currentUserId: "me", workspaceId: null, current: { tour: { step: null, done: true } } });
    expect(state.tour).toEqual({ step: null, done: true });
    expect(state.sample).toMatchObject({ projectId: "proj-1", docId: "doc-1", createdAt: NOW.toISOString() });
    expect(state.sample!.taskIds).toEqual(tasks.map((t) => t.id));
    expect(state.sample!.taskIds[0]).toBe(tasks.find((t) => t.title.startsWith("Start here"))!.id);
    const after = await removeTourSample(deps, state);
    expect(deps.deleteProject).toHaveBeenCalledWith("proj-1");
    expect(after.sample).toBeUndefined();
    expect(after.tour).toEqual({ step: null, done: true });
  });
  it("a failed removal keeps it (so “Remove” stays on offer)", async () => {
    const { deps } = fakeDeps();
    deps.deleteProject = vi.fn(async () => { throw new Error("Failed to fetch"); });
    const s: OnboardingState = { sample: { projectId: "p", taskIds: [], createdAt: "c" } };
    await expect(removeTourSample(deps, s)).rejects.toThrow("Failed to fetch");
  });
});

describe("the shell's first download stays lean", () => {
  // Rollup puts a module the shell imports in the first download with every export a lazy chunk uses from it,
  // and runs (so keeps) any module with load-time side effects. The words and the sample must stay lazy.
  const read = async (f: string) => {
    const nodeFs = "node:fs";
    const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
    const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;
    return readFileSync(`${cwd()}/src/lib/${f.replace("./", "")}`, "utf8");
  };
  it("lib/onboarding only re-exports the words and the sample; they never import it back (types aside)", async () => {
    const lean = await read("./onboarding.ts");
    expect(lean).not.toMatch(/^import \{[^}]*\b(tourSteps|resumeIndex|checklistView|SETUP_COPY|tourSamplePlan|buildTourSample)\b[^}]*\} from/m);
    expect(lean).toMatch(/await import\("\.\/onboardingSample"\)/);
    for (const f of ["./onboardingCopy.ts", "./onboardingSample.ts", "./onboardingItems.ts"]) {
      expect(await read(f), f).not.toMatch(/^import \{[^}]*\} from "\.\/onboarding";/m);
    }
  });
  it("the words module does nothing at load (no top-level spreads or calls)", async () => {
    const copy = await read("./onboardingCopy.ts");
    expect(copy).not.toMatch(/^const [^\n]*=\s*\{\s*\.\.\./m);
    expect(copy).not.toMatch(/^const [^\n]*=\s*[\w.]+\(/m);
  });
});
