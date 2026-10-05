/* The store's half of "plans that follow you" (task_user_state, 0043), against
   a small in-memory fake of the Supabase client: loading and merging, the
   missing-table fallback, routing personal plan writes (collaborators,
   guests, assignees), the offline queue, and realtime. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task } from "./types";

interface Call { table: string; op: string; payload?: unknown; opts?: Record<string, unknown>; filters: [string, string, unknown][]; order?: string; limit?: number; single?: boolean }
type Result = { data?: unknown; error?: { message: string; code?: string } | null } | "throw-network";

function makeFake(uid = "user-a") {
  const calls: Call[] = [];
  const channels: { topic: string; bindings: { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[]; status?: (s: string) => void }[] = [];
  let handler: (c: Call) => Result | undefined = () => undefined;
  let authCb: ((e: string, s: unknown) => void) | null = null;
  const session = { user: { id: uid, email: uid + "@example.com" } };
  const run = (c: Call) => {
    calls.push(c);
    const r = handler(c);
    if (r === "throw-network") throw new TypeError("Failed to fetch");
    const res = r ?? (c.op === "select" ? { data: c.single ? null : [] } : { data: null });
    return { data: res.data ?? null, error: res.error ?? null };
  };
  const from = (table: string) => {
    const c: Call = { table, op: "select", filters: [] };
    const b: Record<string, unknown> = {
      select() { return b; },
      insert(p: unknown) { c.op = "insert"; c.payload = p; return b; },
      upsert(p: unknown, o?: Record<string, unknown>) { c.op = "upsert"; c.payload = p; c.opts = o; return b; },
      update(p: unknown) { c.op = "update"; c.payload = p; return b; },
      delete() { c.op = "delete"; return b; },
      eq(col: string, v: unknown) { c.filters.push(["eq", col, v]); return b; },
      gt(col: string, v: unknown) { c.filters.push(["gt", col, v]); return b; },
      in(col: string, v: unknown) { c.filters.push(["in", col, v]); return b; },
      is(col: string, v: unknown) { c.filters.push(["is", col, v]); return b; },
      gte(col: string, v: unknown) { c.filters.push(["gte", col, v]); return b; },
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
      onAuthStateChange(cb: (e: string, s: unknown) => void) { authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({}) },
    channel(topic: string) {
      const ch = {
        topic: "realtime:" + topic, bindings: [] as { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[], status: undefined as undefined | ((s: string) => void),
        on(type: string, filter: Record<string, unknown>, cb: (p: unknown) => void) { ch.bindings.push({ type, filter, cb }); return ch; },
        subscribe(cb?: (s: string) => void) { ch.status = cb; return ch; },
      };
      channels.push(ch);
      return ch;
    },
    getChannels: () => [],
    removeChannel: async () => "ok",
  };
  return {
    client, calls, channels, reportError: vi.fn(),
    setHandler(h: (c: Call) => Result | undefined) { handler = h; },
    fireAuth(e: string, s: unknown) { authCb?.(e, s); },
  };
}
type Fake = ReturnType<typeof makeFake>;

async function load(fake: Fake) {
  vi.resetModules();
  vi.doMock("../lib/supabase", () => ({ supabase: fake.client, isSupabaseConfigured: true }));
  vi.doMock("../lib/monitoring", () => ({ reportError: fake.reportError, initMonitoring() {}, setUserContext() {}, monitoringEnabled: false }));
  const store = (await import("./store")).store;
  const overlay = await import("../lib/planOverlay");
  const plans = await import("./planState");
  const data = await import("./data");
  const { offlineQueue } = await import("../lib/offlineQueue");
  return { store, overlay, plans, today: data.todayISO(), queue: offlineQueue };
}

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const taskRow = (id: string, o: Record<string, unknown> = {}) => ({ id, title: "Row " + id, description: "", status: "todo", priority: "medium", project_id: "p1", assignee_id: "user-a", due_date: null, original_due_date: null, completed_at: null, tags: [], focus_min: 30, comments: 0, ai_score: 0, ai_reason: null, energy: null, dur: null, scheduled: null, plan_today: false, workspace_id: "ws-1", subtasks: [], task_dependencies: [], ...o });
const upserts = (fake: Fake) => fake.calls.filter((c) => c.table === "task_user_state" && c.op === "upsert");
/** Let the debounced save run, and wait for it to finish (flushPlans hands back the one in flight). */
const flushTimers = async (store?: { flushPlans(): Promise<void> }) => { await vi.runOnlyPendingTimersAsync(); await store?.flushPlans(); };

describe("store — plans that follow you (task_user_state)", () => {
  let onLine: ReturnType<typeof vi.spyOn> | null = null;
  const goOffline = () => { onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false); };
  const goOnline = () => { onLine?.mockRestore(); onLine = null; };
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { goOnline(); vi.useRealTimers(); vi.doUnmock("../lib/supabase"); vi.doUnmock("../lib/monitoring"); });

  function server(fake: Fake, opts: { tasks?: Record<string, unknown>[]; plans?: Record<string, unknown>[]; planError?: { message: string; code?: string }; upsert?: (c: Call) => Result | undefined } = {}) {
    fake.setHandler((c) => {
      if (c.table === "tasks" && c.op === "select") return { data: opts.tasks ?? [] };
      if (c.table === "task_user_state" && c.op === "select") return opts.planError ? { error: opts.planError } : { data: opts.plans ?? [] };
      if (c.table === "task_user_state" && c.op === "upsert") return opts.upsert?.(c);
      return undefined;
    });
  }

  it("loads the caller's rows (their own only, paged) and fills their plan into their own tasks", async () => {
    const fake = makeFake();
    const { store, today } = await load(fake);
    server(fake, {
      tasks: [taskRow(U(1)), taskRow(U(2), { assignee_id: "bob" }), taskRow(U(3), { plan_today: true, scheduled: 480 })],
      plans: [
        { task_id: U(1), user_id: "user-a", plan_today: true, scheduled: 600, plan_day: today, my_section_id: "sec-1" },
        { task_id: U(2), user_id: "user-a", plan_today: true, plan_day: today },
        { task_id: U(3), user_id: "user-a", plan_today: false, scheduled: 900, plan_day: today },
      ],
    });
    const b = await store.bootstrap({ id: "user-a" });
    const q = fake.calls.find((c) => c.table === "task_user_state" && c.op === "select")!;
    expect(q.filters).toContainEqual(["eq", "user_id", "user-a"]);
    expect(q.order).toBe("task_id");
    const byId = new Map(b.tasks.map((t) => [t.id, t]));
    expect(byId.get(U(1))).toMatchObject({ planToday: true, scheduled: 600, mySectionId: "sec-1" }); // handed to them: their plan carries
    expect(byId.get(U(2))).toMatchObject({ planToday: false, scheduled: null });                      // a teammate's row stays theirs
    expect(byId.get(U(3))).toMatchObject({ planToday: true, scheduled: 480 });                        // the row's own plan wins
  });

  it("before 0043 the missing table changes nothing: plans stay on the device, no errors, no writes", async () => {
    const fake = makeFake();
    const { store, overlay, plans, today } = await load(fake);
    server(fake, { tasks: [taskRow(U(2), { assignee_id: "bob" })], planError: { message: "Could not find the table 'public.task_user_state' in the schema cache", code: "PGRST205" } });
    const b = await store.bootstrap({ id: "user-a" });
    expect(plans.planMode("user-a")).toBe("local");
    expect(fake.reportError).not.toHaveBeenCalled();
    overlay.writePlanOverlay("user-a", today, U(2), { planToday: true });
    await store.updateTask(U(1), { planToday: true }); // an assignee's own plan: the row, as always
    await flushTimers(store);
    expect(upserts(fake)).toEqual([]);
    expect(overlay.withOverlay(b.tasks, "user-a", today)[0].planToday).toBe(true); // from this device
    // a reload doesn't ask again (and log another 404) for a while
    await store.bootstrap({ id: "user-a" });
    expect(fake.calls.filter((c) => c.table === "task_user_state")).toHaveLength(1);
    // and the Postgres wording of the same thing
    const fake2 = makeFake();
    const s2 = await load(fake2);
    server(fake2, { planError: { message: 'relation "public.task_user_state" does not exist', code: "42P01" } });
    await s2.store.bootstrap({ id: "user-a" });
    expect(s2.plans.planMode("user-a")).toBe("local");
    expect(fake2.reportError).not.toHaveBeenCalled();
  });

  it("a load that can't read the rows keeps the device's last copy", async () => {
    const fake = makeFake();
    const { store, plans, today } = await load(fake);
    server(fake, { plans: [{ task_id: U(5), user_id: "user-a", plan_today: true, plan_day: today }] });
    await store.bootstrap({ id: "user-a" });
    plans.__resetPlanStateForTests();
    server(fake, { planError: { message: "upstream timeout", code: "57014" } });
    await store.bootstrap({ id: "user-a" });
    expect(plans.planMode("user-a")).toBe("server");
    expect(plans.planEntry(U(5))).toMatchObject({ planToday: true });
  });

  it("a collaborator's plan on a teammate's task is upserted to their own row, never the task", async () => {
    const fake = makeFake();
    const { store, overlay, today } = await load(fake);
    server(fake, { tasks: [taskRow(U(2), { assignee_id: "bob" })] });
    await store.bootstrap({ id: "user-a" });
    overlay.writePlanOverlay("user-a", today, U(2), { planToday: true });
    overlay.writePlanOverlay("user-a", today, U(2), { scheduled: 630 });
    expect(upserts(fake)).toHaveLength(0); // batched: one save shortly after
    await flushTimers(store);
    const [u] = upserts(fake);
    expect(u.opts).toEqual({ onConflict: "task_id,user_id" });
    expect(u.payload).toEqual([{ task_id: U(2), user_id: "user-a", plan_today: true, plan_day: today, scheduled: 630 }]);
    expect(fake.calls.filter((c) => c.table === "tasks" && c.op === "update")).toEqual([]);
  });

  it("a guest's plan goes the same way (it's theirs, not the task's; the server checks they can see it)", async () => {
    const fake = makeFake("guest-1");
    const { store, overlay, plans } = await load(fake);
    server(fake, { tasks: [taskRow(U(7), { assignee_id: "owner-1" })] });
    await store.bootstrap({ id: "guest-1" });
    overlay.writeSectionOverlay("guest-1", U(7), "my-sec");
    await flushTimers(store);
    expect(upserts(fake)[0].payload).toEqual([{ task_id: U(7), user_id: "guest-1", my_section_id: "my-sec" }]);
    expect(plans.pendingPlans()).toEqual([]);
  });

  it("writes of different shapes go in separate upserts, so none nulls out another's columns", async () => {
    const fake = makeFake();
    const { store, overlay, today } = await load(fake);
    server(fake);
    await store.bootstrap({ id: "user-a" });
    overlay.writeSectionOverlay("user-a", U(1), "s1");
    overlay.writeSectionOverlay("user-a", U(2), "s2");
    overlay.writeScoreOverlay("user-a", U(3), { aiScore: 71.6, aiReason: "Due soon" });
    overlay.writePlanOverlay("user-a", today, U(4), { planToday: false });
    await flushTimers(store);
    const sent = upserts(fake).map((c) => c.payload as Record<string, unknown>[]);
    expect(sent).toHaveLength(3);
    for (const rows of sent) {
      const keys = new Set(rows.map((r) => Object.keys(r).sort().join(",")));
      expect(keys.size).toBe(1);
    }
    expect(sent.flat()).toContainEqual({ task_id: U(3), user_id: "user-a", ai_score: 72, ai_reason: "Due soon" });
    expect(sent.flat()).toContainEqual({ task_id: U(4), user_id: "user-a", plan_today: false, plan_day: today, scheduled: null });
  });

  it("an assignee's own plan is mirrored to their row (so a task handed back keeps it), and a hand-off leaves it alone", async () => {
    const fake = makeFake();
    const { store, today } = await load(fake);
    server(fake, { tasks: [taskRow(U(1))] });
    await store.bootstrap({ id: "user-a" });
    await store.updateTask(U(1), { planToday: true, scheduled: 540 });
    await store.updateTask(U(1), { title: "Just a rename" });
    await store.updateTask(U(2), { assigneeId: "bob", planToday: false, scheduled: null }); // handed on: theirs now
    await store.updateTask(U(3), { assigneeId: "user-a", planToday: false, scheduled: null, mySectionId: undefined }); // taken: the clears were the last assignee's
    await store.updateTask(U(4), { assigneeId: "user-a", planToday: true });
    await flushTimers(store);
    expect(fake.calls.filter((c) => c.table === "tasks" && c.op === "update").map((c) => c.payload)).toContainEqual({ plan_today: true, scheduled: 540 });
    const rows = upserts(fake).flatMap((c) => c.payload as Record<string, unknown>[]);
    expect(rows).toContainEqual({ task_id: U(1), user_id: "user-a", plan_today: true, scheduled: 540, plan_day: today });
    expect(rows.find((r) => r.task_id === U(2))).toBeUndefined();
    expect(rows.find((r) => r.task_id === U(3))).toBeUndefined();
    expect(rows).toContainEqual({ task_id: U(4), user_id: "user-a", plan_today: true, plan_day: today, scheduled: null });
  });

  it("offline: kept on the device and shown, then saved when back online", async () => {
    // (its own account: earlier tests' store copies still listen for "online")
    const fake = makeFake("user-off");
    const { store, overlay, plans, today } = await load(fake);
    server(fake, { tasks: [taskRow(U(2), { assignee_id: "bob" })] });
    const b = await store.bootstrap({ id: "user-off" });
    goOffline();
    overlay.writePlanOverlay("user-off", today, U(2), { planToday: true });
    await flushTimers(store);
    expect(upserts(fake)).toHaveLength(0);
    expect(overlay.withOverlay(b.tasks, "user-off", today)[0].planToday).toBe(true);
    expect(JSON.parse(localStorage.getItem("kanbo-plan-pending:user-off")!)[U(2)].patch).toMatchObject({ planToday: true });
    // an offline reload still shows it
    plans.__resetPlanStateForTests();
    const again = await store.bootstrap({ id: "user-off" });
    expect(overlay.withOverlay(again.tasks, "user-off", today)[0].planToday).toBe(true);
    goOnline();
    window.dispatchEvent(new Event("online"));
    await flushTimers(store);
    expect(upserts(fake)).toHaveLength(1);
    expect(plans.pendingPlans()).toEqual([]);
  });

  it("a network drop mid-save keeps the write and tries again", async () => {
    const fake = makeFake();
    let drop = true;
    const { store, overlay, plans, today } = await load(fake);
    server(fake, { upsert: () => (drop ? "throw-network" : undefined) });
    await store.bootstrap({ id: "user-a" });
    overlay.writePlanOverlay("user-a", today, U(2), { planToday: true });
    await flushTimers(store);
    expect(plans.pendingPlans()).toHaveLength(1);
    drop = false;
    await flushTimers(store); // the retry, backed off
    expect(plans.pendingPlans()).toEqual([]);
    expect(upserts(fake).length).toBeGreaterThanOrEqual(2);
  });

  it("waits behind a queued create of its task, and follows it to its saved id", async () => {
    const fake = makeFake();
    const { store, overlay, plans, queue, today } = await load(fake);
    server(fake);
    await store.bootstrap({ id: "user-a" });
    const t: Task = { id: "t-new-1", title: "Made offline", description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "bob", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 50 };
    queue.enqueueCreate(t, "user-a");
    overlay.writePlanOverlay("user-a", today, "t-new-1", { planToday: true });
    await flushTimers(store);
    expect(upserts(fake)).toHaveLength(0); // its task isn't saved yet
    await store.flushQueue();             // the create lands under a real id
    await flushTimers(store);
    const saved = fake.calls.find((c) => c.table === "tasks" && c.op === "upsert")!.payload as { id: string };
    expect(plans.planEntry("t-new-1")).toBeUndefined();
    expect(upserts(fake).flatMap((c) => c.payload as Record<string, unknown>[])).toEqual([{ task_id: saved.id, user_id: "user-a", plan_today: true, plan_day: today, scheduled: null }]);
  });

  it("a write the server keeps refusing (a task gone or out of reach) is dropped after a few tries", async () => {
    const fake = makeFake();
    const { store, overlay, plans } = await load(fake);
    server(fake, { upsert: () => ({ error: { message: "new row violates row-level security policy", code: "42501" } }) });
    await store.bootstrap({ id: "user-a" });
    overlay.writeSectionOverlay("user-a", U(9), "s");
    for (let i = 0; i < 3; i++) await store.flushPlans();
    expect(plans.pendingPlans()).toEqual([]);
    expect(fake.reportError).toHaveBeenCalledTimes(1);
  });

  it("one bad row doesn't sink the batch: the rest are saved row by row", async () => {
    const fake = makeFake();
    const { store, overlay, plans } = await load(fake);
    server(fake, { upsert: (c) => ((c.payload as { task_id: string }[]).some((r) => r.task_id === U(8)) ? { error: { message: "violates foreign key constraint", code: "23503" } } : undefined) });
    await store.bootstrap({ id: "user-a" });
    overlay.writeSectionOverlay("user-a", U(7), "a");
    overlay.writeSectionOverlay("user-a", U(8), "b");
    await store.flushPlans();
    expect(plans.pendingPlans().map((p) => p.taskId)).toEqual([U(8)]);
    expect(upserts(fake).map((c) => (c.payload as unknown[]).length)).toEqual([2, 1, 1]);
  });

  it("a column the database doesn't have yet is stripped and the rest saved", async () => {
    const fake = makeFake();
    const { store, overlay, plans, today } = await load(fake);
    server(fake, { upsert: (c) => ((c.payload as Record<string, unknown>[])[0] && "plan_day" in (c.payload as Record<string, unknown>[])[0] ? { error: { message: "Could not find the 'plan_day' column of 'task_user_state' in the schema cache", code: "PGRST204" } } : undefined) });
    await store.bootstrap({ id: "user-a" });
    overlay.writePlanOverlay("user-a", today, U(2), { planToday: true });
    await store.flushPlans();
    expect(upserts(fake).map((c) => Object.keys((c.payload as Record<string, unknown>[])[0]).sort())).toEqual([
      ["plan_day", "plan_today", "scheduled", "task_id", "user_id"], ["plan_today", "scheduled", "task_id", "user_id"],
    ]);
    expect(plans.pendingPlans()).toEqual([]);
  });

  it("the table vanishing mid-session sends plans back to the device without losing the write", async () => {
    const fake = makeFake();
    const { store, overlay, plans, today } = await load(fake);
    server(fake, { upsert: () => ({ error: { message: "relation \"public.task_user_state\" does not exist", code: "42P01" } }) });
    await store.bootstrap({ id: "user-a" });
    overlay.writePlanOverlay("user-a", today, U(2), { planToday: true });
    await store.flushPlans();
    expect(plans.planMode("user-a")).toBe("local");
    expect(JSON.parse(localStorage.getItem("kanbo-plan-pending:user-a")!)[U(2)]).toBeTruthy();
  });

  it("realtime: listens to the caller's own rows on a channel of its own; only another device's change reloads", async () => {
    const fake = makeFake();
    const { store, overlay, plans, today } = await load(fake);
    server(fake);
    const onChange = vi.fn();
    store.subscribeToChanges(onChange);
    fake.channels[0].status?.("SUBSCRIBED"); // before the plans are loaded: nothing to listen to yet
    expect(fake.channels.some((c) => c.bindings.some((b) => b.filter.table === "task_user_state"))).toBe(false);
    await store.bootstrap({ id: "user-a" });
    const ch = fake.channels.find((c) => c.bindings.some((b) => b.filter.table === "task_user_state"))!;
    expect(ch).toBeTruthy();
    expect(ch.bindings[0].filter).toMatchObject({ table: "task_user_state", filter: "user_id=eq.user-a" });
    expect(fake.channels[0].bindings.some((b) => b.filter.table === "task_user_state")).toBe(false); // never on the core channel
    overlay.writeSectionOverlay("user-a", U(2), "s");
    await store.flushPlans();
    ch.bindings[0].cb({ table: "task_user_state", eventType: "UPDATE", new: { task_id: U(2), user_id: "user-a", my_section_id: "s" }, old: {} });
    expect(onChange).not.toHaveBeenCalled(); // our own echo
    ch.bindings[0].cb({ table: "task_user_state", eventType: "INSERT", new: { task_id: U(3), user_id: "user-a", plan_today: true, plan_day: today }, old: {} });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "row", table: "task_user_state" }));
    expect(plans.planEntry(U(3))).toMatchObject({ planToday: true });
    // not in the publication yet: a console note, the channel closes, tasks keep syncing
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    ch.bindings.find((b) => b.type === "system")!.cb({ extension: "postgres_changes", status: "error", message: "nope" });
    expect(fake.reportError).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it("sign-out clears the plan cache from this device and stops saving", async () => {
    const fake = makeFake();
    const { store, overlay, plans, today } = await load(fake);
    server(fake);
    await store.bootstrap({ id: "user-a" });
    expect(localStorage.getItem("kanbo-plan-state:user-a")).toBeTruthy();
    goOffline();
    overlay.writePlanOverlay("user-a", today, U(2), { planToday: true });
    fake.fireAuth("SIGNED_OUT", null);
    expect(localStorage.getItem("kanbo-plan-state:user-a")).toBeNull();
    expect(plans.planMode()).toBe("local");
    goOnline();
    await store.flushPlans();
    expect(upserts(fake)).toEqual([]);
    expect(localStorage.getItem("kanbo-plan-pending:user-a")).toBeTruthy(); // theirs, for next time
  });
});

describe("store — team templates", () => {
  it("templateDeps works in demo mode: objects come back for the caller's state", async () => {
    vi.resetModules();
    vi.doUnmock("../lib/supabase");
    const { store } = await import("./store");
    const { applyWorkspacePlan, buildWorkspaceFromTemplate, findWorkspaceTemplate } = await import("../lib/templates");
    const plan = buildWorkspaceFromTemplate(findWorkspaceTemplate("marketing")!, "2026-10-05");
    const r = await applyWorkspacePlan(plan, { workspaceId: "ws-foundrise", assigneeId: "m-self" }, store.templateDeps("m-self"));
    expect(r.failed).toEqual([]);
    expect(r.projects.map((p) => p.name)).toEqual(["Campaigns", "Content calendar", "Creative requests"]);
    expect(r.projects[0].description).toBe("Plan, launch and report on each campaign.");
    expect(r.tasks).toHaveLength(21);
    expect(r.tasks.every((t) => t.createdBy === "m-self" && t.workspaceId === "ws-foundrise")).toBe(true);
    expect(r.forms[0]).toMatchObject({ name: "Creative request", description: expect.stringContaining("Ask for a design") });
    expect(r.rules[0].actions[0]).toEqual({ type: "set_section", value: r.sections.find((s) => s.name === "Ideas")!.id });
  });

  it("templateDeps with Supabase: a form keeps its description; a project's description is saved after it", async () => {
    const fake = makeFake();
    fake.setHandler((c) => {
      if (c.op === "insert" && c.table === "projects") return { data: { id: "p-new", name: (c.payload as { name: string }).name, emoji: "x", color: "c", workspace_id: "ws-1" } };
      if (c.op === "insert" && c.table === "forms") return { data: { id: "f-new", workspace_id: "ws-1", project_id: "p-new", name: "F", description: (c.payload as { description?: string }).description ?? null, fields: [] } };
      return undefined;
    });
    const { store } = await load(fake);
    const deps = store.templateDeps("user-a");
    const p = await deps.createProject({ name: "Campaigns", emoji: "📣", color: "c", workspaceId: "ws-1", description: "Plan it." });
    expect(p.description).toBe("Plan it.");
    expect(fake.calls.find((c) => c.table === "projects" && c.op === "update")?.payload).toEqual({ description: "Plan it." });
    const f = await deps.createForm!({ workspaceId: "ws-1", projectId: "p-new", name: "F", fields: [], description: "Ask us." });
    expect(f.description).toBe("Ask us.");
    expect((fake.calls.find((c) => c.table === "forms")!.payload as Record<string, unknown>).description).toBe("Ask us.");
    await deps.createForm!({ workspaceId: "ws-1", projectId: "p-new", name: "G", fields: [] });
    expect(fake.calls.filter((c) => c.table === "forms")[1].payload).not.toHaveProperty("description");
  });
});
