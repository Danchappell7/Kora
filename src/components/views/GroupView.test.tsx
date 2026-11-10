/* Projects › Group: one section per business you run, the one that needs you most first; clicking
   anything asks the host to switch to that business and open it. */
import { describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { GroupView } from "./GroupView";
import { workspaceSignals } from "../../lib/businesses";
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
    // (Studio Opening's work is off track and nobody's said so: its pill reads No update, with Kanbo's mark)
    expect(within(within(a).getByRole("region", { name: "Projects to look at" })).getByText("No update")).toHaveAttribute("data-mismatch", "true");
    expect(within(within(a).getByRole("region", { name: "Waiting for your approval" })).getByText("From Theo · 1h ago")).toBeInTheDocument();
    expect(within(within(a).getByRole("region", { name: "This week's wins" })).getByText("Signed the lease")).toBeInTheDocument();
    // a calm business says so
    const b = section("Beta Padel");
    expect(within(b).getByText("Every goal is on track.")).toBeInTheDocument();
    expect(within(b).getByText("No project needs a look.")).toBeInTheDocument();
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

  it("'Needs you most' is the switcher's and Today's meaning: your own work and requests there", () => {
    // your own work at Beta Padel, overdue and due today: it needs you most, and its line says so
    const tasks = [...TASKS.filter((x) => x.id !== "a3"), t({ id: "b-late", projectId: "pb", workspaceId: "w-b", dueDate: "2026-10-05" }),
      t({ id: "b-today", projectId: "pb", workspaceId: "w-b", dueDate: "2026-10-09" })];
    const signals = workspaceSignals({ workspaces: WS, tasks, projects: PROJECTS, activity: [], approvals: [], me: "me", today: "2026-10-09" });
    renderGroup({ tasks, approvals: [], signals });
    // (Alpha's own overdue work weighs too: a1 and a2)
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    const first = section(names[0]!);
    expect(within(first).getByText("Needs you most")).toBeInTheDocument();
    expect(screen.getAllByText("Needs you most")).toHaveLength(1);
    expect(within(section("Beta Padel")).getByText(/1 of yours overdue · 1 of yours due today/)).toBeInTheDocument();
    // a project off track that nobody's updated says so, and what Kanbo reads in the work
    expect(within(section("Alpha Studio")).getByText("No update")).toHaveAttribute("data-tip", expect.stringMatching(/^No update yet · Kanbo sees /));
  });

  it("a phone folds the calm blocks into one line", () => {
    renderGroup();
    const b = section("Beta Padel");
    expect(within(b).getByRole("region", { name: "Goals behind" })).toHaveAttribute("data-calm", "true");
    expect(within(b).getByRole("region", { name: "This week's wins" })).toHaveAttribute("data-calm", "true");
    expect(b.querySelector(".kgrp-calmline")).toHaveTextContent("Every goal on trackNo project needs a lookNothing waiting for youNothing finished yet");
    expect(within(section("Alpha Studio")).getByRole("region", { name: "Projects to look at" })).not.toHaveAttribute("data-calm");
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

describe("GroupView with an update day (0053)", () => {
  it("a project past its day with nothing posted reads Update missing, and its owner can be asked from the row", () => {
    const ask = vi.fn(async () => ({}) as never);
    const asks = { canAsk: (p: Project) => p.ownerId !== "me", asked: () => undefined, ask };
    const projects = PROJECTS.map((p) => (p.id === "pb" ? { ...p, ownerId: "bo" } : p));
    const tasks = TASKS.map((x) => (x.id === "b1" ? { ...x, createdAt: "2026-09-01T09:00:00Z" } : x));
    renderGroup({ projects, tasks, statusUpdates: [{ ...UPDATES[0], createdAt: "2026-09-20T10:00:00Z" }], asks });
    const look = within(section("Beta Padel")).getByRole("region", { name: "Projects to look at" });
    expect(within(look).getByText("Update missing")).toBeInTheDocument();
    expect(within(look).getByRole("img", { name: /^On track\. Lead says On track/ })).toBeInTheDocument();
    fireEvent.click(within(look).getByRole("button", { name: /for an update on Winter League$/ }));
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ id: "pb" }));
  });
  it("an off-track project whose update is missing too can be asked for it, and says Update missing as the others do", () => {
    const ask = vi.fn(async () => ({}) as never);
    const asks = { canAsk: (p: Project) => p.ownerId !== "me", asked: () => undefined, ask };
    const projects = PROJECTS.map((p) => (p.id === "pa" ? { ...p, ownerId: "theo" } : p));
    const tasks = TASKS.map((x) => (x.id === "a1" ? { ...x, createdAt: "2026-09-01T09:00:00Z" } : x));
    renderGroup({ projects, tasks, asks });
    const look = within(section("Alpha Studio")).getByRole("region", { name: "Projects to look at" });
    expect(within(look).getByText("Update missing")).toBeInTheDocument();
    fireEvent.click(within(look).getByRole("button", { name: /for an update on Studio Opening$/ }));
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ id: "pa" }));
  });
});

describe("GroupView › meetings (0056)", () => {
  it("Run meeting on each business you run, and one over them all; nothing unless the host asks for it", () => {
    renderGroup({ runMeetings: true });
    expect(within(section("Alpha Studio")).getByRole("button", { name: "Run meeting" })).toBeInTheDocument();
    expect(within(section("Beta Padel")).getByRole("button", { name: "Run meeting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run group meeting" })).toBeInTheDocument();
    cleanup();
    renderGroup();
    expect(screen.queryByRole("button", { name: /Run (group )?meeting/ })).toBeNull();
  });
});

