// @vitest-environment node
// Unit tests for the Edge Functions' throttle + AI metering helpers, run
// against a tiny in-memory stand-in for the supabase-js query builder.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp, countAiCall, dayIn, hashKey, hit, KEY_PREFIX, recentlyHit, release, sweep } from "./limits.ts";

type Row = Record<string, unknown>;

class FakeDb {
  tables = new Map<string, Row[]>();
  missing = new Set<string>();
  /** called just before each query runs — lets a test simulate a concurrent writer */
  beforeExec?: (table: string, op: string) => void;
  rows(t: string) {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }
  from(t: string) { return new Query(this, t); }
}

class Query implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private op: "select" | "upsert" | "update" | "delete" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private payload: Row = {};
  private conflict: string[] = [];
  private single = false;
  constructor(private db: FakeDb, private table: string) {}
  select() { return this; }
  upsert(row: Row, opts: { onConflict: string }) { this.op = "upsert"; this.payload = row; this.conflict = opts.onConflict.split(","); return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  lt(c: string, v: string) { this.filters.push((r) => String(r[c]) < v); return this; }
  like(c: string, p: string) {
    const re = new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$");
    this.filters.push((r) => re.test(String(r[c])));
    return this;
  }
  limit() { return this; }
  maybeSingle() { this.single = true; return this; }
  then<A, B>(ok?: ((v: { data: unknown; error: unknown }) => A) | null, bad?: ((e: unknown) => B) | null) {
    return Promise.resolve().then(() => this.exec()).then(ok, bad);
  }
  private exec(): { data: unknown; error: unknown } {
    if (this.db.missing.has(this.table)) {
      return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}' in the schema cache` } };
    }
    this.db.beforeExec?.(this.table, this.op);
    const rows = this.db.rows(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));
    if (this.op === "upsert") {
      const clash = rows.find((r) => this.conflict.every((c) => r[c] === this.payload[c]));
      if (clash) return { data: [], error: null };
      const copy = { ...this.payload };
      rows.push(copy);
      return { data: [copy], error: null };
    }
    if (this.op === "update") {
      const hits = rows.filter(match);
      for (const r of hits) Object.assign(r, this.payload);
      return { data: hits.map((r) => ({ ...r })), error: null };
    }
    if (this.op === "delete") {
      const keep = rows.filter((r) => !match(r));
      this.db.tables.set(this.table, keep);
      return { data: null, error: null };
    }
    const found = rows.filter(match).map((r) => ({ ...r }));
    return { data: this.single ? found[0] ?? null : found, error: null };
  }
}

const T0 = Date.parse("2026-10-05T09:00:00.000Z");

afterEach(() => { vi.restoreAllMocks(); });

describe("hit (fixed-window throttle)", () => {
  it("allows the first hit and blocks a second one inside the window", async () => {
    const db = new FakeDb();
    expect(await hit(db, "kanbo:t:a", { windowSec: 60, now: T0 })).toEqual({ allowed: true, retryAfter: 0 });
    const second = await hit(db, "kanbo:t:a", { windowSec: 60, now: T0 + 5_000 });
    expect(second.allowed).toBe(false);
    expect(second.retryAfter).toBe(55);
  });

  it("opens again once the window has passed, and restarts the count", async () => {
    const db = new FakeDb();
    await hit(db, "k", { windowSec: 60, now: T0 });
    expect((await hit(db, "k", { windowSec: 60, now: T0 + 61_000 })).allowed).toBe(true);
    expect(db.rows("rate_limits")[0].count).toBe(1);
    expect((await hit(db, "k", { windowSec: 60, now: T0 + 62_000 })).allowed).toBe(false);
  });

  it("counts up to max within one window", async () => {
    const db = new FakeDb();
    const w = { windowSec: 600, max: 3 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await hit(db, "ip", { ...w, now: T0 + i * 1000 })).allowed);
    expect(results).toEqual([true, true, true, false]);
  });

  it("keeps keys independent", async () => {
    const db = new FakeDb();
    await hit(db, "a", { windowSec: 60, now: T0 });
    expect((await hit(db, "b", { windowSec: 60, now: T0 })).allowed).toBe(true);
  });

  it("fails OPEN (and warns) when the rate_limits table doesn't exist yet", async () => {
    const db = new FakeDb();
    db.missing.add("rate_limits");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r1 = await hit(db, "x", { windowSec: 60, now: T0 });
    const r2 = await hit(db, "x", { windowSec: 60, now: T0 });
    expect(r1).toEqual({ allowed: true, retryAfter: 0, degraded: true });
    expect(r2.allowed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("run migration 0042"));
  });

  it("fails open when the client throws", async () => {
    const db = { from() { throw new Error("network down"); } };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await hit(db, "x", { windowSec: 60 })).allowed).toBe(true);
  });

  it("release() lets the next attempt through straight away", async () => {
    const db = new FakeDb();
    await hit(db, "k", { windowSec: 60, now: T0 });
    await release(db, "k");
    expect((await hit(db, "k", { windowSec: 60, now: T0 + 1000 })).allowed).toBe(true);
  });

  it("can't be double-spent by a simultaneous request (compare-and-swap)", async () => {
    const db = new FakeDb();
    // an earlier, expired window exists …
    db.rows("rate_limits").push({ key: "k", last_at: new Date(T0 - 120_000).toISOString(), count: 1 });
    // … and another request renews it between our read and our write
    let raced = false;
    db.beforeExec = (table, op) => {
      if (table === "rate_limits" && op === "update" && !raced) {
        raced = true;
        Object.assign(db.rows("rate_limits")[0], { last_at: new Date(T0).toISOString(), count: 1 });
      }
    };
    const r = await hit(db, "k", { windowSec: 60, now: T0 + 100 });
    expect(r.allowed).toBe(false); // the other request won this window
    expect(db.rows("rate_limits")[0].count).toBe(1);
  });

  it("never refuses a burst of simultaneous calls that's under the limit", async () => {
    // e.g. 60 assignment emails fired at once after a bulk reassign (notify: 150 / 10 min)
    const db = new FakeDb();
    const res = await Promise.all(Array.from({ length: 60 }, () => hit(db, "kanbo:notify:u", { windowSec: 600, max: 150, now: T0 })));
    expect(res.filter((r) => !r.allowed)).toHaveLength(0);
    const count = Number(db.rows("rate_limits")[0].count);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(60);
  });

  it("still lets exactly `max` through when a burst goes over it", async () => {
    const db = new FakeDb();
    const res = await Promise.all(Array.from({ length: 40 }, () => hit(db, "kanbo:t:burst", { windowSec: 600, max: 5, now: T0 })));
    expect(res.filter((r) => r.allowed)).toHaveLength(5);
    expect(db.rows("rate_limits")[0].count).toBe(5);
  });

  it("recentlyHit reports a live window without recording anything", async () => {
    const db = new FakeDb();
    expect(await recentlyHit(db, "flag", 600, T0)).toBe(false);
    expect(db.rows("rate_limits")).toHaveLength(0);
    await hit(db, "flag", { windowSec: 600, now: T0 });
    expect(await recentlyHit(db, "flag", 600, T0 + 599_000)).toBe(true);
    expect(await recentlyHit(db, "flag", 600, T0 + 601_000)).toBe(false);
    db.missing.add("rate_limits");
    expect(await recentlyHit(db, "flag", 600, T0)).toBe(false);
  });
});

describe("sweep", () => {
  it("removes only our own keys that are over a week old", async () => {
    const db = new FakeDb();
    const old = new Date(T0 - 8 * 86400_000).toISOString();
    const fresh = new Date(T0 - 3600_000).toISOString();
    db.rows("rate_limits").push(
      { key: `${KEY_PREFIX}old`, last_at: old, count: 1 },
      { key: `${KEY_PREFIX}fresh`, last_at: fresh, count: 1 },
      { key: "someone-else:old", last_at: old, count: 1 },
    );
    await sweep(db, T0, 1);
    expect(db.rows("rate_limits").map((r) => r.key).sort()).toEqual([`${KEY_PREFIX}fresh`, "someone-else:old"]);
  });
});

describe("countAiCall (daily AI limit)", () => {
  const U = "0b7d1c9e-1111-4a4a-8888-123456789abc";

  it("counts calls and refuses once the daily limit is reached", async () => {
    const db = new FakeDb();
    expect(await countAiCall(db, U, "2026-10-05", 2)).toMatchObject({ allowed: true, used: 1 });
    expect(await countAiCall(db, U, "2026-10-05", 2)).toMatchObject({ allowed: true, used: 2 });
    expect(await countAiCall(db, U, "2026-10-05", 2)).toMatchObject({ allowed: false, used: 2, limit: 2 });
    expect(db.rows("ai_usage")).toEqual([{ user_id: U, day: "2026-10-05", calls: 2 }]);
  });

  it("starts fresh the next day", async () => {
    const db = new FakeDb();
    await countAiCall(db, U, "2026-10-05", 1);
    expect((await countAiCall(db, U, "2026-10-05", 1)).allowed).toBe(false);
    expect((await countAiCall(db, U, "2026-10-06", 1)).allowed).toBe(true);
  });

  it("fails open when ai_usage doesn't exist yet", async () => {
    const db = new FakeDb();
    db.missing.add("ai_usage");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await countAiCall(db, U, "2026-10-05", 1)).toMatchObject({ allowed: true, degraded: true });
  });

  it("doesn't lose a count to a simultaneous call", async () => {
    const db = new FakeDb();
    db.rows("ai_usage").push({ user_id: U, day: "2026-10-05", calls: 4 });
    let raced = false;
    db.beforeExec = (table, op) => {
      if (table === "ai_usage" && op === "update" && !raced) { raced = true; db.rows("ai_usage")[0].calls = 5; }
    };
    expect(await countAiCall(db, U, "2026-10-05", 10)).toMatchObject({ allowed: true, used: 6 });
    expect(db.rows("ai_usage")[0].calls).toBe(6);
  });

  it("doesn't refuse simultaneous calls under the limit, and holds the limit when over it", async () => {
    const db = new FakeDb();
    const under = await Promise.all(Array.from({ length: 30 }, () => countAiCall(db, U, "2026-10-05", 200)));
    expect(under.every((r) => r.allowed)).toBe(true);
    const db2 = new FakeDb();
    const over = await Promise.all(Array.from({ length: 30 }, () => countAiCall(db2, U, "2026-10-05", 3)));
    expect(over.filter((r) => r.allowed)).toHaveLength(3);
    expect(db2.rows("ai_usage")[0].calls).toBe(3);
  });
});

describe("helpers", () => {
  it("dayIn uses the UK calendar day, not UTC", () => {
    expect(dayIn("Europe/London", new Date("2026-09-30T23:30:00Z"))).toBe("2026-10-01"); // BST
    expect(dayIn("Europe/London", new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31"); // GMT
  });

  it("hashKey is stable, case-insensitive and never contains the address", async () => {
    const a = await hashKey("Jo.Bloggs@Company.co.uk");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await hashKey(" jo.bloggs@company.co.uk ")).toBe(a);
    expect(await hashKey("someone@company.co.uk")).not.toBe(a);
  });

  it("clientIp can't be steered by a caller-supplied X-Forwarded-For", () => {
    // Cloudflare's header wins over whatever the caller put in X-Forwarded-For
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7", "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    // otherwise the hop our own edge appended (the last), never the first
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(new Headers({ "x-forwarded-for": "<script>" }))).toBe("");
    expect(clientIp(new Headers())).toBe("");
  });
});
