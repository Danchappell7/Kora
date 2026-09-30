import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { TaskDetail, type TaskDetailProps } from "./TaskDetail";
import { ToastProvider } from "./Toast";
import { store } from "../data/store";
import type { Task, WorkspaceMember, Activity, Comment } from "../data/types";

const mk = (over: Partial<Task> = {}): Task => ({
  id: "t1", title: "Write brief", description: "Old text", status: "todo", priority: "medium", projectId: "p1", assigneeId: "u1",
  tags: [], dependencies: [], subtasks: [], focusMin: 25, comments: 0, aiScore: 0, workspaceId: "w1", ...over,
});
const member = (userId: string, name: string): WorkspaceMember => ({ id: "wm-" + userId, workspaceId: "w1", userId, email: userId + "@example.com", name, role: "member", status: "active" });

async function setup(over: Partial<TaskDetailProps> = {}, opts: { toasts?: boolean } = {}) {
  const props: TaskDetailProps = {
    taskId: "t1", tasks: [mk()], tags: {}, activity: [], members: [member("u1", "Me"), member("u2", "Maya Lin"), member("u3", "Mark Ode")],
    currentUserId: "u1",
    onClose: vi.fn(), onToggle: vi.fn(), onPatch: vi.fn(), onDelete: vi.fn(), onToggleSubtask: vi.fn(), onAddSubtask: vi.fn(),
    onCreateTag: vi.fn(), onDeleteTag: vi.fn(), onAddComment: vi.fn(async () => null), onFocus: vi.fn(),
    ...over,
  };
  const ui = () => opts.toasts ? <ToastProvider><TaskDetail {...props} /></ToastProvider> : <TaskDetail {...props} />;
  const r = render(ui());
  await act(async () => {});   // let the demo-mode comment / file / history loads settle
  const rerenderWith = async (p: Partial<TaskDetailProps>) => { Object.assign(props, p); r.rerender(ui()); await act(async () => {}); };
  return { ...r, props, rerenderWith };
}
const titleBox = () => screen.getByLabelText("Task title") as HTMLTextAreaElement;
const nextFrame = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });

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

describe("TaskDetail — Escape after editing", () => {
  it("Escape in the description hands focus to its Edit button", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const desc = screen.getByLabelText("Description") as HTMLTextAreaElement;
    act(() => desc.focus());
    fireEvent.keyDown(desc, { key: "Escape" });
    await nextFrame();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit description" }));
  });

  it("still closes on Escape after you delete the comment whose reply you were editing", async () => {
    let n = 0;
    const onAddComment = vi.fn(async (taskId: string, body: string, _m?: string[], parentId?: string) => ({
      id: "c" + (++n), taskId, authorId: "u1", authorName: "Me", body, createdAt: new Date().toISOString(), parentId,
    }));
    const { props } = await setup({ onAddComment });
    const box = screen.getByLabelText("Add a comment") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Parent" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    fireEvent.click(screen.getByRole("button", { name: "Reply to Me" }));
    fireEvent.change(box, { target: { value: "Child" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);      // edit the reply
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);    // delete its parent (takes the reply too)
    expect(screen.queryByLabelText("Edit comment")).toBeNull();
    const close = screen.getByRole("button", { name: "Close task" });
    act(() => close.focus());
    fireEvent.keyDown(close, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
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

  it("keeps their version on Cancel and offers yours back", async () => {
    const { props, rerenderWith } = await setup({}, { toasts: true });
    act(() => titleBox().focus());
    fireEvent.change(titleBox(), { target: { value: "Mine" } });
    await rerenderWith({ tasks: [mk({ title: "Theirs" })] });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    act(() => titleBox().blur());
    expect(titleBox().value).toBe("Theirs");
    fireEvent.click(screen.getByRole("button", { name: "Restore mine" }));
    await nextFrame();
    expect(titleBox().value).toBe("Mine");
    expect(document.activeElement).toBe(titleBox());
    act(() => titleBox().blur());                             // based on theirs now, so no second prompt
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(props.onPatch).toHaveBeenCalledWith("t1", { title: "Mine" });
  });

  it("offers back a description that was being typed when the page closed", async () => {
    const first = await setup({}, { toasts: true });
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Half-written brief" } });
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    first.unmount();
    await setup({}, { toasts: true });                        // the save never landed: still "Old text"
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Half-written brief");
  });

  it("tabbing through estimate/logged doesn't write a stale value over a teammate's", async () => {
    const { props, rerenderWith } = await setup({ tasks: [mk({ loggedHours: 2 })] });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const logged = screen.getByLabelText("Logged") as HTMLInputElement;
    act(() => logged.focus());
    await rerenderWith({ tasks: [mk({ loggedHours: 3 })] });  // a teammate pressed +1h
    expect(logged.value).toBe("3");                          // untouched, so it follows along
    act(() => logged.blur());
    expect(props.onPatch).not.toHaveBeenCalled();
  });

  it("a custom field you changed while a teammate did asks before overwriting", async () => {
    const f = { id: "f1", projectId: "p1", name: "Client", type: "text" as const, options: [] };
    const { props, rerenderWith } = await setup({ customFields: [f], tasks: [mk({ custom: { f1: "Acme" } })] });
    const input = screen.getByLabelText("Client") as HTMLInputElement;
    act(() => input.focus());
    act(() => input.blur());
    expect(props.onPatch).not.toHaveBeenCalled();             // focus + blur never writes
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Acme Ltd" } });
    await rerenderWith({ tasks: [mk({ custom: { f1: "Acme Holdings Ltd" } })] });
    expect(input.value).toBe("Acme Ltd");                     // your typing isn't clobbered
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    act(() => input.blur());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Someone else changed this"));
    expect(props.onPatch).not.toHaveBeenCalled();
    expect(input.value).toBe("Acme Holdings Ltd");
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

  it("never shows one person's unsent comment to someone else on the same tab", async () => {
    const first = await setup();
    fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "Private note" } });
    first.unmount();
    await setup({ currentUserId: "u2" });
    expect(screen.getByLabelText("Add a comment")).toHaveValue("");
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

  it("words notification rows in Activity, and leaves comments to the thread", async () => {
    const now = new Date().toISOString();
    const activity: Activity[] = [
      { id: "a1", taskId: "t1", taskTitle: "Write brief", kind: "mention", detail: "Maya Lin", createdAt: now },
      // your own comment is logged with its text, not a name
      { id: "a2", taskId: "t1", taskTitle: "Write brief", kind: "comment", detail: "Can we move this to Friday?", createdAt: now },
    ];
    await setup({ activity });
    expect(screen.getByText("Maya Lin mentioned you")).toBeInTheDocument();
    expect(screen.queryByText(/Can we move this to Friday\?/)).toBeNull();
  });

  it("confirms before deleting a tag, naming how many tasks lose it", async () => {
    const onDeleteTag = vi.fn();
    const tags = { g1: { label: "Urgent", color: "#f00" } };
    await setup({ tags, onDeleteTag, tasks: [mk({ tags: ["g1"] }), mk({ id: "t2", tags: ["g1"] })] });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete tag Urgent" }));
    expect(confirm).toHaveBeenCalledTimes(1);   // asked once, not by both the panel and the picker
    expect(confirm.mock.calls[0][0]).toContain("Delete the tag “Urgent”? It will be removed from all 2 tasks that use it.");
    expect(onDeleteTag).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete tag Urgent" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(onDeleteTag).toHaveBeenCalledWith("g1");
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

describe("TaskDetail — dates, repeats and live comments", () => {
  const short = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });

  it("sets a start date, but never one after the due date", async () => {
    const { props } = await setup({ tasks: [mk({ dueDate: "2027-03-10" })] });
    const start = screen.getByLabelText("Start");
    fireEvent.change(start, { target: { value: "2027-03-12" } });
    expect(props.onPatch).not.toHaveBeenCalled();
    expect(screen.getByText("The start date can't be after the due date.")).toBeInTheDocument();
    expect(start).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(start, { target: { value: "2027-03-01" } });
    expect(props.onPatch).toHaveBeenCalledWith("t1", { startDate: "2027-03-01" });
    expect(screen.queryByText("The start date can't be after the due date.")).toBeNull();
  });

  it("previews and skips a monthly series without drifting off month-end", async () => {
    const { props } = await setup({ tasks: [mk({ dueDate: "2027-01-31", startDate: "2027-01-29", recurrence: "monthly" })] });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByText(/^Next:/)).toHaveTextContent(`Next: ${["2027-02-28", "2027-03-31", "2027-04-30"].map(short).join(" · ")}`);
    fireEvent.click(screen.getByRole("button", { name: /^Skip/ }));
    // the start date moves with it, and the series remembers it's a 31st
    expect(props.onPatch).toHaveBeenCalledWith("t1", { dueDate: "2027-02-28", startDate: "2027-02-26", originalDueDate: "2027-01-31" });
  });

  it("names the task on its completion checkbox", async () => {
    await setup();
    expect(screen.getByRole("checkbox", { name: "Done: Write brief" })).toBeInTheDocument();
  });

  it("shows comments as they arrive — your own from another device too — and takes edits live", async () => {
    let onInsert: (c: Comment) => void = () => {};
    let onUpdate: ((c: Comment) => void) | undefined;
    const spy = vi.spyOn(store, "subscribeToTaskComments").mockImplementation((_id, ins, upd) => { onInsert = ins; onUpdate = upd; return () => {}; });
    try {
      await setup();
      const c: Comment = { id: "c-9", taskId: "t1", authorId: "u1", authorName: "Me", body: "Posted from my phone", createdAt: new Date().toISOString() };
      act(() => onInsert(c));
      expect(screen.getByText("Posted from my phone")).toBeInTheDocument();
      act(() => onInsert(c));   // delivered twice (or already added by sending it here)
      expect(screen.getAllByText("Posted from my phone")).toHaveLength(1);
      act(() => onUpdate?.({ ...c, body: "Posted from my phone, then fixed a typo" }));
      expect(screen.getByText("Posted from my phone, then fixed a typo")).toBeInTheDocument();
      // another task's comment never lands in this thread
      act(() => onInsert({ ...c, id: "c-10", taskId: "t2", body: "Wrong thread" }));
      expect(screen.queryByText("Wrong thread")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
