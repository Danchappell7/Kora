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
