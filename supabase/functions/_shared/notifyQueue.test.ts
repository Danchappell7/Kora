// Coalescing push and email: the 2-minute window per task per recipient,
// quiet hours, snoozes, the digest, replays, failures and the drain — on an
// in-memory notify_queue that behaves like 0048's (unique event key, claim
// with a lease, finish with backoff). The clock is a variable: nothing reads
// the real date.
import { describe, expect, it, vi } from "vitest";
import {
  CLAIM_LEASE_SEC, composeGroup, deliverNotice, drainQueue, EMAIL_GAP_MS, LookupFailed, readRecipient, readSnoozedUntil, replanHeld,
  rescheduleHeld, supabaseDrainDeps, supabaseQueueStore, type DrainDeps, type Notice, type QueueRow, type QueueStore, type SendOutcome,
} from "./notifyQueue";
import { resolveNotifyPrefs, type NotifyChannel } from "./notifyTiming";
import type { Composed } from "./notifyCompose";

const T0 = Date.parse("2026-10-09T09:00:00Z");   // Fri 10:00 BST
const sec = (s: number) => new Date(T0 + s * 1000);

/** notify_queue in memory, with the database's rules */
function memoryQueue(clock: { now: Date }) {
  const rows: QueueRow[] = [];
  let seq = 0;
  let missing = false;
  const store: QueueStore & { rows: QueueRow[]; setMissing(v: boolean): void } = {
    rows,
    setMissing(v) { missing = v; },
    async bundleState(userId, channel, bundleKey, now) {
      let last: number | null = null, pending: number | null = null, pendingLast: number | null = null;
      for (const r of rows) {
        if (r.user_id !== userId || r.channel !== channel || r.bundle_key !== bundleKey) continue;
        if (Date.parse(r.created_at) < now.getTime() - 36 * 3600_000) continue;
        if (r.sent_at) { if (!String(r.last_error ?? "").startsWith("dropped")) last = Math.max(last ?? 0, Date.parse(r.sent_at)); }
        else if (r.attempts < 5) {
          pending = Math.min(pending ?? Infinity, Date.parse(r.deliver_after));
          pendingLast = Math.max(pendingLast ?? -Infinity, Date.parse(r.deliver_after));
        }
      }
      const at = (t: number | null) => (t === null ? null : new Date(t));
      return { last: at(last), pending: at(pending), pendingLast: at(pendingLast) };
    },
    async bringForward(userId, channel, bundleKey, until) {
      let n = 0;
      for (const r of rows) {
        if (r.user_id !== userId || r.channel !== channel || r.bundle_key !== bundleKey) continue;
        if (r.sent_at || r.claimed_at || r.last_error || Date.parse(r.deliver_after) <= until.getTime()) continue;
        r.deliver_after = until.toISOString(); n++;
      }
      return n;
    },
    async release(rs) {
      for (const x of rs) { const r = rows.find((y) => y.id === x.id)!; if (!r.sent_at) { r.claimed_at = null; r.attempts = Math.max(0, x.attempts - 1); } }
    },
    async enqueue(n, deliverAfter, opts = {}) {
      if (missing) return { status: "unavailable" };
      if (rows.some((r) => r.user_id === n.userId && r.channel === n.channel && r.event_key === n.eventKey)) return { status: "duplicate" };
      const now = (opts.now ?? clock.now).toISOString();
      const row: QueueRow = {
        id: ++seq, user_id: n.userId, channel: n.channel, kind: n.kind, event_key: n.eventKey, bundle_key: n.bundleKey, task_id: n.taskId,
        actor_id: n.actorId, actor_name: n.actorName, title: n.title, payload: n.payload, deliver_after: deliverAfter.toISOString(),
        created_at: now, claimed_at: opts.claimed ? now : null, attempts: opts.claimed ? 1 : 0, sent_at: null, last_error: null,
      };
      rows.push(row);
      return { status: "queued", id: row.id };
    },
    async finish(ids, error = null) {
      for (const r of rows) {
        if (!ids.includes(r.id) || r.sent_at) continue;
        if (!error) { r.sent_at = clock.now.toISOString(); r.last_error = null; }
        else { r.claimed_at = null; r.last_error = error; r.deliver_after = new Date(clock.now.getTime() + 120_000 * Math.max(1, r.attempts)).toISOString(); }
      }
    },
    async rehold(rs, until) {
      for (const x of rs) { const r = rows.find((y) => y.id === x.id)!; r.deliver_after = until.toISOString(); r.claimed_at = null; r.attempts = Math.max(0, x.attempts - 1); r.last_error = null; }
    },
    async drop(ids, reason, now) {
      for (const r of rows) if (ids.includes(r.id)) { r.sent_at = now.toISOString(); r.last_error = `dropped: ${reason}`; r.claimed_at = null; }
    },
    async claim(limit) {
      const now = clock.now.getTime();
      const due = rows.filter((r) => !r.sent_at && Date.parse(r.deliver_after) <= now && r.attempts < 5
        && (!r.claimed_at || Date.parse(r.claimed_at) < now - CLAIM_LEASE_SEC * 1000))
        .sort((a, b) => a.deliver_after.localeCompare(b.deliver_after) || a.id - b.id).slice(0, limit);
      for (const r of due) { r.claimed_at = clock.now.toISOString(); r.attempts++; }
      return due.map((r) => ({ ...r }));
    },
  };
  return store;
}

const TASK = "11111111-1111-4111-8111-111111111111";
let ev = 0;
const notice = (kind: Notice["kind"], actorName: string, over: Partial<Notice> = {}): Notice => ({
  userId: "maya", channel: "push", kind, eventKey: `c:${++ev}`, bundleKey: `task:${TASK}`, taskId: TASK, actorId: "x", actorName,
  title: "Launch deck",
  payload: { v: 1, line: `${actorName} ${kind === "mention" ? "mentioned you" : "commented"}`, url: `/?task=${TASK}`,
    push: { title: `${actorName} commented`, body: "Launch deck", url: `/?task=${TASK}`, tag: `task-${TASK}`, kind: "comment" },
    email: { subject: "New comment: Launch deck", html: "<p>…</p>" } },
  ...over,
});

function world(rawPrefs: Record<string, unknown> = {}) {
  const clock = { now: sec(0) };
  const store = memoryQueue(clock);
  const sent: { userId: string; channel: NotifyChannel; msg: Composed }[] = [];
  let outcome: SendOutcome = "sent";
  const prefs = { maya: resolveNotifyPrefs(rawPrefs) } as Record<string, ReturnType<typeof resolveNotifyPrefs>>;
  const snoozes = new Map<string, Date>();
  const access = new Set([`maya:${TASK}`]);
  /** lookups that throw (a passing database error) */
  const broken = new Set<"recipient" | "canSee" | "snooze">();
  /** how long each send takes, on the pinned clock */
  let sendMs = 0;
  const deliver = (n: Notice, extra: { snoozedUntil?: Date | null } = {}) => deliverNotice(n, {
    store, now: clock.now, prefs: prefs[n.userId], snoozedUntil: extra.snoozedUntil ?? snoozes.get(`${n.userId}:${n.taskId}`) ?? null,
    send: async () => { if (outcome === "sent") sent.push({ userId: n.userId, channel: n.channel, msg: { push: n.payload.push, email: n.payload.email } }); return outcome; },
  });
  const fail = (what: "recipient" | "canSee" | "snooze") => { if (broken.has(what)) throw new LookupFailed(what, "connection reset"); };
  const deps: DrainDeps = {
    store, now: () => clock.now, appUrl: "https://www.kanbo.co.uk",
    recipient: async (u) => { fail("recipient"); return prefs[u] ? { prefs: prefs[u] } : null; },
    canSee: async (u, t) => { fail("canSee"); return access.has(`${u}:${t}`); },
    snoozedUntil: async (u, t) => { fail("snooze"); return snoozes.get(`${u}:${t}`) ?? null; },
    send: async (userId, channel, msg) => {
      clock.now = new Date(clock.now.getTime() + sendMs);
      if (outcome === "sent") sent.push({ userId, channel, msg });
      return outcome;
    },
  };
  return {
    clock, store, sent, prefs, snoozes, access, broken, deliver,
    drain: (over: Partial<DrainDeps> = {}) => drainQueue({ ...deps, ...over }),
    at: (s: number) => { clock.now = sec(s); },
    failSends: (o: SendOutcome) => { outcome = o; },
    slowSends: (ms: number) => { sendMs = ms; },
  };
}

describe("coalescing (2 minutes per task per recipient)", () => {
  it("the first goes now; the rest in the window go as ONE message naming everyone", async () => {
    const w = world();
    expect((await w.deliver(notice("comment", "Sana Rao"))).result).toBe("sent");
    w.at(30);
    expect(await w.deliver(notice("comment", "Theo Vance"))).toMatchObject({ result: "held", plan: { until: sec(120), reason: "bundle" } });
    w.at(70);
    expect((await w.deliver(notice("comment", "Sana Rao"))).result).toBe("held");
    expect(w.sent).toHaveLength(1);

    w.at(90);
    expect((await w.drain()).messages).toBe(0);   // not yet
    w.at(121);
    const r = await w.drain();
    expect(r).toMatchObject({ claimed: 2, messages: 1, sent: 1 });
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1].msg.push).toMatchObject({ title: "2 comments on Launch deck", body: "From Sana and Theo", tag: `task-${TASK}` });
    expect(w.sent[1].msg.email?.subject).toBe("2 comments on Launch deck from Sana and Theo");
    expect(w.store.rows.every((x) => x.sent_at)).toBe(true);

    // the window rolls on from the bundle's send
    w.at(150);
    expect(await w.deliver(notice("comment", "Maya Lin"))).toMatchObject({ result: "held", plan: { until: sec(241) } });
    w.at(400);
    expect((await w.deliver(notice("comment", "Theo Vance"))).result).toBe("held");   // joins the one still waiting
    await w.drain();
    expect(w.sent).toHaveLength(3);
    expect(w.sent[2].msg.push?.title).toBe("2 comments on Launch deck");
  });

  it("a mention rides in the bundle and is named in it — never dropped", async () => {
    const w = world();
    await w.deliver(notice("comment", "Theo Vance"));
    w.at(20);
    await w.deliver(notice("mention", "Sana Rao"));
    w.at(40);
    await w.deliver(notice("comment", "Maya Lin"));
    w.at(125);
    await w.drain();
    const msg = w.sent[1].msg;
    expect(msg.push).toMatchObject({ title: "2 updates on Launch deck", kind: "mention" });
    expect(msg.push?.body).toBe("Sana mentioned you · From Maya and Sana");
    expect(msg.email?.subject).toBe("2 updates on Launch deck from Maya and Sana");
    expect(msg.email?.html).toContain("<strong>Sana mentioned you.</strong>");
  });

  it("each recipient and each channel has its own window; other tasks aren't held", async () => {
    const w = world();
    w.prefs.theo = resolveNotifyPrefs({});
    await w.deliver(notice("comment", "Sana Rao"));
    expect((await w.deliver(notice("comment", "Sana Rao", { userId: "theo" }))).result).toBe("sent");
    expect((await w.deliver(notice("comment", "Sana Rao", { channel: "email" }))).result).toBe("sent");
    expect((await w.deliver(notice("comment", "Sana Rao", { bundleKey: "task:other", taskId: "other" }))).result).toBe("sent");
    expect((await w.deliver(notice("comment", "Theo Vance"))).result).toBe("held");
  });

  it("bundling off: every notice on its own", async () => {
    const w = world({ bundle: false });
    await w.deliver(notice("comment", "Sana Rao"));
    expect((await w.deliver(notice("comment", "Theo Vance"))).result).toBe("sent");
    expect(w.sent).toHaveLength(2);
  });

  it("a replayed call alerts nobody twice", async () => {
    const w = world();
    const n = notice("mention", "Sana Rao");
    expect((await w.deliver(n)).result).toBe("sent");
    w.at(600);
    expect((await w.deliver({ ...n })).result).toBe("duplicate");
    expect(w.sent).toHaveLength(1);
  });
});

describe("quiet hours, snoozes and the digest", () => {
  it("quiet hours hold everything to their end, then one message", async () => {
    const w = world({ quiet_hours: { start: "22:00", end: "07:00" } });
    w.clock.now = new Date("2026-10-09T22:30:00Z");   // 23:30 BST
    expect(await w.deliver(notice("comment", "Sana Rao"))).toMatchObject({ result: "held", plan: { reason: "quiet_hours", until: new Date("2026-10-10T06:00:00Z") } });
    w.clock.now = new Date("2026-10-09T23:10:00Z");
    expect((await w.deliver(notice("mention", "Theo Vance"))).result).toBe("held");
    expect(w.sent).toHaveLength(0);
    w.clock.now = new Date("2026-10-10T05:59:00Z");
    await w.drain();
    expect(w.sent).toHaveLength(0);
    w.clock.now = new Date("2026-10-10T06:00:30Z");
    await w.drain();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].msg.push?.body).toMatch(/^Theo mentioned you/);
  });

  it("quiet hours that began while a notice waited hold it again, without using up an attempt", async () => {
    const w = world();
    await w.deliver(notice("comment", "Sana Rao"));
    w.at(30);
    await w.deliver(notice("comment", "Theo Vance"));
    w.prefs.maya = resolveNotifyPrefs({ quiet_hours: { start: "10:00", end: "12:00" } });   // switched on meanwhile
    w.at(125);
    const r = await w.drain();
    expect(r).toMatchObject({ held: 1, messages: 0 });
    const row = w.store.rows.find((x) => !x.sent_at)!;
    expect([row.deliver_after, row.attempts, row.claimed_at]).toEqual(["2026-10-09T11:00:00.000Z", 0, null]);
  });

  it("a snoozed thread sends nothing — also when it was snoozed after the notice was held", async () => {
    const w = world();
    w.snoozes.set(`maya:${TASK}`, sec(3600));
    expect((await w.deliver(notice("mention", "Sana Rao"))).result).toBe("skipped");
    w.snoozes.clear();
    await w.deliver(notice("comment", "Sana Rao"));
    w.at(30);
    await w.deliver(notice("comment", "Theo Vance"));
    w.snoozes.set(`maya:${TASK}`, sec(3600));
    w.at(125);
    expect(await w.drain()).toMatchObject({ dropped: 1, messages: 0 });
    expect(w.sent).toHaveLength(1);
    // a dropped notice doesn't count as sent for the next window
    w.snoozes.clear();
    expect(await w.store.bundleState("maya", "push", `task:${TASK}`, w.clock.now)).toEqual({ last: sec(0), pending: null, pendingLast: null });
  });

  it("daily digest: email waits for the digest (nothing queued); a mention still pushes", async () => {
    const w = world({ delivery: "digest" });
    expect((await w.deliver(notice("comment", "Sana Rao", { channel: "email" }))).result).toBe("digest");
    expect((await w.deliver(notice("comment", "Sana Rao"))).result).toBe("skipped");
    expect((await w.deliver(notice("mention", "Sana Rao"))).result).toBe("sent");
    expect(w.store.rows).toHaveLength(1);
  });

  it("someone who left the workspace (or was suspended) while a notice waited gets nothing", async () => {
    const w = world();
    await w.deliver(notice("comment", "Sana Rao"));
    w.at(30);
    await w.deliver(notice("comment", "Theo Vance"));
    w.access.clear();
    w.at(125);
    expect(await w.drain()).toMatchObject({ dropped: 1, messages: 0 });
    w.prefs.theo = resolveNotifyPrefs({});
    await w.deliver(notice("comment", "Sana Rao", { userId: "theo", eventKey: "z1" }));
    w.at(140);
    await w.deliver(notice("comment", "Maya Lin", { userId: "theo", eventKey: "z2" }));
    delete w.prefs.theo;   // suspended
    w.at(300);
    expect(await w.drain()).toMatchObject({ dropped: 1 });
  });
});

describe("failures", () => {
  it("a failed send stays queued and the drain retries it with backoff", async () => {
    const w = world();
    w.failSends("failed");
    expect((await w.deliver(notice("mention", "Sana Rao"))).result).toBe("failed");
    const row = w.store.rows[0];
    expect([row.sent_at, row.last_error, row.deliver_after]).toEqual([null, "send failed", sec(120).toISOString()]);
    w.failSends("sent");
    w.at(60);
    expect((await w.drain()).claimed).toBe(0);
    w.at(121);
    expect(await w.drain()).toMatchObject({ claimed: 1, sent: 1 });
    expect(w.sent[0].msg.push?.title).toBe("Sana Rao commented");   // the lone notice, as rendered
  });

  it("no queue (0048 not run): sends straight away, as before — even what it would have held", async () => {
    const w = world({ quiet_hours: { start: "09:00", end: "11:00" } });
    w.store.setMissing(true);
    expect((await w.deliver(notice("mention", "Sana Rao"))).result).toBe("sent");
    expect(w.sent).toHaveLength(1);
  });

  it("nowhere to send (no device) is not a failure", async () => {
    const w = world();
    w.failSends("nothing");
    expect((await w.deliver(notice("comment", "Sana Rao"))).result).toBe("nothing");
    expect(w.store.rows[0].sent_at).not.toBeNull();
  });
});

describe("prefs changed while notices wait", () => {
  it("held for quiet hours that are then switched off: a mention goes now, and what waited comes in its window", async () => {
    const w = world({ quiet_hours: { start: "22:00", end: "07:00" } });
    w.clock.now = new Date("2026-10-08T22:00:00Z");   // Thu 23:00 BST
    expect(await w.deliver(notice("comment", "Sana Rao"))).toMatchObject({ result: "held", plan: { reason: "quiet_hours", until: new Date("2026-10-09T06:00:00Z") } });
    w.prefs.maya = resolveNotifyPrefs({});              // quiet hours off at 05:00
    w.clock.now = new Date("2026-10-09T04:30:00Z");   // 05:30 BST
    expect(await w.deliver(notice("mention", "Theo Vance"))).toMatchObject({ result: "sent", plan: { action: "send" } });
    expect(w.sent).toHaveLength(1);
    // the comment no longer waits for 07:00: it joins the window the mention opened
    expect(w.store.rows.find((r) => !r.sent_at)?.deliver_after).toBe("2026-10-09T04:32:00.000Z");
    w.clock.now = new Date("2026-10-09T04:31:00Z");
    expect((await w.drain()).messages).toBe(0);
    w.clock.now = new Date("2026-10-09T04:32:01Z");
    expect(await w.drain()).toMatchObject({ messages: 1, sent: 1 });
    expect(w.sent[1].msg.push?.title).toBe("Sana Rao commented");
  });

  it("quiet hours shortened while held: the new notice and the old go together at the new end", async () => {
    const w = world({ quiet_hours: { start: "22:00", end: "07:00" } });
    w.clock.now = new Date("2026-10-08T22:00:00Z");
    await w.deliver(notice("comment", "Sana Rao"));
    w.prefs.maya = resolveNotifyPrefs({ quiet_hours: { start: "22:00", end: "06:00" } });
    w.clock.now = new Date("2026-10-09T04:30:00Z");   // 05:30 BST: quiet until 06:00 now
    expect(await w.deliver(notice("mention", "Theo Vance"))).toMatchObject({ result: "held", plan: { reason: "quiet_hours", until: new Date("2026-10-09T05:00:00Z") } });
    expect(w.store.rows.map((r) => r.deliver_after)).toEqual(["2026-10-09T05:00:00.000Z", "2026-10-09T05:00:00.000Z"]);
    w.clock.now = new Date("2026-10-09T05:00:30Z");
    expect(await w.drain()).toMatchObject({ claimed: 2, messages: 1 });
    expect(w.sent[0].msg.push?.body).toMatch(/^Theo mentioned you/);
  });

  it("a retry's backoff isn't pulled forward, and a new notice doesn't wait for it", async () => {
    const w = world();
    w.failSends("failed");
    await w.deliver(notice("comment", "Sana Rao"));
    w.at(121);
    await w.drain();                                     // fails again: next try 4 minutes on
    const retry = w.store.rows[0];
    expect([retry.attempts, retry.deliver_after]).toEqual([2, sec(361).toISOString()]);
    w.failSends("sent");
    w.at(130);
    expect((await w.deliver(notice("mention", "Theo Vance"))).result).toBe("sent");
    expect(retry.deliver_after).toBe(sec(361).toISOString());
  });
});

describe("replanHeld (Settings changed quiet hours, time zone or delivery)", () => {
  const NOW = new Date("2026-10-09T04:30:00Z");   // Fri 05:30 BST
  const row = (id: number, over: Partial<QueueRow> = {}) => ({
    id, kind: "comment" as const, channel: "push" as const, deliver_after: "2026-10-09T06:00:00.000Z", claimed_at: null, sent_at: null, last_error: null, ...over,
  });

  it("quiet hours off: everything that waited for them goes now", () => {
    expect(replanHeld([row(1), row(2, { kind: "mention", channel: "email" })], resolveNotifyPrefs({}), NOW))
      .toEqual([{ id: 1, until: NOW }, { id: 2, until: NOW }]);
  });

  it("shorter, other days or another time zone: the new end — never later", () => {
    const q = { start: "22:00", end: "07:00" };
    expect(replanHeld([row(1)], resolveNotifyPrefs({ quiet_hours: { ...q, end: "06:00" } }), NOW)).toEqual([{ id: 1, until: new Date("2026-10-09T05:00:00Z") }]);
    // Thursday night isn't a quiet night any more
    expect(replanHeld([row(1)], resolveNotifyPrefs({ quiet_hours: { ...q, days: [6, 7] } }), NOW)).toEqual([{ id: 1, until: NOW }]);
    // Tokyo: 13:30 there, not quiet
    expect(replanHeld([row(1)], resolveNotifyPrefs({ quiet_hours: q, timezone: "Asia/Tokyo" }), NOW)).toEqual([{ id: 1, until: NOW }]);
    // longer (08:00), or New York (quiet till 07:00 there, 11:00Z): left alone — the drain holds it again when it's due
    expect(replanHeld([row(1)], resolveNotifyPrefs({ quiet_hours: { ...q, end: "08:00" } }), NOW)).toEqual([]);
    expect(replanHeld([row(1)], resolveNotifyPrefs({ quiet_hours: q, timezone: "America/New_York" }), NOW)).toEqual([]);
  });

  it("leaves alone the bundle window, what's being sent or retried, what's sent, and digests", () => {
    expect(replanHeld([
      row(1, { deliver_after: "2026-10-09T04:31:30.000Z" }),
      row(2, { claimed_at: "2026-10-09T04:29:00.000Z" }),
      row(3, { last_error: "send failed" }),
      row(4, { sent_at: "2026-10-09T04:00:00.000Z" }),
      row(5, { kind: "digest" }),
    ], resolveNotifyPrefs({}), NOW)).toEqual([]);
  });

  it("rescheduleHeld: reads your own waiting notices and moves only what's still waiting, only earlier", async () => {
    const calls: unknown[][] = [];
    const results = [
      { data: [row(1), row(2), row(3, { last_error: "send failed" })], error: null },
      { data: [{ id: 1 }, { id: 2 }], error: null },
    ];
    const q: Record<string, unknown> = {};
    for (const k of ["select", "eq", "is", "gt", "in", "order", "limit", "update"]) q[k] = vi.fn((...a: unknown[]) => { calls.push([k, ...a]); return q; });
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(results.shift()).then(res);
    const db = { from: vi.fn(() => q), rpc: vi.fn() };
    expect(await rescheduleHeld(db, "maya", resolveNotifyPrefs({}), NOW)).toBe(2);
    expect(calls.slice(0, 4)).toEqual([
      ["select", "id,kind,channel,deliver_after,claimed_at,sent_at,last_error"], ["eq", "user_id", "maya"], ["is", "sent_at", null],
      ["gt", "deliver_after", "2026-10-09T04:32:00.000Z"],
    ]);
    const iso = NOW.toISOString();
    expect(calls.slice(calls.findIndex((c) => c[0] === "update"))).toEqual([
      ["update", { deliver_after: iso }], ["in", "id", [1, 2]], ["eq", "user_id", "maya"], ["is", "sent_at", null], ["is", "claimed_at", null],
      ["gt", "deliver_after", iso], ["select", "id"],
    ]);
    // 0048 not run: nothing to move; any other read error says so
    results.push({ data: null, error: { code: "42P01", message: "relation does not exist" } });
    expect(await rescheduleHeld(db, "maya", resolveNotifyPrefs({}), NOW)).toBe(0);
    results.push({ data: null, error: { message: "timeout" } });
    await expect(rescheduleHeld(db, "maya", resolveNotifyPrefs({}), NOW)).rejects.toBeInstanceOf(LookupFailed);
  });
});

describe("a lookup that fails is never taken for gone", () => {
  it.each(["recipient", "canSee", "snooze"] as const)("%s: the notices wait and are tried again, not dropped", async (what) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const w = world();
    await w.deliver(notice("comment", "Sana Rao"));
    w.at(30);
    await w.deliver(notice("mention", "Theo Vance"));
    w.broken.add(what);
    w.at(125);
    expect(await w.drain()).toMatchObject({ claimed: 1, retried: 1, dropped: 0, messages: 0 });
    const row = w.store.rows[1];
    expect([row.sent_at, row.last_error, row.claimed_at, row.deliver_after]).toEqual([null, "lookup failed", null, sec(245).toISOString()]);
    w.broken.clear();
    w.at(246);
    expect(await w.drain()).toMatchObject({ claimed: 1, sent: 1 });
    expect(w.sent[1].msg.push?.title).toBe("Theo Vance commented");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/lookup failed/), expect.stringContaining("connection reset"));
    warn.mockRestore();
  });

  /** a PostgREST-ish client: each table answers `results[table]` */
  function tablesDb(results: Record<string, { data: unknown; error: unknown }>) {
    const builder = (t: string) => {
      const q: Record<string, unknown> = {};
      for (const k of ["select", "eq", "maybeSingle"]) q[k] = () => q;
      (q as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(results[t] ?? { data: null, error: null }).then(res);
      return q;
    };
    return { from: (t: string) => builder(t), rpc: vi.fn() };
  }
  const boom = { data: null, error: { message: "canceling statement due to statement timeout" } };

  it("readRecipient: a read error throws; no profile, suspended or unapproved is null", async () => {
    await expect(readRecipient(tablesDb({ profiles: boom }), "u")).rejects.toBeInstanceOf(LookupFailed);
    expect(await readRecipient(tablesDb({ profiles: { data: null, error: null } }), "u")).toBeNull();
    expect(await readRecipient(tablesDb({ profiles: { data: { suspended: true }, error: null } }), "u")).toBeNull();
    expect(await readRecipient(tablesDb({ profiles: { data: { approved: false }, error: null } }), "u")).toBeNull();
    const ok = await readRecipient(tablesDb({ profiles: { data: { notify_prefs: { bundle: false }, first_name: "Maya" }, error: null } }), "u");
    expect([ok?.firstName, ok?.prefs.bundle]).toEqual(["Maya", false]);
  });

  it("readSnoozedUntil: a read error throws; no row, or 0048 not run, is not snoozed", async () => {
    await expect(readSnoozedUntil(tablesDb({ notification_snoozes: boom }), "u", "t")).rejects.toBeInstanceOf(LookupFailed);
    expect(await readSnoozedUntil(tablesDb({ notification_snoozes: { data: null, error: { code: "42P01", message: "does not exist" } } }), "u", "t")).toBeNull();
    expect(await readSnoozedUntil(tablesDb({ notification_snoozes: { data: { until: "2026-10-10T08:00:00Z" }, error: null } }), "u", "t"))
      .toEqual(new Date("2026-10-10T08:00:00Z"));
  });

  it("canSee: a task or membership read error throws; a task gone, archived or not theirs is false", async () => {
    const env = { appUrl: "", vapid: null };
    const team = { data: { user_id: "owner", workspace_id: "w1", archived_at: null }, error: null };
    await expect(supabaseDrainDeps(tablesDb({ tasks: boom }), env).canSee("u", "t")).rejects.toBeInstanceOf(LookupFailed);
    await expect(supabaseDrainDeps(tablesDb({ tasks: team, workspace_members: boom }), env).canSee("u", "t")).rejects.toBeInstanceOf(LookupFailed);
    await expect(supabaseDrainDeps(tablesDb({ tasks: team, workspace_members: { data: [], error: null }, workspaces: boom }), env).canSee("u", "t"))
      .rejects.toBeInstanceOf(LookupFailed);
    const fine = supabaseDrainDeps(tablesDb({ tasks: team, workspace_members: { data: [{ user_id: "u" }], error: null }, workspaces: { data: { owner_id: "owner" }, error: null } }), env);
    expect([await fine.canSee("u", "t"), await fine.canSee("owner", "t"), await fine.canSee("x", "t")]).toEqual([true, true, false]);
    expect(await supabaseDrainDeps(tablesDb({ tasks: { data: null, error: null } }), env).canSee("u", "t")).toBe(false);
    expect(await supabaseDrainDeps(tablesDb({ tasks: { data: { ...team.data, archived_at: "2026-10-01" }, error: null } }), env).canSee("owner", "t")).toBe(false);
  });

  it("emails from the drain are paced for Resend; push and 'nowhere to send' aren't", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const db = { ...tablesDb({}), auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: { email: "maya@example.com" } } })) } } };
      const deps = supabaseDrainDeps(db, { appUrl: "", vapid: null, resendKey: "re_test", from: "Kanbo <hi@kanbo.co.uk>" }, { sleep });
      expect(await deps.send("maya", "email", { email: { subject: "2 comments", html: "<p>…</p>" } })).toBe("sent");
      expect(sleep).toHaveBeenCalledWith(EMAIL_GAP_MS);
      expect(await deps.send("maya", "push", { push: { title: "x", body: "y", url: "/", tag: "t", kind: "comment" } })).toBe("nothing");
      expect(await deps.send("maya", "email", {})).toBe("nothing");
      expect(sleep).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("the drain's time and its claim", () => {
  const threads = (w: ReturnType<typeof world>, n: number) => Promise.all(Array.from({ length: n }, (_, i) => {
    const t = `task-${i}`;
    w.access.add(`maya:${t}`);
    return w.store.enqueue(notice("comment", "Sana Rao", { bundleKey: `task:${t}`, taskId: t }), sec(0));
  }));

  it("claims with a lease longer than any run can last", () => {
    expect(CLAIM_LEASE_SEC).toBeGreaterThan(400);   // an edge function's longest wall clock
  });

  it("out of time: what it didn't reach goes back at once, no attempt spent, and the next run sends it", async () => {
    const w = world();
    await threads(w, 5);
    w.slowSends(15_000);   // each send takes 15 s: groups start at 0, 15 and 30 s; at 45 s the 40-second budget is gone
    expect(await w.drain()).toMatchObject({ claimed: 5, messages: 3, sent: 3, released: 2 });
    expect(w.store.rows.filter((r) => !r.sent_at).map((r) => [r.claimed_at, r.attempts])).toEqual([[null, 0], [null, 0]]);
    w.slowSends(0);
    w.at(60);
    expect(await w.drain()).toMatchObject({ claimed: 2, sent: 2 });
    expect(w.sent).toHaveLength(5);
  });

  it("a slow run's notices are never claimed again by the next run (nothing sent twice)", async () => {
    const w = world();
    await threads(w, 3);
    let calls = 0;
    let overlap: Awaited<ReturnType<typeof w.drain>> | null = null;
    // a run that keeps going (65 s a send) while the every-minute schedule starts the next
    const r = await w.drain({
      budgetMs: 300_000,
      send: async (userId, channel, msg) => {
        w.clock.now = new Date(w.clock.now.getTime() + 65_000);
        if (++calls === 2) overlap = await w.drain();   // 130 s in
        w.sent.push({ userId, channel, msg });
        return "sent";
      },
    });
    expect(r).toMatchObject({ claimed: 3, sent: 3 });
    expect(overlap).toMatchObject({ claimed: 0, messages: 0 });
    expect(w.sent).toHaveLength(3);
  });

  it("the limit caps a run; claims are made in batches when asked", async () => {
    const w = world();
    await threads(w, 5);
    expect(await w.drain({ limit: 4, batch: 2 })).toMatchObject({ claimed: 4, batches: 2, sent: 4 });
    expect(await w.drain()).toMatchObject({ claimed: 1, batches: 1 });
  });
});

describe("composeGroup", () => {
  it("a lone held due list renders the morning email and push", () => {
    const row = {
      id: 1, user_id: "maya", channel: "email", kind: "due", event_key: "due:2026-10-09", bundle_key: "due:2026-10-09", task_id: null,
      actor_id: null, actor_name: "", title: "", deliver_after: "", created_at: "", claimed_at: null, attempts: 1, sent_at: null,
      payload: { v: 1, line: "", url: "/today", due: { today: "2026-10-09", more: 0, tasks: [{ id: "t1", title: "Pay <invoices>", due_date: "2026-10-08" }] } },
    } as QueueRow;
    const c = composeGroup([row], "https://www.kanbo.co.uk");
    expect(c.email?.subject).toBe("1 task due on Kanbo");
    expect(c.email?.html).toContain("Pay &lt;invoices&gt;");
    expect(c.push?.title).toBe("1 task overdue");
  });
});

describe("supabaseQueueStore (the calls it makes)", () => {
  function fakeDb() {
    const calls: unknown[][] = [];
    const result = { data: [{ id: 7 }] as unknown, error: null as unknown };
    const q: Record<string, unknown> = {};
    for (const k of ["select", "eq", "gte", "gt", "is", "order", "limit", "upsert", "update", "in"]) q[k] = vi.fn((...a: unknown[]) => { calls.push([k, ...a]); return q; });
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    const db = { from: vi.fn((t: string) => { calls.push(["from", t]); return q; }), rpc: vi.fn(async (fn: string, args: unknown) => { calls.push(["rpc", fn, args]); return result; }) };
    return { db, calls, result };
  }

  it("enqueues idempotently on (user, channel, event_key); a duplicate answers no row", async () => {
    const f = fakeDb();
    const s = supabaseQueueStore(f.db);
    expect(await s.enqueue(notice("comment", "Sana Rao", { eventKey: "c:abc" }), sec(120), { now: sec(0), claimed: true })).toEqual({ status: "queued", id: 7 });
    const up = f.calls.find((c) => c[0] === "upsert")!;
    expect(up[2]).toEqual({ onConflict: "user_id,channel,event_key", ignoreDuplicates: true });
    expect(up[1]).toMatchObject({ user_id: "maya", channel: "push", event_key: "c:abc", bundle_key: `task:${TASK}`, deliver_after: sec(120).toISOString(), claimed_at: sec(0).toISOString(), attempts: 1 });
    f.result.data = [];
    expect(await s.enqueue(notice("comment", "Sana Rao"), sec(0))).toEqual({ status: "duplicate" });
    f.result.data = null; f.result.error = { code: "42P01", message: 'relation "public.notify_queue" does not exist' };
    expect((await s.enqueue(notice("comment", "Sana Rao"), sec(0))).status).toBe("unavailable");
  });

  it("claims and finishes through the 0048 functions", async () => {
    const f = fakeDb();
    const s = supabaseQueueStore(f.db);
    await s.claim(50);
    await s.finish([1, 2]);
    await s.finish([3], "send failed");
    expect(f.calls.filter((c) => c[0] === "rpc")).toEqual([
      ["rpc", "notify_queue_claim", { p_limit: 50, p_lease_seconds: CLAIM_LEASE_SEC }],
      ["rpc", "notify_queue_finish", { p_ids: [1, 2], p_error: null }],
      ["rpc", "notify_queue_finish", { p_ids: [3], p_error: "send failed" }],
    ]);
  });

  it("reads the bundle state: last sent (not dropped), earliest waiting", async () => {
    const f = fakeDb();
    f.result.data = [
      { sent_at: null, deliver_after: sec(240).toISOString(), attempts: 0, last_error: null },
      { sent_at: sec(100).toISOString(), deliver_after: sec(0).toISOString(), attempts: 1, last_error: "dropped: snoozed" },
      { sent_at: sec(10).toISOString(), deliver_after: sec(0).toISOString(), attempts: 1, last_error: null },
      { sent_at: null, deliver_after: sec(5).toISOString(), attempts: 5, last_error: "send failed" },
    ];
    const s = supabaseQueueStore(f.db);
    expect(await s.bundleState("maya", "push", `task:${TASK}`, sec(200))).toEqual({ last: sec(10), pending: sec(240), pendingLast: sec(240) });
  });

  it("brings a bundle forward (only what's waiting, not a retry, only earlier); releases and reholds without spending attempts", async () => {
    const f = fakeDb();
    const s = supabaseQueueStore(f.db);
    f.result.data = [{ id: 4 }, { id: 5 }];
    expect(await s.bringForward("maya", "push", `task:${TASK}`, sec(120))).toBe(2);
    const at = sec(120).toISOString();
    expect(f.calls.slice(1)).toEqual([
      ["update", { deliver_after: at }], ["eq", "user_id", "maya"], ["eq", "channel", "push"], ["eq", "bundle_key", `task:${TASK}`],
      ["is", "sent_at", null], ["is", "claimed_at", null], ["is", "last_error", null], ["gt", "deliver_after", at], ["select", "id"],
    ]);
    f.calls.length = 0;
    await s.release([{ id: 1, attempts: 1 }, { id: 2, attempts: 3 }, { id: 3, attempts: 1 }]);
    expect(f.calls.filter((c) => c[0] === "update" || c[0] === "in")).toEqual([
      ["update", { claimed_at: null, attempts: 0 }], ["in", "id", [1, 3]], ["update", { claimed_at: null, attempts: 2 }], ["in", "id", [2]],
    ]);
    f.calls.length = 0;
    await s.rehold([{ id: 9, attempts: 2 }], sec(600));
    expect(f.calls.find((c) => c[0] === "update")).toEqual(["update", { deliver_after: sec(600).toISOString(), claimed_at: null, attempts: 1, last_error: null }]);
  });
});
