// @vitest-environment node
/* The `calendar` Edge Function end to end, under a stubbed Deno, an in-memory
   calendar_connections table and fake Google / Microsoft APIs:
   - several accounts per person (a second Google account is added, the same
     account again refreshes in place and keeps its choice);
   - choosing calendars per account (validated against the provider's list,
     capped at 25, colours distinct across accounts);
   - events from every chosen calendar of every account, tagged with where
     they came from, with one failing / slow / revoked account or calendar
     reported in `warnings` instead of breaking the rest;
   - which account was connected: the id_token's email, then the provider's
     profile; an account nothing names is refused, never saved over another;
   - an account still on "primary only" shows in one colour everywhere, saved
     the first time the accounts are listed;
   - before 0045 (no selected_calendars column, one account per provider)
     everything still works the old way;
   - tokens never reach a response (or the logs). */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const ANA = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "anon",
  APP_URL: "https://www.kanbo.co.uk", GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", MS_CLIENT_ID: "mid", MS_CLIENT_SECRET: "msecret",
};

/* ---------------- an in-memory database ---------------- */
type Row = Record<string, any>;
let DB: { calendar_connections: Row[]; oauth_states: Row[] };
let PRE_0045 = false;      // selected_calendars missing, unique (user_id, provider)
let CALLER = ANA;
let seq = 0;
const uuid = () => `cccccccc-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function table(name: "calendar_connections" | "oauth_states") {
  let op: "select" | "insert" | "update" | "delete" = "select";
  let cols = "*";
  let payload: Row = {};
  const filters: Array<(r: Row) => boolean> = [];
  let orderCol: string | null = null;
  const project = (r: Row) => {
    const full = { ...r };
    if (PRE_0045 && name === "calendar_connections") delete full.selected_calendars;
    if (cols.trim() === "*") return full;
    return Object.fromEntries(cols.split(",").map((c) => c.trim()).map((c) => [c, full[c]]));
  };
  const run = (): { data: any; error: any } => {
    const rows = DB[name];
    const hits = rows.filter((r) => filters.every((f) => f(r)));
    if (op === "select") {
      if (PRE_0045 && name === "calendar_connections" && cols.includes("selected_calendars")) {
        return { data: null, error: { code: "42703", message: "column calendar_connections.selected_calendars does not exist" } };
      }
      const sorted = orderCol ? [...hits].sort((a, b) => String(a[orderCol!]).localeCompare(String(b[orderCol!]))) : hits;
      return { data: sorted.map(project), error: null };
    }
    if (op === "insert") {
      const row: Row = { id: uuid(), created_at: new Date(Date.now() + seq).toISOString(), updated_at: new Date().toISOString(), ...payload };
      if (name === "calendar_connections") {
        if (!PRE_0045 && !("selected_calendars" in row)) row.selected_calendars = null;
        const clash = rows.some((r) => r.user_id === row.user_id && r.provider === row.provider
          && (PRE_0045 || String(r.account_email).toLowerCase() === String(row.account_email).toLowerCase()));
        if (clash) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      rows.push(row);
      return { data: [project(row)], error: null };
    }
    if (op === "update") {
      if (PRE_0045 && "selected_calendars" in payload) return { data: null, error: { code: "PGRST204", message: "Could not find the 'selected_calendars' column of 'calendar_connections' in the schema cache" } };
      hits.forEach((r) => Object.assign(r, payload));
      return { data: hits.map(project), error: null };
    }
    DB[name] = rows.filter((r) => !hits.includes(r));
    return { data: null, error: null };
  };
  const q: Record<string, any> = {
    select(c = "*") { if (op === "select") cols = c; else cols = c; return q; },
    insert(row: Row) { op = "insert"; payload = row; return q; },
    update(p: Row) { op = "update"; payload = p; return q; },
    delete() { op = "delete"; return q; },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q; },
    is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return q; },
    lt(c: string, v: string) { filters.push((r) => String(r[c]) < v); return q; },
    order(c: string) { orderCol = c; return q; },
    maybeSingle: async () => { const r = run(); return { data: r.error ? null : (r.data?.[0] ?? null), error: r.error }; },
    single: async () => { const r = run(); return { data: r.error ? null : (r.data?.[0] ?? null), error: r.error }; },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, bad),
  };
  return q;
}
vi.mock("https://esm.sh/@supabase/supabase-js@2", () => ({
  createClient: () => ({
    from: (t: "calendar_connections" | "oauth_states") => table(t),
    auth: { getUser: async () => ({ data: { user: { id: CALLER } }, error: null }) },
  }),
}));

/* ---------------- fake Google and Microsoft ---------------- */
const SOON = () => new Date(Date.now() + 3600_000).toISOString();
const GOOGLE_LISTS: Record<string, Row[]> = {
  "at-work": [
    { id: "ana@work.example", summary: "ana@work.example", summaryOverride: "Work", backgroundColor: "#3f7fe0", primary: true, accessRole: "owner" },
    { id: "team@group.calendar.google.com", summary: "Launch team", backgroundColor: "#3f7fe0", accessRole: "writer" },
    { id: "broken@group.calendar.google.com", summary: "Broken", backgroundColor: "#e0663a", accessRole: "reader" },
    { id: "slow@group.calendar.google.com", summary: "Slow", backgroundColor: "#a35bc4", accessRole: "reader" },
  ],
  "at-personal": [
    { id: "ana@gmail.example", summary: "ana@gmail.example", backgroundColor: "#3f7fe0", primary: true, accessRole: "owner" },
    { id: "family@group.calendar.google.com", summary: "Family", backgroundColor: "#d14d72", accessRole: "owner" },
  ],
  // an account connected before 0045, whose primary's colour isn't one of Kanbo's own
  "at-legacy": [
    { id: "legacy@gmail.example", summary: "legacy@gmail.example", backgroundColor: "#9fc6e7", primary: true, accessRole: "owner" },
    { id: "club@group.calendar.google.com", summary: "Running club", backgroundColor: "#9fc6e7", accessRole: "reader" },
  ],
};
const ev = (id: string, title: string, start: string, end: string, extra: Row = {}) => ({ id, summary: title, start: { dateTime: start }, end: { dateTime: end }, ...extra });
const GOOGLE_EVENTS: Record<string, Row[]> = {
  "ana@work.example": [ev("e1", "Standup", "2026-10-05T08:00:00Z", "2026-10-05T08:30:00Z", { iCalUID: "standup@work" })],
  primary: [ev("p1", "Primary thing", "2026-10-05T09:00:00Z", "2026-10-05T09:30:00Z")],
  "team@group.calendar.google.com": [
    ev("t1", "Launch sync", "2026-10-05T10:00:00Z", "2026-10-05T10:30:00Z"),
    ev("t2", "Standup (team copy)", "2026-10-05T08:00:00Z", "2026-10-05T08:30:00Z", { iCalUID: "standup@work" }),
  ],
  "family@group.calendar.google.com": [{ id: "f1", summary: "Half term", start: { date: "2026-10-26" }, end: { date: "2026-10-31" } }],
  "ana@gmail.example": [ev("g1", "Gym", "2026-10-05T06:30:00Z", "2026-10-05T07:30:00Z")],
  "legacy@gmail.example": [ev("l1", "Dinner", "2026-10-05T18:00:00Z", "2026-10-05T19:30:00Z")],
};
/* id_tokens the token endpoint returns: by auth code, and by refresh token */
const ID_TOKENS: Record<string, Row> = {};
const REFRESH_ID_TOKENS: Record<string, Row> = {};
const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: Row) => `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.c2lnbmF0dXJl`;
let userinfoDown = false;  // Google's userinfo answers 503
let meStatus = 200;        // Microsoft's /me (403: the token has no User.Read)
const listDown = new Set<string>(); // tokens whose calendar list answers 503
let slowHang = false;
const fetchLog: string[] = [];
function fakeFetch(input: string | URL, init: RequestInit = {}) {
  const u = new URL(String(input));
  fetchLog.push(`${u.host}${u.pathname}`);
  const auth = String((init.headers as Record<string, string> | undefined)?.Authorization ?? "").replace("Bearer ", "");
  const ok = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
  const no = (s: number) => Promise.resolve(new Response(JSON.stringify({ error: "nope", echoed_token: auth }), { status: s }));
  if (u.pathname.endsWith("/token")) {
    const body = new URLSearchParams(String(init.body));
    if (body.get("refresh_token") === "rt-revoked") return no(400);
    const code = body.get("code") ?? "refresh";
    const claims = body.get("grant_type") === "authorization_code" ? ID_TOKENS[code] : REFRESH_ID_TOKENS[body.get("refresh_token") ?? ""];
    return ok({ access_token: `at-${code}`, refresh_token: body.get("grant_type") === "authorization_code" ? `rt-${code}` : undefined, expires_in: 3600,
      ...(claims ? { id_token: jwt(claims) } : {}) });
  }
  if (u.host === "www.googleapis.com" && u.pathname === "/oauth2/v2/userinfo") {
    if (userinfoDown) return no(503);
    return ok({ email: { "at-code-personal": "ana@gmail.example", "at-code-work-again": "ANA@Work.Example", "at-code-second": "ana.second@gmail.example" }[auth] ?? "new@gmail.example" });
  }
  if (u.host === "graph.microsoft.com" && u.pathname === "/v1.0/me") return meStatus === 200 ? ok({ mail: "ana@outlook.example" }) : no(meStatus);
  if (u.pathname === "/calendar/v3/users/me/calendarList") {
    if (listDown.has(auth)) return no(503);
    const items = GOOGLE_LISTS[auth] ?? GOOGLE_LISTS["at-personal"];
    return ok({ items });
  }
  const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(u.pathname);
  if (m) {
    const cal = decodeURIComponent(m[1]);
    if (cal === "broken@group.calendar.google.com") return no(500);
    if (cal === "slow@group.calendar.google.com") {
      if (!slowHang) return ok({ items: [] });
      return new Promise<Response>((_, reject) => { init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
    }
    return ok({ items: GOOGLE_EVENTS[cal] ?? [] });
  }
  if (u.host === "graph.microsoft.com" && u.pathname === "/v1.0/me/calendars") {
    return ok({ value: [
      { id: "AAMk-default=", name: "Calendar", hexColor: "#3f7fe0", isDefaultCalendar: true, owner: { address: "ana@outlook.example" } },
      { id: "AAMk-family=", name: "Family", color: "lightPink", isDefaultCalendar: false, owner: { address: "ana@outlook.example" } },
    ] });
  }
  if (u.host === "graph.microsoft.com" && (u.pathname === "/v1.0/me/calendarview" || /\/calendarView$/.test(u.pathname))) {
    return ok({ value: [{ id: "o1", subject: "Dentist", iCalUId: "dentist@outlook", start: { dateTime: "2026-10-05T14:00:00.0000000" }, end: { dateTime: "2026-10-05T14:30:00.0000000" } }] });
  }
  return no(404);
}

/* ---------------- the handler ---------------- */
type Handler = (req: Request) => Promise<Response>;
let handler: Handler;
beforeAll(async () => {
  (globalThis as unknown as { Deno: unknown }).Deno = { serve: (h: Handler) => { handler = h; }, env: { get: (k: string) => ENV[k] } };
  await import("../calendar/index.ts");
  expect(handler).toBeTypeOf("function");
});

const logged: unknown[][] = [];
beforeEach(() => {
  seq = 0; PRE_0045 = false; CALLER = ANA; slowHang = false; userinfoDown = false; meStatus = 200; fetchLog.length = 0; logged.length = 0;
  for (const k of Object.keys(ID_TOKENS)) delete ID_TOKENS[k];
  for (const k of Object.keys(REFRESH_ID_TOKENS)) delete REFRESH_ID_TOKENS[k];
  listDown.clear();
  DB = {
    oauth_states: [],
    calendar_connections: [
      { id: "11111111-0000-4000-8000-000000000001", user_id: ANA, provider: "google", account_email: "ana@work.example", access_token: "at-work", refresh_token: "rt-work", expires_at: SOON(), created_at: "2026-01-01T00:00:00Z", selected_calendars: null },
      { id: "22222222-0000-4000-8000-000000000002", user_id: BOB, provider: "google", account_email: "bob@gmail.example", access_token: "at-bob", refresh_token: "rt-bob", expires_at: SOON(), created_at: "2026-01-02T00:00:00Z", selected_calendars: null },
    ],
  };
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const WORK = "11111111-0000-4000-8000-000000000001";
const BOBS = "22222222-0000-4000-8000-000000000002";
const LEGACY = "66666666-0000-4000-8000-000000000006";
const get = (qs: string) => handler(new Request(`https://fn.test/calendar?${qs}`, { headers: { Authorization: "Bearer jwt" } }));
const post = (body: Record<string, unknown>) => handler(new Request("https://fn.test/calendar", {
  method: "POST", headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
const read = async (r: Response) => { const text = await r.text(); return { status: r.status, text, body: JSON.parse(text) }; };
const noSecrets = (s: string) => !/\b(at|rt)-[a-z0-9-]+/i.test(s) && !s.includes("gsecret") && !s.includes("msecret");
const allLogs = () => logged.map((a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")).join("\n");

/** connect + callback + finish, as the app does it */
async function addAccount(provider: "google" | "microsoft", code: string) {
  const c = await read(await get(`action=connect&provider=${provider}&finish=app`));
  const state = new URL(c.body.url).searchParams.get("state")!;
  return read(await get(`action=finish&state=${encodeURIComponent(state)}&code=${code}`));
}

describe("connect", () => {
  it("always asks which account (so a second one of the same provider can be added), with read-only scopes", async () => {
    const g = new URL((await read(await get("action=connect&provider=google&finish=app"))).body.url);
    expect(g.searchParams.get("prompt")).toBe("select_account consent");
    expect(g.searchParams.get("access_type")).toBe("offline");
    expect(g.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/calendar.readonly");
    const m = new URL((await read(await get("action=connect&provider=microsoft&finish=app"))).body.url);
    expect(m.searchParams.get("prompt")).toBe("select_account");
    // (User.Read, already in the Azure app's permissions, lets /me name the account;
    // profile puts the sign-in name in the id_token)
    expect(m.searchParams.get("scope")).toBe("openid email profile offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read");
  });
});

describe("several accounts", () => {
  it("a second Google account is added next to the first, starting on its primary calendar in a colour of its own", async () => {
    const r = await addAccount("google", "code-personal");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, provider: "google", accountEmail: "ana@gmail.example", replaced: false });
    expect(noSecrets(r.text)).toBe(true);
    const mine = DB.calendar_connections.filter((c) => c.user_id === ANA);
    expect(mine.map((c) => c.account_email)).toEqual(["ana@work.example", "ana@gmail.example"]);
    // the older account (still on "primary only") is saved first, keeping its blue;
    // the new one's primary is blue too, so it gets a colour of its own
    expect(mine[0].selected_calendars).toEqual([{ id: "ana@work.example", name: "Work", color: "#3f7fe0", primary: true }]);
    const added = mine[1];
    expect(added.id).toBe(r.body.connectionId);
    expect(added.selected_calendars).toEqual([{ id: "ana@gmail.example", name: "ana@gmail.example", color: "#2e9d6a", primary: true }]);
    // the list the app sees: ids, providers, emails, choices; never a token
    const list = await read(await get("action=list"));
    expect(list.body.multi).toBe(true);
    expect(list.body.connections.map((c: Row) => [c.provider, c.accountEmail, c.selectedCalendars?.length ?? null])).toEqual([
      ["google", "ana@work.example", 1], ["google", "ana@gmail.example", 1],
    ]);
    expect(list.body.connections[0]).toMatchObject({ id: WORK, account_email: "ana@work.example" }); // (older apps' field names too)
    expect(noSecrets(list.text)).toBe(true);
    expect(list.text).not.toContain("bob@");
  });

  it("the same account again (any case) refreshes its tokens in place and keeps its id and calendar choice", async () => {
    DB.calendar_connections[0].selected_calendars = [{ id: "team@group.calendar.google.com", name: "Launch team", color: "#2e9d6a", primary: false }];
    const r = await addAccount("google", "code-work-again");
    expect(r.body).toMatchObject({ ok: true, connectionId: WORK, replaced: false });
    const mine = DB.calendar_connections.filter((c) => c.user_id === ANA);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ access_token: "at-code-work-again", refresh_token: "rt-code-work-again" });
    expect(mine[0].selected_calendars).toHaveLength(1);
  });

  it("an Outlook account alongside", async () => {
    const r = await addAccount("microsoft", "code-ms");
    expect(r.body).toMatchObject({ ok: true, provider: "microsoft", accountEmail: "ana@outlook.example" });
    const ms = DB.calendar_connections.find((c) => c.provider === "microsoft")!;
    // its default calendar; Outlook's blue is the (older) Work calendar's, so another colour
    expect(ms.selected_calendars).toEqual([{ id: "AAMk-default=", name: "Calendar", color: "#2e9d6a", primary: true }]);
    // with no other account, it keeps Outlook's own colour
    DB.calendar_connections = DB.calendar_connections.filter((c) => c.provider !== "microsoft" && c.id !== WORK);
    const again = await addAccount("microsoft", "code-ms-2");
    expect(DB.calendar_connections.find((c) => c.id === again.body.connectionId)!.selected_calendars)
      .toEqual([{ id: "AAMk-default=", name: "Calendar", color: "#3f7fe0", primary: true }]);
  });

  it("a handshake started by someone else can't be finished here", async () => {
    const c = await read(await get("action=connect&provider=google&finish=app"));
    const state = new URL(c.body.url).searchParams.get("state")!;
    CALLER = BOB;
    const r = await read(await get(`action=finish&state=${state}&code=code-personal`));
    expect(r.status).toBe(403);
    expect(DB.calendar_connections.filter((x) => x.user_id === BOB)).toHaveLength(1);
  });
});

describe("which account was connected", () => {
  const anas = () => DB.calendar_connections.filter((c) => c.user_id === ANA).map((c) => ({ id: c.id, email: c.account_email, at: c.access_token, sel: c.selected_calendars }));

  it("comes from the id_token's email, with no profile call needed", async () => {
    ID_TOKENS["code-idt"] = { sub: "g-1", email: "ana.idtoken@gmail.example" };
    userinfoDown = true;
    const r = await addAccount("google", "code-idt");
    expect(r.body).toMatchObject({ ok: true, accountEmail: "ana.idtoken@gmail.example", replaced: false });
    expect(fetchLog.some((x) => x.includes("userinfo"))).toBe(false);
    expect(noSecrets(r.text)).toBe(true);
  });

  it("an account nothing names is refused, and never saved over another account (any number of times)", async () => {
    userinfoDown = true; // no id_token either
    const before = JSON.stringify(anas());
    for (const code of ["code-second", "code-third"]) {
      const r = await addAccount("google", code);
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("Couldn't tell which Google account that was, so it wasn't connected. Please try again.");
      expect(r.body.ok).toBeUndefined();
      expect(noSecrets(r.text)).toBe(true);
    }
    expect(JSON.stringify(anas())).toBe(before);
    expect(noSecrets(allLogs()), allLogs()).toBe(true);
  });

  it("an older row saved without an address is never taken for a new account", async () => {
    DB.calendar_connections[0].account_email = ""; // the old function's profile call had failed
    const r = await addAccount("google", "code-personal");
    expect(r.body).toMatchObject({ ok: true, accountEmail: "ana@gmail.example", replaced: false });
    expect(r.body.connectionId).not.toBe(WORK);
    expect(DB.calendar_connections.find((c) => c.id === WORK)).toMatchObject({ account_email: "", access_token: "at-work", refresh_token: "rt-work" });
  });

  it("Outlook: the sign-in name when there's no email claim and /me is refused, so two accounts stay two", async () => {
    meStatus = 403;
    ID_TOKENS["code-ms-a"] = { sub: "m-a", preferred_username: "ana@contoso.example" };
    ID_TOKENS["code-ms-b"] = { sub: "m-b", preferred_username: "ana@fabrikam.example" };
    const a = await addAccount("microsoft", "code-ms-a");
    const b = await addAccount("microsoft", "code-ms-b");
    expect([a.body.accountEmail, b.body.accountEmail]).toEqual(["ana@contoso.example", "ana@fabrikam.example"]);
    expect(a.body.connectionId).not.toBe(b.body.connectionId);
    expect(DB.calendar_connections.filter((c) => c.provider === "microsoft").map((c) => [c.account_email, c.access_token]))
      .toEqual([["ana@contoso.example", "at-code-ms-a"], ["ana@fabrikam.example", "at-code-ms-b"]]);
  });

  it("Outlook with neither: refused", async () => {
    meStatus = 403;
    const r = await addAccount("microsoft", "code-ms-anon");
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/^Couldn't tell which Outlook account that was/);
    expect(DB.calendar_connections.some((c) => c.provider === "microsoft")).toBe(false);
  });

  it("a row saved without an address learns it at its next token refresh, so the same account added again is recognised", async () => {
    Object.assign(DB.calendar_connections[0], { account_email: "", expires_at: "2020-01-01T00:00:00Z" });
    REFRESH_ID_TOKENS["rt-work"] = { sub: "g-work", email: "ana@work.example" };
    expect((await read(await get("action=events"))).status).toBe(200);
    expect(DB.calendar_connections[0]).toMatchObject({ id: WORK, account_email: "ana@work.example", access_token: "at-refresh" });
    const r = await addAccount("google", "code-work-again");
    expect(r.body).toMatchObject({ ok: true, connectionId: WORK, replaced: false });
    expect(anas()).toHaveLength(1);
  });
});

describe("an account still on \"primary only\" (connected before 0045)", () => {
  beforeEach(() => {
    DB.calendar_connections.unshift({ id: LEGACY, user_id: ANA, provider: "google", account_email: "legacy@gmail.example", access_token: "at-legacy", refresh_token: "rt-legacy",
      expires_at: SOON(), created_at: "2025-12-01T00:00:00Z", selected_calendars: null });
  });
  const legacyRow = () => DB.calendar_connections.find((c) => c.id === LEGACY)!;
  const dinnerColour = async () => {
    const e = await read(await get("action=events&start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z"));
    return e.body.events.find((x: Row) => x.title === "Dinner");
  };

  it("is saved on its primary the first time the accounts are listed: Settings, Month and Today show one colour, and it stays put", async () => {
    const list = await read(await get("action=list"));
    expect(noSecrets(list.text)).toBe(true);
    // oldest first, each in its provider's colour (they don't clash)
    expect(legacyRow().selected_calendars).toEqual([{ id: "legacy@gmail.example", name: "legacy@gmail.example", color: "#9fc6e7", primary: true }]);
    expect(DB.calendar_connections.find((c) => c.id === WORK)!.selected_calendars).toEqual([{ id: "ana@work.example", name: "Work", color: "#3f7fe0", primary: true }]);
    expect(list.body.connections.map((c: Row) => c.selectedCalendars?.[0]?.color)).toEqual(["#9fc6e7", "#3f7fe0"]);

    // the Settings swatch and the colour its events carry are the same
    const cals = await read(await get(`action=calendars&connection=${LEGACY}`));
    const swatch = cals.body.calendars.find((c: Row) => c.primary).color;
    expect(swatch).toBe("#9fc6e7");
    expect(await dinnerColour()).toMatchObject({ color: "#9fc6e7", calendarId: "legacy@gmail.example", calendarName: "legacy@gmail.example" });

    // adding another account, and ticking a second calendar, leave it alone
    await addAccount("google", "code-personal");
    const s = await read(await post({ action: "select", connection: LEGACY, calendarIds: ["legacy@gmail.example", "club@group.calendar.google.com"] }));
    expect(s.body.selectedCalendars.map((c: Row) => c.color)[0]).toBe("#9fc6e7");
    expect(new Set(DB.calendar_connections.filter((c) => c.user_id === ANA).flatMap((c) => c.selected_calendars.map((x: Row) => x.color))).size).toBe(4);
    expect((await dinnerColour()).color).toBe("#9fc6e7");
    expect((await read(await get(`action=calendars&connection=${LEGACY}`))).body.calendars.find((c: Row) => c.primary).color).toBe("#9fc6e7");
  });

  it("opening its calendars saves it too, and its swatch is the colour its events then carry", async () => {
    const cals = await read(await get(`action=calendars&connection=${LEGACY}`));
    expect(cals.body.selectedCalendars).toEqual([{ id: "legacy@gmail.example", name: "legacy@gmail.example", color: "#9fc6e7", primary: true }]);
    expect(cals.body.calendars.map((c: Row) => [c.name, c.selected])).toEqual([["legacy@gmail.example", true], ["Running club", false]]);
    expect(cals.body.calendars[1].color).not.toBe("#9fc6e7");
    expect((await dinnerColour()).color).toBe(cals.body.calendars[0].color);
  });

  it("if its calendars can't be read yet it stays as it is, in one colour everywhere, and is saved next time", async () => {
    listDown.add("at-legacy");
    const first = await read(await get("action=list"));
    expect(first.status).toBe(200);
    expect(first.body.connections[0]).toMatchObject({ id: LEGACY, selectedCalendars: null });
    const e = await read(await get("action=events"));
    const primaryThing = e.body.events.find((x: Row) => x.connectionId === LEGACY);
    // (the other account was saved in its blue, so this one is shown in the next free colour)
    expect(primaryThing).toMatchObject({ calendarId: "primary", color: "#2e9d6a" });
    // back again: saved now
    listDown.clear();
    await read(await get("action=list"));
    expect(legacyRow().selected_calendars).toEqual([{ id: "legacy@gmail.example", name: "legacy@gmail.example", color: "#9fc6e7", primary: true }]);
  });
});

describe("choosing calendars", () => {
  it("lists an account's calendars with Kanbo's colours, the primary ticked while nothing is chosen", async () => {
    const r = await read(await get(`action=calendars&connection=${WORK}`));
    expect(r.status).toBe(200);
    expect(r.body.calendars.map((c: Row) => [c.name, c.primary, c.selected, c.accessRole])).toEqual([
      ["Work", true, true, "owner"], ["Broken", false, false, "reader"], ["Launch team", false, false, "writer"], ["Slow", false, false, "reader"],
    ]);
    const colours = r.body.calendars.map((c: Row) => c.color);
    expect(new Set(colours).size).toBe(4);              // Launch team was blue like Work: it's given another
    expect(noSecrets(r.text)).toBe(true);
  });

  it("saves a choice (in the account's order, colours kept distinct from other accounts)", async () => {
    DB.calendar_connections.push({ id: "33333333-0000-4000-8000-000000000003", user_id: ANA, provider: "google", account_email: "ana@gmail.example", access_token: "at-personal", expires_at: SOON(), created_at: "2026-02-01T00:00:00Z",
      selected_calendars: [{ id: "family@group.calendar.google.com", name: "Family", color: "#2e9d6a", primary: false }] });
    const r = await read(await post({ action: "select", connection: WORK, calendarIds: ["team@group.calendar.google.com", "ana@work.example"] }));
    expect(r.status).toBe(200);
    expect(r.body.selectedCalendars.map((c: Row) => c.name)).toEqual(["Work", "Launch team"]);
    const saved = DB.calendar_connections.find((c) => c.id === WORK)!.selected_calendars;
    expect(saved).toEqual(r.body.selectedCalendars);
    expect(saved.map((c: Row) => c.color)).not.toContain("#2e9d6a");   // the other account's green
    // choosing nothing is allowed (the account stays connected, shows nothing)
    expect((await read(await post({ action: "select", connection: WORK, calendarIds: [] }))).body.selectedCalendars).toEqual([]);
  });

  it("refuses ids that aren't in the account, odd input, and someone else's account", async () => {
    const before = JSON.stringify(DB.calendar_connections);
    expect((await read(await post({ action: "select", connection: WORK, calendarIds: ["someone@else.example"] }))).status).toBe(400);
    expect((await read(await post({ action: "select", connection: WORK, calendarIds: "ana@work.example" }))).status).toBe(400);
    expect((await read(await post({ action: "select", connection: WORK, calendarIds: Array.from({ length: 26 }, (_, i) => `c${i}`) }))).status).toBe(400);
    expect((await read(await post({ action: "select", connection: BOBS, calendarIds: [] }))).status).toBe(404);
    expect((await read(await get(`action=calendars&connection=${BOBS}`))).status).toBe(404);
    expect((await read(await get("action=calendars&connection=google"))).status).toBe(404);
    expect(JSON.stringify(DB.calendar_connections)).toBe(before);
  });
});

describe("events", () => {
  it("reads every chosen calendar of every account, tagged, and the same meeting twice shows once", async () => {
    DB.calendar_connections[0].selected_calendars = [
      { id: "ana@work.example", name: "Work", color: "#3f7fe0", primary: true },
      { id: "team@group.calendar.google.com", name: "Launch team", color: "#2e9d6a", primary: false },
    ];
    DB.calendar_connections.push({ id: "44444444-0000-4000-8000-000000000004", user_id: ANA, provider: "microsoft", account_email: "ana@outlook.example", access_token: "at-ms", expires_at: SOON(), created_at: "2026-03-01T00:00:00Z", selected_calendars: null });
    const r = await read(await get("action=events&start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z"));
    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual([]);
    const titles = r.body.events.map((e: Row) => e.title);
    expect(titles).toEqual(["Standup", "Launch sync", "Dentist"]);     // the team copy of the standup is dropped
    const standup = r.body.events[0];
    expect(standup).toMatchObject({ provider: "google", connectionId: WORK, calendarId: "ana@work.example", calendarName: "Work", color: "#3f7fe0" });
    expect(standup).not.toHaveProperty("uid");
    // an Outlook account still on "primary only": its main calendar, named by the account, a colour nobody uses
    const dentist = r.body.events[2];
    expect(dentist).toMatchObject({ provider: "microsoft", calendarId: "primary", calendarName: "ana@outlook.example", start: "2026-10-05T14:00:00.0000000Z" });
    expect(["#3f7fe0", "#2e9d6a"]).not.toContain(dentist.color);
    expect(new Set(r.body.events.map((e: Row) => e.id)).size).toBe(3);
    expect(r.text).not.toContain("bob");
    expect(noSecrets(r.text)).toBe(true);
  });

  it("one broken calendar and one revoked account are reported; everything else still arrives", async () => {
    DB.calendar_connections[0].selected_calendars = [
      { id: "ana@work.example", name: "Work", color: "#3f7fe0", primary: true },
      { id: "broken@group.calendar.google.com", name: "Broken", color: "#e0663a", primary: false },
    ];
    DB.calendar_connections.push({ id: "55555555-0000-4000-8000-000000000005", user_id: ANA, provider: "google", account_email: "old@gmail.example", access_token: "at-old", refresh_token: "rt-revoked", expires_at: "2020-01-01T00:00:00Z", created_at: "2026-04-01T00:00:00Z",
      selected_calendars: [{ id: "a@g", name: "A", color: "#a35bc4", primary: false }, { id: "b@g", name: "B", color: "#c98a1b", primary: false }] });
    const r = await read(await get("action=events"));
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: Row) => e.title)).toEqual(["Standup"]);
    expect(r.body.warnings).toEqual([
      { connectionId: WORK, provider: "google", accountEmail: "ana@work.example", calendarId: "broken@group.calendar.google.com", calendarName: "Broken", reason: "unavailable" },
      { connectionId: "55555555-0000-4000-8000-000000000005", provider: "google", accountEmail: "old@gmail.example", reason: "reconnect" },
    ]);
    // the revoked account's token was refreshed once, not once per calendar
    expect(fetchLog.filter((x) => x.endsWith("/token"))).toHaveLength(1);
    expect(noSecrets(r.text)).toBe(true);
    expect(noSecrets(allLogs()), allLogs()).toBe(true);
  });

  it("a calendar that never answers times out without holding up the rest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    slowHang = true;
    DB.calendar_connections[0].selected_calendars = [
      { id: "slow@group.calendar.google.com", name: "Slow", color: "#a35bc4", primary: false },
      { id: "ana@work.example", name: "Work", color: "#3f7fe0", primary: true },
    ];
    const p = get("action=events");
    await vi.advanceTimersByTimeAsync(8_100);
    const r = await read(await p);
    expect(r.body.events.map((e: Row) => e.title)).toEqual(["Standup"]);
    expect(r.body.warnings).toEqual([expect.objectContaining({ calendarName: "Slow", reason: "timeout" })]);
  });

  it("an account that chose no calendars reads nothing", async () => {
    DB.calendar_connections[0].selected_calendars = [];
    const r = await read(await get("action=events"));
    expect(r.body).toEqual({ events: [], warnings: [] });
    expect(fetchLog.filter((x) => x.includes("/events"))).toHaveLength(0);
  });
});

describe("disconnect", () => {
  it("one account by id; the old provider-wide way still works; never someone else's", async () => {
    DB.calendar_connections.push({ id: "33333333-0000-4000-8000-000000000003", user_id: ANA, provider: "google", account_email: "ana@gmail.example", access_token: "at-personal", created_at: "2026-02-01T00:00:00Z", selected_calendars: null });
    await read(await post({ action: "disconnect", connection: WORK }));
    expect(DB.calendar_connections.filter((c) => c.user_id === ANA).map((c) => c.account_email)).toEqual(["ana@gmail.example"]);
    await read(await post({ action: "disconnect", connection: BOBS }));
    expect(DB.calendar_connections.some((c) => c.id === BOBS)).toBe(true);
    await read(await get("action=disconnect&provider=google"));
    expect(DB.calendar_connections.filter((c) => c.user_id === ANA)).toEqual([]);
    expect(DB.calendar_connections.filter((c) => c.user_id === BOB)).toHaveLength(1);
    expect((await read(await post({ action: "disconnect" }))).status).toBe(400);
  });
});

describe("before 0045 (no selected_calendars, one account per provider)", () => {
  beforeEach(() => {
    PRE_0045 = true;
    for (const c of DB.calendar_connections) delete c.selected_calendars;
  });

  it("list works, says multi: false, every account on its primary", async () => {
    const r = await read(await get("action=list"));
    expect(r.body).toMatchObject({ multi: false, connections: [{ id: WORK, provider: "google", accountEmail: "ana@work.example", selectedCalendars: null }] });
  });

  it("a second Google account replaces the first, as before", async () => {
    const r = await addAccount("google", "code-personal");
    expect(r.body).toMatchObject({ ok: true, connectionId: WORK, replaced: true, accountEmail: "ana@gmail.example" });
    expect(DB.calendar_connections.filter((c) => c.user_id === ANA)).toHaveLength(1);
    expect(DB.calendar_connections[0]).toMatchObject({ account_email: "ana@gmail.example", access_token: "at-code-personal" });
  });

  it("an account's primary swatch and its events agree on one colour (nothing can be saved yet)", async () => {
    DB.calendar_connections[0].access_token = "at-legacy"; // its primary's own colour is #9fc6e7
    const cals = await read(await get(`action=calendars&connection=${WORK}`));
    const swatch = cals.body.calendars.find((c: Row) => c.primary).color;
    const e = await read(await get("action=events"));
    expect(e.body.events[0]).toMatchObject({ calendarId: "primary", color: swatch });
    expect(cals.body.calendars[1].color).not.toBe(swatch);
    expect(DB.calendar_connections[0]).not.toHaveProperty("selected_calendars");
  });

  it("calendars can be listed but not chosen yet, with a clear reason; events read the primary", async () => {
    expect((await read(await get(`action=calendars&connection=${WORK}`))).body.calendars[0]).toMatchObject({ primary: true, selected: true });
    const s = await read(await post({ action: "select", connection: WORK, calendarIds: ["ana@work.example"] }));
    expect(s.status).toBe(409);
    expect(s.body.reason).toBe("needs_migration");
    const e = await read(await get("action=events"));
    expect(e.body.events.map((x: Row) => [x.title, x.calendarId])).toEqual([["Primary thing", "primary"]]);
  });
});
