import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TemplateLibrary, type TemplateLibraryProps } from "./TemplateLibrary";
import { TemplateEditor } from "./TemplateEditor";
import { listLibraryTemplates, resetLibraryTemplates, withRecurrence } from "../../lib/templates";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  localStorage.clear();
  resetLibraryTemplates({ demoDelayMs: 0 });
});
afterEach(() => { vi.useRealTimers(); });

function open(over: Partial<TemplateLibraryProps> = {}) {
  const props: TemplateLibraryProps = {
    open: true, onClose: vi.fn(), workspaceId: "ws-foundrise", workspaceName: "Foundrise", currentUserId: "m-self",
    canShare: true, canManageShared: false, onApply: vi.fn(), ...over,
  };
  render(<TemplateLibrary {...props} />);
  return props;
}
const list = () => screen.getByRole("listbox");
const card = (name: string) => within(list()).getByRole("option", { name: new RegExp(name) });
const pane = () => screen.getByRole("region", { name: /template/i });
const loaded = () => screen.findByRole("option", { name: /Monthly invoice run/ });

describe("TemplateLibrary", () => {
  it("lists yours, the workspace's shared ones and the built-ins, and previews the first", async () => {
    open();
    await loaded();
    const groups = within(list()).getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Yours", "Shared in Foundrise", "Built-in"]);
    expect(within(list()).getAllByRole("option")).toHaveLength(13);
    expect(screen.queryByRole("option", { name: /Experiment write-up/ })).toBeNull();   // Reco HQ's
    expect(within(pane()).getByRole("heading", { name: "Monthly invoice run" })).toBeInTheDocument();
    expect(within(pane()).getByText("Yours · only you can see it")).toBeInTheDocument();
    fireEvent.click(card("Release checklist"));
    expect(within(pane()).getByText("Shared by Maya Lin · Foundrise")).toBeInTheDocument();
    expect(within(pane()).getByText("version")).toHaveClass("ktpl-ph");                // the {version} placeholder
    expect(within(pane()).getByRole("region", { name: "Sub-tasks, 5" })).toBeInTheDocument();
    expect(within(pane()).getByText("Unassigned")).toBeInTheDocument();
  });

  it("searches (fuzzy) and says when nothing matches", async () => {
    open();
    await loaded();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: "inv" } });
    expect(within(list()).getAllByRole("option")[0]).toHaveTextContent("Monthly invoice run");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: "qqqq" } });
    expect(screen.getByText("No templates match “qqqq”")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(within(list()).getAllByRole("option")).toHaveLength(13);
  });

  it("filters: Yours · Shared · Built-in, with counts", async () => {
    open();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Shared 3" }));
    expect(within(list()).getAllByRole("option").map((o) => o.querySelector(".ktpl-card-name")!.textContent))
      .toEqual(["Release checklist", "Design review", "Incident review"]);
    fireEvent.click(screen.getByRole("button", { name: "Built-in 8" }));
    expect(within(list()).getAllByRole("option")).toHaveLength(8);
  });

  it("keyboard: ↓/↑ walk the list and preview each; Enter uses it", async () => {
    const p = open();
    await loaded();
    const first = card("Monthly invoice run");
    expect(first).toHaveAttribute("tabindex", "0");
    first.focus();
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    await waitFor(() => expect(card("Customer interview")).toHaveFocus());
    expect(card("Customer interview")).toHaveAttribute("aria-selected", "true");
    expect(within(pane()).getByRole("heading", { name: "Customer interview" })).toBeInTheDocument();
    fireEvent.keyDown(list(), { key: "End" });
    expect(within(pane()).getByRole("heading", { name: "Contract review" })).toBeInTheDocument();
    fireEvent.keyDown(list(), { key: "Enter" });
    expect(p.onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "builtin-lib-contract-review" }));
    expect(p.onClose).toHaveBeenCalled();
  });

  it("Use template hands it to the host", async () => {
    const p = open();
    await loaded();
    fireEvent.click(card("Hiring loop"));
    fireEvent.click(within(pane()).getByRole("button", { name: "Use template" }));
    expect(p.onApply).toHaveBeenCalledWith(expect.objectContaining({ name: "Hiring loop" }));
  });

  it("a guest browses read-only: no Use, no sharing, no managing others' templates", async () => {
    open({ canApply: false, canShare: false });
    await loaded();
    fireEvent.click(card("Release checklist"));
    expect(within(pane()).queryByRole("button", { name: "Use template" })).toBeNull();
    expect(within(pane()).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(pane()).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(card("Customer interview"));
    expect(within(pane()).queryByRole("switch")).toBeNull();
  });

  it("built-ins can be copied, not edited", async () => {
    open();
    await loaded();
    fireEvent.click(card("Bug report"));
    expect(within(pane()).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(pane()).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(within(pane()).getByRole("button", { name: "Make a copy to edit" }));
    expect(screen.getByRole("textbox", { name: "Template name" })).toHaveValue("Bug report (copy)");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Bug: {summary}");
    expect(screen.getAllByRole("textbox", { name: /^Sub-task \d$/ })).toHaveLength(5);
  });

  it("owners and admins manage shared templates they didn't make", async () => {
    open({ canManageShared: true });
    await loaded();
    fireEvent.click(card("Design review"));
    expect(within(pane()).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(pane()).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(pane()).queryByRole("switch")).toBeNull();   // sharing stays its maker's call
  });

  it("New template: says what's missing, then creates it and shows it", async () => {
    open();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    const name = screen.getByRole("textbox", { name: "Template name" });
    await waitFor(() => expect(name).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Give the template a name.");
    expect(alert).toHaveTextContent("Say what the task is called.");
    expect(name).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(name, { target: { value: "Retro" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Retro: {sprint}" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Due" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Add sub-task" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Sub-task 1" })).toHaveFocus());
    fireEvent.change(screen.getByRole("textbox", { name: "Sub-task 1" }), { target: { value: "Collect feedback" } });
    // Enter in a row adds the next one
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Sub-task 1" }), { key: "Enter" });
    fireEvent.change(screen.getByRole("textbox", { name: "Sub-task 2" }), { target: { value: "Run the retro" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Sub-task 2 due, days after it's used" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Sub-task 2 goes to" }), { target: { value: "project_owner" } });
    // reorder without dragging
    fireEvent.click(screen.getByRole("button", { name: "Move sub-task 2 up" }));
    expect(screen.getByRole("textbox", { name: "Sub-task 1" })).toHaveValue("Run the retro");
    expect(screen.getByText("Moved “Run the retro” to position 1 of 2.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add checklist item" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Checklist item 1" }), { target: { value: "Actions have owners" } });
    fireEvent.click(screen.getByRole("switch", { name: "Share with Foundrise" }));
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    expect(await screen.findByRole("heading", { name: "Retro" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Created “Retro” and shared it with Foundrise");
    expect(await within(list()).findByRole("option", { name: /Retro/ })).toHaveAttribute("aria-selected", "true");
    const saved = (await listLibraryTemplates("ws-foundrise")).find((t) => t.name === "Retro")!;
    expect(saved).toMatchObject({
      shared: true, workspaceId: "ws-foundrise",
      body: {
        title: "Retro: {sprint}", dueOffsetDays: 3, priority: "medium", estimate: 30,
        subtasks: [{ title: "Run the retro", offsetDays: 3, assigneeRole: "project_owner" }, { title: "Collect feedback", assigneeRole: "me" }],
        checklist: ["Actions have owners"],
      },
    });
  });

  it("edits one of yours; Cancel with changes asks first", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    open();
    await loaded();
    fireEvent.click(card("Customer interview"));
    fireEvent.click(within(pane()).getByRole("button", { name: "Edit" }));
    const name = screen.getByRole("textbox", { name: "Template name" });
    fireEvent.change(name, { target: { value: "Customer call" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalled();
    expect(name).toBeInTheDocument();     // kept editing
    confirm.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("heading", { name: "Customer call" })).toBeInTheDocument();
  });

  it("shares one of yours made here, in place", async () => {
    open();
    await loaded();
    fireEvent.click(card("Customer interview"));
    const sw = within(pane()).getByRole("switch", { name: "Share with Foundrise" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    await waitFor(() => expect(within(pane()).getByRole("switch", { name: "Share with Foundrise" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("status")).toHaveTextContent("Shared “Customer interview” with Foundrise");
  });

  it("one of yours from Personal can only be shared as a copy", async () => {
    open();
    await loaded();
    fireEvent.click(card("Monthly invoice run"));
    expect(within(pane()).queryByRole("switch")).toBeNull();
    fireEvent.click(within(pane()).getByRole("button", { name: "Share a copy with Foundrise" }));
    await waitFor(() => expect(within(list()).getAllByRole("option", { name: /Monthly invoice run/ })).toHaveLength(2));
    expect(within(pane()).getByText("Yours · shared with Foundrise")).toBeInTheDocument();
  });

  it("Delete asks in place, then removes it with an Undo", async () => {
    open();
    await loaded();
    fireEvent.click(card("Customer interview"));
    fireEvent.click(within(pane()).getByRole("button", { name: "Delete" }));
    const ask = within(pane()).getByRole("group", { name: "Delete this template?" });
    expect(within(ask).getByRole("button", { name: "Delete" })).toHaveFocus();
    fireEvent.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(within(pane()).queryByRole("group", { name: "Delete this template?" })).toBeNull();
    fireEvent.click(within(pane()).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(within(pane()).getByRole("group", { name: "Delete this template?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(list()).queryByRole("option", { name: /Customer interview/ })).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Deleted “Customer interview”");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(await within(list()).findByRole("option", { name: /Customer interview/ })).toBeInTheDocument();
  });

  it("Personal: nothing to share, and the Shared filter says why", async () => {
    open({ workspaceId: null, workspaceName: "Personal" });
    await loaded();
    expect(screen.queryByRole("option", { name: /Release checklist/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect(screen.getByText("Nothing's shared in Personal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Yours/ }));
    fireEvent.click(card("Monthly invoice run"));
    expect(within(pane()).queryByRole("switch")).toBeNull();
    expect(within(pane()).queryByRole("button", { name: /Share a copy/ })).toBeNull();
  });

  it("opens straight on a template, or on a blank editor", async () => {
    open({ initialTemplateId: "builtin-lib-expense-claim" });
    const heading = await screen.findByRole("heading", { name: "Expense claim" });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("shows how a template repeats", async () => {
    const t = await (await import("../../lib/templates")).createLibraryTemplate({ workspaceId: "ws-foundrise", name: "Standup", body: withRecurrence({ title: "Standup notes" }, "weekdays") });
    open({ initialTemplateId: t.id });
    await screen.findByRole("heading", { name: "Standup" });
    expect(within(pane()).getByText("Repeats").nextSibling).toHaveTextContent("Every weekday");
    expect(card("Standup")).toHaveTextContent("Every weekday");
  });
});

/* Edit straight after a save, before the library's reload has it (the demo answers after a
   pause here, as the network would): the editor opens on what was just saved, and saves it. */
describe("TemplateLibrary · before the reload lands", () => {
  beforeEach(() => { resetLibraryTemplates({ demoDelayMs: 150 }); });
  const slow = { timeout: 3000 };

  it("Edit right after Create edits that template (it isn't made twice)", async () => {
    open();
    await screen.findByRole("option", { name: /Monthly invoice run/ }, slow);
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "Probe" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Probe task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    await screen.findByRole("heading", { name: "Probe" }, slow);
    expect(within(list()).queryByRole("option", { name: /Probe/ })).toBeNull();   // the reload's still on its way
    fireEvent.click(within(pane()).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Template name" })).toHaveValue("Probe");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Probe task");
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "Probe v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("heading", { name: "Probe v2" }, slow);
    const all = await listLibraryTemplates("ws-foundrise");
    expect(all.filter((t) => t.name.startsWith("Probe")).map((t) => t.name)).toEqual(["Probe v2"]);
  });

  it("Edit right after sharing keeps it shared", async () => {
    open();
    await screen.findByRole("option", { name: /Customer interview/ }, slow);
    fireEvent.click(card("Customer interview"));
    fireEvent.click(within(pane()).getByRole("switch", { name: "Share with Foundrise" }));
    await waitFor(() => expect(within(pane()).getByRole("switch", { name: "Share with Foundrise" })).toHaveAttribute("aria-checked", "true"), slow);
    fireEvent.click(within(pane()).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("switch", { name: "Share with Foundrise" })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "Customer call" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("heading", { name: "Customer call" }, slow);
    expect((await listLibraryTemplates("ws-foundrise")).find((t) => t.name === "Customer call")).toMatchObject({ shared: true });
  });
});

describe("TemplateEditor", () => {
  const edit = (body: Parameters<typeof TemplateEditor>[0]["initial"]["body"], onSave = vi.fn()) => {
    render(<TemplateEditor mode="edit" tileId="t" canShareHere={false} onSave={onSave} onCancel={vi.fn()} initial={{ name: "T", emoji: null, shared: false, body }} />);
    return onSave;
  };
  it("Repeats: shows a template's repeat, and saves the one chosen", () => {
    const onSave = edit(withRecurrence({ title: "Standup notes" }, "weekly"));
    const repeats = screen.getByRole("combobox", { name: "Repeats" });
    expect(repeats).toHaveValue("weekly");
    fireEvent.change(repeats, { target: { value: "weekdays" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave.mock.calls[0][0].body).toMatchObject({ title: "Standup notes", recurrence: "weekdays" });
    fireEvent.change(repeats, { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave.mock.calls[1][0].body).not.toHaveProperty("recurrence");
  });
  it("a title keeps the space at its end, to type on from", () => {
    const onSave = edit({ title: "x" });
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "  Bug: " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave.mock.calls[0][0].body.title).toBe("Bug: ");
  });
  it("moving a row to the top or bottom leaves focus on the button that still works", async () => {
    edit({ title: "t", subtasks: [{ title: "A" }, { title: "B" }, { title: "C" }], checklist: ["x", "y"] });
    const go = async (name: string, then: string) => {
      const b = screen.getByRole("button", { name });
      b.focus(); fireEvent.click(b);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: then })));
      expect(document.activeElement).not.toBeDisabled();
    };
    await go("Move sub-task 2 up", "Move sub-task 1 down");          // B → top: its "up" is disabled now
    await go("Move sub-task 1 down", "Move sub-task 2 down");        // B → 2: "down" still works
    await go("Move sub-task 2 down", "Move sub-task 3 up");          // B → bottom
    await go("Move checklist item 1 down", "Move checklist item 2 up");
    expect(screen.getAllByRole("textbox", { name: /^Sub-task \d$/ }).map((x) => (x as HTMLInputElement).value)).toEqual(["A", "C", "B"]);
  });
});
