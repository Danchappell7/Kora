import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { Task, Goal, AutomationRule, FormDef, Project, Portfolio, StatusUpdate } from "../../data/types";
import { GoalsView, PortfoliosView } from "./GoalsPortfolios";
import { AutomationsView, FormsView } from "./RulesForms";

const proj = (id: string, name: string): Project => ({ id, name, emoji: "", color: "red", workspaceId: "ws" });

describe("GoalsView", () => {
  const base = { projects: [] as Project[], tasks: [] as Task[], onCreate: () => {}, onDelete: () => {} };
  it("renders grandchildren and offers a parent select on nested goals", () => {
    const goals: Goal[] = [
      { id: "C", name: "Company", status: "on_track" },
      { id: "A", name: "Alpha", status: "on_track", parentId: "C" },
      { id: "B", name: "Beta", status: "on_track", parentId: "A" },
    ];
    render(<GoalsView {...base} goals={goals} onUpdate={() => {}} />);
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
    const parentOfA = screen.getByLabelText("Parent goal of Alpha") as HTMLSelectElement;
    const opts = [...parentOfA.options].map((o) => o.value);
    expect(opts).toContain("");       // "No parent goal"
    expect(opts).toContain("C");
    expect(opts).not.toContain("A");  // itself
    expect(opts).not.toContain("B");  // its own sub-goal
    expect(screen.getByLabelText("Parent goal of Beta")).toBeInTheDocument();
  });
  it("saves a renamed goal once, on blur", () => {
    const onUpdate = vi.fn();
    render(<GoalsView {...base} goals={[{ id: "G", name: "Grow", status: "on_track" }]} onUpdate={onUpdate} />);
    const input = screen.getByLabelText("Goal name: Grow");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Grow r" } });
    fireEvent.change(input, { target: { value: "Grow revenue " } });
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("G", { name: "Grow revenue" });
  });
  it("never writes back a stale value when a focused field is left without typing", () => {
    const onUpdate = vi.fn();
    const goal = (o: Partial<Goal>): Goal => ({ id: "G", name: "Grow", status: "on_track", current: 10, target: 100, ...o });
    const { rerender } = render(<GoalsView {...base} goals={[goal({})]} onUpdate={onUpdate} />);
    const nameBox = screen.getByLabelText("Goal name: Grow") as HTMLInputElement;
    const current = screen.getByLabelText("Current value for Grow") as HTMLInputElement;
    fireEvent.focus(nameBox);
    fireEvent.focus(current);
    // a teammate's rename and new figure arrive by realtime while the fields have focus
    rerender(<GoalsView {...base} goals={[goal({ name: "Grow revenue 20%", current: 55 })]} onUpdate={onUpdate} />);
    expect(nameBox.value).toBe("Grow revenue 20%");
    expect(current.value).toBe("55");
    fireEvent.blur(nameBox);
    fireEvent.blur(current);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(nameBox.value).toBe("Grow revenue 20%");
    expect(current.value).toBe("55");
  });
  it("keeps what the user typed when a teammate's change arrives mid-edit, and Escape reverts to the latest", () => {
    const onUpdate = vi.fn();
    const goal = (name: string): Goal => ({ id: "G", name, status: "on_track" });
    const { rerender } = render(<GoalsView {...base} goals={[goal("Grow")]} onUpdate={onUpdate} />);
    const nameBox = screen.getByLabelText("Goal name: Grow") as HTMLInputElement;
    fireEvent.focus(nameBox);
    fireEvent.change(nameBox, { target: { value: "Grow ARR" } });
    rerender(<GoalsView {...base} goals={[goal("Grow revenue")]} onUpdate={onUpdate} />);
    expect(nameBox.value).toBe("Grow ARR");
    fireEvent.keyDown(nameBox, { key: "Escape" });
    fireEvent.blur(nameBox);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(nameBox.value).toBe("Grow revenue");
  });
  it("keeps a parent's own current / target visible and in charge once it has sub-goals", () => {
    const goals: Goal[] = [
      { id: "P", name: "Company revenue", status: "on_track", current: 40, target: 100 },
      { id: "S", name: "EMEA", status: "on_track", current: 0, target: 100, parentId: "P" },
    ];
    render(<GoalsView {...base} goals={goals} onUpdate={() => {}} />);
    expect((screen.getByLabelText("Current value for Company revenue") as HTMLInputElement).value).toBe("40");
    expect(screen.getByRole("progressbar", { name: "Company revenue progress" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText(/Own value · 1 sub-goal average 0%/)).toBeInTheDocument();
  });
});

describe("AutomationsView", () => {
  const rule = (actions: AutomationRule["actions"]): AutomationRule => ({ id: "r1", projectId: "pa", name: "Triage", trigger: "task_created", actions, enabled: false });
  const tags = { "tag-uuid-1": { label: "Urgent", color: "red" } };
  it("picks tags by id and links a legacy free-text value to the matching tag", () => {
    const onUpdate = vi.fn();
    render(<AutomationsView rules={[rule([{ type: "add_tag", value: "urgent" }])]} projects={[proj("pa", "Alpha")]} members={[]} sections={[]} tags={tags} onCreate={() => {}} onUpdate={onUpdate} onDelete={() => {}} />);
    const sel = screen.getByLabelText("Tag added by Triage") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toContain("tag-uuid-1");
    fireEvent.click(screen.getByRole("button", { name: /Link to tag “Urgent”/ }));
    expect(onUpdate).toHaveBeenCalledWith("r1", { actions: [{ type: "add_tag", value: "tag-uuid-1" }] });
  });
  it("read-only: the tag can't be changed or linked either", () => {
    const onUpdate = vi.fn();
    render(<AutomationsView readOnly rules={[rule([{ type: "add_tag", value: "urgent" }])]} projects={[proj("pa", "Alpha")]} members={[]} sections={[]} tags={tags} onCreate={() => {}} onUpdate={onUpdate} onDelete={() => {}} />);
    const sel = screen.getByLabelText("Tag added by Triage") as HTMLSelectElement;
    expect(sel).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Link to tag/ })).not.toBeInTheDocument();
    expect(screen.getByText("This action adds nothing: it isn't linked to a tag.")).toBeInTheDocument();
    fireEvent.change(sel, { target: { value: "tag-uuid-1" } });
    expect(onUpdate).not.toHaveBeenCalled();
  });
  it("shows the paused switch as an accessible switch", () => {
    render(<AutomationsView rules={[rule([])]} projects={[proj("pa", "Alpha")]} members={[]} sections={[]} tags={tags} onCreate={() => {}} onUpdate={() => {}} onDelete={() => {}} />);
    expect(screen.getByRole("switch", { name: "Run rule Triage" })).toHaveAttribute("aria-checked", "false");
  });
});

describe("FormsView", () => {
  it("saves a new form into the current workspace's project after a switch", () => {
    const onCreate = vi.fn();
    const props = { forms: [] as FormDef[], members: [], onUpdate: () => {}, onDelete: () => {}, onSubmit: () => {}, onCreate };
    const { rerender } = render(<FormsView {...props} projects={[proj("pa", "Alpha")]} />);
    rerender(<FormsView {...props} projects={[proj("pb", "Beta")]} />);
    fireEvent.click(screen.getByRole("button", { name: /New form/ }));
    fireEvent.change(screen.getByLabelText("New form name"), { target: { value: "Bug report" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith("pb", "Bug report", ["description", "priority"]);
  });
  it("sends an explicit empty assignee when the submitter picks Unassigned", () => {
    const onSubmit = vi.fn();
    const form: FormDef = { id: "f1", projectId: "pa", name: "Bug", fields: ["assignee"] };
    render(<FormsView forms={[form]} projects={[proj("pa", "Alpha")]} members={[{ id: "m-1", name: "Maya Lin" }]} onCreate={() => {}} onUpdate={() => {}} onDelete={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Open form Bug" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Printer jammed" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    expect(onSubmit).toHaveBeenCalledWith("pa", expect.objectContaining({ title: "Printer jammed", assigneeId: "" }));
  });
  it("Enter in the title moves on to the next field when the form asks for more, and files a title-only form", () => {
    const onSubmit = vi.fn();
    const forms: FormDef[] = [{ id: "f1", projectId: "pa", name: "Bug", fields: ["description"] }, { id: "f2", projectId: "pa", name: "Quick", fields: [] }];
    render(<FormsView forms={forms} projects={[proj("pa", "Alpha")]} members={[]} onCreate={() => {}} onUpdate={() => {}} onDelete={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Open form Bug" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Printer jammed" } });
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Description")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Open form Quick" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Coffee machine" } });
    fireEvent.submit(screen.getByRole("form", { name: "Fill in Quick" }));
    expect(onSubmit).toHaveBeenCalledWith("pa", expect.objectContaining({ title: "Coffee machine" }));
  });
  it("keeps what was typed when the request isn't taken, and clears it once it is", () => {
    const onSubmit = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(undefined);
    const form: FormDef = { id: "f1", projectId: "pa", name: "Bug", fields: ["description"] };
    render(<FormsView forms={[form]} projects={[proj("pa", "Alpha")]} members={[]} onCreate={() => {}} onUpdate={() => {}} onDelete={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Open form Bug" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Printer jammed" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Second floor, again" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    expect(screen.getByLabelText("Title")).toHaveValue("Printer jammed");
    expect(screen.getByLabelText("Description")).toHaveValue("Second floor, again");
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
  });
});

describe("GoalsView — empty", () => {
  it("explains goals and puts New goal inside the empty state", () => {
    const onCreate = vi.fn();
    render(<GoalsView goals={[]} projects={[]} tasks={[]} onCreate={onCreate} onUpdate={() => {}} onDelete={() => {}} />);
    expect(screen.getByText(/Goals track a number you want to hit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    fireEvent.change(screen.getByLabelText("New goal name"), { target: { value: "Reach 1,000 users" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith("Reach 1,000 users");
  });
});

describe("PortfoliosView — exec table", () => {
  const ago = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
  const task = (id: string, projectId: string, o: Partial<Task> = {}): Task => ({ id, title: id, description: "", status: "todo", priority: "medium", projectId, assigneeId: "m-self", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o });
  const projects = [proj("pa", "Alpha"), proj("pb", "Beta")];
  const pf: Portfolio = { id: "pf1", name: "Q3 launch", projectIds: ["pa", "pb"] };
  const updates: StatusUpdate[] = [{ id: "u1", projectId: "pa", status: "at_risk", summary: "Deck is late", createdAt: ago(2) }];
  const tasks = [task("t1", "pa", { status: "done" }), task("t2", "pa"), task("t3", "pb")];
  beforeEach(() => localStorage.clear());

  it("reads each project's latest update, progress and staleness at a glance", () => {
    const onOpenProject = vi.fn();
    render(<PortfoliosView portfolios={[pf]} projects={projects} tasks={tasks} statusUpdates={updates} onCreate={() => {}} onUpdate={() => {}} onDelete={() => {}} onOpenProject={onOpenProject} />);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table", { name: "Q3 launch projects" });
    const [alpha, beta] = within(table).getAllByRole("row").slice(1);
    expect(alpha).toHaveTextContent("At risk");
    expect(alpha).toHaveTextContent("Deck is late");
    expect(within(alpha).getByRole("progressbar", { name: "Alpha progress" })).toHaveAttribute("aria-valuenow", "50");
    expect(beta).toHaveTextContent("No update");
    expect(beta).toHaveTextContent("No update in 14 days");
    fireEvent.click(within(beta).getByRole("button", { name: "Open project Beta" }));
    expect(onOpenProject).toHaveBeenCalledWith("pb");
    expect(localStorage.getItem("kanbo-portfolio-view")).toBe("table");
  });
});

describe("Rules and Requests inside a project", () => {
  const projects = [proj("pa", "Alpha"), proj("pb", "Beta")];
  it("AutomationsView shows only the project's rules and files new ones into it", () => {
    const onCreate = vi.fn();
    const rules: AutomationRule[] = [
      { id: "r1", projectId: "pa", name: "Alpha rule", trigger: "task_created", actions: [], enabled: true },
      { id: "r2", projectId: "pb", name: "Beta rule", trigger: "task_created", actions: [], enabled: true },
    ];
    render(<AutomationsView rules={rules} projects={projects} members={[]} sections={[]} projectId="pb" onCreate={onCreate} onUpdate={() => {}} onDelete={() => {}} />);
    expect(screen.getByDisplayValue("Beta rule")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Alpha rule")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New rule/ }));
    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();   // it's this project
    fireEvent.change(screen.getByLabelText("New rule name"), { target: { value: "Triage" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith("pb", "Triage", [], "task_created");
  });

  it("FormsView shows only the project's forms and files new ones into it", () => {
    const onCreate = vi.fn();
    const forms: FormDef[] = [
      { id: "f1", projectId: "pa", name: "Alpha form", fields: [] },
      { id: "f2", projectId: "pb", name: "Beta form", fields: [] },
    ];
    render(<FormsView forms={forms} projects={projects} members={[]} projectId="pb" onCreate={onCreate} onUpdate={() => {}} onDelete={() => {}} onSubmit={() => {}} />);
    expect(screen.getByText("Teammates fill these in to file work into this project.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Beta form")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Alpha form")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New form/ }));
    fireEvent.change(screen.getByLabelText("New form name"), { target: { value: "Bug report" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith("pb", "Bug report", ["description", "priority"]);
  });

  it("guests see the forms and what they ask for, but can't fill one in, build, rename or delete", () => {
    // App refuses a guest's submission (denyGuest), so a guest is never offered one to type into
    const forms: FormDef[] = [{ id: "f2", projectId: "pb", name: "Beta form", fields: ["description"] }];
    render(<FormsView forms={forms} projects={projects} members={[]} projectId="pb" readOnly onCreate={() => {}} onUpdate={() => {}} onDelete={() => {}} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /New form/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete form/ })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Beta form")).not.toBeInTheDocument();
    expect(screen.getByText("Beta form")).toBeInTheDocument();
    expect(screen.getByText("Asks for a title, description.")).toBeInTheDocument();
    expect(screen.getByText(/Only members can file requests; ask one to file yours\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open form/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Submit/ })).not.toBeInTheDocument();
  });
});
