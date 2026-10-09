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
//   drainQueue()  claims what's due, groups it by recipient + channel +
//     task, checks each notice again (they may have left the workspace,
//     snoozed the thread, switched to the digest, or be in quiet hours now)
//     and sends ONE message per group naming everyone and every mention.
//
// Pure module (no Deno globals, no remote imports): the storage and the
// senders are injected, so notifyQueue.test.ts runs it on an in-memory
// queue against a pinned clock. supabaseQueueStore / supabaseDrainDeps are
// the real ones, used by notify and daily-reminders.
// ============================================================
import { planDelivery, resolveNotifyPrefs, type DeliveryPlan, type NotifyChannel, type NotifyKind, type ResolvedNotifyPrefs } from "./notifyTiming.ts";
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

/** The queue's storage (notify_queue through the service role, or a fake in tests). */
export interface QueueStore {
  /** for one recipient, channel and bundle: when the last one went out (within the last day and a half),
   *  and the earliest deliver_after of those still waiting */
  bundleState(userId: string, channel: NotifyChannel, bundleKey: string, now: Date): Promise<{ last: Date | null; pending: Date | null }>;
  /** record a notice (idempotent on user + channel + event_key); `claimed`: it's being sent right now */
  enqueue(n: Notice, deliverAfter: Date, opts?: { claimed?: boolean; now?: Date }): Promise<EnqueueResult>;
  /** sent (error null), or released for a retry with backoff */
  finish(ids: number[], error?: string | null): Promise<void>;
  /** back in the queue until a time, without spending an attempt (quiet hours began while it waited) */
  rehold(rows: Pick<QueueRow, "id" | "attempts">[], until: Date): Promise<void>;
  /** handled without sending (snoozed, switched off, left the workspace…) */
  drop(ids: number[], reason: string, now: Date): Promise<void>;
  claim(limit: number): Promise<QueueRow[]>;
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

const NO_STATE = { last: null, pending: null };
const safeSend = async (fn: () => Promise<SendOutcome>): Promise<SendOutcome> => { try { return await fn(); } catch { return "failed"; } };

export async function deliverNotice(n: Notice, d: DeliverDeps): Promise<{ result: DeliverResult; plan: DeliveryPlan }> {
  let state: { last: Date | null; pending: Date | null } = NO_STATE;
  if (d.prefs.bundle && n.taskId) state = await d.store.bundleState(n.userId, n.channel, n.bundleKey, d.now).catch(() => NO_STATE);
  const plan = n.kind === "digest" ? { action: "send" } as DeliveryPlan : planDelivery({
    kind: n.kind, channel: n.channel, now: d.now, prefs: d.prefs, snoozedUntil: d.snoozedUntil ?? null,
    lastSentForTask: state.last, pendingUntil: state.pending,
  });
  if (plan.action === "skip") return { result: "skipped", plan };
  if (plan.action === "digest") return { result: "digest", plan };
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

export interface DrainDeps {
  store: QueueStore;
  now: () => Date;
  /** the site, for links ("https://www.kanbo.co.uk") */
  appUrl: string;
  limit?: number;
  /** the recipient as they are now; null: gone, suspended or not approved (their notices are dropped) */
  recipient(userId: string): Promise<{ prefs: ResolvedNotifyPrefs } | null>;
  /** can they still see the task? (people leave workspaces while a notice waits) */
  canSee(userId: string, taskId: string): Promise<boolean>;
  snoozedUntil(userId: string, taskId: string): Promise<Date | null>;
  send(userId: string, channel: NotifyChannel, msg: Composed): Promise<SendOutcome>;
}
export interface DrainReport { claimed: number; messages: number; sent: number; held: number; dropped: number; failed: number }

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

export async function drainQueue(d: DrainDeps): Promise<DrainReport> {
  const report: DrainReport = { claimed: 0, messages: 0, sent: 0, held: 0, dropped: 0, failed: 0 };
  let rows: QueueRow[] = [];
  try { rows = await d.store.claim(d.limit ?? 200); } catch (e) { console.warn("[notify] drain: claim failed", String((e as Error)?.message ?? e)); return report; }
  report.claimed = rows.length;
  const groups = new Map<string, QueueRow[]>();
  for (const r of rows) {
    const k = `${r.user_id}\u0000${r.channel}\u0000${r.bundle_key}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const people = new Map<string, Promise<{ prefs: ResolvedNotifyPrefs } | null>>();
  const sees = new Map<string, Promise<boolean>>();
  const snoozed = new Map<string, Promise<Date | null>>();
  const memo = <T>(m: Map<string, Promise<T>>, k: string, fn: () => Promise<T>, fallback: T) => {
    if (!m.has(k)) m.set(k, fn().catch(() => fallback));
    return m.get(k)!;
  };
  for (const list of groups.values()) {
    const { user_id: userId, channel } = list[0];
    const who = await memo(people, userId, () => d.recipient(userId), null);
    const now = d.now();
    if (!who) {
      await d.store.drop(list.map((r) => r.id), "recipient unavailable", now).catch(() => undefined);
      report.dropped += list.length;
      continue;
    }
    const keep: QueueRow[] = [], drop: QueueRow[] = [], hold = new Map<number, QueueRow[]>();
    for (const r of list) {
      if (r.task_id && !(await memo(sees, `${userId}:${r.task_id}`, () => d.canSee(userId, r.task_id!), false))) { drop.push(r); continue; }
      if (r.kind === "digest") { keep.push(r); continue; }
      const until = r.task_id ? await memo(snoozed, `${userId}:${r.task_id}`, () => d.snoozedUntil(userId, r.task_id!), null) : null;
      // it's due now: only the person's switches, snoozes, digest choice and quiet hours can still stop it
      const plan = planDelivery({ kind: r.kind, channel, now, prefs: who.prefs, snoozedUntil: until });
      if (plan.action === "send") keep.push(r);
      else if (plan.action === "hold") (hold.get(plan.until.getTime()) ?? hold.set(plan.until.getTime(), []).get(plan.until.getTime())!).push(r);
      else drop.push(r);
    }
    for (const [t, rs] of hold) { await d.store.rehold(rs, new Date(t)).catch(() => undefined); report.held += rs.length; }
    if (drop.length) { await d.store.drop(drop.map((r) => r.id), "not sent: no longer wanted", now).catch(() => undefined); report.dropped += drop.length; }
    if (!keep.length) continue;
    report.messages++;
    const out = await safeSend(() => d.send(userId, channel, composeGroup(keep, d.appUrl)));
    await d.store.finish(keep.map((r) => r.id), out === "failed" ? "send failed" : null).catch(() => undefined);
    if (out === "failed") report.failed++;
    else if (out === "sent") report.sent++;
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
      if (error || !Array.isArray(data)) return { last: null, pending: null };
      let last: number | null = null, pending: number | null = null;
      for (const r of data as { sent_at: string | null; deliver_after: string; attempts: number; last_error: string | null }[]) {
        if (r.sent_at) {
          if (String(r.last_error ?? "").startsWith(DROPPED)) continue;
          const t = Date.parse(r.sent_at);
          if (Number.isFinite(t) && (last === null || t > last)) last = t;
        } else if ((r.attempts ?? 0) < 5) {
          const t = Date.parse(r.deliver_after);
          if (Number.isFinite(t) && (pending === null || t < pending)) pending = t;
        }
      }
      return { last: last === null ? null : new Date(last), pending: pending === null ? null : new Date(pending) };
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
      for (const r of rows) {
        await db.from("notify_queue").update({ deliver_after: until.toISOString(), claimed_at: null, attempts: Math.max(0, (r.attempts ?? 1) - 1) }).eq("id", r.id);
      }
    },
    async drop(ids, reason, now) {
      if (!ids.length) return;
      await db.from("notify_queue").update({ sent_at: now.toISOString(), claimed_at: null, last_error: cap(DROPPED + reason, 500) }).in("id", ids);
    },
    async claim(limit) {
      const { data, error } = await db.rpc("notify_queue_claim", { p_limit: limit, p_lease_seconds: 120 });
      if (error) {
        if (!isMissing(error)) console.warn("[notify] drain: claim failed:", String(error?.message ?? error));
        return [];
      }
      return (Array.isArray(data) ? data : []) as QueueRow[];
    },
  };
}

/** The recipient's prefs as the drain and notify read them (null: suspended / not approved / gone). */
export async function readRecipient(db: ServiceDb, userId: string): Promise<{ prefs: ResolvedNotifyPrefs; firstName: string } | null> {
  const { data: prof, error } = await db.from("profiles").select("notify_prefs,suspended,approved,first_name").eq("id", userId).maybeSingle();
  if (error || !prof || prof.suspended || prof.approved === false) return null;
  return { prefs: resolveNotifyPrefs(prof.notify_prefs ?? {}), firstName: String(prof.first_name ?? "") };
}

/** notification_snoozes.until for a person's thread (null when not snoozed or unreadable). */
export async function readSnoozedUntil(db: ServiceDb, userId: string, taskId: string): Promise<Date | null> {
  const { data, error } = await db.from("notification_snoozes").select("until").eq("user_id", userId).eq("task_id", taskId).maybeSingle();
  if (error || !data?.until) return null;
  const t = Date.parse(String(data.until));
  return Number.isFinite(t) ? new Date(t) : null;
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

/** The drain's dependencies on the real database (notify's drain and daily-reminders' share them). */
export function supabaseDrainDeps(db: ServiceDb, env: SenderEnv & { appUrl: string; limit?: number }): DrainDeps {
  const members = new Map<string, Promise<Set<string>>>();
  const teamOf = (workspaceId: string) => {
    if (!members.has(workspaceId)) {
      members.set(workspaceId, (async () => {
        const out = new Set<string>();
        const { data: ms } = await db.from("workspace_members").select("user_id").eq("workspace_id", workspaceId).eq("status", "active");
        for (const m of ms ?? []) if (m.user_id) out.add(String(m.user_id));
        const { data: ws } = await db.from("workspaces").select("owner_id").eq("id", workspaceId).maybeSingle();
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
    recipient: (userId) => readRecipient(db, userId),
    async canSee(userId, taskId) {
      const { data: t } = await db.from("tasks").select("user_id,workspace_id,archived_at").eq("id", taskId).maybeSingle();
      if (!t || t.archived_at) return false;
      if (!t.workspace_id) return String(t.user_id) === userId;
      return (await teamOf(String(t.workspace_id))).has(userId);
    },
    snoozedUntil: (userId, taskId) => readSnoozedUntil(db, userId, taskId),
    send: (userId, channel, msg) => sendComposed(db, userId, channel, msg, env),
  };
}
