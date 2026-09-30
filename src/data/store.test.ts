import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { store, keepOnScreen, inviteEmailNotice } from "./store";
import type { Bootstrap } from "./store";

/* These run in demo mode (no Supabase env in tests), exercising the
   in-memory adapters that mirror the real API shape. */

describe("store (demo mode) — comments", () => {
  it("adds and lists comments per task", async () => {
    const before = await store.listComments("t-test");
    expect(before).toEqual([]);
    const c = await store.addComment("t-test", "First!", "m-self", "Daniel");
    expect(c.body).toBe("First!");
    expect(c.taskId).toBe("t-test");
    const after = await store.listComments("t-test");
    expect(after).toHaveLength(1);
    expect(after[0].authorName).toBe("Daniel");
    // other tasks unaffected
    expect(await store.listComments("t-other")).toEqual([]);
  });
});

describe("store (demo mode) — workspaces & invites", () => {
  it("creates a workspace and invites a member", async () => {
    const ws = await store.createWorkspace("Acme", { id: "m-self", email: "me@kanbo.app", name: "Me" });
    expect(ws.name).toBe("Acme");
    expect(ws.kind).toBe("team");
    expect(ws.id).toBeTruthy();
    const invite = await store.inviteMember(ws.id!, "teammate@acme.com");
    expect(invite.status).toBe("invited");
    expect(invite.email).toBe("teammate@acme.com");
    // bootstrap reflects the new workspace + members
    const b = await store.bootstrap({ id: "m-self" });
    expect(b.workspaces.some((w) => w.id === ws.id)).toBe(true);
    expect(b.members.some((m) => m.email === "teammate@acme.com")).toBe(true);
  });
});

describe("store (demo mode) — attachments", () => {
  it("uploads, lists, and deletes a file", async () => {
    const file = new File(["hello"], "spec.txt", { type: "text/plain" });
    const a = await store.uploadAttachment("t-att", file, "m-self");
    expect(a.name).toBe("spec.txt");
    expect(a.size).toBe(5);
    expect(await store.listAttachments("t-att")).toHaveLength(1);
    await store.deleteAttachment(a);
    expect(await store.listAttachments("t-att")).toHaveLength(0);
  });
});

describe("store (demo mode) — AI prioritize", () => {
  it("falls back to the heuristic (highest aiScore first) without a backend", async () => {
    const t = (id: string, aiScore: number): any => ({ id, title: id, status: "todo", priority: "medium", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore, description: "" });
    const res = await store.aiPrioritize([t("low", 20), t("high", 90), t("mid", 50)], "2026-06-03");
    expect(res.source).toBe("heuristic");
    expect(res.items.map((i) => i.id)).toEqual(["high", "mid", "low"]);
  });
});

describe("store (demo mode) — activity", () => {
  it("logs activity newest-first", async () => {
    await store.logActivity({ taskId: "t-1", taskTitle: "A", kind: "created", detail: "Task created" }, "m-self");
    await store.logActivity({ taskId: "t-1", taskTitle: "A", kind: "completed", detail: "Marked complete" }, "m-self");
    const feed = await store.listActivity();
    expect(feed.length).toBeGreaterThanOrEqual(2);
    expect(feed[0].kind).toBe("completed");
    expect(feed[1].kind).toBe("created");
  });
});

describe("store (demo mode) — inbox scoping", () => {
  it("clearInbox(ids) archives only the given items and unarchive restores them", async () => {
    const a = await store.logActivity({ taskId: "t-a", taskTitle: "A", kind: "created", detail: "one" }, "m-self");
    const b = await store.logActivity({ taskId: "t-b", taskTitle: "B", kind: "created", detail: "two" }, "m-self");
    await store.clearInbox([a.id]);
    let feed = await store.listActivity();
    expect(feed.some((x) => x.id === a.id)).toBe(false);
    expect(feed.some((x) => x.id === b.id)).toBe(true);
    await store.unarchiveActivity([a.id]);
    feed = await store.listActivity();
    expect(feed.some((x) => x.id === a.id)).toBe(true);
  });

  it("your own logged actions are born read", async () => {
    const a = await store.logActivity({ taskId: "t-c", taskTitle: "C", kind: "completed", detail: "done" }, "m-self");
    expect(a.readAt).toBeTruthy();
  });
});

/* ------------------------------------------------------------------
   Offline queue — per-user scoping, cross-tab safety, dead letters
   ------------------------------------------------------------------ */
import { offlineQueue } from "../lib/offlineQueue";
import type { Task } from "./types";

const mkTask = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: "Task " + id, description: "", status: "todo", priority: "medium", projectId: "p-personal",
  assigneeId: "m-self", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 50, ...extra,
});

describe("offlineQueue — scoped to the signed-in user", () => {
  beforeEach(() => { localStorage.clear(); offlineQueue.setUser(null); });

  it("keeps each user's ops under their own key and only shows the current user's", () => {
    offlineQueue.setUser("user-a");
    offlineQueue.enqueueCreate(mkTask("t1"), "user-a");
    offlineQueue.enqueueUpdate("t1", { title: "renamed" }, "user-a");
    expect(offlineQueue.size()).toBe(2);
    expect(localStorage.getItem("kanbo-offline-queue:user-a")).toBeTruthy();

    offlineQueue.setUser("user-b");
    expect(offlineQueue.size()).toBe(0);
    expect(offlineQueue.all()).toEqual([]);
    offlineQueue.enqueueDelete("t9", "user-b");
    expect(offlineQueue.all().every((m) => m.userId === "user-b")).toBe(true);

    offlineQueue.setUser("user-a");
    expect(offlineQueue.all().map((m) => m.kind)).toEqual(["create", "update"]);
    expect(offlineQueue.all().every((m) => m.userId === "user-a")).toBe(true);
  });

  it("re-reads storage before each change, so another tab's queued edits survive", () => {
    offlineQueue.setUser("user-a");
    offlineQueue.enqueueUpdate("t1", { title: "from this tab" }, "user-a");
    // another tab appends straight to storage
    const other = JSON.parse(localStorage.getItem("kanbo-offline-queue:user-a")!);
    other.push({ id: "q-other", ts: Date.now(), kind: "update", taskId: "t2", patch: { priority: "high" }, userId: "user-a" });
    localStorage.setItem("kanbo-offline-queue:user-a", JSON.stringify(other));
    offlineQueue.enqueueUpdate("t3", { status: "done" }, "user-a");
    expect(offlineQueue.all().map((m) => (m.kind === "update" ? m.taskId : ""))).toEqual(["t1", "t2", "t3"]);
  });

  it("ack only clears the fields that were sent, so a mid-flight edit still syncs", () => {
    offlineQueue.setUser("user-a");
    offlineQueue.enqueueUpdate("t1", { title: "v1" }, "user-a");
    const op = offlineQueue.all()[0];
    offlineQueue.enqueueUpdate("t1", { title: "v2", priority: "high" }, "user-a"); // collapsed while "in flight"
    expect(offlineQueue.ack(op.id, { title: "v1" })).toBe(true);
    const left = offlineQueue.all();
    expect(left).toHaveLength(1);
    expect(left[0].kind === "update" && left[0].patch).toEqual({ title: "v2", priority: "high" });
  });

  it("a delete of a create that may have landed still deletes the server row", () => {
    offlineQueue.setUser("user-a");
    offlineQueue.enqueueCreate(mkTask("t-new-1"), "user-a", "11111111-1111-4111-8111-111111111111");
    offlineQueue.enqueueDelete("t-new-1", "user-a");
    const ops = offlineQueue.all();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind === "delete" && ops[0].taskId).toBe("11111111-1111-4111-8111-111111111111");
    // never sent → just dropped
    offlineQueue.enqueueCreate(mkTask("t-new-2"), "user-a");
    offlineQueue.enqueueDelete("t-new-2", "user-a");
    expect(offlineQueue.all()).toHaveLength(1);
  });

  it("dead-letters a failing create together with its later ops, and can retry them", () => {
    offlineQueue.setUser("user-a");
    offlineQueue.enqueueCreate(mkTask("t1"), "user-a");
    offlineQueue.enqueueUpdate("t2", { title: "other task" }, "user-a");
    offlineQueue.enqueueUpdate("t1", { title: "edit" }, "user-a");
    const create = offlineQueue.all()[0];
    offlineQueue.deadLetter(create.id, "violates foreign key");
    expect(offlineQueue.all().map((m) => (m.kind === "update" ? m.taskId : m.kind))).toEqual(["t2"]);
    expect(offlineQueue.deadLetters().map((d) => d.op.kind)).toEqual(["create", "update"]);
    expect(localStorage.getItem("kanbo-offline-deadletter:user-a")).toBeTruthy();
    expect(offlineQueue.retryDeadLetters()).toBe(2);
    expect(offlineQueue.deadLetters()).toEqual([]);
    expect(offlineQueue.size()).toBe(3);
  });

  it("adopts the old shared queue for its owner and never for someone else", () => {
    localStorage.setItem("kanbo-offline-queue", JSON.stringify([
      { id: "q1", ts: 1, kind: "create", task: mkTask("t1"), userId: "user-a" },
      { id: "q2", ts: 2, kind: "update", taskId: "t1", patch: { title: "x" } },
    ]));
    offlineQueue.migrateLegacy("user-a");
    expect(localStorage.getItem("kanbo-offline-queue")).toBeNull();
    offlineQueue.setUser("user-b");
    expect(offlineQueue.size()).toBe(0);
    offlineQueue.setUser("user-a");
    expect(offlineQueue.all().map((m) => m.id)).toEqual(["q1", "q2"]);
  });
});

/* ------------------------------------------------------------------
   Supabase adapter, against a small in-memory fake of the client
   ------------------------------------------------------------------ */
interface FakeCall {
  table: string; op: "select" | "insert" | "upsert" | "update" | "delete" | "rpc";
  payload?: unknown; opts?: Record<string, unknown>; returning?: string; select?: string;
  filters: [string, string, unknown][]; order?: string; orders?: string[]; limit?: number; single?: boolean;
}
type FakeResult = { data?: unknown; error?: { message: string; code?: string } | null };

function makeFake(uid = "user-a") {
  const calls: FakeCall[] = [];
  const invokes: { name: string; body: unknown }[] = [];
  const signCalls: string[][] = [];
  const uploads: { path: string; contentType?: string }[] = [];
  const channels: { topic: string; opts?: unknown; bindings: { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[]; status?: (s: string) => void }[] = [];
  // channels still registered with the client (realtime-js keeps one per topic until it has left)
  const live: { topic: string }[] = [];
  let removeGate: Promise<unknown> | null = null;
  let invokeResult: (name: string, body: unknown) => { data?: unknown; error?: unknown } = () => ({ data: null, error: null });
  let authCb: ((event: string, session: unknown) => void) | null = null;
  const session = { user: { id: uid, email: uid + "@example.com" } };
  let handler: (c: FakeCall) => FakeResult | undefined = () => undefined;
  const defaultResult = (c: FakeCall): FakeResult => (c.op === "select" ? { data: c.single ? null : [] } : { data: c.returning ? [] : null });
  const run = (c: FakeCall) => { calls.push(c); const r = handler(c) ?? defaultResult(c); return { data: r.data ?? null, error: r.error ?? null }; };

  const from = (table: string) => {
    const c: FakeCall = { table, op: "select", filters: [] };
    let started = false;
    const b: Record<string, unknown> = {
      select(cols?: string) { if (!started) { c.select = cols ?? "*"; started = true; } else c.returning = cols ?? "*"; return b; },
      insert(p: unknown) { c.op = "insert"; c.payload = p; started = true; return b; },
      upsert(p: unknown, o?: Record<string, unknown>) { c.op = "upsert"; c.payload = p; c.opts = o; started = true; return b; },
      update(p: unknown) { c.op = "update"; c.payload = p; started = true; return b; },
      delete() { c.op = "delete"; started = true; return b; },
      eq(col: string, v: unknown) { c.filters.push(["eq", col, v]); return b; },
      gt(col: string, v: unknown) { c.filters.push(["gt", col, v]); return b; },
      gte(col: string, v: unknown) { c.filters.push(["gte", col, v]); return b; },
      is(col: string, v: unknown) { c.filters.push(["is", col, v]); return b; },
      in(col: string, v: unknown) { c.filters.push(["in", col, v]); return b; },
      order(col: string) { c.order = col; (c.orders ??= []).push(col); return b; },
      limit(n: number) { c.limit = n; return b; },
      single() { c.single = true; return b; },
      maybeSingle() { c.single = true; return b; },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve().then(() => run(c)).then(res, rej); },
    };
    return b;
  };

  const client = {
    from,
    rpc(name: string, args?: unknown) { return Promise.resolve().then(() => run({ table: "rpc:" + name, op: "rpc", payload: args, filters: [] })); },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange(cb: (event: string, session: unknown) => void) { authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    functions: { invoke: async (name: string, o: { body: unknown }) => { invokes.push({ name, body: o?.body }); const r = invokeResult(name, o?.body); return { data: r.data ?? null, error: r.error ?? null }; } },
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => { signCalls.push(paths); return { data: paths.map((p) => ({ path: p, signedUrl: "https://signed/" + p, error: null })), error: null }; },
        upload: async (path: string, _file: unknown, o?: { contentType?: string }) => { uploads.push({ path, contentType: o?.contentType }); return { data: { path }, error: null }; },
        getPublicUrl: (path: string) => ({ data: { publicUrl: "https://public/" + path } }),
      }),
    },
    channel(topic: string, opts?: unknown) {
      // like realtime-js: a topic still registered (even one that's leaving) is handed back
      const existing = live.find((c) => c.topic === "realtime:" + topic);
      if (existing) return existing;
      const ch = {
        topic: "realtime:" + topic, opts, bindings: [] as { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[], status: undefined as undefined | ((s: string) => void),
        on(type: string, filter: Record<string, unknown>, cb: (p: unknown) => void) { ch.bindings.push({ type, filter, cb }); return ch; },
        subscribe(cb?: (s: string) => void) { ch.status = cb; return ch; },
        presenceState: () => ({}),
        track: async () => "ok",
      };
      channels.push(ch);
      live.push(ch);
      return ch;
    },
    getChannels: () => live.slice(),
    removeChannel: async (ch: { topic: string }) => {
      await removeGate;
      const i = live.indexOf(ch);
      if (i >= 0) live.splice(i, 1);
      return "ok";
    },
  };
  return {
    client, calls, invokes, signCalls, uploads, channels, live, reportError: vi.fn(),
    setHandler(h: (c: FakeCall) => FakeResult | undefined) { handler = h; },
    setInvoke(f: (name: string, body: unknown) => { data?: unknown; error?: unknown }) { invokeResult = f; },
    /** hold every removeChannel until the returned release() is called */
    holdRemovals() { let release = () => {}; removeGate = new Promise((r) => { release = () => { removeGate = null; r(undefined); }; }); return () => release(); },
    fireAuth(event: string, s: unknown) { authCb?.(event, s); },
  };
}

async function loadStore(fake: ReturnType<typeof makeFake>) {
  vi.resetModules();
  vi.doMock("../lib/supabase", () => ({ supabase: fake.client, isSupabaseConfigured: true }));
  vi.doMock("../lib/monitoring", () => ({ reportError: fake.reportError, initMonitoring() {}, setUserContext() {}, monitoringEnabled: false }));
  const mod = await import("./store");
  const q = await import("../lib/offlineQueue");
  return { store: mod.store, getStrippedColumns: mod.getStrippedColumns, queue: q.offlineQueue };
}

const uuidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const taskRow = (id: string) => ({ id, title: "Row " + id, description: "", status: "todo", priority: "medium", project_id: "p-personal", assignee_id: "user-a", due_date: null, original_due_date: null, completed_at: null, tags: [], focus_min: 30, comments: 0, ai_score: 0, ai_reason: null, energy: null, dur: null, scheduled: null, plan_today: false, subtasks: [], task_dependencies: [] });
const selects = (fake: ReturnType<typeof makeFake>, table: string) => fake.calls.filter((c) => c.table === table && c.op === "select");

describe("store (supabase) — complete loads", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

  it("pages through every task (1,000 + 1 rows), not just the first 1,000", async () => {
    const fake = makeFake();
    const server = Array.from({ length: 1001 }, (_, i) => taskRow(uuidN(i)));
    fake.setHandler((c) => {
      if (c.table !== "tasks" || c.op !== "select") return undefined;
      const after = c.filters.find((f) => f[0] === "gt")?.[2] as string | undefined;
      const rows = server.filter((r) => !after || r.id > after);
      return { data: rows.slice(0, Math.min(c.limit ?? 1000, 1000)) }; // PostgREST max-rows
    });
    const { store: s } = await loadStore(fake);
    const b = await s.bootstrap({ id: "user-a" });
    expect(b.tasks).toHaveLength(1001);
    expect(new Set(b.tasks.map((t) => t.id)).size).toBe(1001);
    const pages = selects(fake, "tasks");
    expect(pages).toHaveLength(2);
    expect(pages[0].order).toBe("id");
    expect(pages[1].filters).toContainEqual(["gt", "id", uuidN(999)]);
  });

  it("claims invites once per user per session, not on every reload", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    await s.bootstrap({ id: "user-a" });
    await s.bootstrap({ id: "user-a" });
    expect(fake.calls.filter((c) => c.table === "rpc:claim_invites")).toHaveLength(1);
  });

  it("loads every tag RLS allows (not just the user's own)", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "tags" && c.op === "select" ? { data: [{ id: "tag-1", label: "Client: Acme", color: "red", workspace_id: "ws-1" }] } : undefined));
    const { store: s } = await loadStore(fake);
    const b = await s.bootstrap({ id: "user-a" });
    expect(selects(fake, "tags")[0].filters).toEqual([]);
    expect(b.tags["tag-1"].label).toBe("Client: Acme");
  });

  it("opens in the last-used workspace, else the first team workspace", async () => {
    const fake = makeFake();
    const wsRows = [
      { id: "ws-new", name: "Ops", owner_id: "x", created_at: "2026-09-02T00:00:00Z" },
      { id: "ws-old", name: "Marketing", owner_id: "x", created_at: "2026-01-01T00:00:00Z" },
    ];
    fake.setHandler((c) => (c.table === "workspaces" && c.op === "select" ? { data: wsRows } : undefined));
    const { store: s } = await loadStore(fake);
    expect((await s.bootstrap({ id: "user-a" })).defaultWorkspace).toBe("ws-old");
    localStorage.setItem("kanbo-last-ws:user-a", "ws-new");
    expect((await s.bootstrap({ id: "user-a" })).defaultWorkspace).toBe("ws-new");
    localStorage.setItem("kanbo-last-ws:user-a", "null"); // was last in Personal
    expect((await s.bootstrap({ id: "user-a" })).defaultWorkspace).toBeNull();
    localStorage.setItem("kanbo-last-ws:user-a", "ws-gone"); // no longer a member
    expect((await s.bootstrap({ id: "user-a" })).defaultWorkspace).toBe("ws-old");
  });

  it("lists every unread inbox item plus the newest, merged by id", async () => {
    const fake = makeFake();
    const act = (id: string, t: string, read: boolean) => ({ id, task_id: null, task_title: "x", kind: "mention", detail: "", created_at: t, read_at: read ? t : null });
    fake.setHandler((c) => {
      if (c.table !== "activity" || c.op !== "select") return undefined;
      const unreadOnly = c.filters.some((f) => f[0] === "is" && f[1] === "read_at");
      return { data: unreadOnly ? [act("old-mention", "2026-09-01T00:00:00Z", false), act("n1", "2026-09-30T00:00:00Z", false)] : [act("n1", "2026-09-30T00:00:00Z", false), act("n2", "2026-09-29T00:00:00Z", true)] };
    });
    const { store: s } = await loadStore(fake);
    const feed = await s.listActivity();
    expect(feed.map((a) => a.id)).toEqual(["n1", "n2", "old-mention"]);
  });

  it("Files view: batches task ids, skips unsaved ids, signs in one call, throws on error", async () => {
    const fake = makeFake();
    const ids = Array.from({ length: 250 }, (_, i) => uuidN(i));
    fake.setHandler((c) => {
      if (c.table !== "attachments") return undefined;
      const part = c.filters.find((f) => f[0] === "in")?.[2] as string[];
      return { data: part.slice(0, 1).map((tid) => ({ id: "a-" + tid, task_id: tid, name: "f", size: 1, mime: "text/plain", path: "p/" + tid, created_at: tid })) };
    });
    const { store: s } = await loadStore(fake);
    const files = await s.listProjectAttachments([...ids, "t-new-123"]);
    const q = fake.calls.filter((c) => c.table === "attachments");
    expect(q).toHaveLength(3);
    expect(q.every((c) => (c.filters.find((f) => f[0] === "in")?.[2] as string[]).length <= 100)).toBe(true);
    expect(q.flatMap((c) => c.filters.find((f) => f[0] === "in")?.[2] as string[])).not.toContain("t-new-123");
    expect(fake.signCalls).toHaveLength(1);
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.url?.startsWith("https://signed/"))).toBe(true);
    fake.setHandler((c) => (c.table === "attachments" ? { error: { message: "boom" } } : undefined));
    await expect(s.listProjectAttachments(ids)).rejects.toBeTruthy();
  });
});

describe("store (supabase) — idempotent writes and the offline queue", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

  /** A tasks table that honours ON CONFLICT DO NOTHING. */
  function tasksServer(fake: ReturnType<typeof makeFake>, opts: { loseFirstResponse?: boolean } = {}) {
    const rows = new Map<string, Record<string, unknown>>();
    let lose = !!opts.loseFirstResponse;
    fake.setHandler((c) => {
      if (c.table !== "tasks" || c.op !== "upsert") return undefined;
      const list = (Array.isArray(c.payload) ? c.payload : [c.payload]) as Record<string, unknown>[];
      const inserted = list.filter((r) => !rows.has(r.id as string));
      inserted.forEach((r) => rows.set(r.id as string, r));
      if (lose) { lose = false; return { error: { message: "TypeError: Failed to fetch" } }; } // committed, response lost
      return { data: c.returning ? inserted.map((r) => ({ id: r.id })) : null };
    });
    return rows;
  }

  it("a create whose response was lost is replayed without a duplicate", async () => {
    const fake = makeFake();
    const rows = tasksServer(fake, { loseFirstResponse: true });
    const { store: s, queue } = await loadStore(fake);
    const t = mkTask(uuidN(7));
    const first = await s.createTask(t, "user-a");
    expect(first.id).toBe(t.id);        // kept locally…
    expect(queue.size()).toBe(1);        // …and queued, since the outcome is unknown
    const remap = vi.fn();
    const n = await s.flushQueue(remap);
    expect(n).toBe(1);
    expect(queue.size()).toBe(0);
    expect(rows.size).toBe(1);           // one task on the server, not two
    const upserts = fake.calls.filter((c) => c.table === "tasks" && c.op === "upsert");
    expect(upserts).toHaveLength(2);
    expect(upserts.every((c) => (c.payload as { id: string }).id === t.id)).toBe(true);
    expect(upserts[1].opts).toMatchObject({ onConflict: "id", ignoreDuplicates: true });
    expect(remap).toHaveBeenCalledWith(t.id, t.id, expect.objectContaining({ id: t.id }));
  });

  it("gives a non-UUID optimistic task a real id, and pins it for replays", async () => {
    const fake = makeFake();
    const rows = tasksServer(fake);
    const { store: s } = await loadStore(fake);
    const saved = await s.createTask(mkTask("t-new-1"), "user-a");
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows.has(saved.id)).toBe(true);
  });

  it("replays only the signed-in user's queued ops", async () => {
    const fake = makeFake("user-b");
    tasksServer(fake);
    // user A queued work on this machine, then signed out; B signs in
    localStorage.setItem("kanbo-offline-queue:user-a", JSON.stringify([
      { id: "q1", ts: 1, kind: "create", task: mkTask(uuidN(1)), userId: "user-a" },
      { id: "q2", ts: 2, kind: "delete", taskId: uuidN(2), userId: "user-a" },
    ]));
    const { store: s, queue } = await loadStore(fake);
    expect(await s.flushQueue()).toBe(0);
    expect(fake.calls.filter((c) => c.table === "tasks")).toHaveLength(0);
    expect(queue.currentUser()).toBe("user-b");
    expect(JSON.parse(localStorage.getItem("kanbo-offline-queue:user-a")!)).toHaveLength(2); // still A's, for A
  });

  it("queues a live edit behind older queued edits to the same task", async () => {
    const fake = makeFake();
    const updates: unknown[] = [];
    fake.setHandler((c) => { if (c.table === "tasks" && c.op === "update") updates.push(c.payload); return undefined; });
    const { store: s, queue } = await loadStore(fake);
    queue.setUser("user-a");
    queue.enqueueUpdate(uuidN(3), { priority: "high" }, "user-a"); // stale, from an offline spell
    await s.updateTask(uuidN(3), { priority: "low" });              // newer, made online
    expect(updates).toHaveLength(0);                               // not written ahead of the stale one
    await s.flushQueue();
    expect(updates).toEqual([{ priority: "low" }]);                // collapsed: the newest intent wins
  });

  it("parks an op that keeps failing in the dead-letter list and reports it", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "tasks" && c.op === "upsert" ? { error: { message: "insert or update violates foreign key constraint", code: "23503" } } : undefined));
    const { store: s, queue } = await loadStore(fake);
    queue.setUser("user-a");
    queue.enqueueCreate(mkTask(uuidN(4)), "user-a");
    for (let i = 0; i < 5; i++) await s.flushQueue();
    expect(queue.size()).toBe(0);
    expect(queue.deadLetters()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("kanbo-offline-deadletter:user-a")!)).toHaveLength(1);
    expect(fake.reportError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: "flushQueue-deadletter" }));
  });

  it("createTasksBatch inserts in chunks of 200 with explicit ids and never duplicates", async () => {
    const fake = makeFake();
    const rows = tasksServer(fake);
    const { store: s } = await loadStore(fake);
    const input = Array.from({ length: 450 }, (_, i) => mkTask(uuidN(1000 + i)));
    const saved = await s.createTasksBatch(input, "user-a");
    expect(saved.map((t) => t.id)).toEqual(input.map((t) => t.id));
    const upserts = fake.calls.filter((c) => c.table === "tasks" && c.op === "upsert");
    expect(upserts.map((c) => (c.payload as unknown[]).length)).toEqual([200, 200, 50]);
    expect(upserts[0].opts).toMatchObject({ onConflict: "id", ignoreDuplicates: true, defaultToNull: false });
    await s.createTasksBatch(input, "user-a"); // re-run the same import
    expect(rows.size).toBe(450);
  });

  it("createTasksBatch saves the good rows when one is rejected, and says which failed", async () => {
    const fake = makeFake();
    fake.setHandler((c) => {
      if (c.table !== "tasks" || c.op !== "upsert") return undefined;
      const list = (Array.isArray(c.payload) ? c.payload : [c.payload]) as { title: string }[];
      return list.some((r) => r.title === "bad") ? { error: { message: "new row violates check constraint" } } : { data: c.returning ? [] : null };
    });
    const { store: s } = await loadStore(fake);
    const input = [mkTask(uuidN(1)), mkTask(uuidN(2), { title: "bad" }), mkTask(uuidN(3))];
    const err = await s.createTasksBatch(input, "user-a").then(() => null, (e) => e);
    expect(err?.saved.map((t: Task) => t.id)).toEqual([uuidN(1), uuidN(3)]);
    expect(err?.failed).toHaveLength(1);
    // a message fit to show people; the server's wording stays on .failed
    expect(err?.message).toBe("1 of 3 tasks couldn't be imported. Check they're in a project you can edit and try again.");
    expect(err?.failed[0].message).toMatch(/check constraint/);
  });
});

describe("store (supabase) — inbox, invites, schema drift", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

  it("clearInbox(ids) / markActivityRead(ids) touch only those ids, in URL-safe batches", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    const ids = Array.from({ length: 250 }, (_, i) => uuidN(i));
    await s.clearInbox(ids);
    const archives = fake.calls.filter((c) => c.table === "activity" && c.op === "update");
    expect(archives).toHaveLength(3);
    expect(archives.flatMap((c) => c.filters.find((f) => f[0] === "in")?.[2] as string[])).toEqual(ids);
    expect(archives.every((c) => c.filters.some((f) => f[0] === "is" && f[1] === "archived_at"))).toBe(true);
    fake.calls.length = 0;
    await s.markActivityRead(ids.slice(0, 5));
    const reads = fake.calls.filter((c) => c.table === "activity" && c.op === "update");
    expect(reads).toHaveLength(1);
    expect(reads[0].filters.find((f) => f[0] === "in")?.[2]).toEqual(ids.slice(0, 5));
    fake.calls.length = 0;
    await s.clearInbox(); // no ids: unchanged — everything still active
    const all = fake.calls.filter((c) => c.table === "activity" && c.op === "update");
    expect(all).toHaveLength(1);
    expect(all[0].filters.some((f) => f[0] === "in")).toBe(false);
  });

  it("logs your own activity as read, stripping read_at if the column is missing (reported once)", async () => {
    const fake = makeFake();
    let first = true;
    fake.setHandler((c) => {
      if (c.table !== "activity" || c.op !== "insert") return undefined;
      if (first && "read_at" in (c.payload as object)) { first = false; return { error: { message: "Could not find the 'read_at' column of 'activity' in the schema cache" } }; }
      return { data: { id: "a1", task_id: null, task_title: "x", kind: "created", detail: "", created_at: "2026-09-30T00:00:00Z" } };
    });
    const { store: s, getStrippedColumns } = await loadStore(fake);
    await s.logActivity({ taskId: null, taskTitle: "x", kind: "created", detail: "" }, "user-a");
    const inserts = fake.calls.filter((c) => c.table === "activity" && c.op === "insert");
    expect(inserts).toHaveLength(2);
    expect((inserts[0].payload as Record<string, unknown>).read_at).toBeTruthy();
    expect(getStrippedColumns()).toContain("read_at");
    expect(fake.reportError).toHaveBeenCalledTimes(1);
    expect(fake.reportError.mock.calls[0][1]).toMatchObject({ op: "schema-behind" });
  });

  it("inviteMember surfaces the server's reason and emails the invite best-effort", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "rpc:invite_member" ? { error: { message: "already a member — change their role from the team list" } } : undefined));
    const { store: s } = await loadStore(fake);
    const err = await s.inviteMember("ws-1", "sam@acme.com").then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/already a member/i);
    fake.setHandler((c) => (c.table === "rpc:invite_member" ? { data: { id: "mem-1", workspace_id: "ws-1", user_id: null, email: "sam@acme.com", name: "", role: "member", status: "invited" } } : undefined));
    const m = await s.inviteMember("ws-1", "Sam@Acme.com ");
    expect(m.id).toBe("mem-1");
    await Promise.resolve();
    expect(fake.invokes).toContainEqual({ name: "invite-member", body: { memberId: "mem-1" } });
  });

  it("createTag shares a tag with its workspace", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "tags" && c.op === "insert" ? { data: { id: "tg", label: "Acme", color: "red" } } : undefined));
    const { store: s } = await loadStore(fake);
    await s.createTag("Acme", "red", "user-a", "ws-1");
    expect(fake.calls.find((c) => c.table === "tags" && c.op === "insert")?.payload).toMatchObject({ workspace_id: "ws-1", user_id: "user-a" });
  });
});

describe("store (supabase) — realtime resync and sign-out", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

  it("resyncs after the socket drops and comes back, on 'online', and not after unsubscribe", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    const onChange = vi.fn();
    const unsub = s.subscribeToChanges(onChange);
    const core = fake.channels[0];
    expect(core.bindings.map((b) => b.filter.table)).toEqual(["tasks", "projects", "tags", "subtasks", "workspaces", "workspace_members", "attachments", "activity"]);
    core.status?.("SUBSCRIBED");
    expect(onChange).not.toHaveBeenCalled();
    // team tables ride on their own channel, so they can't break task sync
    const extras = fake.channels[1];
    expect(extras.bindings.filter((b) => b.type === "postgres_changes").map((b) => b.filter.table)).toContain("sections");
    core.status?.("CHANNEL_ERROR");
    core.status?.("SUBSCRIBED");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "resync", reason: "reconnected" });
    window.dispatchEvent(new Event("online"));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "resync", reason: "online" });
    core.bindings[0].cb({ table: "tasks", eventType: "UPDATE", new: { id: "x" }, old: {} });
    expect(onChange).toHaveBeenLastCalledWith({ kind: "row", table: "tasks", event: "UPDATE", row: { id: "x" }, old: null });
    unsub();
    onChange.mockClear();
    window.dispatchEvent(new Event("online"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("drops the team-table channel if the server refuses it (not in the publication), without paging monitoring", async () => {
    const fake = makeFake();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { store: s } = await loadStore(fake);
    s.subscribeToChanges(vi.fn());
    fake.channels[0].status?.("SUBSCRIBED");
    const sys = fake.channels[1].bindings.find((b) => b.type === "system");
    sys?.cb({ extension: "postgres_changes", status: "error", message: "Unable to subscribe to changes with given parameters" });
    // expected until 0042 is live: a console note, not a Sentry event per page load
    expect(fake.reportError).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    fake.channels[0].status?.("CHANNEL_ERROR");
    fake.channels[0].status?.("SUBSCRIBED");
    expect(fake.channels).toHaveLength(2); // not re-requested this session
    info.mockRestore();
  });

  it("on sign-out removes the snapshot and the old shared queue, keeping each user's own queue", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    await s.bootstrap({ id: "user-a" });
    expect(localStorage.getItem("kanbo-offline-snapshot")).toBeTruthy();
    localStorage.setItem("kanbo-offline-queue", JSON.stringify([{ id: "q1", ts: 1, kind: "update", taskId: "t1", patch: { title: "x" } }]));
    fake.fireAuth("SIGNED_OUT", null);
    expect(localStorage.getItem("kanbo-offline-snapshot")).toBeNull();
    expect(localStorage.getItem("kanbo-offline-queue")).toBeNull();
    expect(JSON.parse(localStorage.getItem("kanbo-offline-queue:user-a")!)).toHaveLength(1); // parked with its owner
  });
});

/* ------------------------------------------------------------------
   Review fixes — offline durability, poisoned ops, sign-out race
   ------------------------------------------------------------------ */
describe("store (supabase) — offline queue durability", () => {
  let onLine: ReturnType<typeof vi.spyOn> | null = null;
  const goOffline = () => { onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false); };
  const goOnline = () => { onLine?.mockRestore(); onLine = null; };
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { goOnline(); vi.useRealTimers(); vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

  const updatesSent = (fake: ReturnType<typeof makeFake>) =>
    fake.calls.filter((c) => c.table === "tasks" && c.op === "update").map((c) => c.payload);

  it("queues offline writes at once, even while getSession() is stuck refreshing a token", async () => {
    const fake = makeFake();
    const { store: s, queue } = await loadStore(fake);
    queue.setUser("user-a");
    fake.client.auth.getSession = () => new Promise(() => {}); // never settles (offline refresh retries)
    goOffline();
    void s.createTask(mkTask(uuidN(1)), "user-a");
    void s.updateTask(uuidN(2), { title: "renamed offline" });
    void s.deleteTask(uuidN(3));
    void s.createTasksBatch([mkTask(uuidN(4)), mkTask(uuidN(5))], "user-a");
    // no await: everything is already in the queue and in storage
    expect(queue.size()).toBe(5);
    const stored = JSON.parse(localStorage.getItem("kanbo-offline-queue:user-a")!);
    expect(stored.map((m: { kind: string }) => m.kind)).toEqual(["create", "update", "delete", "create", "create"]);
    expect(stored.every((m: { userId: string }) => m.userId === "user-a")).toBe(true);
  });

  it("an offline unarchive or reopen still clears the field after a trip through storage", async () => {
    const fake = makeFake();
    const { store: s, queue } = await loadStore(fake);
    queue.setUser("user-a");
    goOffline();
    await s.updateTask(uuidN(1), { archivedAt: undefined });                  // unarchive
    await s.updateTask(uuidN(2), { status: "todo", completedAt: undefined }); // reopen
    expect(JSON.parse(localStorage.getItem("kanbo-offline-queue:user-a")!)[0].unset).toEqual(["archivedAt"]);
    goOnline();
    await s.flushQueue();
    expect(updatesSent(fake)).toEqual([{ archived_at: null }, { status: "todo", completed_at: null }]);
    expect(queue.size()).toBe(0);
  });

  it("a live edit never merges into a queued op the server keeps refusing", async () => {
    const fake = makeFake();
    fake.setHandler((c) => {
      if (c.table !== "tasks" || c.op !== "update") return undefined;
      return "section_id" in (c.payload as object) ? { error: { message: "violates foreign key constraint", code: "23503" } } : undefined;
    });
    const { store: s, queue } = await loadStore(fake);
    queue.setUser("user-a");
    queue.enqueueUpdate(uuidN(1), { sectionId: "sec-deleted" }, "user-a");
    await s.flushQueue();                                                  // fails once
    await s.updateTask(uuidN(1), { title: "Renamed while online" });       // queued behind it, not merged
    expect(queue.all().map((m) => m.kind === "update" && m.patch)).toEqual([{ sectionId: "sec-deleted" }, { title: "Renamed while online" }]);
    for (let i = 0; i < 4; i++) await s.flushQueue();                      // 5th failure parks it
    expect(queue.deadLetters().map((d) => d.op.kind === "update" && d.op.patch)).toEqual([{ sectionId: "sec-deleted" }]);
    expect(queue.deadLetters()[0].retryable).toBeFalsy();
    await s.flushQueue();
    expect(updatesSent(fake)).toContainEqual({ title: "Renamed while online" });
    expect(queue.size()).toBe(0);
  });

  it("an edit collapsed into an update while it was in flight is split off when that update fails", async () => {
    const fake = makeFake();
    let queueRef: Awaited<ReturnType<typeof loadStore>>["queue"] | null = null;
    fake.setHandler((c) => {
      if (c.table !== "tasks" || c.op !== "update") return undefined;
      if ("section_id" in (c.payload as object)) {
        queueRef?.enqueueUpdate(uuidN(1), { title: "typed meanwhile" }, "user-a"); // lands mid-flight
        return { error: { message: "violates foreign key constraint", code: "23503" } };
      }
      return undefined;
    });
    const { store: s, queue } = await loadStore(fake);
    queueRef = queue;
    queue.setUser("user-a");
    queue.enqueueUpdate(uuidN(1), { sectionId: "sec-deleted" }, "user-a");
    await s.flushQueue();
    const ops = queue.all();
    expect(ops.map((m) => m.kind === "update" && m.patch)).toEqual([{ sectionId: "sec-deleted" }, { title: "typed meanwhile" }]);
    expect(ops[0].attempts).toBe(1);
    expect(ops[1].attempts).toBeUndefined();
  });

  it("keeps retrying through a server hiccup instead of parking queued work after 30 s", async () => {
    const fake = makeFake();
    let down = true;
    fake.setHandler((c) => (c.table === "tasks" && c.op === "update" && down ? { error: { message: "502 Bad Gateway" } } : undefined));
    const { store: s, queue } = await loadStore(fake);
    queue.setUser("user-a");
    queue.enqueueUpdate(uuidN(1), { title: "saved offline" }, "user-a");
    for (let i = 0; i < 8; i++) { await s.flushQueue(); vi.setSystemTime(Date.now() + 60_000); }
    expect(queue.size()).toBe(1);                       // still queued, still shown
    expect(queue.deadLetters()).toHaveLength(0);
    expect(fake.reportError.mock.calls.filter((c) => c[1]?.op === "flushQueue-retry")).toHaveLength(1); // not one per retry
    vi.setSystemTime(Date.now() + 31 * 60_000);         // failing for over half an hour: park it…
    await s.flushQueue();
    expect(queue.deadLetters()).toHaveLength(1);
    expect(queue.deadLetters()[0].retryable).toBe(true);
    down = false;                                        // …and give it another go next session
    await s.bootstrap({ id: "user-a" });
    expect(queue.deadLetters()).toHaveLength(0);
    await s.flushQueue();
    const sent = updatesSent(fake);
    expect(sent[sent.length - 1]).toEqual({ title: "saved offline" });
    expect(queue.size()).toBe(0);
  });

  it("a parked change never comes back over a newer edit to the same field", async () => {
    const fake = makeFake();
    let down = true;
    fake.setHandler((c) => (c.table === "tasks" && c.op === "update" && down ? { error: { message: "503 Service Unavailable" } } : undefined));
    const { store: s, queue } = await loadStore(fake);
    queue.setUser("user-a");
    queue.enqueueUpdate(uuidN(1), { title: "old", priority: "high" }, "user-a");
    await s.flushQueue();                                          // fails: now retried, not merged into
    await s.updateTask(uuidN(1), { title: "newer" });              // queued behind it
    vi.setSystemTime(Date.now() + 31 * 60_000);
    for (let i = 0; i < 5; i++) await s.flushQueue();              // the old op is parked…
    // …without the title the user has changed since
    expect(queue.deadLetters().map((d) => d.op.kind === "update" && d.op.patch)).toEqual([{ priority: "high" }]);
    down = false;
    await s.flushQueue();
    expect(updatesSent(fake).slice(-1)).toEqual([{ title: "newer" }]);
    await s.updateTask(uuidN(1), { priority: "low" });             // a live edit supersedes the rest
    expect(queue.deadLetters()).toEqual([]);
    await s.bootstrap({ id: "user-a" });                           // so the next session's auto-retry has nothing stale to replay
    expect(queue.size()).toBe(0);
  });

  it("retries later when the session can't be read (token refresh failing while 'online')", async () => {
    const fake = makeFake();
    const { store: s, queue } = await loadStore(fake);
    queue.setUser("user-a");
    queue.enqueueUpdate(uuidN(1), { title: "waiting" }, "user-a");
    const realGetSession = fake.client.auth.getSession;
    fake.client.auth.getSession = async () => ({ data: { session: null as never }, error: null });
    expect(await s.flushQueue()).toBe(0);
    fake.client.auth.getSession = realGetSession;       // refresh recovers
    await vi.advanceTimersByTimeAsync(2_000);            // the store's own retry
    expect(updatesSent(fake)).toEqual([{ title: "waiting" }]);
    expect(queue.size()).toBe(0);
  });

  it("a create whose response is lost hands back its real id, and store-scheduled retries use the registered remap", async () => {
    const fake = makeFake();
    let lose = true;
    fake.setHandler((c) => {
      if (c.table !== "tasks" || c.op !== "upsert") return undefined;
      if (lose) { lose = false; return { error: { message: "TypeError: Failed to fetch" } }; }
      return { data: [{ id: (c.payload as { id: string }).id }] };
    });
    const { store: s, queue } = await loadStore(fake);
    const remap = vi.fn();
    s.setRemapHandler(remap);
    const saved = await s.createTask(mkTask("t-new-1"), "user-a");
    expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);            // swapped in by the caller straight away
    expect(queue.all()[0].kind === "create" && queue.all()[0]).toMatchObject({ task: { id: saved.id }, serverId: saved.id });
    await s.updateTask(saved.id, { title: "edited" });                // queues behind the create
    expect(queue.size()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);                         // store-scheduled retry, no App callback passed
    expect(remap).toHaveBeenCalledWith(saved.id, saved.id, expect.objectContaining({ id: saved.id }));
    expect(queue.size()).toBe(0);
  });

  it("an offline-created task queued under a client id is remapped by a store-scheduled retry", async () => {
    const fake = makeFake();
    let lose = true;
    fake.setHandler((c) => {
      if (c.table !== "tasks" || c.op !== "upsert") return undefined;
      if (lose) { lose = false; return { error: { message: "TypeError: Failed to fetch" } }; }
      return { data: [{ id: (c.payload as { id: string }).id }] };
    });
    const { store: s, queue } = await loadStore(fake);
    queue.setUser("user-a");
    queue.enqueueCreate(mkTask("t-new-9"), "user-a");
    const remap = vi.fn();
    s.setRemapHandler(remap);
    await s.flushQueue();                                              // dropped mid-flight
    await vi.advanceTimersByTimeAsync(2_000);
    expect(remap).toHaveBeenCalledWith("t-new-9", expect.stringMatching(/^[0-9a-f-]{36}$/), expect.anything());
  });

  it("a reload still in flight at sign-out doesn't write the old user's snapshot back", async () => {
    const fake = makeFake();
    let signOutMidLoad = false;
    fake.setHandler((c) => {
      if (signOutMidLoad && c.table === "tasks" && c.op === "select") { signOutMidLoad = false; fake.fireAuth("SIGNED_OUT", null); }
      return undefined;
    });
    const { store: s } = await loadStore(fake);
    await s.bootstrap({ id: "user-a" });
    expect(localStorage.getItem("kanbo-offline-snapshot")).toBeTruthy();
    signOutMidLoad = true;
    await s.bootstrap({ id: "user-a" }); // e.g. a debounced realtime reload
    expect(localStorage.getItem("kanbo-offline-snapshot")).toBeNull();
  });

  it("only one tab replays at a time (navigator.locks)", async () => {
    const fake = makeFake();
    let held = true;
    const request = vi.fn((_name: string, _opts: unknown, cb: (lock: unknown) => Promise<number>) => cb(held ? null : { name: "kanbo-flush" }));
    Object.defineProperty(navigator, "locks", { value: { request }, configurable: true });
    try {
      const { store: s, queue } = await loadStore(fake);
      queue.setUser("user-a");
      queue.enqueueUpdate(uuidN(1), { title: "x" }, "user-a");
      expect(await s.flushQueue()).toBe(0);            // another tab holds the lock and is replaying
      expect(updatesSent(fake)).toHaveLength(0);
      expect(request).toHaveBeenCalledWith("kanbo-flush", { ifAvailable: true }, expect.any(Function));
      held = false;
      expect(await s.flushQueue()).toBe(1);
      expect(updatesSent(fake)).toEqual([{ title: "x" }]);
    } finally {
      delete (navigator as unknown as { locks?: unknown }).locks;
    }
  });
});

/* ------------------------------------------------------------------
   Integration wiring — writes that must stick, honest loads, invites,
   realtime topics, calendar hand-off, AI refusals
   ------------------------------------------------------------------ */
describe("store (supabase) — integration wiring", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

  const upsertsOf = (fake: ReturnType<typeof makeFake>) => fake.calls.filter((c) => c.table === "tasks" && c.op === "upsert");

  it("deleteProject throws when RLS quietly deletes nothing, so the tasks are left alone", async () => {
    const fake = makeFake();
    let allowed = false;
    fake.setHandler((c) => (c.table === "projects" && c.op === "delete" ? { data: allowed ? [{ id: "p1" }] : [] } : undefined));
    const { store: s } = await loadStore(fake);
    await expect(s.deleteProject("p1")).rejects.toThrow(/wasn't deleted/);
    const call = fake.calls.find((c) => c.table === "projects" && c.op === "delete");
    expect(call?.filters).toContainEqual(["eq", "id", "p1"]);
    expect(call?.returning).toBe("id");
    allowed = true;
    await expect(s.deleteProject("p1")).resolves.toBeUndefined();
  });

  it("a new task keeps its completion date, archive date and month-end anchor", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "tasks" && c.op === "upsert" ? { data: [{ id: (c.payload as { id: string }).id }] } : undefined));
    const { store: s } = await loadStore(fake);
    await s.createTask(mkTask(uuidN(1), { status: "done", completedAt: "2026-09-12", archivedAt: "2026-09-20T10:00:00Z", originalDueDate: "2026-01-31" }), "user-a");
    expect(upsertsOf(fake)[0].payload).toMatchObject({ completed_at: "2026-09-12", archived_at: "2026-09-20T10:00:00Z", original_due_date: "2026-01-31" });
    await s.createTask(mkTask(uuidN(2)), "user-a");
    const plain = upsertsOf(fake)[1].payload as Record<string, unknown>;
    expect("completed_at" in plain || "archived_at" in plain || "original_due_date" in plain).toBe(false);
    // and an import sends them too
    await s.createTasksBatch([mkTask(uuidN(3), { status: "done", completedAt: "2026-08-01" })], "user-a");
    expect((upsertsOf(fake)[2].payload as Record<string, unknown>[])[0]).toMatchObject({ completed_at: "2026-08-01" });
  });

  it("a database without archived_at still saves the task, just without it", async () => {
    const fake = makeFake();
    fake.setHandler((c) => {
      if (c.table !== "tasks" || c.op !== "upsert") return undefined;
      if ("archived_at" in (c.payload as object)) return { error: { message: "Could not find the 'archived_at' column of 'tasks' in the schema cache" } };
      return { data: [{ id: (c.payload as { id: string }).id }] };
    });
    const { store: s } = await loadStore(fake);
    const saved = await s.createTask(mkTask(uuidN(4), { archivedAt: "2026-09-20T10:00:00Z", completedAt: "2026-09-19" }), "user-a");
    expect(saved.id).toBe(uuidN(4));
    const last = upsertsOf(fake).slice(-1)[0].payload as Record<string, unknown>;
    expect(last.completed_at).toBe("2026-09-19");
    expect("archived_at" in last).toBe(false);
  });

  it("edits to the month-end anchor are saved, and clearing it clears the column", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    await s.updateTask(uuidN(5), { dueDate: "2026-02-28", originalDueDate: "2026-01-31" });
    await s.updateTask(uuidN(5), { recurrence: "none", originalDueDate: undefined });
    const updates = fake.calls.filter((c) => c.table === "tasks" && c.op === "update").map((c) => c.payload);
    expect(updates).toEqual([{ due_date: "2026-02-28", original_due_date: "2026-01-31" }, { recurrence: "none", original_due_date: null }]);
  });

  it("claims invites before reading the profile, so a just-approved account never sees the waitlist", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    await s.bootstrap({ id: "user-a" });
    const claim = fake.calls.findIndex((c) => c.table === "rpc:claim_invites");
    const profile = fake.calls.findIndex((c) => c.table === "profiles");
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(profile);
  });

  it("a failed projects/workspaces/members/tags query is flagged, not passed off as 'you have none'", async () => {
    const fake = makeFake();
    const good = {
      projects: [{ id: "p-1", name: "Launch", emoji: "🚀", color: "red", workspace_id: "ws-1" }],
      workspaces: [{ id: "ws-1", name: "Ops", owner_id: "user-a", created_at: "2026-01-01T00:00:00Z" }],
      workspace_members: [{ id: "wm-1", workspace_id: "ws-1", user_id: "user-a", email: "a@x.io", name: "A", role: "owner", status: "active" }],
      tags: [{ id: "tag-1", label: "Client", color: "blue" }],
    } as Record<string, unknown[]>;
    let failing = new Set<string>();
    fake.setHandler((c) => {
      if (c.op !== "select" || !(c.table in good)) return undefined;
      return failing.has(c.table) ? { error: { message: "upstream request timeout", code: "57014" } } : { data: good[c.table] };
    });
    const { store: s } = await loadStore(fake);
    const ok = await s.bootstrap({ id: "user-a" });
    expect(ok.partial).toBeUndefined();

    failing = new Set(["projects", "workspaces", "workspace_members", "tags"]);
    const b = await s.bootstrap({ id: "user-a" });
    expect(b.partial).toEqual({ projects: true, workspaces: true, members: true, tags: true });
    // filled from the last good copy on this device rather than emptied
    expect(b.projects.map((p) => p.id)).toContain("p-1");
    expect(b.workspaces.map((w) => w.id)).toContain("ws-1");
    expect(b.members.map((m) => m.id)).toEqual(["wm-1"]);
    expect(b.tags["tag-1"]?.label).toBe("Client");
    expect(fake.reportError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: "bootstrap", part: "projects" }));
    // the cached copy still holds them, and doesn't carry the flag
    const snap = JSON.parse(localStorage.getItem("kanbo-offline-snapshot")!);
    expect(snap.boot.projects.map((p: { id: string }) => p.id)).toContain("p-1");
    expect(snap.boot.partial).toBeUndefined();
  });

  it("a reload keeps what's on screen for each part it couldn't read, and only those", () => {
    const loaded = {
      projects: [{ id: "p-personal" }, { id: "p-old-name" }], tags: { t1: { label: "Snapshot", color: "red" } },
      workspaces: [{ id: "ws-deleted" }], members: [{ id: "wm-snap" }], profile: { id: "user-a", firstName: "Old" },
      tasks: [], partial: { projects: true, profile: true },
    } as unknown as Bootstrap;
    const screen = {
      projects: [{ id: "p-personal" }, { id: "p-renamed" }], tags: { t1: { label: "Now", color: "red" } },
      workspaces: [{ id: "ws-now" }], members: [{ id: "wm-now" }], profile: null,
    } as unknown as Pick<Bootstrap, "projects" | "tags" | "workspaces" | "members" | "profile">;
    const kept = keepOnScreen(loaded, screen);
    expect(kept.projects).toBe(screen.projects);
    expect(kept.profile).toBeNull();                       // a null on screen is still "what's on screen"
    expect(kept.tags).toBe(loaded.tags);                   // these loaded fine, so the server wins
    expect(kept.workspaces).toBe(loaded.workspaces);
    expect(kept.members).toBe(loaded.members);
    // a part the caller doesn't pass stays as loaded; a complete load is untouched
    expect(keepOnScreen({ ...loaded, partial: { tags: true } }, { projects: screen.projects }).tags).toBe(loaded.tags);
    const complete = { ...loaded, partial: undefined };
    expect(keepOnScreen(complete, screen)).toBe(complete);
  });

  it("with no earlier copy, a failed query still boots — flagged, with just the built-ins", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "projects" && c.op === "select" ? { error: { message: "TypeError: Failed to fetch" } } : undefined));
    const { store: s } = await loadStore(fake);
    const b = await s.bootstrap({ id: "user-a" });
    expect(b.partial).toEqual({ projects: true });
    expect(b.projects.map((p) => p.id)).toEqual(["p-personal"]);
  });

  it("the signed-in person gets the lighter default avatar colour", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    await s.bootstrap({ id: "user-a" });
    const data = await import("./data");
    expect(data.getMember("user-a")?.color).toBe(data.SELF_COLOR);
    expect(data.SELF_COLOR).toBe("oklch(0.72 0.14 264)");
  });

  it("orders goals, portfolios, rules and forms on the server so lists don't reshuffle", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    await s.bootstrap({ id: "user-a" });
    const orders = (t: string) => fake.calls.find((c) => c.table === t && c.op === "select")?.orders;
    expect(orders("goals")).toEqual(["position", "created_at"]);
    expect(orders("portfolios")).toEqual(["created_at"]);
    expect(orders("automation_rules")).toEqual(["created_at"]);
    expect(orders("forms")).toEqual(["created_at"]);
  });

  it("attachments carry their current owner, for who may delete them", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "attachments" ? { data: [{ id: "a1", task_id: uuidN(1), user_id: "owner-b", name: "f", size: 1, mime: "text/plain", path: "gone-a/" + uuidN(1) + "/f", created_at: "2026-09-01" }] } : undefined));
    const { store: s } = await loadStore(fake);
    const [a] = await s.listProjectAttachments([uuidN(1)]);
    expect(a.userId).toBe("owner-b");
  });

  describe("invite emails", () => {
    const member = { id: "mem-1", workspace_id: "ws-1", user_id: null, email: "sam@acme.com", name: "", role: "member", status: "invited" };
    const httpError = (status: number, body: unknown) => ({ name: "FunctionsHttpError", context: { status, json: async () => body } });

    it("says whether the invitation email went, and why not", async () => {
      const fake = makeFake();
      fake.setHandler((c) => (c.table === "rpc:invite_member" ? { data: member } : undefined));
      const { store: s } = await loadStore(fake);

      fake.setInvoke(() => ({ data: { ok: true, sent: true } }));
      const m = await s.inviteMember("ws-1", "sam@acme.com");
      expect(m.id).toBe("mem-1");
      expect(m.inviteEmail).toEqual({ sent: true });

      fake.setInvoke(() => ({ data: { ok: true, sent: false, reason: "email_not_configured" } }));
      expect((await s.inviteMember("ws-1", "sam@acme.com")).inviteEmail).toEqual({ sent: false, reason: "email_not_configured" });

      // the invite row is saved even when the inviter is over the hourly limit
      fake.setInvoke(() => ({ error: httpError(429, { reason: "inviter_limit", error: "You've sent a lot of invites this hour.", retryAfter: 1200 }) }));
      const limited = await s.inviteMember("ws-1", "sam@acme.com");
      expect(limited.id).toBe("mem-1");
      expect(limited.inviteEmail).toMatchObject({ sent: false, reason: "inviter_limit", retryAfter: 1200 });

      fake.setInvoke(() => ({ error: httpError(500, { error: "Something went wrong sending that invite." }) }));
      expect((await s.inviteMember("ws-1", "sam@acme.com")).inviteEmail).toMatchObject({ sent: false, reason: "not_sent" });
      expect(fake.reportError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: "sendInviteEmail" }));
    });

    it("words the email result for the inviter: quiet when it went, a next step when it didn't", () => {
      expect(inviteEmailNotice(undefined)).toBeNull();     // demo mode sends none, and says nothing
      expect(inviteEmailNotice({ sent: true })).toBeNull();
      expect(inviteEmailNotice({ sent: false, reason: "throttled", retryAfter: 40 })?.tone).toBe("info");
      expect(inviteEmailNotice({ sent: false, reason: "already_active", message: "already a member" })).toEqual({ tone: "info", text: "They've already joined this workspace, so there's no invite to email." });
      expect(inviteEmailNotice({ sent: false, reason: "email_not_configured" })).toMatchObject({ tone: "error", text: expect.stringMatching(/^Invite saved.*sign-up link/) });
      // the server's own wording for the hourly cap, else a time from retryAfter
      expect(inviteEmailNotice({ sent: false, reason: "inviter_limit", message: "You've sent a lot of invites this hour." })?.text).toBe("You've sent a lot of invites this hour.");
      expect(inviteEmailNotice({ sent: false, reason: "inviter_limit", retryAfter: 1200 })?.text).toMatch(/in about 20 minutes/);
      // a raw server error ("invite not found") is never shown as-is
      expect(inviteEmailNotice({ sent: false, reason: "not_sent", message: "invite not found" })).toEqual({ tone: "error", text: "Invite saved, but the email couldn't be sent. Share the sign-up link or resend it later." });
    });

    it("a resend re-runs the same call and reports a throttle rather than failing", async () => {
      const fake = makeFake();
      fake.setInvoke(() => ({ data: { ok: true, sent: false, reason: "throttled", retryAfter: 40 } }));
      const { store: s } = await loadStore(fake);
      expect(await s.sendInviteEmail("mem-1")).toEqual({ sent: false, reason: "throttled", retryAfter: 40 });
      expect(fake.invokes).toEqual([{ name: "invite-member", body: { memberId: "mem-1" } }]);
      fake.setInvoke(() => ({ error: httpError(409, { ok: false, sent: false, error: "already a member" }) }));
      expect(await s.sendInviteEmail("mem-1")).toMatchObject({ sent: false, reason: "already_active" });
    });
  });

  describe("realtime on a task", () => {
    it("reopening a task's presence waits for the old channel to leave, then joins a fresh one", async () => {
      const fake = makeFake();
      const { store: s } = await loadStore(fake);
      const unsub1 = s.subscribeToTaskPresence("t1", { id: "user-a", name: "A" }, vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.channels).toHaveLength(1);
      const release = fake.holdRemovals();
      unsub1();                                            // still leaving…
      const onSync = vi.fn();
      s.subscribeToTaskPresence("t1", { id: "user-a", name: "A" }, onSync);
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.channels).toHaveLength(1);               // …so nothing is reopened on top of it
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.channels).toHaveLength(2);               // a fresh channel, on the same room
      expect(fake.channels[1]).not.toBe(fake.channels[0]);
      expect(fake.channels[1].topic).toBe("realtime:presence-task-t1");
      expect(fake.live).toEqual([fake.channels[1]]);
      fake.channels[1].bindings.find((b) => b.type === "presence")?.cb({});
      expect(onSync).toHaveBeenCalledWith([]);
    });

    it("closing a task before its presence channel opened never opens it", async () => {
      const fake = makeFake();
      const { store: s } = await loadStore(fake);
      const unsub1 = s.subscribeToTaskPresence("t1", { id: "user-a", name: "A" }, vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      const release = fake.holdRemovals();
      unsub1();
      const unsub2 = s.subscribeToTaskPresence("t1", { id: "user-a", name: "A" }, vi.fn());
      unsub2();                                            // closed again before the old one had gone
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.channels).toHaveLength(1);
      expect(fake.live).toEqual([]);
    });

    it("each comment stream gets its own channel, so a quick reopen can't get a dead one back", async () => {
      const fake = makeFake();
      const { store: s } = await loadStore(fake);
      const unsub = s.subscribeToTaskComments("t1", vi.fn());
      unsub();
      const onInsert = vi.fn();
      s.subscribeToTaskComments("t1", onInsert);
      expect(fake.channels).toHaveLength(2);
      expect(fake.channels[0].topic).not.toBe(fake.channels[1].topic);
      expect(fake.channels[1].bindings[0].filter).toMatchObject({ table: "comments", filter: "task_id=eq.t1" });
      fake.channels[1].bindings[0].cb({ new: { id: "c1", task_id: "t1", user_id: "user-b", author_name: "B", body: "hi", created_at: "2026-09-30" } });
      expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", body: "hi" }));
    });
  });

  it("calendar: the app finishes the handshake only when it asks to", async () => {
    const fake = makeFake();
    fake.client.auth.getSession = async () => ({ data: { session: { user: { id: "user-a" }, access_token: "tok" } as never }, error: null });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.includes("action=finish") ? { ok: true, provider: "google", accountEmail: "a@gmail.com" } : { url: "https://accounts.example/consent" };
      return { ok: true, status: 200, json: async () => body };
    }));
    const { store: s } = await loadStore(fake);
    await s.getCalendarAuthUrl("google");
    expect(urls[0]).toMatch(/action=connect&provider=google$/);
    await s.getCalendarAuthUrl("google", { finishInApp: true });
    expect(urls[1]).toMatch(/action=connect&provider=google&finish=app$/);
    expect(await s.finishCalendarConnect("app:abc/1", "code&x")).toEqual({ provider: "google", accountEmail: "a@gmail.com" });
    expect(urls[2]).toMatch(/action=finish&state=app%3Aabc%2F1&code=code%26x$/);
  });

  it("AI: says why when the daily limit is reached or the account isn't approved", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    fake.setInvoke(() => ({ error: { name: "FunctionsHttpError", context: { status: 429, json: async () => ({ error: "daily_limit", limit: 200, detail: "You've used today's 200 AI requests. They reset at midnight (UK time)." }) } } }));
    expect(await s.aiSummary([], "2026-09-30")).toBeNull();
    expect(s.aiNotice()).toMatch(/today's 200 AI requests/);
    fake.setInvoke(() => ({ error: { name: "FunctionsHttpError", context: { status: 403, json: async () => ({ error: "not_allowed" }) } } }));
    expect(await s.aiBreakdown("Plan launch", "")).toEqual([]);
    expect(s.aiNotice()).toMatch(/awaiting approval/);
    fake.setInvoke(() => ({ error: { name: "FunctionsHttpError", context: { status: 502, json: async () => ({ error: "anthropic_error", detail: "raw upstream text" }) } } }));
    expect((await s.aiPrioritize([], "2026-09-30")).source).toBe("heuristic");
    expect(s.aiNotice()).toBeNull();                        // nothing worth showing: the generic message stands
    fake.setInvoke(() => ({ data: { answer: "Two things are overdue." } }));
    expect(await s.aiAsk("What's overdue?", [], "2026-09-30")).toBe("Two things are overdue.");
    expect(s.aiNotice()).toBeNull();
  });

  it("saving a profile without a photo leaves the saved photo alone", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "profiles" && c.op === "upsert" ? { data: { id: "user-a", first_name: "Ada", last_name: "L", pronouns: "", email: "a@x.io", avatar_url: "https://public/newer.png" } } : undefined));
    const { store: s } = await loadStore(fake);
    const saved = await s.saveProfile("user-a", { firstName: "Ada", lastName: "L", pronouns: "", email: "a@x.io" });
    const up = fake.calls.find((c) => c.table === "profiles" && c.op === "upsert")!.payload as Record<string, unknown>;
    expect("avatar_url" in up).toBe(false);
    expect(saved.avatarUrl).toBe("https://public/newer.png");
    await s.saveProfile("user-a", { firstName: "Ada", lastName: "L", pronouns: "", email: "a@x.io", avatarUrl: null });
    expect(fake.calls.filter((c) => c.table === "profiles" && c.op === "upsert")[1].payload).toMatchObject({ avatar_url: null });
  });

  it("an avatar's file extension follows its type, not its name", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    const url = await s.uploadAvatar("user-a", new File(["x"], "photo.png", { type: "image/jpeg" }));
    expect(fake.uploads[0].path).toMatch(/^user-a\/avatar-\d+\.jpg$/);
    expect(url).toBe("https://public/" + fake.uploads[0].path);
  });
});

describe("store (demo mode) — wiring", () => {
  it("a project made from a template doesn't carry the template id", async () => {
    const p = await store.createProject({ name: "Launch", emoji: "🚀", color: "red", workspaceId: null, templateId: "tpl-launch" }, "m-self");
    expect(p.name).toBe("Launch");
    expect("templateId" in p).toBe(false);
  });
  it("a demo upload belongs to whoever added it", async () => {
    const a = await store.uploadAttachment("t-own", new File(["x"], "a.txt", { type: "text/plain" }), "m-self");
    expect(a.userId).toBe("m-self");
  });
  it("a demo profile save without a photo keeps the photo", async () => {
    await store.saveProfile("m-self", { firstName: "A", lastName: "B", pronouns: "", email: "a@b.c", avatarUrl: "blob:one" });
    const p = await store.saveProfile("m-self", { firstName: "A", lastName: "C", pronouns: "", email: "a@b.c" });
    expect(p.avatarUrl).toBe("blob:one");
    expect(p.lastName).toBe("C");
  });
  it("sends no invitation email without a backend", async () => {
    const m = await store.inviteMember("ws-x", "pat@acme.com");
    expect(m.inviteEmail).toBeUndefined();
    expect(await store.sendInviteEmail(m.id)).toEqual({ sent: false, reason: "email_not_configured" });
  });
});

/* ------------------------------------------------------------------
   The redesign's data: who created a task, the workspace's change
   history (Pulse, Radar) and the AI modes (Ask, notes, standup, status)
   ------------------------------------------------------------------ */
describe("store (supabase) — creator, workspace history and AI modes", () => {
  let onLine: ReturnType<typeof vi.spyOn> | null = null;
  const goOffline = () => { onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false); };
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { onLine?.mockRestore(); onLine = null; vi.useRealTimers(); vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

  const ctx = {
    today: "2026-09-30", me: "user-a",
    members: [{ id: "user-a", name: "Daniel Okai" }, { id: "user-m", name: "Maya Chen" }, { id: "user-t", name: "Theo Park" }],
    projects: [{ id: "p-launch", name: "Q3 Product Launch" }, { id: "p-infra", name: "Platform Infra" }],
  };
  const invokesOf = (fake: ReturnType<typeof makeFake>) => fake.invokes.filter((i) => i.name === "ai-assist").map((i) => i.body as Record<string, unknown>);
  const refusal = (status: number, body: Record<string, unknown>) => ({ context: { status, json: async () => body } });

  it("reads the creator from tasks.user_id", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "tasks" && c.op === "select" ? { data: [{ ...taskRow(uuidN(1)), user_id: "user-m" }, taskRow(uuidN(2))] } : undefined));
    const { store: s } = await loadStore(fake);
    const b = await s.bootstrap({ id: "user-a" });
    expect(b.tasks.find((t) => t.id === uuidN(1))?.createdBy).toBe("user-m");
    expect(b.tasks.find((t) => t.id === uuidN(2))?.createdBy).toBeUndefined();
  });

  it("a new task is created by whoever saves it, even a copy of someone else's", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "tasks" && c.op === "upsert" ? { data: [{ id: uuidN(3) }] } : undefined));
    const { store: s, queue } = await loadStore(fake);
    const saved = await s.createTask(mkTask(uuidN(3), { createdBy: "user-m" }), "m-self");
    expect(saved.createdBy).toBe("user-a");                    // the session's user, not the stale placeholder
    const row = fake.calls.find((c) => c.table === "tasks" && c.op === "upsert")!.payload as Record<string, unknown>;
    expect(row.user_id).toBe("user-a");
    expect("createdBy" in row || "created_by" in row).toBe(false);
    const batch = await s.createTasksBatch([mkTask(uuidN(4)), mkTask(uuidN(5), { createdBy: "user-t" })], "user-a");
    expect(batch.map((t) => t.createdBy)).toEqual(["user-a", "user-a"]);
    // queued offline: the queued copy (what a reload shows) carries it too
    queue.setUser("user-a");
    goOffline();
    const offline = await s.createTask(mkTask(uuidN(6)), "user-a");
    expect(offline.createdBy).toBe("user-a");
    expect(queue.all().find((m) => m.kind === "create")).toMatchObject({ task: { id: uuidN(6), createdBy: "user-a" } });
  });

  it("never writes the creator from an edit", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    await s.updateTask(uuidN(7), { createdBy: "user-m" });
    await s.updateTask(uuidN(7), { createdBy: "user-m", title: "Renamed" });
    const updates = fake.calls.filter((c) => c.table === "tasks" && c.op === "update").map((c) => c.payload);
    expect(updates).toEqual([{ title: "Renamed" }]);
  });

  it("lists a workspace's history since a moment, newest first", async () => {
    const fake = makeFake();
    fake.setHandler((c) => (c.table === "task_events" ? { data: [
      { id: "e1", task_id: uuidN(1), actor_id: "user-m", actor_name: "Maya Chen", field: "status", old_value: "progress", new_value: "done", created_at: "2026-09-30T08:00:00Z", tasks: { workspace_id: "ws-1" } },
      { id: "e2", task_id: uuidN(2), actor_id: null, actor_name: null, field: "due", old_value: "2026-09-29", new_value: "2026-10-02", created_at: "2026-09-29T17:00:00Z", tasks: { workspace_id: "ws-1" } },
    ] } : undefined));
    const { store: s } = await loadStore(fake);
    const events = await s.listWorkspaceEventsSince("ws-1", "2026-09-29T00:00:00.000Z");
    expect(events).toEqual([
      { id: "e1", taskId: uuidN(1), actorId: "user-m", actorName: "Maya Chen", field: "status", oldValue: "progress", newValue: "done", createdAt: "2026-09-30T08:00:00Z" },
      { id: "e2", taskId: uuidN(2), actorId: null, actorName: "Someone", field: "due", oldValue: "2026-09-29", newValue: "2026-10-02", createdAt: "2026-09-29T17:00:00Z" },
    ]);
    const q = fake.calls.find((c) => c.table === "task_events")!;
    expect(q.select).toContain("tasks!inner(workspace_id");
    expect(q.filters).toEqual([["eq", "tasks.workspace_id", "ws-1"], ["gte", "created_at", "2026-09-29T00:00:00.000Z"]]);
    expect(q.order).toBe("created_at");
    expect(q.limit).toBe(500);
  });

  it("Personal history is just your own tasks outside any workspace; errors reject", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    await s.listWorkspaceEventsSince(null, "2026-09-29T00:00:00.000Z", 50);
    const q = fake.calls.find((c) => c.table === "task_events")!;
    expect(q.filters).toEqual([["is", "tasks.workspace_id", null], ["eq", "tasks.user_id", "user-a"], ["gte", "created_at", "2026-09-29T00:00:00.000Z"]]);
    expect(q.limit).toBe(50);
    fake.setHandler((c) => (c.table === "task_events" ? { error: { message: "relation \"task_events\" does not exist", code: "42P01" } } : undefined));
    await expect(s.listWorkspaceEventsSince("ws-1", "2026-09-29T00:00:00.000Z")).rejects.toBeTruthy();
  });

  it("Ask sends up to 300 tasks, most relevant first, with people and projects by name", async () => {
    const fake = makeFake();
    fake.setInvoke(() => ({ data: { answer: "Nothing's overdue.", actions: [], cites: [] } }));
    const { store: s } = await loadStore(fake);
    const theirsLater = mkTask("t-later", { assigneeId: "user-m", projectId: "p-infra", dueDate: "2026-11-20" });
    const mineSoon = mkTask("t-mine", {
      assigneeId: "user-a", projectId: "p-launch", dueDate: "2026-10-01", dueTime: "15:00", startDate: "2026-09-28",
      collaborators: ["user-t"], createdBy: "user-m", description: "  Tighten the story arc,\n\nland the 'why now'. " + "x".repeat(400), dependencies: ["t-later"],
    });
    const theirsSoon = mkTask("t-theirs", { assigneeId: "user-m", projectId: "p-launch", dueDate: "2026-10-02" });
    const unassigned = mkTask("t-nobody", { assigneeId: "", projectId: "p-launch", dueDate: "2026-12-01" });
    const doneRecently = mkTask("t-done", { status: "done", completedAt: "2026-09-28" });
    const doneLongAgo = mkTask("t-old", { status: "done", completedAt: "2026-06-01" });
    const archived = mkTask("t-archived", { archivedAt: "2026-09-01T00:00:00Z" });
    const filler = Array.from({ length: 400 }, (_, i) => mkTask(`t-f${i}`, { assigneeId: "user-t", dueDate: "2027-01-01" }));
    const res = await s.aiCommand("  what's overdue?  ", [doneRecently, theirsLater, unassigned, archived, doneLongAgo, theirsSoon, mineSoon, ...filler], ctx);
    expect(res).toEqual({ data: { answer: "Nothing's overdue.", actions: [], cites: [], source: "ai" }, source: "ai" });
    const [body] = invokesOf(fake);
    expect(body).toMatchObject({ mode: "command", question: "what's overdue?", today: "2026-09-30", me: "Daniel Okai", meId: "user-a", members: ctx.members, projects: ctx.projects });
    const sent = body.tasks as Record<string, unknown>[];
    expect(sent).toHaveLength(300);
    expect(sent.slice(0, 2).map((t) => t.id)).toEqual(["t-mine", "t-theirs"]);
    expect(sent.some((t) => t.id === "t-archived" || t.id === "t-old")).toBe(false);
    expect(sent[0]).toEqual({
      id: "t-mine", title: "Task t-mine", status: "todo", priority: "medium", dueDate: "2026-10-01", dueTime: "15:00", startDate: "2026-09-28",
      assignee: "Daniel Okai", projectName: "Q3 Product Launch", collaborators: ["Theo Park"], createdBy: "Maya Chen",
      description: ("Tighten the story arc, land the 'why now'. " + "x".repeat(400)).slice(0, 200), blockedBy: ["t-later"],
    });
    expect(sent.find((t) => t.id === "t-nobody")).toHaveProperty("assignee", null); // unassigned says so
  });

  it("Ask's proposed changes are checked against what was sent", async () => {
    const fake = makeFake();
    fake.setInvoke(() => ({ data: {
      answer: "Moves 2 tasks to Monday 5 Oct.",
      actions: [
        { op: "update", id: "t-1", patch: { dueDate: "2026-10-05", description: "nope", aiScore: 99 } },
        { op: "update", id: "t-unsent", patch: { dueDate: "2026-10-05" } },
        { op: "update", id: "t-2", patch: { dueDate: null, assigneeId: "user-m", projectId: "p-secret", status: "shipped" } },
        { op: "delete", id: "t-1" },
        { op: "create", task: { title: "Write press release", assigneeId: "stranger", priority: "high" } },
        { op: "create", task: { priority: "high" } },
      ],
      cites: ["t-1", "t-unsent", "t-1"],
      usage: { used: 12, limit: 200 },
    } }));
    const { store: s } = await loadStore(fake);
    const res = await s.aiCommand("move my unstarted tasks this week to monday", [mkTask("t-1", { assigneeId: "user-a" }), mkTask("t-2", { assigneeId: "user-a" })], ctx);
    expect(res.source).toBe("ai");
    if (res.source !== "ai") return;
    expect(res.usage).toEqual({ used: 12, limit: 200 });
    expect(res.data.usage).toEqual({ used: 12, limit: 200 });
    expect(res.data.cites).toEqual(["t-1"]);
    expect(res.data.actions).toEqual([
      { op: "update", id: "t-1", patch: { dueDate: "2026-10-05" } },
      { op: "update", id: "t-2", patch: { dueDate: undefined, assigneeId: "user-m" } },
      { op: "create", task: { title: "Write press release", priority: "high" } },
    ]);
    const clear = res.data.actions[1];
    expect(clear.op === "update" && "dueDate" in clear.patch).toBe(true); // a clear, not a missing field
  });

  it("the daily limit comes back as 'limit' with the server's words; other failures as 'unavailable'", async () => {
    const fake = makeFake();
    fake.setInvoke(() => ({ error: refusal(429, { error: "daily_limit", detail: "You've used today's 200 AI requests. They reset at midnight (UK time)." }) }));
    const { store: s } = await loadStore(fake);
    expect(await s.aiStandup({ done: [] })).toEqual({ data: null, source: "limit", detail: "You've used today's 200 AI requests. They reset at midnight (UK time)." });
    expect(s.aiNotice()).toMatch(/200 AI requests/);
    fake.setInvoke(() => ({ error: refusal(403, { error: "not_allowed" }) }));
    expect(await s.aiStatus({ project: "x" })).toEqual({ data: null, source: "unavailable", detail: "Your account is still awaiting approval, so AI isn't available yet." });
    fake.setInvoke(() => ({ error: refusal(502, { error: "bad_output" }) }));
    expect(await s.aiExtract("Maya to send the brief", { ...ctx, hint: "Launch sync" })).toEqual({ data: null, source: "unavailable" });
    expect(s.aiNotice()).toBeNull();
    fake.setInvoke(() => { throw new Error("boom"); });
    expect(await s.aiCommand("hi", [], ctx)).toEqual({ data: null, source: "unavailable" });
    // an unusable reply is unavailable too
    fake.setInvoke(() => ({ data: { answer: "   " } }));
    expect(await s.aiCommand("hi", [], ctx)).toEqual({ data: null, source: "unavailable" });
  });

  it("offline, or with nothing to ask, it doesn't call at all", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    expect(await s.aiCommand("   ", [], ctx)).toEqual({ data: null, source: "unavailable" });
    expect(await s.aiExtract("", ctx)).toEqual({ data: null, source: "unavailable" });
    goOffline();
    expect(await s.aiCommand("what's overdue?", [], ctx)).toEqual({ data: null, source: "unavailable" });
    expect(await s.aiStandup({ done: [] })).toEqual({ data: null, source: "unavailable" });
    expect(invokesOf(fake)).toHaveLength(0);
  });

  it("before ai-assist is redeployed (it answers as 'prioritise'), stops asking for the session", async () => {
    const fake = makeFake();
    fake.setInvoke(() => ({ data: { items: [], summary: "Nothing open to prioritize." } }));
    const { store: s } = await loadStore(fake);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await s.aiStatus({ project: "Launch" })).toEqual({ data: null, source: "unavailable" });
    expect(await s.aiCommand("what's overdue?", [mkTask("t-1")], ctx)).toEqual({ data: null, source: "unavailable" });
    expect(invokesOf(fake)).toHaveLength(1);
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
    // the original modes are untouched by it
    await s.aiBreakdown("Plan the offsite", "");
    expect(invokesOf(fake)).toHaveLength(2);
  });

  it("notes → tasks: people matched to members, anyone else kept as a name to flag", async () => {
    const fake = makeFake();
    fake.setInvoke(() => ({ data: { tasks: [
      { title: "Send the interview brief", assigneeName: "maya", dueDate: "2026-10-02", dueTime: "15:00", priority: "high" },
      { title: "Book the venue", assigneeName: "Priya", note: "Mentions Priya, who isn't in this workspace." },
      { title: "  ", assigneeName: "Theo Park" },
      { title: "Draft FAQ", dueDate: "2026-02-30", dueTime: "3pm", priority: "asap" },
    ], usage: { used: 3, limit: 200 } } }));
    const { store: s } = await loadStore(fake);
    const res = await s.aiExtract("  Maya to send the brief by Fri 3pm. Priya books the venue. Draft FAQ.  ", { ...ctx, hint: "Launch sync" });
    expect(res).toEqual({ source: "ai", usage: { used: 3, limit: 200 }, data: [
      { title: "Send the interview brief", assigneeId: "user-m", assigneeName: "Maya Chen", dueDate: "2026-10-02", dueTime: "15:00", priority: "high" },
      { title: "Book the venue", assigneeName: "Priya", note: "Mentions Priya, who isn't in this workspace." },
      { title: "Draft FAQ" },
    ] });
    expect(invokesOf(fake)[0]).toMatchObject({ mode: "extract", text: "Maya to send the brief by Fri 3pm. Priya books the venue. Draft FAQ.", hint: "Launch sync", today: "2026-09-30", members: ctx.members, projects: ctx.projects });
    await s.aiExtract("y".repeat(30_000), ctx);
    expect((invokesOf(fake)[1].text as string).length).toBe(20_000);
  });

  it("standup and status drafts", async () => {
    const fake = makeFake();
    fake.setInvoke((_n, body) => ({ data: (body as { mode: string }).mode === "standup"
      ? { text: " Done: tokens shipped.\nIn progress: the deck. ", usage: { used: 4, limit: 200 } }
      : { summary: " The deck is the critical path. ", status: "at_risk" } }));
    const { store: s } = await loadStore(fake);
    expect(await s.aiStandup({ done: [{ who: "Maya", title: "Tokens" }] })).toEqual({ data: "Done: tokens shipped.\nIn progress: the deck.", source: "ai", usage: { used: 4, limit: 200 } });
    expect(await s.aiStatus({ project: "Launch" })).toEqual({ data: { summary: "The deck is the critical path.", status: "at_risk" }, source: "ai" });
    expect(invokesOf(fake)[0]).toMatchObject({ mode: "standup", facts: { done: [{ who: "Maya", title: "Tokens" }] } });
    expect(invokesOf(fake)[0].today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fake.setInvoke(() => ({ data: { summary: "Fine.", status: "great" } }));
    expect(await s.aiStatus({ project: "Launch" })).toEqual({ data: null, source: "unavailable" });
  });

  it("the AI calls work handed around as plain functions (no `this`)", async () => {
    const fake = makeFake();
    fake.setInvoke(() => ({ data: { text: "Done." } }));
    const { store: s } = await loadStore(fake);
    const { aiStandup, aiCommand, listWorkspaceEventsSince } = s;
    expect(await aiStandup({ done: [] })).toMatchObject({ source: "ai", data: "Done." });
    await expect(aiCommand("hi", [], ctx)).resolves.toBeTruthy();
    await expect(listWorkspaceEventsSince("ws-1", "2026-09-29T00:00:00Z")).resolves.toEqual([]);
  });
});

describe("store (demo mode) — the redesign's seed and AI", () => {
  const ctx = { today: "2026-09-30", me: "m-self", members: [{ id: "m-self", name: "Daniel Okai" }], projects: [{ id: "p-launch", name: "Q3 Product Launch" }] };
  afterEach(() => { vi.doUnmock("./data"); });

  /** A demo-mode store over a data module whose redesign seeds are replaced. */
  async function demoStoreWith(seed: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("./data", async (importOriginal) => ({ ...(await importOriginal<typeof import("./data")>()), ...seed }));
    return (await import("./store")).store;
  }
  const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  it("bootstrap returns the seeded goals, portfolios, updates, rules and forms — as copies", async () => {
    const data = await import("./data");
    const b = await store.bootstrap({ id: "m-self" });
    expect(b.goals).toEqual(data.DEMO_GOALS);
    expect(b.portfolios).toEqual(data.DEMO_PORTFOLIOS);
    expect(b.statusUpdates).toEqual(data.DEMO_STATUS_UPDATES);
    expect(b.automationRules).toEqual(data.DEMO_RULES);
    expect(b.forms).toEqual(data.DEMO_FORMS);
    expect(b.goals).not.toBe(data.DEMO_GOALS);

    const goal = { id: "g-1", workspaceId: "ws-foundrise", name: "Launch Q3 on 12 Oct", status: "on_track" };
    const portfolio = { id: "pf-1", workspaceId: "ws-foundrise", name: "Q3 launch", projectIds: ["p-launch", "p-brand"] };
    const rule = { id: "r-1", workspaceId: "ws-foundrise", projectId: "p-launch", name: "Tag bugs for engineering", trigger: "task_created", actions: [{ type: "add_tag", value: "eng" }], enabled: true };
    const s = await demoStoreWith({
      DEMO_GOALS: [goal], DEMO_PORTFOLIOS: [portfolio], DEMO_RULES: [rule],
      DEMO_STATUS_UPDATES: [{ id: "su-1", workspaceId: "ws-foundrise", projectId: "p-launch", summary: "Deck is the critical path.", status: "at_risk", createdAt: ago(9 * 24) }],
      DEMO_FORMS: [{ id: "f-1", workspaceId: "ws-foundrise", projectId: "p-launch", name: "Launch requests", fields: ["description", "priority", "dueDate"] }],
    });
    const first = await s.bootstrap({ id: "m-self" });
    expect(first.goals).toEqual([goal]);
    expect(first.portfolios).toEqual([portfolio]);
    expect(first.automationRules).toEqual([rule]);
    expect(first.statusUpdates.map((u) => u.id)).toEqual(["su-1"]);
    expect(first.forms[0].fields).toEqual(["description", "priority", "dueDate"]);
    // the app changing its copy never reaches the seed or the next load
    first.portfolios[0].projectIds.push("p-infra");
    first.automationRules[0].actions.length = 0;
    const second = await s.bootstrap({ id: "m-self" });
    expect(second.portfolios[0].projectIds).toEqual(["p-launch", "p-brand"]);
    expect(second.automationRules[0].actions).toHaveLength(1);
    expect(portfolio.projectIds).toEqual(["p-launch", "p-brand"]);
  });

  it("the inbox is seeded once, newest first, and what you clear stays cleared", async () => {
    const act = (id: string, h: number, read = false) => ({ id, taskId: "t-1", taskTitle: "Finalise Q3 launch narrative deck", kind: "comment", detail: "Theo Vance", createdAt: ago(h), ...(read ? { readAt: ago(h) } : {}) });
    const seed = [act("a-old", 30, true), act("a-new", 1), act("a-mid", 5)];
    const s = await demoStoreWith({ DEMO_ACTIVITY: seed });
    await s.logActivity({ taskId: "t-2", taskTitle: "Ship onboarding", kind: "created", detail: "Task created" }, "m-self");
    await s.bootstrap({ id: "m-self" });
    let feed = await s.listActivity();
    expect(feed.map((a) => a.id).slice(1)).toEqual(["a-new", "a-mid", "a-old"]);
    expect(feed[0].kind).toBe("created");                  // logged just now, kept
    await s.clearInbox(["a-new"]);
    await s.bootstrap({ id: "m-self" });                   // a reload doesn't bring it back
    feed = await s.listActivity();
    expect(feed.some((a) => a.id === "a-new")).toBe(false);
    expect(feed.filter((a) => a.id === "a-mid")).toHaveLength(1);
    expect(seed[1]).not.toHaveProperty("archivedAt");       // the seed itself is untouched
  });

  it("the workspace history filters by time and by the task's workspace", async () => {
    const ev = (id: string, taskId: string, h: number) => ({ id, taskId, actorId: "m-1", actorName: "Maya Lin", field: "status", oldValue: "progress", newValue: "done", createdAt: ago(h) });
    // t-1 is in Q3 Product Launch (Foundrise), t-3 in Growth Experiments (Reco HQ), t-5 in Personal
    const s = await demoStoreWith({ DEMO_TASK_EVENTS: [ev("e-old", "t-1", 72), ev("e-1", "t-1", 20), ev("e-2", "t-1", 2), ev("e-reco", "t-3", 3), ev("e-me", "t-5", 4), ev("e-ghost", "t-nope", 1)] });
    const since = ago(48);
    expect((await s.listWorkspaceEventsSince("ws-foundrise", since)).map((e) => e.id)).toEqual(["e-2", "e-1"]);
    expect((await s.listWorkspaceEventsSince("ws-reco", since)).map((e) => e.id)).toEqual(["e-reco"]);
    expect((await s.listWorkspaceEventsSince(null, since)).map((e) => e.id)).toEqual(["e-me"]);
    expect((await s.listWorkspaceEventsSince("ws-foundrise", since, 1)).map((e) => e.id)).toEqual(["e-2"]);
    expect((await s.listWorkspaceEventsSince("ws-foundrise", ago(96))).map((e) => e.id)).toEqual(["e-2", "e-1", "e-old"]);
    // a task's own history (the task panel's "Moved 2×") comes from the same seed
    const slips = await s.listTaskEvents("t-1");
    expect(slips.map((e) => e.id)).toEqual(["e-2", "e-1", "e-old"]);
    expect(slips[0]).toEqual({ id: "e-2", actorName: "Maya Lin", field: "status", oldValue: "progress", newValue: "done", createdAt: expect.any(String) });
  });

  it("the AI modes are unavailable, so every caller uses its on-device rules", async () => {
    expect(await store.aiCommand("what's overdue?", [], ctx)).toEqual({ data: null, source: "unavailable" });
    expect(await store.aiExtract("Maya to send the brief by Fri", ctx)).toEqual({ data: null, source: "unavailable" });
    expect(await store.aiStandup({ done: [] })).toEqual({ data: null, source: "unavailable" });
    expect(await store.aiStatus({ project: "Launch" })).toEqual({ data: null, source: "unavailable" });
  });

  it("a task made in the demo is created by you", async () => {
    const t = await store.createTask(mkTask("t-demo-new", { createdBy: "m-2" }), "m-self");
    expect(t.createdBy).toBe("m-self");
    expect((await store.createTasksBatch([mkTask("t-demo-a")], "m-self"))[0].createdBy).toBe("m-self");
  });
});
