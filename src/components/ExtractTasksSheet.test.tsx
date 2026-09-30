import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { ExtractTasksSheet, toRows } from "./ExtractTasksSheet";
import { ToastProvider } from "./Toast";
import { KANBO_TODAY, toLocalISO } from "../data/data";
import type { AiOutcome, ExtractedTask } from "../lib/askTypes";
import type { Project, Task } from "../data/types";

const PROJECTS: Project[] = [
  { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "oklch(0.7 0.15 230)", workspaceId: "ws-1" },
  { id: "p-brand", name: "Brand Refresh", emoji: "🎨", color: "oklch(0.7 0.15 305)", workspaceId: "ws-1" },
];
const MEMBERS = [
  { id: "m-self", name: "Daniel Okai" },
  { id: "m-1", name: "Maya Lin" },
  { id: "m-2", name: "Theo Vance" },
  { id: "m-3", name: "Sana Rao" },
];
const NOTES = [
  "Launch sync",
  "We decided to keep the 12 Oct date.",
  "",
  "Actions:",
  "- Sana to send the brief by Fri",
  "- Priya to draft the press release",
  "- [ ] Theo: book the venue",
].join("\n");

const nextFriday = () => {
  const d = new Date(KANBO_TODAY);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return toLocalISO(d);
};

type CreateFn = (tasks: Array<Partial<Task> & { title: string }>) => boolean | void;
function Harness({ onCreate = vi.fn(), onExtractAI, initialText = NOTES, context, defaultProjectId = "p-brand" }: {
  onCreate?: CreateFn;
  onExtractAI?: (text: string, context?: string) => Promise<AiOutcome<ExtractedTask[]>>;
  initialText?: string;
  context?: string;
  defaultProjectId?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <ExtractTasksSheet open={open} onClose={() => setOpen(false)} initialText={initialText} context={context}
        projects={PROJECTS} members={MEMBERS} defaultProjectId={defaultProjectId} currentUserId="m-self"
        onExtractAI={onExtractAI} onCreate={onCreate} />
    </>
  );
}

const findTasks = async () => {
  fireEvent.click(screen.getByRole("button", { name: /Find tasks/ }));
  return screen.findByRole("list", { name: "Tasks found" });
};
const rowFor = (list: HTMLElement, title: string) =>
  within(list).getAllByRole("listitem").find((li) => (li.querySelector("input") as HTMLInputElement | null)?.value === title)!;

describe("ExtractTasksSheet", () => {
  it("names the notes' source in its title and puts focus on Find tasks when prefilled", () => {
    render(<Harness context="Design review" />);
    expect(screen.getByRole("dialog", { name: "Notes → tasks · Design review" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue(NOTES);
    expect(screen.getByRole("button", { name: /Find tasks/ })).toHaveFocus();
  });

  it("finds “Sana to send the brief by Fri” on the device, with owner and day", async () => {
    render(<Harness />);
    const list = await findTasks();
    expect(screen.getByText("Found on-device")).toBeInTheDocument();
    const row = rowFor(list, "Send the brief");
    expect(within(row).getByRole("combobox", { name: "Assignee for “Send the brief”" })).toHaveValue("m-3");
    expect(within(row).getByRole("button", { name: /Due date for “Send the brief”/ })).toHaveTextContent(/Fri/);
    // prose and decisions are left out
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("flags a name that isn't in the workspace instead of guessing", async () => {
    render(<Harness />);
    const list = await findTasks();
    const row = rowFor(list, "Draft the press release");
    const who = within(row).getByRole("combobox", { name: "Assignee for “Draft the press release”" });
    expect(who).toHaveValue("");
    expect(within(row).getByText("Priya · Not in this workspace")).toBeInTheDocument();
    expect(who).toHaveAccessibleDescription("Priya · Not in this workspace");
    // choosing someone clears the flag
    fireEvent.change(who, { target: { value: "m-1" } });
    expect(within(row).queryByText(/Not in this workspace/)).toBeNull();
  });

  it("creates only the ticked rows, with the edits and the batch's project", async () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    const list = await findTasks();
    expect(screen.getByRole("combobox", { name: "Project for these tasks" })).toHaveValue("p-brand");
    fireEvent.change(screen.getByRole("combobox", { name: "Project for these tasks" }), { target: { value: "p-launch" } });
    fireEvent.click(within(list).getByRole("checkbox", { name: "Include “Draft the press release”" }));
    expect(screen.getByText("2 of 3 selected")).toBeInTheDocument();
    const venue = rowFor(list, "Book the venue");
    fireEvent.change(within(venue).getByRole("textbox"), { target: { value: "Book the venue for the party" } });
    fireEvent.change(within(venue).getByRole("combobox", { name: /^Priority for/ }), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Create 2 tasks" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    const made = onCreate.mock.calls[0][0] as Array<Partial<Task>>;
    expect(made).toHaveLength(2);
    expect(made[0]).toMatchObject({ title: "Send the brief", assigneeId: "m-3", dueDate: nextFriday(), projectId: "p-launch", status: "todo", priority: "medium" });
    expect(made[1]).toMatchObject({ title: "Book the venue for the party", assigneeId: "m-2", priority: "high", projectId: "p-launch" });
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
  });

  describe("one toast, from whoever knows the tasks were made", () => {
    const createWith = async (result: boolean | undefined) => {
      const onCreate = vi.fn(() => result);
      render(<ToastProvider><Harness onCreate={onCreate} /></ToastProvider>);
      await findTasks();
      fireEvent.click(screen.getByRole("button", { name: "Create 3 tasks" }));
      expect(onCreate).toHaveBeenCalledTimes(1);
    };
    it("the host announces it (it returns nothing): the sheet only closes", async () => {
      await createWith(undefined);
      expect(screen.getByTestId("state")).toHaveTextContent("closed");
      expect(screen.queryByText(/Created 3 tasks/)).toBeNull();
    });
    it("the host says they were made (true): the sheet says so", async () => {
      await createWith(true);
      expect(screen.getByTestId("state")).toHaveTextContent("closed");
      expect(await screen.findByText("Created 3 tasks in Brand Refresh")).toBeInTheDocument();
    });
    it("the host couldn't make them (false): no success, and the review stays open", async () => {
      await createWith(false);
      expect(screen.getByTestId("state")).toHaveTextContent("open");
      expect(screen.getByRole("list", { name: "Tasks found" })).toBeInTheDocument();
      expect(screen.queryByText(/Created 3 tasks/)).toBeNull();
    });
  });

  it("Select none leaves nothing to create", async () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    await findTasks();
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByRole("button", { name: "Create tasks" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Create 3 tasks" })).toBeEnabled();
  });

  it("uses Kanbo's AI when it answers, in the vellum with how it got there", async () => {
    const onExtractAI = vi.fn(async (): Promise<AiOutcome<ExtractedTask[]>> => ({
      source: "ai",
      data: [
        { title: "Send the brief to the agency", assigneeId: "m-3", dueDate: "2026-10-02", priority: "high" },
        { title: "Book the launch venue", assigneeName: "Priya" },
        { title: "Chase legal", assigneeName: "Theo" },           // resolved by name
        { title: "", assigneeId: "m-1" },                         // dropped: no title
      ],
    }));
    const onCreate = vi.fn();
    render(<Harness onExtractAI={onExtractAI} onCreate={onCreate} context="Launch sync" />);
    const list = await findTasks();
    expect(onExtractAI).toHaveBeenCalledWith(NOTES, "Launch sync");
    expect(screen.getByText("Kanbo found 3 actions. Check who owns each one, then create them.")).toBeInTheDocument();
    expect(screen.getByText(/From 6 lines of notes/)).toBeInTheDocument();
    expect(screen.queryByText("Found on-device")).toBeNull();
    expect(within(rowFor(list, "Book the launch venue")).getByText("Priya · Not in this workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create 3 tasks" }));
    expect(onCreate.mock.calls[0][0]).toEqual([
      expect.objectContaining({ title: "Send the brief to the agency", assigneeId: "m-3", dueDate: "2026-10-02", priority: "high" }),
      expect.objectContaining({ title: "Book the launch venue", priority: "medium" }),
      expect.objectContaining({ title: "Chase legal", assigneeId: "m-2" }),
    ]);
    expect(onCreate.mock.calls[0][0][1].assigneeId).toBeUndefined();
  });

  it("falls back to the device when Kanbo's AI can't answer, and says why", async () => {
    const onExtractAI = vi.fn(async (): Promise<AiOutcome<ExtractedTask[]>> => ({ source: "limit", data: null }));
    render(<Harness onExtractAI={onExtractAI} />);
    await findTasks();
    expect(screen.getByText("Found on-device")).toBeInTheDocument();
    expect(screen.getByText(/today's Kanbo limit is reached/)).toBeInTheDocument();
  });

  it("falls back to the device when the AI request fails", async () => {
    const onExtractAI = vi.fn(async (): Promise<AiOutcome<ExtractedTask[]>> => { throw new Error("offline"); });
    render(<Harness onExtractAI={onExtractAI} />);
    const list = await findTasks();
    expect(screen.getByText("Found on-device")).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("says so when there's nothing to do, and Back returns to the notes as typed", async () => {
    render(<Harness initialText={"We decided to keep the date.\nPricing will change next quarter."} />);
    fireEvent.click(screen.getByRole("button", { name: /Find tasks/ }));
    expect(await screen.findByText("Kanbo didn't find any actions.")).toBeInTheDocument();
    expect(screen.getByText(/Sana to send the brief by Fri/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("We decided to keep the date.\nPricing will change next quarter."));
  });

  it("can't look for tasks in empty notes; ⌘↵ in the notes finds them", async () => {
    render(<Harness initialText="" />);
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveFocus();
    expect(screen.getByRole("button", { name: /Find tasks/ })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "TODO: renew the domain" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Notes" }), { key: "Enter", metaKey: true });
    const list = await screen.findByRole("list", { name: "Tasks found" });
    expect(rowFor(list, "Renew the domain")).toBeTruthy();
  });
});

describe("toRows", () => {
  it("trims, de-duplicates and checks what came back", () => {
    const rows = toRows([
      { title: "  Send   the brief  " },
      { title: "send the brief" },
      { title: "x".repeat(240) },
      { title: "Bad date", dueDate: "Friday", dueTime: "3pm", priority: "whenever" as never },
      { title: "Ghost owner", assigneeId: "m-404" },
    ], MEMBERS);
    expect(rows.map((r) => r.title)).toEqual(["Send the brief", "x".repeat(200), "Bad date", "Ghost owner"]);
    expect(rows[2]).toMatchObject({ priority: "medium" });
    expect(rows[2].dueDate).toBeUndefined();
    expect(rows[2].dueTime).toBeUndefined();
    expect(rows[3].assigneeId).toBeUndefined();
  });
});
