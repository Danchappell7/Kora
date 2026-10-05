import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUserProjectTemplates } from "../lib/templates";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { NewProjectModal } from "./NewProjectModal";
import { getProjectTemplates, WORKSPACE_TEMPLATES } from "../lib/templates";

beforeEach(() => { localStorage.clear(); });

describe("NewProjectModal", () => {
  it("passes on the template a project was started from, so its starter tasks can be created", () => {
    const onCreate = vi.fn();
    render(<NewProjectModal open onClose={vi.fn()} onCreate={onCreate} workspaceId="ws-1" />);
    const tpl = getProjectTemplates()[0];
    fireEvent.change(screen.getByRole("combobox", { name: "Start from template" }), { target: { value: tpl.id } });
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue(tpl.name);
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: tpl.name, workspaceId: "ws-1", templateId: tpl.id }));
  });

  it("sends no template id for a project started from scratch", () => {
    const onCreate = vi.fn();
    render(<NewProjectModal open onClose={vi.fn()} onCreate={onCreate} workspaceId={null} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Garden" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onCreate.mock.calls[0][0]).toMatchObject({ name: "Garden", workspaceId: null });
    expect(onCreate.mock.calls[0][0].templateId).toBeUndefined();
  });

  it("says so when this device won't keep a template, and saves it on a retry", () => {
    render(<NewProjectModal open onClose={vi.fn()} onCreate={vi.fn()} workspaceId={null} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Garden" } });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save as template" }));
    } finally { setItem.mockRestore(); }
    fireEvent.click(screen.getByRole("button", { name: "Couldn't save: try again" }));
    expect(screen.getByRole("button", { name: "Saved as a template" })).toBeInTheDocument();
    expect(getUserProjectTemplates().map((t) => t.name)).toEqual(["Garden"]);
  });

  it("names each colour and icon choice, and creates with the ones picked (the colour stored as its spectrum fill)", () => {
    const onCreate = vi.fn();
    render(<NewProjectModal open onClose={vi.fn()} onCreate={onCreate} workspaceId={null} />);
    const hues = screen.getByRole("radiogroup", { name: "Colour" });
    expect(within(hues).getAllByRole("radio")).toHaveLength(12);
    const violet = within(hues).getByRole("radio", { name: "Violet" });
    fireEvent.click(violet);
    expect(violet).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "🚀" }));
    expect(screen.getByRole("button", { name: "🚀" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Rocket" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Project name" }), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Rocket", emoji: "🚀", color: "oklch(0.62 0.16 293)" }));
  });

  it("starts in a hue no project here wears yet, with the name's initial on the tile until an icon is picked", () => {
    const onCreate = vi.fn();
    const projects = [{ id: "a", color: "oklch(0.62 0.154 270)" }, { id: "b", color: "oklch(0.62 0.16 293)" }];
    render(<NewProjectModal open onClose={vi.fn()} onCreate={onCreate} workspaceId={null} projects={projects} />);
    expect(screen.getByRole("radio", { name: "Orchid" })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Garden" } });
    expect(screen.getByRole("button", { name: "No icon: use the initial" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".kptile")?.textContent).toBe("G");
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Garden", emoji: "", color: "oklch(0.62 0.16 318)" }));
  });

  it("takes any emoji typed in, and moves through the hues with the arrow keys", () => {
    render(<NewProjectModal open onClose={vi.fn()} onCreate={vi.fn()} workspaceId={null} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Any emoji" }), { target: { value: "🦄 unicorn" } });
    expect(screen.getByRole("textbox", { name: "Any emoji" })).toHaveValue("🦄");
    expect(document.querySelector(".kptile")?.textContent).toBe("🦄");
    const iris = screen.getByRole("radio", { name: "Iris" });
    expect(iris).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Violet" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(iris, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Violet" }));
    fireEvent.keyDown(screen.getByRole("radio", { name: "Violet" }), { key: "End" });
    expect(screen.getByRole("radio", { name: "Cobalt" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Cobalt" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Iris" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("NewProjectModal › From a team template", () => {
  it("is offered only when the host can apply one", () => {
    render(<NewProjectModal open onClose={vi.fn()} onCreate={vi.fn()} workspaceId="ws-1" />);
    expect(screen.queryByRole("button", { name: "From a team template" })).toBeNull();
  });

  it("opens the gallery, applies the chosen template (just the ticked projects), then closes; Back returns to the form", async () => {
    let finish!: () => void;
    const onApplyTemplate = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const onClose = vi.fn();
    render(<NewProjectModal open onClose={onClose} onCreate={vi.fn()} workspaceId="ws-1" onApplyTemplate={onApplyTemplate} />);
    fireEvent.click(screen.getByRole("button", { name: "From a team template" }));
    const sheet = screen.getByRole("dialog", { name: "From a team template" });
    expect(within(sheet).getByRole("list", { name: "Team templates" })).toBeInTheDocument();
    // Back: the form again
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox", { name: "Project name" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "From a team template" }));
    const first = WORKSPACE_TEMPLATES[0];
    const card = screen.getByRole("heading", { name: first.name }).closest("li")!;
    // untick the first project, then start
    fireEvent.click(within(card).getAllByRole("checkbox")[0]);
    fireEvent.click(within(card).getByRole("button", { name: /Start with this/ }));
    expect(onApplyTemplate).toHaveBeenCalledWith(first, first.projects.slice(1).map((p) => p.key));
    expect(within(card).getByRole("button", { name: /Setting up/ })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
