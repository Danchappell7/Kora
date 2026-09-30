import { describe, it, expect, vi } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Popover, computePopoverPosition } from "./Popover";
import { useFocusTrap } from "../../hooks/useFocusTrap";

const VIEW = { width: 1000, height: 800 };
const rect = (top: number, left: number, h = 20, w = 20) => ({ top, left, bottom: top + h, right: left + w });

describe("computePopoverPosition", () => {
  it("opens below the trigger when there's room", () => {
    const p = computePopoverPosition(rect(100, 200), { width: 150, height: 180 }, VIEW);
    expect(p.side).toBe("bottom");
    expect(p.top).toBe(126); // 100 + 20 + 6
    expect(p.left).toBe(200);
  });

  it("flips above the trigger near the bottom of the viewport", () => {
    const p = computePopoverPosition(rect(740, 200), { width: 150, height: 180 }, VIEW);
    expect(p.side).toBe("top");
    expect(p.top).toBe(740 - 6 - 180);
  });

  it("aligns to the trigger's right edge with align=end and stays inside the viewport", () => {
    expect(computePopoverPosition(rect(100, 600), { width: 150, height: 100 }, VIEW, { align: "end" }).left).toBe(620 - 150);
    // a trigger hugging the right edge can't push the panel off-screen
    expect(computePopoverPosition(rect(100, 970), { width: 150, height: 100 }, VIEW).left).toBe(1000 - 8 - 150);
    // …or the left edge
    expect(computePopoverPosition(rect(100, 2), { width: 150, height: 100 }, VIEW, { align: "end" }).left).toBe(8);
  });

  it("caps the height to the room on the chosen side so long lists scroll", () => {
    const p = computePopoverPosition(rect(300, 100), { width: 150, height: 900 }, VIEW);
    expect(p.side).toBe("bottom"); // more room below (466) than above (286)
    expect(p.maxHeight).toBe(800 - 320 - 6 - 8);
  });

  it("prefers the top for bottom bars, flipping down only when there's more room below", () => {
    expect(computePopoverPosition(rect(740, 100), { width: 150, height: 200 }, VIEW, { side: "top" }).side).toBe("top");
    expect(computePopoverPosition(rect(40, 100), { width: 150, height: 200 }, VIEW, { side: "top" }).side).toBe("bottom");
  });
});

function Harness({ onClose, onRowClick = () => {} }: { onClose?: () => void; onRowClick?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div data-testid="row" onClick={onRowClick}>
      <button ref={ref} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>Status</button>
      <Popover open={open} anchorRef={ref} onClose={() => { onClose?.(); setOpen(false); }} label="Status for “Q3 budget”">
        <button role="menuitemradio" aria-checked={false} onClick={() => setOpen(false)}>To do</button>
        <button role="menuitemradio" aria-checked={true} onClick={() => setOpen(false)}>In progress</button>
        <button onClick={() => setOpen(false)}>Done</button>
      </Popover>
    </div>
  );
}

describe("Popover", () => {
  it("renders into document.body, outside the (clipping) row", () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByText("Status"));
    const menu = screen.getByRole("menu", { name: "Status for “Q3 budget”" });
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    // plain buttons are given the menuitem role
    expect(screen.getByRole("menuitem", { name: "Done" })).toBeInTheDocument();
  });

  it("focuses the checked item, moves with arrow keys, and Escape closes and returns focus to the trigger", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByText("Status");
    fireEvent.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "In progress" })));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Done" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }); // wraps
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "To do" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes on a click outside the panel without the click reaching the row underneath", () => {
    const onClose = vi.fn(), onRowClick = vi.fn();
    render(<Harness onClose={onClose} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText("Status"));
    const layer = document.querySelector("[data-kpop]")!;
    fireEvent.click(layer);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking an item doesn't bubble (through the portal) to the row", () => {
    const onRowClick = vi.fn();
    render(<Harness onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText("Status"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Tab closes the menu instead of leaking focus out of the portal", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByText("Status"));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Done" }), { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Popover inside a focus-trapped dialog", () => {
  function TrappedDialog({ onEscape }: { onEscape: () => void }) {
    const trapRef = useFocusTrap<HTMLDivElement>(true, onEscape);
    return (
      <div ref={trapRef} role="dialog" aria-label="Edit task">
        <Harness />
      </div>
    );
  }

  it("keeps focus in the menu (the trap doesn't pull it back) and Escape closes only the menu", async () => {
    const onEscape = vi.fn();
    render(<TrappedDialog onEscape={onEscape} />);
    const trigger = screen.getByText("Status");
    fireEvent.click(trigger);
    const checked = screen.getByRole("menuitemradio", { name: "In progress" });
    await waitFor(() => expect(document.activeElement).toBe(checked));
    // the portal root opts out of every trap, whatever role the panel has
    expect(checked.closest("[data-focus-trap-ignore]")).not.toBeNull();
    fireEvent.keyDown(checked, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("Popover — long lists", () => {
  it("scrolls the checked item into view inside the panel (focus alone can't: it uses preventScroll)", async () => {
    // fake layout: a 280px panel over 30 items × 30px, the 25th of which is checked
    const ITEM = 30, PANEL_TOP = 100, PANEL_H = 280;
    const rectOf = (top: number, h: number) => ({ top, bottom: top + h, left: 0, right: 150, width: 150, height: h, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const panelOf = (el: Element) => el.closest("[data-kpop-panel]") as HTMLElement | null;
    const spies = [
      vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.hasAttribute("data-kpop-panel") ? 30 * ITEM + 10 : 0; }),
      vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.hasAttribute("data-kpop-panel") ? PANEL_H : 0; }),
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        if (this.hasAttribute("data-kpop-panel")) return rectOf(PANEL_TOP, PANEL_H);
        const i = Number(this.getAttribute("data-i"));
        const panel = panelOf(this);
        if (panel && !Number.isNaN(i)) return rectOf(PANEL_TOP + 5 + i * ITEM - panel.scrollTop, ITEM);
        return rectOf(0, 20);
      }),
    ];
    try {
      function Long() {
        const [open, setOpen] = useState(false);
        const ref = useRef<HTMLButtonElement>(null);
        return (
          <>
            <button ref={ref} onClick={() => setOpen(true)}>Assignee</button>
            <Popover open={open} anchorRef={ref} onClose={() => setOpen(false)} maxHeight={PANEL_H} label="Assignee">
              {Array.from({ length: 30 }, (_, i) => <button key={i} data-i={i} role="menuitemradio" aria-checked={i === 24}>Person {i + 1}</button>)}
            </Popover>
          </>
        );
      }
      render(<Long />);
      fireEvent.click(screen.getByText("Assignee"));
      const checked = screen.getByRole("menuitemradio", { name: "Person 25" });
      await waitFor(() => expect(document.activeElement).toBe(checked));
      const panel = screen.getByRole("menu", { name: "Assignee" });
      // item 25 starts 5 + 24×30 = 725px down the list; centred in a 280px panel → 725 − 125
      expect(panel.scrollTop).toBe(725 - (PANEL_H - ITEM) / 2);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
