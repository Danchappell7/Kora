import { describe, it, expect, vi, afterEach } from "vitest";
import { createRef, useState } from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import * as primitives from "./index";
import {
  Button, IconButton, Kbd, Tabs, Meter, StatusGlyph, PriorityGlyph, DateChip, AiMark, Provenance, Vellum,
  EmptyState, Sheet, Pill, ProjectDot, projectPaint, SectionLabel, Toggle, type TabItem,
} from "./kit";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import type { Priority, Status } from "../../data/types";

const day = (offset: number) => { const d = new Date(KANBO_TODAY); d.setDate(d.getDate() + offset); return toLocalISO(d); };
/** the coming Friday, never today (the picker reads "fri" on a Friday as next week's) */
const nextFriday = () => { const ahead = (5 - KANBO_TODAY.getDay() + 7) % 7 || 7; return day(ahead); };

afterEach(() => { vi.useRealTimers(); });

describe("primitives index", () => {
  it("re-exports every kit primitive alongside the existing ones", () => {
    for (const name of ["Button", "IconButton", "Kbd", "Tabs", "Meter", "StatusGlyph", "PriorityGlyph", "DateChip", "AiMark",
      "Provenance", "Vellum", "EmptyState", "Sheet", "Pill", "ProjectDot", "projectPaint", "SectionLabel", "Toggle",
      "Check", "Segmented", "markJustCompleted", "wasJustCompleted", "markJustLanded", "wasJustLanded"]) {
      expect(primitives, name).toHaveProperty(name);
    }
  });
});

describe("Button", () => {
  it("exposes its size and variant as data attributes and defaults to a md secondary type=button", () => {
    render(<>
      <Button>Save</Button>
      <Button variant="hero" size="lg">Plan my day</Button>
      <Button variant="ghost" size="sm">Cancel</Button>
    </>);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("data-size", "md");
    expect(save).toHaveAttribute("data-variant", "secondary");
    expect(save).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Plan my day" })).toHaveAttribute("data-size", "lg");
    expect(screen.getByRole("button", { name: "Plan my day" })).toHaveAttribute("data-variant", "hero");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("data-size", "sm");
  });

  it("keeps the shortcut hint out of its name and forwards its ref", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} variant="primary" kbd="⌘↵">Apply</Button>);
    expect(screen.getByRole("button", { name: "Apply" })).toBe(ref.current);
    expect(ref.current!.querySelector("kbd")).toHaveTextContent("⌘↵");
  });

  it("is busy, not clickable, while loading", () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Saving</Button>);
    const b = screen.getByRole("button", { name: "Saving" });
    expect(b).toHaveAttribute("aria-busy", "true");
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("IconButton", () => {
  it("uses its label as the accessible name and the tooltip, and exposes pressed", () => {
    render(<IconButton icon="filter" label="Filter" pressed />);
    const b = screen.getByRole("button", { name: "Filter" });
    expect(b).toHaveAttribute("data-tip", "Filter");
    expect(b).toHaveAttribute("aria-pressed", "true");
    expect(b).toHaveAttribute("data-size", "md");
  });

  it("says its badge count", () => {
    render(<IconButton icon="inbox" label="Inbox" badge={5} />);
    expect(screen.getByRole("button", { name: "Inbox, 5" })).toBeInTheDocument();
  });
});

describe("Kbd", () => {
  it("renders a kbd element", () => {
    render(<Kbd>⌘K</Kbd>);
    expect(screen.getByText("⌘K").tagName).toBe("KBD");
  });
});

describe("Tabs", () => {
  const items: TabItem[] = [
    { id: "open", label: "Open", count: 12 },
    { id: "waiting", label: "Waiting on", count: 3, tone: "signal" },
    { id: "archived", label: "Archived", disabled: true },
    { id: "done", label: "Done" },
  ];

  it("is a named tablist with the value selected and only that tab in the Tab order", () => {
    render(<Tabs items={items} value="waiting" onChange={() => {}} label="My tasks" />);
    expect(screen.getByRole("tablist", { name: "My tasks" })).toBeInTheDocument();
    const waiting = screen.getByRole("tab", { name: /Waiting on/ });
    expect(waiting).toHaveAttribute("aria-selected", "true");
    expect(waiting).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: /Open/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: /Open/ })).toHaveAttribute("tabindex", "-1");
  });

  it("moves and selects with the arrow keys, skipping disabled tabs, and jumps with Home/End", () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="waiting" onChange={onChange} label="My tasks" />);
    const waiting = screen.getByRole("tab", { name: /Waiting on/ });
    waiting.focus();
    fireEvent.keyDown(waiting, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("done");               // "Archived" is disabled
    expect(screen.getByRole("tab", { name: "Done" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" }); // wraps
    expect(onChange).toHaveBeenLastCalledWith("open");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("done");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("tab", { name: /Open/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(onChange).not.toHaveBeenCalledWith("archived");
  });

  it("in nav mode is a named navigation of links with aria-current, and leaves modified clicks to the browser", () => {
    const onChange = vi.fn();
    const prevented: boolean[] = [];
    // (records whether the tab prevented the click, then stops jsdom trying to navigate)
    render(<div onClick={(e) => { prevented.push(e.defaultPrevented); e.preventDefault(); }}>
      <Tabs mode="nav" label="Team" value="pulse" onChange={onChange}
        items={[{ id: "pulse", label: "Pulse", href: "/team" }, { id: "people", label: "People", href: "/team/people" }]} />
    </div>);
    const nav = screen.getByRole("navigation", { name: "Team" });
    expect(within(nav).getByRole("link", { name: "Pulse" })).toHaveAttribute("aria-current", "page");
    const people = within(nav).getByRole("link", { name: "People" });
    expect(people).not.toHaveAttribute("aria-current");
    fireEvent.click(people, { ctrlKey: true });   // left to the browser: opens a new tab
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(people);                       // routed in-app
    expect(onChange).toHaveBeenCalledWith("people");
    expect(prevented).toEqual([false, true]);
  });

  it("draws a divider before the secondary tabs and renders the trailing slot", () => {
    const { container } = render(<Tabs label="Projects" value="all" onChange={() => {}} trailing={<button>New project</button>}
      items={[{ id: "all", label: "All" }, { id: "goals", label: "Goals" }, { id: "rules", label: "Rules", secondary: true }]} />);
    expect(container.querySelectorAll(".ktabs-sep")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
  });
});

describe("Meter", () => {
  it("is a named progressbar with the right value, clamped to its range", () => {
    render(<>
      <Meter label="Launch progress" value={3} max={5} showValue />
      <Meter label="Over capacity" value={140} tone="signal" marker={100} />
    </>);
    const p = screen.getByRole("progressbar", { name: "Launch progress" });
    expect(p).toHaveAttribute("aria-valuenow", "3");
    expect(p).toHaveAttribute("aria-valuemin", "0");
    expect(p).toHaveAttribute("aria-valuemax", "5");
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Over capacity" })).toHaveAttribute("aria-valuenow", "100");
  });
});

describe("StatusGlyph", () => {
  it("is the completion checkbox: named 'Done: X', checked when done, toggles on click", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<StatusGlyph status="progress" label="Write the launch brief" onToggle={onToggle} />);
    const box = screen.getByRole("checkbox", { name: "Done: Write the launch brief" });
    expect(box).toHaveAttribute("aria-checked", "false");
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<StatusGlyph status="done" label="Write the launch brief" onToggle={onToggle} />);
    expect(screen.getByRole("checkbox", { name: "Done: Write the launch brief" })).toHaveAttribute("aria-checked", "true");
  });

  it("opens the status menu on shift-click or right-click instead of toggling, and never reaches the row", () => {
    const onToggle = vi.fn(), onPick = vi.fn(), onRow = vi.fn();
    render(<div onClick={onRow}><StatusGlyph status="todo" label="Fix login" onToggle={onToggle} onPick={onPick} /></div>);
    const box = screen.getByRole("checkbox", { name: "Done: Fix login" });
    fireEvent.click(box, { shiftKey: true });
    fireEvent.contextMenu(box);
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenCalledWith(box);
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(box);
    expect(onRow).not.toHaveBeenCalled();
  });

  it("is a labelled image when read-only", () => {
    render(<StatusGlyph status="blocked" label="Ship it" readOnly onToggle={() => {}} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("img", { name: "Blocked: Ship it" })).toBeInTheDocument();
  });

  it("gives every status its own shape, and gives each glyph its own knock-out mask", () => {
    const shape = (el: Element) => Array.from(el.querySelectorAll("svg *"))
      .map((n) => `${n.tagName}:${n.getAttribute("d") ?? ""}:${n.getAttribute("fill") === "none" ? "outline" : "filled"}`).join("|");
    const statuses: Status[] = ["todo", "progress", "review", "blocked", "done"];
    const shapes = statuses.map((s) => { const { container, unmount } = render(<StatusGlyph status={s} size={14} />); const f = shape(container); unmount(); return f; });
    expect(new Set(shapes).size).toBe(statuses.length);
    const { container } = render(<><StatusGlyph status="done" /><StatusGlyph status="done" /></>);
    const ids = Array.from(container.querySelectorAll("mask")).map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
    container.querySelectorAll("circle[mask]").forEach((c, i) => expect(c.getAttribute("mask")).toBe(`url(#${ids[i]})`));
  });
});

describe("PriorityGlyph", () => {
  it("keeps the title and data-priority, hides the drawing, and differs by shape", () => {
    const shape = (p: Priority) => { const { container, unmount } = render(<PriorityGlyph priority={p} />); const f = container.innerHTML.replace(/id="[^"]*"|url\(#[^)]*\)/g, ""); unmount(); return f; };
    const all = (["low", "medium", "high", "urgent"] as Priority[]).map(shape);
    expect(new Set(all).size).toBe(4);
    const { container } = render(<PriorityGlyph priority="urgent" withLabel />);
    expect(screen.getByTitle("Urgent priority")).toHaveAttribute("data-priority", "urgent");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Urgent")).toBeInTheDocument();
  });
});

describe("DateChip", () => {
  const open = async (props: Partial<React.ComponentProps<typeof DateChip>> = {}) => {
    const onChange = vi.fn();
    render(<DateChip label="Due date" onChange={onChange} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
    const dialog = await screen.findByRole("dialog", { name: "Due date" });
    return { onChange, dialog };
  };

  it("shows 'Add date' when empty and names itself after its label", () => {
    render(<DateChip label="Due date" onChange={() => {}} />);
    const chip = screen.getByRole("button", { name: "Due date: Add date" });
    expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("reads Today / Tomorrow and a date, and tones overdue (unless done) and today-with-a-time", () => {
    const { rerender } = render(<DateChip label="Due" value={day(0)} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Due: Today" })).toHaveAttribute("data-tone", "plain");
    rerender(<DateChip label="Due" value={day(0)} time="15:00" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Due: Today 15:00" })).toHaveAttribute("data-tone", "now");
    rerender(<DateChip label="Due" value={day(1)} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Due: Tomorrow" })).toBeInTheDocument();
    rerender(<DateChip label="Due" value={day(-3)} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /^Due: \w{3} \d{1,2} \w{3}/ })).toHaveAttribute("data-tone", "overdue");
    rerender(<DateChip label="Due" value={day(-3)} status="done" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /^Due:/ })).toHaveAttribute("data-tone", "plain");
  });

  it("is plain text when read-only, with the move history underneath", () => {
    render(<DateChip label="Due date" value={day(1)} readOnly onChange={() => {}} history={{ moves: 2, original: day(-2) }} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Tomorrow")).toBeInTheDocument();
    expect(screen.getByText(/^Moved 2× · first due \w{3} \d{1,2} \w{3}/)).toBeInTheDocument();
  });

  it("puts focus in the text field; 'fri' + Enter resolves to the next Friday and closes", async () => {
    const { onChange } = await open();
    const field = screen.getByRole("textbox", { name: "Type a due date" });
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.change(field, { target: { value: "fri" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(nextFriday(), undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("picks Tomorrow with the keyboard: ↓ into the month, → a day, Enter", async () => {
    const { onChange } = await open();
    const field = screen.getByRole("textbox", { name: "Type a due date" });
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.keyDown(field, { key: "ArrowDown" });
    const grid = screen.getByRole("grid");
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-iso", day(0)));
    expect(document.activeElement).toHaveAttribute("aria-current", "date");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-iso", day(1)));
    expect(grid).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(day(1), undefined);
  });

  it("offers quick days and No date", async () => {
    const first = await open({ value: day(3) });
    fireEvent.click(within(first.dialog).getByRole("button", { name: "Tomorrow" }));
    expect(first.onChange).toHaveBeenCalledWith(day(1), undefined);
  });

  it("clears with No date", async () => {
    const { onChange, dialog } = await open({ value: day(3), time: "09:30" });
    fireEvent.click(within(dialog).getByRole("button", { name: "No date" }));
    expect(onChange).toHaveBeenCalledWith(undefined, undefined);
  });

  it("uses the parse prop first and keeps the time unless the chip edits it", async () => {
    const parse = vi.fn(() => ({ date: "2031-01-02", time: "08:00" }));
    const { onChange } = await open({ parse, time: "10:00" });
    const field = screen.getByRole("textbox", { name: "Type a due date" });
    fireEvent.change(field, { target: { value: "launch day" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(parse).toHaveBeenCalledWith("launch day");
    expect(onChange).toHaveBeenCalledWith("2031-01-02", "10:00");
  });

  it("with a time row: '3pm' + Enter sets 15:00 on the day", async () => {
    const { onChange, dialog } = await open({ value: day(2), withTime: true });
    const time = within(dialog).getByRole("combobox", { name: "Time" });
    fireEvent.change(time, { target: { value: "3pm" } });
    fireEvent.keyDown(time, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(day(2), "15:00");
  });

  it.each([
    ["fri 3pm", () => [nextFriday(), "15:00"]],
    ["tomorrow at 9.30", () => [day(1), "09:30"]],
    ["in 2 weeks", () => [day(14), undefined]],
    [(() => { const d = new Date(KANBO_TODAY); d.setDate(d.getDate() + 10); return `${d.getDate()}/${d.getMonth() + 1}`; })(), () => [day(10), undefined]],
    [(() => { const d = new Date(KANBO_TODAY); d.setDate(d.getDate() + 20); return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`; })(), () => [day(20), undefined]],
  ])("reads '%s' in the field", async (text, expected) => {
    const { onChange } = await open({ withTime: true });
    const field = screen.getByRole("textbox", { name: "Type a due date" });
    fireEvent.change(field, { target: { value: text } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(...expected());
  });

  it("says when it can't read the text, and Enter then does nothing", async () => {
    const { onChange, dialog } = await open();
    const field = screen.getByRole("textbox", { name: "Type a due date" });
    fireEvent.change(field, { target: { value: "whenever" } });
    expect(within(dialog).getByText("No date matches that yet")).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Due date" })).toBeInTheDocument();
  });
});

describe("AiMark", () => {
  it("gives every instance its own gradient id (no black blocks)", () => {
    const { container } = render(<><AiMark /><AiMark size={16} thinking /></>);
    const grads = Array.from(container.querySelectorAll("linearGradient"));
    expect(grads).toHaveLength(2);
    expect(grads[0].id).not.toBe(grads[1].id);
    container.querySelectorAll("svg").forEach((svg, i) => {
      svg.querySelectorAll("rect").forEach((r) => expect(r.getAttribute("fill")).toBe(`url(#${grads[i].id})`));
    });
  });

  it("is decorative unless titled", () => {
    const { container } = render(<><AiMark /><AiMark title="Written by Kanbo" /></>);
    expect(container.querySelector(".kaimark-wrap")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("img", { name: "Written by Kanbo" })).toBeInTheDocument();
  });
});

describe("Provenance and Vellum", () => {
  it("expands the facts behind an answer", () => {
    render(<Vellum provenance={{ summary: "from 41 tasks and 18 changes", details: ["3 tasks due today", "Maya is at 120%"] }}>Start with the launch deck.</Vellum>);
    const toggle = screen.getByRole("button", { name: "How I got here · from 41 tasks and 18 changes" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("3 tasks due today")).not.toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("3 tasks due today")).toBeVisible();
  });

  it("is a plain line without details", () => {
    render(<Provenance summary="from your calendar" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("How I got here · from your calendar")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders the title, help and the action inside", () => {
    render(<EmptyState art="inbox" title="Inbox zero" body="Nothing needs you." action={<Button>Plan tomorrow</Button>} />);
    expect(screen.getByText("Inbox zero")).toBeInTheDocument();
    expect(screen.getByText("Nothing needs you.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan tomorrow" })).toBeInTheDocument();
  });
});

describe("Sheet", () => {
  function Harness({ onClose = () => {} }: { onClose?: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Sheet open={open} onClose={() => { onClose(); setOpen(false); }} label="Shut down my day" title="Shut down"
          footer={<Button variant="primary">Close the day</Button>}>
          <p>Three things moved.</p>
        </Sheet>
      </>
    );
  }

  it("is a labelled modal dialog with a title, Close and footer actions; focus goes inside", async () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Shut down my day" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { name: "Shut down" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close the day" })).toBeInTheDocument();
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
  });

  it("closes on Escape, on Close and on the scrim, and leaves the tree straight away", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Shut down my day" });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull(); // (the exit fade is aria-hidden)
    await waitFor(() => expect(screen.queryByText("Three things moved.")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    rerender(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const layer = document.querySelector(".ksheet-layer")!;
    fireEvent.mouseDown(layer);
    fireEvent.click(layer);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("a bottom sheet drags down by its handle: a short pull springs back, a long one closes", () => {
    // jsdom has no PointerEvent: a MouseEvent with a pointerId carries clientY and button
    const had = "PointerEvent" in window;
    if (!had) {
      (window as unknown as { PointerEvent: unknown }).PointerEvent = class extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
      };
    }
    const onClose = vi.fn();
    render(<Sheet open onClose={onClose} label="Quick capture" side="bottom"><p>Body</p></Sheet>);
    const sheet = screen.getByRole("dialog", { name: "Quick capture" });
    const handle = sheet.querySelector(".ksheet-handle")!;
    fireEvent.pointerDown(handle, { button: 0, clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 430, pointerId: 1 });
    expect(sheet.style.translate).toBe("0 30px");
    fireEvent.pointerMove(handle, { clientY: 380, pointerId: 1 }); // never lifts above its edge
    expect(sheet.style.translate).toBe("0 0px");
    fireEvent.pointerUp(handle, { clientY: 380, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.translate).toBe("");
    fireEvent.pointerDown(handle, { button: 0, clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 700, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 700, pointerId: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
    if (!had) delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
  });

  it("a drag-close carries on down from where it was let go; an owner that keeps it open gets it back at rest", () => {
    const had = "PointerEvent" in window;
    if (!had) {
      (window as unknown as { PointerEvent: unknown }).PointerEvent = class extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
      };
    }
    vi.useFakeTimers();
    try {
      const pull = (sheet: HTMLElement, dy: number) => {
        const handle = sheet.querySelector(".ksheet-handle")!;
        fireEvent.pointerDown(handle, { button: 0, clientY: 100, pointerId: 1 });
        fireEvent.pointerMove(handle, { clientY: 100 + dy, pointerId: 1 });
        fireEvent.pointerUp(handle, { clientY: 100 + dy, pointerId: 1 });
      };
      function Closes() {
        const [open, setOpen] = useState(true);
        return <Sheet open={open} onClose={() => setOpen(false)} label="Quick capture" side="bottom"><p>Body</p></Sheet>;
      }
      const { unmount } = render(<Closes />);
      const leaving = screen.getByRole("dialog", { name: "Quick capture" });
      pull(leaving, 150);
      // the exit fade starts where the finger let go and travels on from there (ksheetOutDown reads --drag-y)
      expect(document.querySelector(".ksheet-layer")).toHaveAttribute("data-state", "closing");
      expect(leaving.style.translate).toBe("0 150px");
      expect(leaving.style.getPropertyValue("--drag-y")).toBe("150px");
      unmount();

      // a "discard changes?" guard: onClose declines
      render(<Sheet open onClose={() => {}} label="New task" side="bottom"><p>Body</p></Sheet>);
      const kept = screen.getByRole("dialog", { name: "New task" });
      pull(kept, 300);
      act(() => { vi.advanceTimersByTime(0); });
      expect(kept.style.translate).toBe("");
      expect(kept.style.getPropertyValue("--drag-y")).toBe("");
      expect(kept).toHaveAttribute("data-settling", "true");
      act(() => { vi.advanceTimersByTime(200); });
      expect(kept).not.toHaveAttribute("data-settling");
    } finally {
      vi.useRealTimers();
      if (!had) delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
    }
  });

  it("focuses initialFocus when given", async () => {
    function WithFocus() {
      const ref = createRef<HTMLInputElement>();
      return <Sheet open onClose={() => {}} label="Rename" initialFocus={ref}><button>First</button><input ref={ref} aria-label="Name" /></Sheet>;
    }
    render(<WithFocus />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus());
  });
});

describe("Pill", () => {
  it("is a button only when it does something", () => {
    const onClick = vi.fn();
    render(<><Pill tone="warn">At risk</Pill><Pill tone="signal" onClick={onClick}>2 blocked</Pill></>);
    expect(screen.getByText("At risk").tagName).toBe("SPAN");
    fireEvent.click(screen.getByRole("button", { name: "2 blocked" }));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByText("At risk")).toHaveAttribute("data-tone", "warn");
  });
});

describe("projectPaint and ProjectDot", () => {
  it("keeps the hue, clamps the chroma and uses the theme's identity lightness", () => {
    expect(projectPaint("oklch(0.74 0.14 230)").solid).toBe("oklch(var(--pl, 0.62) 0.14 230)");
    expect(projectPaint("oklch(0.66 0.26 20)").solid).toBe("oklch(var(--pl, 0.62) 0.16 20)");   // too loud
    expect(projectPaint("oklch(0.78 0.05 45)").solid).toBe("oklch(var(--pl, 0.62) 0.08 45)");   // too timid
    expect(projectPaint("oklch(0.7 0.02 240)").solid).toBe("oklch(var(--pl, 0.62) 0.02 240)");  // a chosen grey stays grey
    expect(projectPaint("oklch(0.74 0.14 230)").tint).toBe("oklch(var(--pl, 0.62) 0.14 230 / 0.14)");
  });

  it("reads hex colours (project templates) by their real hue, and falls back to the brand hue", () => {
    const hue = (s: string) => +s.match(/ ([\d.]+)\)$/)![1];
    expect(hue(projectPaint("#e5544b").solid)).toBeGreaterThan(20);
    expect(hue(projectPaint("#e5544b").solid)).toBeLessThan(35);   // red
    expect(hue(projectPaint("#37c6a8").solid)).toBeGreaterThan(165);
    expect(hue(projectPaint("#37c6a8").solid)).toBeLessThan(185);  // teal
    expect(projectPaint("not a colour").solid).toBe("oklch(var(--pl, 0.62) 0.12 268)");
  });

  it("is decorative unless titled", () => {
    const { container } = render(<><ProjectDot color="#8B5CF6" /><ProjectDot color="oklch(0.74 0.14 230)" title="Q3 Product Launch" shape="dot" size={10} /></>);
    expect(container.querySelector(".kpdot")).toHaveAttribute("aria-hidden", "true");
    const dot = screen.getByRole("img", { name: "Q3 Product Launch" });
    expect(dot).toHaveStyle({ width: "10px", height: "10px", borderRadius: "50%" });
  });
});

describe("SectionLabel", () => {
  it("is a heading with its count, and an action beside it", () => {
    render(<SectionLabel count={3} tone="signal" id="g-overdue" action={<button>Reschedule</button>}>Overdue</SectionLabel>);
    const h = screen.getByRole("heading", { name: "Overdue 3" });
    expect(h).toHaveAttribute("id", "g-overdue");
    expect(screen.getByRole("button", { name: "Reschedule" })).toBeInTheDocument();
  });
});

describe("Toggle", () => {
  it("is a switch named by its label and described by its description", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Suggested plan" description="Kanbo drafts your day as dashed blocks." />);
    const sw = screen.getByRole("switch", { name: "Suggested plan" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveAccessibleDescription("Kanbo drafts your day as dashed blocks.");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText("Suggested plan")); // the label toggles too
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("does nothing when disabled", () => {
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} label="Kanbo AI" disabled />);
    fireEvent.click(screen.getByRole("switch", { name: "Kanbo AI" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
