/* ============================================================
   KANBO — loading and saving the shared weeks, time off and rates
   (0055). Reads with select("*") (RLS decides what comes back: a
   member gets no rates, a guest no weeks or time off, and a reason
   only reaches the person and the owners and admins of the business
   it was recorded at); writes only
   through the migration's functions. Before 0055 is run the tables
   and functions aren't there: the load says "off" and every reader
   falls back (lib/availability). In the demo (no Supabase) the same
   calls work on an in-memory copy seeded from lib/availabilityDemo.
   The save helpers here change the store at once and put it back
   if the server says no, so screens never wait on the network.
   ============================================================ */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { reportError } from "./monitoring";
import {
  availabilityOn, capacityUploads, getAvailability, updateAvailability,
  type AvailabilityState, type BillRate, type MemberWeek, type TimeOff,
} from "./availability";
import { demoRates, demoTimeOff, demoWeeks } from "./availabilityDemo";
import { readLocalCapacities } from "./radar";

/* ---------- rows ---------- */

interface WeekRow { workspace_id: string; user_id: string; weekly_hours: number | string | null; work_days: number[] | null; day_start: number | null; day_end: number | null }
interface TimeOffRow { id: string; user_id: string; workspace_id?: string | null; starts_on: string; ends_on: string; half_day: string | null }
interface NoteRow { time_off_id: string; reason: string }
interface RateRow { workspace_id: string; project_id: string | null; hourly_rate: number | string }

export const rowToWeek = (r: WeekRow): MemberWeek => ({
  workspaceId: r.workspace_id, userId: r.user_id,
  weeklyHours: r.weekly_hours == null ? null : Number(r.weekly_hours),
  workDays: Array.isArray(r.work_days) && r.work_days.length ? r.work_days.map(Number).sort((a, b) => a - b) : [1, 2, 3, 4, 5],
  dayStart: r.day_start ?? 480, dayEnd: r.day_end ?? 1080,
});
export const rowToTimeOff = (r: TimeOffRow, reason?: string | null): TimeOff => ({
  id: r.id, userId: r.user_id, workspaceId: r.workspace_id ?? null, startsOn: String(r.starts_on).slice(0, 10), endsOn: String(r.ends_on).slice(0, 10),
  halfDay: r.half_day === "am" || r.half_day === "pm" ? r.half_day : null, ...(reason ? { reason } : {}),
});
const rowToRate = (r: RateRow): BillRate => ({ workspaceId: r.workspace_id, projectId: r.project_id, rate: Number(r.hourly_rate) });

/** The table or function isn't there yet (0055 not run): Postgres or PostgREST says so. */
export function isMissingSchema(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? "");
  if (["42P01", "PGRST205", "42703", "PGRST204", "42883", "PGRST202"].includes(code)) return true;
  const msg = String((e as { message?: unknown })?.message ?? "");
  return /(member_availability|time_off|bill_rates|set_member_availability|save_time_off|delete_time_off|set_bill_rate)/.test(msg)
    && /does not exist|could not find|schema cache/i.test(msg);
}

/** What a refused save says, in the app's words. */
export function saveErrorText(e: unknown): string {
  if (isMissingSchema(e)) return "Shared hours and time off aren't switched on yet.";
  const msg = String((e as { message?: unknown })?.message ?? "");
  if (/already off then/.test(msg)) return "They're already off on one of those days.";
  if (/carry capacity/.test(msg)) return "Guests don't carry team capacity.";
  if (/too much time off/.test(msg)) return "That's a lot of time off on record. Remove some old entries first.";
  if (/invalid/.test(msg)) return "That doesn't look right. Check the dates and hours and try again.";
  if (/not authorized/.test(msg)) return "You can't change that. Owners and admins can, or the person themselves.";
  return "Couldn't save that. Check your connection and try again.";
}

/* ---------- the demo's copy ---------- */

let demo: { weeks: MemberWeek[]; timeOff: TimeOff[]; rates: BillRate[] } | null = null;
const demoDb = () => (demo ??= { weeks: demoWeeks(), timeOff: demoTimeOff(), rates: demoRates() });
let demoSeq = 0;
/** Tests: forget the demo's edits. */
export function resetDemoAvailability(): void { demo = null; }

/* ---------- load ---------- */

export interface Loaded { status: "on" | "off"; weeks: MemberWeek[]; timeOff: TimeOff[]; rates: BillRate[] }

/** Everything this person may read. "off" before 0055; null when it couldn't be read this time
 *  (a blip: the app keeps what it has). Time off that ended over 60 days ago isn't loaded. */
export async function loadAvailability(todayISO: string): Promise<Loaded | null> {
  if (!supabase) {
    const d = demoDb();
    return { status: "on", weeks: d.weeks.map((w) => ({ ...w })), timeOff: d.timeOff.map((t) => ({ ...t })), rates: d.rates.map((r) => ({ ...r })) };
  }
  try {
    const weeks = await supabase.from("member_availability").select("*");
    if (weeks.error) return isMissingSchema(weeks.error) ? { status: "off", weeks: [], timeOff: [], rates: [] } : null;
    const since = new Date(`${todayISO}T00:00:00`);
    since.setDate(since.getDate() - 60);
    const sinceISO = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
    const [off, notes, rates] = await Promise.all([
      supabase.from("time_off").select("*").gte("ends_on", sinceISO),
      supabase.from("time_off_notes").select("*"),
      supabase.from("bill_rates").select("*"),
    ]);
    if (off.error) return isMissingSchema(off.error) ? { status: "off", weeks: [], timeOff: [], rates: [] } : null;
    const why = new Map(((notes.data as NoteRow[] | null) ?? []).map((n) => [n.time_off_id, n.reason]));
    return {
      status: "on",
      weeks: ((weeks.data as WeekRow[] | null) ?? []).map(rowToWeek),
      timeOff: ((off.data as TimeOffRow[] | null) ?? []).map((r) => rowToTimeOff(r, why.get(r.id))),
      rates: ((rates.data as RateRow[] | null) ?? []).map(rowToRate),
    };
  } catch (e) {
    reportError(e, { op: "availability-load" });
    return null;
  }
}

/** Load, and put what came back in the store (a failed read keeps what's there). */
export async function refreshAvailability(todayISO: string): Promise<AvailabilityState["status"]> {
  const got = await loadAvailability(todayISO);
  if (got) updateAvailability({ status: got.status, weeks: got.weeks, timeOff: got.timeOff, rates: got.rates });
  return getAvailability().status;
}

/* ---------- live: a teammate's change arrives ---------- */

type Change = { eventType?: string; old?: Record<string, unknown> | null };
/** Is this change news here? A new or changed row only reaches those RLS lets read it, but a delete
 *  reaches everyone (it carries just the id): only a day off this person has on screen is worth a reload,
 *  and a week is only ever deleted with its business or person. */
export function changeMatters(table: "member_availability" | "time_off", p: Change, s: AvailabilityState = getAvailability()): boolean {
  if (p.eventType !== "DELETE") return true;
  if (table === "member_availability") return false;
  const id = p.old?.id;
  return typeof id === "string" && s.timeOff.some((t) => t.id === id);
}

let channelSeq = 0;
/** Calls `onChange` when a week or a day off changes (RLS decides who hears). Off in the demo. */
export function subscribeAvailabilityChanges(onChange: () => void): () => void {
  if (!supabase) return () => {};
  const client = supabase;
  let channel: RealtimeChannel | null = null;
  try {
    channel = client.channel(`kanbo-availability-${++channelSeq}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "member_availability" }, (p: Change) => { if (changeMatters("member_availability", p)) onChange(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "time_off" }, (p: Change) => { if (changeMatters("time_off", p)) onChange(); })
      .subscribe();
  } catch (e) { reportError(e, { op: "availability-realtime" }); }
  return () => { if (channel) void client.removeChannel(channel).catch(() => undefined); };
}

/* ---------- saves ---------- */

export type SaveResult = { ok: true } | { ok: false; message: string };
const fail = (e: unknown, op: string): SaveResult => {
  if (!isMissingSchema(e) && !/not authorized|invalid|already off|carry capacity|too much/.test(String((e as { message?: unknown })?.message ?? ""))) reportError(e, { op });
  return { ok: false, message: saveErrorText(e) };
};

/** Set a person's week at a business (yours, or anyone's as its owner or admin). */
export async function saveWeek(week: MemberWeek): Promise<SaveResult> {
  const before = getAvailability().weeks;
  const others = before.filter((w) => !(w.workspaceId === week.workspaceId && w.userId === week.userId));
  updateAvailability({ weeks: [...others, { ...week, workDays: [...week.workDays].sort((a, b) => a - b) }] });
  if (!supabase) {
    const d = demoDb();
    d.weeks = [...d.weeks.filter((w) => !(w.workspaceId === week.workspaceId && w.userId === week.userId)), { ...week }];
    return { ok: true };
  }
  const { data, error } = await supabase.rpc("set_member_availability", {
    p_ws: week.workspaceId, p_user: week.userId, p_weekly_hours: week.weeklyHours,
    p_work_days: week.workDays, p_day_start: week.dayStart, p_day_end: week.dayEnd,
  });
  if (error) { updateAvailability({ weeks: before }); return fail(error, "availability-save-week"); }
  if (data) updateAvailability((s) => ({ weeks: [...s.weeks.filter((w) => !(w.workspaceId === week.workspaceId && w.userId === week.userId)), rowToWeek(data as WeekRow)] }));
  return { ok: true };
}

/** Record (no id) or change someone's time off at a business (the one on screen; null: your own, in
 *  Personal), with an optional private reason. A change keeps the business it was recorded at. */
export async function saveTimeOff(entry: Omit<TimeOff, "id"> & { id?: string }): Promise<SaveResult & { id?: string }> {
  const before = getAvailability().timeOff;
  const reason = entry.reason?.trim() || null;
  const temp = entry.id ?? `off-new-${++demoSeq}`;
  const was = entry.id ? before.find((t) => t.id === entry.id) : undefined;
  const workspaceId = was ? was.workspaceId ?? null : entry.workspaceId ?? null;
  const next: TimeOff = { id: temp, userId: entry.userId, workspaceId, startsOn: entry.startsOn, endsOn: entry.endsOn, halfDay: entry.halfDay, ...(reason ? { reason } : {}) };
  updateAvailability({ timeOff: [...before.filter((t) => t.id !== temp), next] });
  if (!supabase) {
    const d = demoDb();
    const clash = d.timeOff.some((t) => t.userId === entry.userId && t.id !== entry.id && t.startsOn <= entry.endsOn && t.endsOn >= entry.startsOn
      && !(entry.halfDay && t.halfDay && t.halfDay !== entry.halfDay));
    if (clash) { updateAvailability({ timeOff: before }); return { ok: false, message: saveErrorText({ message: "already off then" }) }; }
    d.timeOff = [...d.timeOff.filter((t) => t.id !== temp), next];
    return { ok: true, id: temp };
  }
  const { data, error } = await supabase.rpc("save_time_off", {
    p_id: entry.id ?? null, p_ws: entry.workspaceId ?? null, p_user: entry.userId, p_starts: entry.startsOn, p_ends: entry.endsOn, p_half: entry.halfDay, p_reason: reason,
  });
  if (error || !data) { updateAvailability({ timeOff: before }); return fail(error ?? new Error("no row"), "availability-save-off"); }
  const saved = rowToTimeOff(data as TimeOffRow, reason);
  updateAvailability((s) => ({ timeOff: [...s.timeOff.filter((t) => t.id !== temp && t.id !== saved.id), saved] }));
  return { ok: true, id: saved.id };
}

/** Take time off back. */
export async function deleteTimeOff(id: string): Promise<SaveResult> {
  const before = getAvailability().timeOff;
  updateAvailability({ timeOff: before.filter((t) => t.id !== id) });
  if (!supabase) { const d = demoDb(); d.timeOff = d.timeOff.filter((t) => t.id !== id); return { ok: true }; }
  const { error } = await supabase.rpc("delete_time_off", { p_id: id });
  if (error) { updateAvailability({ timeOff: before }); return fail(error, "availability-delete-off"); }
  return { ok: true };
}

/** Set (or, with null, clear) the workspace's default rate or a project's own. */
export async function saveRate(workspaceId: string, projectId: string | null, rate: number | null): Promise<SaveResult> {
  const before = getAvailability().rates;
  const others = before.filter((r) => !(r.workspaceId === workspaceId && r.projectId === projectId));
  const value = rate == null ? null : Math.round(rate * 100) / 100;
  updateAvailability({ rates: value == null ? others : [...others, { workspaceId, projectId, rate: value }] });
  if (!supabase) {
    const d = demoDb();
    d.rates = [...d.rates.filter((r) => !(r.workspaceId === workspaceId && r.projectId === projectId)), ...(value == null ? [] : [{ workspaceId, projectId, rate: value }])];
    return { ok: true };
  }
  const { error } = await supabase.rpc("set_bill_rate", { p_ws: workspaceId, p_project: projectId, p_rate: value });
  if (error) { updateAvailability({ rates: before }); return fail(error, "availability-save-rate"); }
  return { ok: true };
}

/* ---------- capacities saved on this device: uploaded once ---------- */

const uploadedKey = (me: string) => `kanbo-capacity-shared:${me}`;

/** Once 0055 is on: hand this device's saved capacities to the shared weeks (only where nobody has
 *  set one, and only what you may set), once per person per device. Returns how many went up. */
export async function uploadLocalCapacities(): Promise<number> {
  const s = getAvailability();
  if (!availabilityOn(s) || !s.me || !Object.keys(s.roles).length) return 0;
  try { if (localStorage.getItem(uploadedKey(s.me)) === "1") return 0; } catch { return 0; }
  const local = readLocalCapacities();
  const todo = capacityUploads(local, s);
  let sent = 0, failed = 0;
  for (const u of todo) {
    const cur = getAvailability().weeks.find((w) => w.workspaceId === u.workspaceId && w.userId === u.userId);
    const r = await saveWeek({ workspaceId: u.workspaceId, userId: u.userId, weeklyHours: u.hours,
      workDays: cur?.workDays ?? [1, 2, 3, 4, 5], dayStart: cur?.dayStart ?? 480, dayEnd: cur?.dayEnd ?? 1080 });
    if (r.ok) sent++; else failed++;
  }
  // done (a refusal is final too); only a dropped connection leaves it for the next visit
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (!(failed && offline)) { try { localStorage.setItem(uploadedKey(s.me), "1"); } catch { /* private mode */ } }
  return sent;
}
