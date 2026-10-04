// @vitest-environment node
/* The slack-post and slack-standup handlers, run under a stubbed Deno with a
   fake database, to check one thing end to end: when Slack can't be reached,
   the webhook URL (the workspace's secret) never reaches console.* or the
   response. Deno's fetch errors quote the request URL, so logging e.message
   as it is would write the secret into the function logs. */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

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
    from: (table: string) => query(table),
    rpc: async () => ({ data: { connected: true, can_manage: true, can_post: true, channel_label: "#team" }, error: null }),
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
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
const standup = (handler: Handler) => handler(new Request("https://fn.test/slack-standup", {
  method: "POST",
  headers: { "x-cron-secret": CRON, "Content-Type": "application/json" },
  body: JSON.stringify({ workspaceId: WS, force: true }),
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
      const pending = standup(handlers[1]);
      await vi.runAllTimersAsync();                 // the 300ms pause between workspaces
      const res = await pending;
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
