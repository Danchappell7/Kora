import { describe, it, expect, vi } from "vitest";
import {
  googleSignInEnabled, normaliseDomain, hdSetting, googleQueryParams, oauthRedirectTo, readHintCache, writeHintCache,
  parseSignInHints, loadGoogleHint, parseGoogleProvider, parseEmailAutoconfirm, googleReadiness, loadGoogleReadiness,
  friendlyGoogleError, usesGoogle, HINT_CACHE_KEY, HINT_CACHE_MS,
} from "./googleSignIn";

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

describe("settings", () => {
  it("reads the switch", () => {
    expect(googleSignInEnabled({ VITE_ENABLE_GOOGLE: "true" })).toBe(true);
    expect(googleSignInEnabled({ VITE_ENABLE_GOOGLE: "1" })).toBe(false);
    expect(googleSignInEnabled({})).toBe(false);
  });

  it("tidies a company domain and refuses free providers and junk", () => {
    expect(normaliseDomain(" @Acme.CO.uk ")).toBe("acme.co.uk");
    expect(normaliseDomain("sam@acme.com")).toBe("acme.com");
    expect(normaliseDomain("gmail.com")).toBeNull();
    expect(normaliseDomain("Outlook.com")).toBeNull();
    expect(normaliseDomain("acme")).toBeNull();
    expect(normaliseDomain("ac me.com")).toBeNull();
    expect(normaliseDomain("-acme.com")).toBeNull();
    expect(normaliseDomain(42)).toBeNull();
  });

  it("reads VITE_GOOGLE_HD: unset is auto, off is off, a domain is fixed", () => {
    expect(hdSetting(undefined)).toEqual({ mode: "auto" });
    expect(hdSetting("auto")).toEqual({ mode: "auto" });
    expect(hdSetting("off")).toEqual({ mode: "off" });
    expect(hdSetting("NONE")).toEqual({ mode: "off" });
    expect(hdSetting("acme.co.uk")).toEqual({ mode: "fixed", domain: "acme.co.uk" });
    expect(hdSetting("gmail.com")).toEqual({ mode: "off" });
  });

  it("always asks which account, and adds the hint when there is one", () => {
    expect(googleQueryParams(null)).toEqual({ prompt: "select_account" });
    expect(googleQueryParams("Acme.co.uk")).toEqual({ prompt: "select_account", hd: "acme.co.uk" });
    expect(googleQueryParams("gmail.com")).toEqual({ prompt: "select_account" });
  });

  it("sends people back to where they started", () => {
    expect(oauthRedirectTo({ origin: "https://www.kanbo.co.uk", pathname: "/admin" })).toBe("https://www.kanbo.co.uk/admin");
    expect(oauthRedirectTo({ origin: "https://www.kanbo.co.uk", pathname: "/admin/" })).toBe("https://www.kanbo.co.uk/admin");
    expect(oauthRedirectTo({ origin: "https://www.kanbo.co.uk", pathname: "/today" })).toBe("https://www.kanbo.co.uk");
  });
});

describe("the hint, cached", () => {
  it("round-trips through storage for six hours", () => {
    const s = memStorage();
    writeHintCache(s, "acme.co.uk", 1000);
    expect(readHintCache(s, 1000 + HINT_CACHE_MS - 1)).toEqual({ hd: "acme.co.uk" });
    expect(readHintCache(s, 1000 + HINT_CACHE_MS + 1)).toBeNull();
    writeHintCache(s, null, 5000);
    expect(readHintCache(s, 6000)).toEqual({ hd: null });
    s.setItem(HINT_CACHE_KEY, "{not json");
    expect(readHintCache(s, 6000)).toBeNull();
    s.setItem(HINT_CACHE_KEY, JSON.stringify({ hd: "gmail.com", at: 6000 }));
    expect(readHintCache(s, 6000)).toEqual({ hd: null });
    expect(readHintCache(null, 0)).toBeNull();
  });

  it("parses the rpc's answer", () => {
    expect(parseSignInHints({ google_hd: "acme.co.uk" })).toEqual({ hd: "acme.co.uk" });
    expect(parseSignInHints({ google_hd: null })).toEqual({ hd: null });
    expect(parseSignInHints({})).toBeNull();
    expect(parseSignInHints([])).toBeNull();
  });

  it("asks the database once, then uses the cache", async () => {
    const s = memStorage();
    const rpc = vi.fn(async () => ({ data: { google_hd: "acme.co.uk" }, error: null }));
    expect(await loadGoogleHint({ setting: { mode: "auto" }, rpc, storage: s, now: 1 })).toBe("acme.co.uk");
    expect(await loadGoogleHint({ setting: { mode: "auto" }, rpc, storage: s, now: 2 })).toBe("acme.co.uk");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("uses the env setting without asking", async () => {
    const rpc = vi.fn();
    expect(await loadGoogleHint({ setting: { mode: "off" }, rpc, storage: null })).toBeNull();
    expect(await loadGoogleHint({ setting: { mode: "fixed", domain: "acme.com" }, rpc, storage: null })).toBe("acme.com");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("remembers a missing rpc as no hint, but retries after a timeout or a network error", async () => {
    const s = memStorage();
    const missing = vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.sign_in_hints" } }));
    expect(await loadGoogleHint({ setting: { mode: "auto" }, rpc: missing, storage: s, now: 10 })).toBeNull();
    expect(readHintCache(s, 11)).toEqual({ hd: null });

    const s2 = memStorage();
    const hang = vi.fn(() => new Promise<never>(() => {}));
    expect(await loadGoogleHint({ setting: { mode: "auto" }, rpc: hang, storage: s2, now: 10, timeoutMs: 10 })).toBeNull();
    expect(readHintCache(s2, 11)).toBeNull();
    const boom = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await loadGoogleHint({ setting: { mode: "auto" }, rpc: boom, storage: s2, now: 10 })).toBeNull();
    expect(readHintCache(s2, 11)).toBeNull();
    expect(await loadGoogleHint({ setting: { mode: "auto" }, rpc: null, storage: s2 })).toBeNull();
  });
});

describe("may the button be used?", () => {
  // GoTrue's GET /auth/v1/settings, as Supabase serves it
  const settings = (google: unknown, autoconfirm: unknown) =>
    ({ external: { google, email: true, apple: false }, disable_signup: false, mailer_autoconfirm: autoconfirm, phone_autoconfirm: false, sms_provider: "twilio", saml_enabled: false });

  it("reads GoTrue's settings", () => {
    expect(parseGoogleProvider({ external: { google: true, email: true } })).toBe(true);
    expect(parseGoogleProvider({ external: { google: false } })).toBe(false);
    expect(parseGoogleProvider({ external: {} })).toBeNull();
    expect(parseGoogleProvider(null)).toBeNull();
    expect(parseEmailAutoconfirm(settings(true, true))).toBe(true);
    expect(parseEmailAutoconfirm(settings(true, false))).toBe(false);
    expect(parseEmailAutoconfirm({ external: {} })).toBeNull();
    expect(parseEmailAutoconfirm({ mailer_autoconfirm: "false" })).toBeNull();
    expect(parseEmailAutoconfirm(null)).toBeNull();
  });

  it("is ready only when Google is on AND Confirm email is on (mailer_autoconfirm false)", () => {
    expect(googleReadiness(settings(true, false))).toBe("ready");
    expect(googleReadiness(settings(false, false))).toBe("provider-off");
    expect(googleReadiness(settings(false, true))).toBe("provider-off");
  });

  it("refuses while Confirm email is off: a stranger's unproven password account would be linked", () => {
    // mailer_autoconfirm: every password sign-up counts as confirmed, so Supabase links a later
    // Google sign-in for that address to it, and the stranger keeps their password
    expect(googleReadiness(settings(true, true))).toBe("confirm-email-off");
  });

  it("fails closed when it can't tell", () => {
    expect(googleReadiness(settings(true, undefined))).toBe("unknown");
    expect(googleReadiness(settings(true, null))).toBe("unknown");
    expect(googleReadiness(settings(undefined, false))).toBe("unknown");
    expect(googleReadiness({})).toBe("unknown");
    expect(googleReadiness(null)).toBe("unknown");
    expect(googleReadiness("ok")).toBe("unknown");
  });

  it("asks /auth/v1/settings with the public key, and is unknown when that fails", async () => {
    const f = vi.fn(async () => Response.json(settings(true, false)));
    expect(await loadGoogleReadiness({ supabaseUrl: "https://x.supabase.co/", anonKey: "anon", fetch: f })).toBe("ready");
    expect(f).toHaveBeenCalledWith("https://x.supabase.co/auth/v1/settings", expect.objectContaining({ headers: { apikey: "anon" } }));
    expect(await loadGoogleReadiness({ supabaseUrl: "https://x.supabase.co", anonKey: "anon", fetch: async () => Response.json(settings(true, true)) })).toBe("confirm-email-off");
    expect(await loadGoogleReadiness({ supabaseUrl: "https://x.supabase.co", anonKey: "anon", fetch: async () => Response.json(settings(false, false)) })).toBe("provider-off");
    expect(await loadGoogleReadiness({ supabaseUrl: "https://x.supabase.co", anonKey: "anon", fetch: async () => new Response("", { status: 500 }) })).toBe("unknown");
    expect(await loadGoogleReadiness({ supabaseUrl: "https://x.supabase.co", anonKey: "anon", fetch: async () => new Response("<html>", { status: 200 }) })).toBe("unknown");
    expect(await loadGoogleReadiness({ supabaseUrl: "https://x.supabase.co", anonKey: "anon", fetch: async () => { throw new Error("offline"); } })).toBe("unknown");
    expect(await loadGoogleReadiness({ supabaseUrl: "", anonKey: "anon" })).toBe("unknown");
    expect(await loadGoogleReadiness({ supabaseUrl: "https://x.supabase.co", anonKey: "" })).toBe("unknown");
  });

  it("gives up on a settings request that hangs", async () => {
    const hang = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    expect(await loadGoogleReadiness({ supabaseUrl: "https://x.supabase.co", anonKey: "anon", fetch: hang, timeoutMs: 10 })).toBe("unknown");
  });
});

describe("words", () => {
  it("explains a Google error, else falls back", () => {
    const fb = (m: string) => `fallback:${m}`;
    expect(friendlyGoogleError("Unsupported provider: provider is not enabled", fb)).toContain("isn’t switched on yet");
    expect(friendlyGoogleError("other", fb)).toBe("fallback:other");
    expect(usesGoogle(["email", "google"])).toBe(true);
    expect(usesGoogle(["email"])).toBe(false);
    expect(usesGoogle(undefined)).toBe(false);
  });
});
