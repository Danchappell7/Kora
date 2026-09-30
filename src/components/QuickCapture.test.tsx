import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { QuickCapture } from "./QuickCapture";
import { KANBO_TODAY, toLocalISO } from "../data/data";
import type { ImportRow } from "../lib/importTasks";
import type { Task } from "../data/types";

const PROJECTS = [
  { id: "p-launch", name: "Q3 Product Launch", color: "oklch(0.7 0.15 230)" },
  { id: "p-brand", name: "Brand Refresh", color: "oklch(0.7 0.15 305)" },
];
const MEMBERS = [
  { id: "m-1", name: "Maya Lin" },
  { id: "m-3", name: "Sana Rao" },
];

/** the next Friday strictly after today, as the grammar reads a bare "fri" */
const nextFriday = () => {
  const d = new Date(KANBO_TODAY);
  const ahead = (5 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + ahead);
  return toLocalISO(d);
};

function Harness({ onCreate = vi.fn(), onPasteNotes, onImportRows, onOpenImport, defaultProjectId }: {
  onCreate?: (t: Partial<Task> & { title: string }) => void;
  onPasteNotes?: (text: string) => void;
  onImportRows?: (rows: ImportRow[]) => void;
  onOpenImport?: (text: string) => void;
  defaultProjectId?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <QuickCapture open={open} onClose={() => setOpen(false)} projects={PROJECTS} members={MEMBERS} tags={{}}
        defaultProjectId={defaultProjectId} onCreate={onCreate} onPasteNotes={onPasteNotes} onImportRows={onImportRows} onOpenImport={onOpenImport} />
    </>
  );
}

const field = () => screen.getByRole("textbox", { name: "Quick capture a task" }) as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(field(), { target: { value: v } });
const marks = () => Array.from(document.querySelectorAll(".ktok-mark")).map((m) => [m.textContent, m.getAttribute("data-kind")]);

const spies: { mockRestore: () => void }[] = [];
afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); });

describe("QuickCapture", () => {
  it("highlights each token it reads, in place, and confirms it as a chip", () => {
    render(<Harness />);
    type("call Sana fri 3pm ~30m #launch");
    expect(marks()).toEqual([["fri", "date"], ["3pm", "time"], ["~30m", "estimate"], ["#launch", "project"]]);
    // the highlight layer is decoration: the field itself keeps the plain text
    expect(field().value).toBe("call Sana fri 3pm ~30m #launch");
    expect(document.querySelector(".ktok-mirror")).toHaveAttribute("aria-hidden", "true");
    const details = screen.getByRole("group", { name: "Task details" });
    expect(details).toHaveTextContent("15:00");
    expect(details).toHaveTextContent("30m");
    expect(details).toHaveTextContent("Q3 Product Launch");
    expect(screen.getByRole("button", { name: "Assign" })).toBeInTheDocument();
  });

  it("⏎ creates the parsed task: a Friday, 15:00, a 30m estimate and the launch project", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    type("call Sana fri 3pm ~30m #launch");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      title: "call Sana", dueDate: nextFriday(), dueTime: "15:00", effortHours: 0.5, projectId: "p-launch", status: "todo", priority: "medium",
    });
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
  });

  it("⇧⏎ adds and keeps the sheet open for the next one", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} defaultProjectId="p-brand" />);
    type("Draft the FAQ @maya !high");
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(onCreate.mock.calls[0][0]).toMatchObject({ title: "Draft the FAQ", assigneeId: "m-1", priority: "high", projectId: "p-brand" });
    expect(screen.getByTestId("state")).toHaveTextContent("open");
    expect(field().value).toBe("");
    expect(screen.getByText("Added “Draft the FAQ”. Type the next one.")).toBeInTheDocument();
  });

  it("a picked project or assignee replaces the typed token", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    type("Book venue #launch");
    fireEvent.click(screen.getByRole("button", { name: "Project: Q3 Product Launch" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Brand Refresh" }));
    expect(field().value).toBe("Book venue");
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sana Rao" }));
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCreate.mock.calls[0][0]).toMatchObject({ title: "Book venue", projectId: "p-brand", assigneeId: "m-3" });
  });

  it("does nothing on ⏎ with no title, and Escape in an empty field closes straight away", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    type("   ");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
    type("");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
  });

  it("with text in it, the first Escape only leaves the field (nothing typed is lost)", () => {
    render(<Harness />);
    type("Half a thought");
    act(() => field().focus());
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.getByTestId("state")).toHaveTextContent("open");
    expect(field().value).toBe("Half a thought");
  });

  describe("a multi-line paste", () => {
    const NOTES = "Launch prep\n  Book venue fri @sana\nSend recap tomorrow 9am";

    it("offers to create them all, counting sub-tasks, and hands over the parent mapping", () => {
      const onImportRows = vi.fn();
      const onCreate = vi.fn();
      render(<Harness onCreate={onCreate} onImportRows={onImportRows} onPasteNotes={vi.fn()} defaultProjectId="p-launch" />);
      type(NOTES);
      // every line is highlighted, not just the first
      expect(marks()).toEqual([["fri", "date"], ["@sana", "person"], ["tomorrow", "date"], ["9am", "time"]]);
      expect(screen.getByRole("list", { name: "Tasks to create" }).querySelectorAll("li")).toHaveLength(3);
      fireEvent.click(screen.getByRole("button", { name: "Create 3 tasks (1 sub-task)" }));
      expect(onCreate).not.toHaveBeenCalled();
      const rows = onImportRows.mock.calls[0][0] as ImportRow[];
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ title: "Launch prep", projectId: "p-launch" });
      expect(rows[0].parentIndex).toBeUndefined();
      expect(rows[1]).toMatchObject({ title: "Book venue", parentIndex: 0, dueDate: nextFriday(), assigneeId: "m-3" });
      expect(rows[2]).toMatchObject({ title: "Send recap", dueTime: "09:00" });
      expect(rows[2].parentIndex).toBeUndefined();
      expect(screen.getByTestId("state")).toHaveTextContent("closed");
    });

    it("⏎ creates the rows too; without onImportRows they go through onCreate, flat", () => {
      const onCreate = vi.fn();
      render(<Harness onCreate={onCreate} />);
      type(NOTES);
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(onCreate.mock.calls.map((c) => c[0].title)).toEqual(["Launch prep", "Book venue", "Send recap"]);
      expect(onCreate.mock.calls.every((c) => c[0].parentIndex === undefined)).toBe(true);
    });

    it("“Turn notes into tasks with Kanbo” hands the whole text to the notes sheet", () => {
      const onPasteNotes = vi.fn();
      const onImportRows = vi.fn();
      render(<Harness onPasteNotes={onPasteNotes} onImportRows={onImportRows} />);
      type(NOTES);
      fireEvent.click(screen.getByRole("button", { name: "Turn notes into tasks with Kanbo" }));
      expect(onPasteNotes).toHaveBeenCalledWith(NOTES);
      expect(onImportRows).not.toHaveBeenCalled();
      expect(screen.getByTestId("state")).toHaveTextContent("closed");
    });

    it("sends a paste longer than one batch to Import instead of creating it", () => {
      const onImportRows = vi.fn();
      const onOpenImport = vi.fn();
      const onCreate = vi.fn();
      render(<Harness onCreate={onCreate} onImportRows={onImportRows} onOpenImport={onOpenImport} onPasteNotes={vi.fn()} />);
      const big = Array.from({ length: 1001 }, (_, i) => `Task ${i + 1} fri`).join("\n");
      type(big);
      expect(screen.getByText("1,001 lines", { selector: "b" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Create/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Turn notes into tasks/ })).toBeNull();
      expect(marks()).toEqual([]);
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(onOpenImport).toHaveBeenCalledWith(big);
      expect(onImportRows).not.toHaveBeenCalled();
      expect(onCreate).not.toHaveBeenCalled();
      expect(screen.getByTestId("state")).toHaveTextContent("closed");
    });

    it("says to use Import when there's nowhere to send a long paste", () => {
      const onCreate = vi.fn();
      render(<Harness onCreate={onCreate} />);
      type(Array.from({ length: 1200 }, (_, i) => `Task ${i + 1}`).join("\n"));
      expect(screen.getByText(/or use Import tasks for a longer list/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Open in Import|^Create/ })).toBeNull();
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(onCreate).not.toHaveBeenCalled();
      expect(screen.getByTestId("state")).toHaveTextContent("open");
    });

    it("hides the Kanbo route when nobody handles notes", () => {
      render(<Harness onImportRows={vi.fn()} />);
      type(NOTES);
      expect(screen.queryByRole("button", { name: /Turn notes into tasks/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Create 3 tasks (1 sub-task)" })).toBeInTheDocument();
    });
  });
});
