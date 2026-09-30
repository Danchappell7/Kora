import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TagManagerModal } from "./TagManagerModal";
import type { TagDef } from "../data/types";

const TAGS: Record<string, TagDef> = {
  "tag-design": { label: "Design", color: "oklch(0.74 0.16 305)" },
  "tag-ops": { label: "Ops", color: "oklch(0.74 0.14 230)" },
};
const COUNTS = { "tag-design": 3, "tag-ops": 1 };

// restore only our own spies — restoreAllMocks would also wipe the global
// matchMedia mock from src/test/setup.ts
const spies: { mockRestore: () => void }[] = [];
const mockConfirm = (v: boolean) => { const s = vi.spyOn(window, "confirm").mockReturnValue(v); spies.push(s); return s; };
afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); });

function setup(over: Partial<Parameters<typeof TagManagerModal>[0]> = {}) {
  const props = { open: true, onClose: vi.fn(), tags: TAGS, taskCounts: COUNTS, onUpdate: vi.fn(), onDelete: vi.fn(), onMerge: vi.fn(), ...over };
  render(<TagManagerModal {...props} />);
  return props;
}

describe("TagManagerModal", () => {
  it("closes on Escape (focus-trapped dialog)", () => {
    const p = setup();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Manage tags" }), { key: "Escape" });
    expect(p.onClose).toHaveBeenCalled();
  });

  it("confirms before deleting, naming the tag and how many tasks use it", () => {
    const p = setup();
    const confirm = mockConfirm(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete tag Design" }));
    expect(confirm).toHaveBeenCalledWith("Delete tag “Design” from every task? It's used on 3 tasks.");
    expect(p.onDelete).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete tag Design" }));
    expect(p.onDelete).toHaveBeenCalledWith("tag-design");
  });

  it("confirms before merging", () => {
    const p = setup();
    const confirm = mockConfirm(false);
    fireEvent.click(screen.getByRole("button", { name: "Merge tag Design into another tag" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Merge Design into" }), { target: { value: "tag-ops" } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Merge “Design” into “Ops”?"));
    expect(confirm.mock.calls[0][0]).toContain("3 tasks tagged “Design” will be tagged “Ops” instead");
    expect(p.onMerge).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Merge tag Design into another tag" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Merge Design into" }), { target: { value: "tag-ops" } });
    expect(p.onMerge).toHaveBeenCalledWith("tag-design", "tag-ops");
  });

  it("Escape backs out of the merge picker before closing the dialog", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Merge tag Design into another tag" }));
    const select = screen.getByRole("combobox", { name: "Merge Design into" });
    fireEvent.keyDown(select, { key: "Escape" });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox", { name: "Merge Design into" })).toBeNull();
  });

  it("renames on Enter, and offers a merge when the new name is taken", () => {
    const p = setup();
    const input = screen.getByRole("textbox", { name: "Rename tag Ops" });
    fireEvent.change(input, { target: { value: "Operations" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onUpdate).toHaveBeenCalledWith("tag-ops", { label: "Operations" });

    const confirm = mockConfirm(true);
    fireEvent.change(input, { target: { value: "design" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(confirm.mock.calls[0][0]).toContain("A tag called “Design” already exists.");
    expect(p.onMerge).toHaveBeenCalledWith("tag-ops", "tag-design");
  });

  it("Escape reverts an unsaved rename instead of closing", () => {
    const p = setup();
    const input = screen.getByRole("textbox", { name: "Rename tag Ops" }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Oops" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(input.value).toBe("Ops");
    fireEvent.blur(input);
    expect(p.onUpdate).not.toHaveBeenCalled();
  });

  it("can create tags when onCreate is provided, without duplicates", () => {
    const onCreate = vi.fn();
    setup({ onCreate });
    const input = screen.getByRole("textbox", { name: "New tag name" });
    fireEvent.change(input, { target: { value: "ops" } });
    fireEvent.click(screen.getByRole("button", { name: /add tag/i }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("A tag called “ops” already exists.");
    fireEvent.change(input, { target: { value: "Legal" } });
    fireEvent.click(screen.getByRole("button", { name: /add tag/i }));
    expect(onCreate).toHaveBeenCalledWith("Legal", expect.any(String));
  });
});
