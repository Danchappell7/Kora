/* The planner end to end in demo mode (the on-device planner): describe →
   review (edit, remove + Undo, move, milestones, warnings) → create through
   the host's deps, with failure, rollback messaging, discard and guests. */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectPlanner, type ProjectPlannerProps } from "./ProjectPlanner";
import { MEMBERS, PROJECTS, TASKS } from "../../data/data";
import type { AppliedProjectPlan, PlanApplyDeps, Section, Task } from "../../data/types";
import { PLANNER_EXAMPLES } from "../../lib/projectPlanner";

function deps(over: Partial<PlanApplyDeps> = {}): PlanApplyDeps {
  return {
    createProject: vi.fn(async (i) => ({ id: "p-new", ...i })),
    createSection: vi.fn(async (i) => ({ id: `sec-${i.name}`, ...i })),
    createTasks: vi.fn(async (ts: Task[]) => ts),
    addDependency: vi.fn(async () => {}),
    deleteProject: vi.fn(async () => {}),
    deleteTasks: vi.fn(async () => {}),
    deleteSection: vi.fn(async () => {}),
    ...over,
  };
}
function setup(over: Partial<ProjectPlannerProps> = {}) {
  const props: ProjectPlannerProps = {
    open: true, mode: "new", workspaceId: "ws-foundrise", workspaceName: "Foundrise", members: MEMBERS, guestIds: ["m-4"], tasks: TASKS,
    currentUserId: "m-self", aiEnabled: false, deps: deps(), onClose: vi.fn(), onCreated: vi.fn(), ...over,
  };
  const r = render(<ProjectPlanner {...props} />);
  return { ...r, props };
}
const dialog = () => screen.getByRole("dialog");
const draftIt = async () => {
  fireEvent.click(screen.getByRole("button", { name: /Draft the plan/ }));
  await screen.findByText(/Drafted on this device/);
};
const footer = () => dialog().querySelector(".ksheet-foot") as HTMLElement;

describe("ProjectPlanner — describe", () => {
  it("offers four examples, the people (guests off), and says plans are drafted on the device", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Plan a project with Kanbo" })).toBeInTheDocument();
    const examples = within(screen.getByRole("group", { name: "Examples to start from" })).getAllByRole("button");
    expect(examples.map((b) => b.textContent)).toEqual([...PLANNER_EXAMPLES]);
    const people = within(screen.getByRole("group", { name: /Who's working on it/ })).getAllByRole("button");
    expect(people.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "true", "true", "true", "false"]);
    expect(screen.getByText(/In the demo, plans are drafted on this device/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Draft the plan/ })).toBeDisabled();
    fireEvent.click(examples[2]);
    expect(screen.getByLabelText("What's the goal?")).toHaveValue(PLANNER_EXAMPLES[2]);
    expect(screen.getByRole("button", { name: /Draft the plan/ })).toBeEnabled();
  });

  it("starts from the goal it was given (⌘K)", () => {
    setup({ initialGoal: "Run user interviews about onboarding" });
    expect(screen.getByLabelText("What's the goal?")).toHaveValue("Run user interviews about onboarding");
  });

  it("guests get an explanation, not the form", () => {
    const { props } = setup({ currentUserId: "m-4" });
    expect(screen.getByText(/Guests can view and comment/)).toBeInTheDocument();
    expect(screen.queryByLabelText("What's the goal?")).toBeNull();
    expect(screen.queryByRole("button", { name: /Draft the plan/ })).toBeNull();
    fireEvent.click(within(footer()).getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("ProjectPlanner — review", () => {
  it("drafts on the device: identity, facts, timeline, sections and a Create button", async () => {
    setup({ initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    expect(screen.getByLabelText("Project name")).toHaveValue("Launch our mobile app in the App Store");
    expect(screen.getByRole("img", { name: /^Timeline: 5 sections from/ })).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "Section name" }).map((i) => (i as HTMLInputElement).value))
      .toEqual(["Plan & positioning", "Product readiness", "Launch assets", "Go-to-market", "Launch & follow-up"]);
    const create = within(footer()).getByRole("button", { name: /Create project/ });
    expect(create).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(/Drafted 19 tasks in 5 sections/);
  });

  it("edits a title, toggles a milestone and changes the owner", async () => {
    setup({ initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    const title = screen.getByRole("textbox", { name: "Title of task 1" });
    fireEvent.change(title, { target: { value: "Write the two-page launch brief" } });
    expect(title).toHaveValue("Write the two-page launch brief");
    const ms = screen.getByRole("button", { name: "Milestone: “Write the two-page launch brief”" });
    expect(ms).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(ms);
    expect(screen.getByRole("button", { name: "Milestone: “Write the two-page launch brief”" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("is a milestone");
    const who = screen.getByRole("combobox", { name: "Who does “Agree the launch date, owners and go/no-go checklist”" });
    fireEvent.change(who, { target: { value: "m-3" } });
    expect(who).toHaveValue("m-3");
    // guests are offered, labelled
    expect(within(who).getByRole("option", { name: "Idris Bell (guest)" })).toBeInTheDocument();
  });

  it("removes a task with Undo", async () => {
    setup({ initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    fireEvent.click(screen.getByRole("button", { name: "Remove “Record a 60-second demo video”" }));
    expect(screen.queryByDisplayValue("Record a 60-second demo video")).toBeNull();
    const bar = screen.getByRole("group", { name: "Removed" });
    expect(bar).toHaveTextContent("Removed “Record a 60-second demo video”.");
    fireEvent.click(within(bar).getByRole("button", { name: "Undo" }));
    expect(screen.getByDisplayValue("Record a 60-second demo video")).toBeInTheDocument();
    // another change after a removal retires the offer (Undo would revert that change too)
    fireEvent.click(screen.getByRole("button", { name: "Remove “Record a 60-second demo video”" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title of task 1" }), { target: { value: "Brief" } });
    expect(screen.queryByRole("group", { name: "Removed" })).toBeNull();
  });

  it("moves a task with the keyboard, across into the next section", async () => {
    setup({ initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    const grip = screen.getByRole("button", { name: "Move “Launch plan signed off”" });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(screen.getByRole("status")).toHaveTextContent("Moved “Launch plan signed off” to Product readiness, 1 of 6.");
    const rows = within(screen.getByRole("list", { name: "Tasks in Product readiness" })).getAllByRole("listitem");
    expect(within(rows[0]).getByRole("textbox")).toHaveValue("Launch plan signed off");
  });

  it("removes a section and its tasks, renames one, adds a task (and focuses it)", async () => {
    setup({ initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    fireEvent.click(screen.getByRole("button", { name: "Remove Go-to-market and its 4 tasks" }));
    expect(screen.getAllByRole("textbox", { name: "Section name" })).toHaveLength(4);
    const name = screen.getAllByRole("textbox", { name: "Section name" })[0];
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.blur(name);
    expect(screen.getAllByRole("textbox", { name: "Section name" })[0]).toHaveValue("Untitled section");
    fireEvent.click(screen.getByRole("button", { name: "Add a task to Untitled section" }));
    expect(screen.getAllByPlaceholderText("Name this task").filter((i) => !(i as HTMLInputElement).value)).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toHaveValue(""));
  });

  it("details: edit the description and what it waits for (no loops offered)", async () => {
    setup({ initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    // everything waits on the brief, so there's nothing it could wait for
    fireEvent.click(screen.getByRole("button", { name: "Details of “Write the launch brief: audience, message and success measures”" }));
    expect(screen.getByText("Nothing it can wait for yet.")).toBeInTheDocument();
    const q = "Line up three customer quotes for launch day";
    fireEvent.click(screen.getByRole("button", { name: `Details of “${q}”` }));
    const group = screen.getByRole("group", { name: `What “${q}” is blocked by` });
    expect(within(group).getByText("Launch plan signed off")).toBeInTheDocument();
    const add = within(group).getByRole("combobox");
    // what waits on it (launch day and after) would make a loop: not offered
    expect(within(add).queryByRole("option", { name: "Launch day" })).toBeNull();
    expect(within(add).queryByRole("option", { name: "Share the one-week results recap" })).toBeNull();
    fireEvent.change(add, { target: { value: within(add).getByRole("option", { name: "Fix the must-fix bugs" }).getAttribute("value") } });
    expect(within(group).getByText("Fix the must-fix bugs")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: `“${q}” no longer waits for “Launch plan signed off”` }));
    expect(within(group).queryByRole("button", { name: `“${q}” no longer waits for “Launch plan signed off”` })).toBeNull();
    // and it's on offer again
    expect(within(within(group).getByRole("combobox")).getByRole("option", { name: "Launch plan signed off" })).toBeInTheDocument();
    const desc = screen.getByRole("textbox", { name: `Description of “${q}”` });
    fireEvent.change(desc, { target: { value: "Two named quotes from the beta." } });
    expect(desc).toHaveValue("Two named quotes from the beta.");
  });

  it("warns about the deadline and takes you to the tasks", async () => {
    setup({ initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    // a deadline earlier than the plan's end
    const dl = screen.getByRole("button", { name: /^Deadline/ });
    expect(dl).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Things to check" })).toBeNull();
  });

  it("back keeps the plan; closing asks first", async () => {
    const { props } = setup({ initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    fireEvent.click(within(footer()).getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("What's the goal?")).toBeInTheDocument();
    fireEvent.click(within(footer()).getByRole("button", { name: /Back to the plan/ }));
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(within(footer()).getByText(/Discard this plan\?/)).toBeInTheDocument();
    fireEvent.click(within(footer()).getByRole("button", { name: "Keep editing" }));
    expect(within(footer()).getByRole("button", { name: /Create project/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(within(footer()).getByRole("button", { name: "Discard" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectPlanner — create", () => {
  it("makes the project through deps and hands the result over", async () => {
    const d = deps();
    const { props } = setup({ initialGoal: PLANNER_EXAMPLES[0], deps: d });
    await draftIt();
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: /Create project/ })); });
    expect(d.createProject).toHaveBeenCalledWith(expect.objectContaining({ name: "Launch our mobile app in the App Store", emoji: "🚀", workspaceId: "ws-foundrise", description: PLANNER_EXAMPLES[0] }));
    expect(d.createTasks).toHaveBeenCalledTimes(1);
    expect(props.onCreated).toHaveBeenCalledTimes(1);
    const r = (props.onCreated as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppliedProjectPlan;
    expect(r.tasks).toHaveLength(19);
    expect(r.rolledBack).toBe(false);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("shows progress while it works", async () => {
    let finish: (t: Task[]) => void = () => {};
    const d = deps({ createTasks: vi.fn((ts: Task[]) => new Promise<Task[]>((res) => { finish = () => res(ts); })) });
    setup({ initialGoal: PLANNER_EXAMPLES[0], deps: d });
    await draftIt();
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: /Create project/ })); });
    expect(dialog().querySelector(".kpl-creating-title")).toHaveTextContent("Creating Launch our mobile app in the App Store…");
    expect(screen.getByRole("progressbar", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getByText("Tasks").closest("li")).toHaveAttribute("data-state", "active");
    // can't be closed half-way
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/Discard this plan/)).toBeNull();
    await act(async () => { finish([]); });
  });

  it("a failure is rolled back and said; the plan stays to try again", async () => {
    let fail = true;
    const d = deps({
      createTasks: vi.fn(async (ts: Task[]) => {
        if (fail) throw Object.assign(new Error("x"), { saved: ts.slice(2), failed: ts.slice(0, 2).map((task) => ({ task, message: "x" })) });
        return ts;
      }),
    });
    const { props } = setup({ initialGoal: PLANNER_EXAMPLES[0], deps: d });
    await draftIt();
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: /Create project/ })); });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The project wasn't created");
    expect(alert).toHaveTextContent(/recycle bin for 30 days/);
    expect(d.deleteProject).toHaveBeenCalledWith("p-new");
    expect(props.onCreated).not.toHaveBeenCalled();
    // closing now says nothing is left (the bin has it), not that nothing was ever made
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(within(footer()).getByText("Discard this plan? Nothing from it was kept.")).toBeInTheDocument();
    fireEvent.click(within(footer()).getByRole("button", { name: "Keep editing" }));
    fail = false;
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: "Try again" })); });
    expect(props.onCreated).toHaveBeenCalledTimes(1);
  });

  it("says plainly what happens if it fails part-way", async () => {
    const d = deps({ createTasks: vi.fn(() => new Promise<Task[]>(() => {})) });
    setup({ initialGoal: PLANNER_EXAMPLES[0], deps: d });
    await draftIt();
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: /Create project/ })); });
    expect(dialog().querySelector(".kpl-creating .kpl-hint")).toHaveTextContent("If its sections or tasks can't all be made, Kanbo removes what it made, and tells you if anything is left over.");
    expect(dialog()).not.toHaveTextContent(/never left with half a plan/);
  });

  it("a rollback that can't remove the project: said, and Try again removes it first — never a second project", async () => {
    let tasksFail = true;
    let deleteFails = true;
    const d = deps({
      createTasks: vi.fn(async (ts: Task[]) => { if (tasksFail) throw new Error("offline"); return ts; }),
      deleteProject: vi.fn(async () => { if (deleteFails) throw new Error("offline"); }),
    });
    const { props } = setup({ initialGoal: PLANNER_EXAMPLES[0], deps: d });
    await draftIt();
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: /Create project/ })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("is still in Projects with no tasks. Trying again removes it first, so there won't be two.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(within(footer()).getByText("Discard this plan? “Launch our mobile app in the App Store” is still in Projects, with no tasks.")).toBeInTheDocument();
    fireEvent.click(within(footer()).getByRole("button", { name: "Keep editing" }));
    // still can't remove it: nothing new is made
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: "Try again" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Kanbo still couldn't remove “Launch our mobile app in the App Store”, so it hasn't started again");
    expect(d.createProject).toHaveBeenCalledTimes(1);
    // now it goes: removed first, then made afresh
    deleteFails = false;
    tasksFail = false;
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: "Try again" })); });
    expect(d.createProject).toHaveBeenCalledTimes(2);
    const removedAt = (d.deleteProject as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    expect(removedAt[removedAt.length - 1]).toBeLessThan((d.createProject as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]);
    expect(props.onCreated).toHaveBeenCalledTimes(1);
  });

  it("the project can't be made: nothing was made, back to the plan", async () => {
    const d = deps({ createProject: vi.fn(async () => { throw new Error("permission denied"); }) });
    setup({ initialGoal: PLANNER_EXAMPLES[0], deps: d });
    await draftIt();
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: /Create project/ })); });
    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing was made/);
    fireEvent.click(within(footer()).getByRole("button", { name: "Back to the plan" }));
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
  });
});

describe("ProjectPlanner — append", () => {
  it("adds to the project: its chip, its sections reused, 'Add n tasks'", async () => {
    const project = PROJECTS.find((p) => p.id === "p-launch")!;
    const d = deps();
    const { props } = setup({
      mode: "append", project, sections: [{ id: "sec-assets", projectId: "p-launch", name: "Launch assets", position: 5 }], deps: d,
      initialGoal: PLANNER_EXAMPLES[0],
    });
    expect(screen.getByRole("dialog", { name: "Add tasks with Kanbo" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Project name/)).toBeNull();
    await draftIt();
    expect(screen.getByText("Adding to")).toBeInTheDocument();
    const add = within(footer()).getByRole("button", { name: /^Add \d+ tasks/ });
    await act(async () => { fireEvent.click(add); });
    expect(d.createProject).not.toHaveBeenCalled();
    const made = (d.createSection as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].name);
    expect(made).not.toContain("Launch assets");
    const batch = (d.createTasks as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task[];
    expect(batch.some((t) => t.sectionId === "sec-assets")).toBe(true);
    expect(props.onCreated).toHaveBeenCalled();
  });

  /** the project's sections as the database has them, and deps over them */
  function liveSections(over: Partial<PlanApplyDeps> = {}) {
    const live = new Map<string, Section>([["sec-assets", { id: "sec-assets", projectId: "p-launch", name: "Launch assets", position: 5 }]]);
    let n = 0;
    const d = deps({
      createSection: vi.fn(async (i) => { const s = { id: `sec-new-${++n}`, ...i }; live.set(s.id, s); return s; }),
      deleteSection: vi.fn(async (id: string) => { live.delete(id); }),
      ...over,
    });
    return { live, d, prop: [...live.values()] };
  }

  it("a failed add takes away the sections it made too; Try again makes each once", async () => {
    const project = PROJECTS.find((p) => p.id === "p-launch")!;
    let fail = true;
    const { live, d, prop } = liveSections({
      createTasks: vi.fn(async (ts: Task[]) => { if (fail) throw Object.assign(new Error("x"), { saved: ts.slice(0, 2), failed: ts.slice(2).map((task) => ({ task, message: "x" })) }); return ts; }),
    });
    const { props } = setup({ mode: "append", project, sections: prop, deps: d, initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: /^Add \d+ tasks/ })); });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The tasks weren't added");
    expect(alert).toHaveTextContent("so Kanbo removed what it had added and the project is as it was.");
    expect(d.deleteTasks).toHaveBeenCalledTimes(1);
    expect([...live.keys()]).toEqual(["sec-assets"]);
    fail = false;
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: "Try again" })); });
    expect(props.onCreated).toHaveBeenCalledTimes(1);
    const names = [...live.values()].map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    const r = (props.onCreated as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppliedProjectPlan;
    expect(r.sections.map((s) => s.id).sort()).toEqual([...live.keys()].filter((id) => id !== "sec-assets").sort());
  });

  it("sections that can't be removed are said, kept out of a second copy, and handed to the host", async () => {
    const project = PROJECTS.find((p) => p.id === "p-launch")!;
    let fail = true;
    const { live, d, prop } = liveSections({
      createTasks: vi.fn(async (ts: Task[]) => { if (fail) throw new Error("offline"); return ts; }),
      deleteSection: vi.fn(async () => { throw new Error("offline"); }),
    });
    const { props } = setup({ mode: "append", project, sections: prop, deps: d, initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: /^Add \d+ tasks/ })); });
    const made = live.size - 1;
    expect(made).toBeGreaterThan(1);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`couldn't remove the ${made} new sections`);
    expect(alert).toHaveTextContent("so they're still there, empty. Trying again won't add them twice.");
    expect(alert).not.toHaveTextContent(/removed what it had added/);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(within(footer()).getByText(`Discard this plan? The ${made} new sections (“Plan & positioning”, “Product readiness”, “Go-to-market” and 1 more) are still in “${project.name}”, empty.`)).toBeInTheDocument();
    fireEvent.click(within(footer()).getByRole("button", { name: "Keep editing" }));
    fail = false;
    const sectionCalls = (d.createSection as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: "Try again" })); });
    // it tried to tidy them again, then reused them by name: no new sections at all
    expect((d.createSection as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sectionCalls);
    expect(live.size).toBe(made + 1);
    expect(props.onCreated).toHaveBeenCalledTimes(1);
    const r = (props.onCreated as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppliedProjectPlan;
    expect(r.sections.map((s) => s.id).sort()).toEqual([...live.keys()].filter((id) => id !== "sec-assets").sort());
    expect(r.tasks.every((t) => !t.sectionId || live.has(t.sectionId))).toBe(true);
  });

  it("says what it removes when adding", async () => {
    const project = PROJECTS.find((p) => p.id === "p-launch")!;
    const d = deps({ createTasks: vi.fn(() => new Promise<Task[]>(() => {})) });
    setup({ mode: "append", project, sections: [], deps: d, initialGoal: PLANNER_EXAMPLES[0] });
    await draftIt();
    await act(async () => { fireEvent.click(within(footer()).getByRole("button", { name: /^Add \d+ tasks/ })); });
    expect(dialog().querySelector(".kpl-creating .kpl-hint")).toHaveTextContent("If the tasks can't all be added, Kanbo removes the tasks and sections it added, and tells you if anything is left over.");
  });
});
