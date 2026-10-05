// @vitest-environment node
/* The slack-post and slack-standup handlers, run under a stubbed Deno with a
   fake database, end to end:
   - when Slack can't be reached, the webhook URL (the workspace's secret)
     never reaches console.* or the response. Deno's fetch errors quote the
     request URL, so logging e.message as it is would write the secret into
     the function logs;
   - the daily post tells Settings when it isn't going out: slack-standup's
     heartbeat and failures (in rate_limits), read back by slack-post's
     "status" action for owners/admins. */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { STANDUP_HEARTBEAT_KEY, standupFailurePrefix, webhookTag } from "./slackHealth";

const HOOK = "https://hooks.slack.com/services/T0001/B0002/abcdefghijklmnopqrstuvwx";
const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SERVICE = "service-role-key-for-tests";
const CRON = "cron-secret-for-tests";

type Handler = (req: Request) => Promise<Response>;
const handlers: Handler[] = [];

/* ---- a fake supabase-js: every query is chainable and awaitable ---- */
const TABLES: Record<string, { data?: unknown[]; error?: { code: string; message: string } }> = {
  profiles: { data: [{ id: USER, first_name: "Ada", last_name: "Lovelace", approved: true, suspended: false }] },
  workspace_integrations: { data: [{ workspace_id: WS, slack_webhook_url: HOOK, slack_channel_label: "#team", slack_autopost_time: "09:00" }] },
  workspaces: { data: [{ name: "Acme", owner_id: USER }] },
  workspace_members: { data: [{ user_id: USER, name: "Ada", email: "ada@example.com", role: "owner" }] },
  tasks: { data: [] },
  projects: { data: [] },
  task_events: { data: [] },
  rate_limits: { error: { code: "42P01", message: 'relation "rate_limits" does not exist' } },   // fails open
};

/* rate_limits in memory, when a test wants one (otherwise it's missing: 0042 not run) */
type RL = { key: string; last_at: string; count: number };
let RATE: Map<string, RL> | null = null;
function rateQuery() {
  let op: "select" | "upsert" | "update" | "delete" = "select";
  let payload: Record<string, unknown> = {};
  let ignore = false;
  const filters: Array<(r: RL) => boolean> = [];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.upsert = (row: RL, o: { ignoreDuplicates?: boolean } = {}) => { op = "upsert"; payload = row; ignore = !!o.ignoreDuplicates; return q; };
  q.update = (patch: Record<string, unknown>) => { op = "update"; payload = patch; return q; };
  q.delete = () => { op = "delete"; return q; };
  q.eq = (c: keyof RL, v: unknown) => { filters.push((r) => r[c] === v); return q; };
  q.is = (c: keyof RL, v: unknown) => { filters.push((r) => r[c] === v); return q; };
  q.lt = (c: keyof RL, v: string) => { filters.push((r) => String(r[c]) < v); return q; };
  q.like = (c: keyof RL, p: string) => {
    const re = new RegExp(`^${p.split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    filters.push((r) => re.test(String(r[c])));
    return q;
  };
  const run = () => {
    const store = RATE!;
    const hits = [...store.values()].filter((r) => filters.every((f) => f(r)));
    if (op === "delete") { hits.forEach((r) => store.delete(r.key)); return { data: null, error: null }; }
    if (op === "update") { hits.forEach((r) => Object.assign(r, payload)); return { data: hits.map((r) => ({ ...r })), error: null }; }
    if (op === "upsert") {
      const row = payload as RL;
      if (ignore && store.has(row.key)) return { data: [], error: null };
      store.set(row.key, { ...row });
      return { data: [{ ...row }], error: null };
    }
    return { data: hits.map((r) => ({ ...r })), error: null };
  };
  q.maybeSingle = async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; };
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, bad);
  return q;
}
const OWNER_VIEW = { connected: true, can_manage: true, can_post: true, channel_label: "#team" };
let RPC: Record<string, unknown> = OWNER_VIEW;
function query(table: string) {
  const t = TABLES[table] ?? { data: [] };
  const many = { data: t.error ? null : t.data ?? [], error: t.error ?? null };
  const one = { data: t.error ? null : (t.data ?? [])[0] ?? null, error: t.error ?? null };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "not", "is", "in", "or", "order", "range", "like", "lt", "gte", "upsert", "update", "insert", "delete"]) q[m] = () => q;
  q.maybeSingle = () => Promise.resolve(one);
  q.single = () => Promise.resolve(one);
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(many).then(ok, bad);
  return q;
}
vi.mock("https://esm.sh/@supabase/supabase-js@2", () => ({
  createClient: () => ({
    from: (table: string) => (table === "rate_limits" && RATE ? rateQuery() : query(table)),
    rpc: async () => ({ data: RPC, error: null }),
    auth: { getUser: async () => ({ data: { user: { id: USER, email: "ada@example.com" } }, error: null }) },
  }),
}));

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: "anon",
  APP_URL: "https://www.kanbo.co.uk", CRON_SECRET: CRON,
};

beforeAll(async () => {
  (globalThis as unknown as { Deno: unknown }).Deno = {
    serve: (h: Handler) => { handlers.push(h); },
    env: { get: (k: string) => ENV[k] },
  };
  await import("../slack-post/index.ts");
  await import("../slack-standup/index.ts");
  expect(handlers).toHaveLength(2);
});

const logged: unknown[][] = [];
beforeEach(() => {
  logged.length = 0;
  for (const level of ["error", "warn", "log", "info", "debug", "trace"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
  }
  vi.spyOn(Math, "random").mockReturnValue(0.99);   // no rate_limits sweep
  RATE = null;
  RPC = OWNER_VIEW;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/** Run a handler to the end under fake setTimeout (the 300ms pause between
 *  workspaces), letting real async work (the webhook's SHA-256) finish too. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 400 && !done; i++) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((r) => setImmediate(r));
  }
  return p;
}

const leaks = (s: string) => s.includes("abcdefghijklmnopqrstuvwx") || s.includes("hooks.slack.com/services") || s.includes("T0001/B0002");
const allLogs = () => logged.map((args) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message} ${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");

const FAILURES: Array<[string, () => unknown]> = [
  ["a DNS failure (older Deno wording)", () => new TypeError(`error sending request for url (${HOOK}): client error (Connect): dns error: failed to lookup address information: nodename nor servname provided`)],
  ["a refused connection (newer Deno wording)", () => new TypeError(`error sending request from 10.0.0.1:50123 for ${HOOK} (3.1.2.3:443): client error (Connect): tcp connect error: Connection refused`)],
  ["a TLS failure", () => new TypeError(`error sending request for url (${HOOK}): client error (Connect): invalid peer certificate: UnknownIssuer`)],
  ["a timeout", () => new DOMException("Signal timed out.", "TimeoutError")],
];

const post = (handler: Handler) => handler(new Request("https://fn.test/slack-post", {
  method: "POST",
  headers: { Authorization: "Bearer user-jwt", "Content-Type": "application/json" },
  body: JSON.stringify({ action: "post_standup", workspaceId: WS, text: "*Pulse — Sun 4 Oct*\nAll quiet." }),
}));
const standup = (handler: Handler, body: Record<string, unknown> = { workspaceId: WS, force: true }) => handler(new Request("https://fn.test/slack-standup", {
  method: "POST",
  headers: { "x-cron-secret": CRON, "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));
const slackPost = (handler: Handler, body: Record<string, unknown>) => handler(new Request("https://fn.test/slack-post", {
  method: "POST",
  headers: { Authorization: "Bearer user-jwt", "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

describe("slack-post: Slack unreachable", () => {
  it.each(FAILURES)("%s: logged without the webhook, refused as unreachable", async (_label, failure) => {
    const fetch = vi.fn(async () => { throw failure(); });
    vi.stubGlobal("fetch", fetch);
    const res = await post(handlers[0]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(HOOK);   // it really was the webhook that failed
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ reason: "slack_rejected", detail: "unreachable" });
    expect(leaks(body)).toBe(false);
    expect(logged.length).toBeGreaterThan(0);      // the failure is still logged…
    expect(allLogs()).toContain(WS);               // …against its workspace…
    expect(leaks(allLogs()), allLogs()).toBe(false); // …but never with the URL
  });
});

describe("slack-standup: Slack unreachable", () => {
  it.each(FAILURES)("%s: logged without the webhook, counted as failed", async (_label, failure) => {
    const fetch = vi.fn(async () => { throw failure(); });
    vi.stubGlobal("fetch", fetch);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const res = await settle(standup(handlers[1]));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ due: 1, posted: 0, failed: 1 });
      expect(leaks(body)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(allLogs()).toContain(WS);
    expect(leaks(allLogs()), allLogs()).toBe(false);
  });
});

/* ---------------------------------------------------------------- is the daily post going out? */

const MONDAY_0905 = new Date("2026-10-05T08:05:00Z");    // Mon 5 Oct, 09:05 in London: 09:00 is due
const SATURDAY = new Date("2026-10-03T08:05:00Z");
const slackSays = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));
const failureKeys = () => [...RATE!.keys()].filter((k) => k.startsWith(standupFailurePrefix(WS)));

describe("slack-standup: leaves marks for Settings", () => {
  beforeEach(() => { RATE = new Map(); });

  it("a scheduled run stamps the heartbeat, weekends included; a forced run doesn't", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: SATURDAY });
    vi.stubGlobal("fetch", slackSays(200, "ok"));
    expect(await (await settle(standup(handlers[1], {}))).json()).toMatchObject({ note: "weekend" });
    expect(RATE!.get(STANDUP_HEARTBEAT_KEY)?.last_at).toBe(SATURDAY.toISOString());

    RATE = new Map();
    await settle(standup(handlers[1]));               // force: a person checking, not the scheduler
    expect(RATE.has(STANDUP_HEARTBEAT_KEY)).toBe(false);
  });

  it("Slack refuses: the reason is kept against the link (never the link), and today's slot is freed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: MONDAY_0905 });
    vi.stubGlobal("fetch", slackSays(404, "no_service"));
    const res = await settle(standup(handlers[1], {}));
    expect(await res.json()).toMatchObject({ due: 1, posted: 0, failed: 1 });
    expect(RATE!.has(STANDUP_HEARTBEAT_KEY)).toBe(true);
    expect(failureKeys()).toEqual([`${standupFailurePrefix(WS)}${await webhookTag(HOOK)}:no_service`]);
    expect([...RATE!.keys()].some((k) => k.startsWith(`kanbo:slack-standup:${WS}:`))).toBe(false);   // slot released
    expect(leaks(JSON.stringify([...RATE!.entries()]))).toBe(false);

    // the next run in the window gets through: the failure is forgotten
    vi.stubGlobal("fetch", slackSays(200, "ok"));
    expect(await (await settle(standup(handlers[1], {}))).json()).toMatchObject({ due: 1, posted: 1 });
    expect(failureKeys()).toEqual([]);
  });

  it("Slack unreachable is kept as 'unreachable'", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: MONDAY_0905 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw FAILURES[0][1](); }));
    await settle(standup(handlers[1], {}));
    expect(failureKeys()).toEqual([`${standupFailurePrefix(WS)}${await webhookTag(HOOK)}:unreachable`]);
    expect(leaks(allLogs())).toBe(false);
  });
});

describe("slack-post: status (is the daily post going out?)", () => {
  const status = () => slackPost(handlers[0], { action: "status", workspaceId: WS });

  it("owner/admin: the heartbeat and the current link's last failure, never the webhook", async () => {
    const tag = await webhookTag(HOOK);
    RATE = new Map([
      [STANDUP_HEARTBEAT_KEY, { key: STANDUP_HEARTBEAT_KEY, last_at: new Date(Date.now() - 10 * 60_000).toISOString(), count: 0 }],
      [`${standupFailurePrefix(WS)}${tag}:channel_is_archived`, { key: `${standupFailurePrefix(WS)}${tag}:channel_is_archived`, last_at: "2026-10-05T08:05:00.000Z", count: 1 }],
    ]);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await status();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, autopostReady: true, lastAutopostError: { detail: "channel_is_archived", at: "2026-10-05T08:05:00.000Z", day: "2026-10-05" } });
    expect(leaks(text)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();             // read-only: nothing goes to Slack
  });

  it("a stale heartbeat is 'not running'; another link's failure isn't reported", async () => {
    RATE = new Map([
      [STANDUP_HEARTBEAT_KEY, { key: STANDUP_HEARTBEAT_KEY, last_at: new Date(Date.now() - 3 * 3600_000).toISOString(), count: 0 }],
      [`${standupFailurePrefix(WS)}aaaaaaaaaaaa:no_service`, { key: `${standupFailurePrefix(WS)}aaaaaaaaaaaa:no_service`, last_at: new Date().toISOString(), count: 1 }],
    ]);
    expect(await (await status()).json()).toEqual({ ok: true, autopostReady: false, lastAutopostError: null });
  });

  it("without rate_limits (0042 not run) it can't tell: null", async () => {
    expect(await (await status()).json()).toEqual({ ok: true, autopostReady: null, lastAutopostError: null });
  });

  it("members and guests are refused", async () => {
    RATE = new Map();
    RPC = { ...OWNER_VIEW, can_manage: false };
    const res = await status();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "not_allowed" });
  });

  it("an unknown action (even one named like Object's own) is refused", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    for (const action of ["constructor", "toString", "__proto__", "nope"]) {
      const res = await slackPost(handlers[0], { action, workspaceId: WS, text: "hi" });
      expect(res.status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a post that reaches Slack clears the workspace's failed daily post", async () => {
    const key = `${standupFailurePrefix(WS)}${await webhookTag(HOOK)}:no_service`;
    RATE = new Map([[key, { key, last_at: new Date().toISOString(), count: 1 }]]);
    vi.stubGlobal("fetch", slackSays(200, "ok"));
    const res = await slackPost(handlers[0], { action: "test", workspaceId: WS });
    expect(res.status).toBe(200);
    expect(RATE.has(key)).toBe(false);
  });

  it("a refused post leaves it", async () => {
    const key = `${standupFailurePrefix(WS)}${await webhookTag(HOOK)}:no_service`;
    RATE = new Map([[key, { key, last_at: new Date().toISOString(), count: 1 }]]);
    vi.stubGlobal("fetch", slackSays(404, "no_service"));
    expect((await slackPost(handlers[0], { action: "test", workspaceId: WS })).status).toBe(502);
    expect(RATE.has(key)).toBe(true);
  });
});
