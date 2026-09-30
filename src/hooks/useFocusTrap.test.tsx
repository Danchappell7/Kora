import { describe, it, expect, vi } from "vitest";
import { useLayoutEffect, useRef, useState } from "react";
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

  it("restores focus to the opener even when a control inside took focus with autoFocus", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    function Auto() {
      const ref = useFocusTrap<HTMLDivElement>(true);
      // eslint-disable-next-line jsx-a11y/no-autofocus
      return <div ref={ref} role="dialog" aria-label="Auto"><input aria-label="Name" autoFocus /></div>;
    }
    const { unmount } = render(<Auto />);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("hands focus back to a menu's trigger when the menu item that opened it has gone", () => {
    function MenuItem({ onPick, trigger }: { onPick: () => void; trigger: React.RefObject<HTMLButtonElement> }) {
      // like a popover handing focus back to its trigger as it closes
      useLayoutEffect(() => () => trigger.current?.focus(), [trigger]);
      return <div role="menu"><button role="menuitem" onClick={onPick}>Manage tags</button></div>;
    }
    function Dlg({ onClose }: { onClose: () => void }) {
      const ref = useFocusTrap<HTMLDivElement>(true, onClose);
      return <div ref={ref} role="dialog" aria-label="Tags"><button data-autofocus onClick={onClose}>Done</button></div>;
    }
    function Page() {
      const [open, setOpen] = useState(false);
      const trigger = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={trigger}>Menu</button>
          {!open && <MenuItem trigger={trigger} onPick={() => setOpen(true)} />}
          {open && <Dlg onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Page />);
    const item = screen.getByRole("menuitem", { name: "Manage tags" });
    act(() => item.focus());
    fireEvent.click(item);
    expect(screen.getByText("Done")).toHaveFocus();
    fireEvent.click(screen.getByText("Done"));
    expect(screen.getByText("Menu")).toHaveFocus();
  });

  it("marks an Escape it acts on as handled, so App's window handler leaves it alone", () => {
    const onEsc = vi.fn();
    render(<Harness onEsc={onEsc} />);
    const name = screen.getByLabelText("Name");
    act(() => name.focus());
    expect(fireEvent.keyDown(name, { key: "Escape" })).toBe(false);          // left the field
    expect(fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })).toBe(false);   // closed
    expect(onEsc).toHaveBeenCalledTimes(1);
  });

  it("takes Escape for the top dialog when focus has dropped onto the page", () => {
    const onEsc = vi.fn();
    render(<Harness onEsc={onEsc} />);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onEsc).toHaveBeenCalledTimes(1);
    // …but not while one of App's own (untrapped) overlays is open over it
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    document.body.appendChild(overlay);
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
    expect(onEsc).toHaveBeenCalledTimes(1);
    overlay.remove();
  });
});

describe("useFocusTrap — { fieldEscape: 'dialog' }", () => {
  function Staged({ onEsc, onBlur }: { onEsc: () => void; onBlur: () => void }) {
    const ref = useFocusTrap<HTMLDivElement>(true, onEsc, { fieldEscape: "dialog" });
    return (
      <div ref={ref} role="dialog" aria-label="Staged">
        <input aria-label="Rename" onBlur={onBlur} />
        <button>Done</button>
      </div>
    );
  }

  it("hands Escape in a field straight to onEscape without moving focus (no blur, so nothing commits)", () => {
    const onEsc = vi.fn(), onBlur = vi.fn();
    render(<Staged onEsc={onEsc} onBlur={onBlur} />);
    const input = screen.getByLabelText("Rename");
    act(() => input.focus());
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(onEsc).toHaveBeenCalledTimes(1);
    expect(input).toHaveFocus();
    expect(onBlur).not.toHaveBeenCalled();
  });
});

describe("useFocusTrap — stacked dialogs", () => {
  function Dialog({ name, autoFocusField }: { name: string; autoFocusField?: boolean }) {
    const ref = useFocusTrap<HTMLDivElement>(true);
    return (
      <div ref={ref} role="dialog" aria-modal="true" aria-label={name}>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input aria-label={`${name} field`} autoFocus={autoFocusField} />
        <button data-autofocus>{`${name} start`}</button>
      </div>
    );
  }

  it("leaves focus to the dialog on top when two open together, then hands it back when that one closes", () => {
    const Both = ({ top }: { top: boolean }) => (
      <>
        <Dialog name="Lower" />
        {top && <Dialog name="Upper" autoFocusField />}
      </>
    );
    const { rerender } = render(<Both top />);
    expect(screen.getByLabelText("Upper field")).toHaveFocus();
    rerender(<Both top={false} />);
    expect(screen.getByText("Lower start")).toHaveFocus();
  });

  it("returns focus to the control you were on in the dialog underneath", () => {
    const Both = ({ top }: { top: boolean }) => (
      <>
        <Dialog name="Lower" />
        {top && <Dialog name="Upper" />}
      </>
    );
    const { rerender } = render(<Both top={false} />);
    const field = screen.getByLabelText("Lower field");
    act(() => field.focus());
    rerender(<Both top />);
    expect(screen.getByText("Upper start")).toHaveFocus();
    rerender(<Both top={false} />);
    expect(field).toHaveFocus();
  });

  // The command palette's actions do this: onAction(…) then onClose() in one
  // batched update, so the palette closes in the same commit New task opens.
  it("when one dialog is swapped for another in one update, focus still goes back to where you started", () => {
    function Swap() {
      const [palette, setPalette] = useState(false);
      const [next, setNext] = useState(false);
      const paletteRef = useFocusTrap<HTMLDivElement>(palette);
      const nextRef = useFocusTrap<HTMLDivElement>(next, () => setNext(false));
      return (
        <>
          <button onClick={() => setPalette(true)}>Board card</button>
          {palette && (
            <div ref={paletteRef} role="dialog" aria-modal="true" aria-label="Palette">
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input aria-label="Search" autoFocus onKeyDown={(e) => { if (e.key === "Enter") { setNext(true); setPalette(false); } }} />
            </div>
          )}
          {next && (
            <div ref={nextRef} role="dialog" aria-modal="true" aria-label="New task">
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input aria-label="Task title" autoFocus />
              <button onClick={() => setNext(false)}>Cancel</button>
            </div>
          )}
        </>
      );
    }
    render(<Swap />);
    const card = screen.getByText("Board card");
    act(() => card.focus());
    fireEvent.click(card);
    const search = screen.getByLabelText("Search");
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Palette" })).toBeNull();
    expect(screen.getByLabelText("Task title")).toHaveFocus();
    fireEvent.click(screen.getByText("Cancel"));
    expect(card).toHaveFocus();
  });

  it("swapping dialogs on top of another dialog hands focus back to the control you were on underneath", () => {
    function Swap() {
      const [palette, setPalette] = useState(false);
      const [next, setNext] = useState(false);
      const baseRef = useFocusTrap<HTMLDivElement>(true);
      const paletteRef = useFocusTrap<HTMLDivElement>(palette);
      const nextRef = useFocusTrap<HTMLDivElement>(next, () => setNext(false));
      return (
        <>
          <div ref={baseRef} role="dialog" aria-modal="true" aria-label="Task">
            <button>Task start</button>
            <button onClick={() => setPalette(true)}>More</button>
          </div>
          {palette && (
            <div ref={paletteRef} role="dialog" aria-modal="true" aria-label="Palette">
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input aria-label="Search" autoFocus onKeyDown={(e) => { if (e.key === "Enter") { setNext(true); setPalette(false); } }} />
            </div>
          )}
          {next && (
            <div ref={nextRef} role="dialog" aria-modal="true" aria-label="Confirm">
              <button data-autofocus onClick={() => setNext(false)}>Cancel</button>
            </div>
          )}
        </>
      );
    }
    render(<Swap />);
    const more = screen.getByText("More");
    act(() => more.focus());
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Enter" });
    expect(screen.getByText("Cancel")).toHaveFocus();
    fireEvent.click(screen.getByText("Cancel"));
    expect(more).toHaveFocus();
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
