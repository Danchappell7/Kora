import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Task } from "../data/types";
import type { TaskDropTargetOptions } from "./dnd";

const seen: TaskDropTargetOptions[] = [];
vi.mock("./dnd", () => ({
  useTaskDropTarget: (o: TaskDropTargetOptions) => { seen.push(o); return { bind: { ref: () => undefined }, isOver: false, canDrop: false, payload: null }; },
}));
const { useProjectDropTarget, usePersonDropTarget } = await import("./dropActions");
// (the moves load with the first drop: their own module, out of the Sidebar's first download)
const { moveTasksToProject, reassignTasks } = await import("./dropMoves");

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, description: "", status: "todo", priority: "medium", projectId: "p-old", sectionId: "s-old", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, workspaceId: "ws", ...extra,
});
const LAUNCH = { id: "p-launch", name: "Launch", workspaceId: "ws" };

function deps(tasks: Task[], extra: Record<string, unknown> = {}) {
  const updates: { id: string; patch: Partial<Task> }[][] = [];
  const toasts: { message: string; undo?: () => void }[] = [];
  return {
    updates, toasts,
    deps: { tasks, updateTasks: (p: { id: string; patch: Partial<Task> }[]) => { updates.push(p); }, toast: (message: string, undo?: () => void) => { toasts.push({ message, undo }); }, ...extra },
  };
}

beforeEach(() => { seen.length = 0; });

describe("moving tasks to a project", () => {
  it("moves into the project's first section, says so, and Undo puts each back where it was", () => {
    const tasks = [task("a"), task("b", { projectId: "p-other", sectionId: undefined })];
    const d = deps(tasks, { sections: [{ id: "s2", projectId: "p-launch", position: 2 }, { id: "s1", projectId: "p-launch", position: 1 }, { id: "x", projectId: "p-old", position: 0 }] });
    const out = moveTasksToProject(["a", "b"], LAUNCH, d.deps);
    expect(out).toEqual({ moved: ["a", "b"], skipped: [], message: "Moved 2 tasks to Launch" });
    expect(d.updates[0]).toEqual([
      { id: "a", patch: { projectId: "p-launch", sectionId: "s1", workspaceId: "ws" } },
      { id: "b", patch: { projectId: "p-launch", sectionId: "s1", workspaceId: "ws" } },
    ]);
    d.toasts[0].undo!();
    expect(d.updates[1]).toEqual([
      { id: "a", patch: { projectId: "p-old", sectionId: "s-old", workspaceId: "ws" } },
      { id: "b", patch: { projectId: "p-other", sectionId: undefined, workspaceId: "ws" } },
    ]);
  });

  it("names a single task; with no sections it lands in none", () => {
    const d = deps([task("a")]);
    expect(moveTasksToProject(["a"], LAUNCH, d.deps).message).toBe("Moved “Task a” to Launch");
    expect(d.updates[0][0].patch.sectionId).toBeUndefined();
  });

  it("skips what's already there, and sub-tasks whose parent is moving (they follow it)", () => {
    const tasks = [task("a", { projectId: "p-launch" }), task("b"), task("c", { parentId: "b" })];
    const d = deps(tasks);
    const out = moveTasksToProject(["a", "b", "c", "missing"], LAUNCH, d.deps);
    expect(out.moved).toEqual(["b"]);
    expect(out.skipped).toEqual(["a"]);
    expect(out.message).toBe("Moved “Task b” to Launch · 1 was already there");
  });

  it("never carries work across workspaces (personal stays personal)", () => {
    const d = deps([task("p", { workspaceId: null, projectId: "p-personal" }), task("q", { workspaceId: "other" })]);
    const out = moveTasksToProject(["p", "q"], LAUNCH, d.deps);
    expect(out.moved).toEqual([]);
    expect(d.updates).toHaveLength(0);
    expect(d.toasts[0]).toEqual({ message: "These tasks can't move to Launch: they're in another workspace", undo: undefined });
    const mixed = deps([task("a", { projectId: "p-launch" }), task("q", { workspaceId: "other" })]);
    expect(moveTasksToProject(["a", "q"], LAUNCH, mixed.deps).message).toBe("Nothing to move to Launch");
    const p = deps([task("p", { workspaceId: null, projectId: "p-personal" })]);
    expect(moveTasksToProject(["p"], { id: "p-home", name: "Home", workspaceId: null }, p.deps).moved).toEqual(["p"]);
    const one = deps([task("q", { workspaceId: "other" })]);
    expect(moveTasksToProject(["q"], LAUNCH, one.deps).message).toBe("“Task q” can't move to Launch: it's in another workspace");
  });

  it("says when everything is already there (no Undo, no write)", () => {
    const d = deps([task("a", { projectId: "p-launch" })]);
    expect(moveTasksToProject(["a"], LAUNCH, d.deps).message).toBe("“Task a” is already in Launch");
    expect(d.updates).toHaveLength(0);
    expect(d.toasts[0].undo).toBeUndefined();
  });
});

describe("reassigning tasks", () => {
  const members = [
    { userId: "sana", workspaceId: "ws", status: "active" as const },
    { userId: "ida", workspaceId: "ws", status: "invited" as const },
  ];
  it("assigns, says so by first name, and Undo gives each back", () => {
    const d = deps([task("a"), task("b", { assigneeId: "theo" })], { members });
    const out = reassignTasks(["a", "b"], { id: "sana", name: "Sana Rao" }, d.deps);
    expect(out.message).toBe("Assigned 2 tasks to Sana");
    expect(d.updates[0]).toEqual([{ id: "a", patch: { assigneeId: "sana" } }, { id: "b", patch: { assigneeId: "sana" } }]);
    d.toasts[0].undo!();
    expect(d.updates[1]).toEqual([{ id: "a", patch: { assigneeId: "me" } }, { id: "b", patch: { assigneeId: "theo" } }]);
  });

  it("skips what's already theirs; refuses people outside the workspace and personal tasks", () => {
    const d = deps([task("a", { assigneeId: "sana" }), task("b")], { members });
    expect(reassignTasks(["a", "b"], { id: "sana", name: "Sana Rao" }, d.deps).message).toBe("Assigned “Task b” to Sana · 1 was already theirs");
    const outside = deps([task("b")], { members });
    expect(reassignTasks(["b"], { id: "ida", name: "Ida" }, outside.deps).message).toBe("Ida can't take “Task b”: they're not in that workspace");
    const personal = deps([task("p", { workspaceId: null })], { members });
    expect(reassignTasks(["p"], { id: "sana", name: "Sana Rao" }, personal.deps).message).toBe("Sana Rao can't take “Task p”: personal tasks stay yours");
    expect(personal.updates).toHaveLength(0);
    const mine = deps([task("a", { assigneeId: "sana" })]);
    expect(reassignTasks(["a"], { id: "sana", name: "Sana Rao" }, mine.deps).message).toBe("“Task a” is already with Sana");
  });

  it("without a member list, leaves membership to the server", () => {
    const d = deps([task("a")]);
    expect(reassignTasks(["a"], { id: "anyone", name: "Any One" }, d.deps).moved).toEqual(["a"]);
  });
});

describe("the drop-target hooks", () => {
  it("a project row registers as a “project” target named after it, and hands the drop over", () => {
    const onDrop = vi.fn();
    renderHook(() => useProjectDropTarget(LAUNCH, { onDrop }));
    const o = seen.slice(-1)[0]!;
    expect(o.target).toEqual({ kind: "project", id: "p-launch", label: "Launch", data: { workspaceId: "ws" } });
    expect(o.disabled).toBe(false);
    expect(o.accepts!({ taskIds: ["t1"], source: "list", originId: "t1" })).toBe(true);
    expect(o.accepts!({ taskIds: [], source: "list", originId: "t1" })).toBe(false);
    o.onDrop({ payload: { taskIds: ["t1", "t2"], source: "list", originId: "t1" }, target: o.target, point: null, within: null, via: "keyboard" });
    expect(onDrop).toHaveBeenCalledWith(["t1", "t2"], "p-launch");
  });

  it("keeps the same options across renders (so the kit doesn't re-register), and binds nothing read-only", () => {
    const { rerender } = renderHook(({ ro }) => useProjectDropTarget(LAUNCH, { readOnly: ro, onDrop: () => undefined }), { initialProps: { ro: false } });
    rerender({ ro: false });
    expect(seen.slice(-1)[0]!.target).toBe(seen.slice(-2)[0]!.target);
    expect(seen.slice(-1)[0]!.onDrop).toBe(seen.slice(-2)[0]!.onDrop);
    rerender({ ro: true });
    expect(seen.slice(-1)[0]!.disabled).toBe(true);
  });

  it("a person row registers as a “person” target; no user id, no drops", () => {
    const onDrop = vi.fn();
    renderHook(() => usePersonDropTarget({ userId: "sana", name: "Sana Rao" }, { onDrop }));
    const o = seen.slice(-1)[0]!;
    expect(o.target).toEqual({ kind: "person", id: "sana", label: "Sana Rao" });
    o.onDrop({ payload: { taskIds: ["t1"], source: "today", originId: "t1" }, target: o.target, point: { x: 1, y: 1 }, within: { x: 0, y: 0 }, via: "pointer" });
    expect(onDrop).toHaveBeenCalledWith(["t1"], "sana");
    renderHook(() => usePersonDropTarget({ userId: "", name: "Invited" }, { onDrop }));
    expect(seen.slice(-1)[0]!.disabled).toBe(true);
  });
});
