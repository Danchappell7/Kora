/* calendarFeed: the private ICS subscription link (0043's calendar_feed_tokens). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as demoLib from "./calendarFeed";

const TOKEN = "0123456789abcdef".repeat(4);
const TOKEN2 = "fedcba9876543210".repeat(4);
type Res = { data?: unknown; error?: unknown };

/** A stand-in for the bits of supabase-js the lib touches. */
function fake(opts: {
  uid?: string | null;
  rpc?: (name: string) => Res | Promise<Res>;
  update?: (patch: Record<string, unknown>, eq: [string, unknown]) => Res;
}) {
  const calls: { kind: string; name: string; args?: unknown }[] = [];
  const client = {
    auth: { getSession: async () => ({ data: { session: opts.uid === null ? null : { user: { id: opts.uid ?? "user-1" } } }, error: null }) },
    rpc(name: string, args?: unknown) {
      calls.push({ kind: "rpc", name, args });
      return Promise.resolve().then(() => opts.rpc?.(name) ?? { data: null }).then((r) => ({ data: r.data ?? null, error: r.error ?? null }));
    },
    from(table: string) {
      let patch: Record<string, unknown> = {};
      let eq: [string, unknown] = ["", null];
      const chain = {
        update(p: Record<string, unknown>) { patch = p; return chain; },
        eq(k: string, v: unknown) { eq = [k, v]; return chain; },
        select() { return chain; },
        maybeSingle() {
          calls.push({ kind: "update", name: table, args: { patch, eq } });
          const r = opts.update?.(patch, eq) ?? { data: null };
          return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
        },
      };
      return chain;
    },
  };
  return { client, calls };
}

async function load(f: ReturnType<typeof fake>) {
  vi.resetModules();
  vi.doMock("./supabase", () => ({ supabase: f.client, isSupabaseConfigured: true }));
  return import("./calendarFeed");
}

afterEach(() => { vi.doUnmock("./supabase"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const SB = "https://abc.supabase.co";
const PING = `${SB}/functions/v1/ics-feed?ping=1`;
type PingAnswer = { ok: boolean; status: number };
const answer = (status: number): PingAnswer => ({ ok: status >= 200 && status < 300, status });

describe("parseCalendarFeed", () => {
  const { parseCalendarFeed } = demoLib;
  it("reads calendar_feed()'s JSON", () => {
    expect(parseCalendarFeed({ token: TOKEN, include_due: false, created_at: "2026-10-04T09:00:00Z" }))
      .toEqual({ token: TOKEN, includeDue: false, createdAt: "2026-10-04T09:00:00Z" });
    expect(parseCalendarFeed({ token: TOKEN })).toEqual({ token: TOKEN, includeDue: true });
    expect(parseCalendarFeed(JSON.stringify({ token: TOKEN, include_due: true }))).toEqual({ token: TOKEN, includeDue: true });
    expect(parseCalendarFeed([{ token: TOKEN, includeDue: false }])).toEqual({ token: TOKEN, includeDue: false });
  });
  it("refuses anything that isn't a real token", () => {
    for (const raw of [null, undefined, 42, "nope", {}, { token: "short" }, { token: TOKEN + "!" }, { token: 123 }, "{bad json"]) {
      expect(parseCalendarFeed(raw)).toBeNull();
    }
  });
});

describe("URLs", () => {
  const url = demoLib.calendarFeedUrl(TOKEN, "https://abc.supabase.co/");
  it("builds the function URL with the token", () => {
    expect(url).toBe(`https://abc.supabase.co/functions/v1/ics-feed?t=${TOKEN}`);
    expect(demoLib.calendarFeedUrl("a b&c", "https://x.co")).toBe("https://x.co/functions/v1/ics-feed?t=a%20b%26c");
  });
  it("webcal, Google and Outlook links", () => {
    expect(demoLib.webcalUrl(url)).toBe(`webcal://abc.supabase.co/functions/v1/ics-feed?t=${TOKEN}`);
    expect(demoLib.webcalUrl("HTTP://x.co/a")).toBe("webcal://x.co/a");
    const g = new URL(demoLib.googleCalendarSubscribeUrl(url));
    expect(g.origin + g.pathname).toBe("https://calendar.google.com/calendar/r");
    expect(g.searchParams.get("cid")).toBe(demoLib.webcalUrl(url));
    const o = new URL(demoLib.outlookSubscribeUrl(url));
    expect(o.origin + o.pathname).toBe("https://outlook.live.com/calendar/0/addfromweb");
    expect(o.searchParams.get("url")).toBe(url);
    expect(o.searchParams.get("name")).toBe("Kanbo");
    const w = new URL(demoLib.outlook365SubscribeUrl(url, "Kanbo plan"));
    expect(w.origin).toBe("https://outlook.office.com");
    expect(w.searchParams.get("url")).toBe(url);
    expect(w.searchParams.get("name")).toBe("Kanbo plan");
  });
  it("the function's ping URL", () => {
    expect(demoLib.calendarFeedPingUrl("https://abc.supabase.co/")).toBe(PING);
  });
  it("the demo shows an example link with the demo token", () => {
    expect(demoLib.demoCalendarFeedUrl()).toBe(`${demoLib.DEMO_FEED_BASE}/functions/v1/ics-feed?t=demo`);
    expect(demoLib.DEMO_FEED_TOKEN).toBe("demo");
  });
});

describe("demo mode (no Supabase)", () => {
  it("is demo, has no feed, and changes resolve null without a network call", async () => {
    expect(await demoLib.loadCalendarFeed()).toEqual({ state: "demo" });
    expect(await demoLib.getCalendarFeed()).toBeNull();
    expect(await demoLib.setCalendarFeedIncludeDue(false)).toBeNull();
    expect(await demoLib.resetCalendarFeed()).toBeNull();
  });
});

describe("signed in", () => {
  let ping: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<PingAnswer>>>;
  beforeEach(() => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.stubEnv("VITE_SUPABASE_URL", SB);
    ping = vi.fn(async () => answer(204));
    vi.stubGlobal("fetch", ping);
  });

  it("loads (and makes) the feed with calendar_feed(), then serves it from memory", async () => {
    const f = fake({ rpc: () => ({ data: { token: TOKEN, include_due: true, created_at: "2026-10-04T09:00:00Z" } }) });
    const lib = await load(f);
    expect(await lib.loadCalendarFeed()).toEqual({ state: "ready", feed: { token: TOKEN, includeDue: true, createdAt: "2026-10-04T09:00:00Z" } });
    expect(await lib.getCalendarFeed()).toEqual({ token: TOKEN, includeDue: true, createdAt: "2026-10-04T09:00:00Z" });
    expect(f.calls.filter((c) => c.kind === "rpc")).toEqual([{ kind: "rpc", name: "calendar_feed", args: undefined }]);
    await lib.loadCalendarFeed({ refresh: true });
    expect(f.calls.filter((c) => c.kind === "rpc")).toHaveLength(2);
  });

  it("asks again for a different account", async () => {
    let uid = "user-1";
    const f = fake({ rpc: () => ({ data: { token: uid === "user-1" ? TOKEN : TOKEN2 } }) });
    f.client.auth.getSession = async () => ({ data: { session: { user: { id: uid } } }, error: null });
    const lib = await load(f);
    expect((await lib.getCalendarFeed())?.token).toBe(TOKEN);
    uid = "user-2";
    expect((await lib.getCalendarFeed())?.token).toBe(TOKEN2);
  });

  it("signed out: no call, signedOut; changes say to sign in", async () => {
    const f = fake({ uid: null });
    const lib = await load(f);
    expect(await lib.loadCalendarFeed()).toEqual({ state: "signedOut" });
    await expect(lib.setCalendarFeedIncludeDue(true)).rejects.toThrow("Sign in again to manage your calendar link.");
    await expect(lib.resetCalendarFeed()).rejects.toThrow("Sign in again");
    expect(f.calls).toHaveLength(0);
  });

  it("before 0043: unavailable, remembered for the session until a refresh", async () => {
    for (const error of [{ code: "PGRST202", message: "Could not find the function public.calendar_feed" }, { code: "42883", message: "function does not exist" }, { code: "42P01", message: 'relation "calendar_feed_tokens" does not exist' }]) {
      const f = fake({ rpc: () => ({ error }) });
      const lib = await load(f);
      expect(await lib.loadCalendarFeed()).toEqual({ state: "unavailable" });
      expect(await lib.loadCalendarFeed()).toEqual({ state: "unavailable" });
      expect(f.calls).toHaveLength(1);
      expect(await lib.getCalendarFeed()).toBeNull();
      await lib.loadCalendarFeed({ refresh: true });
      expect(f.calls).toHaveLength(2);
    }
  });

  it("a suspended or unapproved account (not authorized) reads as signed out", async () => {
    const lib = await load(fake({ rpc: () => ({ error: { code: "P0001", message: "not authorized" } }) }));
    expect(await lib.loadCalendarFeed()).toEqual({ state: "signedOut" });
  });

  it("a network or server problem is an error with a sentence (not cached)", async () => {
    const net = await load(fake({ rpc: () => { throw new TypeError("Failed to fetch"); } }));
    expect(await net.loadCalendarFeed()).toEqual({ state: "error", message: "You're offline. Try again when you're back online." });
    const srv = await load(fake({ rpc: () => ({ error: { code: "XX000", message: "boom" } }) }));
    expect(await srv.loadCalendarFeed()).toEqual({ state: "error", message: "Kanbo couldn't reach the server. Try again in a moment." });
    const junk = await load(fake({ rpc: () => ({ data: { token: "nope" } }) }));
    expect((await junk.loadCalendarFeed()).state).toBe("error");
  });

  it("offline: says so without calling the server", async () => {
    const f = fake({ rpc: () => ({ data: { token: TOKEN } }) });
    const lib = await load(f);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(await lib.loadCalendarFeed()).toEqual({ state: "error", message: "You're offline. Try again when you're back online." });
    await expect(lib.setCalendarFeedIncludeDue(false)).rejects.toThrow("You're offline");
    await expect(lib.resetCalendarFeed()).rejects.toThrow("You're offline");
    expect(f.calls).toHaveLength(0);
    expect(ping).not.toHaveBeenCalled();
  });

  describe("is the ics-feed function deployed?", () => {
    const ok = () => fake({ rpc: () => ({ data: { token: TOKEN, include_due: true } }) });

    it("asks once a session, the way a calendar app would (no credentials, no auth header)", async () => {
      const f = ok();
      const lib = await load(f);
      expect((await lib.loadCalendarFeed()).state).toBe("ready");
      expect(ping).toHaveBeenCalledTimes(1);
      const [url, init] = ping.mock.calls[0];
      expect(url).toBe(PING);
      expect(init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store" });
      expect(init?.headers).toBeUndefined();
      expect((await lib.loadCalendarFeed()).state).toBe("ready");
      expect((await lib.loadCalendarFeed({ refresh: true })).state).toBe("ready");
      expect(ping).toHaveBeenCalledTimes(1);
      expect(f.calls.filter((c) => c.kind === "rpc")).toHaveLength(2);
    });

    it("0043 run but the function not deployed (404): not switched on yet, no link, remembered until a refresh", async () => {
      ping.mockResolvedValue(answer(404));
      const f = ok();
      const lib = await load(f);
      expect(await lib.loadCalendarFeed()).toEqual({ state: "unavailable" });
      expect(await lib.getCalendarFeed()).toBeNull();
      expect(ping).toHaveBeenCalledTimes(1);
      expect(f.calls).toHaveLength(1);
      // deployed now: a refresh asks again
      ping.mockResolvedValue(answer(204));
      expect((await lib.loadCalendarFeed({ refresh: true })).state).toBe("ready");
      expect(ping).toHaveBeenCalledTimes(2);
    });

    it("deployed with JWT checks on (401): calendar apps can't read it either, so not switched on yet", async () => {
      ping.mockResolvedValue(answer(401));
      const lib = await load(ok());
      expect(await lib.loadCalendarFeed()).toEqual({ state: "unavailable" });
    });

    it("a network or CORS error, or a 5xx: not switched on yet this time, and asks again next time", async () => {
      ping.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(answer(503)).mockResolvedValue(answer(204));
      const lib = await load(ok());
      expect(await lib.loadCalendarFeed()).toEqual({ state: "unavailable" });
      expect(await lib.loadCalendarFeed()).toEqual({ state: "unavailable" });
      expect((await lib.loadCalendarFeed()).state).toBe("ready");
      expect(ping).toHaveBeenCalledTimes(3);
    });

    it("gives up after 10 seconds", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      ping.mockImplementation((_url, init) => new Promise((_ok, fail) => {
        init?.signal?.addEventListener("abort", () => fail(new DOMException("The operation was aborted.", "AbortError")));
      }));
      const lib = await load(ok());
      const p = lib.loadCalendarFeed();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toEqual({ state: "unavailable" });
    });

    it("the row's own answer comes first: 0043 missing, signed out, or a server error", async () => {
      expect(await (await load(fake({ rpc: () => ({ error: { code: "PGRST202", message: "Could not find the function" } }) }))).loadCalendarFeed()).toEqual({ state: "unavailable" });
      ping.mockResolvedValue(answer(404));
      expect(await (await load(fake({ rpc: () => ({ error: { code: "P0001", message: "not authorized" } }) }))).loadCalendarFeed()).toEqual({ state: "signedOut" });
      expect((await (await load(fake({ rpc: () => ({ error: { code: "XX000", message: "boom" } }) }))).loadCalendarFeed()).state).toBe("error");
    });

    it("never asks a relative address (no Supabase URL)", async () => {
      vi.stubEnv("VITE_SUPABASE_URL", "");
      const lib = await load(ok());
      expect(await lib.loadCalendarFeed()).toEqual({ state: "unavailable" });
      expect(ping).not.toHaveBeenCalled();
    });

    it("clearCalendarFeedCache asks the function again", async () => {
      const lib = await load(ok());
      await lib.loadCalendarFeed();
      lib.clearCalendarFeedCache();
      await lib.loadCalendarFeed();
      expect(ping).toHaveBeenCalledTimes(2);
    });
  });

  it("include due dates: updates the caller's own row and returns what saved", async () => {
    const f = fake({
      rpc: () => ({ data: { token: TOKEN, include_due: true } }),
      update: (patch) => ({ data: { token: TOKEN, include_due: patch.include_due } }),
    });
    const lib = await load(f);
    await lib.loadCalendarFeed();
    expect(await lib.setCalendarFeedIncludeDue(false)).toEqual({ token: TOKEN, includeDue: false });
    expect(f.calls[f.calls.length - 1]).toEqual({ kind: "update", name: "calendar_feed_tokens", args: { patch: { include_due: false }, eq: ["user_id", "user-1"] } });
    // and the cached copy follows
    expect(await lib.getCalendarFeed()).toEqual({ token: TOKEN, includeDue: false });
  });

  it("include due dates with no row yet: makes it, then saves", async () => {
    let made = false;
    const f = fake({
      rpc: () => { made = true; return { data: { token: TOKEN, include_due: true } }; },
      update: (patch) => (made ? { data: { token: TOKEN, include_due: patch.include_due } } : { data: null }),
    });
    const lib = await load(f);
    expect(await lib.setCalendarFeedIncludeDue(false)).toEqual({ token: TOKEN, includeDue: false });
    expect(f.calls.map((c) => c.kind)).toEqual(["update", "rpc", "update"]);
  });

  it("include due dates: a refusal throws a sentence; before 0043 resolves null", async () => {
    const bad = await load(fake({ update: () => ({ error: { code: "XX000", message: "boom" } }) }));
    await expect(bad.setCalendarFeedIncludeDue(true)).rejects.toThrow("Kanbo couldn't reach the server. Try again in a moment.");
    const missing = await load(fake({ update: () => ({ error: { code: "PGRST205", message: "Could not find the table 'public.calendar_feed_tokens' in the schema cache" } }) }));
    expect(await missing.setCalendarFeedIncludeDue(true)).toBeNull();
  });

  it("reset: rotate_calendar_feed_token() gives a new token and the cache follows", async () => {
    const f = fake({ rpc: (name) => ({ data: { token: name === "rotate_calendar_feed_token" ? TOKEN2 : TOKEN, include_due: false } }) });
    const lib = await load(f);
    expect((await lib.getCalendarFeed())?.token).toBe(TOKEN);
    expect(await lib.resetCalendarFeed()).toEqual({ token: TOKEN2, includeDue: false });
    expect((await lib.getCalendarFeed())?.token).toBe(TOKEN2);
    expect(f.calls.filter((c) => c.kind === "rpc").map((c) => c.name)).toEqual(["calendar_feed", "rotate_calendar_feed_token"]);
  });

  it("reset: failures throw a sentence; before 0043 resolves null", async () => {
    const net = await load(fake({ rpc: () => { throw new TypeError("Failed to fetch"); } }));
    await expect(net.resetCalendarFeed()).rejects.toThrow("You're offline");
    const denied = await load(fake({ rpc: () => ({ error: { code: "P0001", message: "not authorized" } }) }));
    await expect(denied.resetCalendarFeed()).rejects.toThrow("Sign in again");
    const junk = await load(fake({ rpc: () => ({ data: null }) }));
    await expect(junk.resetCalendarFeed()).rejects.toThrow("Kanbo couldn't reach the server");
    const missing = await load(fake({ rpc: () => ({ error: { code: "PGRST202", message: "Could not find the function" } }) }));
    expect(await missing.resetCalendarFeed()).toBeNull();
  });

  it("clearCalendarFeedCache forgets the feed", async () => {
    const f = fake({ rpc: () => ({ data: { token: TOKEN } }) });
    const lib = await load(f);
    await lib.getCalendarFeed();
    lib.clearCalendarFeedCache();
    await lib.getCalendarFeed();
    expect(f.calls).toHaveLength(2);
  });
});
