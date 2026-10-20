/* 0049: a task made from a Slack message shows "From Slack" (opens the message). */
import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TaskDetail, type TaskDetailProps } from "./TaskDetail";
import type { Task } from "../data/types";

const mk = (over: Partial<Task> = {}): Task => ({
  id: "t1", title: "Fix the login bug", description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "u1",
  tags: [], dependencies: [], subtasks: [], focusMin: 25, comments: 0, aiScore: 0, workspaceId: "w1", ...over,
});
async function setup(task: Task) {
  const props: TaskDetailProps = {
    taskId: task.id, tasks: [task], tags: {}, activity: [], members: [], currentUserId: "u1",
    onClose: vi.fn(), onToggle: vi.fn(), onPatch: vi.fn(), onDelete: vi.fn(), onToggleSubtask: vi.fn(), onAddSubtask: vi.fn(),
    onCreateTag: vi.fn(), onDeleteTag: vi.fn(), onAddComment: vi.fn(async () => null), onFocus: vi.fn(),
  };
  render(<TaskDetail {...props} />);
  await act(async () => {});
}

describe("TaskDetail · From Slack", () => {
  it("shows the chip for a Slack message link", async () => {
    const link = "https://acme.slack.com/archives/C024BE91L/p1700000000123456";
    await setup(mk({ slackPermalink: link }));
    expect(screen.getByRole("link", { name: /From Slack/ })).toHaveAttribute("href", link);
  });
  it("no chip without one (or for anything that isn't a Slack message link)", async () => {
    await setup(mk({ slackPermalink: "https://evil.test/archives/C1/p1" }));
    expect(screen.queryByRole("link", { name: /From Slack/ })).toBeNull();
  });
});
