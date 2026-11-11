// Workload's hand-ons and project access (0058): Give to (the menu, or a drop on someone's row),
// Kanbo's rebalance and Radar's Assign never hand Members only or Private work to someone who
// can't see its project, and never say they did.
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import type { Task } from "../../data/types";
import type { MoveDeps } from "../../lib/dropMoves";
import { applyRebalance, useWorkloadMoves } from "./WorkloadParts";
import { RadarPanel } from "../views/RadarPanel";
import type { Risk } from "../../lib/radar";

const base: Omit<Task, "id" | "title" | "projectId"> = {
  description: "", status: "todo", priority: "medium", assigneeId: "m-1", workspaceId: "ws-f",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0,
} as Omit<Task, "id" | "title" | "projectId">;
const pay = { ...base, id: "t-pay", title: "Renew Theo contract", projectId: "p-payroll" } as Task;
const launch = { ...base, id: "t-launch", title: "Launch deck", projectId: "p-launch" } as Task;
const NAMES: Record<string, string> = { "m-1": "Maya Lin", "m-3": "Sana Rao", "m-2": "Theo Vance" };
const PROJECTS: Record<string, string> = { "p-payroll": "Payroll & contracts", "p-launch": "Launch" };
// Sana (m-3) can't see Payroll
const canSee = (u: string, t: Pick<Task, "projectId">) => !(u === "m-3" && t.projectId === "p-payroll");
const deps = (tasks: Task[]) => {
  const updateTasks = vi.fn();
  const toast = vi.fn();
  const d: MoveDeps = { tasks, updateTasks, toast, canSee, canEdit: () => true, projectName: (id) => PROJECTS[id] };
  return { d, updateTasks, toast };
};
const moves = (d: MoveDeps) => renderHook(() => useWorkloadMoves({ moveDeps: () => d, workspaceId: "ws-f", today: new Date(2026, 10, 10), nameOf: (id) => NAMES[id] ?? "" })).result;

describe("Workload's Give to (0058)", () => {
  it("doesn't hand a task to someone who can't see its project, and says it stayed", () => {
    const { d, updateTasks, toast } = deps([pay]);
    const give = moves(d);
    act(() => give.current(["t-pay"], "m-3", null));
    expect(updateTasks).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Sana Rao can't see Payroll & contracts, so “Renew Theo contract” stays with its assignee");
  });
  it("hands on the rest, and counts what stayed", () => {
    const { d, updateTasks, toast } = deps([pay, launch]);
    const give = moves(d);
    act(() => give.current(["t-pay", "t-launch"], "m-3", null));
    expect(updateTasks).toHaveBeenCalledWith([{ id: "t-launch", patch: { assigneeId: "m-3" } }]);
    expect(toast.mock.calls[0][0]).toBe("Gave “Launch deck” to Sana · 1 stayed put: Sana can't see Payroll & contracts");
  });
  it("moving their own task to another week needs nothing of the kind", () => {
    const { d, updateTasks } = deps([{ ...pay, assigneeId: "m-3" } as Task]);
    const give = moves(d);
    act(() => give.current(["t-pay"], "m-3", new Date(2026, 10, 16)));
    expect(updateTasks).toHaveBeenCalledTimes(1);
  });
});

describe("Kanbo's rebalance, applied (0058)", () => {
  it("leaves out a move to someone who can't see the work (access changed since the plan), and says so", () => {
    const { d, updateTasks, toast } = deps([pay, launch]);
    const plan = {
      moves: [
        { taskId: "t-pay", title: pay.title, from: "m-1", to: "m-3", hours: 4 },
        { taskId: "t-launch", title: launch.title, from: "m-1", to: "m-3", hours: 4 },
      ],
      before: {}, after: {},
    };
    applyRebalance(plan, d, (id) => NAMES[id] ?? "");
    expect(updateTasks).toHaveBeenCalledWith([{ id: "t-launch", patch: { assigneeId: "m-3" } }]);
    expect(toast.mock.calls[0][0]).toBe("Rebalanced: moved “Launch deck” · “Renew Theo contract” stayed with Maya: Sana can't see its project");
    const only = deps([pay]);
    applyRebalance({ ...plan, moves: plan.moves.slice(0, 1) }, only.d, (id) => NAMES[id] ?? "");
    expect(only.updateTasks).not.toHaveBeenCalled();
    expect(only.toast).toHaveBeenCalledWith("“Renew Theo contract” stayed with Maya: Sana can't see its project");
  });
});

describe("Radar's Assign (0058)", () => {
  it("offers only teammates who can see the task's project", () => {
    const risk: Risk = { id: "r1", kind: "unowned" as Risk["kind"], severity: "warn", title: "Nobody has it", reason: "Unassigned", taskIds: ["t-pay"],
      fixes: [{ kind: "assign", label: "Assign" }] };
    const people = [{ id: "m-1", name: "Maya Lin" }, { id: "m-3", name: "Sana Rao" }, { id: "m-2", name: "Theo Vance" }];
    render(<RadarPanel risks={[risk]} members={people} readOnly={false} tasks={[{ ...pay, assigneeId: "" } as Task]} onOpen={() => {}}
      onNudge={async () => true} onPatch={() => {}} onOpenWorkload={() => {}} canSee={canSee} />);
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((b) => /Maya Lin|Sana Rao|Theo Vance/.exec(b.textContent ?? "")?.[0])).toEqual(["Maya Lin", "Theo Vance"]);
  });
});
