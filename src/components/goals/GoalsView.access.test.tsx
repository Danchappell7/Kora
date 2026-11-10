/* Goals and portfolio pages with project access on (0058): a goal or portfolio linked to a finished,
   archived project still reads it (it isn't "a project you can't see"), and to the workspace's
   owner, who sees every project, nothing is hidden. Pinned to 10 November 2026. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Goal, Portfolio, Project, Task, Workspace, WorkspaceMember } from "../../data/types";
import { GoalsView } from "./GoalsView";
import { PortfolioPage } from "../portfolios/PortfolioPage";
import { refreshClock, setReferenceData } from "../../data/data";
import { noteAccessSchema, resetAccessSchema } from "../../lib/projectAccess";
import { noteRhythmSchema } from "../../lib/updateRhythm";
import { resetPortfolioUpdates } from "../../lib/portfolioUpdates";

const NOW = new Date(2026, 10, 10, 12);
beforeEach(() => { localStorage.clear(); noteAccessSchema(true); noteRhythmSchema(true); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); refreshClock(NOW); resetPortfolioUpdates(); });
afterEach(() => { vi.useRealTimers(); refreshClock(new Date()); resetAccessSchema(); });

const Q4 = { period: "2026-Q4", periodStart: "2026-10-01", periodEnd: "2026-12-31" };
const member = (userId: string, name: string, role: WorkspaceMember["role"]): WorkspaceMember => ({ id: `wm-${userId}`, workspaceId: "ws", userId, email: `${userId}@x.org`, name, role, status: "active" });
const MEMBERS = [member("m-self", "Daniel Okai", "owner"), member("m-1", "Maya Lin", "member")];
const ALL: Project[] = [
  { id: "p1", name: "Launch", emoji: "🚀", color: "red", workspaceId: "ws", visibility: "workspace" },
  { id: "p-old", name: "Spring campaign", emoji: "🌱", color: "green", workspaceId: "ws", visibility: "workspace", archivedAt: "2026-10-20T00:00:00Z" },
];
// (the page's own list: the workspace's open projects)
const OPEN = ALL.filter((p) => !p.archivedAt);
const mk = (id: string, status: Task["status"], projectId = "p-old"): Task => ({ id, title: id, description: "", status, priority: "medium", projectId, assigneeId: "m-1",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, dur: 30, comments: 0, aiScore: 0, scheduled: null, workspaceId: "ws" });
const TASKS = [mk("t1", "done"), mk("t2", "done"), mk("t3", "done"), mk("t4", "todo"), mk("t5", "todo", "p1")];
const spring = { id: "spring", name: "Run the spring campaign", projectId: "p-old", status: "on_track", workspaceId: "ws", ownerId: "m-self", contributors: [],
  kind: "objective", direction: "higher", visibility: "everyone", ...Q4 } as unknown as Goal;
const workspaces = (owner: string): Workspace[] => [{ id: null, name: "Personal", kind: "personal" },
  { id: "ws", name: "Foundrise", kind: "team", ownerId: owner, projectAccess: { on: true, defaultVisibility: "workspace", membersMayMakePrivate: false } }];

function goalsPage(me: string, role: WorkspaceMember["role"], seen?: Project[]) {
  setReferenceData({ workspaces: workspaces("m-self"), projects: ALL });
  render(<GoalsView goals={[spring]} projects={OPEN} seenProjects={seen} tasks={TASKS} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()}
    extras={{ checkins: [], links: [] }} workspaceId="ws" me={me} role={role} members={MEMBERS} today={new Date(2026, 10, 10)}
    onCheckin={vi.fn()} onDeleteCheckin={vi.fn()} onLink={vi.fn()} onUnlink={vi.fn()} onOpenGoal={vi.fn()} />);
  return [...document.querySelectorAll(".kgp-open")].find((b) => b.textContent === spring.name)!.closest("li")!.textContent ?? "";
}

describe("Goals page, project access on", () => {
  it("a goal reading its % from an archived project still says 75%", () => {
    const row = goalsPage("m-1", "member", ALL);
    expect(row).toMatch(/75%/);
    expect(row).not.toMatch(/can't see/);
  });
  it("one from a project that isn't among yours is unknown, except to the workspace's owner (who sees every project)", () => {
    expect(goalsPage("m-1", "member", OPEN.filter((p) => p.id !== "p-old"))).toMatch(/Progress comes from a project you can't see/);
  });
  it("to the workspace's owner a project that's gone reads as it always did", () => {
    expect(goalsPage("m-self", "owner", OPEN)).not.toMatch(/can't see/);
  });
});

describe("Portfolio page, project access on", () => {
  const pf = { id: "pf", name: "Q4", projectIds: ["p1", "p-old", "p-hidden"], workspaceId: "ws", ownerId: "m-self", followerIds: [], color: null, emoji: "x" } as unknown as Portfolio;
  const page = (me: string) => {
    setReferenceData({ workspaces: workspaces("m-self"), projects: ALL });
    render(<PortfolioPage portfolio={pf} projects={OPEN} seenProjects={ALL} tasks={TASKS} statusUpdates={[]} members={[{ id: "m-self", name: "Daniel Okai" }]} me={me} lead tab="table"
      onTab={vi.fn()} onBack={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onOpenProject={vi.fn()} />);
  };
  it("counts only what you can't see: not the archived one", () => {
    page("m-1");
    expect(screen.getByText("+1 project you can't see")).toBeInTheDocument();
  });
  it("tells the workspace's owner nothing is hidden", () => {
    page("m-self");
    expect(screen.queryByText(/you can't see/)).toBeNull();
  });
});
