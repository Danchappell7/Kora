/* The app's mirror of 0058's project access (lib/projectAccess.ts): rankCore answers exactly what
   the database's pa_rank_core does for every row of the shared table, and the questions built on
   it (who can see, who manages, who'd lose access, what turning it on does) follow the design. */
import { afterEach, describe, expect, it } from "vitest";
import MATRIX from "./projectAccessMatrix.json";
import {
  accessErrorText, accessOn, accessSchema, audienceOpen, canManagePeople, canSetVisibility, cantBeGiven, copyPeople, copyRoles, editableProjects, keepsEdit, mayMakePrivate, narrowingLoss,
  noteAccessSchema, peopleFor, projectRank, rankCore, rankFor, resetAccessSchema, seesCount, taskRank, turnOnPreview, type AccessCtx,
} from "./projectAccess";
import type { Project, ProjectMember, ProjectVisibility, Workspace, WorkspaceMember } from "../data/types";
import { DEMO_PROJECT_MEMBERS, PROJECTS } from "../data/data";

type Row = { on: boolean; wsRole: string; visibility: ProjectVisibility | null; isOwner: boolean; memberRole: string | null; rank: number };

afterEach(() => resetAccessSchema());

describe("rankCore", () => {
  it("answers every row of projectAccessMatrix.json (the table PGlite checks pa_rank_core against)", () => {
    const rows = MATRIX as Row[];
    expect(rows).toHaveLength(320);
    for (const r of rows) {
      const wsRole = r.wsRole === "none" ? null : r.wsRole;
      expect(rankCore(r.on, wsRole, r.visibility, r.isOwner, r.memberRole), JSON.stringify(r)).toBe(r.rank);
    }
  });
  it("anything that isn't a workspace role is an outsider", () => {
    expect(rankCore(false, "suspended", "workspace", false, "editor")).toBe(0);
    expect(rankCore(true, undefined, null, true, "editor")).toBe(0);
  });
});

const W = "ws-1";
const ws = (on: boolean, extra: Partial<Workspace["projectAccess"]> = {}): Workspace => ({ id: W, name: "Foundrise", kind: "team", ownerId: "o",
  projectAccess: { on, defaultVisibility: "workspace", membersMayMakePrivate: false, ...extra } });
const wm = (userId: string, role: WorkspaceMember["role"], status: WorkspaceMember["status"] = "active"): WorkspaceMember =>
  ({ id: `wm-${userId}`, workspaceId: W, userId, email: `${userId}@x.co`, name: userId.toUpperCase(), role, status });
const proj = (id: string, visibility: ProjectVisibility, ownerId = "o"): Project => ({ id, name: id, emoji: "", color: "", workspaceId: W, ownerId, visibility });
const pm = (projectId: string, userId: string, role: ProjectMember["role"]): ProjectMember => ({ id: `${projectId}-${userId}`, projectId, workspaceId: W, userId, role });

function world(on: boolean, me: string, extra: Partial<Workspace["projectAccess"]> = {}): AccessCtx {
  return {
    me,
    workspaces: [ws(on, extra)],
    projects: [proj("pw", "workspace"), proj("pm", "members"), proj("pp", "private"), proj("pq", "private", "me")],
    wsMembers: [wm("o", "owner"), wm("a", "admin"), wm("me", "member"), wm("mv", "member"), wm("m2", "member"), wm("gc", "guest"), wm("g2", "guest"), wm("inv", "member", "invited")],
    members: [pm("pm", "me", "editor"), pm("pp", "me", "editor"), pm("pm", "mv", "viewer"), pm("pw", "gc", "commenter"), pm("pm", "gc", "editor")],
  };
}

describe("projectRank and taskRank", () => {
  it("with the switch off it's today's rule for everyone, whatever the project says", () => {
    noteAccessSchema(true);
    for (const me of ["o", "a", "me", "m2"]) for (const p of ["pw", "pm", "pp", "pq"]) expect(projectRank(p, world(false, me))).toBe(3);
    for (const p of ["pw", "pm", "pp"]) expect(projectRank(p, world(false, "g2"))).toBe(2);
  });
  it("with it on: owners see all, members follow the project, guests only their projects (at most comment)", () => {
    noteAccessSchema(true);
    expect(["pw", "pm", "pp", "pq"].map((p) => projectRank(p, world(true, "o")))).toEqual([3, 3, 3, 3]);
    expect(["pw", "pm", "pp", "pq"].map((p) => projectRank(p, world(true, "a")))).toEqual([3, 3, 0, 0]);
    expect(["pw", "pm", "pp", "pq"].map((p) => projectRank(p, world(true, "me")))).toEqual([3, 3, 3, 3]);
    expect(["pw", "pm", "pp", "pq"].map((p) => projectRank(p, world(true, "mv")))).toEqual([3, 1, 0, 0]);
    expect(["pw", "pm", "pp", "pq"].map((p) => projectRank(p, world(true, "m2")))).toEqual([3, 0, 0, 0]);
    expect(["pw", "pm", "pp", "pq"].map((p) => projectRank(p, world(true, "gc")))).toEqual([2, 2, 0, 0]);
    expect(["pw", "pm", "pp", "pq"].map((p) => projectRank(p, world(true, "g2")))).toEqual([0, 0, 0, 0]);
  });
  it("a task whose project isn't a real one there is loose: staff edit, guests don't see it (switch on)", () => {
    noteAccessSchema(true);
    const loose = { workspaceId: W, projectId: "p-personal" };
    expect(taskRank(loose, world(true, "m2"))).toBe(3);
    expect(taskRank(loose, world(true, "gc"))).toBe(0);
    expect(taskRank(loose, world(false, "gc"))).toBe(2);
    expect(taskRank({ workspaceId: W, projectId: "pm" }, world(true, "mv"))).toBe(1);
    // Personal is your own
    expect(taskRank({ workspaceId: null, projectId: "p-personal" }, world(true, "gc"))).toBe(3);
  });
  it("your own role that couldn't be read (the member list didn't load): today's while the switch is off or before 0058, view only while it's on", () => {
    const unread = (on: boolean): AccessCtx => ({ ...world(on, "me"), wsMembers: [] });
    noteAccessSchema(true);
    expect(["pw", "pm", "pp"].map((p) => projectRank(p, unread(false)))).toEqual([3, 3, 3]);
    expect(taskRank({ workspaceId: W, projectId: "pm" }, unread(false))).toBe(3);
    expect(["pw", "pm"].map((p) => projectRank(p, unread(true)))).toEqual([0, 0]);
    noteAccessSchema(false);
    expect(projectRank("pm", unread(true))).toBe(3);
    // (someone else with no row is still nobody, and a workspace that isn't yours gives you nothing)
    noteAccessSchema(true);
    expect(rankFor(unread(false), "stranger", W, "pw")).toBe(0);
    expect(rankFor({ ...unread(false), workspaces: [] }, "me", W, "pw")).toBe(0);
  });
  it("before 0058 (or before it's known in a live session) nothing is switched on", () => {
    expect(accessSchema()).toBe(true);               // the demo: no backend in tests
    noteAccessSchema(false);
    expect(accessOn(ws(true))).toBe(false);
    expect(projectRank("pp", world(true, "m2"))).toBe(3);
    noteAccessSchema(true);
    expect(accessOn(ws(true))).toBe(true);
    expect(accessOn(undefined)).toBe(false);
  });
});

describe("who can be given new work (cantBeGiven, switch on)", () => {
  it("someone who can't see the project, and someone who has left (once the member list is in); never someone suspended who can", () => {
    noteAccessSchema(true);
    const c = world(true, "o");
    expect(cantBeGiven(c, W, "m2", "pm")).toBe(true);      // a member off Members only pm
    expect(cantBeGiven(c, W, "mv", "pm")).toBe(false);     // a viewer sees it
    expect(cantBeGiven(c, W, "gone", "pw")).toBe(true);    // left the workspace (no row): never a new task
    expect(cantBeGiven(c, W, "inv", "pw")).toBe(true);     // invited, not joined
    expect(cantBeGiven({ ...c, wsMembers: [] }, W, "gone", "pw")).toBe(false);   // the list didn't load: the server decides
  });
});

describe("who manages a project's people and visibility", () => {
  it("switch off: today's writers (not guests) on a Whole workspace project; switch on: owner, project owner, editors, admins unless private", () => {
    noteAccessSchema(true);
    const pp = proj("pp", "private"), pm_ = proj("pm", "members"), pq = proj("pq", "private", "me"), pw = proj("pw", "workspace");
    expect(canManagePeople(pw, world(false, "m2"))).toBe(true);
    expect(canManagePeople(pw, world(false, "gc"))).toBe(false);
    // a Members only or Private project keeps the switch-on rule while it's off (0058: the rollback window)
    expect(canManagePeople(pp, world(false, "m2"))).toBe(false);
    expect(canManagePeople(pp, world(false, "me"))).toBe(true);    // its editor
    expect(canManagePeople(pm_, world(false, "a"))).toBe(true);
    expect(canManagePeople(pp, world(false, "a"))).toBe(false);
    expect(canManagePeople(pp, world(true, "m2"))).toBe(false);
    expect(canManagePeople(pp, world(true, "me"))).toBe(true);     // editor
    expect(canManagePeople(pq, world(true, "me"))).toBe(true);     // its owner
    expect(canManagePeople(pp, world(true, "a"))).toBe(false);     // admins: not on private
    expect(canManagePeople(pm_, world(true, "a"))).toBe(true);
    expect(canManagePeople(pm_, world(true, "gc"))).toBe(false);   // guests never
    expect(canManagePeople(pp, world(true, "o"))).toBe(true);
    // visibility follows the switch-on rule even while it's off
    expect(canSetVisibility(pp, world(false, "m2"))).toBe(false);
  });
  it("private needs an owner or admin, or a workspace that lets members; nobody but the owner locks themselves out", () => {
    noteAccessSchema(true);
    expect(mayMakePrivate(W, world(true, "me"))).toBe(false);
    expect(mayMakePrivate(W, world(true, "me", { membersMayMakePrivate: true }))).toBe(true);
    expect(mayMakePrivate(W, world(true, "a"))).toBe(true);
    expect(mayMakePrivate(W, world(true, "gc", { membersMayMakePrivate: true }))).toBe(false);
    const pw = proj("pw", "workspace");
    expect(keepsEdit(pw, "private", world(true, "mv"))).toBe(false);    // not on it
    expect(keepsEdit(pw, "private", world(true, "o"))).toBe(true);
    expect(keepsEdit(proj("pm", "members"), "private", world(true, "me"))).toBe(true); // an editor keeps it
  });
});

describe("people, projects and previews", () => {
  it("audienceOpen: a task's project that isn't loaded (a real project's id: binned, deleted for good, out of sight) is closed; a loose one is open", () => {
    noteAccessSchema(true);
    const onWs = { projectAccess: { on: true, defaultVisibility: "workspace" as const, membersMayMakePrivate: false } };
    const gone = "5f5f5f5f-1111-4222-8333-444444444444";
    expect(audienceOpen("team", onWs, undefined, gone)).toBe(false);
    expect(audienceOpen("leadership", onWs, undefined, gone)).toBe(false);
    expect(audienceOpen("team", onWs, undefined, "p-personal")).toBe(true);
    expect(audienceOpen("team", onWs, undefined)).toBe(true);
    expect(audienceOpen("team", onWs, { visibility: "workspace" }, gone)).toBe(true);
    expect(audienceOpen("team", { projectAccess: { ...onWs.projectAccess, on: false } }, undefined, gone)).toBe(true);
  });
  it("peopleFor lists the active people who can see the project", () => {
    noteAccessSchema(true);
    const ids = (p: string, me = "o", min: 1 | 2 | 3 = 1) => peopleFor(p, world(true, me), min).map((m) => m.userId).sort();
    expect(ids("pp")).toEqual(["me", "o"]);
    expect(ids("pm")).toEqual(["a", "gc", "me", "mv", "o"]);
    expect(ids("pm", "o", 2)).toEqual(["a", "gc", "me", "o"]);      // a viewer can't be asked to comment
    expect(peopleFor("pp", world(false, "o")).map((m) => m.userId).sort()).toEqual(["a", "g2", "gc", "m2", "me", "mv", "o"]);
  });
  it("editableProjects is what you can change", () => {
    noteAccessSchema(true);
    expect(editableProjects(W, world(true, "mv")).map((p) => p.id)).toEqual(["pw"]);
    expect(editableProjects(W, world(true, "gc"))).toEqual([]);
  });
  it("turnOnPreview names each guest's projects and counts the visibilities", () => {
    noteAccessSchema(true);
    const prev = turnOnPreview(W, world(false, "o"));
    expect(prev.counts).toEqual({ workspace: 1, members: 1, private: 2 });
    expect(prev.guests).toEqual([{ userId: "gc", name: "GC", projects: ["pw", "pm"], lost: [] }, { userId: "g2", name: "G2", projects: [], lost: [] }]);
    // already Members only or Private: who'd lose sight once it's on (members and admins; guests are above)
    expect(prev.closed.map((c) => [c.projectId, c.losing.map((l) => l.userId)])).toEqual([
      ["pm", ["m2"]], ["pp", ["a", "mv", "m2"]], ["pq", ["a", "mv", "m2"]]]);
  });
  it("turnOnPreview names a guest's open tasks they'd stop seeing (assigned or collaborating, in projects they're not on)", () => {
    noteAccessSchema(true);
    const tasks = [
      { workspaceId: W, projectId: "pp", assigneeId: "g2", status: "todo" as const },
      { workspaceId: W, projectId: "pp", assigneeId: "o", status: "todo" as const, collaborators: ["g2"] },
      { workspaceId: W, projectId: "p-personal", assigneeId: "g2", status: "todo" as const },
      { workspaceId: W, projectId: "pw", assigneeId: "gc", status: "todo" as const },      // (on it)
      { workspaceId: W, projectId: "pm", assigneeId: "g2", status: "done" as const },      // (done)
      { workspaceId: W, projectId: "pp", assigneeId: "m2", status: "todo" as const },
    ];
    const prev = turnOnPreview(W, world(false, "o"), undefined, tasks);
    expect(prev.guests.find((g) => g.userId === "g2")?.lost).toEqual([{ project: "pp", openTasks: 2 }, { project: "no project", openTasks: 1 }]);
    expect(prev.guests.find((g) => g.userId === "gc")?.lost).toEqual([]);
    expect(prev.closed.find((c) => c.projectId === "pp")?.losing.find((l) => l.userId === "m2")?.openTasks).toBe(1);
  });
  it("a guest who owns a project (made a guest after making it) keeps it once the switch is on, as a commenter", () => {
    noteAccessSchema(true);
    const own = (c: AccessCtx): AccessCtx => ({ ...c, projects: [...c.projects, proj("pg", "private", "g2")] });
    const tasks = [{ workspaceId: W, projectId: "pg", assigneeId: "g2", status: "todo" as const }];
    const prev = turnOnPreview(W, own(world(false, "o")), undefined, tasks);
    expect(prev.guests.find((g) => g.userId === "g2")).toEqual({ userId: "g2", name: "G2", projects: ["pg"], lost: [] });
    expect(projectRank("pg", own(world(true, "g2")))).toBe(2);
    expect(seesCount(proj("pg", "private", "g2"), own(world(true, "o")))).toBe(2);   // Oona, and Gil
    expect(peopleFor("pg", own(world(true, "o"))).map((m) => m.userId)).toEqual(["o", "g2"]);
    expect(canManagePeople(proj("pg", "private", "g2"), own(world(true, "g2")))).toBe(false);
  });
  it("roleOf: the workspace's owner is its owner even without their own row (as ws_role)", () => {
    noteAccessSchema(true);
    const c = world(false, "o");
    const noRow = { ...c, wsMembers: c.wsMembers.filter((m) => m.userId !== "o") };
    expect(projectRank("pp", noRow)).toBe(3);
    expect(projectRank("pp", { ...world(true, "o"), wsMembers: [] })).toBe(3);
    // (your own row unread with the switch off: today's, not view only; see below)
    expect(projectRank("pp", { ...world(false, "m2"), wsMembers: [] })).toBe(3);
    expect(projectRank("pp", { ...world(true, "m2"), wsMembers: [] })).toBe(0);
  });
  it("copyPeople: a copy starts with the project's people, and its owner only while the switch is on (off, it's today's contributors)", () => {
    noteAccessSchema(true);
    expect(copyPeople(proj("pm", "members", "a"), world(false, "me")).sort()).toEqual(["gc", "me", "mv"]);
    expect(copyPeople(proj("pm", "members", "a"), world(true, "me")).sort()).toEqual(["a", "gc", "me", "mv"]);
    expect(copyPeople(proj("pq", "private", "me"), world(true, "me"))).toEqual([]);           // your own: you own the copy
    expect(copyPeople(proj("pw", "workspace", "gone"), world(true, "me"))).toEqual(["gc"]);   // an owner who's left isn't added
    // switched off, a copy that stays Members only or Private keeps its owner too (it's closed again once it's back on)
    expect(copyPeople(proj("pm", "members", "a"), world(false, "me"), "members").sort()).toEqual(["a", "gc", "me", "mv"]);
    expect(copyPeople(proj("pm", "members", "a"), world(false, "me"), "workspace").sort()).toEqual(["gc", "me", "mv"]);
  });
  it("copyRoles: each person keeps their role on the copy (a viewer stays a viewer); its owner edits", () => {
    expect(copyRoles(proj("pm", "members", "a"), world(true, "me"))).toEqual({ me: "editor", mv: "viewer", gc: "editor", a: "editor" });
    expect(copyRoles(proj("pw", "workspace", "o"), world(true, "me"))).toEqual({ gc: "commenter", o: "editor" });
  });
  it("narrowingLoss says who'd lose sight of it and their open tasks there", () => {
    noteAccessSchema(true);
    const ctx = world(true, "o");
    const tasks = [{ projectId: "pm", assigneeId: "mv", status: "todo" as const }, { projectId: "pm", assigneeId: "mv", status: "done" as const }];
    expect(narrowingLoss(proj("pm", "members"), "private", ctx, tasks)).toEqual([{ userId: "a", name: "A", openTasks: 0 }]);
    expect(narrowingLoss(proj("pw", "workspace"), "private", ctx, [{ projectId: "pw", assigneeId: "m2", status: "todo" }]).map((x) => [x.userId, x.openTasks]))
      .toEqual([["a", 0], ["me", 0], ["mv", 0], ["m2", 1]]);   // (GC is on it: a guest keeps it)
    expect(seesCount(proj("pp", "private"), ctx)).toBe(2);
    expect(seesCount(proj("pp", "private"), ctx, "members")).toBe(3);
  });
  it("refusals are said from your side", () => {
    expect(accessErrorText({ code: "access_missing" })).toBe("Project access isn't switched on yet.");
    expect(accessErrorText({ message: "not authorized" })).toBe("You can't change who has access to this project.");
    expect(accessErrorText({ code: "offline", message: "x" })).toBe("You're offline. Try again when you're back.");
  });
});

describe("the demo's project access", () => {
  it("seeds each project's people from its contributors, guests as commenters, Daniel a viewer on the fee review", () => {
    const of = (pid: string) => DEMO_PROJECT_MEMBERS.filter((m) => m.projectId === pid).map((m) => `${m.userId}:${m.role}`);
    expect(of("p-payroll")).toEqual(["m-1:editor"]);
    expect(of("p-seed")).toEqual(["m-3:editor"]);
    expect(of("p-hb-fees")).toEqual(["m-self:viewer"]);
    expect(of("p-brand")).toEqual(["m-self:editor", "m-1:editor", "m-5:commenter"]);
    expect(of("p-onboard")).toEqual(["m-2:editor", "m-6:commenter"]);
    expect(of("p-northlight")).toEqual(["m-self:commenter"]);
    expect(new Set(DEMO_PROJECT_MEMBERS.map((m) => m.id)).size).toBe(DEMO_PROJECT_MEMBERS.length);
    expect(PROJECTS.find((p) => p.id === "p-payroll")?.visibility).toBe("private");
  });
});
