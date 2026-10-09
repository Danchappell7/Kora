/* lib/trash in demo mode (no Supabase in tests): realistic fakes for every
   scope, and restore / purge / bulk behaving like the server. */
import { beforeEach, describe, expect, it } from "vitest";
import { daysLeft, findTrashForItems, listTrash, purgeTrash, restoreDeletedItems, restoreFromTrash, restoreTrashItems, resetTrashDemo, trashFailure } from "./trash";

beforeEach(() => resetTrashDemo({ demoDelayMs: 0 }));

describe("demo bin", () => {
  it("a team workspace: tasks and a project, newest first, one with sub-tasks, one nearly due", async () => {
    const items = await listTrash("ws-foundrise");
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.some((t) => t.kind === "project")).toBe(true);
    expect(items.some((t) => t.kind === "task" && t.summary.counts.subtasks > 0)).toBe(true);
    expect(items.some((t) => t.summary.parent)).toBe(true);
    expect(items.some((t) => t.deletedByName === "Kanbo")).toBe(true);
    expect(items.some((t) => daysLeft(t.purgeAfter) <= 3)).toBe(true);
    const at = items.map((t) => Date.parse(t.deletedAt));
    expect([...at].sort((a, b) => b - a)).toEqual(at);
    expect(items.every((t) => t.workspaceId === "ws-foundrise" && !t.restoredAt)).toBe(true);
  });
  it("Personal and another workspace have their own", async () => {
    const mine = await listTrash(null);
    expect(mine.length).toBeGreaterThan(1);
    expect(mine.every((t) => t.workspaceId === null)).toBe(true);
    expect((await listTrash("ws-reco")).every((t) => t.workspaceId === "ws-reco")).toBe(true);
  });
  it("restore takes it out of the bin, with the server's note where it moved; again is 'already restored'", async () => {
    const items = await listTrash("ws-foundrise");
    const moved = items.find((t) => t.title === "Migrate blog posts")!;
    const r = await restoreFromTrash(moved.id);
    expect(r).toMatchObject({ status: "restored", itemId: moved.itemId });
    expect(r.note).toMatch(/^Its project was deleted, so it's back in “.+”\.$/);
    expect((await listTrash("ws-foundrise")).some((t) => t.id === moved.id)).toBe(false);
    expect((await restoreFromTrash(moved.id)).status).toBe("already_restored");
    const project = items.find((t) => t.kind === "project")!;
    expect((await restoreFromTrash(project.id)).projectId).toBe(project.itemId);
  });
  it("purge deletes it for good; an unknown id is 'not found'", async () => {
    const [first] = await listTrash("ws-foundrise");
    await purgeTrash(first.id);
    expect((await listTrash("ws-foundrise")).some((t) => t.id === first.id)).toBe(false);
    expect(trashFailure(await purgeTrash(first.id).catch((e) => e))).toBe("not_found");
    expect(trashFailure(await restoreFromTrash("nope").catch((e) => e))).toBe("not_found");
  });
  it("bulk restore answers per id, newest delete first", async () => {
    const items = await listTrash("ws-foundrise");
    const out = await restoreTrashItems([items[2].id, "nope", items[0].id]);
    expect(out.map((r) => r.id)).toEqual([items[0].id, items[2].id, "nope"]);
    expect(out.map((r) => r.ok)).toEqual([true, true, false]);
    expect(out[2].error).toBe("not_found");
  });
  it("finds bin rows by item; Undo in demo mode uses the app's own restore", async () => {
    const items = await listTrash("ws-foundrise");
    expect(await findTrashForItems([items[0].itemId, "x"])).toEqual({ [items[0].itemId]: items[0].id });
    expect((await restoreDeletedItems([items[0].itemId])).status).toBe("unavailable");
  });
});
