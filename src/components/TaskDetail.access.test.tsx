/* The task panel and project access (0058): a viewer reads (View only, no composer, no replies or
   reactions), only the people who can see the project are offered as assignees, and only those who can
   comment as an approval's reviewers. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TaskDetail } from "./TaskDetail";
import { store } from "../data/store";
import type { Task, WorkspaceMember } from "../data/types";

const spies: { mockRestore: () => void }[] = [];
const spy = <T extends { mockRestore: () => void }>(x: T): T => { spies.push(x); return x; };
afterEach(() => { spies.splice(0).forEach((x) => x.mockRestore()); });

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
  it("0058: a commenter can attach a file (D8: rank 2) from the menu's Attach file; a viewer (or a guest with it off) can't", async () => {
    const up = spy(vi.spyOn(store, "uploadAttachment"));
    const { unmount } = render(<TaskDetail {...base} readOnly canComment canAttach people={["m-3", "m-self"]} />);
    fireEvent.click(screen.getByRole("button", { name: /More actions|Actions/i }));
    expect(await screen.findByRole("menuitem", { name: "Attach file" })).toBeInTheDocument();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).not.toBeNull();
    const file = new File(["bands"], "bands.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(up).toHaveBeenCalledWith("t-x", file, "m-self"));
    expect(await screen.findByText("bands.csv")).toBeInTheDocument();
    // (the file they added is theirs to take off again)
    expect(screen.getByRole("button", { name: "Delete bands.csv" })).toBeInTheDocument();
    unmount();
    up.mockClear();
    // a viewer, and a guest where project access is off (canAttach not given): no way to attach
    for (const props of [{ canComment: false, canAttach: false }, { canComment: true }]) {
      const v = render(<TaskDetail {...base} readOnly {...props} people={["m-3", "m-self"]} />);
      expect(document.querySelector('input[type="file"]')).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /More actions|Actions/i }));
      expect(screen.queryByRole("menuitem", { name: "Attach file" })).toBeNull();
      v.unmount();
    }
    expect(up).not.toHaveBeenCalled();
  });
  it("0058: someone who can only view or comment deletes their own comment without a task-row write (no false 'can't change it')", async () => {
    spy(vi.spyOn(store, "listComments")).mockResolvedValue([{ id: "c-old", taskId: "t-x", authorId: "m-self", authorName: "Daniel Okai",
      body: "Old note from when I could edit", createdAt: new Date().toISOString(), mentions: [], reactions: {} }] as never);
    const del = spy(vi.spyOn(store, "deleteComment")).mockResolvedValue(undefined);
    spy(vi.spyOn(window, "confirm")).mockReturnValue(true);
    const onPatch = vi.fn();
    render(<TaskDetail {...base} tasks={[{ ...task, comments: 1 }]} onPatch={onPatch} readOnly canComment={false} people={["m-3", "m-self"]} />);
    expect(await screen.findByText("Old note from when I could edit")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("c-old"));
    expect(screen.queryByText("Old note from when I could edit")).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
  });
});
