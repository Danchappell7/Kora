import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MyWeekView } from "./MyWeekView";
import { ToastProvider } from "../Toast";
import { dayOffset } from "../../data/data";
import type { Task } from "../../data/types";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "me", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

function renderWeek(tasks: Task[]) {
  const onPatch = vi.fn();
  render(<ToastProvider><MyWeekView tasks={tasks} onOpen={vi.fn()} onPatch={onPatch} currentUserId="me" /></ToastProvider>);
  return { onPatch };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("MyWeekView — Pull to today", () => {
  it("only moves overdue tasks assigned to me, and Undo restores their dates", () => {
    const { onPatch } = renderWeek([
      task({ id: "a", title: "Mine", dueDate: dayOffset(-2) }),
      task({ id: "b", title: "Maya's", dueDate: dayOffset(-3), assigneeId: "maya", collaborators: ["me"] }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Pull my 1 to today" }));
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith("a", { dueDate: dayOffset(0) });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onPatch).toHaveBeenLastCalledWith("a", { dueDate: dayOffset(-2) });
  });

  it("asks first when moving more than three", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onPatch } = renderWeek([1, 2, 3, 4].map((i) => task({ id: "o" + i, title: "Old " + i, dueDate: dayOffset(-i) })));
    fireEvent.click(screen.getByRole("button", { name: "Pull all to today" }));
    expect(confirm).toHaveBeenCalled();
    expect(onPatch).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Pull all to today" }));
    expect(onPatch).toHaveBeenCalledTimes(4);
  });

  it("doesn't ask for three or fewer", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { onPatch } = renderWeek([task({ id: "a", dueDate: dayOffset(-1) })]);
    fireEvent.click(screen.getByRole("button", { name: "Pull all to today" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onPatch).toHaveBeenCalledTimes(1);
  });

  it("hides the button when none of the overdue tasks are mine", () => {
    renderWeek([task({ id: "b", dueDate: dayOffset(-3), assigneeId: "maya" })]);
    expect(screen.queryByRole("button", { name: /to today/ })).not.toBeInTheDocument();
  });

  it("lets long lists expand", () => {
    renderWeek(Array.from({ length: 20 }, (_, i) => task({ id: "n" + i, title: "No date " + i })));
    expect(screen.queryByText("No date 19")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all 20 unscheduled tasks" }));
    expect(screen.getByText("No date 19")).toBeInTheDocument();
  });
});
