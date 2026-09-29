import { describe, it, expect, beforeEach } from "vitest";
import { readAuthUrl, withoutParams, friendlyAuthError, isExpiredLinkError, linkNeedsPassword, EXPIRED_MESSAGE } from "./authLinks";
import { claimLocalData, clearLocalUserData, OWNER_KEY, SNAPSHOT_KEY, STASH_PREFIX } from "./localData";
import { offlineQueue } from "../lib/offlineQueue";
import type { Task } from "../data/types";

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
    expect(s.linkError?.message).toContain("Database error saving new user");
    expect(s.cleanUrl).toBe("/?task=t1");
  });

  it("explains a cancelled Google sign-in without calling it expired", () => {
    const s = readAuthUrl(`${ORIGIN}/#error=access_denied`);
    expect(s.linkError?.kind).toBe("failed");
    expect(s.linkError?.message).toMatch(/cancelled/);
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
    expect(readAuthUrl(`${ORIGIN}/privacy#cookies`)).toEqual({ pendingLink: null, linkError: null, implicitType: null, cleanUrl: null });
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
    expect(isExpiredLinkError({ message: "Database error" })).toBe(false);
  });

  it("maps raw Supabase messages to plain guidance", () => {
    expect(friendlyAuthError("Invalid login credentials")).toMatch(/don’t match/);
    expect(friendlyAuthError("Email not confirmed")).toMatch(/confirm your email/);
    expect(friendlyAuthError("Signups not allowed for this instance")).toMatch(/invite-only/);
    expect(friendlyAuthError("TypeError: Failed to fetch")).toMatch(/connection/);
    expect(friendlyAuthError("Something unusual")).toBe("Something unusual");
  });
});

describe("local data belongs to one account at a time", () => {
  const task = (id: string) => ({ id, title: `Task ${id}` } as unknown as Task);
  beforeEach(() => { offlineQueue.clear(); localStorage.clear(); });

  it("never replays another account's queued edits; parks and restores them instead", () => {
    claimLocalData("user-a");
    offlineQueue.enqueueCreate(task("t1"), "user-a");
    offlineQueue.enqueueUpdate("t9", { title: "renamed" });
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ uid: "user-a", boot: {} }));

    claimLocalData("user-b");
    expect(offlineQueue.size()).toBe(0);
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem(OWNER_KEY)).toBe("user-b");
    expect(JSON.parse(localStorage.getItem(STASH_PREFIX + "user-a") || "[]")).toHaveLength(2);

    claimLocalData("user-a");
    expect(offlineQueue.all().map((m) => m.kind)).toEqual(["create", "update"]);
    expect(localStorage.getItem(STASH_PREFIX + "user-a")).toBeNull();
  });

  it("infers the owner of data cached before owner tracking existed", () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ uid: "old-user", boot: {} }));
    claimLocalData("new-user");
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();

    localStorage.clear();
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ uid: "same", boot: {} }));
    claimLocalData("same");
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
  });

  it("clears the snapshot, queue and per-account state on sign-out, keeping device preferences", () => {
    claimLocalData("user-a");
    offlineQueue.enqueueCreate(task("t1"), "user-a");
    localStorage.setItem(SNAPSHOT_KEY, "{}");
    localStorage.setItem("kanbo-filters", "{}");
    localStorage.setItem("kanbo-theme", "light");
    sessionStorage.setItem("kanbo-needs-password", "invite");
    clearLocalUserData();
    expect(offlineQueue.size()).toBe(0);
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem("kanbo-filters")).toBeNull();
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();
    expect(sessionStorage.getItem("kanbo-needs-password")).toBeNull();
    expect(localStorage.getItem("kanbo-theme")).toBe("light");
  });
});
