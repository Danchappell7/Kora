// @vitest-environment node
// The update-day reminders (0053) against an in-memory stand-in for the
// service-role client: whose update is owed today (on hold by hand or by an
// update, an owner who left or is only a guest, a personal update planted on
// someone's project), and how each owner hears (once a day, a digest person
// in their digest, held through quiet hours, a failed send tried again).
// Friday 13 November 2026 is the default update day; nothing reads the clock.
import { describe, expect, it } from "vitest";
import { digestUpdates, emptyRhythmReport, ownerPrefs, ownerUpdatesDue, remindOwner, updateOwners, type RemindDeps } from "./updateReminders.ts";
import { resolveNotifyPrefs } from "./notifyTiming.ts";
import type { Notice, QueueStore, SendOutcome } from "./notifyQueue.ts";

type Row = Record<string, unknown>;
const ME = "11111111-1111-4111-8111-111111111111";
const ADA = "22222222-2222-4222-8222-222222222222";
const BOSS = "33333333-3333-4333-8333-333333333333";
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FRIDAY = "2026-11-13";
const at = (iso: string) => new Date(iso);

/** supabase-js's query chain over arrays of rows: the filters this module uses, applied in order. */
function memoryDb(tables: Record<string, Row[]>, broken: string[] = []) {
  const from = (name: string) => {
    const ops: [string, unknown[]][] = [];
    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (broken.includes(name)) return { data: null, error: { message: `relation "${name}" does not exist` } };
      let rows = [...(tables[name] ?? [])];
      let limit: number | undefined;
      const val = (r: Row, c: unknown) => (r[c as string] ?? null);
      for (const [m, a] of ops) {
        if (m === "eq") rows = rows.filter((r) => val(r, a[0]) === a[1]);
        else if (m === "in") rows = rows.filter((r) => (a[1] as unknown[]).includes(val(r, a[0])));
        else if (m === "is") rows = rows.filter((r) => val(r, a[0]) === a[1]);
        else if (m === "not" && a[1] === "is") rows = rows.filter((r) => val(r, a[0]) !== a[2]);
        else if (m === "gt") rows = rows.filter((r) => String(val(r, a[0])) > String(a[1]));
        else if (m === "order") {
          const asc = (a[1] as { ascending?: boolean } | undefined)?.ascending !== false;
          rows.sort((x, y) => String(val(x, a[0])).localeCompare(String(val(y, a[0]))) * (asc ? 1 : -1));
        } else if (m === "range") rows = rows.slice(a[0] as number, (a[1] as number) + 1);
        else if (m === "limit") limit = a[0] as number;
      }
      return { data: limit === undefined ? rows : rows.slice(0, limit), error: null };
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      then: (ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
      maybeSingle: () => Promise.resolve(run()).then((r) => ({ data: r.data?.[0] ?? null, error: r.error })),
    };
    for (const m of ["select", "eq", "in", "is", "not", "gt", "order", "range", "limit"]) b[m] = (...a: unknown[]) => { ops.push([m, a]); return b; };
    return b;
  };
  return { from, tables };
}

/** A small world: Bob's team, where I own the launch (weekly on Friday, last posted the Monday before last). */
function world(over: { projects?: Row[]; members?: Row[]; updates?: Row[]; asks?: Row[]; profiles?: Row[]; broken?: string[] } = {}) {
  return memoryDb({
    projects: over.projects ?? [{ id: P1, name: "Launch", workspace_id: W1, owner_id: ME, status: "on_track", update_rhythm: null, archived_at: null }],
    workspaces: [{ id: W1, owner_id: BOSS, update_rhythm: null }],
    workspace_members: over.members ?? [{ workspace_id: W1, user_id: ME, role: "member", status: "active" }, { workspace_id: W1, user_id: ADA, role: "admin", status: "active" }],
    status_updates: over.updates ?? [{ id: "u0", project_id: P1, workspace_id: W1, created_at: "2026-11-02T10:00:00Z", status: "on_track" }],
    tasks: [{ project_id: P1, created_at: "2026-10-01T09:00:00Z", archived_at: null }],
    update_asks: over.asks ?? [],
    profiles: over.profiles ?? [{ id: ME, first_name: "Me", notify_prefs: {}, suspended: false, approved: true }, { id: ADA, first_name: "Ada", notify_prefs: {}, suspended: false, approved: true }],
  }, over.broken);
}

describe("ownerUpdatesDue: whose update is owed today", () => {
  const due = (db: ReturnType<typeof world>, today = FRIDAY) => ownerUpdatesDue(db, ME, today, "Europe/London");

  it("the launch is due on its Friday, and on the two working days after; not on the Thursday before", async () => {
    expect(await due(world())).toEqual([{ projectId: P1, name: "Launch", when: "today", followUp: 0 }]);
    expect((await due(world(), "2026-11-16")).map((i) => i.followUp)).toEqual([1]);
    expect((await due(world(), "2026-11-17")).map((i) => i.followUp)).toEqual([2]);
    expect(await due(world(), "2026-11-18")).toEqual([]);
    expect(await due(world(), "2026-11-12")).toEqual([]);
  });
  it("posted since the round before: nothing owed", async () => {
    expect(await due(world({ updates: [{ id: "u1", project_id: P1, workspace_id: W1, created_at: "2026-11-09T10:00:00Z", status: "on_track" }] }))).toEqual([]);
  });
  it("on hold, set by hand or by its latest update: skipped", async () => {
    expect(await due(world({ projects: [{ id: P1, name: "Launch", workspace_id: W1, owner_id: ME, status: "on_hold", update_rhythm: null, archived_at: null }] }))).toEqual([]);
    expect(await due(world({ updates: [{ id: "u1", project_id: P1, workspace_id: W1, created_at: "2026-11-02T10:00:00Z", status: "on_hold" }] }))).toEqual([]);
  });
  it("archived, or Never: skipped", async () => {
    expect(await due(world({ projects: [{ id: P1, name: "Launch", workspace_id: W1, owner_id: ME, status: null, update_rhythm: null, archived_at: "2026-11-01T00:00:00Z" }] }))).toEqual([]);
    expect(await due(world({ projects: [{ id: P1, name: "Launch", workspace_id: W1, owner_id: ME, status: null, update_rhythm: { cadence: "never", weekday: 5 }, archived_at: null }] }))).toEqual([]);
  });
  it("an owner who has left the workspace, or is only a guest there (a guest can't post an update): skipped", async () => {
    expect(await due(world({ members: [{ workspace_id: W1, user_id: ME, role: "member", status: "invited" }] }))).toEqual([]);
    expect(await due(world({ members: [{ workspace_id: W1, user_id: ME, role: "guest", status: "active" }] }))).toEqual([]);
    // the workspace's own owner always can
    const theirs = world({ projects: [{ id: P1, name: "Launch", workspace_id: W1, owner_id: BOSS, status: null, update_rhythm: null, archived_at: null }], members: [] });
    expect((await ownerUpdatesDue(theirs, BOSS, FRIDAY, "Europe/London")).length).toBe(1);
  });
  it("a personal update someone plants on the project (another workspace's, or none) doesn't count, On hold or not", async () => {
    for (const status of ["on_hold", "on_track"]) {
      const planted = world({ updates: [
        { id: "u0", project_id: P1, workspace_id: W1, created_at: "2026-11-02T10:00:00Z", status: "on_track" },
        { id: "x", project_id: P1, workspace_id: null, created_at: "2026-11-12T10:00:00Z", status },
      ] });
      expect((await due(planted)).length).toBe(1);
    }
  });
  it("before 0053 (no update days to read): nothing", async () => {
    expect(await due(world({ broken: ["projects"] }))).toEqual([]);
  });
});

describe("digestUpdates: the digest's \"Your project updates\"", () => {
  const ask = { project_id: P1, asked_by: ADA, owner_id: ME, created_at: "2026-11-11T10:00:00Z" };
  const since = "2026-11-10T08:00:00Z";
  it("a lead's ask since the last digest, while nothing's been posted after it", async () => {
    expect(await digestUpdates(world({ asks: [ask] }), ME, "2026-11-11", "Europe/London", since)).toEqual([{ projectId: P1, name: "Launch", line: "Ada asked for one" }]);
    const answered = world({ asks: [ask], updates: [{ id: "u1", project_id: P1, workspace_id: W1, created_at: "2026-11-11T12:00:00Z", status: "at_risk" }] });
    expect(await digestUpdates(answered, ME, "2026-11-11", "Europe/London", since)).toEqual([]);
  });
  it("a planted personal update isn't an answer", async () => {
    const planted = world({ asks: [ask], updates: [{ id: "x", project_id: P1, workspace_id: null, created_at: "2026-11-11T12:00:00Z", status: "on_track" }] });
    expect((await digestUpdates(planted, ME, "2026-11-11", "Europe/London", since)).length).toBe(1);
  });
  it("on the update day it says so once, not again for the ask", async () => {
    expect(await digestUpdates(world({ asks: [{ ...ask, created_at: "2026-11-13T08:00:00Z" }] }), ME, FRIDAY, "Europe/London", since))
      .toEqual([{ projectId: P1, name: "Launch", line: "due today" }]);
  });
});

describe("owners and their prefs", () => {
  it("owners of live team projects, once each; a suspended or unapproved one gets no prefs", async () => {
    const db = world({
      projects: [
        { id: P1, name: "Launch", workspace_id: W1, owner_id: ME, archived_at: null },
        { id: P2, name: "Old", workspace_id: W1, owner_id: ADA, archived_at: "2026-01-01T00:00:00Z" },
        { id: "p3", name: "Mine", workspace_id: null, owner_id: ADA, archived_at: null },
        { id: "p4", name: "Again", workspace_id: W1, owner_id: ME, archived_at: null },
      ],
      profiles: [{ id: ME, notify_prefs: { timezone: "Europe/Paris" }, suspended: false, approved: true }, { id: ADA, notify_prefs: {}, suspended: true, approved: true }],
    });
    expect(await updateOwners(db)).toEqual([ME]);
    const prefs = await ownerPrefs(db, [ME, ADA, BOSS]);
    expect(prefs.get(ME)?.timezone).toBe("Europe/Paris");
    expect(prefs.get(ADA)).toBeNull();
    expect(prefs.get(BOSS)?.delivery).toBe("realtime");   // no profile row: the defaults
  });
});

/** notify_queue for one run: what was held, and until when */
function heldQueue() {
  const held: { n: Notice; until: Date }[] = [];
  const store = {
    held,
    async bundleState() { return { last: null, pending: null, pendingLast: null }; },
    async enqueue(n: Notice, until: Date) { held.push({ n, until }); return { status: "queued" as const, id: held.length }; },
    async finish() {}, async rehold() {}, async release() {}, async bringForward() { return 0; }, async drop() {}, async claim() { return []; },
  } satisfies QueueStore & { held: unknown[] };
  return store;
}

function deps(over: { now?: Date; push?: SendOutcome; email?: SendOutcome; db?: ReturnType<typeof world> } = {}) {
  const claims = new Set<string>();
  const sent = { push: 0, email: 0 };
  const store = heldQueue();
  const d: RemindDeps = {
    db: over.db ?? world(), store, now: over.now ?? at("2026-11-13T10:00:00Z"), appUrl: "https://www.kanbo.co.uk",
    claim: async (key) => { if (claims.has(key)) return false; claims.add(key); return true; },
    release: async (key) => { claims.delete(key); },
    push: async () => { sent.push++; return over.push ?? "sent"; },
    email: async (_id, mail) => { sent.email++; expect(mail.subject).toMatch(/Launch/); return over.email ?? "sent"; },
  };
  return { d, claims, sent, store };
}

describe("remindOwner: one push and one email a day, the owner's way", () => {
  const prefs = resolveNotifyPrefs({});
  it("on the day, in the working day: one push and one email; a second run that day sends nothing", async () => {
    const { d, sent } = deps();
    const r1 = emptyRhythmReport();
    await remindOwner(ME, prefs, d, r1);
    expect([r1.due, r1.pushed, r1.sent, sent.push, sent.email]).toEqual([1, 1, 1, 1, 1]);
    const r2 = emptyRhythmReport();
    await remindOwner(ME, prefs, d, r2);
    expect([r2.already, sent.push, sent.email]).toEqual([1, 1, 1]);
  });
  it("before 09:00 or after 18:00 their time: nothing claimed, nothing read", async () => {
    for (const now of ["2026-11-13T08:30:00Z", "2026-11-13T18:00:00Z"]) {
      const { d, claims, sent } = deps({ now: at(now) });
      const r = emptyRhythmReport();
      await remindOwner(ME, prefs, d, r);
      expect([r.open, claims.size, sent.push + sent.email]).toEqual([0, 0, 0]);
    }
    // (their own time zone: 09:30 in Paris is 08:30 in London)
    const { d } = deps({ now: at("2026-11-13T08:30:00Z") });
    const r = emptyRhythmReport();
    await remindOwner(ME, resolveNotifyPrefs({ timezone: "Europe/Paris" }), d, r);
    expect(r.sent).toBe(1);
  });
  it("on the daily digest: the email waits for the digest (no push for an FYI-like reminder)", async () => {
    const { d, sent } = deps();
    const r = emptyRhythmReport();
    await remindOwner(ME, resolveNotifyPrefs({ delivery: "digest" }), d, r);
    expect([r.inDigest, sent.email, sent.push]).toEqual([1, 0, 0]);
  });
  it("in quiet hours: held until they end", async () => {
    const { d, sent, store } = deps();
    const r = emptyRhythmReport();
    await remindOwner(ME, resolveNotifyPrefs({ quiet_hours: { start: "08:00", end: "11:00" } }), d, r);
    expect([r.held, sent.push + sent.email]).toEqual([2, 0]);
    expect(store.held.map((h) => [h.n.channel, h.n.kind, h.until.toISOString()])).toEqual([
      ["push", "update", "2026-11-13T11:00:00.000Z"], ["email", "update", "2026-11-13T11:00:00.000Z"]]);
  });
  it("switched off (update_email / update_push): not sent", async () => {
    const { d, sent } = deps();
    await remindOwner(ME, resolveNotifyPrefs({ update_email: false, update_push: false }), d, emptyRhythmReport());
    expect(sent.push + sent.email).toBe(0);
  });
  it("a send that fails outright gives today's claim back, so the next run tries again", async () => {
    const { d, claims, sent } = deps({ email: "failed" });
    const r = emptyRhythmReport();
    await remindOwner(ME, prefs, d, r);
    expect([r.failed, claims.size]).toEqual([1, 0]);
    await remindOwner(ME, prefs, d, emptyRhythmReport());
    expect(sent.email).toBe(2);
  });
  it("nothing due (a guest owner, or posted already): the day's claim is made, and nobody hears", async () => {
    const { d, claims, sent } = deps({ db: world({ members: [{ workspace_id: W1, user_id: ME, role: "guest", status: "active" }] }) });
    const r = emptyRhythmReport();
    await remindOwner(ME, prefs, d, r);
    expect([r.open, r.due, claims.size, sent.push + sent.email]).toEqual([1, 0, 1, 0]);
  });
});
