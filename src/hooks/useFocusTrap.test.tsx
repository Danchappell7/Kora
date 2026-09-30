import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useFocusTrap, isEditableTarget } from "./useFocusTrap";

function Harness({ onEsc, autofocus }: { onEsc: () => void; autofocus?: boolean }) {
  const ref = useFocusTrap<HTMLDivElement>(true, onEsc);
  return (
    <div>
      <button>Behind</button>
      <div ref={ref} role="dialog" aria-label="Trap">
        <input aria-label="Name" />
        {/* a field that handles Escape itself (e.g. closes its own menu) */}
        <input aria-label="Search" onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation(); }} />
        <select aria-label="Pick"><option>a</option></select>
        <input type="checkbox" aria-label="Tick" />
        <button data-autofocus={autofocus ? "" : undefined}>Inside</button>
      </div>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("leaves Escape in a text field, textarea or select to the field", () => {
    const onEsc = vi.fn();
    render(<Harness onEsc={onEsc} />);
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    fireEvent.keyDown(screen.getByLabelText("Pick"), { key: "Escape" });
    expect(onEsc).not.toHaveBeenCalled();
  });

  it("the first Escape in a field leaves it; the next closes", () => {
    const onEsc = vi.fn();
    render(<Harness onEsc={onEsc} />);
    const name = screen.getByLabelText("Name");
    act(() => name.focus());
    fireEvent.keyDown(name, { key: "Escape" });
    expect(onEsc).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onEsc).toHaveBeenCalledTimes(1);
  });

  it("lets a field that handles Escape itself keep it (React handlers run first)", () => {
    const onEsc = vi.fn();
    render(<Harness onEsc={onEsc} />);
    const search = screen.getByLabelText("Search");
    act(() => search.focus());
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onEsc).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search);
  });

  it("Tab from the parked dialog carries on after the field you left", () => {
    // jsdom has no layout, so every element looks hidden (offsetParent null) — pretend otherwise
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get() { return (this as HTMLElement).parentElement; } });
    try {
      render(<Harness onEsc={() => {}} />);
      const name = screen.getByLabelText("Name");
      act(() => name.focus());
      fireEvent.keyDown(name, { key: "Escape" });
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
      expect(document.activeElement).toBe(screen.getByLabelText("Search"));
      act(() => name.focus());
      fireEvent.keyDown(name, { key: "Escape" });
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(screen.getByText("Inside"));   // wraps back to the end
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "offsetParent", desc);
    }
  });

  it("closes on Escape from a button or checkbox", () => {
    const onEsc = vi.fn();
    render(<Harness onEsc={onEsc} />);
    fireEvent.keyDown(screen.getByText("Inside"), { key: "Escape" });
    fireEvent.keyDown(screen.getByLabelText("Tick"), { key: "Escape" });
    expect(onEsc).toHaveBeenCalledTimes(2);
  });

  it("ignores an Escape something already handled (defaultPrevented)", () => {
    const onEsc = vi.fn();
    render(<Harness onEsc={onEsc} />);
    const btn = screen.getByText("Inside");
    const handled = (e: Event) => e.preventDefault();
    document.addEventListener("keydown", handled, true);   // capture: runs before the trap
    fireEvent.keyDown(btn, { key: "Escape" });
    document.removeEventListener("keydown", handled, true);
    expect(onEsc).not.toHaveBeenCalled();
  });

  it("moves focus inside on open, preferring [data-autofocus]", () => {
    render(<Harness onEsc={() => {}} autofocus />);
    expect(document.activeElement).toBe(screen.getByText("Inside"));
  });

  it("pulls focus back when it escapes to the page behind", () => {
    render(<Harness onEsc={() => {}} autofocus />);
    const name = screen.getByLabelText("Name");
    act(() => name.focus());
    act(() => screen.getByText("Behind").focus());
    expect(document.activeElement).toBe(name);
  });

  it("restores focus to where it was when the trap closes", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<Harness onEsc={() => {}} autofocus />);
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("isEditableTarget", () => {
  it("treats typing and picking fields as editable, buttons and checkboxes not", () => {
    const make = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; };
    expect(isEditableTarget(make("<input>"))).toBe(true);
    expect(isEditableTarget(make('<input type="date">'))).toBe(true);
    expect(isEditableTarget(make("<textarea></textarea>"))).toBe(true);
    expect(isEditableTarget(make("<select></select>"))).toBe(true);
    expect(isEditableTarget(make('<input type="checkbox">'))).toBe(false);
    expect(isEditableTarget(make("<button></button>"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
