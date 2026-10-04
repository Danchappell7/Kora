/* lib/push: availability, the subscribe / save / unsubscribe flow against a
   fake browser (service worker, PushManager, Notification) and a fake
   Supabase client, the test notification, the demo stand-in and the
   service worker's messages. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  configured: true,
  client: null as unknown,
}));
vi.mock("./supabase", () => ({
  get isSupabaseConfigured() { return h.configured; },
  get supabase() { return h.configured ? h.client : null; },
}));

// a well-formed (65-byte, uncompressed-point shaped) VAPID public key; not a real key
const KEY_BYTES = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));
const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const KEY = b64url(KEY_BYTES);

type Perm = "default" | "granted" | "denied";

/** A fake browser: Notification, PushManager, a service worker registration. */
function fakeBrowser(opts: { perm?: Perm; answer?: Perm; registered?: boolean; existingKey?: Uint8Array | null } = {}) {
  const state = { perm: (opts.perm ?? "default") as Perm, sub: null as null | ReturnType<typeof makeSub> };
  function makeSub(endpoint: string, key: Uint8Array) {
    return {
      endpoint,
      options: { applicationServerKey: key.buffer.slice(0) },
      toJSON: () => ({ endpoint, keys: { p256dh: "BPUBKEY", auth: "AUTHSECRET" } }),
      unsubscribe: vi.fn(async () => { if (state.sub?.endpoint === endpoint) state.sub = null; return true; }),
    };
  }
  if (opts.existingKey) state.sub = makeSub("https://fcm.googleapis.com/fcm/send/old", opts.existingKey);
  let n = 0;
  const pushManager = {
    getSubscription: vi.fn(async () => state.sub),
    subscribe: vi.fn(async ({ applicationServerKey }: { applicationServerKey: ArrayBuffer | Uint8Array }) => {
      state.sub = makeSub(`https://fcm.googleapis.com/fcm/send/dev-${++n}`, new Uint8Array(applicationServerKey));
      return state.sub;
    }),
  };
  const reg = { active: {}, pushManager, showNotification: vi.fn(async () => {}) };
  let registered = opts.registered ?? true;
  const listeners = new Set<(e: MessageEvent) => void>();
  const sw = {
    getRegistration: vi.fn(async () => (registered ? reg : undefined)),
    register: vi.fn(async () => { registered = true; return reg; }),
    get ready() { return Promise.resolve(reg); },
    addEventListener: (_t: string, fn: (e: MessageEvent) => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: (e: MessageEvent) => void) => listeners.delete(fn),
  };
  const shown: string[] = [];
  class FakeNotification {
    static get permission() { return state.perm; }
    static requestPermission = vi.fn(async () => { if (state.perm === "default") state.perm = opts.answer ?? "granted"; return state.perm; });
    constructor(title: string) { shown.push(title); }
  }
  Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
  (window as unknown as Record<string, unknown>).PushManager = function PushManager() {};
  (globalThis as unknown as Record<string, unknown>).Notification = FakeNotification;
  return { state, reg, sw, pushManager, FakeNotification, shown, listeners };
}

/** A fake supabase client: rpc, push_subscriptions rows (own rows only), functions.invoke, the session. */
function fakeSupabase(o: { rpcError?: unknown; invoke?: () => Promise<{ data: unknown; error: unknown }>; uid?: string } = {}) {
  const rows: { endpoint: string }[] = [];
  const calls = { rpc: [] as unknown[], deleted: [] as string[], invoked: [] as unknown[] };
  const client = {
    rpc: vi.fn(async (_fn: string, args: { p_endpoint: string }) => {
      calls.rpc.push(args);
      if (o.rpcError) return { data: null, error: o.rpcError };
      rows.push({ endpoint: args.p_endpoint });
      return { data: "row-id", error: null };
    }),
    from: vi.fn(() => ({
      select: () => ({ eq: (_k: string, v: string) => ({ maybeSingle: async () => ({ data: rows.find((r) => r.endpoint === v) ?? null, error: null }) }) }),
      delete: () => ({ eq: async (_k: string, v: string) => { calls.deleted.push(v); const i = rows.findIndex((r) => r.endpoint === v); if (i >= 0) rows.splice(i, 1); return { error: null }; } }),
    })),
    functions: { invoke: vi.fn(async (_n: string, opts: unknown) => { calls.invoked.push(opts); return o.invoke ? o.invoke() : { data: { ok: true }, error: null }; }) },
    auth: { getSession: async () => ({ data: { session: { user: { id: o.uid ?? "me" } } } }) },
  };
  return { client, rows, calls };
}

async function load(env: { key?: string; configured?: boolean } = {}) {
  h.configured = env.configured ?? true;
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY", env.key ?? KEY);
  vi.resetModules();
  return await import("./push");
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as unknown as Record<string, unknown>).PushManager;
  delete (globalThis as unknown as Record<string, unknown>).Notification;
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe("availability", () => {
  it("is unconfigured in demo mode or without a usable VAPID key", async () => {
    fakeBrowser();
    expect((await load({ configured: false })).pushAvailability()).toBe("unconfigured");
    expect((await load({ key: "" })).pushAvailability()).toBe("unconfigured");
    expect((await load({ key: "not-a-key" })).pushAvailability()).toBe("unconfigured");
    expect((await load({ key: b64url(new Uint8Array(32)) })).pushAvailability()).toBe("unconfigured");
  });
  it("is unsupported without the browser APIs, denied when blocked, ready otherwise", async () => {
    const push = await load();
    expect(push.pushAvailability()).toBe("unsupported");
    const b = fakeBrowser({ perm: "denied" });
    expect(push.pushAvailability()).toBe("denied");
    b.state.perm = "default";
    expect(push.pushAvailability()).toBe("ready");
  });
  it("decodes base64url keys", async () => {
    const push = await load();
    expect([...push.urlBase64ToUint8Array(KEY)]).toEqual([...KEY_BYTES]);
    expect([...push.urlBase64ToUint8Array("-_8")]).toEqual([251, 255]);
    expect(() => push.urlBase64ToUint8Array("a")).toThrow();
  });
});

describe("enablePush / isPushOnHere / disablePush", () => {
  it("asks, subscribes with Kanbo's key, saves through save_push_subscription, and reads back as on", async () => {
    const b = fakeBrowser();
    const s = fakeSupabase();
    h.client = s.client;
    const push = await load();
    expect(await push.isPushOnHere()).toBe(false);
    const changed = vi.fn();
    push.onPushChange(changed);
    expect(await push.enablePush()).toEqual({ ok: true });
    expect(b.FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    const [opts] = b.pushManager.subscribe.mock.calls[0] as unknown as [{ userVisibleOnly: boolean; applicationServerKey: ArrayBuffer }];
    expect(opts.userVisibleOnly).toBe(true);
    expect([...new Uint8Array(opts.applicationServerKey)]).toEqual([...KEY_BYTES]);
    expect(s.client.rpc).toHaveBeenCalledWith("save_push_subscription", expect.objectContaining({
      p_endpoint: "https://fcm.googleapis.com/fcm/send/dev-1", p_p256dh: "BPUBKEY", p_auth: "AUTHSECRET",
    }));
    expect(changed).toHaveBeenCalled();
    expect(await push.isPushOnHere()).toBe(true);

    await push.disablePush();
    expect(s.calls.deleted).toEqual(["https://fcm.googleapis.com/fcm/send/dev-1"]);
    expect(b.state.sub).toBeNull();
    expect(await push.isPushOnHere()).toBe(false);
  });

  it("registers the service worker itself when there isn't one yet", async () => {
    const b = fakeBrowser({ registered: false });
    h.client = fakeSupabase().client;
    const push = await load();
    expect(await push.enablePush()).toEqual({ ok: true });
    expect(b.sw.register).toHaveBeenCalledWith(expect.stringMatching(/^\/sw\.js/), { scope: "/" });
  });

  it("explains a block and a dismissed prompt, without subscribing", async () => {
    h.client = fakeSupabase().client;
    let b = fakeBrowser({ answer: "denied" });
    let push = await load();
    const denied = await push.enablePush();
    expect(denied).toMatchObject({ ok: false, reason: "denied" });
    expect(denied.ok === false && denied.message).toMatch(/blocked/i);
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();

    b = fakeBrowser({ answer: "default" });
    push = await load();
    expect(await push.enablePush()).toMatchObject({ ok: false, reason: "dismissed" });
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("before 0043: save fails with a sentence, and the browser subscription is undone", async () => {
    const b = fakeBrowser({ perm: "granted" });
    h.client = fakeSupabase({ rpcError: { code: "PGRST202", message: "Could not find the function public.save_push_subscription" } }).client;
    const push = await load();
    const r = await push.enablePush();
    expect(r).toEqual({ ok: false, reason: "save_failed", message: "Push notifications aren't switched on for Kanbo yet." });
    expect(b.state.sub).toBeNull();
    expect(await push.isPushOnHere()).toBe(false);
  });

  it("replaces a subscription made with an old key", async () => {
    const b = fakeBrowser({ perm: "granted", existingKey: new Uint8Array(65).fill(9) });
    const old = b.state.sub!;
    h.client = fakeSupabase().client;
    const push = await load();
    expect(await push.isPushOnHere()).toBe(false);
    expect(await push.enablePush()).toEqual({ ok: true });
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(b.state.sub?.endpoint).toBe("https://fcm.googleapis.com/fcm/send/dev-1");
  });

  it("maps server errors to sentences", async () => {
    const push = await load();
    expect(push.saveErrorMessage({ message: "not authorized" })).toBe("Sign in again, then switch this on.");
    expect(push.saveErrorMessage({ message: "invalid subscription" })).toMatch(/can't use/);
    expect(push.saveErrorMessage({ code: "42P01", message: "relation does not exist" })).toMatch(/aren't switched on/);
    expect(push.saveErrorMessage(new TypeError("Failed to fetch"))).toMatch(/offline/);
    expect(push.saveErrorMessage({ message: "boom" })).toBe("Couldn't switch on notifications. Try again.");
  });

  it("disablePush is safe to call any time (nothing on, no browser support, signed out)", async () => {
    let push = await load();
    await expect(push.disablePush()).resolves.toBeUndefined();
    fakeBrowser();
    h.client = fakeSupabase().client;
    push = await load();
    await expect(push.disablePush()).resolves.toBeUndefined();
    push = await load({ configured: false });
    await expect(push.disablePush()).resolves.toBeUndefined();
  });
});

describe("sendTestPush", () => {
  it("asks notify for a test to this device's endpoint", async () => {
    fakeBrowser({ perm: "granted" });
    const s = fakeSupabase();
    h.client = s.client;
    const push = await load();
    expect(await push.sendTestPush()).toMatchObject({ ok: false }); // not on yet
    await push.enablePush();
    const r = await push.sendTestPush();
    expect(r.ok).toBe(true);
    expect(s.client.functions.invoke).toHaveBeenCalledWith("notify", { body: { kind: "test", endpoint: "https://fcm.googleapis.com/fcm/send/dev-1" } });
  });

  it("explains the server's answers", async () => {
    fakeBrowser({ perm: "granted" });
    const answer = (status: number, body: unknown) => async () => ({
      data: null, error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { name: "FunctionsHttpError", context: new Response(JSON.stringify(body), { status }) }),
    });
    for (const [status, body, re] of [
      [429, { reason: "rate_limited" }, /few tests already/],
      [409, { reason: "no_subscription" }, /isn't subscribed/],
      [503, { reason: "unconfigured" }, /can't send push/],
      [400, { error: "bad kind" }, /can't send push/], // an older notify that doesn't know "test"
    ] as const) {
      h.client = fakeSupabase({ invoke: answer(status, body) }).client;
      const push = await load();
      await push.enablePush();
      const r = await push.sendTestPush();
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(re);
    }
  });
});

describe("demo stand-in", () => {
  it("switches on locally (asking the browser first) and shows the test right here", async () => {
    const b = fakeBrowser();
    const push = await load({ configured: false });
    expect(push.isPushDemo()).toBe(true);
    expect(push.pushAvailability()).toBe("unconfigured");
    expect(await push.sendTestPush()).toMatchObject({ ok: false });
    expect(await push.enablePush()).toEqual({ ok: true });
    expect(await push.isPushOnHere()).toBe(true);
    const r = await push.sendTestPush();
    expect(r).toEqual({ ok: true, message: "Test notification sent." });
    expect(b.reg.showNotification).toHaveBeenCalledWith("Notifications are on", expect.objectContaining({ body: expect.any(String), icon: "/icon-192.png" }));
    await push.disablePush();
    expect(await push.isPushOnHere()).toBe(false);
  });

  it("works without any notification support at all", async () => {
    const push = await load({ configured: false });
    expect(await push.enablePush()).toEqual({ ok: true });
    expect(await push.sendTestPush()).toEqual({ ok: true, message: "In the demo, your test notification would arrive on this device now." });
  });
});

describe("refreshPushSubscription", () => {
  it("re-saves a replaced subscription for the account that switched push on, and nobody else", async () => {
    const b = fakeBrowser({ perm: "granted" });
    const s = fakeSupabase({ uid: "me" });
    h.client = s.client;
    const push = await load();
    await push.enablePush();
    expect(s.calls.rpc).toHaveLength(1);
    await push.refreshPushSubscription(); // same endpoint: no write
    expect(s.calls.rpc).toHaveLength(1);
    // the browser rotated the subscription (sw.js resubscribed)
    await b.pushManager.subscribe({ applicationServerKey: KEY_BYTES });
    await push.refreshPushSubscription();
    expect(s.calls.rpc).toHaveLength(2);
    // another account signs in on this browser: never inherits push
    await b.pushManager.subscribe({ applicationServerKey: KEY_BYTES });
    h.client = fakeSupabase({ uid: "someone-else" }).client;
    const push2 = await load();
    await push2.refreshPushSubscription();
    expect((h.client as ReturnType<typeof fakeSupabase>["client"]).rpc).not.toHaveBeenCalled();
  });
});

describe("listenForPushMessages", () => {
  it("routes a notification click in place and answers the worker; ignores other origins", async () => {
    const b = fakeBrowser();
    const push = await load();
    const go = vi.fn();
    const stop = push.listenForPushMessages(go);
    const port = { postMessage: vi.fn() };
    for (const fn of b.listeners) fn({ data: { type: "kanbo:navigate", url: "/?task=t1" }, ports: [port] } as unknown as MessageEvent);
    expect(go).toHaveBeenCalledWith("/?task=t1");
    expect(port.postMessage).toHaveBeenCalledWith({ ok: true });
    const port2 = { postMessage: vi.fn() };
    for (const fn of b.listeners) fn({ data: { type: "kanbo:navigate", url: "//evil.io/x" }, ports: [port2] } as unknown as MessageEvent);
    expect(go).toHaveBeenCalledTimes(1);
    expect(port2.postMessage).toHaveBeenCalledWith({ ok: false });
    stop();
    expect(b.listeners.size).toBe(0);
  });
});
