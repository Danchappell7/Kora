/* New task + the template library: "/" in the title, the Template button,
   the strip that says what it adds, and what Create hands the host.
   Pinned to Friday 9 October 2026 (before data.ts reads "today"). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-09T10:00:00+01:00") }); });

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { NewTaskModal } from "./NewTaskModal";
import { LIBRARY_BUILTINS, resetLibraryTemplates, withRecurrence, type AppliedTemplatePlan } from "../lib/templates";
import { isTaskId } from "../lib/taskOps";
import type { LibraryTemplate, Project, Task, WorkspaceMember } from "../data/types";

const PROJECTS: Project[] = [
  { id: "p-personal", name: "Personal", emoji: "🏠", color: "#999", workspaceId: null },
  { id: "p-team", name: "Clients", emoji: "💼", color: "#39f", workspaceId: "ws-1", ownerId: "u-owner" },
];
const member = (userId: string, name: string): WorkspaceMember => ({ id: "wm-" + userId, workspaceId: "ws-1", userId, name, email: `${userId}@x.test`, role: "member", status: "active" } as WorkspaceMember);
const MEMBERS = [member("u-1", "Dan Okai"), member("u-owner", "Olive Owner"), member("u-theo", "Theo Hart")];
const onboarding = LIBRARY_BUILTINS.find((t) => t.id === "builtin-lib-client-onboarding")!;

function Harness({ onCreate = vi.fn(), onApplyTemplate, projectId = "p-team", initialTemplate, templates }: {
  onCreate?: (t: Task) => void;
  onApplyTemplate?: (plan: AppliedTemplatePlan, t: LibraryTemplate) => void;
  projectId?: string;
  initialTemplate?: LibraryTemplate;
  templates?: readonly LibraryTemplate[];
}) {
  const [open, setOpen] = useState(true);
  return (
    <NewTaskModal open={open} onClose={() => setOpen(false)} onCreate={onCreate} onCreateTag={vi.fn()} onDeleteTag={vi.fn()}
      projects={PROJECTS} allTags={{}} members={MEMBERS} currentUserId="u-1" defaultProjectId={projectId}
      onApplyTemplate={onApplyTemplate} initialTemplate={initialTemplate} templates={templates} />
  );
}
const title = () => screen.getByRole("textbox", { name: "Task title" }) as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(title(), { target: { value: v } });
const create = () => fireEvent.click(screen.getByRole("button", { name: /create task/i }));

beforeEach(() => { localStorage.clear(); resetLibraryTemplates({ demoDelayMs: 0 }); });
afterEach(() => { vi.clearAllTimers(); });

describe("New task from a template", () => {
  it("“/” lists the library under the title; Enter applies one and selects its placeholder", async () => {
    render(<Harness />);
    type("/onb");
    const list = await screen.findByRole("listbox", { name: "Templates" });
    await waitFor(() => expect(within(list).getAllByRole("option")[0]).toHaveTextContent("Client onboarding"));
    expect(title()).toHaveAttribute("aria-activedescendant", within(list).getAllByRole("option")[0].id);
    fireEvent.keyDown(title(), { key: "Enter" });
    expect(screen.queryByRole("listbox", { name: "Templates" })).toBeNull();
    expect(title().value).toBe("Onboard {client}");
    await waitFor(() => expect(title()).toHaveFocus());
    expect([title().selectionStart, title().selectionEnd]).toEqual([8, 16]);
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("high");
    expect((screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toContain("Main contact");
    const strip = screen.getByRole("group", { name: "Template: Client onboarding" });
    expect(strip).toHaveTextContent("+ 6 sub-tasks · 5 checklist items");
    // what it adds, with dates and people
    fireEvent.click(within(strip).getByRole("button", { name: /Show/ }));
    const subs = screen.getByRole("list", { name: "Sub-tasks it adds" });
    expect(within(subs).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Send the welcome email and kick-off agendaMon 12 OctYou",
      "Hold the kick-off callMon 12 OctOlive Owner",
      "Set up their shared folder and project spaceMon 12 OctYou",
      "Collect logins, brand assets and contactsWed 14 OctUnassigned",
      "Agree the first milestones in writingFri 16 OctOlive Owner",
      "Book the 30-day check-inFri 23 OctYou",
    ]);
  });

  it("Create hands the host the task, its dated sub-tasks (people by role) and its checklist", async () => {
    const onApplyTemplate = vi.fn(), onCreate = vi.fn();
    render(<Harness onApplyTemplate={onApplyTemplate} onCreate={onCreate} />);
    type("/client");
    await screen.findByRole("option", { name: /Client onboarding/ });
    fireEvent.keyDown(title(), { key: "Enter" });
    type("Onboard Acme");
    create();
    expect(onCreate).not.toHaveBeenCalled();
    const [plan, tpl] = onApplyTemplate.mock.calls[0] as [AppliedTemplatePlan, LibraryTemplate];
    expect(tpl.id).toBe(onboarding.id);
    expect(plan.task).toMatchObject({ title: "Onboard Acme", projectId: "p-team", assigneeId: "u-1", priority: "high", focusMin: 60, dueDate: "2026-10-23" });
    expect(plan.subtasks.map((s) => [s.dueDate, s.assigneeId])).toEqual([
      ["2026-10-12", "u-1"], ["2026-10-12", "u-owner"], ["2026-10-12", "u-1"], ["2026-10-14", ""], ["2026-10-16", "u-owner"], ["2026-10-23", "u-1"],
    ]);
    expect(plan.checklist).toEqual(onboarding.body.checklist);
  });

  it("a different due date (typed in the title) moves the sub-tasks with it", async () => {
    const onApplyTemplate = vi.fn();
    render(<Harness onApplyTemplate={onApplyTemplate} />);
    type("/");
    fireEvent.click(await screen.findByRole("option", { name: /Client onboarding/ }));
    type("Onboard Acme 30 oct");
    create();
    const plan = onApplyTemplate.mock.calls[0][0] as AppliedTemplatePlan;
    expect(plan.task).toMatchObject({ title: "Onboard Acme", dueDate: "2026-10-30" });
    expect(plan.subtasks.map((s) => s.dueDate)).toEqual(["2026-10-19", "2026-10-19", "2026-10-19", "2026-10-21", "2026-10-23", "2026-10-30"]);
  });

  it("without a template path the host still gets everything through onCreate: sub-tasks under the task, the checklist in its notes", async () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    type("/expense");
    fireEvent.click(await screen.findByRole("option", { name: /Expense claim/ }));
    type("Expense claim: September");
    create();
    const [parent, ...kids] = onCreate.mock.calls.map((c) => c[0] as Task);
    expect(parent.title).toBe("Expense claim: September");
    // real ids from the start: a host keeps a UUID (App.persistTask re-ids anything else), so the
    // sub-tasks' parentId is the id their task is saved under (App.templates.test.tsx goes end to end)
    expect(isTaskId(parent.id)).toBe(true);
    expect(kids.every((k) => isTaskId(k.id) && k.id !== parent.id)).toBe(true);
    expect(parent.description).toContain("**Checklist**\n- Every item has a receipt");
    expect(kids.map((k) => [k.title, k.parentId, k.dueDate, k.assigneeId, k.planToday])).toEqual([
      ["Gather the receipts", parent.id, "2026-10-09", "u-1", false],
      ["Fill in the claim form", parent.id, "2026-10-12", "u-1", false],
      ["Get it approved", parent.id, "2026-10-12", "u-owner", false],
      ["Send it to finance", parent.id, "2026-10-14", "u-1", false],
    ]);
  });

  it("a template that repeats sets Repeats (unless one was chosen); Remove puts it back", async () => {
    const onApplyTemplate = vi.fn();
    const standup = { ...LIBRARY_BUILTINS[0], id: "tpl-standup", name: "Standup", body: withRecurrence({ title: "Standup notes", subtasks: [{ title: "Post blockers" }] }, "weekdays") };
    render(<Harness onApplyTemplate={onApplyTemplate} templates={[standup, ...LIBRARY_BUILTINS]} />);
    const repeat = () => screen.getByRole("combobox", { name: "Repeat" });
    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    fireEvent.click(await screen.findByRole("option", { name: /Standup/ }));
    expect(repeat()).toHaveValue("weekdays");
    fireEvent.click(screen.getByRole("button", { name: "Remove template “Standup”" }));
    expect(repeat()).toHaveValue("none");
    fireEvent.change(repeat(), { target: { value: "monthly" } });     // chosen first: it stays
    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    fireEvent.click(await screen.findByRole("option", { name: /Standup/ }));
    expect(repeat()).toHaveValue("monthly");
    create();
    expect((onApplyTemplate.mock.calls[0][0] as AppliedTemplatePlan).task).toMatchObject({ title: "Standup notes", recurrence: "monthly" });
  });

  it("the Template button offers the same list with its own search", async () => {
    const onApplyTemplate = vi.fn();
    render(<Harness onApplyTemplate={onApplyTemplate} />);
    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    const search = await screen.findByRole("textbox", { name: "Find a template" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "hire" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(title().value).toBe("Hire a {role}");
    expect(screen.getByRole("group", { name: "Template: Hiring loop" })).toBeInTheDocument();
  });

  it("Escape closes the list and keeps what was typed; the dialog stays open", async () => {
    render(<Harness />);
    type("/zzz");
    await screen.findByRole("listbox", { name: "Templates" });
    fireEvent.keyDown(title(), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Templates" })).toBeNull();
    expect(title().value).toBe("/zzz");
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
  });

  it("opens with a template applied (the library's “Use template”); Personal makes every sub-task yours", async () => {
    const onApplyTemplate = vi.fn();
    render(<Harness onApplyTemplate={onApplyTemplate} projectId="p-personal" initialTemplate={onboarding} templates={LIBRARY_BUILTINS} />);
    expect(screen.getByRole("group", { name: "Template: Client onboarding" })).toBeInTheDocument();
    expect(title().value).toBe("Onboard {client}");
    type("Onboard Acme");
    create();
    const plan = onApplyTemplate.mock.calls[0][0] as AppliedTemplatePlan;
    expect(new Set(plan.subtasks.map((s) => s.assigneeId))).toEqual(new Set(["u-1"]));
  });

  it("switching to another template keeps what was typed since", async () => {
    render(<Harness templates={LIBRARY_BUILTINS} />);
    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    fireEvent.click(await screen.findByRole("option", { name: /Weekly report/ }));
    expect(title().value).toBe("Weekly report");
    fireEvent.click(screen.getByRole("button", { name: "Remove template “Weekly report”" }));
    expect(title().value).toBe("");
    type("My own words");
    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    fireEvent.click(await screen.findByRole("option", { name: /Bug report/ }));
    expect(title().value).toBe("My own words");
    await act(async () => {});
  });
});
