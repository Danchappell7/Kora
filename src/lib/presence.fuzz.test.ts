/* Co-editing convergence: several replicas edit at once, batches arrive in any interleaving (FIFO per sender,
   as Realtime delivers them), and every copy must end the same — content, order and title. */
import { describe, expect, it } from "vitest";
import type { DocBlock } from "../data/types";
import { applyDocOps, diffDocBlocks, docSig, DocReplica, type WireBatch } from "./presence";

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
