import { describe, it, expect } from "vitest";
import type { Activity, Goal, Project, StatusUpdate, Task, WorkspaceMember } from "../data/types";
import { buildExport, guestWorkspaces } from "./exportData";

const mem = (workspaceId: string, userId: string, role: WorkspaceMember["role"], email = `${userId}@x.io`): WorkspaceMember =>
  ({ id: `${workspaceId}:${userId}`, workspaceId, userId, email, name: userId, role, status: "active" });
const task = (id: string, workspaceId: string | null, projectId: string, o: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId, assigneeId: "boss", createdBy: "boss", workspaceId,
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const project = (id: string, workspaceId: string | null): Project => ({ id, name: id, emoji: "", color: "red", workspaceId });

const base = {
  me: "me", profile: { id: "me" }, workspaces: [{ id: null, name: "Personal", kind: "personal" as const }, { id: "own", name: "Mine", kind: "team" as const }, { id: "client", name: "Client", kind: "team" as const }],
  members: [mem("own", "me", "owner"), mem("own", "maya", "member"), mem("client", "boss", "owner", "boss@client.io"), mem("client", "me", "guest"), mem("client", "other", "member", "other@client.io")],
  projects: [project("p-own", "own"), project("p-site", "client"), project("p-secret", "client"), project("p-personal", null)],
  sections: [{ id: "s1", projectId: "p-site", workspaceId: "client", name: "Doing" }, { id: "s2", projectId: "p-own", workspaceId: "own", name: "Now" }],
  customFields: [], tags: {},
  tasks: [
    task("t-own", "own", "p-own"), task("t-personal", null, "p-personal", { assigneeId: "me", createdBy: "me" }),
    task("t-mine", "client", "p-site", { assigneeId: "me" }), task("t-made", "client", "p-site", { createdBy: "me" }),
    task("t-theirs", "client", "p-site"), task("t-secret", "client", "p-secret"),
  ],
  goals: [{ id: "g-own", name: "Ours", status: "on_track", workspaceId: "own" }, { id: "g-client", name: "Revenue to £2m", status: "on_track", workspaceId: "client" }] as Goal[],
  portfolios: [{ id: "pf-client", name: "Bets", projectIds: ["p-site"], workspaceId: "client" }],
  statusUpdates: [{ id: "su-client", projectId: "p-site", summary: "Margins down", status: "at_risk", createdAt: "2026-11-01", workspaceId: "client" }] as StatusUpdate[],
  automationRules: [], forms: [], savedSearches: [],
  activity: [
    { id: "a1", taskId: "t-theirs", taskTitle: "t-theirs", kind: "comment", detail: "x", createdAt: "2026-11-01" },
    { id: "a2", taskId: "t-mine", taskTitle: "t-mine", kind: "assigned", detail: "x", createdAt: "2026-11-01" },
    { id: "a3", taskId: null, taskTitle: "", kind: "integration", detail: "x", createdAt: "2026-11-01" },
  ] as Activity[],
  now: new Date("2026-11-09T10:00:00Z"),
};
const ids = (rows: unknown) => (rows as { id: string }[]).map((r) => r.id);

describe("Export my data", () => {
  it("knows where you're a guest", () => {
    expect([...guestWorkspaces(base.members, "me")]).toEqual(["client"]);
    expect([...guestWorkspaces(base.members, "maya")]).toEqual([]);
  });

  it("where you're a guest: only your own tasks, their projects and your own membership", () => {
    const { payload, limited } = buildExport(base);
    expect(limited).toBe(true);
    expect(ids(payload.tasks)).toEqual(["t-own", "t-personal", "t-mine", "t-made"]);
    expect(ids(payload.projects)).toEqual(["p-own", "p-site", "p-personal"]);
    const members = payload.members as { workspaceId: string; userId: string; email: string }[];
    expect(members.filter((m) => m.workspaceId === "client").map((m) => m.userId)).toEqual(["me"]);
    expect(members.some((m) => m.email === "boss@client.io" || m.email === "other@client.io")).toBe(false);
    // the team's own records stay with the team
    expect(ids(payload.goals)).toEqual(["g-own"]);
    expect(payload.portfolios).toEqual([]);
    expect(payload.statusUpdates).toEqual([]);
    expect(ids(payload.sections)).toEqual(["s2"]);
    expect(ids(payload.activity)).toEqual(["a2", "a3"]);
    expect(payload.note).toMatch(/only your own tasks/);
  });

  it("everywhere else: everything you can see, as before", () => {
    const { payload, limited } = buildExport({ ...base, me: "maya" });
    expect(limited).toBe(false);
    expect(ids(payload.tasks)).toHaveLength(6);
    expect(ids(payload.goals)).toEqual(["g-own", "g-client"]);
    expect(payload.note).toBeUndefined();
    expect(payload).toMatchObject({ app: "Kanbo", exportedAt: "2026-11-09T10:00:00.000Z" });
  });
});
