import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { Task, Goal, AutomationRule, FormDef, Project } from "../../data/types";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import { AnalyticsView } from "./AnalyticsView";
import { ReportsView } from "./ReportsView";
import { WorkloadView, GoalsView, AutomationsView, FormsView } from "./ManagerViews";
import { addDays, startOfWeekMon } from "./reportingUtils";

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "rt" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-1",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...o,
});
const day = (offset: number) => toLocalISO(addDays(KANBO_TODAY, offset));
const proj = (id: string, name: string): Project => ({ id, name, emoji: "", color: "red", workspaceId: "ws" });

describe("AnalyticsView", () => {
  it("keeps the Ask Kanbo input mounted (and focused) while typing", () => {
    render(<AnalyticsView tasks={[task({ loggedHours: 1 })]} members={[{ id: "m-1", name: "Maya Lin" }]} />);
    const input = screen.getByLabelText("Ask Kanbo") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "w" } });
    fireEvent.change(input, { target: { value: "wh" } });
    const after = screen.getByLabelText("Ask Kanbo");
    expect(after).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("wh");
  });
  it("keeps the £/hr input mounted while typing", () => {
    render(<AnalyticsView tasks={[task({ loggedHours: 2 })]} />);
    const rate = screen.getByLabelText("Hourly rate");
    rate.focus();
    fireEvent.change(rate, { target: { value: "5" } });
    fireEvent.change(rate, { target: { value: "55" } });
    expect(screen.getByLabelText("Hourly rate")).toBe(rate);
    expect(document.activeElement).toBe(rate);
  });
  it("names people-field values and hides fields from other workspaces", () => {
    const tasks = [task({ projectId: "p-launch", custom: { cf1: "m-2" } })];
    render(<AnalyticsView tasks={tasks} members={[{ id: "m-2", name: "Theo Vance" }]} projects={[{ id: "p-launch" }]} customFields={[
      { id: "cf1", projectId: "p-launch", name: "Reviewer", type: "people", options: [] },
      { id: "cf2", projectId: "p-growth", name: "Elsewhere", type: "dropdown", options: ["x"] },
    ]} />);
    const groupBy = screen.getByLabelText("Group by") as HTMLSelectElement;
    const labels = [...groupBy.options].map((o) => o.text);
    expect(labels).toContain("By Reviewer");
    expect(labels).not.toContain("By Elsewhere");
    fireEvent.change(groupBy, { target: { value: "cf:people:reviewer" } });
    expect(screen.getByText("Theo Vance")).toBeInTheDocument();
    expect(screen.queryByText("m-2")).toBeNull();
  });
  it("opens a task from the estimate-vs-actual list when onOpen is given", () => {
    const onOpen = vi.fn();
    const t = task({ title: "Migrate billing", effortHours: 2, loggedHours: 5 });
    render(<AnalyticsView tasks={[t]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Open task Migrate billing" }));
    expect(onOpen).toHaveBeenCalledWith(t.id);
  });
});

describe("ReportsView", () => {
  it("lists every project (no 12-row cap) and opens the oldest open task", () => {
    const onOpen = vi.fn();
    const projects = Array.from({ length: 15 }, (_, i) => proj("px" + i, "Project " + i));
    const tasks = projects.map((p) => task({ projectId: p.id, createdAt: day(-30) }));
    render(<ReportsView tasks={tasks} projects={projects} onOpen={onOpen} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(16); // header + 15
    const first = screen.getAllByRole("button", { name: /^Open task Task/ })[0];
    fireEvent.click(first);
    expect(onOpen).toHaveBeenCalled();
  });
  it("drops a project filter that isn't in the current workspace's list", () => {
    const a = [proj("pa", "Alpha")];
    const tasks = [task({ projectId: "pa", createdAt: day(-3) })];
    const { rerender } = render(<ReportsView tasks={tasks} projects={a} />);
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "pa" } });
    rerender(<ReportsView tasks={[task({ projectId: "pb", createdAt: day(-3) })]} projects={[proj("pb", "Beta")]} />);
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("all");
  });
});

describe("WorkloadView", () => {
  it("counts only this week's work and labels people who have left", () => {
    const wk = startOfWeekMon(KANBO_TODAY);
    const inWeek = toLocalISO(addDays(wk, 6));
    render(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }]} onOpen={() => {}} tasks={[
      task({ assigneeId: "m-1", dueDate: inWeek, effortHours: 8.1 }),
      task({ assigneeId: "m-1", dueDate: day(60), effortHours: 60 }),
      task({ assigneeId: "gone-user-id", dueDate: inWeek, effortHours: 3 }),
    ]} />);
    expect(screen.getByText(/8\.1h \/ 40h · 1 task/)).toBeInTheDocument();
    expect(screen.queryByText(/Over capacity/)).toBeNull();
    expect(screen.getByText("(former member)")).toBeInTheDocument();
  });
});

describe("GoalsView", () => {
  const base = { projects: [] as Project[], tasks: [] as Task[], onCreate: () => {}, onDelete: () => {} };
  it("renders grandchildren and offers a parent select on nested goals", () => {
    const goals: Goal[] = [
      { id: "C", name: "Company", status: "on_track" },
      { id: "A", name: "Alpha", status: "on_track", parentId: "C" },
      { id: "B", name: "Beta", status: "on_track", parentId: "A" },
    ];
    render(<GoalsView {...base} goals={goals} onUpdate={() => {}} />);
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
    const parentOfA = screen.getByLabelText("Parent goal of Alpha") as HTMLSelectElement;
    const opts = [...parentOfA.options].map((o) => o.value);
    expect(opts).toContain("");       // "No parent goal"
    expect(opts).toContain("C");
    expect(opts).not.toContain("A");  // itself
    expect(opts).not.toContain("B");  // its own sub-goal
    expect(screen.getByLabelText("Parent goal of Beta")).toBeInTheDocument();
  });
  it("saves a renamed goal once, on blur", () => {
    const onUpdate = vi.fn();
    render(<GoalsView {...base} goals={[{ id: "G", name: "Grow", status: "on_track" }]} onUpdate={onUpdate} />);
    const input = screen.getByLabelText("Goal name: Grow");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Grow r" } });
    fireEvent.change(input, { target: { value: "Grow revenue " } });
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("G", { name: "Grow revenue" });
  });
});

describe("AutomationsView", () => {
  const rule = (actions: AutomationRule["actions"]): AutomationRule => ({ id: "r1", projectId: "pa", name: "Triage", trigger: "task_created", actions, enabled: false });
  const tags = { "tag-uuid-1": { label: "Urgent", color: "red" } };
  it("picks tags by id and links a legacy free-text value to the matching tag", () => {
    const onUpdate = vi.fn();
    render(<AutomationsView rules={[rule([{ type: "add_tag", value: "urgent" }])]} projects={[proj("pa", "Alpha")]} members={[]} sections={[]} tags={tags} onCreate={() => {}} onUpdate={onUpdate} onDelete={() => {}} />);
    const sel = screen.getByLabelText("Tag added by Triage") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toContain("tag-uuid-1");
    fireEvent.click(screen.getByRole("button", { name: /Link to tag “Urgent”/ }));
    expect(onUpdate).toHaveBeenCalledWith("r1", { actions: [{ type: "add_tag", value: "tag-uuid-1" }] });
  });
  it("shows the paused switch as an accessible switch", () => {
    render(<AutomationsView rules={[rule([])]} projects={[proj("pa", "Alpha")]} members={[]} sections={[]} tags={tags} onCreate={() => {}} onUpdate={() => {}} onDelete={() => {}} />);
    expect(screen.getByRole("switch", { name: "Run rule Triage" })).toHaveAttribute("aria-checked", "false");
  });
});

describe("FormsView", () => {
  it("saves a new form into the current workspace's project after a switch", () => {
    const onCreate = vi.fn();
    const props = { forms: [] as FormDef[], members: [], onUpdate: () => {}, onDelete: () => {}, onSubmit: () => {}, onCreate };
    const { rerender } = render(<FormsView {...props} projects={[proj("pa", "Alpha")]} />);
    rerender(<FormsView {...props} projects={[proj("pb", "Beta")]} />);
    fireEvent.click(screen.getByRole("button", { name: /New form/ }));
    fireEvent.change(screen.getByLabelText("New form name"), { target: { value: "Bug report" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith("pb", "Bug report", ["description", "priority"]);
  });
});
