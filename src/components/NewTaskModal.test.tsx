import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { useState } from "react";
import { NewTaskModal } from "./NewTaskModal";
import { resetLibraryTemplates, saveTemplate } from "../lib/templates";
import { parseDateText } from "../lib/nlp";
import { presetDate } from "../data/data";
import type { Project, TagDef, Task } from "../data/types";

const PROJECTS: Project[] = [
  { id: "p-personal", name: "Personal", emoji: "🏠", color: "#999", workspaceId: null },
  { id: "p-web", name: "Website", emoji: "🌐", color: "#39f", workspaceId: null },
];
const TAGS: Record<string, TagDef> = {
  "tag-design": { label: "Design", color: "oklch(0.74 0.16 305)" },
  "tag-ops": { label: "Ops", color: "oklch(0.74 0.14 230)" },
};

function Harness({ onCreate = vi.fn(), onDeleteTag = vi.fn(), tags = TAGS, projectId, projects = PROJECTS }: { onCreate?: (t: Task) => void; onDeleteTag?: (id: string) => void; tags?: Record<string, TagDef>; projectId?: string; projects?: Project[] }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>open-modal</button>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <NewTaskModal open={open} onClose={() => setOpen(false)} onCreate={onCreate} onCreateTag={vi.fn()} onDeleteTag={onDeleteTag}
        projects={projects} allTags={tags} members={[]} currentUserId="u-1" defaultProjectId={projectId} />
    </>
  );
}
const title = () => screen.getByRole("textbox", { name: "Task title" }) as HTMLInputElement;
const typeTitle = (v: string) => fireEvent.change(title(), { target: { value: v } });
const reopen = () => { fireEvent.click(screen.getByText("open-modal")); act(() => { vi.advanceTimersByTime(50); }); };
// An accidental close with Escape. Escape in the title first only leaves the
// field (nothing typed is lost, focus parks on the dialog); the next one closes.
const escape = () => {
  act(() => title().focus());
  fireEvent.keyDown(title(), { key: "Escape" });
  expect(screen.getByTestId("state")).toHaveTextContent("open");
  const dialog = screen.getByRole("dialog", { name: "New task" });
  expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByTestId("state")).toHaveTextContent("closed");
};

beforeEach(() => { localStorage.clear(); resetLibraryTemplates({ demoDelayMs: 0 }); vi.useFakeTimers({ shouldAdvanceTime: true }); });
// restore only our own spies — restoreAllMocks would also wipe the global
// matchMedia mock from src/test/setup.ts
const spies: { mockRestore: () => void }[] = [];
const mockConfirm = (v: boolean) => { const s = vi.spyOn(window, "confirm").mockReturnValue(v); spies.push(s); return s; };
afterEach(() => { vi.useRealTimers(); spies.splice(0).forEach((s) => s.mockRestore()); });

describe("NewTaskModal", () => {
  it("Escape in the New tag box closes only the box — the task draft survives", () => {
    render(<Harness />);
    typeTitle("Ship the rollout deck");
    fireEvent.click(screen.getByRole("button", { name: /new tag/i }));
    const tagInput = screen.getByRole("textbox", { name: "New tag name" });
    fireEvent.change(tagInput, { target: { value: "Launch" } });
    fireEvent.keyDown(tagInput, { key: "Escape" });
    expect(screen.getByTestId("state")).toHaveTextContent("open");
    expect(screen.queryByRole("textbox", { name: "New tag name" })).toBeNull();
    expect(title().value).toBe("Ship the rollout deck");
    // Escape elsewhere still closes the modal (from the title: leave it, then close)
    escape();
  });

  it("opens blank after an accidental close and offers the draft back instead of forcing it", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    typeTitle("Chase Acme invoice");
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), { target: { value: "high" } });
    escape();
    reopen();
    // blank and focused, so the usual "c, type, Enter" creates exactly what was typed
    expect(title().value).toBe("");
    expect(title()).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved draft: “Chase Acme invoice”");
    typeTitle("Call supplier");
    fireEvent.keyDown(title(), { key: "Enter" });
    expect(onCreate.mock.calls[0][0]).toMatchObject({ title: "Call supplier", priority: "medium" });

    // the draft is still on offer until it's restored or discarded
    reopen();
    fireEvent.click(screen.getByRole("button", { name: "Restore draft “Chase Acme invoice”" }));
    expect(title().value).toBe("Chase Acme invoice");
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("high");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.keyDown(title(), { key: "Enter" });
    expect(onCreate.mock.calls[1][0]).toMatchObject({ title: "Chase Acme invoice", priority: "high", projectId: "p-personal" });
    reopen();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Restore swaps with what's already typed, so neither is lost", () => {
    render(<Harness />);
    typeTitle("First draft");
    escape();
    reopen();
    typeTitle("Second thought");
    fireEvent.click(screen.getByRole("button", { name: "Restore draft “First draft”" }));
    expect(title().value).toBe("First draft");
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved draft: “Second thought”");
  });

  it("Discard drops the saved draft, and Cancel never saves one", () => {
    render(<Harness />);
    typeTitle("Half-written task");
    escape();
    reopen();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft “Half-written task”" }));
    expect(screen.queryByRole("status")).toBeNull();
    typeTitle("Not wanted");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    reopen();
    expect(title().value).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("never re-files a restored draft into another workspace's project", () => {
    const onCreate = vi.fn();
    const personal: Project[] = [{ id: "p-diary", name: "Diary", emoji: "📓", color: "#999", workspaceId: null }];
    const team: Project[] = [{ id: "p-team", name: "Team board", emoji: "👥", color: "#39f", workspaceId: "ws-1" }];
    const { rerender } = render(<Harness onCreate={onCreate} projects={personal} projectId="p-diary" />);
    typeTitle("Book GP appointment re results");
    escape();
    // switch workspace, then come back to the modal
    rerender(<Harness onCreate={onCreate} projects={team} />);
    reopen();
    fireEvent.keyDown(title(), { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore draft “Book GP appointment re results”" }));
    const project = screen.getByRole("combobox", { name: "Project" });
    expect(project).toHaveValue("");
    expect(project).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("“Diary” isn't in this workspace — choose a project for this draft.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create task/i })).toBeDisabled();
    fireEvent.keyDown(title(), { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
    expect(project).toHaveFocus();
    // an explicit choice is fine
    fireEvent.change(project, { target: { value: "p-team" } });
    fireEvent.keyDown(title(), { key: "Enter" });
    expect(onCreate.mock.calls[0][0]).toMatchObject({ title: "Book GP appointment re results", projectId: "p-team" });
  });

  it("starts blank again after creating a task", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    typeTitle("Book venue");
    fireEvent.keyDown(title(), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toMatchObject({ title: "Book venue", projectId: "p-personal" });
    fireEvent.click(screen.getByText("open-modal"));
    expect(title().value).toBe("");
  });

  it("applies a template from the library: its description, and only the tags that still exist", async () => {
    saveTemplate({ name: "Client kickoff", title: "Onboard: ", priority: "high", tags: ["tag-design", "tag-gone"], focusMin: 45, recurrence: "none", description: "**Checklist**\n- kickoff" });
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Ops" })); // picked before the template — must survive it
    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    fireEvent.click(await screen.findByRole("option", { name: /Client kickoff/ }));
    expect(title().value).toBe("Onboard: ");   // as it was saved: typed on from
    expect((screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe("**Checklist**\n- kickoff");
    expect(screen.getByRole("group", { name: "Template: Client kickoff" })).toBeInTheDocument();
    typeTitle("Onboard: Acme");
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);   // no sub-tasks in this one
    expect(onCreate.mock.calls[0][0]).toMatchObject({ title: "Onboard: Acme", description: "**Checklist**\n- kickoff", priority: "high", tags: ["tag-ops", "tag-design"], focusMin: 45 });
  });

  it("never overwrites a title the user already typed when a template is picked; Remove undoes the rest", async () => {
    render(<Harness />);
    typeTitle("Login button broken");
    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    fireEvent.click(await screen.findByRole("option", { name: /Bug report/ }));
    expect(title().value).toBe("Login button broken");
    expect((screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toContain("Steps to reproduce");
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("high");
    // taking the template off undoes its settings but keeps the typed title
    fireEvent.click(screen.getByRole("button", { name: "Remove template “Bug report”" }));
    expect(title().value).toBe("Login button broken");
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("medium");
    act(() => { vi.advanceTimersByTime(400); }); // description collapses away
    expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull();
  });

  it("lists each built-in template exactly once, with this browser's own", async () => {
    saveTemplate({ name: "A", title: "A", priority: "medium", tags: [], focusMin: 30, recurrence: "none", description: "" });
    saveTemplate({ name: "B", title: "B", priority: "medium", tags: [], focusMin: 30, recurrence: "none", description: "" });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    await screen.findByRole("option", { name: /Bug report/ });
    const opts = within(screen.getByRole("listbox", { name: "Templates" })).getAllByRole("option").map((o) => o.querySelector(".ktpl-pick-name")!.textContent);
    expect(opts.filter((t) => t === "Bug report")).toHaveLength(1);
    expect(opts).toEqual(expect.arrayContaining(["A", "B"]));
  });

  it("drops a deleted tag from the draft", () => {
    mockConfirm(true);
    const onCreate = vi.fn();
    const onDeleteTag = vi.fn();
    render(<Harness onCreate={onCreate} onDeleteTag={onDeleteTag} />);
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    fireEvent.click(screen.getByRole("button", { name: "Ops" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete tag Design" }));
    expect(onDeleteTag).toHaveBeenCalledWith("tag-design");
    typeTitle("Tagged task");
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    expect(onCreate.mock.calls[0][0].tags).toEqual(["tag-ops"]);
  });

  it("has no native date or time inputs: due and start dates are DateChips", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    const dialog = screen.getByRole("dialog", { name: "New task" });
    expect(dialog.querySelector('input[type="date"], input[type="time"], input[type="datetime-local"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Due date: No due date" }));
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect(screen.getByRole("button", { name: "Due date: Tomorrow" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start date: No start date" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    typeTitle("Book the venue");
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    expect(onCreate.mock.calls[0][0]).toMatchObject({ title: "Book the venue", dueDate: presetDate("tomorrow"), startDate: presetDate("today") });
  });

  it("reads the title with the one grammar: the properties show what it read, and the task gets it", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    typeTitle("Email the supplier fri 3pm #web !high +design 45m");
    // the tokens are highlighted in place…
    const marks = Array.from(document.querySelectorAll(".ktok-mark")).map((m) => m.textContent);
    expect(marks).toEqual(["fri", "3pm", "#web", "!high", "+design", "45m"]);
    // …and each property shows what will be created
    const fri = parseDateText("fri")!.date!;
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("p-web");
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("high");
    expect(screen.getByRole("combobox", { name: "Focus time" })).toHaveValue("45");
    expect(screen.getByRole("button", { name: /^Due date: .*15:00$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(title(), { key: "Enter" });
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      title: "Email the supplier", dueDate: fri, dueTime: "15:00", projectId: "p-web", priority: "high", tags: ["tag-design"], focusMin: 45,
    });
  });

  it("choosing a property by hand takes over from the token typed for it", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    typeTitle("Chase invoice !high tomorrow");
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), { target: { value: "low" } });
    expect(title().value).toBe("Chase invoice tomorrow");
    fireEvent.click(screen.getByRole("button", { name: "Due date: Tomorrow" }));
    fireEvent.click(screen.getByRole("button", { name: "No date" }));
    expect(title().value).toBe("Chase invoice");
    fireEvent.keyDown(title(), { key: "Enter" });
    const t = onCreate.mock.calls[0][0];
    expect(t).toMatchObject({ title: "Chase invoice", priority: "low" });
    expect(t.dueDate).toBeUndefined();
  });

  it("the title wraps rather than scrolling, but stays one line: a pasted line break is a space and ⏎ creates", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    expect(title().tagName).toBe("TEXTAREA");
    typeTitle("Book the venue\n  for the launch party");
    expect(title().value).toBe("Book the venue for the launch party");
    fireEvent.keyDown(title(), { key: "Enter" });
    expect(onCreate.mock.calls[0][0].title).toBe("Book the venue for the launch party");
  });

  it("un-picking a tag typed in the title takes it out of the title", () => {
    render(<Harness />);
    typeTitle("Moodboard +design for the pitch");
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    expect(title().value).toBe("Moodboard for the pitch");
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "false");
  });
});
