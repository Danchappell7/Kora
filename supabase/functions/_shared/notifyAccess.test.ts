// @vitest-environment node
// notify and Project access (0058): the caller must see the work, and only
// recipients who can see it are told. Before 0058 (no access functions),
// everyone in the workspace, as today. A failed check sends nothing.
import { describe, expect, it, vi } from "vitest";
import { projectAccess } from "./projectAccess.ts";
import { digestItemProjects, dueTasksTheySee, projectNoticeGate, projectsTheySee, scopeKey, taskNoticeGate } from "./notifyAccess.ts";
import { AccessLookupFailed } from "./projectAccess.ts";
import type { DigestItem } from "./notifyCompose.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MAYA = "22222222-2222-4222-8222-222222222222";   // on the private project
const THEO = "33333333-3333-4333-8333-333333333333";   // isn't
const VIC = "44444444-4444-4444-8444-444444444444";    // a viewer on it
const WS = "55555555-5555-4555-8555-555555555555";
const PAY = "66666666-6666-4666-8666-666666666666";
const TASK = "77777777-7777-4777-8777-777777777777";
const task = { id: TASK, workspace_id: WS, project_id: PAY };
const ranks: Record<string, number> = { [OWNER]: 3, [MAYA]: 3, [VIC]: 1, [THEO]: 0 };

const with0058 = () => {
  const rpc = vi.fn(async (fn: string, a: Record<string, unknown> = {}) => {
    const r = ranks[String(a.p_user)] ?? 0;
    if (fn === "user_can_see_task" || fn === "user_can_see_project") return { data: r >= 1, error: null };
    if (fn === "user_project_rank") return { data: r, error: null };
    return { data: null, error: { code: "PGRST202", message: "no such function" } };
  });
  return { access: projectAccess({ rpc }), rpc };
};
const before0058 = () => {
  const rpc = vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.user_can_see_task" } }));
  return { access: projectAccess({ rpc }), rpc };
};
const flaky = () => projectAccess({ rpc: vi.fn(async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })) });

describe("a task's notice", () => {
  it("only recipients who can see the task are told (comment, mention, approval, kudos)", async () => {
    const { access } = with0058();
    expect(await taskNoticeGate(access, { actorId: MAYA, task, recipients: [THEO, OWNER, VIC], notFound: "task not found" }))
      .toEqual({ ok: true, recipients: [OWNER, VIC] });
  });
  it("a caller who can't see the task gets the same 404 as a task that isn't there", async () => {
    const { access } = with0058();
    expect(await taskNoticeGate(access, { actorId: THEO, task, recipients: [MAYA], notFound: "task not found" }))
      .toEqual({ ok: false, status: 404, body: { error: "task not found" } });
  });
  it("'assigned' needs edit rights: a viewer can't have assigned anyone", async () => {
    const { access } = with0058();
    expect(await taskNoticeGate(access, { actorId: VIC, task, recipients: [MAYA], needsEdit: true, notFound: "task not found" }))
      .toMatchObject({ ok: false, status: 404 });
    expect(await taskNoticeGate(access, { actorId: MAYA, task, recipients: [OWNER, THEO], needsEdit: true, notFound: "task not found" }))
      .toEqual({ ok: true, recipients: [OWNER] });
  });
  it("the caller first (no recipients yet), then the recipients alone", async () => {
    const { access, rpc } = with0058();
    expect(await taskNoticeGate(access, { actorId: MAYA, task, recipients: [], needsEdit: true, notFound: "task not found" })).toEqual({ ok: true, recipients: [] });
    rpc.mockClear();
    expect(await taskNoticeGate(access, { actorId: MAYA, task, recipients: [THEO, OWNER], callerChecked: true, notFound: "task not found" }))
      .toEqual({ ok: true, recipients: [OWNER] });
    expect(rpc.mock.calls.map((c) => [c[0], (c[1] as { p_user: string }).p_user])).toEqual([["user_can_see_task", THEO], ["user_can_see_task", OWNER]]);
  });
  it("before 0058: everyone the workspace check let through, asked once", async () => {
    const { access, rpc } = before0058();
    expect(await taskNoticeGate(access, { actorId: THEO, task, recipients: [MAYA, VIC, OWNER], needsEdit: true, notFound: "task not found" }))
      .toEqual({ ok: true, recipients: [MAYA, VIC, OWNER] });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("a personal task is never asked about", async () => {
    const { access, rpc } = with0058();
    expect(await taskNoticeGate(access, { actorId: MAYA, task: { ...task, workspace_id: null }, recipients: [MAYA], notFound: "x" }))
      .toEqual({ ok: true, recipients: [MAYA] });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a check that can't be made sends nothing (503)", async () => {
    expect(await taskNoticeGate(flaky(), { actorId: MAYA, task, recipients: [OWNER], notFound: "task not found" }))
      .toEqual({ ok: false, status: 503, body: { error: "couldn't check who can see this — nothing was sent", reason: "unavailable" } });
  });
});

describe("a project's notice (an ask, a posted update)", () => {
  const project = { id: PAY, workspace_id: WS };
  it("the caller must see the project; only recipients who can see it are told", async () => {
    const { access } = with0058();
    expect(await projectNoticeGate(access, { actorId: MAYA, project, recipients: [THEO, VIC], notFound: "update not found" }))
      .toEqual({ ok: true, recipients: [VIC] });
    expect(await projectNoticeGate(access, { actorId: THEO, project, recipients: [MAYA], notFound: "update not found" }))
      .toEqual({ ok: false, status: 404, body: { error: "update not found" } });
  });
  it("before 0058 everyone; a failed check sends nothing", async () => {
    expect(await projectNoticeGate(before0058().access, { actorId: THEO, project, recipients: [THEO, MAYA], notFound: "x" }))
      .toEqual({ ok: true, recipients: [THEO, MAYA] });
    expect(await projectNoticeGate(flaky(), { actorId: MAYA, project, recipients: [OWNER], notFound: "x" })).toMatchObject({ ok: false, status: 503 });
  });
});

describe("the digest's task-less items", () => {
  const U1 = "88888888-8888-4888-8888-888888888881", DOC = "99999999-9999-4999-8999-999999999991";
  const LAUNCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", BINNED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const it_ = (id: string, kind: string, meta: Record<string, unknown> | null, task: string | null = null): DigestItem =>
    ({ id, kind, task_id: task, task_title: "x", detail: "", created_at: "2026-10-09T08:00:00Z", meta });
  type R = Record<string, string | null>;
  /** supabase-js over status_updates, project_docs and trash (`broken`: answers this error) */
  const db = (tables: Record<string, R[]>, broken: Record<string, { code: string; message: string }> = {}) => ({
    from: vi.fn((t: string) => {
      let col = "id", ids: string[] = [];
      const where: [string, unknown][] = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { where.push([c, v]); return q; },
        is: (c: string, v: unknown) => { where.push([c, v]); return q; },
        in: (c: string, v: string[]) => { col = c; ids = v; return q; },
        then: (ok: (r: unknown) => unknown) => Promise.resolve(broken[t] ? { data: null, error: broken[t] } : {
          data: (tables[t] ?? []).filter((r) => ids.includes(String(r[col])) && where.every(([c, v]) => (r[c] ?? null) === v)), error: null,
        }).then(ok),
      };
      return q;
    }),
  });
  it("the project each names, with its workspace: an update's, a doc's, then meta.project_id (in the bin: the bin's); a meeting recap and a task's item aren't asked about", async () => {
    const items = [
      it_("a", "update", { status_update_id: U1, project_id: LAUNCH }),   // the update's project wins
      it_("b", "doc_mention", { doc_id: DOC }),
      it_("c", "update_ask", { project_id: LAUNCH.toUpperCase() }),
      it_("d", "meeting", { doc_id: DOC, project_id: PAY }),
      it_("e", "comment", { project_id: PAY }, TASK),
      it_("f", "doc_mention", { doc_id: "99999999-9999-4999-8999-999999999992" }),   // a doc that's gone: no project
      it_("g", "update", null),
      it_("h", "doc_mention", { doc_id: "99999999-9999-4999-8999-999999999993", project_id: BINNED }),   // its project's in the bin (the doc went with it)
    ];
    const out = await digestItemProjects(db({
      status_updates: [{ id: U1, project_id: PAY, workspace_id: WS }],
      project_docs: [{ id: DOC, project_id: PAY, workspace_id: WS }],
      trash: [{ item_id: BINNED, workspace_id: WS, kind: "project", restored_at: null }, { item_id: LAUNCH, workspace_id: WS, kind: "project", restored_at: "2026-10-01" }],
    }), items);
    expect([...out]).toEqual([["a", { project: PAY, workspaceId: WS }], ["b", { project: PAY, workspaceId: WS }],
      ["c", { project: LAUNCH, workspaceId: null }], ["h", { project: BINNED, workspaceId: WS }]]);
  });
  it("a table that isn't there yet names nothing; any other failed read throws (the digest waits)", async () => {
    const items = [it_("a", "update", { status_update_id: U1 }), it_("b", "doc_mention", { doc_id: DOC })];
    expect([...await digestItemProjects(db({}, { status_updates: { code: "42P01", message: "x" }, project_docs: { code: "PGRST205", message: "x" } }), items)]).toEqual([]);
    await expect(digestItemProjects(db({}, { project_docs: { code: "57014", message: "timeout" } }), items)).rejects.toBeInstanceOf(AccessLookupFailed);
    await expect(digestItemProjects(db({}, { trash: { code: "57014", message: "timeout" } }), [it_("c", "update_ask", { project_id: LAUNCH })])).rejects.toBeInstanceOf(AccessLookupFailed);
  });
  it("projectsTheySee: the ones they can still see, by rank where the workspace is known (a project in the bin); null before 0058 or with nothing to ask", async () => {
    const live = { project: PAY, workspaceId: null }, inWs = { project: PAY, workspaceId: WS };
    expect([...(await projectsTheySee(with0058().access, VIC, [live]))!]).toEqual([scopeKey(live)]);
    expect([...(await projectsTheySee(with0058().access, THEO, [live]))!]).toEqual([]);
    const { access, rpc } = with0058();
    expect([...(await projectsTheySee(access, VIC, [inWs, inWs]))!]).toEqual([scopeKey(inWs)]);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["user_project_rank"]);
    expect([...(await projectsTheySee(with0058().access, THEO, [inWs]))!]).toEqual([]);
    expect(await projectsTheySee(before0058().access, THEO, [live])).toBeNull();
    expect(await projectsTheySee(before0058().access, THEO, [inWs])).toBeNull();
    expect(await projectsTheySee(with0058().access, THEO, [])).toBeNull();
    await expect(projectsTheySee(flaky(), THEO, [live])).rejects.toBeInstanceOf(AccessLookupFailed);
  });
});

describe("the morning due list (daily-reminders runs it once a day)", () => {
  const TASK2 = "88888888-8888-4888-8888-888888888888";
  it("a lookup that fails is asked again after a pause, so a passing blip doesn't cost them the day's email", async () => {
    let calls = 0;
    const rpc = vi.fn(async () => {
      calls++;
      if (calls < 3) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      return { data: [TASK], error: null };
    });
    const pauses: number[] = [];
    expect(await dueTasksTheySee(projectAccess({ rpc }), MAYA, [TASK, TASK2], { sleep: async (ms) => { pauses.push(ms); } })).toEqual([TASK]);
    expect([calls, pauses.length]).toEqual([3, 2]);
  });
  it("every try failing gives up (nothing unchecked goes out); before 0058 it's asked once and every task stays", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(dueTasksTheySee(flaky(), MAYA, [TASK], { sleep })).rejects.toBeInstanceOf(AccessLookupFailed);
    expect(sleep).toHaveBeenCalledTimes(2);
    const { access, rpc } = before0058();
    expect(await dueTasksTheySee(access, MAYA, [TASK, TASK2], { sleep })).toEqual([TASK, TASK2]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
