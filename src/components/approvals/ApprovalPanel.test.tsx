/* TaskDetail › Approval, in demo mode (the fakes in lib/approvals). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApprovalPanel } from "./ApprovalPanel";
import { listTaskApprovals, resetApprovalsDemo } from "../../lib/approvals";
import { MEMBERS, TASKS } from "../../data/data";
import type { Attachment, Task } from "../../data/types";

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const task = (id: string): Task => TASKS.find((t) => t.id === id)!;
const ME = "m-self";
const panel = (t: Task, extra: Partial<Parameters<typeof ApprovalPanel>[0]> = {}) =>
  <ApprovalPanel task={t} members={MEMBERS} guestIds={["m-4"]} currentUserId={ME} {...extra} />;

beforeEach(() => resetApprovalsDemo({ demoDelayMs: 0 }));

describe("ApprovalPanel", () => {
  it("nothing for a personal task; nothing for a guest when nobody has asked", async () => {
    const { container, rerender } = render(panel(task("t-5")));
    await settle();
    expect(container).toBeEmptyDOMElement();
    rerender(panel(task("t-2"), { readOnly: true }));
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it("asks two people (a guest among them), everyone must approve, with a note and a file", async () => {
    const onChange = vi.fn();
    const files: Attachment[] = [{ id: "f-1", taskId: "t-2", name: "staging-walkthrough.mp4", size: 1024, mime: "video/mp4", path: "x/t-2/f", url: "https://files.example.com/f", createdAt: "2026-10-08T09:00:00Z" }];
    render(panel(task("t-2"), { onChange, attachments: files }));
    fireEvent.click(await screen.findByRole("button", { name: "Request approval" }));
    // the picker opens straight away: everyone but you, guests labelled
    const picker = await screen.findByRole("dialog", { name: "Choose reviewers" });
    const options = within(picker).getAllByRole("option");
    expect(options).toHaveLength(4);
    ["Maya Lin", "Sana Rao", "Theo Vance", "Idris Bell Guest"].forEach((name, i) => expect(options[i]).toHaveAccessibleName(name));
    expect(within(picker).getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");
    fireEvent.click(options[0]);
    fireEvent.click(options[3]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose reviewers" })).toBeNull());

    const form = screen.getByRole("group", { name: "Request approval" });
    expect(within(form).getByText("Idris Bell")).toBeInTheDocument();
    expect(within(form).getByText("Guest")).toBeInTheDocument();
    // two people: anyone or everyone
    fireEvent.click(within(form).getByRole("button", { name: "Everyone" }));
    expect(within(form).getByText(/approved once all 2 have approved/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("About"), { target: { value: "f-1" } });
    fireEvent.change(within(form).getByRole("textbox", { name: /Note/ }), { target: { value: "Walkthrough attached" } });
    fireEvent.click(within(form).getByRole("button", { name: /Send request/ }));

    const section = await screen.findByRole("region", { name: /Approval/ });
    await waitFor(() => expect(within(section).getByText("Pending 0/2")).toBeInTheDocument());
    expect(within(section).getByText("Everyone must approve")).toBeInTheDocument();
    expect(within(section).getByText("Walkthrough attached")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: /staging-walkthrough\.mp4.*opens in a new tab/ })).toHaveAttribute("rel", "noopener noreferrer");
    const reviewers = within(section).getByRole("list", { name: "Reviewers" });
    const revRows = within(reviewers).getAllByRole("listitem");
    expect(revRows).toHaveLength(2);
    expect(revRows[0]).toHaveTextContent(/Idris Bell\s*Guest\s*Waiting/);
    expect(revRows[1]).toHaveTextContent(/Maya Lin\s*Waiting/);
    expect(within(section).getByText("You")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Asked (Idris and Maya|Maya and Idris) to approve/));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t-2", rule: "all", attachmentId: "f-1" }));
    // one open request per task: no "Request again" while it's open; you can cancel it
    expect(within(section).queryByRole("button", { name: "Request again" })).toBeNull();
    expect(within(section).getByRole("button", { name: "Cancel request" })).toBeInTheDocument();
  });

  it("won't send without a reviewer; ⌘↵ sends; Escape closes an empty form without closing the task", async () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}>{panel(task("t-3"))}</div>);
    fireEvent.click(await screen.findByRole("button", { name: "Request approval" }));
    const picker = await screen.findByRole("dialog", { name: "Choose reviewers" });
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    const form = screen.getByRole("group", { name: "Request approval" });
    expect(within(form).getByRole("button", { name: /Send request/ })).toBeDisabled();
    fireEvent.keyDown(within(form).getByRole("textbox", { name: /Note/ }), { key: "Enter", metaKey: true });
    expect(await within(form).findByRole("alert")).toHaveTextContent("Choose at least one person to review it.");
    fireEvent.keyDown(within(form).getByRole("textbox", { name: /Note/ }), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("group", { name: "Request approval" })).toBeNull());
    expect(screen.getByRole("button", { name: "Request approval" })).toHaveFocus();
  });

  it("a note keeps the form open on Escape (it steps out to Cancel instead)", async () => {
    render(panel(task("t-3")));
    fireEvent.click(await screen.findByRole("button", { name: "Request approval" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Choose reviewers" })).getByRole("option", { name: /Theo Vance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const note = screen.getByRole("textbox", { name: /Note/ });
    fireEvent.change(note, { target: { value: "Numbers check out?" } });
    fireEvent.keyDown(note, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("group", { name: "Request approval" })).toBeInTheDocument();
    fireEvent.keyDown(note, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("Pending")).toBeInTheDocument());
  });

  it("your own request (everyone must approve, 1 of 2): who decided what, then cancel it", async () => {
    const onChange = vi.fn();
    render(panel(task("t-1"), { onChange }));
    const section = await screen.findByRole("region", { name: /Approval/ });
    expect(within(section).getByText("Pending 1/2")).toBeInTheDocument();
    expect(within(section).getByText("Strong opening. The traction chart lands.")).toBeInTheDocument();
    const rows = within(within(section).getByRole("list", { name: "Reviewers" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent(/Maya Lin.*Approved/);
    expect(rows[1]).toHaveTextContent(/Sana Rao.*Waiting/);
    expect(within(section).queryByRole("button", { name: "Approve" })).toBeNull();   // you're not a reviewer
    fireEvent.click(within(section).getByRole("button", { name: "Cancel request" }));
    const confirm = within(section).getByRole("group", { name: "Cancel this request?" });
    expect(within(confirm).getByRole("button", { name: "Keep it" })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(within(section).getAllByText("Cancelled").length).toBeGreaterThan(0));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
    await waitFor(() => expect(within(section).getByRole("button", { name: "Request again" })).toHaveFocus());
    // asking again starts from the same people and rule
    fireEvent.click(within(section).getByRole("button", { name: "Request again" }));
    const form = screen.getByRole("group", { name: "Request approval" });
    expect(within(form).getByText("Maya Lin")).toBeInTheDocument();
    expect(within(form).getByText("Sana Rao")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Everyone" })).toHaveAttribute("aria-pressed", "true");
  });

  it("a request waiting on you: approve with a comment (anyone may, so it's approved)", async () => {
    const onChange = vi.fn();
    render(panel(task("t-4"), { onChange }));
    const section = await screen.findByRole("region", { name: /Approval/ });
    const review = within(section).getByRole("group", { name: /Sana Rao asked you to review this/ });
    fireEvent.change(within(review).getByRole("textbox", { name: /Comment with your review/ }), { target: { value: "Contrast is spot on" } });
    fireEvent.click(within(review).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(within(section).getByText("Approved", { selector: ".kapv-badge-text" })).toBeInTheDocument());
    expect(within(section).getByText("Contrast is spot on")).toBeInTheDocument();
    expect(within(section).queryByRole("group", { name: /review this/ })).toBeNull();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Approved"));
  });

  it("a guest (read-only here) still decides their own review, but is never offered asking or cancelling", async () => {
    render(panel(task("t-4"), { readOnly: true }));
    const section = await screen.findByRole("region", { name: /Approval/ });
    expect(within(section).queryByRole("button", { name: /Request again|Cancel request|Request approval/ })).toBeNull();
    const review = within(section).getByRole("group", { name: /asked you to review this/ });
    fireEvent.click(within(review).getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(within(section).getByText("Changes requested", { selector: ".kapv-badge-text" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You asked for changes"));
  });

  it("earlier requests fold away; asking again is offered on a resolved one", async () => {
    render(panel(task("t-9")));
    const section = await screen.findByRole("region", { name: /Approval/ });
    expect(within(section).getByText("Changes requested", { selector: ".kapv-badge-text" })).toBeInTheDocument();
    expect(within(section).getByText(/warmer palette/)).toBeInTheDocument();
    const more = within(section).getByRole("button", { name: /Earlier requests/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(within(section).queryByText("First sketch for a gut check.")).toBeNull();
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(within(section).getByText("First sketch for a gut check.")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Request again" })).toBeInTheDocument();
  });

  it("refreshKey reloads (a teammate decided elsewhere)", async () => {
    const { rerender } = render(panel(task("t-10")));
    const section = await screen.findByRole("region", { name: /Approval/ });
    expect(within(section).getByText("Pending")).toBeInTheDocument();
    const { decideApproval } = await import("../../lib/approvals");
    await decideApproval("ap-demo-2", "changes_requested", "Rename two events");
    rerender(panel(task("t-10"), { refreshKey: 1 }));
    await waitFor(() => expect(within(section).getByText("Rename two events")).toBeInTheDocument());
    expect((await listTaskApprovals("t-10"))[0].status).toBe("changes_requested");
  });
});
