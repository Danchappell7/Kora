import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import type { Task, Project } from "../../data/types";
import type { AiOutcome } from "../../lib/askTypes";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import { GroupedBars } from "../charts";
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
/** the page's text, without its stylesheet */
const pageText = () => {
  const page = document.body.cloneNode(true) as HTMLElement;
  page.querySelectorAll("style").forEach((el) => el.remove());
  return page.textContent ?? "";
};
/** how many times a figure is shown on the page, as a whole number (not part of "113" or "13.5") */
const timesShown = (fig: string) => pageText().match(new RegExp(`(?<![\\d.])${fig}(?![\\d.])`, "g"))?.length ?? 0;
/** a promise the test settles by hand */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

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
  it("states every KPI figure once on the page: the status legend gives shares, not counts", () => {
    const tasks = [
      // 13 finished in the past week (12 on time), 4 more a while ago
      ...Array.from({ length: 13 }, (_, i) => task({ status: "done", dueDate: day(i === 0 ? -6 : 0), completedAt: day(-1 - (i % 3)) })),
      ...Array.from({ length: 4 }, () => task({ status: "done", completedAt: day(-20) })),
      ...Array.from({ length: 11 }, () => task({ status: "todo", dueDate: day(-2) })), // overdue
      ...Array.from({ length: 9 }, () => task({ status: "blocked" })),
    ];
    render(<AnalyticsView tasks={tasks} />);
    expect(kpiText()).toBe("In the past week the team finished 13 tasks — 92% on time. 11 are overdue and 9 are blocked.");
    for (const fig of ["13", "92%", "11", "9"]) expect(timesShown(fig)).toBe(1);
    // the bar still names every count and share for screen readers
    expect(screen.getByRole("img", { name: /^37 tasks by status: To do 11 \(30%\), Blocked 9 \(24%\), Done 17 \(46%\)$/ })).toBeInTheDocument();
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
  it("speaks for the team when it can't tell who \"me\" is, whatever the scope says", () => {
    const tasks = [task({ status: "done", assigneeId: "m-2", completedAt: day(0) }), task({ status: "done", assigneeId: "m-3", completedAt: day(0) })];
    render(<AnalyticsView tasks={tasks} scope="me" onScopeChange={vi.fn()} />);
    expect(kpiText()).toContain("the team finished 2 tasks");
    expect(screen.queryByRole("group", { name: "Scope" })).toBeNull();
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

describe("charts", () => {
  it("keeps the Done gradient sized to the plot when a week goes from 0 to 1", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bars = (done: number) => (
      <GroupedBars groups={["1 Sep", "8 Sep"]} h={168}
        series={[{ label: "Created", color: "var(--ink-3)", values: [1, 1] }, { label: "Completed", color: "var(--accent)", values: [1, done], grad: true }]} />
    );
    const { container, rerender } = render(bars(0));
    rerender(bars(1));
    const done = container.querySelectorAll<HTMLElement>("[role=img] > div:last-child > div")[1].children[1] as HTMLElement;
    expect(done.style.backgroundImage).toContain("linear-gradient");
    expect(done.style.backgroundSize).toBe("100% 168px");
    expect(done.style.backgroundPosition).toBe("bottom");
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/conflicting property|Updating a style property/);
    error.mockRestore();
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
    expect(await screen.findByText(/Kanbo couldn't write it just now/, { selector: ".kin-foot" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing finished/)).toBeInTheDocument();
    expect(document.querySelector(".kvellum")).toBeNull();
    expect(screen.getByRole("button", { name: "Try Kanbo again" })).toBeInTheDocument();
  });
  it("keeps keyboard focus when writing the summary, and moves it to the summary once written", () => {
    render(<ReportsView tasks={[task({ status: "done", createdAt: day(-3), completedAt: day(-1) })]} projects={[proj("p-launch", "Launch")]} />);
    const btn = screen.getByRole("button", { name: "Write this week's summary" });
    btn.focus();
    fireEvent.click(btn);
    expect(document.activeElement).toBe(document.querySelector(".kin-summary-body"));
    expect(document.activeElement).not.toBe(document.body);
  });
  it("keeps Kanbo's buttons mounted and busy while it writes, and announces each step in one status region", async () => {
    const first = deferred<AiOutcome<string>>(), second = deferred<AiOutcome<string>>();
    const aiSummary = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<ReportsView tasks={[task({ createdAt: day(-2) })]} projects={[]} aiSummary={aiSummary} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(""); // there from the start, so what lands in it is announced
    const write = screen.getByRole("button", { name: "Write this week's summary" });
    write.focus();
    fireEvent.click(write);
    expect(document.activeElement).toBe(write);
    expect(write).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Kanbo is writing up the team's week…");
    await act(async () => { first.resolve({ data: null, source: "unavailable" }); });
    expect(document.activeElement).toBe(document.querySelector(".kin-summary-body"));
    expect(status).toHaveTextContent(/Kanbo couldn't write it just now/);
    const again = screen.getByRole("button", { name: "Try Kanbo again" });
    again.focus();
    fireEvent.click(again);
    expect(again).toHaveAttribute("aria-busy", "true");
    expect(document.activeElement).toBe(again);
    await act(async () => { second.resolve({ data: "- **Shipped** the deck", source: "ai" }); });
    // the same button, now offering a rewrite; focus never left it
    expect(again).toHaveAccessibleName("Rewrite");
    expect(document.activeElement).toBe(again);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Kanbo wrote this week's summary.");
    expect(document.querySelectorAll(".kin-summary")).toHaveLength(1);
  });
  it("tells Kanbo only about this week's work, and says exactly what it read", async () => {
    const old = Array.from({ length: 300 }, () => task({ status: "done", createdAt: day(-200), completedAt: day(-150) }));
    const open = task({ title: "Brief the press", createdAt: day(-2) });
    const aiSummary = vi.fn().mockResolvedValue({ data: "- **Shipped**", source: "ai" });
    const write = vi.fn();
    const popup = { document: { write, close: vi.fn() }, focus: vi.fn(), print: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    render(<ReportsView tasks={[...old, open]} projects={[]} aiSummary={aiSummary} />);
    fireEvent.click(screen.getByRole("button", { name: "Write this week's summary" }));
    const prov = await screen.findByRole("button", { name: /How I got here/ });
    expect(aiSummary).toHaveBeenCalledWith([open]);
    expect(prov).toHaveTextContent(/from 1 task,/);
    fireEvent.click(prov);
    expect(screen.getByText("1 open: 0 overdue, 0 blocked, 0 under way")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export as PDF" }));
    expect(String(write.mock.calls[0][0])).toContain("Written by Kanbo from 1 task ·");
    openSpy.mockRestore();
  });
  it("leads Throughput with this week when the full weeks were empty", () => {
    render(<ReportsView tasks={[task({ status: "done", completedAt: day(0) }), task({ status: "done", completedAt: day(0) })]} projects={[]} />);
    const card = screen.getByRole("heading", { name: /Throughput/ }).closest("section")!;
    expect(card.querySelector(".kin-lead")!.textContent!.replace(/\u00a0/g, " "))
      .toBe("2 completed so far this week; nothing in the 8 full weeks before.");
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
