/* ============================================================
   KANBO — live presence: the realtime hub and the light hooks.  [0048, u5]
   One Supabase Realtime channel per object ("kanbo:task:<id>",
   "kanbo:doc:<id>", "kanbo:project:<id>"), private (Realtime
   Authorization: the policies on realtime.messages that 0048 adds — see
   docs/integrations/presence.md), shared by every hook in the tab that
   wants it (ref-counted, so a task panel's avatars and its typing line
   ride one channel; a quick close/re-open or React's StrictMode reuses it
   instead of racing a channel that's still leaving).
   • presence: who has it open. Each tab tracks one small object —
     { userId, name, color, clientId, state, taskId?, docId?, caret?, clk }
     — re-sent every PRESENCE_HEARTBEAT_MS while the tab is visible;
     someone whose beat stops (laptop lid, background tab) fades after
     PRESENCE_STALE_MS, measured on this clock (never trusting theirs).
   • broadcast: typing ("Theo is typing…") and, for docs, the block
     operations, carets and "saved" notices (lib/presence useDocCollab).
   Nothing beyond a name, an avatar colour and opaque ids goes on the wire.
   Graceful: demo mode gets a few scripted teammates (demoPeers, loaded
   on first use); tests and a refused / offline channel leave you alone
   (no peers, sends dropped) and never throw into a render.
   The heavy co-editing code lives in lib/presence (the docs chunk); this
   module stays small enough for the shell (list rows import it).
   ============================================================ */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Member, PresencePeer } from "../../data/types";
import { supabase } from "../../lib/supabase";
import { toOklch } from "../../lib/contrast";

export const PRESENCE_HEARTBEAT_MS = 15_000;
export const PRESENCE_STALE_MS = 45_000;
export const TYPING_THROTTLE_MS = 1_500;
export const TYPING_TTL_MS = 4_000;
/** doc ops go out at most this often with one other tab in the doc (more people: slower — lib/presence docOpThrottleMs) */
export const DOC_OP_THROTTLE_MS = 150;
/** a caret that moves without an edit (while typing it rides in the ops batch) */
export const CARET_THROTTLE_MS = 250;
/** a channel nobody uses any more closes after this (a re-open inside it reuses the channel) */
export const PRESENCE_LEAVE_GRACE_MS = 600;

export type PresenceKind = "task" | "doc" | "project";
/** the channel key for an object: "task:<id>" (the realtime channel is "kanbo:" + it).  [final] */
export function presenceKey(kind: PresenceKind, id: string): string {
  return `${kind}:${id}`;
}
/** the realtime topic for a key */
export const presenceTopic = (key: string): string => `kanbo:${key}`;

/** who you are on the wire */
export interface PresenceMe { userId: string; name: string; color: string }
export type PeerState = PresencePeer["state"];
export type PeerCaret = NonNullable<PresencePeer["caret"]>;

/** What each tab tracks on a channel (validated on the way in: see parseWirePresence). */
export interface WirePresence {
  userId: string;
  name: string;
  color: string;
  /** one per tab (the presence key) */
  clientId: string;
  state: PeerState;
  /** on a project channel: the task / doc they have open there */
  taskId?: string | null;
  docId?: string | null;
  /** docs: their caret (also broadcast as it moves) */
  caret?: PeerCaret | null;
  /** docs: their logical clock (newcomers catch up to it before their first edit) */
  clk?: number;
  /** their clock when they sent it (informational; staleness is measured here) */
  at: number;
}
/** A peer as the hub hands it to hooks: what they sent + when this tab last heard from them. */
export interface PeerEntry extends WirePresence { seenAt: number }

/* ------------------------------------------------------------ validation */

const ID_RE = /^[A-Za-z0-9_:.@-]{1,80}$/;
const STATES: readonly PeerState[] = ["viewing", "editing", "typing"];
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const cleanName = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return s || null;
};
const cleanColor = (v: unknown): string => (typeof v === "string" && v.length <= 64 && /^[#a-zA-Z0-9(),.%\s/-]*$/.test(v) ? v : "");
const intIn = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** A caret from the wire (null when malformed). */
export function parseCaret(raw: unknown): PeerCaret | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const offset = intIn(r.offset, 0, 1_000_000);
  if (!isId(r.blockId) || offset === null) return null;
  const extent = r.extent === undefined || r.extent === null ? undefined : intIn(r.extent, -1_000_000, 1_000_000);
  if (extent === null) return null;
  return extent ? { blockId: r.blockId, offset, extent } : { blockId: r.blockId, offset };
}

/** A presence entry from the wire → WirePresence, or null (anything odd is dropped, never trusted). */
export function parseWirePresence(raw: unknown): WirePresence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = cleanName(r.name);
  if (!isId(r.userId) || !isId(r.clientId) || !name) return null;
  const state = STATES.includes(r.state as PeerState) ? (r.state as PeerState) : "viewing";
  const out: WirePresence = { userId: r.userId, name, color: cleanColor(r.color), clientId: r.clientId, state, at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0 };
  if (isId(r.taskId)) out.taskId = r.taskId;
  if (isId(r.docId)) out.docId = r.docId;
  const caret = parseCaret(r.caret);
  if (caret) out.caret = caret;
  if (typeof r.clk === "number" && Number.isFinite(r.clk) && r.clk >= 0) out.clk = r.clk;
  return out;
}

/** The sender of a broadcast (typing, ops, carets): { userId, name, color, clientId } or null. */
export function parseSender(raw: unknown): { userId: string; name: string; color: string; clientId: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = cleanName(r.name);
  if (!isId(r.userId) || !isId(r.clientId) || !name) return null;
  return { userId: r.userId, name, color: cleanColor(r.color), clientId: r.clientId };
}

/* ------------------------------------------------------------ words */

/** "Sana" (first names, unless two people share one: then full names). */
export function shortNames(peers: readonly Pick<PresencePeer, "name">[]): string[] {
  const first = (n: string) => n.trim().split(/\s+/)[0] || n;
  const counts = new Map<string, number>();
  for (const p of peers) counts.set(first(p.name), (counts.get(first(p.name)) ?? 0) + 1);
  return peers.map((p) => ((counts.get(first(p.name)) ?? 0) > 1 ? p.name.trim() : first(p.name)));
}

/** "Sana is viewing" / "Sana and Theo are viewing" / "Sana, Theo and Maya are viewing" /
 *  "Sana, Theo and 2 others are viewing" */
export function presenceSentence(peers: readonly Pick<PresencePeer, "name">[], verb: "viewing" | "typing" | "editing" = "viewing"): string {
  const names = shortNames(peers);
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is ${verb}`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are ${verb}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are ${verb}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others are ${verb}`;
}

/** You, as the wire knows you, from the people the app has (null when you're not among them and have no name). */
export function presenceMeFrom(members: readonly Pick<Member, "id" | "name" | "color">[], userId: string | null | undefined, fallbackName?: string): PresenceMe | null {
  if (!userId) return null;
  const m = members.find((x) => x.id === userId);
  const name = (m?.name || fallbackName || "").trim();
  return name ? { userId, name, color: m?.color ?? "" } : null;
}

/* ------------------------------------------------------------ transports */

export type TransportStatus = "live" | "down" | "refused";
export interface TransportHandlers {
  /** this tab's presence key */
  self: string;
  /** every presence entry on the channel now (ours included) */
  onSync(entries: unknown[]): void;
  onBroadcast(event: string, payload: unknown): void;
  onStatus(status: TransportStatus): void;
}
export interface TransportChannel {
  track(state: WirePresence): void;
  untrack(): void;
  /** false when it couldn't go (not joined) */
  send(event: string, payload: Record<string, unknown>): boolean;
  close(): void;
}
export interface PresenceTransport {
  open(topic: string, h: TransportHandlers): TransportChannel;
}

const REFUSAL = /unauthori[sz]ed|permission|not allowed|denied|forbidden|private/i;

/** Supabase Realtime (private channels; presence keyed by tab; our own broadcasts not echoed). */
export function supabaseTransport(client: SupabaseClient): PresenceTransport {
  const leaving = new Map<string, Promise<void>>();
  return {
    open(topic, h) {
      let ch: RealtimeChannel | null = null;
      let closed = false;
      let retries = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const shut = () => {
        const c = ch;
        ch = null;
        if (!c) return;
        const gone: Promise<void> = client.removeChannel(c).then(() => {}, () => {})
          .finally(() => { if (leaving.get(topic) === gone) leaving.delete(topic); });
        leaving.set(topic, gone);
      };
      const reopen = () => {
        shut();
        if (closed) return;
        clearTimeout(timer);
        timer = setTimeout(() => void start(), Math.min(60_000, 2000 * 2 ** retries++));
      };
      const start = async () => {
        await leaving.get(topic);
        // one still registered under this topic (a leave that never settled) would be handed back: take it down
        for (let i = 0; i < 3 && !closed; i++) {
          const stale = client.getChannels().find((c) => c.topic === `realtime:${topic}`);
          if (!stale) break;
          await client.removeChannel(stale).catch(() => "error");
        }
        if (closed) return;
        const c = client.channel(topic, { config: { private: true, presence: { key: h.self }, broadcast: { self: false, ack: false } } });
        c.on("presence", { event: "sync" }, () => { if (ch === c) h.onSync(Object.values(c.presenceState()).flat()); });
        c.on("broadcast", { event: "*" }, (m: { event: string; payload?: unknown }) => { if (ch === c) h.onBroadcast(m.event, m.payload); });
        ch = c;
        c.subscribe((status, err) => {
          if (ch !== c || closed) return;
          if (status === "SUBSCRIBED") { retries = 0; h.onStatus("live"); }
          else if (status === "CHANNEL_ERROR") {
            if (REFUSAL.test(String((err as { message?: string } | undefined)?.message ?? err ?? ""))) { h.onStatus("refused"); shut(); }
            else h.onStatus("down"); // the client rejoins by itself
          } else if (status === "TIMED_OUT") h.onStatus("down");
          else if (status === "CLOSED") { h.onStatus("down"); reopen(); }
        });
      };
      start().catch(() => h.onStatus("down"));
      return {
        track: (state) => { ch?.track(state as unknown as Record<string, unknown>).catch(() => "error"); },
        untrack: () => { ch?.untrack().catch(() => "error"); },
        send: (event, payload) => {
          if (!ch) return false;
          ch.send({ type: "broadcast", event, payload }).catch(() => "error");
          return true;
        },
        close: () => { closed = true; clearTimeout(timer); shut(); },
      };
    },
  };
}

/* ------------------------------------------------------------ the hub */

/** What one hook brings to a channel. */
export interface PresenceSub {
  me: PresenceMe;
  /** what it adds to this tab's presence (null: watch only, e.g. a typing line) */
  contribute?: () => Partial<Pick<WirePresence, "state" | "taskId" | "docId" | "caret" | "clk">> | null;
  onPeers?: (peers: PeerEntry[]) => void;
  onBroadcast?: (event: string, payload: unknown) => void;
  onLive?: (live: boolean) => void;
}
export interface PresenceConn {
  /** broadcast to the others (false when not live: it isn't queued) */
  send(event: string, payload: Record<string, unknown>): boolean;
  /** this hook's contribution changed */
  retrack(): void;
  leave(): void;
  readonly live: boolean;
  /** how many other tabs are on the channel now — faded ones too (a background tab still receives); null until
   *  the channel has said who's there since it came up */
  readonly others: number | null;
}
export interface PresenceClient {
  readonly clientId: string;
  join(key: string, sub: PresenceSub): PresenceConn;
}

interface Topic {
  key: string;
  subs: Set<PresenceSub>;
  ch: TransportChannel | null;
  live: boolean;
  refused: boolean;
  entries: Map<string, PeerEntry>;
  sigs: Map<string, string>;
  leaveTimer: ReturnType<typeof setTimeout> | undefined;
  trackQueued: boolean;
  lastTrack: string;
  tracked: boolean;
  /** the client ids last handed to the hooks as fresh */
  shown: string;
  /** a presence sync arrived since the channel came up (entries is who's there) */
  heard: boolean;
}

const RANK: Record<PeerState, number> = { viewing: 1, editing: 2, typing: 3 };
const randomId = (): string => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
};

export interface PresenceClientOptions {
  clientId?: string;
  now?: () => number;
  /** watch document visibility (default true): a hidden tab stops its heartbeat */
  visibility?: boolean;
}

/** A hub over a transport (or a promise of one: the demo's is loaded on first use; null = always alone). */
export function createPresenceClient(
  transport: PresenceTransport | null | (() => PresenceTransport | null | Promise<PresenceTransport | null>),
  opts: PresenceClientOptions = {},
): PresenceClient {
  const clientId = opts.clientId ?? randomId();
  const now = opts.now ?? (() => Date.now());
  const topics = new Map<string, Topic>();
  let tp: Promise<PresenceTransport | null> | PresenceTransport | null = typeof transport === "function" ? null : transport;
  let tpLoaded = typeof transport !== "function";
  const getTransport = (): Promise<PresenceTransport | null> | PresenceTransport | null => {
    if (!tpLoaded) {
      tpLoaded = true;
      try {
        const r = (transport as () => PresenceTransport | null | Promise<PresenceTransport | null>)();
        tp = r instanceof Promise ? r.then((t) => (tp = t), () => (tp = null)) : r;
      } catch { tp = null; }
    }
    return tp;
  };
  let beat: ReturnType<typeof setInterval> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const hidden = () => opts.visibility !== false && typeof document !== "undefined" && document.visibilityState === "hidden";

  const merged = (t: Topic): WirePresence | null => {
    let me: PresenceMe | null = null;
    let any = false;
    const out: Partial<WirePresence> = {};
    let rank = 0;
    for (const s of t.subs) {
      me ??= s.me;
      const c = s.contribute?.();
      if (!c) continue;
      any = true;
      const st = c.state ?? "viewing";
      if (RANK[st] > rank) { rank = RANK[st]; out.state = st; }
      if (c.taskId !== undefined && c.taskId !== null) out.taskId = c.taskId;
      if (c.docId !== undefined && c.docId !== null) out.docId = c.docId;
      if (c.caret !== undefined) out.caret = c.caret;
      if (c.clk !== undefined) out.clk = Math.max(out.clk ?? 0, c.clk);
    }
    if (!any || !me) return null;
    return { userId: me.userId, name: me.name, color: me.color, clientId, state: out.state ?? "viewing", taskId: out.taskId ?? null, docId: out.docId ?? null, caret: out.caret ?? null, ...(out.clk !== undefined ? { clk: out.clk } : {}), at: now() };
  };

  const doTrack = (t: Topic, force = false) => {
    t.trackQueued = false;
    if (!t.ch || !t.live) return;
    const p = merged(t);
    if (!p) {
      if (t.tracked) { t.ch.untrack(); t.tracked = false; t.lastTrack = ""; }
      return;
    }
    const { at: _at, ...rest } = p;
    const sig = JSON.stringify(rest);
    if (!force && sig === t.lastTrack) return;
    t.lastTrack = sig;
    t.tracked = true;
    t.ch.track(p);
  };
  const queueTrack = (t: Topic) => {
    if (t.trackQueued) return;
    t.trackQueued = true;
    queueMicrotask(() => { if (t.trackQueued) doTrack(t); });
  };

  const fresh = (t: Topic): PeerEntry[] => {
    const cut = now() - PRESENCE_STALE_MS;
    return [...t.entries.values()].filter((e) => e.seenAt >= cut);
  };
  const deliver = (t: Topic) => {
    const list = fresh(t);
    t.shown = list.map((e) => e.clientId).join(",");
    for (const s of [...t.subs]) {
      try { s.onPeers?.(list); } catch { /* a hook's problem never stops the others */ }
    }
    scheduleStale();
  };
  // re-deliver when the next peer goes stale (it stays known, so an unchanged state in a later sync — someone
  // else's heartbeat — doesn't bring it back as fresh; a beat of its own does)
  const scheduleStale = () => {
    clearTimeout(staleTimer);
    const t0 = now();
    let next = Infinity;
    for (const t of topics.values()) for (const e of t.entries.values()) if (e.seenAt + PRESENCE_STALE_MS >= t0) next = Math.min(next, e.seenAt + PRESENCE_STALE_MS);
    if (next === Infinity) return;
    staleTimer = setTimeout(() => {
      for (const t of topics.values()) {
        const shown = fresh(t).map((e) => e.clientId).join(",");
        if (shown !== t.shown) deliver(t);
      }
      scheduleStale();
    }, Math.max(250, next - now() + 50));
  };

  const ensureBeat = () => {
    if (beat !== undefined || typeof setInterval === "undefined") return;
    beat = setInterval(() => {
      if (hidden()) return; // a background tab lets its presence fade
      for (const t of topics.values()) doTrack(t, true);
    }, PRESENCE_HEARTBEAT_MS);
  };
  const stopBeatIfIdle = () => {
    if (topics.size || beat === undefined) return;
    clearInterval(beat);
    beat = undefined;
  };
  if (opts.visibility !== false && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (hidden()) return;
      for (const t of topics.values()) doTrack(t, true);
    });
  }

  const setLive = (t: Topic, live: boolean) => {
    if (t.live === live) return;
    t.live = live;
    if (!live) {
      t.tracked = false; t.lastTrack = ""; t.heard = false;
      if (t.entries.size) { t.entries.clear(); t.sigs.clear(); deliver(t); }
    }
    for (const s of [...t.subs]) { try { s.onLive?.(live); } catch { /* ignore */ } }
    if (live) doTrack(t, true);
  };

  const open = (t: Topic) => {
    const attach = (tr: PresenceTransport | null) => {
      if (!tr || topics.get(t.key) !== t || !t.subs.size || t.ch) return;
      try {
        t.ch = tr.open(presenceTopic(t.key), {
          self: clientId,
          onSync: (raw) => {
            if (topics.get(t.key) !== t) return;
            t.heard = true;
            const seen = new Set<string>();
            let changed = false;
            const at = now();
            for (const r of raw) {
              const w = parseWirePresence(r);
              if (!w || w.clientId === clientId || seen.has(w.clientId)) continue;
              seen.add(w.clientId);
              const { at: _a, ...rest } = w;
              const sig = JSON.stringify(rest) + "|" + w.at;
              const prev = t.entries.get(w.clientId);
              if (!prev || t.sigs.get(w.clientId) !== sig) {
                t.entries.set(w.clientId, { ...w, seenAt: at });
                t.sigs.set(w.clientId, sig);
                changed = true;
              }
            }
            for (const k of [...t.entries.keys()]) if (!seen.has(k)) { t.entries.delete(k); t.sigs.delete(k); changed = true; }
            if (changed) deliver(t);
          },
          onBroadcast: (event, payload) => {
            if (topics.get(t.key) !== t) return;
            for (const s of [...t.subs]) { try { s.onBroadcast?.(event, payload); } catch { /* ignore */ } }
          },
          onStatus: (status) => {
            if (topics.get(t.key) !== t) return;
            if (status === "refused") {
              t.refused = true;
              if (!reportedRefusal) {
                reportedRefusal = true;
                console.info("[kanbo] Live presence is off: the realtime policies for kanbo:* channels aren't installed (0048).");
              }
            }
            setLive(t, status === "live");
          },
        });
      } catch { t.ch = null; }
    };
    const tr = getTransport();
    if (tr instanceof Promise) void tr.then(attach, () => {});
    else attach(tr);
  };
  const close = (t: Topic) => {
    if (topics.get(t.key) === t) topics.delete(t.key);
    try { if (t.tracked) t.ch?.untrack(); t.ch?.close(); } catch { /* ignore */ }
    t.ch = null;
    t.live = false;
    stopBeatIfIdle();
  };

  return {
    clientId,
    join(key, sub) {
      let t = topics.get(key);
      if (!t) {
        t = { key, subs: new Set(), ch: null, live: false, refused: false, entries: new Map(), sigs: new Map(), leaveTimer: undefined, trackQueued: false, lastTrack: "", tracked: false, shown: "", heard: false };
        topics.set(key, t);
        t.subs.add(sub);
        open(t);
      } else {
        if (t.leaveTimer !== undefined) { clearTimeout(t.leaveTimer); t.leaveTimer = undefined; }
        t.subs.add(sub);
        if (!t.ch && !t.refused) open(t);
        if (t.entries.size) {
          const list = fresh(t);
          queueMicrotask(() => { if (t!.subs.has(sub)) sub.onPeers?.(list); });
        }
        if (t.live) queueMicrotask(() => { if (t!.subs.has(sub)) sub.onLive?.(true); });
      }
      ensureBeat();
      queueTrack(t);
      const topic = t;
      let left = false;
      return {
        send(event, payload) {
          if (left || !topic.live || !topic.ch) return false;
          try { return topic.ch.send(event, payload); } catch { return false; }
        },
        retrack() { if (!left) queueTrack(topic); },
        leave() {
          if (left) return;
          left = true;
          topic.subs.delete(sub);
          if (topic.subs.size) { queueTrack(topic); return; }
          topic.leaveTimer = setTimeout(() => { topic.leaveTimer = undefined; if (!topic.subs.size) close(topic); }, PRESENCE_LEAVE_GRACE_MS);
        },
        get live() { return !left && topic.live; },
        get others() { return !left && topic.live && topic.heard ? topic.entries.size : null; },
      };
    },
  };
}
let reportedRefusal = false;

/* ------------------------------------------------------------ the default client */

const IS_TEST = (() => { try { return import.meta.env?.MODE === "test"; } catch { return false; } })();
let defaultClient: PresenceClient | null | undefined;

/** The app's hub: Supabase when configured, the scripted demo teammates otherwise; none in tests. */
export function defaultPresenceClient(): PresenceClient | null {
  if (defaultClient !== undefined) return defaultClient;
  if (IS_TEST) return (defaultClient = null);
  const client = supabase;
  defaultClient = client
    ? createPresenceClient(supabaseTransport(client))
    : createPresenceClient(() => import("./demoPeers").then((m) => m.demoTransport(), () => null));
  return defaultClient;
}

/** Provide a different hub below (tests; a second "tab" in a test). null = alone. */
export const PresenceContext = createContext<PresenceClient | null | undefined>(undefined);
export function usePresenceClient(): PresenceClient | null {
  const c = useContext(PresenceContext);
  return c === undefined ? defaultPresenceClient() : c;
}

/* ------------------------------------------------------------ peers */

export const NO_PEERS: PresencePeer[] = [];

/** Entries → peers: never you (any of your tabs); one per person (their liveliest tab), in the order they came. */
export function toPeers(entries: readonly PeerEntry[], meUserId: string | null | undefined): PresencePeer[] {
  const by = new Map<string, PresencePeer>();
  for (const e of entries) {
    if (e.userId === meUserId) continue;
    const prev = by.get(e.userId);
    const peer: PresencePeer = { userId: e.userId, name: e.name, color: e.color, state: e.state, caret: e.caret ?? null, at: e.seenAt };
    if (!prev) { by.set(e.userId, peer); continue; }
    by.set(e.userId, {
      ...prev,
      state: RANK[e.state] > RANK[prev.state] ? e.state : prev.state,
      caret: prev.caret ?? peer.caret,
      at: Math.max(prev.at, peer.at),
    });
  }
  return by.size ? [...by.values()] : NO_PEERS;
}

const peersKey = (list: readonly PresencePeer[]) => list.map((p) => `${p.userId}|${p.name}|${p.color}|${p.state}|${p.caret ? `${p.caret.blockId}:${p.caret.offset}:${p.caret.extent ?? 0}` : ""}`).join(",");
/** keep the old array when nothing a renderer cares about changed (so rows don't re-render on every heartbeat) */
export function samePeers(a: readonly PresencePeer[], b: readonly PresencePeer[]): boolean {
  return a === b || (a.length === b.length && peersKey(a) === peersKey(b));
}

/** what a project's rows and header show of its entries (a heartbeat that only moves seenAt changes none of it) */
const entriesKey = (list: readonly PeerEntry[]) => list.map((e) => `${e.clientId}|${e.userId}|${e.name}|${e.color}|${e.state}|${e.taskId ?? ""}|${e.docId ?? ""}`).join(",");

const meKeyOf = (me: PresenceMe | null | undefined) => (me ? `${me.userId}\u0000${me.name}\u0000${me.color}` : "");
/** the same PresenceMe object while its fields stay the same (callers often build it inline) */
export function useStableMe(me: PresenceMe | null | undefined): PresenceMe | null {
  const key = meKeyOf(me);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (me ? { userId: me.userId, name: me.name, color: me.color } : null), [key]);
}

/* ------------------------------------------------------------ hooks */

/** Others on this object (never you). key null = not joined.
 *  opts.state: what you're doing there (default viewing); opts.projectId: also say so on the project's
 *  channel, so its list rows / cards can show who has which task (or doc) open. */
export function usePresence(key: string | null, me: PresenceMe | null, opts?: { state?: PresencePeer["state"]; projectId?: string | null }): { peers: PresencePeer[] } {
  const client = usePresenceClient();
  const stableMe = useStableMe(me);
  const [peers, setPeers] = useState<PresencePeer[]>(NO_PEERS);
  const state = opts?.state ?? "viewing";
  const stateRef = useRef(state);
  stateRef.current = state;
  const conns = useRef<PresenceConn[]>([]);
  const projectId = opts?.projectId ?? null;
  useEffect(() => {
    if (!client || !key || !stableMe) { setPeers(NO_PEERS); return; }
    const sub: PresenceSub = {
      me: stableMe,
      contribute: () => ({ state: stateRef.current }),
      onPeers: (list) => { const next = toPeers(list, stableMe.userId); setPeers((prev) => (samePeers(prev, next) ? prev : next)); },
    };
    const list = [client.join(key, sub)];
    if (projectId && !key.startsWith("project:")) {
      const [kind, ...rest] = key.split(":");
      const id = rest.join(":");
      list.push(client.join(presenceKey("project", projectId), {
        me: stableMe,
        contribute: () => ({ state: stateRef.current, taskId: kind === "task" ? id : null, docId: kind === "doc" ? id : null }),
      }));
    }
    conns.current = list;
    return () => { list.forEach((c) => c.leave()); conns.current = []; setPeers(NO_PEERS); };
  }, [client, key, stableMe, projectId]);
  useEffect(() => { conns.current.forEach((c) => c.retrack()); }, [state]);
  return { peers };
}

/** Who's in a project and what they have open: for the project header ("Sana is viewing") and list rows / board
 *  cards (viewersOf(task.id) → small avatars). Being on the project page counts as viewing it; `watchOnly` (rows in
 *  My tasks, Today, a board of several projects) shows who's there without saying you are. */
export function useProjectPresence(projectId: string | null, me: PresenceMe | null, opts?: { taskId?: string | null; watchOnly?: boolean }): {
  peers: PresencePeer[];
  viewersOf: (taskId: string) => PresencePeer[];
  onDoc: (docId: string) => PresencePeer[];
} {
  const client = usePresenceClient();
  const stableMe = useStableMe(me);
  const [entries, setEntries] = useState<PeerEntry[]>([]);
  const taskRef = useRef(opts?.taskId ?? null);
  taskRef.current = opts?.taskId ?? null;
  const watchOnly = !!opts?.watchOnly;
  const conn = useRef<PresenceConn | null>(null);
  const shownKey = useRef("");
  useEffect(() => {
    if (!client || !projectId || !stableMe) { shownKey.current = ""; setEntries([]); return; }
    const c = client.join(presenceKey("project", projectId), {
      me: stableMe,
      contribute: watchOnly ? undefined : () => ({ state: "viewing", taskId: taskRef.current }),
      // (each peer's heartbeat delivers again: only a change the rows can show re-renders anything)
      onPeers: (list) => {
        const k = entriesKey(list);
        if (k === shownKey.current) return;
        shownKey.current = k;
        setEntries(list);
      },
    });
    conn.current = c;
    return () => { c.leave(); conn.current = null; shownKey.current = ""; setEntries([]); };
  }, [client, projectId, stableMe, watchOnly]);
  useEffect(() => { conn.current?.retrack(); }, [opts?.taskId]);
  const peersRef = useRef<PresencePeer[]>(NO_PEERS);
  // (a row whose viewers didn't change keeps the same array: memoised rows don't re-render for someone else's)
  const groupsRef = useRef({ tasks: new Map<string, PresencePeer[]>(), docs: new Map<string, PresencePeer[]>() });
  return useMemo(() => {
    const uid = stableMe?.userId;
    const all = toPeers(entries, uid);
    const peers = samePeers(peersRef.current, all) ? peersRef.current : all;
    peersRef.current = peers;
    const group = (pick: (e: PeerEntry) => string | null | undefined, before: Map<string, PresencePeer[]>) => {
      const m = new Map<string, PeerEntry[]>();
      for (const e of entries) { const k = pick(e); if (k) m.set(k, [...(m.get(k) ?? []), e]); }
      const out = new Map<string, PresencePeer[]>();
      for (const [k, list] of m) {
        const next = toPeers(list, uid);
        const old = before.get(k);
        out.set(k, old && samePeers(old, next) ? old : next);
      }
      return out;
    };
    const tasks = group((e) => e.taskId, groupsRef.current.tasks);
    const docs = group((e) => e.docId, groupsRef.current.docs);
    groupsRef.current = { tasks, docs };
    return {
      peers,
      viewersOf: (taskId: string) => tasks.get(taskId) ?? NO_PEERS,
      onDoc: (docId: string) => docs.get(docId) ?? NO_PEERS,
    };
  }, [entries, stableMe]);
}

/** Comment typing on a task: others typing, and a function to call on each keystroke (throttled inside). */
export function useTyping(taskId: string | null, me: PresenceMe | null): { typers: PresencePeer[]; notifyTyping: () => void; stopTyping: () => void } {
  const client = usePresenceClient();
  const stableMe = useStableMe(me);
  const [typers, setTypers] = useState<PresencePeer[]>(NO_PEERS);
  const conn = useRef<PresenceConn | null>(null);
  const sent = useRef({ on: false, at: 0 });
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const payload = useCallback((on: boolean) => (stableMe ? { userId: stableMe.userId, name: stableMe.name, color: stableMe.color, clientId: client?.clientId ?? "", on, at: Date.now() } : null), [stableMe, client]);
  const stopTyping = useCallback(() => {
    clearTimeout(idle.current);
    if (!sent.current.on) return;
    sent.current = { on: false, at: 0 };
    const p = payload(false);
    if (p) conn.current?.send("typing", p);
  }, [payload]);
  const notifyTyping = useCallback(() => {
    const c = conn.current;
    if (!c || !c.live) return;
    const t = Date.now();
    clearTimeout(idle.current);
    // quiet for a while: say you've stopped (they'd drop you after TYPING_TTL_MS anyway)
    idle.current = setTimeout(stopTyping, TYPING_TTL_MS - 1000);
    if (sent.current.on && t - sent.current.at < TYPING_THROTTLE_MS) return;
    const p = payload(true);
    if (p && c.send("typing", p)) sent.current = { on: true, at: t };
  }, [payload, stopTyping]);

  useEffect(() => {
    if (!client || !taskId || !stableMe) { setTypers(NO_PEERS); return; }
    const until = new Map<string, { peer: PresencePeer; until: number }>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      const t = Date.now();
      for (const [k, v] of until) if (v.until <= t) until.delete(k);
      const next = until.size ? [...until.values()].map((v) => v.peer) : NO_PEERS;
      setTypers((prev) => (samePeers(prev, next) ? prev : next));
      clearTimeout(timer);
      if (until.size) timer = setTimeout(publish, Math.max(50, Math.min(...[...until.values()].map((v) => v.until)) - t + 10));
    };
    const c = client.join(presenceKey("task", taskId), {
      me: stableMe,
      onBroadcast: (event, raw) => {
        if (event !== "typing") return;
        const s = parseSender(raw);
        if (!s || s.userId === stableMe.userId) return;
        const on = (raw as { on?: unknown }).on === true;
        if (on) until.set(s.userId, { peer: { userId: s.userId, name: s.name, color: s.color, state: "typing", at: Date.now() }, until: Date.now() + TYPING_TTL_MS });
        else until.delete(s.userId);
        publish();
      },
      onLive: (live) => { if (!live) { until.clear(); publish(); } },
    });
    conn.current = c;
    return () => {
      clearTimeout(timer);
      if (sent.current.on) { const p = payload(false); if (p) c.send("typing", p); }
      sent.current = { on: false, at: 0 };
      clearTimeout(idle.current);
      c.leave();
      conn.current = null;
      setTypers(NO_PEERS);
    };
  }, [client, taskId, stableMe, payload]);
  return { typers, notifyTyping, stopTyping };
}

/* ------------------------------------------------------------ colour */

/** A person's hue (from their avatar colour; a grey or unreadable colour takes the brand navy, as Avatar does).
 *  Only this number reaches CSS — a colour string from the wire never does. */
export function peerHue(color: string): number {
  const o = color ? toOklch(color) : null;
  return o && o.c >= 0.03 ? Math.round(o.h) : 268;
}
