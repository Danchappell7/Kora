// @vitest-environment node
/* Is the daily Slack stand-up really going out? The marks slack-standup
   leaves in rate_limits, and what slack-post's "status" action reads back. */
import { describe, it, expect } from "vitest";
import {
  cleanFailureDetail, clearStandupFailure, loadAutopostHealth, markStandupHeartbeat, readAutopostHealth,
  recordStandupFailure, STANDUP_HEARTBEAT_FRESH_SEC, STANDUP_HEARTBEAT_KEY, standupFailurePrefix, webhookTag,
} from "./slackHealth";

const WS = "11111111-1111-4111-8111-111111111111";
const HOOK = "https://hooks.slack.com/services/T0001/B0002/abcdefghijklmnopqrstuvwx";
const NOW = Date.parse("2026-10-05T08:05:00Z");   // Mon 5 Oct, 09:05 in London

/* a tiny in-memory rate_limits, with the query shapes the helpers use */
type Row = { key: string; last_at: string; count: number };
function fakeDb(rows: Row[] = [], opts: { broken?: boolean } = {}) {
  const store = new Map(rows.map((r) => [r.key, { ...r }]));
  const db = {
    store,
    from(table: string) {
      expect(table).toBe("rate_limits");
      let op: "select" | "upsert" | "delete" = "select";
      let payload: Row | null = null;
      let ignore = false;
      const filters: Array<(r: Row) => boolean> = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.upsert = (row: Row, o: { ignoreDuplicates?: boolean } = {}) => { op = "upsert"; payload = row; ignore = !!o.ignoreDuplicates; return q; };
      q.delete = () => { op = "delete"; return q; };
      q.eq = (c: keyof Row, v: unknown) => { filters.push((r) => r[c] === v); return q; };
      q.like = (c: keyof Row, p: string) => {
        const re = new RegExp(`^${p.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
        filters.push((r) => re.test(String(r[c])));
        return q;
      };
      const run = () => {
        if (opts.broken) return { data: null, error: { code: "42P01", message: 'relation "rate_limits" does not exist' } };
        const hits = [...store.values()].filter((r) => filters.every((f) => f(r)));
        if (op === "delete") { hits.forEach((r) => store.delete(r.key)); return { data: null, error: null }; }
        if (op === "upsert" && payload) {
          if (ignore && store.has(payload.key)) return { data: [], error: null };
          store.set(payload.key, { ...payload });
          return { data: [{ ...payload }], error: null };
        }
        return { data: hits.map((r) => ({ ...r })), error: null };
      };
      q.maybeSingle = async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; };
      q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, bad);
      return q;
    },
  };
  return db;
}

describe("webhookTag", () => {
  it("is 12 hex characters, the same for the same link, different for another, and not the link", async () => {
    const a = await webhookTag(HOOK);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(await webhookTag(` ${HOOK} `)).toBe(a);
    expect(await webhookTag(HOOK.replace("B0002", "B0003"))).not.toBe(a);
    expect(HOOK).not.toContain(a);
  });
});

describe("cleanFailureDetail", () => {
  it("keeps Slack's words and http_NNN; anything else is 'unknown'", () => {
    expect(cleanFailureDetail("channel_is_archived")).toBe("channel_is_archived");
    expect(cleanFailureDetail("http_404")).toBe("http_404");
    expect(cleanFailureDetail("NO_SERVICE")).toBe("no_service");
    expect(cleanFailureDetail("a:b")).toBe("unknown");
    expect(cleanFailureDetail(HOOK)).toBe("unknown");
    expect(cleanFailureDetail(null)).toBe("unknown");
  });
});

describe("the marks slack-standup leaves", () => {
  it("the heartbeat is one row, moved on each run", async () => {
    const db = fakeDb();
    await markStandupHeartbeat(db, NOW - 900_000);
    await markStandupHeartbeat(db, NOW);
    expect([...db.store.keys()]).toEqual([STANDUP_HEARTBEAT_KEY]);
    expect(db.store.get(STANDUP_HEARTBEAT_KEY)?.last_at).toBe(new Date(NOW).toISOString());
  });

  it("a failure keeps only the latest reason, against the link's tag, never the link", async () => {
    const db = fakeDb([{ key: "kanbo:slack-standup:fail:22222222-2222-4222-8222-222222222222:aaaaaaaaaaaa:no_service", last_at: new Date(NOW).toISOString(), count: 1 }]);
    await recordStandupFailure(db, WS, HOOK, "slack_unavailable", NOW - 60_000);
    await recordStandupFailure(db, WS, HOOK, "channel_is_archived", NOW);
    const tag = await webhookTag(HOOK);
    const mine = [...db.store.keys()].filter((k) => k.startsWith(standupFailurePrefix(WS)));
    expect(mine).toEqual([`${standupFailurePrefix(WS)}${tag}:channel_is_archived`]);
    expect(db.store.size).toBe(2);                     // another workspace's failure is left alone
    expect(JSON.stringify([...db.store.values()])).not.toContain("abcdefghijklmnopqrstuvwx");

    await clearStandupFailure(db, WS);
    expect([...db.store.keys()].some((k) => k.startsWith(standupFailurePrefix(WS)))).toBe(false);
    expect(db.store.size).toBe(1);
  });

  it("never throws, whatever the database does", async () => {
    const db = { from: () => { throw new Error("down"); } };
    await expect(markStandupHeartbeat(db)).resolves.toBeUndefined();
    await expect(recordStandupFailure(db, WS, HOOK, "no_service")).resolves.toBeUndefined();
    await expect(clearStandupFailure(db, WS)).resolves.toBeUndefined();
    await expect(loadAutopostHealth(db, WS, HOOK)).resolves.toEqual({ autopostReady: null, lastAutopostError: null });
  });

  it("ignores a workspace id that isn't a uuid (no wildcard deletes)", async () => {
    const db = fakeDb([{ key: `${standupFailurePrefix(WS)}aaaaaaaaaaaa:no_service`, last_at: new Date(NOW).toISOString(), count: 1 }]);
    await clearStandupFailure(db, "%");
    await recordStandupFailure(db, "%", HOOK, "no_service");
    expect(db.store.size).toBe(1);
  });
});

describe("readAutopostHealth", () => {
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it("ready while the heartbeat is under an hour old; not after; unknown when unreadable", () => {
    const base = { failures: [], workspaceId: WS, tag: null, now: NOW };
    expect(readAutopostHealth({ ...base, heartbeat: { last_at: at(16 * 60_000) } }).autopostReady).toBe(true);
    expect(readAutopostHealth({ ...base, heartbeat: { last_at: at(STANDUP_HEARTBEAT_FRESH_SEC * 1000 + 1) } }).autopostReady).toBe(false);
    expect(readAutopostHealth({ ...base, heartbeat: null }).autopostReady).toBe(false);          // never ran
    expect(readAutopostHealth({ ...base, heartbeat: undefined }).autopostReady).toBeNull();     // couldn't read
  });

  it("reports the latest failure with the current link only, with its London day", async () => {
    const tag = await webhookTag(HOOK);
    const p = standupFailurePrefix(WS);
    const h = readAutopostHealth({
      heartbeat: { last_at: at(0) }, workspaceId: WS, tag, now: NOW,
      failures: [
        { key: `${p}${tag}:slack_unavailable`, last_at: "2026-10-01T08:00:00Z" },
        { key: `${p}${tag}:channel_is_archived`, last_at: "2026-10-04T23:30:00Z" },   // Mon 5 Oct, 00:30 BST
        { key: `${p}bbbbbbbbbbbb:no_service`, last_at: "2026-10-05T08:00:00Z" },     // the old link's
        { key: `${p}${tag}:Bad Word`, last_at: "2026-10-05T08:00:00Z" },
        { key: STANDUP_HEARTBEAT_KEY, last_at: at(0) },
      ],
    });
    expect(h).toEqual({ autopostReady: true, lastAutopostError: { detail: "channel_is_archived", at: "2026-10-04T23:30:00.000Z", day: "2026-10-05" } });
    expect(readAutopostHealth({ heartbeat: null, workspaceId: WS, tag: null, now: NOW, failures: [{ key: `${p}${tag}:no_service`, last_at: at(0) }] }).lastAutopostError).toBeNull();
  });
});

describe("loadAutopostHealth", () => {
  it("reads the heartbeat and this link's failure", async () => {
    const tag = await webhookTag(HOOK);
    const db = fakeDb([
      { key: STANDUP_HEARTBEAT_KEY, last_at: new Date(NOW - 5 * 60_000).toISOString(), count: 0 },
      { key: `${standupFailurePrefix(WS)}${tag}:no_service`, last_at: new Date(NOW - 60_000).toISOString(), count: 1 },
    ]);
    expect(await loadAutopostHealth(db, WS, HOOK, { now: NOW })).toMatchObject({ autopostReady: true, lastAutopostError: { detail: "no_service", day: "2026-10-05" } });
    expect(await loadAutopostHealth(db, WS, null, { now: NOW })).toEqual({ autopostReady: true, lastAutopostError: null });
    expect(await loadAutopostHealth(fakeDb([]), WS, HOOK, { now: NOW })).toEqual({ autopostReady: false, lastAutopostError: null });
  });

  it("without rate_limits (0042 not run): unknown, not 'not running'", async () => {
    expect(await loadAutopostHealth(fakeDb([], { broken: true }), WS, HOOK, { now: NOW })).toEqual({ autopostReady: null, lastAutopostError: null });
  });
});
