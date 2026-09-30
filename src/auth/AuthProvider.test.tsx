/* AuthProvider in Supabase mode, against a fake client. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { useState } from "react";

const h = vi.hoisted(() => {
  const listeners = new Set<(event: string, session: unknown) => void>();
  const state = { session: null as null | { user: { id: string; email: string; user_metadata: Record<string, unknown> } } };
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: state.session } })),
    onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
      listeners.add(cb);
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    }),
    verifyOtp: vi.fn(),
    resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async (): Promise<{ error: unknown }> => ({ error: null })),
    getUser: vi.fn(async (): Promise<{ data: { user: unknown }; error: unknown }> => ({ data: { user: state.session?.user ?? null }, error: null })),
    updateUser: vi.fn(async () => ({ data: {}, error: null })),
  };
  const flush = vi.fn(async (): Promise<number> => 0);
  const invoke = vi.fn(async (): Promise<{ data: unknown; error: unknown }> => ({ data: {}, error: null }));
  return { auth, listeners, state, flush, invoke };
});
vi.mock("../lib/supabase", () => ({ isSupabaseConfigured: true, supabase: { auth: h.auth, functions: { invoke: h.invoke } } }));
vi.mock("../data/store", () => ({ store: { flushQueue: h.flush } }));

type Mod = typeof import("./AuthProvider");
async function boot(url: string) {
  window.history.replaceState(null, "", url);
  vi.resetModules();
  const mod: Mod = await import("./AuthProvider");
  const { offlineQueue } = await import("../lib/offlineQueue");
  // jsdom can't navigate — record reloads instead
  const { pageNav } = await import("./localData");
  const nav = { reload: vi.spyOn(pageNav, "reload").mockImplementation(() => {}), restart: vi.spyOn(pageNav, "restart").mockImplementation(() => {}) };
  function Probe() {
    const a = mod.useAuth();
    const [reset, setReset] = useState("");
    return (
      <div>
        <span data-testid="recovery">{String(a.recovery)}</span>
        <span data-testid="reason">{a.passwordReason ?? "none"}</span>
        <span data-testid="link-error">{a.linkError?.kind ?? "none"}</span>
        <span data-testid="user">{a.user?.id ?? "none"}</span>
        <button onClick={() => { a.verifyLink(); }}>verify</button>
        <button onClick={a.signOut}>sign out</button>
        <button onClick={async () => { const r = await a.resetPassword("sam@company.com"); setReset(r.error ?? "sent"); }}>reset</button>
        <span data-testid="reset">{reset}</span>
      </div>
    );
  }
  // let the stored-session read settle inside act()
  await act(async () => { render(<mod.AuthProvider><Probe /></mod.AuthProvider>); });
  return { offlineQueue, nav };
}
const signedIn = (id = "u1") => { h.state.session = { user: { id, email: `${id}@company.com`, user_metadata: {} } }; };
const emit = (event: string) => act(async () => { h.listeners.forEach((l) => l(event, h.state.session)); });
const text = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  h.state.session = null;
  h.listeners.clear();
  vi.clearAllMocks();
  h.flush.mockImplementation(async () => 0);
  localStorage.clear();
  sessionStorage.clear();
});

describe("scanner-safe email links", () => {
  it("holds the invite screen without spending the token, then verifies on click and asks for a password", async () => {
    h.auth.verifyOtp.mockImplementation(async () => {
      h.state.session = { user: { id: "u-new", email: "new@company.com", user_metadata: {} } };
      return { data: { session: h.state.session, user: h.state.session.user }, error: null };
    });
    await boot("/?token_hash=th1&type=invite");
    expect(text("recovery")).toBe("true");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.auth.verifyOtp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("verify"));
    await waitFor(() => expect(text("reason")).toBe("invite"));
    expect(h.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "th1", type: "invite" });
    expect(text("recovery")).toBe("true");
    expect(text("user")).toBe("u-new");
    // survives a reload, and the spent token is gone from the address bar
    expect(sessionStorage.getItem("kanbo-needs-password")).toBe("invite");
    expect(window.location.search).toBe("");
  });

  it("sends an expired link to the 'send a new one' path", async () => {
    h.auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { name: "AuthApiError", status: 403, code: "otp_expired", message: "Email link is invalid or has expired" } });
    await boot("/?token_hash=old&type=recovery");
    fireEvent.click(screen.getByText("verify"));
    await waitFor(() => expect(text("link-error")).toBe("expired"));
    expect(text("recovery")).toBe("false");
  });

  it("explains an expired implicit link from the URL hash and tidies the address bar", async () => {
    await boot("/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    expect(text("link-error")).toBe("expired");
    await waitFor(() => expect(window.location.hash).toBe(""));
  });

  it("keeps the set-password screen across a reload while signed in", async () => {
    sessionStorage.setItem("kanbo-needs-password", "recovery");
    h.state.session = { user: { id: "u1", email: "sam@company.com", user_metadata: {} } };
    await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    expect(text("recovery")).toBe("true");
    expect(text("reason")).toBe("recovery");
  });
});

describe("sign-out on a shared device", () => {
  it("asks before discarding edits that won't sync, and clears them when confirmed", async () => {
    signedIn();
    const { offlineQueue, nav } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    offlineQueue.enqueueUpdate("t1", { title: "offline edit" });
    localStorage.setItem("kanbo-offline-snapshot", JSON.stringify({ uid: "u1" }));

    fireEvent.click(screen.getByText("sign out"));
    const dialog = await screen.findByRole("alertdialog");
    // it really tries to sync first
    expect(dialog).toHaveTextContent(/Syncing your changes/);
    expect(h.flush).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(h.auth.signOut).not.toHaveBeenCalled();
    expect(offlineQueue.size()).toBe(1);

    fireEvent.click(screen.getByText("sign out"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out and discard" }));
    await waitFor(() => expect(h.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(offlineQueue.size()).toBe(0));
    expect(localStorage.getItem("kanbo-offline-snapshot")).toBeNull();
    expect(nav.restart).toHaveBeenCalled();
  });

  it("syncs unsaved edits and then carries on signing out", async () => {
    signedIn();
    const { offlineQueue } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    offlineQueue.enqueueUpdate("t1", { title: "dropped mid-flight" });
    h.flush.mockImplementation(async () => { offlineQueue.clear(); return 1; });

    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(h.auth.signOut).toHaveBeenCalled());
    expect(h.flush).toHaveBeenCalledTimes(1);
  });

  it("says honestly when the sync failed and offers to try again", async () => {
    signedIn();
    const { offlineQueue } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    offlineQueue.enqueueUpdate("t1", { title: "keeps failing" });
    h.flush.mockRejectedValueOnce(new Error("500"));

    fireEvent.click(screen.getByText("sign out"));
    const retry = await screen.findByRole("button", { name: /Try again/ }, { timeout: 2000 });
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/couldn’t save 1 change/);
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent(/Syncing/);
    h.flush.mockImplementation(async () => { offlineQueue.clear(); return 1; });
    fireEvent.click(retry);
    await waitFor(() => expect(h.auth.signOut).toHaveBeenCalled());
  });

  it("signs straight out when nothing is waiting to sync", async () => {
    signedIn();
    await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(h.auth.signOut).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("signs out of this device only, and forgets unsent comments and unsaved task text", async () => {
    signedIn();
    const { nav } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    sessionStorage.setItem("kanbo-draft:u1:t1", "half a comment");
    sessionStorage.setItem("kanbo-unsaved:u1:t1:description", "half a description");
    sessionStorage.setItem("kanbo-something-else", "kept");
    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(nav.restart).toHaveBeenCalled());
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(sessionStorage.getItem("kanbo-draft:u1:t1")).toBeNull();
    expect(sessionStorage.getItem("kanbo-unsaved:u1:t1:description")).toBeNull();
    expect(sessionStorage.getItem("kanbo-something-else")).toBe("kept");
  });

  it("doesn't ask about unsynced edits once the account no longer exists", async () => {
    signedIn();
    const { offlineQueue } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    offlineQueue.enqueueUpdate("t1", { title: "can never sync" });
    h.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthApiError", status: 403, code: "user_not_found", message: "User from sub claim in JWT does not exist" } });
    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(h.auth.signOut).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(offlineQueue.size()).toBe(0);
  });

  it("still signs out when the logout request fails (offline): the stored session is removed", async () => {
    signedIn();
    localStorage.setItem("sb-abcd-auth-token", JSON.stringify({ access_token: "a", refresh_token: "r" }));
    const { nav } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    h.auth.signOut.mockResolvedValueOnce({ error: { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" } });
    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(nav.restart).toHaveBeenCalled());
    // the reload would otherwise sign the same person straight back in
    expect(localStorage.getItem("sb-abcd-auth-token")).toBeNull();
  });

  it("leaves the stored session to supabase-js when logout succeeds", async () => {
    signedIn();
    localStorage.setItem("sb-abcd-auth-token", "{}");
    const { nav } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(nav.restart).toHaveBeenCalled());
    // (the fake client doesn't remove it; we only step in when logout failed)
    expect(localStorage.getItem("sb-abcd-auth-token")).toBe("{}");
  });
});

describe("switching accounts on one device", () => {
  it("reloads before showing a different account than the one this device last held", async () => {
    localStorage.setItem("kanbo-local-owner", "user-a");
    localStorage.setItem("kanbo-filters", JSON.stringify({ priority: "high" }));
    signedIn("user-b");
    const { nav } = await boot("/");
    await waitFor(() => expect(nav.reload).toHaveBeenCalled());
    expect(text("user")).toBe("none");
    expect(localStorage.getItem("kanbo-filters")).toBeNull();
    expect(localStorage.getItem("kanbo-local-owner")).toBe("user-b");
  });

  it("parks this tab's edits when the session ends elsewhere, so the next account can't replay them", async () => {
    signedIn("user-a");
    const { offlineQueue, nav } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("user-a"));
    offlineQueue.enqueueUpdate("t1", { title: "A's edit" });
    offlineQueue.enqueueDelete("t2");

    h.state.session = null;
    await emit("SIGNED_OUT"); // signed out in another tab
    expect(text("user")).toBe("none");
    expect(offlineQueue.size()).toBe(0);

    signedIn("user-b");
    await emit("SIGNED_IN"); // someone else signs in (here or in another tab)
    expect(nav.reload).toHaveBeenCalled();
    expect(text("user")).toBe("none");
    expect(offlineQueue.size()).toBe(0);
    expect(JSON.parse(localStorage.getItem("kanbo-offline-stash-user-a") || "[]")).toHaveLength(2);
  });

  it("treats the stored session vanishing (another tab signed out offline) as a sign-out here too", async () => {
    signedIn("user-a");
    const { offlineQueue } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("user-a"));
    offlineQueue.enqueueUpdate("t1", { title: "A's edit" });
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "sb-abcd-auth-token", oldValue: "{}", newValue: null })); });
    expect(text("user")).toBe("none");
    expect(offlineQueue.size()).toBe(0);
    expect(JSON.parse(localStorage.getItem("kanbo-offline-stash-user-a") || "[]")).toHaveLength(1);
  });

  it("forgets an old link error once someone is signed in", async () => {
    signedIn();
    await boot("/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    await waitFor(() => expect(text("user")).toBe("u1"));
    expect(text("link-error")).toBe("none");
  });

  it("sends an expired confirmation link to sign-in rather than password reset", async () => {
    h.auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { name: "AuthApiError", status: 403, code: "otp_expired", message: "Email link is invalid or has expired" } });
    await boot("/?token_hash=old&type=signup");
    fireEvent.click(screen.getByText("verify"));
    await waitFor(() => expect(text("link-error")).toBe("confirm-expired"));
  });
});

describe("password reset", () => {
  it("says to try again in a minute when the email service just refused, instead of failing twice", async () => {
    await boot("/");
    h.invoke.mockResolvedValueOnce({ data: { ok: true, fallback: true, retryAfter: 60 }, error: null });
    fireEvent.click(screen.getByText("reset"));
    await waitFor(() => expect(text("reset")).toBe("We couldn't send that just now. Try again in a minute."));
    expect(h.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("falls back to the built-in reset straight away when the function asks for it", async () => {
    await boot("/");
    h.invoke.mockResolvedValueOnce({ data: { ok: true, fallback: true }, error: null });
    fireEvent.click(screen.getByText("reset"));
    await waitFor(() => expect(text("reset")).toBe("sent"));
    expect(h.auth.resetPasswordForEmail).toHaveBeenCalledWith("sam@company.com", expect.anything());
  });

  it("treats a throttled request as sent (the earlier link still works)", async () => {
    await boot("/");
    h.invoke.mockResolvedValueOnce({ data: { ok: true, throttled: true, retryAfter: 42 }, error: null });
    fireEvent.click(screen.getByText("reset"));
    await waitFor(() => expect(text("reset")).toBe("sent"));
    expect(h.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});
