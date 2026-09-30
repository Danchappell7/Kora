import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewProjectModal } from "./NewProjectModal";
import { getProjectTemplates } from "../lib/templates";

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

  it("names each colour and icon choice, and creates with the ones picked", () => {
    const onCreate = vi.fn();
    render(<NewProjectModal open onClose={vi.fn()} onCreate={onCreate} workspaceId={null} />);
    const violet = screen.getByRole("button", { name: "Violet" });
    fireEvent.click(violet);
    expect(violet).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "🚀" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Rocket" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Project name" }), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Rocket", emoji: "🚀", color: "oklch(0.74 0.16 305)" }));
  });
});
