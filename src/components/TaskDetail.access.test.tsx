/* The task panel and project access (0058): a viewer reads (View only, no composer, no replies or
   reactions), only the people who can see the project are offered as assignees, and only those who can
   comment as an approval's reviewers. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TaskDetail } from "./TaskDetail";
import type { Task, WorkspaceMember } from "../data/types";

const task: Task = { id: "t-x", title: "Compare partner fee bands", description: "", status: "todo", priority: "medium", projectId: "p-hb-fees", workspaceId: "ws-harbour",
  assigneeId: "m-3", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0 };
const mem = (userId: string, role: WorkspaceMember["role"], name: string): WorkspaceMember => ({ id: `wm-${userId}`, workspaceId: "ws-harbour", userId, email: `${userId}@x.co`, name, role, status: "active" });
const base = {
  taskId: "t-x", tasks: [task], tags: {}, activity: [], members: [mem("m-3", "owner", "Sana Rao"), mem("m-self", "member", "Daniel Okai"), mem("m-2", "member", "Theo Vance")],
  currentUserId: "m-self", onClose: vi.fn(), onToggle: vi.fn(), onPatch: vi.fn(), onDelete: vi.fn(), onToggleSubtask: vi.fn(), onAddSubtask: vi.fn(),
  onCreateTag: vi.fn(), onDeleteTag: vi.fn(), onAddComment: vi.fn(async () => null), onFocus: vi.fn(),
};

describe("TaskDetail · project access", () => {
  it("a viewer sees View only and no comment box", () => {
    render(<TaskDetail {...base} readOnly canComment={false} people={["m-3", "m-self"]} />);
    expect(screen.getByText("View only")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Add a comment" })).toBeNull();
    expect(screen.getByText(/You can view this task\./)).toBeInTheDocument();
  });
  it("a commenter on a Members only project sees who can read it, by the composer", () => {
    render(<TaskDetail {...base} readOnly canComment people={["m-3", "m-self"]} audienceNote="Only people on Fee review can see this." />);
    expect(screen.getByText("View and comment")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Add a comment" })).toBeInTheDocument();
    expect(screen.getByText("Only people on Fee review can see this.")).toBeInTheDocument();
  });
  it("an approval's reviewers are the people who can comment: a viewer isn't offered (the server refuses them)", async () => {
    // Daniel edits; Theo can only view; Sana owns the workspace
    render(<TaskDetail {...base} currentUserId="m-self" people={["m-3", "m-self", "m-2"]} reviewers={["m-3", "m-self"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request approval" }));
    const picker = await screen.findByRole("dialog", { name: "Choose reviewers" });
    const options = within(picker).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAccessibleName("Sana Rao");
  });
});
