import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import type { Project, StatusUpdate, Task } from "../../data/types";
import { ProjectsView, directoryColumns } from "./ProjectsView";

const ago = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
const iso = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const proj = (id: string, name: string, o: Partial<Project> = {}): Project => ({ id, name, emoji: "", color: "oklch(0.74 0.14 230)", workspaceId: "ws", ...o });
const task = (id: string, projectId: string, o: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, description: "", status: "todo", priority: "medium", projectId, assigneeId: "m-2",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

const PROJECTS = [
  proj("p-launch", "Launch", { ownerId: "m-self" }),
  proj("p-brand", "Brand"),
  proj("p-infra", "Infra"),
];
const TASKS = [
  task("t1", "p-launch", { title: "Finalise the deck", status: "progress", dueDate: iso(0) }),
  task("t2", "p-launch", { status: "blocked", dependencies: ["t1"] }),
  task("t3", "p-launch", { title: "Launch day", isMilestone: true, dueDate: iso(8), dependencies: ["t2"] }),
  task("t4", "p-brand", { status: "done", completedAt: iso(-1) }),
  task("t5", "p-brand"),
  task("t6", "p-infra", { dueDate: iso(-3) }),
  task("t7", "p-infra"),
];
const UPDATES: StatusUpdate[] = [
  { id: "u1", projectId: "p-launch", status: "at_risk", summary: "Deck is the critical path", createdAt: ago(9) },
  { id: "u2", projectId: "p-brand", status: "on_track", summary: "Logo is with the client", createdAt: ago(2) },
];
const props = (o: Partial<React.ComponentProps<typeof ProjectsView>> = {}): React.ComponentProps<typeof ProjectsView> => ({
  projects: PROJECTS, tasks: TASKS, statusUpdates: UPDATES, members: [], currentUserId: "m-self",
  canCreate: true, onOpenProject: vi.fn(), onNewProject: vi.fn(), ...o,
});
const rowOf = (name: string) => screen.getByRole("link", { name: new RegExp(name) }).closest('[role="row"]') as HTMLElement;
const names = () => within(screen.getByRole("table", { name: "Projects" })).getAllByRole("link").map((a) => a.textContent);

beforeEach(() => localStorage.clear());

describe("ProjectsView (the directory)", () => {
  it("lists every project with its status, progress, milestone and how fresh its update is", () => {
    render(<ProjectsView {...props({ risksByProject: { "p-launch": 2 } })} />);
    const launch = rowOf("Launch");
    expect(within(launch).getByText("At risk")).toBeInTheDocument();
    expect(within(launch).getByText("9d")).toBeInTheDocument();
    expect(within(launch).getByText("Launch day")).toBeInTheDocument();
    expect(within(launch).getByText("2")).toBeInTheDocument();                         // risks
    expect(within(launch).getByText(/Critical path: the deck/)).toBeInTheDocument();    // Kanbo's read
    expect(within(launch).getByRole("progressbar", { name: "Launch progress" })).toHaveAttribute("aria-valuenow", "0");
    const brand = rowOf("Brand");
    expect(within(brand).getByText("On track")).toBeInTheDocument();
    expect(within(brand).getByText("2d")).toBeInTheDocument();
    // no update at all: flagged stale
    const infra = rowOf("Infra");
    expect(within(infra).getByText("No update")).toBeInTheDocument();
    expect(within(infra).getByText("none · stale")).toBeInTheDocument();
    expect(within(infra).getByText("1")).toHaveClass("kpj-signal");                    // overdue
  });

  it("flags an update 14 days old as stale", () => {
    render(<ProjectsView {...props({ statusUpdates: [{ ...UPDATES[1], createdAt: ago(16) }] })} />);
    expect(within(rowOf("Brand")).getByText("16d · stale")).toBeInTheDocument();
  });

  it("filters to the projects at risk, and to yours", () => {
    render(<ProjectsView {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "At risk" }));
    expect(names()).toEqual(["Launch", "Infra"]);                                       // an at-risk update; overdue work
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(names()).toEqual(["Launch"]);                                                // you own it
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter projects" }), { target: { value: "bra" } });
    expect(names()).toEqual(["Brand"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter projects" }), { target: { value: "zzz" } });
    expect(screen.getByText("No projects match")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all projects" }));
    expect(names()).toHaveLength(3);
  });

  it("sorts worst first by default, and by name, progress or last update", () => {
    render(<ProjectsView {...props()} />);
    expect(names()).toEqual(["Launch", "Infra", "Brand"]);
    const sortBy = (label: string) => {
      fireEvent.click(screen.getByRole("button", { name: /^Sort projects/ }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
    };
    sortBy("Name");
    expect(names()).toEqual(["Brand", "Infra", "Launch"]);
    sortBy("Progress");
    expect(names()[0]).toBe("Brand");
    sortBy("Last update");
    expect(names()).toEqual(["Brand", "Launch", "Infra"]);
    expect(localStorage.getItem("kanbo-projects-sort")).toBe("update");
  });

  it("opens a project from its row or its name", () => {
    const onOpenProject = vi.fn();
    render(<ProjectsView {...props({ onOpenProject })} />);
    fireEvent.click(screen.getByRole("link", { name: /Brand/ }));
    expect(onOpenProject).toHaveBeenLastCalledWith("p-brand");
    fireEvent.click(within(rowOf("Infra")).getByText("No update"));
    expect(onOpenProject).toHaveBeenLastCalledWith("p-infra");
    expect(screen.getByRole("link", { name: /Launch/ })).toHaveAttribute("href", "/p/p-launch");
  });

  it("drafts and posts an update from a row without opening the project", async () => {
    const onPostUpdate = vi.fn().mockResolvedValue(true);
    const onOpenProject = vi.fn();
    render(<ProjectsView {...props({ onPostUpdate, onOpenProject })} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft an update on Infra" }));
    const box = screen.getByRole("textbox", { name: "Update" }) as HTMLTextAreaElement;
    expect(box.value).toMatch(/^Nothing finished this week; 0% done overall\. Overdue: Task t6\./);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Post update" })); });
    expect(onPostUpdate).toHaveBeenCalledWith("p-infra", box.value, "off_track");   // half its work is overdue
    expect(onOpenProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Update" })).not.toBeInTheDocument());
  });

  it("has no update buttons for guests", () => {
    render(<ProjectsView {...props({ onPostUpdate: undefined })} />);
    expect(screen.queryByRole("button", { name: /Post an update on/ })).not.toBeInTheDocument();
  });

  it("shows an empty state with New project, and none for guests", () => {
    const onNewProject = vi.fn();
    const { unmount } = render(<ProjectsView {...props({ projects: [], onNewProject })} />);
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(onNewProject).toHaveBeenCalled();
    unmount();
    render(<ProjectsView {...props({ projects: [], canCreate: false })} />);
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
  });

  it("drops columns as the page narrows", () => {
    expect(directoryColumns(1200, true)).toEqual(["name", "status", "progress", "owner", "open", "overdue", "milestone", "update", "risks"]);
    expect(directoryColumns(900, false)).toEqual(["name", "status", "progress", "overdue", "milestone", "update"]);
    expect(directoryColumns(760, true)).toEqual(["name", "status", "progress", "overdue", "update", "risks"]);
  });
});
