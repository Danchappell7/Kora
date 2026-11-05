/* An AI app's request, kept through signing in and out of the address bar. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetOAuthRequest, isOAuthAuthorizePath, oauthQueryFromUrl, pendingOAuthRequest, rememberOAuthRequest, takeOAuthRequest } from "./oauthRequest";

const Q = "response_type=code&client_id=abc&state=s3cret";
beforeEach(() => { sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("reading the address", () => {
  it("knows the path, with or without a slash", () => {
    expect(isOAuthAuthorizePath("/oauth/authorize")).toBe(true);
    expect(isOAuthAuthorizePath("/oauth/authorize/")).toBe(true);
    expect(isOAuthAuthorizePath("/oauth/token")).toBe(false);
    expect(isOAuthAuthorizePath("/")).toBe(false);
  });
  it("takes the query only from that path", () => {
    expect(oauthQueryFromUrl(`https://www.kanbo.co.uk/oauth/authorize?${Q}`)).toBe(Q);
    expect(oauthQueryFromUrl("https://www.kanbo.co.uk/oauth/authorize")).toBeNull();
    expect(oauthQueryFromUrl(`https://www.kanbo.co.uk/today?${Q}`)).toBeNull();
    expect(oauthQueryFromUrl(`https://www.kanbo.co.uk/oauth/authorize?${"x".repeat(9000)}`)).toBeNull();
  });
});

describe("remembering", () => {
  it("keeps it for this tab for 15 minutes", () => {
    const t = 1_000_000;
    expect(rememberOAuthRequest(Q, t)).toBe(true);
    expect(pendingOAuthRequest(t + 14 * 60_000)).toBe(Q);
    expect(pendingOAuthRequest(t + 16 * 60_000)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
  it("forgets on request, and ignores rubbish", () => {
    rememberOAuthRequest(Q);
    forgetOAuthRequest();
    expect(pendingOAuthRequest()).toBeNull();
    sessionStorage.setItem("kanbo:oauth-request", "not json");
    expect(pendingOAuthRequest()).toBeNull();
    sessionStorage.setItem("kanbo:oauth-request", JSON.stringify({ q: Q, at: Date.now() + 3_600_000 }));
    expect(pendingOAuthRequest()).toBeNull();
    expect(rememberOAuthRequest("")).toBe(false);
  });
  it("says so when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(rememberOAuthRequest(Q)).toBe(false);
  });
});

describe("takeOAuthRequest", () => {
  it("takes it out of the address bar at once, keeping the path for the sign-in screen", () => {
    window.history.replaceState(null, "", `/oauth/authorize?${Q}`);
    expect(takeOAuthRequest()).toBe(Q);
    expect(window.location.pathname).toBe("/oauth/authorize");
    expect(window.location.search).toBe("");
    expect(pendingOAuthRequest()).toBe(Q);
  });
  it("finds it again however many times Root starts (StrictMode, signing in)", () => {
    window.history.replaceState(null, "", `/oauth/authorize?${Q}`);
    takeOAuthRequest();
    expect(takeOAuthRequest()).toBe(Q);
    // a Google sign-in comes back to the home page
    window.history.replaceState(null, "", "/");
    expect(takeOAuthRequest()).toBe(Q);
  });
  it("with storage blocked, the address keeps it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    window.history.replaceState(null, "", `/oauth/authorize?${Q}`);
    expect(takeOAuthRequest()).toBe(Q);
    expect(window.location.search).toBe(`?${Q}`);
  });
  it("on the path with nothing usable: the empty request, so the page can say so", () => {
    window.history.replaceState(null, "", "/oauth/authorize");
    expect(takeOAuthRequest()).toBe("");
  });
  it("anywhere else with nothing kept: no request at all", () => {
    window.history.replaceState(null, "", "/today");
    expect(takeOAuthRequest()).toBeNull();
    expect(window.location.pathname).toBe("/today");
  });
});
