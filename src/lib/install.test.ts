/* lib/install: the captured beforeinstallprompt, the installed / iOS states. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetInstallForTests, browserFamily, installState, isIos, isStandalone, listenForInstallPrompt, onInstallStateChange, promptInstall,
  takeNewTaskShortcut,
} from "./install";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0",
};
function setUa(ua: string, touchPoints = 0) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(navigator, "maxTouchPoints", { value: touchPoints, configurable: true });
}
function setDisplayMode(standalone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: standalone && q.includes("standalone"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
function fireInstallPrompt(outcome: "accepted" | "dismissed" = "accepted") {
  const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
  e.prompt = vi.fn(async () => {});
  e.userChoice = Promise.resolve({ outcome });
  window.dispatchEvent(e);
  return e;
}

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  __resetInstallForTests();
  setUa(UA.chrome);
  setDisplayMode(false);
  listenForInstallPrompt();
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  delete (navigator as unknown as Record<string, unknown>).standalone;
});

describe("install state", () => {
  it("is unavailable until the browser offers an install", () => {
    expect(installState()).toBe("unavailable");
  });

  it("keeps the browser's prompt (instead of its banner) and shows it on request", async () => {
    const seen: string[] = [];
    const off = onInstallStateChange((s) => seen.push(s));
    const e = fireInstallPrompt("accepted");
    expect(e.defaultPrevented).toBe(true);
    expect(installState()).toBe("available");
    expect(await promptInstall()).toBe("accepted");
    expect(e.prompt).toHaveBeenCalledTimes(1);
    expect(installState()).toBe("installed");
    expect(seen).toEqual(["available", "installed"]);
    off();
  });

  it("a dismissed prompt can't be shown twice", async () => {
    fireInstallPrompt("dismissed");
    expect(await promptInstall()).toBe("dismissed");
    expect(installState()).toBe("unavailable");
    expect(await promptInstall()).toBe("unavailable");
  });

  it("appinstalled (from the browser's own menu) counts as installed", () => {
    fireInstallPrompt();
    window.dispatchEvent(new Event("appinstalled"));
    expect(installState()).toBe("installed");
  });

  it("running standalone is installed (display-mode or iOS navigator.standalone)", () => {
    setDisplayMode(true);
    expect(isStandalone()).toBe(true);
    expect(installState()).toBe("installed");
    setDisplayMode(false);
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    expect(isStandalone()).toBe(true);
  });

  it("iPhone and iPad (which says it's a Mac with touch) get the Home Screen hint", () => {
    setUa(UA.iphone);
    expect(isIos()).toBe(true);
    expect(installState()).toBe("ios");
    setUa(UA.ipad, 5);
    expect(installState()).toBe("ios");
    setUa(UA.safariMac, 0);
    expect(installState()).toBe("unavailable");
  });

  it("names the browser family for the how-to copy", () => {
    setUa(UA.safariMac); expect(browserFamily()).toBe("safari-mac");
    setUa(UA.chrome); expect(browserFamily()).toBe("chromium");
    setUa(UA.edge); expect(browserFamily()).toBe("chromium");
    setUa(UA.firefox); expect(browserFamily()).toBe("firefox");
  });

  it("listening twice doesn't double up", () => {
    listenForInstallPrompt();
    const fn = vi.fn();
    onInstallStateChange(fn);
    fireInstallPrompt();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("the New task shortcut (/today?new=1)", () => {
  afterEach(() => { window.history.replaceState(null, "", "/"); });

  it("is true once, and takes `new` off the address while keeping everything else", () => {
    window.history.replaceState({ kScroll: 12 }, "", "/today?new=1&task=t1#x");
    expect(takeNewTaskShortcut()).toBe(true);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/today?task=t1#x");
    expect(window.history.state).toEqual({ kScroll: 12 }); // Back/Forward state survives
    expect(takeNewTaskShortcut()).toBe(false); // a second call (or a re-render) doesn't reopen it
  });

  it("is false without the parameter (and leaves the address alone)", () => {
    window.history.replaceState(null, "", "/inbox?q=brief");
    expect(takeNewTaskShortcut()).toBe(false);
    expect(window.location.pathname + window.location.search).toBe("/inbox?q=brief");
  });

  it("only new=1 opens capture; any other value is just tidied away", () => {
    window.history.replaceState(null, "", "/today?new=0");
    expect(takeNewTaskShortcut()).toBe(false);
    expect(window.location.search).toBe("");
  });
});
