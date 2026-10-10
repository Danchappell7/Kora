/* The phone's quick add + the template library: "/" (or "From a template", for a thumb) picks one, what's
   typed still reads as tokens, and Add hands the host the whole plan — as Quick capture does.
   Pinned to Friday 9 October 2026 (before data.ts reads "today"). */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-09T10:00:00+01:00") }); });

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { QuickAddSheet, resetQuickAddMemory, type QuickAddSheetProps } from "./QuickAddSheet";
import { resetLibraryTemplates, type AppliedTemplatePlan } from "../lib/templates";
import type { LibraryTemplate } from "../data/types";

const projects: QuickAddSheetProps["projects"] = [
  { id: "p-launch", name: "Launch", color: "#5b5bd6", emoji: "🚀", workspaceId: "ws-foundrise", ownerId: "m-1" },
  { id: "p-web", name: "Website", color: "#e76f51", emoji: "", workspaceId: "ws-foundrise" },
];
const members = [{ id: "m-1", name: "Maya Lin" }, { id: "m-self", name: "Dan Okai" }];

function Host(extra: Partial<QuickAddSheetProps>) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <QuickAddSheet open={open} onClose={() => setOpen(false)} projects={projects} members={members} currentUserId="m-self"
        defaultProjectId="p-launch" workspaceId="ws-foundrise" tags={{}} onCreate={vi.fn()} {...extra} />
    </>
  );
}
const field = () => screen.getByRole("textbox", { name: "Task, in your own words" }) as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(field(), { target: { value: v } });
const pickFirst = async (name: RegExp) => {
  const opt = await screen.findByRole("option", { name });
  await waitFor(() => expect(within(screen.getByRole("listbox", { name: "Templates" })).getAllByRole("option")[0]).toBe(opt));
  fireEvent.keyDown(field(), { key: "Enter" });
};

beforeEach(() => { localStorage.clear(); resetQuickAddMemory(); resetLibraryTemplates({ demoDelayMs: 0 }); });

describe("Quick add from a template", () => {
  it("“/bug” then ⏎ picks it (nothing is added yet): the title takes the field, its placeholder selected, a strip says what it adds", async () => {
    const onCreate = vi.fn(), onApplyTemplate = vi.fn();
    render(<Host onCreate={onCreate} onApplyTemplate={onApplyTemplate} />);
    type("/bug");
    // the picker has the field: no tokens read out of "/bug", nothing to add yet
    expect(screen.queryByRole("group", { name: "What Kanbo read" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
    await pickFirst(/Bug report/);
    expect(onCreate).not.toHaveBeenCalled();
    expect(onApplyTemplate).not.toHaveBeenCalled();
    expect(field().value).toBe("Bug: {summary}");
    await waitFor(() => expect([field().selectionStart, field().selectionEnd]).toEqual([5, 14]));
    expect(screen.getByRole("group", { name: "Template: Bug report" })).toHaveTextContent("From “Bug report”+ 5 sub-tasks");
    expect(screen.getByText(/From the template Bug report, with 5 sub-tasks/)).toBeInTheDocument();
  });

  it("what's typed still reads (a date moves the sub-tasks with it); Add hands the host the task, its sub-tasks and checklist", async () => {
    const onCreate = vi.fn(), onApplyTemplate = vi.fn();
    render(<Host onCreate={onCreate} onApplyTemplate={onApplyTemplate} />);
    type("/bug");
    await pickFirst(/Bug report/);
    type("Bug: login fails fri");
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
    expect(onCreate).not.toHaveBeenCalled();
    const [plan, tpl] = onApplyTemplate.mock.calls[0] as [AppliedTemplatePlan, LibraryTemplate];
    expect(tpl.id).toBe("builtin-lib-bug-report");
    expect(plan.task).toMatchObject({ title: "Bug: login fails", dueDate: "2026-10-16", priority: "high", projectId: "p-launch", focusMin: 60, status: "todo" });
    expect(plan.subtasks.map((s) => [s.dueDate, s.assigneeId])).toEqual([
      ["2026-10-13", "m-self"], ["2026-10-14", "m-self"], ["2026-10-15", "m-self"], ["2026-10-16", "m-1"], ["2026-10-16", "m-self"],
    ]);
    expect(plan.checklist).toHaveLength(4);
  });

  it("“From a template” is the thumb's way to the picker; Remove goes back to a plain task", async () => {
    const onCreate = vi.fn(), onApplyTemplate = vi.fn();
    render(<Host onCreate={onCreate} onApplyTemplate={onApplyTemplate} />);
    fireEvent.click(screen.getByRole("button", { name: "From a template" }));
    expect(field().value).toBe("/");
    await screen.findByRole("listbox", { name: "Templates" });
    // (typing on narrows it, as "/" does)
    type("/weekly");
    await pickFirst(/Weekly report/);
    expect(screen.queryByRole("button", { name: "From a template" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove template “Weekly report”" }));
    expect(field().value).toBe("");
    expect(screen.queryByRole("group", { name: /^Template:/ })).toBeNull();
    type("Call the printer");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onApplyTemplate).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Call the printer" }));
  });

  it("Escape sets the picker aside (the sheet stays open); without a host for templates, “/” is just a character", async () => {
    const { unmount } = render(<Host onApplyTemplate={vi.fn()} />);
    type("/zzz");
    await waitFor(() => expect(screen.getAllByText(/No templates match “zzz”/).length).toBeGreaterThan(0));
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Templates" })).toBeNull();
    expect(screen.getByTestId("state")).toHaveTextContent("open");
    expect(field().value).toBe("/zzz");
    unmount();
    resetQuickAddMemory();
    render(<Host />);
    expect(screen.queryByRole("button", { name: "From a template" })).toBeNull();
    type("/bug");
    expect(screen.queryByRole("listbox", { name: "Templates" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add task" })).toBeEnabled();
  });
});
