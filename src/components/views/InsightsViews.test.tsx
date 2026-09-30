import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { Task, Project } from "../../data/types";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import { AnalyticsView } from "./AnalyticsView";
import { ReportsView } from "./ReportsView";
import { addDays } from "./reportingUtils";

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
