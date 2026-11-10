/* Check-ins and links from the app: each shows at once, moves the goal's number as the
   server will, and is put back (with a word) when the server says no. */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { Goal, GoalCheckin, GoalExtras, GoalLink } from "../../data/types";
import { useGoalWrites, type GoalWriteStore } from "./useGoalWrites";

const G: Goal = { id: "g", name: "Grow", status: "on_track", workspaceId: "ws", target: 5000, current: 3760, confidence: 3 };
const OLD: GoalCheckin = { id: "c1", goalId: "g", workspaceId: "ws", authorId: "m-1", value: 3550, confidence: 2, createdAt: "2026-10-25T17:00:00Z" };
const NEWEST: GoalCheckin = { id: "c2", goalId: "g", workspaceId: "ws", authorId: "m-1", value: 3760, confidence: 3, createdAt: "2026-11-08T17:00:00Z" };

type Undo = { message: string; run: () => void; onExpire: () => void };

function setup(store: Partial<GoalWriteStore>, o: { guest?: boolean; undo?: Undo[] } = {}) {
  const failed = vi.fn();
  const saveFailed = vi.fn(() => failed);
  const full: GoalWriteStore = {
    addGoalCheckin: vi.fn(), deleteGoalCheckin: vi.fn(async () => undefined), addGoalLink: vi.fn(), removeGoalLink: vi.fn(async () => undefined), ...store,
  } as GoalWriteStore;
  const hook = renderHook(() => {
    const [goals, setGoals] = useState<Goal[]>([G]);
    const [extras, setExtras] = useState<GoalExtras | null>({ checkins: [NEWEST, OLD], links: [] });
    const offerUndo = o.undo ? (message: string, _label: string, run: () => void, opts: { onExpire: () => void }) => { o.undo!.push({ message, run, onExpire: opts.onExpire }); } : undefined;
    const writes = useGoalWrites({ store: full, setGoals, setExtras, userIdRef: { current: "m-self" }, denyGuest: () => !!o.guest, saveFailed, offerUndo });
    return { goals, extras, writes };
  });
  return { hook, store: full, saveFailed, failed };
}

describe("useGoalWrites", () => {
  it("a check-in shows at once, moves the goal's number and confidence, and takes the server's row", async () => {
    let resolve: (c: GoalCheckin) => void = () => {};
    const { hook, store } = setup({ addGoalCheckin: vi.fn(() => new Promise<GoalCheckin>((r) => { resolve = r; })) });
    act(() => hook.result.current.writes.checkin(G, 3900, 4, "Referral pilot live"));
    expect(hook.result.current.extras?.checkins[0]).toMatchObject({ goalId: "g", authorId: "m-self", value: 3900, confidence: 4, note: "Referral pilot live" });
    expect(hook.result.current.goals[0]).toMatchObject({ current: 3900, confidence: 4 });
    expect(store.addGoalCheckin).toHaveBeenCalledWith({ goalId: "g", workspaceId: "ws", value: 3900, confidence: 4, note: "Referral pilot live" }, "m-self");
    await act(async () => resolve({ ...NEWEST, id: "c3", value: 3900, createdAt: "2026-11-10T12:00:00Z" }));
    expect(hook.result.current.extras?.checkins.map((c) => c.id)).toEqual(["c3", "c2", "c1"]);
  });

  it("refused, it's taken off and the goal's number goes back, with a word", async () => {
    const { hook, failed } = setup({ addGoalCheckin: vi.fn(async () => { throw new Error("new row violates row-level security policy"); }) });
    await act(async () => hook.result.current.writes.checkin(G, 9999, null, ""));
    expect(hook.result.current.extras?.checkins.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(hook.result.current.goals[0]).toMatchObject({ current: 3760, confidence: 3 });
    expect(failed).toHaveBeenCalled();
  });

  it("taking back the newest puts the one before back as the goal's number", async () => {
    const { hook, store } = setup({});
    await act(async () => hook.result.current.writes.removeCheckin("c2", G, [NEWEST, OLD]));
    expect(store.deleteGoalCheckin).toHaveBeenCalledWith("c2");
    expect(hook.result.current.extras?.checkins.map((c) => c.id)).toEqual(["c1"]);
    expect(hook.result.current.goals[0]).toMatchObject({ current: 3550, confidence: 2 });
  });

  it("with an Undo on offer, taking one back waits: Undo puts it and the number back and nothing is sent; else it's sent when the toast goes", async () => {
    const undo: Undo[] = [];
    const { hook, store } = setup({}, { undo });
    act(() => hook.result.current.writes.removeCheckin("c2", G, [NEWEST, OLD]));
    expect(undo).toHaveLength(1);
    expect(undo[0].message).toBe("Check-in taken back");
    expect(hook.result.current.extras?.checkins.map((c) => c.id)).toEqual(["c1"]);
    expect(store.deleteGoalCheckin).not.toHaveBeenCalled();
    act(() => undo[0].run());
    expect(hook.result.current.extras?.checkins.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(hook.result.current.goals[0]).toMatchObject({ current: 3760, confidence: 3 });
    act(() => undo[0].onExpire());
    expect(store.deleteGoalCheckin).not.toHaveBeenCalled();   // undone: never sent
    act(() => hook.result.current.writes.removeCheckin("c1", G, [NEWEST, OLD]));
    await act(async () => undo[1].onExpire());
    expect(store.deleteGoalCheckin).toHaveBeenCalledWith("c1");
    expect(hook.result.current.extras?.checkins.map((c) => c.id)).toEqual(["c2"]);
  });

  it("taking back the only check-in puts back the value from before it", async () => {
    const { hook } = setup({});
    await act(async () => hook.result.current.writes.removeCheckin("c9", { ...G, current: 4100 }, [{ ...NEWEST, id: "c9", value: 4100, prevValue: 3200 }]));
    // (c9 isn't in this hook's extras, so it's found in the list passed in)
    expect(hook.result.current.goals[0]).toMatchObject({ current: 3200 });
  });

  it("links and unlinks, putting things back when refused; a guest is turned away before anything is sent", async () => {
    const saved: GoalLink = { id: "l1", goalId: "g", workspaceId: "ws", kind: "project", targetId: "p1" };
    const { hook, store, failed } = setup({ addGoalLink: vi.fn(async () => saved), removeGoalLink: vi.fn(async () => { throw new Error("nope"); }) });
    await act(async () => hook.result.current.writes.link(G, "project", "p1"));
    expect(hook.result.current.extras?.links).toEqual([saved]);
    await act(async () => hook.result.current.writes.unlink(saved));
    expect(store.removeGoalLink).toHaveBeenCalledWith("l1");
    expect(hook.result.current.extras?.links).toEqual([saved]);
    expect(failed).toHaveBeenCalled();
    const guest = setup({}, { guest: true });
    act(() => guest.hook.result.current.writes.checkin(G, 1, null, ""));
    act(() => guest.hook.result.current.writes.link(G, "task", "t1"));
    expect(guest.store.addGoalCheckin).not.toHaveBeenCalled();
    expect(guest.store.addGoalLink).not.toHaveBeenCalled();
  });
});
