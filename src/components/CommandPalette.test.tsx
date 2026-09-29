import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import type { Project, Task } from "../data/types";

const projects: Project[] = [
  { id: "p-q4", name: "Q4 Launch", emoji: "🚀", color: "blue", workspaceId: "ws-1" },
  { id: "p-arch", name: "Q4 Archive", emoji: "📦", color: "grey", workspaceId: "ws-1", archivedAt: "2026-01-01" },
];
const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, title, description: "", status: "todo", priority: "medium", projectId: "p-q4", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...extra,
});

const open = (props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) =>
  render(<CommandPalette open onClose={() => {}} onAction={() => {}} {...props} />);

describe("CommandPalette", () => {
  it("is an ARIA combobox driving a listbox", () => {
    open();
    const input = screen.getByRole("combobox", { name: "Search or run a command" });
    const list = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
    const first = within(list).getAllByRole("option")[0];
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const second = within(list).getAllByRole("option")[1];
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", second.id);
  });

  it("jumps to a project (never an archived one) when onOpenProject is given", () => {
    const onOpenProject = vi.fn(); const onClose = vi.fn();
    open({ projects, onOpenProject, onClose });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "q4" } });
    const group = screen.getByRole("group", { name: "Projects" });
    expect(within(group).getAllByRole("option")).toHaveLength(1);
    expect(within(group).getByRole("option")).toHaveTextContent("Q4 Launch");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenProject).toHaveBeenCalledWith("p-q4");
    expect(onClose).toHaveBeenCalled();
  });

  it("finds tasks, speaks their status and skips archived ones", () => {
    const onOpenTask = vi.fn();
    open({ tasks: [task("t1", "Invoice Acme", { status: "progress" }), task("t2", "Invoice old", { archivedAt: "2026-01-01" })], onOpenTask, projects });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "invoice" } });
    const group = screen.getByRole("group", { name: "Tasks" });
    const rows = within(group).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("In progress");
    expect(rows[0]).toHaveTextContent("Q4 Launch");
    fireEvent.click(rows[0]);
    expect(onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("can hand the query to Search", () => {
    const onSearchAll = vi.fn();
    open({ onSearchAll });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "budget" } });
    fireEvent.click(screen.getByRole("option", { name: /See all results for “budget” in Search/ }));
    expect(onSearchAll).toHaveBeenCalledWith("budget");
  });

  it("reaches every main view", () => {
    const onNavigate = vi.fn();
    open({ onNavigate });
    const input = screen.getByRole("combobox");
    for (const [q, view] of [["workload", "workload"], ["goals", "goals"], ["portfolios", "portfolios"], ["automations", "automations"], ["forms", "forms"], ["my week", "myweek"]] as const) {
      fireEvent.change(input, { target: { value: q } });
      const nav = screen.getByRole("group", { name: "Navigate" });
      fireEvent.click(within(nav).getAllByRole("option")[0]);
      expect(onNavigate).toHaveBeenLastCalledWith(view);
    }
  });
});
