/* store: project access (0058) on the three databases the app must survive. At 0050 (live today) the
   workspaces have no project_access column and project_members is missing: nothing new is sent, the
   missing table is remembered, and every write is today's. At 0058 with the switch off, a project's
   people change through the member calls, and nothing else does. With it on, a new project's
   visibility goes in its own insert, and a task update the server refuses is said, not shown as saved. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
interface Call { table: string; op: string; payload?: unknown; filters: [string, unknown][]; returning?: boolean; single?: boolean }
type Db = "0050" | "off" | "on";

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";
const T1 = "44444444-4444-4444-8444-444444444444";

function fakeClient(db: Db) {
  const calls: Call[] = [];
  let refuseUpdates = false;
  const wsRow: Row = { id: WS, name: "Foundrise", owner_id: "someone-else", created_at: "2026-01-01T00:00:00Z" };
  if (db !== "0050") Object.assign(wsRow, { project_access: db === "on", project_access_default: "members", project_access_member_private: false, project_access_changed_at: null });
  const project: Row = { id: P1, name: "Seed round", emoji: "📊", color: "c", workspace_id: WS, owner_id: ME, contributor_ids: [] };
  if (db !== "0050") project.visibility = db === "on" ? "members" : "workspace";
  const answer = (c: Call): { data: unknown; error: unknown } => {
    if (c.op === "rpc") {
      if (db === "0050") return { data: null, error: { code: "PGRST202", message: "Could not find the function public." + c.table + " in the schema cache" } };
      if (c.table === "set_project_member") return { data: "editor", error: null };
      if (c.table === "remove_project_member") return { data: true, error: null };
      if (c.table === "set_project_access") return { data: { on: true, default: "private", member_private: true, changed_at: "2026-11-10T09:00:00Z" }, error: null };
      if (c.table === "set_project_visibility") return { data: "private", error: null };
      return { data: null, error: null };
    }
    if (c.table === "project_members") {
      if (db === "0050") return { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.project_members' in the schema cache" } };
      if (c.op === "select") return { data: [{ id: "pm-1", project_id: P1, workspace_id: WS, user_id: "old-person", role: "editor", created_at: "2026-11-01T00:00:00Z" }], error: null };
    }
    if (c.table === "workspaces") return { data: [wsRow], error: null };
    if (c.table === "workspace_members") return { data: [{ id: "wm-1", workspace_id: WS, user_id: ME, email: "me@x.co", name: "Me", role: "member", status: "active" }], error: null };
    if (c.table === "projects") {
      if (c.op === "insert") {
        const p = c.payload as Row;
        if (db === "0050" && "visibility" in p) return { data: null, error: { code: "PGRST204", message: "Could not find the 'visibility' column of 'projects' in the schema cache" } };
        return { data: { id: "55555555-5555-4555-8555-555555555555", contributor_ids: [], ...p }, error: null };
      }
      if (c.op === "select") return { data: [project], error: null };
      return { data: null, error: null };
    }
    if (c.table === "tasks") {
      if (c.op === "select" && c.single) return { data: { id: T1 }, error: null };
      if (c.op === "select") return { data: [{ id: T1, title: "Cap table", description: "", status: "todo", priority: "medium", project_id: P1, assignee_id: ME, workspace_id: WS, tags: [], focus_min: 30, comments: 0, ai_score: 0, subtasks: [], task_dependencies: [] }], error: null };
      if (c.op === "update") return { data: c.returning ? (refuseUpdates ? [] : [{ id: T1 }]) : null, error: null };
    }
    return { data: c.op === "select" && !c.single ? [] : null, error: null };
  };
  const from = (table: string) => {
    const c: Call = { table, op: "select", filters: [] };
    let started = false;
    const b: Record<string, unknown> = {
      select() { if (started) c.returning = true; started = true; return b; },
      insert(p: unknown) { c.op = "insert"; c.payload = p; started = true; return b; },
      upsert(p: unknown) { c.op = "upsert"; c.payload = p; started = true; return b; },
      update(p: unknown) { c.op = "update"; c.payload = p; started = true; return b; },
      delete() { c.op = "delete"; started = true; return b; },
      eq(col: string, v: unknown) { c.filters.push([col, v]); return b; },
      gt() { return b; }, gte() { return b; }, is() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
      single() { c.single = true; return b; },
      maybeSingle() { c.single = true; return b; },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve().then(() => { calls.push(c); return answer(c); }).then(res, rej); },
    };
    return b;
  };
  const client = {
    from,
    rpc(name: string, args?: unknown) { return Promise.resolve().then(() => { const c = { table: name, op: "rpc", payload: args, filters: [] }; calls.push(c); return answer(c); }); },
    auth: {
      getSession: async () => ({ data: { session: { user: { id: ME, email: "me@x.co" } } }, error: null }),
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
    channel() { const ch = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel: async () => "ok",
    getChannels: () => [],
  };
  return { client, calls, refuse(on: boolean) { refuseUpdates = on; } };
}

async function load(fake: ReturnType<typeof fakeClient>) {
  vi.resetModules();
  vi.doMock("../lib/supabase", () => ({ supabase: fake.client, isSupabaseConfigured: true }));
  vi.doMock("../lib/monitoring", () => ({ reportError: vi.fn(), initMonitoring() {}, setUserContext() {}, monitoringEnabled: false }));
  const store = (await import("./store")).store;
  const access = await import("../lib/projectAccess");
  const data = await import("./data");
  return { store, access, data };
}
const rpcs = (fake: ReturnType<typeof fakeClient>) => fake.calls.filter((c) => c.op === "rpc" && c.table !== "claim_invites").map((c) => c.table);

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

describe("at 0050 (live today): nothing new is read, sent or shown", () => {
  it("bootstrap: no access settings, no members (null, asked once), and the switch reads as off", async () => {
    const fake = fakeClient("0050");
    const { store, access } = await load(fake);
    const b = await store.bootstrap({ id: ME });
    expect(b.projectMembers).toBeNull();
    expect(b.workspaces.find((w) => w.id === WS)?.projectAccess).toBeUndefined();
    expect(b.projects.find((p) => p.id === P1)?.visibility).toBeUndefined();
    expect(access.accessSchema()).toBe(false);
    const asked = fake.calls.filter((c) => c.table === "project_members").length;
    expect(asked).toBe(1);
    await store.bootstrap({ id: ME });
    expect(fake.calls.filter((c) => c.table === "project_members").length).toBe(asked);   // remembered for ten minutes
  });

  it("writes are today's: contributors as a column, no visibility, an update without a read back", async () => {
    const fake = fakeClient("0050");
    const { store, data } = await load(fake);
    const b = await store.bootstrap({ id: ME });
    data.setReferenceData({ workspaces: b.workspaces });
    await store.updateProject(P1, { contributorIds: ["x"] });
    expect(fake.calls.find((c) => c.table === "projects" && c.op === "update")?.payload).toEqual({ contributor_ids: ["x"] });
    const made = await store.createProject({ name: "New", emoji: "", color: "c", workspaceId: WS, visibility: "private", memberIds: ["y"] }, ME);
    const insert = fake.calls.find((c) => c.table === "projects" && c.op === "insert");
    expect(insert?.payload).not.toHaveProperty("visibility");
    expect(made.name).toBe("New");
    await store.updateTask(T1, { title: "Renamed" });
    expect(fake.calls.find((c) => c.table === "tasks" && c.op === "update")?.returning).toBeFalsy();
    expect(rpcs(fake).filter((n) => n.includes("project"))).toEqual(["set_project_member"]);   // the one person asked for, refused quietly
  });

  it("the access calls say it isn't switched on yet", async () => {
    const fake = fakeClient("0050");
    const { store } = await load(fake);
    await expect(store.setProjectAccess(WS, { on: true })).rejects.toMatchObject({ code: "access_missing", message: "Project access isn't switched on yet." });
    await expect(store.setProjectVisibility(P1, "private")).rejects.toMatchObject({ code: "access_missing" });
  });
});

describe("at 0058 with the switch off", () => {
  it("bootstrap reads the members and the settings; the switch is off", async () => {
    const fake = fakeClient("off");
    const { store, access } = await load(fake);
    const b = await store.bootstrap({ id: ME });
    expect(b.projectMembers).toEqual([{ id: "pm-1", projectId: P1, workspaceId: WS, userId: "old-person", role: "editor", createdAt: "2026-11-01T00:00:00Z" }]);
    const ws = b.workspaces.find((w) => w.id === WS);
    expect(ws?.projectAccess).toEqual({ on: false, defaultVisibility: "members", membersMayMakePrivate: false, changedAt: null });
    expect(access.accessSchema()).toBe(true);
    expect(access.accessOn(ws)).toBe(false);
    expect(b.projects.find((p) => p.id === P1)?.visibility).toBe("workspace");
  });

  it("an old-style contributors edit goes through the member calls; a new project sends no visibility", async () => {
    const fake = fakeClient("off");
    const { store, data } = await load(fake);
    const b = await store.bootstrap({ id: ME });
    data.setReferenceData({ workspaces: b.workspaces });
    await store.updateProject(P1, { contributorIds: ["new-person"] });
    expect(fake.calls.some((c) => c.table === "projects" && c.op === "update")).toBe(false);
    expect(fake.calls.filter((c) => c.op === "rpc" && c.table !== "claim_invites").map((c) => [c.table, (c.payload as Row).p_user])).toEqual([["set_project_member", "new-person"], ["remove_project_member", "old-person"]]);
    await store.createProject({ name: "New", emoji: "", color: "c", workspaceId: WS, visibility: "private" }, ME);
    expect(fake.calls.find((c) => c.table === "projects" && c.op === "insert")?.payload).not.toHaveProperty("visibility");
    await store.updateTask(T1, { title: "Renamed" });
    expect(fake.calls.find((c) => c.table === "tasks" && c.op === "update")?.returning).toBeFalsy();
  });
});

describe("at 0058 with the switch on", () => {
  it("a new project's visibility goes in its insert, then its people are added", async () => {
    const fake = fakeClient("on");
    const { store, data } = await load(fake);
    const b = await store.bootstrap({ id: ME });
    data.setReferenceData({ workspaces: b.workspaces });
    const made = await store.createProject({ name: "Payroll", emoji: "🧾", color: "c", workspaceId: WS, visibility: "private", memberIds: ["maya", ME] }, ME);
    const insert = fake.calls.find((c) => c.table === "projects" && c.op === "insert");
    expect(insert?.payload).toMatchObject({ visibility: "private", owner_id: ME });
    expect(fake.calls.filter((c) => c.op === "rpc" && c.table !== "claim_invites").map((c) => c.payload)).toEqual([{ p_project: made.id, p_user: "maya", p_role: "editor" }]);
    expect(made.contributorIds).toEqual(["maya"]);
  });

  it("a task update the server refuses (no row back, but you can still read it) throws 42501", async () => {
    const fake = fakeClient("on");
    const { store } = await load(fake);
    await store.bootstrap({ id: ME });
    await store.updateTask(T1, { title: "Fine" });
    expect(fake.calls.filter((c) => c.table === "tasks" && c.op === "update").at(-1)?.returning).toBe(true);
    fake.refuse(true);
    await expect(store.updateTask(T1, { title: "Refused" })).rejects.toMatchObject({ code: "42501", message: "You can view this project, but not change it." });
  });

  it("the switch's call maps its answer; a refusal is typed", async () => {
    const fake = fakeClient("on");
    const { store } = await load(fake);
    expect(await store.setProjectAccess(WS, { defaultVisibility: "private", membersMayMakePrivate: true })).toEqual({ on: true, defaultVisibility: "private", membersMayMakePrivate: true, changedAt: "2026-11-10T09:00:00Z" });
    expect(fake.calls.find((c) => c.table === "set_project_access")?.payload).toEqual({ p_ws: WS, p_on: null, p_default: "private", p_member_private: true });
    expect(await store.setProjectVisibility(P1, "private")).toBe("private");
  });
});
