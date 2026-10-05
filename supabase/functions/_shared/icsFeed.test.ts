// @vitest-environment node
// The ics-feed edge function's handler, driven end to end with an in-memory
// stand-in for the supabase-js service-role client.
import { afterEach, describe, expect, it, vi } from "vitest";
import { etagOf, FEED_TOKEN_RE, handleFeedRequest, ifNoneMatchHits, isMissing, type FeedDb } from "./icsFeed.ts";
import type { HitResult, Window } from "./limits.ts";

const ME = "11111111-1111-4111-8111-111111111111";
const YOU = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TOKEN = "a".repeat(64);
const NOW = new Date("2026-10-04T10:00:00Z"); // Sunday 4 Oct, 11:00 in London
type Row = Record<string, unknown>;
type Op = { m: string; a: unknown[] };
type Q = { kind: "from" | "rpc"; name: string; args?: unknown; ops: Op[] };
type Result = { data: unknown; error: unknown };

/** A chainable, thenable query that records every call and asks `resolve` for its result. */
function fakeDb(resolve: (q: Q) => Result) {
  const log: Q[] = [];
  const make = (q: Q) => {
    log.push(q);
    const run = () => Promise.resolve().then(() => resolve(q));
    const builder: Record<string, unknown> = {
      then: (ok: (r: Result) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
      maybeSingle: () => { q.ops.push({ m: "maybeSingle", a: [] }); return run(); },
    };
    for (const m of ["select", "eq", "neq", "not", "is", "gte", "lte", "lt", "like", "in", "or", "order", "range", "limit", "upsert", "update", "delete"]) {
      builder[m] = (...a: unknown[]) => { q.ops.push({ m, a }); return builder; };
    }
    return builder;
  };
  const db: FeedDb = {
    from: (name: string) => make({ kind: "from", name, ops: [] }),
    rpc: (name: string, args?: Record<string, unknown>) => make({ kind: "rpc", name, args, ops: [] }),
  };
  return { db, log };
}
const op = (q: Q, m: string) => q.ops.find((o) => o.m === m)?.a;

/** A small world: a token table, tasks with visibility, plan rows and projects. */
function world(over: {
  tokens?: Row[]; tasks?: Row[]; visibleTo?: (t: Row) => boolean; states?: Row[]; projects?: Row[];
  fail?: Partial<Record<"token" | "tasks" | "states" | "projects", { code?: string; message: string }>>;
} = {}) {
  const tokens = over.tokens ?? [{ token: TOKEN, user_id: ME, include_due: true }];
  const tasks = over.tasks ?? [];
  const states = over.states ?? [];
  const projects = over.projects ?? [{ id: P1, name: "Launch" }];
  const visible = over.visibleTo ?? (() => true);
  return fakeDb((q) => {
    const fail = over.fail ?? {};
    if (q.kind === "from" && q.name === "calendar_feed_tokens") {
      if (fail.token) return { data: null, error: fail.token };
      const want = op(q, "eq")?.[1];
      return { data: tokens.find((t) => t.token === want) ?? null, error: null };
    }
    if (q.kind === "from" && q.name === "task_user_state") {
      if (fail.states) return { data: null, error: fail.states };
      const uid = q.ops.find((o) => o.m === "eq" && o.a[0] === "user_id")?.a[1];
      const from = op(q, "gte")?.[1] as string, to = op(q, "lte")?.[1] as string;
      return { data: states.filter((s) => s.user_id === uid && s.plan_today && s.scheduled != null && (s.plan_day as string) >= from && (s.plan_day as string) <= to), error: null };
    }
    if (q.kind === "rpc" && q.name === "tasks_visible_to") {
      if (fail.tasks) return { data: null, error: fail.tasks };
      let rows = tasks.filter(visible).filter((t) => t.status !== "done" && !t.archived_at);
      const ids = op(q, "in")?.[1] as string[] | undefined;
      if (ids) rows = rows.filter((t) => ids.includes(t.id as string));
      else {
        const or = String(op(q, "or")?.[0] ?? "");
        const uid = (q.args as { p_user: string }).p_user;
        const m = /due_date\.gte\.([\d-]+),due_date\.lte\.([\d-]+)/.exec(or);
        rows = rows.filter((t) => (t.plan_today === true && t.assignee_id === uid)
          || (!!m && !!t.due_date && (t.due_date as string) >= m[1] && (t.due_date as string) <= m[2]));
      }
      const range = op(q, "range") as [number, number] | undefined;
      if (range) rows = rows.slice(range[0], range[1] + 1);
      return { data: rows, error: null };
    }
    if (q.kind === "from" && q.name === "projects") {
      if (fail.projects) return { data: null, error: fail.projects };
      const ids = op(q, "in")?.[1] as string[];
      return { data: projects.filter((p) => ids.includes(p.id as string)), error: null };
    }
    return { data: null, error: null }; // rate_limits housekeeping etc.
  });
}

const task = (over: Row): Row => ({
  title: "Task", status: "todo", project_id: P1, workspace_id: "ws-1", assignee_id: ME, collaborators: [],
  due_date: null, due_time: null, archived_at: null, scheduled: null, plan_today: false, dur: null, focus_min: 30, ...over,
});
const allow = vi.fn(async (_key: string, _w: Window): Promise<HitResult> => ({ allowed: true, retryAfter: 0 }));
const req = (query = `?t=${TOKEN}`, init: RequestInit = {}) =>
  new Request(`https://x.supabase.co/functions/v1/ics-feed${query}`, init);
const run = (w: ReturnType<typeof fakeDb>, r: Request, limit = allow) =>
  handleFeedRequest(r, { db: w.db, appUrl: "https://www.kanbo.co.uk", now: NOW, limit });

afterEach(() => { allow.mockClear(); vi.restoreAllMocks(); });

describe("ics-feed handler", () => {
  it("answers CORS preflight and refuses other methods", async () => {
    const w = world();
    const pre = await run(w, req("", { method: "OPTIONS" }));
    expect(pre.status).toBe(200);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const post = await run(w, req(`?t=${TOKEN}`, { method: "POST" }));
    expect(post.status).toBe(405);
    expect(w.log).toHaveLength(0);
  });

  it("a missing or malformed token is a plain 404 without touching the database", async () => {
    const w = world();
    for (const q of ["", "?t=", "?t=short", `?t=${"a".repeat(31)}`, `?t=${"a".repeat(40)}%27%3B--`, `?token=${TOKEN}`]) {
      const res = await run(w, req(q));
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(w.log).toHaveLength(0);
  });

  it("an unknown token is 404, and repeated misses from one IP are slowed down", async () => {
    const w = world({ tokens: [] });
    const r = req(`?t=${"b".repeat(64)}`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
    const res = await run(w, r);
    expect(res.status).toBe(404);
    expect(allow).toHaveBeenCalledTimes(1);
    const [key, win] = allow.mock.calls[0];
    expect(key).toMatch(/^kanbo:ics-feed:miss:[0-9a-f]{32}$/);
    expect(key).not.toContain("203.0.113.9");
    expect(win).toEqual({ windowSec: 600, max: 30 });
    const deny = vi.fn(async () => ({ allowed: false, retryAfter: 120 }));
    const limited = await run(w, req(`?t=${"b".repeat(64)}`, { headers: { "cf-connecting-ip": "203.0.113.9" } }), deny);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("120");
  });

  it("serves the person's calendar: planned blocks and due dates, with feed headers", async () => {
    const w = world({ tasks: [
      task({ id: T(1), title: "Write brief", plan_today: true, scheduled: 9 * 60, dur: 60 }),
      task({ id: T(2), title: "Send invoice", due_date: "2026-10-06", due_time: "15:00" }),
      task({ id: T(3), title: "Their work", assignee_id: YOU, plan_today: true, scheduled: 600, due_date: "2026-10-06" }),
      task({ id: T(4), title: "Finished", status: "done", plan_today: true, scheduled: 600 }),
    ] });
    const res = await run(w, req());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('inline; filename="kanbo.ics"');
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=900");
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const body = await res.text();
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    const flat = body.replace(/\r\n /g, "");
    expect(flat).toContain("SUMMARY:Write brief · Launch");
    expect(flat).toContain("DTSTART:20261004T080000Z"); // 09:00 BST
    expect(flat).toContain("SUMMARY:Due 15:00: Send invoice · Launch");
    expect(flat).toContain(`URL:https://www.kanbo.co.uk/?task=${T(1)}`);
    expect(flat).not.toContain("Their work");
    expect(flat).not.toContain("Finished");
    // asked the database for exactly this person's open, unarchived tasks
    const rpc = w.log.find((q) => q.kind === "rpc")!;
    expect(rpc.args).toEqual({ p_user: ME });
    expect(rpc.ops).toEqual(expect.arrayContaining([
      { m: "neq", a: ["status", "done"] }, { m: "is", a: ["archived_at", null] },
      { m: "or", a: [`and(plan_today.eq.true,assignee_id.eq.${ME}),and(due_date.gte.2026-10-04,due_date.lte.2026-10-18)`] },
    ]));
    // and rate-limited per token, by its hash
    expect(allow).toHaveBeenCalledTimes(1);
    expect(allow.mock.calls[0][0]).toMatch(/^kanbo:ics-feed:[0-9a-f]{32}$/);
    expect(allow.mock.calls[0][0]).not.toContain(TOKEN);
    expect(allow.mock.calls[0][1]).toEqual({ windowSec: 3600, max: 120 });
  });

  it("include_due off: only planned blocks, and only those are asked for", async () => {
    const w = world({ tokens: [{ token: TOKEN, user_id: ME, include_due: false }], tasks: [
      task({ id: T(1), plan_today: true, scheduled: 600 }), task({ id: T(2), due_date: "2026-10-05" }),
    ] });
    const body = await (await run(w, req())).text();
    expect(body).toContain(`UID:plan-${T(1)}-20261004@kanbo.co.uk`);
    expect(body).not.toContain("due-");
    const rpc = w.log.find((q) => q.kind === "rpc")!;
    expect(op(rpc, "or")).toEqual([`and(plan_today.eq.true,assignee_id.eq.${ME})`]);
  });

  it("plan rows bring in teammates' tasks I can still see, and nothing from tasks I can't", async () => {
    const w = world({
      tasks: [
        task({ id: T(5), title: "Shared", assignee_id: YOU }),
        task({ id: T(6), title: "Left workspace", assignee_id: YOU, workspace_id: "ws-old" }),
      ],
      visibleTo: (t) => t.workspace_id !== "ws-old",
      states: [
        { user_id: ME, task_id: T(5), plan_day: "2026-10-05", scheduled: 14 * 60, plan_today: true },
        { user_id: ME, task_id: T(6), plan_day: "2026-10-05", scheduled: 15 * 60, plan_today: true },
        { user_id: YOU, task_id: T(5), plan_day: "2026-10-05", scheduled: 8 * 60, plan_today: true },
      ],
    });
    const body = (await (await run(w, req())).text()).replace(/\r\n /g, "");
    expect(body).toContain("SUMMARY:Shared · Launch");
    expect(body).toContain("DTSTART:20261005T130000Z");
    expect(body).not.toContain("Left workspace");
    expect(body).not.toContain("DTSTART:20261005T070000Z"); // someone else's plan row
    const byId = w.log.filter((q) => q.kind === "rpc" && op(q, "in"));
    expect(byId).toHaveLength(1);
    expect(op(byId[0], "in")).toEqual(["id", [T(5), T(6)]]);
  });

  it("pages through more than 1000 tasks", async () => {
    const tasks = Array.from({ length: 1205 }, (_, i) => task({ id: T(i + 1), due_date: "2026-10-05" }));
    const w = world({ tasks });
    const body = await (await run(w, req())).text();
    const pages = w.log.filter((q) => q.kind === "rpc" && !op(q, "in"));
    expect(pages.map((q) => op(q, "range"))).toEqual([[0, 999], [1000, 1999]]);
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1205);
  });

  it("only looks up project ids that are uuids, and copes without names", async () => {
    const w = world({ tasks: [task({ id: T(1), project_id: "p-inbox", plan_today: true, scheduled: 600 }), task({ id: T(2), project_id: P1, plan_today: true, scheduled: 660 })] });
    await run(w, req());
    const proj = w.log.find((q) => q.name === "projects")!;
    expect(op(proj, "in")).toEqual(["id", [P1]]);
    expect(op(proj, "select")).toEqual(["id,name,archived_at"]);
    const unnamed = world({ tasks: [task({ id: T(1), plan_today: true, scheduled: 600, title: "Plain" })], projects: [{ id: P1, name: null, archived_at: null }] });
    const res = await run(unnamed, req());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SUMMARY:Plain\r\n");
  });

  it("tasks in an archived project never appear: planned blocks, plan rows or due dates", async () => {
    const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const w = world({
      projects: [{ id: P1, name: "Launch", archived_at: null }, { id: P2, name: "Old site", archived_at: "2026-09-30T12:00:00Z" }],
      tasks: [
        task({ id: T(1), title: "Shelved block", project_id: P2, plan_today: true, scheduled: 600, due_date: "2026-10-05" }),
        task({ id: T(2), title: "Shelved teammate", project_id: P2, assignee_id: YOU }),
        task({ id: T(3), title: "Live work", plan_today: true, scheduled: 660, due_date: "2026-10-06" }),
      ],
      states: [{ user_id: ME, task_id: T(2), plan_day: "2026-10-05", scheduled: 14 * 60, plan_today: true }],
    });
    const res = await run(w, req());
    expect(res.status).toBe(200);
    const body = (await res.text()).replace(/\r\n /g, "");
    expect(body).not.toContain("Shelved");
    expect(body).not.toContain("Old site");
    expect(body).toContain("SUMMARY:Live work · Launch");
    expect(body).toContain("SUMMARY:Due: Live work · Launch");
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it("a projects lookup error is a 503: without it the feed can't tell what's archived", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = world({ tasks: [task({ id: T(1), plan_today: true, scheduled: 600, title: "Plain" })], fail: { projects: { message: "boom" } } });
    const res = await run(broken, req());
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
  });

  it("?ping=1 answers 204 (the app's 'is it deployed?' check) without the database or the limiter", async () => {
    const w = world();
    for (const q of ["?ping=1", "?ping", `?ping=1&t=${TOKEN}`]) {
      const res = await run(w, req(q));
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await run(w, req("?ping=1", { method: "POST" }))).status).toBe(405);
    expect(w.log).toHaveLength(0);
    expect(allow).not.toHaveBeenCalled();
  });

  it("If-None-Match: the same ETag (weak or strong) is a 304 with no body", async () => {
    const w = world({ tasks: [task({ id: T(1), plan_today: true, scheduled: 600 })] });
    const first = await run(w, req());
    const etag = first.headers.get("ETag")!;
    const again = await run(w, req(`?t=${TOKEN}`, { headers: { "If-None-Match": etag } }));
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("ETag")).toBe(etag);
    expect(again.headers.get("Cache-Control")).toBe("private, max-age=900");
    expect((await run(w, req(`?t=${TOKEN}`, { headers: { "If-None-Match": `"zzz", W/${etag}` } }))).status).toBe(304);
    expect((await run(w, req(`?t=${TOKEN}`, { headers: { "If-None-Match": '"other"' } }))).status).toBe(200);
  });

  it("the same plan gives the same bytes (and ETag); a change gives a new one", async () => {
    const tasks = [task({ id: T(1), plan_today: true, scheduled: 600 })];
    const a = await run(world({ tasks }), req());
    const b = await run(world({ tasks }), req());
    expect(a.headers.get("ETag")).toBe(b.headers.get("ETag"));
    const c = await run(world({ tasks: [task({ id: T(1), plan_today: true, scheduled: 660 })] }), req());
    expect(c.headers.get("ETag")).not.toBe(a.headers.get("ETag"));
  });

  it("HEAD: headers only", async () => {
    const w = world({ tasks: [task({ id: T(1), plan_today: true, scheduled: 600 })] });
    const res = await run(w, req(`?t=${TOKEN}`, { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^"/);
    expect(await res.text()).toBe("");
  });

  it("too many fetches for one token: 429 with Retry-After, before any task is read", async () => {
    const w = world();
    const deny = vi.fn(async () => ({ allowed: false, retryAfter: 1800 }));
    const res = await run(w, req(), deny);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1800");
    expect(w.log.some((q) => q.kind === "rpc")).toBe(false);
  });

  it("a database error is a 503 (never an empty calendar), and the token is never logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const fail of [{ tasks: { message: `boom ${TOKEN}` } }, { states: { code: "57014", message: "timeout" } }, { token: { code: "08006", message: "connection" } }]) {
      const res = await run(world({ fail }), req());
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("300");
      expect(res.headers.get("Content-Type")).toContain("text/plain");
    }
    // even when the database echoes the token back, the log line doesn't carry it
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(call.map(String).join(" ")).not.toContain(TOKEN);
  });

  it("before 0043: no token table → 404; no plan table → the feed still works", async () => {
    const noTable = await run(world({ fail: { token: { code: "42P01", message: 'relation "calendar_feed_tokens" does not exist' } } }), req());
    expect(noTable.status).toBe(404);
    const noStates = await run(world({ tasks: [task({ id: T(1), plan_today: true, scheduled: 600 })], fail: { states: { code: "PGRST205", message: "Could not find the table in the schema cache" } } }), req());
    expect(noStates.status).toBe(200);
    expect(await noStates.text()).toContain("BEGIN:VEVENT");
  });

  it("a token row with a non-uuid user is treated as unknown", async () => {
    const res = await run(world({ tokens: [{ token: TOKEN, user_id: "not-a-uuid", include_due: true }] }), req());
    expect(res.status).toBe(404);
  });

  it("uses the default limiter (rate_limits) when none is injected, failing open without the table", async () => {
    const w = world({ tasks: [task({ id: T(1), plan_today: true, scheduled: 600 })] });
    const res = await handleFeedRequest(req(), { db: w.db, appUrl: "https://www.kanbo.co.uk", now: NOW });
    expect(res.status).toBe(200);
    expect(w.log.some((q) => q.name === "rate_limits")).toBe(true);
  });
});

describe("helpers", () => {
  it("FEED_TOKEN_RE matches 0043's server-made tokens only", () => {
    expect(FEED_TOKEN_RE.test("0123456789abcdef".repeat(4))).toBe(true);
    expect(FEED_TOKEN_RE.test("short")).toBe(false);
    expect(FEED_TOKEN_RE.test("a".repeat(31) + "'")).toBe(false);
  });
  it("etagOf is a quoted 128-bit hex digest, stable per body", async () => {
    const a = await etagOf("hello"), b = await etagOf("hello"), c = await etagOf("hello!");
    expect(a).toMatch(/^"[0-9a-f]{32}"$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it("ifNoneMatchHits: lists, weak tags and *", () => {
    expect(ifNoneMatchHits(null, '"x"')).toBe(false);
    expect(ifNoneMatchHits('"x"', '"x"')).toBe(true);
    expect(ifNoneMatchHits('W/"x"', '"x"')).toBe(true);
    expect(ifNoneMatchHits('"a", "x"', '"x"')).toBe(true);
    expect(ifNoneMatchHits("*", '"x"')).toBe(true);
    expect(ifNoneMatchHits('"y"', '"x"')).toBe(false);
  });
  it("isMissing recognises a migration that hasn't run", () => {
    expect(isMissing({ code: "42P01" })).toBe(true);
    expect(isMissing({ code: "PGRST205" })).toBe(true);
    expect(isMissing({ code: "PGRST202" })).toBe(true);
    expect(isMissing({ message: "relation does not exist" })).toBe(true);
    expect(isMissing({ code: "57014", message: "timeout" })).toBe(false);
  });
});
