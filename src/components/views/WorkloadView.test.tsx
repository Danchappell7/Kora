import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { Task } from "../../data/types";
import { KANBO_TODAY, refreshClock, toLocalISO } from "../../data/data";
import { WorkloadView, focusWorkloadMember, readCapacities } from "./WorkloadView";
import { addDays, startOfWeekMon } from "./reportingUtils";

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "rt" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-1",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...o,
});
const day = (offset: number) => toLocalISO(addDays(KANBO_TODAY, offset));

const realToday = new Date(KANBO_TODAY);
afterEach(() => { refreshClock(new Date(realToday.getFullYear(), realToday.getMonth(), realToday.getDate(), 12)); });

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
  it("compares hours as shown, so 40.03h reads 40h / 40h and isn't flagged over capacity", () => {
    const wk = startOfWeekMon(KANBO_TODAY);
    render(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }]} onOpen={() => {}} tasks={[
      task({ assigneeId: "m-1", dueDate: toLocalISO(addDays(wk, 6)), effortHours: 40 }),
      // Mon this week → Fri in 4 weeks = 25 working days; this week's share is 0.03h
      task({ assigneeId: "m-1", startDate: toLocalISO(wk), dueDate: toLocalISO(addDays(wk, 32)), effortHours: 0.15 }),
    ]} />);
    expect(screen.getByText(/40h \/ 40h · 2 tasks/)).toBeInTheDocument();
    expect(screen.queryByText(/Over capacity/)).toBeNull();
    expect(screen.queryByText(/overloaded/)).toBeNull();
  });
  it("reverts a rejected capacity (blank or 0) to the capacity in use, and saves a valid one", () => {
    try { localStorage.removeItem("kanbo-capacity"); } catch { /* no storage */ }
    render(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }]} onOpen={() => {}} tasks={[task({ assigneeId: "m-1", dueDate: day(0), effortHours: 4 })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    const cap = screen.getByLabelText("Weekly capacity for Maya Lin, in hours") as HTMLInputElement;
    for (const bad of ["", "0", "-5", "500"]) {
      fireEvent.focus(cap);
      fireEvent.change(cap, { target: { value: bad } });
      fireEvent.blur(cap);
      expect(cap.value).toBe("40");
      expect(screen.getByText(/4h \/ 40h · 1 task/)).toBeInTheDocument();
    }
    fireEvent.focus(cap);
    fireEvent.change(cap, { target: { value: "32" } });
    fireEvent.blur(cap);
    expect(cap.value).toBe("32");
    expect(screen.getByText(/4h \/ 32h · 1 task/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kanbo-capacity") || "{}")).toEqual({ "m-1": 32 });
    localStorage.removeItem("kanbo-capacity");
  });
  it("without estimates, counts an hour a task — and says how to see real load", () => {
    const wk = startOfWeekMon(KANBO_TODAY);
    render(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }]} onOpen={() => {}} tasks={[
      task({ assigneeId: "m-1", dueDate: toLocalISO(addDays(wk, 6)) }),
      task({ assigneeId: "m-1", dueDate: toLocalISO(addDays(wk, 6)) }),
    ]} />);
    expect(screen.getByText(/2h \/ 40h · 2 tasks/)).toBeInTheDocument();
    expect(screen.getByText("Add estimates (~2h) to tasks to see real load — until then Kanbo counts 1h per task.")).toBeInTheDocument();
  });
  it("shows four weeks side by side, and lists the picked week's work", () => {
    const wk = startOfWeekMon(KANBO_TODAY);
    render(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }]} onOpen={() => {}} tasks={[
      task({ title: "Next week's job", assigneeId: "m-1", dueDate: toLocalISO(addDays(wk, 9)), effortHours: 5 }),
    ]} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/^This week/), expect.stringMatching(/^Next week/), expect.stringMatching(/^In 2 weeks/), expect.stringMatching(/^In 3 weeks/)]));
    expect(screen.getByText(/5h \/ 40h · 1 task/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    expect(screen.queryByRole("button", { name: "Open task Next week's job" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Next week/ }));
    expect(screen.getByRole("button", { name: /^Next week/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open task Next week's job" })).toBeInTheDocument();
  });
  it("opens the person Radar's Rebalance pointed at, with keyboard focus on their row", () => {
    focusWorkloadMember("m-1");
    render(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }, { id: "m-2", name: "Theo Vance" }]} onOpen={() => {}} tasks={[]} />);
    const maya = screen.getByRole("button", { name: /Maya Lin/ });
    expect(maya).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(maya);
    expect(screen.getByRole("button", { name: /Theo Vance/ })).toHaveAttribute("aria-expanded", "false");
    expect(readCapacities()).toEqual({});
  });

  it("keeps every control of an open row inside a table cell (the detail is a full-width row of its own)", () => {
    render(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }]} onOpen={() => {}} tasks={[task({ title: "Edge sessions", assigneeId: "m-1", dueDate: day(0), effortHours: 3 })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    const table = screen.getByRole("table");
    for (const el of within(table).getAllByRole("button").concat(within(table).getAllByRole("spinbutton"))) {
      expect(el.closest('[role="cell"], [role="rowheader"], [role="columnheader"]'), el.textContent ?? el.getAttribute("aria-label") ?? "").not.toBeNull();
    }
    const cell = screen.getByRole("button", { name: "Open task Edge sessions" }).closest('[role="cell"]')!;
    expect(cell).toHaveAttribute("aria-colspan", "5");
    expect(cell.closest('[role="row"]')?.closest('[role="table"]')).toBe(table);
  });

  it("guests show their work but carry no capacity, and are never the one suggested to take more on", () => {
    const wk = startOfWeekMon(KANBO_TODAY);
    const due = toLocalISO(addDays(wk, 4));
    render(<WorkloadView onOpen={() => {}}
      members={[{ id: "m-1", name: "Maya Lin" }, { id: "m-4", name: "Idris Bell", guest: true }]}
      tasks={[task({ assigneeId: "m-1", dueDate: due, effortHours: 48 }), task({ assigneeId: "m-4", dueDate: due, effortHours: 2 })]} />);
    expect(screen.getByText(/1 person looks overloaded/)).toBeInTheDocument();
    expect(screen.queryByText(/who has room/)).toBeNull();
    const idris = screen.getByRole("row", { name: /Idris Bell/ });
    expect(idris).toHaveTextContent("Guest");
    expect(idris).toHaveTextContent("2h · 1 task");
    expect(idris).not.toHaveTextContent("/ 40h");
    fireEvent.click(within(idris).getByRole("button", { name: /Idris Bell/ }));
    expect(screen.queryByLabelText("Weekly capacity for Idris Bell, in hours")).toBeNull();
    // the load reads as words to a screen reader, not as a percentage of 125% of capacity
    expect(screen.getByRole("row", { name: /Maya Lin/ })).toHaveTextContent(/48h \/ 40h · 1 task, over capacity/);
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
  });

  it("with nothing dated in view, says what makes Workload work instead of a silent grid of zeros", () => {
    render(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }]} onOpen={() => {}} tasks={[task({ assigneeId: "m-1" }), task({ assigneeId: "m-1" })]} />);
    expect(screen.getByText(/No dated work in the next four weeks\./)).toBeInTheDocument();
    expect(screen.getByText(/Give tasks a due date \(and an estimate like ~2h\) and Workload shows who has room\. 2 open tasks have no dates yet\./)).toBeInTheDocument();
    expect(screen.queryByText(/Add estimates/)).toBeNull();
  });

  it("moves with the live clock: after midnight, yesterday's work reads overdue", () => {
    const start = new Date(KANBO_TODAY);
    const tasks = [task({ title: "Due today job", assigneeId: "m-1", dueDate: toLocalISO(start), effortHours: 3 })];
    const { rerender } = render(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }]} onOpen={() => {}} tasks={tasks} />);
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    expect(screen.getByRole("button", { name: "Open task Due today job" })).toHaveTextContent(/^Due today jobDue /);
    refreshClock(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 9));
    rerender(<WorkloadView members={[{ id: "m-1", name: "Maya Lin" }]} onOpen={() => {}} tasks={tasks} />);
    // (pick "This week" in case midnight also started a new week)
    fireEvent.click(screen.getAllByRole("button", { name: /^This week/ })[0]);
    expect(screen.getByRole("button", { name: "Open task Due today job" })).toHaveTextContent(/Overdue · /);
  });
  it("in Personal, explains that Workload is for teams", () => {
    render(<WorkloadView members={[{ id: "m-self", name: "Daniel Okai" }]} onOpen={() => {}} tasks={[]} personal />);
    expect(screen.getByText("Workload is for teams")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
