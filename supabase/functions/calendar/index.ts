// ============================================================
// KANBO — external calendar integration (Google + Microsoft)
// One function, action-routed. Keeps OAuth client secrets server-side.
//
//   GET  /calendar?action=connect&provider=google|microsoft   (JWT)  -> { url }
//   GET  /calendar/callback?code=..&state=..                   (open) -> 302 to app
//   GET  /calendar?action=list                                 (JWT)  -> { connections }
//   GET  /calendar?action=events&start=ISO&end=ISO             (JWT)  -> { events }
//   POST /calendar  { action:"disconnect", provider }          (JWT)  -> { ok }
//
// Deploy:  supabase functions deploy calendar --no-verify-jwt
//   (we verify the JWT ourselves for the authed actions; the OAuth callback
//    is reached by the provider's redirect and authenticates via `state`.)
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//          MS_CLIENT_ID, MS_CLIENT_SECRET, APP_URL
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
const APP_URL = Deno.env.get("APP_URL") || "https://kanbo.co.uk";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/calendar/callback`;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

// ---- provider config ---------------------------------------------------
const PROVIDERS = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/calendar.readonly",
    clientId: () => Deno.env.get("GOOGLE_CLIENT_ID") || "",
    clientSecret: () => Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
    extraAuth: { access_type: "offline", prompt: "consent" },
  },
  microsoft: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "openid email offline_access https://graph.microsoft.com/Calendars.Read",
    clientId: () => Deno.env.get("MS_CLIENT_ID") || "",
    clientSecret: () => Deno.env.get("MS_CLIENT_SECRET") || "",
    extraAuth: {},
  },
} as const;
type ProviderKey = keyof typeof PROVIDERS;

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
  const r = await fetch(cfg.tokenUrl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!r.ok) throw new Error(`${p} token exchange failed: ${r.status} ${await r.text()}`);
  return await r.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
}

// ensure a connection has a fresh access token; refresh in place if expired
async function freshToken(conn: Record<string, unknown>): Promise<string> {
  const expISO = conn.expires_at as string | null;
  const notExpired = expISO && new Date(expISO).getTime() - Date.now() > 60_000;
  if (notExpired) return conn.access_token as string;
  const p = conn.provider as ProviderKey;
  if (!conn.refresh_token) return conn.access_token as string; // best effort
  const tok = await exchangeToken(p, { grant_type: "refresh_token", refresh_token: conn.refresh_token as string });
  const expires_at = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
  await admin.from("calendar_connections").update({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? conn.refresh_token, // Google omits on refresh
    expires_at, updated_at: new Date().toISOString(),
  }).eq("id", conn.id as string);
  return tok.access_token;
}

interface ExtEvent { id: string; title: string; start: string; end: string; allDay: boolean; provider: string; }

async function fetchGoogle(token: string, startISO: string, endISO: string): Promise<ExtEvent[]> {
  const u = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  u.searchParams.set("timeMin", startISO); u.searchParams.set("timeMax", endISO);
  u.searchParams.set("singleEvents", "true"); u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("maxResults", "250");
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`google events ${r.status}`);
  const data = await r.json();
  return (data.items ?? []).map((e: Record<string, any>) => ({
    id: `g-${e.id}`, title: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
    allDay: !e.start?.dateTime, provider: "google",
  })).filter((e: ExtEvent) => e.start && e.end);
}

async function fetchMicrosoft(token: string, startISO: string, endISO: string): Promise<ExtEvent[]> {
  const u = new URL("https://graph.microsoft.com/v1.0/me/calendarview");
  u.searchParams.set("startDateTime", startISO); u.searchParams.set("endDateTime", endISO);
  u.searchParams.set("$top", "250"); u.searchParams.set("$orderby", "start/dateTime");
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } });
  if (!r.ok) throw new Error(`microsoft events ${r.status}`);
  const data = await r.json();
  return (data.value ?? []).map((e: Record<string, any>) => ({
    id: `m-${e.id}`, title: e.subject || "(no title)",
    start: e.start?.dateTime ? `${e.start.dateTime}Z`.replace("ZZ", "Z") : "",
    end: e.end?.dateTime ? `${e.end.dateTime}Z`.replace("ZZ", "Z") : "",
    allDay: !!e.isAllDay, provider: "microsoft",
  })).filter((e: ExtEvent) => e.start && e.end);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // ---- OAuth callback (provider redirect; authenticated via state) ----
  if (url.pathname.endsWith("/callback")) {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const back = (msg: string) => Response.redirect(`${APP_URL}/?calendar=${msg}`, 302);
    try {
      if (!code || !state) return back("error");
      const { data: st } = await admin.from("oauth_states").select("*").eq("state", state).maybeSingle();
      if (!st) return back("error");
      await admin.from("oauth_states").delete().eq("state", state);
      const p = st.provider as ProviderKey;
      const tok = await exchangeToken(p, {
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
      });
      // best-effort: identify the connected account's email
      let email = "";
      try {
        if (p === "google") {
          const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
          email = ui.email || "";
        } else {
          const ui = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
          email = ui.mail || ui.userPrincipalName || "";
        }
      } catch { /* non-fatal */ }
      const expires_at = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
      await admin.from("calendar_connections").upsert({
        user_id: st.user_id, provider: p, account_email: email,
        access_token: tok.access_token, refresh_token: tok.refresh_token ?? null,
        expires_at, scope: tok.scope ?? PROVIDERS[p].scope, updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,provider" });
      return back("connected");
    } catch (e) {
      console.error("calendar callback error", e);
      return back("error");
    }
  }

  // ---- authenticated actions ----
  const action = url.searchParams.get("action") || (req.method === "POST" ? (await req.clone().json().catch(() => ({})))?.action : "");
  const user = await getUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  try {
    if (action === "connect") {
      const provider = (url.searchParams.get("provider") || "") as ProviderKey;
      const cfg = PROVIDERS[provider];
      if (!cfg) return json({ error: "unknown provider" }, 400);
      if (!cfg.clientId()) return json({ error: `${provider} is not configured yet` }, 400);
      const state = crypto.randomUUID();
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

    if (action === "list") {
      const { data } = await admin.from("calendar_connections")
        .select("provider, account_email, created_at").eq("user_id", user.id);
      return json({ connections: data ?? [] });
    }

    if (action === "disconnect") {
      const provider = url.searchParams.get("provider") || (await req.json().catch(() => ({})))?.provider;
      await admin.from("calendar_connections").delete().eq("user_id", user.id).eq("provider", provider);
      return json({ ok: true });
    }

    if (action === "events") {
      const startISO = url.searchParams.get("start") || new Date().toISOString();
      const endISO = url.searchParams.get("end") || new Date(Date.now() + 31 * 864e5).toISOString();
      const { data: conns } = await admin.from("calendar_connections").select("*").eq("user_id", user.id);
      const all: ExtEvent[] = [];
      for (const c of conns ?? []) {
        try {
          const token = await freshToken(c);
          const evs = c.provider === "google"
            ? await fetchGoogle(token, startISO, endISO)
            : await fetchMicrosoft(token, startISO, endISO);
          all.push(...evs);
        } catch (e) { console.error("events fetch failed for", c.provider, e); }
      }
      return json({ events: all });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("calendar action error", action, e);
    return json({ error: String(e) }, 500);
  }
});
