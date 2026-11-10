/* useRollout (0057), the app's side of a rollout: which "Get set up" items a team's owner sees (the update
   day once the sign-in read says 0053 is in; nothing for a business that's long been going), the items
   that tick when they're done here (a pack, an import, the pilot invite), and the first run's import,
   which goes into "Our work" of its own, never into a pack's project. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { OnboardingState, Project, Workspace, WorkspaceMember } from "../../data/types";
import { noteRhythmSchema, resetRhythmSchema } from "../../lib/updateRhythm";
import { TEAM_SETUP_ITEMS, tickedAt } from "../../lib/onboarding";
import { store } from "../../data/store";
import { IMPORT_HOME, useRollout, type RolloutAppHost } from "./useRollout";
import type { PackHost } from "../packs/packTypes";

const NOW = new Date(2026, 10, 10, 9, 0);
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); resetRhythmSchema(); vi.restoreAllMocks(); });

const fresh: Workspace = { id: "ws-new", name: "Northside", kind: "team", ownerId: "me", createdAt: new Date(NOW.getTime() - 3_600_000).toISOString() };
const old: Workspace = { id: "ws-old", name: "Foundrise", kind: "team", ownerId: "me" };
const owner = (ws: string): WorkspaceMember => ({ id: `wm-${ws}`, workspaceId: ws, userId: "me", email: "me@acme.co", name: "Me", role: "owner", status: "active" });

function hostOf(over: Partial<RolloutAppHost> = {}): RolloutAppHost {
  return {
    me: "me", workspace: "ws-new", view: "plan", role: "owner", workspaces: [{ id: null, name: "Personal", kind: "personal" }, fresh, old], setWorkspaces: vi.fn(),
    members: [owner("ws-new"), owner("ws-old")], projects: [], tasks: [], statusUpdates: [], goals: [], goalExtras: null, goalReads: new Map(),
    onboarding: {}, changeOnboarding: vi.fn(), today: NOW, newProjectOpen: false, importOpen: false, firstRunOpen: false,
    setRoute: vi.fn(), openTask: vi.fn(), openGoal: vi.fn(), patchTask: vi.fn(), makeWorkspace: vi.fn(async () => "ws-new"), adoptProjects: vi.fn(),
    openPacks: vi.fn(), openImport: vi.fn(), inviteMember: vi.fn(async () => ({})), toast: vi.fn(), toastAction: vi.fn(), toastError: vi.fn(),
    ...over,
  };
}

describe("Get set up for a team's owner", () => {
  it("shows Set your update day as soon as the sign-in read says update days are in (it isn't decided once, before)", () => {
    noteRhythmSchema(false);
    const { result, rerender } = renderHook((h: RolloutAppHost) => useRollout(h), { initialProps: hostOf() });
    expect(result.current.setupHidden).toEqual(["set_update_day"]);
    // the sign-in read comes back with 0053's column: the next render shows it
    noteRhythmSchema(true);
    rerender(hostOf({ workspaces: [...hostOf().workspaces] }));
    expect(result.current.setupHidden).toEqual([]);
  });
  it("is for a workspace being set up: one long going, whose owner finished the old list, gets no new card", () => {
    noteRhythmSchema(true);
    const finished = { invite_team: "2026-01-01", connect_calendar: "2026-01-01", connect_slack: "2026-01-02" };
    const { result } = renderHook(() => useRollout(hostOf({ workspace: "ws-old", onboarding: { checklist: { done: finished } } })));
    expect(new Set(result.current.setupHidden)).toEqual(TEAM_SETUP_ITEMS);
    // (the old list not finished: the card they'd have seen anyway is the new one)
    const unfinished = renderHook(() => useRollout(hostOf({ workspace: "ws-old", onboarding: { checklist: { done: { invite_team: "2026-01-01" } } } })));
    expect(unfinished.result.current.setupHidden).toEqual([]);
    // a new workspace gets it whatever was done before
    expect(renderHook(() => useRollout(hostOf({ onboarding: { checklist: { done: finished } } }))).result.current.setupHidden).toEqual([]);
    // (a workspace whose rollout list was started keeps it)
    const started = renderHook(() => useRollout(hostOf({ workspace: "ws-old", onboarding: { checklist: { teams: { "ws-old": { pick_pack: "2026-11-01" } } } } })));
    expect(started.result.current.setupHidden).toEqual([]);
    // Personal is never a team's list
    expect(renderHook(() => useRollout(hostOf({ workspace: null, role: undefined }))).result.current.setupHidden).toEqual([]);
  });
});

describe("Get set up ticks itself when it's done here", () => {
  const ticks = (change: ReturnType<typeof vi.fn>) => (change.mock.calls[change.mock.calls.length - 1]?.[0] as OnboardingState | undefined)?.checklist;

  it("an import into the team's workspace ticks Bring your work in, whatever its size", () => {
    const changeOnboarding = vi.fn();
    const { result } = renderHook(() => useRollout(hostOf({ changeOnboarding })));
    act(() => result.current.noteImport(5));
    expect(tickedAt(ticks(changeOnboarding), "import_work", { workspaceId: "ws-new" })).toBeTruthy();
    expect(tickedAt(ticks(changeOnboarding), "import_work", { workspaceId: "ws-old" })).toBeUndefined();
  });
  it("the first run's pilot invite ticks Invite your pilot group, and a pack set up ticks Start from a business pack (both kept)", async () => {
    // (the app's onboarding state follows each change)
    let ob: OnboardingState = {};
    const changeOnboarding = vi.fn((next: OnboardingState) => { ob = next; });
    const { result } = renderHook(() => useRollout(hostOf({ onboarding: ob, changeOnboarding, firstRunOpen: true, freshFirstRun: true })));
    await act(async () => { await result.current.teamStart!.invite("ws-new", ["sam@acme.co", "jo@acme.co"]); });
    expect(tickedAt(ticks(changeOnboarding), "invite_pilot", { workspaceId: "ws-new" })).toBeTruthy();
    const packs: PackHost = {
      context: { mode: "project", today: NOW, goalsV2: true, canSetGoals: true, canSetUpdateDay: true },
      apply: vi.fn(async () => ({ workspaceId: "ws-new", applied: { projects: [{ id: "p1" }] } }) as never), undo: vi.fn(), printPoster: vi.fn(),
    };
    await act(async () => { await result.current.wrapPacks(packs).apply!({ id: "pack-venue", name: "Padel or sports venue" } as never, {} as never); });
    const list = ticks(changeOnboarding);
    expect(tickedAt(list, "pick_pack", { workspaceId: "ws-new" })).toBeTruthy();
    expect(tickedAt(list, "invite_pilot", { workspaceId: "ws-new" })).toBeTruthy();
  });
  it("in a workspace that's only just been made, New project's packs set it up with its update day ticked", () => {
    const packs: PackHost = { context: { mode: "project", today: NOW, goalsV2: true, canSetGoals: true, canSetUpdateDay: true }, apply: vi.fn(), undo: vi.fn(), printPoster: vi.fn() };
    const empty = renderHook(() => useRollout(hostOf()));
    expect(empty.result.current.wrapPacks(packs).context.newWorkspace).toBe(true);
    const going = renderHook(() => useRollout(hostOf({ projects: [{ id: "p1", name: "Ops", emoji: "⚙️", color: "#36f", workspaceId: "ws-new" } as Project] })));
    expect(going.result.current.wrapPacks(packs).context.newWorkspace).toBeUndefined();
  });
});

describe("the first run's import", () => {
  it("goes into a project of its own, never the pack's first project", async () => {
    const court: Project = { id: "p-court", name: "Court maintenance", emoji: "🧹", color: "#3a6", workspaceId: "ws-new" };
    const made: Project = { id: "p-ours", name: IMPORT_HOME, emoji: "📥", color: "#36f", workspaceId: "ws-new" };
    const create = vi.spyOn(store, "createProject").mockResolvedValue(made);
    // (the app's import sheet opens when asked, and its projects follow what's adopted)
    let importOpen = false;
    let projects = [court];
    const adoptProjects = vi.fn((ps: Project[]) => { projects = [...projects, ...ps]; });
    const openImport = vi.fn(() => { importOpen = true; });
    const { result, rerender } = renderHook(() => useRollout(hostOf({ projects, adoptProjects, openImport, importOpen, firstRunOpen: true, freshFirstRun: true })));
    await act(async () => { await result.current.teamStart!.importWork("ws-new"); });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Our work", workspaceId: "ws-new" }), "me");
    expect(result.current.importInto).toBe("p-ours");
    expect(openImport).toHaveBeenCalled();
    // once it's there, it's used again
    create.mockClear();
    importOpen = false;
    rerender();
    await act(async () => { await result.current.teamStart!.importWork("ws-new"); });
    expect(create).not.toHaveBeenCalled();
    expect(result.current.importInto).toBe("p-ours");
  });
});

describe("Kanbo noticed's rollout card: only where a rollout's under way", () => {
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
  const est: Workspace = { id: "ws-est", name: "Wellverse", kind: "team", ownerId: "me", createdAt: ago(200) };
  const young: Workspace = { id: "ws-young", name: "The Standing", kind: "team", ownerId: "me", createdAt: ago(45) };
  const teammate = (ws: string): WorkspaceMember => ({ id: `wm-${ws}-maya`, workspaceId: ws, userId: "maya", email: "maya@acme.co", name: "Maya Lin", role: "member", status: "active" });
  const proj = (ws: string): Project => ({ id: `p-${ws}`, name: "Ops", emoji: "⚙️", color: "#36f", workspaceId: ws, ownerId: "maya" } as Project);
  const loose = (ws: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${ws}-t${i}`, title: `Task ${i}`, status: "todo", priority: "medium", projectId: `p-${ws}`,
    workspaceId: ws, assigneeId: "", dueDate: "2026-11-20", createdAt: ago(100), tags: [], dependencies: [], subtasks: [], comments: 0 })) as never[];
  const at = (w: Workspace, over: Partial<RolloutAppHost> = {}) => hostOf({
    workspace: w.id, workspaces: [{ id: null, name: "Personal", kind: "personal" }, w], members: [owner(w.id!), teammate(w.id!)], projects: [proj(w.id!)],
    tasks: loose(w.id!, 6), onboarding: { checklist: { done: { invite_team: "2026-01-01", connect_calendar: "2026-01-01", connect_slack: "2026-01-02" } } }, ...over,
  });

  it("a business that's long been going (made before rollouts came in, however young) gets no daily card", () => {
    for (const w of [est, young]) {
      const { result } = renderHook(() => useRollout(at(w)));
      expect(result.current.today).toBeUndefined();
      // (and no new Get set up list there either: its owner finished the old one)
      expect(new Set(result.current.setupHidden)).toEqual(TEAM_SETUP_ITEMS);
    }
  });
  it("one with a rollout plan under way gets it (until a month after go-live); a new one gets it", () => {
    const planned = renderHook(() => useRollout(at({ ...est, rollout: { champion: "maya", goLive: "2026-11-20" } })));
    expect(planned.result.current.today?.noticed[0]).toMatchObject({ id: "rollout:owner:ws-est", title: "6 tasks in Wellverse have no owner" });
    const over = renderHook(() => useRollout(at({ ...est, rollout: { champion: "maya", goLive: "2026-09-01" } })));
    expect(over.result.current.today).toBeUndefined();
    const made = { ...fresh, id: "ws-new" };
    expect(renderHook(() => useRollout(at(made))).result.current.today?.noticed[0].id).toBe("rollout:owner:ws-new");
  });
  it("its id stays the same as the count moves, so Not now holds for the day", () => {
    const { result, rerender } = renderHook((h: RolloutAppHost) => useRollout(h), { initialProps: at(fresh) });
    const before = result.current.today?.noticed[0].id;
    rerender(at(fresh, { tasks: loose("ws-new", 5) }));
    expect(result.current.today?.noticed[0].id).toBe(before);
  });
  it("never offers Ask for updates before asking works (0053): no update asks, or no update days", () => {
    // every task owned and dated, no update ever: the project's update is missing
    const owned = loose("ws-new", 2).map((t: { assigneeId: string }) => ({ ...t, assigneeId: "maya" })) as never[];
    const ask = { canAsk: () => true, asked: () => undefined, ask: vi.fn(async () => ({}) as never) };
    noteRhythmSchema(false);
    const none = renderHook(() => useRollout(at(fresh, { tasks: owned })));
    expect(none.result.current.today).toBeUndefined();
    const noAsks = renderHook(() => useRollout(at(fresh, { tasks: owned, askForUpdate: ask })));
    expect(noAsks.result.current.today).toBeUndefined();
    noteRhythmSchema(true);
    const on = renderHook(() => useRollout(at(fresh, { tasks: owned, askForUpdate: ask, view: "team" })));
    expect(on.result.current.today?.noticed[0].actions[0]).toMatchObject({ fix: "ask" });
  });
  it("a pack set up in a business long going doesn't start a Get set up list there", async () => {
    const changeOnboarding = vi.fn();
    const { result } = renderHook(() => useRollout(at(est, { changeOnboarding })));
    const packs: PackHost = { context: { mode: "project", today: NOW, goalsV2: true, canSetGoals: true, canSetUpdateDay: true },
      apply: vi.fn(async () => ({ workspaceId: "ws-est", applied: { projects: [{ id: "p1" }] } }) as never), undo: vi.fn(), printPoster: vi.fn() };
    await act(async () => { await result.current.wrapPacks(packs).apply!({ id: "pack-venue", name: "Padel or sports venue" } as never, {} as never); });
    expect(changeOnboarding).not.toHaveBeenCalled();
  });
});

describe("a fix opened from Kanbo noticed opens the card on it once", () => {
  it("Assign now opens the sheet; back on People later, it stays shut", async () => {
    const { render, screen, fireEvent } = await import("@testing-library/react");
    // (this file's afterEach restores every mock, the set-up's matchMedia with them: the card's sheet reads it)
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }) as never);
    const DAY = 86_400_000;
    const made: Workspace = { ...fresh };
    const host = (view: RolloutAppHost["view"]) => hostOf({
      view, workspaces: [{ id: null, name: "Personal", kind: "personal" }, made],
      members: [owner("ws-new"), { id: "wm-maya", workspaceId: "ws-new", userId: "maya", email: "maya@acme.co", name: "Maya Lin", role: "member", status: "active" }],
      projects: [{ id: "p1", name: "Ops", emoji: "⚙️", color: "#36f", workspaceId: "ws-new", ownerId: "maya" } as Project],
      tasks: [{ id: "t1", title: "Order springs", status: "todo", priority: "medium", projectId: "p1", workspaceId: "ws-new", assigneeId: "", dueDate: "2026-11-20",
        createdAt: new Date(NOW.getTime() - DAY).toISOString(), tags: [], dependencies: [], subtasks: [], comments: 0 }] as never[],
    });
    const { result, rerender } = renderHook((h: RolloutAppHost) => useRollout(h), { initialProps: host("plan") });
    expect(result.current.today?.noticed[0].actions[0]).toMatchObject({ fix: "assign" });
    act(() => result.current.today!.onFix("assign"));
    rerender(host("team"));
    const first = render(<>{result.current.healthSlot!()}</>);
    expect(await screen.findByRole("dialog", { name: "Tasks with no owner or date" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    first.unmount();
    // Today, then People again: the card mounts afresh
    rerender(host("plan"));
    rerender(host("team"));
    render(<>{result.current.healthSlot!()}</>);
    expect(await screen.findByRole("region", { name: "Workspace health" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Tasks with no owner or date" })).toBeNull();
  });
});
