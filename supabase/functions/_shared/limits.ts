// ============================================================
// KANBO — shared throttling + AI usage metering for Edge Functions.
//
// Backed by two service-role-only tables from migration 0042:
//   rate_limits(key text primary key, last_at timestamptz, count int)
//   ai_usage(user_id uuid, day date, calls int, primary key (user_id, day))
//
// Everything here FAILS OPEN: if 0042 hasn't been run yet (table missing) or
// the database hiccups, the caller is allowed through and we console.warn —
// throttling must never be the reason a real person can't reset a password.
//
// Writes are compare-and-swap (UPDATE … WHERE the row still has the values we
// read), so two simultaneous requests can't both slip through a 1-per-minute
// limit — the loser re-reads and sees the winner's hit. Losers back off for a
// few random milliseconds before re-reading, and a request that keeps losing
// while the count is still under the limit is let through (not counted)
// rather than refused: a burst of genuine calls — say 40 assignment emails
// after a bulk reassign — must never be throttled below `max`.
//
// Pure module (no Deno globals, no remote imports) so vitest can exercise it
// with an in-memory fake client: see limits.test.ts.
// ============================================================

/** The slice of a supabase-js client these helpers use (service role). */
// deno-lint-ignore no-explicit-any
export type Db = { from(table: string): any };

export interface HitResult {
  /** true → go ahead; false → over the limit */
  allowed: boolean;
  /** seconds until the window resets (0 when allowed) */
  retryAfter: number;
  /** true when the limiter couldn't run (table missing / DB error) and failed open */
  degraded?: boolean;
}

export interface Window {
  /** window length in seconds */
  windowSec: number;
  /** hits allowed per window (default 1) */
  max?: number;
  /** clock override for tests (ms since epoch) */
  now?: number;
}

/** Namespace for every key we write, so housekeeping only ever touches ours. */
export const KEY_PREFIX = "kanbo:";

/** CAS attempts before giving up on counting a hit (see hit()). */
const CAS_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Random, growing pause after a lost compare-and-swap so a burst spreads out. */
const backoff = (attempt: number) => sleep(2 + Math.random() * 15 * (attempt + 1));

const warned = new Set<string>();
function failOpen(where: string, err: unknown): HitResult {
  const msg = String((err as { message?: string })?.message ?? err);
  const code = String((err as { code?: string })?.code ?? "");
  const missing = code === "42P01" || code === "PGRST205" || /does not exist|schema cache/i.test(msg);
  const tag = `${where}:${missing ? "missing" : code || "error"}`;
  if (!warned.has(tag)) {
    warned.add(tag);
    console.warn(
      missing
        ? `[limits] ${where} table not found — run migration 0042. Allowing requests until then.`
        : `[limits] ${where} check failed (${code || "error"}: ${msg}). Allowing the request.`,
    );
  }
  return { allowed: true, retryAfter: 0, degraded: true };
}

/**
 * Record one hit against `key` and say whether it's within the limit
 * (fixed window: at most `max` hits per `windowSec`, counted from the first).
 */
export async function hit(db: Db, key: string, opts: Window): Promise<HitResult> {
  const max = Math.max(1, opts.max ?? 1);
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowSec * 1000;
  const nowIso = new Date(now).toISOString();
  try {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      if (attempt > 0) await backoff(attempt);
      // first hit in a fresh key: plain insert (ON CONFLICT DO NOTHING)
      const ins = await db.from("rate_limits")
        .upsert({ key, last_at: nowIso, count: 1 }, { onConflict: "key", ignoreDuplicates: true })
        .select("key");
      if (ins.error) return failOpen("rate_limits", ins.error);
      if (ins.data && ins.data.length) return { allowed: true, retryAfter: 0 };

      // select * (not "last_at,count"): keeps PostgREST from reading the bare
      // column name `count` as its count() aggregate
      const cur = await db.from("rate_limits").select("*").eq("key", key).maybeSingle();
      if (cur.error) return failOpen("rate_limits", cur.error);
      if (!cur.data) continue; // cleaned up between our insert and read — go again

      const startedAt = Date.parse(cur.data.last_at);
      const count = Number(cur.data.count ?? 0);
      const live = Number.isFinite(startedAt) && now - startedAt < windowMs;
      if (live && count >= max) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((startedAt + windowMs - now) / 1000)) };
      }
      // CAS: only succeeds if nobody else moved the row since we read it
      let upd = db.from("rate_limits")
        .update(live ? { count: count + 1 } : { last_at: nowIso, count: 1 })
        .eq("key", key).eq("last_at", cur.data.last_at);
      upd = cur.data.count === null ? upd.is("count", null) : upd.eq("count", count);
      const res = await upd.select("key");
      if (res.error) return failOpen("rate_limits", res.error);
      if (res.data && res.data.length) return { allowed: true, retryAfter: 0 };
    }
    // Kept losing the race, and every read said we were still under `max`:
    // plenty of simultaneous callers, none of them over the limit. Let this
    // one through uncounted rather than refuse a legitimate burst. (Over the
    // limit, the read above refuses straight away — no retries needed.)
    return { allowed: true, retryAfter: 0, degraded: true };
  } catch (e) {
    return failOpen("rate_limits", e);
  }
}

/**
 * Is `key` inside a live window (a hit() within the last `windowSec`)?
 * Read-only — records nothing. False when unknown (no row, table missing, error).
 */
export async function recentlyHit(db: Db, key: string, windowSec: number, now = Date.now()): Promise<boolean> {
  try {
    const cur = await db.from("rate_limits").select("*").eq("key", key).maybeSingle();
    if (cur.error || !cur.data) return false;
    const at = Date.parse(cur.data.last_at);
    return Number.isFinite(at) && now - at < windowSec * 1000;
  } catch {
    return false;
  }
}

/** Forget a key (e.g. the guarded email failed to send, so let them retry now). */
export async function release(db: Db, key: string): Promise<void> {
  try { await db.from("rate_limits").delete().eq("key", key); } catch { /* best effort */ }
}

/**
 * Give back ONE hit on a shared key whose work didn't happen (say a form's
 * hourly allowance, when the task then failed to save), leaving everyone
 * else's hits counted — unlike release(), which forgets the whole key.
 * Compare-and-swap like hit(); never below zero; best effort, never throws.
 */
export async function refund(db: Db, key: string): Promise<void> {
  try {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      if (attempt > 0) await backoff(attempt);
      const cur = await db.from("rate_limits").select("*").eq("key", key).maybeSingle();
      if (cur.error || !cur.data) return;
      const count = Number(cur.data.count ?? 0);
      if (!(count > 0)) return;
      const res = await db.from("rate_limits").update({ count: count - 1 })
        .eq("key", key).eq("last_at", cur.data.last_at).eq("count", count).select("key");
      if (res.error || (res.data && res.data.length)) return;
    }
  } catch { /* best effort */ }
}

/**
 * Occasional housekeeping: drop our keys that haven't been touched for a week
 * (every window we use is ≤ 1 day). Runs on ~2% of calls; never throws.
 */
export async function sweep(db: Db, now = Date.now(), chance = 0.02): Promise<void> {
  if (Math.random() >= chance) return;
  try {
    await db.from("rate_limits").delete()
      .like("key", `${KEY_PREFIX}%`)
      .lt("last_at", new Date(now - 7 * 86400_000).toISOString());
  } catch { /* best effort */ }
}

export interface AiUsageResult {
  allowed: boolean;
  /** calls counted today including this one (when allowed) */
  used: number;
  limit: number;
  degraded?: boolean;
}

/**
 * Count one AI call for `userId` on `day` (YYYY-MM-DD) against a daily `limit`.
 * Denies once the limit is reached; fails open if ai_usage doesn't exist yet.
 */
export async function countAiCall(db: Db, userId: string, day: string, limit: number): Promise<AiUsageResult> {
  try {
    let calls = 0;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      if (attempt > 0) await backoff(attempt);
      const ins = await db.from("ai_usage")
        .upsert({ user_id: userId, day, calls: 1 }, { onConflict: "user_id,day", ignoreDuplicates: true })
        .select("calls");
      if (ins.error) return { ...failOpen("ai_usage", ins.error), used: 0, limit };
      if (ins.data && ins.data.length) return { allowed: true, used: 1, limit };

      const cur = await db.from("ai_usage").select("calls").eq("user_id", userId).eq("day", day).maybeSingle();
      if (cur.error) return { ...failOpen("ai_usage", cur.error), used: 0, limit };
      if (!cur.data) continue;
      calls = Number(cur.data.calls ?? 0);
      if (calls >= limit) return { allowed: false, used: calls, limit };

      let upd = db.from("ai_usage").update({ calls: calls + 1 }).eq("user_id", userId).eq("day", day);
      upd = cur.data.calls === null ? upd.is("calls", null) : upd.eq("calls", calls);
      const res = await upd.select("calls");
      if (res.error) return { ...failOpen("ai_usage", res.error), used: 0, limit };
      if (res.data && res.data.length) return { allowed: true, used: calls + 1, limit };
    }
    // lots of simultaneous calls, all under the limit: allow, uncounted (see hit())
    return { allowed: true, used: calls + 1, limit, degraded: true };
  } catch (e) {
    return { ...failOpen("ai_usage", e), used: 0, limit };
  }
}

/** Calendar date (YYYY-MM-DD) in a timezone — the unit AI limits reset on. */
export function dayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Stable, non-reversible key part for personal data (emails, IPs), so the
 * rate_limits table never stores an address in the clear.
 */
export async function hashKey(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The caller's IP, from headers the caller can't forge: Cloudflare's
 * cf-connecting-ip (Supabase sits behind Cloudflare, which overwrites it),
 * then x-real-ip, then the LAST X-Forwarded-For hop — the one our own edge
 * appended. Never the first hop: proxies keep whatever the caller sent there,
 * so a fake X-Forwarded-For per request would dodge every per-IP limit.
 * Empty string when unknown — callers then skip the per-IP limit.
 */
export function clientIp(headers: Headers): string {
  const hops = (headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const ip = headers.get("cf-connecting-ip")?.trim() || headers.get("x-real-ip")?.trim() || hops[hops.length - 1] || "";
  return /^[0-9a-f:.]{3,45}$/i.test(ip) ? ip : "";
}
