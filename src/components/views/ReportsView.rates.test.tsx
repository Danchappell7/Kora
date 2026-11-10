import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project, Task } from "../../data/types";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import { addDays } from "./reportingUtils";
import { EMPTY_AVAILABILITY, getAvailability, resetAvailability, updateAvailability } from "../../lib/availability";
import { resetDemoAvailability } from "../../lib/availabilitySync";
import { ReportsView } from "./ReportsView";

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "rr" + (++n), title: "Task " + n, description: "", status: "done", priority: "medium", projectId: "pa", assigneeId: "m-1", workspaceId: "ws",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0,
  createdAt: toLocalISO(addDays(KANBO_TODAY, -10)), completedAt: toLocalISO(addDays(KANBO_TODAY, -3)), ...o,
});
const projects: Project[] = [{ id: "pa", name: "Alpha", emoji: "", color: "red", workspaceId: "ws" }, { id: "pb", name: "Beta", emoji: "", color: "blue", workspaceId: "ws" }];
const tasks = [task({ projectId: "pa", loggedHours: 10 }), task({ projectId: "pb", loggedHours: 4 })];
const shared = (role: "owner" | "member") => updateAvailability({
  ...EMPTY_AVAILABILITY, status: "on", me: "me", activeWs: "ws", roles: { ws: { me: role } },
  rates: role === "owner" ? [{ workspaceId: "ws", projectId: null, rate: 80 }, { workspaceId: "ws", projectId: "pb", rate: 100 }] : [],
});
/** the page's words (no stylesheet; a figure's space is non-breaking) */
const lead = () => { const page = document.body.cloneNode(true) as HTMLElement; page.querySelectorAll("style").forEach((el) => el.remove()); return (page.textContent ?? "").replace(/\u00a0/g, " "); };

beforeEach(() => { localStorage.clear(); resetDemoAvailability(); });
afterEach(() => { act(() => resetAvailability()); });

describe("Time & billing's rates (0055)", () => {
  it("before 0055 (or in Personal) the rate is this device's, as it was", () => {
    localStorage.setItem("kanbo-bill-rate", "50");
    render(<ReportsView tasks={tasks} projects={projects} />);
    expect((screen.getByLabelText("Hourly rate") as HTMLInputElement).value).toBe("50");
    expect(lead()).toContain("At £50 an hour, that's £700.00.");
  });
  it("owners and admins see each project at its own rate, else the default, and set them for the team", async () => {
    shared("owner");
    render(<ReportsView tasks={tasks} projects={projects} />);
    expect(screen.queryByLabelText("Hourly rate")).toBeNull();
    expect((screen.getByLabelText("Default hourly rate, in pounds") as HTMLInputElement).value).toBe("80");
    // Alpha 10h at the £80 default, Beta 4h at its own £100
    expect(lead()).toContain("At each project's rate, that's £1,200.00.");
    expect(screen.getByText("£800.00")).toBeInTheDocument();
    expect(screen.getByText("£400.00")).toBeInTheDocument();
    // (the most hours first: Alpha's row; it shows Beta's own rate, and Alpha's the default as its hint)
    const [alpha, beta] = screen.getAllByLabelText(/^Hourly rate for .*, in pounds \(blank: the default rate\)$/) as HTMLInputElement[];
    expect([alpha.value, alpha.placeholder, beta.value]).toEqual(["", "80", "100"]);
    fireEvent.change(alpha, { target: { value: "90" } });
    fireEvent.blur(alpha);
    await waitFor(() => expect(getAvailability().rates).toContainEqual({ workspaceId: "ws", projectId: "pa", rate: 90 }));
    expect(localStorage.getItem("kanbo-bill-rate")).toBeNull();
  });
  it("members see the hours, never a rate or an amount", () => {
    localStorage.setItem("kanbo-bill-rate", "50");
    shared("member");
    render(<ReportsView tasks={tasks} projects={projects} />);
    expect(screen.queryByLabelText("Hourly rate")).toBeNull();
    expect(screen.queryByLabelText(/Default hourly rate/)).toBeNull();
    expect(screen.queryByText(/£/)).toBeNull();
    expect(screen.getByText("Rates are set by your workspace's owners and admins, so amounts aren't shown here.")).toBeInTheDocument();
  });
});
