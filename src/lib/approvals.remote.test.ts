/* lib/approvals against a (mocked) real backend: the 0047 definer
   functions, the badge query, the notify call and realtime — and every way
   they fail (0047 not run, refusals, offline). Fixtures are the JSON the
   0047 functions returned in the PGlite replay. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, invoke, from, channel, removeChannel } = vi.hoisted(() => ({
  rpc: vi.fn(), invoke: vi.fn(), from: vi.fn(), channel: vi.fn(), removeChannel: vi.fn(async (..._a: unknown[]) => "ok"),
}));
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    from: (...a: unknown[]) => from(...a),
    channel: (...a: unknown[]) => channel(...a),
    removeChannel: (...a: unknown[]) => removeChannel(...a),
  },
  isSupabaseConfigured: true,
}));

import {
  cancelApproval, decideApproval, listApprovalSummaries, listMyApprovals, listTaskApprovals, requestApproval, resetApprovalsDemo, subscribeApprovals,
} from "./approvals";
import { approvalFailure } from "./approvals";

const WS = "851dadfe-dfce-497d-bf03-4e4a1394ad30";
const SANA = "228cd532-0fa5-41b7-83d6-4d5cf399b0dd";
const OLIVE = "78fc9c29-3f55-427d-bc09-f503e0ddd89e";
const GUS = "28b9eec2-f42f-4505-9833-598b3db3e06c";
const TASK = "5b2484e9-79b1-4e86-9488-dc2b6a68e0ee";
const AP = "de277e17-7932-43d5-bac4-39158b9273cc";
const APPROVAL = {
  id: AP, note: "Is the tone right?", rule: "all", title: "Homepage copy", status: "pending", task_id: TASK,
  reviewers: [
    { name: "Gus Guest", comment: null, user_id: GUS, decision: null, decided_at: null },
    { name: "Olive Owner", comment: null, user_id: OLIVE, decision: null, decided_at: null },
  ],
  can_cancel: true, can_decide: false, created_at: "2026-10-09T00:10:11.376+00:00", updated_at: "2026-10-09T00:10:11.376+00:00",
  resolved_at: null, requested_by: SANA, workspace_id: WS, attachment_id: null, requested_by_name: "Sana Malik",
};
const ok = (data: unknown) => ({ data, error: null });
const pgErr = (message: string, code = "P0001") => ({ data: null, error: { message, code, details: null, hint: null } });

/** a PostgREST-ish query builder that records its calls and resolves to `result` */
function table(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = { calls };
  for (const k of ["select", "eq", "in", "order", "limit"]) q[k] = vi.fn((...a: unknown[]) => { calls.push([k, a]); return q; });
  (q as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q as typeof q & { calls: [string, unknown[]][] };
}

beforeEach(() => {
  resetApprovalsDemo({ demoDelayMs: 0 });
  rpc.mockReset(); invoke.mockReset(); from.mockReset(); channel.mockReset(); removeChannel.mockClear();
  invoke.mockResolvedValue({ data: { ok: true }, error: null });
});

describe("reading", () => {
  it("a task's requests through task_approvals()", async () => {
    rpc.mockResolvedValue(ok([APPROVAL, { ...APPROVAL, id: "x", status: "maybe" }]));
    const list = await listTaskApprovals(TASK);
    expect(rpc).toHaveBeenCalledWith("task_approvals", { p_task: TASK });
    expect(list).toHaveLength(1);   // the malformed one is dropped
    expect(list[0]).toMatchObject({ id: AP, rule: "all", canCancel: true, requestedByName: "Sana Malik" });
  });
  it("waiting on you / you asked through list_my_approvals()", async () => {
    rpc.mockResolvedValue(ok({ requested: [{ ...APPROVAL, task: { id: TASK, title: "Homepage copy", status: "todo", due_date: null, project_id: "p", workspace_id: WS } }], to_review: [] }));
    const my = await listMyApprovals();
    expect(rpc).toHaveBeenCalledWith("list_my_approvals", {});
    expect(my.requested[0].task).toMatchObject({ title: "Homepage copy", projectId: "p" });
    expect(my.toReview).toEqual([]);
  });
  it("before 0047: 'unavailable', and it stops asking (and badges quietly read as none)", async () => {
    rpc.mockResolvedValue(pgErr("Could not find the function public.task_approvals(p_task) in the schema cache", "PGRST202"));
    await expect(listTaskApprovals(TASK)).rejects.toSatisfy((e: unknown) => approvalFailure(e) === "unavailable");
    await expect(listMyApprovals()).rejects.toSatisfy((e: unknown) => approvalFailure(e) === "unavailable");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await listApprovalSummaries(WS)).toEqual({});
    expect(from).not.toHaveBeenCalled();
  });
  it("badges: one query, newest first, latest per task wins; reviews counted", async () => {
    const q = table(ok([
      { id: "a3", task_id: "t1", status: "pending", rule: "all", created_at: "3", approval_reviewers: [{ decision: "approved" }, { decision: null }] },
      { id: "a2", task_id: "t1", status: "approved", rule: "any", created_at: "2", approval_reviewers: [{ decision: "approved" }] },
      { id: "a1", task_id: "t2", status: "cancelled", rule: "any", created_at: "1", approval_reviewers: [] },
      { id: "bad", task_id: "t3", status: "weird", rule: "any", created_at: "0", approval_reviewers: [] },
    ]));
    from.mockReturnValue(q);
    const s = await listApprovalSummaries(WS);
    expect(from).toHaveBeenCalledWith("approvals");
    expect(q.calls).toEqual([
      ["select", ["id,task_id,status,rule,created_at,approval_reviewers(decision)"]],
      ["eq", ["workspace_id", WS]],
      ["order", ["created_at", { ascending: false }]],
      ["limit", [1000]],
    ]);
    expect(s).toEqual({
      t1: { approvalId: "a3", taskId: "t1", status: "pending", rule: "all", approved: 1, total: 2 },
      t2: { approvalId: "a1", taskId: "t2", status: "cancelled", rule: "any", approved: 0, total: 0 },
    });
  });
  it("badges: a missing table reads as none from then on; other errors throw", async () => {
    from.mockReturnValueOnce(table({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.approvals' in the schema cache" } }));
    expect(await listApprovalSummaries(WS)).toEqual({});
    expect(await listApprovalSummaries(WS)).toEqual({});
    expect(from).toHaveBeenCalledTimes(1);
    resetApprovalsDemo();
    from.mockReturnValueOnce(table({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }));
    await expect(listApprovalSummaries(WS)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("writing", () => {
  it("request_approval with every parameter, then tells notify which approval (best-effort)", async () => {
    rpc.mockResolvedValue(ok(APPROVAL));
    const a = await requestApproval({ taskId: TASK, reviewerIds: [OLIVE, GUS, OLIVE], rule: "all", note: "  Is the tone right?  ", attachmentId: "f1" });
    expect(rpc).toHaveBeenCalledWith("request_approval", {
      p_task: TASK, p_reviewers: [OLIVE, GUS], p_note: "Is the tone right?", p_rule: "all", p_title: null, p_attachment: "f1",
    });
    expect(a.id).toBe(AP);
    expect(invoke).toHaveBeenCalledWith("notify", { body: { kind: "approval", approvalId: AP } });
  });
  it("a notify that fails (not deployed, offline) never fails the request", async () => {
    rpc.mockResolvedValue(ok(APPROVAL));
    invoke.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(requestApproval({ taskId: TASK, reviewerIds: [OLIVE], rule: "any" })).resolves.toMatchObject({ id: AP });
    invoke.mockImplementation(() => { throw new Error("sync boom"); });
    await expect(requestApproval({ taskId: TASK, reviewerIds: [OLIVE], rule: "any" })).resolves.toMatchObject({ id: AP });
  });
  it("refused before asking: no reviewers, too many, a long note; the server's refusals come through", async () => {
    await expect(requestApproval({ taskId: TASK, reviewerIds: [], rule: "any" })).rejects.toThrow(/invalid reviewers/);
    await expect(requestApproval({ taskId: TASK, reviewerIds: Array.from({ length: 11 }, (_, i) => `u${i}`), rule: "any" })).rejects.toThrow(/invalid reviewers/);
    await expect(requestApproval({ taskId: TASK, reviewerIds: [OLIVE], rule: "any", note: "n".repeat(2001) })).rejects.toThrow(/invalid note/);
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue(pgErr("already pending"));
    await expect(requestApproval({ taskId: TASK, reviewerIds: [OLIVE], rule: "any" })).rejects.toSatisfy((e: unknown) => approvalFailure(e) === "already_pending");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("decide_approval (your own review), then notify; a closed request says so", async () => {
    rpc.mockResolvedValue(ok({ ...APPROVAL, status: "changes_requested", resolved_at: APPROVAL.updated_at }));
    const a = await decideApproval(AP, "changes_requested", "  Shorter, please ");
    expect(rpc).toHaveBeenCalledWith("decide_approval", { p_approval: AP, p_decision: "changes_requested", p_comment: "Shorter, please" });
    expect(a.status).toBe("changes_requested");
    expect(invoke).toHaveBeenCalledWith("notify", { body: { kind: "approval", approvalId: AP } });
    rpc.mockResolvedValue(pgErr("approval closed"));
    await expect(decideApproval(AP, "approved")).rejects.toSatisfy((e: unknown) => approvalFailure(e) === "closed");
    await expect(decideApproval(AP, "approved", "c".repeat(2001))).rejects.toThrow(/invalid comment/);
  });
  it("cancel_approval: no email for a withdrawn request; offline reads as network", async () => {
    rpc.mockResolvedValue(ok({ ...APPROVAL, status: "cancelled", resolved_at: APPROVAL.updated_at, can_cancel: false }));
    expect((await cancelApproval(AP)).status).toBe("cancelled");
    expect(rpc).toHaveBeenCalledWith("cancel_approval", { p_approval: AP });
    expect(invoke).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: { message: "TypeError: Failed to fetch", code: "" } });
    await expect(cancelApproval(AP)).rejects.toSatisfy((e: unknown) => approvalFailure(e) === "network");
  });
});

describe("realtime", () => {
  it("both tables, RLS-scoped; changes carry the approval (and task when the row has it); unsubscribe removes the channel", () => {
    const handlers: Record<string, (p: unknown) => void> = {};
    const ch = {
      on: vi.fn((_: string, f: { table: string }, h: (p: unknown) => void) => { handlers[f.table] = h; return ch; }),
      subscribe: vi.fn(() => ch),
    };
    channel.mockReturnValue(ch);
    const heard = vi.fn();
    const off = subscribeApprovals(heard);
    expect(ch.on).toHaveBeenCalledWith("postgres_changes", { event: "*", schema: "public", table: "approvals" }, expect.any(Function));
    expect(ch.on).toHaveBeenCalledWith("postgres_changes", { event: "*", schema: "public", table: "approval_reviewers" }, expect.any(Function));
    handlers.approvals({ new: { id: AP, task_id: TASK }, old: {} });
    handlers.approval_reviewers({ new: {}, old: { approval_id: AP, user_id: OLIVE } });
    handlers.approvals({ new: {}, old: {} });
    expect(heard.mock.calls).toEqual([
      [{ table: "approvals", approvalId: AP, taskId: TASK }],
      [{ table: "approval_reviewers", approvalId: AP, taskId: null }],
    ]);
    off();
    expect(removeChannel).toHaveBeenCalledWith(ch);
  });
});
