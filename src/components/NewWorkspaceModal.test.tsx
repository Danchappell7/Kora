import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { NewWorkspaceModal } from "./NewWorkspaceModal";
import { WORKSPACE_TEMPLATES } from "../lib/templates";

const named = (name: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: name } });
};

describe("NewWorkspaceModal", () => {
  it("names the workspace, then offers the team templates (Enter is Next)", () => {
    render(<NewWorkspaceModal open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    named("  Acme  ");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Workspace name" }), { key: "Enter" });
    const sheet = screen.getByRole("dialog", { name: "Set up Acme" });
    expect(within(sheet).getByRole("list", { name: "Team templates" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Start empty" })).toBeInTheDocument();
    // Back keeps the name
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue("  Acme  ");
  });

  it("creates it from a template, shows progress until the host is done, then closes", async () => {
    let finish!: () => void;
    const onCreate = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const onClose = vi.fn();
    render(<NewWorkspaceModal open onClose={onClose} onCreate={onCreate} />);
    named("Acme");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const t = WORKSPACE_TEMPLATES[1];
    const card = screen.getByRole("heading", { name: t.name }).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: /Start with this/ }));
    expect(onCreate).toHaveBeenCalledWith("Acme", { template: t, projectKeys: undefined });
    expect(within(card).getByRole("button", { name: /Setting up/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start empty" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Start empty creates it with no template", async () => {
    const onCreate = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<NewWorkspaceModal open onClose={onClose} onCreate={onCreate} />);
    named("Acme");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start empty" })); });
    expect(onCreate).toHaveBeenCalledWith("Acme", undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens on the name step again next time", () => {
    const { rerender } = render(<NewWorkspaceModal open onClose={vi.fn()} onCreate={vi.fn()} />);
    named("Acme");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    rerender(<NewWorkspaceModal open={false} onClose={vi.fn()} onCreate={vi.fn()} />);
    rerender(<NewWorkspaceModal open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue("");
  });
});
