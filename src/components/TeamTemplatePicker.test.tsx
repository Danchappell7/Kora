import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { TeamTemplatePicker, templateSummaryLine } from "./TeamTemplatePicker";
import { WORKSPACE_TEMPLATES, findWorkspaceTemplate } from "../lib/templates";

const card = (name: string) => screen.getByRole("heading", { name }).closest("li")!;

describe("TeamTemplatePicker", () => {
  it("shows a card per template: its cover and tile, summary, projects and what it sets up", () => {
    render(<TeamTemplatePicker mode="workspace" onPick={() => {}} />);
    const list = screen.getByRole("list", { name: "Team templates" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(WORKSPACE_TEMPLATES.length);
    const m = card("Marketing");
    expect(m.querySelector(".kpcover-wrap")).not.toBeNull();
    expect(m.querySelector(".kpcover-wrap > .kptile")).toHaveTextContent("📣");
    expect(m.querySelector(".kpcover-wrap")).toHaveAttribute("data-spectrum", "orchid");
    expect(within(m).getByText(/front door for creative requests/)).toBeInTheDocument();
    // every project is a ticked checkbox named by its project and task count
    const boxes = within(m).getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(within(m).getByRole("checkbox", { name: /Campaigns\s*4 tasks/ })).toBeInTheDocument();
    // a project's request form and rule are named on its row
    expect(within(m).getByRole("checkbox", { name: /Creative requests\s*, Request form\s*3 tasks/ })).toBeInTheDocument();
    expect(within(m).getByRole("checkbox", { name: /Content calendar\s*, Rule: new content starts in Ideas\s*3 tasks/ })).toBeInTheDocument();
    expect(within(m).getByRole("group", { name: "Projects to set up from Marketing" })).toBeInTheDocument();
    expect(within(m).getByText("3 projects · 10 tasks")).toBeInTheDocument();
  });

  it("“Start with this” picks the whole template, described by its name and contents", () => {
    const onPick = vi.fn();
    render(<TeamTemplatePicker mode="workspace" onPick={onPick} />);
    const btn = within(card("Operations")).getByRole("button", { name: "Start with this" });
    expect(btn).toHaveAccessibleDescription(/Operations .*3 projects/);
    fireEvent.click(btn);
    expect(onPick).toHaveBeenCalledWith(findWorkspaceTemplate("operations"), undefined);
  });

  it("unticking projects picks only the rest (in the template's order), and none can't be started", () => {
    const onPick = vi.fn();
    render(<TeamTemplatePicker mode="project" onPick={onPick} />);
    const c = card("Product launch");
    expect(within(c).getByRole("group", { name: "Projects to add from Product launch" })).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("checkbox", { name: /Launch plan/ }));
    expect(within(c).getByText("2 projects · 6 tasks")).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: "Start with this" }));
    expect(onPick).toHaveBeenLastCalledWith(findWorkspaceTemplate("launch"), ["release", "feedback"]);
    // tick it back: order follows the template, not the clicks
    fireEvent.click(within(c).getByRole("checkbox", { name: /Feedback/ }));
    fireEvent.click(within(c).getByRole("checkbox", { name: /Launch plan/ }));
    fireEvent.click(within(c).getByRole("button", { name: "Start with this" }));
    expect(onPick).toHaveBeenLastCalledWith(findWorkspaceTemplate("launch"), ["plan", "release"]);
    fireEvent.click(within(c).getByRole("checkbox", { name: /Launch plan/ }));
    fireEvent.click(within(c).getByRole("checkbox", { name: /Release/ }));
    expect(within(c).getByText("Tick at least one project")).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Start with this" })).toBeDisabled();
    // other cards are untouched
    expect(within(card("Marketing")).getAllByRole("checkbox").every((b) => (b as HTMLInputElement).checked)).toBe(true);
  });

  it("“Start empty” shows only when the host offers it", () => {
    const onStartEmpty = vi.fn();
    const { rerender } = render(<TeamTemplatePicker mode="workspace" onPick={() => {}} />);
    expect(screen.queryByRole("button", { name: "Start empty" })).toBeNull();
    rerender(<TeamTemplatePicker mode="workspace" onPick={() => {}} onStartEmpty={onStartEmpty} />);
    fireEvent.click(screen.getByRole("button", { name: "Start empty" }));
    expect(onStartEmpty).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Start with no projects/)).toBeInTheDocument();
    rerender(<TeamTemplatePicker mode="project" onPick={() => {}} onStartEmpty={onStartEmpty} />);
    expect(screen.getByText(/one blank project/)).toBeInTheDocument();
  });

  it("while busy: the picked card says it's setting up, everything is disabled, and it's announced", () => {
    const onPick = vi.fn(), onStartEmpty = vi.fn();
    const { rerender } = render(<TeamTemplatePicker mode="workspace" onPick={onPick} onStartEmpty={onStartEmpty} />);
    fireEvent.click(within(card("Client services")).getByRole("button", { name: "Start with this" }));
    rerender(<TeamTemplatePicker mode="workspace" onPick={onPick} onStartEmpty={onStartEmpty} busy />);
    const busyBtn = within(card("Client services")).getByRole("button", { name: "Setting up…" });
    expect(busyBtn).toHaveAttribute("aria-busy", "true");
    fireEvent.click(busyBtn); // a second press does nothing
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(card("Client services")).toHaveAttribute("data-picked", "true");
    for (const b of screen.getAllByRole("button")) if (b !== busyBtn) expect(b).toBeDisabled();
    for (const b of screen.getAllByRole("checkbox")) expect(b).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Setting up Client services…");
    fireEvent.click(within(card("Marketing")).getByRole("button", { name: "Start with this" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    // done: back to normal
    rerender(<TeamTemplatePicker mode="workspace" onPick={onPick} onStartEmpty={onStartEmpty} busy={false} />);
    expect(within(card("Client services")).getByRole("button", { name: "Start with this" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("summary line counts what's ticked", () => {
    const ops = findWorkspaceTemplate("operations")!;
    expect(templateSummaryLine(ops)).toBe("3 projects · 10 tasks");
    expect(templateSummaryLine(ops, ["routines"])).toBe("1 project · 4 tasks");
  });
});
