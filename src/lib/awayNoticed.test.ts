import { describe, expect, it } from "vitest";
import type { Task } from "../data/types";
import { awayMovePatches, awayNoticed } from "./awayNoticed";
import { EMPTY_AVAILABILITY, type AvailabilityState } from "./availability";

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "aw" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "sana", workspaceId: "ws",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...o,
});
const today = "2026-11-10";   // a Tuesday
const names: Record<string, string> = { sana: "Sana Rao", me: "Daniel Okai" };
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
    expect(card.body).toMatch(/^You're off Thu 12 Nov, and “Board pack” is due Thu\. Move it to Fri, your first day back\?$/);
  });
  it("says nothing about a teammate's work where you don't lead, half days, done work, or before 0055", () => {
    expect(run([task({ workspaceId: "them", dueDate: "2026-11-11" })])).toEqual([]);
    expect(run([task({ dueDate: "2026-11-11", status: "done" })])).toEqual([]);
    expect(run([task({ dueDate: "2026-11-11" })], state({ timeOff: [{ id: "h", userId: "sana", startsOn: "2026-11-11", endsOn: "2026-11-11", halfDay: "pm" }] }))).toEqual([]);
    expect(run([task({ dueDate: "2026-11-11" })], state({ status: "off" }))).toEqual([]);
  });
  it("moves the work (a start date keeps its span) and can put it back", () => {
    const a = task({ id: "a", dueDate: "2026-11-11", startDate: "2026-11-09" }), b = task({ id: "b", dueDate: "2026-11-17" });
    expect(awayMovePatches([a, b], ["a", "b"], "2026-11-16")).toEqual({
      apply: [{ id: "a", patch: { dueDate: "2026-11-16", startDate: "2026-11-14" } }],
      undo: [{ id: "a", patch: { dueDate: "2026-11-11", startDate: "2026-11-09" } }],
    });
  });
});
