/* lib/notifyPrefs against a (mocked) real backend: merge_notify_prefs, the
   notification_snoozes reads and writes (own rows, upsert on the primary
   key), realtime, and the failures the Inbox falls back on. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, from, channel, removeChannel, getSession, invoke } = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), channel: vi.fn(), removeChannel: vi.fn(async (..._a: unknown[]) => "ok"), invoke: vi.fn(),
  getSession: vi.fn(async () => ({ data: { session: { user: { id: "u-1" } } } })),
}));
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (...a: unknown[]) => from(...a),
    channel: (...a: unknown[]) => channel(...a),
    removeChannel: (...a: unknown[]) => removeChannel(...a),
    auth: { getSession: () => getSession() },
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
  },
  isSupabaseConfigured: true,
}));

import {
  listSnoozes, mergeNotifyPrefs, rescheduleHeldNotices, saveNotifyPrefsChange, snoozeFailure, snoozeThread, subscribeSnoozes, touchesTiming, unsnoozeThread,
} from "./notifyPrefs";

/** a PostgREST-ish builder that records its calls and resolves to `result` */
function table(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = { calls };
  for (const k of ["select", "eq", "gt", "order", "limit", "upsert", "delete", "single"]) q[k] = vi.fn((...a: unknown[]) => { calls.push([k, a]); return q; });
  (q as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q as typeof q & { calls: [string, unknown[]][] };
}
const ROW = { task_id: "5b2484e9-79b1-4e86-9488-dc2b6a68e0ee", until: "2026-10-10T08:00:00+00:00", created_at: "2026-10-09T09:00:00+00:00" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  rpc.mockReset(); from.mockReset(); channel.mockReset(); removeChannel.mockClear();
});

describe("prefs", () => {
  it("merge_notify_prefs with the patch; answers what's stored", async () => {
    rpc.mockResolvedValue({ data: { delivery: "digest", comment_email: false }, error: null });
    expect(await mergeNotifyPrefs({ delivery: "digest" })).toEqual({ delivery: "digest", comment_email: false });
    expect(rpc).toHaveBeenCalledWith("merge_notify_prefs", { p_patch: { delivery: "digest" } });
  });
  it("Settings' whole prefs object: only what changed is sent (a key gone is null); nothing changed, nothing sent", async () => {
    const whole = vi.fn(async () => undefined);
    rpc.mockResolvedValue({ data: { delivery: "digest" }, error: null });
    const stored = await saveNotifyPrefsChange({ delivery: "each", comment_email: false }, { delivery: "digest" }, whole);
    expect(rpc).toHaveBeenCalledWith("merge_notify_prefs", { p_patch: { delivery: "digest", comment_email: null } });
    expect(stored).toEqual({ delivery: "digest" });
    rpc.mockClear();
    expect(await saveNotifyPrefsChange({ delivery: "digest" }, { delivery: "digest" }, whole)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(whole).not.toHaveBeenCalled();
  });
  it("a database without merge_notify_prefs (before 0048) saves the whole object instead; other failures surface", async () => {
    const whole = vi.fn(async () => undefined);
    rpc.mockResolvedValue({ data: null, error: { message: "Could not find the function public.merge_notify_prefs", code: "PGRST202" } });
    expect(await saveNotifyPrefsChange({}, { delivery: "digest" }, whole)).toBeNull();
    expect(whole).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValue({ data: null, error: { message: "not authorized", code: "P0001" } });
    await expect(saveNotifyPrefsChange({}, { delivery: "each" }, whole)).rejects.toMatchObject({ message: "not authorized" });
    expect(whole).toHaveBeenCalledTimes(1);
  });
  it("a refusal surfaces", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "not authorized", code: "P0001" } });
    await expect(mergeNotifyPrefs({ delivery: "digest" })).rejects.toMatchObject({ message: "not authorized" });
  });
  it("after a change to when things may go, asks notify to plan what's held again (best-effort)", async () => {
    expect([touchesTiming({ quiet_hours: null }), touchesTiming({ timezone: "Asia/Tokyo" }), touchesTiming({ delivery: "digest" })]).toEqual([true, true, true]);
    expect([touchesTiming({ bundle: false }), touchesTiming({ comment_email: false }), touchesTiming({ digest_time: "07:00" })]).toEqual([false, false, false]);
    invoke.mockResolvedValueOnce({ data: { ok: true, moved: 2 }, error: null });
    await rescheduleHeldNotices();
    expect(invoke).toHaveBeenCalledWith("notify", { body: { kind: "replan" } });
    invoke.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(rescheduleHeldNotices()).resolves.toBeUndefined();
  });
});

describe("snoozes", () => {
  it("lists running ones (until > now), soonest first; all includes ended ones", async () => {
    const q = table({ data: [ROW, { junk: 1 }], error: null });
    from.mockReturnValue(q);
    expect(await listSnoozes()).toEqual([{ taskId: ROW.task_id, until: ROW.until, createdAt: ROW.created_at }]);
    expect(from).toHaveBeenCalledWith("notification_snoozes");
    expect(q.calls).toEqual([
      ["select", ["task_id,until,created_at"]], ["gt", ["until", "2026-10-09T09:00:00.000Z"]],
      ["order", ["until", { ascending: true }]], ["limit", [1000]],
    ]);
    const all = table({ data: [], error: null });
    from.mockReturnValue(all);
    await listSnoozes({ all: true });
    expect(all.calls.map((c) => c[0])).toEqual(["select", "order", "limit"]);
  });

  it("upserts your own row on (user_id, task_id)", async () => {
    const q = table({ data: ROW, error: null });
    from.mockReturnValue(q);
    const s = await snoozeThread(ROW.task_id, new Date("2026-10-10T08:00:00Z"));
    expect(s.taskId).toBe(ROW.task_id);
    expect(q.calls[0]).toEqual(["upsert", [{ user_id: "u-1", task_id: ROW.task_id, until: "2026-10-10T08:00:00.000Z" }, { onConflict: "user_id,task_id" }]]);
  });

  it("deletes only your own row", async () => {
    const q = table({ data: null, error: null });
    from.mockReturnValue(q);
    await unsnoozeThread(ROW.task_id);
    expect(q.calls).toEqual([["delete", []], ["eq", ["task_id", ROW.task_id]], ["eq", ["user_id", "u-1"]]]);
  });

  it("signed out: refuses before writing", async () => {
    getSession.mockResolvedValueOnce({ data: { session: null } } as never);
    await expect(snoozeThread(ROW.task_id, new Date("2026-10-10T08:00:00Z"))).rejects.toThrow("sign in required");
    expect(from).not.toHaveBeenCalled();
  });

  it("0048 not run yet: the error says unavailable (the Inbox keeps per-device snoozes)", async () => {
    from.mockReturnValue(table({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.notification_snoozes' in the schema cache" } }));
    const err = await listSnoozes().catch((e) => e);
    expect(snoozeFailure(err)).toBe("unavailable");
  });

  it("realtime on your rows; unsubscribe removes the channel", () => {
    const ch: Record<string, unknown> = {};
    ch.on = vi.fn(() => ch);
    ch.subscribe = vi.fn(() => ch);
    channel.mockReturnValue(ch);
    const seen = vi.fn();
    const off = subscribeSnoozes("u-1", seen);
    expect(ch.on).toHaveBeenCalledWith("postgres_changes",
      { event: "*", schema: "public", table: "notification_snoozes", filter: "user_id=eq.u-1" }, expect.any(Function));
    ((ch.on as ReturnType<typeof vi.fn>).mock.calls[0][2] as () => void)();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    expect(removeChannel).toHaveBeenCalledWith(ch);
  });
});
