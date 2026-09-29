import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { store } from "./store";

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
  filters: [string, string, unknown][]; order?: string; limit?: number; single?: boolean;
}
type FakeResult = { data?: unknown; error?: { message: string; code?: string } | null };

function makeFake(uid = "user-a") {
  const calls: FakeCall[] = [];
  const invokes: { name: string; body: unknown }[] = [];
  const signCalls: string[][] = [];
  const channels: { topic: string; bindings: { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[]; status?: (s: string) => void }[] = [];
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
      is(col: string, v: unknown) { c.filters.push(["is", col, v]); return b; },
      in(col: string, v: unknown) { c.filters.push(["in", col, v]); return b; },
      order(col: string) { c.order = col; return b; },
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
    functions: { invoke: async (name: string, o: { body: unknown }) => { invokes.push({ name, body: o?.body }); return { data: null, error: null }; } },
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => { signCalls.push(paths); return { data: paths.map((p) => ({ path: p, signedUrl: "https://signed/" + p, error: null })), error: null }; },
      }),
    },
    channel(topic: string) {
      const ch = {
        topic, bindings: [] as { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[], status: undefined as undefined | ((s: string) => void),
        on(type: string, filter: Record<string, unknown>, cb: (p: unknown) => void) { ch.bindings.push({ type, filter, cb }); return ch; },
        subscribe(cb?: (s: string) => void) { ch.status = cb; return ch; },
      };
      channels.push(ch);
      return ch;
    },
    removeChannel: async () => "ok",
  };
  return {
    client, calls, invokes, signCalls, channels, reportError: vi.fn(),
    setHandler(h: (c: FakeCall) => FakeResult | undefined) { handler = h; },
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

  it("drops the team-table channel if the server refuses it (not in the publication)", async () => {
    const fake = makeFake();
    const { store: s } = await loadStore(fake);
    s.subscribeToChanges(vi.fn());
    fake.channels[0].status?.("SUBSCRIBED");
    const sys = fake.channels[1].bindings.find((b) => b.type === "system");
    sys?.cb({ extension: "postgres_changes", status: "error", message: "Unable to subscribe to changes with given parameters" });
    expect(fake.reportError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: "realtime-extras" }));
    fake.channels[0].status?.("CHANNEL_ERROR");
    fake.channels[0].status?.("SUBSCRIBED");
    expect(fake.channels).toHaveLength(2); // not re-requested this session
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
