import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { QuickAddSheet, resetQuickAddMemory, type QuickAddSheetProps } from "./QuickAddSheet";
import { refreshClock } from "../data/data";

// Friday 9 October 2026, mid-morning, London
const NOW = new Date("2026-10-09T10:00:00+01:00");
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); refreshClock(NOW); });
afterAll(() => { vi.useRealTimers(); refreshClock(new Date()); });
beforeEach(() => resetQuickAddMemory());

const projects: QuickAddSheetProps["projects"] = [
  { id: "p-launch", name: "Launch", color: "#5b5bd6", emoji: "🚀", workspaceId: "w1" },
  { id: "p-hire", name: "Hiring", color: "#2a9d8f", emoji: "", workspaceId: "w1" },
  { id: "p-web", name: "Website", color: "#e76f51", emoji: "", workspaceId: "w1" },
  { id: "p-ops", name: "Office", color: "#264653", emoji: "", workspaceId: "w1" },
  { id: "p-fin", name: "Finance", color: "#e9c46a", emoji: "", workspaceId: "w1" },
  { id: "p-eng", name: "Engineering", color: "#8ab17d", emoji: "", workspaceId: "w1" },
  { id: "p-old", name: "Archive box", color: "#999999", emoji: "", workspaceId: "w1" },
];
const members = [{ id: "m-1", name: "Sana Rao" }, { id: "m-self", name: "Dan Okai" }];

function Host(extra: Partial<QuickAddSheetProps> & { startOpen?: boolean }) {
  const { startOpen = true, ...rest } = extra;
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open quick add</button>
      <QuickAddSheet open={open} onClose={() => setOpen(false)} projects={projects} members={members} currentUserId="m-self"
        recentProjectIds={["p-hire", "p-web", "p-ops", "p-fin", "p-eng", "p-old"]} onCreate={vi.fn()} {...rest} />
    </>
  );
}
const field = () => screen.getByRole("textbox", { name: "Task, in your own words" });
const type = (v: string) => fireEvent.change(field(), { target: { value: v } });
const dialog = () => screen.getByRole("dialog", { name: "Quick add a task" });

describe("QuickAddSheet", () => {
  it("opens as a labelled dialog with the big field focused, and nothing to add yet", () => {
    render(<Host />);
    expect(dialog()).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add and keep going" })).toBeDisabled();
  });

  it("highlights what it read as you type, and Enter adds it and closes", () => {
    const onCreate = vi.fn();
    render(<Host onCreate={onCreate} />);
    type("Call @sana tomorrow 3pm #launch !high");
    const read = screen.getByRole("group", { name: "What Kanbo read" });
    const toks = within(read).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(toks).toEqual([
      "For: Sana Rao. Keep “@sana” as words instead",
      "Due: Sat 10 Oct. Keep “tomorrow” as words instead",
      "At: 15:00. Keep “3pm” as words instead",
      "Project: Launch. Keep “#launch” as words instead",
      "High priority. Keep “!high” as words instead",
    ]);
    // the field's mirror marks the same words
    const marks = Array.from(dialog().querySelectorAll(".kqa-mark")).map((m) => m.textContent);
    expect(marks).toEqual(["@sana", "tomorrow", "3pm", "#launch", "!high"]);
    // the typed project is the chosen one
    expect(screen.getByRole("button", { name: "Launch" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith({ title: "Call", priority: "high", status: "todo", dueDate: "2026-10-10", dueTime: "15:00", assigneeId: "m-1", projectId: "p-launch" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tap a token to keep it as words; the dashed chip reads it again", () => {
    const onCreate = vi.fn();
    render(<Host onCreate={onCreate} />);
    type("Book drinks friday");
    fireEvent.click(screen.getByRole("button", { name: /Keep “friday” as words instead/ }));
    const kept = screen.getByRole("button", { name: "“friday” stays as words. Read it as a due date again" });
    expect(kept).toHaveTextContent("“friday” as words");
    expect(field()).toHaveFocus();
    fireEvent.click(kept);
    expect(screen.getByRole("button", { name: /Keep “friday” as words instead/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Keep “friday” as words instead/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    expect(onCreate).toHaveBeenCalledWith({ title: "Book drinks friday", priority: "medium", status: "todo" });
  });

  it("project chips: the project you're in first, then recent ones (five at most); a tap picks one", () => {
    const onCreate = vi.fn();
    render(<Host onCreate={onCreate} defaultProjectId="p-launch" />);
    const group = screen.getByRole("group", { name: "Project" });
    const chips = within(group).getAllByRole("button").map((b) => b.textContent);
    expect(chips).toEqual(["🚀Launch", "HHiring", "WWebsite", "OOffice", "FFinance", "All projects"]);
    expect(within(group).getByRole("button", { name: /Launch/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: /Website/ }));
    expect(within(group).getByRole("button", { name: /Website/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: /Launch/ })).toHaveAttribute("aria-pressed", "false");
    type("Update the footer");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Update the footer", projectId: "p-web" }));
  });

  it("a chip takes over from a typed #project (the token leaves the text)", () => {
    render(<Host />);
    type("Fix login #launch");
    fireEvent.click(screen.getByRole("button", { name: /Hiring/ }));
    expect(field()).toHaveValue("Fix login");
    expect(screen.getByRole("button", { name: /Hiring/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("All projects lists the rest", () => {
    const onCreate = vi.fn();
    render(<Host onCreate={onCreate} />);
    const more = screen.getByRole("button", { name: "All projects" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    const all = screen.getByRole("group", { name: "All projects" });
    expect(within(all).getAllByRole("button").map((b) => b.textContent)).toEqual(["🚀Launch", "AArchive box"]);
    fireEvent.click(within(all).getByRole("button", { name: /Archive box/ }));
    expect(screen.queryByRole("group", { name: "All projects" })).toBeNull();
    // the picked one shows as a chip now
    expect(screen.getByRole("button", { name: /Archive box/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("Add and keep going clears the field, says what was added, and stays open", () => {
    const onCreate = vi.fn();
    render(<Host onCreate={onCreate} />);
    type("Order business cards");
    fireEvent.click(screen.getByRole("button", { name: "Add and keep going" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Order business cards" }));
    expect(field()).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("Added “Order business cards”. Say or type the next one.");
    expect(dialog()).toBeInTheDocument();
    // ⇧↵ does the same from the keyboard
    type("Book the room");
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeInTheDocument();
  });

  it("is kind to dictation: a closing full stop and a spoken new line don't reach the title", () => {
    const onCreate = vi.fn();
    render(<Host onCreate={onCreate} />);
    type("Call the bank\nabout the loan tomorrow at 3 p.m.");
    expect(field()).toHaveValue("Call the bank about the loan tomorrow at 3 p.m.");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Call the bank about the loan", dueDate: "2026-10-10", dueTime: "15:00" }));
  });

  it("Enter while composing (IME, dictation in progress) doesn't add", () => {
    const onCreate = vi.fn();
    render(<Host onCreate={onCreate} />);
    type("Draft");
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("Escape closes at once, focus goes back, and the unsent draft is there next time", async () => {
    render(<Host startOpen={false} />);
    const opener = screen.getByRole("button", { name: "Open quick add" });
    opener.focus();
    fireEvent.click(opener);
    type("Half a thought");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
    fireEvent.click(opener);
    expect(field()).toHaveValue("Half a thought");
  });

  it("says what it will make, for screen readers", () => {
    render(<Host defaultProjectId="p-hire" />);
    type("Interview @dan tomorrow");
    const live = dialog().querySelector("[aria-live='polite']")!;
    expect(live.textContent).toBe("Due Sat 10 Oct · In Hiring · For you");
  });

  it("with no projects there are no project chips", () => {
    render(<Host projects={[]} recentProjectIds={[]} />);
    expect(screen.queryByRole("group", { name: "Project" })).toBeNull();
  });
});
