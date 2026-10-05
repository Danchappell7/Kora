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
// made before 0045). Until 0045 is run the function still works: one account
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
// Scopes are unchanged (read-only): Google calendar.readonly also lists the
// account's calendars; Microsoft Calendars.Read covers /me/calendars.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  clampWindow, dedupeEvents, distinctColours, eventId, fetchTargets, isUuid, mapLimit, missingSelectionColumn,
  normaliseGoogleCalendars, normaliseMicrosoftCalendars, paintCalendars, PALETTE, parseSelected, sameEmail,
  selectionFrom, TimeoutError, validateSelection, withTimeout,
  type FetchTarget, type ProviderCalendar, type ProviderKey,
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
    scope: "openid email offline_access https://graph.microsoft.com/Calendars.Read",
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
  return await r.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
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
  return tok.access_token;
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

/** Colours already shown for the person's OTHER accounts (so a new choice doesn't clash). */
function coloursElsewhere(rows: Conn[], exceptId: string): string[] {
  return rows.filter((r) => r.id !== exceptId).flatMap((r) => (parseSelected(r.selected_calendars) ?? []).map((s) => s.color));
}

const providerFail = (e: unknown, who: string) => {
  const reason: WarningReason = e instanceof ProviderError ? e.reason : "unavailable";
  return reason === "reconnect"
    ? json({ error: `Kanbo can't read ${who} any more. Disconnect it and add it again.`, reason }, 409)
    : json({ error: `Couldn't reach ${who} just now. Try again in a moment.`, reason }, 502);
};

// swap an OAuth code for tokens and save the connection for `userId`: one
// row per account (user, provider, account email). The same account again
// refreshes its tokens and keeps its calendar choice.
async function saveConnection(userId: string, p: ProviderKey, code: string):
  Promise<{ ok: true; email: string; id: string | null; replaced: boolean } | { ok: false; status: number; error: string }> {
  let tok: Awaited<ReturnType<typeof exchangeToken>>;
  try {
    tok = await exchangeToken(p, { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
  } catch (e) {
    console.error("calendar: token exchange failed", e instanceof Error ? e.message : "error");
    return { ok: false, status: 502, error: "Couldn't finish connecting that calendar. Please try again." };
  }
  // best-effort: identify the connected account's email
  let email = "";
  try {
    if (p === "google") {
      const ui = await providerGet("https://www.googleapis.com/oauth2/v2/userinfo", tok.access_token);
      email = String(ui.email || "");
    } else {
      const ui = await providerGet("https://graph.microsoft.com/v1.0/me", tok.access_token);
      email = String(ui.mail || ui.userPrincipalName || "");
    }
  } catch { /* non-fatal */ }
  email = email.trim().slice(0, 320);
  const now = new Date().toISOString();
  const expires_at = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
  const fresh = { access_token: tok.access_token, expires_at, scope: tok.scope ?? PROVIDERS[p].scope, updated_at: now };

  const accounts = async () => {
    const { data, error } = await admin.from("calendar_connections").select("id, account_email, refresh_token").eq("user_id", userId).eq("provider", p);
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; account_email: string; refresh_token: string | null }[];
  };
  const refresh = async (row: { id: string; account_email: string; refresh_token: string | null }) => {
    const { error } = await admin.from("calendar_connections").update({
      ...fresh, account_email: email || row.account_email, refresh_token: tok.refresh_token ?? row.refresh_token,
    }).eq("id", row.id);
    if (error) throw new Error(error.message);
  };
  try {
    const mine = (await accounts()).find((r) => sameEmail(r.account_email, email));
    if (mine) { await refresh(mine); return { ok: true, email, id: mine.id, replaced: false }; }
    const ins = await admin.from("calendar_connections").insert({
      user_id: userId, provider: p, account_email: email, refresh_token: tok.refresh_token ?? null, created_at: now, ...fresh,
    }).select("id").single();
    if (!ins.error) {
      const id = (ins.data as { id: string } | null)?.id ?? null;
      if (id) await startWithPrimary(userId, id);
      return { ok: true, email, id, replaced: false };
    }
    if (ins.error.code !== "23505") throw new Error(ins.error.message);
    // a duplicate: the same account finishing twice at once, or 0045 not run
    // yet (one account per provider: the new one replaces the old, as before)
    const rows = await accounts();
    const same = rows.find((r) => sameEmail(r.account_email, email));
    const target = same ?? (rows.length === 1 ? rows[0] : null);
    if (!target) throw new Error("duplicate account");
    await refresh(target);
    return { ok: true, email, id: target.id, replaced: !same };
  } catch (e) {
    console.error("calendar: save failed", e instanceof Error ? e.message : "error");
    return { ok: false, status: 500, error: "Couldn't save that calendar connection. Please try again." };
  }
}

/** A new account starts with its primary calendar, in its own colour (and one
 *  no other account's calendars use). Best effort: NULL means the same thing. */
async function startWithPrimary(userId: string, id: string) {
  try {
    const { rows, multi } = await loadConnections(userId, "id, provider, account_email, access_token, refresh_token, expires_at");
    const conn = rows.find((r) => r.id === id);
    if (!multi || !conn || conn.selected_calendars != null) return;
    const list = paintCalendars(await listProviderCalendars(conn, await freshToken(conn)), null, coloursElsewhere(rows, id));
    const primary = list.find((c) => c.primary);
    if (!primary) return;
    await admin.from("calendar_connections").update({ selected_calendars: selectionFrom([primary.id], list) })
      .eq("id", id).eq("user_id", userId).is("selected_calendars", null);
  } catch (e) {
    console.warn("calendar: couldn't read the new account's calendars yet", e instanceof Error ? e.message : "error");
  }
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
      const { rows, multi } = await loadConnections(user.id, "id, provider, account_email, created_at");
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
      const { rows, multi } = await loadConnections(user.id, "id");
      const selected = multi ? parseSelected(conn.selected_calendars) : null;
      const painted = paintCalendars(list, selected, coloursElsewhere(rows, conn.id));
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
      const selection = selectionFrom(checked.ids, paintCalendars(list, previous, coloursElsewhere(rows, conn.id)));
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
      // an account still on "primary only" (NULL) gets a colour that no chosen
      // calendar and no earlier such account uses
      const used = conns.flatMap((c) => (parseSelected(c.selected_calendars) ?? []).map((s) => s.color));
      conns.forEach((conn, i) => {
        if (!PROVIDERS[conn.provider]) return;
        const selected = parseSelected(conn.selected_calendars);
        let color = PALETTE[i % PALETTE.length];
        if (selected === null) { color = distinctColours([{ color: "" }], used)[0].color; used.push(color); }
        const fallback = { name: conn.account_email || PROVIDERS[conn.provider].label, color };
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
        const reason: WarningReason = r.reason instanceof ProviderError ? r.reason.reason : r.reason instanceof TimeoutError ? "timeout" : "unavailable";
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
