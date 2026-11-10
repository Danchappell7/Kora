// @vitest-environment node
// The slack-app router with a stubbed Slack Web API and a scripted database:
// the gate (signatures), routing, the 3-second rule, link prompts, event
// de-duplication and the modal's checks. The full flows (tasks made, assigned,
// completed and undone as the linked person with RLS, unfurls, the Home tab,
// rate limits) run against the real migrations in the PGlite replay
// (scratchpad/pgtest-slack/flows.mjs).
import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { handleSlackRequest, kanboLinkTarget, RATE, within, type SlackAppDeps } from "./slackAppHandler.ts";
import { decodeMeta } from "./slackAppBlocks.ts";
import type { SlackApi, SlackApiAnswer } from "./slackAppApi.ts";
import type { Tx } from "./api/types.ts";

const SECRET = "unit-test-signing-secret";
const TOKEN = "A".repeat(43);
const MIA = "aaaaaaaa-0000-4000-8000-000000000001";

function sign(body: string, ts = Math.floor(Date.now() / 1000)) {
  return { "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex") };
}
const form = (f: Record<string, string>, headers?: Record<string, string>) => {
  const body = new URLSearchParams(f).toString();
  return new Request("https://x/functions/v1/slack-app", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...(headers ?? sign(body)) } });
};
const payload = (p: unknown) => form({ payload: JSON.stringify(p) });
const event = (e: unknown, extra: Record<string, string> = {}, ts?: number) => {
  const body = JSON.stringify(e);
  return new Request("https://x/functions/v1/slack-app", { method: "POST", body, headers: { "content-type": "application/json", ...sign(body, ts), ...extra } });
};
const slash = (text: string, user = "UMIA") => form({ command: "/kanbo", text, team_id: "TACME", team_domain: "acme", user_id: user, response_url: "https://hooks.slack.com/commands/T/1/a", trigger_id: "1.2.3" });

interface Script {
  /** true: everyone is linked (as Mia); a list: only these Slack ids are */
  linked?: boolean | string[];
  canAct?: boolean; ws?: string | null; seen?: Set<string>; missing?: boolean;
  /** count rate-limit hits like api_rate_hit does (rejected hits count too) */
  countRates?: boolean;
  /** users.info says they're a Slack workspace admin */
  slackAdmin?: boolean;
  /** each as-the-person transaction takes this long */
  userDelayMs?: number;
  /** what loadCard / loadProjectCard read as the person (a task card row, a project card row) */
  card?: Record<string, unknown>;
  projectCard?: Record<string, unknown>;
}
function harness(script: Script = {}, slackDelayMs = 0) {
  const sql: string[] = [];
  const params: Array<readonly unknown[]> = [];
  const asUser: string[] = [];
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const responds: Array<{ url: string; body: unknown }> = [];
  const later: Promise<unknown>[] = [];
  const seen = script.seen ?? new Set<string>();
  const hits = new Map<string, number>();
  const isLinked = (slackUserId: unknown) => (Array.isArray(script.linked) ? script.linked.includes(String(slackUserId)) : !!script.linked);
  const service: Tx = {
    async query<T>(text: string, args: readonly unknown[] = []): Promise<T[]> {
      sql.push(text);
      params.push(args);
      if (script.missing && /slack_/.test(text)) throw Object.assign(new Error('relation "public.slack_user_links" does not exist'), { code: "42P01" });
      if (/api_rate_hit/.test(text)) {
        const key = String(args[0]);
        if (key.startsWith("kanbo:api:slack:evt:") || key.startsWith("kanbo:api:slack:sig:")) { const first = !seen.has(key); seen.add(key); return [{ allowed: first, retry_after: 0 }] as T[]; }
        const n = (hits.get(key) ?? 0) + 1;
        hits.set(key, n);
        return [{ allowed: !script.countRates || n <= Number(args[2]), retry_after: 60 }] as T[];
      }
      if (/from public\.slack_user_links/.test(text)) return (isLinked(args[1]) ? [{ user_id: MIA, slack_user_name: "Mia", can_act: script.canAct !== false }] : []) as T[];
      if (/from public\.slack_teams/.test(text)) return (script.ws === undefined ? [] : [{ team_name: "acme", ws: script.ws, ws_name: "Acme" }]) as T[];
      if (script.card && /from public\.tasks t left join lateral/.test(text)) return [script.card] as T[];
      if (script.projectCard && /from public\.projects p where p\.id = \$1::uuid and p\.workspace_id/.test(text)) return [script.projectCard] as T[];
      return [] as T[];
    },
  };
  const slack: SlackApi = {
    async call(method, args): Promise<SlackApiAnswer> {
      calls.push({ method, args });
      if (slackDelayMs) await new Promise((r) => setTimeout(r, slackDelayMs));
      if (method === "users.info") return { ok: true, user: { name: "mia", tz: "Europe/London", is_admin: script.slackAdmin === true, profile: { real_name: "Mia Member", email: "mia@acme.test" } } };
      return { ok: true };
    },
    async respond(url, body) { responds.push({ url, body }); return true; },
  };
  const deps: SlackAppDeps = {
    db: { service, withUser: async (scope, fn) => {
      asUser.push(scope.userId);
      if (script.userDelayMs) await new Promise((r) => setTimeout(r, script.userDelayMs));
      return fn(service);
    } },
    slack, signingSecret: SECRET, appUrl: "https://www.kanbo.co.uk", apiBase: "https://x/functions/v1/api/v1", tz: "Europe/London",
    now: () => Date.now(), waitUntil: (p) => { later.push(p); }, log: () => {}, newToken: () => TOKEN, ackAfterMs: 200,
  };
  const run = async (req: Request) => {
    const res = await handleSlackRequest(req, deps);
    const text = await res.text();
    return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
  };
  return { deps, run, sql, params, asUser, calls, responds, hits, settle: () => Promise.all(later.splice(0)) };
}

describe("the gate", () => {
  it("unsigned, wrongly signed, stale or replayed-onto-another-body requests: 401, nothing read, nothing called", async () => {
    const h = harness({ linked: true, ws: null });
    const body = new URLSearchParams({ command: "/kanbo", text: "x", team_id: "TACME", user_id: "UMIA" }).toString();
    const req = (headers: Record<string, string>) => new Request("https://x", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
    expect((await h.run(req({}))).status).toBe(401);
    expect((await h.run(req({ ...sign(body), "x-slack-signature": "v0=" + "f".repeat(64) }))).status).toBe(401);
    expect((await h.run(req(sign(body, Math.floor(Date.now() / 1000) - 600)))).status).toBe(401);
    expect((await h.run(req(sign("other=1")))).status).toBe(401);
    expect(h.sql).toEqual([]);
    expect(h.calls).toEqual([]);
  });
  it("no signing secret: 503 (fails closed); GET: 405; too big: 413", async () => {
    const h = harness();
    h.deps.signingSecret = "";
    expect((await h.run(slash("x"))).status).toBe(503);
    expect((await h.run(new Request("https://x", { method: "GET" }))).status).toBe(405);
    const big = "x".repeat(600_000);
    expect((await h.run(new Request("https://x", { method: "POST", body: big, headers: sign(big) }))).status).toBe(413);
  });
  it("url_verification echoes a sane challenge only", async () => {
    const h = harness();
    expect((await h.run(event({ type: "url_verification", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" }))).body)
      .toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
    expect((await h.run(event({ type: "url_verification", challenge: "<script>" }))).status).toBe(400);
  });
  it("ssl_check pings and unknown payload types are answered quietly", async () => {
    const h = harness();
    expect((await h.run(form({ ssl_check: "1", token: "x" }))).status).toBe(200);
    expect((await h.run(payload({ type: "view_closed", user: { id: "UMIA" }, team: { id: "TACME" } }))).status).toBe(200);
    expect((await h.run(payload({ type: "block_actions", user: { id: "bad id" }, team: { id: "TACME" } }))).status).toBe(400);
  });
});

describe("replays", () => {
  it("the same signed request twice runs once (a replay inside the 5 minutes is dropped)", async () => {
    const h = harness({ linked: false });
    const body = new URLSearchParams({ command: "/kanbo", text: "Buy milk", team_id: "TACME", user_id: "UMIA", response_url: "https://hooks.slack.com/commands/T/1/a" }).toString();
    const headers = sign(body);
    const req = () => new Request("https://x", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
    const first = await h.run(req());
    expect(JSON.stringify(first.body)).toMatch(/Link your Kanbo account/);
    const inserts = () => h.sql.filter((q) => /insert into public\.slack_link_requests/.test(q)).length;
    expect(inserts()).toBe(1);
    const again = await h.run(req());
    expect(again).toEqual({ status: 200, body: null });
    expect(inserts()).toBe(1);
  });
});

describe("/kanbo", () => {
  it("help answers anyone at once (no link needed, no Slack calls)", async () => {
    const h = harness();
    const r = await h.run(slash("help"));
    expect(r.status).toBe(200);
    expect(r.body.text).toBe("How to use /kanbo");
    expect(h.calls).toEqual([]);
  });
  it("unlinked: an ephemeral link prompt; only the token's SHA-256 goes to the database", async () => {
    const h = harness({ linked: false });
    const r = await h.run(slash("Buy milk"));
    expect(r.body.response_type).toBe("ephemeral");
    expect(JSON.stringify(r.body)).toContain(`https://www.kanbo.co.uk/link/slack?t=${TOKEN}`);
    const insert = h.sql.find((s) => /insert into public\.slack_link_requests/.test(s));
    expect(insert).toBeTruthy();
    expect(h.sql.join("\n")).not.toContain(TOKEN);
    expect(h.asUser).toEqual([]);
  });
  it("hashes the token the way the database does (claim_slack_link)", () => {
    expect(createHash("sha256").update(TOKEN).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("linked but suspended: refused before any task work", async () => {
    const h = harness({ linked: true, canAct: false, ws: null });
    const r = await h.run(slash("Buy milk"));
    expect(JSON.stringify(r.body)).toMatch(/can't add or change things/);
    expect(h.asUser).toEqual([]);
  });
  it("before 0049: says the app isn't set up", async () => {
    const h = harness({ missing: true });
    expect(JSON.stringify((await h.run(slash("Buy milk"))).body)).toMatch(/isn't fully set up/);
  });
  it("bare /kanbo opens the modal with the command's trigger", async () => {
    const h = harness({ linked: true, ws: null });
    const r = await h.run(slash(""));
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
    expect(h.calls.find((c) => c.method === "views.open")?.args.trigger_id).toBe("1.2.3");
  });
  it("bare /kanbo's form answers through the command's response_url: a refusal after the form has closed still reaches them", async () => {
    const h = harness({ linked: true, ws: null, userDelayMs: 300 });   // the write takes longer than we wait (200 ms)
    await h.run(slash(""));
    const view = h.calls.find((c) => c.method === "views.open")?.args.view as { private_metadata: string; callback_id: string };
    expect(decodeMeta(view.private_metadata).ru).toBe("https://hooks.slack.com/commands/T/1/a");
    const r = await h.run(payload({ type: "view_submission", user: { id: "UMIA" }, team: { id: "TACME" },
      view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: { title: { title: { value: "Ship it" } } } } } }));
    expect(r).toEqual({ status: 200, body: null });   // the form closes on time
    expect(h.responds).toEqual([]);
    await h.settle();
    // the scripted database can't make a task: what went wrong is told in the channel, only to them
    expect(h.responds).toHaveLength(1);
    expect(h.responds[0].url).toBe("https://hooks.slack.com/commands/T/1/a");
    expect(JSON.stringify(h.responds[0].body)).toMatch(/Kanbo couldn't add that task/);
  });
  it("the link request records whether Slack says they're a Slack workspace admin", async () => {
    for (const slackAdmin of [true, false]) {
      const h = harness({ linked: false, slackAdmin });
      await h.run(slash("Buy milk"));
      const at = h.sql.findIndex((q) => /insert into public\.slack_link_requests/.test(q));
      expect(h.sql[at]).toMatch(/slack_admin/);
      expect(h.params[at][6]).toBe(slackAdmin);
    }
  });
  it("slow work: Slack gets an empty 200 in time, the answer follows via response_url", async () => {
    const h = harness({ linked: false }, 400);   // users.info takes 400 ms; we answer after 200
    const t0 = Date.now();
    const r = await h.run(slash("Buy milk"));
    expect(Date.now() - t0).toBeLessThan(380);
    expect(r).toEqual({ status: 200, body: null });
    expect(h.responds).toEqual([]);
    await h.settle();
    expect(h.responds).toHaveLength(1);
    expect(h.responds[0].url).toBe("https://hooks.slack.com/commands/T/1/a");
    expect(JSON.stringify(h.responds[0].body)).toMatch(/Link your Kanbo account/);
  });
});

describe("rate limits", () => {
  // every request Slack sends is signed afresh (the replay guard drops repeats): a new trigger each time
  let n = 0;
  const slashOnce = (text: string, user: string) => form({ command: "/kanbo", text, team_id: "TACME", team_domain: "acme", user_id: user,
    response_url: "https://hooks.slack.com/commands/T/1/a", trigger_id: `1.2.${++n}` });
  it("someone with no Kanbo account can't use up the Slack workspace's share: linked people still get through", async () => {
    const h = harness({ linked: ["UMIA"], countRates: true });
    // a flood of /kanbo help from an unlinked person: only their own limit stops them
    let busy = 0;
    for (let i = 0; i < RATE.team.max + 5; i++) {
      const r = await h.run(slashOnce("help", "UEVE"));
      if (/a lot of Kanbo/.test(JSON.stringify(r.body))) busy++;
    }
    expect(busy).toBe(RATE.team.max + 5 - RATE.actions.max);
    // …and an unlinked person's link prompts, past their limit, are refused before anything else
    const prompts = h.sql.filter((q) => /insert into public\.slack_link_requests/.test(q)).length;
    expect(prompts).toBe(0);
    expect(h.hits.get("kanbo:api:slack:team:TACME") ?? 0).toBe(0);
    const mia = await h.run(slashOnce("Buy milk", "UMIA"));
    expect(JSON.stringify(mia.body)).not.toMatch(/a lot of Kanbo/);
    expect(h.hits.get("kanbo:api:slack:team:TACME")).toBe(1);
  });
  it("a linked person over their own limit doesn't count against the Slack workspace either", async () => {
    const h = harness({ linked: true, ws: null, countRates: true });
    for (let i = 0; i < RATE.actions.max + 10; i++) await h.run(slashOnce("", "UMIA"));
    expect(h.hits.get("kanbo:api:slack:actions:TACME:UMIA")).toBe(RATE.actions.max + 10);
    expect(h.hits.get("kanbo:api:slack:team:TACME")).toBe(RATE.actions.max);
  });
});

describe("interactivity", () => {
  it("link buttons are acknowledged and ignored", async () => {
    const h = harness({ linked: true, ws: null });
    for (const action_id of ["open_task", "link_account"]) {
      const r = await h.run(payload({ type: "block_actions", user: { id: "UMIA" }, team: { id: "TACME" }, actions: [{ action_id, value: MIA }] }));
      expect(r).toEqual({ status: 200, body: null });
    }
    // only the replay guard looked at the database: nobody was looked up, nothing changed
    expect(h.sql.filter((q) => !/api_rate_hit/.test(q))).toEqual([]);
  });
  it("an unlinked person's button click gets the link prompt through response_url", async () => {
    const h = harness({ linked: false });
    await h.run(payload({ type: "block_actions", user: { id: "UNEW" }, team: { id: "TACME" }, response_url: "https://hooks.slack.com/actions/T/1/a",
      container: { type: "message_attachment" }, actions: [{ action_id: "complete_task", value: MIA }] }));
    await h.settle();
    expect(JSON.stringify(h.responds[0]?.body)).toMatch(/Link your Kanbo account/);
    expect(h.asUser).toEqual([]);
  });
  it("the modal: a blank title or a Personal task for someone else are field errors, before anything is written", async () => {
    const h = harness({ linked: true, ws: "11111111-1111-4111-8111-111111111111" });
    const submit = (values: Record<string, unknown>) => h.run(payload({
      type: "view_submission", user: { id: "UMIA" }, team: { id: "TACME" },
      view: { callback_id: "create_kanbo_task", private_metadata: "{}", state: { values } },
    }));
    const blank = await submit({ title: { title: { value: "  " } } });
    expect(blank.body).toEqual({ response_action: "errors", errors: { title: "Give the task a title." } });
    const other = await submit({ title: { title: { value: "Ship" } }, project: { project: { selected_option: { value: "p-personal" } } }, assignee: { assignee: { selected_option: { value: "bbbbbbbb-0000-4000-8000-000000000002" } } } });
    expect(other.body.response_action).toBe("errors");
    expect(other.body.errors.assignee).toMatch(/only for you/);
    expect(h.sql.some((s) => /insert into public\.tasks/.test(s))).toBe(false);
  });
  it("a message shortcut from someone unlinked: the link prompt in the channel, no modal", async () => {
    const h = harness({ linked: false });
    await h.run(payload({ type: "message_action", callback_id: "create_kanbo_task", trigger_id: "t", response_url: "https://hooks.slack.com/app/T/1/a",
      user: { id: "UNEW" }, team: { id: "TACME", domain: "acme" }, channel: { id: "C1" }, message: { ts: "1.2", text: "hi" } }));
    await h.settle();
    expect(h.calls.some((c) => c.method === "views.open")).toBe(false);
    expect(JSON.stringify(h.responds[0]?.body)).toMatch(/Link your Kanbo account/);
  });
  it("options for someone unlinked: none", async () => {
    const h = harness({ linked: false });
    const r = await h.run(payload({ type: "block_suggestion", action_id: "project", value: "", user: { id: "UNEW" }, team: { id: "TACME" } }));
    expect(r.body).toEqual({ options: [] });
  });
});

describe("events", () => {
  it("answered at once; a resend of the same event id is dropped", async () => {
    const seen = new Set<string>();
    const h = harness({ linked: false, seen });
    const e = { type: "event_callback", team_id: "TACME", event_id: "Ev01ABC", event: { type: "app_home_opened", user: "UMIA", tab: "home" } };
    expect((await h.run(event(e))).status).toBe(200);
    await h.settle();
    expect(h.calls.filter((c) => c.method === "views.publish")).toHaveLength(1);
    expect(JSON.stringify(h.calls[0].args.view)).toMatch(/Link your Kanbo account/);
    // Slack signs a retry afresh (a new timestamp): it passes the replay guard, and is dropped by its event id
    expect((await h.run(event(e, { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" }, Math.floor(Date.now() / 1000) - 2))).status).toBe(200);
    await h.settle();
    expect(h.calls.filter((c) => c.method === "views.publish")).toHaveLength(1);
  });
  it("user_change: the owner/admin flag follows Slack at once (as of the event's time); nobody is linked, called or told", async () => {
    const h = harness({ linked: true });
    const at = Math.floor(Date.now() / 1000) - 30;
    const change = (id: string, user: Record<string, unknown>, eventTime: unknown = at) =>
      h.run(event({ type: "event_callback", team_id: "TACME", event_id: `EvU${id}`, event_time: eventTime, event: { type: "user_change", user: { id: "UOLIVE", ...user } } }));
    const refreshes = () => h.sql.map((q, i) => ({ q, p: h.params[i] })).filter((x) => /update public\.slack_user_links/.test(x.q)).map((x) => x.p);
    expect((await change("1", { is_admin: false, is_owner: false })).status).toBe(200);
    await change("2", { is_admin: true, deleted: true });                            // deactivated
    await change("3", { is_owner: true });                                          // promoted
    await change("4", { is_bot: true, is_admin: true });                            // a bot never counts
    await change("5", { enterprise_user: { is_admin: true } }, "soon");             // Grid org admin; no usable time
    await change("6", { is_admin: true }, Math.floor(Date.now() / 1000) + 3600);   // a time ahead of ours: now
    await h.settle();
    const r = refreshes();
    expect(r.map((p) => p.slice(0, 3))).toEqual([
      ["TACME", "UOLIVE", false], ["TACME", "UOLIVE", false], ["TACME", "UOLIVE", true], ["TACME", "UOLIVE", false], ["TACME", "UOLIVE", true], ["TACME", "UOLIVE", true],
    ]);
    expect(r[0][3]).toBe(new Date(at * 1000).toISOString());
    expect(r[4][3]).toBeNull();
    expect(Date.parse(String(r[5][3]))).toBeLessThanOrEqual(Date.now());
    expect(h.calls).toEqual([]);
    expect(h.responds).toEqual([]);
    expect(h.asUser).toEqual([]);
    expect(h.sql.some((q) => /insert into public\.slack_(user_links|link_requests|teams)/.test(q))).toBe(false);
  });
  it("user_change: a malformed user or a user object for someone else changes nothing", async () => {
    const h = harness({ linked: true });
    await h.run(event({ type: "event_callback", team_id: "TACME", event_id: "EvU7", event: { type: "user_change", user: { id: "bad id", is_admin: true } } }));
    await h.run(event({ type: "event_callback", team_id: "TACME", event_id: "EvU8", event: { type: "user_change", user: "UOLIVE" } }));
    await h.settle();
    expect(h.sql.some((q) => /update public\.slack_user_links/.test(q))).toBe(false);
  });
  it("using /kanbo or opening the Home tab refreshes the flag from users.info (the database's clock)", async () => {
    const h = harness({ linked: true, ws: null, slackAdmin: true });
    await h.run(event({ type: "event_callback", team_id: "TACME", event_id: "EvH1", event: { type: "app_home_opened", user: "UMIA", tab: "home" } }));
    await h.settle();
    const at = h.sql.findIndex((q) => /update public\.slack_user_links/.test(q));
    expect(at).toBeGreaterThan(-1);
    expect(h.params[at]).toEqual(["TACME", "UMIA", true, null]);
  });
  it("link_shared (0058): a task or project closed to the workspace unfurls as a neutral card; an open one, before 0058 too, in full", async () => {
    const WS = "aaaaaaaa-0000-4000-8000-0000000000ws";
    const task = { id: MIA, title: "Salary bands", status: "progress", priority: "high", workspace_id: WS, due_date: null, due_time: null, assignee_id: null,
      user_id: MIA, created_at: "2026-11-01T09:00:00Z", project_name: "Board pay", project_emoji: "💷", assignee_name: "Theo" };
    const proj = { id: MIA, name: "Board pay", emoji: "💷", description: "Pay for the board", open: 3, done: 1 };
    const share = async (script: Script, url: string) => {
      const h = harness({ linked: true, ws: WS, ...script });
      await h.run(event({ type: "event_callback", team_id: "TACME", event_id: `Ev-${Math.random()}`, event: { type: "link_shared", user: "UMIA", channel: "C1", message_ts: "1.2", links: [{ url }] } }));
      await h.settle();
      return JSON.stringify(h.calls.find((c) => c.method === "chat.unfurl")?.args ?? null);
    };
    const taskUrl = `https://www.kanbo.co.uk/?task=${MIA}`, projectUrl = `https://www.kanbo.co.uk/p/${MIA}`;
    for (const visibility of ["members", "private"]) {
      const t = await share({ card: { ...task, project_visibility: visibility, access_on: "true" } }, taskUrl);
      expect(t).toContain("A task in a private Kanbo project");
      for (const secret of ["Salary bands", "Board pay", "Theo", "In progress"]) expect(t).not.toContain(secret);
      const p = await share({ projectCard: { ...proj, visibility, access_on: "true" } }, projectUrl);
      expect(p).toContain("A private Kanbo project");
      for (const secret of ["Board pay", "Pay for the board", "3 open"]) expect(p).not.toContain(secret);
    }
    // a Whole workspace project, the switch off, or a database before 0058 (no such fields): as before
    for (const extra of [{ project_visibility: "workspace", access_on: "true" }, { project_visibility: "private", access_on: "false" }, {}]) {
      expect(await share({ card: { ...task, ...extra } }, taskUrl)).toContain("Salary bands");
    }
    for (const extra of [{ visibility: "workspace", access_on: "true" }, { visibility: "members", access_on: "false" }, {}]) {
      expect(await share({ projectCard: { ...proj, ...extra } }, projectUrl)).toContain("Board pay");
    }
  });
  it("link_shared from someone unlinked: no unfurl, no task read", async () => {
    const h = harness({ linked: false });
    await h.run(event({ type: "event_callback", team_id: "TACME", event_id: "Ev02", event: { type: "link_shared", user: "UNEW", channel: "C1", message_ts: "1.2",
      links: [{ url: `https://www.kanbo.co.uk/?task=${MIA}` }] } }));
    await h.settle();
    expect(h.calls.some((c) => c.method === "chat.unfurl")).toBe(false);
    expect(h.asUser).toEqual([]);
  });
});

describe("helpers", () => {
  it("which Kanbo thing a link is", () => {
    const app = "https://www.kanbo.co.uk";
    expect(kanboLinkTarget(`https://www.kanbo.co.uk/?task=${MIA}`, app)).toEqual({ kind: "task", id: MIA });
    expect(kanboLinkTarget(`https://kanbo.co.uk/p/${MIA}?task=${MIA.toUpperCase()}`, app)).toEqual({ kind: "task", id: MIA });
    expect(kanboLinkTarget(`https://www.kanbo.co.uk/p/${MIA}/board`, app)).toEqual({ kind: "project", id: MIA });
    expect(kanboLinkTarget(`https://www.kanbo.co.uk/today?x=1&amp;task=${MIA}`, app)).toEqual({ kind: "task", id: MIA });
    for (const bad of [`http://www.kanbo.co.uk/?task=${MIA}`, `https://evil.test/?task=${MIA}`, `https://www.kanbo.co.uk.evil.test/?task=${MIA}`,
      "https://www.kanbo.co.uk/?task=nope", "https://www.kanbo.co.uk/p/personal", "not a url"]) expect(kanboLinkTarget(bad, app)).toBeNull();
  });
  it("within: the value when quick, a timeout flag when slow", async () => {
    expect(await within(Promise.resolve(3), 50)).toEqual({ done: true, value: 3 });
    expect(await within(new Promise((r) => setTimeout(() => r(1), 100)), 10)).toEqual({ done: false });
  });
});
