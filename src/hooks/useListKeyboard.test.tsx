import { describe, it, expect, vi, beforeEach } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useListKeyboard, isTypingTarget, HINT_DISMISSED_KEY, type ListKeyAction } from "./useListKeyboard";

type Spies = {
  onOpen: ReturnType<typeof vi.fn>; onComplete: ReturnType<typeof vi.fn>;
  onAction: ReturnType<typeof vi.fn>; onClear: ReturnType<typeof vi.fn>;
};

/** Three rows, each with a title button (focus lands there), plus a text field inside the list. */
function List({ spies, items = ["a", "b", "c"] }: { spies: Spies; items?: string[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const kb = useListKeyboard({
    rootRef, itemSelector: "[data-row-id]", idOf: (el) => el.dataset.rowId,
    focusTargetOf: (el) => el.querySelector("button"),
    onOpen: spies.onOpen, onComplete: spies.onComplete, onClear: spies.onClear,
    onToggleSelect: (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    onAction: (a: ListKeyAction, id: string) => spies.onAction(a, id),
  });
  return (
    <div>
      <input aria-label="Outside field" />
      <div ref={rootRef}>
        <input aria-label="Rename" />
        {items.map((id) => (
          <div key={id} data-row-id={id} data-selected={sel.has(id) || undefined} data-cursor={kb.cursor === id || undefined} role="group" aria-label={`Row ${id}`}>
            <button type="button">Title {id}</button>
          </div>
        ))}
      </div>
      {kb.hint && <p role="note">hints <button type="button" onClick={kb.dismissHint}>Hide</button></p>}
      <output aria-label="Selected">{[...sel].sort().join(",")}</output>
    </div>
  );
}

const spies = (): Spies => ({ onOpen: vi.fn(), onComplete: vi.fn(), onAction: vi.fn(), onClear: vi.fn() });
const press = (key: string, opts: KeyboardEventInit = {}, target: Element = document.activeElement ?? document.body) => fireEvent.keyDown(target, { key, ...opts });
const row = (id: string) => screen.getByRole("group", { name: `Row ${id}` });
const selectedIds = () => screen.getByLabelText("Selected").textContent;

beforeEach(() => { localStorage.clear(); act(() => (document.activeElement as HTMLElement | null)?.blur()); });

describe("useListKeyboard", () => {
  it("J / K move a cursor, and focus follows it onto the row", () => {
    render(<List spies={spies()} />);
    press("j", {}, document.body);
    expect(row("a")).toHaveAttribute("data-cursor", "true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Title a" }));
    press("j"); press("j"); press("j"); // stops at the last row
    expect(row("c")).toHaveAttribute("data-cursor", "true");
    press("k");
    expect(row("b")).toHaveAttribute("data-cursor", "true");
    expect(row("c")).not.toHaveAttribute("data-cursor");
  });

  it("↓ / ↑ move too, but only once focus is inside the list", () => {
    render(<List spies={spies()} />);
    press("ArrowDown", {}, document.body);
    expect(row("a")).not.toHaveAttribute("data-cursor");
    press("j", {}, document.body);
    press("ArrowDown");
    expect(row("b")).toHaveAttribute("data-cursor", "true");
  });

  it("X toggles the row's selection; Shift+J / Shift+K extend it", () => {
    render(<List spies={spies()} />);
    press("j", {}, document.body);
    press("x");
    expect(selectedIds()).toBe("a");
    press("x");
    expect(selectedIds()).toBe("");
    press("J", { shiftKey: true });
    expect(selectedIds()).toBe("a,b");
    press("J", { shiftKey: true });
    expect(selectedIds()).toBe("a,b,c");
    expect(row("c")).toHaveAttribute("data-cursor", "true");
  });

  it("Enter opens the row under a bare cursor; a focused button opens itself", () => {
    const s = spies();
    render(<List spies={s} />);
    press("j", {}, document.body);
    press("Enter", {}, row("a"));
    expect(s.onOpen).toHaveBeenCalledWith("a");
    s.onOpen.mockClear();
    press("Enter"); // focus is on the title button: its own click does the opening
    expect(s.onOpen).not.toHaveBeenCalled();
  });

  it("⌘↵ and Ctrl+↵ complete the row", () => {
    const s = spies();
    render(<List spies={s} />);
    press("j", {}, document.body); press("j");
    press("Enter", { metaKey: true });
    expect(s.onComplete).toHaveBeenCalledWith("b");
    press("Enter", { ctrlKey: true });
    expect(s.onComplete).toHaveBeenCalledTimes(2);
  });

  it("S / P / D / A hand the row to its controls", () => {
    const s = spies();
    render(<List spies={s} />);
    press("j", {}, document.body);
    for (const k of ["s", "p", "d", "a"]) press(k);
    expect(s.onAction.mock.calls).toEqual([["status", "a"], ["priority", "a"], ["due", "a"], ["assign", "a"]]);
  });

  it("ignores keys typed into a field, inside the list or out", () => {
    const s = spies();
    render(<List spies={s} />);
    const inside = screen.getByLabelText("Rename");
    act(() => inside.focus());
    press("j"); press("x"); press("Enter", { metaKey: true });
    expect(row("a")).not.toHaveAttribute("data-cursor");
    expect(s.onComplete).not.toHaveBeenCalled();
    const outside = screen.getByLabelText("Outside field");
    act(() => outside.focus());
    press("j");
    expect(row("a")).not.toHaveAttribute("data-cursor");
  });

  it("leaves the key after the app's “g” go-to prefix alone", () => {
    render(<List spies={spies()} />);
    press("g", {}, document.body);
    press("k", {}, document.body); // g k is the app's, not ours
    expect(row("a")).not.toHaveAttribute("data-cursor");
    press("j", {}, document.body);
    expect(row("a")).toHaveAttribute("data-cursor", "true");
  });

  it("stands aside while a menu or dialog is open", () => {
    render(<List spies={spies()} />);
    const pop = document.createElement("div");
    pop.setAttribute("aria-modal", "true");
    document.body.appendChild(pop);
    press("j", {}, document.body);
    expect(row("a")).not.toHaveAttribute("data-cursor");
    pop.remove();
  });

  it("Esc clears the cursor and the selection", () => {
    const s = spies();
    render(<List spies={s} />);
    press("j", {}, document.body); press("x");
    press("Escape");
    expect(row("a")).not.toHaveAttribute("data-cursor");
    expect(s.onClear).toHaveBeenCalled();
  });

  it("shows the hint bar after the first move, until it's dismissed for good", () => {
    const { unmount } = render(<List spies={spies()} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    press("j", {}, document.body);
    expect(screen.getByRole("note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(localStorage.getItem(HINT_DISMISSED_KEY)).toBe("1");
    unmount();
    render(<List spies={spies()} />);
    press("j", {}, document.body);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("isTypingTarget", () => {
  it("is true for text fields, not for buttons or checkboxes", () => {
    const make = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild!; };
    expect(isTypingTarget(make("<input>"))).toBe(true);
    expect(isTypingTarget(make('<input type="search">'))).toBe(true);
    expect(isTypingTarget(make("<textarea></textarea>"))).toBe(true);
    expect(isTypingTarget(make("<select></select>"))).toBe(true);
    expect(isTypingTarget(make('<input type="checkbox">'))).toBe(false);
    expect(isTypingTarget(make("<button></button>"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
