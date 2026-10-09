/* The 0047 contract pieces the architect wrote as final (parsers, error
   mapping, summaries, addresses, component props). The JSON below is what
   the 0047 definer functions and tables returned in the PGlite replay of
   0001–0047, so a change on either side shows up here. Kept in its own file
   so no package edits it. */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { parseActivityMeta } from "./activityMeta";
import { daysLeft, parseTrashBulk, parseTrashItem, parseTrashRestoreResult, trashFailure, TRASH_COLUMNS } from "./trash";
import { AUDIT_ACTIONS, AUDIT_ACTION_INFO, auditActionLabel, parseAuditEvent } from "./audit";
import { approvalBadgeLabel, approvalFailure, approvalSummary, parseApproval, parseMyApprovals, resolveApprovalStatus } from "./approvals";
import { docFailure, DOC_LIST_COLUMNS, parseDocBody, parseDocSaveResult, parseDocVersion, parseProjectDocListItem } from "./docs";
import { PLAN_LIMITS } from "./projectPlanner";
import { pathOf, routeOf } from "./nav";
import { RecycleBin, HistoryLog } from "../components/bin";
import { ApprovalBadge, ApprovalPanel, ApprovalsInboxGroup } from "../components/approvals";
import { DocEditor, DocPage, DocsTab } from "../components/docs";
import { ProjectPlanner } from "../components/planner";
import { SystemStatus } from "../components/admin/SystemStatus";
import type { PlanApplyDeps, Task } from "../data/types";

const WS = "851dadfe-dfce-497d-bf03-4e4a1394ad30";
const SANA = "228cd532-0fa5-41b7-83d6-4d5cf399b0dd";
const OLIVE = "78fc9c29-3f55-427d-bc09-f503e0ddd89e";
const GUS = "28b9eec2-f42f-4505-9833-598b3db3e06c";
const TASK = "5b2484e9-79b1-4e86-9488-dc2b6a68e0ee";
const PROJ = "046b1461-13eb-44bd-9341-dea2491479a1";

const TRASH_TASK = {
  id: "938a7942-db67-4851-9730-dfc20f3a80c0", kind: "task", item_id: TASK, workspace_id: WS, user_id: SANA, project_id: PROJ,
  title: "Homepage copy",
  summary: {
    counts: { docs: 0, tasks: 2, comments: 1, sections: 0, subtasks: 1, checklist: 0, attachments: 0 }, parent: null, status: "todo",
    project: { id: PROJ, name: "Website", color: "oklch(0.7 0.12 160)", emoji: "🌐" }, archived: false, due_date: "2026-10-14",
    priority: "high", assignee_id: SANA,
  },
  deleted_by: SANA, deleted_by_name: "Sana Malik", deleted_at: "2026-10-09T00:10:11.392Z", purge_after: "2026-11-08T00:10:11.392Z",
  restored_at: null, restored_by: null,
};
const TRASH_PROJECT = {
  id: "6e431a3f-a9c4-4ad5-9162-57d65c8bbcee", kind: "project", item_id: "f8e55890-c284-45ff-bc09-a85c9cc30c7f", workspace_id: WS,
  user_id: OLIVE, project_id: "f8e55890-c284-45ff-bc09-a85c9cc30c7f", title: "Old site",
  summary: {
    counts: { docs: 0, tasks: 1, comments: 0, sections: 0, checklist: 0, attachments: 0 },
    project: { id: "f8e55890-c284-45ff-bc09-a85c9cc30c7f", name: "Old site", color: "oklch(0.7 0.12 40)", emoji: "🗂️", description: null }, archived: false,
  },
  deleted_by: OLIVE, deleted_by_name: "Olive Owner", deleted_at: "2026-10-09T00:10:11.399Z", purge_after: "2026-11-08T00:10:11.399Z",
  restored_at: null, restored_by: null,
};
const RESTORED = {
  id: "938a7942-db67-4851-9730-dfc20f3a80c0", kind: "task", note: "Its project was deleted, so it's back in “Old site”.",
  counts: { docs: 0, tasks: 2, comments: 1, sections: 0, subtasks: 1, checklist: 0, attachments: 0 }, status: "restored", item_id: TASK,
  project_id: "f8e55890-c284-45ff-bc09-a85c9cc30c7f",
};
const BULK = [
  { id: TRASH_PROJECT.id, ok: true, result: { id: TRASH_PROJECT.id, kind: "project", note: null, counts: TRASH_PROJECT.summary.counts, status: "restored", item_id: TRASH_PROJECT.item_id, project_id: TRASH_PROJECT.item_id } },
  { id: "00000000-0000-4000-8000-000000000000", ok: false, error: "not found" },
];
const AUDIT = {
  id: "c9f6a701-059e-4795-b6cf-8055436f54f8", workspace_id: WS, actor_id: SANA, actor_name: "Sana Malik", action: "task.deleted",
  target_kind: "task", target_id: TASK, target_title: "Homepage copy",
  detail: { subtasks: 1, trash_id: "938a7942-db67-4851-9730-dfc20f3a80c0", project_id: PROJ }, created_at: "2026-10-09T00:10:11.392Z",
};
const APPROVAL_DECIDED = {
  id: "de277e17-7932-43d5-bac4-39158b9273cc", note: "Is the tone right?", rule: "all", title: "Homepage copy", status: "changes_requested", task_id: TASK,
  reviewers: [
    { name: "Gus Guest", comment: "Shorter, please", user_id: GUS, decision: "changes_requested", decided_at: "2026-10-09T00:10:11.38+00:00" },
    { name: "Olive Owner", comment: null, user_id: OLIVE, decision: null, decided_at: null },
  ],
  can_cancel: false, can_decide: false, created_at: "2026-10-09T00:10:11.376+00:00", updated_at: "2026-10-09T00:10:11.38+00:00",
  resolved_at: "2026-10-09T00:10:11.38+00:00", requested_by: SANA, workspace_id: WS, attachment_id: null, requested_by_name: "Sana Malik",
};
const MY_APPROVALS = {
  requested: [],
  to_review: [{
    id: "512e42b5-9ad7-4924-8a6f-cbbd24b2fcbf", note: null, rule: "any",
    task: { id: "fe0e4465-167e-4ba7-92cc-8e075aaea9bf", title: "Pricing table", status: "todo", due_date: null, project_id: PROJ, workspace_id: WS },
    title: "Pricing table", status: "pending", task_id: "fe0e4465-167e-4ba7-92cc-8e075aaea9bf",
    reviewers: [{ name: "Olive Owner", comment: null, user_id: OLIVE, decision: null, decided_at: null }],
    can_cancel: true, can_decide: true, created_at: "2026-10-09T00:10:11.383+00:00", updated_at: "2026-10-09T00:10:11.383+00:00",
    resolved_at: null, requested_by: SANA, workspace_id: WS, attachment_id: null, requested_by_name: "Sana Malik",
  }],
};
const APPROVAL_ACTIVITY_META = { rule: "all", event: "requested", status: "pending", approval_id: "de277e17-7932-43d5-bac4-39158b9273cc" };
const DOC_MENTION_META = { doc_id: "d0c00000-0000-4000-8000-000000000001", project_id: PROJ };
const DOC = {
  id: "d0c00000-0000-4000-8000-000000000001",
  body: [{ id: "b1", type: "h1", spans: [{ text: "Why" }] }, { id: "b2", type: "todo", spans: [{ text: "Pick a date" }], checked: false }],
  icon: "📄", title: "Project brief", can_edit: true, mentions: [OLIVE], position: 1, created_at: "2026-10-09T00:10:11.387+00:00",
  created_by: SANA, project_id: PROJ, updated_at: "2026-10-09T00:10:11.387+00:00", updated_by: SANA, archived_at: null, workspace_id: WS,
  created_by_name: "Sana Malik", updated_by_name: "Sana Malik",
};
const DOC_VERSION = {
  id: "118cb94e-2c28-4983-ad92-51f29a2dd294", doc_id: DOC.id, title: "Project brief", body: DOC.body, saved_by: SANA, saved_at: "2026-10-09T00:10:11.387Z",
};

describe("recycle bin", () => {
  it("parses bin rows (task and project) and never asks for the snapshot", () => {
    const t = parseTrashItem(TRASH_TASK)!;
    expect(t).toMatchObject({ kind: "task", itemId: TASK, workspaceId: WS, title: "Homepage copy", deletedByName: "Sana Malik", restoredAt: null });
    expect(t.summary).toMatchObject({ status: "todo", priority: "high", dueDate: "2026-10-14", archived: false, parent: null });
    expect(t.summary.project).toEqual({ id: PROJ, name: "Website", emoji: "🌐", color: "oklch(0.7 0.12 160)" });
    expect(t.summary.counts).toEqual({ tasks: 2, subtasks: 1, comments: 1, attachments: 0, checklist: 0, sections: 0, docs: 0 });
    const p = parseTrashItem(TRASH_PROJECT)!;
    expect(p).toMatchObject({ kind: "project", title: "Old site" });
    expect(p.summary.project?.description).toBeNull();
    expect(p.summary.counts.subtasks).toBe(0);
    expect(parseTrashItem({ ...TRASH_TASK, kind: "comment" })).toBeNull();
    expect(TRASH_COLUMNS.split(",")).not.toContain("snapshot");
  });
  it("parses restore answers, one at a time and in bulk", () => {
    expect(parseTrashRestoreResult(RESTORED)).toMatchObject({ status: "restored", projectId: "f8e55890-c284-45ff-bc09-a85c9cc30c7f", note: RESTORED.note });
    expect(parseTrashRestoreResult({ ...RESTORED, status: "already_restored", note: null })?.status).toBe("already_restored");
    expect(parseTrashRestoreResult({ ...RESTORED, status: "maybe" })).toBeNull();
    const bulk = parseTrashBulk(BULK);
    expect(bulk[0]).toMatchObject({ ok: true, result: { kind: "project", note: null } });
    expect(bulk[1]).toMatchObject({ ok: false, error: "not_found", message: "not found" });
  });
  it("maps the database's errors", () => {
    expect(trashFailure(new Error("restore conflict"))).toBe("conflict");
    expect(trashFailure(new Error("no project to restore into"))).toBe("no_project");
    expect(trashFailure(new Error("not found"))).toBe("not_found");
    expect(trashFailure(new Error("not authorized"))).toBe("not_allowed");
    expect(trashFailure({ code: "PGRST202", message: "Could not find the function public.restore_from_trash" })).toBe("unavailable");
    expect(trashFailure(new TypeError("Failed to fetch"))).toBe("network");
  });
  it("counts days left, rounding up", () => {
    const now = Date.parse(TRASH_TASK.deleted_at);
    expect(daysLeft(TRASH_TASK.purge_after, now)).toBe(30);
    expect(daysLeft(TRASH_TASK.purge_after, now + 29.5 * 864e5)).toBe(1);
    expect(daysLeft(TRASH_TASK.purge_after, now + 31 * 864e5)).toBe(0);
    expect(daysLeft("nonsense", now)).toBe(0);
  });
});

describe("workspace history", () => {
  it("parses events and labels every action the database writes", () => {
    const e = parseAuditEvent(AUDIT)!;
    expect(e).toMatchObject({ action: "task.deleted", actorName: "Sana Malik", targetKind: "task", targetTitle: "Homepage copy" });
    expect(e.detail.trash_id).toBe("938a7942-db67-4851-9730-dfc20f3a80c0");
    expect(parseAuditEvent({ ...AUDIT, action: "drop table" })).toBeNull();
    expect(parseAuditEvent({ ...AUDIT, action: "doc.shared" })?.action).toBe("doc.shared");   // a later migration's action
    expect(auditActionLabel("doc.shared")).toBe("doc.shared");
    expect(AUDIT_ACTIONS).toHaveLength(19);
    for (const a of ["task.deleted", "project.purged", "member.invited", "role.changed", "workspace.renamed", "integration.connected", "api_key.created", "webhook.created"]) {
      expect(AUDIT_ACTION_INFO[a as keyof typeof AUDIT_ACTION_INFO].label).toBeTruthy();
    }
  });
});

describe("approvals", () => {
  it("parses an approval with every reviewer's decision", () => {
    const a = parseApproval(APPROVAL_DECIDED)!;
    expect(a).toMatchObject({ status: "changes_requested", rule: "all", requestedByName: "Sana Malik", canDecide: false, canCancel: false });
    expect(a.reviewers.map((r) => [r.name, r.decision, r.comment])).toEqual([["Gus Guest", "changes_requested", "Shorter, please"], ["Olive Owner", null, null]]);
    expect(approvalSummary(a)).toEqual({ approvalId: a.id, taskId: TASK, status: "changes_requested", rule: "all", approved: 0, total: 2 });
    expect(parseApproval({ ...APPROVAL_DECIDED, status: "maybe" })).toBeNull();
  });
  it("parses list_my_approvals with each task", () => {
    const m = parseMyApprovals(MY_APPROVALS);
    expect(m.requested).toEqual([]);
    expect(m.toReview[0]).toMatchObject({ canDecide: true, task: { title: "Pricing table", projectId: PROJ, status: "todo", dueDate: null } });
  });
  it("resolves like the server and labels the badge", () => {
    expect(resolveApprovalStatus("any", [null, "approved"])).toBe("approved");
    expect(resolveApprovalStatus("all", [null, "approved"])).toBe("pending");
    expect(resolveApprovalStatus("all", ["approved", "approved"])).toBe("approved");
    expect(resolveApprovalStatus("all", ["approved", "changes_requested"])).toBe("changes_requested");
    expect(resolveApprovalStatus("all", [])).toBe("pending");
    expect(approvalBadgeLabel({ status: "pending", rule: "all", approved: 1, total: 2 })).toBe("Pending 1/2");
    expect(approvalBadgeLabel({ status: "pending", rule: "any", approved: 0, total: 3 })).toBe("Pending");
    expect(approvalBadgeLabel({ status: "changes_requested", rule: "any", approved: 0, total: 1 })).toBe("Changes requested");
  });
  it("maps the database's errors", () => {
    expect(approvalFailure(new Error("already pending"))).toBe("already_pending");
    expect(approvalFailure(new Error("approval closed"))).toBe("closed");
    expect(approvalFailure(new Error("invalid reviewers"))).toBe("invalid");
    expect(approvalFailure(new Error("approvals need a team task"))).toBe("invalid");
    expect(approvalFailure(new Error("approval not found"))).toBe("not_found");
    expect(approvalFailure(new Error("task not found"))).toBe("not_found");
    expect(approvalFailure(new Error("not authorized"))).toBe("not_allowed");
  });
});

describe("Inbox meta", () => {
  it("reads approval and doc-mention meta, and nothing from older rows", () => {
    expect(parseActivityMeta(APPROVAL_ACTIVITY_META)).toEqual({ approvalId: APPROVAL_ACTIVITY_META.approval_id, event: "requested", status: "pending", rule: "all" });
    expect(parseActivityMeta({ approval_id: "x", event: "approved", status: "approved", comment: "Ship it" })).toMatchObject({ event: "approved", comment: "Ship it" });
    expect(parseActivityMeta(DOC_MENTION_META)).toEqual({ docId: DOC.id, projectId: PROJ });
    expect(parseActivityMeta(null)).toBeUndefined();
    expect(parseActivityMeta({ event: "exploded" })).toBeUndefined();
  });
});

describe("project docs", () => {
  it("parses saves, conflicts, list rows and versions", () => {
    const saved = parseDocSaveResult({ status: "saved", doc: DOC })!;
    expect(saved.status).toBe("saved");
    expect(saved.doc).toMatchObject({ title: "Project brief", icon: "📄", canEdit: true, mentions: [OLIVE], updatedByName: "Sana Malik", position: 1 });
    expect(saved.doc.body).toEqual([{ id: "b1", type: "h1", spans: [{ text: "Why" }] }, { id: "b2", type: "todo", spans: [{ text: "Pick a date" }], checked: false }]);
    expect(parseDocSaveResult({ status: "conflict", doc: DOC })?.status).toBe("conflict");
    expect(parseDocSaveResult({ status: "maybe", doc: DOC })).toBeNull();
    const item = parseProjectDocListItem({ ...DOC, body: undefined, can_edit: undefined })!;
    expect(item).not.toHaveProperty("body");
    expect(DOC_LIST_COLUMNS.split(",")).not.toContain("body");
    const v = parseDocVersion(DOC_VERSION)!;
    expect(v).toMatchObject({ title: "Project brief", savedBy: SANA });
    expect(v.body).toHaveLength(2);
    expect(parseDocVersion({ id: "x", doc_id: "y", saved_at: "2026-10-09T00:00:00Z", title: "t" })?.body).toBeNull();
  });
  it("reads a body defensively", () => {
    expect(parseDocBody([{ id: "a", type: "marquee", spans: [{ text: "x" }] }, { type: "p" }, { id: "c", type: "p", spans: [{ text: "l", href: "javascript:alert(1)" }] }, { id: "d", type: "bullet", indent: 9 }]))
      .toEqual([{ id: "a", type: "p", spans: [{ text: "x" }] }, { id: "c", type: "p", spans: [{ text: "l" }] }, { id: "d", type: "bullet", indent: 3 }]);
    expect(parseDocBody({})).toEqual([]);
  });
  it("maps the database's errors", () => {
    expect(docFailure(new Error("doc too large"))).toBe("too_large");
    expect(docFailure(new Error("too many docs"))).toBe("too_many");
    expect(docFailure(new Error("not allowed"))).toBe("not_allowed");
    expect(docFailure(new Error("doc not found"))).toBe("not_found");
    expect(docFailure(new Error("invalid body"))).toBe("invalid");
  });
});

describe("planner + routes", () => {
  it("caps plans at 60 tasks and 10 sections", () => {
    expect(PLAN_LIMITS.tasks).toBe(60);
    expect(PLAN_LIMITS.sections).toBe(10);
  });
  it("has addresses for the bin and docs", () => {
    expect(pathOf({ view: "bin" })).toBe("/projects/bin");
    expect(routeOf("/projects/bin")).toEqual({ view: "bin" });
    expect(routeOf("/p/abc/docs/d1")).toEqual({ view: "project", projectId: "abc", tab: "docs", docId: "d1" });
  });
});

describe("stub components take their final props (and render nothing until built)", () => {
  it("renders", () => {
    const task = { id: TASK, title: "Homepage copy", description: "", status: "todo", priority: "high", projectId: PROJ, assigneeId: SANA,
      tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0 } as Task;
    const project = { id: PROJ, name: "Website", emoji: "🌐", color: "oklch(0.7 0.12 160)", workspaceId: WS };
    const doc = parseDocSaveResult({ status: "saved", doc: DOC })!.doc;
    const deps: PlanApplyDeps = {
      createProject: async () => project, createSection: async () => ({ id: "s", projectId: PROJ, name: "S" }),
      createTasks: async (t) => t, addDependency: async () => undefined,
    };
    const make = async () => null;
    const { container } = render(<>
      <RecycleBin workspaceId={WS} workspaceName="Acme" role="member" currentUserId={SANA} members={[]} projects={[project]} />
      <HistoryLog workspaceId={WS} workspaceName="Acme" members={[]} currentUserId={SANA} canSeeAll={false} />
      <ApprovalPanel task={task} members={[]} currentUserId={SANA} />
      <ApprovalBadge summary={approvalSummary(parseApproval(APPROVAL_DECIDED)!)} />
      <ApprovalsInboxGroup approvals={parseMyApprovals(MY_APPROVALS).toReview} projects={[project]} members={[]} currentUserId={OLIVE} onOpenTask={() => {}} />
      <DocsTab project={project} members={[]} tasks={[task]} currentUserId={SANA} readOnly={false} docId={null} onOpenDoc={() => {}} onMakeTask={make} onOpenTask={() => {}} />
      <DocPage project={project} docId={DOC.id} members={[]} tasks={[]} currentUserId={SANA} readOnly onBack={() => {}} onMakeTask={make} onOpenTask={() => {}} />
      <DocEditor doc={doc} members={[]} tasks={[]} currentUserId={SANA} readOnly={false} onMakeTask={make} onOpenTask={() => {}} />
      <ProjectPlanner open mode="new" workspaceId={WS} workspaceName="Acme" members={[]} tasks={[]} currentUserId={SANA} aiEnabled={false} deps={deps} onClose={() => {}} onCreated={() => {}} />
      <SystemStatus release={null} builtAt={null} />
    </>);
    expect(container).toBeTruthy();
  });
});

describe("Inbox wording for approvals", () => {
  it("says what happened", async () => {
    const { approvalActivityVerb } = await import("./approvals");
    expect(approvalActivityVerb({ event: "requested", status: "pending" })).toBe("asked for your approval on");
    expect(approvalActivityVerb({ event: "approved", status: "approved" })).toBe("approved");
    expect(approvalActivityVerb({ event: "approved", status: "pending" })).toBe("approved their part of");
    expect(approvalActivityVerb({ event: "changes_requested", status: "changes_requested" })).toBe("asked for changes on");
    expect(approvalActivityVerb(undefined)).toBe("asked for your approval on");
  });
});
