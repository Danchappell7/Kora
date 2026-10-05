// @vitest-environment node
// The delivery engine with fakes for the database, DNS and the network: what
// goes out (signed, the API's JSON shape, capped), where it may go (public
// addresses only, connected to directly), and what gets recorded.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILTIN_TAGS } from "../../../../src/data/data";
import type { WebhookEnvelope } from "./serialise.ts";
import type { Tx } from "./types.ts";
import {
  BUILTIN_TAG_LABELS, checkDestination, CREATOR_GONE_REASON, DeliveryError, describeResult, DISPATCH_SQL, dohResolver, fetchSender,
  fitPayload, isRuntimeUnsupported, parseDohAnswer, postPinned, readStatus, runDispatch, type ClaimedDelivery, type Conn, type NetApi,
  type SendTarget,
} from "./webhookDispatch.ts";
import { verifySignature, WEBHOOK_USER_AGENT } from "./webhooks.ts";

const W = "11111111-0000-4000-8000-000000000001";
const HOOK = "c924fcff-0938-4900-a8e7-9cbbb564a762";
const SECRET = "whsec_jdGsQXdTNkPSgmI33ZLnz23lIrUXcu9vDtOYAOWNaJQ";
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;

const TASK = {
  id: "e508af3b-ac25-42ac-a4f3-35192d10cadd", title: "Ship it", description: "", status: "done", priority: "high",
  user_id: "bbbbbbbb-0000-4000-8000-000000000002", workspace_id: W, project_id: "p-w", assignee_id: "", tags: ["design", "7f6e5d4c-0000-4000-8000-000000000001", "t-gone"],
  due_date: "2026-10-09", completed_at: "2026-10-05", created_at: "2026-10-05T18:04:38.31+00:00", updated_at: "2026-10-05T18:04:38.312+00:00",
  ai_reason: "secret ranking", followers: ["x"], archived_at: null, recurrence: "none", is_milestone: false,
};
const claimed = (o: Partial<ClaimedDelivery> = {}): ClaimedDelivery => ({
  delivery_id: "1aefcd04-d7e3-4f30-96e8-2a7008b6045c", attempt: 1, event: "task.updated", outbox_id: 4812, workspace_id: W,
  occurred_at: "2026-10-05T18:04:38.4+00:00", payload: { task: TASK, changes: ["status", "completed_at", "position"] },
  webhook_id: HOOK, url: "https://hooks.example.com/kanbo?team=w", secret: SECRET, ...o,
});
const envelope = (data: Record<string, unknown>): WebhookEnvelope => ({ id: "evt_1", type: "task.created", createdAt: "2026-10-05T18:00:00.000Z", workspaceId: W, data });

describe("payload size", () => {
  it("passes small events through untouched", () => {
    const env = envelope({ object: "task", id: "t", description: "short" });
    expect(fitPayload(env)).toEqual({ body: JSON.stringify(env), truncated: false });
  });
  it("trims the longest text until it fits, and says so", () => {
    const env = envelope({ object: "task", id: "t", title: "A title", description: "é".repeat(200_000) });
    const { body, truncated } = fitPayload(env, 64 * 1024);
    expect(truncated).toBe(true);
    expect(bytes(body)).toBeLessThanOrEqual(64 * 1024);
    const back = JSON.parse(body);
    expect(back.truncated).toBe(true);
    expect(back.data.title).toBe("A title");
    expect(back.data.description.endsWith("…")).toBe(true);
    expect(back.data.description.length).toBeGreaterThan(30_000); // most of what fits is kept
  });
  it("falls back to the bare resource when trimming text isn't enough", () => {
    const env = envelope({ object: "task", id: "t", url: "https://www.kanbo.co.uk/?task=t", tags: Array.from({ length: 5000 }, (_, i) => ({ id: `tag-${i}`, label: "x".repeat(40) })) });
    const { body, truncated } = fitPayload(env, 16 * 1024);
    expect(truncated).toBe(true);
    expect(JSON.parse(body)).toEqual({ id: "evt_1", type: "task.created", createdAt: env.createdAt, workspaceId: W, data: { object: "task", id: "t", url: "https://www.kanbo.co.uk/?task=t" }, truncated: true });
  });
});

describe("where a delivery may go", () => {
  const dns = (map: Record<string, string[] | Error>) => async (host: string) => {
    const v = map[host];
    if (v instanceof Error) throw v;
    return v ?? [];
  };
  it("public addresses only, IPv4 first, port and path kept", async () => {
    const d = await checkDestination("https://Hooks.Example.com:8443/k/b?x=1", dns({ "hooks.example.com": ["2606:4700::1", "93.184.216.34"] }));
    expect(d).toEqual({ ok: true, url: "https://Hooks.Example.com:8443/k/b?x=1", host: "hooks.example.com", port: 8443, path: "/k/b?x=1", addresses: ["93.184.216.34", "2606:4700::1"] });
  });
  it("refuses a host that resolves to anything private — even one address among public ones (DNS rebinding)", async () => {
    for (const addrs of [["127.0.0.1"], ["93.184.216.34", "10.0.0.7"], ["169.254.169.254"], ["::1"], ["93.184.216.34", "fd00::1"], ["::ffff:192.168.0.1"], ["0.0.0.0"]]) {
      const d = await checkDestination("https://evil.example.org/x", dns({ "evil.example.org": addrs }));
      expect(d.ok, addrs.join()).toBe(false);
      if (!d.ok) expect(d.error).toMatch(/private or reserved/);
    }
  });
  it("refuses bad shapes, our own hosts, unknown hosts and DNS failures (without echoing the URL's path)", async () => {
    const r = dns({ "a.example.org": new Error("SERVFAIL") });
    for (const [url, re] of [
      ["http://hooks.example.com/x", /public https/], ["https://127.0.0.1/x", /public https/], ["https://user:pw@hooks.example.com/", /public https/],
      ["https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1/tasks", /own servers/], ["https://x.htnchiljplrnjkwimgla.supabase.co/", /own servers/],
      ["https://nothing.example.org/secret-path", /no DNS address/], ["https://a.example.org/secret-path", /Couldn't look up a\.example\.org/],
    ] as const) {
      const d = await checkDestination(url, r, ["htnchiljplrnjkwimgla.supabase.co"]);
      expect(d.ok, url).toBe(false);
      if (!d.ok) { expect(d.error, url).toMatch(re); expect(d.error).not.toContain("secret-path"); }
    }
  });
  it("DNS over HTTPS: A + AAAA, NXDOMAIN = no addresses, a failing server falls through to the next", async () => {
    expect(parseDohAnswer({ Status: 0, Answer: [{ type: 5, data: "cname.example.net." }, { type: 1, data: "93.184.216.34" }] }, "A")).toEqual(["93.184.216.34"]);
    expect(parseDohAnswer({ Status: 3 }, "A")).toEqual([]);
    expect(parseDohAnswer({ Status: 2 }, "A")).toBeNull();
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      if (url.startsWith("https://one/")) return new Response("down", { status: 502 });
      const type = new URL(url).searchParams.get("type");
      return Response.json({ Status: 0, Answer: [{ type: type === "A" ? 1 : 28, data: type === "A" ? "93.184.216.34" : "2606:4700::1" }] });
    }) as unknown as typeof fetch;
    const resolve = dohResolver(fake, ["https://one/", "https://two/"]);
    expect((await resolve("hooks.example.com")).sort()).toEqual(["2606:4700::1", "93.184.216.34"]);
    expect(asked.some((u) => u.startsWith("https://two/?name=hooks.example.com&type=AAAA"))).toBe(true);
    const dead = dohResolver((async () => { throw new TypeError("network"); }) as unknown as typeof fetch, ["https://one/"]);
    await expect(dead("x.example.com")).rejects.toBeTruthy();
  });
});

/* ---- a fake TLS connection: records what's written, answers with canned bytes ---- */
function fakeNet(answer: string | string[] | null, opts: { failConnect?: Error; failTls?: Error; hang?: boolean } = {}) {
  const log = { connect: [] as { hostname: string; port: number }[], tls: [] as string[], written: "", closed: 0 };
  const chunks = answer === null ? [] : Array.isArray(answer) ? [...answer] : [answer];
  const conn: Conn = {
    async write(p) { const n = Math.min(p.length, 1000); log.written += new TextDecoder().decode(p.subarray(0, n)); return n; }, // partial writes
    async read(p) {
      if (opts.hang) return new Promise<number | null>(() => {});
      const next = chunks.shift();
      if (next === undefined) return null;
      const b = enc.encode(next);
      p.set(b);
      return b.length;
    },
    close() { log.closed++; },
  };
  const net: NetApi = {
    async connect(o) { log.connect.push(o); if (opts.failConnect) throw opts.failConnect; return conn; },
    async startTls(_c, o) { log.tls.push(o.hostname); if (opts.failTls) throw opts.failTls; return conn; },
  };
  return { net, log };
}
const TARGET: SendTarget = { url: "https://hooks.example.com/k?team=w", host: "hooks.example.com", port: 443, path: "/k?team=w", address: "93.184.216.34" };

describe("sending to the checked address", () => {
  it("connects to the IP, TLS for the hostname, writes a well-formed HTTP/1.1 POST, reads the status", async () => {
    const { net, log } = fakeNet("HTTP/1.1 204 No Content\r\nServer: x\r\n\r\n");
    const body = JSON.stringify({ hello: "wörld", long: "x".repeat(3000) });
    const r = await postPinned(net, TARGET, { "Content-Type": "application/json", "Kanbo-Event": "task.created" }, body, 1000);
    expect(r).toEqual({ status: 204, reason: "No Content" });
    expect(log.connect).toEqual([{ hostname: "93.184.216.34", port: 443 }]);
    expect(log.tls).toEqual(["hooks.example.com"]);
    const [head, sent] = log.written.split("\r\n\r\n");
    const lines = head.split("\r\n");
    expect(lines[0]).toBe("POST /k?team=w HTTP/1.1");
    expect(lines).toContain("Host: hooks.example.com");
    expect(lines).toContain(`Content-Length: ${bytes(body)}`);
    expect(lines).toContain("Connection: close");
    expect(lines).toContain("Kanbo-Event: task.created");
    expect(sent).toBe(body);
    expect(log.closed).toBeGreaterThan(0);
  });
  it("names a non-default port in Host; skips 100 Continue; reads a status split across reads", async () => {
    const { net, log } = fakeNet(["HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 50", "3 Service Unavailable\r\nRetry-After: 30\r\n\r\nbody"]);
    const r = await postPinned(net, { ...TARGET, port: 8443 }, {}, "{}", 1000);
    expect(r).toEqual({ status: 503, reason: "Service Unavailable" });
    expect(log.written).toContain("Host: hooks.example.com:8443\r\n");
  });
  it("header values can't smuggle new lines", async () => {
    const { net, log } = fakeNet("HTTP/1.1 200 OK\r\n\r\n");
    await postPinned(net, TARGET, { "Kanbo-Event": "task.created\r\nX-Evil: 1" }, "{}", 1000);
    expect(log.written).not.toContain("\r\nX-Evil");
  });
  it("timeouts, hang-ups, junk and TLS failures are DeliveryErrors with plain words", async () => {
    let e = await postPinned(fakeNet(null, { hang: true }).net, TARGET, {}, "{}", 30).catch((x) => x);
    expect(e).toBeInstanceOf(DeliveryError);
    expect([e.kind, e.message]).toEqual(["timeout", "No answer within 0 seconds."]);
    e = await postPinned(fakeNet(null).net, TARGET, {}, "{}", 1000).catch((x) => x);
    expect([e.kind, e.message]).toEqual(["closed", "The endpoint closed the connection without answering."]);
    e = await postPinned(fakeNet("SSH-2.0-OpenSSH\r\n\r\n").net, TARGET, {}, "{}", 1000).catch((x) => x);
    expect(e.kind).toBe("protocol");
    e = await postPinned(fakeNet(null, { failTls: new Error("invalid peer certificate: NotValidForName") }).net, TARGET, {}, "{}", 1000).catch((x) => x);
    expect([e.kind, e.message]).toEqual(["tls", "The TLS certificate isn't valid for hooks.example.com."]);
    e = await postPinned(fakeNet(null, { failConnect: Object.assign(new Error("Connection refused (os error 111)"), { name: "ConnectionRefused" }) }).net, TARGET, {}, "{}", 1000).catch((x) => x);
    expect([e.kind, e.message]).toEqual(["connect", "hooks.example.com refused the connection."]);
    // a runtime without raw TLS is reported as such (the function then uses fetch)
    e = await postPinned(fakeNet(null, { failTls: new TypeError("Deno.startTls is not a function") }).net, TARGET, {}, "{}", 1000).catch((x) => x);
    expect(isRuntimeUnsupported(e)).toBe(true);
  });
  it("an answer with no end of headers is cut off", async () => {
    const huge = "HTTP/1.1 200 OK\r\n" + "X: y\r\n".repeat(8000);
    const e = await readStatus({ read: async (p) => { const b = enc.encode(huge.slice(0, p.length)); p.set(b); return b.length; }, write: async () => 0, close() {} }).catch((x) => x);
    expect(e.kind).toBe("protocol");
  });
  it("what a result means", () => {
    expect(describeResult({ status: 200, reason: "OK" })).toEqual({ status: 200, error: null });
    expect(describeResult({ status: 301, reason: "Moved" })).toEqual({ status: 301, error: "Redirects aren't followed (HTTP 301). Use the final address." });
    expect(describeResult({ status: 500, reason: "Internal\u0000 Server Error" })).toEqual({ status: 500, error: "HTTP 500 Internal Server Error" });
  });
  it("the fetch fallback: no redirects followed, timeout, errors without the URL", async () => {
    let seen: RequestInit | undefined;
    const ok = fetchSender((async (_u: string, init: RequestInit) => { seen = init; return new Response(null, { status: 302, statusText: "Found" }); }) as unknown as typeof fetch);
    expect(await ok(TARGET, { a: "b" }, "{}", 1000)).toEqual({ status: 302, reason: "Found" });
    expect(seen?.redirect).toBe("manual");
    const slow = fetchSender(((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch);
    const e = await slow(TARGET, {}, "{}", 20).catch((x) => x);
    expect(e.kind).toBe("timeout");
    const bad = fetchSender((async () => { throw new TypeError(`error sending request for url (${TARGET.url})`); }) as unknown as typeof fetch);
    const e2 = await bad(TARGET, {}, "{}", 1000).catch((x) => x);
    expect(e2.message).not.toContain("/k?team=w");
  });
});

/* ---- the whole loop against a fake database ---- */
const ME = "bbbbbbbb-0000-4000-8000-000000000002";
type FakeTag = { id: string; label: string; color: string; ws: string | null; uid: string };
/**
 * pool: what's due, handed out in order, at most the claim's limit at a time
 * (or `claim` decides). hooks: each endpoint's workspace and creator (default:
 * workspace W, added by ME). customTags: who may see each tag, as the SQL does.
 */
function fakeService(pool: ClaimedDelivery[], opts: {
  creatorsOk?: Record<string, boolean>; hooks?: Record<string, { ws: string | null; uid: string }>; customTags?: FakeTag[];
  recordState?: string; claim?: (limit: number) => ClaimedDelivery[];
} = {}) {
  const due = [...pool];
  const log = { recorded: [] as unknown[][], switchedOff: [] as unknown[][], sql: [] as string[], claimLimits: [] as number[], tagQueries: [] as unknown[] };
  const service: Tx = {
    async query<R>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      log.sql.push(sql);
      if (sql === DISPATCH_SQL.claimOutbox) return [{ n: 0 }] as R[];
      if (sql === DISPATCH_SQL.claimDeliveries) {
        const limit = Number(params[0]);
        log.claimLimits.push(limit);
        return (opts.claim ? opts.claim(limit) : due.splice(0, limit)) as R[];
      }
      if (sql === DISPATCH_SQL.creators) {
        const ids = JSON.parse(params[0] as string) as string[];
        return ids.map((id) => {
          const h = opts.hooks?.[id] ?? { ws: W, uid: ME };
          return { id, created_by: h.uid, workspace_id: h.ws, allowed: opts.creatorsOk?.[id] ?? true };
        }) as R[];
      }
      if (sql === DISPATCH_SQL.tags) {
        const groups = JSON.parse(params[0] as string) as { key: string; ws: string | null; uid: string; ids: string[] }[];
        log.tagQueries.push(groups);
        return groups.flatMap((g) => (opts.customTags ?? [])
          .filter((t) => g.ids.includes(t.id) && (g.ws ? t.ws === g.ws : t.ws === null && t.uid === g.uid))
          .map((t) => ({ key: g.key, id: t.id, label: t.label, color: t.color }))) as R[];
      }
      if (sql === DISPATCH_SQL.switchOff) { log.switchedOff.push([...params]); return [] as R[]; }
      if (sql === DISPATCH_SQL.record) {
        log.recorded.push([...params]);
        const ok = Number(params[1]) >= 200 && Number(params[1]) < 300;
        return [{ r: { state: opts.recordState ?? (ok ? "delivered" : "pending"), disabled: false } }] as R[];
      }
      throw new Error(`unexpected SQL ${sql}`);
    },
  };
  return { service, log };
}
const did = (i: number) => `${String(i).padStart(8, "0")}-d7e3-4f30-96e8-2a7008b6045c`;
const LAUNCH = "7f6e5d4c-0000-4000-8000-000000000001";

describe("runDispatch", () => {
  const publicDns = async () => ["93.184.216.34", "2606:4700::1"];

  it("signs and sends the API's JSON, records the status and timing", async () => {
    const { service, log } = fakeService([claimed()], { customTags: [{ id: LAUNCH, label: "Launch", color: "oklch(0.7 0.1 30)", ws: W, uid: ME }] });
    const sent: { target: SendTarget; headers: Record<string, string>; body: string }[] = [];
    let clock = 1_760_000_000_000;
    const stats = await runDispatch({
      service, resolve: publicDns, appUrl: "https://www.kanbo.co.uk", now: () => (clock += 7),
      send: async (target, headers, body) => { sent.push({ target, headers, body }); return { status: 200, reason: "OK" }; },
    });
    expect(sent).toHaveLength(1);
    const { target, headers, body } = sent[0];
    expect(target).toMatchObject({ address: "93.184.216.34", host: "hooks.example.com", port: 443, path: "/kanbo?team=w" });
    expect(headers["Kanbo-Event"]).toBe("task.updated");
    expect(headers["Kanbo-Delivery"]).toBe("1aefcd04-d7e3-4f30-96e8-2a7008b6045c");
    expect(headers["User-Agent"]).toBe(WEBHOOK_USER_AGENT);
    expect(headers["Content-Type"]).toBe("application/json");
    // a receiver can verify it with any HMAC library
    const sig = headers["Kanbo-Signature"];
    const t = Number(/t=(\d+)/.exec(sig)![1]);
    expect(sig).toBe(`t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`);
    expect(await verifySignature(SECRET, sig, body, { nowSec: t + 10 })).toBe(true);
    const env = JSON.parse(body);
    expect(env).toMatchObject({ id: "evt_4812", type: "task.updated", workspaceId: W, changes: ["completedAt", "status"] });
    expect(env.data).toMatchObject({ object: "task", title: "Ship it", assigneeId: null, url: `https://www.kanbo.co.uk/?task=${TASK.id}` });
    expect(env.data.tags).toEqual([
      { id: "design", label: "Design", color: "oklch(0.74 0.16 305)" },
      { id: LAUNCH, label: "Launch", color: "oklch(0.7 0.1 30)" },
      { id: "t-gone", label: null, color: null },
    ]);
    expect(body).not.toContain("secret ranking");
    expect(body).not.toContain("followers");
    expect(body).not.toContain(SECRET);
    expect(log.recorded).toEqual([["1aefcd04-d7e3-4f30-96e8-2a7008b6045c", 200, null, 7]]);
    expect(stats).toMatchObject({ attempted: 1, delivered: 1, retrying: 0 });
  });

  it("tag labels come only from each endpoint's own scope: its workspace, or its creator's personal tags", async () => {
    const X = "22222222-0000-4000-8000-000000000002";
    const EVE = "dddddddd-0000-4000-8000-000000000004";
    const PERSONAL_HOOK = "e0e0e0e0-0938-4900-a8e7-9cbbb564a762";
    const tW = "aaaaaaaa-1111-4000-8000-000000000001", tX = "aaaaaaaa-2222-4000-8000-000000000002";
    const tMine = "aaaaaaaa-3333-4000-8000-000000000003", tAnaLegacy = "aaaaaaaa-4444-4000-8000-000000000004";
    const customTags: FakeTag[] = [
      { id: tW, label: "Team W", color: "c1", ws: W, uid: EVE },
      { id: tX, label: "Secret: Acme acquisition", color: "c2", ws: X, uid: EVE },
      { id: tMine, label: "Mine", color: "c3", ws: null, uid: ME },
      { id: tAnaLegacy, label: "Ana's own", color: "c4", ws: null, uid: "aaaaaaaa-0000-4000-8000-000000000001" },
    ];
    const allTags = ["design", tW, tX, tMine, tAnaLegacy];
    const teamRow = claimed({ delivery_id: did(1), payload: { task: { ...TASK, tags: allTags } } });
    const personalRow = claimed({ delivery_id: did(2), webhook_id: PERSONAL_HOOK, workspace_id: null, payload: { task: { ...TASK, workspace_id: null, tags: allTags } } });
    const { service, log } = fakeService([teamRow, personalRow], { customTags, hooks: { [PERSONAL_HOOK]: { ws: null, uid: ME } } });
    const bodies = new Map<string, string>();
    await runDispatch({ service, resolve: publicDns, send: async (_t, h, b) => { bodies.set(h["Kanbo-Delivery"], b); return { status: 200, reason: "" }; } });
    const labels = (id: string) => Object.fromEntries(JSON.parse(bodies.get(id)!).data.tags.map((t: { id: string; label: string | null }) => [t.id, t.label]));
    expect(labels(did(1))).toEqual({ design: "Design", [tW]: "Team W", [tX]: null, [tMine]: null, [tAnaLegacy]: null });
    expect(labels(did(2))).toEqual({ design: "Design", [tW]: null, [tX]: null, [tMine]: "Mine", [tAnaLegacy]: null });
    // the lookup names each scope (workspace + creator), and only real tag ids
    const asked = log.tagQueries.flat() as { ws: string | null; uid: string; ids: string[] }[];
    expect(asked.map((g) => [g.ws, g.uid]).sort()).toEqual([[W, ME], [null, ME]].sort());
    expect(asked.every((g) => !g.ids.includes("design"))).toBe(true);
  });

  it("an endpoint whose creator lost access is switched off and sent nothing", async () => {
    const other = "dddddddd-0000-4000-8000-000000000004";
    const { service, log } = fakeService([claimed(), claimed({ delivery_id: "2aefcd04-d7e3-4f30-96e8-2a7008b6045c", webhook_id: other })], { creatorsOk: { [other]: false } });
    const sentTo: string[] = [];
    const stats = await runDispatch({ service, resolve: publicDns, send: async (_t, h) => { sentTo.push(h["Kanbo-Delivery"]); return { status: 202, reason: "" }; } });
    expect(sentTo).toEqual(["1aefcd04-d7e3-4f30-96e8-2a7008b6045c"]);
    expect(log.switchedOff).toHaveLength(1);
    expect(log.switchedOff[0][0]).toBe(other);
    expect(log.switchedOff[0][1]).toBe(CREATOR_GONE_REASON);
    expect(stats).toMatchObject({ skipped: 1, disabled: 1, delivered: 1 });
  });

  it("if the access check itself fails, nothing in the batch is sent (fail closed)", async () => {
    const { service } = fakeService([claimed()]);
    const broken: Tx = { query: async (sql, params) => { if (sql === DISPATCH_SQL.creators) throw new Error("db down"); return service.query(sql, params); } };
    let sends = 0;
    await runDispatch({ service: broken, resolve: publicDns, send: async () => { sends++; return { status: 200, reason: "" }; } });
    expect(sends).toBe(0);
  });

  it("a claim that fails is logged and ends the run (nothing thrown)", async () => {
    const lines: string[] = [];
    const broken: Tx = { query: async (sql) => { if (sql === DISPATCH_SQL.claimDeliveries) throw new Error("connection reset"); return [{ n: 0 }] as never[]; } };
    const stats = await runDispatch({ service: broken, resolve: publicDns, log: (l) => lines.push(l), send: async () => ({ status: 200, reason: "" }) });
    expect(stats.attempted).toBe(0);
    expect(lines.some((l) => /claim failed: connection reset/.test(l))).toBe(true);
  });

  it("a private address is never called: recorded as a failure (status 0) with a reason", async () => {
    const { service, log } = fakeService([claimed()]);
    let sends = 0;
    await runDispatch({ service, resolve: async () => ["93.184.216.34", "10.1.2.3"], send: async () => { sends++; return { status: 200, reason: "" }; } });
    expect(sends).toBe(0);
    expect(log.recorded[0][1]).toBe(0);
    expect(String(log.recorded[0][2])).toMatch(/private or reserved address/);
    expect(log.recorded[0][3]).toBeNull();
  });

  it("tries the second address only when the first refused the connection; 3xx and timeouts aren't sent twice", async () => {
    let { service, log } = fakeService([claimed()]);
    const tried: string[] = [];
    await runDispatch({
      service, resolve: publicDns,
      send: async (t) => { tried.push(t.address); if (tried.length === 1) throw new DeliveryError("refused", "connect"); return { status: 200, reason: "" }; },
    });
    expect(tried).toEqual(["93.184.216.34", "2606:4700::1"]);
    expect(log.recorded[0][1]).toBe(200);

    ({ service, log } = fakeService([claimed()]));
    tried.length = 0;
    await runDispatch({ service, resolve: publicDns, send: async (t) => { tried.push(t.address); throw new DeliveryError("No answer within 10 seconds.", "timeout"); } });
    expect(tried).toHaveLength(1);
    expect(log.recorded[0].slice(0, 3)).toEqual(["1aefcd04-d7e3-4f30-96e8-2a7008b6045c", 0, "No answer within 10 seconds."]);

    ({ service, log } = fakeService([claimed()]));
    await runDispatch({ service, resolve: publicDns, send: async () => ({ status: 308, reason: "Permanent Redirect" }) });
    expect(log.recorded[0].slice(1, 3)).toEqual([308, "Redirects aren't followed (HTTP 308). Use the final address."]);
  });

  it("a ping carries the endpoint's own details; an unknown event is recorded, not thrown", async () => {
    const ping = claimed({ event: "ping", payload: { webhook: { id: HOOK, url: "https://hooks.example.com/kanbo?team=w", events: ["task.created"] } } });
    const odd = claimed({ delivery_id: "3aefcd04-d7e3-4f30-96e8-2a7008b6045c", event: "user.deleted" });
    const { service, log } = fakeService([ping, odd]);
    const bodies: string[] = [];
    await runDispatch({ service, resolve: publicDns, send: async (_t, _h, b) => { bodies.push(b); return { status: 200, reason: "" }; } });
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ type: "ping", data: { webhookId: HOOK, events: ["task.created"] } });
    expect(log.recorded.find((r) => r[0] === odd.delivery_id)?.slice(1, 3)).toEqual([0, "Kanbo couldn't build this event."]);
  });

  it("claims only as many as there are free senders, sends at most `concurrency` at once, and drains what's due", async () => {
    const { service, log } = fakeService(Array.from({ length: 10 }, (_, i) => claimed({ delivery_id: did(i) })));
    let inFlight = 0, peak = 0;
    const stats = await runDispatch({
      service, resolve: publicDns,
      send: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { status: 200, reason: "" }; },
    }, { batch: 4, concurrency: 2 });
    expect(stats.attempted).toBe(10);
    expect(log.recorded).toHaveLength(10);
    expect(peak).toBe(2);
    expect(Math.max(...log.claimLimits)).toBeLessThanOrEqual(2); // never more than the free senders (and never more than batch)
    expect(log.claimLimits.at(-1)).toBeGreaterThan(0);
  });

  it("a slow endpoint holds up only its own sender: the others keep claiming and sending", async () => {
    const SLOW = "5105105a-0000-4000-8000-000000000000";
    const slow = claimed({ delivery_id: did(0), webhook_id: SLOW, url: "https://slow.example.com/x" });
    const fast = Array.from({ length: 12 }, (_, i) => claimed({ delivery_id: did(i + 1) }));
    // the slow one is claimed alone; the rest only become due afterwards (a batch that waited for it would never see them)
    let first = true;
    const { service } = fakeService([], { claim: (limit) => (first ? (first = false, [slow]) : fast.splice(0, limit)) });
    const order: string[] = [];
    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((r) => { releaseSlow = r; });
    const stats = await runDispatch({
      service, resolve: publicDns,
      send: async (t, h) => {
        if (t.host === "slow.example.com") { await slowDone; order.push("slow"); return { status: 200, reason: "" }; }
        order.push(h["Kanbo-Delivery"]);
        if (order.length === 12) releaseSlow(); // every fast one went out while the slow one was still waiting
        return { status: 200, reason: "" };
      },
    }, { concurrency: 2 });
    expect(stats.attempted).toBe(13);
    expect(order.at(-1)).toBe("slow");
  });

  it("an empty claim while its own deliveries are in flight waits for one to finish, then looks again", async () => {
    // the database's fair share: one at a time for this endpoint (the second only once the first is recorded)
    const items = [claimed({ delivery_id: did(1) }), claimed({ delivery_id: did(2) })];
    let busy = false;
    const { service, log } = fakeService([], {
      claim: (limit) => (busy || !items.length ? [] : (busy = true, items.splice(0, Math.min(1, limit)))),
    });
    const recorded = service.query.bind(service);
    const tx: Tx = { query: async (sql, params) => { const r = await recorded(sql, params); if (sql === DISPATCH_SQL.record) busy = false; return r as never[]; } };
    const stats = await runDispatch({ service: tx, resolve: publicDns, send: async () => { await new Promise((r) => setTimeout(r, 5)); return { status: 200, reason: "" }; } }, { concurrency: 3 });
    expect(stats.attempted).toBe(2);
    expect(log.recorded.map((r) => r[0])).toEqual([did(1), did(2)]);
  });

  it("stops claiming at the deadline (what's in flight still finishes)", async () => {
    let clock = 0;
    const { service, log } = fakeService(Array.from({ length: 8 }, (_, i) => claimed({ delivery_id: did(i) })));
    const s2 = await runDispatch({ service, resolve: publicDns, now: () => (clock += 30_000), send: async () => ({ status: 200, reason: "" }) }, { batch: 4, deadlineMs: 40_000 });
    expect(s2.rounds).toBe(1);
    expect(log.recorded.length).toBe(s2.attempted);
  });

  it("the built-in tag labels match the app's", () => {
    expect(Object.fromEntries(Object.entries(BUILTIN_TAGS).map(([k, v]) => [k, { label: v.label, color: v.color }]))).toEqual(BUILTIN_TAG_LABELS);
  });
});
