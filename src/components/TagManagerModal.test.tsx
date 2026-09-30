import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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

  it("Escape reverts an unsaved rename instead of closing — and never saves it on the way out", () => {
    const p = setup();
    const input = screen.getByRole("textbox", { name: "Rename tag Ops" }) as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Oops" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(input.value).toBe("Ops");
    expect(input).toHaveFocus();          // focus didn't move, so no blur committed "Oops"
    expect(p.onUpdate).not.toHaveBeenCalled();
    // the next Escape closes the dialog, still without saving anything
    fireEvent.keyDown(input, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.blur(input);
    expect(p.onUpdate).not.toHaveBeenCalled();
  });

  it("Escape in the new-tag box clears the typed name before closing the dialog", () => {
    const p = setup({ onCreate: vi.fn() });
    const input = screen.getByRole("textbox", { name: "New tag name" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Leg" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the filter box while a filter is typed, even when a delete takes the list under the threshold", () => {
    const many: Record<string, TagDef> = {};
    ["old-one", "old-two", "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"].forEach((l, i) => { many["t" + i] = { label: l, color: "x" }; });
    const props = { open: true, onClose: vi.fn(), taskCounts: {}, onUpdate: vi.fn(), onDelete: vi.fn(), onMerge: vi.fn() };
    const { rerender } = render(<TagManagerModal {...props} tags={many} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter tags" }), { target: { value: "old" } });
    expect(screen.getAllByRole("textbox", { name: /^Rename tag/ })).toHaveLength(2);
    const eight = { ...many };
    delete eight.t0;
    rerender(<TagManagerModal {...props} tags={eight} />);
    const box = screen.getByRole("searchbox", { name: "Filter tags" });
    expect(box).toHaveValue("old");
    expect(screen.getAllByRole("textbox", { name: /^Rename tag/ })).toHaveLength(1);
    // clearing it shows everything, and the box goes away again under the threshold
    fireEvent.change(box, { target: { value: "" } });
    expect(screen.getAllByRole("textbox", { name: /^Rename tag/ })).toHaveLength(8);
    expect(screen.queryByRole("searchbox", { name: "Filter tags" })).toBeNull();
  });

  it("Escape in the filter box clears the filter before closing the dialog", () => {
    const many: Record<string, TagDef> = {};
    for (let i = 0; i < 10; i++) many["t" + i] = { label: `Tag ${i}`, color: "x" };
    const p = setup({ tags: many, taskCounts: {} });
    const box = screen.getByRole("searchbox", { name: "Filter tags" });
    box.focus();
    fireEvent.change(box, { target: { value: "Tag 1" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue("");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalled();
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
