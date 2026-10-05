// ============================================================
// KANBO — the ics-feed request handler, kept pure for testing.   [f7-calendar]
// supabase/functions/ics-feed/index.ts is a thin Deno.serve wrapper that hands
// this a service-role client; vitest (icsFeed.test.ts) drives it with an
// in-memory stand-in for supabase-js.
//
//   GET|HEAD /functions/v1/ics-feed?t=<token>
//   · token: the person's calendar_feed_tokens.token (0043; server-generated,
//     64 hex). Unknown or malformed → 404 text/plain, nothing else said.
//   · tasks: tasks_visible_to(user) (service role; the app's own read rule,
//     nothing for a suspended or unapproved account), open and unarchived,
//     and not in an archived project; their own plan rows from
//     task_user_state; project names.
//   · GET ?ping=1 → 204 before anything else (no token, no database): the
//     app's check that this function is deployed.
//   · 200 text/calendar, Cache-Control private 15 min, a strong ETag of the
//     body; If-None-Match → 304.
//   · Limits (rate_limits, 0042; fail open): 120 fetches an hour per token,
//     and 30 unknown tokens per 10 minutes per IP.
//   · A database error is a 503, never an empty calendar: an empty feed
//     would wipe the person's events from their calendar until the next poll.
// The token is a secret: it's never logged and only its hash is used as a
// rate-limit key.
// ============================================================
import { clientIp, dayIn, hashKey, hit, KEY_PREFIX, sweep, type HitResult, type Window } from "./limits.ts";
import { buildIcs, FEED_DAYS, feedEvents, feedStamp, addIcsDays, type FeedStateRow, type FeedTaskRow } from "./ics.ts";

/** The slice of a supabase-js (service-role) client the handler uses. */
// deno-lint-ignore no-explicit-any
export type FeedDb = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

export interface FeedDeps {
  db: FeedDb;
  /** e.g. "https://www.kanbo.co.uk" */
  appUrl: string;
  /** clock override for tests */
  now?: Date;
  /** rate limiter (default: limits.ts hit() against `db`) */
  limit?: (key: string, w: Window) => Promise<HitResult>;
}

/** What a feed token looks like (0043's check constraint). */
export const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
export const FEED_TZ = "Europe/London";
export const FEED_CACHE_SECONDS = 900;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_COLS = "id,title,status,project_id,workspace_id,assignee_id,collaborators,due_date,due_time,archived_at,scheduled,plan_today,dur,focus_min";
const PAGE = 1000;
const MAX_PAGES = 10;
const CHUNK = 100;

export const FEED_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, if-none-match",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "ETag",
};
// the URL carries a secret: don't let it leak onwards, and keep it out of indexes
const QUIET = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...FEED_CORS, ...QUIET, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

/** Missing table / function (0043 not run yet). */
export function isMissing(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return ["42P01", "42883", "PGRST202", "PGRST205"].includes(code) || /does not exist|schema cache/i.test(msg);
}

/** A strong ETag: the first 128 bits of the body's SHA-256, quoted. */
export async function etagOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `"${Array.from(new Uint8Array(digest)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** Does an If-None-Match header match this ETag? (weak comparison, as RFC 9110 asks for GET) */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (s: string) => s.trim().replace(/^W\//, "");
  return header.split(",").some((v) => v.trim() === "*" || bare(v) === bare(etag));
}

class FeedError extends Error {}

/** Every page of an rpc query (PostgREST caps a response at 1000 rows). */
async function allPages(make: () => any): Promise<FeedTaskRow[]> {
  const rows: FeedTaskRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await make().order("id").range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new FeedError(String(error.message ?? error));
    const got = (data ?? []) as FeedTaskRow[];
    rows.push(...got);
    if (got.length < PAGE) break;
  }
  return rows;
}

/** Load what the feed needs for one person. Throws FeedError on a database error. */
export async function loadFeedData(db: FeedDb, userId: string, today: string, days: number, includeDue: boolean) {
  const last = addIcsDays(today, days);

  // their own plan rows in the window (a missing table just means no rows)
  let states: FeedStateRow[] = [];
  {
    const { data, error } = await db.from("task_user_state")
      .select("task_id,scheduled,plan_today,plan_day")
      .eq("user_id", userId).eq("plan_today", true).not("scheduled", "is", null)
      .gte("plan_day", today).lte("plan_day", last)
      .limit(2000);
    if (error && !isMissing(error)) throw new FeedError(String(error.message ?? error));
    states = ((data ?? []) as FeedStateRow[]).filter((s) => s && typeof s.task_id === "string");
  }

  // open tasks they can see that might become events: their own plan for
  // today, and (when asked) anything due in the window
  const mineToday = `and(plan_today.eq.true,assignee_id.eq.${userId})`;
  const dueSoon = `and(due_date.gte.${today},due_date.lte.${last})`;
  const visible = () => db.rpc("tasks_visible_to", { p_user: userId }).select(TASK_COLS).neq("status", "done").is("archived_at", null);
  const tasks = await allPages(() => visible().or(includeDue ? `${mineToday},${dueSoon}` : mineToday));

  // plus the tasks behind their plan rows (still through tasks_visible_to, so a
  // row left over from a workspace they've left shows nothing)
  const have = new Set(tasks.map((t) => t.id));
  const extra = [...new Set(states.map((s) => s.task_id))].filter((id) => !have.has(id) && UUID.test(id));
  for (let i = 0; i < extra.length; i += CHUNK) {
    const { data, error } = await visible().in("id", extra.slice(i, i + CHUNK));
    if (error) throw new FeedError(String(error.message ?? error));
    for (const t of (data ?? []) as FeedTaskRow[]) if (!have.has(t.id)) { have.add(t.id); tasks.push(t); }
  }

  // their projects: names for "Task · Project", and which are archived (0039).
  // The app hides an archived project's tasks everywhere, so the feed must
  // too; not knowing is a database error (503), not a guess.
  const projectNames: Record<string, string> = {};
  const archivedProjects = new Set<string>();
  const pids = [...new Set(tasks.map((t) => t.project_id).filter((p): p is string => !!p && UUID.test(p)))];
  for (let i = 0; i < pids.length; i += CHUNK) {
    const { data, error } = await db.from("projects").select("id,name,archived_at").in("id", pids.slice(i, i + CHUNK));
    if (error) throw new FeedError(String(error.message ?? error));
    for (const p of (data ?? []) as { id: string; name: string | null; archived_at?: string | null }[]) {
      if (!p?.id) continue;
      if (p.name) projectNames[p.id] = p.name;
      if (p.archived_at) archivedProjects.add(p.id);
    }
  }
  return { tasks, states, projectNames, archivedProjects };
}

/** The whole request → response. Never throws. */
export async function handleFeedRequest(req: Request, deps: FeedDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: FEED_CORS });
  if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed", 405, { Allow: "GET, HEAD, OPTIONS" });
  const { db } = deps;
  const now = deps.now ?? new Date();
  const limit = deps.limit ?? ((key: string, w: Window) => hit(db, key, { ...w, now: now.getTime() }));
  const notFound = () => text("Calendar feed not found. Get your link again in Kanbo: Settings › Calendar & integrations.", 404);
  const busy = (retryAfter: number) => text("Too many requests for this calendar feed. Try again later.", 429, { "Retry-After": String(Math.max(1, retryAfter)) });
  const unavailable = () => text("Kanbo's calendar feed is unavailable right now. Your calendar will try again.", 503, { "Retry-After": "300" });

  try {
    const params = new URL(req.url).searchParams;
    // "is the function deployed?" (the Settings panel asks before offering a link)
    if (params.has("ping")) return new Response(null, { status: 204, headers: { ...FEED_CORS, ...QUIET, "Cache-Control": "no-store" } });
    const token = (params.get("t") ?? "").trim();
    if (!FEED_TOKEN_RE.test(token)) return notFound();

    const { data: row, error } = await db.from("calendar_feed_tokens").select("user_id,include_due").eq("token", token).maybeSingle();
    if (error) return isMissing(error) ? notFound() : unavailable();
    if (!row?.user_id) {
      // someone trying tokens: slow them down per IP (only misses count)
      const ip = clientIp(req.headers);
      if (ip) {
        const miss = await limit(`${KEY_PREFIX}ics-feed:miss:${await hashKey(ip)}`, { windowSec: 600, max: 30 });
        if (!miss.allowed) return busy(miss.retryAfter);
      }
      return notFound();
    }
    const userId = String(row.user_id);
    if (!UUID.test(userId)) return notFound();

    const per = await limit(`${KEY_PREFIX}ics-feed:${await hashKey(token)}`, { windowSec: 3600, max: 120 });
    if (!per.allowed) return busy(per.retryAfter);
    void sweep(db, now.getTime()).catch(() => {});

    const today = dayIn(FEED_TZ, now);
    const includeDue = row.include_due !== false;
    const { tasks, states, projectNames, archivedProjects } = await loadFeedData(db, userId, today, FEED_DAYS, includeDue);
    const events = feedEvents({ userId, tasks, states, projectNames, archivedProjects, today, days: FEED_DAYS, includeDue, appUrl: deps.appUrl });
    const body = buildIcs({
      name: "Kanbo",
      description: includeDue ? "Your Kanbo plan: planned work and due dates." : "Your Kanbo plan: planned work.",
      events,
      now: feedStamp(today),
      refreshMinutes: FEED_CACHE_SECONDS / 60,
      timezone: FEED_TZ,
    });
    const etag = await etagOf(body);
    const cache = { "Cache-Control": `private, max-age=${FEED_CACHE_SECONDS}`, ETag: etag };
    if (ifNoneMatchHits(req.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers: { ...FEED_CORS, ...QUIET, ...cache } });
    }
    return new Response(req.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        ...FEED_CORS, ...QUIET, ...cache,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="kanbo.ics"',
      },
    });
  } catch (e) {
    // never echo the URL or anything token-shaped (the token is the credential)
    const why = String((e as Error)?.message ?? e).replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 200);
    console.warn(`[ics-feed] ${e instanceof FeedError ? "database" : "unexpected"} error: ${why}`);
    return unavailable();
  }
}
