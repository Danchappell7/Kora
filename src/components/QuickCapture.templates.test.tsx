/* Quick capture + the template library: "/" picks one, what's typed after it
   still reads as tokens, and ⏎ hands the host the whole plan.
   Pinned to Friday 9 October 2026 (before data.ts reads "today"). */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-09T10:00:00+01:00") }); });

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { QuickCapture } from "./QuickCapture";
import { resetLibraryTemplates, type AppliedTemplatePlan } from "../lib/templates";
import type { ImportRow } from "../lib/importTasks";
import type { LibraryTemplate, Task } from "../data/types";

const PROJECTS = [
  { id: "p-launch", name: "Q3 Product Launch", color: "oklch(0.7 0.15 230)", workspaceId: "ws-foundrise", ownerId: "m-1" },
  { id: "p-personal", name: "Personal", color: "oklch(0.7 0.15 270)", workspaceId: null },
];
const MEMBERS = [{ id: "m-1", name: "Maya Lin" }, { id: "m-3", name: "Sana Rao" }];

function Harness({ onCreate = vi.fn(), onApplyTemplate, onImportRows, defaultProjectId = "p-launch" }: {
  onCreate?: (t: Partial<Task> & { title: string }) => void;
  onApplyTemplate?: (plan: AppliedTemplatePlan, t: LibraryTemplate) => void;
  onImportRows?: (rows: ImportRow[]) => void;
  defaultProjectId?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <QuickCapture open={open} onClose={() => setOpen(false)} projects={PROJECTS} members={MEMBERS} tags={{}} currentUserId="m-self"
        defaultProjectId={defaultProjectId} onCreate={onCreate} onApplyTemplate={onApplyTemplate} onImportRows={onImportRows} />
    </>
  );
}
const field = () => screen.getByRole("textbox", { name: "Quick capture a task" }) as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(field(), { target: { value: v } });
const pick = async (q: string, name: RegExp) => {
  type(q);
  const opt = await screen.findByRole("option", { name });
  await waitFor(() => expect(within(screen.getByRole("listbox", { name: "Templates" })).getAllByRole("option")[0]).toBe(opt));
  fireEvent.keyDown(field(), { key: "Enter" });
};

beforeEach(() => { localStorage.clear(); resetLibraryTemplates({ demoDelayMs: 0 }); });

describe("Quick capture from a template", () => {
  it("“/bug” then ⏎ applies it: the title takes the field, its placeholder selected, a chip says what it adds", async () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    await pick("/bug", /Bug report/);
    expect(onCreate).not.toHaveBeenCalled();           // ⏎ picked: it didn't add "/bug"
    expect(field().value).toBe("Bug: {summary}");
    await waitFor(() => expect([field().selectionStart, field().selectionEnd]).toEqual([5, 14]));
    expect(screen.getByRole("group", { name: "Task details" })).toHaveTextContent("Bug report+ 5 sub-tasks");
    expect(screen.getByText(/From the template Bug report, with 5 sub-tasks/)).toBeInTheDocument();
  });

  it("what's typed still reads as tokens; ⏎ gives the host the task and its sub-tasks, dated from that due date", async () => {
    const onApplyTemplate = vi.fn();
    render(<Harness onApplyTemplate={onApplyTemplate} />);
    await pick("/bug", /Bug report/);
    type("Bug: login fails fri");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
    const [plan, tpl] = onApplyTemplate.mock.calls[0] as [AppliedTemplatePlan, LibraryTemplate];
    expect(tpl.id).toBe("builtin-lib-bug-report");
    expect(plan.task).toMatchObject({
      title: "Bug: login fails", dueDate: "2026-10-16", priority: "high", projectId: "p-launch", focusMin: 60, status: "todo",
    });
    expect(plan.task.description).toContain("Steps to reproduce");
    // the template's own due date is 3 days in: the sub-tasks work back from Friday the 16th
    expect(plan.subtasks.map((s) => [s.title, s.dueDate, s.assigneeId])).toEqual([
      ["Reproduce it and note the exact steps", "2026-10-13", "m-self"],
      ["Find the cause", "2026-10-14", "m-self"],
      ["Fix it and add a test", "2026-10-15", "m-self"],
      ["Review the fix", "2026-10-16", "m-1"],
      ["Let whoever reported it know", "2026-10-16", "m-self"],
    ]);
    expect(plan.checklist).toHaveLength(4);
  });

  it("a priority typed wins over the template's", async () => {
    const onApplyTemplate = vi.fn();
    render(<Harness onApplyTemplate={onApplyTemplate} />);
    await pick("/weekly", /Weekly report/);
    type("Weekly report !urgent");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect((onApplyTemplate.mock.calls[0][0] as AppliedTemplatePlan).task).toMatchObject({ title: "Weekly report", priority: "urgent", dueDate: "2026-10-12" });
  });

  it("without a template path, sub-tasks go in as import rows under the task (the checklist in its notes)", async () => {
    const onImportRows = vi.fn();
    render(<Harness onImportRows={onImportRows} />);
    await pick("/expense", /Expense claim/);
    type("Expense claim: September");
    fireEvent.keyDown(field(), { key: "Enter" });
    const rows = onImportRows.mock.calls[0][0] as ImportRow[];
    expect(rows[0]).toMatchObject({ title: "Expense claim: September", projectId: "p-launch" });
    expect(rows[0].description).toContain("**Checklist**\n- Every item has a receipt");
    expect(rows.slice(1).map((r) => [r.title, r.parentIndex, r.dueDate])).toEqual([
      ["Gather the receipts", 0, "2026-10-09"], ["Fill in the claim form", 0, "2026-10-12"],
      ["Get it approved", 0, "2026-10-12"], ["Send it to finance", 0, "2026-10-14"],
    ]);
  });

  it("✕ on the chip takes the template off (and the untouched title with it)", async () => {
    render(<Harness />);
    await pick("/hiring", /Hiring loop/);
    fireEvent.click(screen.getByRole("button", { name: "Remove template “Hiring loop”" }));
    expect(field().value).toBe("");
    expect(screen.queryByText(/Hiring loop/)).toBeNull();
  });

  it("Escape closes the list (not the sheet); ⇧⏎ adds and starts afresh without the template", async () => {
    const onApplyTemplate = vi.fn();
    render(<Harness onApplyTemplate={onApplyTemplate} />);
    type("/qqq");
    await screen.findByRole("listbox", { name: "Templates" });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Templates" })).toBeNull();
    expect(screen.getByTestId("state")).toHaveTextContent("open");
    type("/qqqx");                                       // still dismissed while the slash stays…
    expect(screen.queryByRole("listbox", { name: "Templates" })).toBeNull();
    type("");                                            // …and back once it's gone
    await pick("/content", /Content piece/);
    type("Write: pricing page");
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(onApplyTemplate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("state")).toHaveTextContent("open");
    expect(field().value).toBe("");
    expect(screen.queryByRole("button", { name: /Remove template/ })).toBeNull();
  });

  it("in Personal every sub-task is yours", async () => {
    const onApplyTemplate = vi.fn();
    render(<Harness onApplyTemplate={onApplyTemplate} defaultProjectId="p-personal" />);
    await pick("/contract", /Contract review/);
    type("Review contract: Acme");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(new Set((onApplyTemplate.mock.calls[0][0] as AppliedTemplatePlan).subtasks.map((s) => s.assigneeId))).toEqual(new Set(["m-self"]));
  });
});
