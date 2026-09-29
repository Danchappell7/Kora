import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { TaskDetail, type TaskDetailProps } from "./TaskDetail";
import type { Task, WorkspaceMember, Activity } from "../data/types";

const mk = (over: Partial<Task> = {}): Task => ({
  id: "t1", title: "Write brief", description: "Old text", status: "todo", priority: "medium", projectId: "p1", assigneeId: "u1",
  tags: [], dependencies: [], subtasks: [], focusMin: 25, comments: 0, aiScore: 0, workspaceId: "w1", ...over,
});
const member = (userId: string, name: string): WorkspaceMember => ({ id: "wm-" + userId, workspaceId: "w1", userId, email: userId + "@example.com", name, role: "member", status: "active" });

async function setup(over: Partial<TaskDetailProps> = {}) {
  const props: TaskDetailProps = {
    taskId: "t1", tasks: [mk()], tags: {}, activity: [], members: [member("u1", "Me"), member("u2", "Maya Lin"), member("u3", "Mark Ode")],
    currentUserId: "u1",
    onClose: vi.fn(), onToggle: vi.fn(), onPatch: vi.fn(), onDelete: vi.fn(), onToggleSubtask: vi.fn(), onAddSubtask: vi.fn(),
    onCreateTag: vi.fn(), onDeleteTag: vi.fn(), onAddComment: vi.fn(async () => null), onFocus: vi.fn(),
    ...over,
  };
  const r = render(<TaskDetail {...props} />);
  await act(async () => {});   // let the demo-mode comment / file / history loads settle
  const rerenderWith = async (p: Partial<TaskDetailProps>) => { Object.assign(props, p); r.rerender(<TaskDetail {...props} />); await act(async () => {}); };
  return { ...r, props, rerenderWith };
}
const titleBox = () => screen.getByLabelText("Task title") as HTMLTextAreaElement;

beforeEach(() => { sessionStorage.clear(); });
// restore only our confirm spies (restoreAllMocks would also wipe the global matchMedia mock)
afterEach(() => { if (vi.isMockFunction(window.confirm)) vi.mocked(window.confirm).mockRestore(); });

describe("TaskDetail — Escape", () => {
  it("Escape in the title finishes editing and saves; it doesn't close the panel", async () => {
    const { props } = await setup();
    act(() => titleBox().focus());
    fireEvent.change(titleBox(), { target: { value: "Write the client brief" } });
    fireEvent.keyDown(titleBox(), { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onPatch).toHaveBeenCalledWith("t1", { title: "Write the client brief" });
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    // a second Escape (focus now on the panel) closes it
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("Escape in the @mention menu only closes the menu and keeps the typed comment", async () => {
    const { props } = await setup();
    const box = screen.getByLabelText("Add a comment") as HTMLTextAreaElement;
    act(() => box.focus());
    fireEvent.change(box, { target: { value: "Thoughts @Ma", selectionStart: 12 } });
    expect(screen.getByRole("listbox", { name: "Teammates to mention" })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Teammates to mention" })).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(box.value).toBe("Thoughts @Ma");
  });

  it("arrow keys choose which teammate to mention, and the pick is sent by id", async () => {
    const onAddComment = vi.fn(async () => null);
    await setup({ onAddComment });
    const box = screen.getByLabelText("Add a comment") as HTMLTextAreaElement;
    act(() => box.focus());
    fireEvent.change(box, { target: { value: "@ma", selectionStart: 3 } });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("@Mark Ode ");
    fireEvent.change(box, { target: { value: "@Mark Ode can you look?" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(onAddComment).toHaveBeenCalledWith("t1", "@Mark Ode can you look?", ["u3"], undefined);
  });
});

describe("TaskDetail — edit buffers", () => {
  it("shows a teammate's new title/description live and a click in and out doesn't write the old text back", async () => {
    const { props, rerenderWith } = await setup();
    await rerenderWith({ tasks: [mk({ title: "Renamed by Bob", description: "Bob's new text" })] });
    expect(titleBox().value).toBe("Renamed by Bob");
    expect(screen.getByText("Bob's new text")).toBeInTheDocument();
    act(() => titleBox().focus());
    act(() => titleBox().blur());
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const desc = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(desc.value).toBe("Bob's new text");
    act(() => desc.blur());
    expect(props.onPatch).not.toHaveBeenCalled();
  });

  it("asks before overwriting a change made underneath you, and keeps theirs on Cancel", async () => {
    const { props, rerenderWith } = await setup();
    act(() => titleBox().focus());
    fireEvent.change(titleBox(), { target: { value: "Mine" } });
    await rerenderWith({ tasks: [mk({ title: "Theirs" })] });
    expect(titleBox().value).toBe("Mine");                    // your typing isn't clobbered
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    act(() => titleBox().blur());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Someone else changed this"));
    expect(props.onPatch).not.toHaveBeenCalled();
    expect(titleBox().value).toBe("Theirs");
  });

  it("overwrites when you confirm", async () => {
    const { props, rerenderWith } = await setup();
    act(() => titleBox().focus());
    fireEvent.change(titleBox(), { target: { value: "Mine" } });
    await rerenderWith({ tasks: [mk({ title: "Theirs" })] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    act(() => titleBox().blur());
    expect(props.onPatch).toHaveBeenCalledWith("t1", { title: "Mine" });
  });

  it("saves an in-progress title and description when the panel closes", async () => {
    const { props, unmount } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const desc = screen.getByLabelText("Description") as HTMLTextAreaElement;
    fireEvent.change(desc, { target: { value: "New brief" } });
    act(() => titleBox().focus());
    fireEvent.change(titleBox(), { target: { value: "Unsaved title" } });
    (props.onPatch as ReturnType<typeof vi.fn>).mockClear();
    unmount();
    expect(props.onPatch).toHaveBeenCalledWith("t1", { title: "Unsaved title" });
    expect(props.onPatch).toHaveBeenCalledTimes(1);           // the description saved on blur, once
  });

  it("buffers estimate edits and saves once on blur", async () => {
    const { props } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const est = screen.getByLabelText("Estimate") as HTMLInputElement;
    act(() => est.focus());
    fireEvent.change(est, { target: { value: "2" } });
    fireEvent.change(est, { target: { value: "2.5" } });
    expect(props.onPatch).not.toHaveBeenCalled();
    act(() => est.blur());
    expect(props.onPatch).toHaveBeenCalledTimes(1);
    expect(props.onPatch).toHaveBeenCalledWith("t1", { effortHours: 2.5 });
  });
});

describe("TaskDetail — switching task", () => {
  it("keeps each task's unsent comment to itself", async () => {
    const { rerenderWith } = await setup({ tasks: [mk(), mk({ id: "t2", title: "Other task" })] });
    fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "Half-written note" } });
    await rerenderWith({ taskId: "t2" });
    expect(screen.getByLabelText("Add a comment")).toHaveValue("");
    await rerenderWith({ taskId: "t1" });
    expect(screen.getByLabelText("Add a comment")).toHaveValue("Half-written note");
  });

  it("saves the previous task's edited title to that task", async () => {
    const { props, rerenderWith } = await setup({ tasks: [mk(), mk({ id: "t2", title: "Other task" })] });
    act(() => titleBox().focus());
    fireEvent.change(titleBox(), { target: { value: "Edited A" } });
    await rerenderWith({ taskId: "t2" });
    expect(props.onPatch).toHaveBeenCalledWith("t1", { title: "Edited A" });
    expect(titleBox().value).toBe("Other task");
  });
});

describe("TaskDetail — actions", () => {
  it("choosing Done in the status menu completes via the checkbox path", async () => {
    const { props } = await setup();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "done" } });
    expect(props.onToggle).toHaveBeenCalledWith("t1");
    expect(props.onPatch).not.toHaveBeenCalled();
  });

  it("confirms before deleting the task or a custom field", async () => {
    const onDeleteCustomField = vi.fn();
    const { props } = await setup({ customFields: [{ id: "f1", projectId: "p1", name: "Budget", type: "text", options: [] }], onDeleteCustomField });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete field “Budget”" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete “Write brief”" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0][0]).toContain("Delete field “Budget” from all tasks in this project?");
    expect(onDeleteCustomField).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete field “Budget”" }));
    expect(onDeleteCustomField).toHaveBeenCalledWith("f1");
  });

  it("dependency picker: keyboard-only, same workspace, open tasks, no loops", async () => {
    const onAddDependency = vi.fn();
    const tasks = [
      mk(),
      mk({ id: "t2", title: "Budget draft" }),
      mk({ id: "t3", title: "Budget done", status: "done" }),
      mk({ id: "t4", title: "Budget elsewhere", workspaceId: "w2" }),
      mk({ id: "t5", title: "Budget loop", dependencies: ["t1"] }),
      mk({ id: "t6", title: "Budget review" }),
    ];
    const { props } = await setup({ tasks, onAddDependency });
    fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
    const input = screen.getByRole("combobox", { name: /blocked by/i });
    fireEvent.change(input, { target: { value: "budget" } });
    const options = within(screen.getByRole("listbox", { name: /Open tasks/ })).getAllByRole("option").map((o) => o.textContent?.trim());
    expect(options).toEqual(["Budget draft", "Budget review"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAddDependency).toHaveBeenCalledWith("t1", "t6");
    // Escape closes the picker, not the panel
    fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: /blocked by/i }), { key: "Escape" });
    expect(screen.queryByRole("combobox", { name: /blocked by/i })).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("words notification rows in Activity", async () => {
    const activity: Activity[] = [{ id: "a1", taskId: "t1", taskTitle: "Write brief", kind: "mention", detail: "Maya Lin", createdAt: new Date().toISOString() }];
    await setup({ activity });
    expect(screen.getByText("Maya Lin mentioned you")).toBeInTheDocument();
  });
});

describe("TaskDetail — read-only (guests)", () => {
  it("shows values as text but keeps comments and Follow", async () => {
    await setup({ readOnly: true, onToggleFollow: vi.fn(), onDuplicate: vi.fn(), onArchive: vi.fn(), onAddDependency: vi.fn() });
    expect(screen.queryByLabelText("Task title")).toBeNull();
    expect(screen.getByRole("heading", { name: "Write brief" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Status")).toBeNull();
    expect(screen.getByText("To do")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete “Write brief”/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Duplicate task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
    expect(screen.queryByLabelText("Add a subtask")).toBeNull();
    expect(screen.getByLabelText("Add a comment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Follow task" })).toBeInTheDocument();
  });
});
