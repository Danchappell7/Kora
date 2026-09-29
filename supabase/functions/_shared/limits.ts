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
// limit — the loser re-reads and sees the winner's hit.
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
    for (let attempt = 0; attempt < 5; attempt++) {
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
    // lost the race five times in a row on one key: that's a burst, not a person
    return { allowed: false, retryAfter: 1 };
  } catch (e) {
    return failOpen("rate_limits", e);
  }
}

/** Forget a key (e.g. the guarded email failed to send, so let them retry now). */
export async function release(db: Db, key: string): Promise<void> {
  try { await db.from("rate_limits").delete().eq("key", key); } catch { /* best effort */ }
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
  /** true when denied only because of a burst of simultaneous calls */
  busy?: boolean;
}

/**
 * Count one AI call for `userId` on `day` (YYYY-MM-DD) against a daily `limit`.
 * Denies once the limit is reached; fails open if ai_usage doesn't exist yet.
 */
export async function countAiCall(db: Db, userId: string, day: string, limit: number): Promise<AiUsageResult> {
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ins = await db.from("ai_usage")
        .upsert({ user_id: userId, day, calls: 1 }, { onConflict: "user_id,day", ignoreDuplicates: true })
        .select("calls");
      if (ins.error) return { ...failOpen("ai_usage", ins.error), used: 0, limit };
      if (ins.data && ins.data.length) return { allowed: true, used: 1, limit };

      const cur = await db.from("ai_usage").select("calls").eq("user_id", userId).eq("day", day).maybeSingle();
      if (cur.error) return { ...failOpen("ai_usage", cur.error), used: 0, limit };
      if (!cur.data) continue;
      const calls = Number(cur.data.calls ?? 0);
      if (calls >= limit) return { allowed: false, used: calls, limit };

      let upd = db.from("ai_usage").update({ calls: calls + 1 }).eq("user_id", userId).eq("day", day);
      upd = cur.data.calls === null ? upd.is("calls", null) : upd.eq("calls", calls);
      const res = await upd.select("calls");
      if (res.error) return { ...failOpen("ai_usage", res.error), used: 0, limit };
      if (res.data && res.data.length) return { allowed: true, used: calls + 1, limit };
    }
    return { allowed: false, used: -1, limit, busy: true };
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
 * The caller's IP as seen by Supabase's edge (first X-Forwarded-For hop).
 * Empty string when unknown — callers then skip the per-IP limit.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim() ?? "";
  const ip = first || headers.get("cf-connecting-ip") || headers.get("x-real-ip") || "";
  return /^[0-9a-f:.]{3,45}$/i.test(ip) ? ip : "";
}
