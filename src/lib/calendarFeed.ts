/* ============================================================
   KANBO — "Add Kanbo to your calendar": a private ICS subscription feed. [f7-calendar]
   No new OAuth scopes: each person has an unguessable token (0043
   calendar_feed_tokens, server-generated) and their calendar app polls
   GET <SUPABASE_URL>/functions/v1/ics-feed?t=<token> (verify_jwt OFF).
   RPCs: calendar_feed() → { token, include_due, created_at } (made on first
   use); rotate_calendar_feed_token() → the same with a new token;
   include_due is a direct update of the caller's own row (RLS).
   Demo mode: an example URL and a note that it works once signed in.

   loadCalendarFeed() says which state the panel is in (demo, ready,
   not switched on yet, signed out, or a passing error). "Ready" needs
   both halves: 0043's calendar_feed() and the deployed ics-feed function
   (asked once a session with GET ics-feed?ping=1, which answers 204 with
   no token and no database). They're set up separately, and a link to a
   function that isn't there is a 404 for Google and Outlook. The contract's
   getCalendarFeed() is the "feed or null" view of it. Changes
   (include due dates, reset) resolve the new feed, resolve null in demo
   mode or before 0043, and throw an Error whose message is a sentence
   for the person when the change didn't save.
   ============================================================ */
import type { CalendarFeed } from "../data/types";
import { isSupabaseConfigured, supabase } from "./supabase";

/** The token the demo shows in its example URL. */
export const DEMO_FEED_TOKEN = "demo";
/** The demo's stand-in for the project URL (there is no backend in demo mode). */
export const DEMO_FEED_BASE = "https://your-project.supabase.co";
/** What the calendar is called when it's added. */
export const FEED_CALENDAR_NAME = "Kanbo";

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export type CalendarFeedLoad =
  | { state: "demo" }
  | { state: "ready"; feed: CalendarFeed }
  /** 0043 isn't there yet, or the ics-feed function isn't deployed */
  | { state: "unavailable" }
  /** not signed in, or the account can't act (suspended / awaiting approval) */
  | { state: "signedOut" }
  /** offline or a passing server problem: try again */
  | { state: "error"; message: string };

/** calendar_feed() JSON → CalendarFeed; null for anything malformed. */
export function parseCalendarFeed(raw: unknown): CalendarFeed | null {
  let v = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  if (Array.isArray(v)) v = v[0];
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const token = typeof r.token === "string" ? r.token.trim() : "";
  if (!TOKEN_RE.test(token)) return null;
  const inc = r.include_due ?? r.includeDue;
  const created = r.created_at ?? r.createdAt;
  const feed: CalendarFeed = { token, includeDue: inc !== false };
  if (typeof created === "string" && created) feed.createdAt = created;
  return feed;
}

/* ---------- errors ---------- */

const errCode = (e: unknown) => String((e as { code?: string } | null)?.code ?? "");
const errMsg = (e: unknown) => String((e as { message?: string } | null)?.message ?? e ?? "");
const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** 0043 not run: the RPC or table isn't there. */
export function isFeedMissing(e: unknown): boolean {
  const code = errCode(e);
  const status = Number((e as { status?: number } | null)?.status ?? 0);
  return ["PGRST202", "PGRST205", "42P01", "42883"].includes(code) || status === 404
    || /does not exist|schema cache|could not find the function/i.test(errMsg(e));
}
const isNotAuthorized = (e: unknown) => /not authori[sz]ed|jwt|permission denied/i.test(errMsg(e)) || errCode(e) === "42501";
const isNetwork = (e: unknown) => e instanceof TypeError || /failed to fetch|network|load failed|fetch failed/i.test(errMsg(e));

const OFFLINE_MSG = "You're offline. Try again when you're back online.";
const SERVER_MSG = "Kanbo couldn't reach the server. Try again in a moment.";
const SIGNED_OUT_MSG = "Sign in again to manage your calendar link.";
const UNAVAILABLE_MSG = "Calendar links aren't switched on yet.";

/** An error whose message is already the sentence to show. */
class FeedError extends Error {}

function sentence(e: unknown): string {
  if (e instanceof FeedError) return e.message;
  if (offline() || isNetwork(e)) return OFFLINE_MSG;
  if (isNotAuthorized(e)) return SIGNED_OUT_MSG;
  if (isFeedMissing(e)) return UNAVAILABLE_MSG;
  return SERVER_MSG;
}

/* ---------- the signed-in person's feed (cached per account) ---------- */

let cache: { uid: string; feed: CalendarFeed } | null = null;
let missing = false; // 0043 answered "not there" this session
/** The ics-feed function's answer this session: deployed, or definitely not
 *  (404, or 401 = deployed with JWT checks on, which calendar apps can't pass).
 *  Anything else (a timeout, a network or CORS error, a 5xx) isn't kept. */
let fnChecked: "ok" | "missing" | null = null;
const PING_TIMEOUT_MS = 10_000;

async function currentUserId(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch { return null; }
}

/** Is the ics-feed function deployed and open to calendar apps? Asks like a
 *  calendar app does (no credentials, no auth header) and never throws. */
async function checkFeedFunction(refresh = false): Promise<"ok" | "missing" | "failed"> {
  if (fnChecked === "ok" || (fnChecked === "missing" && !refresh)) return fnChecked;
  const url = calendarFeedPingUrl();
  if (!/^https?:\/\//i.test(url) || typeof fetch !== "function") return "failed";
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), PING_TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: ctl?.signal });
    if (res.ok) return (fnChecked = "ok");
    if (res.status === 404 || res.status === 401) return (fnChecked = "missing");
    return "failed";
  } catch {
    return "failed"; // offline, timed out, or a 404 the gateway sent without CORS headers
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Forget the cached feed (e.g. on sign-out). */
export function clearCalendarFeedCache(): void { cache = null; missing = false; fnChecked = null; }

/** The panel's state: demo, ready (with the feed), not switched on yet,
 *  signed out, or a passing error. Never throws. Cached per account; pass
 *  `refresh` to ask the server again. */
export async function loadCalendarFeed(opts: { refresh?: boolean } = {}): Promise<CalendarFeedLoad> {
  if (!isSupabaseConfigured || !supabase) return { state: "demo" };
  const uid = await currentUserId();
  if (!uid) return { state: "signedOut" };
  if (!opts.refresh && cache?.uid === uid && fnChecked === "ok") return { state: "ready", feed: cache.feed };
  if (!opts.refresh && (missing || fnChecked === "missing")) return { state: "unavailable" };
  if (offline()) return { state: "error", message: OFFLINE_MSG };
  try {
    // both at once: the row (made on first use) and "is the function there?"
    const [{ data, error }, fn] = await Promise.all([supabase.rpc("calendar_feed"), checkFeedFunction(opts.refresh)]);
    if (error) throw error;
    missing = false;
    const feed = parseCalendarFeed(data);
    if (!feed) return { state: "error", message: SERVER_MSG };
    // a link that would 404 in Google or Outlook isn't offered
    if (fn !== "ok") return { state: "unavailable" };
    cache = { uid, feed };
    return { state: "ready", feed };
  } catch (e) {
    if (isFeedMissing(e)) { missing = true; return { state: "unavailable" }; }
    if (isNotAuthorized(e)) return { state: "signedOut" };
    return { state: "error", message: sentence(e) };
  }
}

/** The signed-in person's feed (created on first call). Null in demo mode,
 *  signed out, or before 0043 is run. */
export async function getCalendarFeed(): Promise<CalendarFeed | null> {
  const r = await loadCalendarFeed();
  return r.state === "ready" ? r.feed : null;
}

/** Include due dates as all-day events (or not). Resolves the feed as saved;
 *  null in demo mode or before 0043; throws Error(sentence) when it didn't save. */
export async function setCalendarFeedIncludeDue(includeDue: boolean): Promise<CalendarFeed | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const uid = await currentUserId();
  if (!uid) throw new FeedError(SIGNED_OUT_MSG);
  if (offline()) throw new FeedError(OFFLINE_MSG);
  const update = () => supabase!.from("calendar_feed_tokens")
    .update({ include_due: !!includeDue }).eq("user_id", uid)
    .select("token,include_due,created_at").maybeSingle();
  try {
    let { data, error } = await update();
    if (error) throw error;
    if (!data) {
      // no row yet (the panel normally makes it first): make it, then save
      const made = await supabase.rpc("calendar_feed");
      if (made.error) throw made.error;
      ({ data, error } = await update());
      if (error) throw error;
    }
    const feed = parseCalendarFeed(data);
    if (!feed) throw new FeedError(SERVER_MSG);
    cache = { uid, feed };
    return feed;
  } catch (e) {
    if (isFeedMissing(e)) { missing = true; return null; }
    throw new FeedError(sentence(e));
  }
}

/** "Reset link": a new token; calendars using the old URL stop updating.
 *  Null in demo mode or before 0043; throws Error(sentence) when it failed. */
export async function resetCalendarFeed(): Promise<CalendarFeed | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const uid = await currentUserId();
  if (!uid) throw new FeedError(SIGNED_OUT_MSG);
  if (offline()) throw new FeedError(OFFLINE_MSG);
  try {
    const { data, error } = await supabase.rpc("rotate_calendar_feed_token");
    if (error) throw error;
    const feed = parseCalendarFeed(data);
    if (!feed) throw new FeedError(SERVER_MSG);
    cache = { uid, feed };
    return feed;
  } catch (e) {
    if (isFeedMissing(e)) { missing = true; return null; }
    throw new FeedError(sentence(e));
  }
}

/* ---------- URLs ---------- */

/** The https feed URL for a token (defaults to VITE_SUPABASE_URL). */
export function calendarFeedUrl(token: string, supabaseUrl?: string): string {
  const base = (supabaseUrl ?? (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "").replace(/\/+$/, "");
  return `${base}/functions/v1/ics-feed?t=${encodeURIComponent(token)}`;
}

/** The function's "are you there?" URL: 204 when it's deployed (no token, no database). */
export function calendarFeedPingUrl(supabaseUrl?: string): string {
  const base = (supabaseUrl ?? (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "").replace(/\/+$/, "");
  return `${base}/functions/v1/ics-feed?ping=1`;
}

/** The example URL the demo shows. */
export function demoCalendarFeedUrl(): string {
  return calendarFeedUrl(DEMO_FEED_TOKEN, (import.meta.env.VITE_SUPABASE_URL as string | undefined) || DEMO_FEED_BASE);
}

/** https://… → webcal://… (what calendar apps subscribe to). */
export function webcalUrl(httpsUrl: string): string {
  return httpsUrl.replace(/^https?:\/\//i, "webcal://");
}

/** One-click Google Calendar subscribe link: https://calendar.google.com/calendar/r?cid=<webcal URL>. */
export function googleCalendarSubscribeUrl(feedUrl: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl(feedUrl))}`;
}

/** Outlook on the web "add from web" link (Outlook desktop: File › Account settings › Internet calendars). */
export function outlookSubscribeUrl(feedUrl: string, name = "Kanbo"): string {
  return `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(feedUrl)}&name=${encodeURIComponent(name)}`;
}

/** The same for work and school accounts (Microsoft 365, outlook.office.com). */
export function outlook365SubscribeUrl(feedUrl: string, name = "Kanbo"): string {
  return `https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(feedUrl)}&name=${encodeURIComponent(name)}`;
}
