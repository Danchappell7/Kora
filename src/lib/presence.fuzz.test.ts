/* Co-editing convergence: several replicas edit at once, batches arrive in any interleaving (FIFO per sender,
   as Realtime delivers them), and every copy must end the same — content, order and title. And a replica cut off
   for a while (it misses batches and a save) that catches up: saved words are never overwritten unseen. */
import { describe, expect, it } from "vitest";
import type { DocBlock } from "../data/types";
import { applyDocOps, blockSig, diffDocBlocks, docSig, DocReplica, mergeDocVersions, type WireBatch } from "./presence";

/** a small seeded PRNG (mulberry32) so a failure can be replayed */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const p = (id: string, text: string): DocBlock => ({ id, type: "p", spans: text ? [{ text }] : [] });

interface Node { r: DocReplica; cur: DocBlock[]; title: string; id: string }

function simulate(seed: number, opts: { replicas?: number; steps?: number; structural?: boolean; orderCheck?: boolean; noMoves?: boolean } = {}) {
  const rand = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const n = opts.replicas ?? 3;
  const initial = [p("a", "alpha"), p("b", "bravo"), p("c", "charlie"), p("d", "delta")];
  const nodes: Node[] = Array.from({ length: n }, (_, i) => {
    const id = `c${i}`;
    return { r: new DocReplica(id, initial, "Doc"), cur: initial.slice(), title: "Doc", id };
  });
  // inbox[to][from] = FIFO
  const inbox: WireBatch[][][] = nodes.map(() => nodes.map(() => []));
  let now = 1_000_000;
  let fresh = 0;
  const send = (from: number) => {
    const node = nodes[from];
    const out = node.r.flush(node.cur, node.title, now);
    if (!out) return;
    const b: WireBatch = { docId: "d", clientId: node.id, userId: "u" + from, name: "N" + from, seq: out.seq, baseVersion: "", ops: JSON.parse(JSON.stringify(out.ops)), at: now, ...(out.title !== undefined ? { title: out.title } : {}) };
    nodes.forEach((_, to) => { if (to !== from) inbox[to][from].push(b); });
  };
  const deliver = (to: number, from: number) => {
    const b = inbox[to][from].shift();
    if (!b) return;
    const node = nodes[to];
    const res = node.r.receive(b, node.cur, node.title, now);
    if (res) { node.cur = res.blocks; node.title = res.title; }
  };
  const edit = (i: number) => {
    const node = nodes[i];
    const list = node.cur.slice();
    const kind = rand();
    if (!opts.structural || kind < 0.45) {
      if (!list.length) return;
      const j = Math.floor(rand() * list.length);
      list[j] = { ...list[j], spans: [{ text: `${(list[j].spans ?? []).map((s) => s.text).join("")}+${i}` }] };
    } else if (kind < 0.7) {
      const at = Math.floor(rand() * (list.length + 1));
      list.splice(at, 0, p(`n${i}x${++fresh}`, `new ${fresh}`));
    } else if (kind < 0.85) {
      if (list.length <= 1) return;
      list.splice(Math.floor(rand() * list.length), 1);
    } else if (kind < 0.95) {
      if (list.length < 2 || opts.noMoves) return;
      const [b] = list.splice(Math.floor(rand() * list.length), 1);
      list.splice(Math.floor(rand() * (list.length + 1)), 0, b);
    } else {
      node.title = `Doc ${i}.${++fresh}`;
    }
    node.cur = list;
  };
  const steps = opts.steps ?? 200;
  for (let s = 0; s < steps; s++) {
    now += Math.floor(rand() * 40);
    const r = rand();
    const i = Math.floor(rand() * n);
    if (r < 0.4) edit(i);
    else if (r < 0.6) send(i);
    else {
      const from = pick(nodes.map((_, k) => k).filter((k) => k !== i));
      deliver(i, from);
    }
  }
  // quiesce: everyone sends what's left; everything is delivered; until nothing moves
  for (let round = 0; round < 50; round++) {
    nodes.forEach((_, i) => send(i));
    let any = false;
    for (let to = 0; to < n; to++) for (let from = 0; from < n; from++) while (inbox[to][from].length) { deliver(to, from); any = true; }
    nodes.forEach((node) => { const res = node.r.expire(node.cur, node.title, now + 10_000); if (res) { node.cur = res.blocks; node.title = res.title; } });
    if (!any && nodes.every((node) => !diffDocBlocks(node.r.shadow, node.cur).length && node.r.shadowTitle === node.title)) break;
  }
  // the order check (quiet editors compare the order of their copies; the highest client id's order stands)
  for (let round = 0; round < (opts.orderCheck === false ? 0 : 5); round++) {
    let moved = false;
    for (let from = 0; from < n; from++) {
      const ids = nodes[from].r.orderIds();
      for (let to = 0; to < n; to++) {
        if (to === from) continue;
        const res = nodes[to].r.adoptOrder(ids, nodes[from].id, nodes[to].cur, nodes[to].title);
        if (res) { nodes[to].cur = res.blocks; moved = true; }
      }
    }
    if (!moved) break;
  }
  return nodes;
}

describe("co-editing converges", () => {
  it("text edits only: every copy ends the same, whatever the interleaving", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const nodes = simulate(seed, { steps: 160 });
      expect(new Set(nodes.map((x) => docSig(x.title, x.cur))).size, `seed ${seed}`).toBe(1);
    }
  });
  it("inserts, deletes, moves and titles: the same words everywhere even before the order check…", () => {
    const sorted = (x: { title: string; cur: DocBlock[] }) => docSig(x.title, [...x.cur].sort((a, b) => a.id.localeCompare(b.id)));
    for (let seed = 1; seed <= 200; seed++) {
      const nodes = simulate(seed, { steps: 220, structural: true, replicas: 2 + (seed % 3), orderCheck: false });
      expect(new Set(nodes.map(sorted)).size, `seed ${seed}`).toBe(1);
    }
  });
  it("…and the same order after it, with 2–5 people", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const nodes = simulate(seed, { steps: 240, structural: true, replicas: 2 + (seed % 4) });
      expect(new Set(nodes.map((x) => docSig(x.title, x.cur))).size, `seed ${seed}`).toBe(1);
      for (const x of nodes) expect(x.cur.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });
  it("two people adding lines after the same paragraph: the same order for both, without the order check", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const nodes = simulate(seed, { steps: 60, structural: true, replicas: 2, orderCheck: false, noMoves: true });
      expect(new Set(nodes.map((x) => docSig(x.title, x.cur))).size, `seed ${seed}`).toBe(1);
    }
  });
  it("applyDocOps(before, diffDocBlocks(before, after)) is after (random lists)", () => {
    const rand = rng(7);
    for (let k = 0; k < 500; k++) {
      const ids = "abcdefghij".split("").filter(() => rand() < 0.7);
      const before = ids.map((id) => p(id, id));
      const after = before.filter(() => rand() < 0.8).map((b) => (rand() < 0.3 ? p(b.id, b.id + "!") : b));
      for (let j = 0; j < 3; j++) if (rand() < 0.5) after.splice(Math.floor(rand() * (after.length + 1)), 0, p(`z${k}${j}`, "z"));
      for (let i = after.length - 1; i > 0; i--) if (rand() < 0.3) { const j = Math.floor(rand() * (i + 1)); [after[i], after[j]] = [after[j], after[i]]; }
      expect(applyDocOps(before, diffDocBlocks(before, after))).toEqual(after);
    }
  });
});

/* ---------------------------------------------------------------- cut off, then back
   Three editors share a doc and a server (each save a version). Editor X's channel drops: it misses every batch and
   the others' save while it keeps typing on its old copy. Back, it catches up the way the editor does (resync: the
   server's copy merged three ways; the banner if its words clash with saved ones it never saw — answered Reload or
   Keep mine), its edits the server already holds settle, and only then does anything go out. In the race variant
   it flushes on its old copy first (the catch-up came too late): the others refuse its edits over words saved since
   and tell it to catch up. Properties: everyone converges; a saved block X didn't touch ends as saved; a saved block
   X did touch is always a conflict X answered (never a silent overwrite); refused words never show on the others'
   screens. */
interface Ed { r: DocReplica; cur: DocBlock[]; title: string; id: string; base: { v: string; title: string; blocks: DocBlock[] } }
const ver = (k: number) => new Date(Date.UTC(2026, 9, 9, 9, k)).toISOString();

function cutOff(seed: number, opts: { race?: boolean; keepMine?: boolean }) {
  const rand = rng(seed);
  const initial = [p("a", "alpha"), p("b", "bravo"), p("c", "charlie"), p("d", "delta"), p("e", "echo")];
  let server = { v: ver(0), title: "Doc", blocks: initial };
  let vk = 0;
  const eds: Ed[] = [0, 1, 2].map((i) => ({ r: new DocReplica(`c${i}`, initial, "Doc", { version: ver(0) }), cur: initial.slice(), title: "Doc", id: `c${i}`, base: { ...server } }));
  const X = 2;
  const inbox: WireBatch[][][] = eds.map(() => eds.map(() => []));
  const down = new Set<number>();
  let now = 1_000_000;
  let fresh = 0;
  const send = (from: number) => {
    const e = eds[from];
    const out = e.r.flush(e.cur, e.title, now);
    if (!out) return;
    const b: WireBatch = { docId: "d", clientId: e.id, userId: "u" + from, name: "N" + from, seq: out.seq, baseVersion: e.r.baseVersion ?? "", ops: JSON.parse(JSON.stringify(out.ops)), prev: out.prev, at: now, ...(out.title !== undefined ? { title: out.title } : {}) };
    eds.forEach((_, to) => { if (to !== from && !down.has(to) && !down.has(from)) inbox[to][from].push(b); });
  };
  const refusedAt: { to: number; ids: string[] }[] = [];
  const deliver = (to: number, from: number) => {
    const b = inbox[to][from].shift();
    if (!b) return;
    const e = eds[to];
    const res = e.r.receive(b, e.cur, e.title, now);
    if (e.r.refused.length) refusedAt.push({ to, ids: e.r.refused.slice() });
    if (res) { e.cur = res.blocks; e.title = res.title; }
  };
  const edit = (i: number) => {
    const e = eds[i];
    const list = e.cur.slice();
    const kind = rand();
    if (kind < 0.55) {
      if (!list.length) return;
      const j = Math.floor(rand() * list.length);
      list[j] = { ...list[j], spans: [{ text: `${(list[j].spans ?? []).map((sp) => sp.text).join("")}+${i}` }] };
    } else if (kind < 0.75) {
      list.splice(Math.floor(rand() * (list.length + 1)), 0, p(`n${i}x${++fresh}`, `new ${fresh}`));
    } else if (kind < 0.85) {
      if (list.length <= 2) return;
      list.splice(Math.floor(rand() * list.length), 1);
    } else if (kind < 0.95) {
      if (list.length < 2) return;
      const [b] = list.splice(Math.floor(rand() * list.length), 1);
      list.splice(Math.floor(rand() * (list.length + 1)), 0, b);
    } else {
      e.title = `Doc ${i}.${++fresh}`;
    }
    e.cur = list;
  };
  const live = () => eds.map((_, i) => i).filter((i) => !down.has(i));
  const steps = (n: number, who: number[], typist?: number) => {
    for (let k = 0; k < n; k++) {
      now += Math.floor(rand() * 40);
      const r = rand();
      if (typist !== undefined && r < 0.15) { edit(typist); continue; }
      const i = who[Math.floor(rand() * who.length)];
      if (r < 0.45) edit(i);
      else if (r < 0.65) send(i);
      else { const others = who.filter((x) => x !== i); if (others.length) deliver(i, others[Math.floor(rand() * others.length)]); }
    }
  };
  const quiesce = (who: number[]) => {
    for (let round = 0; round < 50; round++) {
      who.forEach(send);
      let any = false;
      for (const to of who) for (const from of who) while (inbox[to][from].length) { deliver(to, from); any = true; }
      who.forEach((i) => { const res = eds[i].r.expire(eds[i].cur, eds[i].title, now + 10_000); if (res) { eds[i].cur = res.blocks; eds[i].title = res.title; } });
      if (!any && who.every((i) => !diffDocBlocks(eds[i].r.shadow, eds[i].cur).length && eds[i].r.shadowTitle === eds[i].title)) break;
    }
    for (let round = 0; round < 5; round++) {
      let moved = false;
      for (const from of who) for (const to of who) {
        if (to === from) continue;
        const res = eds[to].r.adoptOrder(eds[from].r.orderIds(), eds[from].id, eds[to].cur, eds[to].title);
        if (res) { eds[to].cur = res.blocks; moved = true; }
      }
      if (!moved) break;
    }
  };
  /** someone saves what's on their screen; the others, all showing the same, take it as their base */
  const save = (by: number, who: number[]) => {
    server = { v: ver(++vk), title: eds[by].title, blocks: eds[by].cur.slice() };
    for (const i of who) if (docSig(eds[i].title, eds[i].cur) === docSig(server.title, server.blocks)) { eds[i].base = { ...server }; eds[i].r.remember(server.blocks, server.title, server.v); }
  };
  /** the editor's reconcile: their save merged three ways ("conflict": the banner) */
  const reconcile = (i: number): { conflicts: string[]; titleConflict: boolean } => {
    const e = eds[i];
    const mine = { title: e.title, blocks: e.cur };
    const r = mergeDocVersions(e.base, mine, server, {
      seen: (id, b) => e.r.seen(id, b), seenTitle: (t) => e.r.seenTitle(t), remoteAuthored: (id) => e.r.remoteAuthored(id), mineUnsent: (id) => e.r.unsent(id, e.cur),
    });
    if (r.conflicts.length || r.titleConflict) return r;
    e.base = { ...server };
    e.r.remember(server.blocks, server.title, server.v);
    if (docSig(mine.title, mine.blocks) !== docSig(r.title, r.blocks)) { e.r.absorb(mine, { title: r.title, blocks: r.blocks }); e.cur = r.blocks; e.title = r.title; }
    return r;
  };

  // together for a while, then everyone saved and the same
  steps(120, [0, 1, 2]);
  quiesce([0, 1, 2]);
  save(0, [0, 1, 2]);
  // X drops: the others write (and save); X types on its old copy
  down.add(X);
  inbox[X].forEach((q) => (q.length = 0));
  const xAtDrop = new Map(eds[X].cur.map((b) => [b.id, blockSig(b)]));
  const v1 = new Map(server.blocks.map((b) => [b.id, blockSig(b)]));
  steps(100, [0, 1], X);
  quiesce([0, 1]);
  save(0, [0, 1]);
  const v2 = server;
  const xEdited = new Set(eds[X].cur.filter((b) => xAtDrop.has(b.id) && xAtDrop.get(b.id) !== blockSig(b)).map((b) => b.id));
  const savedOver = new Set(v2.blocks.filter((b) => v1.has(b.id) && v1.get(b.id) !== blockSig(b)).map((b) => b.id));
  const both = [...savedOver].filter((id) => xEdited.has(id));
  // back
  down.delete(X);
  if (opts.race) {
    // its edits go out before it has caught up: the others refuse those over words saved since
    send(X);
    for (const to of [0, 1]) while (inbox[to][X].length) deliver(to, X);
    for (const to of [0, 1]) for (const id of both) {
      const b = eds[to].cur.find((x) => x.id === id);
      const saved = v2.blocks.find((x) => x.id === id)!;
      if (b) expect(blockSig(b), `seed ${seed}: refused words stay off ${to}'s screen`).toBe(blockSig(saved));
    }
    if (both.length) expect(refusedAt.some((x) => both.some((id) => x.ids.includes(id))), `seed ${seed}: refused`).toBe(true);
  }
  const res = reconcile(X);
  const conflict = res.conflicts.length > 0 || res.titleConflict;
  // every block both changed (and both kept) is a conflict the banner shows
  for (const id of both) if (eds[X].cur.some((b) => b.id === id)) expect(res.conflicts, `seed ${seed}: ${id} both changed`).toContain(id);
  if (conflict && !opts.keepMine) {
    // Reload: their copy; what the others show of yours goes back to theirs
    const e = eds[X];
    e.cur = v2.blocks.slice(); e.title = v2.title; e.base = { ...v2 };
    e.r.remember(v2.blocks, v2.title, v2.v);
    e.r.settleSaved(e.cur, e.title, { keepOwn: true });
  } else if (conflict) {
    // Keep mine: on top of their copy, live and saved
    const e = eds[X];
    e.r.remember(v2.blocks, v2.title, v2.v);
    e.base = { ...v2 };
  } else {
    eds[X].r.settleSaved(eds[X].cur, eds[X].title);
  }
  quiesce([0, 1, 2]);
  if (conflict && opts.keepMine) {
    save(X, [X]);
    for (const i of [0, 1]) { const r = reconcile(i); expect(r.conflicts, `seed ${seed}: keep mine merges at ${i}`).toEqual([]); }
    quiesce([0, 1, 2]);
  }
  expect(new Set(eds.map((e) => docSig(e.title, e.cur))).size, `seed ${seed}: converged`).toBe(1);
  if (!conflict || !opts.keepMine) {
    // a saved block X didn't touch ends as saved (X's catch-up never wrote over it); Reload: all of theirs
    const final = new Map(eds[0].cur.map((b) => [b.id, blockSig(b)]));
    for (const b of v2.blocks) {
      if (!savedOver.has(b.id) || !final.has(b.id)) continue;
      if (conflict || !xEdited.has(b.id)) expect(final.get(b.id), `seed ${seed}: ${b.id} as saved`).toBe(blockSig(b));
    }
  }
  return { conflict, both: both.length };
}

describe("a replica cut off, then back", () => {
  it("catching up first: no saved words overwritten unseen, the banner for every clash, everyone the same (Reload)", () => {
    let conflicts = 0, clashes = 0;
    for (let seed = 1; seed <= 150; seed++) { const r = cutOff(seed, {}); if (r.conflict) conflicts++; clashes += r.both; }
    // (the seeds do exercise both paths)
    expect(conflicts).toBeGreaterThan(20);
    expect(conflicts).toBeLessThan(150);
    expect(clashes).toBeGreaterThan(0);
  });
  it("…and answered Keep mine: theirs stays in the history, yours goes live and saved, everyone the same", () => {
    for (let seed = 1; seed <= 150; seed++) cutOff(seed, { keepMine: true });
  });
  it("its batch on the old copy goes out first (the race): the others refuse its words over saved ones, then it catches up", () => {
    for (let seed = 1; seed <= 150; seed++) cutOff(seed, { race: true });
    for (let seed = 151; seed <= 250; seed++) cutOff(seed, { race: true, keepMine: true });
  });
});

