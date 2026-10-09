import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Comment, Member, Project, SearchHit, Task } from "../data/types";
import { setReferenceData } from "../data/data";

const rpc = vi.hoisted(() => ({ fn: vi.fn(), client: { current: null as unknown } }));
vi.mock("./supabase", () => ({
  get supabase() { return rpc.client.current; },
  isSupabaseConfigured: true,
}));

import {
  searchAll, localSearch, mergeSearchHits, groupSearchHits, titleTier, recentSearches, rememberSearch, forgetRecentSearches,
  forgetRecentSearch, filtersNarrowTasks, isAbort, SEARCH_GROUPS, RECENT_SEARCHES_MAX, searchFailure,
} from "./searchApi";
import { splitHighlights, SEARCH_MARK_START as S, SEARCH_MARK_END as E } from "./searchRows";
import { highlightRuns, makeSnippet, matchRanges } from "./search/highlight";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, workspaceId: "ws-1", ...o,
});
const PROJECTS: Project[] = [
  { id: "p-launch", name: "Launch", emoji: "🚀", color: "blue", workspaceId: "ws-1", description: "The pricing page and launch plan" },
  { id: "p-old", name: "Old pricing", emoji: "", color: "grey", workspaceId: "ws-1", archivedAt: "2026-09-01T00:00:00Z" },
  { id: "p-me", name: "Personal", emoji: "📌", color: "violet", workspaceId: null },
];
const MEMBERS: Member[] = [
  { id: "m-self", name: "Daniel Okai", email: "daniel@kanbo.app", type: "self", color: "#888" },
  { id: "m-1", name: "Maya Lin", email: "maya@kanbo.app", type: "team", color: "#888" },
  { id: "m-2", name: "Theo Vance", email: "theo@kanbo.app", type: "team", color: "#888" },
];
const TASKS: Task[] = [
  task({ id: "t-deck", title: "Pricing deck", description: "Draft the pricing slides for the board", status: "blocked", assigneeId: "m-1", dueDate: "2026-10-08" }),
  task({ id: "t-review", title: "Competitor review", description: "Check competitor pricing", assigneeId: "m-2", dueDate: "2026-10-12", collaborators: ["m-1"] }),
  task({ id: "t-done", title: "Pricing page copy", status: "done", completedAt: "2026-10-01T10:00:00Z" }),
  task({ id: "t-arch", title: "Pricing archived", archivedAt: "2026-09-02T00:00:00Z" }),
  task({ id: "t-oldp", title: "Pricing in an old project", projectId: "p-old" }),
  task({ id: "t-mine", title: "Personal pricing note", projectId: "p-me", workspaceId: null }),
];
const COMMENTS: Comment[] = [
  { id: "c-1", taskId: "t-review", authorId: "m-2", authorName: "Theo Vance", body: "Can we move the pricing table to slide 3?", createdAt: "2026-10-07T09:00:00Z" },
  { id: "c-2", taskId: "t-deck", authorId: "m-1", authorName: "Maya Lin", body: "Pricing looks good", createdAt: "2026-10-08T09:00:00Z" },
  { id: "c-3", taskId: "t-gone", authorId: "m-1", authorName: "Maya Lin", body: "pricing on a task I can't see", createdAt: "2026-10-08T09:00:00Z" },
];
const DOCS = [
  { id: "d-1", projectId: "p-launch", title: "Launch brief", workspaceId: "ws-1", text: "Goals for the quarter\nPricing: three tiers, annual discount\nOwner: Sana" },
  { id: "d-2", projectId: "p-old", title: "Old pricing doc", workspaceId: "ws-1" },
];
const run = (text: string, filters = {}, extra: Partial<Parameters<typeof localSearch>[0]> = {}) =>
  localSearch({ text, filters, tasks: TASKS, projects: PROJECTS, members: MEMBERS, comments: COMMENTS, docs: DOCS, currentUserId: "m-self", ...extra });
const ids = (hits: SearchHit[], kind?: string) => hits.filter((h) => !kind || h.kind === kind).map((h) => h.id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  setReferenceData({ projects: PROJECTS, members: MEMBERS });
  window.localStorage.clear();
  rpc.client.current = null;
  rpc.fn.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe("localSearch follows search_all's rules", () => {
  it("every kind, every word required, archived hidden by default", () => {
    const hits = run("pricing");
    expect(ids(hits, "task").sort()).toEqual(["t-deck", "t-done", "t-mine", "t-review"]);
    expect(ids(hits, "comment")).toEqual(["c-2", "c-1"]);          // newest first; c-3's task isn't visible
    expect(ids(hits, "doc")).toEqual(["d-1"]);                      // d-2 is in an archived project
    expect(ids(hits, "project")).toEqual(["p-launch"]);
    expect(ids(run("pricing slides"), "task")).toEqual(["t-deck"]);
  });
  it("include archived brings back archived tasks and what's in archived projects", () => {
    const hits = run("pricing", { includeArchived: true });
    expect(ids(hits, "task")).toEqual(expect.arrayContaining(["t-arch", "t-oldp"]));
    expect(ids(hits, "doc")).toEqual(["d-1", "d-2"]);
    expect(ids(hits, "project")).toEqual(["p-launch", "p-old"]);
  });
  it("task filters narrow tasks; a project narrows everything; an author narrows comments", () => {
    expect(ids(run("pricing", { assigneeId: "m-1" }), "task").sort()).toEqual(["t-deck", "t-review"]);   // collaborator counts
    expect(ids(run("pricing", { statuses: ["blocked"] }), "task")).toEqual(["t-deck"]);
    expect(ids(run("pricing", { excludeDone: true }), "task")).not.toContain("t-done");
    expect(ids(run("pricing", { dueFrom: "2026-10-10", dueTo: "2026-10-16" }), "task")).toEqual(["t-review"]);
    expect(ids(run("pricing", { authorId: "m-2" }), "comment")).toEqual(["c-1"]);
    const inLaunch = run("pricing", { projectId: "p-launch" });
    expect(ids(inLaunch, "project")).toEqual(["p-launch"]);
    expect(ids(inLaunch, "task")).not.toContain("t-mine");
    // task filters don't touch other kinds (the client decides which kinds to show)
    expect(ids(run("pricing", { statuses: ["blocked"] }), "doc")).toEqual(["d-1"]);
  });
  it("scope: a workspace, Personal (null) or everywhere (undefined)", () => {
    expect(ids(run("pricing", { workspaceId: null }), "task")).toEqual(["t-mine"]);
    expect(ids(run("pricing", { workspaceId: "ws-1" }), "task")).not.toContain("t-mine");
    expect(ids(run("maya", { workspaceId: null }), "person")).toEqual([]);   // no people in Personal
  });
  it("no words: task filters list tasks (soonest due first); nothing else, and no filters lists nothing", () => {
    expect(ids(run("", { excludeDone: true, workspaceId: "ws-1" }))).toEqual(["t-deck", "t-review", "t-oldp"].filter((x) => x !== "t-oldp"));
    expect(run("", {})).toEqual([]);
    expect(run('"', { workspaceId: "ws-1" })).toEqual([]);
    expect(run("", { kinds: ["doc"], statuses: ["blocked"] })).toEqual([]);
  });
  it("an author alone lists their comments on hand, newest first (the server needs words for comments)", () => {
    const hits = run("", { authorId: "m-1", kinds: ["comment"] });
    expect(ids(hits)).toEqual(["c-2"]);
    expect(hits[0].snippet).toBe("Pricing looks good");
    expect(run("", { authorId: "m-1", kinds: ["comment", "doc", "project"] }).map((h) => h.kind)).toEqual(["comment"]);
  });
  it("people: a name containing the text, or an email starting with it", () => {
    expect(ids(run("maya"), "person")).toEqual(["m-1"]);
    expect(ids(run("theo@"), "person")).toEqual(["m-2"]);
    expect(ids(run("kanbo.app"), "person")).toEqual([]);
  });
  it("snippets mark the words in the body; titles are matched across names too", () => {
    const deck = run("pricing slides").find((h) => h.id === "t-deck")!;
    expect(splitHighlights(deck.snippet)).toEqual([
      { text: "Draft the ", hit: false }, { text: "pricing", hit: true }, { text: " ", hit: false }, { text: "slides", hit: true }, { text: " for the board", hit: false },
    ]);
    // a task found through its assignee's name (as Search always has)
    expect(ids(run("maya pricing"), "task")).toContain("t-deck");
    const doc = run("annual").find((h) => h.kind === "doc")!;
    expect(doc.snippet).toBe(`…Goals for the quarter · Pricing: three tiers, ${S}annual${E} discount · Owner: Sana`.replace("…", ""));
  });
  it("respects the kinds asked for and the per-kind limit", () => {
    expect(run("pricing", { kinds: ["doc"] }).map((h) => h.kind)).toEqual(["doc"]);
    expect(run("pricing", {}, { limit: 1 }).filter((h) => h.kind === "task")).toHaveLength(1);
  });
});

describe("mergeSearchHits", () => {
  const hit = (o: Partial<SearchHit>): SearchHit => ({ kind: "task", id: "x", title: "x", snippet: null, rank: 0, taskId: null, projectId: null, workspaceId: null, updatedAt: null, source: "local", ...o });
  it("exact title > starts with > every word in the title > some > body only", () => {
    const local = [
      hit({ id: "body", title: "Plan the week", snippet: "budget for Q3" }),
      hit({ id: "some", title: "Budget" }),
      hit({ id: "words", title: "Q3 marketing budget review" }),
      hit({ id: "prefix", title: "Budget Q3 draft" }),
      hit({ id: "exact", title: "Budget  Q3" }),
    ];
    expect(mergeSearchHits(local, [], { text: "budget q3" }).map((h) => h.id)).toEqual(["exact", "prefix", "words", "some", "body"]);
  });
  it("open work before finished; then the server's rank; then the newest", () => {
    const local = [
      hit({ id: "done", title: "Deck", task: { status: "done", priority: "medium", dueDate: null, assigneeId: null, parentId: null, archived: false } }),
      hit({ id: "old", title: "Deck", updatedAt: "2026-01-01T00:00:00Z" }),
      hit({ id: "new", title: "Deck", updatedAt: "2026-10-01T00:00:00Z" }),
    ];
    const server = [hit({ id: "ranked", title: "Deck", rank: 0.9, source: "server" })];
    expect(mergeSearchHits(local, server, { text: "deck" }).map((h) => h.id)).toEqual(["ranked", "new", "old", "done"]);
  });
  it("de-duplicates by kind + id: the server's snippet wins, the device's fills the gaps", () => {
    const local = [hit({ id: "a", title: "Pricing", snippet: "local", updatedAt: "2026-10-01T00:00:00Z" }), hit({ kind: "doc", id: "a", title: "Pricing doc" })];
    const server = [hit({ id: "a", title: "Pricing", snippet: `server ${S}pricing${E}`, source: "server" }), hit({ id: "b", title: "Pricing two", source: "server", snippet: null })];
    const merged = mergeSearchHits(local, server, { text: "pricing" });
    expect(merged.map((h) => `${h.kind}:${h.id}`)).toEqual(["task:a", "task:b", "doc:a"]);
    expect(merged[0]).toMatchObject({ snippet: `server ${S}pricing${E}`, source: "server", updatedAt: "2026-10-01T00:00:00Z" });
    const keepLocal = mergeSearchHits([hit({ id: "c", title: "c", snippet: "mine" })], [hit({ id: "c", title: "c", snippet: null, source: "server" })]);
    expect(keepLocal[0].snippet).toBe("mine");
  });
  it("caps each kind and keeps the groups in order; with no words the order is as found", () => {
    const local = [hit({ kind: "person", id: "p1", title: "Ann" }), ...Array.from({ length: 6 }, (_, i) => hit({ id: `t${i}`, title: `Task ${i}` }))];
    const merged = mergeSearchHits(local, [], { limitPerKind: 3, text: "" });
    expect(merged.map((h) => h.id)).toEqual(["t0", "t1", "t2", "p1"]);
    expect(groupSearchHits(merged).map((g) => [g.label, g.hits.length])).toEqual([["Tasks", 3], ["People", 1]]);
    expect(SEARCH_GROUPS.map((g) => g.kind)).toEqual(["task", "comment", "doc", "project", "person"]);
  });
  it("title tiers fold accents and case", () => {
    expect(titleTier("Café menu", "cafe menu")).toBe(4);
    expect(titleTier("Zoë’s notes", "zoe's")).toBe(3);
    expect(titleTier("anything", "")).toBe(0);
  });
});

describe("searchAll", () => {
  const client = (result: { data?: unknown; error?: unknown }) => {
    const builder = { abortSignal: vi.fn(() => builder), then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej) };
    rpc.fn.mockReturnValue(builder);
    rpc.client.current = { rpc: rpc.fn };
    return builder;
  };
  it("calls search_all with the words, snake_case filters and the per-kind limit, and parses the rows", async () => {
    const b = client({ data: [{ kind: "task", id: "t1", title: "Pricing deck", snippet: `the ${S}pricing${E}`, rank: 0.4, task_id: "t1", project_id: "p", workspace_id: "w", meta: { status: "blocked" } }, { kind: "nope" }] });
    const ac = new AbortController();
    const hits = await searchAll("  pricing  ", { assigneeId: "m-1", workspaceId: null, statuses: ["blocked"] }, { limit: 5, signal: ac.signal });
    expect(rpc.fn).toHaveBeenCalledWith("search_all", { q: "pricing", filters: { assignee_id: "m-1", workspace_id: null, statuses: ["blocked"] }, lim: 5 });
    expect(b.abortSignal).toHaveBeenCalledWith(ac.signal);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "task", id: "t1", source: "server", task: { status: "blocked" } });
  });
  it("no words and no task filters: nothing, without a call", async () => {
    client({ data: [] });
    expect(await searchAll("  ", {})).toEqual([]);
    expect(await searchAll("", { workspaceId: "w", includeArchived: true })).toEqual([]);
    expect(rpc.fn).not.toHaveBeenCalled();
    await searchAll("", { excludeDone: true });
    expect(rpc.fn).toHaveBeenCalledTimes(1);
    expect(filtersNarrowTasks({ projectId: "p" })).toBe(true);
  });
  it("limits stay within 1–50", async () => {
    client({ data: [] });
    await searchAll("x", {}, { limit: 500 });
    await searchAll("x", {}, { limit: 0 });
    expect(rpc.fn.mock.calls.map((c) => c[1].lim)).toEqual([50, 1]);
  });
  it("errors keep their reason; demo mode (no server) is 'unavailable'", async () => {
    client({ error: { message: "not authorized" } });
    await expect(searchAll("x", {})).rejects.toSatisfy((e: unknown) => searchFailure(e) === "not_allowed");
    client({ error: { message: "function public.search_all(text, jsonb, integer) does not exist" } });
    await expect(searchAll("x", {})).rejects.toSatisfy((e: unknown) => searchFailure(e) === "unavailable");
    rpc.client.current = null;
    await expect(searchAll("x", {})).rejects.toSatisfy((e: unknown) => searchFailure(e) === "unavailable");
  });
  it("a cancelled search rejects as an abort (not a failure)", async () => {
    client({ data: [] });
    const ac = new AbortController();
    ac.abort();
    await expect(searchAll("x", {}, { signal: ac.signal })).rejects.toSatisfy(isAbort);
  });
});

describe("recent searches", () => {
  it("newest first, no repeats (case and accents folded), at most 8, per person", () => {
    for (let i = 0; i < 10; i++) rememberSearch("u1", `search ${i}`);
    rememberSearch("u1", "SEARCH 9");
    rememberSearch("u1", "  ");
    rememberSearch("u1", '"');
    const list = recentSearches("u1");
    expect(list).toHaveLength(RECENT_SEARCHES_MAX);
    expect(list[0]).toBe("SEARCH 9");
    expect(list).not.toContain("search 9");
    expect(recentSearches("u2")).toEqual([]);
    forgetRecentSearch("u1", "search 8");
    expect(recentSearches("u1")).not.toContain("search 8");
    forgetRecentSearches("u1");
    expect(recentSearches("u1")).toEqual([]);
  });
  it("survives storage that throws or holds rubbish", () => {
    window.localStorage.setItem("kanbo-recent-searches:u3", "{not json");
    expect(recentSearches("u3")).toEqual([]);
    window.localStorage.setItem("kanbo-recent-searches:u3", JSON.stringify(["ok", 4, null, ""]));
    expect(recentSearches("u3")).toEqual(["ok"]);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => rememberSearch("u3", "x")).not.toThrow();
    spy.mockRestore();
  });
});

describe("highlights", () => {
  it("finds words with accents and case folded, in the original text's positions", () => {
    expect(matchRanges("Café Zoë CAFE", ["cafe"])).toEqual([[0, 4], [9, 13]]);
    expect(highlightRuns("Zoë’s pricing", "zoe's")).toEqual([{ text: "Zoë’s", hit: true }, { text: " pricing", hit: false }]);
    expect(highlightRuns("no match", "zzz")).toEqual([{ text: "no match", hit: false }]);
    expect(matchRanges("aaaa", ["aa"])).toEqual([[0, 4]]);
  });
  it("snippets: a window round the first match, word boundaries, ellipses, markers", () => {
    const long = `${"word ".repeat(60)}the pricing table ${"more ".repeat(60)}`;
    const s = makeSnippet(long, ["pricing"], 80)!;
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain(`${S}pricing${E}`);
    expect(s.length).toBeLessThan(120);
    expect(makeSnippet("nothing here", ["pricing"])).toBeNull();
    expect(makeSnippet(`sneaky ${S}markers${E} pricing`, ["pricing"])).toBe(`sneaky markers ${S}pricing${E}`);
  });
});
