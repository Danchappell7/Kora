/* lib/presence's pure parts: block ops, the diff, merging a remote batch, the three-way merge of saved copies,
   the wire parser, caret mapping and the replica's last-writer-wins rules. (Convergence under any interleaving:
   presence.fuzz.test.ts.) */
import { describe, expect, it } from "vitest";
import type { DocBlock, DocOp, DocOpBatch } from "../data/types";
import {
  applyDocOps, blockSig, diffDocBlocks, docSig, DocReplica, hashText, mapTextOffset, mergeDocVersions, mergeRemoteBatch, parseWireBatch,
  presenceKey, presenceSentence,
} from "./presence";

const p = (id: string, text: string, extra: Partial<DocBlock> = {}): DocBlock => ({ id, type: "p", spans: text ? [{ text }] : [], ...extra });
const ids = (bs: DocBlock[]) => bs.map((b) => b.id).join(",");
const texts = (bs: DocBlock[]) => bs.map((b) => `${b.id}:${(b.spans ?? []).map((s) => s.text).join("")}`).join(" | ");
const batch = (ops: DocOp[], over: Partial<DocOpBatch> = {}): DocOpBatch => ({ docId: "d", clientId: "c-them", userId: "u-them", name: "Sana", seq: 1, baseVersion: "", ops, at: 0, ...over });
const A = p("a", "alpha"), B = p("b", "bravo"), C = p("c", "charlie"), D = p("d", "delta");

describe("the contract's small parts", () => {
  it("presenceKey and the sentence", () => {
    expect(presenceKey("task", "t1")).toBe("task:t1");
    expect(presenceKey("doc", "d1")).toBe("doc:d1");
    expect(presenceSentence([{ name: "Sana Rao" }])).toBe("Sana is viewing");
    expect(presenceSentence([{ name: "Sana Rao" }, { name: "Theo Vance" }], "editing")).toBe("Sana and Theo are editing");
    expect(presenceSentence([{ name: "Sana Rao" }, { name: "Theo Vance" }, { name: "Maya Lin" }, { name: "Idris Bell" }])).toBe("Sana, Theo and 2 others are viewing");
  });
});

describe("applyDocOps", () => {
  it("insert after a block, at the start, and after a missing block (the end)", () => {
    expect(ids(applyDocOps([A, B], [{ t: "insert", block: C, afterId: "a" }]))).toBe("a,c,b");
    expect(ids(applyDocOps([A, B], [{ t: "insert", block: C, afterId: null }]))).toBe("c,a,b");
    expect(ids(applyDocOps([A, B], [{ t: "insert", block: C, afterId: "zz" }]))).toBe("a,b,c");
  });
  it("update, delete and move; unknown ids are skipped; the input is never changed", () => {
    const list = [A, B, C];
    const out = applyDocOps(list, [
      { t: "update", block: p("b", "BRAVO") }, { t: "update", block: p("zz", "?") },
      { t: "delete", blockId: "a" }, { t: "delete", blockId: "zz" },
      { t: "move", blockId: "c", afterId: null }, { t: "move", blockId: "zz", afterId: null },
    ]);
    expect(texts(out)).toBe("c:charlie | b:BRAVO");
    expect(ids(list)).toBe("a,b,c");
    expect(ids(applyDocOps([A, B], [{ t: "move", blockId: "a", afterId: "missing" }]))).toBe("b,a");
    expect(ids(applyDocOps([A, B], [{ t: "move", blockId: "a", afterId: "a" }]))).toBe("a,b");
  });
  it("an insert of a block that's there replaces and moves it", () => {
    expect(texts(applyDocOps([A, B, C], [{ t: "insert", block: p("a", "ALPHA"), afterId: "c" }]))).toBe("b:bravo | c:charlie | a:ALPHA");
  });
});

describe("diffDocBlocks", () => {
  it("nothing for the same blocks; one update for one edited block (the same objects aren't compared)", () => {
    expect(diffDocBlocks([A, B], [A, B])).toEqual([]);
    expect(diffDocBlocks([A, B], [A, p("b", "bravo!")])).toEqual([{ t: "update", block: p("b", "bravo!") }]);
    // equal content in a new object (key order, absent vs false) is no change
    expect(diffDocBlocks([{ id: "x", type: "todo", spans: [{ text: "t" }] }], [{ spans: [{ text: "t" }], type: "todo", id: "x", checked: false }])).toEqual([]);
  });
  it("deletes, then inserts and moves in order, then updates", () => {
    const ops = diffDocBlocks([A, B, C, D], [C, A, p("e", "echo"), D]);
    expect(ops.map((o) => o.t)).toEqual(["delete", "move", "insert"]);
    expect(applyDocOps([A, B, C, D], ops)).toEqual([C, A, p("e", "echo"), D]);
  });
});

describe("mergeRemoteBatch", () => {
  it("different blocks merge without a conflict", () => {
    // you changed a (unsent); they changed c
    const shared = [A, B, C];
    const mine: DocOp[] = [{ t: "update", block: p("a", "alpha, mine") }];
    const r = mergeRemoteBatch(shared, batch([{ t: "update", block: p("c", "charlie, theirs") }]), mine);
    expect(texts(r.blocks)).toBe("a:alpha, mine | b:bravo | c:charlie, theirs");
    expect(r.conflicts).toEqual([]);
    expect(r.changed).toEqual(["c"]);
  });
  it("the same block: theirs wins, and it's a conflict", () => {
    const r = mergeRemoteBatch([A, B], batch([{ t: "update", block: p("a", "theirs") }]), [{ t: "update", block: p("a", "mine") }]);
    expect(texts(r.blocks)).toBe("a:theirs | b:bravo");
    expect(r.conflicts).toEqual(["a"]);
  });
  it("your new line survives anything; your delete gives way to their edit; their move doesn't undo your edit", () => {
    const mine: DocOp[] = [{ t: "insert", block: p("n", "new"), afterId: "a" }, { t: "delete", blockId: "b" }, { t: "update", block: p("c", "c, mine") }];
    const r = mergeRemoteBatch([A, B, C], batch([{ t: "update", block: p("b", "bravo, theirs") }, { t: "move", blockId: "c", afterId: null }]), mine);
    expect(texts(r.blocks)).toBe("c:c, mine | a:alpha | n:new | b:bravo, theirs");
    expect(r.conflicts).toEqual(["b"]);
  });
});

describe("mergeDocVersions (someone else's save, three ways)", () => {
  const base = { title: "Brief", blocks: [A, B, C] };
  it("their changes come in, yours stay", () => {
    const r = mergeDocVersions(base, { title: "Brief", blocks: [p("a", "alpha, mine"), B, C] }, { title: "Brief, v2", blocks: [A, B, p("c", "charlie, theirs"), D] });
    expect(r.conflicts).toEqual([]);
    expect(r.title).toBe("Brief, v2");
    expect(texts(r.blocks)).toBe("a:alpha, mine | b:bravo | c:charlie, theirs | d:delta");
    expect(r.theirsChanged).toEqual(["c", "d"]);
  });
  it("the same block changed both ways is a conflict (and the blocks stay yours)…", () => {
    const mine = { title: "Brief", blocks: [p("a", "mine"), B, C] };
    const r = mergeDocVersions(base, mine, { title: "Brief", blocks: [p("a", "theirs"), B, C] });
    expect(r.conflicts).toEqual(["a"]);
    expect(r.blocks).toBe(mine.blocks);
  });
  it("…unless you had their copy live and moved on (yours stays)…", () => {
    const r = mergeDocVersions(base, { title: "Brief", blocks: [p("a", "theirs, then mine"), B, C] }, { title: "Brief", blocks: [p("a", "theirs"), B, C] },
      { seen: (id, b) => id === "a" && blockSig(b) === blockSig(p("a", "theirs")) });
    expect(r.conflicts).toEqual([]);
    expect(texts(r.blocks)).toBe("a:theirs, then mine | b:bravo | c:charlie");
  });
  it("…or the words here were someone else's anyway, with nothing unsent of yours (theirs comes in)", () => {
    const r = mergeDocVersions(base, { title: "Brief", blocks: [p("a", "Theo's"), B, C] }, { title: "Brief", blocks: [p("a", "Sana's, newer"), B, C] },
      { remoteAuthored: () => true, mineUnsent: () => false });
    expect(r.conflicts).toEqual([]);
    expect(texts(r.blocks)).toBe("a:Sana's, newer | b:bravo | c:charlie");
  });
  it("deleted on one side, edited on the other: the words are kept", () => {
    const r1 = mergeDocVersions(base, { title: "Brief", blocks: [A, p("b", "bravo, mine"), C] }, { title: "Brief", blocks: [A, C] });
    expect(texts(r1.blocks)).toBe("a:alpha | b:bravo, mine | c:charlie");
    const r2 = mergeDocVersions(base, { title: "Brief", blocks: [A, C] }, { title: "Brief", blocks: [A, p("b", "bravo, theirs"), C] });
    expect(texts(r2.blocks)).toBe("a:alpha | b:bravo, theirs | c:charlie");
  });
  it("your new line after a block they deleted goes where that block was", () => {
    const r = mergeDocVersions(base, { title: "Brief", blocks: [A, B, p("n", "new"), C] }, { title: "Brief", blocks: [A, C] });
    expect(ids(r.blocks)).toBe("a,n,c");
  });
  it("titles: one side changed takes it; both changed differently is a conflict; trailing spaces aren't a change", () => {
    expect(mergeDocVersions(base, { title: "Brief ", blocks: base.blocks }, { title: "Brief", blocks: base.blocks }).titleConflict).toBe(false);
    expect(mergeDocVersions(base, { title: "Mine", blocks: base.blocks }, { title: "Brief", blocks: base.blocks }).title).toBe("Mine");
    expect(mergeDocVersions(base, { title: "Mine", blocks: base.blocks }, { title: "Theirs", blocks: base.blocks }).titleConflict).toBe(true);
    expect(mergeDocVersions(base, { title: "Mine", blocks: base.blocks }, { title: "Theirs", blocks: base.blocks }, { seenTitle: (t) => t === "Theirs" }).title).toBe("Mine");
  });
});

describe("the wire", () => {
  const ok = { docId: "d1", clientId: "c1", userId: "u1", name: "Sana Rao", color: "oklch(0.7 0.1 300)", seq: 5, baseVersion: "2026-10-09T09:00:00.000Z", at: 1, ops: [{ t: "update", block: { id: "b1", type: "p", spans: [{ text: "hi" }, { text: "!" }] } }] };
  it("a good batch comes through (spans tidied)", () => {
    const b = parseWireBatch(ok)!;
    expect(b.ops).toEqual([{ t: "update", block: { id: "b1", type: "p", spans: [{ text: "hi!" }] } }]);
    expect(b.name).toBe("Sana Rao");
  });
  it("anything odd and the whole batch is dropped; unsafe links never survive", () => {
    expect(parseWireBatch({ ...ok, ops: [{ t: "explode" }] })).toBeNull();
    expect(parseWireBatch({ ...ok, ops: [{ t: "insert", block: { id: "b2", type: "p" }, afterId: 7 }] })).toBeNull();
    expect(parseWireBatch({ ...ok, docId: "../x" })).toBeNull();
    expect(parseWireBatch({ ...ok, seq: -1 })).toBeNull();
    expect(parseWireBatch({ ...ok, ops: new Array(2001).fill(ok.ops[0]) })).toBeNull();
    expect(parseWireBatch({ ...ok, ops: [{ t: "update", block: { id: "b1", type: "p", spans: [{ text: "x".repeat(100_001) }] } }] })).toBeNull();
    const b = parseWireBatch({ ...ok, ops: [{ t: "update", block: { id: "b1", type: "p", spans: [{ text: "click", href: "javascript:alert(1)" }] } }] })!;
    expect(b.ops[0]).toEqual({ t: "update", block: { id: "b1", type: "p", spans: [{ text: "click" }] } });
    expect(parseWireBatch({ ...ok, title: "A\ntitle" })!.title).toBe("A title");
  });
});

describe("small things", () => {
  it("mapTextOffset keeps a caret in the words", () => {
    expect(mapTextOffset("hello world", "hello brave world", 8)).toBe(14); // after the insert point: shifts
    expect(mapTextOffset("hello world", "hello brave world", 3)).toBe(3);  // before it: stays
    expect(mapTextOffset("hello world", "hello", 9)).toBe(5);             // its words went: the end
    expect(mapTextOffset("abc", "abc", 2)).toBe(2);
  });
  it("docSig and hashText: the same doc is the same, whatever the key order or trailing spaces", () => {
    const x = docSig("Brief ", [{ id: "a", type: "p", spans: [{ text: "t", marks: ["i", "b"] }] }]);
    const y = docSig("Brief", [{ spans: [{ marks: ["b", "i"], text: "t" }], type: "p", id: "a" }]);
    expect(x).toBe(y);
    expect(hashText(x)).toBe(hashText(y));
    expect(hashText(x)).not.toBe(hashText(docSig("Brief", [p("a", "u")])));
  });
});

describe("DocReplica", () => {
  const two = () => [new DocReplica("c-a", [A, B, C], "Doc"), new DocReplica("c-b", [A, B, C], "Doc")] as const;
  const wire = (r: DocReplica, cur: DocBlock[], title = "Doc", now = 1000) => {
    const out = r.flush(cur, title, now)!;
    return { docId: "d", clientId: r.clientId, userId: "u-" + r.clientId, name: r.clientId, seq: out.seq, baseVersion: "", ops: out.ops, at: now, ...(out.title !== undefined ? { title: out.title } : {}) };
  };
  it("edits to different blocks cross over and both copies agree", () => {
    const [a, b] = two();
    const ca = [p("a", "alpha, A"), B, C], cb = [A, B, p("c", "charlie, B")];
    const fa = wire(a, ca), fb = wire(b, cb);
    const ra = a.receive(fb, ca, "Doc", 1001)!, rb = b.receive(fa, cb, "Doc", 1001)!;
    expect(texts(ra.blocks)).toBe(texts(rb.blocks));
    expect(texts(ra.blocks)).toBe("a:alpha, A | b:bravo | c:charlie, B");
    expect(ra.changed).toEqual(["c"]);
    expect(ra.conflicts).toEqual([]);
  });
  it("the same block: the later stamp wins on both copies", () => {
    const [a, b] = two();
    const fa = wire(a, [p("a", "from A"), B, C], "Doc", 1000);
    const fb = wire(b, [p("a", "from B"), B, C], "Doc", 1000);
    const ra = a.receive(fb, [p("a", "from A"), B, C], "Doc", 1001);
    const rb = b.receive(fa, [p("a", "from B"), B, C], "Doc", 1001);
    const finalA = ra ? ra.blocks : [p("a", "from A"), B, C];
    const finalB = rb ? rb.blocks : [p("a", "from B"), B, C];
    expect(texts(finalA)).toBe(texts(finalB));
    expect(texts(finalA)).toBe("a:from B | b:bravo | c:charlie"); // same time: the higher client id
  });
  it("unsent words lose to a remote edit of the same block (a conflict) — but never to a remote delete", () => {
    const [a, b] = two();
    const fb = wire(b, [p("a", "B's"), B, C]);
    const r = a.receive(fb, [p("a", "A typing"), B, C], "Doc", 1001)!;
    expect(r.conflicts).toEqual(["a"]);
    expect(texts(r.blocks)).toContain("a:B's");
    const [x, y] = two();
    const del = wire(y, [A, C]);
    const r2 = x.receive(del, [A, p("b", "bravo, still typing"), C], "Doc", 1001)!;
    expect(texts(r2.blocks)).toBe("a:alpha | b:bravo, still typing | c:charlie");
    // …and it goes back out as an edit, which brings it back for them in place
    const back = wire(x, r2.blocks, "Doc", 1002);
    expect(back.ops).toEqual([{ t: "update", block: p("b", "bravo, still typing") }]);
    const r3 = y.receive(back, [A, C], "Doc", 1003)!;
    expect(texts(r3.blocks)).toBe("a:alpha | b:bravo, still typing | c:charlie");
  });
  it("an edit that arrives before its block's insert waits for it", () => {
    const [a] = two();
    const ins = { docId: "d", clientId: "c-x", userId: "u-x", name: "X", seq: 5000, baseVersion: "", ops: [{ t: "insert" as const, block: p("n", "new"), afterId: "b" }], at: 0 };
    const upd = { docId: "d", clientId: "c-y", userId: "u-y", name: "Y", seq: 6000, baseVersion: "", ops: [{ t: "update" as const, block: p("n", "new, edited") }], at: 0 };
    expect(a.receive(upd, [A, B, C], "Doc", 1000)).toBeNull();
    expect(a.waitingCount).toBe(1);
    const r = a.receive(ins, [A, B, C], "Doc", 1001)!;
    expect(texts(r.blocks)).toBe("a:alpha | b:bravo | n:new, edited | c:charlie");
  });
  it("titles are last writer wins too", () => {
    const [a, b] = two();
    const fb = wire(b, [A, B, C], "Launch plan");
    const r = a.receive(fb, [A, B, C], "Doc", 1001)!;
    expect(r.title).toBe("Launch plan");
    expect(r.titleChanged).toBe(true);
  });
  it("remembers which copies of a block it has seen, and who wrote the words last", () => {
    const [a, b] = two();
    const fb = wire(b, [p("a", "B1"), B, C]);
    a.receive(fb, [A, B, C], "Doc", 1001);
    expect(a.seen("a", p("a", "B1"))).toBe(true);
    expect(a.seen("a", p("a", "never"))).toBe(false);
    expect(a.remoteAuthored("a")).toBe(true);
    expect(a.remoteAuthored("b")).toBe(false);
  });
  it("the order check: the higher client id's order stands; a read-only copy always takes it", () => {
    const low = new DocReplica("c-1", [A, B, C], "Doc");
    expect(low.adoptOrder(["c", "a", "b"], "c-0", [A, B, C], "Doc")).toBeNull();
    expect(ids(low.adoptOrder(["c", "a", "b"], "c-2", [A, B, C], "Doc")!.blocks)).toBe("c,a,b");
    const ro = new DocReplica("c-9", [A, B, C], "Doc");
    expect(ids(ro.adoptOrder(["b", "a", "c"], "c-0", [A, B, C], "Doc", { force: true })!.blocks)).toBe("b,a,c");
  });
});

describe("clocks from the wire", () => {
  it("a batch stamped more than a day ahead is refused; a clock that far ahead isn't followed", () => {
    const r = new DocReplica("c-a", [A], "Doc");
    const now = Date.now();
    const far = { docId: "d", clientId: "c-z", userId: "u", name: "Z", seq: now + 2 * 86_400_000, baseVersion: "", ops: [{ t: "update" as const, block: p("a", "mine forever") }], at: 0 };
    expect(r.receive(far, [A], "Doc", now)).toBeNull();
    r.observe(now + 2 * 86_400_000);
    expect(r.clock).toBeLessThan(now + 86_400_000);
  });
});
