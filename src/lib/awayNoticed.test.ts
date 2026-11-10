import { describe, expect, it } from "vitest";
import type { Task } from "../data/types";
import { awayGivePatches, awayMovePatches, awayNoticed } from "./awayNoticed";
import { EMPTY_AVAILABILITY, type AvailabilityState } from "./availability";

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "aw" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "sana", workspaceId: "ws",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...o,
});
const today = "2026-11-10";   // a Tuesday
const names: Record<string, string> = { sana: "Sana Rao", me: "Daniel Okai", theo: "Theo Vance", maya: "Maya Lin" };
const state = (o: Partial<AvailabilityState> = {}): AvailabilityState => ({
  ...EMPTY_AVAILABILITY, status: "on", me: "me", activeWs: "ws", roles: { ws: { me: "owner", sana: "member" }, them: { me: "member", sana: "member" } },
  timeOff: [{ id: "o1", userId: "sana", startsOn: "2026-11-11", endsOn: "2026-11-13", halfDay: null }],
  ...o,
});
const run = (tasks: Task[], s = state()) => awayNoticed({ tasks, today, s, nameOf: (id) => names[id] ?? "" });

describe("awayNoticed", () => {
  it("offers to move a teammate's work due while they're away to the day they're back", () => {
    const tasks = [task({ title: "FAQ copy", dueDate: "2026-11-11" }), task({ title: "Hero", dueDate: "2026-11-13" }), task({ title: "Later", dueDate: "2026-11-20" })];
    const [card, ...rest] = run(tasks);
    expect(rest).toEqual([]);
    expect(card.title).toBe("Sana's away when two tasks are due");
    expect(card.body).toBe("Sana is off 11–13 Nov, and “FAQ copy” and “Hero” are due then. Move them to Mon, when Sana's back?");
    expect(card.actions[0]).toEqual({ kind: "away", label: "Move to Mon", userId: "sana", taskIds: [tasks[0].id, tasks[1].id], to: "2026-11-16" });
  });
  it("speaks to you about your own, anywhere", () => {
    const s = state({ timeOff: [{ id: "o2", userId: "me", startsOn: "2026-11-12", endsOn: "2026-11-12", halfDay: null }] });
    const [card] = run([task({ assigneeId: "me", workspaceId: "them", title: "Board pack", dueDate: "2026-11-12" })], s);
    expect(card.title).toBe("You're away when a task is due");
    // (Sana's around at "them" with room: you may hand your own work to a teammate)
    expect(card.body).toBe("You're off Thu 12 Nov, and “Board pack” is due Thu. Sana has room then: give it to Sana, or move it to Fri, your first day back?");
  });
  it("says nothing about a teammate's work where you don't lead, half days, done work, or before 0055", () => {
    expect(run([task({ workspaceId: "them", dueDate: "2026-11-11" })])).toEqual([]);
    expect(run([task({ dueDate: "2026-11-11", status: "done" })])).toEqual([]);
    expect(run([task({ dueDate: "2026-11-11" })], state({ timeOff: [{ id: "h", userId: "sana", startsOn: "2026-11-11", endsOn: "2026-11-11", halfDay: "pm" }] }))).toEqual([]);
    expect(run([task({ dueDate: "2026-11-11" })], state({ status: "off" }))).toEqual([]);
  });
  it("offers first to give the work to the teammate with the most room that week (not you, not someone off then)", () => {
    const roles = { ws: { me: "owner" as const, sana: "member" as const, theo: "member" as const, maya: "member" as const, gus: "guest" as const } };
    const tasks = [task({ title: "FAQ copy", dueDate: "2026-11-11", effortHours: 4 }), task({ title: "Hero", dueDate: "2026-11-13", effortHours: 4 }),
      // Maya's week is nearly full
      task({ assigneeId: "maya", title: "Big build", dueDate: "2026-11-12", effortHours: 34 })];
    // Theo's off on the Friday the hero's due: Maya has no room, so nobody can take it
    const blocked = run(tasks, state({ roles, timeOff: [...state().timeOff, { id: "t", userId: "theo", startsOn: "2026-11-13", endsOn: "2026-11-13", halfDay: null }] }));
    expect(blocked[0].actions.map((a) => a.label)).toEqual(["Move to Mon", "Open it"]);
    const [card] = run(tasks, state({ roles }));
    expect(card.body).toBe("Sana is off 11–13 Nov, and “FAQ copy” and “Hero” are due then. Theo has room then: give them to Theo, or move them to Mon, when Sana's back?");
    expect(card.actions).toEqual([
      { kind: "away", label: "Give to Theo", userId: "sana", taskIds: [tasks[0].id, tasks[1].id], to: "2026-11-16", assignTo: "theo" },
      { kind: "away", label: "Move to Mon", userId: "sana", taskIds: [tasks[0].id, tasks[1].id], to: "2026-11-16" },
    ]);
    expect(awayGivePatches(tasks, [tasks[0].id], "theo")).toEqual({ apply: [{ id: tasks[0].id, patch: { assigneeId: "theo" } }], undo: [{ id: tasks[0].id, patch: { assigneeId: "sana" } }] });
  });
  it("leaves your own work alone where you're only a guest (guests don't change work)", () => {
    const s = state({ roles: { ws: { me: "owner", sana: "member" }, g: { me: "guest", idris: "owner" } },
      timeOff: [{ id: "o2", userId: "me", startsOn: "2026-11-12", endsOn: "2026-11-12", halfDay: null }] });
    expect(run([task({ assigneeId: "me", workspaceId: "g", dueDate: "2026-11-12" })], s)).toEqual([]);
    // (your Personal work is yours to move)
    expect(run([task({ assigneeId: "me", workspaceId: "personal", dueDate: "2026-11-12" })], s)).toHaveLength(1);
  });
  it("moves the work (a start date keeps its span) and can put it back", () => {
    const a = task({ id: "a", dueDate: "2026-11-11", startDate: "2026-11-09" }), b = task({ id: "b", dueDate: "2026-11-17" });
    expect(awayMovePatches([a, b], ["a", "b"], "2026-11-16")).toEqual({
      apply: [{ id: "a", patch: { dueDate: "2026-11-16", startDate: "2026-11-14" } }],
      undo: [{ id: "a", patch: { dueDate: "2026-11-11", startDate: "2026-11-09" } }],
    });
  });
});
