/* lib/approvals in demo mode (no Supabase): the fakes behave like the 0047
   functions (who may do what, how a request resolves, one open request per
   task), plus the pure helpers the integrator wires in. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_NOTIFY_ROW, DEMO_APPROVAL_ACTIVITY, approvalBadgeAria, approvalErrorText, approvalEventText, approvalInboxLine, approvalWaitingNote,
  approvalsInWorkspace,
  cancelApproval, decideApproval, demoApprovalEvents, listApprovalSummaries, listMyApprovals, listTaskApprovals, nameList,
  rememberApprovalTask, requestApproval, resetApprovalsDemo, shownInApprovalsGroup, subscribeApprovals, waitingOnApproval, waitingOnApprovalTaskIds,
} from "./approvals";
import { parseActivityMeta } from "./activityMeta";
import { TASKS } from "../data/data";
import type { Approval, ApprovalReviewer } from "../data/types";

beforeEach(() => resetApprovalsDemo({ demoDelayMs: 0 }));

const rev = (name: string, decision: ApprovalReviewer["decision"] = null): ApprovalReviewer => ({ userId: name, name, decision, comment: null, decidedAt: decision ? "2026-10-09T09:00:00Z" : null });

describe("demo: what's waiting", () => {
  it("two requests wait on you, one you made is half approved", async () => {
    const my = await listMyApprovals();
    expect(my.toReview.map((a) => a.task?.title)).toEqual(["Define design tokens v2", "Set up usage analytics events"]);
    expect(my.toReview.every((a) => a.canDecide && !a.canCancel && a.status === "pending")).toBe(true);
    expect(my.toReview[0]).toMatchObject({ requestedByName: "Sana Rao", rule: "any", task: { projectId: "p-brand", workspaceId: "ws-foundrise" } });
    expect(my.requested).toHaveLength(1);
    expect(my.requested[0]).toMatchObject({ taskId: "t-1", rule: "all", canCancel: true, canDecide: false });
    expect(approvalWaitingNote(my.requested[0])).toBe("1 of 2 approved · waiting on Sana");
    // the decided reviewer comes first, with their comment
    expect(my.requested[0].reviewers.map((r) => [r.name, r.decision])).toEqual([["Maya Lin", "approved"], ["Sana Rao", null]]);
  });
  it("a task's requests, newest first; badges = each task's latest", async () => {
    const hero = await listTaskApprovals("t-9");
    expect(hero.map((a) => a.status)).toEqual(["changes_requested", "cancelled"]);
    expect(hero[0].reviewers[0]).toMatchObject({ userId: "m-self", decision: "changes_requested" });
    expect(await listTaskApprovals("t-nope")).toEqual([]);
    const s = await listApprovalSummaries("ws-foundrise");
    expect(Object.keys(s).sort()).toEqual(["t-1", "t-10", "t-4", "t-9"]);
    expect(s["t-1"]).toMatchObject({ status: "pending", rule: "all", approved: 1, total: 2 });
    expect(s["t-9"].status).toBe("changes_requested");
    expect(await listApprovalSummaries("ws-reco")).toEqual({});
  });
});

describe("demo: asking, deciding, cancelling", () => {
  it("asks on a team task (yourself dropped); one open request per task; personal tasks and bad lists refused", async () => {
    const a = await requestApproval({ taskId: "t-2", reviewerIds: ["m-1", "m-self", "m-1", "m-4"], rule: "all", note: "  Ready for a look  " });
    expect(a).toMatchObject({ status: "pending", rule: "all", note: "Ready for a look", requestedBy: "m-self", canCancel: true, canDecide: false, title: "Ship onboarding redesign to staging" });
    expect(a.reviewers.map((r) => r.userId).sort()).toEqual(["m-1", "m-4"]);
    await expect(requestApproval({ taskId: "t-2", reviewerIds: ["m-2"], rule: "any" })).rejects.toThrow(/already pending/);
    await expect(requestApproval({ taskId: "t-5", reviewerIds: ["m-2"], rule: "any" })).rejects.toThrow(/need a team task/);
    await expect(requestApproval({ taskId: "t-3", reviewerIds: ["m-self"], rule: "any" })).rejects.toThrow(/invalid reviewers/);
    await expect(requestApproval({ taskId: "t-3", reviewerIds: Array.from({ length: 11 }, (_, i) => `x${i}`), rule: "any" })).rejects.toThrow(/invalid reviewers/);
    await expect(requestApproval({ taskId: "t-3", reviewerIds: ["m-1"], rule: "most" as never })).rejects.toThrow(/invalid rule/);
    await expect(requestApproval({ taskId: "t-3", reviewerIds: ["m-1"], rule: "any", note: "x".repeat(2001) })).rejects.toThrow(/invalid note/);
    await expect(requestApproval({ taskId: "t-unknown", reviewerIds: ["m-1"], rule: "any" })).rejects.toThrow(/task not found/);
    expect((await listMyApprovals()).requested.map((x) => x.taskId)).toEqual(["t-2", "t-1"]);
  });
  it("a task made this session can be asked about once the panel has told the fakes about it", async () => {
    rememberApprovalTask({ id: "t-new", title: "Brand new", projectId: "p-launch", status: "todo" });
    const a = await requestApproval({ taskId: "t-new", reviewerIds: ["m-2"], rule: "any" });
    expect(a).toMatchObject({ workspaceId: "ws-foundrise", title: "Brand new" });
  });
  it("deciding resolves like the server: any → first approval; a change of mind is allowed until it resolves", async () => {
    const r = await decideApproval("ap-demo-1", "approved", "  Lovely  ");
    expect(r).toMatchObject({ status: "approved", canDecide: false });
    expect(r.resolvedAt).toBeTruthy();
    expect(r.reviewers.find((x) => x.userId === "m-self")).toMatchObject({ decision: "approved", comment: "Lovely" });
    await expect(decideApproval("ap-demo-1", "changes_requested")).rejects.toThrow(/approval closed/);
    await expect(decideApproval("ap-demo-3", "approved")).rejects.toThrow(/approval not found/);   // not a reviewer
    await expect(decideApproval("ap-demo-2", "maybe" as never)).rejects.toThrow(/invalid decision/);
    await expect(decideApproval("ap-demo-2", "approved", "x".repeat(2001))).rejects.toThrow(/invalid comment/);
    const c = await decideApproval("ap-demo-2", "changes_requested", "Rename two events");
    expect(c.status).toBe("changes_requested");
    expect((await listMyApprovals()).toReview).toHaveLength(0);
  });
  it("only the requester cancels; a closed request can't be", async () => {
    await expect(cancelApproval("ap-demo-1")).rejects.toThrow(/approval not found/);
    const c = await cancelApproval("ap-demo-3");
    expect(c).toMatchObject({ status: "cancelled", canCancel: false });
    await expect(cancelApproval("ap-demo-3")).rejects.toThrow(/approval closed/);
    expect((await listApprovalSummaries("ws-foundrise"))["t-1"].status).toBe("cancelled");
  });
  it("listeners hear the fakes' changes; unsubscribe stops them", async () => {
    const heard = vi.fn();
    const off = subscribeApprovals(heard);
    await decideApproval("ap-demo-1", "approved");
    expect(heard).toHaveBeenCalledWith({ table: "approval_reviewers", approvalId: "ap-demo-1", taskId: "t-4" });
    off();
    await cancelApproval("ap-demo-3");
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("demo Inbox items and history", () => {
  it("activity rows carry meta the Inbox can word", () => {
    expect(DEMO_APPROVAL_ACTIVITY.every((a) => a.kind === "approval" && a.meta?.approvalId)).toBe(true);
    expect(DEMO_APPROVAL_ACTIVITY.map((a) => a.createdAt)).toEqual([...DEMO_APPROVAL_ACTIVITY.map((a) => a.createdAt)].sort().reverse());
    for (const a of DEMO_APPROVAL_ACTIVITY) expect(TASKS.find((t) => t.id === a.taskId)?.title).toBe(a.taskTitle);
    expect(parseActivityMeta({ approval_id: "x", event: "requested", status: "pending" })).toMatchObject({ event: "requested" });
  });
  it("history rows: requested, each decision with the status after it, a cancel", () => {
    expect(demoApprovalEvents("t-1").map((e) => `${e.newValue}/${e.oldValue}`)).toEqual(["approved/pending", "requested/pending"]);
    expect(demoApprovalEvents("t-9").map((e) => e.newValue)).toEqual(["changes_requested", "requested", "cancelled", "requested"]);
    expect(demoApprovalEvents("t-9").every((e) => e.field === "approval" && e.actorName)).toBe(true);
  });
});

describe("helpers", () => {
  const base = { status: "pending" as const, rule: "any" as const };
  it("waiting notes", () => {
    expect(approvalWaitingNote({ ...base, reviewers: [rev("Sana Rao")] })).toBe("Waiting on Sana");
    expect(approvalWaitingNote({ ...base, reviewers: [rev("Sana Rao"), rev("Maya Lin")] })).toBe("Waiting on Sana or Maya");
    expect(approvalWaitingNote({ ...base, rule: "all", reviewers: [rev("Sana Rao"), rev("Maya Lin")] })).toBe("Waiting on Sana and Maya");
    expect(approvalWaitingNote({ ...base, rule: "all", reviewers: [rev("Sana Rao", "approved"), rev("maya@x.io")] })).toBe("1 of 2 approved · waiting on maya@x.io");
    expect(approvalWaitingNote({ status: "approved", rule: "any", reviewers: [] })).toBe("Approved");
    expect(nameList(["A", "B", "C", "D", "E"])).toBe("A and 4 others");
    expect(nameList(["A", "B", "C"], "or")).toBe("A, B or C");
  });
  it("My tasks › Waiting on approval", () => {
    const mk = (id: string, taskId: string, status: Approval["status"] = "pending") =>
      ({ id, taskId, status, rule: "any", reviewers: [rev("Theo Vance")] }) as unknown as Approval & { task: null };
    const my = { requested: [mk("a", "t-1"), mk("b", "t-2", "approved"), mk("c", "t-99")] };
    expect([...waitingOnApprovalTaskIds(my)]).toEqual(["t-1", "t-99"]);
    const w = waitingOnApproval(my, TASKS);
    expect(w).toMatchObject({ key: "approval", label: "Waiting on approval" });
    expect(w.items.map((t) => t.id)).toEqual(["t-1"]);
    expect(w.notes.get("t-1")).toBe("Waiting on Theo");
  });
  it("Inbox words for approval notices; requests still in the group aren't listed twice", () => {
    expect(approvalInboxLine({ detail: "Sana Rao", meta: { event: "requested", status: "pending" } })).toEqual({ actor: "Sana Rao", verb: "asked for your approval on", quote: null });
    expect(approvalInboxLine({ detail: " Olive ", meta: { event: "changes_requested", status: "changes_requested", comment: " Tone it down " } }))
      .toEqual({ actor: "Olive", verb: "asked for changes on", quote: "Tone it down" });
    expect(approvalInboxLine({ detail: "", meta: { event: "approved", status: "pending", comment: null } })).toEqual({ actor: "Someone", verb: "approved their part of", quote: null });
    const [req, dec] = [DEMO_APPROVAL_ACTIVITY.find((a) => a.id === "a-demo-ap-1")!, DEMO_APPROVAL_ACTIVITY.find((a) => a.id === "a-demo-ap-2")!];
    expect(shownInApprovalsGroup(req, [{ id: "ap-demo-1" }])).toBe(true);
    expect(shownInApprovalsGroup(req, [{ id: "ap-demo-2" }])).toBe(false);
    expect(shownInApprovalsGroup(dec, [{ id: "ap-demo-3" }])).toBe(false);
  });
  it("timeline words for task_events field 'approval'", () => {
    expect(approvalEventText("requested", "pending")).toBe("asked for approval");
    expect(approvalEventText("approved", "approved")).toBe("approved it");
    expect(approvalEventText("approved", "pending")).toBe("approved it, still waiting on others");
    expect(approvalEventText("changes_requested", "changes_requested")).toBe("asked for changes");
    expect(approvalEventText("cancelled", "cancelled")).toBe("cancelled the approval request");
    expect(approvalEventText("moved", "cancelled")).toBe("moved the task, so its approval request was cancelled");
    expect(approvalEventText(null, null)).toBe("updated the approval request");
  });
  it("Approvals for you: only requests whose task is in this workspace now", () => {
    const task = (workspaceId: string | null) => ({ id: "t", title: "T", projectId: "p", workspaceId, status: "todo" as const, dueDate: null });
    const here = { id: "a1", workspaceId: "ws-a", task: task("ws-a") };
    const movedAway = { id: "a2", workspaceId: "ws-a", task: task("ws-b") };      // listed before its task moved to B
    const toPersonal = { id: "a3", workspaceId: "ws-a", task: task(null) };
    const elsewhere = { id: "a4", workspaceId: "ws-b", task: task("ws-b") };
    const noTask = { id: "a5", workspaceId: "ws-a", task: null };
    const list = [here, movedAway, toPersonal, elsewhere, noTask];
    expect(approvalsInWorkspace(list, "ws-a").map((a) => a.id)).toEqual(["a1", "a5"]);
    expect(approvalsInWorkspace(list, "ws-b").map((a) => a.id)).toEqual(["a4"]);   // never the old workspace's request
    expect(approvalsInWorkspace(list, null)).toEqual([]);
  });
  it("badges for screen readers; the Settings row", () => {
    expect(approvalBadgeAria({ status: "pending", rule: "all", approved: 1, total: 3 })).toBe("Approval pending, 1 of 3 approved");
    expect(approvalBadgeAria({ status: "pending", rule: "any", approved: 0, total: 3 })).toBe("Approval pending");
    expect(approvalBadgeAria({ status: "changes_requested", rule: "any", approved: 0, total: 1 })).toBe("Changes requested");
    expect(APPROVAL_NOTIFY_ROW.key).toBe("approval");
  });
  it("failures in plain words", () => {
    expect(approvalErrorText(new Error("already pending"), "request")).toMatch(/already has an open request/);
    expect(approvalErrorText(new Error("invalid reviewers"), "request")).toMatch(/1 to 10 people/);
    expect(approvalErrorText(new Error("invalid note"), "request")).toMatch(/2,000/);
    expect(approvalErrorText(new Error("approvals need a team task"), "request")).toMatch(/team workspace/);
    expect(approvalErrorText(new Error("task not found"), "request")).toMatch(/can't edit it/);
    expect(approvalErrorText(new Error("approval not found"), "cancel")).toMatch(/isn't there any more/);
    expect(approvalErrorText(new Error("not authorized"), "cancel")).toMatch(/owner or admin/);
    expect(approvalErrorText(new TypeError("Failed to fetch"))).toMatch(/offline/);
    expect(approvalErrorText({ code: "PGRST202", message: "Could not find the function" })).toMatch(/switched on/);
    expect(approvalErrorText(new Error("boom"))).toBe("Couldn't load approvals. Try again.");
  });
});
