/* Projects › Group: one section per business you run, the one that needs you most first; clicking
   anything asks the host to switch to that business and open it. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { GroupView } from "./GroupView";
import type { ApprovalWithTask, Goal, Project, StatusUpdate, Task, Workspace, WorkspaceMember } from "../../data/types";

const TODAY = new Date(2026, 9, 9);
const WS: Workspace[] = [
  { id: null, name: "Personal", kind: "personal" },
  { id: "w-a", name: "Alpha Studio", kind: "team", logoUrl: "data:image/svg+xml,%3Csvg%2F%3E" },
  { id: "w-b", name: "Beta Padel", kind: "team" },
  { id: "w-c", name: "Cove Advisory", kind: "team" },
];
const mem = (workspaceId: string, role: WorkspaceMember["role"]): WorkspaceMember => ({ id: workspaceId, workspaceId, userId: "me", email: "", name: "Me", role, status: "active" });
const MEMBERS = [mem("w-a", "owner"), mem("w-b", "admin"), mem("w-c", "member")];
const PROJECTS: Project[] = [
  { id: "pa", name: "Studio Opening", emoji: "", color: "", workspaceId: "w-a" }, { id: "pb", name: "Winter League", emoji: "", color: "", workspaceId: "w-b" },
  { id: "pc", name: "Client Review", emoji: "", color: "", workspaceId: "w-c" },
];
const t = (o: Partial<Task> & { id: string }): Task => ({ title: o.id, status: "todo", priority: "medium", projectId: "pa", workspaceId: "w-a", assigneeId: "me",
  dependencies: [], subtasks: [], tags: [], comments: 0, createdAt: "2026-10-06T09:00:00Z", ...o } as Task);
const TASKS: Task[] = [
  t({ id: "a1", dueDate: "2026-10-01" }), t({ id: "a2", dueDate: "2026-10-02" }), t({ id: "a3", dueDate: "2026-10-03" }),
  t({ id: "won", title: "Signed the lease", status: "done", completedAt: "2026-10-08" }),
  t({ id: "b1", projectId: "pb", workspaceId: "w-b", dueDate: "2026-10-20" }),
  t({ id: "c1", title: "Cove's own work", projectId: "pc", workspaceId: "w-c", dueDate: "2026-10-01" }),
];
const GOALS: Goal[] = [
  { id: "g1", name: "Open by December", status: "at_risk", workspaceId: "w-a", target: 10, current: 3 },
  { id: "g2", name: "Fill the league", status: "on_track", workspaceId: "w-b" },
  { id: "g3", name: "Cove's goal", status: "off_track", workspaceId: "w-c" },
];
const UPDATES: StatusUpdate[] = [{ id: "u", projectId: "pb", workspaceId: "w-b", status: "on_track", createdAt: "2026-10-07T10:00:00Z", summary: "Fine" }];
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const APPROVALS = [{ id: "ap", taskId: "a3", workspaceId: "w-a", title: "a3", requestedByName: "Theo Vance", createdAt: HOUR_AGO, task: { workspaceId: "w-a", title: "Pick the contractor" } } as unknown as ApprovalWithTask];

const renderGroup = (o: Partial<React.ComponentProps<typeof GroupView>> = {}) => {
  const onOpen = vi.fn();
  render(<GroupView workspaces={WS} members={MEMBERS} currentUserId="me" tasks={TASKS} projects={PROJECTS} goals={GOALS} statusUpdates={UPDATES}
    approvals={APPROVALS} today={TODAY} onOpen={onOpen} {...o} />);
  return onOpen;
};
const section = (name: string) => screen.getByRole("region", { name });

describe("GroupView", () => {
  it("one section per business you run, with its logo; the one that needs you most first", () => {
    renderGroup();
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(names).toEqual(["Alpha Studio", "Beta Padel"]);
    expect(screen.queryByText("Cove Advisory")).toBeNull();          // only a member there
    expect(screen.queryByText("Cove's own work")).toBeNull();
    expect(within(section("Alpha Studio")).getByText("Needs you most")).toBeInTheDocument();
    expect(within(section("Alpha Studio")).getByText(/Owner/)).toBeInTheDocument();
    expect(within(section("Beta Padel")).getByText(/Admin/)).toBeInTheDocument();
  });

  it("each business: goals behind, projects to look at, requests for you and the week's wins", () => {
    renderGroup();
    const a = section("Alpha Studio");
    expect(within(within(a).getByRole("region", { name: "Goals behind" })).getByText("Open by December")).toBeInTheDocument();
    expect(within(within(a).getByRole("region", { name: "Projects to look at" })).getByText("Off track")).toBeInTheDocument();
    expect(within(within(a).getByRole("region", { name: "Waiting for your approval" })).getByText("From Theo · 1h ago")).toBeInTheDocument();
    expect(within(within(a).getByRole("region", { name: "This week's wins" })).getByText("Signed the lease")).toBeInTheDocument();
    // a calm business says so
    const b = section("Beta Padel");
    expect(within(b).getByText("Every goal is on track.")).toBeInTheDocument();
    expect(within(b).getByText("Every project is on track and up to date.")).toBeInTheDocument();
    expect(within(b).getByText("Nothing waiting for you.")).toBeInTheDocument();
  });

  it("clicking anything switches to that business and opens it", () => {
    const onOpen = renderGroup();
    const a = section("Alpha Studio");
    fireEvent.click(within(a).getByRole("button", { name: "Studio Opening" }));
    expect(onOpen).toHaveBeenLastCalledWith("w-a", { kind: "project", projectId: "pa" });
    fireEvent.click(within(a).getByRole("button", { name: "Pick the contractor" }));
    expect(onOpen).toHaveBeenLastCalledWith("w-a", { kind: "task", taskId: "a3" });
    fireEvent.click(within(a).getByRole("button", { name: "Signed the lease" }));
    expect(onOpen).toHaveBeenLastCalledWith("w-a", { kind: "task", taskId: "won" });
    fireEvent.click(within(a).getByRole("button", { name: "Open by December" }));
    expect(onOpen).toHaveBeenLastCalledWith("w-a", { kind: "goals" });
    fireEvent.click(within(section("Beta Padel")).getByRole("button", { name: "Open Beta Padel" }));
    expect(onOpen).toHaveBeenLastCalledWith("w-b", { kind: "business" });
  });

  it("wave 2's pace line shows under a goal", () => {
    renderGroup({ pace: (g) => (g.id === "g1" ? { behind: true, line: "Needs 2 a week; doing 1" } : null) });
    expect(within(section("Alpha Studio")).getByText("Needs 2 a week; doing 1")).toBeInTheDocument();
  });

  it("someone who runs one business sees why the page is empty", () => {
    renderGroup({ members: [mem("w-a", "owner"), mem("w-b", "member")] });
    expect(screen.getByText("One business at a time, for now")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Alpha Studio" })).toBeNull();
  });
});
