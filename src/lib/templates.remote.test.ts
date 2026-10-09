/* lib/templates against a (mocked) real backend: the task_templates queries
   the library makes (the same shapes the PGlite replay in
   scratchpad/pgtest-u9 runs as each kind of person), adoption of this
   browser's old templates, and every way it fails (0048 not run, offline,
   refusals). Row fixtures are what PostgREST returns for task_templates. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { from, getSession } = vi.hoisted(() => ({ from: vi.fn(), getSession: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: { from: (...a: unknown[]) => from(...a), auth: { getSession: () => getSession() } },
  isSupabaseConfigured: true,
}));

import {
  LIBRARY_BUILTINS, TEMPLATE_COLUMNS, createLibraryTemplate, deleteLibraryTemplate, listLibraryTemplates, onLibraryChange,
  resetLibraryTemplates, saveTemplate, templateFailure, updateLibraryTemplate,
} from "./templates";

const ME = "a89a2412-b64a-49e4-bb75-10dc9466bba2";
const SANA = "228cd532-0fa5-41b7-83d6-4d5cf399b0dd";
const WS = "32bcfe00-b584-4a9b-a861-d331bceb69b0";
const OTHER_WS = "851dadfe-dfce-497d-bf03-4e4a1394ad30";
const row = (o: Record<string, unknown>) => ({
  id: "a1b71c68-a9c2-43cd-a9de-429c29576018", workspace_id: WS, user_id: ME, name: "Client onboarding", emoji: "🤝",
  body: { title: "Onboard {client}", subtasks: [{ title: "Kick-off call", offsetDays: 2, assigneeRole: "project_owner" }] },
  shared: false, created_at: "2026-10-09T09:00:00.000Z", updated_at: "2026-10-09T09:00:00.000Z", ...o,
});
const ok = (data: unknown) => ({ data, error: null });
const pgErr = (message: string, code = "P0001") => ({ data: null, error: { message, code, details: null, hint: null } });

/** a PostgREST-ish builder that records its calls and resolves to `result` */
function query(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = { calls };
  for (const k of ["select", "eq", "in", "or", "order", "limit", "insert", "update", "delete", "single"]) {
    q[k] = vi.fn((...a: unknown[]) => { calls.push([k, a]); return q; });
  }
  (q as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q as typeof q & { calls: [string, unknown[]][] };
}
const callsOf = (q: { calls: [string, unknown[]][] }, k: string) => q.calls.filter(([n]) => n === k).map(([, a]) => a);

beforeEach(() => {
  localStorage.clear();
  resetLibraryTemplates();
  from.mockReset(); getSession.mockReset();
  getSession.mockResolvedValue({ data: { session: { user: { id: ME } } } });
});
afterEach(() => { vi.useRealTimers(); });

describe("listing", () => {
  it("reads every column, newest first; keeps yours and this workspace's shared ones; built-ins last", async () => {
    const list = query(ok([
      row({ id: "1", name: "Mine here", updated_at: "2026-10-08T00:00:00Z" }),
      row({ id: "2", name: "Mine elsewhere", workspace_id: OTHER_WS, updated_at: "2026-10-09T00:00:00Z" }),
      row({ id: "3", name: "Sana's shared", user_id: SANA, shared: true }),
      row({ id: "4", name: "Sana's elsewhere", user_id: SANA, shared: true, workspace_id: OTHER_WS }),
      row({ id: "5", name: "Broken", body: { description: "no title" } }),
      row({ id: "builtin-lib-bug-report", name: "Spoofed built-in" }),
    ]));
    from.mockReturnValueOnce(list);
    const out = await listLibraryTemplates(WS);
    expect(from).toHaveBeenCalledWith("task_templates");
    expect(callsOf(list, "select")).toEqual([[TEMPLATE_COLUMNS]]);
    expect(callsOf(list, "order")).toEqual([["updated_at", { ascending: false }]]);
    expect(out.map((t) => t.name)).toEqual(["Mine elsewhere", "Mine here", "Sana's shared", ...LIBRARY_BUILTINS.map((t) => t.name)]);
  });
  it("is cached for a minute, and a change here clears it", async () => {
    from.mockReturnValue(query(ok([row({})])));
    await listLibraryTemplates(WS);
    await listLibraryTemplates(WS);
    expect(from).toHaveBeenCalledTimes(1);
    let told = 0;
    const off = onLibraryChange(() => { told++; });
    from.mockReturnValueOnce(query(ok(row({ name: "New" }))));
    await createLibraryTemplate({ workspaceId: WS, name: "New", body: { title: "x" } });
    expect(told).toBe(1);
    off();
    await listLibraryTemplates(WS);
    expect(from).toHaveBeenCalledTimes(3);
  });
  it("before 0048: your local templates and the built-ins, and it stops asking", async () => {
    saveTemplate({ name: "Old one", title: "Old", priority: "low", tags: [], focusMin: 30, recurrence: "none", description: "" });
    from.mockReturnValue(query(pgErr("Could not find the table 'public.task_templates' in the schema cache", "PGRST205")));
    const out = await listLibraryTemplates(WS);
    expect(out.map((t) => t.name)).toEqual(["Old one", ...LIBRARY_BUILTINS.map((t) => t.name)]);
    expect(out[0].userId).toBe(ME);
    const n = from.mock.calls.length;
    resetCacheOnly();
    await listLibraryTemplates(WS);
    expect(from.mock.calls.length).toBe(n);   // schema known missing: no more requests
    expect(JSON.parse(localStorage.getItem("kanbo-templates")!)).toHaveLength(1);   // and they stay in this browser
  });
  it("offline: the last list this session saw, else the built-ins", async () => {
    from.mockReturnValueOnce(query(pgErr("TypeError: Failed to fetch", "")));
    expect((await listLibraryTemplates(WS)).map((t) => t.id)).toEqual(LIBRARY_BUILTINS.map((t) => t.id));
  });
  it("other refusals reach the caller (as templateFailure words)", async () => {
    from.mockReturnValueOnce(query(pgErr("permission denied for table task_templates", "42501")));
    await expect(listLibraryTemplates(WS)).rejects.toSatisfy((e: unknown) => templateFailure(e) === "not_allowed");
  });
  it("signed out: only the built-ins", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    expect((await listLibraryTemplates(WS)).map((t) => t.id)).toEqual(LIBRARY_BUILTINS.map((t) => t.id));
    expect(from).not.toHaveBeenCalled();
  });
});

function resetCacheOnly() {
  // a minute later: the cache has gone stale (the schema flag stays)
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
}

describe("writing", () => {
  it("creates as you, cleaned; shared only with a workspace", async () => {
    const q = query(ok(row({ id: "n1", shared: true })));
    from.mockReturnValueOnce(q);
    const t = await createLibraryTemplate({ workspaceId: WS, name: " Onboarding ", emoji: " 🤝 ", body: { title: " Onboard {client} ", subtasks: [{ title: " Call ", offsetDays: 2.4 }, { title: "" }] }, shared: true });
    expect(callsOf(q, "insert")).toEqual([[{
      workspace_id: WS, user_id: ME, name: "Onboarding", emoji: "🤝", shared: true,
      body: { title: "Onboard {client}", subtasks: [{ title: "Call", offsetDays: 2 }] },
    }]]);
    expect(callsOf(q, "select")).toEqual([[TEMPLATE_COLUMNS]]);
    expect(t.id).toBe("n1");
    await expect(createLibraryTemplate({ workspaceId: null, name: "x", body: { title: "x" }, shared: true })).rejects.toSatisfy((e: unknown) => templateFailure(e) === "invalid");
    await expect(createLibraryTemplate({ workspaceId: WS, name: "x", body: { title: "x", description: "é".repeat(20_000) } })).rejects.toSatisfy((e: unknown) => templateFailure(e) === "invalid");
    expect(from).toHaveBeenCalledTimes(1);   // the bad ones never left
  });
  it("the database's refusals come back as failures", async () => {
    from.mockReturnValueOnce(query(pgErr("too many task templates")));
    await expect(createLibraryTemplate({ workspaceId: WS, name: "x", body: { title: "x" } })).rejects.toSatisfy((e: unknown) => templateFailure(e) === "too_many");
    from.mockReturnValueOnce(query(pgErr('new row violates row-level security policy for table "task_templates"', "42501")));
    await expect(createLibraryTemplate({ workspaceId: WS, name: "x", body: { title: "x" }, shared: true })).rejects.toSatisfy((e: unknown) => templateFailure(e) === "not_allowed");
    getSession.mockResolvedValue({ data: { session: null } });
    await expect(createLibraryTemplate({ workspaceId: WS, name: "x", body: { title: "x" } })).rejects.toSatisfy((e: unknown) => templateFailure(e) === "not_allowed");
  });
  it("updates only what changed; an RLS-hidden row reads as not found", async () => {
    const q = query(ok(row({ name: "Renamed" })));
    from.mockReturnValueOnce(q);
    await updateLibraryTemplate("a1", { name: " Renamed ", emoji: "", shared: false });
    expect(callsOf(q, "update")).toEqual([[{ name: "Renamed", emoji: null, shared: false }]]);
    expect(callsOf(q, "eq")).toEqual([["id", "a1"]]);
    from.mockReturnValueOnce(query(pgErr("JSON object requested, multiple (or no) rows returned", "PGRST116")));
    await expect(updateLibraryTemplate("a1", { name: "x" })).rejects.toSatisfy((e: unknown) => templateFailure(e) === "not_found");
    await expect(updateLibraryTemplate("a1", { name: "  " })).rejects.toSatisfy((e: unknown) => templateFailure(e) === "invalid");
    await expect(updateLibraryTemplate("builtin-lib-bug-report", { name: "x" })).rejects.toSatisfy((e: unknown) => templateFailure(e) === "not_allowed");
  });
  it("deletes by id and says so when nothing went (someone else's, or gone already)", async () => {
    const q = query(ok([{ id: "a1" }]));
    from.mockReturnValueOnce(q);
    await deleteLibraryTemplate("a1");
    expect(callsOf(q, "delete")).toEqual([[]]);
    expect(callsOf(q, "select")).toEqual([["id"]]);
    from.mockReturnValueOnce(query(ok([])));
    await expect(deleteLibraryTemplate("a1")).rejects.toSatisfy((e: unknown) => templateFailure(e) === "not_found");
  });
  it("a template still kept in this browser is deleted there", async () => {
    const local = saveTemplate({ name: "Local", title: "L", priority: "low", tags: [], focusMin: 30, recurrence: "none", description: "" });
    await deleteLibraryTemplate(local.id);
    expect(from).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("kanbo-templates")!)).toEqual([]);
  });
});

describe("adopting this browser's old templates", () => {
  it("copies them up once as personal ones (skipping any you already have), then lets them go", async () => {
    saveTemplate({ name: "Weekly review", title: "Weekly review", priority: "medium", tags: ["t1"], focusMin: 30, recurrence: "weekly", description: "Wins" });
    saveTemplate({ name: "Already there", title: "Same", priority: "high", tags: [], focusMin: 60, recurrence: "none", description: "" });
    const have = query(ok([{ name: "already there", body: { title: "Same" } }]));
    const insert = query(ok(null));
    const list = query(ok([]));
    from.mockReturnValue(query(ok([])));
    from.mockReturnValueOnce(have).mockReturnValueOnce(insert).mockReturnValueOnce(list);
    const out = await listLibraryTemplates(null);
    expect(callsOf(have, "eq")).toEqual([["user_id", ME]]);
    expect(callsOf(insert, "insert")).toEqual([[[{
      workspace_id: null, user_id: ME, name: "Weekly review", emoji: null, shared: false,
      body: { title: "Weekly review", description: "Wins", priority: "medium", estimate: 30, tags: ["t1"] },
    }]]]);
    expect(JSON.parse(localStorage.getItem("kanbo-templates")!)).toEqual([]);
    expect(out.map((t) => t.name)).toEqual(LIBRARY_BUILTINS.map((t) => t.name));   // (the list ran after; this one's empty)
    await listLibraryTemplates(WS);
    expect(from).toHaveBeenCalledTimes(4);   // adoption doesn't run twice in a session
  });
  it("before 0048 nothing moves and they stay put", async () => {
    saveTemplate({ name: "Keep me", title: "K", priority: "low", tags: [], focusMin: 30, recurrence: "none", description: "" });
    from.mockReturnValue(query(pgErr("relation \"public.task_templates\" does not exist", "42P01")));
    const out = await listLibraryTemplates(null);
    expect(out[0].name).toBe("Keep me");
    expect(JSON.parse(localStorage.getItem("kanbo-templates")!)).toHaveLength(1);
  });
  it("a failed copy keeps them here and tries again next time", async () => {
    saveTemplate({ name: "Retry me", title: "R", priority: "low", tags: [], focusMin: 30, recurrence: "none", description: "" });
    from.mockReturnValueOnce(query(ok([]))).mockReturnValueOnce(query(pgErr("TypeError: Failed to fetch", ""))).mockReturnValueOnce(query(ok([])));
    const out = await listLibraryTemplates(null);
    expect(out[0].name).toBe("Retry me");      // still listed from this browser
    expect(JSON.parse(localStorage.getItem("kanbo-templates")!)).toHaveLength(1);
    const insert = query(ok(null));
    from.mockReturnValueOnce(query(ok([]))).mockReturnValueOnce(insert).mockReturnValueOnce(query(ok([])));
    resetCacheOnly();
    await listLibraryTemplates(null);
    expect(callsOf(insert, "insert")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("kanbo-templates")!)).toEqual([]);
  });
});
