/* The 0047 wave in the Inbox: "Approvals for you" leads, its request notices
   aren't repeated, decisions read as sentences with the reviewer's words, and a
   doc @mention (no task) opens its doc. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { InboxView } from "./InboxView";
import type { Activity, ApprovalWithTask, Member, Task } from "../../data/types";
import { PROJECTS } from "../../data/data";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const task = { id: "t1", title: "Q3 budget", projectId: "p-launch", status: "todo", assigneeId: "m-1", aiScore: 1 } as unknown as Task;
const people: Member[] = [
  { id: "m-self", name: "Daniel Okai", email: "d@x.test", type: "self", color: "red" },
  { id: "m-3", name: "Sana Rao", email: "s@x.test", type: "team", color: "blue" },
];
const request = (over: Partial<ApprovalWithTask> = {}): ApprovalWithTask => ({
  id: "ap-1", taskId: "t1", workspaceId: "ws-foundrise", requestedBy: "m-3", requestedByName: "Sana Rao", title: "Q3 budget",
  note: "Happy for this to go?", attachmentId: null, status: "pending", rule: "any", createdAt: iso(60_000), updatedAt: iso(60_000),
  resolvedAt: null, reviewers: [{ userId: "m-self", name: "Daniel Okai", decision: null, comment: null, decidedAt: null }],
  canDecide: true, canCancel: false,
  task: { id: "t1", title: "Q3 budget", projectId: "p-launch", workspaceId: "ws-foundrise", status: "todo", dueDate: null },
  ...over,
});
const notice = (p: Partial<Activity> & { id: string }): Activity => ({
  taskId: "t1", taskTitle: "Q3 budget", kind: "approval", detail: "Sana Rao", createdAt: iso(60_000), ...p,
});

function inbox(activity: Activity[], extra: Partial<Parameters<typeof InboxView>[0]> = {}) {
  const props = { activity, tasks: [task], onOpen: vi.fn(), onArchive: vi.fn(), onClearAll: vi.fn(), currentUserId: "m-self", ...extra };
  return { ...render(<InboxView {...props} />), props };
}

beforeEach(() => { localStorage.clear(); });

describe("Inbox › Approvals for you (0047)", () => {
  it("leads the Inbox, and the request's own notice isn't repeated in the triage groups", () => {
    const onNewCount = vi.fn();
    const { container } = inbox([notice({ id: "n1", meta: { approvalId: "ap-1", event: "requested", status: "pending", rule: "any" } })], {
      approvals: { toReview: [request()], projects: PROJECTS, members: people }, onNewCount,
    });
    expect(screen.getByText("Approvals for you")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve “Q3 budget”" })).toBeInTheDocument();
    // one row says it (the group's), never a second one in the triage groups
    expect(screen.getAllByRole("button", { name: /Sana Rao asked for your approval on Q3 budget/ })).toHaveLength(1);
    expect(container.querySelector(".kinbox-row")).toBeNull();
    // the group is the first thing in the list
    const list = container.querySelector(".kinbox-list")!;
    expect(list.firstElementChild?.textContent).toMatch(/Approvals for you/);
    // its unread notice still counts once, as the group's row
    expect(onNewCount).toHaveBeenLastCalledWith(1);
  });

  it("never claims Inbox zero while a request waits on you", () => {
    inbox([], { approvals: { toReview: [request()], projects: PROJECTS, members: people } });
    expect(screen.queryByText("Inbox zero.")).toBeNull();
    inbox([], { approvals: { toReview: [], projects: PROJECTS, members: people } });
    expect(screen.getByText("Inbox zero.")).toBeInTheDocument();
  });

  it("reads decisions on your requests as sentences, with the reviewer's words quoted", () => {
    inbox([notice({ id: "n2", detail: "Maya Lin", readAt: iso(), meta: { approvalId: "ap-9", event: "changes_requested", status: "changes_requested", comment: "Warmer palette, please." } })]);
    expect(screen.getByRole("button", { name: /Maya Lin asked for changes on Q3 budget/ })).toBeInTheDocument();
    expect(screen.getByText("“Warmer palette, please.”")).toBeInTheDocument();
    // "changes requested" sends the task back to you: New to you, not FYI
    expect(screen.getByRole("region", { name: "New to you" })).toBeInTheDocument();
  });

  it("shows a request that's no longer waiting on you as an ordinary notice", () => {
    inbox([notice({ id: "n3", readAt: iso(), meta: { approvalId: "ap-old", event: "requested", status: "pending", rule: "any" } })], {
      approvals: { toReview: [], projects: PROJECTS, members: people },
    });
    expect(screen.getByRole("button", { name: /Sana Rao asked for your approval on Q3 budget/ })).toBeInTheDocument();
  });
});

describe("Inbox › doc mentions (0047)", () => {
  const mention = (over: Partial<Activity> = {}): Activity => ({
    id: "d1", taskId: null, taskTitle: "Launch brief", kind: "doc_mention", detail: "Sana Rao", createdAt: iso(60_000),
    meta: { docId: "doc-launch-brief", projectId: "p-launch" }, ...over,
  });

  it("says who mentioned you in which doc, with the doc's project, and opens the doc", () => {
    const onOpenDoc = vi.fn();
    const { props } = inbox([mention()], { onOpenDoc });
    const row = screen.getByRole("button", { name: /Sana Rao mentioned you in Launch brief/ });
    expect(row).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText(/· Docs/)).toBeInTheDocument();
    fireEvent.click(row);
    expect(onOpenDoc).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "New to you" })).getByText("Launch brief")).toBeInTheDocument();
  });

  it("without a way to open docs (or without its doc), the row is inert", () => {
    inbox([mention({ meta: undefined })], { onOpenDoc: vi.fn() });
    expect(screen.getByRole("button", { name: /Sana Rao mentioned you in Launch brief/ })).toHaveAttribute("aria-disabled", "true");
  });
});
