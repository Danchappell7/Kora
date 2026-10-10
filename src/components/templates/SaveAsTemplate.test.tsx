import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SaveAsTemplate, type SaveAsTemplateProps } from "./SaveAsTemplate";
import { listLibraryTemplates, resetLibraryTemplates } from "../../lib/templates";
import type { Task } from "../../data/types";

const FRI = new Date(2026, 9, 9);
const t = (o: Partial<Task> & { id: string; title: string }): Task => ({
  description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 50, ...o,
});
const parent = t({
  id: "t-1", title: "Onboard Acme", description: "Kick-off notes", priority: "high", focusMin: 60, dueDate: "2026-10-23",
  subtasks: [{ id: "c1", title: "Contract signed", done: true }, { id: "c2", title: "PO received", done: false }],
});
const kids = [
  t({ id: "k1", title: "Welcome email", parentId: "t-1", dueDate: "2026-10-12", position: 1 }),
  t({ id: "k2", title: "Kick-off call", parentId: "t-1", dueDate: "2026-10-12", assigneeId: "m-3", position: 2 }),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  resetLibraryTemplates({ demoDelayMs: 0 });
});
afterEach(() => { vi.useRealTimers(); });

function open(over: Partial<SaveAsTemplateProps> = {}) {
  const props: SaveAsTemplateProps = {
    open: true, task: parent, subtasks: kids, workspaceId: "ws-foundrise", workspaceName: "Foundrise", canShare: true,
    onClose: vi.fn(), onSaved: vi.fn(), currentUserId: "m-self", projectOwnerId: "m-3", today: FRI, ...over,
  };
  render(<SaveAsTemplate {...props} />);
  return props;
}

describe("SaveAsTemplate", () => {
  it("is prefilled from the task and says what it keeps", () => {
    open();
    expect(screen.getByRole("dialog", { name: "Save as template" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Template name" })).toHaveValue("Onboard Acme");
    expect(screen.getByRole("checkbox", { name: /2 sub-tasks/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /The checklist \(2 items\)/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Due dates/ })).toBeChecked();
    const subs = screen.getByRole("list", { name: "Sub-tasks it keeps" });
    expect(within(subs).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Welcome emailIn 3 daysYou", "Kick-off callIn 3 daysProject owner",
    ]);
  });
  it("a task that repeats keeps how it repeats, and says so", async () => {
    const p = open({ task: { ...parent, recurrence: "weekly" }, subtasks: [] });
    expect(screen.getByText("The title, description, priority, focus time, tags and how it repeats (weekly)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(p.onSaved).toHaveBeenCalled());
    expect((p.onSaved as ReturnType<typeof vi.fn>).mock.calls[0][0].body).toMatchObject({ title: "Onboard Acme", recurrence: "weekly" });
  });
  it("saves it to the library (shared, when asked) and closes", async () => {
    const p = open();
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "Client onboarding (ours)" } });
    fireEvent.click(screen.getByRole("switch", { name: "Share with Foundrise" }));
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(p.onSaved).toHaveBeenCalled());
    expect(p.onClose).toHaveBeenCalled();
    const saved = (await listLibraryTemplates("ws-foundrise")).find((x) => x.name === "Client onboarding (ours)")!;
    expect(saved).toMatchObject({
      shared: true, workspaceId: "ws-foundrise",
      body: {
        title: "Onboard Acme", description: "Kick-off notes", priority: "high", estimate: 60, dueOffsetDays: 14,
        subtasks: [{ title: "Welcome email", offsetDays: 3, assigneeRole: "me" }, { title: "Kick-off call", offsetDays: 3, assigneeRole: "project_owner" }],
        checklist: ["Contract signed", "PO received"],
      },
    });
  });
  it("can leave out the sub-tasks, the checklist and the dates", async () => {
    const p = open();
    fireEvent.click(screen.getByRole("checkbox", { name: /Due dates/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /The checklist/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(p.onSaved).toHaveBeenCalled());
    const body = (p.onSaved as ReturnType<typeof vi.fn>).mock.calls[0][0].body;
    expect(body.dueOffsetDays).toBeUndefined();
    expect(body.checklist).toBeUndefined();
    expect(body.subtasks).toEqual([{ title: "Welcome email", assigneeRole: "me" }, { title: "Kick-off call", assigneeRole: "project_owner" }]);
  });
  it("needs a name", () => {
    open();
    const name = screen.getByRole("textbox", { name: "Template name" });
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Give the template a name.")).toBeInTheDocument();
  });
  it("no sharing in Personal", () => {
    open({ workspaceId: null, canShare: true });
    expect(screen.queryByRole("switch")).toBeNull();
  });
  it("a task with nothing else keeps just its shape", () => {
    open({ task: t({ id: "t-9", title: "Tidy inbox" }), subtasks: [] });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("The title, description, priority, focus time and tags")).toBeInTheDocument();
  });
});
