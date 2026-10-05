// ============================================================
// KANBO — several calendar accounts, and a choice of calendars in each
// (0045). The pure parts of the `calendar` Edge Function: reading the
// providers' calendar lists, checking a selection, picking what to fetch,
// tagging and de-duplicating events, colours, timeouts.
//
// Pure module (no Deno globals, no remote imports) so vitest can exercise
// it directly: see calendars.test.ts and calendar.functions.test.ts.
// ============================================================

export type ProviderKey = "google" | "microsoft";

/** One calendar in a connected account, as the providers list them. */
export interface ProviderCalendar {
  id: string;
  name: string;
  /** "#rrggbb" */
  color: string;
  primary: boolean;
  /** owner · writer · reader · freeBusyReader */
  accessRole: string;
}

/** What `calendar_connections.selected_calendars` stores, per entry. */
export interface SelectedCalendar {
  id: string;
  name: string;
  color: string;
  primary: boolean;
}

/** One calendar to read events from ("primary" = the account's main one). */
export interface FetchTarget extends SelectedCalendar {}

/** Most calendars one account can show (the database checks it too). */
export const MAX_SELECTED = 25;
const MAX_ID = 1024;
const MAX_NAME = 200;

/** Distinct mid-tone colours, used when a provider gives none (or a clash).
 *  The app re-tones every calendar colour per theme, so these only need to
 *  be different hues. */
export const PALETTE = [
  "#3f7fe0", "#2e9d6a", "#e0663a", "#a35bc4", "#c98a1b",
  "#d14d72", "#1f9bb4", "#7a8b2e", "#8a6fdf", "#b5651d",
];

/** Outlook's named colours (calendar.color) when hexColor is empty. */
const MS_COLOURS: Record<string, string> = {
  lightBlue: "#4f8fe8", lightGreen: "#3fa45b", lightOrange: "#e3803a", lightGray: "#8a8f98",
  lightYellow: "#c9a21b", lightTeal: "#2a9fa6", lightPink: "#d45a93", lightBrown: "#9c6b3f",
  lightRed: "#d9534f",
};

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** "#abc" / "#AABBCC" → "#aabbcc"; anything else (names, rgb(), url(…)) → null. */
export function safeColour(c: unknown): string | null {
  if (typeof c !== "string") return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return "#" + (h.length === 3 ? h.split("").map((x) => x + x).join("") : h);
}

/** The same account address (any case, stray spaces ignored). An empty address
 *  never matches anything, not even another empty one: "we don't know who this
 *  is" must never pick out an existing account. */
export const sameEmail = (a: unknown, b: unknown): boolean => {
  const x = String(a ?? "").trim().toLowerCase();
  return x !== "" && x === String(b ?? "").trim().toLowerCase();
};

/** An account address fit to store: trimmed, at most 320 characters, "" if none. */
export const cleanIdentity = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, 320) : "");

/** Who the person signed in as, from the id_token the token endpoint returns
 *  alongside the access token (we ask for `openid email`): the `email` claim,
 *  and Microsoft's `preferred_username` (its sign-in name, usually an address).
 *  The token came straight from the provider over TLS in the code exchange, so
 *  its signature needn't be checked (OpenID Connect Core 3.1.3.7). "" for
 *  anything missing or malformed. */
export function idTokenIdentity(idToken: unknown): { email: string; username: string } {
  const none = { email: "", username: "" };
  if (typeof idToken !== "string") return none;
  const part = idToken.split(".")[1];
  if (!part || part.length > 16_384) return none;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (!claims || typeof claims !== "object") return none;
    return { email: cleanIdentity(claims.email), username: cleanIdentity(claims.preferred_username) };
  } catch {
    return none;
  }
}

export const isUuid = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Google calendarList.items → calendars (primary first, then by name). */
export function normaliseGoogleCalendars(items: unknown): ProviderCalendar[] {
  const out: ProviderCalendar[] = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const c = raw as Record<string, unknown>;
    const id = str(c?.id, MAX_ID);
    if (!id || c.deleted === true) continue;
    out.push({
      id,
      name: str(c.summaryOverride, MAX_NAME) || str(c.summary, MAX_NAME) || id.slice(0, MAX_NAME),
      color: safeColour(c.backgroundColor) ?? "",
      primary: c.primary === true,
      accessRole: str(c.accessRole, 40) || "reader",
    });
  }
  return order(out);
}

/** Microsoft Graph /me/calendars value → calendars (the default first). */
export function normaliseMicrosoftCalendars(items: unknown, accountEmail = ""): ProviderCalendar[] {
  const out: ProviderCalendar[] = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const c = raw as Record<string, unknown>;
    const id = str(c?.id, MAX_ID);
    if (!id) continue;
    const owner = (c.owner as Record<string, unknown> | undefined)?.address;
    const mine = c.isDefaultCalendar === true || !owner || sameEmail(owner, accountEmail);
    out.push({
      id,
      name: str(c.name, MAX_NAME) || "Calendar",
      color: safeColour(c.hexColor) ?? MS_COLOURS[String(c.color ?? "")] ?? "",
      primary: c.isDefaultCalendar === true,
      accessRole: mine ? "owner" : c.canEdit === true ? "writer" : "reader",
    });
  }
  return order(out);
}

function order(list: ProviderCalendar[]): ProviderCalendar[] {
  return list.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "en-GB"));
}

/** Give every calendar a colour no other one already has: a calendar keeps its
 *  own colour unless it's missing or taken (by an earlier one in the list or
 *  by `taken`, e.g. another account's calendars), then it gets the first free
 *  palette colour. Order matters: earlier calendars keep theirs. */
export function distinctColours<T extends { color: string }>(cals: T[], taken: Iterable<string> = []): T[] {
  const used = new Set<string>();
  for (const t of taken) { const c = safeColour(t); if (c) used.add(c); }
  return cals.map((cal, i) => {
    let c = safeColour(cal.color);
    if (!c || used.has(c)) c = PALETTE.find((p) => !used.has(p)) ?? PALETTE[i % PALETTE.length];
    used.add(c);
    return c === cal.color ? cal : { ...cal, color: c };
  });
}

/** selected_calendars as stored (NULL = primary only). Tolerant: bad entries are dropped. */
export function parseSelected(raw: unknown): SelectedCalendar[] | null {
  if (raw == null) return null;
  let v = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  if (!Array.isArray(v)) return null;
  const out: SelectedCalendar[] = [];
  const seen = new Set<string>();
  for (const e of v) {
    const id = str((e as Record<string, unknown>)?.id, MAX_ID);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const o = e as Record<string, unknown>;
    out.push({ id, name: str(o.name, MAX_NAME) || id.slice(0, MAX_NAME), color: safeColour(o.color) ?? "", primary: o.primary === true });
    if (out.length >= MAX_SELECTED) break;
  }
  return out;
}

/** The account's calendars with the colours Kanbo shows them in: the saved
 *  colour for the ones already chosen, a free one for the rest (never one a
 *  calendar in another account, or an earlier one here, already uses). */
export function paintCalendars(list: ProviderCalendar[], selected: SelectedCalendar[] | null, takenElsewhere: Iterable<string> = []): ProviderCalendar[] {
  const saved = new Map((selected ?? []).map((s) => [s.id, safeColour(s.color)]));
  const keep = new Set<string>([...takenElsewhere].map((c) => safeColour(c)).filter((c): c is string => !!c));
  // chosen calendars keep their saved colour (events are already tagged with it)
  const fixed = list.map((c) => ({ ...c, color: saved.get(c.id) ?? c.color }));
  for (const c of fixed) if (saved.get(c.id)) keep.add(saved.get(c.id)!);
  const free = distinctColours(fixed.filter((c) => !saved.get(c.id)), keep);
  const byId = new Map(free.map((c) => [c.id, c]));
  return fixed.map((c) => byId.get(c.id) ?? c);
}

/** The selection an account on "primary only" (NULL) gets saved as: its
 *  primary calendar, in exactly the colour the calendar list (paintCalendars,
 *  with the same other accounts' colours) shows it in. null if the account
 *  marks no calendar as primary. */
export function primarySelection(list: ProviderCalendar[], takenElsewhere: Iterable<string> = []): SelectedCalendar[] | null {
  const painted = paintCalendars(list, null, takenElsewhere);
  const primary = painted.find((c) => c.primary);
  return primary ? selectionFrom([primary.id], painted) : null;
}

/** The one colour each account still on "primary only" (NULL, not saved yet)
 *  is shown in, everywhere: on its events and as its primary's swatch in the
 *  calendar list. A palette colour no saved calendar and no earlier such
 *  account uses, in account order (oldest first). Only used until the
 *  account's primary is saved (primarySelection), which is normally the first
 *  time the app lists the accounts after 0045. */
export function unsavedPrimaryColours(rows: { id: string; selected_calendars?: unknown }[]): Map<string, string> {
  const used = rows.flatMap((r) => (parseSelected(r.selected_calendars) ?? []).map((s) => s.color));
  const out = new Map<string, string>();
  for (const r of rows) {
    if (parseSelected(r.selected_calendars) !== null) continue;
    const c = distinctColours([{ color: "" }], used)[0].color;
    used.push(c);
    out.set(r.id, c);
  }
  return out;
}

/** Check a requested selection against the account's real calendars. */
export function validateSelection(ids: unknown, available: ProviderCalendar[]):
  { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(ids)) return { ok: false, error: "calendarIds must be a list" };
  const clean: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_ID) return { ok: false, error: "That isn't a calendar id." };
    if (!clean.includes(raw)) clean.push(raw);
  }
  if (clean.length > MAX_SELECTED) return { ok: false, error: `Choose up to ${MAX_SELECTED} calendars per account.` };
  const known = new Set(available.map((c) => c.id));
  if (clean.some((id) => !known.has(id))) {
    return { ok: false, error: "One of those calendars isn't in this account any more. Reopen the list and try again." };
  }
  return { ok: true, ids: clean };
}

/** The selection to store, in the account's own order, with Kanbo's colours. */
export function selectionFrom(ids: string[], painted: ProviderCalendar[]): SelectedCalendar[] {
  const want = new Set(ids);
  return painted.filter((c) => want.has(c.id)).map(({ id, name, color, primary }) => ({ id, name, color, primary }));
}

/** What to read for one connection: its chosen calendars, or (NULL) just the primary. */
export function fetchTargets(selected: SelectedCalendar[] | null, fallback: { name: string; color: string }): FetchTarget[] {
  if (selected === null) return [{ id: "primary", name: fallback.name, color: fallback.color, primary: true }];
  return selected.map((s) => ({ ...s, color: safeColour(s.color) ?? fallback.color }));
}

/** A short, stable tag for a calendar id (ids can be long e-mail-like strings). */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** An event id unique across accounts and calendars (the same meeting can sit in several). */
export function eventId(p: ProviderKey, connectionId: string, calendarId: string, rawId: string): string {
  return `${p === "google" ? "g" : "m"}-${connectionId.slice(0, 8)}-${shortHash(calendarId)}-${rawId}`;
}

/** One meeting in two chosen calendars (a work invite copied to a personal
 *  calendar, a shared team calendar) shows once: the first copy wins, so
 *  order the input primary-first. Events without an iCal UID are kept. */
export function dedupeEvents<T extends { uid?: string | null; start: string }>(events: T[]): T[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (!e.uid) return true;
    const k = `${e.uid}|${new Date(e.start).getTime() || e.start}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export class TimeoutError extends Error {
  constructor(ms: number) { super(`timed out after ${ms}ms`); this.name = "TimeoutError"; }
}

/** Run `fn` with an AbortSignal that fires after `ms`; rejects with TimeoutError then. */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new TimeoutError(ms)); ctl.abort(); }, ms);
  });
  try {
    return await Promise.race([fn(ctl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Promise.allSettled with at most `limit` running at once, results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await fn(items[i], i) }; }
      catch (reason) { out[i] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const DAY = 86_400_000;
/** The events window: valid ISO dates, end after start, at most 100 days. */
export function clampWindow(startRaw: string | null, endRaw: string | null, now = Date.now()): { start: string; end: string } {
  const s = startRaw ? Date.parse(startRaw) : NaN;
  const start = Number.isFinite(s) ? s : now;
  const e = endRaw ? Date.parse(endRaw) : NaN;
  let end = Number.isFinite(e) && e > start ? e : start + 31 * DAY;
  if (end - start > 100 * DAY) end = start + 100 * DAY;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** Did a query fail because 0045's column isn't there yet? */
export function missingSelectionColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42703" || err.code === "PGRST204" || /selected_calendars/i.test(err.message ?? "");
}
