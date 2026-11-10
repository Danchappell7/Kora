/* ============================================================
   KANBO — how the "Run meeting" buttons (Pulse, the Group page, each
   business there) and the Inbox reach the one meeting host App mounts
   (MeetingsHost): a request to start one (with its scope) or to open
   one. And the live meetings those buttons show ("Live now · Join"),
   read once and kept fresh for every button by one subscription.
   ============================================================ */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { liveMeetings, probeMeetings, subscribeLiveMeetings, subscribeMeetingsMode, meetingsMode, type MeetingsMode } from "../../lib/meetings/sync";
import type { Meeting, MeetingPreset } from "../../lib/meetings/types";
// (the demo's meetings and teammates: installed when the demo starts, before any button reads)
import "../../lib/meetings/demo";

/** Where a meeting is started from, and what it covers. */
export interface MeetingScope {
  /** the host business */
  workspaceId: string;
  /** a Group meeting: every business it covers (the host among them) */
  workspaceIds?: string[];
  /** the kind it starts as (the sheet can change it where you may run either) */
  preset: MeetingPreset;
  /** may the person starting it run a leadership meeting here? */
  canLead: boolean;
}

export type MeetingRequest = { kind: "start"; scope: MeetingScope } | { kind: "open"; id: string };

let request: MeetingRequest | null = null;
const reqListeners = new Set<() => void>();
const emit = () => reqListeners.forEach((fn) => fn());

/** Ask the host to open the start sheet. */
export function requestMeetingStart(scope: MeetingScope): void { request = { kind: "start", scope }; emit(); }
/** Ask the host to open a meeting (live: the room; ended: its recap). */
export function requestMeetingOpen(id: string): void { request = { kind: "open", id }; emit(); }
export function clearMeetingRequest(): void { if (request) { request = null; emit(); } }
export function useMeetingRequest(): MeetingRequest | null {
  return useSyncExternalStore((fn) => { reqListeners.add(fn); return () => { reqListeners.delete(fn); }; }, () => request, () => null);
}

/* ---------- live meetings, shared by every button ---------- */

let live: Meeting[] = [];
let watched: string[] = [];
const liveListeners = new Set<() => void>();
const wants = new Map<number, string[]>();
let seq = 0;
let unsub: (() => void) | null = null;
let fetching = 0;

async function refresh(): Promise<void> {
  const ids = [...new Set([...wants.values()].flat())].sort();
  watched = ids;
  const n = ++fetching;
  const got = ids.length ? await liveMeetings(ids).catch(() => [] as Meeting[]) : [];
  if (n !== fetching) return;
  live = got;
  liveListeners.forEach((fn) => fn());
}

function want(id: number, ids: string[]): () => void {
  wants.set(id, ids);
  if (!unsub) unsub = subscribeLiveMeetings(() => { void refresh(); }, () => new Map(live.map((m) => [m.id, m.status])));
  if (ids.some((x) => !watched.includes(x))) void refresh();
  return () => {
    wants.delete(id);
    if (!wants.size && unsub) { unsub(); unsub = null; live = []; watched = []; }
  };
}

/** Tests: start over. */
export function resetMeetingBus(): void {
  request = null; live = []; watched = []; wants.clear(); fetching = 0;
  if (unsub) { unsub(); unsub = null; }
}

/** Tell every "Live now" button to look again (after you start or end one). */
export function refreshLiveMeetings(): void { if (wants.size) void refresh(); }

/** The live meetings in these businesses (kept fresh while mounted). */
export function useLiveMeetings(workspaceIds: readonly string[]): Meeting[] {
  const key = [...new Set(workspaceIds.filter(Boolean))].sort().join(",");
  useEffect(() => {
    if (!key) return;
    return want(++seq, key.split(","));
  }, [key]);
  const all = useSyncExternalStore((fn) => { liveListeners.add(fn); return () => { liveListeners.delete(fn); }; }, () => live, () => live);
  return useMemo(() => { const ids = key.split(","); return all.filter((m) => ids.includes(m.workspaceId)); }, [all, key]);
}

/** Where meetings live (shared once 0056 is on; this browser before it, and in the demo). */
export function useMeetingsMode(): MeetingsMode {
  useEffect(() => { void probeMeetings(); }, []);
  return useSyncExternalStore(subscribeMeetingsMode, meetingsMode, meetingsMode);
}
