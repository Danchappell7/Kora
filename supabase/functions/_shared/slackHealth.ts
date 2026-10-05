// ============================================================
// KANBO — is the daily Slack stand-up really being posted?      [f6-slack]
// Settings lets an owner/admin switch the daily post on, but the post is
// made by slack-standup on pg_cron. If that function isn't deployed, the job
// isn't scheduled, or Slack refuses the post, nothing arrives, so the panel
// has to be told. slack-standup leaves two kinds of mark in rate_limits
// (migration 0042, service role only; nobody else can read it):
//
//   kanbo:slack-standup:heartbeat
//       every scheduled run (not forced manual runs), weekends included.
//       Older than an hour (four missed runs): the daily post isn't running.
//   kanbo:slack-standup:fail:<workspace>:<tag>:<detail>
//       the last time that workspace's stand-up didn't go out, with Slack's
//       error word ("channel_is_archived", "no_service", "http_404"…) or
//       "unreachable" / "kanbo_error". <tag> is 12 hex characters of the
//       webhook's SHA-256, so a failure belongs to the link it happened with:
//       replacing the link drops it. Never the webhook itself.
//
// A delivered post clears the workspace's failure: the daily one, a forced
// run, a test or any post through slack-post. slack-post's "status" action
// (owners/admins) reads both back for Settings.
//
// No Deno globals, no remote imports (vitest runs it: slackHealth.test.ts).
// Best effort: nothing here throws, and without rate_limits the heartbeat is
// unknown (null), never "not running".
// ============================================================
import { KEY_PREFIX, type Db } from "./limits.ts";
import { zonedNow } from "./slack.ts";

export const STANDUP_HEARTBEAT_KEY = `${KEY_PREFIX}slack-standup:heartbeat`;
/** pg_cron runs slack-standup every 15 minutes: a heartbeat older than this means it isn't running. */
export const STANDUP_HEARTBEAT_FRESH_SEC = 60 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_RE = /^[0-9a-f]{12}$/;
/** Slack's error words, http_NNN, and our own few. */
export const FAILURE_DETAIL_RE = /^[a-z0-9_]{2,60}$/;

/** The prefix of a workspace's failure keys. */
export const standupFailurePrefix = (workspaceId: string) => `${KEY_PREFIX}slack-standup:fail:${workspaceId}:`;

/** 12 hex characters of the webhook's SHA-256: which link a failure happened with (not reversible). */
export async function webhookTag(hook: string): Promise<string> {
  const bytes = new TextEncoder().encode(String(hook ?? "").trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A failure word safe to keep in a key: Slack's words pass; anything else is "unknown". */
export function cleanFailureDetail(detail: unknown): string {
  const d = String(detail ?? "").trim().toLowerCase();
  return FAILURE_DETAIL_RE.test(d) ? d : "unknown";
}

/** Each scheduled run: "the daily post is running". */
export async function markStandupHeartbeat(db: Db, now = Date.now()): Promise<void> {
  try {
    await db.from("rate_limits").upsert({ key: STANDUP_HEARTBEAT_KEY, last_at: new Date(now).toISOString(), count: 0 }, { onConflict: "key" });
  } catch { /* best effort */ }
}

/** The workspace's stand-up didn't go out: keep the latest reason (one row per workspace). */
export async function recordStandupFailure(db: Db, workspaceId: string, hook: string, detail: unknown, now = Date.now()): Promise<void> {
  if (!UUID.test(workspaceId)) return;
  try {
    const tag = await webhookTag(hook);
    await db.from("rate_limits").delete().like("key", `${standupFailurePrefix(workspaceId)}%`);
    await db.from("rate_limits").upsert(
      { key: `${standupFailurePrefix(workspaceId)}${tag}:${cleanFailureDetail(detail)}`, last_at: new Date(now).toISOString(), count: 1 },
      { onConflict: "key" },
    );
  } catch { /* best effort */ }
}

/** A post reached the channel: forget the workspace's failure. */
export async function clearStandupFailure(db: Db, workspaceId: string): Promise<void> {
  if (!UUID.test(workspaceId)) return;
  try { await db.from("rate_limits").delete().like("key", `${standupFailurePrefix(workspaceId)}%`); } catch { /* best effort */ }
}

export interface AutopostFailure {
  /** Slack's error word, http_NNN, "unreachable" or "kanbo_error" */
  detail: string;
  /** when it happened (ISO) */
  at: string;
  /** that day in the stand-up's time zone (YYYY-MM-DD) */
  day: string;
}
export interface AutopostHealth {
  /** true: the scheduler ran in the last hour · false: it hasn't (not deployed or not scheduled) · null: can't tell */
  autopostReady: boolean | null;
  /** the last time the daily post didn't go out with the current link, if it hasn't worked since */
  lastAutopostError: AutopostFailure | null;
}

interface Row { key?: unknown; last_at?: unknown }

/** What the rows say (pure). `heartbeat` undefined = couldn't read rate_limits. */
export function readAutopostHealth(input: {
  heartbeat: Row | null | undefined;
  failures: readonly Row[] | null | undefined;
  workspaceId: string;
  /** webhookTag() of the current link; null when not connected */
  tag: string | null;
  now?: number;
  tz?: string;
}): AutopostHealth {
  const now = input.now ?? Date.now();
  let autopostReady: boolean | null = null;
  if (input.heartbeat !== undefined) {
    const at = Date.parse(String(input.heartbeat?.last_at ?? ""));
    autopostReady = Number.isFinite(at) && now - at < STANDUP_HEARTBEAT_FRESH_SEC * 1000;
  }
  let lastAutopostError: AutopostFailure | null = null;
  if (input.tag && TAG_RE.test(input.tag)) {
    const prefix = `${standupFailurePrefix(input.workspaceId)}${input.tag}:`;
    for (const r of input.failures ?? []) {
      const key = String(r?.key ?? "");
      if (!key.startsWith(prefix)) continue;
      const detail = key.slice(prefix.length);
      const at = Date.parse(String(r?.last_at ?? ""));
      if (!FAILURE_DETAIL_RE.test(detail) || !Number.isFinite(at)) continue;
      if (lastAutopostError && Date.parse(lastAutopostError.at) >= at) continue;
      const iso = new Date(at).toISOString();
      lastAutopostError = { detail, at: iso, day: zonedNow(new Date(at), input.tz ?? "Europe/London").day };
    }
  }
  return { autopostReady, lastAutopostError };
}

/** Read the heartbeat and the workspace's failure (service role). Never throws. */
export async function loadAutopostHealth(db: Db, workspaceId: string, hook: string | null | undefined, opts: { now?: number; tz?: string } = {}): Promise<AutopostHealth> {
  if (!UUID.test(workspaceId)) return { autopostReady: null, lastAutopostError: null };
  try {
    const link = String(hook ?? "").trim();
    const [hb, fails, tag] = await Promise.all([
      db.from("rate_limits").select("*").eq("key", STANDUP_HEARTBEAT_KEY).maybeSingle(),
      link ? db.from("rate_limits").select("*").like("key", `${standupFailurePrefix(workspaceId)}%`) : Promise.resolve({ data: [], error: null }),
      link ? webhookTag(link) : Promise.resolve(null),
    ]);
    return readAutopostHealth({
      heartbeat: hb?.error ? undefined : (hb?.data ?? null),
      failures: fails?.error ? [] : ((fails?.data ?? []) as Row[]),
      workspaceId, tag, now: opts.now, tz: opts.tz,
    });
  } catch {
    return { autopostReady: null, lastAutopostError: null };
  }
}
