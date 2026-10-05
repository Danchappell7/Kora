// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  changedFields, isoDate, isoTime, num, PROJECT_COLUMN_FIELDS, serialiseComment, serialiseEvent, serialiseMember,
  serialiseProject, serialiseSection, serialiseTask, serialiseWorkspace, TASK_COLUMN_FIELDS, type OutboxEvent,
} from "./serialise.ts";

const migration = readFileSync(new URL("../../../migrations/0046_api_webhooks_notion.sql", import.meta.url), "utf8");
const APP = { appUrl: "https://www.kanbo.co.uk/" };
const W = "11111111-0000-4000-8000-000000000001";

// a tasks row exactly as to_jsonb() stores it in webhook_outbox (captured from the 0046 PGlite run)
const OUTBOX_TASK = {
  id: "e508af3b-ac25-42ac-a4f3-35192d10cadd", dur: null, tags: ["t-1", "t-unknown"], title: "Ship it", custom: {}, energy: null,
  status: "done", user_id: "bbbbbbbb-0000-4000-8000-000000000002", ai_score: 0, comments: 0, due_date: "2026-10-09",
  due_time: "14:30", position: 1791223478.31, priority: "medium", ai_reason: "secret ranking", focus_min: 30, followers: ["x"],
  parent_id: null, reactions: { "👍": ["x"] }, scheduled: 540, created_at: "2026-10-05T18:04:38.31+00:00", plan_today: true,
  project_id: "p-w", recurrence: "none", section_id: null, start_date: null, updated_at: "2026-10-05T18:04:38.312+00:00",
  archived_at: null, assignee_id: "", description: "", completed_at: "2026-10-05", effort_hours: null, is_milestone: false,
  logged_hours: null, workspace_id: W, collaborators: [], my_section_id: null, original_due_date: null,
};

describe("value helpers", () => {
  it("dates and times from strings or Dates", () => {
    expect(isoDate("2026-10-05")).toBe("2026-10-05");
    expect(isoDate(new Date("2026-10-05T00:00:00Z"))).toBe("2026-10-05");
    expect(isoDate("nope")).toBeNull();
    expect(isoTime("2026-10-05T18:04:38.31+00:00")).toBe("2026-10-05T18:04:38.310Z");
    expect(isoTime("2026-10-05T18:04:38.123456+01:00")).toBe("2026-10-05T17:04:38.123Z");
    expect(isoTime("2026-10-05 18:04:38+00")).toBe("2026-10-05T18:04:38.000Z");
    expect(isoTime(new Date("2026-10-05T18:04:38Z"))).toBe("2026-10-05T18:04:38.000Z");
    expect(isoTime("")).toBeNull();
    expect(isoTime(null)).toBeNull();
  });
  it("numbers from numeric strings (postgres.js) or numbers", () => {
    expect(num("2.50")).toBe(2.5);
    expect(num(3)).toBe(3);
    expect(num(null)).toBeNull();
    expect(num("x")).toBeNull();
  });
});

describe("serialiseTask", () => {
  const tags = new Map([["t-1", { label: "Launch", color: "oklch(0.7 0.1 30)" }]]);
  const t = serialiseTask(OUTBOX_TASK, { ...APP, tags });
  it("is the API shape: camelCase, explicit nulls, no internal columns", () => {
    expect(t).toEqual({
      object: "task", id: OUTBOX_TASK.id, title: "Ship it", description: "", status: "done", priority: "medium",
      workspaceId: W, projectId: "p-w", sectionId: null, parentId: null, assigneeId: null,
      createdBy: "bbbbbbbb-0000-4000-8000-000000000002", dueDate: "2026-10-09", dueTime: "14:30", startDate: null,
      completedAt: "2026-10-05",
      tags: [{ id: "t-1", label: "Launch", color: "oklch(0.7 0.1 30)" }, { id: "t-unknown", label: null, color: null }],
      effortHours: null, loggedHours: null, isMilestone: false, recurrence: "none", archived: false, archivedAt: null,
      createdAt: "2026-10-05T18:04:38.310Z", updatedAt: "2026-10-05T18:04:38.312Z",
      url: `https://www.kanbo.co.uk/?task=${OUTBOX_TASK.id}`,
    });
    for (const secret of ["ai_reason", "aiReason", "reactions", "followers", "scheduled", "planToday", "position", "custom"]) {
      expect(JSON.stringify(t)).not.toContain(secret === "ai_reason" ? "secret ranking" : `"${secret}"`);
    }
  });
  it("reads postgres.js rows too (Dates, numeric strings) and detail extras", () => {
    const r = serialiseTask({ ...OUTBOX_TASK, created_at: new Date("2026-10-01T09:00:00Z"), effort_hours: "1.5", archived_at: new Date("2026-10-06T10:00:00Z"),
      assignee_id: "aaaaaaaa-0000-4000-8000-000000000001", subtask_ids: ["s1"], dependency_ids: [] });
    expect(r.createdAt).toBe("2026-10-01T09:00:00.000Z");
    expect(r.effortHours).toBe(1.5);
    expect(r.archived).toBe(true);
    expect(r.assigneeId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(r.subtaskIds).toEqual(["s1"]);
    expect(r.dependencyIds).toEqual([]);
  });
  it("falls back safely on odd values; no url without an app address", () => {
    const r = serialiseTask({ id: "x", status: "weird", priority: 7, recurrence: null, due_time: "late" });
    expect(r).toMatchObject({ status: "todo", priority: "medium", recurrence: "none", dueTime: null, title: "", url: null, tags: [] });
    expect(serialiseTask({ id: "x" }, { appUrl: "javascript:alert(1)" }).url).toBeNull();
  });
});

describe("other resources", () => {
  it("project", () => {
    const p = serialiseProject({ id: "p1", name: "P2", color: "oklch(0.74 0.14 230)", emoji: "📁", status: null, user_id: "u1", owner_id: "u1",
      created_at: "2026-10-05T18:04:38.317+00:00", archived_at: null, description: null, workspace_id: W, contributor_ids: [] }, APP);
    expect(p).toEqual({ object: "project", id: "p1", workspaceId: W, name: "P2", emoji: "📁", color: "oklch(0.74 0.14 230)", description: null,
      status: null, ownerId: "u1", contributorIds: [], createdBy: "u1", archived: false, archivedAt: null,
      createdAt: "2026-10-05T18:04:38.317Z", url: "https://www.kanbo.co.uk/p/p1" });
  });
  it("section, comment, member, workspace", () => {
    expect(serialiseSection({ id: "s", project_id: "p", workspace_id: null, name: "Doing", position: "2", created_at: null }))
      .toEqual({ object: "section", id: "s", projectId: "p", workspaceId: null, name: "Doing", position: 2, createdAt: null });
    expect(serialiseComment({ id: "c", task_id: "t", user_id: null, author_name: "", body: "Hi", mentions: ["u"], parent_id: null, reactions: {}, created_at: "2026-10-05T10:00:00+00:00" }))
      .toEqual({ object: "comment", id: "c", taskId: "t", parentId: null, authorId: null, authorName: "Someone", body: "Hi", mentions: ["u"], createdAt: "2026-10-05T10:00:00.000Z" });
    expect(serialiseMember({ id: "m", workspace_id: W, user_id: "u", name: "Zed", email: "zed@kanbo.test", role: "member", status: "active", title: null, created_at: null }))
      .toMatchObject({ object: "member", role: "member", status: "active", userId: "u" });
    expect(serialiseMember({ id: "m", workspace_id: W, role: "superuser", status: "invited" })).toMatchObject({ role: "member", status: "invited", userId: null });
    expect(serialiseWorkspace({ id: W, name: "W", owner_id: "u", logo_url: null, created_at: null, role: "guest" }))
      .toEqual({ object: "workspace", id: W, name: "W", logoUrl: null, ownerId: "u", role: "guest", createdAt: null });
  });
});

describe("webhook events", () => {
  const ev = (event: string, payload: Record<string, unknown>): OutboxEvent => ({ outbox_id: 2, event, occurred_at: "2026-10-05T18:04:38.312Z", workspace_id: W, payload });
  it("task.updated: data = the API task, changes = API field names", () => {
    const e = serialiseEvent(ev("task.updated", { task: OUTBOX_TASK, changes: ["completed_at", "status", "ai_score"] }), APP);
    expect(e).toMatchObject({ id: "evt_2", type: "task.updated", createdAt: "2026-10-05T18:04:38.312Z", workspaceId: W, changes: ["completedAt", "status"] });
    expect(e.data).toEqual(serialiseTask(OUTBOX_TASK, APP));
  });
  it("task.deleted says how", () => {
    expect(serialiseEvent(ev("task.deleted", { task: OUTBOX_TASK, deletion: "archived" })).deletion).toBe("archived");
    expect(serialiseEvent(ev("task.deleted", { task: OUTBOX_TASK, deletion: "moved" })).deletion).toBe("moved");
    expect(serialiseEvent(ev("task.deleted", { task: OUTBOX_TASK })).deletion).toBe("deleted");
  });
  it("comment.created carries its task", () => {
    const e = serialiseEvent(ev("comment.created", {
      comment: { id: "c", body: "Nice", task_id: "t", user_id: "u", author_name: "Gus", mentions: [], parent_id: null, created_at: "2026-10-05T18:04:38.3+00:00" },
      task: { id: "t", title: "Ship it", project_id: "p-w", workspace_id: W },
    }), APP);
    expect(e.data).toMatchObject({ object: "comment", body: "Nice", authorName: "Gus", task: { id: "t", title: "Ship it", projectId: "p-w", url: "https://www.kanbo.co.uk/?task=t" } });
  });
  it("project, member and ping", () => {
    expect(serialiseEvent(ev("project.updated", { project: { id: "p", name: "N" }, changes: ["name", "user_id"] })).changes).toEqual(["name"]);
    expect(serialiseEvent(ev("member.joined", { member: { id: "m", workspace_id: W, user_id: "u", status: "active", role: "member" } })).data).toMatchObject({ object: "member" });
    const ping = serialiseEvent({ outbox_id: "9", event: "ping", created_at: "2026-10-05T18:00:00Z", workspace_id: null, payload: { webhook: { id: "w", url: "https://x.example.com/h", events: ["task.created"] } } });
    expect(ping).toMatchObject({ id: "evt_9", type: "ping", workspaceId: null, data: { webhookId: "w", events: ["task.created"] } });
  });
  it("throws on an event it doesn't know", () => {
    expect(() => serialiseEvent(ev("user.deleted", {}))).toThrow(/unknown webhook event/);
  });
  it("changedFields drops unknown columns and de-duplicates", () => {
    expect(changedFields(["status", "status", "position", "due_date"], TASK_COLUMN_FIELDS)).toEqual(["dueDate", "status"]);
    expect(changedFields("nope", TASK_COLUMN_FIELDS)).toEqual([]);
  });
});

describe("the 0046 capture triggers watch exactly the serialised columns", () => {
  const colsIn = (fn: string) => {
    const body = migration.split(`function public.${fn}()`)[1];
    const m = /cols constant text\[\] := array\[([\s\S]*?)\];/.exec(body);
    return (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1)).sort();
  };
  it("tasks", () => expect(colsIn("webhook_capture_task")).toEqual(Object.keys(TASK_COLUMN_FIELDS).sort()));
  it("projects", () => expect(colsIn("webhook_capture_project")).toEqual(Object.keys(PROJECT_COLUMN_FIELDS).sort()));
});
