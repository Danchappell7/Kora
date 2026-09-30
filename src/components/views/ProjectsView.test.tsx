import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import type { Project, StatusUpdate, Task } from "../../data/types";
import { PERSONAL_PROJECT, refreshClock } from "../../data/data";
import { ProjectsView, directoryColumns } from "./ProjectsView";
import { ProjectActions } from "../project/ProjectHeader";
import { clearStatusDrafts } from "../project/StatusComposer";

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

beforeEach(() => { localStorage.clear(); clearStatusDrafts(); });

describe("ProjectsView (the gallery, the default)", () => {
  const cards = () => within(screen.getByRole("list", { name: "Projects" })).getAllByRole("listitem");
  const cardOf = (name: string) => screen.getByRole("link", { name }).closest("li") as HTMLElement;

  it("opens on the gallery: one card per project in its identity (cover, tile, status, progress, work, freshness, people)", () => {
    render(<ProjectsView {...props()} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(cards()).toHaveLength(3);
    const launch = cardOf("Launch");
    expect(launch).toHaveClass("kp");
    expect(launch.querySelector(".kpcover")).not.toBeNull();
    expect(launch.querySelector(".kptile[data-size='44']")).not.toBeNull();
    expect(within(launch).getByText("At risk")).toBeInTheDocument();
    expect(within(launch).getByRole("progressbar", { name: "Launch progress" })).toHaveAttribute("aria-valuenow", "0");
    expect(within(launch).getByRole("img", { name: /^People: \S/ })).toBeInTheDocument();                   // the owner
    expect(within(launch).getByText(/Critical path: the deck/)).toBeInTheDocument();                         // Kanbo's read
    expect(cardOf("Infra")).toHaveTextContent("2 open · 1 overdue · No update yet");
  });

  it("warns as an update ages: amber after a week, red after two", () => {
    render(<ProjectsView {...props({ statusUpdates: [{ ...UPDATES[0], createdAt: ago(9) }, { ...UPDATES[1], createdAt: ago(16) }] })} />);
    expect(within(cardOf("Launch")).getByText("Updated 9d ago")).toHaveClass("kpj-warn");
    expect(within(cardOf("Brand")).getByText("Updated 16d ago")).toHaveClass("kpj-signal");
  });

  it("keeps Table as the other view, and remembers the choice", () => {
    render(<ProjectsView {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table", { name: "Projects" })).toBeInTheDocument();
    expect(localStorage.getItem("kanbo-projects-view")).toBe("table");
    // the table's name cell carries the 20px tile (no emoji beside the name)
    expect(rowOf("Launch").querySelector(".kptile[data-size='20']")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Gallery" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("drafts and posts an update from a card without opening the project", async () => {
    const onPostUpdate = vi.fn().mockResolvedValue(true);
    const onOpenProject = vi.fn();
    render(<ProjectsView {...props({ onPostUpdate, onOpenProject })} />);
    fireEvent.click(within(cardOf("Infra")).getByRole("button", { name: "Draft update for Infra" }));
    expect((screen.getByRole("textbox", { name: "Update" }) as HTMLTextAreaElement).value).toMatch(/^Nothing finished this week/);
    expect(onOpenProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Brand" }));
    expect(onOpenProject).toHaveBeenCalledWith("p-brand");
  });
});

describe("ProjectsView (the directory as a table)", () => {
  beforeEach(() => { localStorage.setItem("kanbo-projects-view", "table"); });

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

  it("leaves out the built-in Personal project", () => {
    render(<ProjectsView {...props({ projects: [PERSONAL_PROJECT, ...PROJECTS] })} />);
    expect(names()).toEqual(["Launch", "Infra", "Brand"]);
    expect(screen.getByText("3 projects")).toBeInTheDocument();
  });

  it("flags an update 14 days old as stale", () => {
    render(<ProjectsView {...props({ statusUpdates: [{ ...UPDATES[1], createdAt: ago(16) }] })} />);
    expect(within(rowOf("Brand")).getByText("16d · stale")).toBeInTheDocument();
  });

  it("moves update ages on when the day rolls over in a tab left open", () => {
    const p = props({ statusUpdates: [{ ...UPDATES[1], createdAt: ago(10) }] });
    const { rerender } = render(<ProjectsView {...p} />);
    expect(within(rowOf("Brand")).getByText("10d")).toBeInTheDocument();
    try {
      refreshClock(new Date(Date.now() + 5 * 86400000));
      rerender(<ProjectsView {...p} />);                                              // same props: only the day moved
      expect(within(rowOf("Brand")).getByText("15d · stale")).toBeInTheDocument();
    } finally { refreshClock(new Date()); }
  });

  it("counts Open over the same work as Overdue (sub-tasks included), so a row never shows more overdue than open", () => {
    const tasks = [...TASKS, task("t8", "p-infra", { parentId: "t7", dueDate: iso(-2) }), task("t9", "p-infra", { parentId: "t7", dueDate: iso(-1) })];
    render(<ProjectsView {...props({ tasks })} />);
    const cells = within(rowOf("Infra")).getAllByRole("cell");
    expect(cells[4]).toHaveTextContent(/^4$/);                                        // open
    expect(cells[5]).toHaveTextContent(/^3$/);                                        // overdue
    expect(screen.getByRole("columnheader", { name: "Open" })).toHaveAttribute("title", "Open tasks, sub-tasks included");
  });

  it("names each owner for screen readers, and says what an empty cell means", () => {
    render(<ProjectsView {...props()} />);
    expect(within(rowOf("Launch")).getByRole("img", { name: /^Owner: \S/ })).toBeInTheDocument();
    const brand = rowOf("Brand");
    expect(within(brand).getByText("No owner")).toHaveClass("sr-only");
    expect(within(brand).getByText("No milestone")).toHaveClass("sr-only");
  });

  it("gives touch screens the gallery, each card with its own Draft and Post update (there's no hover to reveal a row's)", () => {
    const mm = vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({
      matches: q === "(hover: none)", media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);
    try {
      const onPostUpdate = vi.fn();
      const onOpenProject = vi.fn();
      render(<ProjectsView {...props({ onPostUpdate, onOpenProject })} />);
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Table" })).not.toBeInTheDocument();            // no table to switch to
      const list = screen.getByRole("list", { name: "Projects" });
      const infra = within(list).getByRole("link", { name: "Infra" }).closest("li") as HTMLElement;
      expect(infra).toHaveTextContent("2 open · 1 overdue · No update yet");
      fireEvent.click(within(infra).getByRole("button", { name: "Post update for Infra" }));
      expect(screen.getByRole("textbox", { name: "Update" })).toHaveValue("");
      expect(onOpenProject).not.toHaveBeenCalled();
      fireEvent.click(within(list).getByRole("link", { name: "Brand" }));
      expect(onOpenProject).toHaveBeenCalledWith("p-brand");
    } finally { mm.mockRestore(); }
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
    fireEvent.click(screen.getByRole("button", { name: "Draft update for Infra" }));
    const box = screen.getByRole("textbox", { name: "Update" }) as HTMLTextAreaElement;
    expect(box.value).toMatch(/^Nothing finished this week; 0% done overall\. Overdue: Task t6\./);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Post update" })); });
    expect(onPostUpdate).toHaveBeenCalledWith("p-infra", box.value, "off_track");   // half its work is overdue
    expect(onOpenProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Update" })).not.toBeInTheDocument());
  });

  it("Post update opens an empty field; a row's draft is the project header's draft", () => {
    const onPostUpdate = vi.fn();
    render(<ProjectsView {...props({ onPostUpdate })} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft update for Infra" }));
    expect((screen.getByRole("textbox", { name: "Update" }) as HTMLTextAreaElement).value).toMatch(/^Nothing finished/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Post update for Infra" }));
    const box = screen.getByRole("textbox", { name: "Update" });
    expect(box).toHaveValue("");
    fireEvent.change(box, { target: { value: "Moving the servers on Friday" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const header = render(<ProjectActions project={PROJECTS[2]} tasks={TASKS} statusUpdates={UPDATES} canManage readOnly={false} onTab={() => {}} onPostStatus={onPostUpdate} />);
    fireEvent.click(within(header.container).getByRole("button", { name: "Post update" }));
    expect(screen.getByRole("textbox", { name: "Update" })).toHaveValue("Moving the servers on Friday");
  });

  it("has no update buttons for guests", () => {
    render(<ProjectsView {...props({ onPostUpdate: undefined })} />);
    expect(screen.queryByRole("button", { name: /Post update for/ })).not.toBeInTheDocument();
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

  it("shows the empty state to a new account, whose only project is the built-in Personal one", () => {
    render(<ProjectsView {...props({ projects: [PERSONAL_PROJECT], tasks: [task("t1", "p-personal")] })} />);
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("drops columns as the page narrows", () => {
    expect(directoryColumns(1200, true)).toEqual(["name", "status", "progress", "owner", "open", "overdue", "milestone", "update", "risks"]);
    expect(directoryColumns(900, false)).toEqual(["name", "status", "progress", "overdue", "milestone", "update"]);
    expect(directoryColumns(760, true)).toEqual(["name", "status", "progress", "overdue", "update", "risks"]);
  });
});
