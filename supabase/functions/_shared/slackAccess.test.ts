// @vitest-environment node
// Slack and project access (0058): a post about a project goes only when
// the project is open to the whole channel; the stand-up names only open
// work. Before 0058 (no access functions) everything is open, as today.
import { describe, expect, it, vi } from "vitest";
import { projectAccess } from "./projectAccess.ts";
import { PRIVATE_PROJECT_COPY, RELOAD_TO_POST_COPY, splitStandupTasks, standupAudienceCheck, statusPostProject } from "./slackAccess.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const LAUNCH = "33333333-3333-4333-8333-333333333333";
const PAY = "44444444-4444-4444-8444-444444444444";

/** projects as the person posting reads them (RLS: only what they can see) */
const asUser = (rows: Record<string, unknown>[], error: unknown = null) => ({
  from: vi.fn(() => {
    let id = "";
    const q = {
      select: () => q,
      eq: (_c: string, v: string) => { id = v; return q; },
      maybeSingle: async () => ({ data: error ? null : rows.find((r) => r.id === id) ?? null, error }),
    };
    return q;
  }),
});
const rows = [{ id: LAUNCH, name: "Launch", workspace_id: WS }, { id: PAY, name: "Board pay", workspace_id: WS }];
const access = (answer: (fn: string, a: Record<string, unknown>) => { data: unknown; error: unknown }) => projectAccess({ rpc: vi.fn(async (fn: string, a: Record<string, unknown> = {}) => answer(fn, a)) });
const on = () => access((_fn, a) => ({ data: a.p_project !== PAY, error: null }));
const before0058 = () => access(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }));

describe("slack-post: a status update about a project", () => {
  it("an open project goes, with its name", async () => {
    expect(await statusPostProject(asUser(rows), on(), WS, LAUNCH)).toEqual({ ok: true, projectName: "Launch" });
  });
  it("a Members only or Private project isn't posted to the team channel (403, private_project)", async () => {
    expect(await statusPostProject(asUser(rows), on(), WS, PAY)).toEqual({ ok: false, status: 403, reason: "private_project", error: PRIVATE_PROJECT_COPY });
    expect(PRIVATE_PROJECT_COPY).toBe("This project is private, so it isn't posted to the team channel.");
  });
  it("a project the person can't see (RLS) is not found, the same as one that isn't there", async () => {
    const seen = asUser([rows[0]]);
    const r = await statusPostProject(seen, on(), WS, PAY);
    expect(r).toEqual({ ok: false, status: 404, reason: "invalid", error: "That project couldn't be found." });
    expect(await statusPostProject(seen, on(), WS, "55555555-5555-4555-8555-555555555555")).toEqual(r);
  });
  it("another workspace's project is refused as before", async () => {
    const r = await statusPostProject(asUser([{ id: LAUNCH, name: "Launch", workspace_id: OTHER_WS }]), on(), WS, LAUNCH);
    expect(r).toMatchObject({ ok: false, status: 400, reason: "invalid" });
  });
  it("before 0058 every project goes, as today", async () => {
    expect(await statusPostProject(asUser(rows), before0058(), WS, PAY)).toEqual({ ok: true, projectName: "Board pay" });
  });
  it("when it can't tell, nothing is posted (503)", async () => {
    const flaky = access(() => ({ data: null, error: { code: "57014", message: "timeout" } }));
    expect(await statusPostProject(asUser(rows), flaky, WS, LAUNCH)).toMatchObject({ ok: false, status: 503, reason: "unavailable" });
    expect(await statusPostProject(asUser(rows, { code: "08006", message: "reset" }), on(), WS, LAUNCH)).toMatchObject({ ok: false, status: 503 });
  });
});

describe("slack-standup: open work and private work", () => {
  it("tasks in closed projects are set aside (ids compared case-blind); loose ones stay open", () => {
    const tasks = [
      { id: "a", project_id: LAUNCH }, { id: "b", project_id: PAY.toUpperCase() }, { id: "c", project_id: "p-personal" }, { id: "d", project_id: null },
    ];
    const { open, hidden } = splitStandupTasks(tasks, new Set([PAY]));
    expect(open.map((t) => t.id)).toEqual(["a", "c", "d"]);
    expect(hidden.map((t) => t.id)).toEqual(["b"]);
    expect(splitStandupTasks(tasks, new Set()).hidden).toEqual([]);
  });
});

describe("slack-post: a stand-up or Radar post from a tab opened before wave 4", () => {
  /** workspaces as the service role reads them */
  const admin = (row: Record<string, unknown> | null, error: unknown = null) => {
    const from = vi.fn(() => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: error ? null : row, error }) };
      return q;
    });
    return { from };
  };
  it("the app says its text leaves closed work out: it goes, nothing is read", async () => {
    const db = admin({ project_access: true });
    expect(await standupAudienceCheck(db, WS, "open")).toEqual({ ok: true });
    expect(db.from).not.toHaveBeenCalled();
  });
  it("no word from the app, and the switch is on: it's asked to reload (409, the only refusal an old tab reads out)", async () => {
    expect(await standupAudienceCheck(admin({ project_access: true }), WS, undefined)).toEqual({ ok: false, status: 409, reason: "invalid", error: RELOAD_TO_POST_COPY });
    expect(RELOAD_TO_POST_COPY).toMatch(/^[A-Z].{3,200}[.]$/);
    expect(await standupAudienceCheck(admin({ project_access: true }), WS, "everyone")).toMatchObject({ ok: false, status: 409 });
  });
  it("the switch off, or before 0058 (no column): it goes, as today", async () => {
    expect(await standupAudienceCheck(admin({ project_access: false }), WS, undefined)).toEqual({ ok: true });
    expect(await standupAudienceCheck(admin({ name: "Wellverse" }), WS, undefined)).toEqual({ ok: true });
    expect(await standupAudienceCheck(admin(null, { code: "42703", message: "column workspaces.project_access does not exist" }), WS, undefined)).toEqual({ ok: true });
  });
  it("when the switch can't be read, nothing is posted (503)", async () => {
    expect(await standupAudienceCheck(admin(null, { code: "57014", message: "canceling statement due to statement timeout" }), WS, undefined))
      .toMatchObject({ ok: false, status: 503, reason: "unavailable" });
  });
});
