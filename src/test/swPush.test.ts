// @vitest-environment node
/* public/sw.js: push → notification, notification click → the deep link
   (same origin only), the dev push-only mode, pushsubscriptionchange. */
import { describe, expect, it, vi } from "vitest";
import swSrc from "../../public/sw.js?raw";

const O = "https://www.kanbo.co.uk";
type Listener = (e: unknown) => void;

function boot(opts: { search?: string; wins?: FakeWin[]; openWindow?: boolean } = {}) {
  const listeners: Record<string, Listener> = {};
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const self = {
    addEventListener: (t: string, fn: Listener) => { listeners[t] = fn; },
    location: { origin: O, search: opts.search ?? "" },
    skipWaiting: () => {},
    registration: { showNotification, pushManager: { subscribe: vi.fn(async () => ({})) } },
    clients: {
      claim: () => {},
      matchAll: vi.fn(async () => opts.wins ?? []),
      openWindow: opts.openWindow === false ? undefined : openWindow,
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const caches = { open: async () => ({ addAll: async () => {}, put: async () => {} }), keys: async () => [], match: async () => undefined };
  new Function("self", "caches", swSrc)(self, caches);
  return { listeners, self, showNotification, openWindow };
}

/** run a handler and wait for everything it handed to waitUntil */
async function fire(l: Listener, e: Record<string, unknown>) {
  const waits: Promise<unknown>[] = [];
  l({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
}
const pushData = (o: unknown) => ({ json: () => o, text: () => JSON.stringify(o) });

interface FakeWin { url: string; focused?: boolean; visibilityState?: string; focus: ReturnType<typeof vi.fn>; navigate?: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }
function win(url: string, o: { answers?: boolean; focused?: boolean } = {}): FakeWin {
  return {
    url, focused: o.focused,
    focus: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    postMessage: vi.fn((_m: unknown, ports?: MessagePort[]) => { if (o.answers) ports?.[0]?.postMessage({ ok: true }); }),
  };
}

describe("sw.js push", () => {
  it("shows the payload as a notification with Kanbo's icon, badge and collapse tag", async () => {
    const { listeners, showNotification } = boot();
    await fire(listeners.push, { data: pushData({ title: "Ana assigned you a task", body: "Write the brief", url: "/?task=t1", tag: "task-t1", kind: "assigned" }) });
    expect(showNotification).toHaveBeenCalledWith("Ana assigned you a task", expect.objectContaining({
      body: "Write the brief", icon: "/icon-192.png", badge: "/badge-96.png", tag: "task-t1", renotify: true,
      data: { url: "/?task=t1", kind: "assigned" },
    }));
  });

  it("always shows something, even for an empty or broken push", async () => {
    const { listeners, showNotification } = boot();
    await fire(listeners.push, { data: null });
    await fire(listeners.push, { data: { json: () => { throw new Error("not json"); }, text: () => "plain words" } });
    expect(showNotification).toHaveBeenNthCalledWith(1, "Kanbo", expect.objectContaining({ body: "", data: { url: "/", kind: "" } }));
    expect(showNotification).toHaveBeenNthCalledWith(2, "Kanbo", expect.objectContaining({ body: "plain words" }));
  });

  it("never links off-site", async () => {
    const { listeners, showNotification } = boot();
    for (const url of ["https://evil.io/x", "//evil.io/x", "/\\evil.io", "javascript:alert(1)", 42]) {
      await fire(listeners.push, { data: pushData({ title: "x", url }) });
    }
    for (const call of showNotification.mock.calls as unknown as [string, { data: { url: string } }][]) expect(call[1].data.url).toBe("/");
  });
});

describe("sw.js notificationclick", () => {
  const click = (url: string) => ({ notification: { data: { url }, close: vi.fn() } });

  it("focuses an open Kanbo window and lets the app route in place", async () => {
    const w = win(`${O}/today`, { answers: true, focused: true });
    const { listeners, openWindow } = boot({ wins: [win("https://other.site/"), w] });
    const e = click("/?task=t1");
    await fire(listeners.notificationclick, e);
    expect(e.notification.close).toHaveBeenCalled();
    expect(w.focus).toHaveBeenCalled();
    expect(w.postMessage).toHaveBeenCalledWith({ type: "kanbo:navigate", url: "/?task=t1" }, expect.any(Array));
    expect(w.navigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("navigates the window when the app doesn't answer", async () => {
    const w = win(`${O}/today`);
    const { listeners } = boot({ wins: [w] });
    await fire(listeners.notificationclick, click("/inbox"));
    expect(w.navigate).toHaveBeenCalledWith(`${O}/inbox`);
  });

  it("opens a window when Kanbo isn't open, and only ever on Kanbo", async () => {
    const { listeners, openWindow } = boot({ wins: [win("https://other.site/")] });
    await fire(listeners.notificationclick, click("/?task=t9"));
    expect(openWindow).toHaveBeenCalledWith(`${O}/?task=t9`);
    await fire(listeners.notificationclick, click("https://evil.io/"));
    expect(openWindow).toHaveBeenLastCalledWith(`${O}/`);
  });
});

describe("sw.js modes", () => {
  it("the dev push-only worker never touches fetches", () => {
    const { listeners } = boot({ search: "?push-only=1" });
    const respondWith = vi.fn();
    listeners.fetch({ request: { method: "GET", url: `${O}/src/main.tsx`, mode: "no-cors" }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("the production worker still serves same-origin assets (caching unchanged)", () => {
    const { listeners } = boot();
    const respondWith = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("asset", { status: 200 })));
    listeners.fetch({ request: { method: "GET", url: `${O}/assets/index-ABC.js`, mode: "no-cors" }, respondWith });
    listeners.fetch({ request: { method: "GET", url: "https://abc.supabase.co/rest/v1/tasks", mode: "cors" }, respondWith });
    vi.unstubAllGlobals();
    expect(respondWith).toHaveBeenCalledTimes(1); // cross-origin is never intercepted
  });

  it("resubscribes with the same key when the browser replaces the subscription", async () => {
    const w = win(`${O}/today`);
    const { listeners, self } = boot({ wins: [w] });
    const key = new Uint8Array([4, 1, 2]).buffer;
    await fire(listeners.pushsubscriptionchange, { oldSubscription: { options: { applicationServerKey: key } } });
    expect(self.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
    expect(w.postMessage).toHaveBeenCalledWith({ type: "kanbo:push-resubscribed" });
  });
});
