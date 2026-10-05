/* ============================================================
   KANBO — connected calendars on the client: which calendar an event
   came from, the legend Month shows (one entry per calendar shown, in
   its own colour), the per-device "hide this calendar for now" set,
   and the words Settings uses. Pure, so it's unit-tested directly.
   ============================================================ */
import type { CalendarConnection, CalendarWarning, CalProvider, ExternalEvent } from "../data/types";

export const PROVIDER_LABEL: Record<CalProvider, string> = { google: "Google", microsoft: "Outlook" };
/** used only when an event carries no colour (a server from before several accounts) */
const PROVIDER_COLOUR: Record<string, string> = { google: "#3f7fe0", microsoft: "#c98a1b" };
const FALLBACK = "#6b7a90";

/** One calendar, across accounts: "<connection id>|<calendar id>" ("primary" for the main one). */
export const calendarKey = (connectionId: string, calendarId: string) => `${connectionId}|${calendarId}`;
/** The calendar an event came from (old servers send neither id: provider + primary). */
export const eventCalendarKey = (e: Pick<ExternalEvent, "connectionId" | "calendarId" | "provider">) =>
  calendarKey(e.connectionId ?? e.provider, e.calendarId ?? "primary");

/** An event's colour: its calendar's, else its provider's. Always a plain hex. */
export function eventColour(e: Pick<ExternalEvent, "color" | "provider">): string {
  return e.color && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : PROVIDER_COLOUR[e.provider] ?? FALLBACK;
}

export interface LegendEntry {
  key: string;
  name: string;
  color: string;
  provider: CalProvider | string;
  accountEmail: string;
}

/** One entry per calendar shown: every account's chosen calendars (or its primary), in
 *  account order, plus any calendar the events mention that the list doesn't (older servers). */
export function calendarLegend(connections: CalendarConnection[], events: ExternalEvent[]): LegendEntry[] {
  const firstEvent = new Map<string, ExternalEvent>();
  for (const e of events) { const k = eventCalendarKey(e); if (!firstEvent.has(k)) firstEvent.set(k, e); }
  const out: LegendEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: LegendEntry) => { if (!seen.has(entry.key)) { seen.add(entry.key); out.push(entry); } };
  for (const c of connections) {
    if (c.selectedCalendars) {
      for (const cal of c.selectedCalendars) {
        const key = calendarKey(c.id, cal.id);
        const ev = firstEvent.get(key);
        add({ key, name: cal.name, color: cal.color || (ev ? eventColour(ev) : PROVIDER_COLOUR[c.provider] ?? FALLBACK), provider: c.provider, accountEmail: c.accountEmail });
      }
    } else {
      const key = calendarKey(c.id, "primary");
      const ev = firstEvent.get(key);
      add({ key, name: ev?.calendarName || c.accountEmail || `${PROVIDER_LABEL[c.provider]} calendar`, color: ev ? eventColour(ev) : PROVIDER_COLOUR[c.provider] ?? FALLBACK, provider: c.provider, accountEmail: c.accountEmail });
    }
  }
  for (const [key, e] of firstEvent) {
    add({ key, name: e.calendarName || `${PROVIDER_LABEL[e.provider as CalProvider] ?? "Calendar"}`, color: eventColour(e), provider: e.provider, accountEmail: "" });
  }
  return out;
}

/** "Main calendar shown" · "3 calendars shown" · "No calendars shown" */
export function shownSummary(c: Pick<CalendarConnection, "selectedCalendars">): string {
  const n = c.selectedCalendars?.length;
  if (n === undefined) return "Main calendar shown";
  if (n === 0) return "No calendars shown";
  return `${n} calendar${n === 1 ? "" : "s"} shown`;
}

/** What Settings says about a calendar or account the last sync couldn't read. */
export function warningText(w: CalendarWarning): string {
  if (w.reason === "reconnect") return "Kanbo can no longer read this account. Disconnect it and add it again.";
  if (w.reason === "timeout") return `${w.calendarName ? `“${w.calendarName}”` : "This account"} took too long to load. Kanbo will try again.`;
  return `Couldn't load ${w.calendarName ? `“${w.calendarName}”` : "this account"} just now. Kanbo will try again.`;
}

/* ---- Month: calendars hidden on this device ("hide for now") ---- */
export const HIDDEN_CALENDARS_KEY = "kanbo-cal-hidden";

export function loadHiddenCalendars(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_CALENDARS_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string").slice(0, 200) : []);
  } catch { return new Set(); }
}

export function saveHiddenCalendars(keys: Set<string>): void {
  try {
    if (keys.size) localStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify([...keys]));
    else localStorage.removeItem(HIDDEN_CALENDARS_KEY);
  } catch { /* private mode: it lasts for this visit */ }
}
