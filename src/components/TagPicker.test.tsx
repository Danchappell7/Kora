import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { TagPicker } from "./TagPicker";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { TagDef } from "../data/types";

const TAGS: Record<string, TagDef> = {
  "tag-design": { label: "Design", color: "oklch(0.74 0.16 305)" },
  "tag-ops": { label: "Ops", color: "oklch(0.74 0.14 230)" },
};

// restore only our own spies — restoreAllMocks would also wipe the global
// matchMedia mock from src/test/setup.ts
const spies: { mockRestore: () => void }[] = [];
const mockConfirm = (v: boolean) => { const s = vi.spyOn(window, "confirm").mockReturnValue(v); spies.push(s); return s; };
afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); });

function setup(over: Partial<Parameters<typeof TagPicker>[0]> = {}) {
  const props = { tags: TAGS, selected: [] as string[], onToggle: vi.fn(), onCreate: vi.fn(), onDelete: vi.fn(), ...over };
  render(<TagPicker {...props} />);
  return props;
}

describe("TagPicker", () => {
  it("asks before deleting a tag from every task, and names it", () => {
    const p = setup();
    const confirm = mockConfirm(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete tag Design" }));
    expect(confirm).toHaveBeenCalledWith("Delete tag “Design” from every task?");
    expect(p.onDelete).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete tag Design" }));
    expect(p.onDelete).toHaveBeenCalledWith("tag-design");
    expect(p.onToggle).not.toHaveBeenCalled();
  });

  it("exposes tag state as toggle buttons", () => {
    setup({ selected: ["tag-ops"] });
    expect(screen.getByRole("button", { name: "Ops" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "false");
  });

  it("re-uses an existing tag instead of creating a duplicate", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /new tag/i }));
    const input = screen.getByRole("textbox", { name: "New tag name" });
    fireEvent.change(input, { target: { value: "  design " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onCreate).not.toHaveBeenCalled();
    expect(p.onToggle).toHaveBeenCalledWith("tag-design");
  });

  it("creates a new tag and selects it once the server id arrives", () => {
    const onToggle = vi.fn();
    const onCreate = vi.fn();
    const { rerender } = render(<TagPicker tags={TAGS} selected={[]} onToggle={onToggle} onCreate={onCreate} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /new tag/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "New tag name" }), { target: { value: "Legal" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith("Legal", expect.any(String));
    // optimistic temp row: shown as saving, not selectable, not deletable
    rerender(<TagPicker tags={{ ...TAGS, "tmp-tag-1": { label: "Legal", color: "x" } }} selected={[]} onToggle={onToggle} onCreate={onCreate} onDelete={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Legal (saving…)" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete tag Legal" })).toBeNull();
    expect(onToggle).not.toHaveBeenCalled();
    // server confirms with the real id → it gets selected
    rerender(<TagPicker tags={{ ...TAGS, "3f2a": { label: "Legal", color: "x" } }} selected={[]} onToggle={onToggle} onCreate={onCreate} onDelete={vi.fn()} />);
    expect(onToggle).toHaveBeenCalledWith("3f2a");
  });

  it("Escape closes only the new-tag box, not the dialog around it", () => {
    const onDialogClose = vi.fn();
    const onWindowEscape = vi.fn((e: KeyboardEvent) => { if (e.key === "Escape") onDialogClose("window"); });
    window.addEventListener("keydown", onWindowEscape);
    function Dialog() {
      const ref = useFocusTrap<HTMLDivElement>(true, () => onDialogClose("trap"));
      const [sel, setSel] = useState<string[]>([]);
      return (
        <div ref={ref} role="dialog">
          <TagPicker tags={TAGS} selected={sel} onToggle={(id) => setSel((s) => [...s, id])} onCreate={vi.fn()} onDelete={vi.fn()} />
        </div>
      );
    }
    render(<Dialog />);
    fireEvent.click(screen.getByRole("button", { name: /new tag/i }));
    const input = screen.getByRole("textbox", { name: "New tag name" });
    fireEvent.change(input, { target: { value: "half-typed" } });
    const notCancelled = fireEvent.keyDown(input, { key: "Escape" });
    expect(notCancelled).toBe(false); // preventDefault
    expect(onDialogClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "New tag name" })).toBeNull();
    expect(screen.getByRole("button", { name: /new tag/i })).toHaveFocus();
    // a second Escape (box closed) reaches the dialog as normal
    fireEvent.keyDown(screen.getByRole("button", { name: /new tag/i }), { key: "Escape" });
    expect(onDialogClose).toHaveBeenCalled();
    window.removeEventListener("keydown", onWindowEscape);
  });
});
