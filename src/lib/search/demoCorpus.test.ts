import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { docPlainText, loadDemoCorpus, demoSearchComments } from "./demoCorpus";
import { TASKS, MEMBERS } from "../../data/data";
import { localSearch } from "../searchApi";
import type { DocBlock } from "../../data/types";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00")); });
afterEach(() => { vi.useRealTimers(); });

describe("demo corpus", () => {
  it("a doc's text is each block's spans, one line per block (as project_docs.plain_text)", () => {
    const body: DocBlock[] = [
      { id: "1", type: "h1", spans: [{ text: "Launch " }, { text: "brief", marks: ["b"] }] },
      { id: "2", type: "divider" },
      { id: "3", type: "p", spans: [{ text: "   " }] },
      { id: "4", type: "p", spans: [{ text: "Owner: " }, { text: "@Sana", mention: "m-3" }] },
    ];
    expect(docPlainText(body)).toBe("Launch brief\nOwner: @Sana");
    expect(docPlainText(null)).toBe("");
  });

  it("loads the demo docs with their text, and the demo store's comments, and never throws", async () => {
    const corpus = await loadDemoCorpus(["p-launch", "p-nothing"], ["t-1"], {
      listComments: async (id) => (id === "t-1" ? [{ id: "c", taskId: "t-1", authorId: "m-1", authorName: "Maya Lin", body: "hi", createdAt: "2026-10-09T08:00:00Z" }] : []),
    });
    expect(corpus.docs.map((d) => d.title).sort()).toEqual(expect.arrayContaining(["Decision log", "Launch brief"]));
    const log = corpus.docs.find((d) => d.title === "Decision log")!;
    expect(log.text).toContain("£12 a seat");
    expect(corpus.comments.map((c) => c.id)).toEqual(["c"]);
    // searching it finds the decision, with the words marked
    const hits = localSearch({ text: "seat", filters: { kinds: ["doc"] }, tasks: [], projects: [], members: [], docs: corpus.docs, currentUserId: "m-self" });
    expect(hits.map((h) => h.title)).toEqual(["Decision log"]);
    const broken = await loadDemoCorpus(["p"], ["t"], { listProjectDocs: async () => { throw new Error("no"); }, listComments: async () => { throw new Error("no"); } });
    expect(broken).toEqual({ docs: [], comments: [] });
  });

  it("the demo threads sit on real demo tasks, by real demo people, in the past — as many as each task's count", () => {
    const list = demoSearchComments(Date.parse("2026-10-09T10:00:00Z"));
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
    const per: Record<string, number> = {};
    for (const c of list) per[c.taskId] = (per[c.taskId] ?? 0) + 1;
    for (const t of TASKS) expect(per[t.id] ?? 0, t.id).toBe(t.comments ?? 0);
    for (const c of list) {
      expect(TASKS.some((t) => t.id === c.taskId), c.taskId).toBe(true);
      expect(MEMBERS.find((m) => m.id === c.authorId)?.name).toBe(c.authorName);
      expect(Date.parse(c.createdAt)).toBeLessThan(Date.parse("2026-10-09T10:00:00Z"));
    }
  });
});
