// ============================================================
// KANBO — calmer push and email: deliver now, hold, or leave to the digest,
// and drain what was held (0048 notify_queue, service role only).   [u4]
//
//   deliverNotice(notice)  one notice for one recipient on one channel:
//     planDelivery (notifyTiming.ts) decides — switched off / thread snoozed
//     → nothing; daily digest → email waits for it, push only for mentions
//     and approvals; quiet hours → held to their end; bundling → the first
//     notice for a task goes now and opens a 2-minute window, later ones
//     are held to the window's end (or join notices already waiting) and go
//     out as one. Every notice is recorded in notify_queue under its
//     event_key, so a replayed call alerts nobody twice; a send that fails
//     is left in the queue and the drain retries it (2 min × attempts, up
//     to 5). Without the queue (0048 not run) it sends straight away, as
//     before: a notification is never lost to the queue being missing.
//     A notice never joins a longer wait than the bundle window: notices
//     held for quiet hours the person has since switched off, shortened or
//     moved to another time zone come forward to go out with the new one.
//   drainQueue()  claims what's due in small batches (each sent well inside
//     its claim's lease, so a slow run is never claimed twice), groups it by
//     recipient + channel + task, checks each notice again (they may have
//     left the workspace, snoozed the thread, switched to the digest, or be
//     in quiet hours now) and sends ONE message per group naming everyone
//     and every mention. A lookup that fails (a passing database error) is
//     never taken for "gone": those notices wait and are tried again.
//   replanHeld()  after a change to quiet hours, time zone or delivery
//     (notify { kind: "replan" }): held notices come forward to what the
//     new settings say — never later.
//
// Pure module (no Deno globals, no remote imports): the storage and the
// senders are injected, so notifyQueue.test.ts runs it on an in-memory
// queue against a pinned clock. supabaseQueueStore / supabaseDrainDeps are
// the real ones, used by notify and daily-reminders.
// ============================================================
import {
  NOTIFY_BUNDLE_WINDOW_SEC, planDelivery, resolveNotifyPrefs, type DeliveryPlan, type NotifyChannel, type NotifyKind, type ResolvedNotifyPrefs,
} from "./notifyTiming.ts";
import { composeBundle, dueEmail, type Composed, type NoticePayload } from "./notifyCompose.ts";
import { dueDigestPush, pushToUser, type PushMessage, type VapidKeys } from "./webpush.ts";
import { sendEmail } from "./email.ts";

/** What the database's notify_queue accepts as kind. */
export type QueueKind = NotifyKind | "digest";

/** public.notify_queue. */
export interface QueueRow {
  id: number;
  user_id: string;
  channel: NotifyChannel;
  kind: QueueKind;
  event_key: string;
  bundle_key: string;
  task_id: string | null;
  actor_id: string | null;
  actor_name: string;
  title: string;
  payload: NoticePayload;
  deliver_after: string;
  created_at: string;
  claimed_at: string | null;
  attempts: number;
  sent_at: string | null;
  last_error?: string | null;
}

/** One notice for one recipient on one channel. */
export interface Notice {
  userId: string;
  channel: NotifyChannel;
  kind: QueueKind;
  /** names the event: the same event for the same person and channel is only ever recorded once */
  eventKey: string;
  /** what's sent together: "task:<id>" (or "due:<date>") */
  bundleKey: string;
  taskId: string | null;
  actorId: string | null;
  actorName: string;
  /** the task's title */
  title: string;
  payload: NoticePayload;
}

export type EnqueueResult = { status: "queued"; id: number } | { status: "duplicate" } | { status: "unavailable"; error?: string };

/** For one recipient, channel and bundle: when the last one went out (within the last day and a half),
 *  and the earliest (`pending`) and latest (`pendingLast`) deliver_after of those still waiting. */
export interface BundleState { last: Date | null; pending: Date | null; pendingLast?: Date | null }

/** The queue's storage (notify_queue through the service role, or a fake in tests). */
export interface QueueStore {
  bundleState(userId: string, channel: NotifyChannel, bundleKey: string, now: Date): Promise<BundleState>;
  /** record a notice (idempotent on user + channel + event_key); `claimed`: it's being sent right now */
  enqueue(n: Notice, deliverAfter: Date, opts?: { claimed?: boolean; now?: Date }): Promise<EnqueueResult>;
  /** sent (error null), or released for a retry with backoff */
  finish(ids: number[], error?: string | null): Promise<void>;
  /** back in the queue until a time, without spending an attempt (quiet hours began while it waited) */
  rehold(rows: Pick<QueueRow, "id" | "attempts">[], until: Date): Promise<void>;
  /** claimed but not handled (the run ran out of time): back in the queue as they were, no attempt spent */
  release(rows: Pick<QueueRow, "id" | "attempts">[]): Promise<void>;
  /** this bundle's notices waiting past `until` (not being sent, not a retry) now go at `until`; answers how many */
  bringForward(userId: string, channel: NotifyChannel, bundleKey: string, until: Date): Promise<number>;
  /** handled without sending (snoozed, switched off, left the workspace…) */
  drop(ids: number[], reason: string, now: Date): Promise<void>;
  /** what's due, leased for CLAIM_LEASE_SEC */
  claim(limit: number): Promise<QueueRow[]>;
}

/** A lookup that couldn't be made (a passing database error). The drain never takes it for "gone":
 *  the notices wait and are tried again. */
export class LookupFailed extends Error {
  constructor(what: string, cause?: unknown) {
    super(`lookup failed (${what}): ${String((cause as { message?: string })?.message ?? cause ?? "")}`.slice(0, 300));
    this.name = "LookupFailed";
  }
}

/** What a send did: reached them · there was nowhere to send it (no device, no address) · failed (retry). */
export type SendOutcome = "sent" | "nothing" | "failed";
export type DeliverResult = "sent" | "nothing" | "failed" | "held" | "digest" | "skipped" | "duplicate";

export interface DeliverDeps {
  store: QueueStore;
  now: Date;
  prefs: ResolvedNotifyPrefs;
  /** notification_snoozes.until for this recipient and task */
  snoozedUntil?: Date | null;
  /** send this notice on its own, now. `recorded`: it's in the queue under its event key (so a replay
   *  can't send it again); false when there's no queue, so the caller keeps its own guard */
  send: (info: { recorded: boolean }) => Promise<SendOutcome>;
}

const NO_STATE: BundleState = { last: null, pending: null, pendingLast: null };
const WINDOW_MS = NOTIFY_BUNDLE_WINDOW_SEC * 1000;
const safeSend = async (fn: () => Promise<SendOutcome>): Promise<SendOutcome> => { try { return await fn(); } catch { return "failed"; } };

export async function deliverNotice(n: Notice, d: DeliverDeps): Promise<{ result: DeliverResult; plan: DeliveryPlan }> {
  let state: BundleState = NO_STATE;
  if (d.prefs.bundle && n.taskId) state = await d.store.bundleState(n.userId, n.channel, n.bundleKey, d.now).catch(() => NO_STATE);
  const plan = n.kind === "digest" ? { action: "send" } as DeliveryPlan : planDelivery({
    kind: n.kind, channel: n.channel, now: d.now, prefs: d.prefs, snoozedUntil: d.snoozedUntil ?? null,
    lastSentForTask: state.last, pendingUntil: state.pending,
  });
  if (plan.action === "skip") return { result: "skipped", plan };
  if (plan.action === "digest") return { result: "digest", plan };
  // this task's notices that would wait longer than this one (held for quiet hours the person has
  // since switched off, shortened or moved to another time zone) come forward: to this hold's end,
  // or, when this one goes now, to the end of the window it opens — so they still go out as one
  const latest = state.pendingLast ?? state.pending;
  if (latest && n.taskId) {
    const target = plan.action === "hold" ? plan.until : new Date(d.now.getTime() + WINDOW_MS);
    if (latest.getTime() > target.getTime() + 1000) {
      await Promise.resolve().then(() => d.store.bringForward(n.userId, n.channel, n.bundleKey, target)).catch(() => 0);
    }
  }
  if (plan.action === "hold") {
    const r = await d.store.enqueue(n, plan.until, { now: d.now }).catch((e) => ({ status: "unavailable" as const, error: String(e) }));
    if (r.status === "duplicate") return { result: "duplicate", plan };
    if (r.status === "queued") return { result: "held", plan };
    // no queue to hold it in: send it now rather than lose it (what notify did before 0048)
    return { result: await safeSend(() => d.send({ recorded: false })), plan };
  }
  const r = await d.store.enqueue(n, d.now, { claimed: true, now: d.now }).catch((e) => ({ status: "unavailable" as const, error: String(e) }));
  if (r.status === "duplicate") return { result: "duplicate", plan };
  const out = await safeSend(() => d.send({ recorded: r.status === "queued" }));
  if (r.status === "queued") {
    // a failed send stays queued: the drain tries again in 2 minutes
    await d.store.finish([r.id], out === "failed" ? "send failed" : null).catch(() => undefined);
  }
  return { result: out, plan };
}

/* ---------- the drain ---------- */

/** How long a claim holds its notices (notify_queue_claim's p_lease_seconds): longer than an edge
 *  function may run (400 s), so no run outlives its claim and nothing is claimed — and sent — twice. */
export const CLAIM_LEASE_SEC = 600;
/** A run starts no group after this long (ms): inside the scheduler's 55-second wait for an answer.
 *  What it hasn't reached goes back to the queue at once, for the next run. */
export const DRAIN_BUDGET_MS = 40_000;
/** and none this close to the end of its claim's lease (a budget set past it can't outrun the claim) */
const LEASE_MARGIN_MS = 60_000;

export interface DrainDeps {
  store: QueueStore;
  now: () => Date;
  /** the site, for links ("https://www.kanbo.co.uk") */
  appUrl: string;
  /** at most this many notices a run (default 200) */
  limit?: number;
  /** claimed this many at a time (default: the limit, in one claim — fewer bundles cut in two) */
  batch?: number;
  /** no group is started after this long, ms (default DRAIN_BUDGET_MS) */
  budgetMs?: number;
  /** the recipient as they are now; null: gone, suspended or not approved (their notices are dropped).
   *  Throws when it can't tell (LookupFailed): their notices wait and are tried again. */
  recipient(userId: string): Promise<{ prefs: ResolvedNotifyPrefs } | null>;
  /** can they still see the task? (people leave workspaces while a notice waits) — throws when it can't tell */
  canSee(userId: string, taskId: string): Promise<boolean>;
  /** throws when it can't tell */
  snoozedUntil(userId: string, taskId: string): Promise<Date | null>;
  send(userId: string, channel: NotifyChannel, msg: Composed): Promise<SendOutcome>;
}
export interface DrainReport {
  claimed: number; messages: number; sent: number; held: number; dropped: number; failed: number;
  /** a lookup failed: back in the queue with backoff, never dropped */
  retried: number;
  /** claimed but the run ran out of time: back in the queue at once, no attempt spent */
  released: number;
  /** claims made */
  batches: number;
}

/** What one group of held notices says: a lone one as it was rendered, several as one bundle. */
export function composeGroup(rows: readonly QueueRow[], appUrl: string): Composed {
  if (rows.length === 1) {
    const p = (rows[0].payload ?? {}) as Partial<NoticePayload>;
    if (p.due) {
      return {
        push: dueDigestPush(p.due.tasks, p.due.today),
        email: dueEmail(p.due.tasks, p.due.today, appUrl, p.due.more ?? 0),
      };
    }
    if (p.push || p.email) return { push: p.push as PushMessage | undefined, email: p.email };
  }
  return composeBundle(rows, appUrl);
}

const groupKey = (r: QueueRow) => `${r.user_id}\u0000${r.channel}\u0000${r.bundle_key}`;
/** the claim's rows by recipient + channel + bundle, in claim order */
function groupRows(rows: readonly QueueRow[]): QueueRow[][] {
  const groups = new Map<string, QueueRow[]>();
  for (const r of rows) (groups.get(groupKey(r)) ?? groups.set(groupKey(r), []).get(groupKey(r))!).push(r);
  return [...groups.values()];
}

export async function drainQueue(d: DrainDeps): Promise<DrainReport> {
  const report: DrainReport = { claimed: 0, messages: 0, sent: 0, held: 0, dropped: 0, failed: 0, retried: 0, released: 0, batches: 0 };
  const limit = Math.max(1, Math.floor(d.limit ?? 200));
  const size = Math.max(1, Math.min(Math.floor(d.batch ?? limit), limit));
  const budget = Math.max(0, d.budgetMs ?? DRAIN_BUDGET_MS);
  const start = d.now().getTime();
  // per run: one read per person, task and thread (a failed read is remembered too: tried again next run)
  const people = new Map<string, Promise<{ prefs: ResolvedNotifyPrefs } | null>>();
  const sees = new Map<string, Promise<boolean>>();
  const snoozed = new Map<string, Promise<Date | null>>();
  const memo = <T>(m: Map<string, Promise<T>>, k: string, fn: () => Promise<T>): Promise<T> => {
    if (!m.has(k)) m.set(k, Promise.resolve().then(fn));
    return m.get(k)!;
  };

  const retry = async (rows: QueueRow[], e: unknown) => {
    console.warn("[notify] drain: lookup failed, will retry:", String((e as Error)?.message ?? e).slice(0, 200));
    await d.store.finish(rows.map((r) => r.id), "lookup failed").catch(() => undefined);
    report.retried += rows.length;
  };

  const handle = async (list: QueueRow[]) => {
    const { user_id: userId, channel } = list[0];
    let who: { prefs: ResolvedNotifyPrefs } | null;
    try { who = await memo(people, userId, () => d.recipient(userId)); } catch (e) { await retry(list, e); return; }
    const now = d.now();
    if (!who) {
      await d.store.drop(list.map((r) => r.id), "recipient unavailable", now).catch(() => undefined);
      report.dropped += list.length;
      return;
    }
    const keep: QueueRow[] = [], drop: QueueRow[] = [], again: QueueRow[] = [], hold = new Map<number, QueueRow[]>();
    let failure: unknown = null;
    for (const r of list) {
      try {
        if (r.task_id && !(await memo(sees, `${userId}:${r.task_id}`, () => d.canSee(userId, r.task_id!)))) { drop.push(r); continue; }
        if (r.kind === "digest") { keep.push(r); continue; }
        const until = r.task_id ? await memo(snoozed, `${userId}:${r.task_id}`, () => d.snoozedUntil(userId, r.task_id!)) : null;
        // it's due now: only the person's switches, snoozes, digest choice and quiet hours can still stop it
        const plan = planDelivery({ kind: r.kind, channel, now, prefs: who.prefs, snoozedUntil: until });
        if (plan.action === "send") keep.push(r);
        else if (plan.action === "hold") (hold.get(plan.until.getTime()) ?? hold.set(plan.until.getTime(), []).get(plan.until.getTime())!).push(r);
        else drop.push(r);
      } catch (e) { again.push(r); failure = e; }
    }
    if (again.length) await retry(again, failure);
    for (const [t, rs] of hold) { await d.store.rehold(rs, new Date(t)).catch(() => undefined); report.held += rs.length; }
    if (drop.length) { await d.store.drop(drop.map((r) => r.id), "not sent: no longer wanted", now).catch(() => undefined); report.dropped += drop.length; }
    if (!keep.length) return;
    report.messages++;
    const out = await safeSend(() => d.send(userId, channel, composeGroup(keep, d.appUrl)));
    await d.store.finish(keep.map((r) => r.id), out === "failed" ? "send failed" : null).catch(() => undefined);
    if (out === "failed") report.failed++;
    else if (out === "sent") report.sent++;
  };

  while (report.claimed < limit && d.now().getTime() - start < budget) {
    const want = Math.min(size, limit - report.claimed);
    let rows: QueueRow[] = [];
    try { rows = await d.store.claim(want); } catch (e) { console.warn("[notify] drain: claim failed", String((e as Error)?.message ?? e)); break; }
    report.batches++;
    if (!rows.length) break;
    report.claimed += rows.length;
    // no group starts once the run's time is up, or near the end of this claim's lease
    const deadline = Math.min(d.now().getTime() + CLAIM_LEASE_SEC * 1000 - LEASE_MARGIN_MS, start + budget);
    const left: QueueRow[] = [];
    for (const list of groupRows(rows)) {
      if (left.length || d.now().getTime() >= deadline) { left.push(...list); continue; }
      await handle(list);
    }
    if (left.length) {
      // not reached: back in the queue now (no attempt spent), first in line for the next run
      await d.store.release(left).catch(() => undefined);
      report.released += left.length;
      break;
    }
    if (rows.length < want) break;
  }
  return report;
}

/* ---------- the real thing (service role) ---------- */

// deno-lint-ignore no-explicit-any
export type ServiceDb = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any; auth?: any };

const isMissing = (err: unknown) => {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? err);
  return code === "42P01" || code === "PGRST205" || code === "42883" || /does not exist|schema cache/i.test(msg);
};
const DROPPED = "dropped: ";
const cap = (s: unknown, n: number) => String(s ?? "").slice(0, n);

export function supabaseQueueStore(db: ServiceDb): QueueStore {
  return {
    async bundleState(userId, channel, bundleKey, now) {
      const since = new Date(now.getTime() - 36 * 3600_000).toISOString();
      const { data, error } = await db.from("notify_queue").select("sent_at,deliver_after,attempts,last_error")
        .eq("user_id", userId).eq("channel", channel).eq("bundle_key", bundleKey).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(50);
      if (error || !Array.isArray(data)) return { last: null, pending: null, pendingLast: null };
      let last: number | null = null, pending: number | null = null, pendingLast: number | null = null;
      for (const r of data as { sent_at: string | null; deliver_after: string; attempts: number; last_error: string | null }[]) {
        if (r.sent_at) {
          if (String(r.last_error ?? "").startsWith(DROPPED)) continue;
          const t = Date.parse(r.sent_at);
          if (Number.isFinite(t) && (last === null || t > last)) last = t;
        } else if ((r.attempts ?? 0) < 5) {
          const t = Date.parse(r.deliver_after);
          if (!Number.isFinite(t)) continue;
          if (pending === null || t < pending) pending = t;
          if (pendingLast === null || t > pendingLast) pendingLast = t;
        }
      }
      const at = (t: number | null) => (t === null ? null : new Date(t));
      return { last: at(last), pending: at(pending), pendingLast: at(pendingLast) };
    },
    async enqueue(n, deliverAfter, opts = {}) {
      const nowIso = (opts.now ?? new Date()).toISOString();
      const row = {
        user_id: n.userId, channel: n.channel, kind: n.kind, event_key: cap(n.eventKey, 200), bundle_key: cap(n.bundleKey, 200),
        task_id: n.taskId, actor_id: n.actorId, actor_name: cap(n.actorName, 200), title: cap(n.title, 500), payload: n.payload,
        deliver_after: deliverAfter.toISOString(), ...(opts.claimed ? { claimed_at: nowIso, attempts: 1 } : {}),
      };
      const { data, error } = await db.from("notify_queue")
        .upsert(row, { onConflict: "user_id,channel,event_key", ignoreDuplicates: true }).select("id");
      if (error) {
        if (!isMissing(error)) console.warn("[notify] queue refused a notice:", String(error?.message ?? error));
        return { status: "unavailable", error: String(error?.message ?? error) };
      }
      const id = Array.isArray(data) && data.length ? Number(data[0].id) : NaN;
      return Number.isFinite(id) ? { status: "queued", id } : { status: "duplicate" };
    },
    async finish(ids, error = null) {
      if (!ids.length) return;
      await db.rpc("notify_queue_finish", { p_ids: ids, p_error: error ? cap(error, 500) : null });
    },
    async rehold(rows, until) {
      // a fresh hold (quiet hours), not a retry: last_error goes, so a change of prefs can bring it forward
      for (const r of rows) {
        await db.from("notify_queue").update({ deliver_after: until.toISOString(), claimed_at: null, attempts: Math.max(0, (r.attempts ?? 1) - 1), last_error: null }).eq("id", r.id);
      }
    },
    async release(rows) {
      const byAttempts = new Map<number, number[]>();
      for (const r of rows) {
        const a = Math.max(0, (r.attempts ?? 1) - 1);
        (byAttempts.get(a) ?? byAttempts.set(a, []).get(a)!).push(r.id);
      }
      for (const [attempts, ids] of byAttempts) {
        await db.from("notify_queue").update({ claimed_at: null, attempts }).in("id", ids).is("sent_at", null);
      }
    },
    async bringForward(userId, channel, bundleKey, until) {
      const iso = until.toISOString();
      const { data, error } = await db.from("notify_queue").update({ deliver_after: iso })
        .eq("user_id", userId).eq("channel", channel).eq("bundle_key", bundleKey)
        .is("sent_at", null).is("claimed_at", null).is("last_error", null).gt("deliver_after", iso)
        .select("id");
      if (error) return 0;
      return Array.isArray(data) ? data.length : 0;
    },
    async drop(ids, reason, now) {
      if (!ids.length) return;
      await db.from("notify_queue").update({ sent_at: now.toISOString(), claimed_at: null, last_error: cap(DROPPED + reason, 500) }).in("id", ids);
    },
    async claim(limit) {
      const { data, error } = await db.rpc("notify_queue_claim", { p_limit: limit, p_lease_seconds: CLAIM_LEASE_SEC });
      if (error) {
        if (!isMissing(error)) console.warn("[notify] drain: claim failed:", String(error?.message ?? error));
        return [];
      }
      return (Array.isArray(data) ? data : []) as QueueRow[];
    },
  };
}

export interface Recipient { prefs: ResolvedNotifyPrefs; firstName: string }
/** When a recipient's profile can't be read for a fresh event: the defaults, as notify did before 0048. */
export const DEFAULT_RECIPIENT: Recipient = { prefs: resolveNotifyPrefs({}), firstName: "" };

/** The recipient's prefs as the drain and notify read them: null when suspended, not approved or gone.
 *  Throws LookupFailed when the profile can't be read — that's not "gone". */
export async function readRecipient(db: ServiceDb, userId: string): Promise<Recipient | null> {
  const { data: prof, error } = await db.from("profiles").select("notify_prefs,suspended,approved,first_name").eq("id", userId).maybeSingle();
  if (error) throw new LookupFailed("profile", error);
  if (!prof || prof.suspended || prof.approved === false) return null;
  return { prefs: resolveNotifyPrefs(prof.notify_prefs ?? {}), firstName: String(prof.first_name ?? "") };
}

/** notification_snoozes.until for a person's thread (null when not snoozed, or 0048 isn't run).
 *  Throws LookupFailed when it can't be read. */
export async function readSnoozedUntil(db: ServiceDb, userId: string, taskId: string): Promise<Date | null> {
  const { data, error } = await db.from("notification_snoozes").select("until").eq("user_id", userId).eq("task_id", taskId).maybeSingle();
  if (error) {
    if (isMissing(error)) return null;
    throw new LookupFailed("snooze", error);
  }
  if (!data?.until) return null;
  const t = Date.parse(String(data.until));
  return Number.isFinite(t) ? new Date(t) : null;
}

/* ---------- prefs changed: plan what's held again ---------- */

/** The slice of a held notify_queue row replanHeld reads. */
export type HeldRow = Pick<QueueRow, "id" | "kind" | "channel" | "deliver_after" | "claimed_at" | "sent_at"> & { last_error?: string | null };

/**
 * A person's held notices whose wait their prefs no longer call for (quiet
 * hours switched off or shortened, other days, a new time zone): when each
 * may go now — only ever earlier. Still inside quiet hours: their (new) end;
 * otherwise now (the drain then sends it, or drops what's switched off or
 * left to the digest). Untouched: anything due within the bundle window,
 * being sent, waiting to be retried, or already sent. A wait that grew is
 * left alone: the drain holds it again when it comes due.
 */
export function replanHeld(rows: readonly HeldRow[], prefs: ResolvedNotifyPrefs, now: Date): { id: number; until: Date }[] {
  const out: { id: number; until: Date }[] = [];
  const soon = now.getTime() + WINDOW_MS;
  for (const r of rows) {
    if (r.sent_at || r.claimed_at || r.last_error || r.kind === "digest") continue;
    const at = Date.parse(r.deliver_after);
    if (!Number.isFinite(at) || at <= soon) continue;
    const plan = planDelivery({ kind: r.kind, channel: r.channel, now, prefs });
    const until = plan.action === "hold" ? plan.until.getTime() : now.getTime();
    if (until < at - 1000) out.push({ id: r.id, until: new Date(until) });
  }
  return out;
}

/** replanHeld on the person's own held notices (notify { kind: "replan" }); answers how many moved. */
export async function rescheduleHeld(db: ServiceDb, userId: string, prefs: ResolvedNotifyPrefs, now: Date): Promise<number> {
  const { data, error } = await db.from("notify_queue").select("id,kind,channel,deliver_after,claimed_at,sent_at,last_error")
    .eq("user_id", userId).is("sent_at", null).gt("deliver_after", new Date(now.getTime() + WINDOW_MS).toISOString())
    .order("deliver_after", { ascending: true }).limit(500);
  if (error) {
    if (isMissing(error)) return 0;
    throw new LookupFailed("held notices", error);
  }
  const moves = replanHeld((Array.isArray(data) ? data : []) as HeldRow[], prefs, now);
  const byUntil = new Map<number, number[]>();
  for (const m of moves) (byUntil.get(m.until.getTime()) ?? byUntil.set(m.until.getTime(), []).get(m.until.getTime())!).push(m.id);
  let moved = 0;
  for (const [t, ids] of byUntil) {
    const iso = new Date(t).toISOString();
    // only what's still waiting (a drain may have claimed some meanwhile), and only ever earlier
    const { data: done, error: e } = await db.from("notify_queue").update({ deliver_after: iso })
      .in("id", ids).eq("user_id", userId).is("sent_at", null).is("claimed_at", null).gt("deliver_after", iso).select("id");
    if (!e) moved += Array.isArray(done) ? done.length : 0;
  }
  return moved;
}

export interface SenderEnv { resendKey?: string | null; from?: string | null; vapid: VapidKeys | null }

/** Send one composed message to one person on one channel. */
export async function sendComposed(db: ServiceDb, userId: string, channel: NotifyChannel, msg: Composed, env: SenderEnv): Promise<SendOutcome> {
  if (channel === "push") {
    if (!env.vapid || !msg.push) return "nothing";
    const r = await pushToUser(db, userId, msg.push, env.vapid, { ttl: 12 * 3600 });
    return r.sent > 0 ? "sent" : r.failed > 0 ? "failed" : "nothing";
  }
  if (!env.resendKey || !msg.email) return "nothing";
  const { data: u } = await db.auth.admin.getUserById(userId);
  const email = u?.user?.email;
  if (!email) return "nothing";
  const r = await sendEmail({ resendKey: env.resendKey, from: env.from }, { to: email, subject: msg.email.subject, html: msg.email.html, text: msg.email.text });
  return r.ok ? "sent" : "failed";
}

/** Resend takes about two requests a second: the drain leaves this long after each email (as "due" and "digest" do). */
export const EMAIL_GAP_MS = 550;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The drain's dependencies on the real database (notify's drain and daily-reminders' share them). */
export function supabaseDrainDeps(db: ServiceDb, env: SenderEnv & { appUrl: string; limit?: number; batch?: number; budgetMs?: number },
  opts: { sleep?: (ms: number) => Promise<void> } = {}): DrainDeps {
  const sleep = opts.sleep ?? pause;
  const members = new Map<string, Promise<Set<string>>>();
  // a failed read throws (and is remembered for this run): their notices wait for the next one
  const teamOf = (workspaceId: string) => {
    if (!members.has(workspaceId)) {
      members.set(workspaceId, (async () => {
        const out = new Set<string>();
        const { data: ms, error: e1 } = await db.from("workspace_members").select("user_id").eq("workspace_id", workspaceId).eq("status", "active");
        if (e1) throw new LookupFailed("members", e1);
        for (const m of ms ?? []) if (m.user_id) out.add(String(m.user_id));
        const { data: ws, error: e2 } = await db.from("workspaces").select("owner_id").eq("id", workspaceId).maybeSingle();
        if (e2) throw new LookupFailed("workspace", e2);
        if (ws?.owner_id) out.add(String(ws.owner_id));
        return out;
      })());
    }
    return members.get(workspaceId)!;
  };
  return {
    store: supabaseQueueStore(db),
    now: () => new Date(),
    appUrl: env.appUrl,
    limit: env.limit,
    batch: env.batch,
    budgetMs: env.budgetMs,
    recipient: (userId) => readRecipient(db, userId),
    async canSee(userId, taskId) {
      const { data: t, error } = await db.from("tasks").select("user_id,workspace_id,archived_at").eq("id", taskId).maybeSingle();
      if (error) throw new LookupFailed("task", error);
      if (!t || t.archived_at) return false;
      if (!t.workspace_id) return String(t.user_id) === userId;
      return (await teamOf(String(t.workspace_id))).has(userId);
    },
    snoozedUntil: (userId, taskId) => readSnoozedUntil(db, userId, taskId),
    async send(userId, channel, msg) {
      const out = await sendComposed(db, userId, channel, msg, env);
      if (channel === "email" && out !== "nothing") await sleep(EMAIL_GAP_MS);
      return out;
    },
  };
}
