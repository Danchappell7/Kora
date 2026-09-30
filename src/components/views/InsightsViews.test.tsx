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
// a figure never ends a line: the space after it is non-breaking
const kpiText = () => (document.querySelector(".kin-kpi")?.textContent ?? "").replace(/\u00a0/g, " ");

describe("AnalyticsView", () => {
  it("Ask Kanbo button calls onAsk", () => {
    const onAsk = vi.fn();
    render(<AnalyticsView tasks={[task({})]} onAsk={onAsk} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Kanbo" }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    // the old inline Ask box is gone: Ask lives in ⌘K
    expect(screen.queryByRole("textbox", { name: "Ask Kanbo" })).toBeNull();
  });
  it("switches to Trends from the Overview · Trends control", () => {
    const onOpenTrends = vi.fn();
    render(<AnalyticsView tasks={[task({})]} onOpenTrends={onOpenTrends} />);
    const views = screen.getByRole("group", { name: "Insights view" });
    expect(within(views).getByRole("button", { name: "Overview" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(views).getByRole("button", { name: "Trends" }));
    expect(onOpenTrends).toHaveBeenCalledTimes(1);
  });
  it("states each figure once in the KPI sentence, with no duplicate tiles", () => {
    const tasks = [
      task({ status: "done", dueDate: day(-1), completedAt: day(-1) }),
      task({ status: "done", dueDate: day(-2), completedAt: day(-2) }),
      task({ status: "done", dueDate: day(-5), completedAt: day(-3) }),
      task({ status: "done", completedAt: day(-20) }), // outside the past week
      task({ status: "todo", dueDate: day(-4) }),
      task({ status: "progress", dueDate: day(-1) }),
      task({ status: "blocked", dueDate: day(3) }),
    ];
    render(<AnalyticsView tasks={tasks} />);
    expect(kpiText()).toBe("In the past week the team finished 3 tasks — 67% on time. 2 are overdue and 1 is blocked.");
    expect(document.body.textContent!.match(/67%/g)).toHaveLength(1);
    // the stat tiles, the banner and the duplicate cards are gone
    for (const gone of ["Completion rate", "On-time rate", "Done this week", "Open tasks", "Finished early", "Focus today"]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.queryByRole("heading", { name: "By status" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "By priority" })).toBeNull();
    // four cards, in pairs
    expect(document.querySelectorAll(".kin-grid > .kin-card")).toHaveLength(4);
  });
  it("Me scope filters to your tasks (assigned or shared with you)", () => {
    const onScopeChange = vi.fn();
    const tasks = [
      task({ status: "done", assigneeId: "me", completedAt: day(0) }),
      task({ status: "done", assigneeId: "m-2", collaborators: ["me"], completedAt: day(-1) }),
      task({ status: "done", assigneeId: "m-2", completedAt: day(-1) }),
      task({ status: "done", assigneeId: "m-3", completedAt: day(-2) }),
    ];
    render(<AnalyticsView tasks={tasks} currentUserId="me" onScopeChange={onScopeChange}
      members={[{ id: "me", name: "Daniel Okai" }, { id: "m-2", name: "Theo Vance" }, { id: "m-3", name: "Sana Rao" }]} />);
    expect(kpiText()).toContain("the team finished 4 tasks");
    expect(screen.getByRole("heading", { name: /Team output/ })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Scope" })).getByRole("button", { name: "Me" }));
    expect(onScopeChange).toHaveBeenCalledWith("me");
    expect(kpiText()).toContain("you finished 2 tasks");
    // on your own, "who carried the work" becomes "where your work went"
    expect(screen.queryByRole("heading", { name: /Team output/ })).toBeNull();
    expect(screen.getByRole("heading", { name: /By project/ })).toBeInTheDocument();
  });
  it("follows a controlled scope and hides Me · Team in a Personal workspace", () => {
    const tasks = [task({ status: "done", assigneeId: "me", completedAt: day(0) }), task({ status: "done", assigneeId: "", completedAt: day(0) })];
    const { rerender } = render(<AnalyticsView tasks={tasks} currentUserId="me" scope="me" />);
    expect(kpiText()).toContain("you finished 1 task.");
    rerender(<AnalyticsView tasks={tasks} currentUserId="me" personal />);
    expect(screen.queryByRole("group", { name: "Scope" })).toBeNull();
    // everything in a Personal workspace is yours, assigned or not
    expect(kpiText()).toContain("you finished 2 tasks");
  });
  it("shows the empty state for an empty workspace, and offers the team when nothing is yours", () => {
    const { unmount } = render(<AnalyticsView tasks={[]} />);
    expect(screen.getByText("Insights appear once your team finishes a few tasks.")).toBeInTheDocument();
    unmount();
    render(<AnalyticsView tasks={[task({ assigneeId: "m-2" })]} currentUserId="me" scope="me" />);
    expect(screen.getByText("Nothing's assigned to you here yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the team" })).toBeInTheDocument();
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
  it("keeps the £/hr input (moved to Time & billing) mounted while typing", () => {
    render(<ReportsView tasks={[task({ loggedHours: 2 })]} projects={[proj("p-launch", "Launch")]} />);
    const rate = screen.getByLabelText("Hourly rate");
    rate.focus();
    fireEvent.change(rate, { target: { value: "5" } });
    fireEvent.change(rate, { target: { value: "55" } });
    expect(screen.getByLabelText("Hourly rate")).toBe(rate);
    expect(document.activeElement).toBe(rate);
    expect(screen.getByText("£110.00")).toBeInTheDocument();
  });
  it("includes the weekly summary in the PDF when ticked, and leaves it out when not", () => {
    const write = vi.fn();
    const popup = { document: { write, close: vi.fn() }, focus: vi.fn(), print: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const tasks = [
      task({ title: "Ship the <launch> email", status: "done", createdAt: day(-3), dueDate: day(-1), completedAt: day(-1) }),
      task({ title: "Brief the press", status: "todo", createdAt: day(-2), dueDate: day(2) }),
    ];
    render(<ReportsView tasks={tasks} projects={[proj("p-launch", "Launch")]} />);
    const include = screen.getByRole("checkbox", { name: "Include in PDF" });
    expect(include).toBeChecked();
    // writing it on-device shows the same summary the PDF will carry
    fireEvent.click(screen.getByRole("button", { name: "Write this week's summary" }));
    expect(screen.getByText(/Finished 1 task/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export as PDF" }));
    const html = String(write.mock.calls[0][0]);
    expect(html).toContain("<h2>Weekly summary</h2>");
    expect(html).toContain("<b>Finished 1 task</b>");
    expect(html).toContain("“Brief the press”");
    expect(html).not.toContain("<launch>"); // user text is escaped
    fireEvent.click(include);
    fireEvent.click(screen.getByRole("button", { name: "Export as PDF" }));
    expect(String(write.mock.calls[1][0])).not.toContain("Weekly summary");
    open.mockRestore();
  });
  it("writes Kanbo's summary on vellum with provenance", async () => {
    const aiSummary = vi.fn().mockResolvedValue({ data: "- **Shipped** the launch deck", source: "ai" });
    render(<ReportsView tasks={[task({ createdAt: day(-2) })]} projects={[]} aiSummary={aiSummary} />);
    fireEvent.click(screen.getByRole("button", { name: "Write this week's summary" }));
    expect(await screen.findByText("Shipped")).toBeInTheDocument();
    expect(aiSummary).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".kvellum")).not.toBeNull();
    expect(screen.getByRole("button", { name: /How I got here/ })).toBeInTheDocument();
  });
  it("falls back to the on-device summary, with a note, when Kanbo can't write it", async () => {
    const aiSummary = vi.fn().mockResolvedValue({ data: null, source: "unavailable" });
    render(<ReportsView tasks={[task({ createdAt: day(-2) })]} projects={[]} aiSummary={aiSummary} />);
    fireEvent.click(screen.getByRole("button", { name: "Write this week's summary" }));
    expect(await screen.findByText(/Kanbo couldn't write it just now/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing finished/)).toBeInTheDocument();
    expect(document.querySelector(".kvellum")).toBeNull();
    expect(screen.getByRole("button", { name: "Try Kanbo again" })).toBeInTheDocument();
  });
  it("Me scope narrows Trends to your work and steps the person filter aside", () => {
    const tasks = [
      task({ projectId: "pa", assigneeId: "me", createdAt: day(-3) }),
      task({ projectId: "pb", assigneeId: "m-2", createdAt: day(-3) }),
    ];
    const members = [{ id: "me", name: "Daniel Okai" }, { id: "m-2", name: "Theo Vance" }];
    render(<ReportsView tasks={tasks} projects={[proj("pa", "Alpha"), proj("pb", "Beta")]} members={members} currentUserId="me" />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByLabelText("Assignee")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Scope" })).getByRole("button", { name: "Me" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
    expect(screen.queryByLabelText("Assignee")).toBeNull();
  });
});
