import { describe, it, expect } from "vitest";
import { readAuthUrl, withoutParams, friendlyAuthError, isExpiredLinkError, expiredLinkError, linkNeedsPassword, EXPIRED_MESSAGE, CONFIRM_EXPIRED_MESSAGE } from "./authLinks";

const ORIGIN = "https://www.kanbo.co.uk";

describe("readAuthUrl", () => {
  it("turns an expired email link (hash) into the 'send a new one' message and strips it", () => {
    const s = readAuthUrl(`${ORIGIN}/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
    expect(s.linkError).toEqual({ kind: "expired", message: EXPIRED_MESSAGE });
    expect(s.cleanUrl).toBe("/");
    expect(s.pendingLink).toBeNull();
  });

  it("handles errors in the query string and keeps unrelated params", () => {
    const s = readAuthUrl(`${ORIGIN}/?error=server_error&error_description=Database+error+saving+new+user&task=t1`);
    expect(s.linkError?.kind).toBe("failed");
    expect(s.linkError?.message).toBe("That sign-in didn’t work. Please try again, or ask your workspace admin for help.");
    expect(s.errorDetail).toEqual({ error: "server_error", code: null, description: "Database error saving new user" });
    expect(s.cleanUrl).toBe("/?task=t1");
  });

  it("never shows the link's own error text (anyone can craft one)", () => {
    const s = readAuthUrl(`${ORIGIN}/#error=x&error_description=Your+account+is+locked.+Call+0800+000+000+now`);
    expect(s.linkError?.kind).toBe("failed");
    expect(s.linkError?.message).not.toMatch(/locked|0800/);
  });

  it("explains an uninvited Google account in invite-only mode in plain English", () => {
    const s = readAuthUrl(`${ORIGIN}/#error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance`);
    expect(s.linkError?.kind).toBe("failed");
    expect(s.linkError?.message).toMatch(/invite-only/);
    expect(s.linkError?.message).not.toMatch(/instance/);
  });

  it("explains a cancelled Google sign-in without calling it expired", () => {
    const s = readAuthUrl(`${ORIGIN}/#error=access_denied`);
    expect(s.linkError?.kind).toBe("failed");
    expect(s.linkError?.message).toMatch(/cancelled/);
    // an OAuth "invalid state" is not an expired email link
    expect(readAuthUrl(`${ORIGIN}/?error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+state+is+invalid`).linkError?.kind).toBe("failed");
  });

  it("sends an expired confirmation link to sign-in, not to 'reset your password'", () => {
    expect(expiredLinkError("signup")).toEqual({ kind: "confirm-expired", message: CONFIRM_EXPIRED_MESSAGE });
    expect(expiredLinkError("email")).toEqual({ kind: "confirm-expired", message: CONFIRM_EXPIRED_MESSAGE });
    expect(expiredLinkError("recovery")).toEqual({ kind: "expired", message: EXPIRED_MESSAGE });
    expect(expiredLinkError("invite").kind).toBe("expired");
    expect(expiredLinkError(null).kind).toBe("expired");
  });

  it("recognises scanner-safe token links without consuming them", () => {
    const s = readAuthUrl(`${ORIGIN}/?token_hash=abc123&type=invite`);
    expect(s.pendingLink).toEqual({ tokenHash: "abc123", type: "invite" });
    expect(s.cleanUrl).toBeNull();
    expect(readAuthUrl(`${ORIGIN}/?token_hash=abc123&type=recovery`).pendingLink?.type).toBe("recovery");
    expect(readAuthUrl(`${ORIGIN}/?token_hash=abc123&type=nonsense`).pendingLink).toBeNull();
    expect(readAuthUrl(`${ORIGIN}/?type=invite`).pendingLink).toBeNull();
  });

  it("notes the type of a legacy #access_token link", () => {
    expect(readAuthUrl(`${ORIGIN}/#access_token=x&refresh_token=y&expires_in=3600&token_type=bearer&type=invite`).implicitType).toBe("invite");
    expect(readAuthUrl(`${ORIGIN}/#access_token=x&type=recovery`).implicitType).toBe("recovery");
  });

  it("ignores ordinary URLs and anchors", () => {
    expect(readAuthUrl(`${ORIGIN}/privacy#cookies`)).toEqual({ pendingLink: null, linkError: null, errorDetail: null, implicitType: null, cleanUrl: null });
    expect(readAuthUrl(`${ORIGIN}/?task=abc`).linkError).toBeNull();
  });
});

describe("auth link helpers", () => {
  it("withoutParams drops only the named params", () => {
    expect(withoutParams(`${ORIGIN}/?token_hash=a&type=invite&task=t1`, ["token_hash", "type"])).toBe("/?task=t1");
    expect(withoutParams(`${ORIGIN}/?token_hash=a&type=invite`, ["token_hash", "type"])).toBe("/");
  });

  it("only invite and recovery links need a password", () => {
    expect(linkNeedsPassword("invite")).toBe(true);
    expect(linkNeedsPassword("recovery")).toBe(true);
    expect(linkNeedsPassword("signup")).toBe(false);
    expect(linkNeedsPassword(null)).toBe(false);
  });

  it("detects expired OTP errors by code or message", () => {
    expect(isExpiredLinkError({ code: "otp_expired" })).toBe(true);
    expect(isExpiredLinkError({ message: "Token has expired or is invalid" })).toBe(true);
    expect(isExpiredLinkError({ message: "Email link is invalid or has expired" })).toBe(true);
    expect(isExpiredLinkError({ message: "Database error" })).toBe(false);
    expect(isExpiredLinkError({ message: "OAuth state is invalid" })).toBe(false);
  });

  it("maps raw Supabase messages to plain guidance", () => {
    expect(friendlyAuthError("Invalid login credentials")).toMatch(/don’t match/);
    expect(friendlyAuthError("Email not confirmed")).toMatch(/confirm your email/);
    expect(friendlyAuthError("Signups not allowed for this instance")).toMatch(/invite-only/);
    expect(friendlyAuthError("TypeError: Failed to fetch")).toMatch(/connection/);
    expect(friendlyAuthError("Something unusual")).toBe("Something unusual");
  });
});
