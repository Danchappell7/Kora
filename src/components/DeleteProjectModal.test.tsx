import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DeleteProjectModal } from "./DeleteProjectModal";
import type { Project } from "../data/types";

const P = (id: string, name: string, workspaceId: string | null, extra: Partial<Project> = {}): Project =>
  ({ id, name, emoji: "📁", color: "red", workspaceId, ...extra });
const launch = P("p-launch", "Q4 Launch", "ws-1");
const projects = [launch, P("p-brand", "Brand", "ws-1"), P("p-old", "Old", "ws-1", { archivedAt: "2026-01-01" }), P("p-mine", "Mine", null), P("p-personal", "Personal", null)];

const radio = (name: RegExp) => screen.getByRole("radio", { name });

describe("DeleteProjectModal", () => {
  it("offers Archive instead, chosen by default, when onArchive is given", () => {
    const onArchive = vi.fn(); const onConfirm = vi.fn();
    render(<DeleteProjectModal project={launch} taskCount={5} archivedCount={2} projects={projects} onConfirm={onConfirm} onArchive={onArchive} onClose={() => {}} />);
    expect(radio(/Archive instead/)).toHaveAttribute("aria-checked", "true");
    expect(radio(/Delete 7 tasks too/)).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("button", { name: /Archive project/ }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("describes what's at stake to a screen reader as the dialog opens", () => {
    render(<DeleteProjectModal project={launch} taskCount={3} projects={projects} onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Delete project" })).toHaveAccessibleDescription(/Delete 📁 Q4 Launch ?\? It has 3 tasks ?\. What should happen to them\?/);
  });

  it("closes itself after archiving, so the caller only has to archive", () => {
    const onArchive = vi.fn(); const onClose = vi.fn();
    render(<DeleteProjectModal project={launch} taskCount={1} projects={projects} onConfirm={() => {}} onArchive={onArchive} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Archive project/ }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("tabbing past the target picker never turns Archive into Move & delete", () => {
    const onArchive = vi.fn(); const onConfirm = vi.fn();
    render(<DeleteProjectModal project={launch} taskCount={5} projects={projects} onConfirm={onConfirm} onArchive={onArchive} onClose={() => {}} />);
    const select = screen.getByRole("combobox", { name: /Move tasks from Q4 Launch to/ });
    // not a tab stop while Move isn't the choice…
    expect(select).toHaveAttribute("tabindex", "-1");
    // …and even if it gets focus, focus alone isn't a choice
    fireEvent.focus(select);
    expect(radio(/Archive instead/)).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: /Archive project/ }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("puts the target picker in the tab order once Move is chosen, and clicking it chooses Move", () => {
    render(<DeleteProjectModal project={launch} taskCount={5} projects={projects} onConfirm={() => {}} onArchive={() => {}} onClose={() => {}} />);
    const select = screen.getByRole("combobox", { name: /Move tasks from Q4 Launch to/ });
    fireEvent.mouseDown(select);
    expect(radio(/Move 5 tasks/)).toHaveAttribute("aria-checked", "true");
    expect(select).toHaveAttribute("tabindex", "0");
  });

  it("counts archived tasks and says so", () => {
    render(<DeleteProjectModal project={launch} taskCount={5} archivedCount={20} projects={projects} onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("5 tasks and 20 archived");
    expect(radio(/Delete 25 tasks too/)).toBeInTheDocument();
    expect(radio(/Move 25 tasks to another project/)).toBeInTheDocument();
  });

  it("only offers move targets from the same workspace that aren't archived", () => {
    render(<DeleteProjectModal project={launch} taskCount={3} projects={projects} onConfirm={() => {}} onClose={() => {}} />);
    const select = screen.getByRole("combobox", { name: /Move tasks from Q4 Launch to/ });
    const names = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["📁 Brand"]);
    expect(radio(/Move 3 tasks/)).toHaveAttribute("aria-checked", "true");
  });

  it("never pre-chooses delete when archived tasks exist", () => {
    const onConfirm = vi.fn();
    const lonely = P("p-solo", "Solo", "ws-2");
    render(<DeleteProjectModal project={lonely} taskCount={0} archivedCount={4} projects={[lonely]} onConfirm={onConfirm} onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("no active tasks, but 4 archived tasks");
    expect(radio(/Delete 4 tasks too/)).toHaveAttribute("aria-checked", "false");
    const cta = screen.getByRole("button", { name: /Delete project/ });
    expect(cta).toBeDisabled();
    // say why the button is disabled
    expect(cta).toHaveAccessibleDescription("Choose what happens to the tasks first.");
    fireEvent.click(cta);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(radio(/Delete 4 tasks too/));
    const go = screen.getByRole("button", { name: /Delete project and 4 tasks/ });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    expect(onConfirm).toHaveBeenCalledWith("delete");
  });

  it("moves to the chosen target", () => {
    const onConfirm = vi.fn();
    render(<DeleteProjectModal project={launch} taskCount={2} projects={[...projects, P("p-ops", "Ops", "ws-1")]} onConfirm={onConfirm} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p-ops" } });
    fireEvent.click(screen.getByRole("button", { name: /Move tasks & delete/ }));
    expect(onConfirm).toHaveBeenCalledWith("reassign", "p-ops");
  });

  it("deletes an empty project straight away when there is no archive option", () => {
    const onConfirm = vi.fn();
    render(<DeleteProjectModal project={launch} taskCount={0} projects={projects} onConfirm={onConfirm} onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("This project has no tasks.");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delete project$/ }));
    expect(onConfirm).toHaveBeenCalledWith("delete");
  });

  it("arrow keys move between options", () => {
    render(<DeleteProjectModal project={launch} taskCount={2} projects={projects} onConfirm={() => {}} onArchive={() => {}} onClose={() => {}} />);
    fireEvent.keyDown(radio(/Archive instead/), { key: "ArrowDown" });
    expect(radio(/Move 2 tasks/)).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radio(/Move 2 tasks/), { key: "ArrowDown" });
    expect(radio(/Delete 2 tasks too/)).toHaveAttribute("aria-checked", "true");
  });
});
