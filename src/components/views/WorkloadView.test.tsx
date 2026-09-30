import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Task } from "../../data/types";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import { WorkloadView } from "./WorkloadView";
import { addDays, startOfWeekMon } from "./reportingUtils";

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "rt" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-1",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...o,
});
const day = (offset: number) => toLocalISO(addDays(KANBO_TODAY, offset));

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
});
