// ============================================================
// KANBO — the update-day reminders (0053), run by daily-reminders' digest
// step every 15 minutes, and the digest's "Your project updates".
//
//   • updateOwners / ownerPrefs: the people who own a live team project,
//     and how each wants to hear (null: suspended or not approved).
//   • ownerUpdatesDue: an owner's projects whose update is theirs to post
//     today, in their timezone: the update day or a working follow-up day,
//     with nothing posted in the project's own workspace since the round
//     before. Archived and on-hold projects (by hand, or by their latest
//     update) are skipped, and so are projects in a workspace they've left
//     or are only a guest in (a guest can't post an update).
//   • remindOwner: one push and one email a day per owner, 09:00–18:00 their
//     time, through the notify queue (quiet hours hold it, a digest person
//     gets it inside the digest, "update_email" / "update_push" switch it
//     off). Claimed once a day per owner; released when a send fails
//     outright, so a later run retries.
//   • digestUpdates: those, plus the leads' asks since the last digest that
//     nothing's been posted after.
// The database is a parameter (the service-role client in the function, an
// in-memory stand-in in the tests); nothing here reads the clock.
// ============================================================
import { addWorkingDays, dueDayWords, dueOnOrBefore, effectiveRhythm, FOLLOW_UPS, isReminderDay, rhythmState } from "./updateRhythm.ts";
import { localParts, resolveNotifyPrefs, type ResolvedNotifyPrefs } from "./notifyTiming.ts";
import { updateDueEmail, updateDuePush, type DigestUpdate, type UpdateDueItem } from "./notifyCompose.ts";
import type { PushMessage } from "./webpush.ts";
import { deliverNotice, type QueueStore, type SendOutcome } from "./notifyQueue.ts";
import { KEY_PREFIX } from "./limits.ts";

// deno-lint-ignore no-explicit-any
export type ReminderDb = { from(table: string): any };

/** Update-day reminders go out in the owner's working day: from this local time… */
export const RHYTHM_FROM = 9 * 60;
/** …until this one (a day the runs miss isn't made up in the evening). */
export const RHYTHM_UNTIL = 18 * 60;
/** the roles that can post a project's update */
const POSTERS = new Set(["owner", "admin", "member"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const oneLine = (s: string) => String(s).replace(/[\r\n]+/g, " ").slice(0, 160);

interface OwnedProject { id: string; name: string; workspace_id: string; status: string | null; update_rhythm: unknown }

/** Everyone who owns a live team project (the people a reminder can be for). */
export async function updateOwners(db: ReminderDb): Promise<string[]> {
  const owners = new Set<string>();
  for (let fromRow = 0; ; fromRow += PAGE) {
    const { data, error } = await db.from("projects").select("owner_id")
      .not("workspace_id", "is", null).is("archived_at", null).not("owner_id", "is", null).order("id").range(fromRow, fromRow + PAGE - 1);
    if (error) { console.warn("[rhythm] projects:", String(error.message)); break; }
    for (const p of data ?? []) if (UUID.test(String(p.owner_id))) owners.add(String(p.owner_id));
    if (!data || data.length < PAGE) break;
  }
  return [...owners];
}

/** Each owner's notification prefs, in one read per 200 people (null: suspended or not approved;
 *  no profile row: the defaults). */
export async function ownerPrefs(db: ReminderDb, ids: readonly string[]): Promise<Map<string, ResolvedNotifyPrefs | null>> {
  const out = new Map<string, ResolvedNotifyPrefs | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await db.from("profiles").select("id,notify_prefs,suspended,approved").in("id", chunk);
    if (error) { for (const id of chunk) out.set(id, null); continue; }   // can't tell: nobody's reminded this run
    const rows = new Map<string, { notify_prefs: unknown; suspended: boolean | null; approved: boolean | null }>(
      (data ?? []).map((r: { id: string; notify_prefs: unknown; suspended: boolean | null; approved: boolean | null }) => [String(r.id), r]));
    for (const id of chunk) {
      const r = rows.get(id);
      out.set(id, r?.suspended || r?.approved === false ? null : resolveNotifyPrefs(r?.notify_prefs ?? {}));
    }
  }
  return out;
}

/** An owner's project updates that are theirs to post today (see the file note). [] before 0053. */
export async function ownerUpdatesDue(db: ReminderDb, ownerId: string, today: string, tz: string): Promise<UpdateDueItem[]> {
  const { data: ps, error } = await db.from("projects").select("id,name,workspace_id,status,update_rhythm")
    .eq("owner_id", ownerId).not("workspace_id", "is", null).is("archived_at", null).order("id").limit(200);
  if (error || !ps?.length) return [];
  const projects = (ps as OwnedProject[]).filter((p) => p.status !== "on_hold");
  const wsIds = [...new Set(projects.map((p) => String(p.workspace_id)))];
  if (!wsIds.length) return [];
  const { data: ws, error: wsErr } = await db.from("workspaces").select("id,owner_id,update_rhythm").in("id", wsIds);
  if (wsErr) return [];
  const wsById = new Map<string, { owner_id: string; update_rhythm: unknown }>((ws ?? []).map((w: { id: string; owner_id: string; update_rhythm: unknown }) => [String(w.id), w]));
  // still in the workspace, and someone who can post there: an active owner, admin or member, or its owner
  const canPost = new Set<string>();
  const { data: ms } = await db.from("workspace_members").select("workspace_id,role").eq("user_id", ownerId).eq("status", "active").in("workspace_id", wsIds);
  for (const m of ms ?? []) if (POSTERS.has(String(m.role))) canPost.add(String(m.workspace_id));
  for (const [id, w] of wsById) if (String(w.owner_id) === ownerId) canPost.add(id);
  const local = (iso: string) => localParts(new Date(iso), tz).date;
  const out: UpdateDueItem[] = [];
  for (const p of projects) {
    const w = wsById.get(String(p.workspace_id));
    if (!w || !canPost.has(String(p.workspace_id))) continue;
    const rhythm = effectiveRhythm(p.update_rhythm, w.update_rhythm);
    const due = dueOnOrBefore(rhythm, today);
    // most days, for most projects, it isn't one: their updates aren't read
    if (!due || today > addWorkingDays(due, FOLLOW_UPS)) continue;
    // (the project's own workspace's updates: a personal one naming it is its writer's alone, and says nothing here)
    const { data: last } = await db.from("status_updates").select("created_at,status").eq("project_id", p.id).eq("workspace_id", p.workspace_id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (last?.status === "on_hold") continue;
    const { data: first } = await db.from("tasks").select("created_at").eq("project_id", p.id).is("archived_at", null)
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    const state = rhythmState({
      rhythm, today,
      lastUpdate: last?.created_at ? local(String(last.created_at)) : null,
      startedOn: first ? (first.created_at ? local(String(first.created_at)) : "1970-01-01") : null,
    });
    if (state.kind !== "due" || !isReminderDay(state, today)) continue;
    out.push({ projectId: p.id, name: String(p.name ?? ""), when: dueDayWords(state.due, today), followUp: state.followUp });
  }
  return out;
}

/** The digest's "Your project updates": what ownerUpdatesDue finds, and the leads' asks since the last digest that
 *  nothing's been posted after. */
export async function digestUpdates(db: ReminderDb, userId: string, today: string, tz: string, since: string): Promise<DigestUpdate[]> {
  const out: DigestUpdate[] = (await ownerUpdatesDue(db, userId, today, tz))
    .map((i) => ({ projectId: i.projectId, name: i.name, line: i.followUp === 0 || i.when === "today" ? "due today" : `was due ${i.when}` }));
  const { data: asks, error } = await db.from("update_asks").select("project_id,asked_by,created_at")
    .eq("owner_id", userId).gt("created_at", since).order("created_at", { ascending: false }).limit(20);
  if (error) return out;   // before 0053
  for (const a of (asks ?? []) as { project_id: string; asked_by: string; created_at: string }[]) {
    if (out.some((u) => u.projectId === a.project_id)) continue;
    const { data: p } = await db.from("projects").select("id,name,owner_id,workspace_id,archived_at").eq("id", a.project_id).maybeSingle();
    if (!p || p.archived_at || String(p.owner_id) !== userId || !p.workspace_id) continue;
    const { data: later } = await db.from("status_updates").select("id").eq("project_id", a.project_id).eq("workspace_id", p.workspace_id)
      .gt("created_at", a.created_at).limit(1);
    if (later?.length) continue;
    const { data: asker } = await db.from("profiles").select("first_name").eq("id", a.asked_by).maybeSingle();
    out.push({ projectId: String(p.id), name: String(p.name ?? ""), line: `${oneLine(String(asker?.first_name ?? "")).slice(0, 40) || "A lead"} asked for one` });
  }
  return out;
}

export interface RhythmReport { owners: number; open: number; due: number; sent: number; pushed: number; held: number; inDigest: number; already: number; failed: number; note: string }
export const emptyRhythmReport = (): RhythmReport => ({ owners: 0, open: 0, due: 0, sent: 0, pushed: 0, held: 0, inDigest: 0, already: 0, failed: 0, note: "" });

export interface RemindDeps {
  db: ReminderDb;
  store: QueueStore;
  now: Date;
  appUrl: string;
  /** today's reminder for this key, claimed (rate_limits): false when a run already has it */
  claim(key: string): Promise<boolean>;
  /** give it back, so a later run tries again */
  release(key: string): Promise<void>;
  /** to their devices (absent: no push this run) */
  push?: (ownerId: string, message: PushMessage) => Promise<SendOutcome>;
  /** to their email address (absent: no email this run) */
  email?: (ownerId: string, mail: { subject: string; html: string; text: string }) => Promise<SendOutcome>;
  /** after an email went (or failed): Resend takes about two a second */
  afterEmail?: () => Promise<void>;
}

/** One owner's update-day reminder for this run (see the file note). Counts what happened in `report`. */
export async function remindOwner(ownerId: string, prefs: ResolvedNotifyPrefs, d: RemindDeps, report: RhythmReport): Promise<void> {
  const local = localParts(d.now, prefs.timezone);
  if (local.minutes < RHYTHM_FROM || local.minutes >= RHYTHM_UNTIL) return;
  report.open++;
  const key = `${KEY_PREFIX}rhythm:${ownerId}:${local.date}`;
  if (!(await d.claim(key))) { report.already++; return; }
  let items: UpdateDueItem[];
  try { items = await ownerUpdatesDue(d.db, ownerId, local.date, prefs.timezone); }
  catch (e) { console.warn("[rhythm]", String((e as Error)?.message ?? e)); report.failed++; await d.release(key); return; }
  if (!items.length) return;
  report.due++;
  const push = updateDuePush(items);
  const mail = updateDueEmail(items, d.appUrl);
  const base = {
    userId: ownerId, kind: "update" as const, eventKey: `update_due:${local.date}`, bundleKey: `update_due:${local.date}`,
    taskId: null, actorId: null, actorName: "", title: items.length === 1 ? oneLine(items[0].name) : "Project updates",
  };
  const payload = { v: 1 as const, line: push.title, url: "/today", push, email: { subject: mail.subject, html: mail.html } };
  let failed = false;
  if (d.push) {
    const send = d.push;
    const r = await deliverNotice({ ...base, channel: "push", payload }, { store: d.store, now: d.now, prefs, send: () => send(ownerId, push) });
    if (r.result === "sent") report.pushed++;
    else if (r.result === "held") report.held++;
    else if (r.result === "failed") failed = true;
  }
  if (d.email) {
    const send = d.email;
    const r = await deliverNotice({ ...base, channel: "email", payload }, { store: d.store, now: d.now, prefs, send: () => send(ownerId, mail) });
    if (r.result === "sent") report.sent++;
    else if (r.result === "held") report.held++;
    else if (r.result === "digest") report.inDigest++;
    else if (r.result === "failed") failed = true;
    if ((r.result === "sent" || r.result === "failed") && d.afterEmail) await d.afterEmail();
  }
  // a send that failed outright (no queue to retry it from): a later run today tries again
  if (failed) { report.failed++; await d.release(key); }
}
