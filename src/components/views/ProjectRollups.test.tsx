import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Task, Goal, AutomationRule, FormDef, Project } from "../../data/types";
import { GoalsView } from "./GoalsPortfolios";
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
});
