import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Task } from "../../data/types";
import { refreshClock } from "../../data/data";
import { EMPTY_AVAILABILITY, getAvailability, resetAvailability, updateAvailability } from "../../lib/availability";
import { resetDemoAvailability } from "../../lib/availabilitySync";
import type { MoveDeps } from "../../lib/dropMoves";
import { WorkloadView } from "./WorkloadView";

// Tuesday 10 November 2026: the week runs Mon 9 – Sun 15 Nov
const NOW = new Date(2026, 10, 10, 10);
const real = new Date();
let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "wl" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "maya", workspaceId: "ws",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...o,
});
const members = [{ id: "maya", name: "Maya Lin" }, { id: "theo", name: "Theo Vance" }, { id: "sana", name: "Sana Rao" }];

function deps(tasks: Task[]) {
  const updateTasks = vi.fn();
  const toast = vi.fn();
  const moveDeps = (): MoveDeps => ({ tasks, updateTasks, toast });
  return { moveDeps, updateTasks, toast };
}
const share = (me = "me", role: "owner" | "member" = "owner") => updateAvailability({
  ...EMPTY_AVAILABILITY, status: "on", me, activeWs: "ws",
  roles: { ws: { me: role, maya: "member", theo: "member", sana: "member" } },
  weeks: [{ workspaceId: "ws", userId: "maya", weeklyHours: 32, workDays: [1, 2, 3, 4], dayStart: 540, dayEnd: 1050 }],
  timeOff: [{ id: "o", userId: "sana", startsOn: "2026-11-11", endsOn: "2026-11-13", halfDay: null }],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  refreshClock(NOW);
  localStorage.clear();
  resetDemoAvailability();
});
afterEach(() => {
  act(() => resetAvailability());
  vi.useRealTimers();
  refreshClock(real);
});

describe("Workload with the team's shared weeks (0055)", () => {
  it("reads each person's shared week less their time off, and says who's off", () => {
    share();
    render(<WorkloadView workspaceId="ws" members={members} onOpen={() => {}} tasks={[task({ dueDate: "2026-11-12", effortHours: 30 }), task({ assigneeId: "sana", dueDate: "2026-11-10", effortHours: 4 })]} />);
    expect(screen.getByRole("row", { name: /Maya Lin/ })).toHaveTextContent("30h / 32h · 1 task");
    const sana = screen.getByRole("row", { name: /Sana Rao/ });
    // 40h, less three of her five days
    expect(sana).toHaveTextContent("4h / 16h · 1 task");
    expect(sana).toHaveTextContent("Off 3 days");
    expect(sana).toHaveTextContent("Off from tomorrow");
    fireEvent.click(within(screen.getByRole("row", { name: /Maya Lin/ })).getByRole("button", { name: /Maya Lin/ }));
    expect(screen.getByText(/Mon–Thu, shared with the team/)).toBeInTheDocument();
  });
  it("an owner's capacity edit is saved for everyone", async () => {
    share();
    render(<WorkloadView workspaceId="ws" members={members} onOpen={() => {}} tasks={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Theo Vance/ }));
    const cap = screen.getByLabelText("Weekly capacity for Theo Vance, in hours");
    fireEvent.focus(cap);
    fireEvent.change(cap, { target: { value: "24" } });
    fireEvent.blur(cap);
    await waitFor(() => expect(getAvailability().weeks.find((w) => w.userId === "theo")?.weeklyHours).toBe(24));
    expect(localStorage.getItem("kanbo-capacity")).toBeNull();
  });
  it("a member can't change a teammate's capacity, only read it", () => {
    share("theo", "member");
    render(<WorkloadView workspaceId="ws" members={members} onOpen={() => {}} tasks={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    expect(screen.queryByLabelText("Weekly capacity for Maya Lin, in hours")).toBeNull();
    expect(screen.getByText(/set by Maya or an owner or admin/)).toBeInTheDocument();
  });
  it("previews Kanbo's rebalance, applies it in one save, and Undo puts it back", () => {
    share();
    const tasks = [task({ id: "big", title: "Load test", dueDate: "2026-11-12", effortHours: 20 }), task({ id: "rest", status: "progress", dueDate: "2026-11-12", effortHours: 20 })];
    const d = deps(tasks);
    render(<WorkloadView workspaceId="ws" members={members} onOpen={() => {}} tasks={tasks} moveDeps={d.moveDeps} />);
    expect(screen.getByText(/Kanbo can move a task to people with room\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview rebalance" }));
    const preview = screen.getByRole("region", { name: "Rebalance preview" });
    expect(preview).toHaveTextContent("Load test20hMaya Theo");
    expect(preview).toHaveTextContent("Maya 40h → 20h of 32h · Theo 0h → 20h of 40h");
    fireEvent.click(within(preview).getByRole("button", { name: "Apply rebalance" }));
    expect(d.updateTasks).toHaveBeenCalledWith([{ id: "big", patch: { assigneeId: "theo" } }]);
    const [message, undo] = d.toast.mock.calls[0];
    expect(message).toBe("Rebalanced: moved “Load test”");
    undo();
    expect(d.updateTasks).toHaveBeenLastCalledWith([{ id: "big", patch: { assigneeId: "maya" } }]);
    expect(screen.queryByRole("region", { name: "Rebalance preview" })).toBeNull();
  });
  it("a task's Move menu gives it to someone, or moves it into another week (stepping off their days away)", () => {
    share();
    const t = task({ id: "copy", title: "FAQ copy", dueDate: "2026-11-10", effortHours: 2 });
    const d = deps([t]);
    render(<WorkloadView workspaceId="ws" members={members} onOpen={() => {}} tasks={[t]} moveDeps={d.moveDeps} />);
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move FAQ copy" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sana Rao" }));
    expect(d.updateTasks).toHaveBeenLastCalledWith([{ id: "copy", patch: { assigneeId: "sana" } }]);
    expect(d.toast.mock.calls[0][0]).toBe("Gave “FAQ copy” to Sana");
    fireEvent.click(screen.getByRole("button", { name: "Move FAQ copy" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Next week" }));
    expect(d.updateTasks).toHaveBeenLastCalledWith([{ id: "copy", patch: { dueDate: "2026-11-17" } }]);
    expect(d.toast.mock.calls[1][0]).toBe("Moved “FAQ copy”, now due Tue 17 Nov");
  });
  it("the Move menu says who's off the day it's due", () => {
    share();
    const t = task({ id: "hero", title: "Hero", dueDate: "2026-11-12", effortHours: 2 });
    const d = deps([t]);
    render(<WorkloadView workspaceId="ws" members={members} onOpen={() => {}} tasks={[t]} moveDeps={d.moveDeps} />);
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Hero" }));
    expect(screen.getByRole("menuitem", { name: /Sana Rao/ })).toHaveTextContent("Off Thu");
    expect(screen.getByRole("menuitem", { name: /Theo Vance/ })).not.toHaveTextContent("Off");
  });
  it("with only started work left over capacity, the banner says what you can still do", () => {
    share();
    const busy = task({ id: "busy", title: "Busy", status: "progress", dueDate: "2026-11-12", effortHours: 40 });
    const d = deps([busy]);
    render(<WorkloadView workspaceId="ws" members={members} onOpen={() => {}} tasks={[busy]} moveDeps={d.moveDeps} />);
    expect(document.querySelector(".kload-notice[data-tone='signal']")).toHaveTextContent(/What's left is already under way: drag a task to a later week, or to (Theo|Sana)\b/);
    expect(screen.queryByRole("button", { name: "Preview rebalance" })).toBeNull();
  });
  it("without the app's update path (a guest, or no host), nothing can be moved", () => {
    share();
    render(<WorkloadView workspaceId="ws" members={members} onOpen={() => {}} tasks={[task({ dueDate: "2026-11-12", effortHours: 40 })]} />);
    expect(screen.queryByRole("button", { name: "Preview rebalance" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
  });
});
