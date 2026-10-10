/* lib/docs in demo mode (no Supabase): the in-memory docs follow the server's rules. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  docMentionInWorkspace, docMentionLine, docMentionRoute,
  deleteProjectDoc, demoSaveAs, docAgo, docErrorText, docFailure, docFileName, DOC_COPY, DOC_LIMITS, getDocVersion, getProjectDoc, listDocVersions,
  listProjectDocs, mentionsIn, resetDemoDocs, saveProjectDoc, setProjectDocProps, subscribeProjectDocs, taskLinksIn,
} from "./docs";
import { parseDocBody } from "./docs";

beforeEach(() => resetDemoDocs());

describe("demo docs", () => {
  it("the launch project has three docs, in order, without bodies; other projects have none", async () => {
    const list = await listProjectDocs("p-launch");
    expect(list.map((d) => d.title)).toEqual(["Launch brief", expect.stringMatching(/^Launch sync, \d{1,2} \w+$/), "Decision log"]);
    expect(list.map((d) => d.icon)).toEqual(["🧭", "🗒️", "⚖️"]);
    expect(list[0]).not.toHaveProperty("body");
    expect(list.every((d) => d.archivedAt === null && d.workspaceId === "ws-foundrise")).toBe(true);
    expect(await listProjectDocs("p-brand")).toEqual([]);
  });

  it("the brief mentions people and links tasks (a Make-task line), and is a valid stored body", async () => {
    const d = (await getProjectDoc("doc-launch-brief"))!;
    expect(d.canEdit).toBe(true);
    expect(d.updatedByName).toBe("Sana Rao");
    expect(mentionsIn(d.body)).toEqual(expect.arrayContaining(["m-self", "m-3", "m-1", "m-2"]));
    expect(d.mentions.sort()).toEqual(mentionsIn(d.body).sort());
    expect(taskLinksIn(d.body)).toEqual(["t-13", "t-1", "t-2"]);
    expect(parseDocBody(JSON.parse(JSON.stringify(d.body)))).toEqual(d.body);
    const sync = (await getProjectDoc("doc-launch-sync"))!;
    expect(taskLinksIn(sync.body)).toEqual(["t-20", "t-17"]);
  });

  it("creates a doc with the app's id at the end of the list, with a first version", async () => {
    const r = await saveProjectDoc({ id: "new-1", projectId: "p-launch", title: "  Retro  ", body: [{ id: "a", type: "p", spans: [{ text: "Hi" }] }], baseUpdatedAt: null, icon: "🔁", mentions: [] });
    expect(r.status).toBe("saved");
    expect(r.doc).toMatchObject({ id: "new-1", title: "Retro", icon: "🔁", position: 4, createdBy: "m-self", canEdit: true, createdByName: "Daniel Okai" });
    expect((await listProjectDocs("p-launch")).map((d) => d.id).pop()).toBe("new-1");
    expect(await listDocVersions("new-1")).toHaveLength(1);
  });

  it("optimistic concurrency: a stale base is a conflict with their copy; keep mine saves on their updatedAt", async () => {
    const mine = (await getProjectDoc("doc-launch-brief"))!;
    const base = new Date(mine.updatedAt).toISOString(); // a JS Date round trip still matches
    const first = await saveProjectDoc({ id: mine.id, projectId: mine.projectId, title: "Mine", body: mine.body, baseUpdatedAt: base });
    expect(first.status).toBe("saved");
    expect(new Date(first.doc.updatedAt) > new Date(mine.updatedAt)).toBe(true);
    const stale = await saveProjectDoc({ id: mine.id, projectId: mine.projectId, title: "Stale", body: [], baseUpdatedAt: base });
    expect(stale).toMatchObject({ status: "conflict", doc: { title: "Mine" } });
    const keep = await saveProjectDoc({ id: mine.id, projectId: mine.projectId, title: "Stale wins", body: [], baseUpdatedAt: stale.doc.updatedAt });
    expect(keep).toMatchObject({ status: "saved", doc: { title: "Stale wins" } });
    // no base on an existing doc is never a blind overwrite
    expect((await saveProjectDoc({ id: mine.id, projectId: mine.projectId, title: "x", body: [], baseUpdatedAt: null })).status).toBe("conflict");
  });

  it("two quick saves in the same millisecond still move updatedAt on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T10:00:00.000Z"));
    try {
      const a = await saveProjectDoc({ id: "q", projectId: "p-launch", title: "a", body: [], baseUpdatedAt: null });
      const b = await saveProjectDoc({ id: "q", projectId: "p-launch", title: "b", body: [], baseUpdatedAt: a.doc.updatedAt });
      expect(b.status).toBe("saved");
      expect(b.doc.updatedAt > a.doc.updatedAt).toBe(true);
      const c = await saveProjectDoc({ id: "q", projectId: "p-launch", title: "c", body: [], baseUpdatedAt: b.doc.updatedAt });
      expect(c.status).toBe("saved");
    } finally { vi.useRealTimers(); }
  });

  it("versions: one per ten minutes of the doc's editing, whoever saves; newest first, bodies on request", async () => {
    const before = await listDocVersions("doc-launch-brief");
    expect(before.map((v) => v.savedBy)).toEqual(["m-3", "m-self", "m-1", "m-self"]);
    expect(before.every((v) => v.body === null)).toBe(true);
    const d = (await getProjectDoc("doc-launch-brief"))!;
    const s1 = await saveProjectDoc({ id: d.id, projectId: d.projectId, title: "One", body: d.body, baseUpdatedAt: d.updatedAt });
    await saveProjectDoc({ id: d.id, projectId: d.projectId, title: "Two", body: d.body, baseUpdatedAt: s1.doc.updatedAt });
    const after = await listDocVersions(d.id);
    expect(after).toHaveLength(5);                  // the last one is two hours old, so mine starts a new one, then folds in
    const top = (await getDocVersion(after[0].id))!;
    expect(top.title).toBe("Two");
    expect(top.body).toEqual(d.body);
    expect(await getDocVersion("nope")).toBeNull();
    // a checkpoint (a restore, keep mine) is a version of its own: "Two" stays in the list
    const s3 = await saveProjectDoc({ id: d.id, projectId: d.projectId, title: "Restored", body: [], baseUpdatedAt: (await getProjectDoc(d.id))!.updatedAt, checkpoint: true });
    expect(s3.status).toBe("saved");
    const withRestore = await listDocVersions(d.id);
    expect(withRestore.map((v) => v.title).slice(0, 2)).toEqual(["Restored", "Two"]);
    expect(withRestore).toHaveLength(6);
    // and the next ordinary save folds into it as usual
    await saveProjectDoc({ id: d.id, projectId: d.projectId, title: "Restored, then typed", body: [], baseUpdatedAt: s3.doc.updatedAt });
    expect((await listDocVersions(d.id)).map((v) => v.title).slice(0, 2)).toEqual(["Restored, then typed", "Two"]);
    // someone else saving within the ten minutes (writing together live) folds in too, named for them: the older
    // history isn't pushed out by people saving in turn
    await demoSaveAs(d.id, (b) => [...b, { id: "sana-line", type: "p", spans: [{ text: "Sana's line" }] }], "m-3");
    const together = await listDocVersions(d.id);
    expect(together).toHaveLength(6);
    expect(together[0]).toMatchObject({ title: "Restored, then typed", savedBy: "m-3" });
    expect((await getDocVersion(together[0].id))!.body!.map((b) => b.id)).toContain("sana-line");
  });

  it("icon, order and archive don't count as an edit (updatedAt stays)", async () => {
    const d = (await getProjectDoc("doc-decision-log"))!;
    const r = await setProjectDocProps(d.id, { icon: "📌", position: 0.5, archived: true });
    expect(r).toMatchObject({ icon: "📌", position: 0.5, updatedAt: d.updatedAt });
    expect(r.archivedAt).toBeTruthy();
    expect((await listProjectDocs("p-launch"))[0].id).toBe(d.id);
    const back = await setProjectDocProps(d.id, { icon: "", archived: false });
    expect(back).toMatchObject({ icon: null, archivedAt: null, position: 0.5 });
    await expect(setProjectDocProps("gone", { archived: true })).rejects.toThrow(/doc not found/);
  });

  it("delete takes the doc and its versions; a save on it afterwards says it's gone", async () => {
    const d = (await getProjectDoc("doc-launch-sync"))!;
    await deleteProjectDoc(d.id);
    expect(await getProjectDoc(d.id)).toBeNull();
    expect(await listDocVersions(d.id)).toEqual([]);
    await expect(saveProjectDoc({ id: d.id, projectId: d.projectId, title: "x", body: [], baseUpdatedAt: d.updatedAt })).rejects.toThrow(/doc not found/);
    await expect(deleteProjectDoc(d.id)).rejects.toThrow(/doc not found/);
  });

  it("tells subscribers about changes to their project only", async () => {
    const seen: string[] = [];
    const off = subscribeProjectDocs("p-launch", (c) => seen.push(`${c.type}:${c.docId}`));
    const offOther = subscribeProjectDocs("p-brand", (c) => seen.push(`other:${c.docId}`));
    await saveProjectDoc({ id: "n", projectId: "p-launch", title: "n", body: [], baseUpdatedAt: null });
    await setProjectDocProps("n", { archived: true });
    await deleteProjectDoc("n");
    await Promise.resolve();
    expect(seen).toEqual(["INSERT:n", "UPDATE:n", "DELETE:n"]);
    off(); offOther();
    await saveProjectDoc({ id: "m", projectId: "p-launch", title: "m", body: [], baseUpdatedAt: null });
    await Promise.resolve();
    expect(seen).toHaveLength(3);
  });

  it("refuses before the server would: long titles, huge bodies, 200 docs", async () => {
    await expect(saveProjectDoc({ id: "t", projectId: "p-launch", title: "x".repeat(201), body: [], baseUpdatedAt: null })).rejects.toThrow(/invalid title/);
    const huge = [{ id: "a", type: "p" as const, spans: [{ text: "x".repeat(DOC_LIMITS.bytes) }] }];
    const e = await saveProjectDoc({ id: "t", projectId: "p-launch", title: "t", body: huge, baseUpdatedAt: null }).catch((x) => x);
    expect(docFailure(e)).toBe("too_large");
    for (let i = 0; i < DOC_LIMITS.perProject; i++) await saveProjectDoc({ id: `many-${i}`, projectId: "p-many", title: `${i}`, body: [], baseUpdatedAt: null });
    const full = await saveProjectDoc({ id: "one-more", projectId: "p-many", title: "x", body: [], baseUpdatedAt: null }).catch((x) => x);
    expect(docFailure(full)).toBe("too_many");
  });
});

describe("words", () => {
  const now = new Date("2026-10-09T15:00:00").getTime();
  it("says how long ago, the British way", () => {
    expect(docAgo(new Date(now - 10_000).toISOString(), now)).toBe("just now");
    expect(docAgo(new Date(now - 60_000).toISOString(), now)).toBe("a minute ago");
    expect(docAgo(new Date(now - 25 * 60_000).toISOString(), now)).toBe("25 minutes ago");
    expect(docAgo(new Date(now - 60 * 60_000).toISOString(), now)).toBe("an hour ago");
    expect(docAgo(new Date(now - 3 * 3600_000).toISOString(), now)).toBe("3 hours ago");
    expect(docAgo(new Date("2026-10-08T09:00:00").toISOString(), now)).toBe("yesterday");
    expect(docAgo(new Date("2026-10-05T09:00:00").toISOString(), now)).toBe("4 days ago");
    expect(docAgo(new Date("2026-09-20T09:00:00").toISOString(), now)).toBe("20 Sept");
    expect(docAgo(new Date("2025-09-20T09:00:00").toISOString(), now)).toBe("20 Sept 2025");
    expect(docAgo(null, now)).toBe("");
  });
  it("file names for Export", () => {
    expect(docFileName("Launch brief")).toBe("Launch brief.md");
    expect(docFileName("a/b\\c:d*e?f\"g<h>i|j")).toBe("a b c d e f g h i j.md");
    expect(docFileName("  ")).toBe("Untitled doc.md");
    expect(docFileName("...hidden")).toBe("hidden.md");
    expect(docFileName("x".repeat(300))).toHaveLength(83);
  });
  it("a sentence for every failure", () => {
    for (const k of Object.keys(DOC_COPY)) expect(DOC_COPY[k as keyof typeof DOC_COPY].length).toBeGreaterThan(10);
    expect(docErrorText(new Error("too many docs"))).toMatch(/200 docs/);
    expect(docErrorText(new TypeError("Failed to fetch"))).toMatch(/offline/);
    expect(docErrorText({ code: "PGRST202", message: "Could not find the function public.save_project_doc" })).toMatch(/switched on/);
  });
});

describe("doc mentions in the Inbox", () => {
  const a = { kind: "doc_mention" as const, detail: "Sana Rao", taskTitle: "Launch brief", meta: { docId: "doc-launch-brief", projectId: "p-launch" } };
  it("go to the doc, in its project's workspace, in words", () => {
    expect(docMentionRoute(a)).toEqual({ view: "project", projectId: "p-launch", tab: "docs", docId: "doc-launch-brief" });
    expect(docMentionRoute({ kind: "mention", meta: a.meta })).toBeNull();
    expect(docMentionRoute({ kind: "doc_mention", meta: undefined })).toBeNull();
    const projects = [{ id: "p-launch", workspaceId: "ws-foundrise" }, { id: "p-personal", workspaceId: null }];
    expect(docMentionInWorkspace(a, projects, "ws-foundrise")).toBe(true);
    expect(docMentionInWorkspace(a, projects, null)).toBe(false);
    expect(docMentionInWorkspace({ ...a, meta: { docId: "d", projectId: "p-gone" } }, projects, "ws-foundrise")).toBe(false);
    expect(docMentionLine(a)).toBe("Sana Rao mentioned you in “Launch brief”");
    expect(docMentionLine({ detail: "", taskTitle: "" })).toBe("Someone mentioned you in “Untitled”");
  });
});
