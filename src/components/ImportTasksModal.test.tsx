import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportTasksModal } from "./ImportTasksModal";

const projects = [{ id: "p-web", name: "Website" }, { id: "p-ops", name: "Operations" }];
const members = [{ id: "u-sarah", name: "Sarah Jones", email: "sarah@acme.co.uk" }];

function setup(props: Partial<Parameters<typeof ImportTasksModal>[0]> = {}) {
  const onClose = vi.fn();
  const onImport = vi.fn();
  const utils = render(<ImportTasksModal open onClose={onClose} onImport={onImport} projects={projects} members={members} {...props} />);
  const textarea = screen.getByLabelText("Tasks to import");
  const type = (v: string) => fireEvent.change(textarea, { target: { value: v } });
  return { ...utils, onClose, onImport, textarea, type };
}

describe("ImportTasksModal", () => {
  it("is a labelled modal dialog that closes on Escape", () => {
    const { onClose, textarea } = setup({ defaultProjectId: "p-web" });
    expect(screen.getByRole("dialog", { name: "Import tasks" })).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("previews a pasted list and imports it into the current project", () => {
    const { type, onImport, onClose } = setup({ defaultProjectId: "p-web", defaultProjectName: "Website" });
    type("Call Sarah re budget, timeline\nBook venue, catering\nSend invites");
    expect(screen.getByRole("status")).toHaveTextContent("3 tasks ready");
    expect(screen.getByText("Book venue, catering")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import 3 tasks" }));
    expect(onImport).toHaveBeenCalledTimes(1);
    const rows = onImport.mock.calls[0][0];
    expect(rows.map((r: { title: string }) => r.title)).toEqual(["Call Sarah re budget, timeline", "Book venue, catering", "Send invites"]);
    expect(rows.every((r: { projectId?: string }) => r.projectId === "p-web")).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it("asks which project to import into when there's no project context", () => {
    const { type, onImport } = setup();
    type("Task one\nTask two");
    const importBtn = screen.getByRole("button", { name: "Import 2 tasks" });
    expect(importBtn).toBeDisabled();
    expect(screen.getByText("Choose a project to import into.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Import into"), { target: { value: "p-ops" } });
    expect(importBtn).not.toBeDisabled();
    fireEvent.click(importBtn);
    expect(onImport.mock.calls[0][0][0]).toMatchObject({ title: "Task one", projectId: "p-ops" });
  });

  it("shows the column mapping, unreadable dates and people it couldn't match", () => {
    const { type } = setup({ defaultProjectId: "p-web" });
    type("Task Name\tDue Date\tAssignee\tCreated At\nDraft brief\t31/10/2026\tSarah Jones\t2026-01-01\nShip it\tsoon-ish\tJo Nobody\t2026-01-01");
    const mapping = screen.getByRole("list", { name: "Column mapping" });
    expect(mapping).toHaveTextContent("Task Name→imported asTitle");
    expect(mapping).toHaveTextContent("Due Date→imported asDue date");
    expect(screen.getByText(/1 date couldn't be read/)).toHaveTextContent("“soon-ish”");
    expect(screen.getByText(/assigned to someone who isn't in this workspace/)).toHaveTextContent("“Jo Nobody”");
    expect(screen.getByText("Not imported: Created At")).toBeInTheDocument();
  });

  it("lets you switch between columns and one task per line", () => {
    const { type } = setup({ defaultProjectId: "p-web" });
    type("Title,Due\nA,2026-10-01\nB,2026-10-02");
    expect(screen.getByRole("status")).toHaveTextContent("2 tasks ready");
    fireEvent.click(screen.getByRole("button", { name: "Treat each line as one task instead" }));
    expect(screen.getByRole("status")).toHaveTextContent("3 tasks ready");
    fireEvent.click(screen.getByRole("button", { name: "Detect columns" }));
    expect(screen.getByRole("status")).toHaveTextContent("2 tasks ready");
  });

  it("offers a day/month choice only for ambiguous numeric dates", () => {
    const { type, onImport } = setup({ defaultProjectId: "p-web" });
    type("Title,Due\nA,03/04/2026");
    const order = screen.getByLabelText("Dates like 03/04/2026 are");
    expect(order).toHaveValue("dmy");
    fireEvent.change(order, { target: { value: "mdy" } });
    fireEvent.click(screen.getByRole("button", { name: "Import 1 task" }));
    expect(onImport.mock.calls[0][0][0].dueDate).toBe("2026-03-04");
  });

  it("keeps the pasted text when cancelled", () => {
    const { type, onClose, rerender } = setup({ defaultProjectId: "p-web" });
    type("Keep me");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    rerender(<ImportTasksModal open={false} onClose={onClose} onImport={vi.fn()} projects={projects} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<ImportTasksModal open onClose={onClose} onImport={vi.fn()} projects={projects} defaultProjectId="p-web" />);
    expect(screen.getByLabelText("Tasks to import")).toHaveValue("Keep me");
  });

  it("explains how to import spreadsheet files it can't open", () => {
    setup({ defaultProjectId: "p-web" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "board.xlsx")] } });
    expect(screen.getByRole("alert")).toHaveTextContent("Kanbo can't open XLSX files directly");
  });
  it("imports into the chosen project unless you ask to keep the file's projects", () => {
    const { type, onImport } = setup({ defaultProjectId: "p-web", defaultProjectName: "Website" });
    type("Title,Project\nHero copy,Operations\nFooter,Website");
    expect(screen.getByText("Into Website")).toBeInTheDocument();
    const keep = screen.getByRole("checkbox", { name: /Put tasks into the projects named in the “Project” column \(“Operations”\) instead of “Website”/ });
    expect(keep).not.toBeChecked();
    fireEvent.click(keep);
    expect(screen.getByText("Into Website and 1 other project")).toBeInTheDocument();
    expect(screen.getByText("Operations", { selector: "span[title='Goes into Operations']" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import 2 tasks" }));
    expect(onImport.mock.calls[0][0].map((r: { projectId: string }) => r.projectId)).toEqual(["p-ops", "p-web"]);
  });

  it("says which details will be left off until the handler keeps them", () => {
    const text = "Title,Notes,Start date\nLaunch,Remember the press list,01/10/2026";
    const { type, unmount } = setup({ defaultProjectId: "p-web" });
    type(text);
    expect(screen.getByText(/Descriptions and start dates from your text will be left off/)).toBeInTheDocument();
    expect(screen.queryByTitle("Has a description")).toBeNull();
    unmount();
    const again = setup({ defaultProjectId: "p-web", supports: { details: true } });
    again.type(text);
    expect(screen.queryByText(/will be left off/)).toBeNull();
    expect(screen.getByTitle("Has a description")).toBeInTheDocument();
  });

  it("accepts a file dropped anywhere on the dialog and turns away images", async () => {
    setup({ defaultProjectId: "p-web" });
    const dialog = screen.getByRole("dialog");
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0])], "photo.png", { type: "image/png" });
    fireEvent.drop(dialog, { dataTransfer: { files: [png], types: ["Files"] } });
    expect(screen.getByRole("alert")).toHaveTextContent("Kanbo can import CSV, TSV and text files");
    const csv = new File(["Title,Due\nA,2026-10-01"], "tasks.csv", { type: "text/csv" });
    fireEvent.drop(dialog, { dataTransfer: { files: [csv], types: ["Files"] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 task ready"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads a Trello board's JSON export", async () => {
    setup({ defaultProjectId: "p-web" });
    const board = { lists: [{ id: "l1", name: "Doing" }], cards: [{ id: "c1", name: "Fix header", idList: "l1" }] };
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(board)], "board.json", { type: "application/json" })] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 task ready"));
    expect(screen.getByText("Fix header")).toBeInTheDocument();
    fireEvent.change(input, { target: { files: [new File(['{"hello":1}'], "other.json", { type: "application/json" })] } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("isn't a Trello board export"));
  });
});
