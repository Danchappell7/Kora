/* lib/trash against a (mocked) real backend: the bin's reads, the 0047
   definer functions, chunking, Undo after a delete reached the server, and
   every way they fail — 0047 not run, offline, refusals. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
  isSupabaseConfigured: true,
}));

import {
  findTrashForItems, listTrash, purgeTrash, restoreDeletedItems, restoreFromTrash, restoreTrashItems, trashFailure, trashFailureText,
  TRASH_BULK_MAX, TRASH_COLUMNS, TRASH_LIST_MAX,
} from "./trash";

const WS = "851dadfe-dfce-497d-bf03-4e4a1394ad30";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROW = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(1000 + n), kind: "task", item_id: uuid(n), workspace_id: WS, user_id: uuid(9), project_id: uuid(7), title: `Task ${n}`,
  summary: { counts: { tasks: 1 }, project: { id: uuid(7), name: "Launch", emoji: "🚀", color: "oklch(0.6 0.1 200)" }, parent: null, status: "todo", archived: false },
  deleted_by: uuid(9), deleted_by_name: "Sana Rao", deleted_at: `2026-10-0${n % 9 + 1}T10:00:00.123456+00:00`, purge_after: "2026-11-08T10:00:00+00:00",
  restored_at: null, restored_by: null, ...extra,
});
const RESULT = (n: number, extra: Record<string, unknown> = {}) => ({ id: uuid(1000 + n), kind: "task", item_id: uuid(n), status: "restored", project_id: uuid(7), note: null, counts: { tasks: 1 }, ...extra });

/** a PostgREST-ish builder that records its calls and resolves to `result` */
function table(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = { calls };
  for (const k of ["select", "eq", "in", "is", "order", "limit", "or", "gte", "lt"]) q[k] = vi.fn((...a: unknown[]) => { calls.push([k, a]); return q; });
  (q as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q as Record<string, unknown> & { calls: [string, unknown[]][] };
}

beforeEach(() => { rpc.mockReset(); from.mockReset(); });

describe("listTrash", () => {
  it("reads a workspace's unrestored rows, newest first, never the snapshot", async () => {
    const q = table({ data: [ROW(1), ROW(2), { nonsense: true }], error: null });
    from.mockReturnValue(q);
    const items = await listTrash(WS);
    expect(from).toHaveBeenCalledWith("trash");
    expect(q.calls).toEqual([
      ["select", [TRASH_COLUMNS]],
      ["is", ["restored_at", null]],
      ["eq", ["workspace_id", WS]],
      ["order", ["deleted_at", { ascending: false }]],
      ["order", ["id", { ascending: false }]],
      ["limit", [TRASH_LIST_MAX]],
    ]);
    expect(items.map((t) => t.title)).toEqual(["Task 1", "Task 2"]);
    expect(items[0]).toMatchObject({ kind: "task", itemId: uuid(1), deletedByName: "Sana Rao", summary: { project: { name: "Launch" } } });
  });
  it("Personal: the rows with no workspace (RLS keeps them to yours)", async () => {
    const q = table({ data: [], error: null });
    from.mockReturnValue(q);
    await listTrash(null);
    expect(q.calls).toContainEqual(["is", ["workspace_id", null]]);
    expect(q.calls.some(([k, a]) => k === "eq" && a[0] === "workspace_id")).toBe(false);
  });
  it("before 0047 the bin is 'unavailable', whichever way PostgREST says the table is missing", async () => {
    for (const error of [
      { code: "PGRST205", message: "Could not find the table 'public.trash' in the schema cache" },
      { code: "42P01", message: 'relation "public.trash" does not exist' },
    ]) {
      from.mockReturnValue(table({ data: null, error }));
      const e = await listTrash(WS).catch((x) => x);
      expect(trashFailure(e)).toBe("unavailable");
    }
    from.mockReturnValue(table({ data: null, error: { message: "TypeError: Failed to fetch" } }));
    expect(trashFailure(await listTrash(WS).catch((x) => x))).toBe("network");
  });
});

describe("findTrashForItems (Undo after the delete went out)", () => {
  it("maps each item to its newest unrestored bin row, skipping ids that were never on the server", async () => {
    const q = table({ data: [
      { id: "bin-new", item_id: uuid(1), deleted_at: "2026-10-09T10:00:00Z" },
      { id: "bin-old", item_id: uuid(1), deleted_at: "2026-10-01T10:00:00Z" },
      { id: "bin-2", item_id: uuid(2), deleted_at: "2026-10-08T10:00:00Z" },
    ], error: null });
    from.mockReturnValue(q);
    expect(await findTrashForItems([uuid(1), uuid(2), "local-123", uuid(1)])).toEqual({ [uuid(1)]: "bin-new", [uuid(2)]: "bin-2" });
    expect(q.calls).toContainEqual(["in", ["item_id", [uuid(1), uuid(2)]]]);
    expect(q.calls).toContainEqual(["is", ["restored_at", null]]);
    expect(q.calls).toContainEqual(["order", ["deleted_at", { ascending: false }]]);
  });
  it("asks in chunks of 100 and nothing at all for no ids", async () => {
    from.mockImplementation(() => table({ data: [], error: null }));
    await findTrashForItems(Array.from({ length: 250 }, (_, i) => uuid(i + 1)));
    expect(from).toHaveBeenCalledTimes(3);
    from.mockClear();
    expect(await findTrashForItems(["not-a-uuid"])).toEqual({});
    expect(from).not.toHaveBeenCalled();
  });
});

describe("restore and purge", () => {
  it("restore_from_trash: the answer, idempotent repeats, the database's refusals", async () => {
    rpc.mockResolvedValueOnce({ data: RESULT(1, { note: "Its project was deleted, so it's back in “Marketing”." }), error: null });
    expect(await restoreFromTrash(uuid(1001))).toMatchObject({ status: "restored", itemId: uuid(1), note: "Its project was deleted, so it's back in “Marketing”." });
    expect(rpc).toHaveBeenCalledWith("restore_from_trash", { p_id: uuid(1001) });
    rpc.mockResolvedValueOnce({ data: RESULT(1, { status: "already_restored" }), error: null });
    expect((await restoreFromTrash(uuid(1001))).status).toBe("already_restored");
    for (const [message, why] of [["restore conflict", "conflict"], ["no project to restore into", "no_project"], ["not authorized", "not_allowed"], ["not found", "not_found"]] as const) {
      rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message } });
      expect(trashFailure(await restoreFromTrash(uuid(1)).catch((x) => x))).toBe(why);
    }
    rpc.mockResolvedValueOnce({ data: { what: "?" }, error: null });
    expect(trashFailure(await restoreFromTrash(uuid(1)).catch((x) => x))).toBe("error");
  });
  it("restore_trash_items: chunks of 200 in the order given; one answer per id", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => uuid(1000 + i));
    rpc.mockImplementation(async (_fn: string, args: { p_ids: string[] }) => ({ data: args.p_ids.map((id) => ({ id, ok: true, result: { ...RESULT(0), id } })), error: null }));
    const out = await restoreTrashItems([...ids, ids[0]]);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls.map((c) => (c[1] as { p_ids: string[] }).p_ids.length)).toEqual([TRASH_BULK_MAX, TRASH_BULK_MAX, 50]);
    expect(rpc.mock.calls[0][0]).toBe("restore_trash_items");
    expect(out).toHaveLength(450);
    expect(out.every((r) => r.ok)).toBe(true);
  });
  it("restore_trash_items: a refused item fails alone; a call that fails outright fails its ids and stops", async () => {
    rpc.mockResolvedValueOnce({ data: [{ id: uuid(1), ok: true, result: RESULT(1) }, { id: uuid(2), ok: false, error: "restore conflict" }], error: null });
    expect(await restoreTrashItems([uuid(1), uuid(2)])).toEqual([
      { id: uuid(1), ok: true, result: expect.objectContaining({ itemId: uuid(1) }) },
      { id: uuid(2), ok: false, error: "conflict", message: "restore conflict" },
    ]);
    rpc.mockReset();
    rpc.mockResolvedValue({ data: null, error: { message: "TypeError: Failed to fetch" } });
    const out = await restoreTrashItems(Array.from({ length: 250 }, (_, i) => uuid(i)));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(250);
    expect(out.every((r) => !r.ok && r.error === "network")).toBe(true);
  });
  it("purge_trash", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(purgeTrash(uuid(1))).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("purge_trash", { p_id: uuid(1) });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "not found" } });
    expect(trashFailure(await purgeTrash(uuid(1)).catch((x) => x))).toBe("not_found");
  });
  it("says why in words", () => {
    expect(trashFailureText("conflict")).toMatch(/already back/);
    expect(trashFailureText("no_project")).toMatch(/Make a project first/);
    expect(trashFailureText("network")).toMatch(/connection/);
  });
});

describe("restoreDeletedItems (the Undo helper)", () => {
  it("finds the bin rows, restores them, and reports what came back with the server's notes", async () => {
    from.mockReturnValue(table({ data: [{ id: uuid(1001), item_id: uuid(1) }, { id: uuid(1002), item_id: uuid(2) }], error: null }));
    rpc.mockResolvedValue({ data: [
      { id: uuid(1001), ok: true, result: RESULT(1, { note: "Its project was deleted, so it's back in “Marketing”." }) },
      { id: uuid(1002), ok: true, result: RESULT(2, { note: "Its project was deleted, so it's back in “Marketing”." }) },
    ], error: null });
    const r = await restoreDeletedItems([uuid(1), uuid(2)]);
    expect(rpc).toHaveBeenCalledWith("restore_trash_items", { p_ids: [uuid(1001), uuid(1002)] });
    expect(r).toMatchObject({ status: "restored", restored: [uuid(1), uuid(2)], failed: [], missing: [], notes: ["Its project was deleted, so it's back in “Marketing”."] });
  });
  it("partial: one refused, one never reached the bin", async () => {
    from.mockReturnValue(table({ data: [{ id: uuid(1001), item_id: uuid(1) }, { id: uuid(1002), item_id: uuid(2) }], error: null }));
    rpc.mockResolvedValue({ data: [{ id: uuid(1001), ok: true, result: RESULT(1) }, { id: uuid(1002), ok: false, error: "restore conflict" }], error: null });
    const r = await restoreDeletedItems([uuid(1), uuid(2), uuid(3)]);
    expect(r.status).toBe("partial");
    expect(r.restored).toEqual([uuid(1)]);
    expect(r.failed).toEqual([{ itemId: uuid(2), error: "conflict", message: "restore conflict" }]);
    expect(r.missing).toEqual([uuid(3)]);
  });
  it("unavailable before 0047 (so the app falls back to copies); failed when offline", async () => {
    from.mockReturnValue(table({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.trash' in the schema cache" } }));
    expect((await restoreDeletedItems([uuid(1)])).status).toBe("unavailable");
    from.mockReturnValue(table({ data: [{ id: uuid(1001), item_id: uuid(1) }], error: null }));
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.restore_trash_items" } });
    expect((await restoreDeletedItems([uuid(1)])).status).toBe("unavailable");
    from.mockReturnValue(table({ data: null, error: { message: "TypeError: Failed to fetch" } }));
    const off = await restoreDeletedItems([uuid(1)]);
    expect(off.status).toBe("failed");
    expect(off.failed[0]).toMatchObject({ itemId: uuid(1), error: "network" });
    expect(await restoreDeletedItems([])).toMatchObject({ status: "restored", restored: [] });
  });
});
