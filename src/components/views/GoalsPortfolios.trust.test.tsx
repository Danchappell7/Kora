/* Goals and Portfolios: one progress rule (top-level tasks, as the project header
   counts them), a goal that keeps its archived project's progress, the goal's
   description, who posted each update, and a calm read-only page for guests. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { Task, Goal, Project, Portfolio, StatusUpdate } from "../../data/types";
import { GoalsView, PortfoliosView } from "./GoalsPortfolios";
import { setReferenceData, MEMBERS, PROJECTS } from "../../data/data";

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: `t${++n}`, title: "Task", description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const proj = (id: string, name: string, o: Partial<Project> = {}): Project => ({ id, name, emoji: "", color: "red", workspaceId: "ws", ...o });
// 2 of 4 top-level tasks done, plus 6 open sub-tasks: 50% (counting every task said 20%)
const tasksFor = (pid: string) => {
  const parent = task({ id: `${pid}-parent`, projectId: pid, status: "done" });
  return [parent, task({ projectId: pid, status: "done" }), task({ projectId: pid }), task({ projectId: pid }),
    ...Array.from({ length: 6 }, () => task({ projectId: pid, parentId: parent.id }))];
};
const meter = (name: string) => screen.getByRole("progressbar", { name: `${name} progress` });

describe("GoalsView — the numbers", () => {
  const base = { onCreate: () => {}, onDelete: () => {}, onUpdate: () => {} };
  it("a goal linked to a project reads the project header's % (top-level tasks)", () => {
    const p1 = proj("p1", "Launch");
    render(<GoalsView {...base} projects={[p1]} tasks={tasksFor("p1")} goals={[{ id: "g", name: "Ship it", status: "on_track", projectId: "p1" }]} />);
    expect(meter("Ship it")).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("From project Launch")).toBeInTheDocument();
  });

  it("a goal linked to an archived project keeps that project's progress instead of dropping to 0%", () => {
    const done = proj("p-old", "Old launch", { archivedAt: "2026-10-01T09:00:00Z" });
    const prev = [...PROJECTS];
    setReferenceData({ projects: [...prev, done] });
    try {
      const finished = [task({ projectId: "p-old", status: "done" }), task({ projectId: "p-old", status: "done" })];
      // the archived project isn't in the workspace's project list; its tasks still come (App's goalTasks)
      render(<GoalsView {...base} projects={[proj("p1", "Launch")]} tasks={finished} goals={[{ id: "g", name: "Old goal", status: "done", projectId: "p-old" }]} />);
      expect(meter("Old goal")).toHaveAttribute("aria-valuenow", "100");
      expect(screen.getByText("From project Old launch (archived)")).toBeInTheDocument();
    } finally {
      setReferenceData({ projects: prev });
    }
  });

  it("shows the description and saves an edit to it once", () => {
    const onUpdate = vi.fn();
    render(<GoalsView {...base} onUpdate={onUpdate} projects={[]} tasks={[]} goals={[{ id: "g", name: "Grow", status: "on_track", description: "Weekly actives across web and mobile." }]} />);
    const box = screen.getByLabelText("Description of Grow") as HTMLInputElement;
    expect(box.value).toBe("Weekly actives across web and mobile.");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "Weekly actives, web only." } });
    fireEvent.blur(box);
    expect(onUpdate).toHaveBeenCalledWith("g", { description: "Weekly actives, web only." });
  });
});

describe("GoalsView — a guest", () => {
  const base = { onCreate: vi.fn(), onDelete: vi.fn(), onUpdate: vi.fn(), projects: [proj("p1", "Launch")], readOnly: true };
  it("reads the goals with no fields, pickers or buttons", () => {
    const goals: Goal[] = [
      { id: "g", name: "Reach 5,000 actives", status: "at_risk", description: "Across web and mobile.", target: 5000, current: 3900, unit: "users", due: "2026-12-31" },
      { id: "s", name: "Ship it", status: "on_track", projectId: "p1", parentId: "g" },
    ];
    const { container } = render(<GoalsView {...base} goals={goals} tasks={tasksFor("p1")} />);
    expect(screen.getByRole("heading", { name: "Reach 5,000 actives" })).toBeInTheDocument();
    expect(screen.getByText("Across web and mobile.")).toBeInTheDocument();
    expect(screen.getByText("At risk")).toBeInTheDocument();
    expect(screen.getByText("3900 / 5000 users")).toBeInTheDocument();
    expect(meter("Ship it")).toHaveAttribute("aria-valuenow", "50");
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /New goal|Delete goal/ })).toBeNull();
    expect(screen.queryByLabelText(/Status of/)).toBeNull();
  });
  it("with nothing to read, says who goals are for instead of offering to make one", () => {
    render(<GoalsView {...base} goals={[]} tasks={[]} />);
    expect(screen.getByText("Goals are for members")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New goal" })).toBeNull();
  });
});

describe("PortfoliosView — the numbers and who said it", () => {
  const p1 = proj("p1", "Launch"), p2 = proj("p2", "Brand");
  const pf: Portfolio = { id: "pf", name: "Q3", projectIds: ["p1", "p2"] };
  const tasks = [...tasksFor("p1"), task({ projectId: "p2", status: "done" }), task({ projectId: "p2" })];
  const base = { portfolios: [pf], projects: [p1, p2], tasks, onCreate: () => {}, onUpdate: () => {}, onDelete: () => {}, onOpenProject: () => {} };

  it("cards, the combined % and the table all count top-level tasks", () => {
    localStorage.setItem("kanbo-portfolio-view", "cards");
    render(<PortfoliosView {...base} />);
    const card = screen.getByRole("article", { name: "Portfolio Q3" });
    expect(within(card).getByRole("progressbar", { name: "Launch progress" })).toHaveAttribute("aria-valuenow", "50");
    expect(within(card).getByText("4 tasks")).toBeInTheDocument();
    // 3 of the 6 top-level tasks across both projects (not 3 of 12)
    expect(within(card).getByText("50% · 2 projects")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table", { name: "Q3 projects" });
    expect(within(table).getByRole("progressbar", { name: "Launch progress" })).toHaveAttribute("aria-valuenow", "50");
  });

  it("names who posted the latest update, and a former member as such", () => {
    localStorage.setItem("kanbo-portfolio-view", "cards");
    const maya = MEMBERS.find((m) => m.id === "m-1")!;
    const updates: StatusUpdate[] = [
      { id: "u1", projectId: "p1", status: "at_risk", summary: "Deck is late", createdAt: "2026-11-08T10:00:00Z", authorId: maya.id },
      { id: "u2", projectId: "p2", status: "on_track", summary: "Palette shipped", createdAt: "2026-11-08T11:00:00Z", authorId: null },
    ];
    render(<PortfoliosView {...base} statusUpdates={updates} />);
    expect(screen.getByText("Update: At risk").closest("[title]")?.getAttribute("title")).toContain(`, ${maya.name}): Deck is late`);
    expect(screen.getByText("Update: On track").closest("[title]")?.getAttribute("title")).toContain(", Former member): Palette shipped");
  });

  it("a guest reads it: no rename, add, remove or delete", () => {
    localStorage.setItem("kanbo-portfolio-view", "cards");
    const { container } = render(<PortfoliosView {...base} readOnly />);
    expect(screen.getByRole("heading", { name: "Q3" })).toBeInTheDocument();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /New portfolio|Add a project|Delete portfolio|Remove Launch/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Open project Launch" })).toBeInTheDocument();
  });
  it("a guest with nothing to read is told who portfolios are for", () => {
    render(<PortfoliosView {...base} portfolios={[]} readOnly />);
    expect(screen.getByText("Portfolios are for members")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New portfolio" })).toBeNull();
  });
});
