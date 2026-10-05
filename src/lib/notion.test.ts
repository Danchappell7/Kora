/* lib/notion in demo mode (no Supabase): the in-memory Notion workspace the
   Settings panel and the task chips run against. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotionDatabaseSchema, NotionDatabaseSummary, NotionPreviewRow } from "../data/types";
import type { DbSchema, DbSummary, PreviewRow } from "../../supabase/functions/_shared/notionMap.ts";
import {
  NotionError, connectNotion, deleteNotionSync, disconnectNotion, getNotionDatabaseSchema, importNotionDatabase, linkNotionPage,
  listNotionDatabases, listNotionSyncs, listTaskNotionLinks, loadNotionStatus, previewNotionDatabase, resetNotionDemo, runNotionSyncNow,
  setNotionSyncEnabled, subscribeNotionSyncs, subscribeTaskNotionLinks, suggestNotionMapping, testNotion, unlinkNotionPage, NOTION_COPY,
} from "./notion";

const WS = "ws-foundrise";
const TOKEN = "ntn_" + "Ab12Cd34".repeat(5);
const reason = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof NotionError ? e.reason : "not a NotionError"; } return "no error"; };

beforeEach(() => resetNotionDemo({ demoDelayMs: 0 }));

describe("the server's shapes are the app's shapes", () => {
  it("schema, summary and preview rows line up with src/data/types", () => {
    // compile-time: the edge function's JSON is the client's type
    const a: NotionDatabaseSchema = {} as DbSchema;
    const b: NotionDatabaseSummary = {} as DbSummary;
    const c: NotionPreviewRow = {} as PreviewRow;
    expect([a, b, c]).toHaveLength(3);
  });
});

describe("connection (demo)", () => {
  it("Personal has no Notion; Foundrise is connected; other workspaces aren't", async () => {
    expect(await loadNotionStatus(null)).toBeNull();
    expect(await loadNotionStatus(WS)).toMatchObject({ connected: true, workspaceName: "Foundrise", tokenHint: "…f3Qa", canManage: true, syncCount: 2 });
    expect(await loadNotionStatus("ws-reco")).toMatchObject({ connected: false, canManage: true });
  });
  it("connect checks the secret's shape, then connects; disconnect pauses every sync", async () => {
    expect(await reason(connectNotion("ws-reco", "Bearer abc"))).toBe("invalid_token");
    const s = await connectNotion("ws-reco", TOKEN);
    expect(s).toMatchObject({ connected: true, tokenHint: "…" + TOKEN.slice(-4) });
    expect(await testNotion("ws-reco")).toEqual({ ok: true, workspaceName: "Foundrise" });
    const off = await disconnectNotion(WS);
    expect(off.connected).toBe(false);
    expect((await listNotionSyncs(WS)).every((x) => !x.enabled)).toBe(true);
    expect(await testNotion(WS)).toEqual({ ok: false, reason: "not_connected", message: NOTION_COPY.notConnected });
  });
});

describe("import wizard (demo)", () => {
  it("lists and searches databases; reads the Content calendar's schema and first five pages", async () => {
    const all = await listNotionDatabases(WS);
    expect(all.map((d) => d.title)).toContain("Content calendar");
    expect(await listNotionDatabases(WS, "road")).toHaveLength(1);
    const cal = all.find((d) => d.title === "Content calendar")!;
    const schema = await getNotionDatabaseSchema(WS, cal.id);
    expect(schema.properties[0]).toMatchObject({ name: "Name", type: "title" });
    const rows = await previewNotionDatabase(WS, cal.id);
    expect(rows).toHaveLength(5);
    expect(rows[1].values.Status).toBe("Drafting");
    const m = suggestNotionMapping(schema);
    expect(m).toMatchObject({ title: "Name", due: { property: "Publish date" }, assignee: { property: "Owner" }, tags: { property: "Channels" }, description: { property: "Summary" } });
    expect(m.status?.values).toEqual({ Idea: "todo", Drafting: "progress", Scheduled: "review", Published: "done" });
    expect(await reason(listNotionDatabases("ws-reco"))).toBe("not_connected");
    expect(await reason(getNotionDatabaseSchema(WS, "nope"))).toBe("not_shared");
  });
  it("imports into a project and keeps it in sync; the same database can't sync twice", async () => {
    const cal = (await listNotionDatabases(WS, "content"))[0];
    const mapping = suggestNotionMapping(await getNotionDatabaseSchema(WS, cal.id));
    const told = vi.fn();
    const off = subscribeNotionSyncs(WS, told);
    const r = await importNotionDatabase({ workspaceId: WS, databaseId: cal.id, mapping, projectId: "p-brand", keepInSync: true, direction: "two_way" });
    expect(r).toMatchObject({ projectId: "p-brand", created: 14, skipped: 0, errors: [], partial: false });
    expect(r.syncId).toBeTruthy();
    expect(told).toHaveBeenCalled();
    off();
    const syncs = await listNotionSyncs(WS);
    expect(syncs.find((x) => x.id === r.syncId)).toMatchObject({ databaseTitle: "Content calendar", projectId: "p-brand", direction: "two_way", enabled: true });
    expect(await reason(importNotionDatabase({ workspaceId: WS, databaseId: cal.id, mapping, projectId: "p-launch", keepInSync: true, direction: "two_way" }))).toBe("invalid");
    const one = await importNotionDatabase({ workspaceId: WS, databaseId: cal.id, mapping, projectId: null, newProject: { name: "Content", emoji: "🗓️", color: "oklch(0.62 0.16 250)" }, keepInSync: false, direction: "two_way" });
    expect(one.syncId).toBeNull();
    expect(await reason(importNotionDatabase({ workspaceId: WS, databaseId: cal.id, mapping, projectId: null, keepInSync: false, direction: "two_way" }))).toBe("invalid");
  });
  it("sync now, pause / resume, remove; a failing sync says why", async () => {
    const [roadmap, bugs] = await listNotionSyncs(WS);
    const st = await runNotionSyncNow(roadmap.id);
    expect(st).toMatchObject({ updated: 1, pushed: 1 });
    await expect(runNotionSyncNow(bugs.id)).rejects.toThrow(/can't see this Notion database/);
    expect((await setNotionSyncEnabled(roadmap.id, false)).enabled).toBe(false);
    expect((await setNotionSyncEnabled(roadmap.id, true)).enabled).toBe(true);
    await deleteNotionSync(bugs.id);
    expect((await listNotionSyncs(WS)).map((x) => x.id)).toEqual([roadmap.id]);
    expect((await loadNotionStatus(WS))?.syncCount).toBe(1);
  });
});

describe("page links (demo)", () => {
  it("seeded links, a pasted link (title from the URL), linking twice, unlinking", async () => {
    expect((await listTaskNotionLinks("t-1", WS)).map((l) => l.page?.title)).toEqual(["Q3 launch: narrative notes", "Launch plan"]);
    expect(await listTaskNotionLinks("t-1", null)).toEqual([]);
    const told = vi.fn();
    const off = subscribeTaskNotionLinks("t-9", told);
    expect(await reason(linkNotionPage("t-9", "https://evil.example.com/89abcdef0123456789abcdef01234567", WS))).toBe("invalid");
    const l = await linkNotionPage("t-9", "https://www.notion.so/acme/Launch-brief-89abcdef0123456789abcdef01234567?pvs=4", WS);
    expect(l).toMatchObject({ taskId: "t-9", pageId: "89abcdef-0123-4567-89ab-cdef01234567", kind: "reference", page: { title: "Launch brief" } });
    expect((await linkNotionPage("t-9", "89abcdef0123456789abcdef01234567", WS)).id).toBe(l.id);
    expect(told).toHaveBeenCalledTimes(1);
    await unlinkNotionPage(l.id);
    expect(await listTaskNotionLinks("t-9", WS)).toEqual([]);
    expect(told).toHaveBeenCalledTimes(2);
    off();
    expect(await reason(linkNotionPage("t-9", "89abcdef0123456789abcdef01234567", "ws-reco"))).toBe("not_connected");
  });
});

describe("taking a sync over (demo)", () => {
  it("an owner saves a sync as themselves: it acts as them and the error clears", async () => {
    const { takeOverNotionSync } = await import("./notion");
    const [, bugs] = await listNotionSyncs(WS);
    const s = await takeOverNotionSync({ ...bugs, createdBy: null, createdByName: null });
    expect(s).toMatchObject({ id: bugs.id, createdByName: "Daniel Okai", lastError: null, enabled: true });
  });
});
