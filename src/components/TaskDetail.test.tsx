import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { TaskDetail, type TaskDetailProps } from "./TaskDetail";
import { ToastProvider } from "./Toast";
import { store } from "../data/store";
import { shortDay, dayLabel } from "./taskDetailHelpers";
import { dayOffset } from "../data/data";
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
/** the header's ⋯ menu (Duplicate, Archive, Delete…) */
const openActions = () => fireEvent.click(screen.getByRole("button", { name: "More actions" }));
/** "+ n more fields" (empty optional fields fold away) */
const showMoreFields = () => fireEvent.click(screen.getByRole("button", { name: /more fields?$/i }));
const send = (box: HTMLElement) => fireEvent.keyDown(box, { key: "Enter", metaKey: true });
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
    fireEvent.keyDown(box, { key: "Enter" });                  // Enter alone is a new line
    expect(onAddComment).not.toHaveBeenCalled();
    await act(async () => { send(box); });                    // ⌘↵ sends
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
    await act(async () => { send(box); });
    fireEvent.click(screen.getByRole("button", { name: "Reply to Me" }));
    fireEvent.change(box, { target: { value: "Child" } });
    await act(async () => { send(box); });
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
    const logged = screen.getByLabelText("Logged") as HTMLInputElement;   // filled, so it's shown
    expect(logged.value).toBe("2h");
    act(() => logged.focus());
    await rerenderWith({ tasks: [mk({ loggedHours: 3 })] });  // a teammate pressed +1h
    expect(logged.value).toBe("3h");                         // untouched, so it follows along
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
    const est = screen.getByLabelText("Estimate") as HTMLInputElement;
    act(() => est.focus());
    fireEvent.change(est, { target: { value: "2" } });
    fireEvent.change(est, { target: { value: "2.5" } });
    expect(props.onPatch).not.toHaveBeenCalled();
    act(() => est.blur());
    expect(props.onPatch).toHaveBeenCalledTimes(1);
    expect(props.onPatch).toHaveBeenCalledWith("t1", { effortHours: 2.5 });
    expect(est.value).toBe("2.5");                            // (the saved value comes back as "2h 30m")
  });

  it("reads estimates as durations, and puts back anything it can't read", async () => {
    const { props, rerenderWith } = await setup({ tasks: [mk({ effortHours: 1.5 })] });
    const est = screen.getByLabelText("Estimate") as HTMLInputElement;
    expect(est.value).toBe("1h 30m");
    act(() => est.focus());
    fireEvent.change(est, { target: { value: "90 mins" } });
    act(() => est.blur());
    expect(props.onPatch).not.toHaveBeenCalled();            // the same 1.5 hours: nothing to save
    act(() => est.focus());
    fireEvent.change(est, { target: { value: "soonish" } });
    act(() => est.blur());
    expect(props.onPatch).not.toHaveBeenCalled();
    expect(est.value).toBe("1h 30m");
    act(() => est.focus());
    fireEvent.change(est, { target: { value: "2h 15m" } });
    act(() => est.blur());
    expect(props.onPatch).toHaveBeenCalledWith("t1", { effortHours: 2.25 });
    await rerenderWith({ tasks: [mk({ effortHours: 2.25 })] });
    expect(est.value).toBe("2h 15m");
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
    expect(screen.queryByRole("button", { name: "Delete field “Budget”" })).toBeNull();   // empty, so folded away
    showMoreFields();
    fireEvent.click(screen.getByRole("button", { name: "Delete field “Budget”" }));
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0][0]).toContain("Delete field “Budget” from all tasks in this project?");
    expect(onDeleteCustomField).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete field “Budget”" }));
    expect(onDeleteCustomField).toHaveBeenCalledWith("f1");
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onDelete).toHaveBeenCalledWith("t1");
  });

  it("keeps Duplicate, Archive and Delete under ⋯, and Escape closes only the menu", async () => {
    const onDuplicate = vi.fn(), onArchive = vi.fn();
    const { props } = await setup({ onDuplicate, onArchive, onToggleFollow: vi.fn() });
    // the header has exactly four controls
    const head = screen.getByRole("button", { name: "Close task" }).parentElement!;
    const controls = Array.from(head.querySelectorAll("button")).filter((b) => !b.closest('[role="menu"]'));
    expect(controls.map((b) => b.getAttribute("aria-label"))).toEqual(["Follow task", "Copy link to task", "More actions", "Close task"]);
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();    // closed
    openActions();
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Duplicate", "Save as template", "Attach file", "Archive", "Delete"]);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Save as template" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions" }));
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledWith("t1");
    expect(props.onClose).toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole("button", { name: /^Tags/ }));
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
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.getByText("To do")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "To do: Write brief" })).toBeInTheDocument();   // the glyph, not a checkbox
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Assignee/ })).toBeNull();
    openActions();
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Save as template"]);
    expect(screen.queryByTitle("Delete task")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
    expect(screen.queryByLabelText("Add a sub-task")).toBeNull();
    expect(screen.queryByRole("button", { name: /more fields?$/i })).toBeNull();
    expect(screen.getByLabelText("Add a comment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Follow task" })).toBeInTheDocument();
  });
});

describe("TaskDetail — dates, repeats and live comments", () => {
  /** open a DateChip and type into its natural-language field */
  const typeDate = async (chip: RegExp, label: string, text: string) => {
    fireEvent.click(screen.getByRole("button", { name: chip }));
    const field = await screen.findByRole("textbox", { name: label });
    fireEvent.change(field, { target: { value: text } });
    fireEvent.keyDown(field, { key: "Enter" });
  };

  it("sets a start date, but never one after the due date", async () => {
    const { props } = await setup({ tasks: [mk({ dueDate: "2027-03-10" })] });
    showMoreFields();
    await typeDate(/^Start date/, "Type a start date", "12/3/2027");
    expect(props.onPatch).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("The start date can't be after the due date.");
    await typeDate(/^Start date/, "Type a start date", "1/3/2027");
    expect(props.onPatch).toHaveBeenCalledWith("t1", { startDate: "2027-03-01" });
    expect(screen.queryByText("The start date can't be after the due date.")).toBeNull();
  });

  it("sets the due date and time from the chip, and clears the time with the date", async () => {
    const { props, rerenderWith } = await setup();
    await typeDate(/^Due date/, "Type a due date", "tomorrow 3pm");
    expect(props.onPatch).toHaveBeenLastCalledWith("t1", { dueDate: dayOffset(1), dueTime: "15:00" });
    await rerenderWith({ tasks: [mk({ dueDate: dayOffset(1), dueTime: "15:00" })] });
    expect(screen.getByRole("button", { name: /^Due date/ })).toHaveTextContent("Tomorrow 15:00");
    fireEvent.click(screen.getByRole("button", { name: /^Due date/ }));
    fireEvent.click(await screen.findByRole("button", { name: "No date" }));
    expect(props.onPatch).toHaveBeenLastCalledWith("t1", { dueDate: undefined, dueTime: undefined });
  });

  it("has no native date or time inputs, even with every field showing", async () => {
    const date = { id: "f1", projectId: "p1", name: "Launch day", type: "date" as const, options: [] };
    const { container } = await setup({ customFields: [date], onCreateCustomField: vi.fn(), tasks: [mk({ dueDate: dayOffset(2), dueTime: "09:30" })] });
    showMoreFields();
    expect(screen.getByRole("button", { name: /^Launch day/ })).toBeInTheDocument();
    expect(container.ownerDocument.querySelectorAll('input[type="date"], input[type="time"], input[type="datetime-local"]')).toHaveLength(0);
  });

  it("previews and skips a monthly series without drifting off month-end", async () => {
    const { props } = await setup({ tasks: [mk({ dueDate: "2027-01-31", startDate: "2027-01-29", recurrence: "monthly" })] });
    expect(screen.getByText(/^Next:/)).toHaveTextContent(`Next: ${["2027-02-28", "2027-03-31", "2027-04-30"].map((d) => shortDay(d)).join(" · ")}`);
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

describe("TaskDetail — frame", () => {
  it("overlays with a soft scrim and a focus trap below 1280px; a click outside closes it", async () => {
    const { props } = await setup();
    const dialog = screen.getByRole("dialog", { name: "Task: Write brief" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const scrim = document.querySelector(".ktd-scrim") as HTMLElement;
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("docked, it has no scrim, isn't modal, leaves focus with the page, and Escape still closes it", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    try {
      const { props } = await setup({ docked: true });
      const dialog = screen.getByRole("dialog", { name: "Task: Write brief" });
      expect(dialog).toHaveAttribute("aria-modal", "false");
      expect(document.querySelector(".ktd-scrim")).toBeNull();
      expect(document.activeElement).toBe(outside);            // the list beside it keeps focus
      fireEvent.keyDown(outside, { key: "Escape" });
      expect(props.onClose).not.toHaveBeenCalled();             // (App's own Escape handles the page)
      act(() => titleBox().focus());
      fireEvent.keyDown(titleBox(), { key: "Escape" });         // leaves the field first…
      expect(props.onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(dialog);
      fireEvent.keyDown(dialog, { key: "Escape" });             // …then closes
      expect(props.onClose).toHaveBeenCalledTimes(1);
    } finally {
      outside.remove();
    }
  });

  it("the breadcrumb's project closes the panel and opens the project", async () => {
    const onOpenProject = vi.fn();
    const project = { id: "p1", name: "Q3 Product Launch", color: "oklch(0.62 0.14 230)", icon: "🚀", workspaceId: "w1" } as never;
    const { props } = await setup({ projects: [project], onOpenProject, sections: [{ id: "s1", projectId: "p1", name: "Narrative" }], tasks: [mk({ sectionId: "s1" })] });
    const crumb = screen.getByRole("navigation", { name: "Where this task lives" });
    expect(crumb).toHaveTextContent("Q3 Product Launch/Narrative");
    fireEvent.click(within(crumb).getByRole("button", { name: "Q3 Product Launch" }));
    expect(props.onClose).toHaveBeenCalled();
    expect(onOpenProject).toHaveBeenCalledWith("p1");
  });
});

describe("TaskDetail — quiet by default", () => {
  it("leaves out empty sections: no files, no activity, no blank-state sentences", async () => {
    await setup();
    expect(screen.queryByRole("heading", { name: /^Files/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Activity/ })).toBeNull();
    expect(screen.queryByText(/No files attached|No comments yet|No subtasks/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Sub-tasks" })).toBeInTheDocument();   // where you add them
    expect(screen.getByRole("button", { name: /^\d+ more fields$/ })).toHaveTextContent("4 more fields");
  });

  it("guests don't see empty description, sub-task or dependency sections at all", async () => {
    await setup({ readOnly: true, tasks: [mk({ description: "" })] });
    expect(screen.queryByText("Add details…")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sub-tasks" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Blocked by|Blocking/ })).toBeNull();
  });

  it("shows filled optional fields without being asked, and folds the empty ones", async () => {
    const f = { id: "f1", projectId: "p1", name: "Client", type: "text" as const, options: [] };
    const g = { id: "f2", projectId: "p1", name: "Budget", type: "number" as const, options: [] };
    await setup({ customFields: [f, g], tasks: [mk({ custom: { f1: "Acme" }, isMilestone: true })] });
    expect(screen.getByLabelText("Client")).toHaveValue("Acme");
    expect(screen.getByRole("checkbox", { name: "Milestone" })).toBeChecked();
    expect(screen.queryByLabelText("Budget")).toBeNull();
    expect(screen.queryByLabelText("Repeats")).toBeNull();
    showMoreFields();
    expect(screen.getByLabelText("Budget")).toBeInTheDocument();
    expect(screen.getByLabelText("Repeats")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fewer fields" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("TaskDetail — Kanbo suggests and slip history", () => {
  const today = dayOffset(0);
  it("says what slips when a task that blocks others is due today, and offers focus", async () => {
    const onStartFocus = vi.fn();
    const tasks = [
      mk({ dueDate: today, focusMin: 90 }),
      mk({ id: "t2", title: "Press kit", dependencies: ["t1"], assigneeId: "u2" }),
      mk({ id: "t3", title: "Sales brief", dependencies: ["t1"], assigneeId: "u3" }),
    ];
    await setup({ tasks, onStartFocus });
    expect(screen.getByText("Blocks 2 tasks and is due today. If it slips, Press kit (Maya) starts late.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start 90m focus" }));
    expect(onStartFocus).toHaveBeenCalledWith("t1");
  });

  it("points a blocked task at its blocker", async () => {
    const onOpenTask = vi.fn();
    const tasks = [mk({ dependencies: ["t2"] }), mk({ id: "t2", title: "Design tokens", assigneeId: "u3" })];
    await setup({ tasks, onOpenTask });
    expect(screen.getByText("Blocked by “Design tokens” (Mark).")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open blocker" }));
    expect(onOpenTask).toHaveBeenCalledWith("t2");
  });

  it("notes how often the due date has moved, once the history has loaded", async () => {
    const ev = (id: string, oldValue: string | null, newValue: string | null, at: string) =>
      ({ id, actorName: "Sana Rahman", field: "due", oldValue, newValue, createdAt: at });
    const spy = vi.spyOn(store, "listTaskEvents").mockResolvedValue([
      ev("e2", dayOffset(-2), dayOffset(3), new Date(Date.now() - 3600e3).toISOString()),
      ev("e1", dayOffset(-4), dayOffset(-2), new Date(Date.now() - 2 * 86400e3).toISOString()),
    ]);
    try {
      await setup({ tasks: [mk({ dueDate: dayOffset(3), originalDueDate: dayOffset(-4) })] });
      expect(screen.getByText(`Moved 2× · first due ${dayLabel(dayOffset(-4))}`)).toBeInTheDocument();
      // …and the moves are in the activity timeline, oldest first
      const rows = screen.getAllByText(/moved due/).map((el) => el.parentElement!.textContent);
      expect(rows[0]).toContain(`Sana Rahman moved due ${dayLabel(dayOffset(-4))} → ${dayLabel(dayOffset(-2))}`);
      expect(rows[1]).toContain(`moved due ${dayLabel(dayOffset(-2))} → ${dayLabel(dayOffset(3))}`);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("TaskDetail — people", () => {
  it("assigns from the assignee menu and adds collaborators without closing it", async () => {
    const onToggleCollaborator = vi.fn();
    const { props } = await setup({ onToggleCollaborator });
    const trigger = screen.getByRole("button", { name: /^Assignee/ });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("dialog", { name: "Assignee" });
    fireEvent.click(within(menu).getByRole("button", { name: "Mark Ode" }));
    expect(onToggleCollaborator).toHaveBeenCalledWith("t1", "u3");
    expect(screen.getByRole("dialog", { name: "Assignee" })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("option", { name: "Maya Lin" }));
    expect(props.onPatch).toHaveBeenCalledWith("t1", { assigneeId: "u2" });
    expect(screen.queryByRole("dialog", { name: "Assignee" })).toBeNull();
  });
});
