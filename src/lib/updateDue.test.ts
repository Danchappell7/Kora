/* lib/updateDue and lib/updateAsks: only a project's OWNER hears about its update — on its day and the two
   working days after, or once a lead asks — and only leads may ask, about someone else's project. */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { Project, StatusUpdate, Task, UpdateAsk, Workspace, WorkspaceMember } from "../data/types";
import { dueUpdatesFor, draftedFrom, dueVerb, updateNoticed } from "./updateDue";
import { asksAwaiting, askForUpdate, canAskFor, ownerCanPost, recentAsk, resetUpdateAsks, AskError } from "./updateAsks";

const FRI = new Date(2026, 10, 13);        // Friday 13 Nov 2026
const WS: Workspace[] = [{ id: "w", name: "Foundry", kind: "team" }];
const proj = (id: string, o: Partial<Project> = {}): Project => ({ id, name: id, emoji: "", color: "", workspaceId: "w", ownerId: "me", ...o });
const task = (id: string, projectId: string, o: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId, assigneeId: "me", tags: [], dependencies: [], subtasks: [],
  focusMin: 30, comments: 0, aiScore: 0, createdAt: "2026-09-01T09:00:00", ...o,
});
const upd = (projectId: string, createdAt: string, status: StatusUpdate["status"] = "on_track"): StatusUpdate => ({ id: `u-${projectId}`, projectId, summary: "", status, createdAt });
const ask = (projectId: string, o: Partial<UpdateAsk> = {}): UpdateAsk => ({ id: `a-${projectId}`, projectId, workspaceId: "w", askedBy: "lead", ownerId: "me", createdAt: "2026-11-12T10:00:00.000Z", ...o });

afterEach(() => { vi.useRealTimers(); resetUpdateAsks(); });

describe("your updates for Today", () => {
  const projects = [proj("launch"), proj("brand"), proj("theirs", { ownerId: "sana" }), proj("paused", { status: "on_hold" }), proj("old", { archivedAt: "2026-10-01" }),
    proj("mine-personal", { workspaceId: null })];
  const tasks = ["launch", "brand", "theirs", "paused", "old", "mine-personal"].map((p) => task(`t-${p}`, p));
  it("due on its day for its owner only; on hold, archived, Personal and someone else's are left out", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 13, 10));
    const due = dueUpdatesFor({ me: "me", projects, tasks, statusUpdates: [upd("brand", "2026-11-10T10:00:00")], asks: [], today: FRI, workspaces: WS });
    expect(due.map((d) => [d.project.id, d.reason])).toEqual([["launch", "due"]]);
    expect(dueVerb(due[0], FRI)).toBe("is due today");
    expect(draftedFrom(due)).toBe("Kanbo has a draft ready.");
  });
  it("a lead's ask brings it in on any day, until an update's posted after it", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 12, 12));
    const thu = new Date(2026, 10, 12);
    const base = { me: "me", projects, tasks, today: thu, workspaces: WS };
    const asked = dueUpdatesFor({ ...base, statusUpdates: [upd("brand", "2026-11-10T10:00:00"), upd("launch", "2026-11-11T10:00:00")], asks: [ask("brand")] });
    expect(asked.map((d) => [d.project.id, d.reason, d.ask?.askedBy])).toEqual([["brand", "asked", "lead"]]);
    // answered: an update after the ask
    expect(dueUpdatesFor({ ...base, statusUpdates: [upd("brand", "2026-11-12T11:00:00"), upd("launch", "2026-11-11T10:00:00")], asks: [ask("brand")] })).toEqual([]);
    // an ask on someone else's project, or one you made yourself, isn't yours to answer
    expect(dueUpdatesFor({ ...base, statusUpdates: [upd("launch", "2026-11-11T10:00:00")], asks: [ask("theirs", { ownerId: "sana" }), ask("brand", { askedBy: "me" })] })).toEqual([]);
  });
  it("one Kanbo noticed nudge, naming the project or counting them", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 13, 10));
    const one = dueUpdatesFor({ me: "me", projects: [proj("launch")], tasks, statusUpdates: [], asks: [], today: FRI, workspaces: WS });
    const [n] = updateNoticed(one, FRI);
    expect(n).toMatchObject({ kind: "update", title: "Your launch update is due today", actions: [{ kind: "update", label: "Review and post", projectId: "launch" }] });
    const two = dueUpdatesFor({ me: "me", projects: [proj("launch"), proj("brand")], tasks, statusUpdates: [], asks: [ask("brand")], today: FRI, workspaces: WS });
    expect(updateNoticed(two, FRI)[0]).toMatchObject({ title: "2 project updates are waiting on you", body: "brand and launch. Kanbo has drafts ready. Each takes a minute to check." });
    expect(updateNoticed([], FRI)).toEqual([]);
  });
});

describe("Ask for an update", () => {
  it("is for a workspace's owners and admins, about a live project someone else owns", () => {
    const p = proj("launch", { ownerId: "sana" });
    expect(canAskFor(p, "me", "owner")).toBe(true);
    expect(canAskFor(p, "me", "admin")).toBe(true);
    expect(canAskFor(p, "me", "member")).toBe(false);
    expect(canAskFor(p, "me", "guest")).toBe(false);
    expect(canAskFor(proj("mine"), "me", "owner")).toBe(false);
    expect(canAskFor({ ...p, archivedAt: "2026-10-01" }, "me", "owner")).toBe(false);
    expect(canAskFor({ ...p, workspaceId: null }, "me", "owner")).toBe(false);
  });
  it("never of an owner who's only a guest there, or has left (a guest can't post an update)", () => {
    const p = proj("launch", { ownerId: "sana" });
    const m = (role: WorkspaceMember["role"], status: WorkspaceMember["status"] = "active"): WorkspaceMember =>
      ({ id: "m", workspaceId: "w", userId: "sana", email: "", name: "Sana", role, status });
    expect(ownerCanPost(p, [m("member")])).toBe(true);
    expect(ownerCanPost(p, [m("guest")])).toBe(false);
    expect(ownerCanPost(p, [m("member", "invited")])).toBe(false);
    // (someone the list doesn't name: the database decides)
    expect(ownerCanPost(p, [])).toBe(true);
  });
  it("asks once in 20 hours (the demo keeps the database's rule)", async () => {
    const p = proj("launch", { ownerId: "sana" });
    const now = new Date("2026-11-13T09:00:00Z");
    const a = await askForUpdate(p, "me", now);
    expect(a).toMatchObject({ projectId: "launch", askedBy: "me", ownerId: "sana", workspaceId: "w" });
    expect(recentAsk([a], "launch", new Date("2026-11-14T04:00:00Z"))).toBe(a);
    expect(recentAsk([a], "launch", new Date("2026-11-14T06:00:00Z"))).toBeUndefined();
    await expect(askForUpdate(p, "me", new Date("2026-11-13T12:00:00Z"))).rejects.toBeInstanceOf(AskError);
    await expect(askForUpdate(proj("mine"), "me", now)).rejects.toMatchObject({ reason: "not_allowed" });
  });
  it("asks awaiting you: yours to answer, newest per project, until an update's posted", () => {
    const now = new Date("2026-11-13T10:00:00Z");
    const asks = [ask("a", { createdAt: "2026-11-12T10:00:00Z" }), ask("a", { id: "a2", createdAt: "2026-11-13T09:00:00Z" }), ask("b", { createdAt: "2026-11-01T10:00:00Z" })];
    expect(asksAwaiting(asks, "me", () => undefined, now).map((a) => a.id)).toEqual(["a2"]);   // b's is over a week old
    expect(asksAwaiting(asks, "me", () => ({ createdAt: "2026-11-13T09:30:00Z" }), now)).toEqual([]);
  });
});
