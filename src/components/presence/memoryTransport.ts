/* ============================================================
   KANBO — an in-memory stand-in for Supabase Realtime (tests).  [0048, u5]
   One bus; every hub that's given `bus.transport()` sees the others on
   the same topics, as separate tabs would: presence (track → everyone's
   sync, ours included), broadcast (to everyone but the sender, in order),
   join / leave. `refuse` makes a topic answer like a channel the
   Realtime policies turn away. Not imported by the app.
   ============================================================ */
import type { PresenceTransport, TransportChannel, TransportHandlers, WirePresence } from "./core";

interface Member { h: TransportHandlers; state: WirePresence | null; live: boolean }

export interface MemoryBus {
  transport(): PresenceTransport;
  /** topics a join is refused on (like a channel the policies refuse) */
  refuse: Set<string>;
  /** every broadcast that went out: [topic, event, payload] */
  sent: [string, string, Record<string, unknown>][];
  /** channels open now, per topic */
  open(topic: string): number;
  /** how many times a topic was opened */
  opened(topic: string): number;
  /** hold deliveries (broadcast and presence) until flushed */
  pause(): void;
  flush(): void;
}

export function createMemoryBus(): MemoryBus {
  const topics = new Map<string, Set<Member>>();
  const opens = new Map<string, number>();
  const sent: [string, string, Record<string, unknown>][] = [];
  const refuse = new Set<string>();
  let paused = false;
  let queue: (() => void)[] = [];
  const run = (fn: () => void) => { if (paused) queue.push(fn); else fn(); };
  const sync = (topic: string) => {
    const set = topics.get(topic);
    if (!set) return;
    const states = [...set].filter((m) => m.live && m.state).map((m) => ({ ...m.state!, presence_ref: m.h.self }));
    for (const m of set) if (m.live) { const h = m.h; run(() => h.onSync(states)); }
  };
  return {
    sent, refuse,
    open: (topic) => topics.get(topic)?.size ?? 0,
    opened: (topic) => opens.get(topic) ?? 0,
    pause() { paused = true; },
    flush() { paused = false; const q = queue; queue = []; q.forEach((fn) => fn()); },
    transport(): PresenceTransport {
      return {
        open(topic, h): TransportChannel {
          opens.set(topic, (opens.get(topic) ?? 0) + 1);
          const me: Member = { h, state: null, live: false };
          let closed = false;
          if (refuse.has(topic)) {
            queueMicrotask(() => { if (!closed) h.onStatus("refused"); });
            return { track() {}, untrack() {}, send: () => false, close() { closed = true; } };
          }
          const set = topics.get(topic) ?? new Set<Member>();
          topics.set(topic, set);
          set.add(me);
          queueMicrotask(() => {
            if (closed) return;
            me.live = true;
            h.onStatus("live");
            sync(topic);
          });
          return {
            track(state) { if (closed) return; me.state = state; sync(topic); },
            untrack() { if (closed) return; me.state = null; sync(topic); },
            send(event, payload) {
              if (closed || !me.live) return false;
              const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
              sent.push([topic, event, copy]);
              for (const m of set) if (m !== me && m.live) { const other = m.h; run(() => other.onBroadcast(event, JSON.parse(JSON.stringify(copy)))); }
              return true;
            },
            close() {
              if (closed) return;
              closed = true;
              set.delete(me);
              me.live = false;
              sync(topic);
            },
          };
        },
      };
    },
  };
}
