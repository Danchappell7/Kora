import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HomeView } from "./HomeView";
import { dayOffset } from "../../data/data";
import type { Task } from "../../data/types";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "m-self", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

const renderHome = (tasks: Task[]) => render(
  <HomeView tasks={tasks} projects={[]} userName="Dan Chappell" onOpen={vi.fn()} setRoute={vi.fn()} openFocus={vi.fn()}
    onNewProject={vi.fn()} onNewTask={vi.fn()} onAutoPrioritize={vi.fn()} />,
);

describe("HomeView daily brief", () => {
  it("counts overdue separately from due today", () => {
    renderHome([
      task({ id: "a", title: "Due A", dueDate: dayOffset(0) }),
      task({ id: "b", title: "Late B", dueDate: dayOffset(-2) }),
      task({ id: "c", title: "Late C", dueDate: dayOffset(-1) }),
    ]);
    const brief = screen.getByText(/Dan\./).closest("p")!;
    expect(brief.textContent).toContain("You have 1 task due today and 2 overdue");
    expect(screen.getByText("Plus 2 overdue")).toBeInTheDocument();
    // the focus queue still works through both, marking the late ones
    expect(screen.getAllByText("Overdue")).toHaveLength(2);
  });

  it("says nothing is due today when only overdue work is left", () => {
    renderHome([task({ id: "b", title: "Late B", dueDate: dayOffset(-2) })]);
    const brief = screen.getByText(/Dan\./).closest("p")!;
    expect(brief.textContent).toContain("Nothing's due today, but 1 overdue");
  });

  it("points first-run tips at the q shortcut", () => {
    renderHome([]);
    expect(screen.getByText(/anywhere to capture/)).toBeInTheDocument();
    expect(screen.queryByText(/in the bar at the top/)).not.toBeInTheDocument();
  });

  it("gives phones and tablets touch copy instead of a key they can't press", () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...original(q), matches: q === "(hover: none)" })) as typeof window.matchMedia;
    try {
      renderHome([]);
      expect(screen.queryByText("q")).not.toBeInTheDocument();
      expect(screen.getByText(/is the quickest way in/)).toBeInTheDocument();
      expect(screen.getByText(/write tasks the way you'd say them/)).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("HomeView for a guest", () => {
  const renderAs = (tasks: Task[], canCreateProject: boolean) => render(
    <HomeView tasks={tasks} projects={[]} userName="Dan Chappell" onOpen={vi.fn()} setRoute={vi.fn()} openFocus={vi.fn()}
      onNewProject={vi.fn()} onNewTask={vi.fn()} onAutoPrioritize={vi.fn()} canCreateProject={canCreateProject} />,
  );

  it("offers no New project button to someone who can't create projects", () => {
    renderAs([task({ id: "a", title: "Due A", dueDate: dayOffset(0) })], false);
    expect(screen.queryByRole("button", { name: /New project/ })).toBeNull();
  });

  it("leaves 'Create a project' out of the first-run starters too", () => {
    renderAs([], false);
    expect(screen.queryByRole("button", { name: /Create a project/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Add your first task/ })).toBeInTheDocument();
  });

  it("members still get both", () => {
    const { unmount } = renderAs([task({ id: "a", title: "Due A" })], true);
    expect(screen.getByRole("button", { name: /New project/ })).toBeInTheDocument();
    unmount();
    renderAs([], true);
    expect(screen.getByRole("button", { name: /Create a project/ })).toBeInTheDocument();
  });
});

describe("HomeView in a team workspace", () => {
  const mine = [
    task({ id: "a", title: "My due A", dueDate: dayOffset(0) }),
    task({ id: "d", title: "My done D", status: "done", completedAt: dayOffset(0) }),
  ];
  const theirs = [
    task({ id: "b", title: "Maya's due B", assigneeId: "m-maya", dueDate: dayOffset(0) }),
    task({ id: "c", title: "Maya's late C", assigneeId: "m-maya", dueDate: dayOffset(-1), status: "blocked" }),
    task({ id: "e", title: "Maya's done E", assigneeId: "m-maya", status: "done", completedAt: dayOffset(0) }),
  ];
  const renderTeam = () => render(
    <HomeView tasks={[...mine, ...theirs]} myTasks={mine} projects={[{ id: "p-personal", name: "Launch", emoji: "🚀", color: "#888", workspaceId: null } as never]}
      userName="Dan Chappell" onOpen={vi.fn()} setRoute={vi.fn()} openFocus={vi.fn()}
      onNewProject={vi.fn()} onNewTask={vi.fn()} onAutoPrioritize={vi.fn()} />,
  );

  it("builds the brief, focus queue and weekly count from the viewer's own tasks", () => {
    renderTeam();
    const brief = screen.getByText(/Dan\./).closest("p")!;
    expect(brief.textContent).toContain("You have 1 task due today.");
    expect(brief.textContent).not.toMatch(/overdue|blocked/);
    expect(screen.getByRole("button", { name: /My due A/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Maya's/ })).toBeNull();
    expect(screen.getByText("task done").previousSibling?.textContent).toBe("1");
  });

  it("still counts the whole workspace on the project cards", () => {
    renderTeam();
    expect(screen.getByRole("button", { name: /Launch/ }).textContent).toContain("5 tasks");
  });

  it("shows the dashboard, not the clean slate, to a member with nothing assigned yet", () => {
    render(
      <HomeView tasks={theirs} myTasks={[]} projects={[]} userName="Dan Chappell" onOpen={vi.fn()} setRoute={vi.fn()} openFocus={vi.fn()}
        onNewProject={vi.fn()} onNewTask={vi.fn()} onAutoPrioritize={vi.fn()} />,
    );
    expect(screen.queryByText(/Welcome to Kanbo/)).toBeNull();
    expect(screen.getByText(/Dan\./).closest("p")!.textContent).toContain("Nothing's due today.");
  });
});
