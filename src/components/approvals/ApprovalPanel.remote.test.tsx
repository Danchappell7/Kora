/* TaskDetail › Approval against a (mocked) backend: before 0047 it stays out
   of the way; a failed load says so with Try again; a refusal reads plainly. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { rpc, invoke } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    from: () => { throw new Error("not used"); },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: async () => {},
  },
  isSupabaseConfigured: true,
}));

import { ApprovalPanel } from "./ApprovalPanel";
import { ApprovalsInboxGroup } from "./ApprovalsInboxGroup";
import { resetApprovalsDemo } from "../../lib/approvals";
import type { Member, Task } from "../../data/types";

const WS = "851dadfe-dfce-497d-bf03-4e4a1394ad30";
const ME = "228cd532-0fa5-41b7-83d6-4d5cf399b0dd";
const OLIVE = "78fc9c29-3f55-427d-bc09-f503e0ddd89e";
const TASK = { id: "5b2484e9-79b1-4e86-9488-dc2b6a68e0ee", title: "Homepage copy", status: "todo", priority: "medium", projectId: "p", workspaceId: WS,
  assigneeId: ME, tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, description: "" } as unknown as Task;
const MEMBERS: Member[] = [
  { id: ME, name: "Sana Malik", email: "sana@acme.test", type: "self", color: "oklch(0.7 0.1 200)" },
  { id: OLIVE, name: "Olive Owner", email: "olive@acme.test", type: "team", color: "oklch(0.7 0.1 100)" },
];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const pgErr = (message: string, code = "P0001") => ({ data: null, error: { message, code } });

beforeEach(() => { resetApprovalsDemo({ demoDelayMs: 0 }); rpc.mockReset(); invoke.mockReset(); invoke.mockResolvedValue({ data: {}, error: null }); });

describe("ApprovalPanel (backend)", () => {
  it("before 0047: renders nothing", async () => {
    rpc.mockResolvedValue(pgErr("Could not find the function public.task_approvals", "PGRST202"));
    const { container } = render(<ApprovalPanel task={TASK} members={MEMBERS} currentUserId={ME} />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it("a failed load says so, and Try again works", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "TypeError: Failed to fetch", code: "" } });
    render(<ApprovalPanel task={TASK} members={MEMBERS} currentUserId={ME} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You're offline. Check your connection and try again.");
    rpc.mockResolvedValueOnce({ data: [], error: null });
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Request approval" })).toBeInTheDocument();
  });

  it("someone asked first: the refusal reads plainly and the panel reloads to show theirs", async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    render(<ApprovalPanel task={TASK} members={MEMBERS} currentUserId={ME} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request approval" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Choose reviewers" })).getByRole("option", { name: /Olive Owner/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    rpc.mockResolvedValueOnce(pgErr("already pending"));
    rpc.mockResolvedValueOnce({ data: [], error: null });
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));
    expect(await screen.findByText("This task already has an open request. Cancel it first, or wait for the decision.")).toBeInTheDocument();
    await waitFor(() => expect(rpc).toHaveBeenLastCalledWith("task_approvals", { p_task: TASK.id }));
    expect(rpc).toHaveBeenCalledWith("request_approval", expect.objectContaining({ p_task: TASK.id, p_reviewers: [OLIVE], p_rule: "any" }));
  });

  it("the Inbox group: an error on one row stays on that row", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "TypeError: Failed to fetch", code: "" } });
    const a = {
      id: "ap", taskId: TASK.id, workspaceId: WS, requestedBy: OLIVE, requestedByName: "Olive Owner", title: "Homepage copy", note: null, attachmentId: null,
      status: "pending" as const, rule: "any" as const, createdAt: "2026-10-09T08:00:00Z", updatedAt: "2026-10-09T08:00:00Z", resolvedAt: null,
      reviewers: [{ userId: ME, name: "Sana Malik", decision: null, comment: null, decidedAt: null }], canDecide: true, canCancel: false,
      task: { id: TASK.id, title: "Homepage copy", projectId: "p", workspaceId: WS, status: "todo" as const, dueDate: null },
    };
    render(<ApprovalsInboxGroup approvals={[a]} projects={[]} members={MEMBERS} currentUserId={ME} onOpenTask={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve “Homepage copy”" }));
    const row = screen.getByRole("listitem");
    expect(await within(row).findByRole("alert")).toHaveTextContent(/offline/);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
