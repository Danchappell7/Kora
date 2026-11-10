// @vitest-environment node
// Project access for the edge functions (0058): the service-only helpers
// through both connections (supabase-js .rpc and the SQL driver), the
// "before 0058" answers (today's rule), and a lookup that fails (never
// read as allowed). The real functions run in the PGlite suite.
import { describe, expect, it, vi } from "vitest";
import {
  AccessLookupFailed, accessInstalled, canSeeProject, closedProjects, isMissingAccessFn, MISSING_ACCESS_CODES, personRankSql,
  projectAccess, projectRank, visibleTaskIds, workspaceAccessOn,
} from "./projectAccess.ts";
import type { Tx } from "./api/types.ts";

const MAYA = "11111111-1111-4111-8111-111111111111";
const THEO = "22222222-2222-4222-8222-222222222222";
const GUS = "33333333-3333-4333-8333-333333333333";
const WS = "44444444-4444-4444-8444-444444444444";
const PAY = "55555555-5555-4555-8555-555555555555";
const T1 = "66666666-6666-4666-8666-666666666661";
const T2 = "66666666-6666-4666-8666-666666666662";
const T3 = "66666666-6666-4666-8666-666666666663";

type Answer = { data: unknown; error: unknown };
/** a supabase-js client whose rpc answers from `answer(fn, args)` */
const rpcDb = (answer: (fn: string, args: Record<string, unknown>) => Answer) => {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown> = {}) => answer(fn, args));
  return { rpc };
};
const before0058 = () => rpcDb(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.user_can_see_task" } }));
const flaky = () => rpcDb(() => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }));

/** the 0058 world: Maya sees T1 and T3 and the Pay project; Theo sees T1 only; Gus nothing */
const sees: Record<string, string[]> = { [MAYA]: [T1, T3, PAY], [THEO]: [T1], [GUS]: [] };
const live = () => rpcDb((fn, a) => {
  const user = String(a.p_user ?? "");
  switch (fn) {
    case "user_can_see_task": return { data: (sees[user] ?? []).includes(String(a.p_task)), error: null };
    case "user_can_see_project": return { data: (sees[user] ?? []).includes(String(a.p_project)), error: null };
    case "user_visible_task_ids": return { data: (a.p_ids as string[]).filter((id) => (sees[user] ?? []).includes(id)).sort(), error: null };
    case "closed_project_ids": return { data: [PAY.toUpperCase()], error: null };
    case "project_is_open": return { data: String(a.p_project) !== PAY, error: null };
    case "user_project_rank": return { data: user === MAYA ? 3 : user === THEO ? 1 : 0, error: null };
    default: return { data: null, error: { code: "PGRST202", message: "no such function" } };
  }
});

describe("what counts as 'before 0058'", () => {
  it("a missing function, table or column (Postgres or PostgREST) and nothing else", () => {
    for (const code of MISSING_ACCESS_CODES) expect(isMissingAccessFn({ code })).toBe(true);
    for (const code of ["57014", "42501", "08006", "PGRST301", "", undefined]) expect(isMissingAccessFn({ code })).toBe(false);
    expect(isMissingAccessFn(null)).toBe(false);
    // a message alone never counts: only the database's code says what's missing
    expect(isMissingAccessFn({ message: "function does not exist" })).toBe(false);
  });
});

describe("with 0058 in", () => {
  it("visibleTaskIds keeps the ones they may see, in the order given", async () => {
    const db = live();
    expect(await visibleTaskIds(db, MAYA, [T3, T2, T1])).toEqual([T3, T1]);
    expect(await visibleTaskIds(db, GUS, [T1, T2])).toEqual([]);
    expect(db.rpc).toHaveBeenCalledWith("user_visible_task_ids", { p_user: MAYA, p_ids: [T3, T2, T1] });
    // nothing to ask about: no call at all
    db.rpc.mockClear();
    expect(await visibleTaskIds(db, MAYA, [])).toEqual([]);
    expect(await visibleTaskIds(db, MAYA, ["p-personal", "not-a-task"])).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("the people who may see a task or a project, in their order, once each", async () => {
    const a = projectAccess(live());
    expect(await a.usersWhoCanSeeTask(T1, [THEO, GUS, MAYA, THEO])).toEqual([THEO, MAYA]);
    expect(await a.usersWhoCanSeeTask(T3, [THEO, GUS])).toEqual([]);
    expect(await a.usersWhoCanSeeProject(PAY, [GUS, MAYA, THEO])).toEqual([MAYA]);
    expect(await a.usersWhoCanSeeTask(T1, [])).toEqual([]);
    expect(a.before0058).toBe(false);
  });
  it("a person or a thing that isn't an id is never seen", async () => {
    const a = projectAccess(live());
    expect(await a.canSeeTask("nobody", T1)).toBe(false);
    expect(await a.canSeeTask(MAYA, "p-personal")).toBe(false);
    expect(await a.canSeeProject(MAYA, "p-personal")).toBe(false);
    expect(await a.projectRank("nobody", WS, PAY)).toBe(0);
  });
  it("closed projects come back lower-case; a project's openness and a person's rank", async () => {
    const db = live();
    expect([...await closedProjects(db, WS)]).toEqual([PAY]);
    const a = projectAccess(db);
    expect(await a.projectIsOpen(WS, PAY)).toBe(false);
    expect(await a.projectIsOpen(WS, T1)).toBe(true);
    // no project, or no workspace: nothing to hide
    expect(await a.projectIsOpen(WS, null)).toBe(true);
    expect(await a.projectIsOpen("", PAY)).toBe(true);
    expect([await projectRank(db, MAYA, WS, PAY), await projectRank(db, THEO, WS, PAY), await projectRank(db, GUS, WS, PAY)]).toEqual([3, 1, 0]);
    expect(await canSeeProject(db, THEO, PAY)).toBe(false);
  });
});

describe("before 0058 (the database at 0050..0057): today's rule", () => {
  it("everyone sees everything the caller's own workspace check lets through", async () => {
    const a = projectAccess(before0058());
    expect(await a.visibleTaskIds(MAYA, [T2, T1])).toEqual([T2, T1]);
    expect(await a.canSeeTask(GUS, T3)).toBe(true);
    expect(await a.canSeeProject(GUS, PAY)).toBe(true);
    expect(await a.usersWhoCanSeeTask(T1, [GUS, THEO])).toEqual([GUS, THEO]);
    expect(await a.usersWhoCanSeeProject(PAY, [GUS])).toEqual([GUS]);
    expect([...await a.closedProjects(WS)]).toEqual([]);
    expect(await a.projectIsOpen(WS, PAY)).toBe(true);
    expect(await a.projectRank(MAYA, WS, PAY)).toBeNull();
    expect(a.before0058).toBe(true);
  });
  it("asks once per run: after the first 'missing' nobody else is asked", async () => {
    const db = before0058();
    const a = projectAccess(db);
    expect(await a.usersWhoCanSeeTask(T1, [MAYA, THEO, GUS])).toEqual([MAYA, THEO, GUS]);
    await a.canSeeProject(MAYA, PAY);
    await a.visibleTaskIds(MAYA, [T1]);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    // a new run asks again (so it sees 0058 as soon as it's in)
    await projectAccess(db).canSeeTask(MAYA, T1);
    expect(db.rpc).toHaveBeenCalledTimes(2);
  });
  it("a missing table or column (part of 0058 in, part not) counts as missing too", async () => {
    for (const code of ["42P01", "PGRST205", "42703", "PGRST204", "42883"]) {
      const a = projectAccess(rpcDb(() => ({ data: null, error: { code, message: "x" } })));
      expect(await a.canSeeTask(MAYA, T1)).toBe(true);
    }
  });
});

describe("a lookup that fails is never 'allowed'", () => {
  it("throws AccessLookupFailed for a timeout, a refusal, a thrown call or no answer", async () => {
    await expect(projectAccess(flaky()).canSeeTask(MAYA, T1)).rejects.toBeInstanceOf(AccessLookupFailed);
    await expect(projectAccess(flaky()).visibleTaskIds(MAYA, [T1])).rejects.toBeInstanceOf(AccessLookupFailed);
    await expect(projectAccess(flaky()).closedProjects(WS)).rejects.toBeInstanceOf(AccessLookupFailed);
    await expect(projectAccess(flaky()).projectIsOpen(WS, PAY)).rejects.toBeInstanceOf(AccessLookupFailed);
    await expect(projectAccess(flaky()).projectRank(MAYA, WS, PAY)).rejects.toBeInstanceOf(AccessLookupFailed);
    await expect(projectAccess(flaky()).usersWhoCanSeeTask(T1, [MAYA, THEO])).rejects.toBeInstanceOf(AccessLookupFailed);
    const denied = rpcDb(() => ({ data: null, error: { code: "42501", message: "permission denied for function user_can_see_task" } }));
    await expect(projectAccess(denied).canSeeTask(MAYA, T1)).rejects.toBeInstanceOf(AccessLookupFailed);
    const thrown = { rpc: vi.fn(async () => { throw new Error("fetch failed"); }) };
    await expect(projectAccess(thrown).canSeeProject(MAYA, PAY)).rejects.toBeInstanceOf(AccessLookupFailed);
    const silent = { rpc: vi.fn() };   // a stub that answers nothing at all
    await expect(projectAccess(silent).canSeeTask(MAYA, T1)).rejects.toBeInstanceOf(AccessLookupFailed);
  });
  it("one failed person fails the whole list (it's never sent to the others as if checked)", async () => {
    const db = rpcDb((fn, a) => (a.p_user === GUS ? { data: null, error: { code: "08006", message: "connection reset" } } : { data: true, error: null }));
    await expect(projectAccess(db).usersWhoCanSeeTask(T1, [MAYA, GUS, THEO])).rejects.toBeInstanceOf(AccessLookupFailed);
  });
});

describe("through the SQL driver (the privileged connection)", () => {
  /** a Tx answering one `v` per statement, from what the statement names */
  const sqlDb = (answer: (text: string, params: readonly unknown[]) => unknown) => {
    const seen: { text: string; params: readonly unknown[] }[] = [];
    const tx: Tx = {
      async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
        seen.push({ text, params });
        const v = answer(text, params);
        if (v instanceof Error) throw v;
        return [{ v } as T];
      },
    };
    return { tx, seen };
  };
  it("asks the same functions, with typed parameters", async () => {
    const { tx, seen } = sqlDb((text) => (/user_can_see_task/.test(text) ? true : /user_visible_task_ids/.test(text) ? [T1] : /closed_project_ids/.test(text) ? [PAY] : /project_is_open/.test(text) ? false : 2));
    const a = projectAccess(tx);
    expect(await a.canSeeTask(MAYA, T1)).toBe(true);
    expect(await a.visibleTaskIds(MAYA, [T2, T1])).toEqual([T1]);
    expect([...await a.closedProjects(WS)]).toEqual([PAY]);
    expect(await a.projectIsOpen(WS, PAY)).toBe(false);
    expect(await a.projectRank(MAYA, WS, PAY)).toBe(2);
    expect(seen.map((s) => s.text.match(/public\.(\w+)/)?.[1])).toEqual(["user_can_see_task", "user_visible_task_ids", "closed_project_ids", "project_is_open", "user_project_rank"]);
    expect(seen[1].params).toEqual([MAYA, JSON.stringify([T2, T1])]);
  });
  it("before 0058 (42883) today's rule; any other error throws", async () => {
    const missing = sqlDb(() => Object.assign(new Error("function public.user_can_see_task(uuid, uuid) does not exist"), { code: "42883" }));
    expect(await projectAccess(missing.tx).canSeeTask(MAYA, T1)).toBe(true);
    const broken = sqlDb(() => Object.assign(new Error("connection reset"), { code: "08006" }));
    await expect(projectAccess(broken.tx).canSeeTask(MAYA, T1)).rejects.toBeInstanceOf(AccessLookupFailed);
  });
});

describe("workspaceAccessOn (only ever for wording)", () => {
  const tableDb = (answer: { data: unknown; error: unknown } | Error) => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const k of ["select", "eq"]) q[k] = () => q;
      q.maybeSingle = async () => { if (answer instanceof Error) throw answer; return answer; };
      return q;
    },
  });
  it("true only when the switch is on; before 0058, unreadable or off it's false", async () => {
    expect(await workspaceAccessOn(tableDb({ data: { project_access: true }, error: null }), WS)).toBe(true);
    expect(await workspaceAccessOn(tableDb({ data: { project_access: false }, error: null }), WS)).toBe(false);
    expect(await workspaceAccessOn(tableDb({ data: null, error: { code: "42703", message: "column workspaces.project_access does not exist" } }), WS)).toBe(false);
    expect(await workspaceAccessOn(tableDb({ data: null, error: null }), WS)).toBe(false);
    expect(await workspaceAccessOn(tableDb(new Error("fetch failed")), WS)).toBe(false);
    expect(await workspaceAccessOn(tableDb({ data: { project_access: true }, error: null }), "not-a-workspace")).toBe(false);
  });
});

describe("inside the person's own transaction", () => {
  it("accessInstalled asks to_regprocedure (which never errors)", async () => {
    const asked: string[] = [];
    const tx = (on: boolean): Tx => ({ async query<T>(text: string): Promise<T[]> { asked.push(text); return [{ on } as T]; } });
    expect(await accessInstalled(tx(true))).toBe(true);
    expect(await accessInstalled(tx(false))).toBe(false);
    expect(asked[0]).toContain("to_regprocedure('public.pa_rank_core(boolean,text,text,boolean,text)')");
  });
  it("personRankSql only reads rows, through pa_rank_core, with the ids guarded before any cast", () => {
    const sql = personRankSql("t.assignee_id", "$1::uuid", "$2");
    expect(sql).toContain("public.pa_rank_core(");
    expect(sql).not.toMatch(/user_project_rank|pa_rank_for|kanbo_uuid/);   // nothing a signed-in caller can't run
    expect(sql).toContain("(case when (t.assignee_id) ~* ");
    expect(sql).toContain("(case when ($2) ~* ");
    expect(sql).toMatch(/where paw\.id = \$1::uuid\), 0\)$/);
  });
});
