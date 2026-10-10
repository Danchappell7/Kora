/* lib/momentum against a (mocked) real backend: the kudos table read, give_kudos /
   take_back_kudos, the best-effort notify call, realtime — and how each fails (0048 not
   run, refusals, offline). Fixtures are the JSON 0048 returned in the PGlite replay. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, invoke, from, channel, removeChannel } = vi.hoisted(() => ({
  rpc: vi.fn(), invoke: vi.fn(), from: vi.fn(), channel: vi.fn(), removeChannel: vi.fn(async (..._a: unknown[]) => "ok"),
}));
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    from: (...a: unknown[]) => from(...a),
    channel: (...a: unknown[]) => channel(...a),
    removeChannel: (...a: unknown[]) => removeChannel(...a),
  },
  isSupabaseConfigured: true,
}));

import { giveKudos, KUDOS_COLUMNS, kudosFailure, listKudos, readPlannedDays, resetKudosDemo, subscribeKudos, takeBackKudos } from "./momentum";

const GIVE_KUDOS = { "id": "f7fb9ef1-c395-4077-97c2-3405baa5b9e6", "note": "Great work", "emoji": "👏", "task_id": "610f3019-387f-44ec-9c9e-50613b791fe6", "to_name": "Sana Rao", "to_user": "a89a2412-b64a-49e4-bb75-10dc9466bba2", "from_name": "Theo Hart", "from_user": "56709045-a8fa-42c1-8c2b-80f424fe596e", "created_at": "2026-10-09T17:41:31.698+00:00", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0" };
const KUDOS_ROW = { "id": "f7fb9ef1-c395-4077-97c2-3405baa5b9e6", "task_id": "610f3019-387f-44ec-9c9e-50613b791fe6", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0", "from_user": "56709045-a8fa-42c1-8c2b-80f424fe596e", "to_user": "a89a2412-b64a-49e4-bb75-10dc9466bba2", "emoji": "👏", "note": "Great work", "created_at": "2026-10-09T17:41:31.698Z" };
const WS = KUDOS_ROW.workspace_id, TASK = KUDOS_ROW.task_id;
const ok = (data: unknown) => ({ data, error: null });
const pgErr = (message: string, code = "P0001") => ({ data: null, error: { message, code, details: null, hint: null } });

/** a PostgREST-ish query builder that records its calls and resolves to `result` */
function table(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = { calls };
  for (const k of ["select", "eq", "in", "gte", "order", "limit"]) q[k] = vi.fn((...a: unknown[]) => { calls.push([k, a]); return q; });
  (q as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q as typeof q & { calls: [string, unknown[]][] };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  resetKudosDemo({ demoDelayMs: 0 });
  rpc.mockReset(); invoke.mockReset(); from.mockReset(); channel.mockReset(); removeChannel.mockClear();
  invoke.mockResolvedValue({ data: { ok: true }, error: null });
  localStorage.clear();
});

describe("reading", () => {
  it("a workspace's kudos (since, some tasks), newest first; bad rows dropped", async () => {
    const q = table(ok([KUDOS_ROW, { ...KUDOS_ROW, id: "x", to_user: null }]));
    from.mockReturnValue(q);
    const list = await listKudos(WS, { since: "2026-10-05T00:00:00.000Z", taskIds: [TASK] });
    expect(from).toHaveBeenCalledWith("kudos");
    expect(q.calls).toEqual([
      ["select", [KUDOS_COLUMNS]], ["eq", ["workspace_id", WS]], ["gte", ["created_at", "2026-10-05T00:00:00.000Z"]],
      ["in", ["task_id", [TASK]]], ["order", ["created_at", { ascending: false }]], ["limit", [1000]],
    ]);
    expect(list).toEqual([{ id: KUDOS_ROW.id, taskId: TASK, workspaceId: WS, fromUser: KUDOS_ROW.from_user, toUser: KUDOS_ROW.to_user, emoji: "👏", note: "Great work", createdAt: KUDOS_ROW.created_at }]);
  });
  it("Personal, or no tasks asked for: nothing, and no call", async () => {
    expect(await listKudos("")).toEqual([]);
    expect(await listKudos(WS, { taskIds: [] })).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
  it("before 0048: [] and no more asking this session", async () => {
    from.mockReturnValue(table(pgErr("Could not find the table 'public.kudos' in the schema cache", "PGRST205")));
    expect(await listKudos(WS)).toEqual([]);
    expect(await listKudos(WS)).toEqual([]);
    expect(from).toHaveBeenCalledTimes(1);
    // and subscribing binds no channel
    subscribeKudos(WS, () => undefined)();
    expect(channel).not.toHaveBeenCalled();
  });
  it("other errors are thrown for the caller to explain", async () => {
    from.mockReturnValue(table(pgErr("permission denied for table kudos", "42501")));
    await expect(listKudos(WS)).rejects.toMatchObject({ message: "permission denied for table kudos" });
  });
  it("never seeds a real account's planned days", () => {
    expect(readPlannedDays("m-self")).toEqual([]);
  });
});

describe("giving and taking back", () => {
  it("give_kudos with the emoji, the trimmed note and the recipient; then notify (best-effort)", async () => {
    rpc.mockResolvedValue(ok(GIVE_KUDOS));
    const k = await giveKudos(TASK, "👏", "  Great work  ", null);
    expect(rpc).toHaveBeenCalledWith("give_kudos", { p_task: TASK, p_emoji: "👏", p_note: "Great work", p_to: null });
    expect(k).toMatchObject({ id: GIVE_KUDOS.id, fromName: "Theo Hart", toName: "Sana Rao", emoji: "👏" });
    expect(invoke).toHaveBeenCalledWith("notify", { body: { kind: "kudos", kudosId: GIVE_KUDOS.id } });
  });
  it("a failed notify never fails the kudos", async () => {
    rpc.mockResolvedValue(ok(GIVE_KUDOS));
    invoke.mockRejectedValue(new Error("not deployed"));
    await expect(giveKudos(TASK)).resolves.toMatchObject({ id: GIVE_KUDOS.id });
  });
  it("checks emoji and note before asking", async () => {
    await expect(giveKudos(TASK, "💩" as never)).rejects.toThrow("invalid emoji");
    await expect(giveKudos(TASK, "🎉", "x".repeat(141))).rejects.toThrow("invalid note");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("the server's refusals come back as KudosFailure", async () => {
    for (const [msg, reason] of [["task not done", "not_done"], ["kudos need a team task", "team_only"], ["not for yourself", "self"],
      ["too many kudos", "too_many"], ["invalid recipient", "invalid"], ["not authorized", "not_allowed"], ["task not found", "not_found"]] as const) {
      rpc.mockResolvedValueOnce(pgErr(msg));
      const e = await giveKudos(TASK).catch((x) => x);
      expect(kudosFailure(e)).toBe(reason);
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it("before 0048: unavailable, and it stops asking", async () => {
    rpc.mockResolvedValue(pgErr("Could not find the function public.give_kudos(p_emoji, p_note, p_task, p_to) in the schema cache", "PGRST202"));
    expect(kudosFailure(await giveKudos(TASK).catch((x) => x))).toBe("unavailable");
    expect(kudosFailure(await takeBackKudos(TASK).catch((x) => x))).toBe("unavailable");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("take_back_kudos answers whether there was one", async () => {
    rpc.mockResolvedValueOnce(ok(true)).mockResolvedValueOnce(ok(false));
    expect(await takeBackKudos(TASK)).toBe(true);
    expect(await takeBackKudos(TASK)).toBe(false);
    expect(rpc).toHaveBeenCalledWith("take_back_kudos", { p_task: TASK });
  });
  it("offline: a network failure", async () => {
    rpc.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(kudosFailure(await giveKudos(TASK).catch((x) => x))).toBe("network");
  });
});

describe("realtime", () => {
  it("inserts in the workspace and any delete; unsubscribing removes the channel", () => {
    const handlers: [Record<string, unknown>, () => void][] = [];
    const ch = { on: vi.fn((_e: string, f: Record<string, unknown>, h: () => void) => { handlers.push([f, h]); return ch; }), subscribe: vi.fn(() => ch) };
    channel.mockReturnValue(ch);
    const heard = vi.fn();
    const off = subscribeKudos(WS, heard);
    expect(handlers.map(([f]) => f)).toEqual([
      { event: "INSERT", schema: "public", table: "kudos", filter: `workspace_id=eq.${WS}` },
      { event: "DELETE", schema: "public", table: "kudos" },
    ]);
    handlers[0][1](); handlers[1][1]();
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    expect(removeChannel).toHaveBeenCalledWith(ch);
  });
  it("Personal: nothing to follow", () => {
    subscribeKudos("", () => undefined)();
    expect(channel).not.toHaveBeenCalled();
  });
});
