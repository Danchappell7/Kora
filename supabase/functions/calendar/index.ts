// ============================================================
// KANBO — external calendar integration (Google + Microsoft)
// One function, action-routed. Keeps OAuth client secrets and every token
// server-side: the app only ever sees a connection's id, provider, account
// email and calendar list/selection.
//
// Several accounts per person (a work Google, a personal Google and an
// Outlook, say), and inside each account a choice of calendars (0045).
//
//   GET  /calendar?action=connect&provider=google|microsoft[&finish=app] (JWT) -> { url }
//        (always shows the provider's account chooser, so a second account
//         of the same provider can be added)
//   GET  /calendar/callback?code=..&state=..                   (open) -> 302 to app
//   GET  /calendar?action=finish&state=..&code=..              (JWT)  -> { ok, provider, accountEmail, connectionId, replaced }
//   GET  /calendar?action=list                                 (JWT)  -> { connections: [{ id, provider, accountEmail, selectedCalendars }], multi }
//   GET  /calendar?action=calendars&connection=<id>            (JWT)  -> { calendars: [{ id, name, color, primary, accessRole, selected }], selectedCalendars }
//   POST /calendar  { action:"select", connection, calendarIds } (JWT) -> { ok, selectedCalendars }
//   GET  /calendar?action=events&start=ISO&end=ISO             (JWT)  -> { events, warnings }
//   POST /calendar  { action:"disconnect", connection }        (JWT)  -> { ok }
//        (or ?action=disconnect&connection=<id>; `provider` alone, the old
//         way, disconnects every account of that provider)
//
// selected_calendars NULL means "the primary calendar only" (every connection
// made before 0045). action=list saves that as [the primary] the first time
// (adoptPrimaries), so the colour Settings shows and the colour its events
// carry are one saved value that never shifts; until then both use
// unsavedPrimaryColours. Until 0045 is run the function still works: one account
// per provider (a second one replaces the first, as before), the primary
// calendar only, and action=select says the database needs updating.
//
// Two ways to finish the OAuth handshake:
//   • app finish (connect sent `finish=app`): the callback doesn't touch the
//     code; it bounces to APP_URL/?calendar=finish&calendar_state=..&
//     calendar_code=.., and the app — signed in as whoever actually approved
//     on Google/Microsoft — calls action=finish with its own JWT, which must
//     match the user who started the flow. This closes a hole where someone
//     starts "connect", sends the consent link to a colleague, and gets the
//     colleague's calendar saved on their own account.
//   • legacy (no `finish=app`, i.e. an app that predates action=finish): the
//     callback swaps the code itself and saves it for whoever started the
//     flow, then 302s to ?calendar=connected — exactly the old behaviour, so
//     deploying this never breaks a live app. Once the app sends finish=app,
//     set the secret CALENDAR_APP_FINISH_ONLY=true to switch legacy off.
// Either way states are single-use and expire after 10 minutes.
//
// Deploy:  supabase functions deploy calendar --no-verify-jwt
//   (we verify the JWT ourselves for the authed actions; the OAuth callback
//    is reached by the provider's redirect and carries no JWT.)
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//          MS_CLIENT_ID, MS_CLIENT_SECRET, APP_URL
//          optional: CALENDAR_APP_FINISH_ONLY=true (see above)
// Scopes stay read-only: Google calendar.readonly also lists the account's
// calendars; Microsoft Calendars.Read covers /me/calendars. Microsoft also
// asks for User.Read (already in the Azure app's permissions, CALENDAR_SETUP.md)
// so /me can name the account when the id_token doesn't, and for the standard
// sign-in scope `profile`, which puts the sign-in name in the id_token.
//
// Which account was connected comes from the id_token the code exchange
// returns (its email claim), then the provider's profile call. If neither
// names the account, nothing is saved: an unnamed account must never be
// taken for (and overwrite) one already connected.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  clampWindow, cleanIdentity, dedupeEvents, eventId, fetchTargets, idTokenIdentity, isUuid, mapLimit, missingSelectionColumn,
  normaliseGoogleCalendars, normaliseMicrosoftCalendars, paintCalendars, PALETTE, parseSelected, primarySelection, sameEmail,
  selectionFrom, TimeoutError, unsavedPrimaryColours, validateSelection, withTimeout,
  type FetchTarget, type ProviderCalendar, type ProviderKey, type SelectedCalendar,
} from "../_shared/calendars.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_URL = (Deno.env.get("APP_URL") || "https://www.kanbo.co.uk").replace(/\/+$/, "");
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/calendar/callback`;
const STATE_TTL_MS = 10 * 60 * 1000;
/** state prefix for handshakes the app will finish itself (action=finish) */
const APP_FINISH = "app.";
const APP_FINISH_ONLY = /^(1|true|yes|on)$/i.test(Deno.env.get("CALENDAR_APP_FINISH_ONLY") ?? "");
/** one provider call (a calendar's events, a calendar list, a token refresh) */
const CALL_MS = 8_000;
/** provider calls in flight at once for one events request */
const PARALLEL = 6;
/** calendars read per events request, across all accounts */
const MAX_TARGETS = 60;
/** reading one not-yet-saved account's calendars while listing accounts (adoptPrimaries) */
const ADOPT_MS = 5_000;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

// ---- provider config ---------------------------------------------------
const PROVIDERS = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/calendar.readonly",
    clientId: () => Deno.env.get("GOOGLE_CLIENT_ID") || "",
    clientSecret: () => Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
    // select_account: always ask which Google account (so a second one can be
    // added); consent: always hand back a refresh token
    extraAuth: { access_type: "offline", prompt: "select_account consent" },
    label: "Google Calendar",
  },
  microsoft: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // profile: the id_token also carries the sign-in name (preferred_username);
    // User.Read: /me, to name the account when the id_token has no email
    scope: "openid email profile offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read",
    clientId: () => Deno.env.get("MS_CLIENT_ID") || "",
    clientSecret: () => Deno.env.get("MS_CLIENT_SECRET") || "",
    extraAuth: { prompt: "select_account" },
    label: "Outlook",
  },
} as const;

type Conn = Record<string, unknown> & { id: string; provider: ProviderKey; account_email?: string | null };

/** Why one account or calendar couldn't be read (the others still are). */
type WarningReason = "reconnect" | "unavailable" | "timeout";
class ProviderError extends Error {
  constructor(public reason: WarningReason, message: string) { super(message); this.name = "ProviderError"; }
}
const whyFailed = (e: unknown): WarningReason =>
  e instanceof ProviderError ? e.reason : e instanceof TimeoutError ? "timeout" : "unavailable";

/** What the token endpoint returns (the id_token when `openid` was asked for). */
type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string };

// identify the caller from their JWT (functions deploy with --no-verify-jwt)
async function getUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return null;
  const supa = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data } = await supa.auth.getUser();
  return data?.user ?? null;
}

// exchange an auth code (or refresh token) for tokens
async function exchangeToken(p: ProviderKey, params: Record<string, string>) {
  const cfg = PROVIDERS[p];
  const body = new URLSearchParams({
    client_id: cfg.clientId(), client_secret: cfg.clientSecret(), ...params,
  });
  const r = await withTimeout((signal) => fetch(cfg.tokenUrl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal,
  }), CALL_MS);
  // (the body can echo the code or refresh token: never put it in the error)
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new ProviderError(r.status === 400 || r.status === 401 ? "reconnect" : "unavailable", `${p} token exchange failed: ${r.status}`); }
  return await r.json() as TokenResponse;
}

// ensure a connection has a fresh access token; refresh in place if expired
async function freshToken(conn: Conn): Promise<string> {
  const expISO = conn.expires_at as string | null;
  const notExpired = expISO && new Date(expISO).getTime() - Date.now() > 60_000;
  if (notExpired) return conn.access_token as string;
  if (!conn.refresh_token) return conn.access_token as string; // best effort
  const tok = await exchangeToken(conn.provider, { grant_type: "refresh_token", refresh_token: conn.refresh_token as string });
  const expires_at = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
  await admin.from("calendar_connections").update({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? conn.refresh_token, // Google omits on refresh
    expires_at, updated_at: new Date().toISOString(),
  }).eq("id", conn.id);
  conn.access_token = tok.access_token; conn.expires_at = expires_at;
  await learnAddress(conn, tok);
  return tok.access_token;
}

/** A connection saved without its address (when the old function's profile
 *  call failed) learns it from the id_token a token refresh returns, so the
 *  same account added again is recognised rather than added twice. Best
 *  effort: if that account is already connected again under its address, the
 *  unique index refuses and the row stays as it is. */
async function learnAddress(conn: Conn, tok: TokenResponse) {
  if (cleanIdentity(conn.account_email)) return;
  const who = idTokenIdentity(tok.id_token);
  const email = who.email || (conn.provider === "microsoft" ? who.username : "");
  if (!email) return;
  const { error } = await admin.from("calendar_connections").update({ account_email: email }).eq("id", conn.id);
  if (!error) conn.account_email = email;
}

/** GET a provider API with the account's token, under a timeout. */
async function providerGet(url: URL | string, token: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await withTimeout((signal) => fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal }), CALL_MS);
  } catch (e) {
    if (e instanceof TimeoutError) throw new ProviderError("timeout", "provider timed out");
    throw new ProviderError("unavailable", "provider unreachable");
  }
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    throw new ProviderError(r.status === 401 ? "reconnect" : "unavailable", `provider ${r.status}`);
  }
  return await r.json();
}

/** Every calendar in a connected account. */
async function listProviderCalendars(conn: Conn, token: string): Promise<ProviderCalendar[]> {
  if (conn.provider === "google") {
    const u = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    u.searchParams.set("maxResults", "250");
    const data = await providerGet(u, token);
    return normaliseGoogleCalendars(data.items);
  }
  const u = new URL("https://graph.microsoft.com/v1.0/me/calendars");
  u.searchParams.set("$top", "100");
  u.searchParams.set("$select", "id,name,color,hexColor,isDefaultCalendar,canEdit,owner");
  const data = await providerGet(u, token);
  return normaliseMicrosoftCalendars(data.value, String(conn.account_email ?? ""));
}

interface ExtEvent {
  id: string; title: string; start: string; end: string; allDay: boolean; provider: string;
  connectionId: string; calendarId: string; calendarName: string; color: string;
  /** the iCal UID, for de-duplication (not sent to the app) */
  uid?: string | null;
}

/** One calendar's events in [startISO, endISO), tagged with where they came from. */
async function fetchCalendarEvents(conn: Conn, token: string, cal: FetchTarget, startISO: string, endISO: string): Promise<ExtEvent[]> {
  const tag = { connectionId: conn.id, calendarId: cal.id, calendarName: cal.name, color: cal.color };
  if (conn.provider === "google") {
    const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`);
    u.searchParams.set("timeMin", startISO); u.searchParams.set("timeMax", endISO);
    u.searchParams.set("singleEvents", "true"); u.searchParams.set("orderBy", "startTime");
    u.searchParams.set("maxResults", "250");
    const data = await providerGet(u, token);
    return ((data.items ?? []) as Record<string, any>[]).filter((e) => e.status !== "cancelled").map((e) => ({
      id: eventId("google", conn.id, cal.id, String(e.id)), title: e.summary || "(no title)",
      start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
      allDay: !e.start?.dateTime, provider: "google", uid: e.iCalUID ?? null, ...tag,
    })).filter((e) => e.start && e.end);
  }
  const u = new URL(cal.id === "primary"
    ? "https://graph.microsoft.com/v1.0/me/calendarview"
    : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(cal.id)}/calendarView`);
  u.searchParams.set("startDateTime", startISO); u.searchParams.set("endDateTime", endISO);
  u.searchParams.set("$top", "250"); u.searchParams.set("$orderby", "start/dateTime");
  const data = await providerGet(u, token, { Prefer: 'outlook.timezone="UTC"' });
  return ((data.value ?? []) as Record<string, any>[]).filter((e) => !e.isCancelled).map((e) => ({
    id: eventId("microsoft", conn.id, cal.id, String(e.id)), title: e.subject || "(no title)",
    start: e.start?.dateTime ? `${e.start.dateTime}Z`.replace("ZZ", "Z") : "",
    end: e.end?.dateTime ? `${e.end.dateTime}Z`.replace("ZZ", "Z") : "",
    allDay: !!e.isAllDay, provider: "microsoft", uid: e.iCalUId ?? null, ...tag,
  })).filter((e) => e.start && e.end);
}

/** The person's connections, oldest first. `multi` is false until 0045 adds
 *  selected_calendars (then every selection reads as NULL: primary only). */
async function loadConnections(userId: string, cols: string): Promise<{ rows: Conn[]; multi: boolean }> {
  const q = (c: string) => admin.from("calendar_connections").select(c).eq("user_id", userId).order("created_at", { ascending: true });
  if (cols === "*") {
    // every column there is (selected_calendars too, once 0045 has added it)
    const all = await q("*");
    if (all.error) throw new Error(`calendar_connections: ${all.error.message}`);
    const rows = (all.data ?? []) as unknown as Conn[];
    return { rows, multi: rows.length ? "selected_calendars" in rows[0] : true };
  }
  const first = await q(`${cols}, selected_calendars`);
  if (!first.error) return { rows: (first.data ?? []) as unknown as Conn[], multi: true };
  if (!missingSelectionColumn(first.error)) throw new Error(`calendar_connections: ${first.error.message}`);
  const again = await q(cols);
  if (again.error) throw new Error(`calendar_connections: ${again.error.message}`);
  return { rows: (again.data ?? []) as unknown as Conn[], multi: false };
}

/** One of the caller's connections (never someone else's). */
async function ownConnection(userId: string, id: unknown): Promise<Conn | null> {
  if (!isUuid(id)) return null;
  const { data } = await admin.from("calendar_connections").select("*").eq("user_id", userId).eq("id", id).maybeSingle();
  return (data as Conn | null) ?? null;
}

/** Colours already shown for the person's OTHER accounts (so a new choice
 *  doesn't clash): their saved calendars, and the colour of any still on
 *  "primary only" that isn't saved yet. */
function coloursElsewhere(rows: Conn[], exceptId: string): string[] {
  const unsaved = unsavedPrimaryColours(rows);
  return rows.filter((r) => r.id !== exceptId)
    .flatMap((r) => (parseSelected(r.selected_calendars) ?? []).map((s) => s.color).concat(unsaved.get(r.id) ?? []));
}

/** An account's calendars in the colours Kanbo shows them in: the saved colour
 *  for each chosen one; for an account still on "primary only" (NULL), its
 *  primary in the same colour its events carry (unsavedPrimaryColours); the
 *  rest in colours nothing else uses. `calendars` and `select` both use this,
 *  so a swatch, the colour saved for it and its events always agree. */
function painting(list: ProviderCalendar[], selected: SelectedCalendar[] | null, rows: Conn[], connId: string): ProviderCalendar[] {
  const elsewhere = coloursElsewhere(rows, connId);
  if (selected !== null) return paintCalendars(list, selected, elsewhere);
  const primary = list.find((c) => c.primary);
  const colour = unsavedPrimaryColours(rows).get(connId);
  return paintCalendars(list, primary && colour ? [{ id: primary.id, name: primary.name, color: colour, primary: true }] : null, elsewhere);
}

const providerFail = (e: unknown, who: string) => {
  const reason = whyFailed(e);
  return reason === "reconnect"
    ? json({ error: `Kanbo can't read ${who} any more. Disconnect it and add it again.`, reason }, 409)
    : json({ error: `Couldn't reach ${who} just now. Try again in a moment.`, reason }, 502);
};

/** Which account the person approved: the id_token's email claim (no extra
 *  call), else the provider's profile (Google userinfo; Microsoft /me, which
 *  needs User.Read), else Microsoft's sign-in name from the id_token. "" when
 *  nothing names it: the caller then refuses rather than guess. */
async function whoConnected(p: ProviderKey, tok: TokenResponse): Promise<string> {
  const fromToken = idTokenIdentity(tok.id_token);
  if (fromToken.email) return fromToken.email;
  try {
    if (p === "google") {
      const ui = await providerGet("https://www.googleapis.com/oauth2/v2/userinfo", tok.access_token);
      const email = cleanIdentity(ui.email);
      if (email) return email;
    } else {
      const me = await providerGet("https://graph.microsoft.com/v1.0/me", tok.access_token);
      const email = cleanIdentity(me.mail) || cleanIdentity(me.userPrincipalName);
      if (email) return email;
    }
  } catch (e) {
    console.warn("calendar: couldn't read the connected account's address", p, whyFailed(e));
  }
  return p === "microsoft" ? fromToken.username : "";
}

type AccountRow = { id: string; account_email?: string | null; refresh_token?: unknown };

// swap an OAuth code for tokens and save the connection for `userId`: one
// row per account (user, provider, account email). The same account again
// refreshes its tokens and keeps its calendar choice. An account nothing
// names is refused, never matched to (and saved over) another one.
async function saveConnection(userId: string, p: ProviderKey, code: string):
  Promise<{ ok: true; email: string; id: string | null; replaced: boolean } | { ok: false; status: number; error: string }> {
  let tok: TokenResponse;
  try {
    tok = await exchangeToken(p, { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
  } catch (e) {
    console.error("calendar: token exchange failed", e instanceof Error ? e.message : "error");
    return { ok: false, status: 502, error: "Couldn't finish connecting that calendar. Please try again." };
  }
  const email = await whoConnected(p, tok);
  if (!email) {
    console.error("calendar: the connected account has no address; not saved", p);
    return { ok: false, status: 502, error: `Couldn't tell which ${p === "microsoft" ? "Outlook" : "Google"} account that was, so it wasn't connected. Please try again.` };
  }
  const now = new Date().toISOString();
  const expires_at = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
  const fresh = { access_token: tok.access_token, expires_at, scope: tok.scope ?? PROVIDERS[p].scope, updated_at: now };

  // new tokens onto a row; `accountEmail` is what the row is called from now on
  const refresh = async (row: AccountRow, accountEmail: string) => {
    const { error } = await admin.from("calendar_connections").update({
      ...fresh, account_email: accountEmail, refresh_token: tok.refresh_token ?? row.refresh_token ?? null,
    }).eq("id", row.id);
    if (error) throw new Error(error.message);
  };
  try {
    const { data, error } = await admin.from("calendar_connections").select("id, account_email, refresh_token").eq("user_id", userId).eq("provider", p);
    if (error) throw new Error(error.message);
    const mine = ((data ?? []) as AccountRow[]).find((r) => sameEmail(r.account_email, email));
    if (mine) { await refresh(mine, cleanIdentity(mine.account_email) || email); return { ok: true, email, id: mine.id, replaced: false }; }
    const ins = await admin.from("calendar_connections").insert({
      user_id: userId, provider: p, account_email: email, refresh_token: tok.refresh_token ?? null, created_at: now, ...fresh,
    }).select("id").single();
    if (!ins.error) {
      const id = (ins.data as { id: string } | null)?.id ?? null;
      if (id) await startWithPrimary(userId);
      return { ok: true, email, id, replaced: false };
    }
    if (ins.error.code !== "23505") throw new Error(ins.error.message);
    // a duplicate: the same account finishing twice at once (it's there now),
    // or a database before 0045, where the rule is one account per provider
    // and the new one replaces the old, as before. With 0045 a different
    // account is never replaced.
    const { rows: all, multi } = await loadConnections(userId, "id, provider, account_email, refresh_token");
    const rows = all.filter((r) => r.provider === p) as AccountRow[];
    const same = rows.find((r) => sameEmail(r.account_email, email));
    const target = same ?? (!multi && rows.length === 1 ? rows[0] : null);
    if (!target) throw new Error("duplicate account");
    await refresh(target, same ? cleanIdentity(same.account_email) || email : email);
    return { ok: true, email, id: target.id, replaced: !same };
  } catch (e) {
    console.error("calendar: save failed", e instanceof Error ? e.message : "error");
    return { ok: false, status: 500, error: "Couldn't save that calendar connection. Please try again." };
  }
}

/** A new account starts with its primary calendar, in its own colour (and one
 *  no other account's calendars use); any older account still on "primary
 *  only" is saved first, so it keeps the colour it already shows in. Best
 *  effort: NULL means the same thing. */
async function startWithPrimary(userId: string) {
  try {
    const { rows, multi } = await loadConnections(userId, "id, provider, account_email, access_token, refresh_token, expires_at");
    if (multi) await adoptPrimaries(userId, rows);
  } catch (e) {
    console.warn("calendar: couldn't read the new account's calendars yet", e instanceof Error ? e.message : "error");
  }
}

/** Accounts still on "primary only" (selected_calendars NULL: every
 *  connection made before 0045, or one whose calendars couldn't be read when
 *  it was added) get that choice saved as [their primary], in the colour the
 *  calendar list shows it in (primarySelection). From then on Settings, Month
 *  and Today all read one saved colour, and it no longer moves when other
 *  accounts change. Oldest first. Bounded and best effort: an account that
 *  can't be read within ADOPT_MS stays NULL (shown everywhere in its
 *  unsavedPrimaryColours colour) and is tried again next time. Updates
 *  `rows` in place and returns them. `only`: just that account; `lists`:
 *  calendar lists already read. Needs 0045 (rows without the column are left alone). */
async function adoptPrimaries(userId: string, rows: Conn[], opts: { only?: string; lists?: Map<string, ProviderCalendar[]> } = {}): Promise<Conn[]> {
  const pending = rows.filter((r) => r.selected_calendars === null && PROVIDERS[r.provider] && (!opts.only || r.id === opts.only));
  if (!pending.length) return rows;
  const lists = await mapLimit(pending, PARALLEL, (conn) => {
    const known = opts.lists?.get(conn.id);
    return known ? Promise.resolve(known) : withTimeout(async () => listProviderCalendars(conn, await freshToken(conn)), ADOPT_MS);
  });
  // colours the other accounts already show, plus each primary saved here, so none clash
  const unsaved = unsavedPrimaryColours(rows);
  const taken = rows.filter((r) => !pending.includes(r))
    .flatMap((r) => (parseSelected(r.selected_calendars) ?? []).map((s) => s.color).concat(unsaved.get(r.id) ?? []));
  for (let i = 0; i < pending.length; i++) {
    const conn = pending[i], got = lists[i];
    if (got.status === "rejected") { console.warn("calendar: couldn't read an account's calendars yet", conn.id, whyFailed(got.reason)); continue; }
    const selection = primarySelection(got.value, taken);
    if (!selection) continue;
    const { data, error } = await admin.from("calendar_connections").update({ selected_calendars: selection })
      .eq("id", conn.id).eq("user_id", userId).is("selected_calendars", null).select("selected_calendars");
    if (error) {
      console.warn("calendar: couldn't save an account's primary calendar", conn.id, missingSelectionColumn(error) ? "needs 0045" : "error");
      if (missingSelectionColumn(error)) break;
      continue;
    }
    if (Array.isArray(data) && data.length) {
      conn.selected_calendars = selection;
    } else {
      // chosen in the meantime (another tab): that choice stands
      const now = await admin.from("calendar_connections").select("selected_calendars").eq("id", conn.id).eq("user_id", userId).maybeSingle();
      conn.selected_calendars = (now.data as { selected_calendars?: unknown } | null)?.selected_calendars ?? null;
    }
    taken.push(...(parseSelected(conn.selected_calendars) ?? []).map((s) => s.color));
  }
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // ---- OAuth callback (provider redirect, no JWT) ----
  if (url.pathname.endsWith("/callback")) {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const back = (msg: string) => Response.redirect(`${APP_URL}/?calendar=${msg}`, 302);
    try {
      if (!code || !state) {
        if (state) await admin.from("oauth_states").delete().eq("state", state); // cancelled at the consent screen
        return back("error");
      }
      const { data: st } = await admin.from("oauth_states").select("*").eq("state", state).maybeSingle();
      if (!st || Date.now() - new Date(st.created_at).getTime() > STATE_TTL_MS) {
        if (st) await admin.from("oauth_states").delete().eq("state", state);
        return back("error");
      }
      if (state.startsWith(APP_FINISH)) {
        // the app finishes as the signed-in person (action=finish)
        const qs = new URLSearchParams({ calendar: "finish", calendar_state: state, calendar_code: code });
        return Response.redirect(`${APP_URL}/?${qs}`, 302);
      }
      // legacy handshake from an app that predates action=finish
      await admin.from("oauth_states").delete().eq("state", state); // single-use
      if (APP_FINISH_ONLY) {
        console.warn("calendar callback: legacy handshake refused (CALENDAR_APP_FINISH_ONLY)");
        return back("error");
      }
      const p = st.provider as ProviderKey;
      if (!PROVIDERS[p]) return back("error");
      const saved = await saveConnection(st.user_id, p, code);
      return back(saved.ok ? "connected" : "error");
    } catch (e) {
      console.error("calendar callback error", e instanceof Error ? e.message : "error");
      return back("error");
    }
  }

  // ---- authenticated actions ----
  const body: Record<string, unknown> = req.method === "POST" ? await req.json().catch(() => ({})) ?? {} : {};
  const action = url.searchParams.get("action") || String(body.action ?? "");
  const user = await getUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  try {
    if (action === "connect") {
      const provider = (url.searchParams.get("provider") || "") as ProviderKey;
      const cfg = PROVIDERS[provider];
      if (!cfg) return json({ error: "unknown provider" }, 400);
      if (!cfg.clientId()) return json({ error: `${provider} is not configured yet` }, 400);
      // finish=app: this app handles ?calendar=finish and calls action=finish
      const state = (url.searchParams.get("finish") === "app" ? APP_FINISH : "") + crypto.randomUUID();
      // tidy abandoned handshakes, then start this one
      await admin.from("oauth_states").delete().lt("created_at", new Date(Date.now() - STATE_TTL_MS).toISOString());
      await admin.from("oauth_states").insert({ state, user_id: user.id, provider });
      const auth = new URL(cfg.authUrl);
      auth.searchParams.set("client_id", cfg.clientId());
      auth.searchParams.set("redirect_uri", REDIRECT_URI);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", cfg.scope);
      auth.searchParams.set("state", state);
      for (const [k, v] of Object.entries(cfg.extraAuth)) auth.searchParams.set(k, v as string);
      return json({ url: auth.toString() });
    }

    if (action === "finish") {
      const state = String(url.searchParams.get("state") || body.state || "");
      const code = String(url.searchParams.get("code") || body.code || "");
      if (!state || !code) return json({ error: "missing state or code" }, 400);
      const { data: st } = await admin.from("oauth_states").select("*").eq("state", state).maybeSingle();
      if (!st) return json({ error: "This calendar link has expired. Please connect again." }, 400);
      // single-use, whoever presents it
      await admin.from("oauth_states").delete().eq("state", state);
      if (st.user_id !== user.id) {
        console.warn("calendar finish: state belongs to a different user — refused");
        return json({ error: "This calendar connection was started from a different Kanbo account. Please connect again from your own account." }, 403);
      }
      if (Date.now() - new Date(st.created_at).getTime() > STATE_TTL_MS) {
        return json({ error: "This calendar link has expired. Please connect again." }, 400);
      }
      const p = st.provider as ProviderKey;
      if (!PROVIDERS[p]) return json({ error: "unknown provider" }, 400);
      const saved = await saveConnection(user.id, p, code);
      if (!saved.ok) return json({ error: saved.error }, saved.status);
      return json({ ok: true, provider: p, accountEmail: saved.email, connectionId: saved.id, replaced: saved.replaced });
    }

    if (action === "list") {
      // (tokens are read only to save a not-yet-saved account's primary; they're never sent)
      const { rows, multi } = await loadConnections(user.id, "id, provider, account_email, created_at, access_token, refresh_token, expires_at");
      if (multi) await adoptPrimaries(user.id, rows);
      return json({
        multi,
        connections: rows.map((r) => ({
          id: r.id, provider: r.provider, accountEmail: r.account_email ?? "",
          selectedCalendars: multi ? parseSelected(r.selected_calendars) : null,
          createdAt: r.created_at,
          // (the names apps from before 0045 read)
          account_email: r.account_email ?? "", created_at: r.created_at,
        })),
      });
    }

    if (action === "calendars") {
      const id = url.searchParams.get("connection") || body.connection;
      const conn = await ownConnection(user.id, id);
      if (!conn) return json({ error: "That calendar account isn't connected any more." }, 404);
      const who = conn.account_email || PROVIDERS[conn.provider].label;
      let list: ProviderCalendar[];
      try { list = await listProviderCalendars(conn, await freshToken(conn)); }
      catch (e) { console.warn("calendar: list failed", conn.id, e instanceof Error ? e.message : "error"); return providerFail(e, who); }
      const { rows, multi } = await loadConnections(user.id, "id, provider");
      // still on "primary only": save that now, in the colour shown here
      if (multi) await adoptPrimaries(user.id, rows, { only: conn.id, lists: new Map([[conn.id, list]]) });
      const selected = multi ? parseSelected(rows.find((r) => r.id === conn.id)?.selected_calendars ?? conn.selected_calendars) : null;
      const painted = painting(list, selected, rows, conn.id);
      const chosen = new Set((selected ?? []).map((s) => s.id));
      return json({
        multi,
        selectedCalendars: selected,
        calendars: painted.map((c) => ({ ...c, selected: selected === null ? c.primary : chosen.has(c.id) })),
      });
    }

    if (action === "select") {
      const conn = await ownConnection(user.id, body.connection);
      if (!conn) return json({ error: "That calendar account isn't connected any more." }, 404);
      const who = conn.account_email || PROVIDERS[conn.provider].label;
      let list: ProviderCalendar[];
      try { list = await listProviderCalendars(conn, await freshToken(conn)); }
      catch (e) { console.warn("calendar: list failed", conn.id, e instanceof Error ? e.message : "error"); return providerFail(e, who); }
      const checked = validateSelection(body.calendarIds, list);
      if (!checked.ok) return json({ error: checked.error }, 400);
      const { rows, multi } = await loadConnections(user.id, "id");
      if (!multi) {
        return json({ error: "Choosing calendars needs Kanbo's calendar update (database 0045). Until then Kanbo shows each account's main calendar.", reason: "needs_migration" }, 409);
      }
      const previous = parseSelected(conn.selected_calendars);
      const selection = selectionFrom(checked.ids, painting(list, previous, rows, conn.id));
      const { error } = await admin.from("calendar_connections").update({ selected_calendars: selection, updated_at: new Date().toISOString() })
        .eq("id", conn.id).eq("user_id", user.id);
      if (error) {
        if (missingSelectionColumn(error)) return json({ error: "Choosing calendars needs Kanbo's calendar update (database 0045).", reason: "needs_migration" }, 409);
        throw new Error(error.message);
      }
      return json({ ok: true, selectedCalendars: selection });
    }

    if (action === "disconnect") {
      const connection = url.searchParams.get("connection") || body.connection;
      const provider = (url.searchParams.get("provider") || body.provider) as ProviderKey | undefined;
      if (isUuid(connection)) {
        await admin.from("calendar_connections").delete().eq("user_id", user.id).eq("id", connection);
      } else if (provider && PROVIDERS[provider]) {
        // the old way: every account of that provider
        await admin.from("calendar_connections").delete().eq("user_id", user.id).eq("provider", provider);
      } else {
        return json({ error: "Which calendar account?" }, 400);
      }
      return json({ ok: true });
    }

    if (action === "events") {
      const { start: startISO, end: endISO } = clampWindow(url.searchParams.get("start"), url.searchParams.get("end"));
      const { rows: conns } = await loadConnections(user.id, "*");
      type Job = { conn: Conn; cal: FetchTarget };
      const jobs: Job[] = [];
      // an account still on "primary only" (NULL, not saved yet: action=list
      // normally saves it first) shows in the same colour as in its calendar list
      const unsaved = unsavedPrimaryColours(conns);
      conns.forEach((conn, i) => {
        if (!PROVIDERS[conn.provider]) return;
        const selected = parseSelected(conn.selected_calendars);
        const fallback = { name: conn.account_email || PROVIDERS[conn.provider].label, color: unsaved.get(conn.id) ?? PALETTE[i % PALETTE.length] };
        for (const cal of fetchTargets(selected, fallback)) jobs.push({ conn, cal });
      });
      const warnings: { connectionId: string; provider: string; accountEmail: string; calendarId?: string; calendarName?: string; reason: WarningReason }[] = [];
      if (jobs.length > MAX_TARGETS) {
        for (const j of jobs.splice(MAX_TARGETS)) warnings.push({ connectionId: j.conn.id, provider: j.conn.provider, accountEmail: j.conn.account_email ?? "", calendarId: j.cal.id, calendarName: j.cal.name, reason: "unavailable" });
      }
      // one token refresh per account, shared by its calendars
      const tokens = new Map<string, Promise<string>>();
      const tokenFor = (c: Conn) => { let t = tokens.get(c.id); if (!t) { t = freshToken(c); tokens.set(c.id, t); } return t; };
      const results = await mapLimit(jobs, PARALLEL, async ({ conn, cal }) => fetchCalendarEvents(conn, await tokenFor(conn), cal, startISO, endISO));
      const all: ExtEvent[] = [];
      const failedAccounts = new Set<string>();
      results.forEach((r, i) => {
        const { conn, cal } = jobs[i];
        if (r.status === "fulfilled") { all.push(...r.value); return; }
        const reason = whyFailed(r.reason);
        console.error("calendar: events failed", conn.provider, conn.id, cal.id === "primary" ? "primary" : "calendar", reason);
        // a token that can't be refreshed fails the whole account: say so once
        if (reason === "reconnect") {
          if (failedAccounts.has(conn.id)) return;
          failedAccounts.add(conn.id);
          warnings.push({ connectionId: conn.id, provider: conn.provider, accountEmail: conn.account_email ?? "", reason });
          return;
        }
        warnings.push({ connectionId: conn.id, provider: conn.provider, accountEmail: conn.account_email ?? "", calendarId: cal.id, calendarName: cal.name, reason });
      });
      const events = dedupeEvents(all).map(({ uid: _uid, ...e }) => e)
        .sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0));
      return json({ events, warnings });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("calendar action error", action, e instanceof Error ? e.message : "error");
    return json({ error: "Something went wrong with the calendar. Please try again." }, 500);
  }
});
