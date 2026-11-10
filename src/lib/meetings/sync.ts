/* ============================================================
   KANBO — meetings: loading, live changes and saves (0056).
   Reads with select("*") (RLS decides what comes back: a guest gets
   nothing, a member no leadership meeting); writes only through the
   migration's functions. Live: one realtime channel per open meeting
   (the meeting row for the presenter's place, its items and who's
   joined), and one for "a meeting started or ended here".
   Before 0056 is run the tables aren't there: the first read says so
   (status "off") and meetings run in this browser alone (the same calls
   on an in-memory copy: nobody else sees them, no recap is sent; the
   notes doc still saves). The demo (no Supabase) uses that copy too,
   seeded with last week's meetings, and its teammates join, watch and
   present (lib/meetings/demo).
   ============================================================ */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../supabase";
import { reportError } from "../monitoring";
import { parseAgenda, type AgendaItem, type Meeting, type MeetingAttendee, type MeetingItem, type MeetingItemKind, type MeetingPreset } from "./types";

/* ---------- rows ---------- */

interface MeetingRow {
  id: string; workspace_id: string; workspace_ids: string[] | null; preset: string; title: string; status: string; agenda: unknown;
  place: number | null; place_key: string | null; moved_at: string | null; presenter_id: string | null; started_by: string | null;
  started_at: string; ended_at: string | null; ended_by: string | null; previous_id: string | null; doc_id: string | null; doc_project_id: string | null;
}
interface ItemRow {
  id: string; meeting_id: string; kind: string; body: string; agenda_key: string | null; owner_id: string | null; due_on: string | null;
  task_id: string | null; created_by: string | null; created_at: string;
}
interface AttendeeRow { user_id: string; invited: boolean | null; joined_at: string | null }

export const rowToMeeting = (r: MeetingRow): Meeting => ({
  id: r.id, workspaceId: r.workspace_id, workspaceIds: Array.isArray(r.workspace_ids) && r.workspace_ids.length ? r.workspace_ids : [r.workspace_id],
  preset: r.preset === "leadership" ? "leadership" : "team", title: r.title, status: r.status === "ended" ? "ended" : "live",
  agenda: parseAgenda(r.agenda), place: Math.max(0, r.place ?? 0), placeKey: r.place_key ?? null, movedAt: r.moved_at ?? r.started_at,
  presenterId: r.presenter_id, startedBy: r.started_by, startedAt: r.started_at, endedAt: r.ended_at, endedBy: r.ended_by,
  previousId: r.previous_id, docId: r.doc_id, docProjectId: r.doc_project_id,
});
export const rowToItem = (r: ItemRow): MeetingItem => ({
  id: r.id, meetingId: r.meeting_id, kind: r.kind === "decision" || r.kind === "action" ? r.kind : "note", body: r.body,
  agendaKey: r.agenda_key, ownerId: r.owner_id, due: r.due_on ? String(r.due_on).slice(0, 10) : null, taskId: r.task_id,
  createdBy: r.created_by, createdAt: r.created_at,
});
const rowToAttendee = (r: AttendeeRow): MeetingAttendee => ({ userId: r.user_id, invited: r.invited !== false, joinedAt: r.joined_at });

/** The table or function isn't there yet (0056 not run): Postgres or PostgREST says so. */
export function isMissingSchema(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? "");
  if (["42P01", "PGRST205", "42703", "PGRST204", "42883", "PGRST202"].includes(code)) return true;
  const msg = String((e as { message?: unknown })?.message ?? "");
  return /(meetings|meeting_items|meeting_attendees|start_meeting|move_meeting|end_meeting|add_meeting_item)/.test(msg)
    && /does not exist|could not find|schema cache/i.test(msg);
}

/** What a refused change says, in the app's words. */
export function meetingErrorText(e: unknown): string {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  if (isMissingSchema(e)) return "Shared meetings aren't switched on yet. Ask the workspace owner to run the 0056 update.";
  if (/already running/.test(msg)) return "A meeting like this is already running here. Join it instead.";
  if (/not the presenter/.test(msg)) return "Only the presenter moves the agenda. Present from here to take over.";
  if (/need to be in the meeting/.test(msg)) return "They need to have joined the meeting first.";
  if (/must be on the team/.test(msg)) return "An action's owner has to be on the team (not a guest).";
  if (/meeting ended|meeting closed/.test(msg)) return "This meeting has ended.";
  if (/too many/.test(msg)) return "That's a lot for one meeting. Start a fresh one.";
  if (/invalid/.test(msg)) return "That doesn't look right. Check it and try again.";
  if (/not authorized/.test(msg)) return "You can't do that here.";
  return "Couldn't save that. Check your connection and try again.";
}

export type Result<T> = { ok: true; data: T } | { ok: false; message: string; missing?: boolean };
const fail = <T>(e: unknown, op: string): Result<T> => {
  const missing = isMissingSchema(e);
  if (missing) markOff();
  else if (!/not authorized|invalid|already running|not the presenter|need to be in|must be on the team|meeting ended|meeting closed|too many/.test(String((e as { message?: unknown })?.message ?? ""))) {
    reportError(e, { op });
  }
  return { ok: false, message: meetingErrorText(e), ...(missing ? { missing: true } : {}) };
};

/* ---------- on, off, or here only ---------- */

export type MeetingsMode = "unknown" | "shared" | "local";
let mode: MeetingsMode = supabase ? "unknown" : "local";
let probe: Promise<MeetingsMode> | null = null;
const modeListeners = new Set<() => void>();
function markOff(): void {
  if (mode === "local") return;
  mode = "local";
  modeListeners.forEach((fn) => fn());
}
/** Where meetings live: "shared" (0056 is on), "local" (this browser: the demo, or before 0056), "unknown" (not asked yet). */
export const meetingsMode = (): MeetingsMode => mode;
/** Is this the demo's copy (its teammates join and present)? */
export const isDemoMeetings = (): boolean => !supabase;
export function subscribeMeetingsMode(fn: () => void): () => void { modeListeners.add(fn); return () => { modeListeners.delete(fn); }; }

/** Ask once whether 0056 is on (the meetings table answers). */
export function probeMeetings(): Promise<MeetingsMode> {
  if (mode !== "unknown") return Promise.resolve(mode);
  if (!supabase) return Promise.resolve((mode = "local"));
  const client = supabase;
  probe ??= (async () => {
    try {
      const { error } = await client.from("meetings").select("id").limit(1);
      if (error) {
        if (isMissingSchema(error)) { markOff(); return mode; }
        probe = null;
        return "unknown";   // a blip: ask again next time
      }
      mode = "shared";
      modeListeners.forEach((fn) => fn());
      return mode;
    } catch (e) {
      reportError(e, { op: "meetings-probe" });
      probe = null;
      return "unknown";
    }
  })();
  return probe;
}

const shared = () => mode === "shared" && !!supabase;

/* ---------- this browser's copy (the demo, and before 0056) ---------- */

type Listener = (c: MeetingChange) => void;
/** What changed in an open meeting: its row (the presenter's place), its items, or who's in it. */
export type MeetingChange = { meeting?: Meeting; items?: MeetingItem[]; attendees?: MeetingAttendee[] };

interface Mem {
  meetings: Map<string, Meeting>;
  items: Map<string, MeetingItem[]>;
  attendees: Map<string, MeetingAttendee[]>;
  listeners: Map<string, Set<Listener>>;
  live: Set<() => void>;
}
let mem: Mem | null = null;
let memSeq = 0;
let seeder: ((m: Mem) => void) | null = null;
/** (lib/meetings/demo) the demo's last meetings, put in the first time the copy is used */
export function setDemoSeeder(fn: (m: Pick<Mem, "meetings" | "items" | "attendees">) => void): void { seeder = fn; }
const memDb = (): Mem => {
  if (mem) return mem;
  mem = { meetings: new Map(), items: new Map(), attendees: new Map(), listeners: new Map(), live: new Set() };
  if (!supabase && seeder) seeder(mem);
  return mem;
};
/** Tests: forget the in-memory meetings. */
export function resetMeetings(): void {
  mem = null; memSeq = 0; probe = null;
  mode = supabase ? "unknown" : "local";
  hooks.forEach((h) => h.reset?.());
}
const memId = (p: string) => `${p}-${Date.now().toString(36)}-${(++memSeq).toString(36)}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function tell(id: string, c: MeetingChange): void {
  const m = memDb();
  const ls = m.listeners.get(id);
  if (ls) queueMicrotask(() => ls.forEach((fn) => fn(c)));
  if (c.meeting) queueMicrotask(() => m.live.forEach((fn) => fn()));
}

/** (lib/meetings/demo) the demo's teammates act through these, as a real teammate's browser would. */
export interface MemHooks {
  /** a meeting started (or the presenter changed): the demo may join and present */
  onChange?: (meeting: Meeting) => void;
  reset?: () => void;
}
const hooks = new Set<MemHooks>();
export function addMemHooks(h: MemHooks): () => void { hooks.add(h); return () => { hooks.delete(h); }; }

/** (demo) change a meeting as someone else would: the presenter's place, who presents, who's joined. */
export function memAct(id: string, by: string, act: { place?: number; presenterId?: string; join?: boolean }): Meeting | null {
  const db = memDb();
  const cur = db.meetings.get(id);
  if (!cur || cur.status !== "live") return null;
  let next = cur;
  if (act.place !== undefined) {
    const place = Math.max(0, Math.min(cur.agenda.length - 1, act.place));
    next = { ...next, place, placeKey: cur.agenda[place]?.key ?? null, movedAt: new Date().toISOString() };
  }
  if (act.presenterId) next = { ...next, presenterId: act.presenterId };
  if (next !== cur) { db.meetings.set(id, next); tell(id, { meeting: clone(next) }); }
  if (act.join) {
    const list = db.attendees.get(id) ?? [];
    const now = new Date().toISOString();
    const has = list.find((a) => a.userId === by);
    const out = has ? list.map((a) => (a.userId === by ? { ...a, joinedAt: a.joinedAt ?? now } : a)) : [...list, { userId: by, invited: false, joinedAt: now }];
    db.attendees.set(id, out);
    tell(id, { attendees: clone(out) });
  }
  return clone(next);
}

/* ---------- reads ---------- */

/** One meeting (null when it's gone, or you can't read it). */
export async function getMeeting(id: string): Promise<Meeting | null> {
  if (mode === "unknown") await probeMeetings();
  if (shared()) {
    const { data, error } = await supabase!.from("meetings").select("*").eq("id", id).maybeSingle();
    if (error) { if (isMissingSchema(error)) markOff(); else throw error; return null; }
    return data ? rowToMeeting(data as MeetingRow) : null;
  }
  const m = memDb().meetings.get(id);
  return m ? clone(m) : null;
}

export async function listItems(meetingId: string): Promise<MeetingItem[]> {
  if (mode === "unknown") await probeMeetings();
  if (shared()) {
    const { data, error } = await supabase!.from("meeting_items").select("*").eq("meeting_id", meetingId).order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as ItemRow[] | null) ?? []).map(rowToItem);
  }
  return clone(memDb().items.get(meetingId) ?? []);
}

export async function listAttendees(meetingId: string): Promise<MeetingAttendee[]> {
  if (mode === "unknown") await probeMeetings();
  if (shared()) {
    const { data, error } = await supabase!.from("meeting_attendees").select("*").eq("meeting_id", meetingId);
    if (error) throw error;
    return ((data as AttendeeRow[] | null) ?? []).map(rowToAttendee);
  }
  return clone(memDb().attendees.get(meetingId) ?? []);
}

/** The live meetings you can read in these businesses (Pulse's and the Group page's "Live now"). */
export async function liveMeetings(workspaceIds: readonly string[]): Promise<Meeting[]> {
  const ids = workspaceIds.filter(Boolean);
  if (!ids.length) return [];
  if (mode === "unknown") await probeMeetings();
  if (shared()) {
    const { data, error } = await supabase!.from("meetings").select("*").eq("status", "live").in("workspace_id", ids)
      .order("started_at", { ascending: false }).limit(20);
    if (error) { if (isMissingSchema(error)) markOff(); return []; }
    return ((data as MeetingRow[] | null) ?? []).map(rowToMeeting);
  }
  return [...memDb().meetings.values()].filter((m) => m.status === "live" && ids.includes(m.workspaceId)).map(clone);
}

/** The last ended meeting of this kind here (over the same businesses), with its items: its actions open the next. */
export async function lastMeeting(workspaceId: string, preset: MeetingPreset, workspaceIds: readonly string[]): Promise<{ meeting: Meeting; items: MeetingItem[] } | null> {
  const same = (m: Pick<Meeting, "workspaceIds">) => [...m.workspaceIds].sort().join(",") === [...workspaceIds].sort().join(",");
  if (mode === "unknown") await probeMeetings();
  if (shared()) {
    const { data, error } = await supabase!.from("meetings").select("*").eq("workspace_id", workspaceId).eq("preset", preset).eq("status", "ended")
      .order("ended_at", { ascending: false }).limit(10);
    if (error) { if (isMissingSchema(error)) markOff(); return null; }
    const m = ((data as MeetingRow[] | null) ?? []).map(rowToMeeting).find(same);
    if (!m) return null;
    try { return { meeting: m, items: await listItems(m.id) }; } catch { return { meeting: m, items: [] }; }
  }
  const db = memDb();
  const m = [...db.meetings.values()].filter((x) => x.workspaceId === workspaceId && x.preset === preset && x.status === "ended" && same(x))
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
  return m ? { meeting: clone(m), items: clone(db.items.get(m.id) ?? []) } : null;
}

/* ---------- live ---------- */

let channelSeq = 0;
/** One open meeting's changes: its row (the presenter's place), its items, who's joined. Returns unsubscribe. */
export function subscribeMeeting(id: string, onChange: (c: MeetingChange) => void): () => void {
  if (shared()) {
    const client = supabase!;
    let channel: RealtimeChannel | null = null;
    let off = false;
    const items = () => { void listItems(id).then((xs) => { if (!off) onChange({ items: xs }); }).catch(() => undefined); };
    const people = () => { void listAttendees(id).then((xs) => { if (!off) onChange({ attendees: xs }); }).catch(() => undefined); };
    try {
      channel = client.channel(`kanbo-meeting-${id}-${++channelSeq}`)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "meetings", filter: `id=eq.${id}` },
          (p: { new?: Record<string, unknown> }) => { if (!off && p.new) onChange({ meeting: rowToMeeting(p.new as unknown as MeetingRow) }); })
        .on("postgres_changes", { event: "*", schema: "public", table: "meeting_items", filter: `meeting_id=eq.${id}` }, items)
        // (a delete can't be filtered by meeting: it carries only the id, so any delete reads the list again)
        .on("postgres_changes", { event: "DELETE", schema: "public", table: "meeting_items" }, items)
        .on("postgres_changes", { event: "*", schema: "public", table: "meeting_attendees", filter: `meeting_id=eq.${id}` }, people)
        .subscribe();
    } catch (e) { reportError(e, { op: "meeting-realtime" }); }
    return () => { off = true; if (channel) void client.removeChannel(channel).catch(() => undefined); };
  }
  const db = memDb();
  const set = db.listeners.get(id) ?? new Set<Listener>();
  set.add(onChange);
  db.listeners.set(id, set);
  return () => { set.delete(onChange); };
}

/** A meeting started, moved on or ended somewhere you can read (for "Live now"). Returns unsubscribe. */
export function subscribeLiveMeetings(onChange: () => void): () => void {
  if (shared()) {
    const client = supabase!;
    let channel: RealtimeChannel | null = null;
    try {
      channel = client.channel(`kanbo-meetings-live-${++channelSeq}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "meetings" }, () => onChange())
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "meetings" }, (p: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          // (the presenter moving on isn't news here: only a start or an end)
          if (!p.old || p.new?.status !== p.old.status) onChange();
        })
        .subscribe();
    } catch (e) { reportError(e, { op: "meetings-live-realtime" }); }
    return () => { if (channel) void client.removeChannel(channel).catch(() => undefined); };
  }
  const db = memDb();
  db.live.add(onChange);
  return () => { db.live.delete(onChange); };
}

/* ---------- writes ---------- */

export interface StartInput {
  workspaceId: string;
  workspaceIds: string[];
  preset: MeetingPreset;
  title: string;
  agenda: AgendaItem[];
  attendees: string[];
  docProjectId: string | null;
  previousId: string | null;
  me: string;
}

export async function startMeeting(input: StartInput): Promise<Result<Meeting>> {
  if (mode === "unknown") await probeMeetings();
  if (shared()) {
    try {
      const { data, error } = await supabase!.rpc("start_meeting", {
        p_ws: input.workspaceId, p_preset: input.preset, p_title: input.title.trim(), p_workspace_ids: input.workspaceIds,
        p_agenda: input.agenda, p_attendees: input.attendees, p_doc_project: input.docProjectId, p_previous: input.previousId,
      });
      if (error) throw error;
      return { ok: true, data: rowToMeeting(data as MeetingRow) };
    } catch (e) {
      const r = fail<Meeting>(e, "meeting-start");
      // 0056 isn't there after all: run it here
      return r.ok || !r.missing ? r : startMeeting(input);
    }
  }
  const db = memDb();
  const wss = [...new Set([input.workspaceId, ...input.workspaceIds])].sort();
  const running = [...db.meetings.values()].find((m) => m.status === "live" && m.workspaceId === input.workspaceId && m.preset === input.preset
    && [...m.workspaceIds].sort().join(",") === wss.join(","));
  if (running) return { ok: false, message: meetingErrorText(new Error("already running")) };
  const now = new Date().toISOString();
  const m: Meeting = {
    id: memId("mtg"), workspaceId: input.workspaceId, workspaceIds: wss, preset: input.preset, title: input.title.trim() || "Meeting",
    status: "live", agenda: clone(input.agenda), place: 0, placeKey: input.agenda[0]?.key ?? null, movedAt: now, presenterId: input.me,
    startedBy: input.me, startedAt: now, endedAt: null, endedBy: null, previousId: input.previousId, docId: null, docProjectId: input.docProjectId,
  };
  db.meetings.set(m.id, m);
  db.items.set(m.id, []);
  db.attendees.set(m.id, [{ userId: input.me, invited: true, joinedAt: now },
    ...[...new Set(input.attendees)].filter((u) => u !== input.me).map((u) => ({ userId: u, invited: true, joinedAt: null }))]);
  tell(m.id, { meeting: clone(m) });
  hooks.forEach((h) => h.onChange?.(clone(m)));
  return { ok: true, data: clone(m) };
}

async function rpcMeeting(fn: string, args: Record<string, unknown>, op: string): Promise<Result<Meeting>> {
  try {
    const { data, error } = await supabase!.rpc(fn, args);
    if (error) throw error;
    return { ok: true, data: rowToMeeting(data as MeetingRow) };
  } catch (e) { return fail(e, op); }
}

function memMeeting(id: string, me: string, change: (m: Meeting) => Meeting | string): Result<Meeting> {
  const db = memDb();
  const cur = db.meetings.get(id);
  if (!cur) return { ok: false, message: meetingErrorText(new Error("not authorized")) };
  const next = change(cur);
  if (typeof next === "string") return { ok: false, message: meetingErrorText(new Error(next)) };
  db.meetings.set(id, next);
  if (next !== cur) {
    tell(id, { meeting: clone(next) });
    if (next.presenterId !== cur.presenterId || next.status !== cur.status) hooks.forEach((h) => h.onChange?.(clone(next)));
  }
  void me;
  return { ok: true, data: clone(next) };
}

/** The presenter moves to an agenda item (everyone following moves with them). */
export async function moveMeeting(id: string, place: number, key: string | null, me: string): Promise<Result<Meeting>> {
  if (shared()) return rpcMeeting("move_meeting", { p_meeting: id, p_place: place, p_key: key }, "meeting-move");
  return memMeeting(id, me, (m) => {
    if (m.status !== "live") return "meeting ended";
    if (m.presenterId !== me) return "not the presenter";
    if (place < 0 || place >= Math.max(1, m.agenda.length)) return "invalid place";
    return { ...m, place, placeKey: key, movedAt: new Date().toISOString() };
  });
}

/** Present from here: take over. */
export async function presentMeeting(id: string, me: string): Promise<Result<Meeting>> {
  if (shared()) return rpcMeeting("present_meeting", { p_meeting: id }, "meeting-present");
  memAct(id, me, { join: true });
  return memMeeting(id, me, (m) => (m.status !== "live" ? "meeting ended" : m.presenterId === me ? m : { ...m, presenterId: me }));
}

/** Hand the agenda to someone in the room. */
export async function handMeeting(id: string, to: string, me: string): Promise<Result<Meeting>> {
  if (shared()) return rpcMeeting("hand_meeting", { p_meeting: id, p_user: to }, "meeting-hand");
  const there = (memDb().attendees.get(id) ?? []).some((a) => a.userId === to && a.joinedAt);
  return memMeeting(id, me, (m) => (m.status !== "live" ? "meeting ended" : m.presenterId !== me ? "not the presenter"
    : !there ? "need to be in the meeting" : { ...m, presenterId: to }));
}

/** You're watching (recorded once; nothing once it's ended). */
export async function joinMeeting(id: string, me: string): Promise<void> {
  if (shared()) {
    const { error } = await supabase!.rpc("join_meeting", { p_meeting: id });
    if (error && isMissingSchema(error)) markOff();
    return;
  }
  memAct(id, me, { join: true });
}

export interface ItemInput { kind: MeetingItemKind; body: string; agendaKey: string | null; ownerId: string | null; due: string | null; taskId: string | null }

export async function addItem(meetingId: string, input: ItemInput, me: string): Promise<Result<MeetingItem>> {
  const body = input.body.replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!body) return { ok: false, message: meetingErrorText(new Error("invalid item")) };
  if (shared()) {
    try {
      const { data, error } = await supabase!.rpc("add_meeting_item", {
        p_meeting: meetingId, p_kind: input.kind, p_body: body, p_agenda_key: input.agendaKey, p_owner: input.ownerId, p_due: input.due, p_task: input.taskId,
      });
      if (error) throw error;
      return { ok: true, data: rowToItem(data as ItemRow) };
    } catch (e) { return fail(e, "meeting-item-add"); }
  }
  const db = memDb();
  if (!db.meetings.has(meetingId)) return { ok: false, message: meetingErrorText(new Error("not authorized")) };
  const it: MeetingItem = { id: memId("mi"), meetingId, kind: input.kind, body, agendaKey: input.agendaKey, ownerId: input.ownerId, due: input.due,
    taskId: input.taskId, createdBy: me, createdAt: new Date().toISOString() };
  const list = [...(db.items.get(meetingId) ?? []), it];
  db.items.set(meetingId, list);
  tell(meetingId, { items: clone(list) });
  return { ok: true, data: clone(it) };
}

export async function updateItem(item: MeetingItem): Promise<Result<MeetingItem>> {
  const body = item.body.replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!body) return { ok: false, message: meetingErrorText(new Error("invalid item")) };
  if (shared()) {
    try {
      const { data, error } = await supabase!.rpc("update_meeting_item", {
        p_item: item.id, p_kind: item.kind, p_body: body, p_owner: item.ownerId, p_due: item.due, p_task: item.taskId,
      });
      if (error) throw error;
      return { ok: true, data: rowToItem(data as ItemRow) };
    } catch (e) { return fail(e, "meeting-item-update"); }
  }
  const db = memDb();
  const list = db.items.get(item.meetingId) ?? [];
  if (!list.some((x) => x.id === item.id)) return { ok: false, message: meetingErrorText(new Error("not authorized")) };
  const next = list.map((x) => (x.id === item.id ? { ...x, kind: item.kind, body, ownerId: item.ownerId, due: item.due, taskId: item.taskId } : x));
  db.items.set(item.meetingId, next);
  tell(item.meetingId, { items: clone(next) });
  return { ok: true, data: clone(next.find((x) => x.id === item.id)!) };
}

export async function deleteItem(item: Pick<MeetingItem, "id" | "meetingId">): Promise<Result<true>> {
  if (shared()) {
    try {
      const { error } = await supabase!.rpc("delete_meeting_item", { p_item: item.id });
      if (error) throw error;
      return { ok: true, data: true };
    } catch (e) { return fail(e, "meeting-item-delete"); }
  }
  const db = memDb();
  const next = (db.items.get(item.meetingId) ?? []).filter((x) => x.id !== item.id);
  db.items.set(item.meetingId, next);
  tell(item.meetingId, { items: clone(next) });
  return { ok: true, data: true };
}

/** Remember the notes doc. */
export async function setMeetingDoc(id: string, docId: string, projectId: string, me: string): Promise<Result<Meeting>> {
  if (shared()) return rpcMeeting("set_meeting_doc", { p_meeting: id, p_doc: docId, p_project: projectId }, "meeting-doc");
  return memMeeting(id, me, (m) => ({ ...m, docId, docProjectId: projectId }));
}

/** End it: the recap goes to everyone asked or there (the database writes it; here, nobody else is told). */
export async function endMeeting(id: string, me: string, doc?: { docId: string; projectId: string } | null): Promise<Result<Meeting>> {
  if (shared()) return rpcMeeting("end_meeting", { p_meeting: id, p_doc: doc?.docId ?? null, p_project: doc?.projectId ?? null }, "meeting-end");
  return memMeeting(id, me, (m) => (m.status === "ended" ? m : {
    ...m, status: "ended", endedAt: new Date().toISOString(), endedBy: me,
    ...(doc ? { docId: doc.docId, docProjectId: doc.projectId } : {}),
  }));
}
