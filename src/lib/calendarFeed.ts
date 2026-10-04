/* ============================================================
   KANBO — "Add Kanbo to your calendar": a private ICS subscription feed. [f7-calendar]
   No new OAuth scopes: each person has an unguessable token (0043
   calendar_feed_tokens, server-generated) and their calendar app polls
   GET <SUPABASE_URL>/functions/v1/ics-feed?t=<token> (verify_jwt OFF).
   RPCs: calendar_feed() → { token, include_due, created_at } (made on first
   use); rotate_calendar_feed_token() → the same with a new token;
   include_due is a direct update of the caller's own row (RLS).
   Demo mode: an example URL and a note that it works once signed in.
   CONTRACT STUB — f7 replaces the bodies, keeps every exported name/signature.
   ============================================================ */
import type { CalendarFeed } from "../data/types";

/** The token the demo shows in its example URL. */
export const DEMO_FEED_TOKEN = "demo";

/** calendar_feed() JSON → CalendarFeed; null for anything malformed. */
export function parseCalendarFeed(raw: unknown): CalendarFeed | null {
  void raw;
  return null;
}

/** The signed-in person's feed (created on first call). Null in demo mode,
 *  signed out, or before 0043 is run. */
export async function getCalendarFeed(): Promise<CalendarFeed | null> {
  return null;
}

/** Include due dates as all-day events (or not). */
export async function setCalendarFeedIncludeDue(includeDue: boolean): Promise<CalendarFeed | null> {
  void includeDue;
  return null;
}

/** "Reset link": a new token; calendars using the old URL stop updating. */
export async function resetCalendarFeed(): Promise<CalendarFeed | null> {
  return null;
}

/** The https feed URL for a token (defaults to VITE_SUPABASE_URL). */
export function calendarFeedUrl(token: string, supabaseUrl?: string): string {
  const base = (supabaseUrl ?? (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "").replace(/\/+$/, "");
  return `${base}/functions/v1/ics-feed?t=${encodeURIComponent(token)}`;
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
