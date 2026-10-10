import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { TemplatePicker } from "./TemplatePicker";
import { LIBRARY_BUILTINS } from "../../lib/templates";
import type { LibraryTemplate } from "../../data/types";

const mine: LibraryTemplate = {
  id: "m1", workspaceId: null, userId: "me", name: "Monthly invoices", emoji: "💷", shared: false, createdAt: "", updatedAt: "",
  body: { title: "Send invoices", subtasks: [{ title: "Export hours", offsetDays: 0 }] },
};

function Host({ onPick = vi.fn(), onHostKey = vi.fn(), templates = [mine, ...LIBRARY_BUILTINS] }: {
  onPick?: (t: LibraryTemplate) => void; onHostKey?: (key: string) => void; templates?: readonly LibraryTemplate[];
}) {
  const [text, setText] = useState("/");
  const [open, setOpen] = useState(true);
  return (
    <div>
      <input id="field" aria-label="Title" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => onHostKey(e.key)} />
      {open && text.startsWith("/") && (
        <TemplatePicker query={text.slice(1)} templates={templates} inputId="field" currentUserId="me"
          onPick={onPick} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
const field = () => screen.getByRole("textbox", { name: "Title" });
const options = () => screen.queryAllByRole("option");

describe("TemplatePicker", () => {
  it("lists the matches as a listbox the field controls, with its count announced", () => {
    render(<Host />);
    expect(screen.getByRole("listbox", { name: "Templates" })).toBeInTheDocument();
    expect(options()).toHaveLength(9);
    expect(field()).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    expect(field()).toHaveAttribute("aria-autocomplete", "list");
    expect(field()).toHaveAttribute("aria-activedescendant", options()[0].id);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/9 templates\. Up and down/)).toBeInTheDocument();
    // where each one's from (yours carry no label)
    expect(options()[0]).not.toHaveTextContent("Built-in");
    expect(options()[1]).toHaveTextContent("Built-in");
  });
  it("narrows as you type (fuzzy), ↑/↓ move, Enter picks — without the host's Enter running", () => {
    const onPick = vi.fn(), onHostKey = vi.fn();
    render(<Host onPick={onPick} onHostKey={onHostKey} />);
    fireEvent.change(field(), { target: { value: "/rep" } });
    expect(options().map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Weekly report")]));
    const firstName = options()[0].querySelector(".ktpl-pick-name")!.textContent;
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(field()).toHaveAttribute("aria-activedescendant", options()[1].id);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    fireEvent.keyDown(field(), { key: "ArrowUp" });   // wraps to the last
    expect(options()[options().length - 1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field(), { key: "ArrowDown" });  // and back round to the first
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].name).toBe(firstName);
    expect(onHostKey).not.toHaveBeenCalledWith("Enter");
    expect(onHostKey).not.toHaveBeenCalledWith("ArrowDown");
  });
  it("a click picks (and doesn't take focus from the field)", () => {
    const onPick = vi.fn();
    render(<Host onPick={onPick} />);
    field().focus();
    const opt = screen.getByRole("option", { name: /Bug report/ });
    const down = fireEvent.mouseDown(opt);
    expect(down).toBe(false); // default prevented: the field keeps focus
    fireEvent.click(opt);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "builtin-lib-bug-report" }));
  });
  it("Escape closes it (the text stays) and gives the field its attributes back", () => {
    const onHostKey = vi.fn();
    render(<Host onHostKey={onHostKey} />);
    fireEvent.change(field(), { target: { value: "/bug" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("/bug");
    expect(field()).not.toHaveAttribute("aria-controls");
    expect(field()).not.toHaveAttribute("aria-activedescendant");
    expect(onHostKey).not.toHaveBeenCalledWith("Escape");
  });
  it("nothing matches: says so, and Enter is the host's again", () => {
    const onPick = vi.fn(), onHostKey = vi.fn();
    render(<Host onPick={onPick} onHostKey={onHostKey} />);
    fireEvent.change(field(), { target: { value: "/zzzz" } });
    expect(options()).toHaveLength(0);
    expect(screen.getAllByText("No templates match “zzzz”.").length).toBeGreaterThan(0);
    expect(field()).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(onHostKey).toHaveBeenCalledWith("Enter");
  });
  it("says it's loading while the library's on its way", () => {
    render(<div><input id="f" aria-label="x" /><TemplatePicker query="" templates={[]} inputId="f" loading onPick={vi.fn()} onClose={vi.fn()} /></div>);
    expect(screen.getAllByText("Loading templates…").length).toBeGreaterThan(0);
  });
});
