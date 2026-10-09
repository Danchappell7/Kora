/* Inbox › Approvals for you, in demo mode, and the row/card badge. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApprovalsInboxGroup } from "./ApprovalsInboxGroup";
import { ApprovalBadge } from "./ApprovalBadge";
import { listMyApprovals, listTaskApprovals, resetApprovalsDemo } from "../../lib/approvals";
import { MEMBERS, PROJECTS } from "../../data/data";
import type { ApprovalWithTask } from "../../data/types";

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
let waiting: ApprovalWithTask[] = [];
beforeEach(async () => {
  resetApprovalsDemo({ demoDelayMs: 0 });
  waiting = (await listMyApprovals()).toReview;
});
const group = (extra: Partial<Parameters<typeof ApprovalsInboxGroup>[0]> = {}) => (
  <ApprovalsInboxGroup approvals={waiting} projects={PROJECTS} members={MEMBERS} currentUserId="m-self" onOpenTask={() => {}} {...extra} />
);

describe("ApprovalsInboxGroup", () => {
  it("nothing when nothing waits on you", () => {
    const { container } = render(group({ approvals: [] }));
    expect(container).toBeEmptyDOMElement();
  });

  it("each request: who asked, the task, its project and note; newest first", () => {
    render(group());
    const section = screen.getByRole("region", { name: /Approvals for you/ });
    const rows = within(section).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const main = within(rows[0]).getByRole("button", { name: /Sana Rao asked for your approval on Define design tokens v2/ });
    expect(main).toHaveAccessibleDescription(/Brand Refresh.*Final pass on contrast/);
    expect(within(rows[0]).getByRole("button", { name: "Approve “Define design tokens v2”" })).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Set up usage analytics events/)).toBeInTheDocument();
    expect(within(section).getByText("2")).toBeInTheDocument();
  });

  it("Enter opens the task; J/K and the arrows move; the Inbox's own letters never reach past the group", () => {
    const onOpenTask = vi.fn();
    const inboxKeys = vi.fn();
    render(<div onKeyDown={(e) => inboxKeys(e.key)}>{group({ onOpenTask })}</div>);
    const [first, second] = screen.getAllByRole("listitem").map((r) => within(r).getAllByRole("button")[0]);
    first.focus();
    fireEvent.keyDown(first, { key: "j" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "k" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Enter" });
    expect(onOpenTask).toHaveBeenCalledWith("t-4");
    for (const key of ["e", "h", "r", "d", "a", "c", "j"]) fireEvent.keyDown(first, { key, repeat: key === "a" });
    expect(inboxKeys).not.toHaveBeenCalled();
    fireEvent.keyDown(first, { key: "g" });   // the app's "g …" go-to keys still pass through
    expect(inboxKeys).toHaveBeenCalledWith("g");
  });

  it("A approves the focused row: it leaves, focus moves on, the host hears", async () => {
    const onDecided = vi.fn();
    render(group({ onDecided }));
    const rows = screen.getAllByRole("listitem");
    const first = within(rows[0]).getAllByRole("button")[0];
    first.focus();
    fireEvent.keyDown(first, { key: "a" });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ id: "ap-demo-1", status: "approved" }));
    expect(within(screen.getByRole("listitem")).getAllByRole("button")[0]).toHaveFocus();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Approved “Define design tokens v2”"));
    expect((await listTaskApprovals("t-4"))[0].status).toBe("approved");
  });

  it("C opens a comment for the changes; ⌘↵ sends it; clearing the last one says you're caught up", async () => {
    render(group({ approvals: waiting.slice(1) }));
    const row = screen.getByRole("listitem");
    const main = within(row).getAllByRole("button")[0];
    main.focus();
    fireEvent.keyDown(main, { key: "c" });
    const box = within(row).getByRole("textbox", { name: /What needs to change\? Maya will see this/ });
    await waitFor(() => expect(box).toHaveFocus());
    // typing letters in the comment never triggers the row's keys
    fireEvent.keyDown(box, { key: "a" });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(box, { target: { value: "Rename page_view to screen_view" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    const done = await screen.findByText("You're all caught up on approvals.");
    await waitFor(() => expect(done).toHaveFocus());
    const t10 = (await listTaskApprovals("t-10"))[0];
    expect(t10.status).toBe("changes_requested");
    expect(t10.reviewers.find((r) => r.userId === "m-self")?.comment).toBe("Rename page_view to screen_view");
  });

  it("Escape puts the comment away (and keeps the draft); the buttons work by mouse too", async () => {
    render(group());
    const row = screen.getAllByRole("listitem")[1];
    fireEvent.click(within(row).getByRole("button", { name: "Request changes on “Set up usage analytics events”" }));
    const box = within(row).getByRole("textbox");
    fireEvent.change(box, { target: { value: "Half-written" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(within(row).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /Request changes on/ }));
    expect(within(row).getByRole("textbox")).toHaveValue("Half-written");
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(row).getByRole("button", { name: "Approve “Set up usage analytics events”" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  });

  it("a request someone else already closed drops out with a note, without an error on the row", async () => {
    render(group());
    // decided meanwhile (another tab): the Inbox still shows it until it refreshes
    const { decideApproval } = await import("../../lib/approvals");
    await decideApproval("ap-demo-1", "approved");
    const first = within(screen.getAllByRole("listitem")[0]).getByRole("button", { name: /^Approve/ });
    fireEvent.click(first);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/already been decided or cancelled/));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a guest's group looks the same (they decide their own reviews)", async () => {
    render(group({ currentUserId: "m-4" }));
    await settle();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("ApprovalBadge", () => {
  it("Pending 1/2 · Pending · Approved · Changes requested; nothing for cancelled or none", () => {
    const s = (status: "pending" | "approved" | "changes_requested" | "cancelled", rule: "any" | "all" = "all") =>
      ({ approvalId: "a", taskId: "t", status, rule, approved: 1, total: 2 });
    const { container, rerender } = render(<ApprovalBadge summary={s("pending")} />);
    expect(container.textContent).toContain("Pending 1/2");
    expect(container.firstChild).toHaveAttribute("data-tone", "accent");
    expect(screen.getByText("Approval pending, 1 of 2 approved")).toHaveClass("sr-only");
    rerender(<ApprovalBadge summary={s("pending", "any")} size="md" />);
    expect(container.textContent).toContain("Pending");
    expect(container.firstChild).toHaveAttribute("data-size", "md");
    rerender(<ApprovalBadge summary={s("approved")} />);
    expect(container.firstChild).toHaveAttribute("data-tone", "ok");
    rerender(<ApprovalBadge summary={s("changes_requested")} />);
    expect(container.firstChild).toHaveAttribute("data-tone", "warn");
    expect(container.textContent).toContain("Changes requested");
    rerender(<ApprovalBadge summary={s("cancelled")} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ApprovalBadge summary={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
